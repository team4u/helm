/**
 * Cross-platform target-path shape detection and a lexical rule subset (the single
 * implementation shared by kernel and plugins; browser-safe pure functions).
 *
 * The target node may run a different platform than the Hub, so path shape is
 * judged by the path's own form — never by the host's node:path rules. This
 * module must not depend on Node builtins (protocol is bundled from source by
 * the Web side).
 *
 * Also provides normalizeTargetPath: deterministic normalization for the target
 * platform — on win32 targets it converts POSIX views of WSL / Git Bash
 * (/mnt/<drive>, /<drive>, //server/share) into canonical Windows paths, and
 * POSIX roots without a drive correspondence fail explicitly in a structured way
 * (zero probing, zero guessing); non-win32 targets keep POSIX semantics.
 */

/**
 * Target path shape (judged by the path's own form, independent of the Hub host
 * platform):
 * - 'posix': a POSIX absolute path starting with /;
 * - 'win32': Windows drive-absolute (C:\x / C:/x) or UNC / root backslash (\\server\share);
 * - undefined: a relative path (follows the shape of the conversation cwd target).
 */
export function targetPathShape(p: string): 'posix' | 'win32' | undefined {
  if (p.startsWith('/')) return 'posix'
  if (p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)) return 'win32'
  return undefined
}

/** Whether the target path is absolute (POSIX leading /, Windows drive-absolute, or UNC / root backslash). */
export function isAbsoluteTargetPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)
}

// ---------------------------------------------------------------------------
// Target-path lexical rules (a pure-function subset selected by shape)
// ---------------------------------------------------------------------------

const FORWARD_SLASH = 47
const BACKWARD_SLASH = 92
const COLON = 58

const isWinSeparator = (code: number): boolean => code === FORWARD_SLASH || code === BACKWARD_SLASH
const isDriveLetter = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) // A-Z / a-z

/**
 * Target-path lexical rule subset: normalize / join / dirname / basename.
 *
 * Semantics align with node:path's posix / win32 functions of the same name
 * (trailing separators preserved, dirname does not resolve '..', win32
 * double-separator and device-root (drive / UNC) behaviors match), but
 * implemented as browser-safe pure functions — this package is bundled from
 * source by the Web side, so Node builtins are forbidden. Semantics that depend
 * on the process cwd / case rules (resolve / relative etc.) are outside this
 * subset and stay in the kernel (Node environment). Kernel tests verify
 * case-by-case alignment with node:path as the oracle.
 */
export interface TargetPathRules {
  /** Lexical normalization: collapse repeated separators, resolve '.' and '..' segments (a single trailing separator is preserved). */
  normalize(p: string): string
  /** Join multiple parts then normalize (empty parts ignored; all-empty returns '.'). */
  join(...parts: string[]): string
  /** Cut to before the last path segment (does not resolve '..'; returns the root when only the root remains). */
  dirname(p: string): string
  /** Take the last path segment (trailing separator stripped; returns '' or the device-prefix semantics when only the root remains). */
  basename(p: string): string
}

/** Select lexical rules by target path shape (unknown shape uses POSIX; independent of the Hub host platform). */
export function pathRulesForShape(shape: 'posix' | 'win32' | undefined): TargetPathRules {
  return shape === 'win32' ? win32Rules : posixRules
}

const posixRules: TargetPathRules = {
  normalize(p: string): string {
    if (p.length === 0) return '.'
    const isAbsolute = p.charCodeAt(0) === FORWARD_SLASH
    const trailing = p.charCodeAt(p.length - 1) === FORWARD_SLASH
    const segments: string[] = []
    for (const segment of p.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
        else if (!isAbsolute) segments.push('..')
        continue
      }
      segments.push(segment)
    }
    const joined = segments.join('/')
    if (joined.length === 0) return isAbsolute ? '/' : trailing ? './' : '.'
    return (isAbsolute ? '/' : '') + joined + (trailing ? '/' : '')
  },

  join(...parts: string[]): string {
    let joined: string | undefined
    for (const part of parts) {
      if (part.length === 0) continue
      joined = joined === undefined ? part : `${joined}/${part}`
    }
    return joined === undefined ? '.' : posixRules.normalize(joined)
  },

  dirname(p: string): string {
    if (p.length === 0) return '.'
    let end = p.length
    while (end > 1 && p.charCodeAt(end - 1) === FORWARD_SLASH) end -= 1
    const q = p.slice(0, end)
    const i = q.lastIndexOf('/')
    if (i < 0) return '.'
    // POSIX: exactly two leading slashes ('//x') is an implementation-defined root; dirname keeps '//'.
    if (
      i === 1 &&
      q.charCodeAt(0) === FORWARD_SLASH &&
      q.charCodeAt(1) === FORWARD_SLASH &&
      q.charCodeAt(2) !== FORWARD_SLASH
    ) {
      return '//'
    }
    if (i === 0) return '/'
    return q.slice(0, i)
  },

  basename(p: string): string {
    let end = p.length
    while (end > 0 && p.charCodeAt(end - 1) === FORWARD_SLASH) end -= 1
    if (end === 0) return ''
    let start = end
    while (start > 0 && p.charCodeAt(start - 1) !== FORWARD_SLASH) start -= 1
    return p.slice(start, end)
  },
}

