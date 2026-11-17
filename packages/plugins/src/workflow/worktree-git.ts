/**
 * WorktreeAllocator 的节点侧探测与解析层（纯机制、零状态）：
 * - 纯解析/纯计算：`parseWorktreeList`、`parseStatusPorcelainV2`、`normalizePathValue` / `matchWorktreeEntry`；
 * - git 命令执行：`gitExec`（argv 数组直跑、无 shell 解析，非零退出显式失败；支持 chars/lines 受限采集）；
 * - git 命令序列：`resolveRepoAuthority`、`deleteManagedBranch`、`resolveMergeReferenceHead`、`countUnmergedCommits`；
 * - 节点真实 fs 探测：`dirExistsOnNode` / `canonicalPathOnNode`（探测失败一律 fail-closed 抛 `worktree_check_failed`）。
 */

import type { FileError, Result } from '@earendil-works/pi-durable/env'
import { HelmError, pathRulesForShape, targetPathShape } from '@helm/protocol'

export interface WorktreeExecOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export interface WorktreeExecResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
}

export interface WorktreeNodePorts {
  exec: (
    nodeId: string,
    cwd: string,
    args: readonly string[],
    options?: WorktreeExecOptions,
  ) => Promise<WorktreeExecResult>
  nodeExists: (nodeId: string, path: string) => Promise<Result<boolean, FileError>>
  nodeCanonicalPath: (nodeId: string, path: string) => Promise<Result<string, FileError>>
  redact?: (text: string) => string
}

const GIT_TIMEOUT_MS = 120_000

/** `git worktree list --porcelain -z` 的单条权威登记。 */
interface WorktreeEntry {
  path: string
  head: string
  branch?: string
  detached: boolean
  locked: boolean
  lockedReason?: string
  prunable: boolean
  prunableReason?: string
}

/** 同一仓库的权威信息（主工作树 + common-dir + 全部登记）。 */
export interface RepoAuthority {
  mainPath: string
  commonDir: string
  canonicalCommonDir: string
  entries: WorktreeEntry[]
}

/** `git status --porcelain=v2 --branch` 解析结果。 */
interface SourceWorktreeStatus {
  oid: string
  branch?: string
  dirty: boolean
}

export type GitOkResult = { ok: true; output: string; truncated: boolean; lines: string[]; totalNonEmptyLines: number }
type GitResult = GitOkResult | { ok: false; output: string; exitCode: number | null; truncated: boolean }

interface GitCaptureChars {
  kind: 'chars'
  limit: number
}
interface GitCaptureLines {
  kind: 'lines'
  maxLines: number
}
export type GitCapture = GitCaptureChars | GitCaptureLines

/** 解析 `git worktree list --porcelain -z` 输出（NUL 分隔记录，空 token 分隔条目）。 */
function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | undefined
  const flush = (): void => {
    if (current !== undefined) entries.push(current)
    current = undefined
  }
  for (const token of output.split('\0')) {
    if (token === '') {
      flush()
      continue
    }
    if (token.startsWith('worktree ')) {
      flush()
      current = { path: token.slice('worktree '.length), head: '', detached: false, locked: false, prunable: false }
      continue
    }
    if (current === undefined) continue
    if (token.startsWith('HEAD ')) current.head = token.slice('HEAD '.length)
    else if (token.startsWith('branch ')) current.branch = token.slice('branch '.length)
    else if (token === 'detached') current.detached = true
    else if (token === 'locked') current.locked = true
    else if (token.startsWith('locked ')) {
      current.locked = true
      current.lockedReason = token.slice('locked '.length)
    } else if (token === 'prunable') current.prunable = true
    else if (token.startsWith('prunable ')) {
      current.prunable = true
      current.prunableReason = token.slice('prunable '.length)
    }
  }
  flush()
  return entries
}

/** 解析 `git status --porcelain=v2 --branch` 输出（提取 HEAD 提交、当前本地分支与脏工作区标记）。 */
export function parseStatusPorcelainV2(output: string): SourceWorktreeStatus {
  let oid = ''
  let branch: string | undefined
  let dirty = false
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine === '') continue
    if (rawLine.startsWith('# branch.oid ')) {
      oid = rawLine.slice('# branch.oid '.length).trim()
    } else if (rawLine.startsWith('# branch.head ')) {
      const head = rawLine.slice('# branch.head '.length).trim()
      if (head !== '' && head !== '(detached)') branch = head
    } else if (!rawLine.startsWith('#')) {
      dirty = true
    }
  }
  return { oid, ...(branch !== undefined ? { branch } : {}), dirty }
}

