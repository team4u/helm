/**
 * Herdr approval bridge: Ask creation (createAsk) for the blocked state and terminal-state consumption (consumeAskOutcome).
 *
 * The two approval-bridge responsibilities split out of executor.ts (behavior line-for-line equivalent to before
 * the split); dependencies injected via ApprovalBridgePort (the executor holds agent.get / terminal snapshot /
 * cancellation and the host AskDoc port):
 * - createAsk (pre-allocated id, entry registered first): returns the terminal-state result and the keystroke
 *   plan generated from this snapshot (plan lets consumeAskOutcome map the decision to a keystroke sequence).
 *   - Authoritative recheck before creation: seq already advanced / no longer blocked -> no need to ask (synthetic superseded);
 *   - Host returns cancelled and the entry was already cancelled (404 race confirmation) -> likewise synthetic superseded
 *     back to the main loop; never leave a pending behind;
 *   - Hybrid fast/slow paths: once the regex has recognized a standard menu (>= 2 items), take the 0ms deterministic fast path
 *     and never call AI; only for non-standard TUI snapshots with a configured model port are candidate keystroke options parsed async;
 *   - Ask liveness recheck: createAsk returns a terminal-state promise whose storage may land later than the event-driven
 *     cancellation's 404; keep rechecking and cancelling until that promise ends; remote likewise needs no local socket
 *     events; transient failures back off and retry, past the limit first cancel the host AskDoc then fail explicitly; never leave
 *     a forever-pending orphan approval card;
 *   - On a retry attempt (reopened approval), prefix the description with a "last keystrokes did not clear the block" hint;
 *     the terminal snapshot is wrapped in a code fence (the frontend AskDock extracts the collapsible snapshot from it).
 * - consumeAskOutcome: answered and the authoritative seq has not advanced -> CAS capability gate -> CAS
 *   send_keys with expected_state_seq (a stale_state rejection = keys not sent, never retried);
 *   cancelled/superseded -> converge per semantics.
 *
 * CAS capability gate for agent.send_keys (explicit probing, never silently degraded):
 * When the target Herdr does not advertise SEND_KEYS_CAS_CAPABILITY in ping capabilities, sending keys is rejected
 * (herdr_cas_unsupported) -- old servers' serde ignores unknown fields, so blindly sending expected_state_seq would
 * silently act as a CAS-less key write, exactly reproducing the residual window this fix closes.
 * Probe results are frozen per target within the same enable cycle (re-enable the plugin after Herdr upgrades).
 */

import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type AgentSpawnRequest } from '@helm/protocol'
import type {
  CreateAskResultLike,
  CreateAskSpecLike,
  HerdrPluginDependencies,
  HerdrTarget,
} from './contracts.js'
import type { AskCoordinator, AskEntry } from './asks.js'
import {
  buildHerdrAskPromptPlan,
  extractMenuItemsFromSnapshot,
  parseCustomKeys,
  type BlockedSnapshotAnalysis,
  type HerdrAskPromptPlan,
} from './prompt-options.js'
import { nodeIdOf, targetOf, type ManagedPane } from './panes.js'
import {
  assertOkResult,
  buildSendKeysParams,
  isStaleStateError,
  parsePong,
  SEND_KEYS_CAS_CAPABILITY,
  type HerdrAgentInfo,
} from './rpc.js'

