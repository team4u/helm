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
  runLocalGate(command: string, options: { cwd?: string; conversationId?: number; signal?: AbortSignal }): Promise<AgentGateResult>
  transport?: HerdrTransport
}

export interface HerdrConfig {
  session: string
  socketPath: string
  startupTimeoutMs: number
}
