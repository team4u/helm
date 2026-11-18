/**
 * builtin:swarm 协同黑板纯函数与插件定义单测（Unit 档，纯内存零全局副作用）：
 * - 插件定义契约：SWARM_PLUGIN_ID = 'builtin:swarm'、无静态 dependencies: ['builtin:workflow']；
 * - 配置边界（maxWorkersPerGroup 2..32，boardPreviewLimit 20..200）与单真源契约守卫；
 * - Fail-Closed 目标解析（coordinator / all 权限 / #main 400 / 未知或归档频道 / 未知成员）与正交 wake 缺省推导；
 * - BoardViewDoc 合成与 (headSeq, memberStateDigest) 投影指纹去重；
 * - 100% 字节恒定的 <active_swarm_group> 提示词段构造；
 * - 防哑巴退场单次自愈（nudge -> fallback_blocker）与 6 条件 0-Token [stall] 三类根因判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HelmError } from '@helm/protocol'
import {
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_SCOPE,
  COORDINATOR_TAG,
  PARTICIPANT_SCOPE,
  SWARM_PLUGIN_ID,
  SWARM_SKILL_ID,
  WORKER_TAG,
  activeSwarmGroupCoordinatorSection,
  activeSwarmGroupWorkerSection,
  assertBoardPost,
  assertChannelName,
  assertCollabGroupRecord,
  assertGroupId,
  assertIndexDoc,
  assertMemberName,
  createSwarmPlugin,
  diagnoseStallRootCause,
  evaluateGroupQuiescence,
  evaluateSilentExit,
  resolveBoardTargets,
  resolveDefaultWake,
  resolvePostChannel,
  resolveSwarmConfig,
  synthesizeBoardView,
  type BoardPost,
  type CollabGroupRecord,
  type GroupMemberState,
} from '../src/swarm.js'
import { checkCoordinatorEligibility } from '../src/swarm/actions.js'
import { classifyMemberDetailOutcome, inspectBoardWalLines } from '../src/swarm/recovery.js'
import { lastAssistantText } from '../src/entry-text.js'

function makeMember(over: Partial<GroupMemberState> = {}): GroupMemberState {
  return {
    name: 'author',
    conversationId: 11,
    profileId: 'assistant',
    access: 'readwrite',
    isolation: 'worktree',
    nodeId: 'local',
    cwd: '/repo/wt-author',
    worktreeId: 'local:/repo/wt-author',
    channels: ['main'],
    lifecycle: 'active',
    readCursorSeq: 0,
    pendingWakeupSeq: 0,
    createdAt: 1_000,
    ...over,
  }
}

function makeGroup(over: Partial<CollabGroupRecord> = {}): CollabGroupRecord {
  return {
    id: 'grp_test_1',
    title: 'Auth Refactor Squad',
    objective: 'Ship clean auth refactor with full test coverage',
    coordinatorConversationId: 1,
    status: 'active',
    channels: [
      { name: 'main' },
      { name: 'review', topic: 'Code review loop' },
      { name: 'legacy', archived: true },
    ],
    members: [
      makeMember({ name: 'author', conversationId: 11, channels: ['main', 'review'] }),
      makeMember({
        name: 'verifier',
        conversationId: 12,
        access: 'readonly',
        isolation: 'inherit',
        cwd: '/repo',
        worktreeId: undefined,
        channels: ['main', 'review'],
      }),
      makeMember({
        name: 'retired',
        conversationId: 13,
        lifecycle: 'archived',
        archivedAt: 2_000,
        channels: ['main', 'review'],
      }),
    ],
    headSeq: 0,
    coordinatorNotifiedSeq: 0,
    coordinatorPendingSeq: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  }
}

function makePost(seq: number, over: Partial<BoardPost> = {}): BoardPost {
  return {
    seq,
    groupId: 'grp_test_1',
    channel: 'main',
    from: 'coordinator',
    to: ['author'],
    resolvedTargets: ['author'],
    wake: true,
    kind: 'brief',
    refs: [],
    body: `Task #${seq}`,
    createdAt: 1_000 + seq,
    ...over,
  }
}

test('swarm-unit1: plugin definition contract, tags/scopes, config bounds, and single-source validators', { timeout: 60_000 }, () => {
  const def = createSwarmPlugin()
  assert.equal(def.id, SWARM_PLUGIN_ID)
  assert.equal(def.id, 'builtin:swarm')
  assert.equal(SWARM_SKILL_ID, 'swarm')
  // Must NOT declare static dependencies: ['builtin:workflow'] so idle builtin:swarm never blocks disabling builtin:workflow
  assert.equal(def.dependencies, undefined)

  assert.equal(COORDINATOR_TAG, 'swarm-coordinator')
  assert.equal(WORKER_TAG, 'swarm-worker')
  assert.equal(ARCHIVED_WORKER_TAG, 'swarm-worker-archived')
  assert.equal(ARCHIVED_COORDINATOR_TAG, 'swarm-coordinator-archived')
  assert.deepEqual(COORDINATOR_SCOPE, { tags: ['swarm-coordinator'] })
  assert.deepEqual(PARTICIPANT_SCOPE, { tags: ['swarm-coordinator', 'swarm-worker'] })

  const defaults = resolveSwarmConfig({})
  assert.equal(defaults.maxWorkersPerGroup, 12)
  assert.equal(defaults.boardPreviewLimit, 80)

  const custom = resolveSwarmConfig({ maxWorkersPerGroup: 2, boardPreviewLimit: 200 })
  assert.equal(custom.maxWorkersPerGroup, 2)
  assert.equal(custom.boardPreviewLimit, 200)

  assert.throws(() => resolveSwarmConfig({ maxWorkersPerGroup: 1 }), /2\.\.32/)
  assert.throws(() => resolveSwarmConfig({ maxWorkersPerGroup: 33 }), /2\.\.32/)
  assert.throws(() => resolveSwarmConfig({ maxWorkersPerGroup: 4.5 }), /2\.\.32/)
  assert.throws(() => resolveSwarmConfig({ boardPreviewLimit: 19 }), /20\.\.200/)
  assert.throws(() => resolveSwarmConfig({ boardPreviewLimit: 201 }), /20\.\.200/)

  assert.equal(assertMemberName('author-1'), 'author-1')
  for (const reserved of ['coordinator', 'all', 'system']) {
    assert.throws(() => assertMemberName(reserved), /保留字/)
  }
  assert.throws(() => assertMemberName('AuthorUpper'), /非法/)
  assert.throws(() => assertMemberName('has space'), /非法/)

  assert.equal(assertChannelName('review-1'), 'review-1')
  assert.throws(() => assertChannelName('#review'), /非法/)
  assert.equal(assertGroupId('grp_abc-123'), 'grp_abc-123')
  assert.throws(() => assertGroupId('../escape'), /非法/)

  const group = makeGroup({ headSeq: 1 })
  assert.equal(assertCollabGroupRecord(group).id, 'grp_test_1')
  assert.equal(assertBoardPost(makePost(1)).seq, 1)

  assertIndexDoc({
    workers: [
      {
        conversationId: 11,
        coordinatorConversationId: 1,
        profileId: 'assistant',
        groupId: 'grp_test_1',
        name: 'author',
        createdAt: 1,
      },
    ],
    groups: [
      {
        id: 'grp_test_1',
        title: 'Squad',
        coordinatorConversationId: 1,
        status: 'active',
        activeWorkerCount: 1,
        headSeq: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  })
  assert.throws(
    () =>
      assertIndexDoc({
        workers: [{ conversationId: 11, coordinatorConversationId: 1, profileId: 'assistant', groupId: '', name: 'a', createdAt: 1 }],
        groups: [],
      }),
    /非法/,
  )
})

test('swarm-unit2: default wake derivation and Fail-Closed target resolution', { timeout: 60_000 }, () => {
  assert.equal(resolveDefaultWake('comment', ['author']), false)
  assert.equal(resolveDefaultWake('handoff', ['verifier']), true)
  assert.equal(resolveDefaultWake('brief', ['author']), true)
  assert.equal(resolveDefaultWake('review', ['author']), true)
  assert.equal(resolveDefaultWake('done', ['coordinator']), true)
  assert.equal(resolveDefaultWake('blocker', ['coordinator']), true)
  assert.equal(resolveDefaultWake('handoff', []), false)

  const group = makeGroup()
  assert.equal(resolvePostChannel(group, undefined), 'main')
  assert.equal(resolvePostChannel(group, 'review'), 'review')
  assert.throws(
    () => resolvePostChannel(group, 'unknown'),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_unknown_channel' && err.status === 404,
  )
  assert.throws(
    () => resolvePostChannel(group, 'legacy'),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_channel_archived' && err.status === 409,
  )

  // Coordinator 'all' expands only active members (excludes archived 'retired')
  const broadcast = resolveBoardTargets(group, { role: 'coordinator', from: 'coordinator' }, ['all'])
  assert.deepEqual(broadcast.resolvedTargets, ['author', 'verifier'])

  // Worker calling 'all' -> 403 swarm_broadcast_forbidden
  assert.throws(
    () => resolveBoardTargets(group, { role: 'worker', from: 'author' }, ['all']),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_broadcast_forbidden' && err.status === 403,
  )

  // '#main' -> 400 validation_error
  assert.throws(
    () => resolveBoardTargets(group, { role: 'coordinator', from: 'coordinator' }, ['#main']),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  )

  // Unknown '#ghost' -> 404; archived '#legacy' -> 409
  assert.throws(
    () => resolveBoardTargets(group, { role: 'worker', from: 'author' }, ['#ghost']),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_unknown_channel' && err.status === 404,
  )
  assert.throws(
    () => resolveBoardTargets(group, { role: 'worker', from: 'author' }, ['#legacy']),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_channel_archived' && err.status === 409,
  )

  // Active '#review' from 'author' -> expands ['author', 'verifier'], strips self 'author' -> ['verifier']
  const subchannel = resolveBoardTargets(group, { role: 'worker', from: 'author' }, ['#review'])
  assert.deepEqual(subchannel.resolvedTargets, ['verifier'])

  // Archived or unknown member -> 404 swarm_unknown_target
  assert.throws(
    () => resolveBoardTargets(group, { role: 'worker', from: 'author' }, ['retired']),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_unknown_target' && err.status === 404,
  )
  assert.throws(
    () => resolveBoardTargets(group, { role: 'worker', from: 'author' }, ['nobody']),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_unknown_target' && err.status === 404,
  )
})

test('swarm-unit3: synthesizeBoardView, fingerprint deduplication, and byte-constant <active_swarm_group> sections', { timeout: 60_000 }, () => {
  const group = makeGroup({ headSeq: 2 })
  const posts: BoardPost[] = [
    makePost(1, { from: 'coordinator', to: ['author'], resolvedTargets: ['author'], kind: 'brief' }),
    makePost(2, { from: 'author', to: ['verifier'], resolvedTargets: ['verifier'], kind: 'handoff', refs: [1] }),
  ]

  const first = synthesizeBoardView({
    group,
    posts,
    previewLimit: 80,
    resolveMemberLive: (id) => (id === 12 ? { liveState: 'working', model: 'faux/faux-1' } : { liveState: 'idle', model: 'faux/faux-1' }),
  })
  const second = synthesizeBoardView({
    group,
    posts,
    previewLimit: 80,
    resolveMemberLive: (id) => (id === 12 ? { liveState: 'working', model: 'faux/faux-1' } : { liveState: 'idle', model: 'faux/faux-1' }),
  })

  // Identical (headSeq, memberStateDigest) during streaming token frames
  assert.equal(first.digest, second.digest)
  assert.deepEqual(first.view.activeWorkingMembers, ['verifier'])
  assert.equal(first.badge.tone, 'accent')
  assert.equal(first.badge.count, 2)
  assert.equal(first.view.edges.length, 2)

  // State change flips digest and badge tone
  const errored = synthesizeBoardView({
    group,
    posts,
    previewLimit: 80,
    resolveMemberLive: (id) => (id === 12 ? { liveState: 'error', model: 'faux/faux-2' } : { liveState: 'idle', model: 'faux/faux-1' }),
  })
  assert.notEqual(errored.digest, first.digest)
  assert.equal(errored.badge.tone, 'warn')
  assert.equal(errored.view.headline.kind, 'blocker')

  // Byte-constant sections contain <active_swarm_group> and zero mutable roster/headSeq
  const coordSec = activeSwarmGroupCoordinatorSection('grp_test_1')
  assert.match(coordSec, /^<active_swarm_group id="grp_test_1" role="coordinator">/)
  assert.match(coordSec, /load_skill\(\{ skillId: "swarm" \}\)/)
  assert.match(coordSec, /"\/skill:swarm"/)
  assert.match(coordSec, /never follow fixed role-name templates/)
  assert.match(coordSec, /swarm_dispatch_worker/)
  assert.match(coordSec, /<\/active_swarm_group>$/)
  const workerSec = activeSwarmGroupWorkerSection('grp_test_1', 'verifier', 'readonly', 'inherit')
  assert.match(workerSec, /^<active_swarm_group id="grp_test_1" role="worker" name="verifier" access="readonly" isolation="inherit">/)
  assert.match(workerSec, /swarm_board_post/)
  assert.match(workerSec, /readonly/)
})

test('swarm-unit4: At-Most-Once Silent-Exit Nudge and 6-condition 0-Token [stall] 3 root causes', { timeout: 60_000 }, () => {
  const group = makeGroup({ headSeq: 1 })
  const unpostedMember = makeMember({
    name: 'author',
    readCursorSeq: 1,
    pendingWakeupSeq: 1,
    lastWakeTaskSeq: 1,
  })

  // 1st silent exit -> single deterministic nudge
  const step1 = evaluateSilentExit(group, unpostedMember, 'I edited auth.ts locally.')
  assert.equal(step1.kind, 'nudge')
  if (step1.kind === 'nudge') {
    assert.equal(step1.taskSeq, 1)
    assert.match(step1.prompt, /<swarm_silent_exit_nudge/)
    assert.match(step1.prompt, /#1/)
  }

  // 2nd silent exit (silentExitNudgeSeq === lastWakeTaskSeq) -> fallback [blocker] with reply excerpt
  const nudgedMember: GroupMemberState = { ...unpostedMember, silentExitNudgeSeq: 1 }
  const step2 = evaluateSilentExit(group, nudgedMember, 'Still forgot to call board_post.')
  assert.equal(step2.kind, 'fallback_blocker')
  if (step2.kind === 'fallback_blocker') {
    assert.match(step2.body, /Still forgot to call board_post/)
  }

  // Answered task -> none
  const answeredMember: GroupMemberState = { ...nudgedMember, lastPostSeq: 2 }
  assert.equal(evaluateSilentExit(group, answeredMember, 'Done').kind, 'none')

  // Root cause 1: unwoken_output (wake === false leaving target unwoken)
  const g1 = makeGroup({
    headSeq: 2,
    members: [
      makeMember({ name: 'author', conversationId: 11, readCursorSeq: 2, pendingWakeupSeq: 1, lastPostSeq: 2 }),
      makeMember({ name: 'verifier', conversationId: 12, readCursorSeq: 0, pendingWakeupSeq: 0 }),
    ],
  })
  const posts1: BoardPost[] = [
    makePost(1, { from: 'coordinator', to: ['author'], resolvedTargets: ['author'], wake: true, kind: 'brief' }),
    makePost(2, { from: 'author', to: ['verifier'], resolvedTargets: ['verifier'], wake: false, kind: 'comment', body: 'Ready for look' }),
  ]
  const diag1 = diagnoseStallRootCause(g1, posts1)
  assert.equal(diag1.cause, 'unwoken_output')
  assert.equal(diag1.refSeq, 2)
  assert.match(diag1.body, /#2/)

  const q1 = evaluateGroupQuiescence({
    group: g1,
    posts: posts1,
    hasInflightDeliveries: false,
    coordinatorState: { exists: true, liveState: 'idle' },
    memberSnapshots: [
      { name: 'author', liveState: 'idle', completionSeq: 3, isSettling: false },
      { name: 'verifier', liveState: 'idle', completionSeq: 1, isSettling: false },
    ],
  })
  assert.equal(q1.shouldEmitStall, true)

  // Watermark prevents duplicate stall firing when state has not advanced
  if (q1.shouldEmitStall) {
    const repeated = evaluateGroupQuiescence({
      group: { ...g1, lastStallWatermark: '2|author:3,verifier:1' },
      posts: posts1,
      hasInflightDeliveries: false,
      coordinatorState: { exists: true, liveState: 'idle' },
      memberSnapshots: [
        { name: 'author', liveState: 'idle', completionSeq: 3, isSettling: false },
        { name: 'verifier', liveState: 'idle', completionSeq: 1, isSettling: false },
      ],
    })
    assert.equal(repeated.shouldEmitStall, false)
  }

  // Root cause 2: unanswered_wakeup (member read wakeup #2 but never posted)
  const g2 = makeGroup({
    headSeq: 2,
    members: [
      makeMember({ name: 'author', conversationId: 11, readCursorSeq: 2, pendingWakeupSeq: 1, lastPostSeq: 2 }),
      makeMember({ name: 'verifier', conversationId: 12, readCursorSeq: 2, pendingWakeupSeq: 2 }),
    ],
  })
  const posts2: BoardPost[] = [
    makePost(1, { from: 'coordinator', to: ['author'], resolvedTargets: ['author'], wake: true, kind: 'brief' }),
    makePost(2, { from: 'author', to: ['verifier'], resolvedTargets: ['verifier'], wake: true, kind: 'handoff' }),
  ]
  const diag2 = diagnoseStallRootCause(g2, posts2)
  assert.equal(diag2.cause, 'unanswered_wakeup')
  assert.equal(diag2.targetMember, 'verifier')
  assert.equal(diag2.refSeq, 2)
  assert.match(diag2.body, /@verifier/)
  assert.match(diag2.body, /#2/)

  // Root cause 3: idle_without_done (everyone answered their wakeups, all idle, latest post is review -> coordinator without done)
  const g3 = makeGroup({
    headSeq: 3,
    coordinatorNotifiedSeq: 3,
    coordinatorPendingSeq: 3,
    members: [
      makeMember({ name: 'author', conversationId: 11, readCursorSeq: 3, pendingWakeupSeq: 1, lastPostSeq: 2 }),
      makeMember({ name: 'verifier', conversationId: 12, readCursorSeq: 3, pendingWakeupSeq: 2, lastPostSeq: 3 }),
    ],
  })
  const posts3: BoardPost[] = [
    makePost(1, { from: 'coordinator', to: ['author'], resolvedTargets: ['author'], wake: true, kind: 'brief' }),
    makePost(2, { from: 'author', to: ['verifier'], resolvedTargets: ['verifier'], wake: true, kind: 'handoff' }),
    makePost(3, { from: 'verifier', to: ['coordinator'], resolvedTargets: ['coordinator'], wake: true, kind: 'review' }),
  ]
  const diag3 = diagnoseStallRootCause(g3, posts3)
  assert.equal(diag3.cause, 'idle_without_done')
  assert.match(diag3.body, /#3/)
})

test('swarm-unit5: checkCoordinatorEligibility rejects child, worker, archived-worker, and non-human conversations', { timeout: 60_000 }, () => {
  const baseConv = {
    id: 1,
    title: 'Top Chat',
    profileId: 'assistant',
    tags: [] as string[],
    cwd: '/repo',
    model: 'faux/faux-1',
    thinkingLevel: 'off',
    status: 'idle' as const,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  assert.equal(checkCoordinatorEligibility(baseConv, 'human'), undefined)
  assert.equal(checkCoordinatorEligibility({ ...baseConv, tags: [COORDINATOR_TAG] }, 'human'), undefined)
  assert.equal(
    checkCoordinatorEligibility({ ...baseConv, tags: [ARCHIVED_COORDINATOR_TAG] }, 'human'),
    undefined,
    'archived coordinator conversation may start a fresh swarm',
  )
  assert.equal(checkCoordinatorEligibility({ ...baseConv, parentConversationId: 9 }, 'human')?.code, 'validation_error')
  assert.equal(checkCoordinatorEligibility({ ...baseConv, tags: [WORKER_TAG] }, 'human')?.code, 'conversation_scope_violation')
  assert.equal(checkCoordinatorEligibility({ ...baseConv, tags: [ARCHIVED_WORKER_TAG] }, 'human')?.code, 'conversation_scope_violation')
  assert.equal(checkCoordinatorEligibility(baseConv, 'helm')?.code, 'conversation_scope_violation')
  assert.equal(checkCoordinatorEligibility(baseConv, 'bot')?.code, 'conversation_scope_violation')
})

// ---------------------------------------------------------------------------
// lastAssistantText：结算摘要只取 assistant 角色文本（回归：曾把 toolResult/user 文本当成员回复）
// ---------------------------------------------------------------------------

test('lastAssistantText skips toolResult and user text blocks, walking back to the newest assistant text', { timeout: 60_000 }, () => {
  const toolResultEntry = {
    kind: 'pi.tool-result',
    model: [{ role: 'toolResult', content: [{ type: 'text', text: '/root/code/helm\ntotal 388\ndrwxr-xr-x ...' }] }],
  }
  const steerEntry = {
    kind: 'pi.user',
    model: [{ role: 'user', content: [{ type: 'text', text: 'please continue with the next step' }] }],
  }
  const assistantEntry = {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'found the bug' }] }],
  }
  const assistantToolCallOnly = {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }] }],
  }

  // Tail full of tool results and steers: must return the older assistant text, not tool output or user text.
  assert.equal(
    lastAssistantText([assistantEntry, toolResultEntry, toolResultEntry, steerEntry]),
    'found the bug',
  )
  // Assistant entries without text blocks do not stop the backward scan.
  assert.equal(lastAssistantText([assistantEntry, assistantToolCallOnly, toolResultEntry]), 'found the bug')
  // Only tool results: no assistant reply exists -> '' (callers derive honest placeholders).
  assert.equal(lastAssistantText([toolResultEntry]), '')
  // Multiple text blocks of one assistant message join with newlines.
  assert.equal(
    lastAssistantText([
      { kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] },
    ]),
    'a\nb',
  )
  // User entries with plain-string content are ignored as well.
  assert.equal(
    lastAssistantText([{ kind: 'helm.input', model: [{ role: 'user', content: 'plain steer' }] }, assistantEntry]),
    'found the bug',
  )
})

// ---------------------------------------------------------------------------
// unit6 / unit7: WAL 提交点回滚、在途意图契约校验与重启前成员回合终态归因
// ---------------------------------------------------------------------------

test('swarm-unit6: inspectBoardWalLines trims single uncommitted tail or truncated JSON, while rejecting multi-line or prefix corruption', { timeout: 60_000 }, () => {
  const p1 = JSON.stringify(makePost(1))
  const p2 = JSON.stringify(makePost(2, { from: 'author', to: ['coordinator'], resolvedTargets: ['coordinator'], kind: 'done' }))
  const p3 = JSON.stringify(makePost(3, { body: 'uncommitted seq 3' }))

  // Clean committed prefix
  const clean = inspectBoardWalLines(`${p1}\n${p2}\n`, 'grp_test_1', 2)
  assert.equal(clean.trimmed, false)
  assert.equal(clean.posts.length, 2)

  // Empty board with headSeq=0
  const empty = inspectBoardWalLines('', 'grp_test_1', 0)
  assert.equal(empty.trimmed, false)
  assert.equal(empty.posts.length, 0)

  // Single full uncommitted post seq=3 (crash between datasync(board.jsonl) and atomicWriteFile(meta.json))
  const uncommittedFull = inspectBoardWalLines(`${p1}\n${p2}\n${p3}\n`, 'grp_test_1', 2)
  assert.equal(uncommittedFull.trimmed, true)
  assert.equal(uncommittedFull.posts.length, 2)
  assert.equal(uncommittedFull.posts[1]!.seq, 2)

  // Single truncated half-written line (crash mid-appendFile)
  const truncatedTail = inspectBoardWalLines(`${p1}\n{"seq":2,"groupId":"grp_test_1"`, 'grp_test_1', 1)
  assert.equal(truncatedTail.trimmed, true)
  assert.equal(truncatedTail.posts.length, 1)

  // >= 2 uncommitted lines must throw swarm_doc_corrupt rather than silently dropping data
  assert.throws(
    () => inspectBoardWalLines(`${p1}\n${p2}\n${p3}\n`, 'grp_test_1', 1),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_doc_corrupt',
  )

  // Uncommitted line with mismatched seq must throw swarm_doc_corrupt
  const wrongSeq = JSON.stringify(makePost(99))
  assert.throws(
    () => inspectBoardWalLines(`${p1}\n${wrongSeq}\n`, 'grp_test_1', 1),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_doc_corrupt',
  )

  // Fewer lines than meta.headSeq must throw swarm_doc_corrupt
  assert.throws(
    () => inspectBoardWalLines(`${p1}\n`, 'grp_test_1', 2),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_doc_corrupt',
  )

  // Corrupt line inside committed prefix must throw swarm_doc_corrupt
  assert.throws(
    () => inspectBoardWalLines(`{broken\n${p2}\n`, 'grp_test_1', 2),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_doc_corrupt',
  )
})

test('swarm-unit7: recovery metadata validation and classifyMemberDetailOutcome', { timeout: 60_000 }, () => {
  const validWithInflight = makeGroup({
    headSeq: 1,
    createKey: '1:call-create-1',
    inflightReport: {
      requestId: 'swarm-report:grp_test_1:1-1',
      fromSeq: 1,
      toSeq: 1,
      baseCompletionSeq: 2,
      baseLastEntryId: 8,
    },
    members: [
      makeMember({
        dispatchKey: '1:call-disp-1',
        briefPostSeq: 1,
        inflightWakeup: {
          requestId: 'swarm-wakeup:grp_test_1:author:1-1',
          fromSeq: 1,
          toSeq: 1,
          baseCompletionSeq: 0,
          baseLastEntryId: 0,
        },
        inflightNudge: {
          requestId: 'swarm-nudge:grp_test_1:author:1',
          taskSeq: 1,
          baseCompletionSeq: 1,
          baseLastEntryId: 5,
        },
      }),
    ],
  })
  assert.equal(assertCollabGroupRecord(validWithInflight).createKey, '1:call-create-1')
  assert.equal(assertBoardPost(makePost(1, { idempotencyKey: '1:call-post-1' })).idempotencyKey, '1:call-post-1')

  // Reject reversed range in inflightWakeup
  assert.throws(
    () =>
      assertCollabGroupRecord(
        makeGroup({
          members: [
            makeMember({
              inflightWakeup: {
                requestId: 'swarm-wakeup:grp_test_1:author:3-1',
                fromSeq: 3,
                toSeq: 1,
                baseCompletionSeq: 0,
                baseLastEntryId: 0,
              },
            }),
          ],
        }),
      ),
    (err: unknown) => err instanceof HelmError && err.code === 'swarm_doc_corrupt',
  )

  const member = makeMember({ name: 'author', lastWakeTaskSeq: 2, lastWakeCompletionSeq: 1 })
  // Error summary -> failed
  assert.deepEqual(
    classifyMemberDetailOutcome([], { status: 'error', completionSeq: 1, lastError: 'upstream 500' }, 'grp_test_1', member),
    { kind: 'failed', error: 'upstream 500' },
  )

  // Matching wake input + completed assistant reply (even if completionSeq hasn't flushed yet) -> completed
  assert.deepEqual(
    classifyMemberDetailOutcome(
      [
        { id: '10', kind: 'helm.input', data: { id: 'swarm-wakeup:grp_test_1:author:1-2' } },
        { id: '11', kind: 'pi.assistant', model: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'forgot post' }] }] },
      ],
      { status: 'idle', completionSeq: 1 },
      'grp_test_1',
      member,
    ),
    { kind: 'completed' },
  )

  // Matching wake input + aborted assistant reply -> aborted (do not nudge)
  assert.deepEqual(
    classifyMemberDetailOutcome(
      [
        { id: '10', kind: 'helm.input', data: { id: 'swarm-wakeup:grp_test_1:author:1-2' } },
        { id: '11', kind: 'pi.assistant', model: [{ role: 'assistant', stopReason: 'aborted', content: [] }] },
      ],
      { status: 'idle', completionSeq: 2 },
      'grp_test_1',
      member,
    ),
    { kind: 'aborted' },
  )

  // Unrelated older input while completionSeq <= lastWakeCompletionSeq -> pending_queue (still in pi.inbox)
  assert.deepEqual(
    classifyMemberDetailOutcome(
      [
        { id: '8', kind: 'helm.input', data: { id: 'swarm-wakeup:grp_test_1:author:1-1' } },
        { id: '9', kind: 'pi.assistant', model: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'old' }] }] },
      ],
      { status: 'idle', completionSeq: 1 },
      'grp_test_1',
      member,
    ),
    { kind: 'pending_queue' },
  )
})
