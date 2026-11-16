/**
 * ConversationContextUsage / ConversationLive contracts (type level):
 * - ConversationSummary.contextUsage is optional and does not break the existing public shape;
 * - tokens is required (number | null: null = context unknown after compaction),
 *   contextWindow / compacting optional (never fabricated when unknown/unmeasurable);
 * - rate metrics do not ride along with usage (response etc. already removed:
 *   policy belongs to the optional builtin:token-speed plugin; compile-time
 *   negative cases lock this, preventing dead fields from creeping back);
 * - ConversationLive.generation carries generic streaming facts (attempt +
 *   restricted message projection) with zero rate computation in the kernel;
 *   policy fields such as tokenSpeed do not exist in the protocol (compile-time
 *   negative-case lock).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ConversationContextUsage, ConversationLive, ConversationSummary } from '@helm/protocol'

describe('ConversationSummary.contextUsage contract', () => {
  it('minimal usage (tokens only) is valid: unknown window/compaction state omitted', { timeout: 60_000 }, () => {
    const usage: ConversationContextUsage = { tokens: 12_345 }
    const summary: ConversationSummary = {
      id: 1,
      title: 'Conversation',
      profileId: 'assistant',
      tags: [],
      cwd: '/tmp',
      model: 'faux/faux-1',
      thinkingLevel: '',
      status: 'idle',
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 0,
      updatedAt: 0,
      contextUsage: usage,
    }
    assert.equal(summary.contextUsage, usage)
  })

  it('tokens may be null (no valid usage since compaction); full shape = tokens + window + compacting', { timeout: 60_000 }, () => {
    const unknown: ConversationContextUsage = { tokens: null, contextWindow: 128_000 }
    assert.equal(unknown.tokens, null)
    const full: ConversationContextUsage = {
      tokens: 91_000,
      contextWindow: 128_000,
      compacting: true,
    }
    assert.equal(full.compacting, true)
    assert.equal(full.contextWindow, 128_000)
  })

  it('dead fields rejected at compile time (measuredTokens / thresholds / compactionError / bare tps / response rate)', { timeout: 60_000 }, () => {
    // @ts-expect-error measuredTokens was removed along with the old Popover display
    const withMeasured: ConversationContextUsage = { tokens: 1, measuredTokens: 1 }
    // @ts-expect-error thresholds removed (threshold display no longer rides along with usage)
    const withThresholds: ConversationContextUsage = { tokens: 1, thresholds: { blockingTokens: 1 } }
    // @ts-expect-error compactionError removed (failures now go through the notification event)
    const withError: ConversationContextUsage = { tokens: 1, compactionError: 'boom' }
    // @ts-expect-error bare tps does not exist: rate policy belongs to optional plugins, not kernel usage
    const withBareTps: ConversationContextUsage = { tokens: 1, tps: 52.4 }
    // @ts-expect-error response rate triple removed (same as above; plugins display via COMPOSER_STATUS_SLOT)
    const withResponse: ConversationContextUsage = { tokens: 1, response: { responseTps: 52.4 } }
    assert.ok(withMeasured || withThresholds || withError || withBareTps || withResponse)
  })
})

describe('ConversationLive.generation generic streaming facts contract', () => {
  const base: ConversationLive = {
    conversationId: 1,
    text: '',
    tools: [],
    updatedAt: 0,
  }

  it('minimal generation (taskId+attempt only, message omitted while it has no content) is valid', { timeout: 60_000 }, () => {
    const live: ConversationLive = { ...base, generation: { taskId: 7, attempt: 1 } }
    assert.equal(live.generation?.taskId, 7)
    assert.equal(live.generation?.attempt, 1)
    assert.equal(live.generation?.message, undefined)
  })

  it('full message projection: text/thinking/toolCall blocks + provider-cumulative usage', { timeout: 60_000 }, () => {
    const live: ConversationLive = {
      ...base,
      generation: {
        taskId: 7,
        attempt: 2,
        message: {
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'text', text: 'answer' },
            { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } },
          ],
          usage: { output: 128 },
        },
      },
    }
    assert.equal(live.generation!.message!.content.length, 3)
    assert.equal(live.generation!.message!.usage!.output, 128)
  })

  it('policy fields absent from the protocol (tokenSpeed / decode etc.; compile-time negative lock on zero kernel rate computation)', { timeout: 60_000 }, () => {
    // @ts-expect-error tokenSpeed does not exist: rates are plugin policy; the kernel only passes facts through
    const withTokenSpeed: ConversationLive = { ...base, tokenSpeed: { phase: 'decoding', outputTokens: 1, decodeMs: 1, source: 'estimate', updatedAt: 0 } }
    // @ts-expect-error response does not exist: final-state rates also belong to plugins
    const withResponse: ConversationContextUsage = { tokens: 1, response: { decodeTps: 52.4 } }
    assert.ok(withTokenSpeed || withResponse)
  })
})
