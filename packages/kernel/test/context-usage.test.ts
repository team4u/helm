/**
 * 会话上下文用量（contextUsage）端到端契约：
 *
 * 1. 纯函数 estimateContextUsage 与 pi agent 1.5.2 `getContextUsage` /
 *    `estimateProjectedContextTokens` 语义对齐：实测锚点（head 之后最近一条
 *    stopReason 非 aborted/error 且 usage>0 的 assistant）+ 尾段估算；锚点
 *    失效（无 usage / 越过 head / 被 omit 覆盖）退化为当前有效消息全量估算；
 *    最近一次压缩（head 为 pi.compaction）后尚无有效 usage 时 tokens=null
 *    （摘要字符估算不冒充已知上下文）；reset 是全新上下文，全量估算为真实值；
 * 2. 组装与透传：compacting 布尔透传；压缩失败经 notification 通知（脱敏 +
 *    按 taskId 去重），不再随用量携带失败摘要；速率类指标（response）已收敛
 *    到可选插件 builtin:token-speed（内核零速率计算，契约级死字段锁定）；
 * 3. 集成（真实 KernelRuntime + faux provider + SQLite）：回合结算后摘要携带
 *    contextUsage；usage-only 变化发布 conversation.upsert 但不推进
 *    stateChangeSeq；reset 后归零；手动压缩期间 compacting=true 可达、完成后
 *    tokens=null 直到下一次回答产生有效 usage；压缩失败恰发一次脱敏
 *    notification，后续回合不重复。
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import type { ContextView } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { calculateContextTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { AssistantMessage, Message, SystemMessage, Tool, UserMessage } from '@earendil-works/pi-ai'
import type { ConversationSummary, HelmEventFrame } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import type { ProviderConfig } from '@helm/protocol'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor as waitForCondition } from './helpers.js'
import {
  assembleContextUsage,
  compactionFailureNoticeOf,
  compactingOf,
  contextUsageKeyOf,
  estimateContextUsage,
  estimateTokens,
} from '../src/runtime/context-usage.js'
import { buildModels } from '../src/runtime/models.js'
import { EventHub } from '../src/runtime/events.js'
import { KernelRuntime } from '../src/runtime/index.js'

// ---------------------------------------------------------------------------
// 构造工具：纯函数测试的 ContextView / Message 形状
// ---------------------------------------------------------------------------

function userMessage(text: string): UserMessage {
  return { role: 'user', content: text, timestamp: 1 }
}

function systemMessage(spec: {
  content?: string
  sections?: Record<string, string | null>
  toolsAdded?: Tool[]
}): SystemMessage {
  return {
    role: 'system',
    content: spec.content ?? '',
    ...(spec.sections !== undefined ? { sections: spec.sections } : {}),
    ...(spec.toolsAdded !== undefined ? { toolsAdded: spec.toolsAdded } : {}),
    timestamp: 0,
  }
}

function assistantMessage(
  usage: { input: number; output: number },
  text = '回答',
  stopReason: AssistantMessage['stopReason'] = 'stop',
  measured?: { durationMs?: number },
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'faux',
    model: 'faux-1',
    usage: { input: usage.input, output: usage.output, cacheRead: 0, cacheWrite: 0, totalTokens: usage.input + usage.output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    ...(measured?.durationMs !== undefined ? { durationMs: measured.durationMs } : {}),
    timestamp: 2,
  }
}

interface ViewSpec {
  headId?: number
  headKind?: 'pi.compaction' | 'pi.reset'
  /** [entryId, contribution messages]（omit 用空数组表示：被 edit 覆盖的目标条目）。 */
  entries: Array<[number, Message[]]>
  /** 携带非空 edits 的条目 id（helm.rewind 等上下文覆盖条目；其 edits 的
   * targets 由测试用空 contribution 自行模拟，viewOf 只标注边界）。 */
  editEntryIds?: number[]
}

