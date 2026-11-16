/**
 * 受管 worktree 清理状态机（worktree.ts 拆分模块，WorktreeAllocator 机制层；
 * 总体诚实性纪律见 worktree.ts 模块头）。
 *
 * - `cleanupWorktree`：选择器解析已登记记录 + 占用检查 + per-repo 串行锁
 *   （锁函数经参数注入，同仓库不同 worktree 也串行）+ 锁内重读记录、权威
 *   worktree list 的 path/branch/head 归属匹配、realpath canonical 校验 +
 *   脏工作区保护（未提交修改或未合入提交且未显式 force 时拒绝；状态命令
 *   失败显式报错，绝不假成功）+ 真实 `git worktree remove` / `git branch
 *   -d|-D`（分支删除部分失败先固化 removed 事实、可重试）；目录缺失经节点
 *   真实 fs stat 证明时显式 worktree_missing 并保留登记（绝不全仓 prune
 *   他人的登记）；分支名严格校验 helm 受管前缀；
 * - `assertPathUnusedByProcesses`：删除前进程占用快照检查（force 不可绕
 *   过；只诊断与拒绝，绝不自动终止进程）。
 */
import { HelmError, type NodePathUsage } from '@helm/protocol'
import { setTimeout as delay } from 'node:timers/promises'
import {
  canonicalPathOnNode,
  countUnmergedCommits,
  deleteManagedBranch,
  dirExistsOnNode,
  gitExec,
  matchWorktreeEntry,
  normalizePathValue,
  resolveMergeReferenceHead,
  resolveRepoAuthority,
  type RepoAuthority,
} from './worktree-git.js'
import type { ManagedWorktreeRecord, WorktreeStore } from './worktree-store.js'
import { ownerMismatchError } from './worktree-inspect.js'
import type { CleanupInput, CleanupResult, WorktreeAllocatorDeps } from './worktree.js'

/** 允许清理的分支前缀（helm 受管命名空间；绝不碰人类分支）。 */
const MANAGED_BRANCH_PREFIXES = ['helm/spawn-', 'helm/wf-'] as const

  /**
   * 删除前进程占用快照检查（per-repo 锁内、真实 git worktree remove 前的
   * 最后一道屏障；force 不可绕过）。
   *
   * 完整性语义（结构性盲区与扫描异常分治）：快照 complete 由扫描方区分
   * ——可观测集合内的读取异常（同 uid PID 被拒、stat 异常等）或扫描上限
   * 触发时 complete=false；跨 uid 不可观测的进程（Linux DAC 结构性盲区，
   * 如非 root Hub 遇 root 属主进程）计入 unobservable 并在 diagnostics
   * 如实呈现，不影响 complete——与 Hub 同 uid 的进程（helm 派生的子
   * 代理/git/shell）永远可观测，保护面不受影响。
   * - 探测端口缺失 / 探测失败（节点离线、守护进程版本不支持、平台不支持、
   *   权限、超时）→ worktree_process_check_failed（不能证明 0 占用就不能
   *   删除，绝不静默跳过、绝不当作干净；force 也不可绕过）；
   * - 无命中的不完整快照最多复查两次（进程 exec/退出期间可能瞬时拒读）；
   *   只有新的完整零占用快照可放行，持续不完整仍携带 diagnostics 拒绝
   *   （盲区不触发复查——unobservable 不计入完整性判定）；
   * - 命中（cwd / 打开 fd 引用 worktree 或其子目录）→ worktree_process_in_use
   *   （409，含 PID/进程名/引用路径，路径与诊断均经 redact 脱敏；进程名
   *   与 PID 非机密）；只诊断与拒绝，绝不自动 kill/发键；命中且快照同时
   *   不完整时仍报 in_use（占用事实已成立），details 附 complete 状态。
   * 快照是删除前一次性观测而非跨进程互斥：扫描之后新启动的进程不在
   * 保护范围（并发竞争如实存在，由调用方文档口径承担）。
   */
