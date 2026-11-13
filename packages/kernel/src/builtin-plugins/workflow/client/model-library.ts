/**
 * builtin:workflow 插件 client 纯逻辑：工作流库（list/get/save 动作结果的
 * 严格解析、库运行 args 严格解析与「让 AI 修改」请求文案；零 React/DOM 依赖）。
 */
import type { WorkflowRunSummary } from '@helm/protocol'
import { firstLineOf, inspectString } from './model-format.ts'

// ---------------------------------------------------------------------------
// 工作流库（list/get/save 动作结果的严格解析与 args 严格解析）
// ---------------------------------------------------------------------------

/** 已保存工作流条目视图（与 SavedWorkflowSummary 同构；严格解析）。 */
export interface SavedWorkflowView {
  name: string
  path?: string
  /** 定义文件最后修改时间（epoch ms）。 */
  updatedAt: number
  /** 定义文件字节数。 */
  size: number
  metadataError?: string
  description?: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

/** get 动作返回的完整定义视图（含只读源码）。 */
export interface SavedWorkflowDetailView extends SavedWorkflowView {
  script: string
}

/** 非负安全整数校验（文件事实字段类型边界）。 */
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 条目解析：条目非对象、缺 name、updatedAt/size 非非负安全整数、phases 非法时 undefined。 */
function parseSavedWorkflowEntry(item: unknown): SavedWorkflowView | undefined {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
  const record = item as Record<string, unknown>
  const name = inspectString(record, 'name')
  if (name === undefined) return undefined
  if (!nonNegativeInteger(record['updatedAt'])) return undefined
  if (!nonNegativeInteger(record['size'])) return undefined
  let phases: Array<{ title: string; detail?: string; model?: string }> | undefined
  const phasesRaw = record['phases']
  if (phasesRaw !== undefined) {
    if (!Array.isArray(phasesRaw)) return undefined
    const parsedPhases: Array<{ title: string; detail?: string; model?: string }> = []
    for (const p of phasesRaw) {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) return undefined
      const phase = p as Record<string, unknown>
      const title = inspectString(phase, 'title')
      if (title === undefined) return undefined
      const detail = inspectString(phase, 'detail')
      const model = inspectString(phase, 'model')
      parsedPhases.push({
        title,
        ...(detail !== undefined ? { detail } : {}),
        ...(model !== undefined ? { model } : {}),
      })
    }
    phases = parsedPhases.length > 0 ? parsedPhases : undefined
  }
  return {
    name,
    updatedAt: record['updatedAt'],
    size: record['size'],
    ...(inspectString(record, 'path') !== undefined ? { path: inspectString(record, 'path') } : {}),
    ...(inspectString(record, 'metadataError') !== undefined ? { metadataError: inspectString(record, 'metadataError') } : {}),
    ...(inspectString(record, 'description') !== undefined ? { description: inspectString(record, 'description') } : {}),
    ...(inspectString(record, 'whenToUse') !== undefined ? { whenToUse: inspectString(record, 'whenToUse') } : {}),
    ...(phases !== undefined ? { phases } : {}),
  }
}

/**
 * 严格解析 list 动作结果（非法形状返回 undefined，不伪造列表）。
 *
 * 边界收紧：条目非对象、缺 name、updatedAt/size 缺失或非非负安全整数、
 * phases 非数组或含非法阶段项时整体返回 undefined——不把异常条目静默丢弃
 * 成看似完整的列表（缺项列表会误导用户以为目录里只有这些工作流）。
 */
export function parseSavedWorkflowList(raw: unknown): SavedWorkflowView[] | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const workflows = (raw as Record<string, unknown>)['workflows']
  if (!Array.isArray(workflows)) return undefined
  const out: SavedWorkflowView[] = []
  for (const item of workflows) {
    const entry = parseSavedWorkflowEntry(item)
    if (entry === undefined) return undefined
    out.push(entry)
  }
  return out
}

/**
 * 严格解析 get 动作结果（结构非法返回 undefined，不猜测）：workflow 必需且
 * 含非空 script（只读源码）；其余字段与列表条目同标准。
 */
export function parseWorkflowDetail(raw: unknown): SavedWorkflowDetailView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const workflow = (raw as Record<string, unknown>)['workflow']
  const entry = parseSavedWorkflowEntry(workflow)
  if (entry === undefined) return undefined
  const script = (workflow as Record<string, unknown>)['script']
  if (typeof script !== 'string' || script === '') return undefined
  return { ...entry, script }
}

/** 严格解析 save 动作结果：created 必需 boolean，workflow 必需合法摘要。 */
export function parseWorkflowSaveResult(raw: unknown): { created: boolean; workflow: SavedWorkflowView } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record['created'] !== 'boolean') return undefined
  const workflow = parseSavedWorkflowEntry(record['workflow'])
  if (workflow === undefined) return undefined
  return { created: record['created'], workflow }
}

/** 内联 run 一键保存为工作流定义的可用判定：非 subagent 且未按已保存定义发起。 */
export function canSaveRunAsWorkflow(run: Pick<WorkflowRunSummary, 'kind' | 'savedName'>): boolean {
  return run.kind !== 'subagent' && run.savedName === undefined
}

/** 「让 AI 修改」请求文案：只描述目标与能力入口，不在 Web 内伪造编辑。 */
export function buildWorkflowEditRequest(name: string, detail?: { description?: string }): string {
  const lines = [
    `请修改已保存工作流 ${name}（跨会话可复用资产）：`,
    '- 先用 workflow get 动作（或 helm workflows get ' + name + ' --json）读取当前源码与元数据；',
    '- 按需求修改后用 workflow save 动作（helm workflows save <文件或源码> --name ' + name + ' --overwrite）写回；保存前校验会自动做语法预检，默认拒绝覆盖、需显式 overwrite；',
    detail?.description !== undefined ? `- 当前描述：${firstLineOf(detail.description, 120)}` : undefined,
    '- 修改完成后告诉我保存结果与变化点，不要静默改动。',
  ].filter((line): line is string => line !== undefined)
  return lines.join('\n')
}

/** 库运行 args 输入严格解析：空串无 args；非空必须为合法 JSON（绝不静默当字符串透传）。 */
export function parseWorkflowArgsInput(text: string): { ok: true; args?: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true }
  try {
    return { ok: true, args: JSON.parse(trimmed) as unknown }
  } catch (error) {
    return { ok: false, error: `args 需为合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
}
