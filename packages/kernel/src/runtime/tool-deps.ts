/**
 * Shared dependencies for the tool layer (avoids circular imports between `tools.ts` and `runtime.ts`).
 *
 * The `artifacts` interface matches the real `ArtifactService` Promise signatures in `services/artifacts.ts`
 * (`get`/`readContent`/`readBuffer` are all async): production passes the live service directly without wrapping
 * it in a synchronous fake shim.
 */
import type { ArtifactService } from '../services/artifacts.js'
import type { EnvFabric } from '../env/index.js'

export interface HelmxToolDeps {
  dataDir: string
  defaultCwd: string
  /** Hub URL derived from `HELMX_PORT` (e.g. `http://127.0.0.1:3202`; injectable for tests). */
  hubUrl: string
  /** Inject conversation-scoped `SecretStash` environment variables. */
  stashEnvFor(conversationId: number): Record<string, string>
  /** Text redaction (stash plaintext -> marker; one-way only). */
  redact(text: string): string
  /** Managed process token (read on each call via getter; omits `HELMX_TOKEN` if unset or disposed). */
  processToken?: () => string | undefined
  /** Artifact service (matches `services.ArtifactService`: async `get`/`readContent`/`readBuffer`). */
  artifacts: Pick<ArtifactService, 'spill' | 'get' | 'readContent' | 'readBuffer'> &
    Partial<Pick<ArtifactService, 'writeUploaded'>>
  /** Cross-platform node execution substrate (targets remote `(nodeId, cwd)`; defaults to local only). */
  envFabric?: EnvFabric
  /** `conversationId ->` bound compute node ID (defaults to `'local'`; backed by authoritative store snapshot). */
  nodeIdOf?: (conversationId: number) => string
  /**
   * `conversationId ->` whether its Profile sets `restrictToCwd` (guardrail: file tools confined to the
   * conversation cwd). Resolved live per call so profile edits take effect immediately; read failures
   * propagate explicitly (a corrupt profile.json already breaks the turn's persona injection).
   */
  restrictToCwdOf?: (conversationId: number) => Promise<boolean>
  /** Directory containing `helmx` CLI wrapper scripts (prepended to `PATH` so managed children can run `helmx`). */
  cliBinDir?: string
}

/**
 * Tool abort signal guard: throws the native abort exception when `abortSignal` is aborted (prefers an `Error`
 * `reason`, otherwise constructs a DOMException `'AbortError'`), ensuring pi-durable `ToolTask` takes the
 * `writeAtClose()`/interrupted branch without persisting error results or garbage spills.
 */
export function throwIfToolAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}
