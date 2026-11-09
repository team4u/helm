/**
 * 跨节点通用 WorktreeAllocator：isolation: 'worktree' 的机制层。
 *
 * 职责（机制与策略分离：本模块只提供受管 worktree 的创建/登记/校验/清理
 * 机制，策略由调用方（原生 spawn、外部运行时插件）决定）：
 * - `allocate`：在目标节点 (EnvFabric envFor) 对源 cwd 执行真实 git 命令
 *   （argv 数组直跑，无 shell quoting，跨 POSIX/Windows 同构），从
 *   `git worktree list --porcelain -z` 的权威登记确定主工作树（从已有
 *   worktree 再派生也定位到真正主仓，绝不以 dirname 猜根、绝不嵌套
 *   .helm-worktrees），在主工作树同级 `.helm-worktrees/<repo>-<shortId>`
 *   建独立 worktree 与 `helm/spawn-<shortId>` 分支（基于记录的
 *   baseCommit 而非易变 HEAD），如实记录源 cwd 的 dirtySource；
 * - `registerExternal`：外部运行时（如 builtin:herdr 的 worktree.create）
 *   回传的 worktree 统一登记（cleanup 只清理已登记记录，绝不碰人类目录）；
 * - `verifyForResume`：resume 续接前经节点真实 fs 探测 + git 探测校验
 *   worktree 仍在（探测失败与目录缺失显式区分，绝不把节点离线/权限/
 *   超时当作缺失）；
 * - `cleanup`：选择器（worktreeId | conversationId | path[+nodeId]）解析
 *   已登记记录 + 占用检查（子会话运行中/路径被引用拒绝）+ per-repo
 *   canonical git common-dir 串行锁（同仓库不同 worktree 也串行，防
 *   parallel() 抢 .git/config.lock）+ 锁内重读记录、权威 worktree list
 *   的 path/branch/head 归属匹配、realpath canonical 校验（禁止清除主
 *   工作树、拒绝软链跳树、拒绝 locked/prunable/分支被替换的登记路径）+
 *   脏工作区保护（未提交修改或相对主工作树当前 HEAD 未合入提交且未显式
 *   force 时拒绝，external 记录同样检查；状态命令失败显式报错，绝不假
 *   成功）+ 真实 `git worktree remove` / `git branch -d|-D`（分支删除
 *   部分失败先固化 worktree 已 removed 事实，保留 branchDeleted 状态与
 *   诊断、可重试）；目录缺失经节点真实 fs stat 证明时显式
 *   worktree_missing 并保留登记（绝不全仓 prune 他人的登记）；
 *
 * 诚实性纪律：非 Git 仓库、裸仓库/--separate-git-dir 等非常规布局、git
 * 失败、目录缺失均带真实输出显式抛 HelmError，绝不静默降级、绝不伪造
 * fallback 数据、绝不把节点离线/权限/超时当作目录缺失；持久化元数据
 * （路径/分支/仓路径）含已登记机密时显式 worktree_metadata_secret 拒绝
 * 落库（诊断仅用脱敏值）；清理仅针对 docStore 已登记记录，分支名严格
 * 校验 helm/spawn-* | helm/wf-* 前缀（绝不误删人类分支/目录）。
 */

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import { randomUUID } from 'node:crypto'
import { HelmError } from '@helm/protocol'
import type { EnvFabric } from '../env/fabric.js'
import { pathRulesForShape, targetPathShape } from './tools.js'

/** 受管 worktree 持久化 key（docStore 命名空间 'runtime/worktrees'）。 */
const DOC_KEY = 'runtime/worktrees'

/** 持久化文档形状（版本化，向后不兼容时整体重建——开发阶段无迁移）。 */
interface WorktreeDoc {
  version: 1
  records: ManagedWorktreeRecord[]
}

/** 单条受管 worktree 记录。 */
export interface ManagedWorktreeRecord {
  /** 唯一标识（`${nodeId}:${path}`）。 */
  id: string
  nodeId: string
  /** 主工作树路径（权威 `git worktree list` 首条登记；external 首次清理时解析并持久化）。 */
  repoRoot: string
  path: string
  branch: string
  baseCommit: string
  dirtySource: boolean
  parentConversationId: number
  conversationId?: number
  executionId?: string
  origin: 'native' | 'external'
  status: 'active' | 'removed'
  createdAt: number
  removedAt?: number
  /** 分支是否已删除（worktree 已移除但分支删除部分失败时为 false，可重试 cleanup deleteBranch）。 */
  branchDeleted?: boolean
  /** 分支删除失败的最后诊断（已脱敏；重试成功后清除）。 */
  branchDeleteError?: string
}

export interface WorktreeAllocatorDeps {
  /** 跨节点执行底座（allocate/verify/cleanup 的 git 命令经目标节点执行）。 */
  envFabric: Pick<EnvFabric, 'envFor'>
  /** 持久化文档存储（get/set 同步；与 PluginDocStore 同契约；原始 JSON 落库不自动脱敏）。 */
  docStore: { get<T>(key: string, initial: T): T; set<T>(key: string, value: T): void }
  /** 文本脱敏（git 输出进错误诊断前过一遍；缺省原样）。 */
  redact?: (text: string) => string
  /** 子会话是否仍在运行（cleanup 占用检查；缺省视为不在运行）。 */
  isConversationWorking?: (conversationId: number) => boolean
  /** worktree 路径是否仍被引用（cleanup 占用检查；缺省视为未被引用）。 */
  isPathInUse?: (nodeId: string, path: string) => boolean
}

