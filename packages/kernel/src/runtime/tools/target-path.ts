/**
 * Target path lexical resolution (shared by `read`/`write`/`edit`/`register_artifact`).
 *
 * Cross-platform path handling: picks pure `posix` or `win32` lexical rules based on target path shape
 * (POSIX absolute / Windows drive-letter absolute / UNC), never letting the Hub host's `node:path` default
 * misparse remote paths (resolving `'C:\\workspace'` on a Linux Hub produces corrupt paths, breaking
 * cross-platform Windows/macOS/Linux invariants); Windows drive-relative paths (`C:rel`) depend on
 * process-current directory and are always rejected explicitly.
 *
 * Shape detection and browser-safe path rules (`normalize`/`join`/`dirname`/`basename`) live in
 * `@helmx/protocol`; full `node:path` `resolve` semantics (requiring Node) live here;
 * `isAbsoluteTargetPath`/`targetPathShape` are re-exported by `tools.ts` for existing relative imports.
 */
import { isAbsoluteTargetPath, normalizeTargetPath, targetPathShape, type TargetPlatform } from '@helmx/protocol'
import { posix, win32 } from 'node:path'

/** Windows drive prefix (case-insensitive): `C:` / `c:`, etc. */
const WINDOWS_DRIVE = /^[A-Za-z]:/
/** Windows drive-relative path (`C:rel` or bare `C:`): depends on per-drive process cwd and is rejected on target. */
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:($|[^\\/])/

/**
 * Pick the full `node:path` rule set matching a path shape (kernel Node-only usage where `resolve`/`relative`
 * depend on Node implementations; lexical subset lives in `@helmx/protocol` `pathRulesForShape`).
 */
export function nodePathForShape(shape: 'posix' | 'win32' | undefined): typeof posix | typeof win32 {
  return shape === 'win32' ? win32 : posix
}

/**
 * Resolve an absolute target path per target shape: `base` (conversation `cwd`) serves solely as the base for
 * relative paths; absolute paths and `../` traversals are valid; Windows drive-relative paths (`C:rel` / bare `C:`)
 * are always rejected (since process cwd semantics cannot be pre-verified).
 *
 * When `platform === 'win32'` (known Windows target): normalizes `base` and absolute `raw` deterministically via
 * `@helmx/protocol` `normalizeTargetPath` (converting WSL `/mnt/<drive>`, Git Bash `/<drive>`, and `//server/share`
 * into canonical Windows paths; explicitly rejects unmappable bare POSIX roots while preserving original strings),
 * then resolves relative segments with `win32` rules. When `platform` is omitted (unknown remote platform), keeps
 * existing shape-based behavior without guessing (Linux/macOS and POSIX semantics remain unchanged).
 */
export function resolveTargetPath(
  raw: string,
  base: string,
  platform?: TargetPlatform,
): { ok: true; abs: string } | { ok: false; reason: string } {
  if (WINDOWS_DRIVE.test(raw) && WINDOWS_DRIVE_RELATIVE.test(raw)) {
    return { ok: false, reason: `Drive-relative path depends on per-process cwd and is rejected: ${raw}` }
  }
  if (platform === 'win32') {
    const baseN = normalizeTargetPath(base, 'win32')
    if (!baseN.ok) return { ok: false, reason: baseN.reason }
    const rawN = isAbsoluteTargetPath(raw) ? normalizeTargetPath(raw, 'win32') : undefined
    if (rawN !== undefined && !rawN.ok) return { ok: false, reason: rawN.reason }
    return { ok: true, abs: win32.resolve(baseN.path, rawN !== undefined ? rawN.path : raw) }
  }
  const shape = targetPathShape(raw) ?? targetPathShape(base)
  const rules = nodePathForShape(shape)
  return { ok: true, abs: rules.resolve(base, raw) }
}

/**
 * Strict lexical containment: `target` must be a child of `root` (never the root itself; case-insensitive on
 * win32 shapes). Single source for both the Web workspace file boundary (`workspace-files.ts`) and the
 * `Profile.restrictToCwd` guardrail — purely lexical by design (symlinks are the user's filesystem reality,
 * same privilege boundary as bash; canonical containment would need per-node `realpath` probes).
 */
export function isStrictlyInsideRoot(
  target: string,
  root: string,
  shape: 'posix' | 'win32' | undefined,
): boolean {
  const isWin = shape === 'win32'
  const t = isWin ? target.toLowerCase() : target
  const r = isWin ? root.toLowerCase() : root
  if (t === r) return false
  const sep = isWin ? '\\' : '/'
  if (r.endsWith(sep)) {
    return t.startsWith(r) && t.length > r.length
  }
  return t.startsWith(r + sep)
}
