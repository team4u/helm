/**
 * target node platform aware path specification (kernel execute chain unique entry).
 *
 * platform source discipline (honest hard rule):
 * - local by default Hub host process.platform(same process, no need to query), test can inject
 *   Hub platform fact;
 * - remote only take NodeRegistry register register platform (EnvFabric.nodePlatformOf most small
 *   only read port); node offline or daemon not on report platform when platform unknown - - never guess,
 *   never fallback Hub host platform, never access probe choose path;
 * - platform unknown when path keep original (along use since has by shape term method parse semantics),Linux/macOS
 *   and remote POSIX semantics do not change (remote POSIX node never by mistakenly judge into Windows).
 *
 * this module do not duplicate path regex: shape decide, term method rule and win32 target on determinism view
 * convert (/mnt/<symbol>,/<symbol>,//server/share) all re- use @helm/protocol 
 * normalizeTargetPath / targetPlatformOf original language; business entry (runShell /
 * resolveExecTarget / read/write/edit) one rule via this module, must not each another write rule.
 */
import { normalizeTargetPath, targetPlatformOf, type TargetPlatform } from '@helm/protocol'

/** platform read most small port (EnvFabric  Hub/node platform fact shape; test can inject replace body). */
export interface NodePlatformSource {
  /** remote node platform fact (NodeRegistry on report);local do not from this port guess. */
  nodePlatformOf?(nodeId: string): string | undefined
  /** Hub local machine platform fact; test can inject, produce default fall back process.platform. */
  hubPlatform?(): string | undefined
}

/** target platform parse result:known carry platform semantics and original on report value;unknown carry explicit reason. */
export type TargetPlatformInfo =
  | { known: true; platform: TargetPlatform; reported: string }
  | { known: false; reason: string }

/**
 * parse target node platform:local constant process.platform; remote only take register register value
 * (not on report / offline / port missing → unknown, never guess, never fallback Hub host).
 */
export function targetPlatformForNode(
  source: NodePlatformSource | undefined,
  nodeId: string,
): TargetPlatformInfo {
  if (nodeId === 'local') {
    const reported = source?.hubPlatform?.() || process.platform
    return { known: true, platform: targetPlatformOf(reported), reported }
  }
  const reported = source?.nodePlatformOf?.(nodeId)
  if (reported === undefined || reported === '') {
    return {
      known: false,
      reason: `node ${nodeId} platform information unknown (offline or daemon not on report), do not guess platform, does not fall back Hub host platform`,
    }
  }
  return { known: true, platform: targetPlatformOf(reported), reported }
}

/** platform aware path specification result: succeeded carry canonical path; failed keep original path (original). */
export type TargetPathNormalization =
  | { ok: true; path: string; platform: TargetPlatform | undefined; view: string }
  | { ok: false; code: 'invalid_path'; original: string; reason: string }

/**
 * by target platform specification path (cwd / absolute path unify entry):
 * - platform unknown: path original return (do not guess platform,view 'unknown-platform');
 * - platform known:normalizeTargetPath determinism specification - -win32 target on WSL /
 *   Git Bash  POSIX view convert is specification Windows path, cannot mapping bare POSIX
 *   explicit failed and keep original path;posix target only term method archive one (semantics do not change).
 */
export function normalizePathForTarget(path: string, info: TargetPlatformInfo): TargetPathNormalization {
  if (!info.known) return { ok: true, path, platform: undefined, view: 'unknown-platform' }
  const result = normalizeTargetPath(path, info.platform)
  if (result.ok) return { ok: true, path: result.path, platform: info.platform, view: result.view }
  return { ok: false, code: 'invalid_path', original: path, reason: result.reason }
}

/** invalid_path failed unify can read information (protocol reason already contains original path; each entry must not another piece together). */
export function invalidPathText(failure: Extract<TargetPathNormalization, { ok: false }>): string {
  return `invalid_path: ${failure.reason}`
}
