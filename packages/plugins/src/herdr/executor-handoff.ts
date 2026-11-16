/**
 * Herdr executor submodule: handoff file validation, in-place follow-up self-heal and Gate execution.
 *
 * Split out of executor.ts (behavior line-for-line equivalent to before the split); dependencies injected via PaneHandoffPort
 * (the executor holds the registry / transport / pane env baseline and secret re-authorization / settle
 * waiting and failure marking):
 * - readAndValidateOutput: handoff file read + JSON Schema/md stability validation; on failure self-heal
 *   exactly once (same-shape follow-up), then fail explicitly with herdr_output_contract_violation plus the
 *   agent.read recent_unwrapped 40-line redacted snapshot; never pass off dirty terminal text as the result;
 * - readDiagnostic: 40-line redacted diagnostic snapshot (shared by executor / approval bridge);
 * - runGateFor: exactly once after file success (local runLocalGate / remote transport.runGate,
 *   same actual cwd and routing baseline env; secrets are never cached, re-authorized per request secretNames
 *   from the current stash; missing/expired/settled gets an explicit 404 before the gate subprocess starts).
 *
 * Honesty discipline (no silent degradation): transport IO/SSH/permission errors throw diagnostics as-is
 * (herdr_output_missing 404 is the only self-healable boundary code); never re-dispatch the task treating
 * other errors as a missing file.
 */

import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, validateOrThrow, type AgentSpawnRequest } from '@helm/protocol'
import type { HerdrPluginDependencies, HerdrTarget } from './contracts.js'
import { nodeIdOf, paneStateKey, targetOf, type ManagedPane } from './panes.js'
import { parsePaneRead, type HerdrAgentInfo } from './rpc.js'
import { redactSchemaText } from './spawn-rules.js'

/** The minimal dependency surface of PaneHandoff on the executor. */
export interface PaneHandoffPort {
  transport: NonNullable<HerdrPluginDependencies['transport']>
  redact(text: string): string
  notify(title: string, body: string, level: 'info' | 'error'): void
  /** AskDoc target conversation (defaults to the parent conversation). */
  askConversationId(parentConversationId: number): number
  /** Pane env baseline (current paneEnvs value; shared by Gate and resume, no stash secrets). */
  paneEnvOf(key: string): Record<string, string> | undefined
  /** Re-authorize secrets from the current stash overlaid onto the baseline (fetched fresh each time; missing gets an explicit 404 at the kernel boundary). */
  applyPaneSecrets(
    baseline: Record<string, string>,
    parentConversationId: number,
    cwd: string,
    target: HerdrTarget,
    secretNames: string[],
  ): Record<string, string>
  /** prompt --wait (blocked may also return immediately; the approval bridge takes over). */
  promptAndWait(target: HerdrTarget, pane: ManagedPane, text: string, signal?: AbortSignal): Promise<HerdrAgentInfo>
  /** Settle waiting + blocked approval bridge loop. */
  waitUntilSettled(request: AgentSpawnRequest, pane: ManagedPane, initial: HerdrAgentInfo): Promise<void>
  /** $helm status token projection (mark heal before the self-heal follow-up). */
  project(pane: ManagedPane, token: string): Promise<void>
  /** Failure pane keep-the-scene marker (outcome=failed + redacted failureNote). */
  markFailed(pane: ManagedPane, note: string): Promise<void>
  /** Local Gate execution port (remote goes through transport.runGate). */
  runLocalGate: HerdrPluginDependencies['runLocalGate']
  /** md handoff stability recheck interval (shortened in tests; production default 300ms). */
  mdStableRecheckMs?: number
}

export class PaneHandoff {
  /** Interval for the md handoff stability recheck (accepted only when two reads agree; json has hard schema validation and needs no such check). */
  private static readonly DEFAULT_MD_STABLE_RECHECK_MS = 300

  constructor(private readonly port: PaneHandoffPort) {}