function viewOf(spec: ViewSpec): ContextView {
  const head =
    spec.headId !== undefined
      ? ({ id: spec.headId, kind: spec.headKind ?? 'pi.compaction' } as never)
      : undefined
  // 真实 ContextView 语义：entries = [head 标记（自身 contribution：reset 的
  // handoff / compaction 的摘要）+ 保留前缀 + 后续条目]；messages 由全部
  // contributions 组成（head 之前的旧条目不应出现在 spec 中，由测试自行保证）。
  const editIds = new Set(spec.editEntryIds ?? [])
  const entries = spec.entries.map(([id]) => ({
    id,
    kind: 'pi.assistant',
    ...(editIds.has(id) ? { edits: [{ target: 1, action: 'omit' }] } : {}),
  } as never))
  // edits 携带条目自身无 model（helm.rewind 只写 edits/data）：贡献为空；
  // 被 omit 的目标条目由测试用空 contribution 自行模拟（ContextView 已应用 edits）。
  const contributions = spec.entries.map(([id, messages]) => (editIds.has(id) ? [] : messages))
  const messages = spec.entries.flatMap(([id, msgs]) => (editIds.has(id) ? [] : msgs))
  return { head, entries, contributions, messages } as unknown as ContextView
}

describe('estimateTokens：pi agent compaction.js chars/4 分档（固定期望）', { timeout: 60_000 }, () => {
  it('user/toolResult：text 字符 /4 向上取整；图片按 4800 字符', { timeout: 60_000 }, () => {
    assert.equal(estimateTokens(userMessage('a'.repeat(400))), 100)
    assert.equal(estimateTokens(userMessage('a'.repeat(401))), 101)
    assert.equal(estimateTokens(userMessage('a'.repeat(3))), 1)
    const withImage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'a'.repeat(100) },
        { type: 'image', data: 'x', mimeType: 'image/png' },
      ],
      timestamp: 1,
    }
    assert.equal(estimateTokens(withImage), Math.ceil((100 + 4_800) / 4))
    const toolResult: Message = {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 't',
      content: [{ type: 'text', text: 'r'.repeat(400) }],
      isError: false,
      timestamp: 1,
    }
    assert.equal(estimateTokens(toolResult), 100)
  })

  it('assistant：text + thinking 字符 + toolCall 的 name 与参数 JSON 字符', { timeout: 60_000 }, () => {
    const args = { path: '/tmp/x' }
    const assistant: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'a'.repeat(100) },
        { type: 'thinking', thinking: 'b'.repeat(200) },
        { type: 'toolCall', id: 't1', name: 'n'.repeat(10), arguments: args },
      ],
      api: 'openai-completions',
      provider: 'faux',
      model: 'faux-1',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 1,
    }
    const expectedChars = 100 + 200 + 10 + JSON.stringify(args).length
    assert.equal(estimateTokens(assistant), Math.ceil(expectedChars / 4))
  })

  it('system：content + sections 值（null 跳过）+ toolsAdded JSON 合并后一次 ceil(/4)', { timeout: 60_000 }, () => {
    const tool: Tool = { name: 'demo', description: 'd'.repeat(100), parameters: {} }
    const toolsChars = JSON.stringify([tool]).length
    assert.equal(
      estimateTokens(
        systemMessage({
          content: 'a'.repeat(300),
          sections: { intro: 'b'.repeat(80), gone: null },
          toolsAdded: [tool],
        }),
      ),
      Math.ceil((300 + 80 + toolsChars) / 4),
    )
  })
})

