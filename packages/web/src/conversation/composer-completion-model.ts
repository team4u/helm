/**
 * composerCompleter（协议 ComposerCompleterSpec）前端闭环纯逻辑：
 * - 触发 token 检测/替换：触发符前必须是行首或空白（空格边界）；token 内允许
 *   中文与路径斜杠；邮箱 user@x、URL a.com/@b、时间 12:30 不误触发；
 * - 源过滤排序：trigger + 会话 scope 命中，priority 降序稳定排列（缺省 0）；
 * - 边界校验：doc 顶层字段与 action 返回逐项校验，非法项丢弃并计数诊断（不静默）；
 * - 候选合并：以「插件 + 源」命名空间去重、合并上限截断、空格分词 AND 过滤（中文友好）。
 * 纯函数无 React 依赖，供 Composer / 订阅 hook / 单测共同消费。
 */
import type {
  ActionManifest,
  ComposerCompleterSpec,
  ComposerCompletionItem,
  ConversationSummary,
} from '@helm/protocol'
import type { QualifiedUiSpec } from '../lib/types.js'
import { matchesUiScope } from '../lib/types.js'

export type CompletionTrigger = '@' | '#' | ':'

/** 内置 Artifacts 源在合并去重中的命名空间（与插件 id 不冲突）。 */
export const HOST_ARTIFACT_SOURCE = '__host_artifacts__'

/** 浮层可见候选上限：键盘循环同样只在此列表内（修复旧 12 显示 / 全量索引不一致）。 */
export const COMPLETION_VISIBLE_LIMIT = 12

/** 合并层候选硬上限：失控源最多贡献到此数量，超出截断并显式提示。 */
export const COMPLETION_MERGE_LIMIT = 100

/** action 源查询防抖窗口。 */
export const COMPLETION_QUERY_DEBOUNCE_MS = 150

