/**
 * builtin:swarm 强杀（SIGKILL）与重启对账辅助：
 * - inspectBoardWalLines：以 meta.json.headSeq 为唯一事务提交点校验 board.jsonl，回滚至多 1 条崩溃未提交 WAL 尾；
 * - classifyInflightIntent：对账崩溃前登记的在途唤醒/续催/汇总提交意图（区分仍在跑 / 已完成 / 未提交）；
 * - classifyMemberDetailOutcome：从会话时间线精准判定重启前遗留未回帖成员是 failed / aborted / 静默完成 / 仍排队；
 * - reconcileOrphanConversations / reconcileOrphanWorktreeHolds：按 meta.json 单真源清理半途强杀遗留的孤儿会话标签与 Worktree 锁。
 */
import {
  HelmError,
  isJsonObject,
  type ConversationEntry,
  type ConversationSummary,
  type HelmHostApi,
  type HelmPluginContext,
} from '@helm/protocol'
import {
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  WORKER_TAG,
  assertBoardPost,
  type BoardPost,
  type CollabGroupRecord,
  type GroupMemberState,
} from './contracts.js'
import {
  WORKFLOW_PLUGIN_ID,
  cleanupManagedWorktree,
  releaseWorktreeHoldById,
} from './worktree-bridge.js'

export interface WalInspectionResult {
  posts: BoardPost[]
  trimmed: boolean
  trimReason?: string
}

/**
 * 纯函数校验 board.jsonl 与 meta.headSeq 提交点一致性：
 * - 前 headSeq 行必须严格合法且 seq=1..headSeq 连续，任何缺失或损坏均抛 swarm_doc_corrupt；
 * - 允许至多 1 行未提交 WAL 尾（meta.json 原子替换前崩溃留下的截断半行或单条 seq=headSeq+1 完整待提交行），
 *   返回 trimmed=true 交由调用方原子截断回 headSeq。
 */
export function inspectBoardWalLines(
  rawBoard: string,
  groupId: string,
  headSeq: number,
): WalInspectionResult {
  const corrupt = (detail: string, extra?: Record<string, unknown>): HelmError =>
    new HelmError('swarm_doc_corrupt', `协作组 '${groupId}' ${detail}`, 500, {
      pluginId: SWARM_PLUGIN_ID,
      groupId,
      ...extra,
    })

  if (rawBoard === '') {
    if (headSeq !== 0) {
      throw corrupt(`board.jsonl 为空但 meta.headSeq=${headSeq}`, { postsCount: 0, headSeq })
    }
    return { posts: [], trimmed: false }
  }

  const endsWithNewline = rawBoard.endsWith('\n')
  const rawLines = rawBoard.split('\n')
  if (endsWithNewline) rawLines.pop()

  if (rawLines.length < headSeq) {
    throw corrupt(`board.jsonl 条数(${rawLines.length})少于 meta.headSeq(${headSeq})`, {
      postsCount: rawLines.length,
      headSeq,
    })
  }

  const posts: BoardPost[] = []
  for (let i = 0; i < headSeq; i += 1) {
    const rawLine = rawLines[i]!
    if (rawLine.trim() === '') {
      throw corrupt(`board.jsonl 第 ${i + 1} 行为空行`, { line: i + 1 })
    }
    let parsedLine: unknown
    try {
      parsedLine = JSON.parse(rawLine)
    } catch (err) {
      throw corrupt(
        `board.jsonl 第 ${i + 1} 行 JSON 非法：${err instanceof Error ? err.message : String(err)}`,
        { line: i + 1 },
      )
    }
    const post = assertBoardPost(parsedLine)
    if (post.groupId !== groupId || post.seq !== i + 1) {
      throw corrupt(
        `board.jsonl 第 ${i + 1} 行序号或 groupId 不连续（收到 seq=${post.seq}）`,
        { line: i + 1, seq: post.seq },
      )
    }
    posts.push(post)
  }

  const extraLines = rawLines.slice(headSeq)
  if (extraLines.length === 0) {
    return { posts, trimmed: false }
  }
  if (extraLines.length > 1) {
    throw corrupt(
      `board.jsonl 条数(${rawLines.length})超出 meta.headSeq(${headSeq}) 多行（${extraLines.length} 行），拒绝静默丢弃`,
      { postsCount: rawLines.length, headSeq },
    )
  }

  const extraLine = extraLines[0]!
  let parsedExtra: unknown
  let extraParsedOk = false
  if (extraLine.trim() !== '') {
    try {
      parsedExtra = JSON.parse(extraLine)
      extraParsedOk = true
    } catch {
      // 崩溃截断的半行 JSON，按未提交 WAL 尾回滚
    }
  }
  if (extraParsedOk) {
    const extraPost = assertBoardPost(parsedExtra)
    if (extraPost.groupId !== groupId || extraPost.seq !== headSeq + 1) {
      throw corrupt(
        `board.jsonl 第 ${headSeq + 1} 行未提交记录序号或 groupId 异常（收到 seq=${extraPost.seq}）`,
        { line: headSeq + 1, seq: extraPost.seq },
      )
    }
  }

  return {
    posts,
    trimmed: true,
    trimReason: extraParsedOk
      ? `uncommitted post seq=${headSeq + 1} before meta.json commit`
      : `truncated tail line after headSeq=${headSeq}`,
  }
}

