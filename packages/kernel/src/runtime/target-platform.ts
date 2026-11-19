/**
 * Target-node platform-aware path normalization (single entrypoint for the kernel execution chain).
 *
 * Platform source discipline (honesty invariant):
 * - Local defaults to Hub host `process.platform` (in-process, no query needed; injectable in tests);
 * - Remote nodes use only the registered platform reported to NodeRegistry (minimal read-only EnvFabric.nodePlatformOf
 *   port); when a node is offline or didn't report a platform, it stays unknown—never guessed, never falls back to
 *   Hub host platform, and never probes paths remotely;
 * - When platform is unknown, paths stay untouched (preserving shape-based syntax parsing), leaving Linux/macOS and
 *   remote POSIX behavior intact (remote POSIX nodes are never misclassified as Windows).
 *
 * Avoids duplicating path regexes: delegates syntax checks, formatting, and deterministic win32 view conversion
 * (`/mnt/<drive>`, `/<drive>`, `//server/share`) to `@helmx/protocol` primitives `normalizeTargetPath` / `targetPlatformOf`.
 * All execution entries (`runShell`, `resolveExecTarget`, `read`/`write`/`edit`) route through here with zero ad-hoc rules.
 */
import { normalizeTargetPath, targetPlatformOf, type TargetPlatform } from '@helmx/protocol'

/** Minimal platform lookup port (implemented by EnvFabric from Hub/node platform facts; stubbed in tests). */
interface NodePlatformSource {
  /** Reported remote node platform (from NodeRegistry); local does not read this port. */
  nodePlatformOf?(nodeId: string): string | undefined
  /** Hub local platform override for tests; defaults to `process.platform` in production. */
  hubPlatform?(): string | undefined
}

/** Platform lookup result: known carries parsed TargetPlatform + raw string; unknown carries explicit reason. */
type TargetPlatformInfo =
  | { known: true; platform: TargetPlatform; reported: string }
  | { known: false; reason: string }

/**
 * Resolve target node platform: local always uses process.platform; remote uses only reported registration metadata
 * (unreported / offline / missing port -> unknown; never guesses and never falls back to Hub host).
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
      reason: `node ${nodeId} platform is unknown (offline or not reported by daemon); refusing to guess or fall back to Hub host platform`,
    }
  }
  return { known: true, platform: targetPlatformOf(reported), reported }
}

/** Platform-aware path normalization result: success yields canonical path; failure preserves original path. */
type TargetPathNormalization =
  | { ok: true; path: string; platform: TargetPlatform | undefined; view: string }
  | { ok: false; code: 'invalid_path'; original: string; reason: string }

/**
 * Normalize path for target platform (unified entrypoint for cwd / absolute paths):
 * - Unknown platform: return path untouched (`view: 'unknown-platform'`);
 * - Known platform: normalizeTargetPath handles deterministic resolution—on win32 targets, converts WSL / Git Bash
 *   POSIX views to canonical Windows paths, fails explicitly on unmappable bare POSIX paths (keeping original path),
 *   and normalizes syntax on POSIX targets without changing semantics.
 */
export function normalizePathForTarget(path: string, info: TargetPlatformInfo): TargetPathNormalization {
  if (!info.known) return { ok: true, path, platform: undefined, view: 'unknown-platform' }
  const result = normalizeTargetPath(path, info.platform)
  if (result.ok) return { ok: true, path: result.path, platform: info.platform, view: result.view }
  return { ok: false, code: 'invalid_path', original: path, reason: result.reason }
}

/** Format invalid_path failure consistently (protocol reason already includes original path; callers need not append it). */
export function invalidPathText(failure: Extract<TargetPathNormalization, { ok: false }>): string {
  return `invalid_path: ${failure.reason}`
}
