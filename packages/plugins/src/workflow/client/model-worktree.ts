/**
 * builtin:workflow 插件 client 纯逻辑：受管工作树只读检视（inspect_worktree
 * 动作结果的宽松解析与视图模型、inspect/cleanup 动作选择器与审阅请求文案；
 * 零 React/DOM 依赖）。
 */
import { firstLineOf, inspectString } from './model-format.ts'

// ---------------------------------------------------------------------------
// 受管工作树只读检视（inspect_worktree 动作结果的宽松解析与视图模型）
// ---------------------------------------------------------------------------

/** inspect_worktree 动作结果的只读视图（非法形状解析为 undefined，不猜测）。 */
export interface WorktreeInspectView {
  worktreeId: string
  nodeId: string
  path: string
  branch: string
  baseCommit: string
  status: string
  origin: string
  exists: boolean
  unavailableReason?: string
  currentBranch?: string
  currentHead?: string
  branchChanged?: boolean
  dirtyFiles: string[]
  dirtyFileCount: number
  dirtyFilesTruncated: boolean
  commitsAhead?: number
  diffStat?: string
  diffPreview?: string
  diffTruncated: boolean
  diffBase: string
}

/** 非负安全整数（计数类字段类型边界）。 */
function inspectCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * 宽松解析 inspect_worktree 动作结果（结构非法返回 undefined，不伪造）。
 *
 * 边界收紧：exists / dirtyFiles（纯 string[]）/ dirtyFileCount（非负安全整数，
 * 不再回退数组长度）/ dirtyFilesTruncated / diffTruncated（boolean）/ diffBase
 * （枚举）与 record 核心字段均为必需且类型正确；可选字段（unavailableReason /
 * status / origin / commitsAhead 等）出现非法取值同样整体拒绝。缺字段或类型
 * 错位的响应绝不降级显示成「已清理 / 无变更」，一律 undefined 拒收。
 * 一致性不变式：未截断时 dirtyFileCount === dirtyFiles.length；截断时计数大于列表长度。
 */
export function parseWorktreeInspectResult(raw: unknown): WorktreeInspectView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const result = raw as Record<string, unknown>
  const record = result['record']
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return undefined
  const rec = record as Record<string, unknown>
  const worktreeId = inspectString(rec, 'id')
  const path = inspectString(rec, 'path')
  const branch = inspectString(rec, 'branch')
  const nodeId = inspectString(rec, 'nodeId')
  if (worktreeId === undefined || path === undefined || branch === undefined || nodeId === undefined) return undefined
  const baseCommit = rec['baseCommit']
  if (baseCommit !== undefined && typeof baseCommit !== 'string') return undefined
  const status = rec['status'] ?? 'active'
  if (status !== 'active' && status !== 'removed') return undefined
  const origin = rec['origin'] ?? 'native'
  if (origin !== 'native' && origin !== 'external') return undefined
  if (typeof result['exists'] !== 'boolean') return undefined
  const dirtyFilesRaw = result['dirtyFiles']
  if (!Array.isArray(dirtyFilesRaw) || dirtyFilesRaw.some((l) => typeof l !== 'string')) return undefined
  const dirtyFiles = dirtyFilesRaw as string[]
  if (!inspectCount(result['dirtyFileCount'])) return undefined
  const dirtyFileCount: number = result['dirtyFileCount']
  if (typeof result['dirtyFilesTruncated'] !== 'boolean') return undefined
  const dirtyFilesTruncated: boolean = result['dirtyFilesTruncated']
  if (typeof result['diffTruncated'] !== 'boolean') return undefined
  const diffBase = result['diffBase']
  if (diffBase !== 'baseCommit' && diffBase !== 'HEAD') return undefined
  if (dirtyFilesTruncated ? dirtyFileCount <= dirtyFiles.length : dirtyFileCount !== dirtyFiles.length) return undefined
  const unavailableReason = inspectString(result, 'unavailableReason')
  if (unavailableReason !== undefined && unavailableReason !== 'removed' && unavailableReason !== 'directory_missing') {
    return undefined
  }
  const currentBranch = inspectString(result, 'currentBranch')
  const currentHead = inspectString(result, 'currentHead')
  if (result['branchChanged'] !== undefined && typeof result['branchChanged'] !== 'boolean') return undefined
  const commitsAhead = result['commitsAhead']
  if (commitsAhead !== undefined && !inspectCount(commitsAhead)) return undefined
  const diffStat = inspectString(result, 'diffStat')
  const diffPreview = inspectString(result, 'diffPreview')
  return {
    worktreeId,
    nodeId,
    path,
    branch,
    baseCommit: baseCommit ?? '',
    status,
    origin,
    exists: result['exists'],
    ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    ...(currentBranch !== undefined ? { currentBranch } : {}),
    ...(currentHead !== undefined ? { currentHead } : {}),
    ...(result['branchChanged'] === true ? { branchChanged: true } : {}),
    dirtyFiles,
    dirtyFileCount,
    dirtyFilesTruncated,
    ...(commitsAhead !== undefined ? { commitsAhead } : {}),
    ...(diffStat !== undefined ? { diffStat } : {}),
    ...(diffPreview !== undefined ? { diffPreview } : {}),
    diffTruncated: result['diffTruncated'],
    diffBase,
  }
}

