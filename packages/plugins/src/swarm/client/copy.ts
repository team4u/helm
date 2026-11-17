/**
 * Display copy for the builtin:swarm client (pure copy table + builders, zero
 * component exports -- Fast Refresh compliant, zero Emoji).
 *
 * Every human-visible string of the collaboration board, starter presets,
 * header badge action, timeline receipt pills, and 540px member drawer resolves
 * here against the active host locale via usePluginTranslator / usePluginLocale.
 */
import type { HelmLocale, LocalizedText } from '@helm/plugin-client'
import { resolveLocalizedText } from '@helm/plugin-client'
import type { MemberLiveState } from './board-model.ts'

// ---------------------------------------------------------------------------
// Shared chrome & actions
// ---------------------------------------------------------------------------

export const SW_LOADING_BOARD: LocalizedText = {
  en: 'Loading collaboration board…',
  'zh-CN': '协同看板读取中…',
}
export const SW_ACTION_CLOSE: LocalizedText = { en: 'Close', 'zh-CN': '关闭' }
export const SW_ACTION_CANCEL: LocalizedText = { en: 'Cancel', 'zh-CN': '取消' }
export const SW_ACTION_REFRESH: LocalizedText = { en: 'Refresh', 'zh-CN': '刷新' }
export const SW_ACTION_RETRY: LocalizedText = { en: 'Retry', 'zh-CN': '重试' }

// ---------------------------------------------------------------------------
// Timeline 1-line receipt pills (swarm:board-report / swarm:board-wakeup)
// ---------------------------------------------------------------------------

export const SW_BOARD_REPORT_PILL: LocalizedText = { en: 'Swarm report', 'zh-CN': '看板汇总' }
export const SW_BOARD_WAKEUP_PILL: LocalizedText = { en: 'Swarm wakeup', 'zh-CN': '看板唤醒' }
export const SW_BOARD_OPEN_IN_SPLIT: LocalizedText = { en: 'Open on board', 'zh-CN': '定位看板' }

