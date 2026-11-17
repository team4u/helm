/**
 * Shared MIME type and text/binary classification for workspace files and artifacts.
 *
 * - Known extensions/basenames resolve deterministically without inspecting bytes.
 * - Unknown/extensionless workspace files inspect up to the first 8 KiB for NUL bytes
 *   and valid UTF-8 (handling multi-byte sequences split at the 8 KiB boundary).
 */

export const BINARY_MIME = 'application/octet-stream'

const MAX_UTF8_SNIFF_BYTES = 8192

const KNOWN_MIME_BY_EXT: Readonly<Record<string, string>> = {
  // Markdown
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',

  // Structured text
  json: 'application/json',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',

  // Source & config text
  ts: 'text/plain',
  tsx: 'text/plain',
  mts: 'text/plain',
  cts: 'text/plain',
  jsx: 'text/plain',
  py: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  kt: 'text/plain',
  kts: 'text/plain',
  swift: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  hpp: 'text/plain',
  cc: 'text/plain',
  hh: 'text/plain',
  cxx: 'text/plain',
  hxx: 'text/plain',
  cs: 'text/plain',
  rb: 'text/plain',
  php: 'text/plain',
  lua: 'text/plain',
  sh: 'text/plain',
  bash: 'text/plain',
  zsh: 'text/plain',
  fish: 'text/plain',
  ps1: 'text/plain',
  bat: 'text/plain',
  cmd: 'text/plain',
  sql: 'text/plain',
  toml: 'text/plain',
  ini: 'text/plain',
  properties: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  jsonc: 'text/plain',
  json5: 'text/plain',
  scss: 'text/plain',
  sass: 'text/plain',
  less: 'text/plain',
  tsv: 'text/plain',
  diff: 'text/plain',
  patch: 'text/plain',
  txt: 'text/plain',
  log: 'text/plain',
  gitignore: 'text/plain',
  gitattributes: 'text/plain',
  gitmodules: 'text/plain',
  dockerignore: 'text/plain',
  npmignore: 'text/plain',
  eslintignore: 'text/plain',
  prettierignore: 'text/plain',
  editorconfig: 'text/plain',
  vue: 'text/plain',
  svelte: 'text/plain',
  astro: 'text/plain',
  graphql: 'text/plain',
  gql: 'text/plain',
  proto: 'text/plain',
  tf: 'text/plain',
  tfvars: 'text/plain',
  hcl: 'text/plain',
  nix: 'text/plain',
  zig: 'text/plain',
  ex: 'text/plain',
  exs: 'text/plain',
  erl: 'text/plain',
  hrl: 'text/plain',
  clj: 'text/plain',
  cljs: 'text/plain',
  scala: 'text/plain',
  groovy: 'text/plain',
  r: 'text/plain',
  jl: 'text/plain',
  pl: 'text/plain',
  pm: 'text/plain',
  awk: 'text/plain',
  sed: 'text/plain',
  vim: 'text/plain',
  tex: 'text/plain',
  bib: 'text/plain',
  rst: 'text/plain',
  adoc: 'text/plain',
  org: 'text/plain',
  lock: 'text/plain',
  map: 'text/plain',
  cmake: 'text/plain',
  mk: 'text/plain',

  // Common binary formats
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
}

const TEXT_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'gnumakefile',
  'license',
  'readme',
  'changelog',
  'authors',
  'contributing',
  'notice',
  'procfile',
  'gemfile',
  'rakefile',
  'justfile',
  'vagrantfile',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.dockerignore',
  '.npmignore',
  '.eslintignore',
  '.prettierignore',
  '.editorconfig',
  '.env',
  '.babelrc',
  '.eslintrc',
  '.prettierrc',
  '.npmrc',
  '.nvmrc',
  '.yarnrc',
])

/** Whether a MIME type represents UTF-8 textual content (redacted & decoded as text). */
export function isTextMime(mimeType: string): boolean {
  const base = mimeType.split(';', 1)[0]!.trim().toLowerCase()
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'image/svg+xml'
  )
}

/** Detect MIME type solely by file basename / extension; returns undefined when unknown. */
export function detectMimeByExtension(fileName: string): string | undefined {
  const base = (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase()
  if (
    TEXT_BASENAMES.has(base) ||
    base.startsWith('.env.') ||
    base.startsWith('dockerfile.') ||
    base.startsWith('makefile.')
  ) {
    return 'text/plain'
  }
  const dot = base.lastIndexOf('.')
  if (dot === -1 || dot === base.length - 1) return undefined
  const ext = base.slice(dot + 1)
  return Object.hasOwn(KNOWN_MIME_BY_EXT, ext) ? KNOWN_MIME_BY_EXT[ext] : undefined
}

/**
 * Determine safe slice end <= maxBytes when sampling a larger buffer so a valid
 * multi-byte UTF-8 sequence split right at the cap boundary is excluded rather
 * than misclassified as invalid UTF-8.
 */
function utf8SniffEnd(bytes: Uint8Array, maxBytes: number): number {
  if (bytes.length <= maxBytes) return bytes.length
  const end = maxBytes
  let contCount = 0
  let idx = end - 1
  while (idx >= 0 && contCount < 3 && (bytes[idx]! & 0xc0) === 0x80) {
    contCount += 1
    idx -= 1
  }
  if (idx < 0) return end
  const lead = bytes[idx]!
  let expectedLen = 0
  if ((lead & 0x80) === 0) expectedLen = 1
  else if ((lead & 0xe0) === 0xc0) expectedLen = 2
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4
  else return end
  const present = end - idx
  return present < expectedLen ? idx : end
}

/**
 * Detect workspace file MIME type and text/binary classification.
 * Known extensions/basenames map directly; unknown/extensionless files sniff up to
 * the first 8 KiB for absence of NUL bytes and valid UTF-8.
 */
export function detectWorkspaceFileMime(
  fileName: string,
  sampleBytes?: Uint8Array,
): { mimeType: string; isText: boolean } {
  const known = detectMimeByExtension(fileName)
  if (known !== undefined) {
    return { mimeType: known, isText: isTextMime(known) }
  }
  if (sampleBytes === undefined) {
    return { mimeType: BINARY_MIME, isText: false }
  }
  const end = utf8SniffEnd(sampleBytes, MAX_UTF8_SNIFF_BYTES)
  const sample = sampleBytes.subarray(0, end)
  if (sample.includes(0)) {
    return { mimeType: BINARY_MIME, isText: false }
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample)
    return { mimeType: 'text/plain', isText: true }
  } catch {
    return { mimeType: BINARY_MIME, isText: false }
  }
}
