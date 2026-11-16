/**
 * target path term method parse (read/write/edit/register_artifact shared use).
 *
 * across platform path shape: target path one rule by its itself shape (POSIX absolute / Windows symbol absolute /
 * UNC) choose use pure posix/win32 rule do term method parse, never use Hub host node:path by default
 * rule parse remote path (Linux Hub on resolve('C:\\workspace') will obtain to error result,
 * Windows/mac/Linux across platform promise i.e. do not into establish); symbol relative path (C:relative) semantics
 * dependency process when before directory, one rule explicit reject.
 *
 * shape decide and term method rule sub- collection (normalize/join/dirname/basename) already consolidate
 * @helm/protocol(browser security pure function, kernel and @helm/plugins sharing); dependency
 * node:path complete implement resolve semantics (process cwd / large small write rule) in kernel
 * (Node environment);isAbsoluteTargetPath/targetPathShape by tools.ts again export
 * supply since has relative path reference keep stable.
 */
import { isAbsoluteTargetPath, normalizeTargetPath, targetPathShape, type TargetPlatform } from '@helm/protocol'
import { posix, win32 } from 'node:path'

/** Windows symbol (does not distinguish large small write):C: / c: etc.. */
const WINDOWS_DRIVE = /^[A-Za-z]:/
/** Windows symbol each other for (C:relative / bare C:): semantics dependency process when before directory, target execute reject. */
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:($|[^\\/])/

/**
 * by shape choose node:path complete rule (kernel Node environment dedicated use:resolve/relative etc.
 * semantics dependency Node implement; term method sub- collection see @helm/protocol pathRulesForShape).
 */
export function nodePathForShape(shape: 'posix' | 'win32' | undefined): typeof posix | typeof win32 {
  return shape === 'win32' ? win32 : posix
}

/**
 * by target shape parse absolute path:base(conversation cwd) only act relative path base allow, absolute path and
 * ../ across directory all legal; symbol relative path (C:relative / bare C:) one rule reject (dependency process
 * cwd, semantics cannot pre- test).
 *
 * platform === 'win32'(target node platform known is Windows):base and absolute raw first via
 * protocol normalizeTargetPath do determinism specification (WSL /mnt/<symbol>,Git Bash
 * /<symbol>,//server/share POSIX view rotate specification Windows path; cannot mapping bare
 * POSIX explicit reject and keep original path), again by win32 rule parse each other for segment.platform
 * default (remote platform unknown): along use by shape choose rule since has semantics (do not guess platform),
 * Linux/macOS and remote POSIX semantics do not change.
 */
export function resolveTargetPath(
  raw: string,
  base: string,
  platform?: TargetPlatform,
): { ok: true; abs: string } | { ok: false; reason: string } {
  if (WINDOWS_DRIVE.test(raw) && WINDOWS_DRIVE_RELATIVE.test(raw)) {
    return { ok: false, reason: `symbol relative path dependency process when before directory, reject:${raw}` }
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