export function swReceiptCountLabel(count: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `${count} post${count === 1 ? '' : 's'}`, 'zh-CN': `${count} 条流转` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Starter dialog & conversation:header actions
// ---------------------------------------------------------------------------

export const SW_START_GROUP_BUTTON: LocalizedText = {
  en: 'Start Swarm Collaboration',
  'zh-CN': '开启协同组',
}
export const SW_START_GROUP_DESC: LocalizedText = {
  en: 'Create a flat peer-handoff blackboard for this conversation and unlock coordinator tools.',
  'zh-CN': '为当前会话创建扁平对等流转看板，并切换为主控协调工具集。',
}
export const SW_PRESET_LABEL: LocalizedText = { en: 'Collaboration preset', 'zh-CN': '协作预设' }
export const SW_PRESET_AUTHOR_VERIFIER: LocalizedText = {
  en: 'Author + Verifier',
  'zh-CN': 'Author + Verifier 审改闭环',
}
export const SW_PRESET_AUTHOR_VERIFIER_DESC: LocalizedText = {
  en: 'Isolated worktree implementation paired with an independent read-only verifier.',
  'zh-CN': '独立 Worktree 编码实现 + 只读 Verifier 交叉跑测与打回审改。',
}
export const SW_PRESET_SQUAD: LocalizedText = {
  en: 'Multi-Role Squad',
  'zh-CN': '多角色联合攻坚',
}
export const SW_PRESET_SQUAD_DESC: LocalizedText = {
  en: 'Parallel non-overlapping worktree authors + dedicated verifier + coordinator synthesis.',
  'zh-CN': '无重叠分片并行读写成员 + 独立门禁验收 + 主控裁决合入。',
}
export const SW_PRESET_BLANK: LocalizedText = {
  en: 'Blank Group',
  'zh-CN': '自定义空白组',
}
export const SW_PRESET_BLANK_DESC: LocalizedText = {
  en: 'Empty blackboard ready for custom roles, channels, and manual dispatch.',
  'zh-CN': '仅初始化空白看板，按需自定义招募角色与子频道。',
}
export const SW_GROUP_TITLE_LABEL: LocalizedText = { en: 'Group title', 'zh-CN': '协作组标题' }
export const SW_GROUP_TITLE_PLACEHOLDER: LocalizedText = {
  en: 'e.g. Auth refactor & verification',
  'zh-CN': '例如：鉴权模块重构与交叉验收',
}
export const SW_GROUP_OBJECTIVE_LABEL: LocalizedText = {
  en: 'Objective (optional)',
  'zh-CN': '协作目标（可选）',
}
export const SW_GROUP_OBJECTIVE_PLACEHOLDER: LocalizedText = {
  en: 'Shared goal anchored on coordinator batch reports',
  'zh-CN': '在主控汇总信封顶部持续锚定的核心验收目标',
}
export const SW_GUARD_LABEL: LocalizedText = {
  en: 'Coordinator guard',
  'zh-CN': '主控守卫（剥离直改工具）',
}
export const SW_GUARD_HINT: LocalizedText = {
  en: 'Strips edit/write/bash/subagent on the coordinator so all edits stay in workers until merge unlock.',
  'zh-CN': '开启期间剥离主控会话的 edit/write/bash/subagent，防止主控阻塞调度；结单选保留分支合入即可恢复。',
}
export const SW_STARTER_PROMPT_LABEL: LocalizedText = {
  en: 'Starter prompt draft (optional, not auto-sent)',
  'zh-CN': '开场任务草稿（可选，仅预填或复制，不自动发送）',
}
export const SW_COPY_PROMPT: LocalizedText = { en: 'Copy draft', 'zh-CN': '复制草稿' }
export const SW_CREATE_OPEN_BOARD: LocalizedText = {
  en: 'Create & Open Board',
  'zh-CN': '创建并打开看板',
}
export const SW_CREATING_GROUP: LocalizedText = { en: 'Creating…', 'zh-CN': '创建中…' }
export const SW_GROUP_TITLE_REQUIRED: LocalizedText = {
  en: 'Group title is required.',
  'zh-CN': '请填写协作组标题。',
}
export const SW_OPEN_BOARD_BUTTON: LocalizedText = {
  en: 'Swarm Board',
  'zh-CN': '协同看板',
}

export function swOpenBoardTitle(footerText: string | undefined, locale: HelmLocale): string {
  const base = resolveLocalizedText(
    { en: 'Open Swarm collaboration board', 'zh-CN': '打开协同流转看板' },
    locale,
  )
  return footerText !== undefined && footerText.trim() !== '' ? `${base}: ${footerText}` : base
}

export function swPresetDefaultTitle(
  preset: 'author-verifier' | 'squad' | 'blank',
  convTitle: string,
  locale: HelmLocale,
): string {
  const clean = convTitle.trim()
  if (clean !== '') return clean.slice(0, 80)
  if (preset === 'author-verifier') {
    return resolveLocalizedText(
      { en: 'Author + Verifier Review Loop', 'zh-CN': 'Author + Verifier 审改闭环' },
      locale,
    )
  }
  if (preset === 'squad') {
    return resolveLocalizedText({ en: 'Multi-Role Squad', 'zh-CN': '多角色联合攻坚' }, locale)
  }
  return resolveLocalizedText({ en: 'Swarm Collaboration Group', 'zh-CN': '协同工作组' }, locale)
}

export function swPresetDefaultDraft(
  preset: 'author-verifier' | 'squad' | 'blank',
  locale: HelmLocale,
): string {
  if (preset === 'author-verifier') {
    return resolveLocalizedText(
      {
        en: 'Use swarm_dispatch_worker to spawn an isolated worktree @author to implement the changes and a readonly @verifier to audit diffs and run tests via swarm_board_post peer handoffs (#seq). Wake coordinator only on blocker or final [done].',
        'zh-CN': '请通过 swarm_dispatch_worker 招募独立 worktree 的 @author 负责编码实现，以及只读 @verifier 负责审查 Diff 与跑测验收；双方调用 swarm_board_post 以 #seq 指针横向交接打回，仅遇阻塞或最终通过时唤醒 coordinator。',
      },
      locale,
    )
  }
  if (preset === 'squad') {
    return resolveLocalizedText(
      {
        en: 'Split the task into non-overlapping slices, use swarm_dispatch_worker for dedicated worktree authors per slice plus a readonly @verifier for integration checks, and coordinate peer handoffs via swarm_board_post on the board.',
        'zh-CN': '请将任务拆分为无文件重叠的独立分片，按分片调用 swarm_dispatch_worker 招募独立 worktree 读写成员并配备只读 @verifier 做集成验收，全程通过 swarm_board_post 以 #seq 对等流转。',
      },
      locale,
    )
  }
  return ''
}

// ---------------------------------------------------------------------------
// Swarm Board Screen
// ---------------------------------------------------------------------------

export const SW_BOARD_TITLE: LocalizedText = {
  en: 'Swarm Collaboration Board',
  'zh-CN': '协同流转看板',
}
export const SW_BOARD_EMPTY_TITLE: LocalizedText = {
  en: 'No collaboration groups yet',
  'zh-CN': '暂无协同工作组',
}
export const SW_BOARD_EMPTY_HINT: LocalizedText = {
  en: 'Open a top-level conversation and choose "Start Swarm Collaboration" from More actions, or start one from an active conversation below.',
  'zh-CN': '可在任意顶层人类会话右上角「更多操作 -> 开启协同组」创建，或在下方选择顶层会话直接开启。',
}
export const SW_BOARD_SELECT_GROUP_ARIA: LocalizedText = {
  en: 'Select collaboration group',
  'zh-CN': '选择协作组',
}
export const SW_BOARD_SELECT_CONV_ARIA: LocalizedText = {
  en: 'Select target conversation to start a group',
  'zh-CN': '选择要开启协作组的顶层会话',
}
export const SW_BOARD_CHANNEL_ALL: LocalizedText = { en: 'All channels', 'zh-CN': '全部频道' }
export const SW_BOARD_CHANNEL_TABS_ARIA: LocalizedText = { en: 'Board channels', 'zh-CN': '看板频道切换' }
export const SW_BOARD_GUARD_SHORT: LocalizedText = { en: 'Coordinator guard', 'zh-CN': '主控守卫' }
export const SW_BOARD_UNLOCK_MERGE: LocalizedText = {
  en: 'Unlock & Keep Branches',
  'zh-CN': '保留分支合入收尾',
}
export const SW_BOARD_UNLOCK_MERGE_TITLE: LocalizedText = {
  en: 'Release worktree holds, preserve unmerged branches, and restore coordinator bash/edit/write tools for merging.',
  'zh-CN': '释放工作树锁、保留待合入分支，并摘除主控守卫标签以恢复 bash/edit/write 合入权限。',
}
export const SW_BOARD_CLOSE_CLEAN: LocalizedText = {
  en: 'Close & Clean Up',
  'zh-CN': '全清关闭',
}
export const SW_BOARD_CLOSE_CLEAN_TITLE: LocalizedText = {
  en: 'Close the group and clean up merged clean worktrees (rejects if unmerged changes remain).',
  'zh-CN': '要求全部工作树已合入且干净后关闭协作组并清理目录（存在未合入改动时显式拒绝）。',
}
export const SW_BOARD_OPEN_COORDINATOR: LocalizedText = {
  en: 'Coordinator',
  'zh-CN': '打开主控会话',
}
export const SW_BOARD_DETACHED_BADGE: LocalizedText = {
  en: 'Coordinator detached',
  'zh-CN': '主控已脱离',
}
export const SW_BOARD_STATUS_ACTIVE: LocalizedText = { en: 'active', 'zh-CN': '活跃' }
export const SW_BOARD_STATUS_CLOSED: LocalizedText = { en: 'closed', 'zh-CN': '已结单' }

// Rescue banner copy
export const SW_RESCUE_STALL_TITLE: LocalizedText = {
  en: 'Collaboration stall detected',
  'zh-CN': '检测到全组静默停滞',
}
export const SW_RESCUE_BLOCKER_TITLE: LocalizedText = {
  en: 'Member blocked or failed',
  'zh-CN': '成员阻塞或回合失败',
}
export const SW_RESCUE_UNMERGED_TITLE: LocalizedText = {
  en: 'Unmerged worktree branches pending',
  'zh-CN': '存在待合入的工作树分支',
}
export const SW_RESCUE_WAKE_BUTTON: LocalizedText = {
  en: 'Wake Now',
  'zh-CN': '一键唤醒续跑',
}
export const SW_RESCUE_SWITCH_MODEL: LocalizedText = {
  en: 'Switch Model / Inspect',
  'zh-CN': '切换模型 / 检视成员',
}
export const SW_RESCUE_UNLOCK_MERGE: LocalizedText = {
  en: 'Unlock Coordinator to Merge',
  'zh-CN': '解锁主控保留分支合入',
}

export function swRescueWakeBody(target: string, refSeq: number | undefined, locale: HelmLocale): string {
  const ref = refSeq !== undefined ? ` (#${refSeq})` : ''
  return resolveLocalizedText(
    {
      en: `Human nudge: please review the pending board state${ref} for @${target} and publish the next handoff or [done] via swarm_board_post.`,
      'zh-CN': `人工续催：请跟进当前黑板悬空进展${ref}（目标 @${target}），完成后调用 swarm_board_post 发布下一跳交接或 [done]。`,
    },
    locale,
  )
}

// Topology & Filters
export const SW_TOPO_SECTION_TITLE: LocalizedText = { en: 'Collaboration Topology', 'zh-CN': '对等流转拓扑' }
export const SW_TOPO_GRAPH_ARIA: LocalizedText = {
  en: 'Orthogonal collaboration graph of coordinator, members, and handoff edges',
  'zh-CN': '主控、对等成员与交接有向边的正交拓扑图',
}
export const SW_TOPO_COORDINATOR_NODE: LocalizedText = { en: 'coordinator', 'zh-CN': 'coordinator (主控)' }
export const SW_TOPO_NO_MEMBERS: LocalizedText = {
  en: 'No peer workers dispatched yet.',
  'zh-CN': '尚未招募组内对等成员。',
}
export const SW_FILTER_CLEAR: LocalizedText = { en: 'Clear filter', 'zh-CN': '清除筛选' }

export function swFilterEdgeLabel(from: string, to: string, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `Edge: ${from} -> ${to}`, 'zh-CN': `连线筛选：${from} -> ${to}` },
    locale,
  )
}

