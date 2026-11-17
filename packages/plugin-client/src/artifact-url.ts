/**
 * Artifact URL recognition and safe Markdown URL transformation.
 * Pure-function module, obeys the Fast Refresh constraint (no React components).
 */
import { defaultUrlTransform } from 'react-markdown'

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CONTENT_URL_RE = /^\/api\/artifacts\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/content(?:\?.*)?$/

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
 * Markdown URL transform: artifact and file: links are allowed through (protocol
 * prefix preserved so host components can validate or reject unsafe file://
 * targets explicitly); everything else goes through react-markdown's default
 * safe interception (filters javascript:, data:, vbscript:, etc.).
 */
export function markdownUrlTransform(url: string): string {
  if (parseArtifactUrl(url) !== null) {
    return url.trim()
  }
  const trimmed = url.trim()
  if (trimmed.toLowerCase().startsWith('file:')) {
    return trimmed
  }
  return defaultUrlTransform(url)
}
