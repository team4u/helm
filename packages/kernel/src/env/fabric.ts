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
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import {
  HelmError,
  type NodeEnvRpcFunctions,
  type NodeIpcCallInput,
  type NodeIpcSubscribeInput,
  type NodePathUsage,
  type NodePathUsageProcess,
  type NodeTunnelTarget,
  type RpcResult,
  scanPathUsage,
  validatePosixScanPath,
  type PathUsageIo,
} from '@helm/protocol'
import { readlink, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { NodeRegistry, normalizeTunnelTarget } from './registry.js'
import { RemoteExecutionEnv } from './remote-env.js'
import { connectLocalTunnel, tunnelFetch } from './node-fetch.js'
import { createScopedExecutionEnv, type EnvTarget, type ScopedExecutionEnv } from './scoped-env.js'
import { envWithFileMutationQueue } from './file-mutation-queue.js'

export { ExecOutputHub } from './exec-output.js'
export { NodeRegistry, tokenAuthenticator, sha256hex, normalizeTunnelTarget } from './registry.js'
export type { NodeRegistryOptions, NodeConnection, RegisterOutcome, HubConnectionLocal, NodeSideFunctions, UpgradeWaiterHandle } from './registry.js'
export { HelmUpgradeBusyError, HelmUpgradeTimeoutError, HelmUpgradeCancelledError } from './registry.js'
export { RemoteExecutionEnv } from './remote-env.js'
export type { NodeRpcResolver, RemoteExecutionEnvOptions } from './remote-env.js'
export { attachNodeWsGateway } from './ws-gateway.js'
export type { NodeWsGateway, NodeWsGatewayOptions } from './ws-gateway.js'
export { attachNodeTunnelGateway } from './ws-tunnel-gateway.js'
export type { NodeTunnelGateway, NodeTunnelGatewayOptions } from './ws-tunnel-gateway.js'
export { createScopedExecutionEnv } from './scoped-env.js'
export type { EnvTarget, ScopedExecutionEnv } from './scoped-env.js'

/** exec 时合成的环境选项（机密与身份注入的唯一通道）。 */
export type EnvOptionsComposer = (input: {
  nodeId: string
  cwd: string
  conversationId?: number
}) => Promise<Record<string, string>> | Record<string, string>

export interface EnvFabricOptions {
  /**
   * Hub 平台事实（缺省 process.platform）。仅用于测试或受控宿主注入；生产
   * 不应伪造本机平台，远端平台仍只取节点注册上报值。
   */
  hubPlatform?: () => string | undefined
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
  /** 远端文件操作解析 RPC 的等待重连上限（毫秒）；缺省见 remote-env.ts。 */
  remoteRpcWaitTimeoutMs?: number
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
   * Pipe）。节点不支持 IPC 桥或节点离线时显式报错（fail-fast，不静默降级）；
   * 节点升级排空拒新时 RpcResult 保留原始 node_draining 错误码（连接仍在、
   * 与离线/取消可区分，由调用方如 builtin:herdr 自行分型）。
   */
  ipcCall(nodeId: string, input: NodeIpcCallInput, signal?: AbortSignal): Promise<RpcResult<string>>
  /**
   * 节点本机流式 IPC 订阅：onLine 逐行回调；onClosed 在结束/断开/取消时
   * 恰好回调一次；返回的函数用于主动停止订阅。节点不支持时抛错；节点
   * 升级排空拒新时抛 HelmError node_draining（503）。
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
   * Hub 平台事实最小只读端口：缺省 process.platform，测试可显式注入。
   * 目标平台规范化只通过此端口读取 local 的可测试 Hub 事实；生产不得伪造。
   */
  readonly hubPlatform?: () => string | undefined
  /**
   * 节点平台（process.platform 口径）的最小只读端口：local 恒 Hub 宿主；
   * 远端仅取注册登记值（未上报或离线返回 undefined）。调用方据此做目标
   * 平台感知的路径规范化——平台未知时不猜、不 fallback Hub 宿主平台。
   */
  nodePlatformOf(nodeId: string): string | undefined
  /**
   * 文件互斥队列（目标节点 canonical 路径串行）：在 (nodeId, cwd) 靶点内把
   * fn 的读-改-写窗口与内核 write/edit 工具排同一队列（同文件不丢更新；
   * 其他文件/节点互不等待；软链别名同 key；新文件按 canonical 父目录拼接）。
   * local 直接在 Hub 进程队列执行；远端经短生命周期 RemoteExecutionEnv。
   * 不是对 bash/外部进程的锁，也不可重入；详见 env/file-mutation-queue.ts。
   */
  withFileMutationQueue<T>(
    target: { nodeId: string; cwd: string; path: string },
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>
  /**
   * 一等公民任意 TCP 隧道：建立到目标节点 host:port 的原始 Duplex。
   * - local：Hub 进程内 net.connect 直连；
   * - 远端：复用 registry.openTunnel（既有 WS 隧道网关，不另建传输）；
   * - 未知/离线节点显式 HelmError（node_offline 409），绝不回退 local；
   * - abort/超时/错误显式抛出并保证资源释放（duplex 不泄漏）。
   * host 由节点解析与连接（省略时目标为 127.0.0.1）。
   */
  openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex>
  /**
   * 节点本机 HTTP(S) fetch 适配层（基于 openTunnel）：local 直接返回
   * globalThis.fetch；远端支持任意 host 与 http/https——http 经隧道
   * Duplex 上的 node:http.request（createConnection），https 在隧道 Duplex
   * 上叠 node:tls.connect（servername/证书校验）后交给 node:http.request；
   * 4xx/5xx 仍返回 Response，建立/传输/断开错误映射 HelmError，绝不回退
   * local。供插件（ctx.host.nodeFetch）访问目标节点视角的 HTTP(S) 服务。
   */
  nodeFetch(nodeId: string): typeof fetch
  /**
   * 目标节点进程占用快照（删除前诊断面；非跨进程互斥）：
   * - local：Hub 进程内真实 /proc 只读扫描（零 helper spawn，不用目标 cwd
   *   启动任何子进程）；只读 cwd/fd/comm 定位信息，绝不读 cmdline/environ；
   * - 远端：经 envPathUsage RPC 在目标节点扫描，**绝不回退本机**；节点
   *   离线抛 409 node_offline，旧版守护进程无本方法抛 501
   *   path_usage_not_supported，扫描不完整时返回 complete=false（调用方
   *   必须 fail-closed，绝不当 0 占用）；
   * - 非 Linux 平台显式 not_supported（HelmError path_usage_not_supported）。
   */
  inspectPathUsage(nodeId: string, path: string, signal?: AbortSignal): Promise<NodePathUsage>
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

/**
 * RPC 边界外的节点快照严格校验（AGENTS.md 边界 schema 纪律；非法形状/
 * 与请求不相关联/自相矛盾的快照显式拒绝，绝不部分采信——节点返回其它
 * 目录的空快照不能用作本目录清理依据）。
 */
function validatePathUsageSnapshot(nodeId: string, expectedPath: string, value: unknown): NodePathUsage {
  const fail = (reason: string): HelmError =>
    new HelmError('node_path_usage_failed', `节点 ${nodeId} 返回的进程占用快照非法（${reason}），拒绝采信`, 502, {
      nodeId,
      expectedPath,
    })
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail('非对象')
  const v = value as Record<string, unknown>
  // 与请求关联：快照必须回显归一化后的目标路径（防拿错快照充当本目录依据）。
  if (v['path'] !== expectedPath) {
    throw fail(`path 与请求不符（期望 ${JSON.stringify(expectedPath)}，收到 ${JSON.stringify(String(v['path']))}）`)
  }
  if (!Array.isArray(v['processes'])) throw fail('processes 非数组')
  if (v['processes'].length > 512) throw fail('processes 超出合理上限 512')
  const processes: NodePathUsageProcess[] = []
  const seenPids = new Set<number>()
  for (const raw of v['processes']) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail('processes 条目非对象')
    const p = raw as Record<string, unknown>
    if (!Number.isSafeInteger(p['pid']) || (p['pid'] as number) <= 0) throw fail('pid 非正整数')
    if (seenPids.has(p['pid'] as number)) throw fail(`processes 含重复 PID ${p['pid']}（同进程多引用应去重）`)
    seenPids.add(p['pid'] as number)
    if (p['source'] !== 'cwd' && p['source'] !== 'fd') throw fail('source 非 cwd|fd')
    if (typeof p['path'] !== 'string' || p['path'] === '') throw fail('process path 非非空字符串')
    if (p['name'] !== undefined && typeof p['name'] !== 'string') throw fail('name 非字符串')
    processes.push({
      pid: p['pid'] as number,
      ...(p['name'] !== undefined ? { name: p['name'] as string } : {}),
      source: p['source'] as 'cwd' | 'fd',
      path: p['path'] as string,
    })
  }
  if (!Number.isSafeInteger(v['matchedTotal']) || (v['matchedTotal'] as number) < 0) throw fail('matchedTotal 非非负整数')
  const matchedTotal = v['matchedTotal'] as number
  if (typeof v['processesTruncated'] !== 'boolean') throw fail('processesTruncated 非布尔')
  const truncated = v['processesTruncated'] as boolean
  // 计数与清单自洽：总数不得小于清单数；截断意味着总数大于清单数；未截断
  // 时二者必须相等（如 truncated=true 而 matchedTotal=0 是矛盾）。
  if (matchedTotal < processes.length) throw fail(`matchedTotal(${matchedTotal}) 小于清单数(${processes.length})`)
  if (truncated && matchedTotal <= processes.length) {
    throw fail(`processesTruncated=true 但 matchedTotal(${matchedTotal}) 未超过清单数(${processes.length})`)
  }
  if (!truncated && matchedTotal !== processes.length) {
    throw fail(`未截断但 matchedTotal(${matchedTotal}) 与清单数(${processes.length})不一致`)
  }
  if (typeof v['complete'] !== 'boolean') throw fail('complete 非布尔')
  if (!Array.isArray(v['diagnostics'])) throw fail('diagnostics 非数组')
  if (v['diagnostics'].length > 128) throw fail('diagnostics 超出合理上限 128')
  if (v['diagnostics'].some((d) => typeof d !== 'string')) throw fail('diagnostics 条目非字符串')
  return {
    path: v['path'] as string,
    processes,
    matchedTotal,
    processesTruncated: truncated,
    complete: v['complete'] as boolean,
    diagnostics: v['diagnostics'] as string[],
  }
}

export function createEnvFabric(options: EnvFabricOptions): EnvFabric {
  const { envOptions, cliBinDir } = options
  const logReleaseError = options.logReleaseError ?? ((message: string) => console.error(`[helm] env fabric: ${message}`))
  // **底座按会话靶点缓存**：仅 envForTarget（带 conversationId）使用——
  // 会话生命周期有界（evictConversation 释放）。无会话靶点每次新建。
  const bases = new Map<string, ExecutionEnv>()
  const closing = new AbortController()
  const localTunnels = new Set<Duplex>()
  const registry = new NodeRegistry({
    authenticate: options.authenticate ?? (() => false),
    ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
    ...(options.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: options.heartbeatTimeoutMs }),
  })
  const hubPlatform = (): string => options.hubPlatform?.() || process.platform
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
    nodeId === 'local'
      ? new NodeExecutionEnv({ cwd })
      : new RemoteExecutionEnv(
          remoteResolver,
          {
            nodeId,
            cwd,
            ...(options.remoteRpcWaitTimeoutMs === undefined ? {} : { rpcWaitTimeoutMs: options.remoteRpcWaitTimeoutMs }),
          },
        )

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
    hubPlatform,
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
        // 升级排空拒新：节点态条件，拋稳定的 node_draining（503）——与
        // ipc_subscribe_failed（节点功能层失败）区分，不吞成普通失败。
        if (result.error.code === 'node_draining') {
          throw new HelmError(
            'node_draining',
            `节点 ${nodeId} 正在升级排空，拒绝新 IPC 订阅：${result.error.message}`,
            503,
            { nodeId },
          )
        }
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

    nodePlatformOf(nodeId: string): string | undefined {
      // local 与 Hub 同进程；测试注入的 hubPlatform 代表受控 Hub 事实。
      // 远端仅取注册登记 platform（未上报/离线 → undefined，由调用方按
      // 「平台未知」语义处理，绝不代猜）。
      if (nodeId === 'local') return hubPlatform()
      const platform = registry.get(nodeId)?.platform
      return platform === undefined || platform === '' ? undefined : platform
    },

    async openTunnel(nodeId: string, target: NodeTunnelTarget, signal?: AbortSignal): Promise<Duplex> {
      const { host, port } = normalizeTunnelTarget(target)
      if (signal?.aborted) {
        throw new HelmError('aborted', '隧道建立已取消', 499, { nodeId })
      }
      if (closing.signal.aborted) {
        throw new HelmError('node_offline', '节点隧道服务已关闭', 409, { nodeId })
      }
      // local 也必须参与关停：包括 await connect 期间尚未返回的 socket。
      if (nodeId === 'local') {
        const connectSignal = signal === undefined ? closing.signal : AbortSignal.any([signal, closing.signal])
        const duplex = await connectLocalTunnel(host ?? '127.0.0.1', port, connectSignal)
        if (closing.signal.aborted || signal?.aborted) {
          duplex.destroy()
          throw new HelmError('aborted', '隧道建立已取消', 499, { nodeId })
        }
        localTunnels.add(duplex)
        duplex.once('close', () => localTunnels.delete(duplex))
        return duplex
      }
      return await registry.openTunnel(nodeId, { ...(host === undefined ? {} : { host }), port }, signal)
    },

    nodeFetch(nodeId: string): typeof fetch {
      if (nodeId === 'local') return globalThis.fetch
      return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init)
        return tunnelFetch(
          (target, signal) => this.openTunnel(nodeId, target, signal),
          nodeId,
          request,
        ) as ReturnType<typeof fetch>
      }) as typeof fetch
    },

    async inspectPathUsage(nodeId: string, targetPath: string, signal?: AbortSignal): Promise<NodePathUsage> {
      if (signal?.aborted) throw new HelmError('aborted', '进程占用扫描已取消', 499, { nodeId })
      // 入口统一形状校验（local/远端同规则）：归一化 POSIX 绝对路径既拦非法
      // 入参，也作为快照回显关联（expectedPath）的基准。
      const normalized = validatePosixScanPath(targetPath)
      if (!normalized.ok) {
        throw new HelmError('validation_error', `进程占用扫描入参非法：${normalized.message}`, 400, { nodeId })
      }
      const expectedPath = normalized.value
      if (nodeId === 'local') {
        // Hub 进程内真实扫描（platform 经 hubPlatform 端口，测试可注入；
        // 生产为 process.platform，绝不伪造）。
        const io: PathUsageIo = {
          readlink: (p) => readlink(p),
          readdir: (p) => readdir(p),
          stat: (p) => stat(p).then((s) => ({ uid: s.uid })),
          readFile: (p) => readFile(p, 'utf8'),
          realpath: (p) => realpath(p),
        }
        const result = await scanPathUsage(expectedPath, { io, platform: hubPlatform(), signal })
        if (result.ok) return result.value
        const { code, message } = result.error
        if (code === 'invalid') throw new HelmError('validation_error', `进程占用扫描入参非法：${message}`, 400, { nodeId })
        if (code === 'permission_denied') {
          throw new HelmError(
            'node_path_usage_failed',
            `本机进程占用扫描失败（权限不足）：${message}`,
            502,
            { nodeId, code: 'permission_denied' },
          )
        }
        if (code === 'not_supported') {
          throw new HelmError(
            'path_usage_not_supported',
            `本 Hub 平台 '${hubPlatform()}' 不支持进程占用扫描（当前仅 Linux /proc；不伪造跨平台结果），无法证明目标路径 0 占用`,
            501,
            { nodeId, platform: hubPlatform() },
          )
        }
        if (code === 'aborted') throw new HelmError('aborted', message, 499, { nodeId })
        throw new HelmError('node_path_usage_failed', `本机进程占用扫描失败：${message}`, 502, { nodeId })
      }
      // 远端：目标节点真实扫描，绝不回退本机。
      const rpc = await requireRpc(nodeId, signal)
      const fn = rpc.envPathUsage
      if (fn === undefined) {
        throw new HelmError(
          'path_usage_not_supported',
          `节点 ${nodeId} 的守护进程不支持 envPathUsage（版本过旧？），无法证明目标路径 0 占用；绝不回退本机扫描`,
          501,
          { nodeId },
        )
      }
      // birpc 可能以 undefined 结算（网关吸收旧版守护进程缺方法错误）：类型上显式含 undefined。
      let result: RpcResult<import('@helm/protocol').NodePathUsage> | undefined
      try {
        result = await fn({ path: expectedPath })
      } catch (error) {
        // birpc 代理使任意方法访问都是函数：旧版守护进程缺本方法时，调用
        // 以「function not found」拒绝——如实归类为不支持（501），绝不伪装
        // 成扫描失败或回退本机；传输/超时等其他错误仍为 502。
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('[birpc] function') && message.includes('not found')) {
          throw new HelmError(
            'path_usage_not_supported',
            `节点 ${nodeId} 的守护进程不支持 envPathUsage（版本过旧？），无法证明目标路径 0 占用；绝不回退本机扫描`,
            501,
            { nodeId, cause: message },
          )
        }
        throw new HelmError(
          'node_path_usage_failed',
          `节点 ${nodeId} 进程占用扫描调用失败：${message}`,
          502,
          { nodeId, cause: message },
        )
      }
      if (result === undefined || result === null) {
        // 旧版守护进程无 envPathUsage：birpc 经网关 onGeneralError 吸收后
        // 以 undefined 结算——如实归类不支持（501），绝不回退本机、绝不当作空快照。
        throw new HelmError(
          'path_usage_not_supported',
          `节点 ${nodeId} 的守护进程不支持 envPathUsage（版本过旧？），无法证明目标路径 0 占用；绝不回退本机扫描`,
          501,
          { nodeId },
        )
      }
      // RPC 信封严格校验：ok 必须严格布尔；失败分支 error 必须携带合法
      // code/message——非法信封显式 node_path_usage_failed，绝不靠后续
      // 属性访问的 TypeError 兜底。
      const envelope = result as { ok?: unknown; value?: unknown; error?: unknown }
      if (typeof envelope.ok !== 'boolean') {
        throw new HelmError(
          'node_path_usage_failed',
          `节点 ${nodeId} 进程占用扫描返回非法信封（ok 非严格布尔，协议违反）`,
          502,
          { nodeId },
        )
      }
      if (!envelope.ok) {
        const e = envelope.error as { code?: unknown; message?: unknown } | undefined
        if (
          typeof e !== 'object' || e === null ||
          typeof e.code !== 'string' || e.code === '' ||
          typeof e.message !== 'string' || e.message === ''
        ) {
          throw new HelmError(
            'node_path_usage_failed',
            `节点 ${nodeId} 进程占用扫描返回非法错误信封（缺合法 code/message，协议违反）`,
            502,
            { nodeId },
          )
        }
        throw new HelmError(
          'node_path_usage_failed',
          `节点 ${nodeId} 进程占用扫描失败（${e.code}: ${e.message}）`,
          502,
          { nodeId, code: e.code },
        )
      }
      return validatePathUsageSnapshot(nodeId, expectedPath, envelope.value)
    },

    async withFileMutationQueue<T>(
      target: { nodeId: string; cwd: string; path: string },
      fn: () => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      // 短生命周期底座：队列在进程级 Map（key 含 env.id），不依赖实例缓存，
      // 与 tools.ts 远端分支的 envFor 实例共享同一 key 空间。
      const env = freshBase(target.nodeId, target.cwd)
      const context: Context = signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
      return envWithFileMutationQueue(env, target.path, fn, context)
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
      closing.abort()
      for (const duplex of localTunnels) duplex.destroy()
      localTunnels.clear()
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