describe('estimateContextUsage：与 pi agent getContextUsage 语义对齐（固定期望）', { timeout: 60_000 }, () => {
  it('实测锚点：边界之后最近一条有效 assistant 的 usage + 其后消息 chars/4 估算', { timeout: 60_000 }, () => {
    const anchor = assistantMessage({ input: 1_000, output: 50 }, 'm'.repeat(400)) // usage 1050
    const trailingUser = userMessage('c'.repeat(400)) // 100
    const view = viewOf({
      headId: 10,
      entries: [
        [11, [anchor]],
        [12, [trailingUser]],
      ],
    })
    assert.equal(estimateContextUsage(view).tokens, 1_050 + 100)
  })

  it('无实测锚点（无 head、无 edit）：全量估算', { timeout: 60_000 }, () => {
    const user = userMessage('x'.repeat(400)) // 100
    const anchorless = assistantMessage({ input: 0, output: 0 }, 'y'.repeat(400)) // 100
    const view = viewOf({ entries: [[11, [user]], [12, [anchorless]]] })
    assert.equal(estimateContextUsage(view).tokens, 200)
  })

  it('多条实测 assistant：取最新一条（尾向扫描第一个命中）', { timeout: 60_000 }, () => {
    const older = assistantMessage({ input: 2_000, output: 10 }, 'a'.repeat(400))
    const newer = assistantMessage({ input: 3_000, output: 20 }, 'b'.repeat(400)) // usage 3020
    const view = viewOf({
      entries: [
        [11, [older]],
        [12, [newer]],
      ],
    })
    assert.equal(estimateContextUsage(view).tokens, 3_020)
  })

  it('stopReason 为 aborted/error 的 assistant 不作锚点（pi getAssistantUsage 同款过滤）', { timeout: 60_000 }, () => {
    const aborted = assistantMessage({ input: 8_000, output: 10 }, 'a'.repeat(400), 'aborted') // 100
    const errored = assistantMessage({ input: 8_500, output: 10 }, 'b'.repeat(400), 'error') // 100
    const trailingUser = userMessage('c'.repeat(400)) // 100
    const view = viewOf({ entries: [[11, [aborted]], [12, [errored]], [13, [trailingUser]]] })
    // aborted/error 无有效 usage：不作锚点，退化为全量 chars/4 估算
    // （真实 ContextView 的 contributions 已剔除这类消息；本合成视图刻意保留，
    // 锁定「锚点扫描不得把 8k+ 假装成实测」的核心语义）。
    assert.equal(estimateContextUsage(view).tokens, 300)
  })

  it('rewind 边界（最新 edits 非空条目）之前的锚点一律失效：全量估算（pi 语义）', { timeout: 60_000 }, () => {
    const anchor = assistantMessage({ input: 5_000, output: 10 }, 'm'.repeat(400)) // 5010
    const newUser = userMessage('n'.repeat(400)) // 100
    const view = viewOf({
      editEntryIds: [9],
      entries: [
        [8, [anchor]],
        [9, []], // helm.rewind：携带 edits 的条目（自身无 model）
        [10, []], // 被 omit 的目标条目
        [11, [newUser]],
      ],
    })
    // pi：最新 context_edit 之前的 usage 不可信——即使锚点条目本身未被 omit，
    // 也不得把 5010 当作实测（旧实现在此错误地信任锚点）。
    assert.equal(estimateContextUsage(view).tokens, 100 + 100)
  })

  it('edit 之后的新 usage 恢复实测（锚点晚于 edit 边界即可信）', { timeout: 60_000 }, () => {
    const stale = assistantMessage({ input: 5_000, output: 10 }, 'm'.repeat(400)) // 5010
    const fresh = assistantMessage({ input: 3_000, output: 40 }, 'p'.repeat(400)) // 3040
    const view = viewOf({
      editEntryIds: [9],
      entries: [
        [8, [stale]],
        [9, []],
        [10, []],
        [11, [fresh]],
      ],
    })
    assert.equal(estimateContextUsage(view).tokens, 3_040)
  })

  it('压缩 head（pi.compaction）后尚无有效 usage：tokens=null，摘要估算不冒充已知上下文', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400))
    const summary = userMessage('s'.repeat(400))
    // 保留的旧前缀条目 id 均小于压缩标记：其 usage 反映压缩前规模，不可信。
    const view = viewOf({
      headId: 100,
      headKind: 'pi.compaction',
      entries: [
        [100, [summary]],
        [99, [kept]],
      ],
    })
    assert.equal(estimateContextUsage(view).tokens, null)
  })

  it('压缩 head 后已有新回答：用 post-compaction usage 实测', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400))
    const summary = userMessage('s'.repeat(400))
    const fresh = assistantMessage({ input: 3_000, output: 40 }, 'p'.repeat(400)) // 3040
    const view = viewOf({
      headId: 100,
      headKind: 'pi.compaction',
      entries: [
        [100, [summary]],
        [99, [kept]],
        [101, [fresh]],
      ],
    })
    // 锚点（101）晚于 head（100）且无 edit 边界：usage 实测，保留前缀不计入。
    assert.equal(estimateContextUsage(view).tokens, 3_040)
  })

  it('压缩后有有效回答但后续 edit 使锚点失效：全量估算（非 null，pi 两判定独立）', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400)) // 100
    const summary = userMessage('s'.repeat(400)) // 100
    const fresh = assistantMessage({ input: 3_000, output: 40 }, 'p'.repeat(400)) // 100（usage 3040）
    const view = viewOf({
      headId: 100,
      headKind: 'pi.compaction',
      editEntryIds: [102],
      entries: [
        [100, [summary]],
        [99, [kept]],
        [101, [fresh]],
        [102, []], // 压缩后的又一次 rewind（携带 edits）
      ],
    })
    // post-compaction 有效 assistant 存在（不为 null）；但锚点 101 早于 edit 边界
    // 102：退化为全量估算（摘要 + 保留前缀 + 新回答均按字符计）。
    assert.equal(estimateContextUsage(view).tokens, 100 + 100 + 100)
  })

  it('压缩后唯一有效回答被 edit omit：post-compaction 无有效 assistant，tokens=null', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400))
    const summary = userMessage('s'.repeat(400))
    const view = viewOf({
      headId: 100,
      headKind: 'pi.compaction',
      editEntryIds: [102],
      entries: [
        [100, [summary]],
        [99, [kept]],
        [101, []], // 压缩后的新回答被后续 rewind omit（contributions 为空）
        [102, []],
      ],
    })
    assert.equal(estimateContextUsage(view).tokens, null)
  })

  it('reset head（pi.reset）是全新上下文：全量估算即真实值（0 不为 null）', { timeout: 60_000 }, () => {
    const empty = viewOf({ headId: 50, headKind: 'pi.reset', entries: [[50, []], [51, []]] })
    assert.equal(estimateContextUsage(empty).tokens, 0)
    const withHandoff = viewOf({
      headId: 50,
      headKind: 'pi.reset',
      entries: [[50, [userMessage('h'.repeat(400))]], [51, []]],
    })
    assert.equal(estimateContextUsage(withHandoff).tokens, 100)
  })

  it('全量估算折叠当前生效 system：sections 按名 patch，不重复计被替换/删除的旧 section', { timeout: 60_000 }, () => {
    const sys1 = systemMessage({ sections: { intro: 'x'.repeat(400) } })
    const sys2 = systemMessage({ sections: { intro: null, guide: 'y'.repeat(400) } })
    const user = userMessage('z'.repeat(400))
    const view = viewOf({ entries: [[5, [sys1]], [6, [sys2]], [7, [user]]] })
    // 当前生效 system = sections {guide: 400}（intro 被替换删除）→ 100；user 100。
    // 旧实现逐条计 system 会把 intro+guide 双计（300）。
    assert.equal(estimateContextUsage(view).tokens, 200)
  })

  it('全量估算折叠当前生效 system：tools 重放后只计一次（追加指令计入 content）', { timeout: 60_000 }, () => {
    const tool: Tool = { name: 'demo', description: 'd'.repeat(100), parameters: {} }
    const toolsChars = JSON.stringify([tool]).length
    const sys1 = systemMessage({ toolsAdded: [tool] })
    const sys2 = systemMessage({ content: 'b'.repeat(400) })
    const user = userMessage('c'.repeat(400))
    const view = viewOf({ entries: [[5, [sys1]], [6, [sys2]], [7, [user]]] })
    // 折叠后 system：content 400 + 当前 tools（仅计一次 JSON）→ 一次 ceil；user 100。
    const expected = Math.ceil((400 + toolsChars) / 4) + 100
    assert.equal(estimateContextUsage(view).tokens, expected)
    // 旧实现双计 tools JSON：会得到 toolsChars×2 的偏大值。
    assert.notEqual(estimateContextUsage(view).tokens, Math.ceil((400 + 2 * toolsChars) / 4) + 100)
  })
})

