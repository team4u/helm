/**
 * Pre-flight guards for remote execution (unified helpers): `env_fabric_missing` and `node_offline` were
 * duplicated across 6 sites in `runShell` and `read`/`write`/`edit`/`register_artifact`. Consolidated here into
 * two message families + guard helpers so explicit failures (never falling back silently to local) share one source.
 *
 * Both message families differ intentionally:
 * - Shell family (`runShell` / `bash` / `runGate`): command execution wording;
 * - File family (`read`/`write`/`edit`/`register_artifact`): action-parameterized (`read`/`write`/`edit`)
 *   preserving exact character-for-character legacy phrasing expectations.
 */
import type { EnvFabric } from '../../env/index.js'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'

/** File tool action verb (used in guard messages for consistency across file tools). */
export type FileOpAction = 'read' | 'write' | 'edit'

/** Shell family: `EnvFabric` missing (cannot establish remote execution). */
export function shellEnvFabricMissingText(nodeId: string): string {
  return `env_fabric_missing: node '${nodeId}' is remote but EnvFabric is not configured (cannot establish remote execution; refusing to fall back to local)`
}

/** Shell family: node offline or unreachable. */
function shellNodeOfflineText(nodeId: string): string {
  return `node_offline: node '${nodeId}' is offline or unreachable; cannot run command remotely (refusing to fall back to local)`
}

/**
 * Remote pre-guard for `runShell`: returns an explicit error message if `EnvFabric` is missing or the node is
 * known offline at invocation time; returns `undefined` to proceed.
 *
 * `isOnline` fails fast only when the node is already known offline; post-check in-flight connection drops during
 * RPC are governed by `RemoteExecutionEnv` (awaits reconnection while honoring context cancellation — see
 * `env/remote-env.ts` offline resilience semantics). These two paths intentionally differ.
 */
export function remoteShellGuardText(envFabric: EnvFabric | undefined, nodeId: string): string | undefined {
  if (envFabric === undefined) return shellEnvFabricMissingText(nodeId)
  if (!envFabric.isOnline(nodeId)) return shellNodeOfflineText(nodeId)
  return undefined
}

/** File family: `EnvFabric` missing (parameterized by action verb). */
function envFabricMissingFileText(nodeId: string, action: FileOpAction): string {
  return `env_fabric_missing: node '${nodeId}' is remote but EnvFabric is not configured (cannot ${action} remote file; refusing to fall back to local)`
}

/** File family: node offline (parameterized by action verb). */
function nodeOfflineFileText(nodeId: string, action: FileOpAction): string {
  return `node_offline: node '${nodeId}' is offline; cannot ${action} remote file (refusing to fall back to local)`
}

/**
 * Remote pre-guard for file tools: returns an explicit error message when `EnvFabric` is missing or the node is
 * offline; returns `undefined` to proceed. Never silently falls back to Hub's local disk.
 */
function remoteFileGuardText(
  envFabric: EnvFabric | undefined,
  nodeId: string,
  action: FileOpAction,
): string | undefined {
  if (envFabric === undefined) return envFabricMissingFileText(nodeId, action)
  if (!envFabric.isOnline(nodeId)) return nodeOfflineFileText(nodeId, action)
  return undefined
}

/**
 * Combined remote guard + substrate lookup (shared by `read`/`write`/`edit`/`register_artifact`):
 * returns explicit error text if `EnvFabric` is missing or the node is offline, else returns the `(nodeId, base)`
 * `ExecutionEnv`. Never silently falls back to local.
 */
export function requireRemoteEnv(
  envFabric: EnvFabric | undefined,
  nodeId: string,
  base: string,
  action: FileOpAction,
): { error: string } | { env: ExecutionEnv } {
  const guard = remoteFileGuardText(envFabric, nodeId, action)
  if (guard !== undefined) return { error: guard }
  return { env: envFabric!.envFor(nodeId, base) }
}