export function swFilterMemberLabel(member: string, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `Member: @${member}`, 'zh-CN': `成员筛选：@${member}` },
    locale,
  )
}

export function swUnreadCursorBadge(delta: number, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `${delta} queued`, 'zh-CN': `待读 ${delta}` },
    locale,
  )
}

const MEMBER_LIVE_STATE_LABELS: Readonly<Record<MemberLiveState, LocalizedText>> = {
  idle: { en: 'Idle', 'zh-CN': '空闲' },
  working: { en: 'Working', 'zh-CN': '执行中' },
  blocked: { en: 'Blocked', 'zh-CN': '阻塞中' },
  done: { en: 'Done', 'zh-CN': '已完成' },
  error: { en: 'Error', 'zh-CN': '错误' },
  missing: { en: 'Missing', 'zh-CN': '会话缺失' },
}

export function swMemberLiveStateLabel(state: MemberLiveState, locale: HelmLocale): string {
  return resolveLocalizedText(MEMBER_LIVE_STATE_LABELS[state], locale)
}

// Handoff stream & post composer
export const SW_STREAM_TITLE: LocalizedText = { en: 'Handoff Stream', 'zh-CN': '序号交接流' }
export const SW_STREAM_EMPTY: LocalizedText = {
  en: 'No board posts match the current view.',
  'zh-CN': '当前筛选条件下暂无黑板流转记录。',
}
export const SW_PASSIVE_NOTE_BADGE: LocalizedText = {
  en: 'Note only (wake=false)',
  'zh-CN': '仅留言未唤醒',
}
export const SW_BODY_EXPAND: LocalizedText = { en: 'Expand full text', 'zh-CN': '展开全文' }
export const SW_BODY_COLLAPSE: LocalizedText = { en: 'Collapse', 'zh-CN': '收起长文' }
export const SW_POST_TARGETS_PLACEHOLDER: LocalizedText = {
  en: 'Select targets (@member / #channel)…',
  'zh-CN': '选择投递目标（成员 / #频道）…',
}
export const SW_POST_TARGETS_ARIA: LocalizedText = { en: 'Post targets', 'zh-CN': '投递目标选择' }
export const SW_POST_KIND_ARIA: LocalizedText = { en: 'Post kind', 'zh-CN': '消息类型选择' }
export const SW_POST_WAKE_LABEL: LocalizedText = { en: 'Wake immediately', 'zh-CN': '立即唤醒' }
export const SW_POST_WAKE_NOTE_HINT: LocalizedText = {
  en: 'Leave note (wake=false)',
  'zh-CN': '仅留言(wake=false)',
}
export const SW_POST_INPUT_PLACEHOLDER: LocalizedText = {
  en: 'Post a handoff, review, or note to the board (Ctrl/Cmd+Enter to send)…',
  'zh-CN': '向协同黑板发布人工指令、审改意见或被动留言（Ctrl/Cmd+Enter 发送）…',
}
export const SW_POST_INPUT_ARIA: LocalizedText = { en: 'Board message input', 'zh-CN': '黑板消息输入框' }
export const SW_POST_SEND: LocalizedText = { en: 'Post', 'zh-CN': '发布上板' }
export const SW_POST_SENDING: LocalizedText = { en: 'Posting…', 'zh-CN': '发布中…' }
export const SW_POST_VALIDATION_EMPTY: LocalizedText = {
  en: 'Select at least one target and enter a message.',
  'zh-CN': '请至少选择一个目标并输入消息正文。',
}