describe('contextUsage 组装与压缩失败通知', { timeout: 60_000 }, () => {
  it('compactingOf：compactions 非空即 true；空/缺省省略', { timeout: 60_000 }, () => {
    assert.equal(compactingOf(undefined), undefined)
    assert.equal(compactingOf([]), undefined)
    assert.equal(compactingOf([{ taskId: 1, trigger: 'threshold', blocking: true }]), true)
    // 未知 trigger 形状同样是在途压缩：布尔不伪造细节。
    assert.equal(compactingOf([{ taskId: 3, trigger: 'unknown-future', blocking: false }]), true)
  })

  it('compactionFailureNoticeOf：trigger 语义 + redact 注入 + 400 字符截断', { timeout: 60_000 }, () => {
    assert.equal(
      compactionFailureNoticeOf({ taskId: 1, trigger: 'manual', error: 'sk-abc 网关 500' }, (t) => t.replace('sk-abc', '***')),
      '手动触发的上下文精简失败：*** 网关 500',
    )
    assert.equal(
      compactionFailureNoticeOf({ taskId: 2, trigger: 'overflow', error: '' }, (t) => t),
      '溢出触发的上下文精简失败（无错误详情）',
    )
    const long = compactionFailureNoticeOf({ taskId: 3, trigger: 'threshold', error: 'x'.repeat(500) }, (t) => t)
    assert.ok(long.length < 500, '错误摘要截断')
  })

  it('assembleContextUsage：可缺字段省略；指纹区分全部承载字段', { timeout: 60_000 }, () => {
    const base = assembleContextUsage({ estimate: { tokens: 100 } })
    assert.deepEqual(base, { tokens: 100 })
    const nullTokens = assembleContextUsage({ estimate: { tokens: null }, contextWindow: 128_000 })
    assert.deepEqual(nullTokens, { tokens: null, contextWindow: 128_000 })
    const full = assembleContextUsage({
      estimate: { tokens: 100 },
      contextWindow: 1_000,
      compacting: true,
    })
    assert.deepEqual(full, { tokens: 100, contextWindow: 1_000, compacting: true })
    const variants = [
      full,
      { ...full, tokens: 101 },
      { ...full, tokens: null },
      { ...full, contextWindow: undefined },
      { ...full, compacting: undefined },
    ]
    const keys = new Set(variants.map((v) => contextUsageKeyOf(v)))
    assert.equal(keys.size, variants.length, '任一承载字段变化必须产生新指纹')
    assert.equal(contextUsageKeyOf(undefined), '')
  })
})