  async readAndValidateOutput(request: AgentSpawnRequest, pane: ManagedPane): Promise<unknown> {
    const transport = this.port.transport
    const fileName = pane.outputFileName!
    const target = targetOf(pane)
    const readOnce = async (): Promise<{ ok: true; value: unknown } | { ok: false; reason: string; recoverable: boolean }> => {
      let raw: string
      try {
        raw = await transport.readOutput(target, pane.effectiveCwd, fileName, request.signal)
      } catch (error) {
        if (error instanceof HelmError && error.code === 'herdr_output_missing') {
          return { ok: false, reason: `handoff file missing: ${fileName}`, recoverable: true }
        }
        // Other IO/SSH/permission errors: throw diagnostics as-is; do not self-heal as a missing file.
        throw error
      }
      if (request.schema === undefined) {
        if (raw.trim() === '') return { ok: false, reason: 'handoff file is empty', recoverable: true }
        return { ok: true, value: this.port.redact(raw) }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (err) {
        return {
          ok: false,
          reason: `handoff file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: true,
        }
      }
      try {
        validateOrThrow(request.schema, parsed, 'handoff file content failed JSON Schema validation', 'schema_validation_failed', 502)
        return { ok: true, value: JSON.parse(this.port.redact(JSON.stringify(parsed))) as unknown }
      } catch (err) {
        if (err instanceof HelmError && err.code === 'schema_validation_failed') {
          return { ok: false, reason: err.message, recoverable: true }
        }
        throw err
      }
    }

    /**
     * Stability recheck for md handoff: with non-atomic multi-part writes plus agent.wait returning
     * idle while a background write is still going, the first read may see truncated Markdown -- accept
     * only when a short-interval re-read agrees, otherwise take the self-heal follow-up path (the json
     * path already has parse+schema hard validation and needs no such check; residual risk: a truncated
     * prefix that happens to finish and stop changing between the two reads is still indistinguishable, backstopped by the self-heal follow-up).
     */
    const readOnceStable = async (): Promise<{ ok: true; value: unknown } | { ok: false; reason: string; recoverable: boolean }> => {
      const first = await readOnce()
      if (!first.ok || request.schema !== undefined) return first
      const recheckMs = this.port.mdStableRecheckMs ?? PaneHandoff.DEFAULT_MD_STABLE_RECHECK_MS
      await delay(recheckMs, undefined, { signal: request.signal })
      const second = await readOnce()
      if (!second.ok) return second
      if (second.value !== first.value) {
        return { ok: false, reason: 'handoff file is still being written (interval re-read disagrees)', recoverable: true }
      }
      return first
    }

    let attempt = await readOnceStable()
    if (!attempt.ok) {
      this.port.notify('Herdr handoff self-heal', `pane ${pane.paneId} first handoff failed (${attempt.reason}); following up once`, 'info')
      await this.port.project(pane, `heal:${pane.agentName}`)
      // The self-heal follow-up itself may also get blocked: the same approval bridge waits for real
      // progress before re-reading the file; a missing file must not be judged a failure.
      await this.promptAndWaitHeal(request, pane, attempt.reason)
      attempt = await readOnceStable()
    }
    if (!attempt.ok) {
      await this.port.markFailed(pane, attempt.reason)
      const snapshot = await this.readDiagnostic(pane)
      throw new HelmError(
        'herdr_output_contract_violation',
        `pane ${pane.paneId} both handoff attempts failed (${attempt.reason}); pane kept for manual investigation. Last 40 terminal lines (redacted):\n${snapshot}`,
        502,
        { paneId: pane.paneId, reason: attempt.reason, snapshot },
      )
    }
    await transport.removeOutput(target, pane.effectiveCwd, fileName, request.signal)
    return attempt.value
  }

  /** Self-heal follow-up: same shape as the first round (prompt --wait + blocked bridge loop). */
  private async promptAndWaitHeal(request: AgentSpawnRequest, pane: ManagedPane, reason: string): Promise<void> {
    const target = targetOf(pane)
    const text =
      `Your previous round did not deliver as required. ${reason}. Write the final result now to ${pane.effectiveCwd}/.helm/${pane.outputFileName}` +
      (request.schema !== undefined ? ` (a single JSON value satisfying the Schema).\nJSON Schema: ${redactSchemaText(request.schema, this.port.redact)}` : ' (full Markdown).')
    const info = await this.port.promptAndWait(target, pane, this.port.redact(text), request.signal)
    await this.port.waitUntilSettled(request, pane, info)
  }

  /** agent.read recent_unwrapped 40-line redacted snapshot (diagnostics only). */
  async readDiagnostic(pane: ManagedPane): Promise<string> {
    try {
      const read = parsePaneRead(
        await this.port.transport.call(targetOf(pane), 'agent.read', {
          target: pane.paneId,
          source: 'recent_unwrapped',
          lines: 40,
          format: 'text',
        }, { timeoutMs: 5_000 }),
      )
      return this.port.redact(read.text).slice(-4_000)
    } catch (error) {
      return `[snapshot read failed: ${error instanceof Error ? this.port.redact(error.message) : String(error)}]`
    }
  }

  /** gate: exactly once after file success; local runLocalGate, remote transport.runGate (same actual cwd and routing baseline env). */
  async runGateFor(request: AgentSpawnRequest, pane: ManagedPane): Promise<void> {
    const baseline = this.port.paneEnvOf(paneStateKey(pane))
    if (baseline === undefined) throw new HelmError('herdr_context_unavailable', 'task environment is lost; cannot run Gate in the same environment', 409)
    const env = this.port.applyPaneSecrets(baseline, request.parentConversationId, pane.effectiveCwd, targetOf(pane), request.secretNames ?? [])
    const gate: { ok: boolean; output: string } =
      nodeIdOf(pane) === undefined
        ? await this.port.runLocalGate(request.gate!, {
            cwd: pane.effectiveCwd,
            conversationId: this.port.askConversationId(request.parentConversationId),
            signal: request.signal,
            env,
          })
        : await this.port.transport.runGate(targetOf(pane), request.gate!, pane.effectiveCwd, request.signal, env)
    request.onGateResult?.({ ...gate, output: this.port.redact(gate.output) })
    if (!gate.ok) {
      await this.port.markFailed(pane, `gate failed: ${request.gate}`)
      throw new HelmError(
        'gate_failed',
        `gate command failed (exit!=0): ${request.gate}\n${this.port.redact(gate.output).slice(-2000)}`,
        502,
        { output: this.port.redact(gate.output).slice(-4000) },
      )
    }
  }
}
