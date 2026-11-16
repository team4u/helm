/**
 * conversation / spawn cwd by target node platform unify specification consolidate (kernel inside unique implement).
 *
 * all enter persist (conversation mirror / sub-conversation register) or execute environment (SDK agent cwd /
 * worktree source directory / Herdr pane cwd) cwd, all via normalizeSessionCwd:
 * - relative path (contains Windows symbol each other for C:relative) explicit reject (since has contract);
 * - platform known: re- use @helm/protocol normalizeTargetPath(win32 target on
 *   WSL /mnt/<symbol>,Git Bash /<symbol>,//server/share view determinism convert is
 *   specification Windows path;POSIX target only term method archive one, never reverse change write);
 * - target node platform without can message information (remote not registered / not on report): do not guess, do not change write, original
 *   pass-through (absolute validate still takes effect).
 *
 * platform fact source (honest hard rule):local by default use process.platform, test can via
 * trustedPlatformFromEnvFabric inject Hub platform; remote only use NodeRegistry register when
 * on report can message platform, never probe, never use path shape upside down push target platform.
 */

import { HelmError, isAbsoluteTargetPath, normalizeTargetPath, targetPlatformOf, type TargetPlatform } from '@helm/protocol'
import type { EnvFabric } from '../env/index.js'

/**
 * can message node platform source: return node on report original platform string (such as 'linux' /
 * 'win32' / 'darwin');unknown / not on report return undefined.
 */
export type TrustedNodePlatformSource = (nodeId: string) => string | undefined

/**
 * EnvFabric platform fact most small structure (structure dependency: test can inject light amount stub,
 * no need to construct complete NodeRegistry). produce EnvFabric provide nodePlatformOf only read
 * port when takes precedence use (unique fact exit, see env/fabric.ts); only has registry 
 * structure stub retreat back direct read register table, semantics and port consistent.
 */
export interface TrustedPlatformHost {
  registry: { get(nodeId: string): { platform: string } | undefined }
  /** optional Hub platform fact port (test can inject, produce default fall back process.platform). */
  hubPlatform?(): string | undefined
  /** optional most small only read platform port (EnvFabric.nodePlatformOf); remote platform takes precedence use. */
  nodePlatformOf?(nodeId: string): string | undefined
}

/**
 * produce can message source:local takes precedence EnvFabric.hubPlatform(test inject), default fall back
 * process.platform; remote takes precedence EnvFabric.nodePlatformOf only read port (NodeRegistry
 * register on report platform, not registered / not on report = undefined); only has registry structure
 * stub retreat back direct read register table (the same semantics).
 */
export function trustedPlatformFromEnvFabric(
  envFabric: EnvFabric | TrustedPlatformHost | undefined,
): TrustedNodePlatformSource {
  return (nodeId) => {
    if (nodeId === 'local') {
      return envFabric?.hubPlatform?.() || envFabric?.nodePlatformOf?.('local') || process.platform
    }
    if (envFabric?.nodePlatformOf !== undefined) return envFabric.nodePlatformOf(nodeId)
    return envFabric?.registry.get(nodeId)?.platform || undefined
  }
}

/**
 * parse target node platform semantics:undefined means without can message information (caller must not guess).
 * nodeId default / empty string treated as 'local';local by default use process.platform, explicit
 * trustedPlatform source can provide test use Hub platform fact; remote only used to source on report.
 */
export function resolveTargetPlatform(
  nodeId: string | undefined,
  source?: TrustedNodePlatformSource,
): TargetPlatform | undefined {
  const id = nodeId === undefined || nodeId === '' ? 'local' : nodeId
  if (id === 'local') {
    const raw = source?.(id) || process.platform
    return targetPlatformOf(raw)
  }
  const raw = source?.(id)
  return raw !== undefined && raw !== '' ? targetPlatformOf(raw) : undefined
}

/** normalizeSessionCwd reference. */
export interface NormalizeSessionCwdOptions {
  /** target compute node (default / empty string = 'local'). */
  nodeId?: string
  /** can message platform source (default only local can parse). */
  trustedPlatform?: TrustedNodePlatformSource
  /** diagnose use entry name (such as 'conversation.create'). */
  entry: string
}

/**
 * by already parse platform specification cwd(pure term method, zero disk access):
 * - reject relative path (POSIX each other for,Windows symbol each other for), keep since has absolute path contract;
 * - platform undefined(target platform without can message information): pass-through, do not guess do not change write;
 * - platform known:normalizeTargetPath;win32 target on cannot mapping POSIX explicit
 *   failed (unmappable_posix_root, never static default written to the database broken POSIX cwd).
 */
export function normalizeCwdForPlatform(cwd: string, platform: TargetPlatform | undefined, entry: string): string {
  if (!isAbsoluteTargetPath(cwd)) {
    throw new HelmError(
      'validation_error',
      `${entry}: cwd must be absolute path (POSIX / open head,Windows symbol C:\\ or UNC \\\\server\\share; reject symbol each other for and relative path): receives '${cwd}'`,
      400,
      { cwd, entry },
    )
  }
  if (platform === undefined) return cwd
  const result = normalizeTargetPath(cwd, platform)
  if (!result.ok) {
    throw new HelmError(result.code, `${entry}: ${result.reason}`, 400, { cwd, entry })
  }
  return result.path
}

/**
 * cwd consolidate (by target node platform): absolute validate + resolveTargetPlatform +
 * normalizeCwdForPlatform combine (semantics see on way each function).
 */
export function normalizeSessionCwd(cwd: string, options: NormalizeSessionCwdOptions): string {
  const platform = resolveTargetPlatform(options.nodeId, options.trustedPlatform)
  return normalizeCwdForPlatform(cwd, platform, options.entry)
}
