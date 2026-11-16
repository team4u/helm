/**
 * tool layer sharing dependency (avoid tools.ts and runtime.ts loop reference).
 *
 * artifacts interface and real `services/artifacts.ts`  `ArtifactService` Promise signature
 * consistent (get/readContent/readBuffer all async): produce end directly pass service instance, never with sync false
 * fixture mask real service form.
 */
import type { ArtifactService } from '../services/artifacts.js'
import type { EnvFabric } from '../env/index.js'

export interface HelmToolDeps {
  dataDir: string
  defaultCwd: string
  /** by HELM_PORT generate hub URL(such as http://127.0.0.1:3202; test can inject). */
  hubUrl: string
  /** SecretStash value conversation level environment inject. */
  stashEnvFor(conversationId: number): Record<string, string>
  /** text redaction (stash plaintext -> marker; never reverse restore). */
  redact(text: string): string
  /** managed process token(getter each time read; default or dispose after do not inject HELM_TOKEN). */
  processToken?: () => string | undefined
  /** artifact service (and services.ArtifactService same signature:get/readContent/readBuffer all async). */
  artifacts: Pick<ArtifactService, 'spill' | 'get' | 'readContent' | 'readBuffer'> &
    Partial<Pick<ArtifactService, 'writeUploaded'>>
  /** across platform node execute bottom seat (remote (nodeId, cwd) target execute; default only local). */
  envFabric?: EnvFabric
  /** conversation -> bind set compute node ID(default 'local';store mirror real mapping). */
  nodeIdOf?: (conversationId: number) => string
  /** helm CLI wrap script directory (pre- inject PATH, make managed child process can directly run helm). */
  cliBinDir?: string
}

/**
 * tool abort signal check:abortSignal already abort when throw original generate Abort exception (takes precedence pass-through
 * Error type reason, otherwise construct AbortError DOMException), ensure pi-durable
 * ToolTask enter writeAtClose()/interrupt branch while do not write error result or garbage spill.
 */
export function throwIfToolAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}
