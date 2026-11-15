/**
 * 受管 worktree 只读检视与 resume 续接校验（worktree.ts 拆分模块，
 * WorktreeAllocator 机制层；总体诚实性纪律见 worktree.ts 模块头）。
 *
 * - `inspectWorktree`：只读检视面——登记元数据 + 目标节点真实 git 只读命令
 *   的状态/统计/有上限 diff 预览；仅登记记录可检视，命令固定白名单
 *   `git -C <登记路径>`，不接受任意目录；采集阶段即受限（绝不无限聚合内存；
 *   状态行保留真实总数计数），diff 固定 --no-ext-diff --no-textconv（绝不
 *   触发用户自定义驱动）且仅覆盖 tracked 改动；成功返回的文本与错误诊断
 *   同样经 redact 脱敏；
 * - `verifyWorktreeForResume`：resume 续接前经节点真实 fs 探测 + git 探测
 *   校验 worktree 仍在（探测失败与目录缺失显式区分，绝不把节点离线/权限/
 *   超时当作缺失）；
 * - `ownerMismatchError`：归属不匹配的显式拒绝错误构造（由 worktree-cleanup.ts
 *   消费；force 也不可越过归属校验）。
 */
import { HelmError } from '@helm/protocol'
import {
  dirExistsOnNode,
  gitExec,
  type GitCapture,
  type GitOkResult,
  type WorktreeNodePorts,
} from './worktree-git.js'
import type { ManagedWorktreeRecord, WorktreeStore } from './worktree-store.js'

/** 只读检视选择器（与 CleanupInput 同款互斥规则；仅登记记录可检视）。 */
export interface WorktreeInspectInput {
  /** 受管 worktree 登记 ID（`${nodeId}:${path}`；与 conversationId/path 互斥）。 */
  worktreeId?: string
  conversationId?: number
  /** worktree 绝对路径（多节点同名路径时必须另附 nodeId 消歧）。 */
  path?: string
  /** 目标节点 ID（仅可与 path 搭配）。 */
  nodeId?: string
  /** 是否包含 diff 预览（默认包含；登记元数据与统计始终返回）。 */
  diff?: boolean
  signal?: AbortSignal
}

/** 只读检视结果：登记元数据 + 节点真实 git 只读探测（全部有上限）。 */
export interface WorktreeInspectResult {
  /** 登记元数据（与持久记录同构；含已 removed 记录）。 */
  record: ManagedWorktreeRecord
  /** 节点真实 fs 探测：目录是否仍存在（探测失败显式抛错，绝不猜）。 */
  exists: boolean
  /** 无法执行 git 探测的显式原因（登记已清理 / 目录缺失）。 */
  unavailableReason?: 'removed' | 'directory_missing'
  /** 权威当前分支（`git rev-parse --abbrev-ref HEAD`）。 */
  currentBranch?: string
  currentHead?: string
  /** 权威分支与登记分支不一致（工作树可能已被改签/替换）。 */
  branchChanged?: boolean
  /** 未提交/未跟踪文件行（`git status --porcelain` 原行——保留 XY 首列状态码；上限截断）。 */
  dirtyFiles: string[]
  /** 非空状态行真实总数（不因 dirtyFiles 保留上限截断而失真）。 */
  dirtyFileCount: number
  dirtyFilesTruncated: boolean
  /** 相对登记 baseCommit 的领先提交数（external 记录无 baseCommit 时缺省）。 */
  commitsAhead?: number
  /** diff 统计摘要（`git diff --stat <base>`；超出采集上限时末尾附截断说明，非完整统计）。 */
  diffStat?: string
  /** diff 预览（有上限截断；仅覆盖 tracked 改动，untracked 文件内容不进 diff、仍完整见于 dirtyFiles）。 */
  diffPreview?: string
  diffTruncated: boolean
  /** diff 基线：登记 baseCommit，或 external 记录退化用的 HEAD。 */
  diffBase: 'baseCommit' | 'HEAD'
}

