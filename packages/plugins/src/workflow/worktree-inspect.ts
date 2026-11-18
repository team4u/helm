/**
 * 受管 worktree 只读检视与 resume 续接校验：
 * - `inspectWorktree`：登记元数据 + 目标节点真实只读 git 状态/统计/受限 diff 预览（固定 `--no-ext-diff --no-textconv` 且全量脱敏）；
 * - `verifyWorktreeForResume`：续接前经节点真实 fs + git 探测校验工作树仍在（探测失败与目录缺失显式区分）；
 * - `ownerMismatchError`：归属校验拒绝错误构造（`force` 不可越过）。
 */
import { HelmError } from '@helm/protocol'
import type { WorktreeInspectResult } from '../contracts.js'
import {
  countUnmergedCommits,
  dirExistsOnNode,
  gitExec,
  resolveMergeReferenceHead,
  resolveRepoAuthority,
  type GitCapture,
  type GitOkResult,
  type WorktreeNodePorts,
} from './worktree-git.js'
import type { ManagedWorktreeRecord, WorktreeStore } from './worktree-store.js'

export type { WorktreeInspectResult }

export interface WorktreeInspectInput {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
  diff?: boolean
  signal?: AbortSignal
}

const INSPECT_DIRTY_FILES_LIMIT = 200
const INSPECT_DIFF_PREVIEW_LIMIT = 16_384
const INSPECT_DIFF_STAT_LIMIT = 4_096
const INSPECT_PROBE_LIMIT = 4_096
const INSPECT_ERROR_DIAGNOSTIC_LIMIT = 2_000