export interface AllocateInput {
  nodeId: string
  sourceCwd: string
  parentConversationId: number
  /** 人类可读标签提示（暂未参与命名；预留）。 */
  labelHint?: string
  signal?: AbortSignal
}

export interface RegisterExternalInput {
  nodeId: string
  path: string
  branch: string
  parentConversationId: number
  conversationId?: number
  executionId?: string
  /** 外部运行时的源 cwd（repoRoot 未知时先记录，清理时经权威登记解析主工作树）。 */
  sourceCwd?: string
}

export interface CleanupInput {
  /** 受管 worktree 登记 ID（`${nodeId}:${path}`；与 conversationId/path 互斥）。 */
  worktreeId?: string
  conversationId?: number
  /** worktree 绝对路径（多节点同名路径时必须另附 nodeId 消歧）。 */
  path?: string
  /** 目标节点 ID（仅可与 path 搭配）。 */
  nodeId?: string
  deleteBranch?: boolean
  force?: boolean
  signal?: AbortSignal
}

export interface CleanupResult {
  removed: boolean
  worktreeId: string
  path: string
  branch: string
  nodeId: string
  branchDeleted: boolean
}

/** 允许清理的分支前缀（helm 受管命名空间；绝不碰人类分支）。 */
const MANAGED_BRANCH_PREFIXES = ['helm/spawn-', 'helm/wf-'] as const

/** 单条 git 命令的执行超时（秒）。 */
const GIT_TIMEOUT_SECONDS = 120

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
interface RepoAuthority {
  /** 主工作树路径（porcelain 输出首条登记）。 */
  mainPath: string
  /** 绝对 git common-dir（`<mainPath>/.git`，布局校验通过的前提下）。 */
  commonDir: string
  /** common-dir 的真实路径（per-repo 锁键；解析失败回退原值）。 */
  canonicalCommonDir: string
  entries: WorktreeEntry[]
}

type GitResult = { ok: true; output: string } | { ok: false; output: string; exitCode: number | null }

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

/** 路径形状感知的归一化比较（跨 POSIX/Windows 拼写差异；形状未知时原值）。 */
function normalizePathValue(path: string): string {
  const rules = pathRulesForShape(targetPathShape(path))
  return rules === undefined ? path : rules.normalize(path)
}

/** 外部 AbortSignal 挂到 SDK Context（预 aborted 时 exec 直接拒绝 spawn）。 */
function contextWithSignal(signal: AbortSignal | undefined): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}

/**
 * 在目标节点执行单条 git 命令（argv 数组直跑程序、无 shell 解析，路径含
 * 空格/特殊字符或 Windows 目标 shell 未知时同样安全）；非零退出显式失败。
 */
async function gitExec(
  deps: WorktreeAllocatorDeps,
  nodeId: string,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  const redact = deps.redact ?? ((t: string) => t)
  const env = deps.envFabric.envFor(nodeId, cwd)
  let combined = ''
  const result = await env.exec(
    ['git', ...args],
    {
      cwd,
      timeout: GIT_TIMEOUT_SECONDS,
      onOutput: (text: string) => {
        combined += text
      },
    },
    contextWithSignal(signal),
  )
  if (!result.ok) {
    return {
      ok: false,
      output: redact(combined + (combined === '' ? '' : '\n') + `[git ${result.error.code}: ${result.error.message}]`),
      exitCode: null,
    }
  }
  if (result.value.exitCode !== 0) {
    return { ok: false, output: redact(combined), exitCode: result.value.exitCode }
  }
  return { ok: true, output: combined }
}

export class WorktreeAllocator {
  /** per-repo 进程内串行队列尾（键为 canonical git common-dir：同仓库不同 worktree 也串行）。 */
  private readonly repoLocks = new Map<string, Promise<unknown>>()

  private readonly redact: (text: string) => string

  constructor(private readonly deps: WorktreeAllocatorDeps) {
    this.redact = deps.redact ?? ((t: string) => t)
  }

  // ------------------------------------------------------------------
  // 持久化
  // ------------------------------------------------------------------