/** 路径形状感知的归一化比较（跨 POSIX/Windows 拼写差异；形状未知时原值）。 */
export function normalizePathValue(path: string): string {
  const rules = pathRulesForShape(targetPathShape(path))
  return rules === undefined ? path : rules.normalize(path)
}

/** 权威登记中按归一化路径匹配条目。 */
export function matchWorktreeEntry(entries: readonly WorktreeEntry[], path: string): WorktreeEntry | undefined {
  return entries.find((e) => normalizePathValue(e.path) === normalizePathValue(path)) ?? entries.find((e) => e.path === path)
}

/**
 * 在目标节点执行单条 git 命令（argv 数组直跑、无 shell 解析）；非零退出或超时显式失败。
 * `capture` 提供受限采集（chars 先到先截、lines 只保留前 N 条非空原行并统计真实非空行数）。
 */
export async function gitExec(
  ports: WorktreeNodePorts,
  nodeId: string,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  capture?: GitCapture,
): Promise<GitResult> {
  const redact = ports.redact ?? ((t: string) => t)
  const res = await ports.exec(nodeId, cwd, ['git', ...args], {
    timeoutMs: GIT_TIMEOUT_MS,
    ...(signal !== undefined ? { signal } : {}),
  })

  let captured = res.output
  let truncated = false
  const lines: string[] = []
  let totalNonEmptyLines = 0

  if (capture?.kind === 'chars') {
    if (res.output.length > capture.limit) {
      captured = res.output.slice(0, capture.limit)
      truncated = true
    }
  } else if (capture?.kind === 'lines') {
    for (const line of res.output.split('\n')) {
      if (line === '') continue
      totalNonEmptyLines += 1
      if (lines.length < capture.maxLines) lines.push(line)
      else truncated = true
    }
    captured = lines.join('\n')
  }

  if (!res.ok || res.exitCode !== 0 || res.timedOut) {
    const diag =
      res.timedOut && !captured.includes('timeout')
        ? `${captured}${captured === '' ? '' : '\n'}[git timeout]`
        : captured
    return {
      ok: false,
      truncated,
      output: redact(diag),
      exitCode: res.exitCode,
    }
  }

  return { ok: true, output: captured, truncated, lines, totalNonEmptyLines }
}

