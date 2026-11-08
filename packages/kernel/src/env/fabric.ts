/**
 * 环境编排（EnvFabric）：按靶点提供 pi-durable ExecutionEnv。
 *
 * - `local`：直接复用 pi-durable 的 NodeExecutionEnv（进程内，无 RPC）；
 * - 远端 BYOM 节点：RemoteExecutionEnv over NodeRegistry（WS+birpc）；
 *   远端节点离线时等待重连（可取消），**绝不回落到 local**；
 * - 环境选项注入（受管 HELM_TOKEN / HELM_HUB_URL / HELM_CONVERSATION_ID /
 *   SecretStash 机密）经 envOptions 回调合成：机密服务在 fabric 外部，
 *   fabric 只消费回调结果，不持有机密；
 * - IPC 桥（ipcCall / ipcSubscribe）：供可选插件（如 builtin:herdr）经
 *   节点通道连接目标机器上的 Unix Socket / Named Pipe，跨节点同构。
 *
 * 缓存生命周期（有界，无引用计数/LRU 框架）：
 * - **有会话靶点（envForTarget 且带 conversationId）**：按
 *   (conversationId, nodeId, cwd) 缓存底座；会话删除（deleteConversation）
 *   或修改 nodeId/cwd（updateConversation）时 evictConversation 释放该会话
 *   全部条目。驱逐只移除缓存条目、绝不调用 cleanup 杀在途命令——该会话
 *   在途 exec/reader 仍持有旧实例引用并自然完成（abort 路径另行精确杀），
 *   实例随最后一个在途操作结束被 GC，缓存不增长也不误杀。
 * - **无会话靶点（envFor / envForTarget 无 conversationId）**：短生命周期
 *   对象——每次调用创建全新实例，用后即弃，绝不进缓存（herdr 文件交接、
 *   gate、无会话 HTTP exec 均为短序列）。远端实例的输出 sink 由
 *   RemoteExecutionEnv 按 exec 生命周期自注册/自注销（见 remote-env.ts），
 *   对象丢弃即无注册残留，不需要调用方显式 release。
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
export type { NodeRegistryOptions, NodeConnection, RegisterOutcome, HubConnectionLocal, NodeSideFunctions, UpgradeWaiterHandle } from './registry.js'
export { HelmUpgradeBusyError, HelmUpgradeTimeoutError, HelmUpgradeCancelledError } from './registry.js'
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
  /** local exec 的 PATH 前置目录（helm CLI 包装目录；缺省不前置）。 */
  cliBinDir?: () => string | undefined
  /** 资源释放失败的诊断日志（dispose 尽力清理路径；缺省 console.error）。 */
  logReleaseError?: (message: string) => void
}

/** 对外只读诊断口径（debugBases；不参与业务逻辑）。 */
export interface EnvTargetSnapshot {
  key: string
  nodeId: string
  cwd: string
  conversationId?: number
}

/** 对 runtime 暴露的最小端口。 */
export interface EnvFabric {
  /** 内建注册表（WS 网关接线用：attachNodeWsGateway(server, { registry })）。 */
  readonly registry: NodeRegistry
  /**
   * 无会话作用域执行环境（herdr 文件交接 / gate / 无会话 HTTP exec）：
   * **短生命周期对象**——每次调用全新实例，用后即弃，绝不缓存。local
   * 进程内直建；远端经 RPC；未知节点返回 Remote env（操作时等待重连），
   * **绝不回落 local**。
   */
  envFor(nodeId: string, cwd: string): ExecutionEnv
  /**
   * 会话作用域执行环境（推荐入口）：同一 (nodeId,cwd) 的并发会话各自拿到
   * 独立 env 选项作用域——每条命令的 envOptions 现场合成（fresh，含
   * 绑定的受管 token / HELM_CONVERSATION_ID / SecretStash 机密），绝不
   * 缓存或借用上一个会话的选项快照。共享传输（同节点一个连接），
   * 逐命令选项隔离。无 conversationId 时不注入任何机密（fail-closed），
   * 且不进缓存（短生命周期）。带 conversationId 时底座按会话缓存，
   * 会话删除/靶点变更经 evictConversation 释放。
   */
  envForTarget(target: EnvTarget): ScopedExecutionEnv
  /** 远端节点是否在线（local 恒 true）。 */
  isOnline(nodeId: string): boolean
  /** 等待远端节点上线（可取消）；local 恒为 true。 */
  waitForOnline(nodeId: string, context: Context): Promise<boolean>
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
  /**
   * 释放某会话的全部靶点缓存：仅移除 bases 条目（绝不调用 cleanup 杀
   * 该会话在途命令——在途 exec/reader 持旧实例自然完成，见文件头注释）。
   * 会话删除或修改 nodeId/cwd 时调用。
   */
  evictConversation(conversationId: number): void
  /** 当前靶点缓存条目数（诊断/测试内省；不参与业务逻辑）。 */
  debugBaseCount(): number
  /** 全部底座条目的只读诊断（测试/观测用；不参与业务逻辑）。 */
  debugBases(): EnvTargetSnapshot[]
  /** dispose：远端 env 清理 + 注册表关闭；幂等；单条失败如实记录不静默。 */
  dispose(): Promise<void>
}