/** win32 root parse result: device prefix + root length (device + root separator). */
interface Win32Root {
  /** Drive ('C:') or UNC device ('\\\server\share', separators unified to '\'); '' when there is no device. */
  device: string
  /** Length of device + root separator (2 for a drive without a root separator; 0 when there is no root). */
  rootLen: number
  isAbsolute: boolean
}

/** Parse the device and root of a win32 path: exactly two leading separators + non-empty server + separator + non-empty share counts as UNC. */
function win32ParseRoot(p: string): Win32Root {
  const len = p.length
  if (len === 0) return { device: '', rootLen: 0, isAbsolute: false }
  const first = p.charCodeAt(0)
  if (isWinSeparator(first)) {
    if (isWinSeparator(p.charCodeAt(1))) {
      let j = 2
      while (j < len && !isWinSeparator(p.charCodeAt(j))) j += 1
      if (j > 2 && j < len) {
        let k = j + 1
        while (k < len && !isWinSeparator(p.charCodeAt(k))) k += 1
        if (k > j + 1) {
          return {
            device: `\\\\${p.slice(2, j)}\\${p.slice(j + 1, k)}`,
            rootLen: k + (k < len ? 1 : 0),
            isAbsolute: true,
          }
        }
      }
    }
    return { device: '', rootLen: 1, isAbsolute: true }
  }
  if (len >= 2 && isDriveLetter(first) && p.charCodeAt(1) === COLON) {
    const rootLen = len > 2 && isWinSeparator(p.charCodeAt(2)) ? 3 : 2
    return { device: p.slice(0, 2), rootLen, isAbsolute: rootLen === 3 }
  }
  return { device: '', rootLen: 0, isAbsolute: false }
}

const win32Rules: TargetPathRules = {
  normalize(p: string): string {
    if (p.length === 0) return '.'
    const { device, rootLen, isAbsolute } = win32ParseRoot(p)
    const trailing = isWinSeparator(p.charCodeAt(p.length - 1))
    const rawSegments = p.slice(rootLen).split(/[\\/]/)
    const segments: string[] = []
    for (const segment of rawSegments) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
        else if (!isAbsolute) segments.push('..')
        // Absolute paths clamp at the root: '..' neither escapes nor persists (matching node:path win32).
        continue
      }
      segments.push(segment)
    }
    const joined = segments.join('\\')
    if (isAbsolute) {
      const base = device.length > 0 ? `${device}\\` : '\\'
      return joined.length === 0 ? base : `${base}${joined}${trailing ? '\\' : ''}`
    }
    if (device.length > 0) {
      // Drive-relative (C:relative): no root separator introduced; an empty-segment result gains '.' (node behavior).
      return joined.length === 0 ? `${device}.` : `${device}${joined}${trailing ? '\\' : ''}`
    }
    // If a relative result could be re-parsed as a device path (first segment is a
    // drive, or any raw segment ends with ':' — including segments already
    // cancelled out by '..'), add a '.\' prefix to disambiguate (matching
    // node:path win32.normalize).
    const body = joined.length === 0 ? (trailing ? '.\\' : '.') : `${joined}${trailing ? '\\' : ''}`
    if (joined.charCodeAt(1) === COLON || rawSegments.some((s) => s.endsWith(':'))) {
      return `.\\${body}`
    }
    return body
  },

  join(...parts: string[]): string {
    let joined: string | undefined
    for (const part of parts) {
      if (part.length === 0) continue
      joined = joined === undefined ? part : `${joined}\\${part}`
    }
    return joined === undefined ? '.' : win32Rules.normalize(joined)
  },

  dirname(p: string): string {
    if (p.length === 0) return '.'
    const { device, rootLen } = win32ParseRoot(p)
    let end = p.length
    while (end > Math.max(rootLen, 1) && isWinSeparator(p.charCodeAt(end - 1))) end -= 1
    const q = p.slice(0, end)
    let i = -1
    for (let k = q.length - 1; k >= 0; k -= 1) {
      if (isWinSeparator(q.charCodeAt(k))) {
        i = k
        break
      }
    }
    if (i < 0) {
      // No separator: a drive (including the parent of drive-relative 'C:a') returns the device; everything else returns '.'.
      return device.length > 0 ? device : '.'
    }
    if (i < rootLen) return p.slice(0, rootLen)
    return q.slice(0, i)
  },

  basename(p: string): string {
    let end = p.length
    while (end > 0 && isWinSeparator(p.charCodeAt(end - 1))) end -= 1
    const q = p.slice(0, end)
    // The name boundary sits right after a drive prefix (C:): the basename of 'C:a' is 'a', of 'C:' is ''.
    const floor = q.length >= 2 && isDriveLetter(q.charCodeAt(0)) && q.charCodeAt(1) === COLON ? 2 : 0
    let start = q.length
    while (start > floor && !isWinSeparator(q.charCodeAt(start - 1))) start -= 1
    return q.slice(start)
  },
}