/** 经目标节点真实 fs 探测路径是否存在；探测失败一律 fail-closed 抛 `worktree_check_failed`。 */
export async function dirExistsOnNode(ports: WorktreeNodePorts, nodeId: string, path: string): Promise<boolean> {
  const redact = ports.redact ?? ((t: string) => t)
  let failure: string
  try {
    const result = await ports.nodeExists(nodeId, path)
    if (result.ok) return result.value
    failure = `${result.error.code}: ${result.error.message}`
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  throw new HelmError(
    'worktree_check_failed',
    `无法探测节点 ${nodeId} 上 '${redact(path)}' 是否存在（${failure}）：节点离线/权限/超时一律不当作目录缺失，操作中止`,
    502,
    { nodeId, path: redact(path), failure },
  )
}

/** 节点侧真实路径用于锁与归属校验；探测失败必须拒绝，不能退回词法路径。 */
export async function canonicalPathOnNode(ports: WorktreeNodePorts, nodeId: string, path: string): Promise<string> {
  const redact = ports.redact ?? ((t: string) => t)
  const result = await ports.nodeCanonicalPath(nodeId, path)
  if (!result.ok) {
    throw new HelmError('worktree_check_failed', `节点 ${nodeId} 无法确认真实路径 ${redact(path)}：${redact(result.error.message)}`, 502)
  }
  return result.value
}

/**
 * 从 cwd 出发取同一仓库的权威信息（`knownCommonDir` 已由上游批量 `rev-parse` 解析时免重复调用）。
 * 布局校验：`common-dir` 必须位于主工作树下（`<mainPath>/.git`），非常规布局显式拒绝。
 */
export async function resolveRepoAuthority(
  ports: WorktreeNodePorts,
  nodeId: string,
  cwd: string,
  signal?: AbortSignal,
  knownCommonDir?: string,
): Promise<RepoAuthority> {
  const redact = ports.redact ?? ((t: string) => t)
  let commonDir = knownCommonDir ?? ''
  if (commonDir === '') {
    const common = await gitExec(ports, nodeId, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
    commonDir = common.ok ? common.output.trim() : ''
    if (!common.ok || commonDir === '') {
      throw new HelmError(
        'worktree_check_failed',
        `无法在节点 ${nodeId} 解析 '${redact(cwd)}' 的 git common-dir（不猜测主仓路径，操作中止）：\n${common.output.trim()}`,
        502,
        { nodeId, cwd: redact(cwd), output: common.output.slice(0, 2000) },
      )
    }
  }
  const list = await gitExec(ports, nodeId, cwd, ['worktree', 'list', '--porcelain', '-z'], signal)
  if (!list.ok) {
    throw new HelmError(
      'worktree_check_failed',
      `无法在节点 ${nodeId} 读取 '${redact(cwd)}' 的权威 worktree 登记（git worktree list 失败，操作中止）：\n${list.output.trim()}`,
      502,
      { nodeId, cwd: redact(cwd), output: list.output.slice(0, 2000) },
    )
  }
  const entries = parseWorktreeList(list.output)
  const main = entries[0]
  if (main === undefined || main.path === '') {
    throw new HelmError(
      'worktree_check_failed',
      `节点 ${nodeId} 上 '${redact(cwd)}' 的权威 worktree 登记为空（无法确定主工作树，操作中止）`,
      502,
      { nodeId, cwd: redact(cwd) },
    )
  }
  const rules = pathRulesForShape(targetPathShape(commonDir) ?? targetPathShape(main.path))
  if (rules.normalize(commonDir) !== rules.normalize(rules.join(main.path, '.git'))) {
    throw new HelmError(
      'worktree_unsupported_layout',
      `仓库布局不受支持：git common-dir '${redact(commonDir)}' 不在主工作树 '${redact(main.path)}' 下（--separate-git-dir / 裸仓库等形态不猜测主仓路径，显式拒绝）`,
      400,
      { nodeId, commonDir: redact(commonDir), mainPath: redact(main.path) },
    )
  }
  return { mainPath: main.path, commonDir, canonicalCommonDir: await canonicalPathOnNode(ports, nodeId, commonDir), entries }
}

/** 删除受管分支（幂等：分支已不存在视为已删除；失败返回真实输出供重试诊断）。 */
export async function deleteManagedBranch(
  ports: WorktreeNodePorts,
  nodeId: string,
  repoRoot: string,
  branch: string,
  force: boolean,
  signal?: AbortSignal,
): Promise<{ deleted: boolean; failureOutput?: string }> {
  const verify = await gitExec(ports, nodeId, repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], signal)
  if (!verify.ok && verify.exitCode === 1) return { deleted: true }
  const del = await gitExec(ports, nodeId, repoRoot, ['branch', force ? '-D' : '-d', branch], signal)
  return del.ok ? { deleted: true } : { deleted: false, failureOutput: del.output }
}

/** 「已合入」参考提交解析：显式 mergedInto 严格校验 > baseBranch > 主工作树 HEAD。 */
export async function resolveMergeReferenceHead(
  ports: WorktreeNodePorts,
  nodeId: string,
  repoRoot: string,
  mainHead: string,
  mergedInto: string | undefined,
  baseBranch: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const redact = ports.redact ?? ((t: string) => t)
  if (mergedInto !== undefined) {
    const verify = await gitExec(
      ports,
      nodeId,
      repoRoot,
      ['rev-parse', '--verify', '--quiet', `${mergedInto}^{commit}`],
      signal,
    )
    const commit = verify.output.trim()
    if (!verify.ok || !/^[0-9a-f]{7,64}$/i.test(commit)) {
      throw new HelmError(
        'validation_error',
        `mergedInto 指向的分支或提交不存在：${redact(mergedInto)}（不回退主工作树，操作中止）`,
        400,
        { mergedInto: redact(mergedInto) },
      )
    }
    return commit
  }
  if (baseBranch !== undefined && baseBranch !== '') {
    const verify = await gitExec(
      ports,
      nodeId,
      repoRoot,
      ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}^{commit}`],
      signal,
    )
    const commit = verify.output.trim()
    if (verify.ok && /^[0-9a-f]{7,64}$/i.test(commit)) return commit
  }
  return mainHead
}

/** 分支相对参考提交的未合入提交数（rev-list count）；git 失败显式 `worktree_check_failed`。 */
export async function countUnmergedCommits(
  ports: WorktreeNodePorts,
  nodeId: string,
  repoRoot: string,
  referenceHead: string,
  branch: string,
  signal?: AbortSignal,
): Promise<number> {
  const unmerged = await gitExec(
    ports,
    nodeId,
    repoRoot,
    ['rev-list', '--count', `${referenceHead}..${branch}`],
    signal,
  )
  if (!unmerged.ok) {
    throw new HelmError(
      'worktree_check_failed',
      `无法确认分支 ${branch} 相对参考提交 ${referenceHead} 的未合入提交（git rev-list 失败，清理中止）：\n${unmerged.output.trim()}`,
      502,
      { referenceHead, branch, output: unmerged.output.slice(0, 2000) },
    )
  }
  return Number.parseInt(unmerged.output.trim(), 10) || 0
}