export interface InflightSubmissionMarker {
  requestId: string
  baseCompletionSeq: number
  baseLastEntryId: number
}

export type InflightIntentStatus = 'missing_conv' | 'active' | 'settled' | 'uncommitted'

/**
 * 统一对账在途提交意图（唤醒 / 续催 / 主控汇总共用）：
 * - active：会话正在跑（含阻塞待审批），提交已生效；
 * - settled：completionSeq 已推进或时间线已出现同 requestId 的 helm.input（涵盖 HelmStore 未及刷盘的强杀窗口）；
 * - uncommitted：尚未进入时间线，可安全释放水位并幂等重投。
 */
export async function classifyInflightIntent(
  host: Pick<HelmHostApi, 'getConversationDetail'>,
  conversationId: number,
  summary: ConversationSummary | undefined,
  intent: InflightSubmissionMarker,
): Promise<InflightIntentStatus> {
  if (summary === undefined) return 'missing_conv'
  if (summary.status === 'working' || summary.status === 'blocked') return 'active'
  if (summary.completionSeq > intent.baseCompletionSeq) return 'settled'
  if ((summary.lastEntryId ?? 0) <= intent.baseLastEntryId) return 'uncommitted'

  let detailEntries: ConversationEntry[]
  try {
    const detail = await host.getConversationDetail(conversationId, { limit: 50 })
    detailEntries = detail.entries
  } catch (err) {
    if (err instanceof HelmError && err.code === 'not_found') return 'missing_conv'
    throw err
  }
  const hasMatchingInput = detailEntries.some(
    (entry) =>
      entry.kind === 'helm.input' &&
      isJsonObject(entry.data) &&
      entry.data['id'] === intent.requestId,
  )
  if (hasMatchingInput) return 'settled'
  if (detailEntries.length === 50 && Number(detailEntries[0]?.id ?? 0) > intent.baseLastEntryId) {
    return 'settled'
  }
  return 'uncommitted'
}

export type MemberSettledClassification =
  | { kind: 'pending_queue' }
  | { kind: 'aborted' }
  | { kind: 'completed' }
  | { kind: 'failed'; error?: string }

function matchesMemberWakeOrNudgeInput(
  entry: ConversationEntry,
  groupId: string,
  memberName: string,
  taskSeq: number,
): boolean {
  if (entry.kind !== 'helm.input' || !isJsonObject(entry.data)) return false
  const id = entry.data['id']
  if (typeof id !== 'string') return false
  if (id === `swarm-nudge:${groupId}:${memberName}:${taskSeq}`) return true
  const wakePrefix = `swarm-wakeup:${groupId}:${memberName}:`
  if (!id.startsWith(wakePrefix)) return false
  const range = id.slice(wakePrefix.length)
  const dash = range.indexOf('-')
  if (dash <= 0) return false
  const toSeq = Number(range.slice(dash + 1))
  return Number.isInteger(toSeq) && toSeq >= taskSeq
}