/** 斜杠命令 token：既有三源命令与技能触发词（ASCII），保持原字符集不变。 */
const SLASH_TOKEN_RE = /(?:^|\s)\/([a-zA-Z0-9:_-]*)$/
/** '@' '#' ':' 补全 token：触发符前须行首或空白；token 内允许非空白字符（中文/斜杠/点号）。 */
const TRIGGER_TOKEN_RE = /(?:^|\s)([@#:])([^\s]*)$/
/** 选中替换：光标前最近的触发 token（含触发符）整体替换为 insertText。 */
const REPLACE_TOKEN_RE = /(?:^|\s)([/@#:][^\s]*)$/

export interface CompletionToken {
  trigger: '/' | '@' | '#' | ':'
  query: string
  /** 触发符在全文中的起始下标（含触发符本身）。 */
  tokenStart: number
}

/** 检测光标前最近的补全触发 token；斜杠优先（命令命名空间独立，字符集互斥）。 */
export function detectCompletionToken(beforeCaret: string): CompletionToken | null {
  const slash = SLASH_TOKEN_RE.exec(beforeCaret)
  if (slash !== null) {
    const query = slash[1] ?? ''
    return { trigger: '/', query, tokenStart: beforeCaret.length - query.length - 1 }
  }
  const hit = TRIGGER_TOKEN_RE.exec(beforeCaret)
  if (hit !== null) {
    const query = hit[2] ?? ''
    return { trigger: hit[1] as '@' | '#' | ':', query, tokenStart: beforeCaret.length - query.length - 1 }
  }
  return null
}

/** 用 insertText 替换光标前最近的触发 token（含触发符），保留前后文本；无 token 时原地插入。 */
export function replaceTriggerToken(
  text: string,
  caret: number,
  insertText: string,
): { next: string; nextCaret: number } {
  const pos = Math.max(0, Math.min(text.length, Math.trunc(caret) || 0))
  const hit = REPLACE_TOKEN_RE.exec(text.slice(0, pos))
  const start = hit !== null ? pos - (hit[1]?.length ?? 0) : pos
  const next = text.slice(0, start) + insertText + text.slice(pos)
  return { next, nextCaret: start + insertText.length }
}

/** 当前会话可用的指定触发符补全源：trigger + scope 命中，priority 降序稳定排列。 */
export function completersForTrigger(
  completers: ReadonlyArray<QualifiedUiSpec<ComposerCompleterSpec>> | undefined,
  trigger: CompletionTrigger,
  conversation: ConversationSummary | undefined,
): Array<QualifiedUiSpec<ComposerCompleterSpec>> {
  return (completers ?? [])
    .filter((c) => c.spec.trigger === trigger && matchesUiScope(conversation, c.spec.scope))
    .sort((a, b) => (b.spec.priority ?? 0) - (a.spec.priority ?? 0))
}

/** 单个候选边界校验：id/label/insertText 必须为非空字符串，hint/icon 可选字符串。 */
export function validateCompletionItem(entry: unknown): ComposerCompletionItem | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  if (typeof e['id'] !== 'string' || e['id'] === '') return null
  if (typeof e['label'] !== 'string' || e['label'] === '') return null
  if (typeof e['insertText'] !== 'string') return null
  if (e['hint'] !== undefined && typeof e['hint'] !== 'string') return null
  if (e['icon'] !== undefined && typeof e['icon'] !== 'string') return null
  return {
    id: e['id'],
    label: e['label'],
    insertText: e['insertText'],
    ...(e['hint'] !== undefined ? { hint: e['hint'] } : {}),
    ...(e['icon'] !== undefined ? { icon: e['icon'] } : {}),
  }
}

export interface ExtractedItems {
  /** 解析出的合法候选；null 表示文档尚未加载（不是错误）。 */
  items: ComposerCompletionItem[] | null
  /** 非法内容诊断（逐源显式暴露，不影响其他源）。 */
  error?: string
}

/** doc / sessionDoc 源提取：只读贡献插件自己公开文档的安全顶层字段，逐项边界校验。 */
export function extractCompletionItems(docValue: unknown, itemsField: string): ExtractedItems {
  if (docValue === undefined || docValue === null) return { items: null }
  if (typeof docValue !== 'object' || Array.isArray(docValue)) {
    return { items: null, error: '文档值不是对象' }
  }
  const raw = (docValue as Record<string, unknown>)[itemsField]
  if (raw === undefined || raw === null) return { items: null, error: `文档缺少数组字段 ${itemsField}` }
  if (!Array.isArray(raw)) return { items: null, error: `文档缺少数组字段 ${itemsField}` }
  const items: ComposerCompletionItem[] = []
  let dropped = 0
  for (const entry of raw) {
    const item = validateCompletionItem(entry)
    if (item !== null) items.push(item)
    else dropped++
  }
  return { items, error: dropped > 0 ? `已丢弃 ${dropped} 个非法候选` : undefined }
}

/** action 源返回解析：ComposerCompletionResult { items } 逐项校验。 */
export function parseCompletionActionResult(result: unknown): ExtractedItems {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { items: null, error: '补全动作返回格式无效' }
  }
  const items = (result as Record<string, unknown>)['items']
  if (!Array.isArray(items)) return { items: null, error: '补全动作返回缺少 items 数组' }
  const valid: ComposerCompletionItem[] = []
  let dropped = 0
  for (const entry of items) {
    const item = validateCompletionItem(entry)
    if (item !== null) valid.push(item)
    else dropped++
  }
  return { items: valid, error: dropped > 0 ? `已丢弃 ${dropped} 个非法候选` : undefined }
}

/** action 源调用前置核对：真实 manifest 存在且声明 idempotent:true（幂等只读才可作补全源）。 */
export function verifyCompletionActionManifest(
  actions: ReadonlyArray<ActionManifest> | undefined,
  pluginId: string,
  actionId: string,
): string | null {
  const manifest = (actions ?? []).find((a) => a.pluginId === pluginId && a.id === actionId)
  if (manifest === undefined) return `动作 ${pluginId}/${actionId} 未注册或插件已停用`
  if (manifest.idempotent !== true) return `动作 ${pluginId}/${actionId} 未声明 idempotent，禁止作为补全源`
  return null
}

/** 空格分词 AND 过滤（大小写不敏感，中文 includes 友好）；空查询原样返回。
 * 候选 label 常带触发符前缀（#标签），而查询已剥离触发符（词）；
 * 因此每词同时匹配原串与剥前缀后的串，避免“#词”查不到“#标签”。 */
export function filterByQuery(
  items: ReadonlyArray<ComposerCompletionItem>,
  query: string,
): ComposerCompletionItem[] {
  const raw = query.toLowerCase().split(/\s+/).filter((t) => t !== '')
  if (raw.length === 0) return [...items]
  // 每个词剥去首部触发符（可能随粘贴混入），两形态任一命中即通过。
  const terms = raw.flatMap((term) => {
    const stripped = term.replace(/^[@#:\/]+/, '')
    return stripped === '' || stripped === term ? [term] : [term, stripped]
  })
  return items.filter((item) => {
    const haystack = `${item.label}\n${item.id}\n${item.hint ?? ''}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

export interface MergedCompletionItem {
  /** `${pluginId}\u0000${item.id}`：插件 + 源命名空间内去重的稳定键。 */
  key: string
  item: ComposerCompletionItem
}

/** 按源顺序合并候选：跨插件同 id 不去重（命名空间隔离），超 limit 截断并如实报告。 */
export function mergeCompletionItems(
  groups: ReadonlyArray<{ pluginId: string; items: ReadonlyArray<ComposerCompletionItem> | null }>,
  limit: number = COMPLETION_MERGE_LIMIT,
): { items: MergedCompletionItem[]; total: number; truncated: boolean } {
  const seen = new Set<string>()
  const out: MergedCompletionItem[] = []
  for (const group of groups) {
    if (group.items === null) continue
    for (const item of group.items) {
      const key = `${group.pluginId}\u0000${item.id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (out.length < limit) out.push({ key, item })
    }
  }
  return { items: out, total: seen.size, truncated: seen.size > limit }
}
