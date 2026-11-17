/**
 * Pure logic for the builtin:workflow client: managed worktree read-only
 * inspection (lenient parsing of the inspect_worktree action result into a
 * view model, inspect/cleanup action selectors and the review request copy;
 * zero React/DOM dependencies).
 */
import { DEFAULT_HELM_LOCALE, type HelmLocale } from '@helm/plugin-client'
import { firstLineOf, inspectString } from './model-format.ts'
import {
  wtReviewAheadLine,
  wtReviewBranchChanged,
  wtReviewDirtyLine,
  wtReviewInspectMissing,
  wtReviewTaskLine,
  worktreeReviewLines,
} from './copy.ts'

// ---------------------------------------------------------------------------
// Managed worktree read-only inspection (lenient parse of the inspect_worktree
// action result into a view model)
// ---------------------------------------------------------------------------

/** Read-only view of the inspect_worktree action result (invalid shapes parse to undefined, never guessed). */
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

/** Non-negative safe integer (type boundary for count-like fields). */
function inspectCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Leniently parse the inspect_worktree action result (structurally invalid
 * returns undefined, never fabricated).
 *
 * Tightened boundaries: exists / dirtyFiles (plain string[]) /
 * dirtyFileCount (non-negative safe integer, no longer falls back to the
 * array length) / dirtyFilesTruncated / diffTruncated (boolean) / diffBase
 * (enum) and the core record fields are all required and correctly typed;
 * optional fields (unavailableReason / status / origin / commitsAhead, ...)
 * with invalid values reject the whole payload too. A response with missing
 * fields or wrong types never degrades into a "cleaned up / no changes" view
 * — it is rejected as undefined. Consistency invariant: without truncation
 * dirtyFileCount === dirtyFiles.length; with truncation the count exceeds the
 * list length.
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
 * Build the worktree action (inspect_worktree / cleanup_worktree) call
 * selector: the managed registration ID wins (precise); without an ID it
 * degrades to path (+nodeId disambiguation, avoiding cross-node same-path
 * mismatches). Only acts on registered worktrees, never arbitrary directories.
 */
export function buildWorktreeSelector(
  worktree: { id?: string; path: string },
  nodeId?: string,
): { worktreeId: string } | { path: string; nodeId?: string } {
  const id = worktree.id?.trim()
  if (id !== undefined && id !== '') return { worktreeId: id }
  return { path: worktree.path, ...(nodeId !== undefined && nodeId !== '' ? { nodeId } : {}) }
}

/**
 * "Ask the main conversation to review and merge" request copy: registration
 * metadata and read-only inspection stats only — no disguised execution
 * instructions.
 */
export function buildWorktreeReviewRequest(
  input: {
    path: string
    branch: string
    nodeId?: string
    baseCommit?: string
    taskLabel?: string
    inspect?: WorktreeInspectView
  },
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  const taskLine =
    input.taskLabel !== undefined && input.taskLabel.trim() !== ''
      ? wtReviewTaskLine(firstLineOf(input.taskLabel, 80), locale)
      : undefined
  const inspect = input.inspect
  const inspectLine = inspect !== undefined
    ? (loc: HelmLocale): string[] => {
        if (!inspect.exists) {
          return [wtReviewInspectMissing(inspect.unavailableReason === 'removed', loc)]
        }
        const lines = [wtReviewDirtyLine(inspect.dirtyFileCount, loc)]
        if (inspect.commitsAhead !== undefined) lines.push(wtReviewAheadLine(inspect.commitsAhead, loc))
        if (inspect.branchChanged === true && inspect.currentBranch !== undefined) {
          lines.push(wtReviewBranchChanged(inspect.currentBranch, loc))
        }
        return lines
      }
    : undefined
  return worktreeReviewLines(
    {
      path: input.path,
      branch: input.branch,
      nodeId: input.nodeId,
      baseCommit: input.baseCommit,
      ...(taskLine !== undefined ? { taskLine } : {}),
      ...(inspectLine !== undefined ? { inspectLine } : {}),
    },
    locale,
  ).join('\n')
}