describe('事件边界：conversation.upsert 携带 contextUsage 的形状校验', { timeout: 60_000 }, () => {
  function hubOf(): EventHub {
    return new EventHub({
      initialSeq: 0,
      snapshot: () => ({
        seq: 0,
        conversations: [],
        pendingAsks: [],
        plugins: [],
        ui: [],
        pluginDocs: [],
        conversationLives: [],
        nodes: [],
      }),
    })
  }

  const baseSummary = {
    id: 1,
    title: '会话',
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/faux-1',
    thinkingLevel: '',
    status: 'idle' as const,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }

  it('合法形状通过（tokens 可为 null；compacting 布尔）；死字段与非法形状拒绝', { timeout: 60_000 }, () => {
    const hub = hubOf()
    hub.publish('conversation.upsert', {
      conversation: {
        ...baseSummary,
        contextUsage: { tokens: null, contextWindow: 128_000, compacting: true },
      },
    })
    hub.publish('conversation.upsert', {
      conversation: {
        ...baseSummary,
        contextUsage: { tokens: 1_500, contextWindow: 128_000 },
      },
    })
    assert.equal(hub.seq, 2)
    const rejects: unknown[] = [
      { tokens: '12345' }, // tokens 非数字
      { tokens: -1 }, // 负数
      { tokens: 1, thresholds: { blockingTokens: 1 } }, // 已删除的死字段
      { tokens: 1, measuredTokens: 2 }, // 已删除的死字段
      { tokens: 1, compactionError: 'boom' }, // 已删除的死字段
      { tokens: 1, compacting: { trigger: 'manual', blocking: false } }, // compacting 已收敛为布尔
      { tokens: 1, contextWindow: 0 }, // 非正窗口
      { tokens: 1, tps: 52.4 }, // 已删除的死字段（速率归插件策略，不随用量携带）
      { tokens: 1, response: { responseTps: 52.4 } }, // 已删除的死字段（同上）
      { tokens: 1, response: { responseTps: 52.4, responseOutputTokens: 524, responseDurationMs: 10_000 } }, // 已删除的死字段（同上）
    ]
    for (const contextUsage of rejects) {
      assert.throws(
        () => hub.publish('conversation.upsert', { conversation: { ...baseSummary, contextUsage } }),
        (error: unknown) => error instanceof HelmError,
        `必须拒绝 ${JSON.stringify(contextUsage)}`,
      )
    }
    // 拒绝不推进 seq（水位线无裸缺口）。
    assert.equal(hub.seq, 2)
  })
})

