/**
 * 产物预览文本解码纯逻辑（无组件导出，供 ArtifactPreviewModal 与测试共用） */
import type { ArtifactMetadata } from '@helm/protocol'

/** 协议契约：宿主最多向插件解码 1 MiB 文本。 */
export const MAX_PREVIEW_TEXT_BYTES = 1024 * 1024

/** MIME 前缀/精确值判定为文本（判定唯一真源，与宿主默认渲染共用）。 */
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh))/i

/** 已知文本类文件后缀（含多段后缀）：MIME 缺失/未知时按名称判定是否尝试解码。 */
const TEXT_EXTENSION_RE = /\.(?:md|markdown|txt|log|json|jsonc|json5|ya?ml|toml|ini|properties|cfg|conf|csv|tsv|xml|svg|html?|css|scss|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cc|cs|php|lua|sh|bash|zsh|fish|ps1|bat|cmd|sql|diff|patch|env|gitignore|editorconfig|dockerfile)$/i

export function isMarkdown(name: string | undefined, mime: string): boolean {
  if (mime.startsWith('text/markdown')) return true
  if (name !== undefined && /\.md$/i.test(name)) return true
  return false
}

/** MIME 明确为文本类（text/* 或常见文本 application/*）。 */
export function looksLikeText(mime: string): boolean {
  return TEXT_MIME_RE.test(mime)
}

/**
 * 是否尝试解码文本：MIME 明确文本类，或（MIME 未知时）名称命中已知文本后缀。
 * 名称未知不猜（不以 artifactId 冒充文件名推导）。
 */
export function shouldDecodeText(meta: ArtifactMetadata | undefined, mime: string): boolean {
  if (looksLikeText(mime)) return true
  if (mime !== '') return false
  const name = meta?.name
  return name !== undefined && name !== '' && TEXT_EXTENSION_RE.test(name)
}

/**
 * 解码产物文本：超过 1 MiB 上限时返回 null（显式超限，不截断伪装全文）。
 */
export async function decodePreviewText(blob: Blob): Promise<string | null> {
  if (blob.size > MAX_PREVIEW_TEXT_BYTES) return null
  return await blob.text()
}
