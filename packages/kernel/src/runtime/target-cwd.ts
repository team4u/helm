/**
 * Unified conversation/spawn `cwd` normalization by target node platform (sole internal kernel implementation).
 *
 * Every `cwd` entering persistence (conversation mirror / sub-conversation registration) or execution
 * (SDK agent cwd / worktree source directory / Herdr pane cwd) flows through `normalizeSessionCwd`:
 * - Relative paths (including Windows drive-relative paths like `C:rel`) are explicitly rejected by contract;
 * - When target platform is known, delegates to `@helm/protocol` `normalizeTargetPath`: on `win32`,
 *   WSL `/mnt/<drive>`, Git Bash `/<drive>`, and `//server/share` are deterministically converted into
 *   canonical Windows paths; on POSIX targets only `path.posix.normalize` is applied (never rewritten backward);
 * - When target platform is unknown (remote unregistered or not yet reported), never guesses or rewrites —
 *   passes through verbatim (absolute-path validation still applies).
 *
 * Authoritative platform source (strict honesty rule): local defaults to `process.platform` and tests may
 * inject Hub platform via `trustedPlatformFromEnvFabric`; remote uses only the authoritative platform reported
 * on `NodeRegistry` registration, never probing or inferring platform from path syntax.
 */

import { HelmError, isAbsoluteTargetPath, normalizeTargetPath, targetPlatformOf, type TargetPlatform } from '@helm/protocol'
import type { EnvFabric } from '../env/index.js'

/**
 * Authoritative node platform provider: returns the raw `platform` string reported by the node (e.g.
 * `'linux'` / `'win32'` / `'darwin'`); returns `undefined` if unknown or unreported.
 */
export type TrustedNodePlatformSource = (nodeId: string) => string | undefined

/**
 * Minimal structural shape for `EnvFabric` platform facts (structural dependency so tests can pass lightweight
 * stubs without constructing a full `NodeRegistry`). Uses `EnvFabric.nodePlatformOf` read-only port when provided
 * (sole fact exit; see `env/fabric.ts`); structural stubs with only `registry` fall back to direct registry lookup
 * with identical semantics.
 */
export interface TrustedPlatformHost {
  registry: { get(nodeId: string): { platform: string } | undefined }
  /** Optional Hub platform fact port (injectable in tests; defaults to `process.platform` in production). */
  hubPlatform?(): string | undefined
  /** Optional minimal read-only platform port (`EnvFabric.nodePlatformOf`); preferred for remote platforms. */
  nodePlatformOf?(nodeId: string): string | undefined
}

/**
 * Authoritative production source: `local` prefers `EnvFabric.hubPlatform` (test-injected) and defaults to
 * `process.platform`; remote prefers the read-only `EnvFabric.nodePlatformOf` port (`platform` reported at
 * `NodeRegistry` registration, `undefined` if unregistered/unreported); structural stubs with only `registry`
 * fall back to direct registry lookup (same semantics).
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
 * Resolve target node platform semantics: `undefined` means no authoritative info (caller must not guess).
 * Missing/empty `nodeId` is treated as `'local'`; `local` defaults to `process.platform` or an explicit
 * `trustedPlatform` Hub fact in tests; remote uses only source-reported values.
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

/** Parameters for `normalizeSessionCwd`. */
export interface NormalizeSessionCwdOptions {
  /** Target compute node (missing / empty string = `'local'`). */
  nodeId?: string
  /** Authoritative platform source (defaults to resolving `local` only). */
  trustedPlatform?: TrustedNodePlatformSource
  /** Entry point name for diagnostics (e.g. `'conversation.create'`). */
  entry: string
}

/**
 * Normalize `cwd` per resolved platform (purely lexical, zero disk access):
 * - Reject relative paths (POSIX relative, Windows drive-relative), preserving the existing absolute-path contract;
 * - `platform === undefined` (no authoritative target platform info): pass through without guessing or rewriting;
 * - Platform known: `normalizeTargetPath`; unmappable POSIX roots on `win32` targets fail explicitly
 *   (`unmappable_posix_root`, never silently persisting broken POSIX cwds).
 */
export function normalizeCwdForPlatform(cwd: string, platform: TargetPlatform | undefined, entry: string): string {
  if (!isAbsoluteTargetPath(cwd)) {
    throw new HelmError(
      'validation_error',
      `${entry}: cwd must be an absolute path (starting with / on POSIX, drive letter C:\\ or UNC \\\\server\\share on Windows; drive-relative and relative paths are rejected): received '${cwd}'`,
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
 * `cwd` consolidation (by target node platform): composes absolute validation + `resolveTargetPlatform` +
 * `normalizeCwdForPlatform` (see functions above for exact semantics).
 */
export function normalizeSessionCwd(cwd: string, options: NormalizeSessionCwdOptions): string {
  const platform = resolveTargetPlatform(options.nodeId, options.trustedPlatform)
  return normalizeCwdForPlatform(cwd, platform, options.entry)
}