export async function assertPathUnusedByProcesses(
  deps: Pick<WorktreeAllocatorDeps, 'inspectPathUsage'>,
  redact: (text: string) => string,
  record: ManagedWorktreeRecord,
  signal?: AbortSignal,
): Promise<void> {
  const probe = deps.inspectPathUsage
  if (probe === undefined) {
    throw new HelmError(
      'worktree_process_check_failed',
      `worktree '${record.path}'（节点 ${record.nodeId}）未装配进程占用探测端口，无法证明无进程占用，清理中止（force 也不可绕过）`,
      502,
      { worktreeId: record.id, path: redact(record.path), nodeId: record.nodeId },
    )
  }
  let usage: NodePathUsage
  try {
    usage = await probe(record.nodeId, record.path, signal)
    // /proc 的 exec/退出窗口可能短暂拒读；复查必须重新取得完整快照，
    // 不能凭重试次数、进程身份或延时把未知占用当作安全。实际命中立即拒绝。
    for (
      let attempt = 0;
      attempt < 2 && usage.complete !== true && usage.matchedTotal === 0 && usage.processes.length === 0;
      attempt += 1
    ) {
      await delay(25 * (attempt + 1), undefined, { signal })
      usage = await probe(record.nodeId, record.path, signal)
    }
  } catch (error) {
    const cause = error instanceof HelmError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error)
    throw new HelmError(
      'worktree_process_check_failed',
      `无法完成 worktree '${record.path}'（节点 ${record.nodeId}）的进程占用扫描（${redact(cause)}），不能证明 0 占用，清理中止（force 也不可绕过）`,
      502,
      { worktreeId: record.id, nodeId: record.nodeId, path: redact(record.path), cause: redact(cause) },
    )
  }
  if (usage.matchedTotal > 0 || usage.processes.length > 0) {
    const shown = usage.processes.map((p) => `${p.pid}${p.name !== undefined ? `(${p.name})` : ''}`)
    throw new HelmError(
      'worktree_process_in_use',
      `worktree '${record.path}'（节点 ${record.nodeId}）被 ${usage.matchedTotal} 个进程的工作目录或打开文件引用（${shown.join('、')}${usage.matchedTotal > shown.length ? ` 等 ${usage.matchedTotal} 个` : ''}${usage.processesTruncated ? '；清单截断' : ''}）；这是删除前快照，不会自动终止任何进程，请先在目标节点处理后再清理（force 也不可绕过）`,
      409,
      {
        worktreeId: record.id,
        path: redact(record.path),
        nodeId: record.nodeId,
        pids: usage.processes.map((p) => p.pid),
        processes: usage.processes.map((p) => ({
          pid: p.pid,
          ...(p.name !== undefined ? { name: p.name } : {}),
          source: p.source,
          path: redact(p.path),
        })),
        matchedTotal: usage.matchedTotal,
        processesTruncated: usage.processesTruncated,
        complete: usage.complete,
      },
    )
  }
  if (usage.complete !== true) {
    throw new HelmError(
      'worktree_process_check_failed',
      `worktree '${record.path}'（节点 ${record.nodeId}）的进程占用扫描不完整（${usage.diagnostics.map((d) => redact(d)).join('；') || '原因未知'}），不能证明 0 占用，清理中止（force 也不可绕过）`,
      502,
      {
        worktreeId: record.id,
        nodeId: record.nodeId,
        path: redact(record.path),
        diagnostics: usage.diagnostics.map((d) => redact(d)),
      },
    )
  }
}

