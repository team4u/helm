/**
 * Artifact URL recognition and safe Markdown URL transformation.
 * Pure-function module, obeys the Fast Refresh constraint (no React components).
 */
import { defaultUrlTransform } from 'react-markdown'

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CONTENT_URL_RE = /^\/api\/artifacts\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/content(?:\?.*)?$/
const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:[\\/]/

/**
 * Recognizes artifact:<id> and /api/artifacts/<id>/content(?...)?.
 * The id must satisfy /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/; invalid or non-matching input returns null.
 */
export function parseArtifactUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.startsWith('artifact:')) {
    const id = trimmed.slice(9)
    return ARTIFACT_ID_RE.test(id) ? id : null
  }
  const match = CONTENT_URL_RE.exec(trimmed)
  if (match !== null) {
    return match[1]!
  }
  return null
}

/**
 * Markdown URL transform: artifact, file:, and Windows drive-letter local paths
 * (e.g. C:/...) are allowed through so host components can resolve workspace
 * files or reject out-of-workspace targets explicitly; everything else goes
 * through react-markdown's default safe interception (filters javascript:, data:, vbscript:, etc.).
 */
export function markdownUrlTransform(url: string): string {
  if (parseArtifactUrl(url) !== null) {
    return url.trim()
  }
  const trimmed = url.trim()
  if (trimmed.toLowerCase().startsWith('file:') || WINDOWS_DRIVE_ABS_RE.test(trimmed)) {
    return trimmed
  }
  return defaultUrlTransform(url)
}
