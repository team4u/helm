/**
 * builtin:workflow 插件 client 纯逻辑：共享格式化与宽松字段提取工具
 * （零 React/DOM 依赖）。各 model-*.ts 域模块共用；inputString / inspectString
 * 为域模块间内部导出，不经 models.ts 门面对外暴露。
 */

// ---------------------------------------------------------------------------
// 格式化工具（时长摘要统一复用宿主 lib/format.ts 经 @helm/plugin-client 共享的实现）
// ---------------------------------------------------------------------------

export function toolResultPreviewTruncated(preview: string | undefined): boolean {
  return preview?.endsWith('…') === true
}

export function isScrolledToBottom(element: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 36
}

/** 首行截断（trim 后超长加省略号）。 */
export function firstLineOf(text: string, maxChars: number): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line
}

const PURE_HEADING_LABEL_RE = /^(?:汇报|结果|总结|摘要|结论|输出|report|result|results|summary|output)\s*[:：]?$/i
const CODE_FENCE_OR_HR_RE = /^(?:```.*|~~~.*|[-*_]{3,})$/

/** 剥离行内 Markdown 语法符号（标题前缀、引用、列表项、加粗/斜体/行内代码/链接）。 */
export function cleanInlineMarkdown(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^(?:[-*+]\s+|\d+\.\s+)/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2')
    .trim()
}

function isPureHeadingOrDecoratorLine(rawLine: string): boolean {
  const trimmed = rawLine.trim()
  if (trimmed === '') return true
  if (CODE_FENCE_OR_HR_RE.test(trimmed)) return true
  const stripped = trimmed.replace(/^#{1,6}\s*/, '').trim()
  return stripped === '' || PURE_HEADING_LABEL_RE.test(stripped)
}

/**
 * 单行摘要清洗器：跳过空行与纯标题/分隔符前缀行（如 `## 汇报:` / `# 结果`），
 * 提取首个有实质内容的行并剥离行内 Markdown 符号后截断；若全篇只有标题行则退回首行清洗文本。
 */
export function extractCleanPreviewLine(text: string, maxChars: number): string {
  const lines = text.split('\n')
  let firstNonEmptyCleaned: string | undefined
  for (const raw of lines) {
    const cleaned = cleanInlineMarkdown(raw)
    if (cleaned === '') continue
    if (firstNonEmptyCleaned === undefined) firstNonEmptyCleaned = cleaned
    if (isPureHeadingOrDecoratorLine(raw)) continue
    return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars)}…` : cleaned
  }
  const fallback = firstNonEmptyCleaned ?? ''
  return fallback.length > maxChars ? `${fallback.slice(0, maxChars)}…` : fallback
}

function formatReadableScalar(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'string') return cleanInlineMarkdown(value.replace(/\s+/g, ' '))
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 对 JSON 对象/数组提取前序可读键值摘要（避免直接截断裸 `{` 字符）。
 * 优先抽取 summary/result/output/message 等高价值字段，其余按键顺序拼接。
 */
export function summarizeReadableJson(value: unknown, maxChars: number): string {
  if (value === null || typeof value !== 'object') {
    const scalar = formatReadableScalar(value)
    return scalar.length > maxChars ? `${scalar.slice(0, maxChars)}…` : scalar
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.slice(0, 3).map((item) => formatReadableScalar(item)).filter((s) => s !== '')
    const suffix = value.length > 3 ? ` 等 ${value.length} 项` : ''
    const joined = `${items.join(', ')}${suffix}`
    return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined
  }
  const record = value as Record<string, unknown>
  const priorityKeys = ['summary', 'result', 'output', 'message', 'status', 'error']
  const entries: Array<[string, unknown]> = []
  const seen = new Set<string>()
  for (const k of priorityKeys) {
    if (Object.hasOwn(record, k) && record[k] !== undefined) {
      entries.push([k, record[k]])
      seen.add(k)
    }
  }
  for (const [k, v] of Object.entries(record)) {
    if (seen.has(k) || v === undefined) continue
    entries.push([k, v])
  }
  if (entries.length === 0) return '{}'
  const parts = entries.slice(0, 4).map(([k, v]) => `${k}: ${formatReadableScalar(v)}`)
  const joined = parts.join(' · ')
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined
}

/** 工具入参字段提取（字符串且非空）。 */
export function inputString(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

export function inspectString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 模型短名：剥离 provider/ 前缀，空串返回 undefined。 */
export function formatShortModelName(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const trimmed = model.trim()
  if (trimmed === '') return undefined
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed
}

/** 结构化值只读展示序列化（缩进 JSON；无法序列化时回退 String，不伪造）。 */
export function stringifyPretty(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}
