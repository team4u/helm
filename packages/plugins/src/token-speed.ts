/**
 * builtin:token-speed: real-time decoding speed (tok/s) read-only status plugin.
 *
 * Responsibility boundary (mechanism vs policy):
 * - The kernel only passes through ConversationLive.generation's generic streaming facts (taskId +
 *   attempt + a restricted message projection) with zero speed computation; this plugin consumes those
 *   facts and derives all policy itself: time-sliding-window speed, chars/4 estimation, TTFT (start =
 *   first observation, never fabricated), burst/stall smoothing, exact per-taskId reconciliation, and
 *   tool-execution time exclusion (see tracker.ts); disabling this plugin produces no extra kernel
 *   computation or write overhead;
 * - High-frequency conversation-scoped state goes into an in-memory transient public sessionDoc
 *   (`durable: false`, dedicated SSE subscribed on demand, writes throttled to 120ms with trailing-frame
 *   deferred commit; first measurement / phase change / terminal state written immediately), never touching
 *   SQLite, global ctx.doc, or the conversation summary;
 * - Display injects into COMPOSER_STATUS_SLOT (the host's composer status line) via ctx.ui.slot;
 *   disabling removes it along with the UI contribution, leaving no phantom prompt; no actions / no tools / no CLI (pure read-only display, triggering no five-end mapping obligations).
 *
 * Event-ordering facts (kernel observation chain, stable across same-commit folds):
 * - conversation.entry (pi.assistant final usage) arrives before the same commit's conversation.live
 *   frames -- completion facts associate exactly to segments by taskId (failed attempts' counts
 *   excluded; entries without taskId have unclear identity and never associate);
 * - pi-durable hands over to a new generation task per tool round (live.run.taskId changes;
 *   generation.taskId shares the source); each model request within a turn settles turn_settled once:
 *   payload.conversation.status still working means the chain continues (keep accumulating); non-working is the chain endpoint (terminal publish + the next generation frame resets the chain).
 *
 * Lifecycle and cleanup semantics (all derived measurements, rebuildable from new traffic; no
 * migration, no fallback):
 * - Transient sessionDoc (`durable: false`): automatically starts empty on each enable/restart and clears
 *   on disable, conversation deletion, or process exit without SQLite writes or startup DB cleanup;
 * - pi.reset / pi.compaction / helm.rewind landing: the old context is invalid; wipe that
 *   conversation's speed state completely, never re-reading the old context or falling back to old TPS;
 * - Failed / aborted turns (turn_settled outcome): clear the current measurement outright; an unfinished answer must never pose as a normal terminal state; a runtime completed terminal state stays displayed until the next turn's first measurement overwrites it.
 */
import { COMPOSER_STATUS_SLOT, HelmError, type PluginDefinition } from '@helm/protocol'
import { resolvePluginClientRoot } from './asset-paths.js'
import {
  CONTEXT_INVALIDATION_ENTRY_KINDS,
  DEFAULT_SLIDING_WINDOW_MS,
  DOC_WRITE_INTERVAL_MS,
  MAX_SLIDING_WINDOW_MS,
  MIN_SLIDING_WINDOW_MS,
  TOKEN_SPEED_DOC,
  TOKEN_SPEED_PLUGIN_ID,
  asAssistantCompletion,
  asConversationDeletedId,
  asConversationEntryEnvelope,
  asConversationLiveFrame,
  type TokenSpeedStatus,
} from './token-speed/contracts.js'
import { ConversationTokenSpeedTracker } from './token-speed/tracker.js'

export { TOKEN_SPEED_PLUGIN_ID }

