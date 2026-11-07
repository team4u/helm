/**
 * 本机节点连接的最小生产 helper（`nodeId === 'local'`）：
 * - 真实 IPC：Unix 直接 connect UDS 路径；Windows 按 herdr 实际规则把
 *   marker 文件路径换算为 Named Pipe 名（见 windowsPipeNameOf 源码依据注释）；
 * - 真实执行环境：`NodeExecutionEnv` 结构即满足 `HerdrNodeEnv`（Pick 子集）。
 *
 * Windows pipe 名规则（interprocess 2.4.2 源码核实，非臆测）：
 * - `src/os/windows/path_conversion.rs` `pathcvt`（L126-137）：namespaced 名只是
 *   `\\\\` + `.`（本地主机）+ `\\pipe\\` + 原始 name 逐段拼接，**不替换冒号/
 *   斜杠**（herdr 的 marker 路径 `C:\\Users\\...\\herdr.sock` 进 pipe 名后冒号
 *   原样保留——NPFS 对 name 除 NUL 与路径分隔语义外不禁止 `:`）；
 * - `src/os/windows/local_socket/name_type.rs` `map_generic_namespaced_osstr`：
 *   已是 `\\HOST\pipe\NAME` 形态的完整 pipe 路径原样通过（`is_pipefs`）。
 * 依据源码推导，未在 Windows 实机验证（测试如实声明）。
 */

import { connect } from 'node:net'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { Context } from '@earendil-works/chord/context'
import type { RpcResult } from '@helm/protocol'
import type { HerdrNodeChannel, HerdrNodeEnv } from './contracts.js'

/** interprocess `\\<host>\pipe\<name>` 的本地主机段（pathcvt LOCAL_HOSTNAME）。 */
const PIPE_PREFIX = '\\\\.\\pipe\\'

/**
 * Windows marker 文件路径 → named pipe 连接名。
 * 规则 = `\\.\pipe\` + 原始路径（仅统一正斜杠为反斜杠；冒号/其余字符原样）。
 * 已是完整 pipe 路径（`\\.\pipe\...` 或 `\\HOST\pipe\...`）时原样返回。
 */
export function windowsPipeNameOf(markerPath: string): string {
  const normalized = markerPath.replaceAll('/', '\\')
  if (isPipePath(normalized)) return normalized
  return PIPE_PREFIX + normalized
}

/** interprocess `is_pipefs` 同规则：`\\HOST\pipe\...`（host 段非空）即完整 pipe 路径。 */
function isPipePath(path: string): boolean {
  if (!path.startsWith('\\\\')) return false
  const hostEnd = path.indexOf('\\', 2)
  if (hostEnd <= 2) return false
  return path.startsWith('\\pipe\\', hostEnd)
}

/** 建立到本机 Herdr IPC 端点的 socket 连接（Unix UDS / Windows Named Pipe）。 */
export function connectHerdrEndpoint(endpoint: string, kind: 'unix-socket' | 'named-pipe') {
  if (kind === 'named-pipe') {
    return connect(windowsPipeNameOf(endpoint))
  }
  return connect(endpoint)
}

/**
 * 本机节点通道（`nodeId === 'local'`；其它节点一律拒绝——EnvFabric 未注入时
 * transport 对远端目标显式报 herdr_node_unavailable，绝不经本类兜底本机执行）。
 * 一连接一请求：写入单行请求，读到首个换行响应即返回并关闭。
 */
export class LocalNodeChannel implements HerdrNodeChannel {
  private readonly envCache = new Map<string, HerdrNodeEnv>()

  isOnline(nodeId: string): boolean {
    return nodeId === 'local'
  }

  getNodeHubUrl(): string | undefined {
    return undefined
  }

  async ipcCall(
    nodeId: string,
    input: { endpoint?: string; session?: string; line: string; timeoutMs?: number },
    context: Context,
  ): Promise<RpcResult<string>> {
    if (nodeId !== 'local') {
      return { ok: false, error: { code: 'invalid', message: `LocalNodeChannel 仅承载 'local' 节点（收到 '${nodeId}'）` } }
    }
    if (input.endpoint === undefined) {
      return { ok: false, error: { code: 'invalid', message: 'ipcCall requires an explicit endpoint' } }
    }
    if (context.abortSignal?.aborted) {
      return { ok: false, error: { code: 'aborted', message: 'ipcCall aborted' } }
    }
    return await new Promise<RpcResult<string>>((resolve) => {
      const socket = connectHerdrEndpoint(input.endpoint!, 'unix-socket')
      socket.setNoDelay(true)
      const chunks: Buffer[] = []
      let done = false
      const settle = (result: RpcResult<string>) => {
        if (done) return
        done = true
        clearTimeout(timer)
        context.abortSignal?.removeEventListener('abort', onAbort)
        socket.destroy()
        resolve(result)
      }
      const timer =
        input.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              settledTimeout = true
              settle({ ok: false, error: { code: 'timeout', message: `ipcCall no response within ${input.timeoutMs}ms` } })
            }, input.timeoutMs)
      timer?.unref?.()
      let settledTimeout = false
      const onAbort = () => settle({ ok: false, error: { code: 'aborted', message: 'ipcCall aborted' } })
      context.abortSignal?.addEventListener('abort', onAbort, { once: true })
      socket.on('connect', () => socket.write(`${input.line}\n`))
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        const joined = Buffer.concat(chunks)
        const newline = joined.indexOf(0x0a)
        if (newline >= 0) settle({ ok: true, value: joined.subarray(0, newline).toString('utf8') })
      })
      socket.once('close', () => {
        if (settledTimeout || context.abortSignal?.aborted) return
        const joined = Buffer.concat(chunks)
        settle(
          joined.length === 0
            ? { ok: false, error: { code: 'unknown', message: 'ipc endpoint closed before response' } }
            : { ok: true, value: joined.toString('utf8').split('\n')[0]! },
        )
      })
      socket.once('error', (err) => {
        if (settledTimeout || context.abortSignal?.aborted) return
        settle({ ok: false, error: { code: 'unknown', message: err.message } })
      })
    })
  }

  envFor(nodeId: string, cwd: string): HerdrNodeEnv {
    if (nodeId !== 'local') {
      throw new Error(`LocalNodeChannel 仅承载 'local' 节点的文件环境（收到 '${nodeId}'）`)
    }
    const cached = this.envCache.get(cwd)
    if (cached !== undefined) return cached
    // NodeExecutionEnv 结构即满足 HerdrNodeEnv（Pick 子集）；取消由调用方
    // 经 withAbortSignal(signal, BACKGROUND_CONTEXT) 派生的 context 携带。
    const env: HerdrNodeEnv = new NodeExecutionEnv({ cwd })
    this.envCache.set(cwd, env)
    return env
  }
}