/** inspect 未提交文件行上限（超出截断，dirtyFileCount 保留真实计数）。 */
const INSPECT_DIRTY_FILES_LIMIT = 200
/** inspect diff 预览字符上限（超出截断并标记 diffTruncated）。 */
const INSPECT_DIFF_PREVIEW_LIMIT = 16_384
/** inspect diff 统计摘要字符上限（超出时末尾附截断说明，不假装完整）。 */
const INSPECT_DIFF_STAT_LIMIT = 4_096
/** inspect 短探测命令（rev-parse/rev-list）输出上限（截断即显式失败，不把残缺哈希/计数当真值）。 */
const INSPECT_PROBE_LIMIT = 4_096
/** inspect git 失败诊断进入错误消息的字符上限（details.output 同限）。 */
const INSPECT_ERROR_DIAGNOSTIC_LIMIT = 2_000

  /**
   * 只读检视一个受管 worktree：登记元数据 + 在目标节点真实执行的 git 只读
   * 命令（全部 `git -C <登记路径>`，命令固定白名单，不接受任意目录/cwd）。
   * - 目录存在性仅由节点真实 fs 探测证明；探测失败 fail closed 抛
   *   worktree_check_failed（节点离线/权限/超时不当作缺失）；
   * - 已 removed 登记或目录缺失：返回元数据 + unavailableReason，不跑 git；
   * - git 命令失败（非零退出/超时）显式 worktree_check_failed 并附截断的
   *   真实输出诊断（经 redact 脱敏）；绝不伪造空统计、绝不当作成功；
   * - 受限采集：diff 预览/统计/状态清单在 onOutput 阶段即限内存（不完整
   *   聚合后 slice）；diff 超上限置 diffTruncated、统计末尾附截断说明，
   *   状态行保留 XY 首列原行且 dirtyFileCount 始终为真实总数；
   * - diff 固定 `--no-ext-diff --no-textconv`（受管只读检视绝不触发用户
   *   自定义 diff/textconv 驱动）；仅覆盖 tracked 改动（基线为登记
   *   baseCommit，external 记录退化 HEAD；基线失效显式报错、无 fallback），
   *   untracked 文件内容不进 diff、仍完整见于 dirtyFiles/dirtyFileCount；
   * - 成功返回的分支/哈希/状态行/diff 文本与错误诊断同样经 redact 脱敏
   *   （与项目既有机密约定一致，不因检视面绕过）。
   */
export async function inspectWorktree(
  ports: WorktreeNodePorts,
  store: WorktreeStore,
  redact: (text: string) => string,
  input: WorktreeInspectInput,
  signal?: AbortSignal,
): Promise<WorktreeInspectResult> {
  if (input.worktreeId === undefined && input.conversationId === undefined && input.path === undefined) {
    throw new HelmError('validation_error', 'inspect 需提供 worktreeId、conversationId 或 path 之一', 400)
  }
  if (input.worktreeId !== undefined && (input.conversationId !== undefined || input.path !== undefined)) {
    throw new HelmError('validation_error', 'worktreeId 与 conversationId/path 互斥（worktreeId 单独使用）', 400)
  }
  if (input.nodeId !== undefined && input.path === undefined) {
    throw new HelmError('validation_error', 'nodeId 仅可与 path 搭配使用（跨节点同名路径消歧）', 400)
  }
  if (input.conversationId !== undefined && input.path !== undefined) {
    throw new HelmError('validation_error', 'conversationId 与 path 择一提供', 400)
  }

  const record = store.resolveInspectRecord(input)
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
  /** 短探测命令（rev-parse/rev-list）取完整输出：受限采集下截断即显式失败，绝不把残缺哈希/计数当真值。 */
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
  // 状态清单：流式按行受限采集——保留前 200 条原行（含 XY 首列，不 trim），
  // 非空行总数为真实值（不因保留上限截断而失真 dirtyFileCount）。
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
  const diffRef = record.baseCommit !== '' ? record.baseCommit : 'HEAD'
  // diff 固定禁用外部 diff 驱动与 textconv 过滤器（受管只读检视绝不触发
  // 用户自定义驱动）；仅覆盖 tracked 改动，untracked 内容不进 diff。
  const statResult = await run(['diff', '--no-ext-diff', '--no-textconv', '--stat', diffRef], {
    kind: 'chars',
    limit: INSPECT_DIFF_STAT_LIMIT,
  })
  let diffStat: string | undefined
  const statText = statResult.output.trim()
  if (statText !== '') {
    // 统计被采集上限截断时末尾附文字说明，不假装完整统计。
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
    ...(diffStat !== undefined ? { diffStat } : {}),
    ...(diffPreview !== undefined ? { diffPreview } : {}),
    diffTruncated,
  }
}

  /**
   * resume 续接校验：cwd 冲突显式拒绝（不中途搬家）；记录已清理或目录缺失
   * 显式 worktree_missing（目录缺失经节点真实 fs stat 证明；节点离线/
   * 权限/超时等探测失败显式 worktree_check_failed，绝不当作缺失）。
   */
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

  /** 归属不匹配的显式拒绝（登记路径上的工作树已被替换/挪用，force 也不可越过）。 */
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
