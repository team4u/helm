/**
 * Strict SemVer contract (a strict subset of the official semver.org grammar; the repo's single implementation).
 *
 * Consumers: kernel upgrade boundary validation (runtime/semver.ts, http/node-routes.ts)
 * and the helm-node self-upgrade engine (daemon/upgrader.ts) — each keeps its own error
 * envelope (HelmError / UpgradeRejectedError); parsing and precedence comparison live only here.
 *
 * Semantics: no v prefix or loose formats accepted; build metadata is grammatically allowed but,
 * per spec, does not participate in precedence comparison; prerelease precedence is
 * release > prerelease, numeric identifiers < alphanumeric identifiers, and alphabetic
 * segments compare in ASCII lexicographic order. Invalid input throws explicitly and is never
 * silently swallowed (honesty discipline).
 */

/** Official SemVer grammar (strict x.y.z[-pre][+build]; v prefix not allowed). */
const STRICT_SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** Structured parse result of a strict SemVer (build metadata does not participate in comparison per spec, so it is not kept). */
export interface StrictSemver {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly string[]
}

/** Thrown when an invalid version reaches a path that requires strict SemVer; each consumer maps it into its own error envelope. */
export class SemverFormatError extends Error {
  constructor(text: string) {
    super(`Invalid strict SemVer: "${text}" (expected x.y.z[-pre][+build]; v prefix not allowed)`)
    this.name = 'SemverFormatError'
  }
}

/** Whether the text is a strict SemVer (non-throwing variant, for "is it valid" checks). */
export function isStrictSemver(text: string): boolean {
  return STRICT_SEMVER_PATTERN.test(text)
}

/** Parse a strict SemVer; returns null on invalid input (use compareStrictSemver / SemverFormatError when explicit rejection semantics are required). */
export function parseStrictSemver(text: string): StrictSemver | null {
  const match = STRICT_SEMVER_PATTERN.exec(text)
  if (match === null) return null
  const [, major, minor, patch, prerelease] = match
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

/** Strips surrounding whitespace and a single v/V prefix (leniency for Web/UI input); does not validate the remainder. */
export function stripSemverVPrefix(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed.slice(1) : trimmed
}

/**
 * Strict SemVer precedence comparison: -1 / 0 / 1. Throws SemverFormatError if either side is
 * invalid (explicit rejection; never silently treated as equal or as 0).
 */
export function compareStrictSemver(a: string, b: string): number {
  const pa = parseStrictSemver(a)
  const pb = parseStrictSemver(b)
  if (pa === null) throw new SemverFormatError(a)
  if (pb === null) throw new SemverFormatError(b)
  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! > pb.core[i]!) return 1
    if (pa.core[i]! < pb.core[i]!) return -1
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  // No prerelease (release) > has prerelease.
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  const len = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i++) {
    const sa = pa.prerelease[i]
    const sb = pb.prerelease[i]
    if (sa === undefined) return -1
    if (sb === undefined) return 1
    if (sa === sb) continue
    const na = /^\d+$/.test(sa) ? Number(sa) : undefined
    const nb = /^\d+$/.test(sb) ? Number(sb) : undefined
    if (na !== undefined && nb !== undefined) return na > nb ? 1 : -1
    if (na !== undefined) return -1 // numeric identifiers < alphanumeric identifiers
    if (nb !== undefined) return 1
    return sa < sb ? -1 : 1 // ASCII lexicographic order, not localeCompare
  }
  return 0
}
