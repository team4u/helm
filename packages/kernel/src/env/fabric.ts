/**
 * 环境编排（EnvFabric）：按 (nodeId, cwd) 提供 pi-durable ExecutionEnv。
 *
 * - `local`：直接复用 pi-durable 的 NodeExecutionEnv（进程内，无 RPC）；
 * - 远端 BYOM 节点：RemoteExecutionEnv over NodeRegistry（WS+birpc）；
 *   远端节点离线时等待重连（可取消），**绝不回落到 local**；
 * - 环境选项注入（受管 HELM_TOKEN / HELM_HUB_URL / HELM_CONVERSATION_ID /
 *   SecretStash 机密）经 envOptions 回调合成：机密服务在 fabric 外部，
 *   fabric 只消费回调结果，不持有机密；
 * - IPC 桥（ipcCall / ipcSubscribe）：供可选插件（如 builtin:herdr）经
 *   节点通道连接目标机器上的 Unix Socket / Named Pipe，跨节点同构。
 */

import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import {
  HelmError,
  type NodeEnvRpcFunctions,
  type NodeIpcCallInput,
  type NodeIpcSubscribeInput,
  type RpcResult,
} from '@helm/protocol'
import { randomUUID } from 'node:crypto'
import { NodeRegistry } from './registry.js'
import { RemoteExecutionEnv } from './remote-env.js'
import { createScopedExecutionEnv, type EnvTarget, type ScopedExecutionEnv } from './scoped-env.js'

export { ExecOutputHub } from './exec-output.js'
export { NodeRegistry, tokenAuthenticator, sha256hex } from './registry.js'
export type { NodeRegistryOptions, NodeConnection, RegisterOutcome, HubConnectionLocal, NodeSideFunctions } from './registry.js'
export { RemoteExecutionEnv } from './remote-env.js'
export type { NodeRpcResolver, RemoteExecutionEnvOptions } from './remote-env.js'
export { attachNodeWsGateway } from './ws-gateway.js'
export type { NodeWsGateway, NodeWsGatewayOptions } from './ws-gateway.js'
export { createScopedExecutionEnv } from './scoped-env.js'
export type { EnvTarget, ScopedExecutionEnv } from './scoped-env.js'

/** exec 时合成的环境选项（机密与身份注入的唯一通道）。 */
export type EnvOptionsComposer = (input: {
  nodeId: string
  cwd: string
  conversationId?: number
}) => Promise<Record<string, string>> | Record<string, string>

export interface EnvFabricOptions {
  /** 节点 token 鉴权（由外部签发表提供；缺省拒绝一切注册）。 */
  authenticate?: (nodeId: string, token: string) => boolean | Promise<boolean>
  /** 心跳间隔/超时（毫秒）。 */
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  /**
   * 环境选项注入回调：exec 前合成附加 env（如 HELM_HUB_URL、
   * HELM_CONVERSATION_ID、受管 HELM_TOKEN、SecretStash 机密）。由外部
   * 机密服务组合——fabric 不持有任何机密。
   */
  envOptions?: EnvOptionsComposer
}

/** 对 runtime 暴露的最小端口。 */
export interface EnvFabric {
  /** 内建注册表（WS 网关接线用：attachNodeWsGateway(server, { registry })）。 */
  readonly registry: NodeRegistry
  /** 取执行环境：local 进程内直用；远端经 RPC；未知节点显式等待/报错。 */
  envFor(nodeId: string, cwd: string): ExecutionEnv
  /**
   * 会话作用域执行环境（推荐入口）：同一 (nodeId,cwd) 的并发会话各自拿到
   * 独立 env 选项作用域——每条命令的 envOptions 现场合成（fresh，含
   * 绑定的受管 token / HELM_CONVERSATION_ID / SecretStash 机密），绝不
   * 缓存或借用上一个会话的选项快照。共享传输（同节点一个连接），
   * 逐命令选项隔离。无 conversationId 时不注入任何机密（fail-closed）。
   */
  envForTarget(target: EnvTarget): ScopedExecutionEnv
  /** 远端节点是否在线（local 恒 true）。 */
  isOnline(nodeId: string): boolean
  /** 等待远端节点上线（可取消）；local 恒为 true。 */
  waitForOnline(nodeId: string, context: Context): Promise<boolean>
  /** exec 前的选项合成（外部把结果并入 envExec.env）。 */
  composeEnvOptions(input: { nodeId: string; cwd: string; conversationId?: number }): Promise<Record<string, string>>
  /**
   * 节点本机单次 IPC 调用（跨节点连接目标机器上的 Unix Socket / Named
   * Pipe）。节点不支持 IPC 桥或节点离线时显式报错（fail-fast，不静默降级）。
   */
  ipcCall(nodeId: string, input: NodeIpcCallInput, signal?: AbortSignal): Promise<RpcResult<string>>
  /**
   * 节点本机流式 IPC 订阅：onLine 逐行回调；onClosed 在结束/断开/取消时
   * 恰好回调一次；返回的函数用于主动停止订阅。节点不支持时抛错。
   */
  ipcSubscribe(
    nodeId: string,
    input: Omit<NodeIpcSubscribeInput, 'subscribeId'>,
    onLine: (line: string) => void,
    onClosed: (error?: string) => void,
    signal?: AbortSignal,
  ): Promise<() => void>
  /** 节点注册时上报的 hubUrl（远端受管子进程回连地址守恒）。 */
  getNodeHubUrl(nodeId: string): string | undefined
  /** dispose：远端 env 清理（杀命令）+ 注册表关闭；幂等。 */
  dispose(): Promise<void>
}