// ---------------------------------------------------------------------------
// 集成：真实 KernelRuntime（faux provider + SQLite + 观察者链路）
// ---------------------------------------------------------------------------

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

let root = ''

before(async () => {
  root = await makeTempDir('helm-context-usage-')
})

after(async () => {
  await cleanupDir(root)
})

async function openRuntime(name: string): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: join(root, name),
    cwd: join(root, name),
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

const waitFor = (cond: () => boolean, ms = 15_000): Promise<void> => waitForCondition(cond, ms)

function recordUpserts(kernel: KernelRuntime, conversationId: number): {
  frames: ConversationSummary[]
  stop: () => void
} {
  const frames: ConversationSummary[] = []
  const unsubscribe = kernel.events.subscribe((frame: HelmEventFrame) => {
    if (frame.event.type !== 'conversation.upsert') return
    const conversation = (frame.event as { conversation?: ConversationSummary }).conversation
    if (conversation?.id === conversationId) frames.push(conversation)
  })
  return { frames, stop: unsubscribe }
}

function recordCompactionFailureNotices(kernel: KernelRuntime, conversationId: number): {
  notices: Array<{ title: string; body?: string }>
  stop: () => void
} {
  const notices: Array<{ title: string; body?: string }> = []
  const unsubscribe = kernel.events.subscribe((frame: HelmEventFrame) => {
    if (frame.event.type !== 'notification') return
    const event = frame.event as { level?: string; title?: string; body?: string; conversationId?: number }
    if (event.conversationId !== conversationId || event.title !== '上下文精简失败') return
    notices.push({ title: event.title ?? '', body: event.body })
  })
  return { notices, stop: unsubscribe }
}