/**
 * 根据成员摘要与最近时间线，判定重启前尚未调用 swarm_board_post 的已停机成员应走哪条自愈分支：
 * - error -> 补发系统 [blocker]；
 * - completed（最后回复非 aborted/error）-> 补跑 evaluateSilentExit（单次续催或二次 [blocker]）；
 * - aborted（被人为中止或无回复中止）-> 清理任务水位不误发续催；
 * - pending_queue（唤醒仍在 pi.inbox 等待压缩完成）-> 暂不介入。
 */
export function classifyMemberDetailOutcome(
  entries: readonly ConversationEntry[],
  summary: Pick<ConversationSummary, 'status' | 'completionSeq' | 'lastError'>,
  groupId: string,
  member: Pick<GroupMemberState, 'name' | 'lastWakeTaskSeq' | 'lastWakeCompletionSeq'>,
): MemberSettledClassification {
  if (summary.status === 'error') {
    return {
      kind: 'failed',
      ...(summary.lastError !== undefined ? { error: summary.lastError } : {}),
    }
  }
  const taskSeq = member.lastWakeTaskSeq
  if (taskSeq === undefined) return { kind: 'pending_queue' }

  const completionAdvanced =
    member.lastWakeCompletionSeq === undefined || summary.completionSeq > member.lastWakeCompletionSeq

  let lastInputIdx = -1
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.kind === 'helm.input') {
      lastInputIdx = i
      break
    }
  }

  if (lastInputIdx === -1) {
    if (!completionAdvanced) return { kind: 'pending_queue' }
  } else if (!completionAdvanced) {
    const lastInput = entries[lastInputIdx]!
    if (!matchesMemberWakeOrNudgeInput(lastInput, groupId, member.name, taskSeq)) {
      return { kind: 'pending_queue' }
    }
  }

  const tail = lastInputIdx >= 0 ? entries.slice(lastInputIdx + 1) : entries
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const entry = tail[i]!
    if (entry.kind !== 'pi.assistant' || !Array.isArray(entry.model)) continue
    for (let j = entry.model.length - 1; j >= 0; j -= 1) {
      const msg = entry.model[j]
      if (!isJsonObject(msg) || msg['role'] !== 'assistant') continue
      const stopReason = msg['stopReason']
      if (stopReason === 'aborted') return { kind: 'aborted' }
      if (stopReason === 'error') {
        const errText =
          typeof msg['errorMessage'] === 'string' && msg['errorMessage'].trim() !== ''
            ? msg['errorMessage'].trim()
            : undefined
        return { kind: 'failed', ...(errText !== undefined ? { error: errText } : {}) }
      }
      return { kind: 'completed' }
    }
  }

  return { kind: 'aborted' }
}

