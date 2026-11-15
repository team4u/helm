/**
 * WorktreeAllocator 的节点侧探测与解析层（纯机制、零状态）：
 * - 纯解析/纯计算：`parseWorktreeList`（`git worktree list --porcelain -z`
 *   权威登记）、`normalizePathValue` / `matchWorktreeEntry`（路径形状感知
 *   归一化匹配，跨 POSIX/Windows 拼写差异）；
 * - git 命令执行：`gitExec`（argv 数组直跑、无 shell 解析，非零退出显式
 *   失败；受限采集模式 chars/lines 在 onOutput 阶段即限内存）；
 * - git 命令序列：`resolveRepoAuthority`（common-dir + 权威登记 + 布局
 *   校验，绝不 dirname 猜根）、`deleteManagedBranch`（幂等删除）、
 *   `resolveMergeReferenceHead`（「已合入」参考解析：显式 mergedInto 严格
 *   校验 / baseBranch / 主工作树 HEAD）、`countUnmergedCommits`；
 * - 节点真实 fs 探测：`dirExistsOnNode` / `canonicalPathOnNode`（探测失败
 *   一律 fail closed 抛 worktree_check_failed，绝不当作目录缺失）。
 *
 * 本模块零业务策略：全部函数显式携带 `WorktreeNodePorts`（allocator deps
 * 的结构子集），错误码与诊断文本由 WorktreeAllocator 的调用方契约锁定。
 */

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import type { ExecutionError, FileError, Result, ShellExecResult } from '@earendil-works/pi-durable/env'
import { HelmError, pathRulesForShape, targetPathShape } from '@helm/protocol'

/**
 * 节点执行/探测端口（WorktreeAllocatorDeps 的结构子集）：本模块零状态、
 * 零内核依赖，全部函数显式携带端口；redact 缺省原样（与 deps 契约一致）。
 */
export interface WorktreeNodePorts {
  exec: (
    nodeId: string,
    cwd: string,
    args: readonly string[],
    options: { cwd: string; timeout: number; onOutput: (text: string) => void },
    context: Context,
  ) => Promise<Result<ShellExecResult, ExecutionError>>
  nodeExists: (nodeId: string, path: string, context: Context) => Promise<Result<boolean, FileError>>
  nodeCanonicalPath: (nodeId: string, path: string, context: Context) => Promise<Result<string, FileError>>
  redact?: (text: string) => string
}

/** 单条 git 命令的执行超时（秒）。 */
const GIT_TIMEOUT_SECONDS = 120

/** `git worktree list --porcelain -z` 的单条权威登记。 */
export interface WorktreeEntry {
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
  /** 主工作树路径（porcelain 输出首条登记）。 */
  mainPath: string
  /** 绝对 git common-dir（`<mainPath>/.git`，布局校验通过的前提下）。 */
  commonDir: string
  /** common-dir 的真实路径（per-repo 锁键；解析失败回退原值）。 */
  canonicalCommonDir: string
  entries: WorktreeEntry[]
}

export type GitOkResult = { ok: true; output: string; truncated: boolean; lines: string[]; totalNonEmptyLines: number }
export type GitResult = GitOkResult | { ok: false; output: string; exitCode: number | null; truncated: boolean }

/**
 * git 输出受限采集模式（inspect 只读预览专用；不声明则不限制，
 * allocate/cleanup/verify 语义保持不变）：
 * - chars：字符上限——onOutput 阶段先到先截，绝不无限聚合内存后再 slice；
 * - lines：流式按行结算——只保留前 maxLines 条非空原行（含 porcelain 首列），
 *   同时对全部非空行保持真实计数（status 清单截断不失真总量）。
 */
export interface GitCaptureChars {
  kind: 'chars'
  limit: number
}
export interface GitCaptureLines {
  kind: 'lines'
  maxLines: number
}
export type GitCapture = GitCaptureChars | GitCaptureLines

/** 解析 `git worktree list --porcelain -z` 输出（NUL 分隔记录，空 token 分隔条目）。 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
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

/** 路径形状感知的归一化比较（跨 POSIX/Windows 拼写差异；形状未知时原值）。 */
export function normalizePathValue(path: string): string {
  const rules = pathRulesForShape(targetPathShape(path))
  return rules === undefined ? path : rules.normalize(path)
}

/** 权威登记中按归一化路径匹配条目。 */
export function matchWorktreeEntry(entries: readonly WorktreeEntry[], path: string): WorktreeEntry | undefined {
  return entries.find((e) => normalizePathValue(e.path) === normalizePathValue(path)) ?? entries.find((e) => e.path === path)
}

/** 外部 AbortSignal 挂到 SDK Context（预 aborted 时 exec 直接拒绝 spawn）。 */
function contextWithSignal(signal: AbortSignal | undefined): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}

