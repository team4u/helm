/**
 * conversation context use amount (contextUsage) end-to-end contract:
 *
 * 1. pure function estimateContextUsage and pi agent 1.5.2 `getContextUsage` /
 *    `estimateProjectedContextTokens` semantics align: measured anchor (head after most near a
 *    stopReason non- aborted/error and usage>0  assistant)+ tail segment estimate compute; anchor
 *    expires (without usage / exceeds head / by omit override) retreat is when before valid message all amount estimate compute;
 *    most near once compress (head is pi.compaction) after still without valid usage when tokens=null
 *    (summary character estimate compute do not smoke fill known context);reset is all new context, all amount estimate compute is real value;
 * 2. group install and pass-through:compacting boolean pass-through; compress failed via notification notify (redaction +
 *    by taskId dedupe), no longer follow use amount carry failed summary; rate class metric (response) already converge
 *    to optional plugin builtin:token-speed(kernel zero rate compute, contract level die field lock);
 * 3. collection into (real KernelRuntime + faux provider + SQLite): turn compute after summary carry
 *    contextUsage;usage-only change publish conversation.upsert but do not push enter
 *    stateChangeSeq;reset after reset to zero; manually compress during compacting=true can reach, after completion
 *    tokens=null until under once answer produce valid usage; compress failed exactly once redaction
 *    notification, after continue turn does not repeat.
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
// construct tool: pure function test ContextView / Message shape
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
  text = 'answer',
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
  /** [entryId, contribution messages](omit use empty array means: by edit override target item). */
  entries: Array<[number, Message[]]>
  /** carry non-empty edits item id(helm.rewind etc. context override item; its edits 
   * targets by test use empty contribution self row simulated,viewOf only mark note boundary). */
  editEntryIds?: number[]
}

function viewOf(spec: ViewSpec): ContextView {
  const head =
    spec.headId !== undefined
      ? ({ id: spec.headId, kind: spec.headKind ?? 'pi.compaction' } as never)
      : undefined
  // real ContextView semantics:entries = [head mark record (itself contribution:reset 
  // handoff / compaction summary)+ keep prefix + after continue item];messages by all
  // contributions group into (head before old item must not appear in spec in, by test self row guarantee).
  const editIds = new Set(spec.editEntryIds ?? [])
  const entries = spec.entries.map(([id]) => ({
    id,
    kind: 'pi.assistant',
    ...(editIds.has(id) ? { edits: [{ target: 1, action: 'omit' }] } : {}),
  } as never))
  // edits carry item itself without model(helm.rewind only write edits/data): contribution is empty;
  // by omit target item by test use empty contribution self row simulated (ContextView already should use edits).
  const contributions = spec.entries.map(([id, messages]) => (editIds.has(id) ? [] : messages))
  const messages = spec.entries.flatMap(([id, msgs]) => (editIds.has(id) ? [] : msgs))
  return { head, entries, contributions, messages } as unknown as ContextView
}

