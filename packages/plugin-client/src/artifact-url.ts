/**
 * 产物 URL 识别与 Markdown URL 安全转换。
 * 纯函数模块，遵守 Fast Refresh 约束（不含 React 组件）。
 */
import { defaultUrlTransform } from 'react-markdown'

const ARTIFACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CONTENT_URL_RE = /^\/api\/artifacts\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/content(?:\?.*)?$/

/**
 * 识别 artifact:<id> 与 /api/artifacts/<id>/content(?...)?。
 * id 需满足 /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/，非法或不匹配返回 null。
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
 * Markdown URL 转换：命中产物链接时放行（保留协议头），其余走 react-markdown 默认安全拦截（过滤 javascript: 等）。
 */
export function markdownUrlTransform(url: string): string {
  if (parseArtifactUrl(url) !== null) {
    return url.trim()
  }
  return defaultUrlTransform(url)
}
