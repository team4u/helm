/**
 * builtin:swarm 协同黑板与对等交接真实组合层整链集成测试（Integration 档）：
 * 1) 默认启用、启动零常驻会话、空闲态不阻塞 disable('builtin:workflow')、受管技能 swarm 随启停显隐、
 *    create_group 同回合下一拍解锁团队工具并剥离重工具、扩缩容期间 <active_swarm_group> 100% 字节恒定、inUse 保护；
 * 2) Author(worktree) + Verifier(readonly) 真实 Git Worktree 交接快照、空闲期 ManagedWorktreeHold 防删与阻塞 workflow 停用、
 *    只读成员写工具/非幂等外部动作拦截、两态 close_group(409 swarm_worktree_unmerged vs keepWorktree: true 解锁主控 bash 合入、
 *    主控 tag 原地替换为 swarm-coordinator-archived 历史 tag：工作台面板可达、建组解锁、协同工具不复活、重建组摘除历史 tag)、
 *    closed 与 coordinatorDetached 历史组 board_status / board_read 正常读取；
 * 3) forkFrom 干净锚点热分叉、manage_channel + #channel 寻址、被动留言(wake: false)与合并唤醒、
 *    abort_worker 原地刹车、switch_worker_model 原地切模，以及 @/# 幂等补全动作；
 * 4) 回合 failed 自动上板 [blocker]、防哑巴退场单次续催 -> 二次命中代发 [blocker]、
 *    6 条件 0-Token 根因 [stall] 守卫，以及 Hub 重启补发未送达信封。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'

import { HelmError } from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { createHelm } from '../../hub/src/app.js'
import {
  createGitTemplate,
  deferred,
  makeFauxProvider,
  useTempDir,
  waitFor,
  type FauxProviderHandle,
} from './helpers/plugin-test-env.js'
import {
  ARCHIVED_COORDINATOR_TAG,
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  SWARM_SKILL_ID,
  WORKER_TAG,
  type BoardBadgesDoc,
  type BoardPost,
  type BoardViewDoc,
  type SwarmIndexDoc,
} from '../src/swarm.js'

const WORKFLOW_ID = 'builtin:workflow'

const gitTemplate = createGitTemplate()
test.after(() => gitTemplate.cleanup())

interface SwarmTestEnv {
  dataDir: string
  repoDir: string
  faux: FauxProviderHandle
  app: Awaited<ReturnType<typeof createHelm>>
  close(): Promise<void>
}

async function openSwarmEnv(root: string): Promise<SwarmTestEnv> {
  const dataDir = join(root, 'data')
  const repoDir = join(root, 'repo')
  gitTemplate.cloneTo(repoDir)
  const faux = makeFauxProvider({
    models: [{ id: 'faux-1' }, { id: 'faux-2' }],
  })
  const app = await createHelm({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: repoDir,
    model: 'faux/faux-1',
    providers: [faux.provider],
  })
  faux.setResponses([])
  return {
    dataDir,
    repoDir,
    faux,
    app,
    async close() {
      await app.close()
    },
  }
}

function captureRequestMeta(messages: readonly Record<string, unknown>[]): {
  toolNames: string[]
  sectionsById: Record<string, string>
} {
  const tools = getCurrentTools(messages as never)
  const sectionsById: Record<string, string> = {}
  for (const m of messages) {
    if (m['role'] === 'system' && typeof m['sections'] === 'object' && m['sections'] !== null) {
      for (const [k, v] of Object.entries(m['sections'] as Record<string, unknown>)) {
        if (typeof v === 'string') sectionsById[k] = v
      }
    }
  }
  return {
    toolNames: tools.map((t) => t.name),
    sectionsById,
  }
}

type FauxStep = NonNullable<Parameters<FauxProviderHandle['setResponses']>[0]>[number]
type FauxFactoryArgs = Parameters<Extract<FauxStep, (...args: never[]) => unknown>>

function setSwarmRoleResponses(
  faux: FauxProviderHandle,
  queues: Record<string, FauxStep[]>,
  maxCalls = 32,
): void {
  const cursors = new Map<string, number>()
  const dispatch: FauxStep = (async (ctx: FauxFactoryArgs[0], ...rest: [FauxFactoryArgs[1], FauxFactoryArgs[2], FauxFactoryArgs[3]]) => {
    const groupSec =
      captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group'] ?? ''
    const workerMatch = /role="worker" name="([^"]+)"/.exec(groupSec)
    const roleKey = workerMatch ? workerMatch[1]! : groupSec.includes('role="coordinator"') ? 'coordinator' : 'other'
    const list = queues[roleKey] ?? queues['*'] ?? []
    const idx = cursors.get(roleKey) ?? 0
    cursors.set(roleKey, idx + 1)
    const step = list[idx]
    if (step === undefined) {
      throw new Error(`Unexpected faux request for swarm role "${roleKey}" at index ${idx}`)
    }
    if (typeof step === 'function') {
      return await step(ctx, ...rest)
    }
    return step
  }) as FauxStep
  faux.setResponses(Array.from({ length: maxCalls }, () => dispatch))
}

test('swarm-int1: default-enabled zero-resident boot, idle workflow-disable freedom, swarm skill lifecycle, same-turn tool unlock, byte-constant <active_swarm_group>, and inUse guard', { timeout: 60_000 }, async (t) => {
  const env = await openSwarmEnv(useTempDir(t, 'helm-swarm-int-'))
  try {
    const { kernel } = env.app

    // 1) Default-enabled in createHelm, zero background resident conversations created on boot!
    const swarmSummary = kernel.plugins.list().find((p) => p.id === SWARM_PLUGIN_ID)
    assert.ok(swarmSummary, 'createHelm must register builtin:swarm')
    assert.equal(swarmSummary!.enabled, true, 'builtin:swarm must be default-enabled')
    const bootConvs = kernel.listConversations()
    assert.equal(
      bootConvs.some((c) => c.ownedBy === 'helm' || c.tags.includes(COORDINATOR_TAG) || c.tags.includes(WORKER_TAG)),
      false,
      'builtin:swarm must NOT create any global resident conversations on boot',
    )

    // 2) Coexistence with builtin:superagent AND idle workflow-disable freedom:
    //    - Enabling builtin:superagent alongside default-enabled builtin:swarm passes listTools() with zero duplicate_tool_name!
    await kernel.plugins.enable('builtin:superagent')
    const coexistingToolNames = kernel.plugins.listTools().map((tool) => tool.name)
    assert.ok(coexistingToolNames.includes('dispatch_worker'), 'superagent dispatch_worker coexists cleanly')
    assert.ok(coexistingToolNames.includes('swarm_dispatch_worker'), 'swarm_dispatch_worker coexists cleanly')
    assert.ok(coexistingToolNames.includes('swarm_board_post'), 'swarm_board_post coexists cleanly')
    await kernel.plugins.disable('builtin:superagent')

    //    - Idle builtin:swarm has NO static dependency on builtin:workflow -> disabling & re-enabling builtin:workflow succeeds!
    await kernel.plugins.disable(WORKFLOW_ID)
    assert.equal(kernel.plugins.list().find((p) => p.id === WORKFLOW_ID)?.enabled, false)
    await kernel.plugins.enable(WORKFLOW_ID)
    assert.equal(kernel.plugins.list().find((p) => p.id === WORKFLOW_ID)?.enabled, true)

    const coord = await kernel.createConversation({ title: 'Feature Chat', profileId: 'assistant', cwd: env.repoDir })

    // 3) swarm managed skill is available while builtin:swarm is enabled, with no duplicate ui.command
    assert.equal(SWARM_SKILL_ID, 'swarm')
    assert.equal(
      kernel.plugins.listUi().filter((u) => u.pluginId === SWARM_PLUGIN_ID && u.surface === 'commandPalette').length,
      0,
      'builtin:swarm must not register duplicate ui.command',
    )
    const loadedSkill = (await kernel.plugins.executeTool(
      'load_skill',
      { skillId: SWARM_SKILL_ID },
      { conversationId: coord.id },
    )) as { text: string }
    assert.match(loadedSkill.text, /Zero-Coding Coordinator Rule/)
    assert.match(loadedSkill.text, /swarm_create_group/)
    assert.match(loadedSkill.text, /swarm_dispatch_worker/)
    assert.match(loadedSkill.text, /helm swarm/)

    // 4) Before swarm_create_group: #C sees swarm_create_group + subagent/bash/edit/write, NOT swarm_dispatch_worker/swarm_board_*
    const preCapture: Array<{ toolNames: string[]; sectionsById: Record<string, string> }> = []
    env.faux.setResponses([
      (ctx) => {
        preCapture.push(captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]))
        return fauxAssistantMessage([fauxToolCall('swarm_create_group', { title: 'API Squad', objective: 'Ship v2 API' })], {
          stopReason: 'toolUse',
        })
      },
      (ctx) => {
        // Same turn, very next LLM request after swarm_create_group!
        preCapture.push(captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]))
        return fauxAssistantMessage('Group created and squad tools unlocked.')
      },
    ])

    await kernel.submitInput(coord.id, 'Start a squad')
    await kernel.waitForIdle(coord.id)
    assert.equal(preCapture.length, 2)

    const beforeTools = preCapture[0]!.toolNames
    assert.ok(beforeTools.includes('swarm_create_group'))
    assert.ok(beforeTools.includes('subagent'))
    assert.ok(beforeTools.includes('bash'))
    assert.equal(beforeTools.includes('swarm_dispatch_worker'), false)
    assert.equal(beforeTools.includes('swarm_board_post'), false)
    assert.equal(preCapture[0]!.sectionsById['swarm.active_group'], undefined)

    // Next beat inside the SAME turn: squad tools unlocked, swarm_create_group & heavy tools stripped!
    const afterTools = preCapture[1]!.toolNames
    for (const expected of [
      'swarm_update_group',
      'swarm_dispatch_worker',
      'swarm_board_post',
      'swarm_board_read',
      'swarm_board_status',
      'swarm_abort_worker',
      'swarm_switch_worker_model',
      'swarm_inspect_worker',
      'swarm_archive_worker',
      'swarm_close_group',
    ]) {
      assert.ok(afterTools.includes(expected), `expected ${expected} unlocked after swarm_create_group (actual: ${afterTools.join(',')})`)
    }
    for (const stripped of ['swarm_create_group', 'subagent', 'SubagentWorkflow', 'bash', 'edit', 'write']) {
      assert.equal(afterTools.includes(stripped), false, `expected ${stripped} stripped on guarded coordinator`)
    }
    const sectionInitial = preCapture[1]!.sectionsById['swarm.active_group']
    assert.ok(typeof sectionInitial === 'string' && sectionInitial.includes('<active_swarm_group'))

    // Duplicate create_group on the same coordinator returns 409 swarm_group_already_active
    await assert.rejects(
      () => kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', { title: 'Second', conversationId: coord.id }),
      (err: unknown) => err instanceof HelmError && err.code === 'swarm_group_already_active' && err.status === 409,
    )

    // Active group blocks non-force disable of builtin:swarm via inUse()
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await assert.rejects(
      () => kernel.plugins.disable(SWARM_PLUGIN_ID),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_in_use' && err.status === 409,
    )

    // 5) Recruit 2 members, mutate group title/objective, archive 1 member -> coordinator <active_swarm_group> stays 100% byte-identical!
    setSwarmRoleResponses(env.faux, {
      alpha: [
        fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'w1 booted' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('w1 idle'),
      ],
      beta: [
        fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'w2 booted' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('w2 idle'),
      ],
      coordinator: [fauxAssistantMessage('Coordinator noted idle boot comments.')],
    })
    const w1 = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Role 1', name: 'alpha' },
      { conversationId: coord.id },
    )) as { workerConversationId: number; groupId: string }
    const w2 = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Role 2', name: 'beta' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }
    await kernel.waitForIdle(w1.workerConversationId)
    await kernel.waitForIdle(w2.workerConversationId)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)

    const indexDoc = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
    assert.equal(indexDoc.workers.length, 2)
    assert.equal(indexDoc.workers[0]!.coordinatorConversationId, coord.id)

    await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'update_group',
      { groupId: w1.groupId, title: 'Renamed API Squad', objective: 'Updated objective text' },
      { conversationId: coord.id },
    )
    await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'archive_worker',
      { groupId: w1.groupId, name: 'beta' },
      { conversationId: coord.id },
    )

    let sectionAfterScaling: string | undefined
    setSwarmRoleResponses(env.faux, {
      coordinator: [
        (ctx) => {
          sectionAfterScaling = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group']
          return fauxAssistantMessage([fauxToolCall('bash', { command: 'echo blocked' })], { stopReason: 'toolUse' })
        },
        fauxAssistantMessage('Guard blocked bash as expected.'),
      ],
    })
    await kernel.submitInput(coord.id, 'Check prompt cache stability and guard')
    await kernel.waitForIdle(coord.id)

    assert.equal(sectionAfterScaling, sectionInitial, 'active_swarm_group section must stay 100% byte-constant across member scaling and metadata edits')
    const detail = await kernel.getConversationDetail(coord.id, { limit: 10 })
    assert.match(JSON.stringify(detail.entries), /coordinatorGuard/, 'tool_call guard must block coordinator bash')

    // Close group -> skill disappears once plugin is disabled
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: w1.groupId }, { conversationId: coord.id })
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.plugins.disable(SWARM_PLUGIN_ID)
    await assert.rejects(
      () => kernel.plugins.executeTool('load_skill', { skillId: SWARM_SKILL_ID }, { conversationId: coord.id }),
      (err: unknown) => err instanceof HelmError && err.code === 'skill_not_available',
    )
  } finally {
    await env.close()
  }
})

test('swarm-int2: Author(worktree) + Verifier(readonly) handoff, hold blocks workflow disable & cleanup_worktree, readonly write-blocking, two-mode close_group unlock & merge, and closed/detached board_status', { timeout: 60_000 }, async (t) => {
  const env = await openSwarmEnv(useTempDir(t, 'helm-swarm-int-'))
  try {
    const { kernel } = env.app
    const coord = await kernel.createConversation({ title: 'Release Coordinator', profileId: 'assistant', cwd: env.repoDir })

    const { groupId } = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'create_group',
      { title: 'Feature Delivery', objective: 'Implement and verify feature.txt', conversationId: coord.id },
    )) as { groupId: string }

    // Dispatch verifier (readonly, inherit) first so it is idle when author hands off
    setSwarmRoleResponses(env.faux, {
      verifier: [
        fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'verifier standing by' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Standing by for author handoff.'),
      ],
      coordinator: [fauxAssistantMessage('Coordinator noted verifier boot stall.')],
    })
    const verifier = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Wait for author handoff and verify.', name: 'verifier', access: 'readonly', isolation: 'inherit' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }
    await kernel.waitForIdle(verifier.workerConversationId)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)

    const verifierBlockedReasons: string[] = []
    let authorStep = 0
    let verifierStep = 0
    const routeSquadStep = (ctx: { messages: unknown[] }) => {
      const groupSec = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group'] ?? ''
      if (groupSec.includes('name="author"')) {
        authorStep += 1
        if (authorStep === 1) {
          return fauxAssistantMessage(
            [
              fauxToolCall('bash', {
                command: 'printf "verified-payload\\n" > feature.txt && git add feature.txt && git commit -m "feat: add feature.txt"',
              }),
            ],
            { stopReason: 'toolUse' },
          )
        }
        if (authorStep === 2) {
          return fauxAssistantMessage(
            [
              fauxToolCall('swarm_board_post', {
                to: ['verifier'],
                kind: 'handoff',
                refs: [2],
                body: 'Implemented feature.txt in worktree; ready for verification.',
              }),
            ],
            { stopReason: 'toolUse' },
          )
        }
        return fauxAssistantMessage('Handed off to @verifier.')
      }
      if (groupSec.includes('name="verifier"')) {
        verifierStep += 1
        if (verifierStep === 1) {
          return fauxAssistantMessage([fauxToolCall('write', { path: 'hack.txt', content: 'nope' })], { stopReason: 'toolUse' })
        }
        if (verifierStep === 2) {
          verifierBlockedReasons.push(JSON.stringify(ctx.messages.slice(-2)))
          return fauxAssistantMessage(
            [
              fauxToolCall('run_action', {
                actionId: 'builtin:workflow.cleanup_worktree',
                input: { path: env.repoDir },
              }),
            ],
            { stopReason: 'toolUse' },
          )
        }
        if (verifierStep === 3) {
          verifierBlockedReasons.push(JSON.stringify(ctx.messages.slice(-2)))
          return fauxAssistantMessage([fauxToolCall('bash', { command: 'git log -n 1 --oneline' })], { stopReason: 'toolUse' })
        }
        if (verifierStep === 4) {
          return fauxAssistantMessage(
            [
              fauxToolCall('swarm_board_post', {
                to: ['coordinator'],
                kind: 'done',
                refs: [3],
                body: 'Verified feature.txt commit cleanly (#3).',
              }),
            ],
            { stopReason: 'toolUse' },
          )
        }
        return fauxAssistantMessage('Verification complete.')
      }
      return fauxAssistantMessage('All slices verified; ready to merge.')
    }
    env.faux.setResponses(Array.from({ length: 14 }, () => routeSquadStep))

    const author = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Create and commit feature.txt, then hand off to verifier.', name: 'author', access: 'readwrite', isolation: 'worktree' },
      { conversationId: coord.id },
    )) as { workerConversationId: number; worktreeId: string }

    assert.ok(typeof author.worktreeId === 'string' && author.worktreeId.length > 0)

    await waitFor(async () => {
      const status = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
      return status.posts.some((p) => p.kind === 'done' && p.from === 'verifier')
    })
    await kernel.waitForIdle(author.workerConversationId)
    await kernel.waitForIdle(verifier.workerConversationId)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)

    // Verify readonly blocks occurred for both write and non-idempotent run_action
    assert.equal(verifierBlockedReasons.length, 2)
    assert.match(verifierBlockedReasons[0]!, /readonly/)
    assert.match(verifierBlockedReasons[1]!, /非幂等外部动作/)

    // Verify handoff post #3 carries auto-inlined worktreeSnapshot
    const readRes = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
      posts: BoardPost[]
    }
    const handoffPost = readRes.posts.find((p) => p.from === 'author' && p.kind === 'handoff')
    assert.ok(handoffPost !== undefined, 'handoff post from author must exist')
    assert.ok(handoffPost!.worktreeSnapshot !== undefined, 'handoff post must inline worktreeSnapshot')
    assert.equal(handoffPost!.worktreeSnapshot!.worktreeId, author.worktreeId)
    assert.equal(handoffPost!.worktreeSnapshot!.commitsAhead, 1)
    assert.ok(handoffPost!.worktreeSnapshot!.changedFilesPreview.includes('feature.txt'))

    // Verify O(1) board-badges populated for coordinator AND both active members
    const badges = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'board-badges').value as BoardBadgesDoc
    for (const id of [coord.id, author.workerConversationId, verifier.workerConversationId]) {
      assert.equal(badges.byConversation[String(id)]?.groupId, groupId)
      assert.equal(badges.byConversation[String(id)]?.coordinatorConversationId, coord.id)
      assert.equal(badges.byConversation[String(id)]?.count, 2)
    }

    // Verify sessionDoc('board-view') matches board_status
    const sessionView = kernel.plugins.getPublicSessionDoc(SWARM_PLUGIN_ID, 'board-view', coord.id).value as BoardViewDoc
    assert.equal(sessionView.group.id, groupId)
    assert.ok(sessionView.edges.some((e) => e.from === 'author' && e.to === 'verifier'))

    // Verify coordinator timeline report and worker wakeup carry swarm:board-report & swarm:board-wakeup renderers
    const coordDetail = await kernel.getConversationDetail(coord.id, { limit: 20 })
    assert.match(JSON.stringify(coordDetail.entries), /swarm:board-report/)
    const verifierDetail = await kernel.getConversationDetail(verifier.workerConversationId, { limit: 20 })
    assert.match(JSON.stringify(verifierDetail.entries), /swarm:board-wakeup/)

    // Held worktree enforces 409 plugin_in_use on disable('builtin:workflow') AND 409 worktree_in_use on cleanup_worktree(force: true)!
    await assert.rejects(
      () => kernel.plugins.disable(WORKFLOW_ID),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_in_use' && err.status === 409,
    )
    await assert.rejects(
      () => kernel.plugins.invokeAction(WORKFLOW_ID, 'cleanup_worktree', { worktreeId: author.worktreeId, force: true }),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'worktree_in_use' &&
        err.status === 409 &&
        err.message.includes(groupId),
    )

    // Default close_group({}) without keepWorktree MUST reject unmerged branch with 409 swarm_worktree_unmerged (keeping hold intact!)
    await assert.rejects(
      () => kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id }),
      (err: unknown) => err instanceof HelmError && err.code === 'swarm_worktree_unmerged' && err.status === 409,
    )
    await assert.rejects(
      () => kernel.plugins.invokeAction(WORKFLOW_ID, 'cleanup_worktree', { worktreeId: author.worktreeId, force: true }),
      (err: unknown) => err instanceof HelmError && err.code === 'worktree_in_use',
    )

    // Unlock-merge mode: close_group({ keepWorktree: true }) releases hold, preserves branch, and strips swarm-coordinator tag to restore bash!
    const closed = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'close_group',
      { groupId, keepWorktree: true, summary: 'Ready for coordinator merge' },
      { conversationId: coord.id },
    )) as {
      closed: boolean
      retainedWorktrees: Array<{ memberName: string; worktreeId: string; branch: string; path: string; commitsAhead: number }>
    }
    assert.equal(closed.closed, true)
    assert.equal(closed.retainedWorktrees.length, 1)
    const retained = closed.retainedWorktrees[0]!
    assert.equal(retained.memberName, 'author')
    assert.equal(retained.commitsAhead, 1)
    assert.ok(existsSync(join(retained.path, 'feature.txt')))
    assert.equal(kernel.getConversation(coord.id).tags.includes(COORDINATOR_TAG), false, 'coordinator must drop swarm-coordinator tag')
    assert.equal(
      kernel.getConversation(coord.id).tags.includes(ARCHIVED_COORDINATOR_TAG),
      true,
      'closed coordinator keeps the history tag so the workbench orchestration panel stays reachable',
    )

    // Coordinator #C now has bash restored and merges the retained branch, then cleans up worktree cleanly!
    let postCloseToolNames: string[] = []
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('bash', { command: `git merge --no-edit ${retained.branch}` })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [fauxToolCall('cleanup_worktree', { worktreeId: retained.worktreeId, deleteBranch: true })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Merged and cleaned up worktree.'),
      (ctx) => {
        postCloseToolNames = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).toolNames
        return fauxAssistantMessage('Post-close probe done.')
      },
    ])
    await kernel.submitInput(coord.id, 'Merge retained branch and clean up')
    await kernel.waitForIdle(coord.id)

    // Trigger the post-close probe turn to capture the coordinator tool list after group close.
    await kernel.submitInput(coord.id, 'Post-close tool probe')
    await kernel.waitForIdle(coord.id)

    assert.equal(readFileSync(join(env.repoDir, 'feature.txt'), 'utf8').trim(), 'verified-payload')
    assert.equal(existsSync(retained.path), false, 'worktree directory must be removed after merge + cleanup_worktree')

    // History-tag tool semantics: after close the archived tag unlocks swarm_create_group again
    // while granting zero participant/coordinator tools (no active group, tag is UI-history only).
    assert.ok(postCloseToolNames.includes('bash'), 'coordinator bash restored after close')
    assert.ok(postCloseToolNames.includes('swarm_create_group'), 'archived coordinator may start a fresh swarm')
    assert.equal(postCloseToolNames.includes('swarm_dispatch_worker'), false, 'history tag must not resurrect squad tools')
    assert.equal(postCloseToolNames.includes('swarm_board_post'), false, 'history tag must not resurrect board tools')

    // Re-creating a group on the same conversation swaps the history tag back to the active coordinator tag.
    const recreated = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Second run',
      conversationId: coord.id,
    })) as { groupId: string }
    assert.notEqual(recreated.groupId, groupId)
    const coordTagsAfterRecreate = kernel.getConversation(coord.id).tags
    assert.equal(coordTagsAfterRecreate.includes(COORDINATOR_TAG), true, 're-created group restores the active coordinator tag')
    assert.equal(coordTagsAfterRecreate.includes(ARCHIVED_COORDINATOR_TAG), false, 'history tag is stripped on re-activation')
    await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'close_group',
      { groupId: recreated.groupId },
      { conversationId: coord.id },
    )
    assert.equal(kernel.getConversation(coord.id).tags.includes(ARCHIVED_COORDINATOR_TAG), true, 'closing again re-swaps to the history tag')

    // Closed group and coordinatorDetached fallback: delete coordinator #C, board_status & board_read still work!
    await kernel.deleteConversation(coord.id)
    await waitFor(async () => {
      const view = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
      return view.group.coordinatorDetached === true && view.group.status === 'closed'
    })
    const finalPosts = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
    assert.ok(finalPosts.posts.length >= 4)
  } finally {
    await env.close()
  }
})

test('swarm-int3: forkFrom clean anchor, #channel addressing & passive wake=false coalescing, abort_worker brake, switch_worker_model, inspect_worker, and @/# completions', { timeout: 60_000 }, async (t) => {
  const env = await openSwarmEnv(useTempDir(t, 'helm-swarm-int-'))
  try {
    const { kernel } = env.app
    const coord = await kernel.createConversation({ title: 'Context Coordinator', profileId: 'assistant', cwd: env.repoDir })

    // Seed real history on coordinator before forking
    env.faux.setResponses([fauxAssistantMessage('Architecture context: token format is v3-hmac.')])
    await kernel.submitInput(coord.id, 'Remember architecture token format v3-hmac')
    await kernel.waitForIdle(coord.id)

    const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Channel & Fork Squad',
      channels: [{ name: 'qa', topic: 'QA channel' }],
      conversationId: coord.id,
    })) as { groupId: string }

    // Dispatch forked worker (forkFrom: 'coordinator' without explicit entryId)
    let forkedSawHistory = false
    setSwarmRoleResponses(env.faux, {
      coder: [
        (ctx) => {
          forkedSawHistory = JSON.stringify(ctx.messages).includes('v3-hmac')
          return fauxAssistantMessage([fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'comment', body: 'forked ready' })], {
            stopReason: 'toolUse',
          })
        },
        fauxAssistantMessage('Forked worker parked.'),
      ],
      coordinator: [fauxAssistantMessage('Coordinator noted forked worker stall.')],
    })
    const coder = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Stand by with forked context.', name: 'coder', forkFrom: 'coordinator', channels: ['qa'] },
      { conversationId: coord.id },
    )) as { workerConversationId: number }
    await kernel.waitForIdle(coder.workerConversationId)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)
    assert.equal(forkedSawHistory, true, 'forkFrom="coordinator" must inherit clean parent conversation history')
    assert.deepEqual(kernel.getConversation(coder.workerConversationId).tags, [WORKER_TAG], 'forked worker must have swarm-worker tag only')

    // Verify inspect_worker & @ / # completion actions
    const inspected = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'inspect_worker',
      { groupId, name: 'coder' },
      { conversationId: coord.id },
    )) as { conversationId: number; name: string; groupId: string }
    assert.equal(inspected.conversationId, coder.workerConversationId)
    assert.equal(inspected.name, 'coder')
    assert.equal(inspected.groupId, groupId)

    const atItems = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'complete_board_members',
      { query: 'cod', conversationId: coord.id },
      { conversationId: coord.id },
    )) as { items: Array<{ id: string }> }
    assert.deepEqual(atItems.items.map((i) => i.id), ['coder'])
    const hashItems = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'complete_board_channels',
      { query: '', conversationId: coder.workerConversationId },
      { conversationId: coder.workerConversationId },
    )) as { items: Array<{ id: string }> }
    assert.deepEqual(hashItems.items.map((i) => i.id), ['qa'])

    // Passive comment (wake: false default) MUST NOT wake idle coder
    const beforeCompletionSeq = kernel.getConversation(coder.workerConversationId).completionSeq
    const statusBeforePassive = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
    const coderBefore = statusBeforePassive.members.find((m) => m.name === 'coder')!
    const commentRes = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_post', {
      groupId,
      to: ['coder'],
      kind: 'comment',
      body: 'Passive heads-up note #A',
    })) as { post: BoardPost }
    assert.equal(commentRes.post.wake, false)
    await Promise.resolve()
    assert.equal(kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID), 0, 'passive comment must not schedule any wakeup task')
    const statusAfterPassive = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
    const coderAfter = statusAfterPassive.members.find((m) => m.name === 'coder')!
    assert.equal(coderAfter.pendingWakeupSeq, coderBefore.pendingWakeupSeq, 'passive comment must not advance pendingWakeupSeq')
    assert.equal(coderAfter.liveState, 'idle')
    await kernel.waitForIdle(coder.workerConversationId)
    assert.equal(
      kernel.getConversation(coder.workerConversationId).completionSeq,
      beforeCompletionSeq,
      'comment(wake=false) must not wake an idle member',
    )

    // Subsequent wake=true via '#qa' channel sweeps BOTH the passive comment AND the handoff into one wakeup!
    let sweptPrompt = ''
    const slowGate = deferred<void>()
    setSwarmRoleResponses(env.faux, {
      coder: [
        async (ctx) => {
          sweptPrompt = JSON.stringify(ctx.messages.slice(-2))
          await slowGate.promise
          return fauxAssistantMessage('Should be aborted before finishing')
        },
      ],
    })
    await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_post', {
      groupId,
      to: ['#qa'],
      kind: 'handoff',
      body: 'Active QA handoff #B',
    })
    await waitFor(() => sweptPrompt !== '')
    assert.match(sweptPrompt, /Passive heads-up note #A/, 'wakeup envelope must sweep prior wake=false comment')
    assert.match(sweptPrompt, /Active QA handoff #B/)

    // While coder is working: switch_worker_model rejects with 409 swarm_worker_busy; abort_worker stops in place!
    await assert.rejects(
      () =>
        kernel.plugins.invokeAction(
          SWARM_PLUGIN_ID,
          'switch_worker_model',
          { groupId, name: 'coder', model: 'faux/faux-2' },
          { conversationId: coord.id },
        ),
      (err: unknown) => err instanceof HelmError && err.code === 'swarm_worker_busy' && err.status === 409,
    )

    const abortPromise = kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'abort_worker',
      { groupId, name: 'coder' },
      { conversationId: coord.id },
    ) as Promise<{ aborted: boolean }>
    slowGate.resolve()
    const abortRes = await abortPromise
    assert.equal(abortRes.aborted, true)
    await kernel.waitForIdle(coder.workerConversationId)

    // Once idle: switch_worker_model switches model to faux/faux-2 in place!
    const switched = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'switch_worker_model',
      { groupId, name: 'coder', model: 'faux/faux-2' },
      { conversationId: coord.id },
    )) as { model: string }
    assert.equal(switched.model, 'faux/faux-2')
    assert.equal(kernel.getConversation(coder.workerConversationId).model, 'faux/faux-2')

    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id })
  } finally {
    await env.close()
  }
})

test('swarm-int4: failed turn auto [blocker], At-Most-Once Silent-Exit Nudge -> fallback [blocker], 0-Token [stall], and Hub restart recovery', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-swarm-selfheal-')
  const dataDir = join(root, 'data')
  const repoDir = join(root, 'repo')
  gitTemplate.cloneTo(repoDir)

  const makeInstance = async (configureFaux?: (faux: FauxProviderHandle) => void) => {
    const faux = makeFauxProvider({ models: [{ id: 'faux-1' }, { id: 'faux-2' }] })
    if (configureFaux !== undefined) {
      configureFaux(faux)
    } else {
      faux.setResponses([])
    }
    const app = await createHelm({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: repoDir,
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    return { faux, app }
  }

  let inst = await makeInstance()
  try {
    const coord = await inst.app.kernel.createConversation({ title: 'Resilience Coord', profileId: 'assistant', cwd: repoDir })
    const { groupId } = (await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Self-Heal Squad',
      conversationId: coord.id,
    })) as { groupId: string }

    // 1) At-Most-Once Silent-Exit Nudge -> 2nd silent exit emits fallback [blocker] (no infinite loop!)
    let silentTurns = 0
    setSwarmRoleResponses(inst.faux, {
      mute: [
        () => {
          silentTurns += 1
          return fauxAssistantMessage('First turn: forgot to call board_post.')
        },
        () => {
          silentTurns += 1
          return fauxAssistantMessage('Second turn after nudge: still forgot to call board_post.')
        },
      ],
      coordinator: [fauxAssistantMessage('Coordinator noted silent-exit blocker.')],
    })

    const muteWorker = (await inst.app.kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Implement task and report.', name: 'mute' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }

    await waitFor(async () => {
      const read = (await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
        posts: BoardPost[]
      }
      return read.posts.some((p) => p.from === 'system' && p.kind === 'blocker' && p.body.includes('@mute'))
    })
    await inst.app.kernel.waitForIdle(muteWorker.workerConversationId)
    await waitFor(() => inst.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await inst.app.kernel.waitForIdle(coord.id)
    assert.equal(silentTurns, 2, 'must nudge at most once (initial turn + 1 nudge turn = 2 turns total)')

    // 2) Turn outcome === 'failed' -> auto-posts system [blocker] with model name & redacted error
    setSwarmRoleResponses(inst.faux, {
      flaky: [
        () => {
          throw new Error('upstream 429 quota_exhausted')
        },
      ],
      coordinator: [fauxAssistantMessage('Coordinator received failure blocker.')],
    })
    const flakyWorker = (await inst.app.kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Run against flaky model.', name: 'flaky' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }

    await waitFor(async () => {
      const read = (await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
        posts: BoardPost[]
      }
      return read.posts.some(
        (p) => p.from === 'system' && p.kind === 'blocker' && p.body.includes('@flaky') && p.body.includes('faux/faux-1'),
      )
    })
    await inst.app.kernel.waitForIdle(flakyWorker.workerConversationId)
    await waitFor(() => inst.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await inst.app.kernel.waitForIdle(coord.id)

    // 3) 6-condition 0-Token Quiescence Guard: mute posts comment(wake=false) to flaky -> all idle -> auto [stall] citing #seq!
    setSwarmRoleResponses(inst.faux, {
      mute: [
        fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['flaky'], kind: 'comment', wake: false, body: 'Dangling passive output' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Finished turn after passive comment.'),
      ],
      coordinator: [fauxAssistantMessage('Coordinator received stall diagnosis.')],
    })
    await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_post', {
      groupId,
      to: ['mute'],
      kind: 'handoff',
      wake: true,
      body: 'Produce passive note.',
    })
    await waitFor(async () => {
      const read = (await inst.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
        posts: BoardPost[]
      }
      return read.posts.some((p) => p.from === 'system' && p.kind === 'stall' && p.body.includes('wake=false'))
    })
    await inst.app.kernel.waitForIdle(muteWorker.workerConversationId)
    await waitFor(() => inst.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await inst.app.kernel.waitForIdle(coord.id)

    // 4) Restart recovery of unsent wakeup envelope: persist pendingWakeupSeq > readCursorSeq on disk, restart Hub, verify wakeup delivered!
    await inst.app.close()
    const actualMetaPath = join(dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId, 'meta.json')
    const persistedMeta = JSON.parse(readFileSync(actualMetaPath, 'utf8')) as {
      headSeq: number
      members: Array<{ name: string; readCursorSeq: number; pendingWakeupSeq: number; lastWakeCompletionSeq?: number }>
    }
    const muteRec = persistedMeta.members.find((m) => m.name === 'mute')!
    muteRec.readCursorSeq = 0
    muteRec.pendingWakeupSeq = persistedMeta.headSeq
    delete muteRec.lastWakeCompletionSeq
    writeFileSync(actualMetaPath, `${JSON.stringify(persistedMeta, null, 2)}\n`)

    let recoveredWakeupDelivered = false
    inst = await makeInstance((faux) => {
      setSwarmRoleResponses(faux, {
        mute: [
          () => {
            recoveredWakeupDelivered = true
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Recovered after restart!' })],
              { stopReason: 'toolUse' },
            )
          },
          fauxAssistantMessage('Recovered worker settled.'),
        ],
        coordinator: [fauxAssistantMessage('Coordinator received recovered done.')],
      })
    })
    await waitFor(() => recoveredWakeupDelivered, { timeoutMs: 10_000 })
    await inst.app.kernel.waitForIdle(muteWorker.workerConversationId)
    await waitFor(() => inst.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await inst.app.kernel.waitForIdle(coord.id)
  } finally {
    await inst.app.close()
  }
})

test('swarm-int5: /skill:swarm activation loop (task auto-create + same-turn tools, empty/idempotent reuse, worker/child block, non-matching passthrough)', { timeout: 60_000 }, async (t) => {
  const env = await openSwarmEnv(useTempDir(t, 'helm-swarm-slash-'))
  try {
    const { kernel } = env.app

    // 1) Non-/skill:swarm inputs (including plain /swarm) pass through untouched without creating any group
    const plainConv = await kernel.createConversation({ title: 'Normal Chat', profileId: 'assistant', cwd: env.repoDir })
    let plainSawText = ''
    env.faux.setResponses([
      (ctx) => {
        plainSawText = JSON.stringify(ctx.messages)
        return fauxAssistantMessage('Normal reply.')
      },
      (ctx) => {
        plainSawText = JSON.stringify(ctx.messages)
        return fauxAssistantMessage('Second normal reply.')
      },
      (ctx) => {
        plainSawText = JSON.stringify(ctx.messages)
        return fauxAssistantMessage('Third normal reply.')
      },
    ])
    await kernel.submitInput(plainConv.id, '/skill:swarming check')
    await kernel.waitForIdle(plainConv.id)
    assert.match(plainSawText, /\/skill:swarming check/)
    assert.equal(kernel.getConversation(plainConv.id).tags.includes(COORDINATOR_TAG), false)

    await kernel.submitInput(plainConv.id, 'please explain /skill:swarm syntax')
    await kernel.waitForIdle(plainConv.id)
    assert.match(plainSawText, /please explain \/skill:swarm syntax/)
    assert.equal(kernel.getConversation(plainConv.id).tags.includes(COORDINATOR_TAG), false)

    await kernel.submitInput(plainConv.id, '/swarm legacy prefix should not trigger')
    await kernel.waitForIdle(plainConv.id)
    assert.match(plainSawText, /\/swarm legacy prefix should not trigger/)
    assert.equal(kernel.getConversation(plainConv.id).tags.includes(COORDINATOR_TAG), false)

    // 2) Sending `/skill:swarm <task>` on a blank top-level human conversation auto-creates group, tags coordinator, keeps clean user bubble/title, and injects system guide
    const coord = await kernel.createConversation({ title: '', profileId: 'assistant', cwd: env.repoDir })
    let turnMeta: { toolNames: string[]; sectionsById: Record<string, string>; userText: string } | undefined
    let workerDispatched = false
    setSwarmRoleResponses(env.faux, {
      coordinator: [
        (ctx) => {
          const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
          turnMeta = {
            ...meta,
            userText: JSON.stringify(ctx.messages),
          }
          return fauxAssistantMessage(
            [
              fauxToolCall('swarm_dispatch_worker', {
                prompt: 'Implement token helper and report done.',
                name: 'author',
                access: 'readwrite',
                isolation: 'worktree',
              }),
            ],
            { stopReason: 'toolUse' },
          )
        },
        fauxAssistantMessage('Coordinator dispatched @author.'),
        fauxAssistantMessage('Coordinator received @author done.'),
      ],
      author: [
        () => {
          workerDispatched = true
          return fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Implemented cleanly.' })],
            { stopReason: 'toolUse' },
          )
        },
        fauxAssistantMessage('Author finished.'),
      ],
    })

    await kernel.submitInput(coord.id, '/skill:swarm 重构鉴权模块并交叉验收')
    await kernel.waitForIdle(coord.id)
    await waitFor(() => workerDispatched)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)

    assert.ok(turnMeta !== undefined)
    const coordSummary = kernel.getConversation(coord.id)
    assert.equal(coordSummary.tags.includes(COORDINATOR_TAG), true)
    assert.equal(coordSummary.title, '/skill:swarm 重构鉴权模块并交叉验收', 'auto-title must derive from clean user input')
    const coordDetail = await kernel.getConversationDetail(coord.id, { limit: 20 })
    const firstHumanInput = coordDetail.entries.find((e) => e.kind === 'helm.input')
    assert.equal(
      (firstHumanInput?.data as { text?: string } | undefined)?.text,
      '/skill:swarm 重构鉴权模块并交叉验收',
      'helm.input must preserve original /skill:swarm text verbatim without system-prompt wall',
    )
    for (const expected of ['swarm_dispatch_worker', 'swarm_board_post', 'swarm_board_read', 'swarm_close_group']) {
      assert.ok(turnMeta.toolNames.includes(expected), `expected ${expected} exposed on turn 1 after /skill:swarm`)
    }
    for (const stripped of ['swarm_create_group', 'bash', 'edit', 'write', 'subagent', 'SubagentWorkflow']) {
      assert.equal(turnMeta.toolNames.includes(stripped), false, `expected ${stripped} stripped on turn 1 after /skill:swarm`)
    }
    const coordSection = turnMeta.sectionsById['swarm.active_group'] ?? ''
    assert.match(coordSection, /^<active_swarm_group id="[^"]+" role="coordinator">/)
    assert.match(coordSection, /load_skill\(\{ skillId: "swarm" \}\)/)
    assert.match(coordSection, /never follow fixed role-name templates/)
    assert.match(coordSection, /swarm_dispatch_worker/)
    assert.match(turnMeta.userText, /\/skill:swarm 重构鉴权模块并交叉验收/)

    const indexDoc = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
    const coordGroup = indexDoc.groups.find((g) => g.coordinatorConversationId === coord.id && g.status === 'active')
    assert.ok(coordGroup !== undefined, 'active group created for /skill:swarm coordinator')
    assert.equal(coordGroup.title, '重构鉴权模块并交叉验收')

    // 3) Sending `/skill:swarm <followup>` again in the same active coordinator reuses the existing group idempotently and keeps user text verbatim
    let secondPromptText = ''
    setSwarmRoleResponses(env.faux, {
      coordinator: [
        (ctx) => {
          secondPromptText = JSON.stringify(ctx.messages.slice(-2))
          return fauxAssistantMessage('Reused active group cleanly.')
        },
      ],
    })
    await kernel.submitInput(coord.id, '/skill:swarm 补充单测覆盖')
    await kernel.waitForIdle(coord.id)
    assert.match(secondPromptText, /\/skill:swarm 补充单测覆盖/)
    const indexAfterSecond = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
    assert.equal(
      indexAfterSecond.groups.filter((g) => g.coordinatorConversationId === coord.id && g.status === 'active').length,
      1,
      'must reuse existing active group without creating duplicate',
    )

    // 4) Sending `/skill:swarm` on a worker or child sub-conversation is explicitly blocked by onInput
    const workerId = indexAfterSecond.workers.find((w) => w.groupId === coordGroup.id)!.conversationId
    await assert.rejects(
      () => kernel.submitInput(workerId, '/skill:swarm nested attempt'),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'input_blocked' &&
        err.message.includes('不能在子成员或后台会话中使用 /skill:swarm 发起协同'),
    )
    const childConv = await kernel.createConversation({
      title: 'Child Chat',
      profileId: 'assistant',
      cwd: env.repoDir,
      parentConversationId: plainConv.id,
    })
    await assert.rejects(
      () => kernel.submitInput(childConv.id, '/skill:swarm child attempt'),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'input_blocked' &&
        err.message.includes('不能在子成员或后台会话中使用 /skill:swarm 发起协同'),
    )

    // 5) Plain `/skill:swarm` (no arguments) on a top-level human conversation activates group, keeps '/skill:swarm' verbatim, and injects ask-for-task system guidance
    const emptyArgCoord = await kernel.createConversation({ title: 'Standby Swarm Topic', profileId: 'assistant', cwd: env.repoDir })
    let emptyArgSection = ''
    let emptyArgMessages = ''
    env.faux.setResponses([
      (ctx) => {
        emptyArgSection =
          captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group'] ?? ''
        emptyArgMessages = JSON.stringify(ctx.messages)
        return fauxAssistantMessage('请告诉我本次协同目标任务。')
      },
    ])
    await kernel.submitInput(emptyArgCoord.id, '/skill:swarm')
    await kernel.waitForIdle(emptyArgCoord.id)
    assert.equal(kernel.getConversation(emptyArgCoord.id).tags.includes(COORDINATOR_TAG), true)
    assert.match(emptyArgSection, /load_skill\(\{ skillId: "swarm" \}\)/)
    assert.match(emptyArgSection, /briefly ask what task to coordinate/)
    assert.match(emptyArgMessages, /"\/skill:swarm"/)
    const emptyArgDetail = await kernel.getConversationDetail(emptyArgCoord.id, { limit: 10 })
    const emptyArgInput = emptyArgDetail.entries.find((e) => e.kind === 'helm.input')
    assert.equal((emptyArgInput?.data as { text?: string } | undefined)?.text, '/skill:swarm')
    const emptyArgIndex = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
    const emptyArgGroup = emptyArgIndex.groups.find((g) => g.coordinatorConversationId === emptyArgCoord.id && g.status === 'active')
    assert.ok(emptyArgGroup !== undefined)
    assert.equal(emptyArgGroup.title, 'Standby Swarm Topic')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// int6: 多工具轮成员回合的精确结算（回归：handOver 曾被误判为 run 结束）
// ---------------------------------------------------------------------------

test('swarm-int6: multi-tool-round worker turn settles once — no mid-turn silent-exit nudge, no false system blocker, single post-done coordinator report', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-swarm-handover-')
  const dataDir = join(root, 'data')
  const repoDir = join(root, 'repo')
  gitTemplate.cloneTo(repoDir)

  const faux = makeFauxProvider({ models: [{ id: 'faux-1' }] })
  const app = await createHelm({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: repoDir,
    model: 'faux/faux-1',
    providers: [faux.provider],
  })
  try {
    const coord = await app.kernel.createConversation({ title: 'Handover Coord', profileId: 'assistant', cwd: repoDir })
    const { groupId } = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Handover Squad',
      conversationId: coord.id,
    })) as { groupId: string }

    // Worker turn: two plain bash rounds (each ends in a pi-durable run handOver to a new generation task),
    // then the done post, then the final answer text. Pre-fix every handOver emitted a spurious turn_settled:
    // the first fired a silent-exit nudge mid-turn and the second auto-posted a false system [blocker].
    setSwarmRoleResponses(faux, {
      coder: [
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo step one' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo step two' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Shipped after two tool rounds.' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Final summary after the done post.'),
      ],
      coordinator: [fauxAssistantMessage('Coordinator received the final done report.')],
    })

    const worker = (await app.kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Run two tool steps, then post done.', name: 'coder' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }

    await app.kernel.waitForIdle(worker.workerConversationId)
    await waitFor(() => app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await app.kernel.waitForIdle(coord.id)

    // 1) Board carries only the coordinator brief and the worker done — no system blocker, no stall, no echo posts.
    const read = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
    assert.equal(
      read.posts.filter((p) => p.from === 'system').length,
      0,
      `system posts must stay empty, got ${JSON.stringify(read.posts.filter((p) => p.from === 'system'))}`,
    )
    assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'coder').length, 1)

    // 2) The worker conversation never received a silent-exit nudge (mid-turn settlement misfire).
    const workerDetail = await app.kernel.getConversationDetail(worker.workerConversationId, { limit: 50 })
    assert.equal(
      workerDetail.entries.some((e) => JSON.stringify(e.data ?? '').includes('swarm_silent_exit_nudge')),
      false,
      'no silent-exit nudge may be queued while the worker is mid-turn',
    )

    // 3) The coordinator received exactly one board report, covering the done post.
    const coordDetail = await app.kernel.getConversationDetail(coord.id, { limit: 50 })
    const reportInputs = coordDetail.entries.filter(
      (e) => e.kind === 'helm.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
    )
    assert.equal(reportInputs.length, 1, `expected exactly one coordinator report, got ${reportInputs.length}`)
    assert.match(JSON.stringify(reportInputs[0]!.data ?? ''), /\[done\] @coder/)
  } finally {
    await app.close()
  }
})