export function createTokenSpeedPlugin(options?: { now?: () => number }): PluginDefinition {
  return {
    id: TOKEN_SPEED_PLUGIN_ID,
    name: { en: 'Token Speed', 'zh-CN': '解码速率' },
    description: {
      en: 'Real-time decoding speed (tok/s) in the composer status line: streaming-observed speed, first-token latency, and terminal reconciliation (throttled-frame observation estimates; badges marked with an approx sign).',
      'zh-CN': '输入区状态栏实时解码速率（tok/s）：流式观测速率、首 token 延迟与终态对账（节流帧观测估算，徽标带约等号）。',
    },
    icon: 'gauge',
    version: '0.1.0',
    clientRoot: resolvePluginClientRoot(TOKEN_SPEED_PLUGIN_ID, 'token-speed', 'token_speed_plugin_client_missing'),
    definePlugin(rawCtx) {
      const ctx = rawCtx
      const clock = options?.now ?? Date.now

      ctx.configSchema({
        slidingWindowMs: {
          type: 'number',
          label: { en: 'Sliding window (ms)', 'zh-CN': '滑动窗口（毫秒）' },
          description: {
            en: 'The time window for real-time speed; 3000-15000 recommended for slow servers (aligned with pi-token-speed guidance)',
            'zh-CN': '实时速率的时间窗口；慢服务器建议 3000-15000（与 pi-token-speed 指引一致）',
          },
          default: DEFAULT_SLIDING_WINDOW_MS,
          minimum: MIN_SLIDING_WINDOW_MS,
          maximum: MAX_SLIDING_WINDOW_MS,
          integer: true,
        },
      })

      const speedDoc = ctx.sessionDoc<TokenSpeedStatus | null>(TOKEN_SPEED_DOC, null, {
        public: true,
        durable: false,
      })

      /** conversation -> speed state machine (created per chain; config changes take effect next turn). */
      const trackers = new Map<number, ConversationTokenSpeedTracker>()
      /** conversation -> last sessionDoc write time (throttling). */
      const lastWriteAt = new Map<number, number>()
      /** conversation -> throttled trailing-frame deferred-write timers and pending state. */
      const writeTimers = new Map<number, ReturnType<typeof setTimeout>>()
      const pendingStatuses = new Map<number, TokenSpeedStatus>()
      /** Conversations whose chain ended: the next generation frame resets the chain (a new turn accumulates from zero). */
      const settledChains = new Set<number>()
      let serviceActive = true

      const windowMsOf = (): number => {
        const raw = (ctx.getConfig() as { slidingWindowMs?: unknown }).slidingWindowMs
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SLIDING_WINDOW_MS
        return Math.min(MAX_SLIDING_WINDOW_MS, Math.max(MIN_SLIDING_WINDOW_MS, Math.round(raw)))
      }

      const trackerOf = (conversationId: number): ConversationTokenSpeedTracker => {
        let tracker = trackers.get(conversationId)
        if (tracker === undefined) {
          tracker = new ConversationTokenSpeedTracker({
            windowMs: windowMsOf(),
            minSpanMs: MIN_SLIDING_WINDOW_MS,
          })
          trackers.set(conversationId, tracker)
        }
        return tracker
      }

      const nowOf = (fallback: number): number =>
        Number.isFinite(fallback) && fallback > 0 ? fallback : clock()

      const cancelPendingWrite = (conversationId: number): void => {
        const timer = writeTimers.get(conversationId)
        if (timer !== undefined) {
          clearTimeout(timer)
          writeTimers.delete(conversationId)
        }
        pendingStatuses.delete(conversationId)
      }

      const writeDocSafe = (conversationId: number, status: TokenSpeedStatus | null): void => {
        try {
          speedDoc.set(conversationId, status)
        } catch (error) {
          if (!(error instanceof HelmError && error.status === 404)) throw error
        }
      }

      /** Write the sessionDoc (throttled + trailing-frame deferred write; force for first measurement / phase change / first speed / terminal / cleanup). */
      const publish = (conversationId: number, status: TokenSpeedStatus | null, force: boolean, now: number): void => {
        const previous = speedDoc.get(conversationId)
        const shouldThrottle =
          !force &&
          status !== null &&
          previous !== null &&
          previous.phase === status.phase &&
          !(previous.tps === undefined && status.tps !== undefined)
        if (shouldThrottle) {
          const last = lastWriteAt.get(conversationId)
          if (last !== undefined && now >= last && now - last < DOC_WRITE_INTERVAL_MS) {
            pendingStatuses.set(conversationId, status)
            if (!writeTimers.has(conversationId)) {
              const delayMs = Math.max(1, DOC_WRITE_INTERVAL_MS - (now - last))
              const timer = setTimeout(() => {
                writeTimers.delete(conversationId)
                const pending = pendingStatuses.get(conversationId)
                pendingStatuses.delete(conversationId)
                if (!serviceActive || pending === undefined) return
                lastWriteAt.set(conversationId, nowOf(clock()))
                writeDocSafe(conversationId, pending)
              }, delayMs)
              timer.unref?.()
              writeTimers.set(conversationId, timer)
            }
            return
          }
        }
        cancelPendingWrite(conversationId)
        lastWriteAt.set(conversationId, now)
        writeDocSafe(conversationId, status)
      }

      /** Wipe a conversation's speed state completely (in-memory state + throttle timers + the session doc). When the
       * conversation row is already gone, doc deletion tolerates not_found (conversation ids are monotonic and never reused;
       * leftovers are unreachable); other errors propagate honestly. Shared by context-invalidation markers / failed-aborted turns / conversation deletion. */
      const clearConversationState = (conversationId: number): void => {
        cancelPendingWrite(conversationId)
        trackers.delete(conversationId)
        lastWriteAt.delete(conversationId)
        settledChains.delete(conversationId)
        try {
          speedDoc.delete(conversationId)
        } catch (error) {
          if (!(error instanceof HelmError && error.status === 404)) throw error
        }
      }

      // Live frames: drive the state machine and publish the throttled doc.
      ctx.host.onEvent('conversation.live', (raw) => {
        const frame = asConversationLiveFrame(raw)
        if (frame === undefined) return
        const now = nowOf(frame.updatedAt)
        if (settledChains.has(frame.conversationId)) {
          if (frame.generation === undefined) return
          // A new turn starts: reset the chain (the previous turn's terminal values stay in the doc until this turn's first measurement).
          settledChains.delete(frame.conversationId)
          trackers.get(frame.conversationId)?.resetChain()
        }
        const tracker = trackerOf(frame.conversationId)
        tracker.observeFrame(now, frame)
        const status = tracker.liveStatus(now)
        if (status === undefined) return
        const previous = speedDoc.get(frame.conversationId)
        const force =
          previous === null ||
          previous.phase !== status.phase ||
          (previous.tps === undefined && status.tps !== undefined)
        publish(frame.conversationId, status, force, now)
      })

      // Persisted entries: validate the envelope and boundary markers first. pi.reset / pi.compaction /
      // helm.rewind means the old context is invalid -- wipe that conversation's entire speed state;
      // never re-read the old context or fall back to old TPS; pi.assistant completion facts (taskId /
      // usage / stopReason / contentChars) reconcile exactly by request identity, backfill the trailing frame, then refresh the publish.
      ctx.host.onEvent('conversation.entry', (raw) => {
        const envelope = asConversationEntryEnvelope(raw)
        if (envelope === undefined) return
        const { conversationId, kind } = envelope
        if (CONTEXT_INVALIDATION_ENTRY_KINDS.has(kind)) {
          clearConversationState(conversationId)
          return
        }
        if (kind !== 'pi.assistant') return
        const completion = asAssistantCompletion(raw)
        if (completion === undefined) return
        const tracker = trackers.get(conversationId)
        if (tracker === undefined) return
        const now = nowOf(clock())
        tracker.noteCompletion(
          {
            taskId: completion.taskId,
            entryId: completion.entryId,
            usageOutput: completion.usageOutput,
            stopReason: completion.stopReason,
            ...(completion.contentChars !== undefined ? { contentChars: completion.contentChars } : {}),
          },
          now,
        )
        if (settledChains.has(conversationId)) return
        const status = tracker.liveStatus(now)
        if (status === undefined) return
        const previous = speedDoc.get(conversationId)
        const force =
          previous === null ||
          previous.phase !== status.phase ||
          (previous.tps === undefined && status.tps !== undefined)
        publish(conversationId, status, force, now)
      })

      // Turn settlement: working = an intermediate settlement of a tool round's handOver (the chain
      // continues); failed / aborted = an unfinished answer that must never pose as a normal terminal
      // state -- clear the current measurement outright; other completed values are chain endpoints -- publish the terminal state and wait for the next generation frame to reset the chain.
      ctx.hook.onTurnSettled((payload) => {
        const conversationId = payload.conversation.id
        if (payload.outcome === 'failed' || payload.outcome === 'aborted') {
          clearConversationState(conversationId)
          return
        }
        if (payload.conversation.status === 'working') return
        const tracker = trackers.get(conversationId)
        settledChains.add(conversationId)
        if (tracker === undefined) return
        const now = nowOf(payload.settledAt)
        const status = tracker.settle(now)
        publish(conversationId, status ?? null, true, now)
      })

      // Conversation deletion: fully clean the state machine and throttle fingerprint; doc deletion
      // rejects with not_found when the conversation row is already gone (triple-existence assertion),
      // and only that error is tolerated -- conversation ids are monotonic and never reused, persistent leftovers are unreachable and cleaned with the plugin's purgePlugin; other errors propagate honestly.
      ctx.host.onEvent('conversation.deleted', (raw) => {
        const conversationId = asConversationDeletedId(raw)
        if (conversationId === undefined) return
        clearConversationState(conversationId)
      })

      // Lifecycle service: all derived measurements use transient in-memory sessionDocs (`durable: false`),
      // so disable/restart automatically drops prior cycle docs without SQLite cleanup. `stop` cancels
      // deferred-write throttle timers and clears in-memory trackers for this cycle.
      ctx.service({
        id: 'speed-lifecycle',
        start: () => {
          serviceActive = true
        },
        stop: () => {
          serviceActive = false
          for (const timer of writeTimers.values()) clearTimeout(timer)
          writeTimers.clear()
          pendingStatuses.clear()
          trackers.clear()
          lastWriteAt.clear()
          settledChains.clear()
        },
      })

      // ---- Declarative UI: the host composer status-line slot (read-only speed text) ------------------
      ctx.ui.slot({
        id: 'token-speed-status',
        target: COMPOSER_STATUS_SLOT,
        order: 10,
        client: { module: 'index.tsx', export: 'TokenSpeedStatusBadge' },
      })
    },
  }
}
