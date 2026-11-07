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
  defaultCwd: string
  profiles: { get(id: string): Promise<Profile | undefined> }
  /** Only explicit session/stash variables, never the whole inherited process environment. */
  buildSpawnEnv(conversationId: number, cwd: string): Record<string, string>
  redact(text: string): string
  runLocalGate(command: string, options: { cwd?: string; conversationId?: number; signal?: AbortSignal; env?: Record<string, string> }): Promise<AgentGateResult>
  transport?: HerdrTransport
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
