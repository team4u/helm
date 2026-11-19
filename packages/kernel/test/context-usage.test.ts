/**
 * End-to-end contract tests for conversation contextUsage:
 *
 * 1. Pure function estimateContextUsage matches pi-agent 1.5.2 `getContextUsage` /
 *    `estimateProjectedContextTokens` semantics: measured anchor (latest non-aborted/error
 *    assistant after head with usage>0) + trailing estimation; invalidated anchor
 *    (missing usage / before head / invalidated by omit edits) falls back to full estimation;
 *    after latest compaction (head is pi.compaction) without subsequent valid usage -> tokens=null
 *    (never guesses context size from summary chars); reset starts a fresh context estimating to 0;
 * 2. Assembly & passthrough: boolean compacting passthrough; compaction failures report via notification
 *    (redacted + deduplicated by taskId) rather than carrying error strings on usage; throughput metrics
 *    belong to optional plugin builtin:token-speed (kernel does zero rate calculation; contract locks dead fields);
 * 3. Integration (real KernelRuntime + faux provider + SQLite): summary carries contextUsage after turn
 *    settlement; usage-only updates emit conversation.upsert without advancing stateChangeSeq; reset zeroes
 *    usage; manual compaction shows compacting=true while running and tokens=null afterwards until next
 *    reply produces valid usage; compaction failure emits exactly one redacted notification without repeating.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { join } from 'node:path'
import type { ContextView } from '@earendil-works/pi-durable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage, Message, SystemMessage, Tool, UserMessage } from '@earendil-works/pi-ai'
import type { ConversationSummary, HelmxEventFrame } from '@helmx/protocol'
import { HelmxError } from '@helmx/protocol'
import type { ProviderConfig } from '@helmx/protocol'
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
// Test builders: pure ContextView / Message shapes
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
  /** [entryId, contribution messages] (targets invalidated by omit use empty arrays). */
  entries: Array<[number, Message[]]>
  /** Entry IDs carrying non-empty edits (e.g. helmx.rewind; omitted targets are simulated with empty contributions, viewOf marks boundary). */
  editEntryIds?: number[]
}

function viewOf(spec: ViewSpec): ContextView {
  const head =
    spec.headId !== undefined
      ? ({ id: spec.headId, kind: spec.headKind ?? 'pi.compaction' } as never)
      : undefined
  // Real ContextView semantics: entries = [head marker (own contribution: reset handoff / compaction summary)
  // + kept prefix + subsequent entries]; messages aggregates all contributions (pre-head entries omitted by spec).
  const editIds = new Set(spec.editEntryIds ?? [])
  const entries = spec.entries.map(([id]) => ({
    id,
    kind: 'pi.assistant',
    ...(editIds.has(id) ? { edits: [{ target: 1, action: 'omit' }] } : {}),
  } as never))
  // Entries with edits have no model field (helmx.rewind writes only edits/data), so empty contribution.
  const contributions = spec.entries.map(([id, messages]) => (editIds.has(id) ? [] : messages))
  const messages = spec.entries.flatMap(([id, msgs]) => (editIds.has(id) ? [] : msgs))
  return { head, entries, contributions, messages } as unknown as ContextView
}