/**
 * 构建 worktree 动作（inspect_worktree / cleanup_worktree）调用选择器：
 * 优先受管登记 ID（精确）；无 ID 时退化 path（+nodeId 消歧，避免跨节点
 * 同名路径误满）。仅作用于已登记 worktree，绝不携带任意目录。
 */
export function buildWorktreeSelector(
  worktree: { id?: string; path: string },
  nodeId?: string,
): { worktreeId: string } | { path: string; nodeId?: string } {
  const id = worktree.id?.trim()
  if (id !== undefined && id !== '') return { worktreeId: id }
  return { path: worktree.path, ...(nodeId !== undefined && nodeId !== '' ? { nodeId } : {}) }
}

/** 「让主会话审阅并合入」请求文案：只含登记元数据与只读检视统计，不含执行指令伪装。 */
export function buildWorktreeReviewRequest(input: {
  path: string
  branch: string
  nodeId?: string
  baseCommit?: string
  taskLabel?: string
  inspect?: WorktreeInspectView
}): string {
  const lines: string[] = ['请审阅并合入以下受管工作树的改动（数据来自只读检视，实际内容请在目标节点以 git 复核）：']
  lines.push(`- 工作树：${input.path}${input.nodeId !== undefined && input.nodeId !== '' ? `（节点 ${input.nodeId}）` : ''}`)
  lines.push(`- 分支：${input.branch}${input.baseCommit !== undefined && input.baseCommit !== '' ? `（基于提交 ${input.baseCommit.slice(0, 12)}）` : ''}`)
  if (input.taskLabel !== undefined && input.taskLabel.trim() !== '') lines.push(`- 任务：${firstLineOf(input.taskLabel, 80)}`)
  const inspect = input.inspect
  if (inspect !== undefined) {
    if (!inspect.exists) {
      lines.push(`- 检视：目录${inspect.unavailableReason === 'removed' ? '登记已清理' : '不存在'}，无可检视改动`)
    } else {
      lines.push(`- 未提交修改：${inspect.dirtyFileCount} 个文件`)
      if (inspect.commitsAhead !== undefined) lines.push(`- 领先基线提交：${inspect.commitsAhead} 个`)
      if (inspect.branchChanged === true && inspect.currentBranch !== undefined) {
        lines.push(`- 注意：工作树当前分支 ${inspect.currentBranch} 与登记分支不一致，可能已被改签，请先核实归属`)
      }
    }
  }
  lines.push('请先只读复核（git diff / status），确认后合入主工作树；需要丢弃或清理工作树时请明确说明，不要静默 force 清理。')
  return lines.join('\n')
}