export function swSnapshotSummary(
  snap: { branch?: string; commitsAhead?: number; dirtyCount: number },
  locale: HelmLocale,
): string {
  const parts: string[] = []
  if (snap.branch !== undefined && snap.branch !== '') parts.push(snap.branch)
  if (snap.commitsAhead !== undefined) {
    parts.push(
      resolveLocalizedText(
        {
          en: `+${snap.commitsAhead} commit${snap.commitsAhead === 1 ? '' : 's'}`,
          'zh-CN': `领先 ${snap.commitsAhead} 提交`,
        },
        locale,
      ),
    )
  }
  parts.push(
    resolveLocalizedText(
      { en: `${snap.dirtyCount} dirty`, 'zh-CN': `未提交 ${snap.dirtyCount}` },
      locale,
    ),
  )
  return parts.join(' · ')
}

// Retained worktrees section
export const SW_RETAINED_WT_TITLE: LocalizedText = {
  en: 'Retained Worktrees Ready for Merge',
  'zh-CN': '保留待主控合入的工作树分支',
}
export const SW_REQUEST_MERGE_BTN: LocalizedText = {
  en: 'Request Coordinator Merge',
  'zh-CN': '请求主控合入此分支',
}
export const SW_MERGE_REQUEST_SENT: LocalizedText = {
  en: 'Merge request submitted to coordinator conversation.',
  'zh-CN': '已向主控会话提交分支审阅与合入请求。',
}

