import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { AgentGateResult, AskFieldOption, Profile, RpcResult } from '@helm/protocol'
import type { BlockedSnapshotAnalysis } from './prompt-options.js'

/** One server, selected consistently for commands, files and event subscriptions. */
export interface HerdrTarget {
  /** 目标计算节点 ID（缺省本机；'local' 显式表示本机）。 */
  nodeId?: string
  session?: string
  socketPath?: string
}

/**
 * 目标节点 ID（'local' 折叠为 undefined = 本机；其余原样返回）。
 * 空串不折叠：入口校验（isValidNodeId）必须显式拒绝，绝不默默当本机。
 */
export function targetNodeId(target: HerdrTarget | undefined): string | undefined {
  const id = target?.nodeId
  return id === undefined || id === 'local' ? undefined : id
}

/**
 * 跨节点通道：由内核 EnvFabric 公共端口（nodeIpc / executionEnv）或测试
 * fixture 提供，transport 借它在目标节点连接当地 Herdr IPC、读写交接文件
 * 并执行 Gate（彻底取代 ssh + python3 脚本）。
 *
 * 端点语义（远端节点自解析，绝不携带 Hub 本机的平台/目录）：
 * - `endpoint` 仅在 target 显式给出 socketPath 时传递（可缺省）；
 * - `session` 传递显式会话名（可缺省）；
 * - 目标节点自己解析 HERDR_SOCKET_PATH / 平台配置目录与端点形态（UDS 或
 *   Named Pipe），Hub 侧绝不把本机 resolveSocketPath 或 endpointKind 强加给远端。
 *
 * 取消语义：所有方法接受普通 AbortSignal（与宿主公共端口同形），transport
 * 内部文件/命令操作仍用 SDK Context 派生（见 HerdrNodeEnv）。
 */
