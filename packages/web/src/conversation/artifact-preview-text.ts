/**
 * 产物与工作区文件预览文本解码纯逻辑（无组件导出，供预览模态框与测试共用）
 */

/** 协议契约：宿主最多向插件解码 1 MiB 文本。 */
export const MAX_PREVIEW_TEXT_BYTES = 1024 * 1024

/** MIME 前缀/精确值判定为文本（判定唯一真源，与宿主默认渲染共用）。 */
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh))/i

/** 已知文本类文件后缀（含多段后缀）：MIME 缺失或 octet-stream 时按名称判定是否尝试解码。 */
const TEXT_EXTENSION_RE = /\.(?:md|markdown|mdx|txt|log|json|jsonc|json5|ya?ml|toml|ini|properties|cfg|conf|csv|tsv|xml|svg|html?|css|scss|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|astro|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cc|cs|php|lua|sh|bash|zsh|fish|ps1|bat|cmd|sql|diff|patch|env|gitignore|gitattributes|editorconfig|dockerfile|makefile|proto|graphql|gql|tf|hcl|nix|rst|adoc|tex|zig|ex|exs|erl|clj|scala|dart|jl|r|lock|mod|sum)$/i

/** 无后缀或约定俗成的文本基名（如 Dockerfile、Makefile、.env.* 等）。 */
const TEXT_BASENAME_RE = /^(?:Dockerfile(?:\.[^/\\]+)?|Makefile(?:\.[^/\\]+)?|GNUmakefile|Containerfile(?:\.[^/\\]+)?|Vagrantfile|Gemfile|Rakefile|Procfile|Brewfile|LICENSE|README|CHANGELOG|\.env(?:\.[^/\\]+)?|\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.prettierrc|\.eslintrc)$/i

export function isMarkdown(name: string | undefined, mime: string): boolean {
  if (mime.toLowerCase().startsWith('text/markdown')) return true
  if (name !== undefined && /\.(?:md|markdown|mdx)$/i.test(name)) return true
  return false
}

/** MIME 明确为文本类（text/* 或常见文本 application/*）。 */
export function looksLikeText(mime: string): boolean {
  return TEXT_MIME_RE.test(mime)
}

/**
 * 是否尝试解码文本：MIME 明确文本类，或（MIME 缺失 / application/octet-stream 时）
 * 名称命中已知文本后缀/基名。名称未知不猜（不以 artifactId 冒充文件名推导）。
 */
export function shouldDecodeText(meta: { name?: string } | undefined, mime: string): boolean {
  if (looksLikeText(mime)) return true
  const baseMime = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  if (baseMime !== '' && baseMime !== 'application/octet-stream') return false
  const name = meta?.name
  if (name === undefined || name === '') return false
  const baseName = name.split(/[\\/]/).pop() ?? name
  return TEXT_EXTENSION_RE.test(baseName) || TEXT_BASENAME_RE.test(baseName)
}

/**
 * 解码产物文本：超过 1 MiB 上限时返回 null（显式超限，不截断伪装全文）。
 */
export async function decodePreviewText(blob: Blob): Promise<string | null> {
  if (blob.size > MAX_PREVIEW_TEXT_BYTES) return null
  return await blob.text()
}