// ---------------------------------------------------------------------------
// Right 540px Member Detail Drawer
// ---------------------------------------------------------------------------

export function swMemberDrawerAria(name: string, locale: HelmLocale): string {
  return resolveLocalizedText(
    { en: `Member @${name} details`, 'zh-CN': `成员 @${name} 详情抽屉` },
    locale,
  )
}

export const SW_DRAWER_OPEN_CONV: LocalizedText = {
  en: 'Open Sub-Conversation Drawer',
  'zh-CN': '打开子会话抽屉',
}
export const SW_DRAWER_ABORT_TURN: LocalizedText = {
  en: 'Abort Current Turn',
  'zh-CN': '中止本轮回合',
}
export const SW_DRAWER_ABORTING: LocalizedText = { en: 'Aborting…', 'zh-CN': '中止中…' }
export const SW_DRAWER_ARCHIVE: LocalizedText = {
  en: 'Archive Member',
  'zh-CN': '归档此成员',
}
export const SW_DRAWER_ARCHIVING: LocalizedText = { en: 'Archiving…', 'zh-CN': '归档中…' }
export const SW_DRAWER_MODEL_SECTION: LocalizedText = {
  en: 'Model Switch (Idle Only)',
  'zh-CN': '原地切换模型（空闲态可用）',
}
export const SW_DRAWER_MODEL_ARIA: LocalizedText = {
  en: 'Member model selector',
  'zh-CN': '成员模型选择器',
}
export const SW_DRAWER_MODEL_DEFAULT: LocalizedText = {
  en: 'Follow Profile default',
  'zh-CN': '跟随角色默认模型',
}
export const SW_DRAWER_MODEL_BUSY_HINT: LocalizedText = {
  en: 'Abort or wait for the current turn to settle before switching models.',
  'zh-CN': '成员正在执行回合，请等待本轮结束或先点「中止本轮回合」后再切换模型。',
}
export const SW_DRAWER_MODEL_CUSTOM_PLACEHOLDER: LocalizedText = {
  en: 'Custom provider/model…',
  'zh-CN': '输入其他 provider/model…',
}
export const SW_DRAWER_MODEL_APPLY: LocalizedText = { en: 'Apply', 'zh-CN': '切换' }

