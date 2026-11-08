/**
 * 语法高亮语言推导（纯函数，供 MarkdownView 代码块与产物预览共用）。
 * 由文件名后缀或 mimeType 推导 highlight.js 语言标识；无法识别时返回空串
 * （空串即普通等宽代码展示，绝不猜造语言）。
 */

/** 文件名后缀 -> highlight.js 语言标识（仅收录 highlight.js/lib/common 已注册语言）。 */
const EXT_LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  json: 'json',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  php: 'php',
  lua: 'lua',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  svg: 'xml',
  xml: 'xml',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  properties: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
  patch: 'diff',
}

/** mimeType -> highlight.js 语言标识。 */
const MIME_LANGUAGE_MAP: Record<string, string> = {
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'application/json': 'json',
  'text/json': 'json',
  'application/javascript': 'javascript',
  'text/javascript': 'javascript',
  'application/x-javascript': 'javascript',
  'application/typescript': 'typescript',
  'text/x-typescript': 'typescript',
  'text/x-python': 'python',
  'application/x-sh': 'bash',
  'application/x-shellscript': 'bash',
  'text/x-sh': 'bash',
  'text/css': 'css',
  'text/x-scss': 'scss',
  'text/html': 'xml',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/x-sql': 'sql',
  'application/x-yaml': 'yaml',
  'text/x-yaml': 'yaml',
  'text/x-diff': 'diff',
  'text/x-patch': 'diff',
}

/** 取文件名最后一个点之后的小写后缀（无后缀返回空串）。 */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/** 由文件名后缀推导语言标识；无法识别返回空串。 */
export function languageFromFilename(name: string | undefined): string {
  if (!name) return ''
  return EXT_LANGUAGE_MAP[fileExtension(name)] ?? ''
}

/** 由 mimeType 推导语言标识；无法识别返回空串。 */
export function languageFromMime(mime: string | undefined): string {
  if (!mime) return ''
  const normalized = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  return MIME_LANGUAGE_MAP[normalized] ?? ''
}

/** 后缀优先、mimeType 兜底推导语言标识；均无法识别返回空串（回退普通代码样式）。 */
export function detectLanguage(name: string | undefined, mime: string | undefined): string {
  return languageFromFilename(name) || languageFromMime(mime)
}
