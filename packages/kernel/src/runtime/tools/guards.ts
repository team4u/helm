/**
 * remote execute pre- guard (unify assist manually):EnvFabric missing (env_fabric_missing) and
 * node offline (node_offline) in runShell and read/write/edit/register_artifact
 * shared 6 where duplicate appear, this where consolidate is two family text proposal + guard function, guarantee never static default fall back
 * localexplicit failed semantics and text proposal single one source.
 *
 * two family text proposal has intent different (is not omission):
 * - shell family (runShell / bash / runGate): for command execute;
 * - file family (read/write/edit/register_artifact): by operation motion term (read/write/edit)
 *   to out for text proposal, and since has behavior one by one character consistent.
 */
import type { EnvFabric } from '../../env/index.js'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'

/** file tool operation motion term (guard text proposal use, and each tool since has text proposal one by one character align). */
export type FileOpAction = 'read' | 'write' | 'edit'

/** shell family:EnvFabric missing (cannot establish remote execute). */
export function shellEnvFabricMissingText(nodeId: string): string {
  return `env_fabric_missing: node ${nodeId} is remote but EnvFabric not inject (cannot establish remote execute, never fall back local machine)`
}

/** shell family: node offline or not access. */
export function shellNodeOfflineText(nodeId: string): string {
  return `node_offline: node ${nodeId} offline or not access, cannot in remote execute command (never fall back local machine execute)`
}

/**
 * runShell remote pre- guard:EnvFabric missing or node known dawn offline when return explicit failed text,
 * via return undefined.
 *
 * isOnline only is invoke when known dawn offline fast failed hint; check after to RPC between assert connect
 * behavior by RemoteExecutionEnv unify decide: wait for node reconnect (respect context cancel, see
 * env/remote-env.ts offline resilience semantics). two path semantics has intent different (before known determine
 * offline immediately errors, after in-flight resilience wait for), is not omission.
 */
export function remoteShellGuardText(envFabric: EnvFabric | undefined, nodeId: string): string | undefined {
  if (envFabric === undefined) return shellEnvFabricMissingText(nodeId)
  if (!envFabric.isOnline(nodeId)) return shellNodeOfflineText(nodeId)
  return undefined
}

/** file family:EnvFabric missing (by operation motion term). */
export function envFabricMissingFileText(nodeId: string, action: FileOpAction): string {
  return `env_fabric_missing: node ${nodeId} is remote but EnvFabric not inject (cannot${action}remote file, never fall back local machine)`
}

/** file family: node offline (by operation motion term). */
export function nodeOfflineFileText(nodeId: string, action: FileOpAction): string {
  return `node_offline: node ${nodeId} offline, cannot${action}remote file (never fall back local machine)`
}

/**
 * file tool remote pre- guard:EnvFabric missing or node offline when return explicit failed text,
 * via return undefined. never fall back local machine read write Hub disk.
 */
export function remoteFileGuardText(
  envFabric: EnvFabric | undefined,
  nodeId: string,
  action: FileOpAction,
): string | undefined {
  if (envFabric === undefined) return envFabricMissingFileText(nodeId, action)
  if (!envFabric.isOnline(nodeId)) return nodeOfflineFileText(nodeId, action)
  return undefined
}

/**
 * file tool remote guard + bottom seat get (read/write/edit/register_artifact shared use):
 * EnvFabric missing or node offline return explicit failed text, via then return the (nodeId, cwd)
 * target ExecutionEnv. never fall back local machine.
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