export const SW_DRAWER_KV_CONVERSATION: LocalizedText = { en: 'Conversation', 'zh-CN': '子会话' }
export const SW_DRAWER_KV_PROFILE: LocalizedText = { en: 'Profile', 'zh-CN': '角色 Profile' }
export const SW_DRAWER_KV_ACCESS: LocalizedText = { en: 'Access', 'zh-CN': '写权限' }
export const SW_DRAWER_KV_ISOLATION: LocalizedText = { en: 'Isolation', 'zh-CN': '工作区隔离' }
export const SW_DRAWER_KV_ENV: LocalizedText = { en: 'Workspace', 'zh-CN': '节点与目录' }
export const SW_DRAWER_KV_CHANNELS: LocalizedText = { en: 'Channels', 'zh-CN': '订阅频道' }
export const SW_DRAWER_KV_CURSORS: LocalizedText = { en: 'Board cursors', 'zh-CN': '黑板游标水位' }

export const SW_WT_SECTION_TITLE: LocalizedText = {
  en: 'Managed Worktree Snapshot',
  'zh-CN': '受管 Worktree 只读快照',
}
export const SW_WT_INSPECTING: LocalizedText = {
  en: 'Inspecting worktree…',
  'zh-CN': '正在读取工作树快照…',
}
export const SW_WT_INVALID: LocalizedText = {
  en: 'Worktree inspection returned an invalid payload.',
  'zh-CN': '工作树快照返回结构无效。',
}
export const SW_WT_KV_BRANCH: LocalizedText = { en: 'Branch', 'zh-CN': '分支' }
export const SW_WT_KV_BASE: LocalizedText = { en: 'Base commit', 'zh-CN': '基线提交' }
export const SW_WT_KV_AHEAD: LocalizedText = { en: 'Commits ahead', 'zh-CN': '领先提交' }
export const SW_WT_KV_DIRTY: LocalizedText = { en: 'Dirty files', 'zh-CN': '未提交文件' }
export const SW_WT_CLEAN: LocalizedText = {
  en: 'Working tree clean.',
  'zh-CN': '工作树干净，无未提交改动。',
}
export const SW_WT_DIFF_TRUNCATED: LocalizedText = { en: 'Truncated', 'zh-CN': '已截断' }

export function swBuildCoordinatorMergeRequest(
  input: {
    groupId: string
    memberName: string
    worktreeId: string
    branch: string
    path: string
    nodeId?: string
    commitsAhead?: number
    dirtyFileCount?: number
  },
  locale: HelmLocale,
): string {
  const stats: string[] = []
  if (input.commitsAhead !== undefined) {
    stats.push(
      resolveLocalizedText(
        { en: `commitsAhead=${input.commitsAhead}`, 'zh-CN': `领先提交=${input.commitsAhead}` },
        locale,
      ),
    )
  }
  if (input.dirtyFileCount !== undefined) {
    stats.push(
      resolveLocalizedText(
        { en: `dirtyFiles=${input.dirtyFileCount}`, 'zh-CN': `未提交文件=${input.dirtyFileCount}` },
        locale,
      ),
    )
  }
  const statSuffix = stats.length > 0 ? ` (${stats.join(', ')})` : ''
  return resolveLocalizedText(
    {
      en: [
        `Please review and merge the worktree branch from member @${input.memberName} in group ${input.groupId}:`,
        `- worktreeId: ${input.worktreeId}`,
        `- branch: ${input.branch}${statSuffix}`,
        `- path: ${input.path}${input.nodeId !== undefined ? ` (node: ${input.nodeId})` : ''}`,
        `If coordinatorGuard is still enabled, run swarm_close_group({ groupId: "${input.groupId}", keepWorktree: true }) first to unlock bash/edit/write, merge the branch cleanly, and then run cleanup_worktree.`,
      ].join('\n'),
      'zh-CN': [
        `请审阅并合入协作组 ${input.groupId} 成员 @${input.memberName} 的受管 Worktree 分支：`,
        `- worktreeId: ${input.worktreeId}`,
        `- 分支: ${input.branch}${statSuffix}`,
        `- 目录: ${input.path}${input.nodeId !== undefined ? `（节点: ${input.nodeId}）` : ''}`,
        `若当前仍开启主控守卫（coordinatorGuard），请先调用 swarm_close_group({ groupId: "${input.groupId}", keepWorktree: true }) 解锁 bash/edit/write，完成 git merge 与测试验收后再调用 cleanup_worktree 清理。`,
      ].join('\n'),
    },
    locale,
  )
}
