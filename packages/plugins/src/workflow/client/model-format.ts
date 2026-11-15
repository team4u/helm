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