/** 启动阶段按 meta.json 单真源收敛孤儿/错配的 Swarm 会话标签与归属权。 */
export async function reconcileOrphanConversations(
  ctx: HelmPluginContext,
  groups: Iterable<CollabGroupRecord>,
): Promise<void> {
  const activeCoordinators = new Set<number>()
  const activeWorkers = new Set<number>()
  for (const group of groups) {
    if (group.status !== 'active') continue
    activeCoordinators.add(group.coordinatorConversationId)
    for (const member of group.members) {
      if (member.lifecycle === 'active') activeWorkers.add(member.conversationId)
    }
  }

  for (const conv of ctx.host.listConversations()) {
    const hasCoordTag = conv.tags.includes(COORDINATOR_TAG)
    const hasArchivedCoordTag = conv.tags.includes(ARCHIVED_COORDINATOR_TAG)
    const hasWorkerTag = conv.tags.includes(WORKER_TAG)
    const hasArchivedWorkerTag = conv.tags.includes(ARCHIVED_WORKER_TAG)

    if (activeCoordinators.has(conv.id)) {
      if (!hasCoordTag || hasArchivedCoordTag) {
        const nextTags = [
          ...conv.tags.filter((t) => t !== ARCHIVED_COORDINATOR_TAG && t !== COORDINATOR_TAG),
          COORDINATOR_TAG,
        ]
        await ctx.host.updateConversation(conv.id, { tags: nextTags })
      }
      continue
    }

    if (activeWorkers.has(conv.id)) {
      ctx.host.markConversationOwnership(conv.id, 'helm')
      if (!hasWorkerTag || hasArchivedWorkerTag || hasCoordTag) {
        const nextTags = [
          ...conv.tags.filter((t) => t !== ARCHIVED_WORKER_TAG && t !== COORDINATOR_TAG && t !== WORKER_TAG),
          WORKER_TAG,
        ]
        await ctx.host.updateConversation(conv.id, { tags: nextTags })
      }
      continue
    }

    if (hasWorkerTag || (hasCoordTag && conv.parentConversationId !== undefined)) {
      ctx.host.markConversationOwnership(conv.id, 'helm')
      const base = conv.tags.filter(
        (t) => t !== WORKER_TAG && t !== COORDINATOR_TAG && t !== ARCHIVED_WORKER_TAG,
      )
      await ctx.host.updateConversation(conv.id, { tags: [...base, ARCHIVED_WORKER_TAG] })
      continue
    }

    if (hasCoordTag && conv.parentConversationId === undefined) {
      const base = conv.tags.filter((t) => t !== COORDINATOR_TAG && t !== ARCHIVED_COORDINATOR_TAG)
      await ctx.host.updateConversation(conv.id, { tags: [...base, ARCHIVED_COORDINATOR_TAG] })
    }
  }
}

interface ListedWorktreeEntry {
  id: string
  status?: string
  hold?: { pluginId?: string; holdId?: string }
}

/**
 * 启动阶段回收半途强杀遗留的孤儿 Swarm Worktree 锁与目录：
 * 仅处理 status === 'active' 且 hold.pluginId === 'builtin:swarm' 但不对应任何活跃成员的记录；
 * keepWorktree: true 主动释放锁（hold 已为空）的分支不受影响。
 */
export async function reconcileOrphanWorktreeHolds(
  ctx: HelmPluginContext,
  groups: Iterable<CollabGroupRecord>,
  logDiagnostic: (message: string) => void,
): Promise<boolean> {
  let listed: { worktrees?: ListedWorktreeEntry[] } | undefined
  try {
    listed = (await ctx.host.invokeAction(WORKFLOW_PLUGIN_ID, 'list_worktrees', {})) as {
      worktrees?: ListedWorktreeEntry[]
    }
  } catch (err) {
    if (
      err instanceof HelmError &&
      (err.code === 'plugin_disabled' || err.code === 'unknown_action')
    ) {
      return false
    }
    logDiagnostic(`查询受管 worktree 失败：${err instanceof Error ? err.message : String(err)}`)
    return false
  }

  const activeHoldTargets = new Map<string, string>()
  for (const group of groups) {
    if (group.status !== 'active') continue
    for (const member of group.members) {
      if (member.lifecycle === 'active' && member.worktreeId !== undefined) {
        activeHoldTargets.set(`${group.id}:${member.name}`, member.worktreeId)
      }
    }
  }

  for (const wt of listed?.worktrees ?? []) {
    if (wt.status !== 'active') continue
    if (wt.hold?.pluginId !== SWARM_PLUGIN_ID) continue
    const holdId = wt.hold.holdId ?? ''
    if (holdId !== '' && activeHoldTargets.get(holdId) === wt.id) continue
    if (holdId === '') {
      logDiagnostic(`跳过空 holdId 的孤儿 worktree '${wt.id}'`)
      continue
    }
    try {
      await releaseWorktreeHoldById(ctx, holdId, wt.id)
      await cleanupManagedWorktree(ctx, wt.id, true)
      logDiagnostic(`已回收孤儿 worktree '${wt.id}' (holdId=${holdId})`)
    } catch (err) {
      logDiagnostic(
        `回收孤儿 worktree '${wt.id}' 失败（已跳过不阻断启动）：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return true
}