describe('estimateTokens: pi-agent compaction chars/4 heuristic (pinned expectations)', { timeout: 60_000 }, () => {
  it('user/toolResult: text chars / 4 rounded up; images count as 4800 chars', { timeout: 60_000 }, () => {
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

  it('assistant: text + thinking chars + toolCall name and argument JSON chars', { timeout: 60_000 }, () => {
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

  it('system: content + section values (null skipped) + toolsAdded JSON summed before single ceil(/4)', { timeout: 60_000 }, () => {
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

describe('estimateContextUsage: parity with pi-agent getContextUsage (pinned expectations)', { timeout: 60_000 }, () => {
  it('measured anchor: latest valid assistant usage after head + trailing message chars/4 estimate', { timeout: 60_000 }, () => {
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

  it('no measured anchor (no head, no edits): full estimation', { timeout: 60_000 }, () => {
    const user = userMessage('x'.repeat(400)) // 100
    const anchorless = assistantMessage({ input: 0, output: 0 }, 'y'.repeat(400)) // 100
    const view = viewOf({ entries: [[11, [user]], [12, [anchorless]]] })
    assert.equal(estimateContextUsage(view).tokens, 200)
  })

  it('multiple measured assistants: selects latest (first match scanning from tail)', { timeout: 60_000 }, () => {
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

  it('aborted/error assistant is never used as anchor (matching pi getAssistantUsage filter)', { timeout: 60_000 }, () => {
    const aborted = assistantMessage({ input: 8_000, output: 10 }, 'a'.repeat(400), 'aborted') // 100
    const errored = assistantMessage({ input: 8_500, output: 10 }, 'b'.repeat(400), 'error') // 100
    const trailingUser = userMessage('c'.repeat(400)) // 100
    const view = viewOf({ entries: [[11, [aborted]], [12, [errored]], [13, [trailingUser]]] })
    // Aborted/error messages without valid usage fall back to full chars/4 estimation
    // (real ContextView contributions already omit these, so locking the scan ensures we never trust bogus 8k+ values).
    assert.equal(estimateContextUsage(view).tokens, 300)
  })

  it('rewind boundary (latest entry with non-empty edits) invalidates earlier anchors: falls back to full estimation (pi semantics)', { timeout: 60_000 }, () => {
    const anchor = assistantMessage({ input: 5_000, output: 10 }, 'm'.repeat(400)) // 5010
    const newUser = userMessage('n'.repeat(400)) // 100
    const view = viewOf({
      editEntryIds: [9],
      entries: [
        [8, [anchor]],
        [9, []], // helmx.rewind: carries edits without model
        [10, []], // omitted target entry
        [11, [newUser]],
      ],
    })
    // Usage before the latest context_edit is stale even if the anchor entry itself was not omitted;
    // must not trust 5010 as measured.
    assert.equal(estimateContextUsage(view).tokens, 100 + 100)
  })

  it('new usage after edit restores measured anchor (anchor newer than edit boundary)', { timeout: 60_000 }, () => {
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

  it('compaction head (pi.compaction) with no subsequent valid usage: tokens=null (never fakes known context from summary estimate)', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400))
    const summary = userMessage('s'.repeat(400))
    // Kept prefix entry ID is below compaction marker: its usage reflects pre-compaction context and cannot be used.
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

  it('new reply after compaction head: uses post-compaction measured usage', { timeout: 60_000 }, () => {
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
    // Anchor (101) is newer than head (100) with no intervening edit boundary: usage is measured, kept prefix excluded.
    assert.equal(estimateContextUsage(view).tokens, 3_040)
  })

  it('valid post-compaction reply later invalidated by edit: falls back to full estimation (non-null, independent checks)', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400)) // 100
    const summary = userMessage('s'.repeat(400)) // 100
    const fresh = assistantMessage({ input: 3_000, output: 40 }, 'p'.repeat(400)) // 100 (usage 3040)
    const view = viewOf({
      headId: 100,
      headKind: 'pi.compaction',
      editEntryIds: [102],
      entries: [
        [100, [summary]],
        [99, [kept]],
        [101, [fresh]],
        [102, []], // subsequent rewind (with edits) after compaction
      ],
    })
    // A valid post-compaction assistant exists (so not null), yet anchor 101 precedes edit boundary 102:
    // falls back to full char estimation (summary + kept prefix + reply).
    assert.equal(estimateContextUsage(view).tokens, 100 + 100 + 100)
  })

  it('only valid post-compaction reply omitted by edit: no valid post-compaction assistant -> tokens=null', { timeout: 60_000 }, () => {
    const kept = assistantMessage({ input: 40_000, output: 100 }, 'k'.repeat(400))
    const summary = userMessage('s'.repeat(400))
    const view = viewOf({
      headId: 100,
      headKind: 'pi.compaction',
      editEntryIds: [102],
      entries: [
        [100, [summary]],
        [99, [kept]],
        [101, []], // post-compaction reply omitted by subsequent rewind (empty contributions)
        [102, []],
      ],
    })
    assert.equal(estimateContextUsage(view).tokens, null)
  })

  it('reset head (pi.reset) starts fresh context: full estimation is exact (0 rather than null)', { timeout: 60_000 }, () => {
    const empty = viewOf({ headId: 50, headKind: 'pi.reset', entries: [[50, []], [51, []]] })
    assert.equal(estimateContextUsage(empty).tokens, 0)
    const withHandoff = viewOf({
      headId: 50,
      headKind: 'pi.reset',
      entries: [[50, [userMessage('h'.repeat(400))]], [51, []]],
    })
    assert.equal(estimateContextUsage(withHandoff).tokens, 100)
  })

  it('full estimation folds active system state: named section overrides avoid double-counting replaced/deleted sections', { timeout: 60_000 }, () => {
    const sys1 = systemMessage({ sections: { intro: 'x'.repeat(400) } })
    const sys2 = systemMessage({ sections: { intro: null, guide: 'y'.repeat(400) } })
    const user = userMessage('z'.repeat(400))
    const view = viewOf({ entries: [[5, [sys1]], [6, [sys2]], [7, [user]]] })
    // Active system = sections {guide: 400} (intro deleted via null) -> 100; user 100.
    // Summing raw historical systems would double-count intro+guide (300).
    assert.equal(estimateContextUsage(view).tokens, 200)
  })

  it('full estimation folds active system state: replayed tools count once (matching actual prompt size)', { timeout: 60_000 }, () => {
    const tool: Tool = { name: 'demo', description: 'd'.repeat(100), parameters: {} }
    const toolsChars = JSON.stringify([tool]).length
    const sys1 = systemMessage({ toolsAdded: [tool] })
    const sys2 = systemMessage({ content: 'b'.repeat(400) })
    const user = userMessage('c'.repeat(400))
    const view = viewOf({ entries: [[5, [sys1]], [6, [sys2]], [7, [user]]] })
    // Folded system: content 400 + active tools (counted once) -> single ceil + user 100.
    const expected = Math.ceil((400 + toolsChars) / 4) + 100
    assert.equal(estimateContextUsage(view).tokens, expected)
    // Naive double counting of tools JSON would add an extra toolsChars term.
    assert.notEqual(estimateContextUsage(view).tokens, Math.ceil((400 + 2 * toolsChars) / 4) + 100)
  })
})

describe('contextUsage assembly & compaction failure notifications', { timeout: 60_000 }, () => {
  it('compactingOf: true when compactions non-empty; undefined when empty or absent', { timeout: 60_000 }, () => {
    assert.equal(compactingOf(undefined), undefined)
    assert.equal(compactingOf([]), undefined)
    assert.equal(compactingOf([{ taskId: 1, trigger: 'threshold', blocking: true }]), true)
    // Unknown trigger shapes still signal active compaction boolean without fabricating details.
    assert.equal(compactingOf([{ taskId: 3, trigger: 'unknown-future', blocking: false }]), true)
  })

  it('compactionFailureNoticeOf: trigger wording + redaction + 400-char cap', { timeout: 60_000 }, () => {
    assert.equal(
      compactionFailureNoticeOf({ taskId: 1, trigger: 'manual', error: 'sk-abc gateway 500' }, (t) => t.replace('sk-abc', '***')),
      'manual-triggered context compaction failed: *** gateway 500',
    )
    assert.equal(
      compactionFailureNoticeOf({ taskId: 2, trigger: 'overflow', error: '' }, (t) => t),
      'overflow-triggered context compaction failed (no error details)',
    )
    const long = compactionFailureNoticeOf({ taskId: 3, trigger: 'threshold', error: 'x'.repeat(500) }, (t) => t)
    assert.ok(long.length < 500, 'error summary must be truncated')
  })

  it('assembleContextUsage: omits optional fields when undefined; cache key distinguishes every payload field', { timeout: 60_000 }, () => {
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
    assert.equal(keys.size, variants.length, 'every payload field change must produce a distinct fingerprint')
    assert.equal(contextUsageKeyOf(undefined), '')
  })
})

describe('event boundary: conversation.upsert contextUsage shape validation', { timeout: 60_000 }, () => {
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

  it('accepts valid shapes (nullable tokens; boolean compacting) and rejects removed dead fields or invalid shapes', { timeout: 60_000 }, () => {
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
      { tokens: '12345' }, // non-numeric tokens
      { tokens: -1 }, // negative tokens
      { tokens: 1, thresholds: { blockingTokens: 1 } }, // removed dead field
      { tokens: 1, measuredTokens: 2 }, // removed dead field
      { tokens: 1, compactionError: 'boom' }, // removed dead field
      { tokens: 1, compacting: { trigger: 'manual', blocking: false } }, // compacting converged to boolean
      { tokens: 1, contextWindow: 0 }, // non-positive window
      { tokens: 1, tps: 52.4 }, // removed dead field (throughput belongs to plugin)
      { tokens: 1, response: { responseTps: 52.4 } }, // removed dead field
      { tokens: 1, response: { responseTps: 52.4, responseOutputTokens: 524, responseDurationMs: 10_000 } }, // removed dead field
    ]
    for (const contextUsage of rejects) {
      assert.throws(
        () => hub.publish('conversation.upsert', { conversation: { ...baseSummary, contextUsage } }),
        (error: unknown) => error instanceof HelmxError,
        `must reject ${JSON.stringify(contextUsage)}`,
      )
    }
    // Rejections must not advance seq (no gaps on event watermark).
    assert.equal(hub.seq, 2)
  })
})

// ---------------------------------------------------------------------------
// Integration: real KernelRuntime (faux provider + SQLite + observer chain)
// ---------------------------------------------------------------------------

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

let root = ''

before(async () => {
  root = await makeTempDir('helmx-context-usage-')
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
  const unsubscribe = kernel.events.subscribe((frame: HelmxEventFrame) => {
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
  const unsubscribe = kernel.events.subscribe((frame: HelmxEventFrame) => {
    if (frame.event.type !== 'notification') return
    const event = frame.event as { level?: string; title?: string; body?: string; conversationId?: number }
    if (event.conversationId !== conversationId || event.title !== 'Context compaction failed') return
    notices.push({ title: event.title ?? '', body: event.body })
  })
  return { notices, stop: unsubscribe }
}

describe('integration: summary carries contextUsage and publishes events', { timeout: 60_000 }, () => {
  it('idle historical conversation after restart: first detail read does not block and background populates contextUsage', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('idle-detail')
    kernel.__faux.setResponses([fauxAssistantMessage('history answer')])
    await kernel.submitInput(1, 'history issue')
    await kernel.waitForIdle(1)
    await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) > 0)
    await kernel.close()

    // Restart: rebuilds chain observing idle conversation; first detail read returns immediately without blocking on
    // background contextUsage computation, and once ready pushes/caches usage so subsequent reads include it.
    const reopened = await openRuntime('idle-detail')
    try {
      const detail = await reopened.getConversationDetail(1, { limit: 5 })
      assert.ok(detail.entries.length >= 1, 'detail returns entries immediately without waiting on contextUsage')
      await waitFor(() => (reopened.getConversation(1).contextUsage?.tokens ?? 0) > 0, 10_000)
      const tokens = reopened.getConversation(1).contextUsage!.tokens
      assert.equal(typeof tokens, 'number', 'tokens should be numeric once historical measured anchor is restored')
      // Subsequent page reads hit cache without recomputing and remain stable.
      const page2 = await reopened.getConversationDetail(1, { limit: 5 })
      assert.ok(page2.contextUsage)
      assert.equal(page2.contextUsage.tokens, tokens)
    } finally {
      await reopened.close()
    }
  })

  it('compat gateway default model: includes tokens while omitting contextWindow (never fabricates)', { timeout: 60_000 }, async () => {
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
      assert.ok(detail.contextUsage, 'estimated token usage is still provided')
      assert.equal(detail.contextUsage.contextWindow, undefined, 'default placeholder window must not masquerade as known window')
      if (firstDetail.contextUsage === undefined) {
        await waitFor(() => recorded.frames.some((f) => f.contextUsage !== undefined), 5_000)
      }
    } finally {
      await kernel.close()
    }
  })

  it('post-turn tokens matches measured anchor; usage-only updates do not advance stateChangeSeq', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('settle-usage')
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('answer one')])
      const recorded = recordUpserts(kernel, 1)
      await kernel.submitInput(1, 'a question')
      await kernel.waitForIdle(1)
      // Refresh runs asynchronously after settlement: wait for measured value (initial cache may hold empty estimate).
      await waitFor(() => {
        const tokens = kernel.getConversation(1).contextUsage?.tokens
        return typeof tokens === 'number' && tokens > 0
      })
      const usage = kernel.getConversation(1).contextUsage
      assert.ok(usage, 'summary must carry contextUsage after turn settles')
      assert.ok(typeof usage.tokens === 'number' && usage.tokens > 0, 'faux provides real usage, so measured anchor must be populated')
      // Rate metrics do not ride along on contextUsage (delegated to optional plugin builtin:token-speed).
      assert.equal('response' in usage, false, 'contextUsage must no longer carry response rate field')
      // Faux model has known 128k window (built-in policy metadata): propagated as-is.
      assert.equal(usage.contextWindow, 128_000)
      assert.equal(usage.compacting, undefined)
      // Usage-only frame carries the exact stateChangeSeq of the settled frame (no CAS watermark pollution).
      const withUsage = recorded.frames.filter((f) => f.contextUsage !== undefined)
      assert.ok(withUsage.length >= 1, 'must publish conversation.upsert with contextUsage')
      const settled = recorded.frames.find((f) => f.status === 'done' || f.status === 'idle')
      assert.ok(settled, 'settled terminal status summary frame must arrive first')
      assert.equal(withUsage[withUsage.length - 1]!.stateChangeSeq, settled.stateChangeSeq)
      recorded.stop()
    } finally {
      await kernel.close()
    }
  })

  it('reset zeroes context usage (tokens=0 without measured anchor)', { timeout: 60_000 }, async () => {
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
      assert.ok(usage, 'contextUsage must be readable after reset')
      assert.equal(usage.tokens, 0, 'empty context without measured anchor must not retain stale value')
    } finally {
      await kernel.close()
    }
  })

  it('manual compaction on idle conversation: streams compacting=true, sets tokens=null afterwards, and restores measured after next reply', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('manual-compact')
    // Seed context larger than keepRecentTokens (20000) so selectCut has a compactable prefix.
    const bigInput = '大规模上下文素材。'.repeat(5_000)
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
    assert.ok(beforeCompact > 30_000, 'pre-compaction context must exceed threshold')

    // Latch compaction summary request to reliably observe compacting=true passthrough.
    let releaseSummary = () => {}
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve })
    kernel.__faux.setResponses([async () => {
      await summaryGate
      return fauxAssistantMessage('history compacted into summary')
    }])
    const recorded = recordUpserts(kernel, 1)
    try {
      await kernel.compactConversation(1)
      await waitFor(() => kernel.getConversation(1).contextUsage?.compacting === true, 20_000)
      await waitFor(() => recorded.frames.some((f) => f.contextUsage?.compacting === true))
      releaseSummary()
      // Post-compaction before new usage: tokens=null (never fakes known context from summary chars).
      await waitFor(() => {
        const usage = kernel.getConversation(1).contextUsage
        return usage !== undefined && usage.compacting === undefined && usage.tokens === null
      }, 20_000)
      const after = kernel.getConversation(1).contextUsage!
      assert.equal(after.tokens, null, 'context size remains unknown immediately after compaction without a reply')
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      assert.ok(detail.entries.some((entry) => entry.kind === 'pi.compaction'), 'must persist pi.compaction entry')

      // Next assistant reply restores measured tokens.
      kernel.__faux.setResponses([fauxAssistantMessage('new reply after compaction')])
      await kernel.submitInput(1, 'new issue after compaction')
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

  it('compaction failure emits exactly one redacted notification without repeating on subsequent turns', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('compact-failure')
    // 3 large turns ensure a compactable prefix beyond keepRecentTokens (20000).
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

    // Summary call returns non-retryable error -> compactionFailure appears in pi.live.
    kernel.__faux.setResponses([
      fauxAssistantMessage('summary failed', { stopReason: 'error', errorMessage: 'faux summarization rejected' }),
    ])
    const recorded = recordCompactionFailureNotices(kernel, 1)
    try {
      await kernel.compactConversation(1)
      await waitFor(() => recorded.notices.length === 1, 20_000)
      assert.match(recorded.notices[0]!.body ?? '', /faux summarization rejected/, 'failure notice includes error summary')
      assert.match(recorded.notices[0]!.body ?? '', /manual/, 'failure notice indicates trigger mode')

      // Next turn keeps same compactionFailure in pi.live across snapshots -> must not re-notify.
      kernel.__faux.setResponses([fauxAssistantMessage('normal answer after failure')])
      await kernel.submitInput(1, 'follow-up question')
      await kernel.waitForIdle(1)
      await waitFor(() => {
        const tokens = kernel.getConversation(1).contextUsage?.tokens
        return typeof tokens === 'number' && tokens > 0
      }, 20_000)
      assert.equal(recorded.notices.length, 1, 'same compaction failure must not notify twice')
    } finally {
      recorded.stop()
      await kernel.close()
    }
  })

  it('first-turn multi-step run publishes measured tokens mid-run before settlement (never frozen at 0)', { timeout: 60_000 }, async () => {
    const kernel = await openRuntime('mid-run-live-usage')
    // Populate initial empty cache (tokens=0) before the first turn starts, reproducing a newly opened conversation.
    await kernel.getConversationDetail(1, { limit: 10 })
    await waitFor(() => kernel.getConversation(1).contextUsage?.tokens === 0, 10_000)

    let releaseSecondStep = () => {}
    const secondStepGate = new Promise<void>((resolve) => { releaseSecondStep = resolve })
    let secondStepStarted = false
    kernel.__faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'printf ok' })], { stopReason: 'toolUse' }),
      async () => {
        secondStepStarted = true
        await secondStepGate
        return fauxAssistantMessage('final answer after tool call')
      },
    ])

    const recorded = recordUpserts(kernel, 1)
    try {
      await kernel.submitInput(1, 'run a tool and answer')
      await waitFor(() => secondStepStarted, 15_000)

      // Still inside the very first run (completionSeq=0, status='working'): step 1 pi.assistant already committed,
      // so contextUsage must leave 0 and push a working conversation.upsert with real tokens.
      await waitFor(() => {
        const usage = kernel.getConversation(1).contextUsage
        return typeof usage?.tokens === 'number' && usage.tokens > 0
      }, 15_000)
      const midSummary = kernel.getConversation(1)
      assert.equal(midSummary.status, 'working', 'run must still be active when mid-run usage arrives')
      assert.equal(midSummary.completionSeq, 0, 'turn has not settled yet')
      const midTokens = midSummary.contextUsage!.tokens as number
      assert.ok(midTokens > 0, 'mid-run tokens must be measured and positive')
      assert.ok(
        recorded.frames.some((f) => f.status === 'working' && typeof f.contextUsage?.tokens === 'number' && f.contextUsage.tokens > 0),
        'mid-run usage update must reach SSE subscribers via conversation.upsert',
      )

      releaseSecondStep()
      await kernel.waitForIdle(1)
      await waitFor(() => (kernel.getConversation(1).contextUsage?.tokens ?? 0) >= midTokens, 15_000)
      assert.ok((kernel.getConversation(1).contextUsage?.tokens ?? 0) >= midTokens)
    } finally {
      releaseSecondStep()
      recorded.stop()
      await kernel.close()
    }
  })
})