/** The approval bridge's minimal dependency surface on the executor and host. */
export interface ApprovalBridgePort {
  asks: AskCoordinator
  transport: NonNullable<HerdrPluginDependencies['transport']>
  host: {
    notify(title: string, body: string, level: 'info' | 'error'): void
    createAsk(spec: CreateAskSpecLike): Promise<CreateAskResultLike>
  }
  redact(text: string): string
  analyzeBlockedSnapshot?: HerdrPluginDependencies['analyzeBlockedSnapshot']
  /** Authoritative agent.get (the single trusted source of seq; held by the executor). */
  agentGet(target: HerdrTarget, paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo>
  /** agent.read recent_unwrapped 40-line redacted snapshot (diagnostics only; held by the executor). */
  readDiagnostic(pane: ManagedPane): Promise<string>
  /** Host cancellation (404 = already settled, callers clear the entry on it; other errors propagate as-is). */
  cancelAskQuietly(askId: string, reason: 'cancelled' | 'superseded'): Promise<void>
  /** Poll interval (shortened in tests; production default 100ms). Used for the AskDoc liveness recheck. */
  pollIntervalMs: number
  /** Backoff base and cap for transient failures in the Ask liveness poll (shortened in tests; production defaults 500ms / 4000ms). */
  askPollTransientBackoffBaseMs?: number
  askPollTransientBackoffCapMs?: number
  /** Post-abort cancellation backoff cap (shortened in tests; production default 3200ms). */
  abortCancelBackoffCapMs?: number
}

export class ApprovalBridge {
  /** Max attempts of the post-abort cancellation loop (prevents retry+notify storms when cancel keeps failing; the remaining backstop goes to closePane). */
  private static readonly MAX_ABORT_CANCEL_ATTEMPTS = 5
  private static readonly DEFAULT_ABORT_CANCEL_BACKOFF_CAP_MS = 3_200
  /** Max consecutive tolerances for transient failures (herdr_timeout/node flaps) in the Ask liveness recheck (backoff retry); beyond that, cancel and fail explicitly. */
  private static readonly MAX_ASK_POLL_TRANSIENT_FAILURES = 6
  private static readonly DEFAULT_ASK_POLL_TRANSIENT_BACKOFF_BASE_MS = 500
  private static readonly DEFAULT_ASK_POLL_TRANSIENT_BACKOFF_CAP_MS = 4_000

  /** send_keys CAS capability probe result (frozen per target within the same enable cycle). */
  private readonly sendKeysCasSupport = new Map<string, boolean>()

  constructor(private readonly port: ApprovalBridgePort) {}

  private async cancelSuperseded(pane: ManagedPane, authority: HerdrAgentInfo): Promise<void> {
    for (const superseded of this.port.asks.observeAuthority({
      paneId: pane.paneId,
      nodeId: nodeIdOf(pane),
      seq: authority.stateChangeSeq,
      status: authority.agentStatus,
    })) {
      await this.port.cancelAskQuietly(superseded.askId, 'superseded')
    }
  }

  private async settleSuperseded(entry: AskEntry): Promise<{ outcome: CreateAskResultLike; plan: HerdrAskPromptPlan }> {
    this.port.asks.settle(entry, { keysSent: false })
    return { outcome: { id: entry.askId, status: 'superseded', answers: {} }, plan: buildHerdrAskPromptPlan('') }
  }