// ---------------------------------------------------------------------------
// Target-platform path normalization (deterministic POSIX-view conversion on win32 targets)
// ---------------------------------------------------------------------------

/**
 * Target platform semantics: 'win32' triggers Windows normalization (including
 * POSIX-view conversion); every other platform keeps POSIX semantics (darwin /
 * linux etc. share the POSIX rules).
 */
export type TargetPlatform = 'win32' | 'posix'

/** Host platform identifier (e.g. process.platform) -> target platform semantics (win32-only special case). */
export function targetPlatformOf(platform: string): TargetPlatform {
  return platform === 'win32' ? 'win32' : 'posix'
}

/** The input view the normalization followed (for diagnostics: how the path was recognized and converted). */
export type TargetPathView =
  /** Native Windows shape (drive-absolute / root backslash / UNC, separators may be mixed) or a relative path. */
  | 'win32'
  /** POSIX target platform: POSIX semantics kept as-is (lexical normalization only, never converted the other way). */
  | 'posix'
  /** POSIX-spelled UNC view with exactly two leading slashes (//server/share/…). */
  | 'unc'
  /** WSL mount view (/mnt/<drive>/…). */
  | 'wsl-mount'
  /** Drive-root view (/<drive>/…, the Git Bash / MSYS convention). */
  | 'drive'

/** normalizeTargetPath result: success carries the canonical path and the recognized view; failure is a machine-readable code + human-readable reason. */
export type NormalizeTargetPathResult =
  | { ok: true; path: string; view: TargetPathView }
  | {
      /**
       * A POSIX absolute path with no deterministic drive correspondence on a
       * win32 target (bare '/', /home, /tmp, /mnt, /mnt/<non-single-letter
       * segment>, '..' escaping the drive root, etc.): the real location of a
       * WSL distro root lives under \\wsl$\… and is unknowable without probing;
       * guessing is refused (honesty red line).
       */
      ok: false
      code: 'unmappable_posix_root'
      reason: string
    }

/** Only a single-letter segment (A-Z / a-z) is a legal drive segment for the drive views (multi-letter or non-letter segments such as 'cd' are all rejected). */
function isSingleDriveSegment(segment: string): boolean {
  return segment.length === 1 && isDriveLetter(segment.charCodeAt(0))
}

/** Canonical spelling with the drive letter uppercased (purely lexical; UNC and drive-less paths return unchanged). */
function canonicalWin32Drive(p: string): string {
  return p.length >= 2 && isDriveLetter(p.charCodeAt(0)) && p.charCodeAt(1) === COLON
    ? p.charAt(0).toUpperCase() + p.slice(1)
    : p
}

