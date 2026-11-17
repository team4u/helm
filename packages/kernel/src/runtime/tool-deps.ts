/**
 * Shared dependencies for the tool layer (avoids circular imports between `tools.ts` and `runtime.ts`).
 *
 * The `artifacts` interface matches the real `ArtifactService` Promise signatures in `services/artifacts.ts`
 * (`get`/`readContent`/`readBuffer` are all async): production passes the live service directly without wrapping
 * it in a synchronous fake shim.
 */
import type { ArtifactService } from '../services/artifacts.js'
import type { EnvFabric } from '../env/index.js'

export interface HelmToolDeps {
  dataDir: string
  defaultCwd: string
  /** Hub URL derived from `HELM_PORT` (e.g. `http://127.0.0.1:3202`; injectable for tests). */
  hubUrl: string
  /** Inject conversation-scoped `SecretStash` environment variables. */
  stashEnvFor(conversationId: number): Record<string, string>
  /** Text redaction (stash plaintext -> marker; one-way only). */
  redact(text: string): string
  /** Managed process token (read on each call via getter; omits `HELM_TOKEN` if unset or disposed). */
  processToken?: () => string | undefined
  /** Artifact service (matches `services.ArtifactService`: async `get`/`readContent`/`readBuffer`). */
  artifacts: Pick<ArtifactService, 'spill' | 'get' | 'readContent' | 'readBuffer'> &
    Partial<Pick<ArtifactService, 'writeUploaded'>>
  /** Cross-platform node execution substrate (targets remote `(nodeId, cwd)`; defaults to local only). */
  envFabric?: EnvFabric
  /** `conversationId ->` bound compute node ID (defaults to `'local'`; backed by authoritative store snapshot). */
  nodeIdOf?: (conversationId: number) => string
  /** Directory containing `helm` CLI wrapper scripts (prepended to `PATH` so managed children can run `helm`). */
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
