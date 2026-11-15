import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { AgentGateResult } from '@helm/protocol'
import type { HerdrNodeChannel, HerdrNodeEnv } from './contracts.js'
import { checkAborted, HerdrTransportError } from './transport-shared.js'

/**
 * Herdr Gate 命令执行，本机与远端同构（从 transport.ts 拆出，行为与拆分前
 * 逐行等价）：
 * - SDK NodeExecutionEnv.exec：跨平台 shell 选择与进程树终止由 SDK 承担；
 * - inheritEnv: false：只注入显式受管 env，宿主环境变量绝不泄漏进 gate 子进程；
 * - 流式累计超限（MAX_GATE_OUTPUT_BYTES）立即 abort 远端命令并显式失败；
 * - 超时 herdr_timeout / 外部 abort herdr_aborted 如实分型，不静默降级。
 */

/** Gate 输出保留上限；超限显式失败，绝不静默截断充当成功。 */
export const MAX_GATE_OUTPUT_BYTES = 1024 * 1024

/** Gate 超时（秒；NodeExecutionEnv timeout 单位）：600s 预算 + 收尾余量。 */
const GATE_TIMEOUT_SECONDS = 620

function validEnvEntries(env: Record<string, string> | undefined): [string, string][] {
  return Object.entries(env ?? {}).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
}

/**
 * Gate 执行核心（本机与远端同构）：SDK `NodeExecutionEnv.exec`——跨平台 shell
 * 选择（Unix /bin/bash→sh；Windows Git Bash/WSL 探测）与进程树终止
 * （Unix 进程组 SIGKILL；Windows taskkill /F /T）由 SDK 承担。
 * `inheritEnv: false`：只注入显式受管 env（宿主 HELM_TOKEN 等绝不泄漏进
 * gate 子进程；token 只能经显式 env 提供）。流式累计超限即取消并显式失败。
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
            controller.abort() // 立即取消远端命令，不先聚合无限输出
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

/** 本机 Gate：NodeExecutionEnv（真实本机环境）+ 显式受管 env。 */
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

/** 远端 Gate：经节点 env.exec 在目标节点执行（同一安全边界）。 */
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