export function createEnvFabric(options: EnvFabricOptions): EnvFabric {
  const { envOptions } = options
  // **底座按靶点隔离**：local 与远端都按 (conversationId, nodeId, cwd)
  // 缓存独立实例——共享的只有注册表/连接，cwd 语义（相对路径解析 + exec
  // 默认 cwd）每个靶点互不影响；workerA(cwdA) 与 workerB(cwdB) 绝不
  // 共享可变 cwd 的同一实例。
  const bases = new Map<string, ExecutionEnv>()
  const registry = new NodeRegistry({
    authenticate: options.authenticate ?? (() => false),
    ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
  })
  const remoteResolver = {
    getNodeEnvRpc: (nodeId: string): NodeEnvRpcFunctions | undefined => registry.getNodeEnvRpc(nodeId),
    waitForNodeOnline: (nodeId: string, context: Context) => registry.waitForNodeOnline(nodeId, context),
  }

  const baseKey = (nodeId: string, cwd: string, conversationId?: number): string =>
    `${nodeId}\u0000${cwd}\u0000${conversationId ?? '-'}`

  /** 取（或建）靶点专属底座：local 直建；远端 RemoteExecutionEnv 且把
   *  输出 sink 登记到注册表（按节点路由，同节点多靶点互不串扰）。 */
  const baseFor = (nodeId: string, cwd: string, conversationId?: number): ExecutionEnv => {
    const key = baseKey(nodeId, cwd, conversationId)
    let entry = bases.get(key)
    if (entry === undefined) {
      if (nodeId === 'local') {
        entry = new NodeExecutionEnv({ cwd })
      } else {
        const remote = new RemoteExecutionEnv(remoteResolver, { nodeId, cwd })
        registry.addOutputSink(nodeId, remote.onEnvExecOutput)
        entry = remote
      }
      bases.set(key, entry)
    }
    return entry
  }

  /** 等待节点在线的 rpc（IPC 桥共用；不等待重连，离线即显式报错）。 */
  const requireRpc = async (nodeId: string, signal?: AbortSignal): Promise<NodeEnvRpcFunctions> => {
    if (signal?.aborted) throw new HelmError('aborted', 'IPC 调用已取消', 499)
    const rpc = registry.getNodeEnvRpc(nodeId)
    if (rpc !== undefined) return rpc
    throw new HelmError('node_offline', `节点 ${nodeId} 离线，无法建立 IPC 通道`, 409, { nodeId })
  }

  return {
    registry,
    envFor(nodeId: string, cwd: string): ExecutionEnv {
      // 靶点专属底座（无会话维度：conversationId 缺省键）；远端离线时
      // 也返回 Remote env（操作时等待重连），**绝不回落 local**。
      return baseFor(nodeId, cwd, undefined)
    },

    envForTarget(target: EnvTarget): ScopedExecutionEnv {
      // 靶点专属底座 + 会话选项作用域：同一 (nodeId,cwd) 的两个会话底座
      // 实例独立（cwd 互不污染），选项各自现场合成。
      const base = baseFor(target.nodeId, target.cwd, target.conversationId)
      return createScopedExecutionEnv(base, target, envOptions)
    },

    isOnline(nodeId: string): boolean {
      if (nodeId === 'local') return true
      return registry.get(nodeId) !== undefined
    },

    async waitForOnline(nodeId: string, context: Context): Promise<boolean> {
      if (nodeId === 'local') return true
      return (await registry.waitForNodeOnline(nodeId, context)) !== undefined
    },

    async composeEnvOptions(input: { nodeId: string; cwd: string; conversationId?: number }): Promise<Record<string, string>> {
      if (envOptions === undefined) return {}
      return envOptions(input)
    },

    async ipcCall(nodeId: string, input: NodeIpcCallInput, signal?: AbortSignal): Promise<RpcResult<string>> {
      const rpc = await requireRpc(nodeId, signal)
      if (rpc.ipcCall === undefined) {
        throw new HelmError('ipc_not_supported', `节点 ${nodeId} 的守护进程不支持本机 IPC 调用`, 501, {
          nodeId,
        })
      }
      const callId = input.callId ?? `ipc-${randomUUID()}`
      // signal abort 时尽力销毁在途调用（节点侧立即关闭底层 socket）。
      const ipcCall = rpc.ipcCall
      const ipcAbort = rpc.ipcAbortCall
      if (ipcCall === undefined) {
        throw new HelmError('ipc_not_supported', `节点 ${nodeId} 的守护进程不支持本机 IPC 调用`, 501, {
          nodeId,
        })
      }
      const onAbort = () => {
        void ipcAbort?.(callId).catch(() => undefined)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); throw new HelmError('aborted', 'IPC 调用已取消', 499) }
      try {
        return await ipcCall({ ...input, callId })
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    },

    async ipcSubscribe(
      nodeId: string,
      input: Omit<NodeIpcSubscribeInput, 'subscribeId'>,
      onLine: (line: string) => void,
      onClosed: (error?: string) => void,
      signal?: AbortSignal,
    ): Promise<() => void> {
      const rpc = await requireRpc(nodeId, signal)
      const ipcSubscribeFn = rpc.ipcSubscribe
      const ipcUnsubscribeFn = rpc.ipcUnsubscribe
      if (ipcSubscribeFn === undefined || ipcUnsubscribeFn === undefined) {
        throw new HelmError('ipc_not_supported', `节点 ${nodeId} 的守护进程不支持本机 IPC 订阅`, 501, {
          nodeId,
        })
      }
      const subscribeId = randomUUID()
      let closed = false
      let closedOnce = false
      const finish = (error?: string): void => {
        if (closedOnce) return
        closedOnce = true
        signal?.removeEventListener('abort', onAbort)
        registry.removeIpcSink(nodeId, subscribeId)
        try {
          onClosed(error)
        } catch {
          // 订阅者回调故障不影响 fabric。
        }
      }
      const onAbort = () => {
        if (closed) return
        closed = true
        void ipcUnsubscribeFn(subscribeId).catch(() => undefined)
        finish('aborted')
      }
      registry.addIpcSink(nodeId, subscribeId, {
        onEvent: (line) => {
          if (closed) return
          try { onLine(line) } catch { onAbort() }
        },
        onClosed: (error) => {
          if (closed) return
          closed = true
          finish(error)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      let result: Awaited<ReturnType<typeof ipcSubscribeFn>>
      try { result = await ipcSubscribeFn({ ...input, subscribeId }) }
      catch (error) { closed = true; finish('node connection lost'); throw error }
      if (signal?.aborted) { onAbort(); throw new HelmError('aborted', 'IPC 订阅已取消', 499) }
      if (!result.ok) {
        closed = true
        finish(result.error.message)
        throw new HelmError('ipc_subscribe_failed', `节点 ${nodeId} IPC 订阅失败：${result.error.message}`, 502, {
          nodeId,
          code: result.error.code,
        })
      }
      return () => {
        if (closed) return
        closed = true
        void ipcUnsubscribeFn(subscribeId).catch(() => undefined)
        finish()
      }
    },

    getNodeHubUrl(nodeId: string): string | undefined {
      if (nodeId === 'local') return undefined
      return registry.get(nodeId)?.hubUrl
    },

    async dispose(): Promise<void> {
      // 先关闭节点连接，让在途请求按未知终态结束；离线清理不等待重连。
      await registry.close()
      const cleanups: Promise<void>[] = []
      for (const [key, entry] of bases) {
        if (entry instanceof RemoteExecutionEnv) {
          const remote = entry as RemoteExecutionEnv
          registry.removeOutputSink(key.split('\u0000')[0]!, remote.onEnvExecOutput)
        }
        cleanups.push(entry.cleanup(BACKGROUND_CONTEXT).catch(() => undefined))
      }
      bases.clear()
      await Promise.allSettled(cleanups)
      await registry.close()
    },
  }
}