export interface HerdrNodeChannel {
  /** 节点是否在线（'local' 恒为 true）。 */
  isOnline(nodeId: string): boolean
  /** 获取节点注册的可达 Hub URL（若有，供远端窗格自动注入 HELM_HUB_URL）。 */
  getNodeHubUrl?(nodeId: string): string | undefined
  /**
   * 节点可信平台上报（NodeRegistry 注册事实，如 'linux' / 'win32'；
   * 未上报 / 不可达返回 undefined）：resolveCwd 按目标节点平台做 cwd
   * 规范化用。缺席时远端平台视为未知（不猜、不改写）。
   */
  nodePlatform?(nodeId: string): string | undefined
  /** 在目标节点执行本机 Herdr 单次行协议 IPC 请求（支持 signal 取消，取消时立即中断底层连接）。 */
  ipcCall(
    nodeId: string,
    input: { endpoint?: string; session?: string; line: string; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<RpcResult<string>>
  /** 在目标节点获取文件与命令执行环境。 */
  envFor(nodeId: string, cwd: string): HerdrNodeEnv
  /**
   * 可选：远端节点 IPC 事件流订阅。
   * Promise 成功 resolve 即代表订阅请求已被目标节点确认（ACK 在通道层消费
   * 并验证）；此后 onLine 只推送裸事件帧，绝不二次伪造 ACK。
   */
  ipcSubscribe?(
    nodeId: string,
    input: { endpoint?: string; session?: string; line: string },
    onLine: (line: string) => void,
    onClosed: (error?: string) => void,
    signal?: AbortSignal,
  ): Promise<() => void>
}

/**
 * `HerdrNodeChannel.envFor` 的环境契约：SDK `ExecutionEnv` 核心子集的 Pick。
 * NodeExecutionEnv / 宿主 executionEnv 端口结构可赋值（无 as 掩盖）。
 */
export type HerdrNodeEnv = Pick<
  ExecutionEnv,
  'canonicalPath' | 'fileInfo' | 'readTextFile' | 'remove' | 'exec'
>

export interface HerdrCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export type HerdrEvent =
  | {
      type:
        | 'pane.created'
        | 'pane.updated'
        | 'pane.closed'
        | 'pane.exited'
        | 'pane.focused'
        | 'pane.moved'
        | 'pane.agent_status_changed'
      paneId: string
    }
  | { type: 'tab.closed'; tabId: string; workspaceId: string; paneId?: never }
  | { type: 'workspace.closed'; workspaceId: string; paneId?: never }

/** 订阅选项：paneIds 为每个窗格追加 pane.agent_status_changed 过滤订阅；signal 取消整个订阅。 */
export interface HerdrSubscribeOptions {
  paneIds?: string[]
  signal?: AbortSignal
}

/** Responses are unwrapped RPC results; each consumer validates its boundary shape. */
export interface HerdrTransport {
  call(target: HerdrTarget, method: string, params: Record<string, unknown>, options?: HerdrCallOptions): Promise<unknown>
  readOutput(target: HerdrTarget, cwd: string, fileName: string, signal?: AbortSignal): Promise<string>
  removeOutput(target: HerdrTarget, cwd: string, fileName: string, signal?: AbortSignal): Promise<void>
  runGate(target: HerdrTarget, command: string, cwd: string, signal?: AbortSignal, env?: Record<string, string>): Promise<AgentGateResult>
  /** Local event subscription. Errors terminate the stream and are reported to the owner. */
  subscribe(
    target: HerdrTarget,
    onEvent: (event: HerdrEvent) => void,
    onError: (error: unknown) => void,
    options?: HerdrSubscribeOptions,
  ): Promise<() => void>
}

export interface HerdrPluginDependencies {
  profiles: { get(id: string): Promise<Profile | undefined> }
  /**
   * 外部 spawn 环境变量：目标节点受管回连集合（stash + 受管 HELM_*）。
   * nodeId 为实际选定的目标节点（'local' 显式表示本机；绝不传 undefined 让
   * 内核按父会话继承——父会话绑定远端时会把本机窗格误配到远端）。
   * 仅显式 session/stash 变量，绝不携带整个继承的 process 环境。
   */
  buildSpawnEnv(conversationId: number, cwd: string, nodeId: string): Record<string, string>
  redact(text: string): string
  runLocalGate(command: string, options: { cwd?: string; conversationId?: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<AgentGateResult>
  /** 附件产物元数据解析（含授权校验；不存在/越权抛 HelmError）。可选注入。 */
  getArtifact?: (
    id: string,
    conversationId: number,
  ) => Promise<{ id: string; name: string; mimeType: string; size: number; absPath: string }>
  /** 跨节点通道（EnvFabric 注入；缺省时远端目标显式报错，绝不静默回退本机）。 */
  nodeChannel?: HerdrNodeChannel
  transport?: HerdrTransport
  /** 同 seq blocked 退避基数与上限（测试可缩短；缺省 500ms / 4000ms）。 */
  blockedBackoffBaseMs?: number
  blockedBackoffCapMs?: number
  /** 审批轮询间隔（测试可缩短；缺省 100ms）。 */
  pollIntervalMs?: number
  /**
   * 可选：当确定性正则未从阻塞快照中识别出标准菜单时，调用会话模型解析
   * 脱敏终端快照并提取候选按键选项。返回 analysis 为 undefined 时附
   * diagnostic（脱敏短诊断，仅用于通知/description，不含快照与响应原文）；
   * 外部 signal 取消时以原始错误 reject（立即传播，不回退）。
   */
  analyzeBlockedSnapshot?: (input: {
    snapshot: string
    conversationId: number
    signal?: AbortSignal
  }) => Promise<{ analysis: BlockedSnapshotAnalysis | undefined; diagnostic?: string }>
}

export type { BlockedSnapshotAiOption, BlockedSnapshotAnalysis } from './prompt-options.js'

/** ctx.host.createAsk 的最小形状（与 AskCreateSpec/AskResult 对齐）。 */
export interface CreateAskSpecLike {
  id?: string
  conversationId: number
  ownerPluginId: string
  title: string
  description?: string
  fields: Array<{
    name: string
    label: string
    type: 'text' | 'select' | 'confirm'
    options?: Array<AskFieldOption>
    required?: boolean
  }>
  expectedStateSeq?: number
}

export interface CreateAskResultLike {
  id: string
  status: 'answered' | 'cancelled' | 'superseded'
  answers: Record<string, string>
}

export interface HerdrConfig {
  session: string
  socketPath: string
  startupTimeoutMs: number
}