export async function inspectWorktree(
  ports: WorktreeNodePorts,
  store: WorktreeStore,
  redact: (text: string) => string,
  input: WorktreeInspectInput,
  signal?: AbortSignal,
): Promise<WorktreeInspectResult> {
  const record = store.resolveRecord(input, 'inspect')
  const diffBase: WorktreeInspectResult['diffBase'] = record.baseCommit !== '' ? 'baseCommit' : 'HEAD'
  const metadata: Pick<WorktreeInspectResult, 'record' | 'diffBase'> = { record, diffBase }
  if (record.status === 'removed') {
    return {
      ...metadata,
      exists: false,
      unavailableReason: 'removed',
      dirtyFiles: [],
      dirtyFileCount: 0,
      dirtyFilesTruncated: false,
      diffTruncated: false,
    }
  }
  if (!(await dirExistsOnNode(ports, record.nodeId, record.path))) {
    return {
      ...metadata,
      exists: false,
      unavailableReason: 'directory_missing',
      dirtyFiles: [],
      dirtyFileCount: 0,
      dirtyFilesTruncated: false,
      diffTruncated: false,
    }
  }

  const run = async (args: readonly string[], capture?: GitCapture): Promise<GitOkResult> => {
    const result = await gitExec(ports, record.nodeId, record.path, ['-C', record.path, ...args], signal, capture)
    if (!result.ok) {
      const diagnostic = result.output.trim().slice(0, INSPECT_ERROR_DIAGNOSTIC_LIMIT)
      const cut =
        result.output.trim().length > INSPECT_ERROR_DIAGNOSTIC_LIMIT || result.truncated
          ? '…（诊断已截断）'
          : ''
      throw new HelmError(
        'worktree_check_failed',
        `无法在节点 ${record.nodeId} 只读检视 worktree '${record.path}'（git ${args[0]} 失败，检视中止）：\n${diagnostic}${cut}`,
        502,
        { worktreeId: record.id, path: record.path, nodeId: record.nodeId, output: result.output.slice(0, INSPECT_ERROR_DIAGNOSTIC_LIMIT) },
      )
    }
    return result
  }

  const probe = async (args: readonly string[]): Promise<string> => {
    const result = await run(args, { kind: 'chars', limit: INSPECT_PROBE_LIMIT })
    if (result.truncated) {
      throw new HelmError(
        'worktree_check_failed',
        `检视探测命令 git ${args.join(' ')} 输出超出采集上限（${INSPECT_PROBE_LIMIT} 字符），结果不可信，检视中止`,
        502,
        { worktreeId: record.id, path: record.path, nodeId: record.nodeId },
      )
    }
    return result.output.trim()
  }

  const branch = await probe(['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = await probe(['rev-parse', 'HEAD'])
  const statusResult = await run(['status', '--porcelain', '--untracked-files=all'], {
    kind: 'lines',
    maxLines: INSPECT_DIRTY_FILES_LIMIT,
  })

  let commitsAhead: number | undefined
  if (record.baseCommit !== '') {
    const aheadRaw = await probe(['rev-list', '--count', `${record.baseCommit}..${head}`])
    const ahead = Number.parseInt(aheadRaw, 10)
    if (!Number.isFinite(ahead)) {
      throw new HelmError(
        'worktree_check_failed',
        `检视无法解析领先提交数（git rev-list --count 输出 ${JSON.stringify(redact(aheadRaw))}，检视中止）`,
        502,
        { worktreeId: record.id, path: record.path, nodeId: record.nodeId },
      )
    }
    commitsAhead = ahead
  }

  const repoProbeDir = record.repoRoot !== '' ? record.repoRoot : record.path
  const authority = await resolveRepoAuthority(ports, record.nodeId, repoProbeDir, signal)
  const referenceHead = await resolveMergeReferenceHead(
    ports,
    record.nodeId,
    authority.mainPath,
    authority.entries[0]!.head,
    undefined,
    record.baseBranch,
    signal,
  )
  const targetRef = branch !== '' && branch !== 'HEAD' ? branch : head
  const unmergedCommits = await countUnmergedCommits(
    ports,
    record.nodeId,
    authority.mainPath,
    referenceHead,
    targetRef,
    signal,
  )

  const diffRef = record.baseCommit !== '' ? record.baseCommit : 'HEAD'
  const statResult = await run(['diff', '--no-ext-diff', '--no-textconv', '--stat', diffRef], {
    kind: 'chars',
    limit: INSPECT_DIFF_STAT_LIMIT,
  })
  let diffStat: string | undefined
  const statText = statResult.output.trim()
  if (statText !== '') {
    diffStat =
      redact(statText) +
      (statResult.truncated ? `\n…（diff 统计超出检视上限 ${INSPECT_DIFF_STAT_LIMIT} 字符已截断，非完整统计）` : '')
  }

  let diffPreview: string | undefined
  let diffTruncated = false
  if (input.diff !== false) {
    const diffResult = await run(['diff', '--no-ext-diff', '--no-textconv', diffRef], {
      kind: 'chars',
      limit: INSPECT_DIFF_PREVIEW_LIMIT,
    })
    diffTruncated = diffResult.truncated
    diffPreview = diffResult.output === '' ? undefined : redact(diffResult.output)
  }

  return {
    ...metadata,
    exists: true,
    currentBranch: redact(branch),
    currentHead: redact(head),
    ...(branch !== record.branch ? { branchChanged: true } : {}),
    dirtyFiles: statusResult.lines.map((line) => redact(line)),
    dirtyFileCount: statusResult.totalNonEmptyLines,
    dirtyFilesTruncated: statusResult.truncated,
    ...(commitsAhead !== undefined ? { commitsAhead } : {}),
    unmergedCommits,
    ...(diffStat !== undefined ? { diffStat } : {}),
    ...(diffPreview !== undefined ? { diffPreview } : {}),
    diffTruncated,
  }
}

export async function verifyWorktreeForResume(
  ports: WorktreeNodePorts,
  record: ManagedWorktreeRecord,
  explicitCwd?: string,
  signal?: AbortSignal,
): Promise<ManagedWorktreeRecord> {
  if (explicitCwd !== undefined && explicitCwd !== record.path) {
    throw new HelmError(
      'resume_cwd_conflict',
      `子会话已绑定隔离 worktree '${record.path}'，不支持在 resume 时改写 cwd 为 '${explicitCwd}'`,
      409,
      { existingCwd: record.path, requestedCwd: explicitCwd },
    )
  }
  if (record.status === 'removed') {
    throw new HelmError(
      'worktree_missing',
      `子会话绑定的隔离 worktree '${record.path}' 已被清理（branch: ${record.branch}）`,
      409,
      { path: record.path, branch: record.branch },
    )
  }
  if (!(await dirExistsOnNode(ports, record.nodeId, record.path))) {
    throw new HelmError(
      'worktree_missing',
      `子会话绑定的隔离 worktree '${record.path}'（节点 ${record.nodeId}）目录已不存在（节点真实 fs 探测证实）`,
      409,
      { path: record.path, branch: record.branch, nodeId: record.nodeId },
    )
  }
  const probe = await gitExec(
    ports,
    record.nodeId,
    record.path,
    ['-C', record.path, 'rev-parse', '--is-inside-work-tree'],
    signal,
  )
  if (!probe.ok) {
    throw new HelmError(
      'worktree_check_failed',
      `无法确认 worktree '${record.path}'（节点 ${record.nodeId}）仍是 Git 工作树（不当作缺失，续接中止）：\n${probe.output.trim()}`,
      502,
      { path: record.path, branch: record.branch, nodeId: record.nodeId, output: probe.output.slice(0, 2000) },
    )
  }
  if (probe.output.trim() !== 'true') {
    throw new HelmError(
      'worktree_missing',
      `子会话绑定的隔离 worktree '${record.path}'（节点 ${record.nodeId}）已不是 Git 工作树（可能已被替换）`,
      409,
      { path: record.path, branch: record.branch, nodeId: record.nodeId },
    )
  }
  return record
}

export function ownerMismatchError(
  record: ManagedWorktreeRecord,
  reason: string,
  detail: string,
  extra?: Record<string, unknown>,
): HelmError {
  return new HelmError(
    'worktree_owner_mismatch',
    `受管 worktree '${record.path}'（节点 ${record.nodeId}）${detail}（reason: ${reason}）：登记路径上的工作树已不归属本记录，拒绝清理（force 也不可越过归属校验）`,
    409,
    { path: record.path, branch: record.branch, nodeId: record.nodeId, reason, ...extra },
  )
}