/**
 * 在目标节点执行单条 git 命令（argv 数组直跑程序、无 shell 解析，路径含
 * 空格/特殊字符或 Windows 目标 shell 未知时同样安全）；非零退出显式失败。
 * capture（可选）：声明后按受限模式在 onOutput 阶段即限内存（chars 截断
 * 置 truncated；lines 只保留前 N 条非空原行并保持全量非空行计数），
 * 错误诊断同样受限并经 redact 脱敏；不声明时行为与原无限聚合一致。
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
  const maxLines = capture?.kind === 'lines' ? capture.maxLines : undefined
  let combined = ''
  let truncated = false
  const lines: string[] = []
  let totalNonEmptyLines = 0
  let pendingLine = ''
  /** lines 模式：结算一条完整行（空行不计不入；超保留上限仍计数并置 truncated）。 */
  const settleLine = (line: string): void => {
    if (maxLines === undefined || line === '') return
    totalNonEmptyLines += 1
    if (lines.length < maxLines) lines.push(line)
    else truncated = true
  }
  const result = await ports.exec(
    nodeId,
    cwd,
    ['git', ...args],
    {
      cwd,
      timeout: GIT_TIMEOUT_SECONDS,
      onOutput: (text: string) => {
        if (capture === undefined) {
          combined += text
          return
        }
        if (capture.kind === 'chars') {
          if (truncated) return
          if (combined.length + text.length <= capture.limit) {
            combined += text
            return
          }
          combined += text.slice(0, capture.limit - combined.length)
          truncated = true
          return
        }
        // lines 模式：块内可能切在行中间，仅结算完整行，残行留待下一块/收尾。
        pendingLine += text
        const parts = pendingLine.split('\n')
        pendingLine = parts.pop() ?? ''
        for (const line of parts) settleLine(line)
      },
    },
    contextWithSignal(signal),
  )
  // 流末尾：残留半行按完整行结算（porcelain 输出以换行结尾时此处为空）。
  if (pendingLine !== '') settleLine(pendingLine)
  if (!result.ok) {
    const captured = capture?.kind === 'lines' ? lines.join('\n') : combined
    return {
      ok: false,
      truncated,
      output: redact(captured + (captured === '' ? '' : '\n') + `[git ${result.error.code}: ${result.error.message}]`),
      exitCode: null,
    }
  }
  if (result.value.exitCode !== 0) {
    const captured = capture?.kind === 'lines' ? lines.join('\n') : combined
    return { ok: false, truncated, output: redact(captured), exitCode: result.value.exitCode }
  }
  return capture?.kind === 'lines'
    ? { ok: true, output: lines.join('\n'), truncated, lines, totalNonEmptyLines }
    : { ok: true, output: combined, truncated, lines, totalNonEmptyLines }
}

/**
 * 经目标节点真实 fs stat 证明路径存在（Result/异常都显式处理）：探测失败
 * （节点离线/权限/超时）一律 fail closed 抛 worktree_check_failed，绝不
 * 当作目录缺失（目录缺失只能由本方法返回 false 或权威 worktree 记录证明）。
 */
export async function dirExistsOnNode(ports: WorktreeNodePorts, nodeId: string, path: string): Promise<boolean> {
  const redact = ports.redact ?? ((t: string) => t)
  let failure: string
  try {
    const result = await ports.nodeExists(nodeId, path, BACKGROUND_CONTEXT)
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
  const result = await ports.nodeCanonicalPath(nodeId, path, BACKGROUND_CONTEXT)
  if (!result.ok) {
    throw new HelmError('worktree_check_failed', `节点 ${nodeId} 无法确认真实路径 ${redact(path)}：${redact(result.error.message)}`, 502)
  }
  return result.value
}

/**
 * 从 cwd 出发取同一仓库的权威信息：`git rev-parse --git-common-dir` +
 * `git worktree list --porcelain -z`（首条登记即主工作树）。布局校验：
 * common-dir 必须位于主工作树下（`<mainPath>/.git`），裸仓库 /
 * --separate-git-dir 等非常规形态显式拒绝（绝不 dirname 猜根）。
 */
export async function resolveRepoAuthority(ports: WorktreeNodePorts, nodeId: string, cwd: string, signal?: AbortSignal): Promise<RepoAuthority> {
  const redact = ports.redact ?? ((t: string) => t)
  const common = await gitExec(ports, nodeId, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
  const commonDir = common.ok ? common.output.trim() : ''
  if (!common.ok || commonDir === '') {
    throw new HelmError(
      'worktree_check_failed',
      `无法在节点 ${nodeId} 解析 '${redact(cwd)}' 的 git common-dir（不猜测主仓路径，操作中止）：\n${common.output.trim()}`,
      502,
      { nodeId, cwd: redact(cwd), output: common.output.slice(0, 2000) },
    )
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

/**
 * 「已合入」参考提交解析（cleanup 脏工作区检查与分支删除共用）：
 * 1) 显式 mergedInto：rev-parse --verify 严格校验，目标不存在显式
 *    validation_error（绝不静默回退主工作树）；
 * 2) 记录的 baseBranch：父分支仍存在则用其当前提交（多级派生时父模块
 *    分支才是合入目标）；
 * 3) 其余（含 baseBranch 已删）：回退主工作树当前 HEAD。
 */
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
    // 父分支已删：回退主工作树 HEAD（不猜测其他基线）。
  }
  return mainHead
}

/** 分支相对参考提交的未合入提交数（rev-list count）；git 失败显式 worktree_check_failed。 */
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