  /**
   * createAsk (pre-allocated id, entry registered first): returns the terminal-state result and the keystroke
   * plan generated from this snapshot (plan lets consumeAskOutcome map the decision to a keystroke sequence).
   */
  async createAsk(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    conversationId: number,
  ): Promise<{ outcome: CreateAskResultLike; plan: HerdrAskPromptPlan }> {
    const authority = await this.port.agentGet(targetOf(pane), pane.paneId, request.signal)
    await this.cancelSuperseded(pane, authority)
    if (authority.stateChangeSeq !== entry.seq || authority.agentStatus !== 'blocked') {
      return this.settleSuperseded(entry)
    }
    const snapshot = await this.port.readDiagnostic(pane)
    // Hybrid fast/slow paths: once the regex has recognized a standard menu (>= 2 items), take the 0ms deterministic fast path
    // and never call AI (saves latency and tokens); only for non-standard TUI snapshots (e.g. horizontal buttons / hotkey hints)
    // with a configured model port are candidate keystroke options parsed async.
    let aiAnalysis: BlockedSnapshotAnalysis | undefined
    let aiDiagnostic: string | undefined
    const fastItems = extractMenuItemsFromSnapshot(snapshot)
    if (fastItems.length < 2 && snapshot.trim().length > 0 && this.port.analyzeBlockedSnapshot !== undefined) {
      try {
        const outcome = await this.port.analyzeBlockedSnapshot({
          snapshot,
          conversationId,
          signal: request.signal,
        })
        aiAnalysis = outcome.analysis
        aiDiagnostic = outcome.diagnostic
        if (aiDiagnostic !== undefined) {
          // An incomplete enhancement does not block the approval main flow, but is never silent: notify the human of the fallback to generic options.
          this.port.host.notify('Blocked-snapshot AI parse incomplete', this.port.redact(aiDiagnostic), 'info')
        }
      } catch (error) {
        // External cancellation propagates immediately; otherwise (incl. the injected port throwing directly) notify honestly and fall back.
        // Diagnostics use a fixed safe message; the upstream Error.message is not echoed (may contain raw response/snapshot).
        if (request.signal?.aborted) throw error
        aiAnalysis = undefined
        aiDiagnostic = 'Blocked-snapshot AI parse failed (request error); fell back to generic keystroke options'
        this.port.host.notify('Blocked-snapshot AI parse incomplete', aiDiagnostic, 'info')
      }
      // The terminal may advance on its own while waiting for AI: authoritatively recheck seq; if stale, do not attach an old AskDoc.
      const latest = await this.port.agentGet(targetOf(pane), pane.paneId, request.signal)
      await this.cancelSuperseded(pane, latest)
      if (latest.stateChangeSeq !== entry.seq || latest.agentStatus !== 'blocked') {
        return this.settleSuperseded(entry)
      }
    }
    const plan = buildHerdrAskPromptPlan(snapshot, aiAnalysis, (t) => this.port.redact(t))
    const retryHint =
      entry.attempt > 0 && entry.lastSentKeys && entry.lastSentKeys.length > 0
        ? `The last keystrokes sent [${entry.lastSentKeys.join(', ')}] did not clear the block (the terminal is still at seq ${entry.seq}); please re-choose against the snapshot.\n\n`
        : ''
    const aiSummaryLine = plan.summary ? `Block summary: ${this.port.redact(plan.summary)}\n\n` : ''
    const aiFallbackLine = aiDiagnostic ? `${this.port.redact(aiDiagnostic)}\n\n` : ''
    // The snapshot uniformly takes the trailing 1500 characters: the same slice the AI parse relied on, ensuring the human sees
    // the current menu the model based its judgment on (long snapshot heads are usually irrelevant rhythm output).
    const description = `${retryHint}${aiSummaryLine}${aiFallbackLine}Terminal agent (${pane.agentName}) is waiting for a choice in ${pane.effectiveCwd}. Terminal snapshot (redacted):\n\`\`\`\n${snapshot.slice(-1500)}\n\`\`\``
    const pending = this.port.host.createAsk({
      id: entry.askId,
      conversationId,
      ownerPluginId: 'builtin:herdr',
      title: `Herdr approval: pane ${pane.paneId}`,
      description,
      fields: [
        {
          name: 'decision',
          label: 'How should this block be handled?',
          type: 'select',
          required: true,
          options: plan.options,
        },
        {
          name: 'key',
          label: 'Custom keystroke sequence (only used when decision=custom; separate multiple keys with spaces or commas, e.g. enter / esc / down, enter)',
          type: 'text',
          required: false,
        },
      ],
      expectedStateSeq: entry.seq,
    })
    this.port.asks.markPending(entry)
    // createAsk returns a terminal-state promise; its storage may land later than the event-driven cancellation's 404.
    // Keep rechecking and cancelling until that promise ends; remote likewise needs no local socket events.
    const monitor = new AbortController()
    const result = pending.finally(() => monitor.abort())
    const polling = (async () => {
      // Liveness recheck fault tolerance boundary: transient failures (herdr_timeout/node flaps) back off and retry; only
      // past the limit first cancel the host AskDoc then fail explicitly; never let one jitter pierce the task, and never
      // leave a forever-pending orphan approval card.
      let transientFailures = 0
      let abortCancelAttempts = 0
      while (!monitor.signal.aborted) {
        try { await delay(this.port.pollIntervalMs, undefined, { signal: monitor.signal }) }
        catch (error) { if (monitor.signal.aborted) return; throw error }
        if (request.signal?.aborted) {
          // Post-abort cancellation backoff is bounded: when cancel keeps failing non-404, there must be no 100ms
          // retry+notify storm; past the limit, closePane's paneClosed list takes over the backstop.
          if (abortCancelAttempts >= ApprovalBridge.MAX_ABORT_CANCEL_ATTEMPTS) return
          if (abortCancelAttempts > 0) {
            try {
              const abortCancelBackoffCapMs =
                this.port.abortCancelBackoffCapMs ?? ApprovalBridge.DEFAULT_ABORT_CANCEL_BACKOFF_CAP_MS
              await delay(
                Math.min(this.port.pollIntervalMs * 2 ** abortCancelAttempts, abortCancelBackoffCapMs),
                undefined,
                { signal: monitor.signal },
              )
            } catch (error) { if (monitor.signal.aborted) return; throw error }
          }
          await this.port.cancelAskQuietly(entry.askId, 'cancelled')
          abortCancelAttempts += 1
          continue
        }
        let current: HerdrAgentInfo
        try {
          current = await this.port.agentGet(targetOf(pane), pane.paneId, monitor.signal)
          transientFailures = 0
        } catch (error) {
          if (monitor.signal.aborted) return
          if ((error as { code?: string }).code === 'herdr_aborted') throw error
          transientFailures += 1
          if (transientFailures > ApprovalBridge.MAX_ASK_POLL_TRANSIENT_FAILURES) {
            // Final failure: cancel the host AskDoc async then immediately rethrow the real error (no await --
            // awaiting would let the host's cancelled terminal state win Promise.race first, disguising infrastructure failure
            // as a "human cancelled" abort path closing the failure scene); the backstop cancel is
            // guaranteed by the task chain catch's synchronous cancellation; never leave a pending orphan approval card.
            void this.port.cancelAskQuietly(entry.askId, 'cancelled')
            throw error
          }
          try {
            const backoffBaseMs =
              this.port.askPollTransientBackoffBaseMs ?? ApprovalBridge.DEFAULT_ASK_POLL_TRANSIENT_BACKOFF_BASE_MS
            const backoffCapMs =
              this.port.askPollTransientBackoffCapMs ?? ApprovalBridge.DEFAULT_ASK_POLL_TRANSIENT_BACKOFF_CAP_MS
            await delay(
              Math.min(backoffBaseMs * 2 ** (transientFailures - 1), backoffCapMs),
              undefined,
              { signal: monitor.signal },
            )
          } catch (error) { if (monitor.signal.aborted) return; throw error }
          continue
        }
        if (current.stateChangeSeq !== entry.seq || current.agentStatus !== 'blocked') {
          this.port.asks.observeAuthority({ nodeId: nodeIdOf(pane), paneId: pane.paneId, seq: current.stateChangeSeq, status: current.agentStatus })
          await this.port.cancelAskQuietly(entry.askId, 'superseded')
        }
      }
    })()
    try {
      return { outcome: await Promise.race([result, polling.then(() => result)]), plan }
    } finally {
      monitor.abort()
      await polling.catch((error: unknown) => {
        if ((error as { code?: string }).code !== 'herdr_aborted') throw error
      })
    }
  }