export function createEnvFabric(options: EnvFabricOptions): EnvFabric {
  const { envOptions, cliBinDir } = options
  const logReleaseError = options.logReleaseError ?? ((message: string) => console.error(`[helm] env fabric: ${message}`))
  // **底座按会话靶点缓存**：仅 envForTarget（带 conversationId）使用——
  // 会话生命周期有界（evictConversation 释放）。无会话靶点每次新建。
  const bases = new Map<string, ExecutionEnv>()
  const registry = new NodeRegistry({
    authenticate: options.authenticate ?? (() => false),
    ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
  })
  const remoteResolver = {
    getNodeEnvRpc: (nodeId: string): NodeEnvRpcFunctions | undefined => registry.getNodeEnvRpc(nodeId),
    waitForNodeOnline: (nodeId: string, context: Context) => registry.waitForNodeOnline(nodeId, context),
    addOutputSink: (nodeId: string, sink: (event: import('@helm/protocol').EnvExecOutputEvent) => void) =>
      registry.addOutputSink(nodeId, sink),
    removeOutputSink: (nodeId: string, sink: (event: import('@helm/protocol').EnvExecOutputEvent) => void) =>
      registry.removeOutputSink(nodeId, sink),
  }

  const baseKey = (nodeId: string, cwd: string, conversationId: number): string =>
    `${nodeId}\u0000${cwd}\u0000${conversationId}`

  /** baseKey 的会话段。 */
  const conversationIdOfKey = (key: string): number | undefined => {
    const part = key.split('\u0000')[2]
    return part !== undefined && part !== '-' && /^\d+$/.test(part) ? Number(part) : undefined
  }

  /** 无缓存新建底座：local 进程内直建；远端 Remote（sink 由 exec 生命周期自管理）。 */
  const freshBase = (nodeId: string, cwd: string): ExecutionEnv =>
    nodeId === 'local' ? new NodeExecutionEnv({ cwd }) : new RemoteExecutionEnv(remoteResolver, { nodeId, cwd })

  /** 取（或建）会话靶点专属底座（仅带 conversationId 的靶点进缓存）。 */
  const baseFor = (nodeId: string, cwd: string, conversationId: number): ExecutionEnv => {
    const key = baseKey(nodeId, cwd, conversationId)
    let entry = bases.get(key)
    if (entry === undefined) {
      entry = freshBase(nodeId, cwd)
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
      // 无会话短生命周期对象：绝不缓存（同 cwd 反复使用也不堆积实例）。
      return freshBase(nodeId, cwd)
    },

    envForTarget(target: EnvTarget): ScopedExecutionEnv {
      // 靶点专属底座 + 会话选项作用域：同一 (nodeId,cwd) 的两个会话底座
      // 实例独立（cwd 互不污染），选项各自现场合成。无 conversationId 的
      // 靶点不进缓存（短生命周期；fail-closed 不注入机密）。
      const base =
        target.conversationId === undefined
          ? freshBase(target.nodeId, target.cwd)
          : baseFor(target.nodeId, target.cwd, target.conversationId)
      return createScopedExecutionEnv(base, target, envOptions, cliBinDir === undefined ? {} : { cliBinDir })
    },

    isOnline(nodeId: string): boolean {
      if (nodeId === 'local') return true
      return registry.get(nodeId) !== undefined
    },

    async waitForOnline(nodeId: string, context: Context): Promise<boolean> {
      if (nodeId === 'local') return true
      return (await registry.waitForNodeOnline(nodeId, context)) !== undefined
    },

    async ipcCall(nodeId: string, input: NodeIpcCallInput, signal?: AbortSignal): Promise<RpcResult<string>> {
      const rpc = await requireRpc(nodeId, signal)
      const ipcCallFn = rpc.ipcCall
      const ipcAbort = rpc.ipcAbortCall
      if (ipcCallFn === undefined) {
        throw new HelmError('ipc_not_supported', `节点 ${nodeId} 的守护进程不支持本机 IPC 调用`, 501, {
          nodeId,
        })
      }
      const callId = input.callId ?? `ipc-${randomUUID()}`
      // signal abort 时尽力销毁在途调用（节点侧立即关闭底层 socket）。
      const onAbort = () => {
        void ipcAbort?.(callId).catch(() => undefined)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) { onAbort(); throw new HelmError('aborted', 'IPC 调用已取消', 499) }
      try {
        return await ipcCallFn({ ...input, callId })
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

    evictConversation(conversationId: number): void {
      // 只移除缓存条目：绝不调用 entry.cleanup——NodeExecutionEnv.cleanup
      // 会杀 activeChildPids（该会话在途命令被误杀），Remote 的按 cwd
      // envCleanup 会杀同 cwd 其他会话的命令。在途操作持旧实例引用自然
      // 完成，实例随后可 GC；缓存不增长。
      for (const [key] of [...bases]) {
        if (conversationIdOfKey(key) === conversationId) bases.delete(key)
      }
    },

    debugBaseCount(): number {
      return bases.size
    },

    debugBases(): EnvTargetSnapshot[] {
      return [...bases].map(([key]) => ({
        key,
        nodeId: key.split('\u0000')[0]!,
        cwd: key.split('\u0000')[1]!,
        ...(conversationIdOfKey(key) !== undefined ? { conversationId: conversationIdOfKey(key) } : {}),
      }))
    },

    async dispose(): Promise<void> {
      // 先关闭节点连接，让在途请求按未知终态结束；离线清理不等待重连。
      await registry.close()
      // 再逐靶点硬清理（dispose 是关停语义，杀在途命令是预期的；Remote 的
      // cleanup 仅注销自身 sink，不发按 cwd 的 envCleanup——那会误杀同节点
      // 同 cwd 其他会话的命令，节点侧在途命令由连接级 dispose 兜底）。
      const entries = [...bases]
      bases.clear()
      for (const [key, entry] of entries) {
        const [nodeId, cwd] = key.split('\u0000')
        entry
          .cleanup(BACKGROUND_CONTEXT)
          .catch((error: unknown) =>
            logReleaseError(
              `底座清理失败（node=${nodeId} cwd=${cwd}）：${error instanceof Error ? error.message : String(error)}`,
            ),
          )
      }
      // registry.close 已在开头执行且幂等内部收敛；不重复调用第二次。
    },
  }
}
