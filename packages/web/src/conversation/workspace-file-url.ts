/**
 * Workspace file link & image URL parser (pure functions, zero React/DOM deps).
 *
 * Recognizes safe workspace-relative paths and `file://` URLs strictly
 * contained within `conversationCwd`, normalizing relative references against
 * `workspaceBaseDir` and extracting optional `#L<start>(-L?<end>)` line ranges.
 */
import { pathRulesForShape, targetPathShape } from '@helm/protocol/browser'

export interface WorkspaceFileRef {
  path: string
  startLine?: number
  endLine?: number
}

const EXPLICIT_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const BARE_LOCALHOST_RE = /^localhost(?::\d+)?$/i
const BARE_IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/
const BARE_WEB_TLD_RE = /\.(?:com|org|net|io|dev|app|ai|cn|edu|gov|co|me|xyz|info|biz)(?::\d+)?$/i
const LINE_FRAGMENT_RE = /^L(\d+)(?:-L?(\d+))?$/i

/** Returns true when a raw link/image URL uses the `file:` scheme (case-insensitive). */
export function isDisallowedFileUrl(raw: string | undefined): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase().startsWith('file:')
}

function parseLineRange(fragment: string): { startLine?: number; endLine?: number } {
  if (fragment === '') return {}
  const match = LINE_FRAGMENT_RE.exec(fragment)
  if (match === null) return {}
  const startLine = Number(match[1])
  if (!Number.isSafeInteger(startLine) || startLine <= 0) return {}
  if (match[2] === undefined) return { startLine }
  const endLine = Number(match[2])
  if (!Number.isSafeInteger(endLine) || endLine < startLine) {
    return { startLine }
  }
  return { startLine, endLine }
}

function parseFileSchemeRef(
  beforeHash: string,
  conversationCwd: string | undefined,
): string | null {
  if (!beforeHash.toLowerCase().startsWith('file://')) return null
  if (beforeHash.includes('?')) return null
  if (conversationCwd === undefined) return null
  const trimmedCwd = conversationCwd.trim()
  if (trimmedCwd === '') return null

  let url: URL
  try {
    url = new URL(beforeHash)
  } catch {
    return null
  }
  if (url.protocol !== 'file:' || url.search !== '') return null
  if (url.hostname !== '' && url.hostname.toLowerCase() !== 'localhost') {
    return null
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (decodedPath === '' || decodedPath.includes('\0')) return null

  // Windows drive URL: file:///C:/a/b -> pathname '/C:/a/b' -> 'C:/a/b'
  const candidatePath = /^\/[A-Za-z]:(?:[\\/]|$)/.test(decodedPath)
    ? decodedPath.slice(1)
    : decodedPath

  const cwdShape = targetPathShape(trimmedCwd)
  if (cwdShape === undefined) return null
  if (targetPathShape(candidatePath) !== cwdShape) return null

  const rules = pathRulesForShape(cwdShape)
  const normCwd = rules.normalize(trimmedCwd)
  const normFile = rules.normalize(candidatePath)

  if (cwdShape === 'win32') {
    const base = /^[A-Za-z]:\\$/.test(normCwd) || normCwd === '\\'
      ? normCwd
      : normCwd.replace(/\\+$/, '')
    const prefix = base.endsWith('\\') ? base : `${base}\\`
    if (!normFile.toLowerCase().startsWith(prefix.toLowerCase())) return null
    const relWin = normFile.slice(prefix.length)
    if (relWin === '' || relWin.endsWith('\\')) return null
    return relWin.replace(/\\/g, '/')
  }

  const base = normCwd === '/' ? '/' : normCwd.replace(/\/+$/, '')
  const prefix = base === '/' ? '/' : `${base}/`
  if (!normFile.startsWith(prefix)) return null
  const relPosix = normFile.slice(prefix.length)
  if (relPosix === '' || relPosix === '.' || relPosix.endsWith('/')) return null
  return relPosix
}

/**
 * Parse a Markdown link/image href/src into a workspace-relative file reference.
 * Returns null for anchors, external URLs, bare host/domain links, API paths,
 * absolute root paths, paths escaping the workspace root, or `file://` URLs
 * outside `conversationCwd` (or when `conversationCwd` is missing).
 */
export function parseWorkspaceFileRef(
  raw: string | undefined,
  opts?: { conversationCwd?: string; workspaceBaseDir?: string },
): WorkspaceFileRef | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) return null

  const hashIdx = trimmed.indexOf('#')
  const beforeHash = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)
  const fragment = hashIdx === -1 ? '' : trimmed.slice(hashIdx + 1)
  if (beforeHash === '') return null

  if (/^file:/i.test(beforeHash)) {
    const relPath = parseFileSchemeRef(beforeHash, opts?.conversationCwd)
    if (relPath === null) return null
    return { path: relPath, ...parseLineRange(fragment) }
  }

  // Reject absolute root paths (including /api/...) and query strings outside file://
  if (beforeHash.startsWith('/')) return null
  if (beforeHash.includes('?')) return null
  if (EXPLICIT_SCHEME_RE.test(beforeHash)) return null
  if (beforeHash.includes('\\')) return null

  // Reject bare domain/host links that do not explicitly start with ./ or ../
  if (!beforeHash.startsWith('./') && !beforeHash.startsWith('../')) {
    const firstSeg = beforeHash.split('/')[0] ?? ''
    if (
      BARE_LOCALHOST_RE.test(firstSeg) ||
      BARE_IPV4_RE.test(firstSeg) ||
      BARE_WEB_TLD_RE.test(firstSeg)
    ) {
      return null
    }
  }

  let decodedRel: string
  try {
    decodedRel = decodeURIComponent(beforeHash)
  } catch {
    return null
  }
  if (
    decodedRel === '' ||
    decodedRel.includes('\0') ||
    decodedRel.includes('\\') ||
    decodedRel.includes('?') ||
    decodedRel.startsWith('/')
  ) {
    return null
  }

  const posix = pathRulesForShape('posix')
  let combined = decodedRel
  if (opts?.workspaceBaseDir !== undefined) {
    const rawBase = opts.workspaceBaseDir.trim().replace(/^\/+/, '').replace(/\/+$/, '')
    if (rawBase !== '' && rawBase !== '.') {
      const baseNorm = posix.normalize(rawBase)
      if (baseNorm === '..' || baseNorm.startsWith('../')) return null
      if (baseNorm !== '.') {
        combined = `${baseNorm}/${decodedRel}`
      }
    }
  }

  const normalized = posix.normalize(combined)
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/')
  ) {
    return null
  }

  return {
    path: normalized,
    ...parseLineRange(fragment),
  }
}