  /** Consume the terminal state: answered and the authoritative seq has not advanced -> capability gate -> CAS send_keys with expected_state_seq (a stale_state rejection = keys not sent, never retried); cancelled -> false. */
  async consumeAskOutcome(
    request: AgentSpawnRequest,
    pane: ManagedPane,
    entry: AskEntry,
    outcome: CreateAskResultLike,
    plan: HerdrAskPromptPlan,
  ): Promise<boolean> {
    if (outcome.status !== 'answered') {
      this.port.asks.settle(entry, { keysSent: false })
      if (outcome.status === 'superseded') return true
      return false
    }
    const decision = outcome.answers['decision'] ?? ''
    let keys: string[] | undefined
    if (decision === 'custom') {
      const custom = parseCustomKeys(outcome.answers['key'] ?? '')
      if (custom.length === 0) {
        this.port.asks.settle(entry, { keysSent: false })
        return false
      }
      keys = custom
    } else {
      keys = plan.decisionKeys.get(decision)
    }
    if (keys === undefined || keys.length === 0) {
      this.port.asks.settle(entry, { keysSent: false })
      return false
    }
    const authority = await this.port.agentGet(targetOf(pane), pane.paneId, request.signal)
    await this.cancelSuperseded(pane, authority)
    if (authority.name !== pane.agentName) throw new HelmError('herdr_ownership_lost', `pane ${pane.paneId}'s Agent identity has changed; cannot send keystrokes`, 409)
    if (authority.stateChangeSeq !== entry.seq || authority.agentStatus !== 'blocked') {
      this.port.asks.settle(entry, { keysSent: false })
      return true
    }
    // Protocol-level CAS: send_keys carries expected_state_seq (entry.seq), thoroughly closing the millisecond-scale
    // residual window between the authoritative agent.get above and the key write -- when a human presses keys directly
    // in the terminal and advances seq, the server must reject with stale_state and write no keystrokes.
    await this.assertSendKeysCas(targetOf(pane), request.signal)
    try {
      await assertOkResult(
        await this.port.transport.call(
          targetOf(pane),
          'agent.send_keys',
          buildSendKeysParams({ target: pane.paneId, keys, expectedStateSeq: entry.seq }),
          { signal: request.signal },
        ),
        'agent.send_keys',
      )
    } catch (error) {
      if (!isStaleStateError(error)) throw error
      // Server CAS rejection = keys not sent: converge as "the terminal advanced first" (back to the main loop
      // waiting for the authoritative state, same as superseded semantics); never retry the same batch of keys, never record a successful send.
      this.port.asks.settle(entry, { keysSent: false })
      this.port.host.notify(
        'Herdr approval superseded',
        `pane ${pane.paneId}'s keystroke choice was rejected by the server because the terminal state advanced (stale_state); no keystrokes were sent; the main loop will keep converging on the authoritative state`,
        'info',
      )
      return true
    }
    this.port.asks.settle(entry, { keysSent: true, sentKeys: keys })
    this.port.host.notify('Herdr approval sent', `pane ${pane.paneId} sent keystrokes per the human's choice: ${keys.join(' ')}`, 'info')
    return true
  }