function unmappablePosixRoot(input: string, normalized: string): NormalizeTargetPathResult {
  return {
    ok: false,
    code: 'unmappable_posix_root',
    reason:
      `cannot determine a Windows drive correspondence for the POSIX absolute path ${input} ` +
      `(lexically normalized to ${normalized}) on a win32 target: only three deterministic mappings are ` +
      `supported — /mnt/<drive>/… (WSL mount view), /<drive>/… (Git Bash / MSYS drive-root view) and ` +
      `//server/share/… (UNC view); every other POSIX root belongs to a WSL distro filesystem ` +
      `(its real location lives under \\\\wsl$\\… and is unknowable without probing); silent guessing is refused`,
  }
}

/**
 * Target-platform path normalization (a deterministic pure function; zero probing, zero guessing):
 *
 * - platform 'posix': POSIX lexical normalization (/mnt/c/… is a real path on
 *   Linux-like targets; never a reverse "smart" conversion).
 * - platform 'win32':
 *   - win32 shape (drive-absolute / root backslash / UNC, separators may be
 *     mixed) -> win32 lexical normalization;
 *   - exactly two leading slashes (//server/share/…) -> a POSIX-spelled UNC view,
 *     normalized by the win32 rules (POSIX reserves exactly-two-leading-slash
 *     semantics for implementations; Git Bash / MSYS likewise hand it to UNC;
 *     three or more slashes first collapse to a single root, then drive-view
 *     detection applies);
 *   - other POSIX shapes are first lexically normalized by the POSIX rules
 *     (resolving '.'/'..', collapsing repeated separators, preserving a single
 *     trailing separator), then the result is deterministically classified:
 *     /mnt/<single-letter drive>/… -> <uppercase drive>:\… (WSL mount view; mount
 *     points are case-sensitive, and only lowercase 'mnt' is the WSL convention);
 *     /<single-letter drive>/… -> <uppercase drive>:\… (Git Bash / MSYS drive-root
 *     view);
 *     every other POSIX root (including '..' escaping the drive root, or
 *     backslash segments mixed into the POSIX view) fails explicitly in a
 *     structured way (unmappable_posix_root), never guessing silently;
 *   - relative paths (including drive-relative C:relative) -> win32 lexical
 *     normalization (this primitive never absolutizes; the resolution base is
 *     the caller's policy).
 *
 * Drives are emitted in the canonical uppercase spelling (Windows drive letters
 * are case-insensitive); UNC server / share keep the input casing (the canonical
 * spelling is unknowable without network probing — keep it faithfully).
 */
export function normalizeTargetPath(p: string, platform: TargetPlatform): NormalizeTargetPathResult {
  if (platform !== 'win32') {
    return { ok: true, path: posixRules.normalize(p), view: 'posix' }
  }
  const shape = targetPathShape(p)
  if (shape !== 'posix') {
    // win32 shape and relative paths: win32 lexical normalization (relative paths include drive-relative ones; no absolutization).
    return { ok: true, path: canonicalWin32Drive(win32Rules.normalize(p)), view: 'win32' }
  }
  if (
    p.charCodeAt(0) === FORWARD_SLASH &&
    p.charCodeAt(1) === FORWARD_SLASH &&
    p.charCodeAt(2) !== FORWARD_SLASH
  ) {
    return { ok: true, path: canonicalWin32Drive(win32Rules.normalize(p)), view: 'unc' }
  }
  // First POSIX-lexically normalize, then classify the drive view: '.'/'..' are
  // resolved here (escaping the drive root naturally falls back to a drive-less
  // root and fails), repeated separators collapse, and a single trailing
  // separator is preserved.
  const normalized = posixRules.normalize(p)
  const trailing = normalized.length > 1 && normalized.charCodeAt(normalized.length - 1) === FORWARD_SLASH
  const segments = (trailing ? normalized.slice(0, -1) : normalized).slice(1).split('/')
  const first = segments[0] ?? ''
  let drive: string
  let view: TargetPathView
  if (first === 'mnt') {
    const second = segments[1] ?? ''
    if (!isSingleDriveSegment(second)) return unmappablePosixRoot(p, normalized)
    drive = second
    view = 'wsl-mount'
    segments.splice(0, 2)
  } else if (isSingleDriveSegment(first)) {
    drive = first
    view = 'drive'
    segments.splice(0, 1)
  } else {
    return unmappablePosixRoot(p, normalized)
  }
  const tail = segments.join('\\')
  return {
    ok: true,
    path: `${drive.toUpperCase()}:\\${tail}${trailing && tail.length > 0 ? '\\' : ''}`,
    view,
  }
}
