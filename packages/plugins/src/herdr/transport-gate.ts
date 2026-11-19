import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { AgentGateResult } from '@helmx/protocol'
import type { HerdrNodeChannel, HerdrNodeEnv } from './contracts.js'
import { checkAborted, HerdrTransportError } from './transport-shared.js'

/**
 * Herdr Gate command execution, isomorphic for local and remote (split out of transport.ts,
 * behavior line-for-line equivalent to before the split):
 * - SDK NodeExecutionEnv.exec: cross-platform shell selection and process-tree termination are the SDK's job;
 * - inheritEnv: false: only explicit managed env is injected; host environment variables never leak into the gate subprocess;
 * - streaming accumulation over the limit (MAX_GATE_OUTPUT_BYTES) immediately aborts the remote command and fails explicitly;
 * - timeout herdr_timeout / external abort herdr_aborted are typed honestly; no silent degradation.
 */

/** Gate output retention cap; over the limit fails explicitly, never silently truncated and passed off as success. */
export const MAX_GATE_OUTPUT_BYTES = 1024 * 1024

/** Gate timeout (seconds; the NodeExecutionEnv timeout unit): a 600s budget + teardown headroom. */
const GATE_TIMEOUT_SECONDS = 620

function validEnvEntries(env: Record<string, string> | undefined): [string, string][] {
  return Object.entries(env ?? {}).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
}

/**
 * Gate execution core (isomorphic local & remote): SDK `NodeExecutionEnv.exec` -- cross-platform shell
 * selection (Unix /bin/bash->sh; Windows Git Bash/WSL probing) and process-tree termination
 * (Unix process-group SIGKILL; Windows taskkill /F /T) are the SDK's job.
 * `inheritEnv: false`: only the explicit managed env is injected (host HELMX_TOKEN etc. never leak into
 * the gate subprocess; a token can only be provided via explicit env). Streaming over the limit cancels and fails explicitly.
 */
async function execGate(
  env: HerdrNodeEnv,
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  target: string,
  envVars: Record<string, string>,
  redact: (s: string) => string,
): Promise<AgentGateResult> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const chunks: string[] = []
  let total = 0
  let overflow = false
  try {
    const result = await env.exec(
      command,
      {
        cwd,
        env: envVars,
        inheritEnv: false,
        timeout: GATE_TIMEOUT_SECONDS,
        onOutput: (text) => {
          total += Buffer.byteLength(text, 'utf8')
          if (total > MAX_GATE_OUTPUT_BYTES) {
            overflow = true
            controller.abort() // cancel the remote command immediately; do not aggregate unbounded output first
            return
          }
          chunks.push(text)
        },
      },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    )
    if (!result.ok) {
      if (overflow) return { ok: false, output: `gate output exceeded ${MAX_GATE_OUTPUT_BYTES} bytes` }
      if (result.error.code === 'aborted' && signal?.aborted) {
        throw new HerdrTransportError('herdr_aborted', 'gate aborted', target)
      }
      if (result.error.code === 'timeout') {
        throw new HerdrTransportError('herdr_timeout', `gate timed out: ${result.error.message}`, target)
      }
      throw new HerdrTransportError('herdr_node_error', `gate failed: ${result.error.code}: ${result.error.message}`, target)
    }
    if (total > MAX_GATE_OUTPUT_BYTES) {
      return { ok: false, output: `gate output exceeded ${MAX_GATE_OUTPUT_BYTES} bytes` }
    }
    return { ok: result.value.exitCode === 0, output: redact(chunks.join('')) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Local Gate: NodeExecutionEnv (the real local environment) + explicit managed env. */
export async function runLocalGate(
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  env: Record<string, string> | undefined,
  target: string,
  redact: (s: string) => string,
): Promise<AgentGateResult> {
  checkAborted(signal, target)
  const sanitized: Record<string, string> = {}
  for (const [key, value] of validEnvEntries(env)) sanitized[key] = value
  const localEnv = new NodeExecutionEnv({ cwd })
  return execGate(localEnv, command, cwd, signal, target, sanitized, redact)
}

/** Remote Gate: executed on the target node via the node env.exec (the same safety boundary). */
export async function runNodeGate(
  nodeChannel: HerdrNodeChannel,
  nodeId: string,
  targetLabel: string,
  command: string,
  cwd: string,
  signal: AbortSignal | undefined,
  env: Record<string, string> | undefined,
  redact: (s: string) => string,
): Promise<AgentGateResult> {
  checkAborted(signal, targetLabel)
  const sanitized: Record<string, string> = {}
  for (const [key, value] of validEnvEntries(env)) sanitized[key] = value
  return execGate(nodeChannel.envFor(nodeId, cwd), command, cwd, signal, targetLabel, sanitized, redact)
}