  private async assertSendKeysCas(target: HerdrTarget, signal?: AbortSignal): Promise<void> {
    const key = JSON.stringify(target)
    const cached = this.sendKeysCasSupport.get(key)
    if (cached === true) return
    if (cached === false) throw this.casUnsupportedError(target)
    const pong = parsePong(await this.port.transport.call(target, 'ping', {}, { signal, timeoutMs: 5_000 }))
    this.sendKeysCasSupport.set(key, pong.sendKeysCas)
    if (!pong.sendKeysCas) throw this.casUnsupportedError(target, pong)
  }

  private casUnsupportedError(target: HerdrTarget, server?: { version: string; protocol: number }): HelmError {
    const serverLabel = server !== undefined ? ` (version ${server.version}, protocol ${server.protocol})` : ''
    return new HelmError(
      'herdr_cas_unsupported',
      `Target Herdr${serverLabel} does not advertise '${SEND_KEYS_CAS_CAPABILITY}' in ping capabilities; refusing CAS-less agent.send_keys: old servers silently ignore expected_state_seq and write keys anyway (reproducing the approval bridge's CAS residual window); upgrade the Herdr server to a version that advertises the capability and re-enable the herdr plugin`,
      502,
      {
        capability: SEND_KEYS_CAS_CAPABILITY,
        ...(server !== undefined ? { serverVersion: server.version, serverProtocol: server.protocol } : {}),
        target: JSON.stringify(target),
      },
    )
  }
}
