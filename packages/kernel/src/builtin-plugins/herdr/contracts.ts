import type { AgentGateResult, Profile } from '@helm/protocol'

/** One server, selected consistently for commands, files and event subscriptions. */
export interface HerdrTarget {
  machine?: string
  session?: string
  socketPath?: string
}

export interface HerdrCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface HerdrEvent {
  type: 'pane.created' | 'pane.updated' | 'pane.closed' | 'pane.exited'
  paneId: string
}

/** Responses are unwrapped RPC results; each consumer validates its boundary shape. */
export interface HerdrTransport {
  call(target: HerdrTarget, method: string, params: Record<string, unknown>, options?: HerdrCallOptions): Promise<unknown>
  readOutput(target: HerdrTarget, cwd: string, fileName: string, signal?: AbortSignal): Promise<string>
  removeOutput(target: HerdrTarget, cwd: string, fileName: string, signal?: AbortSignal): Promise<void>
  runGate(target: HerdrTarget, command: string, cwd: string, signal?: AbortSignal, env?: Record<string, string>): Promise<AgentGateResult>
  /** Local event subscription. Errors terminate the stream and are reported to the owner. */
  subscribe(target: HerdrTarget, onEvent: (event: HerdrEvent) => void, onError: (error: unknown) => void): Promise<() => void>
}

export interface HerdrPluginDependencies {
  defaultCwd: string
  profiles: { get(id: string): Promise<Profile | undefined> }
  /** Only explicit session/stash variables, never the whole inherited process environment. */
  buildSpawnEnv(conversationId: number, cwd: string): Record<string, string>
  redact(text: string): string
  runLocalGate(command: string, options: { cwd?: string; conversationId?: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<AgentGateResult>
  transport?: HerdrTransport
}

/**
 * 主插件 → 宿主桥（插件文件内组合，非 protocol 公共契约）：
 * - lookupProfile / listProfileIds：spawn 路由与 resume 校验（真实 Profile 服务）；
 * - getConversation：父会话 cwd 读取（错误如实上抛，不吞）；
 * - createAskResult / cancelAsk：AskDoc 宿主桥（cancel 区分真实销单成功与 404）。
 */
export interface HerdrHostBridge {
  lookupProfile(id: string): Promise<Profile | undefined>
  listProfileIds(): string[]
  getConversationCwd(id: number): string | undefined
  createAskResult(spec: CreateAskSpecLike): Promise<CreateAskResultLike>
  cancelAsk(askId: string, reason: 'cancelled' | 'superseded'): Promise<void>
}

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
    options?: Array<{ label: string; value: string }>
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