  private loadDoc(): WorktreeDoc {
    const doc = this.deps.docStore.get<WorktreeDoc>(DOC_KEY, { version: 1, records: [] })
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.records)) {
      // 开发阶段不迁移：损坏文档显式失败，绝不静默当空表（丢失已登记记录
      // 会让 cleanup 误判“未登记”而拒绝清理，或误把人类目录当可清理）。
      throw new HelmError('worktree_doc_corrupted', `受管 worktree 文档 '${DOC_KEY}' 损坏（records 非数组）`, 500)
    }
    return doc
  }

  private saveDoc(doc: WorktreeDoc): void {
    this.deps.docStore.set(DOC_KEY, doc)
  }

  private updateRecord(id: string, mutate: (record: ManagedWorktreeRecord) => ManagedWorktreeRecord): void {
    const doc = this.loadDoc()
    const index = doc.records.findIndex((r) => r.id === id)
    if (index === -1) {
      throw new HelmError('not_found', `受管 worktree 记录 ${id} 不存在（文档状态不一致）`, 404, { id })
    }
    doc.records[index] = mutate(doc.records[index]!)
    this.saveDoc(doc)
  }

  /**
   * 持久化元数据机密检查：docStore 原始 JSON 落库不自动脱敏，任何将保存的
   * 路径/分支/仓路径经 redact 后有差异（含已登记 secret）即显式拒绝登记
   * （诊断仅用脱敏值；绝不脱敏后再当真实路径使用，也绝不 raw 落库）。
   * identity 为非机密定位字段（nodeId/conversationId/executionId 等），
   * 原样进 message/details——拒绝后仍能定位对应的外部执行。
   */
  private assertMetadataSecretFree(
    fields: Record<string, string>,
    identity: Record<string, string | number | undefined>,
  ): void {
    const offenders: string[] = []
    for (const [name, value] of Object.entries(fields)) {
      if (value === '') continue
      const redacted = this.redact(value)
      if (redacted !== value) offenders.push(`${name}=${redacted}`)
    }
    if (offenders.length > 0) {
      const identityEntries = Object.entries(identity).filter(([, v]) => v !== undefined && v !== '')
      const identityText = identityEntries.map(([k, v]) => `${k}: ${String(v)}`).join('，')
      throw new HelmError(
        'worktree_metadata_secret',
        `受管 worktree 元数据疑似包含已登记机密，拒绝登记与原始落库（脱敏值：${offenders.join('；')}）${identityText !== '' ? `【定位：${identityText}】` : ''}；请调整路径/分支命名或先轮换机密`,
        400,
        {
          ...Object.fromEntries(identityEntries),
          redactedFields: offenders,
        },
      )
    }
  }

  // ------------------------------------------------------------------
  // per-repo mutex（canonical git common-dir）
  // ------------------------------------------------------------------

  /** 同一 (nodeId, canonical common-dir) 的操作串行执行（进程内 Promise 链尾拼接）。 */
  private async withRepoLock<T>(nodeId: string, canonicalCommonDir: string, fn: () => Promise<T>): Promise<T> {
    const key = `${nodeId}\u0000${canonicalCommonDir}`
    const previous = this.repoLocks.get(key) ?? Promise.resolve()
    const run = previous.then(fn, fn)
    // 链尾自愈：fn 抛错不让后续等待者永久失败（错误由各自调用方如实处理）。
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.repoLocks.set(key, tail)
    void tail.then(() => {
      if (this.repoLocks.get(key) === tail) this.repoLocks.delete(key)
    })
    return run
  }

  // ------------------------------------------------------------------
  // 节点侧 fs / 权威 repo 信息
  // ------------------------------------------------------------------

  /**
   * 经目标节点真实 fs stat 证明路径存在（Result/异常都显式处理）：探测失败
   * （节点离线/权限/超时）一律 fail closed 抛 worktree_check_failed，绝不
   * 当作目录缺失（目录缺失只能由本方法返回 false 或权威 worktree 记录证明）。
   */
  private async dirExistsOnNode(nodeId: string, path: string): Promise<boolean> {
    let failure: string
    try {
      const env = this.deps.envFabric.envFor(nodeId, path)
      const result = await env.exists(path, BACKGROUND_CONTEXT)
      if (result.ok) return result.value
      failure = `${result.error.code}: ${result.error.message}`
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    throw new HelmError(
      'worktree_check_failed',
      `无法探测节点 ${nodeId} 上 '${this.redact(path)}' 是否存在（${failure}）：节点离线/权限/超时一律不当作目录缺失，操作中止`,
      502,
      { nodeId, path: this.redact(path), failure },
    )
  }

  /** 节点侧真实路径用于锁与归属校验；探测失败必须拒绝，不能退回词法路径。 */
  private async canonicalPathOnNode(nodeId: string, path: string): Promise<string> {
    const env = this.deps.envFabric.envFor(nodeId, path)
    const result = await env.canonicalPath(path, BACKGROUND_CONTEXT)
    if (!result.ok) {
      throw new HelmError('worktree_check_failed', `节点 ${nodeId} 无法确认真实路径 ${this.redact(path)}：${this.redact(result.error.message)}`, 502)
    }
    return result.value
  }

  /**
   * 从 cwd 出发取同一仓库的权威信息：`git rev-parse --git-common-dir` +
   * `git worktree list --porcelain -z`（首条登记即主工作树）。布局校验：
   * common-dir 必须位于主工作树下（`<mainPath>/.git`），裸仓库 /
   * --separate-git-dir 等非常规形态显式拒绝（绝不 dirname 猜根）。
   */
  private async resolveRepoAuthority(nodeId: string, cwd: string, signal?: AbortSignal): Promise<RepoAuthority> {
    const common = await gitExec(this.deps, nodeId, cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)
    const commonDir = common.ok ? common.output.trim() : ''
    if (!common.ok || commonDir === '') {
      throw new HelmError(
        'worktree_check_failed',
        `无法在节点 ${nodeId} 解析 '${this.redact(cwd)}' 的 git common-dir（不猜测主仓路径，操作中止）：\n${common.output.trim()}`,
        502,
        { nodeId, cwd: this.redact(cwd), output: common.output.slice(0, 2000) },
      )
    }
    const list = await gitExec(this.deps, nodeId, cwd, ['worktree', 'list', '--porcelain', '-z'], signal)
    if (!list.ok) {
      throw new HelmError(
        'worktree_check_failed',
        `无法在节点 ${nodeId} 读取 '${this.redact(cwd)}' 的权威 worktree 登记（git worktree list 失败，操作中止）：\n${list.output.trim()}`,
        502,
        { nodeId, cwd: this.redact(cwd), output: list.output.slice(0, 2000) },
      )
    }
    const entries = parseWorktreeList(list.output)
    const main = entries[0]
    if (main === undefined || main.path === '') {
      throw new HelmError(
        'worktree_check_failed',
        `节点 ${nodeId} 上 '${this.redact(cwd)}' 的权威 worktree 登记为空（无法确定主工作树，操作中止）`,
        502,
        { nodeId, cwd: this.redact(cwd) },
      )
    }
    const rules = pathRulesForShape(targetPathShape(commonDir) ?? targetPathShape(main.path))
    if (rules.normalize(commonDir) !== rules.normalize(rules.join(main.path, '.git'))) {
      throw new HelmError(
        'worktree_unsupported_layout',
        `仓库布局不受支持：git common-dir '${this.redact(commonDir)}' 不在主工作树 '${this.redact(main.path)}' 下（--separate-git-dir / 裸仓库等形态不猜测主仓路径，显式拒绝）`,
        400,
        { nodeId, commonDir: this.redact(commonDir), mainPath: this.redact(main.path) },
      )
    }
    return { mainPath: main.path, commonDir, canonicalCommonDir: await this.canonicalPathOnNode(nodeId, commonDir), entries }
  }

  /** 权威登记中按归一化路径匹配条目。 */
  private matchEntry(entries: readonly WorktreeEntry[], path: string): WorktreeEntry | undefined {
    return entries.find((e) => normalizePathValue(e.path) === normalizePathValue(path)) ?? entries.find((e) => e.path === path)
  }

  /** 删除受管分支（幂等：分支已不存在视为已删除；失败返回真实输出供重试诊断）。 */
  private async deleteManagedBranch(
    nodeId: string,
    repoRoot: string,
    branch: string,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<{ deleted: boolean; failureOutput?: string }> {
    const verify = await gitExec(this.deps, nodeId, repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], signal)
    if (!verify.ok && verify.exitCode === 1) return { deleted: true }
    const del = await gitExec(this.deps, nodeId, repoRoot, ['branch', force ? '-D' : '-d', branch], signal)
    return del.ok ? { deleted: true } : { deleted: false, failureOutput: del.output }
  }

  // ------------------------------------------------------------------
  // allocate（原生 isolation: 'worktree'）
  // ------------------------------------------------------------------

  async allocate(input: AllocateInput): Promise<ManagedWorktreeRecord> {
    const { nodeId, sourceCwd, signal } = input
    // Step A：源目录必须是工作树（非 Git 目录与裸仓库显式区分，绝不猜测）。
    const toplevel = await gitExec(this.deps, nodeId, sourceCwd, ['rev-parse', '--show-toplevel'], signal)
    if (!toplevel.ok || toplevel.output.trim() === '') {
      const bare = await gitExec(this.deps, nodeId, sourceCwd, ['rev-parse', '--is-bare-repository'], signal)
      if (bare.ok && bare.output.trim() === 'true') {
        throw new HelmError(
          'worktree_unsupported_layout',
          `目录 ${sourceCwd}（节点 ${nodeId}）是裸仓库（bare）：没有可检出的工作树，不支持派生隔离 worktree`,
          400,
          { nodeId, sourceCwd },
        )
      }
      throw new HelmError(
        'not_a_git_repo',
        `目录 ${sourceCwd}（节点 ${nodeId}）不是 Git 仓库（git rev-parse --show-toplevel 失败）：\n${toplevel.output.trim()}`,
        400,
        { nodeId, sourceCwd, output: toplevel.output.slice(0, 2000) },
      )
    }
    const sourceToplevel = toplevel.output.trim()
    const bare = await gitExec(this.deps, nodeId, sourceCwd, ['rev-parse', '--is-bare-repository'], signal)
    if (bare.ok && bare.output.trim() === 'true') {
      throw new HelmError(
        'worktree_unsupported_layout',
        `目录 ${sourceCwd}（节点 ${nodeId}）位于裸仓库（bare）：没有可检出的工作树，不支持派生隔离 worktree`,
        400,
        { nodeId, sourceCwd },
      )
    }

    // Step B：权威 repo 信息（主工作树来自 `git worktree list` 首条登记——
    // 从已有隔离 worktree 再派生也定位到真正主仓；锁键为 canonical
    // common-dir，同仓库不同 worktree 的操作同样串行）。
    const authority = await this.resolveRepoAuthority(nodeId, sourceToplevel, signal)

    // Step C：baseCommit 与 dirtySource 取实际 sourceCwd（父隔离工作树已
    // 提交的改动不丢失；不从主工作树取 HEAD）。
    const head = await gitExec(this.deps, nodeId, sourceCwd, ['rev-parse', 'HEAD'], signal)
    if (!head.ok) {
      throw new HelmError(
        'worktree_failed',
        `读取目录 ${sourceCwd}（节点 ${nodeId}）HEAD 失败：\n${head.output.trim()}`,
        502,
        { nodeId, sourceCwd, output: head.output.slice(0, 2000) },
      )
    }
    const baseCommit = head.output.trim()
    if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) {
      throw new HelmError(
        'worktree_failed',
        `目录 ${sourceCwd}（节点 ${nodeId}）HEAD 输出非提交哈希：${JSON.stringify(baseCommit)}`,
        502,
        { nodeId, sourceCwd, head: baseCommit },
      )
    }
    const status = await gitExec(this.deps, nodeId, sourceCwd, ['status', '--porcelain'], signal)
    if (!status.ok) {
      throw new HelmError(
        'worktree_failed',
        `读取目录 ${sourceCwd}（节点 ${nodeId}）状态失败：\n${status.output.trim()}`,
        502,
        { nodeId, sourceCwd, output: status.output.slice(0, 2000) },
      )
    }
    const dirtySource = status.output.trim().length > 0

    // Step D：隔离路径与分支名（基于主工作树同级：嵌套派生不反复嵌套
    // .helm-worktrees；路径规则按主工作树自身形状 POSIX/Windows）。
    const pathRules = pathRulesForShape(targetPathShape(authority.mainPath))
    const repoName = pathRules.basename(authority.mainPath).replace(/[^A-Za-z0-9._-]/g, '-') || 'repo'
    const shortId = randomUUID().replaceAll('-', '').slice(0, 8)
    const branch = `helm/spawn-${shortId}`
    const worktreeBase = pathRules.join(pathRules.dirname(authority.mainPath), '.helm-worktrees')
    const worktreePath = pathRules.join(worktreeBase, `${repoName}-${shortId}`)

    // Step E：机密检查（git worktree add 之前拦截全部将落库的持久字段）。
    this.assertMetadataSecretFree(
      { repoRoot: authority.mainPath, path: worktreePath, branch },
      { nodeId, parentConversationId: input.parentConversationId },
    )

    // Step F：per-repo 串行；worktree add 以记录的 baseCommit 为起点
    //（不追易变 HEAD——锁内创建瞬间主仓 HEAD 可能已被推进）。
    return this.withRepoLock(nodeId, authority.canonicalCommonDir, async () => {
      const add = await gitExec(
        this.deps,
        nodeId,
        authority.mainPath,
        ['worktree', 'add', '-b', branch, worktreePath, baseCommit],
        signal,
      )
      if (!add.ok) {
        throw new HelmError(
          'worktree_failed',
          `在仓库 ${authority.mainPath}（节点 ${nodeId}）创建 worktree ${worktreePath} 失败：\n${add.output.trim()}`,
          502,
          { nodeId, repoRoot: authority.mainPath, path: worktreePath, branch, baseCommit, output: add.output.slice(0, 2000) },
        )
      }
      const now = Date.now()
      const record: ManagedWorktreeRecord = {
        id: `${nodeId}:${worktreePath}`,
        nodeId,
        repoRoot: authority.mainPath,
        path: worktreePath,
        branch,
        baseCommit,
        dirtySource,
        parentConversationId: input.parentConversationId,
        origin: 'native',
        status: 'active',
        createdAt: now,
      }
      // 登记持久化失败：如实报 worktree_register_failed 并保留已创建资源
      // 坐标（不擅自回收——调用方可能已基于该 worktree 派生子会话）。
      try {
        const doc = this.loadDoc()
        doc.records.push(record)
        this.saveDoc(doc)
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error)
        throw new HelmError(
          'worktree_register_failed',
          `worktree ${worktreePath}（分支 ${branch}，节点 ${nodeId}）已创建，但登记持久化失败（资源坐标保留在 details，未擅自回收；请人工核对后清理或重新登记）：${cause}`,
          502,
          { nodeId, repoRoot: this.redact(authority.mainPath), path: this.redact(worktreePath), branch, baseCommit, cause },
        )
      }
      return record
    })
  }

  // ------------------------------------------------------------------
  // 登记 / 查询
  // ------------------------------------------------------------------

  /** 子会话创建后把 conversationId 关联写回记录。 */
  bindConversation(worktreePath: string, nodeId: string, conversationId: number): void {
    const id = `${nodeId}:${worktreePath}`
    const existing = this.loadDoc().records.find((r) => r.id === id)
    if (existing === undefined) {
      throw new HelmError(
        'not_found',
        `受管 worktree 记录 ${id} 不存在，无法绑定会话 ${conversationId}`,
        404,
        { id, conversationId },
      )
    }
    this.updateRecord(id, (r) => ({ ...r, conversationId }))
  }

  /** 外部运行时（如 builtin:herdr）回传 worktree 时统一登记/更新（同 (nodeId,path) 去重）。 */
  registerExternal(input: RegisterExternalInput): ManagedWorktreeRecord {
    const id = `${input.nodeId}:${input.path}`
    this.assertMetadataSecretFree(
      { path: input.path, branch: input.branch, repoRoot: input.sourceCwd ?? '', nodeId: input.nodeId, executionId: input.executionId ?? '' },
      { nodeId: this.redact(input.nodeId), parentConversationId: input.parentConversationId, conversationId: input.conversationId, executionId: input.executionId !== undefined ? this.redact(input.executionId) : undefined },
    )
    const doc = this.loadDoc()
    const existing = doc.records.find((r) => r.id === id)
    if (existing !== undefined) {
      const updated: ManagedWorktreeRecord = {
        ...existing,
        ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
        ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
      }
      this.updateRecord(id, () => updated)
      return updated
    }
    // 机密检查：docStore 原始 JSON 落库不自动脱敏，含已登记 secret 的
    // 路径/分支/仓路径显式拒绝（诊断仅用脱敏值 + 非机密定位字段，绝不
    // raw 落库；拒绝时尚未登记，不产生任何 onResolved 副作用）。
    const record: ManagedWorktreeRecord = {
      id,
      nodeId: input.nodeId,
      // 外部运行时可能不回传主仓路径：先记 sourceCwd（清理时经权威登记解析）。
      repoRoot: input.sourceCwd ?? '',
      path: input.path,
      branch: input.branch,
      baseCommit: '',
      dirtySource: false,
      parentConversationId: input.parentConversationId,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
      ...(input.executionId !== undefined ? { executionId: input.executionId } : {}),
      origin: 'external',
      status: 'active',
      createdAt: Date.now(),
    }
    doc.records.push(record)
    this.saveDoc(doc)
    return record
  }

  /** 查询会话当前绑定的受管 worktree（最新优先；无绑定返回 undefined）。 */
  getForConversation(conversationId: number): ManagedWorktreeRecord | undefined {
    const records = this.loadDoc().records.filter((r) => r.conversationId === conversationId)
    if (records.length === 0) return undefined
    // 多条（历史遗留）时取最新创建的 active 记录；无 active 取最新。
    const active = records.filter((r) => r.status === 'active')
    const pool = active.length > 0 ? active : records
    return pool.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
  }

  /**
   * 按 worktreeId / 会话 / 路径（可附 nodeId 消歧）查询 active 记录。
   * 同一路径在多个节点有 active 登记且未指定 nodeId 时显式 validation_error
   * （绝不任选首条静默清理别的节点）。
   */
  findActive(query: { worktreeId?: string; conversationId?: number; path?: string; nodeId?: string }): ManagedWorktreeRecord | undefined {
    const records = this.loadDoc().records.filter((r) => r.status === 'active')
    if (query.worktreeId !== undefined) return records.find((r) => r.id === query.worktreeId)
    if (query.conversationId !== undefined) {
      const byConversation = records.filter((r) => r.conversationId === query.conversationId)
      return byConversation.length === 0
        ? undefined
        : byConversation.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    }
    if (query.path !== undefined) {
      const byPath = records.filter(
        (r) => r.path === query.path && (query.nodeId === undefined || r.nodeId === query.nodeId),
      )
      const nodeIds = new Set(byPath.map((r) => r.nodeId))
      if (nodeIds.size > 1) {
        throw new HelmError(
          'validation_error',
          `路径 ${query.path} 在多个节点存在 active 登记（${[...nodeIds].join(', ')}），查询需指定 nodeId 消歧`,
          400,
          { path: query.path, nodeIds: [...nodeIds] },
        )
      }
      return byPath.length === 0 ? undefined : byPath.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    }
    return undefined
  }

  // ------------------------------------------------------------------
  // resume 校验
  // ------------------------------------------------------------------

  /**
   * resume 续接校验：cwd 冲突显式拒绝（不中途搬家）；记录已清理或目录缺失
   * 显式 worktree_missing（目录缺失经节点真实 fs stat 证明；节点离线/
   * 权限/超时等探测失败显式 worktree_check_failed，绝不当作缺失）。
   */
  async verifyForResume(
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
    if (!(await this.dirExistsOnNode(record.nodeId, record.path))) {
      throw new HelmError(
        'worktree_missing',
        `子会话绑定的隔离 worktree '${record.path}'（节点 ${record.nodeId}）目录已不存在（节点真实 fs 探测证实）`,
        409,
        { path: record.path, branch: record.branch, nodeId: record.nodeId },
      )
    }
    const probe = await gitExec(
      this.deps,
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

  // ------------------------------------------------------------------
  // cleanup
  // ------------------------------------------------------------------

  /** 解析清理目标记录（选择器互斥：worktreeId 单用；nodeId 仅搭 path；conversationId/path 择一）。 */
  private resolveCleanupRecord(input: CleanupInput): ManagedWorktreeRecord {
    const records = this.loadDoc().records
    if (input.worktreeId !== undefined) {
      const record = records.find((r) => r.id === input.worktreeId)
      if (record === undefined) {
        throw new HelmError('not_found', `未找到受管 worktree 记录 ${input.worktreeId}`, 404, { worktreeId: input.worktreeId })
      }
      return record
    }
    if (input.conversationId !== undefined) {
      const record = this.getForConversation(input.conversationId)
      if (record === undefined) {
        throw new HelmError(
          'not_found',
          `未找到会话 ${input.conversationId} 绑定的受管 worktree 记录；cleanup 仅清理 helm 登记的隔离 worktree，绝不触碰未登记目录`,
          404,
          { conversationId: input.conversationId },
        )
      }
      return record
    }
    const matches = records.filter(
      (r) => r.path === input.path && (input.nodeId === undefined || r.nodeId === input.nodeId),
    )
    if (matches.length === 0) {
      throw new HelmError(
        'not_found',
        `未找到路径 ${input.path}${input.nodeId !== undefined ? `（节点 ${input.nodeId}）` : ''} 的受管 worktree 记录；cleanup 仅清理 helm 登记的隔离 worktree，绝不触碰未登记目录`,
        404,
        { path: input.path, ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}) },
      )
    }
    const active = matches.filter((r) => r.status === 'active')
    const nodeIds = new Set(active.map((r) => r.nodeId))
    if (nodeIds.size > 1) {
      throw new HelmError(
        'validation_error',
        `路径 ${input.path} 在多个节点存在 active 登记（${[...nodeIds].join(', ')}），清理需指定 nodeId 消歧（或改用 worktreeId 精确指定）`,
        400,
        { path: input.path, nodeIds: [...nodeIds] },
      )
    }
    if (active.length > 0) return active.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    // 全部已 removed：幂等返回最新一条（供重复清理拿 removed:false）。
    return matches.reduce((a, b) => ((b.removedAt ?? b.createdAt) >= (a.removedAt ?? a.createdAt) ? b : a))
  }

  /** 归属不匹配的显式拒绝（登记路径上的工作树已被替换/挪用，force 也不可越过）。 */
  private ownerMismatch(record: ManagedWorktreeRecord, reason: string, detail: string, extra?: Record<string, unknown>): HelmError {
    return new HelmError(
      'worktree_owner_mismatch',
      `受管 worktree '${record.path}'（节点 ${record.nodeId}）${detail}（reason: ${reason}）：登记路径上的工作树已不归属本记录，拒绝清理（force 也不可越过归属校验）`,
      409,
      { path: record.path, branch: record.branch, nodeId: record.nodeId, reason, ...extra },
    )
  }

  async cleanup(input: CleanupInput): Promise<CleanupResult> {
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

    const record = this.resolveCleanupRecord(input)
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
        const authority = await this.resolveRepoAuthority(record.nodeId, record.repoRoot, input.signal)
        await this.withRepoLock(record.nodeId, authority.canonicalCommonDir, async () => {
          const del = await this.deleteManagedBranch(record.nodeId, authority.mainPath, record.branch, input.force === true, input.signal)
          branchDeleted = del.deleted
          if (del.deleted) {
            this.updateRecord(record.id, (r) => ({ ...r, branchDeleted: true, branchDeleteError: undefined }))
          } else {
            this.updateRecord(record.id, (r) => ({ ...r, branchDeleted: false, branchDeleteError: (del.failureOutput ?? '').slice(0, 2000) }))
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
    if (record.conversationId !== undefined && this.deps.isConversationWorking?.(record.conversationId) === true) {
      throw new HelmError(
        'worktree_in_use',
        `worktree '${record.path}' 关联的子代理仍在运行中，拒绝清理`,
        409,
        { path: record.path, conversationId: record.conversationId },
      )
    }
    if (this.deps.isPathInUse?.(record.nodeId, record.path) === true) {
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
    if (!(await this.dirExistsOnNode(record.nodeId, record.path))) {
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
      authority = await this.resolveRepoAuthority(record.nodeId, record.repoRoot, input.signal)
    } else {
      authority = await this.resolveRepoAuthority(record.nodeId, record.path, input.signal)
      this.assertMetadataSecretFree({ repoRoot: authority.mainPath }, { nodeId: record.nodeId, executionId: record.executionId })
      this.updateRecord(record.id, (r) => ({ ...r, repoRoot: authority.mainPath }))
    }

    let outcome: { removed: boolean; branchDeleted: boolean } | undefined
    await this.withRepoLock(record.nodeId, authority.canonicalCommonDir, async () => {
      // 锁内以最新记录为准（并发清理/状态变更在此收敛）。
      const fresh = this.loadDoc().records.find((r) => r.id === record.id)
      if (fresh === undefined) {
        throw new HelmError('not_found', `受管 worktree 记录 ${record.id} 不存在（文档状态不一致）`, 404, { id: record.id })
      }
      if (fresh.status === 'removed') {
        outcome = { removed: false, branchDeleted: fresh.branchDeleted === true }
        return
      }
      // 在用复查（锁内最新事实；force 不可越过）。
      if (fresh.conversationId !== undefined && this.deps.isConversationWorking?.(fresh.conversationId) === true) {
        throw new HelmError(
          'worktree_in_use',
          `worktree '${fresh.path}' 关联的子代理仍在运行中，拒绝清理`,
          409,
          { path: fresh.path, conversationId: fresh.conversationId },
        )
      }
      if (this.deps.isPathInUse?.(fresh.nodeId, fresh.path) === true) {
        throw new HelmError(
          'worktree_in_use',
          `worktree '${fresh.path}'（节点 ${fresh.nodeId}）仍被引用，拒绝清理`,
          409,
          { path: fresh.path, nodeId: fresh.nodeId },
        )
      }

      // 锁内重新取证权威登记，做 path/branch/head 归属匹配。
      const locked = await this.resolveRepoAuthority(fresh.nodeId, fresh.repoRoot !== '' ? fresh.repoRoot : fresh.path, input.signal)
      const entries = locked.entries
      const mainEntry = entries[0]!
      const match = this.matchEntry(entries, fresh.path)
      if (match === undefined) {
        throw this.ownerMismatch(
          fresh,
          'not_in_worktree_list',
          `不在权威 worktree 登记中（目录仍存在：路径上的内容已不受本仓库管理）`,
          { registeredEntries: entries.map((e) => this.redact(e.path)).slice(0, 20) },
        )
      }
      if (match === mainEntry || normalizePathValue(match.path) === normalizePathValue(mainEntry.path)) {
        throw this.ownerMismatch(fresh, 'main_worktree', '指向主工作树（主工作树绝不清除）', { mainPath: this.redact(mainEntry.path) })
      }
      if (match.locked) {
        // locked 是所有者显式加锁：force 只能越过 dirty/unmerged，不可越过。
        throw new HelmError(
          'worktree_locked',
          `worktree '${fresh.path}'（节点 ${fresh.nodeId}）已被 git worktree lock 锁定${match.lockedReason !== undefined ? `（${this.redact(match.lockedReason)}）` : ''}，拒绝清理（请先解锁）`,
          409,
          { worktreeId: fresh.id, path: fresh.path, nodeId: fresh.nodeId, ...(match.lockedReason !== undefined ? { lockedReason: this.redact(match.lockedReason) } : {}) },
        )
      }
      if (match.prunable) {
        throw this.ownerMismatch(
          fresh,
          'prunable',
          `的 gitdir 链接已断（${match.prunableReason !== undefined ? this.redact(match.prunableReason) : 'prunable'}：登记路径上的目录可能已被替换）`,
        )
      }
      if (match.branch !== `refs/heads/${fresh.branch}`) {
        throw this.ownerMismatch(
          fresh,
          'branch_changed',
          `的权威登记分支为 ${match.branch ?? (match.detached ? 'detached' : '未知')}，与登记分支 ${fresh.branch} 不一致（工作树可能已被用户替换或改签分支）`,
          { authorityBranch: this.redact(match.branch ?? '') },
        )
      }
      if (match.head === '' || /^0+$/.test(match.head)) {
        throw this.ownerMismatch(fresh, 'head_unreadable', '的权威登记 HEAD 缺失（工作树状态不可信）', { authorityHead: match.head })
      }

      // realpath canonical 校验：登记路径不得经软链跳到主工作树或其他工作树。
      const canonicalRecord = await this.canonicalPathOnNode(fresh.nodeId, fresh.path)
      const canonicalMain = await this.canonicalPathOnNode(fresh.nodeId, mainEntry.path)
      if (canonicalRecord === canonicalMain) {
        throw this.ownerMismatch(fresh, 'main_worktree', `经真实路径解析指向主工作树 ${this.redact(mainEntry.path)}`, {
          mainPath: this.redact(mainEntry.path),
        })
      }
      for (const other of entries) {
        if (other === match) continue
        const canonicalOther = await this.canonicalPathOnNode(fresh.nodeId, other.path)
        if (canonicalRecord === canonicalOther) {
          throw this.ownerMismatch(
            fresh,
            'symlink_redirect',
            `经真实路径解析指向其他工作树 ${this.redact(other.path)}（登记路径可能已被软链替换）`,
            { redirectedTo: this.redact(other.path) },
          )
        }
      }

      // 脏工作区保护（force=false；external 记录同样检查；合入参考为主
      // 工作树当前 HEAD——分支可能已相对 baseCommit 演进，不以 baseCommit
      // 缺失为由跳过）。ignored 文件也计入：实测 git worktree remove 无
      // --force 也会删除仅含 ignored 内容（.env 等）的 worktree，默认检查
      // 必须显式拦下（force 允许显式清除）。状态命令失败显式报错，绝不
      // 当作干净或目录缺失。
      let dirtyFiles: string[] = []
      let unmergedCommits = 0
      if (input.force !== true) {
        const status = await gitExec(
          this.deps,
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
        const mainHead = mainEntry.head
        const unmerged = await gitExec(
          this.deps,
          fresh.nodeId,
          locked.mainPath,
          ['rev-list', '--count', `${mainHead}..${fresh.branch}`],
          input.signal,
        )
        if (!unmerged.ok) {
          throw new HelmError(
            'worktree_check_failed',
            `无法确认分支 ${fresh.branch} 相对主工作树 HEAD（${mainHead}）的未合入提交（git rev-list 失败，清理中止）：\n${unmerged.output.trim()}`,
            502,
            { worktreeId: fresh.id, path: fresh.path, referenceHead: mainHead, output: unmerged.output.slice(0, 2000) },
          )
        }
        unmergedCommits = Number.parseInt(unmerged.output.trim(), 10) || 0
        if (dirtyFiles.length > 0 || unmergedCommits > 0) {
          throw new HelmError(
            'worktree_dirty',
            `worktree '${fresh.path}' (branch: ${fresh.branch}) 含未提交修改、未跟踪/被忽略文件或未合入提交（相对主工作树 HEAD ${mainHead}）；请先检视/合入，或显式传 force: true 强制清理`,
            409,
            { worktreeId: fresh.id, path: fresh.path, branch: fresh.branch, dirtyFiles: dirtyFiles.slice(0, 200), unmergedCommits, referenceHead: mainHead },
          )
        }
      }

      // 真实移除（不 prune、不猜测缺失；失败显式报错）。
      const remove = await gitExec(
        this.deps,
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

      // 分支删除：部分失败先固化 worktree 已 removed 事实（branchDeleted
      // 状态与诊断保留，可重试），再显式报错——绝不把已消失的树永远留在
      // active，也不掩盖分支删除失败。
      let branchDeleted = false
      if (input.deleteBranch === true) {
        const del = await this.deleteManagedBranch(fresh.nodeId, locked.mainPath, fresh.branch, input.force === true, input.signal)
        branchDeleted = del.deleted
        if (!del.deleted) {
          this.updateRecord(fresh.id, (r) => ({
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
      this.updateRecord(fresh.id, (r) => ({
        ...r,
        status: 'removed' as const,
        removedAt: Date.now(),
        ...(input.deleteBranch === true ? { branchDeleted: true, branchDeleteError: undefined } : {}),
      }))
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
}