/** 清理一个受管 worktree（行为契约与错误码不变，见方法内注释）。 */
export async function cleanupWorktree(
  deps: WorktreeAllocatorDeps,
  store: WorktreeStore,
  redact: (text: string) => string,
  withRepoLock: <T>(nodeId: string, canonicalCommonDir: string, fn: () => Promise<T>) => Promise<T>,
  input: CleanupInput,
): Promise<CleanupResult> {
  // 选择器校验：worktreeId 单用；conversationId/path 择一；nodeId 仅搭 path。
  if (input.worktreeId === undefined && input.conversationId === undefined && input.path === undefined) {
    throw new HelmError('validation_error', 'cleanup 需提供 worktreeId、conversationId 或 path 之一', 400)
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
  // mergedInto 严格形状校验（argv 直跑无 shell 注入面，但必须拒绝范围
  // 操作符与以 - 开头的值，防止意外解析成其他引用或选项）。
  if (input.mergedInto !== undefined) {
    if (
      typeof input.mergedInto !== 'string' ||
      input.mergedInto === '' ||
      /[\s\u0000-\u001f]/.test(input.mergedInto) ||
      input.mergedInto.includes('..') ||
      input.mergedInto.includes('~') ||
      input.mergedInto.includes('^') ||
      input.mergedInto.includes(':') ||
      input.mergedInto.startsWith('-')
    ) {
      throw new HelmError(
        'validation_error',
        `mergedInto 必须是不含空白与范围操作符（.. ~ ^ :）且不以 - 开头的非空分支/提交名`,
        400,
        { mergedInto: input.mergedInto },
      )
    }
  }

  const record = store.resolveCleanupRecord(input)
  if (!MANAGED_BRANCH_PREFIXES.some((prefix) => record.branch.startsWith(prefix))) {
    throw new HelmError(
      'validation_error',
      `受管 worktree '${record.path}' 的分支 '${record.branch}' 不在 helm 受管前缀（helm/spawn- | helm/wf-）内，拒绝清理`,
      400,
      { path: record.path, branch: record.branch },
    )
  }

  // 幂等：已清理记录直接 removed:false；分支删除曾部分失败且本次要求
  // deleteBranch 时可重试（branchDeleted 状态与诊断保留在记录上）。
  if (record.status === 'removed') {
    let branchDeleted = record.branchDeleted === true
    if (input.deleteBranch === true && !branchDeleted) {
      if (record.repoRoot === '') {
        throw new HelmError(
          'branch_delete_failed',
          `记录 ${record.id} 缺少主仓路径，无法重试删除分支 ${record.branch}（请人工核对）`,
          502,
          { worktreeId: record.id, branch: record.branch },
        )
      }
      const authority = await resolveRepoAuthority(deps, record.nodeId, record.repoRoot, input.signal)
      await withRepoLock(record.nodeId, authority.canonicalCommonDir, async () => {
        // 与主路径同规则解析「已合入」参考（显式 mergedInto 优先，不存在
        // 显式拒绝；其次 baseBranch；再主 HEAD）；确认已全部合入时统一 -D
        // 删除（参考非 main 时 git branch -d 的上游合入检查会拒绝）。
        const referenceHead = await resolveMergeReferenceHead(
          deps,
          record.nodeId,
          authority.mainPath,
          authority.entries[0]!.head,
          input.mergedInto,
          record.baseBranch,
          input.signal,
        )
        const mergedIntoReference =
          (await countUnmergedCommits(deps, record.nodeId, authority.mainPath, referenceHead, record.branch, input.signal)) === 0
        const del = await deleteManagedBranch(
          deps,
          record.nodeId,
          authority.mainPath,
          record.branch,
          input.force === true || mergedIntoReference,
          input.signal,
        )
        branchDeleted = del.deleted
        if (del.deleted) {
          store.updateRecord(record.id, (r) => {
            const { branchDeleteError: _previousError, ...clean } = r
            return { ...clean, branchDeleted: true }
          })
        } else {
          store.updateRecord(record.id, (r) => ({ ...r, branchDeleted: false, branchDeleteError: (del.failureOutput ?? '').slice(0, 2000) }))
          throw new HelmError(
            'branch_delete_failed',
            `重试删除分支 ${record.branch} 失败（登记保持 removed，可再次重试）：\n${(del.failureOutput ?? '').trim()}`,
            502,
            { worktreeId: record.id, branch: record.branch, output: (del.failureOutput ?? '').slice(0, 2000) },
          )
        }
      })
    }
    return { removed: false, worktreeId: record.id, path: record.path, branch: record.branch, nodeId: record.nodeId, branchDeleted }
  }

  // 占用检查（锁外快速失败；锁内还会以最新记录复查）。
  if (record.conversationId !== undefined && deps.isConversationWorking?.(record.conversationId) === true) {
    throw new HelmError(
      'worktree_in_use',
      `worktree '${record.path}' 关联的子代理仍在运行中，拒绝清理`,
      409,
      { path: record.path, conversationId: record.conversationId },
    )
  }
  if (deps.isPathInUse?.(record.nodeId, record.path) === true) {
    throw new HelmError(
      'worktree_in_use',
      `worktree '${record.path}'（节点 ${record.nodeId}）仍被引用，拒绝清理`,
      409,
      { path: record.path, nodeId: record.nodeId },
    )
  }

  // 目录存在性证明：仅节点真实 fs stat（或后续权威 worktree 登记）可证明
  // 缺失；探测失败 fail closed。缺失时显式 worktree_missing 并保留登记
  //（绝不全仓 prune 其他节点的登记，也绝不假成功）。
  if (!(await dirExistsOnNode(deps, record.nodeId, record.path))) {
    throw new HelmError(
      'worktree_missing',
      `受管 worktree '${record.path}'（节点 ${record.nodeId}）目录已不存在（节点真实 fs 探测证实）；登记保留，请人工核对后处理（不自动 prune）`,
      409,
      { worktreeId: record.id, path: record.path, branch: record.branch, nodeId: record.nodeId },
    )
  }

  // 权威 repo 信息（external 记录首次清理时解析并持久化主工作树）。
  let authority: RepoAuthority
  if (record.repoRoot !== '') {
    authority = await resolveRepoAuthority(deps, record.nodeId, record.repoRoot, input.signal)
  } else {
    authority = await resolveRepoAuthority(deps, record.nodeId, record.path, input.signal)
    store.assertMetadataSecretFree({ repoRoot: authority.mainPath }, { nodeId: record.nodeId, executionId: record.executionId })
    store.updateRecord(record.id, (r) => ({ ...r, repoRoot: authority.mainPath }))
  }

  let outcome: { removed: boolean; branchDeleted: boolean } | undefined
  await withRepoLock(record.nodeId, authority.canonicalCommonDir, async () => {
    // 锁内以最新记录为准（并发清理/状态变更在此收敛）。
    const fresh = store.findById(record.id)
    if (fresh === undefined) {
      throw new HelmError('not_found', `受管 worktree 记录 ${record.id} 不存在（文档状态不一致）`, 404, { id: record.id })
    }
    if (fresh.status === 'removed') {
      outcome = { removed: false, branchDeleted: fresh.branchDeleted === true }
      return
    }
    // 在用复查（锁内最新事实；force 不可越过）。
    if (fresh.conversationId !== undefined && deps.isConversationWorking?.(fresh.conversationId) === true) {
      throw new HelmError(
        'worktree_in_use',
        `worktree '${fresh.path}' 关联的子代理仍在运行中，拒绝清理`,
        409,
        { path: fresh.path, conversationId: fresh.conversationId },
      )
    }
    if (deps.isPathInUse?.(fresh.nodeId, fresh.path) === true) {
      throw new HelmError(
        'worktree_in_use',
        `worktree '${fresh.path}'（节点 ${fresh.nodeId}）仍被引用，拒绝清理`,
        409,
        { path: fresh.path, nodeId: fresh.nodeId },
      )
    }

    // 锁内重新取证权威登记，做 path/branch/head 归属匹配。
    const locked = await resolveRepoAuthority(deps, fresh.nodeId, fresh.repoRoot !== '' ? fresh.repoRoot : fresh.path, input.signal)
    const entries = locked.entries
    const mainEntry = entries[0]!
    const match = matchWorktreeEntry(entries, fresh.path)
    if (match === undefined) {
      throw ownerMismatchError(
        fresh,
        'not_in_worktree_list',
        `不在权威 worktree 登记中（目录仍存在：路径上的内容已不受本仓库管理）`,
        { registeredEntries: entries.map((e) => redact(e.path)).slice(0, 20) },
      )
    }
    if (match === mainEntry || normalizePathValue(match.path) === normalizePathValue(mainEntry.path)) {
      throw ownerMismatchError(fresh, 'main_worktree', '指向主工作树（主工作树绝不清除）', { mainPath: redact(mainEntry.path) })
    }
    if (match.locked) {
      // locked 是所有者显式加锁：force 只能越过 dirty/unmerged，不可越过。
      throw new HelmError(
        'worktree_locked',
        `worktree '${fresh.path}'（节点 ${fresh.nodeId}）已被 git worktree lock 锁定${match.lockedReason !== undefined ? `（${redact(match.lockedReason)}）` : ''}，拒绝清理（请先解锁）`,
        409,
        { worktreeId: fresh.id, path: fresh.path, nodeId: fresh.nodeId, ...(match.lockedReason !== undefined ? { lockedReason: redact(match.lockedReason) } : {}) },
      )
    }
    if (match.prunable) {
      throw ownerMismatchError(
        fresh,
        'prunable',
        `的 gitdir 链接已断（${match.prunableReason !== undefined ? redact(match.prunableReason) : 'prunable'}：登记路径上的目录可能已被替换）`,
      )
    }
    if (match.branch !== `refs/heads/${fresh.branch}`) {
      throw ownerMismatchError(
        fresh,
        'branch_changed',
        `的权威登记分支为 ${match.branch ?? (match.detached ? 'detached' : '未知')}，与登记分支 ${fresh.branch} 不一致（工作树可能已被用户替换或改签分支）`,
        { authorityBranch: redact(match.branch ?? '') },
      )
    }
    if (match.head === '' || /^0+$/.test(match.head)) {
      throw ownerMismatchError(fresh, 'head_unreadable', '的权威登记 HEAD 缺失（工作树状态不可信）', { authorityHead: match.head })
    }

    // realpath canonical 校验：登记路径不得经软链跳到主工作树或其他工作树。
    const canonicalRecord = await canonicalPathOnNode(deps, fresh.nodeId, fresh.path)
    const canonicalMain = await canonicalPathOnNode(deps, fresh.nodeId, mainEntry.path)
    if (canonicalRecord === canonicalMain) {
      throw ownerMismatchError(fresh, 'main_worktree', `经真实路径解析指向主工作树 ${redact(mainEntry.path)}`, {
        mainPath: redact(mainEntry.path),
      })
    }
    for (const other of entries) {
      if (other === match) continue
      const canonicalOther = await canonicalPathOnNode(deps, fresh.nodeId, other.path)
      if (canonicalRecord === canonicalOther) {
        throw ownerMismatchError(
          fresh,
          'symlink_redirect',
          `经真实路径解析指向其他工作树 ${redact(other.path)}（登记路径可能已被软链替换）`,
          { redirectedTo: redact(other.path) },
        )
      }
    }

    // 脏工作区保护（force=false；external 记录同样检查；合入参考优先
    // 显式 mergedInto，其次记录 baseBranch，再主工作树 HEAD——不以
    // baseCommit 缺失为由跳过）。ignored 文件也计入：实测 git worktree remove 无
    // --force 也会删除仅含 ignored 内容（.env 等）的 worktree，默认检查
    // 必须显式拦下（force 允许显式清除）。状态命令失败显式报错，绝不
    // 当作干净或目录缺失。
    let dirtyFiles: string[] = []
    let unmergedCommits = 0
    if (input.force !== true) {
      const status = await gitExec(
        deps,
        fresh.nodeId,
        fresh.path,
        ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'],
        input.signal,
      )
      if (!status.ok) {
        throw new HelmError(
          'worktree_check_failed',
          `无法确认 worktree '${fresh.path}' 的工作区状态（git status 失败；绝不当作干净或目录缺失，清理中止）：\n${status.output.trim()}`,
          502,
          { worktreeId: fresh.id, path: fresh.path, output: status.output.slice(0, 2000) },
        )
      }
      dirtyFiles = status.output
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '')
      const referenceHead = await resolveMergeReferenceHead(
        deps,
        fresh.nodeId,
        locked.mainPath,
        mainEntry.head,
        input.mergedInto,
        fresh.baseBranch,
        input.signal,
      )
      unmergedCommits = await countUnmergedCommits(deps, fresh.nodeId, locked.mainPath, referenceHead, fresh.branch, input.signal)
      if (dirtyFiles.length > 0 || unmergedCommits > 0) {
        throw new HelmError(
          'worktree_dirty',
          `worktree '${fresh.path}' (branch: ${fresh.branch}) 含未提交修改、未跟踪/被忽略文件或未合入提交（相对参考提交 ${referenceHead}）；请先检视/合入，或显式传 force: true 强制清理`,
          409,
          { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, dirtyFiles: dirtyFiles.slice(0, 200), unmergedCommits, referenceHead },
        )
      }
    }

    // 删除前进程占用快照（per-repo 锁内、真实 remove 前的最后一道屏障；
    // force 不可绕过——force 只授权丢弃文件，不授权拆除运行中进程脚下的
    // 目录）。只诊断与拒绝，绝不自动终止进程。
    await assertPathUnusedByProcesses(deps, redact, fresh, input.signal)

    // 真实移除（不 prune、不猜测缺失；失败显式报错）。
    const remove = await gitExec(
      deps,
      fresh.nodeId,
      locked.mainPath,
      ['worktree', 'remove', ...(input.force === true ? ['--force'] : []), fresh.path],
      input.signal,
    )
    if (!remove.ok) {
      throw new HelmError(
        'worktree_remove_failed',
        `移除 worktree '${fresh.path}'（节点 ${fresh.nodeId}）失败：\n${remove.output.trim()}`,
        502,
        { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, output: remove.output.slice(0, 2000) },
      )
    }

    // 分支删除：锁内已确认相对 referenceHead 全部合入（unmergedCommits
    // === 0；force 路径恒为 0）或显式 force 时统一 -D——referenceHead 非
    // main 时 git branch -d 的上游/HEAD 合入检查不认参考，会拒绝实际已
    // 合入的分支。部分失败先固化 worktree 已 removed 事实（branchDeleted
    // 状态与诊断保留，可重试），再显式报错——绝不把已消失的树永远留在
    // active，也不掩盖分支删除失败。
    let branchDeleted = false
    if (input.deleteBranch === true) {
      const del = await deleteManagedBranch(
        deps,
        fresh.nodeId,
        locked.mainPath,
        fresh.branch,
        input.force === true || unmergedCommits === 0,
        input.signal,
      )
      branchDeleted = del.deleted
      if (!del.deleted) {
        store.updateRecord(fresh.id, (r) => ({
          ...r,
          status: 'removed' as const,
          removedAt: Date.now(),
          branchDeleted: false,
          branchDeleteError: (del.failureOutput ?? '').slice(0, 2000),
        }))
        throw new HelmError(
          'branch_delete_failed',
          `worktree '${fresh.path}' 已移除，但删除分支 ${fresh.branch} 失败（登记已置 removed，可重试 cleanup 传 deleteBranch:true）：\n${(del.failureOutput ?? '').trim()}`,
          502,
          { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, output: (del.failureOutput ?? '').slice(0, 2000) },
        )
      }
    }
    store.updateRecord(fresh.id, (r) => {
      if (input.deleteBranch !== true) return { ...r, status: 'removed' as const, removedAt: Date.now() }
      const { branchDeleteError: _previousError, ...clean } = r
      return { ...clean, status: 'removed' as const, removedAt: Date.now(), branchDeleted: true }
    })
    outcome = { removed: true, branchDeleted }
  })

  const result = outcome
  if (result === undefined) {
    throw new HelmError('worktree_check_failed', '清理未产生结果（内部状态不一致）', 500, { worktreeId: record.id })
  }
  return {
    removed: result.removed,
    worktreeId: record.id,
    path: record.path,
    branch: record.branch,
    nodeId: record.nodeId,
    branchDeleted: result.branchDeleted,
  }
}