describe('集成：摘要携带 contextUsage 与事件发布', { timeout: 60_000 }, () => {
  it('重启后 idle 历史会话：首个详情即携带 contextUsage（实测锚点可恢复）', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('idle-detail')
    kernel.__faux.setResponses([fauxAssistantMessage('历史回答')])
    await kernel.submitInput(1, '历史问题')
    await kernel.waitForIdle(1)
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 0)
    await kernel.close()

    // 重启：恢复链 observe idle 会话；首个详情（不经任何列表读/等待）必须
    // 已携带 usage（getConversationDetail 在缓存缺失时等初始刷新完成）。
    const reopened = await openRuntime('idle-detail')
    try {
      const detail = await reopened.getConversationDetail(1, { limit: 5 })
      assert.ok(detail.contextUsage, '重启后首个详情必须携带 contextUsage')
      assert.equal(typeof detail.contextUsage.tokens, 'number', '历史实测锚点恢复后 tokens 为已知数值')
      assert.ok((detail.contextUsage.tokens ?? 0) > 0)
      // 后续分页不重复刷新（缓存直通）：仍携带且值稳定。
      const page2 = await reopened.getConversationDetail(1, { limit: 5 })
      assert.ok(page2.contextUsage)
      assert.equal(page2.contextUsage.tokens, detail.contextUsage.tokens)
    } finally {
      await reopened.close()
    }
  })

  it('compat 网关静态模型：tokens 携带但 contextWindow 省略（不伪造）', { timeout: 60_000 }, async () => {
    const compatConfig: ProviderConfig = {
      id: 'gw-static',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:9',
      models: ['static-model'],
      label: '静态网关',
      enabled: true,
    }
    const kernel = await KernelRuntime.open({
      dataDir: join(root, 'compat-window'),
      cwd: join(root, 'compat-window'),
      model: 'gw-static/static-model',
      models: buildModels({ providers: [compatConfig], apiKeys: () => ({}) }),
    })
    try {
      const detail = await kernel.getConversationDetail(1, { limit: 5 })
      assert.ok(detail.contextUsage, '用量估算（tokens）仍提供')
      assert.equal(detail.contextUsage.contextWindow, undefined, '静态缺省窗口不得显示为已知窗口')
      assert.equal(detail.model, 'gw-static/static-model')
    } finally {
      await kernel.close()
    }
  })

  it('回合结算后 tokens 为实测锚点值；usage-only 变化不推进 stateChangeSeq', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('settle-usage')
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('回答一')])
      const recorded = recordUpserts(kernel, 1)
      await kernel.submitInput(1, '第一个问题')
      await kernel.waitForIdle(1)
      // 刷新是结算后的异步动作：等待实测值（初始缓存可能先以空上下文填充）。
      await waitFor(() => {
        const tokens = kernel.getConversation(1).contextUsage?.tokens
        return typeof tokens === 'number' && tokens > 0
      })
      const usage = kernel.getConversation(1).contextUsage
      assert.ok(usage, '回合结算后摘要必须携带 contextUsage')
      // 单回合：锚点（最终 assistant usage）之后无尾段消息，tokens 全为实测。
      assert.ok(typeof usage.tokens === 'number' && usage.tokens > 0, 'faux 注入真实 usage，实测锚点必须存在')
      // 速率类指标不随用量携带（策略归可选插件 builtin:token-speed）。
      assert.equal('response' in usage, false, 'contextUsage 不再携带 response 速率字段')
      // faux 模型窗口 128k 已知（内置策展数据）：如实携带。
      assert.equal(usage.contextWindow, 128_000)
      assert.equal(usage.compacting, undefined)
      // usage-only 帧：stateChangeSeq 与结算帧一致（不污染 CAS 水位线）。
      const withUsage = recorded.frames.filter((f) => f.contextUsage !== undefined)
      assert.ok(withUsage.length >= 1, '必须发布携带 contextUsage 的 conversation.upsert')
      const settled = recorded.frames.find((f) => f.status === 'done' || f.status === 'idle')
      assert.ok(settled, '必须先有终态摘要帧')
      assert.equal(withUsage[withUsage.length - 1]!.stateChangeSeq, settled.stateChangeSeq)
      recorded.stop()
    } finally {
      await kernel.close()
    }
  })

  it('reset 后上下文归零（tokens=0，无实测锚点）', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('reset-usage')
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('回答')])
      await kernel.submitInput(1, '问题')
      await kernel.waitForIdle(1)
      await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 0)
      await kernel.resetConversation(1)
      await waitFor(() => {
        const usage = kernel.getConversation(1).contextUsage
        return usage !== undefined && usage.tokens === 0
      })
      const usage = kernel.getConversation(1).contextUsage
      assert.ok(usage, '归零后的 contextUsage 必须可读')
      assert.equal(usage.tokens, 0, '空上下文无实测锚点，不得残留旧值')
    } finally {
      await kernel.close()
    }
  })

  it('空闲会话手动压缩：compacting=true 透传；完成后 tokens=null，新回答后恢复实测', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('manual-compact')
    // 构造超过 keepRecentTokens(20000) 的上下文，使 selectCut 有可压缩前缀。
    const bigInput = '大规模上下文素材。'.repeat(5_000) // 10 chars × 5000 = 50000 字符/条
    kernel.__faux.setResponses([
      fauxAssistantMessage('答一'),
      fauxAssistantMessage('答二'),
      fauxAssistantMessage('答三'),
    ])
    for (const text of [`${bigInput}一`, `${bigInput}二`, `${bigInput}三`]) {
      await kernel.submitInput(1, text)
      await kernel.waitForIdle(1)
    }
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 30_000, 20_000)
    const beforeCompact = kernel.getConversation(1).contextUsage!.tokens as number
    assert.ok(beforeCompact > 30_000, '压缩前上下文必须足够大（实际不够时应加大素材）')

    // 压缩摘要请求用门闩挂住：稳定观测 compacting 透传（空闲会话无 live 帧）。
    let releaseSummary = () => {}
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
    kernel.__faux.setResponses([async () => {
      await summaryGate
      return fauxAssistantMessage('历史已精简为该摘要')
    }])
    const recorded = recordUpserts(kernel, 1)
    try {
      await kernel.compactConversation(1)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 20_000)
      // 透传同样到达事件流（conversation.upsert 携带 compacting）。
      await waitFor(() => recorded.frames.some((f) => f.contextUsage?.compacting === true))
      releaseSummary()
      // 压缩完成：pi.compaction 落地且尚无 post-compaction usage —— tokens=null，
      // 绝不拿摘要字符估算冒充已知上下文（pi getContextUsage 同款语义）。
      await waitFor(() => {
        const usage = kernel.getConversation(1).contextUsage
        return usage !== undefined && usage.compacting === undefined && usage.tokens === null
      }, 20_000)
      const after = kernel.getConversation(1).contextUsage!
      assert.equal(after.tokens, null, '压缩后尚无新回答：上下文规模未知')
      // pi.compaction 条目真实落地（时间线分割线数据源）。
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      assert.ok(detail.entries.some((entry) => entry.kind === 'pi.compaction'), '必须产生 pi.compaction 条目')

      // 下一次回答产生有效 usage 后恢复实测。
      kernel.__faux.setResponses([fauxAssistantMessage('压缩后的新回答')])
      await kernel.submitInput(1, '压缩后的新问题')
      await kernel.waitForIdle(1)
      await waitFor(() => {
        const tokens = kernel.getConversation(1).contextUsage?.tokens
        return typeof tokens === 'number' && tokens > 0
      }, 20_000)
      assert.equal(kernel.getConversation(1).contextUsage!.tokens === null, false)
      recorded.stop()
    } finally {
      releaseSummary()
      await kernel.close()
    }
  })

  it('压缩失败恰发一次脱敏 notification；后续回合不重复通知', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('compact-failure')
    // 3 轮大素材：保证 keepRecentTokens(20000) 之外还有可压缩前缀（2 轮时
    // selectCut 无可压缩区间，任务会静默完成而不产生失败）。
    const bigInput = '失败场景上下文素材。'.repeat(5_000)
    kernel.__faux.setResponses([
      fauxAssistantMessage('答一'),
      fauxAssistantMessage('答二'),
      fauxAssistantMessage('答三'),
    ])
    for (const text of [`${bigInput}一`, `${bigInput}二`, `${bigInput}三`]) {
      await kernel.submitInput(1, text)
      await kernel.waitForIdle(1)
    }
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 30_000, 20_000)

    // 摘要请求返回不可重试的 error：压缩任务失败，compactionFailure 落 pi.live。
    kernel.__faux.setResponses([
      fauxAssistantMessage('摘要失败', { stopReason: 'error', errorMessage: 'faux summarization rejected' }),
    ])
    const recorded = recordCompactionFailureNotices(kernel, 1)
    try {
      await kernel.compactConversation(1)
      await waitFor(() => recorded.notices.length === 1, 20_000)
      assert.match(recorded.notices[0]!.body ?? '', /faux summarization rejected/, '失败通知携带错误摘要')
      assert.match(recorded.notices[0]!.body ?? '', /手动/, '失败通知标注触发方式')

      // 同一失败在后续快照（新回合、用量刷新）中重复出现：不得重复通知。
      kernel.__faux.setResponses([fauxAssistantMessage('失败后的正常回答')])
      await kernel.submitInput(1, '后续问题')
      await kernel.waitForIdle(1)
      await waitFor(() => {
        const tokens = kernel.getConversation(1).contextUsage?.tokens
        return typeof tokens === 'number' && tokens > 0
      }, 20_000)
      // 快照已多次推进（压缩失败仍在 pi.live）：通知数仍为 1。
      assert.equal(recorded.notices.length, 1, '同一压缩失败不得重复通知')
    } finally {
      recorded.stop()
      await kernel.close()
    }
  })
})