describe('estimateTokens:pi agent compaction.js chars/4 Profile (fixed expectation)', { timeout: 60_000 }, () => {
  it('user/toolResult:text character /4 to on take whole; diagram piece by 4800 character', { timeout: 60_000 }, () => {
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

  it('assistant:text + thinking character + toolCall  name and parameter JSON character', { timeout: 60_000 }, () => {
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

  it('system:content + sections value (null skip)+ toolsAdded JSON merge after once ceil(/4)', { timeout: 60_000 }, () => {
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

describe('estimateContextUsage: and pi agent getContextUsage semantics align (fixed expectation)', { timeout: 60_000 }, () => {
  it('measured anchor: boundary after most near a valid assistant  usage + its after message chars/4 estimate compute', { timeout: 60_000 }, () => {
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

  it('without measured anchor (without head, without edit): all amount estimate compute', { timeout: 60_000 }, () => {
    const user = userMessage('x'.repeat(400)) // 100
    const anchorless = assistantMessage({ input: 0, output: 0 }, 'y'.repeat(400)) // 100
    const view = viewOf({ entries: [[11, [user]], [12, [anchorless]]] })
    assert.equal(estimateContextUsage(view).tokens, 200)
  })

  it('many measured assistant: take most new a (tail to scan a hit)', { timeout: 60_000 }, () => {
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

  it('stopReason is aborted/error  assistant do not act anchor (pi getAssistantUsage same style filter)', { timeout: 60_000 }, () => {
    const aborted = assistantMessage({ input: 8_000, output: 10 }, 'a'.repeat(400), 'aborted') // 100
    const errored = assistantMessage({ input: 8_500, output: 10 }, 'b'.repeat(400), 'error') // 100
    const trailingUser = userMessage('c'.repeat(400)) // 100
    const view = viewOf({ entries: [[11, [aborted]], [12, [errored]], [13, [trailingUser]]] })
    // aborted/error without valid usage: do not act anchor, retreat is all amount chars/4 estimate compute
    // (real ContextView  contributions already remove this kind of message; this together into view moment intent keep,
    // lock anchor scan must not 8k+ pretend into measured core semantics).
    assert.equal(estimateContextUsage(view).tokens, 300)
  })

  it('rewind boundary (most new edits non-empty item) before anchor one rule expires: all amount estimate compute (pi semantics)', { timeout: 60_000 }, () => {
    const anchor = assistantMessage({ input: 5_000, output: 10 }, 'm'.repeat(400)) // 5010
    const newUser = userMessage('n'.repeat(400)) // 100
    const view = viewOf({
      editEntryIds: [9],
      entries: [
        [8, [anchor]],
        [9, []], // helm.rewind: carry edits item (itself without model)
        [10, []], // by omit target item
        [11, [newUser]],
      ],
    })
    // pi: most new context_edit before usage cannot message - - even if anchor item itself not by omit,
    // also must not 5010 when act measured (old implement in this error ground trust anchor).
    assert.equal(estimateContextUsage(view).tokens, 100 + 100)
  })

  it('edit after new usage restore measured (anchor later than edit boundary i.e. can message)', { timeout: 60_000 }, () => {
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

  it('compress head(pi.compaction) after still without valid usage:tokens=null, summary estimate compute do not smoke fill known context', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400))
    const summary = userMessage('s'.repeat(400))
    // keep old prefix item id all less than compress mark record: its usage reverse reflect compress before rule mode, cannot message.
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

  it('compress head after already has new answer: use post-compaction usage measured', { timeout: 60_000 }, () => {
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
    // anchor (101) later than head(100) and without edit boundary:usage measured, keep prefix do not count.
    assert.equal(estimateContextUsage(view).tokens, 3_040)
  })

  it('compress after has valid answer but after continue edit make anchor expires: all amount estimate compute (non- null,pi two decide independent)', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400)) // 100
    const summary = userMessage('s'.repeat(400)) // 100
    const fresh = assistantMessage({ input: 3_000, output: 40 }, 'p'.repeat(400)) // 100(usage 3040)
    const view = viewOf({
      headId: 100,
      headKind: 'pi.compaction',
      editEntryIds: [102],
      entries: [
        [100, [summary]],
        [99, [kept]],
        [101, [fresh]],
        [102, []], // compress after again once rewind(carry edits)
      ],
    })
    // post-compaction valid assistant store in (do not is null); but anchor 101 early at edit boundary
    // 102: retreat is all amount estimate compute (summary + keep prefix + new answer all by character count).
    assert.equal(estimateContextUsage(view).tokens, 100 + 100 + 100)
  })

  it('compress after unique valid answer by edit omit:post-compaction without valid assistant,tokens=null', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400))
    const summary = userMessage('s'.repeat(400))
    const view = viewOf({
      headId: 100,
      headKind: 'pi.compaction',
      editEntryIds: [102],
      entries: [
        [100, [summary]],
        [99, [kept]],
        [101, []], // compress after new answer by after continue rewind omit(contributions is empty)
        [102, []],
      ],
    })
    assert.equal(estimateContextUsage(view).tokens, null)
  })

  it('reset head(pi.reset) is all new context: all amount estimate compute i.e. real value (0 do not is null)', { timeout: 60_000 }, () => {
    const empty = viewOf({ headId: 50, headKind: 'pi.reset', entries: [[50, []], [51, []]] })
    assert.equal(estimateContextUsage(empty).tokens, 0)
    const withHandoff = viewOf({
      headId: 50,
      headKind: 'pi.reset',
      entries: [[50, [userMessage('h'.repeat(400))]], [51, []]],
    })
    assert.equal(estimateContextUsage(withHandoff).tokens, 100)
  })

  it('all amount estimate compute collapse when before takes effect system:sections by name patch, does not repeat count by replace/delete old section', { timeout: 60_000 }, () => {
    const sys1 = systemMessage({ sections: { intro: 'x'.repeat(400) } })
    const sys2 = systemMessage({ sections: { intro: null, guide: 'y'.repeat(400) } })
    const user = userMessage('z'.repeat(400))
    const view = viewOf({ entries: [[5, [sys1]], [6, [sys2]], [7, [user]]] })
    // when before takes effect system = sections {guide: 400}(intro by replace delete)→ 100;user 100.
    // old implement one by one count system will intro+guide double count (300).
    assert.equal(estimateContextUsage(view).tokens, 200)
  })

  it('all amount estimate compute collapse when before takes effect system:tools replay after only count once (append instruction count content)', { timeout: 60_000 }, () => {
    const tool: Tool = { name: 'demo', description: 'd'.repeat(100), parameters: {} }
    const toolsChars = JSON.stringify([tool]).length
    const sys1 = systemMessage({ toolsAdded: [tool] })
    const sys2 = systemMessage({ content: 'b'.repeat(400) })
    const user = userMessage('c'.repeat(400))
    const view = viewOf({ entries: [[5, [sys1]], [6, [sys2]], [7, [user]]] })
    // collapse after system:content 400 + when before tools(only count once JSON)→ once ceil;user 100.
    const expected = Math.ceil((400 + toolsChars) / 4) + 100
    assert.equal(estimateContextUsage(view).tokens, expected)
    // old implement double count tools JSON: will obtain to toolsChars×2 bias large value.
    assert.notEqual(estimateContextUsage(view).tokens, Math.ceil((400 + 2 * toolsChars) / 4) + 100)
  })
})

describe('contextUsage group install and compress failed notify', { timeout: 60_000 }, () => {
  it('compactingOf:compactions non-empty i.e. true; empty/default omit', { timeout: 60_000 }, () => {
    assert.equal(compactingOf(undefined), undefined)
    assert.equal(compactingOf([]), undefined)
    assert.equal(compactingOf([{ taskId: 1, trigger: 'threshold', blocking: true }]), true)
    // unknown trigger shape same is in-flight compress: boolean do not fabricate detail.
    assert.equal(compactingOf([{ taskId: 3, trigger: 'unknown-future', blocking: false }]), true)
  })

  it('compactionFailureNoticeOf:trigger semantics + redact inject + 400 character truncate', { timeout: 60_000 }, () => {
    assert.equal(
      compactionFailureNoticeOf({ taskId: 1, trigger: 'manual', error: 'sk-abc gateway 500' }, (t) => t.replace('sk-abc', '***')),
      'manually trigger context streamline failed:*** gateway 500',
    )
    assert.equal(
      compactionFailureNoticeOf({ taskId: 2, trigger: 'overflow', error: '' }, (t) => t),
      'overflow trigger context streamline failed (without error detail)',
    )
    const long = compactionFailureNoticeOf({ taskId: 3, trigger: 'threshold', error: 'x'.repeat(500) }, (t) => t)
    assert.ok(long.length < 500, 'error summary truncate')
  })

  it('assembleContextUsage: can missing field omit; refer grain zone all bear load field', { timeout: 60_000 }, () => {
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
    assert.equal(keys.size, variants.length, 'any one bear load field change must produce new refer grain')
    assert.equal(contextUsageKeyOf(undefined), '')
  })
})

describe('event boundary:conversation.upsert carry contextUsage shape validate', { timeout: 60_000 }, () => {
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
    title: 'conversation',
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

  it('legal shape via (tokens can is null;compacting boolean); die field and illegal shape reject', { timeout: 60_000 }, () => {
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
      { tokens: '12345' }, // tokens non- number
      { tokens: -1 }, // negative number
      { tokens: 1, thresholds: { blockingTokens: 1 } }, // deleted die field
      { tokens: 1, measuredTokens: 2 }, // deleted die field
      { tokens: 1, compactionError: 'boom' }, // deleted die field
      { tokens: 1, compacting: { trigger: 'manual', blocking: false } }, // compacting already converge is boolean
      { tokens: 1, contextWindow: 0 }, // non- correct window
      { tokens: 1, tps: 52.4 }, // deleted die field (rate archive plugin policy, do not follow use amount carry)
      { tokens: 1, response: { responseTps: 52.4 } }, // deleted die field (same on)
      { tokens: 1, response: { responseTps: 52.4, responseOutputTokens: 524, responseDurationMs: 10_000 } }, // deleted die field (same on)
    ]
    for (const contextUsage of rejects) {
      assert.throws(
        () => hub.publish('conversation.upsert', { conversation: { ...baseSummary, contextUsage } }),
        (error: unknown) => error instanceof HelmError,
        `must reject ${JSON.stringify(contextUsage)}`,
      )
    }
    // reject do not push enter seq(watermark line without bare missing opening).
    assert.equal(hub.seq, 2)
  })
})

// ---------------------------------------------------------------------------
// collection into: real KernelRuntime(faux provider + SQLite + observer link)
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
    if (event.conversationId !== conversationId || event.title !== 'context streamline failed') return
    notices.push({ title: event.title ?? '', body: event.body })
  })
  return { notices, stop: unsubscribe }
}

describe('collection into: summary carry contextUsage and event publish', { timeout: 60_000 }, () => {
  it('after restart idle history conversation: first detail situation i.e. carry contextUsage(measured anchor can restore)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('idle-detail')
    kernel.__faux.setResponses([fauxAssistantMessage('history answer')])
    await kernel.submitInput(1, 'history issue')
    await kernel.waitForIdle(1)
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 0)
    await kernel.close()

    // restart: restore chain observe idle conversation; first detail read returns immediately without blocking on
    // background contextUsage computation, and once ready pushes/caches usage so subsequent reads include it.
    const reopened = await openRuntime('idle-detail')
    try {
      const detail = await reopened.getConversationDetail(1, { limit: 5 })
      assert.ok(detail.entries.length >= 1, 'detail returns entries immediately without waiting on contextUsage')
      await waitFor(() => (reopened.getConversation(1).contextUsage?.tokens ?? 0) > 0, 10_000)
      const tokens = reopened.getConversation(1).contextUsage!.tokens
      assert.equal(typeof tokens, 'number', 'history measured anchor restore after tokens is known count value')
      // after continue page does not repeat refresh (cache direct through): still carry and value stable.
      const page2 = await reopened.getConversationDetail(1, { limit: 5 })
      assert.ok(page2.contextUsage)
      assert.equal(page2.contextUsage.tokens, tokens)
    } finally {
      await reopened.close()
    }
  })

  it('compat gateway static model:tokens carry but contextWindow omit (do not fabricate)', { timeout: 60_000 }, async () => {
    const compatConfig: ProviderConfig = {
      id: 'gw-static',
      protocol: 'openai',
      baseUrl: 'http://127.0.0.1:9',
      models: ['static-model'],
      label: 'static gateway',
      enabled: true,
    }
    const kernel = await KernelRuntime.open({
      dataDir: join(root, 'compat-window'),
      cwd: join(root, 'compat-window'),
      model: 'gw-static/static-model',
      models: buildModels({ providers: [compatConfig], apiKeys: () => ({}) }),
    })
    try {
      const recorded = recordUpserts(kernel, 1)
      const firstDetail = await kernel.getConversationDetail(1, { limit: 5 })
      assert.equal(firstDetail.model, 'gw-static/static-model')
      await waitFor(() => kernel.getConversation(1).contextUsage !== undefined, 10_000)
      const detail = await kernel.getConversationDetail(1, { limit: 5 })
      assert.ok(detail.contextUsage, 'use amount estimate compute (tokens) still provide')
      assert.equal(detail.contextUsage.contextWindow, undefined, 'static default window must not show is known window')
      if (firstDetail.contextUsage === undefined) {
        await waitFor(() => recorded.frames.some((f) => f.contextUsage !== undefined), 5_000)
      }
    } finally {
      await kernel.close()
    }
  })

  it('turn compute after tokens is measured anchor value;usage-only change do not push enter stateChangeSeq', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('settle-usage')
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('answer one')])
      const recorded = recordUpserts(kernel, 1)
      await kernel.submitInput(1, 'a issue')
      await kernel.waitForIdle(1)
      // refresh is compute after async action: wait for measured value (initial cache may first with empty context fill).
      await waitFor(() => {
        const tokens = kernel.getConversation(1).contextUsage?.tokens
        return typeof tokens === 'number' && tokens > 0
      })
      const usage = kernel.getConversation(1).contextUsage
      assert.ok(usage, 'turn compute after summary must carry contextUsage')
      // single turn: anchor (eventually assistant usage) after without tail segment message,tokens all is measured.
      assert.ok(typeof usage.tokens === 'number' && usage.tokens > 0, 'faux inject real usage, measured anchor must store in')
      // rate class metric do not follow use amount carry (policy archive optional plugin builtin:token-speed).
      assert.equal('response' in usage, false, 'contextUsage no longer carry response rate field')
      // faux model window 128k known (inside placement policy expand data): such as carry.
      assert.equal(usage.contextWindow, 128_000)
      assert.equal(usage.compacting, undefined)
      // usage-only frame:stateChangeSeq and compute frame consistent (do not pollute CAS watermark line).
      const withUsage = recorded.frames.filter((f) => f.contextUsage !== undefined)
      assert.ok(withUsage.length >= 1, 'must publish carry contextUsage  conversation.upsert')
      const settled = recorded.frames.find((f) => f.status === 'done' || f.status === 'idle')
      assert.ok(settled, 'must first has terminal state summary frame')
      assert.equal(withUsage[withUsage.length - 1]!.stateChangeSeq, settled.stateChangeSeq)
      recorded.stop()
    } finally {
      await kernel.close()
    }
  })

  it('reset after context reset to zero (tokens=0, without measured anchor)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('reset-usage')
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('answer')])
      await kernel.submitInput(1, 'issue')
      await kernel.waitForIdle(1)
      await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 0)
      await kernel.resetConversation(1)
      await waitFor(() => {
        const usage = kernel.getConversation(1).contextUsage
        return usage !== undefined && usage.tokens === 0
      })
      const usage = kernel.getConversation(1).contextUsage
      assert.ok(usage, 'reset to zero after contextUsage must can read')
      assert.equal(usage.tokens, 0, 'empty context without measured anchor, must not leftover old value')
    } finally {
      await kernel.close()
    }
  })

  it('idle conversation manually compress:compacting=true pass-through; after completion tokens=null, new answer after restore measured', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('manual-compact')
    // construct exceeds keepRecentTokens(20000) context, make selectCut has can compress prefix.
    const bigInput = '大规模上下文素材。'.repeat(5_000) // 10 chars × 5000 = 50000 character/
    kernel.__faux.setResponses([
      fauxAssistantMessage('answer one'),
      fauxAssistantMessage('answer two'),
      fauxAssistantMessage('answer three'),
    ])
    for (const text of [`${bigInput}one`, `${bigInput}two`, `${bigInput}three`]) {
      await kernel.submitInput(1, text)
      await kernel.waitForIdle(1)
    }
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 30_000, 20_000)
    const beforeCompact = kernel.getConversation(1).contextUsage!.tokens as number
    assert.ok(beforeCompact > 30_000, 'compress before context must enough large (actual do not enough when should add large element material)')

    // compress summary request use latch hang: stable observability compacting pass-through (idle conversation without live frame).
    let releaseSummary = () => {}
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
    kernel.__faux.setResponses([async () => {
      await summaryGate
      return fauxAssistantMessage('history already streamline is the summary')
    }])
    const recorded = recordUpserts(kernel, 1)
    try {
      await kernel.compactConversation(1)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 20_000)
      // pass-through same reach event stream (conversation.upsert carry compacting).
      await waitFor(() => recorded.frames.some((f) => f.contextUsage?.compacting === true))
      releaseSummary()
      // compress complete:pi.compaction persisted and still without post-compaction usage - - tokens=null,
      // never take summary character estimate compute smoke fill known context (pi getContextUsage same style semantics).
      await waitFor(() => {
        const usage = kernel.getConversation(1).contextUsage
        return usage !== undefined && usage.compacting === undefined && usage.tokens === null
      }, 20_000)
      const after = kernel.getConversation(1).contextUsage!
      assert.equal(after.tokens, null, 'compress after still without new answer: context rule mode unknown')
      // pi.compaction item real persisted (timeline split line data source).
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      assert.ok(detail.entries.some((entry) => entry.kind === 'pi.compaction'), 'must produce pi.compaction item')

      // under once answer produce valid usage after restore measured.
      kernel.__faux.setResponses([fauxAssistantMessage('compress after new answer')])
      await kernel.submitInput(1, 'compress after new issue')
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

  it('compress failed exactly once redaction notification; after continue turn does not repeat notify', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('compact-failure')
    // 3 round large element material: guarantee keepRecentTokens(20000) of outside also has can compress prefix (2 round when
    // selectCut without can compress zone between, task will static default complete while produces no failed).
    const bigInput = '失败场景上下文素材。'.repeat(5_000)
    kernel.__faux.setResponses([
      fauxAssistantMessage('answer one'),
      fauxAssistantMessage('answer two'),
      fauxAssistantMessage('answer three'),
    ])
    for (const text of [`${bigInput}one`, `${bigInput}two`, `${bigInput}three`]) {
      await kernel.submitInput(1, text)
      await kernel.waitForIdle(1)
    }
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 30_000, 20_000)

    // summary request return cannot retry error: compress task failed,compactionFailure  pi.live.
    kernel.__faux.setResponses([
      fauxAssistantMessage('summary failed', { stopReason: 'error', errorMessage: 'faux summarization rejected' }),
    ])
    const recorded = recordCompactionFailureNotices(kernel, 1)
    try {
      await kernel.compactConversation(1)
      await waitFor(() => recorded.notices.length === 1, 20_000)
      assert.match(recorded.notices[0]!.body ?? '', /faux summarization rejected/, 'failed notify carry error summary')
      assert.match(recorded.notices[0]!.body ?? '', /manually/, 'failed notify mark note trigger way')

      // the same failed in after continue snapshot (new turn, use amount refresh) in duplicate appear: must not duplicate notify.
      kernel.__faux.setResponses([fauxAssistantMessage('failed after normal answer')])
      await kernel.submitInput(1, 'after continue issue')
      await kernel.waitForIdle(1)
      await waitFor(() => {
        const tokens = kernel.getConversation(1).contextUsage?.tokens
        return typeof tokens === 'number' && tokens > 0
      }, 20_000)
      // snapshot already many time push enter (compress failed still in pi.live): notify count still is 1.
      assert.equal(recorded.notices.length, 1, 'the same compress failed must not duplicate notify')
    } finally {
      recorded.stop()
      await kernel.close()
    }
  })
})
