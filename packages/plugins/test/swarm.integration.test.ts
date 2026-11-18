/**
 * builtin:swarm 协同黑板与对等交接真实组合层整链集成测试（Integration 档）：
 * 1) 默认启用、启动零常驻会话、空闲态不阻塞 disable('builtin:workflow')、受管技能 swarm 随启停显隐、
 *    create_group 同回合下一拍解锁团队工具且不剥离常规工具、扩缩容期间 <active_swarm_group> 100% 字节恒定、inUse 保护；
 * 2) Author(worktree) + Verifier(readonly) 真实 Git Worktree 交接快照、空闲期 ManagedWorktreeHold 防删与阻塞 workflow 停用、
 *    两态 close_group(409 swarm_worktree_unmerged vs keepWorktree: true 保留分支合入、
 *    主控 tag 原地替换为 swarm-coordinator-archived 历史 tag：工作台面板可达、建组解锁、协同工具不复活、重建组摘除历史 tag)、
 *    closed 与 coordinatorDetached 历史组 board_status / board_read 正常读取；
 * 3) forkFrom 干净锚点热分叉、manage_channel + #channel 寻址、被动留言(wake: false)与合并唤醒、
 *    abort_worker 原地刹车、switch_worker_model 原地切模，以及 @/# 幂等补全动作；
 * 4) 回合 failed 自动上板 [blocker]、防哑巴退场单次续催 -> 二次命中代发 [blocker]、
 *    6 条件 0-Token 根因 [stall] 守卫，以及 Hub 重启补发未送达信封。
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'

import { HelmError } from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { createHelm } from '../../hub/src/app.js'
import {
  createGitTemplate,
  deferred,
  makeFauxProvider,
  sanitizedHostEnv,
  useTempDir,
  waitFor,
  type FauxProviderHandle,
} from './helpers/plugin-test-env.js'
import {
  ARCHIVED_COORDINATOR_TAG,
  ARCHIVED_WORKER_TAG,
  COORDINATOR_TAG,
  SWARM_PLUGIN_ID,
  SWARM_SKILL_ID,
  WORKER_TAG,
  type BoardBadgesDoc,
  type BoardPost,
  type BoardViewDoc,
  type CollabGroupRecord,
  type SwarmIndexDoc,
} from '../src/swarm.js'

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')
const KERNEL_DIR = new URL('../../kernel/', import.meta.url).pathname
const PI_AI_FAUX_URL = pathToFileURL(join(KERNEL_DIR, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')).href
const HUB_APP_URL = pathToFileURL(new URL('../../hub/src/app.ts', import.meta.url).pathname).href
const PLUGIN_BUILD_URL = import.meta.resolve('@helm/plugin-build')

async function spawnSigkillSeeder(
  t: TestContext,
  root: string,
  scriptName: string,
  scriptBody: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = join(root, scriptName)
  writeFileSync(scriptPath, scriptBody, 'utf8')
  let child: ChildProcess | undefined
  t.after(() => {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL')
    }
  })
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child = spawn(process.execPath, [TSX_CLI, scriptPath], {
      cwd: root,
      env: sanitizedHostEnv({ ...extraEnv }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child?.kill('SIGKILL')
      reject(new Error(`SIGKILL seeder ${scriptName} timed out (30s):\n${stdout}\n${stderr}`))
    }, 30_000)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (signal === 'SIGKILL' || code === 137) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`Seeder ${scriptName} did not exit via SIGKILL (code=${code}, signal=${signal}):\n${stdout}\n${stderr}`))
      }
    })
  })
}

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
    assert.match(loadedSkill.text, /Coordinator Rule: Do Not Do the Work/)
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

    // Next beat inside the SAME turn: squad tools unlocked, swarm_create_group hidden, general tools preserved!
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
      'subagent',
      'SubagentWorkflow',
      'bash',
      'edit',
      'write',
    ]) {
      assert.ok(afterTools.includes(expected), `expected ${expected} available after swarm_create_group (actual: ${afterTools.join(',')})`)
    }
    assert.equal(afterTools.includes('swarm_create_group'), false, 'expected swarm_create_group hidden on active coordinator')
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
          return fauxAssistantMessage([fauxToolCall('bash', { command: 'echo quick-lookup-ok' })], { stopReason: 'toolUse' })
        },
        fauxAssistantMessage('Quick lookup finished.'),
      ],
    })
    await kernel.submitInput(coord.id, 'Check prompt cache stability')
    await kernel.waitForIdle(coord.id)

    assert.equal(sectionAfterScaling, sectionInitial, 'active_swarm_group section must stay 100% byte-constant across member scaling and metadata edits')
    const detail = await kernel.getConversationDetail(coord.id, { limit: 10 })
    assert.match(JSON.stringify(detail.entries), /quick-lookup-ok/, 'coordinator retains bash for lightweight lookups')

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

test('swarm-int2: Author(worktree) + Verifier(readonly) handoff, hold blocks workflow disable & cleanup_worktree, two-mode close_group retain & merge, and closed/detached board_status', { timeout: 60_000 }, async (t) => {
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

    let verifierSectionSeen = ''
    let verifierToolsSeen: string[] = []
    let authorStep = 0
    let verifierStep = 0
    const routeSquadStep = (ctx: { messages: unknown[] }) => {
      const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
      const groupSec = meta.sectionsById['swarm.active_group'] ?? ''
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
        verifierSectionSeen = groupSec
        verifierToolsSeen = meta.toolNames
        if (verifierStep === 1) {
          return fauxAssistantMessage([fauxToolCall('bash', { command: 'git log -n 1 --oneline' })], { stopReason: 'toolUse' })
        }
        if (verifierStep === 2) {
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

    // Verify readonly worker receives prompt guidance without stripping tools
    assert.match(verifierSectionSeen, /access="readonly"/)
    assert.match(verifierSectionSeen, /without modifying files/)
    assert.ok(verifierToolsSeen.includes('write'), 'readonly worker does not strip tools from tool definitions')
    assert.ok(verifierToolsSeen.includes('bash'), 'readonly worker retains bash')

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
      members: Array<{ name: string; readCursorSeq: number; pendingWakeupSeq: number }>
    }
    const muteRec = persistedMeta.members.find((m) => m.name === 'mute')!
    muteRec.readCursorSeq = 0
    muteRec.pendingWakeupSeq = persistedMeta.headSeq
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
    for (const expected of ['swarm_dispatch_worker', 'swarm_board_post', 'swarm_board_read', 'swarm_close_group', 'bash', 'edit', 'write', 'subagent', 'SubagentWorkflow']) {
      assert.ok(turnMeta.toolNames.includes(expected), `expected ${expected} exposed on turn 1 after /skill:swarm`)
    }
    assert.equal(turnMeta.toolNames.includes('swarm_create_group'), false, 'expected swarm_create_group hidden on turn 1 after /skill:swarm')
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

test('swarm-int11: done non-race catch-up, failed-turn queued wakeup delivery, active worker delete lock + disabled-period reconcile', { timeout: 60_000 }, async (t) => {
  const env = await openSwarmEnv(useTempDir(t, 'helm-swarm-int7-'))
  try {
    const { kernel } = env.app
    const coord = await kernel.createConversation({ title: 'Catchup Coord', profileId: 'assistant', cwd: env.repoDir })
    const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Catchup Squad',
      conversationId: coord.id,
    })) as { groupId: string }

    // 1) Eliminating the 50ms done race deadlock + multi-worker blocker idle catch-up:
    //    beta posts kind:'done' in round 1, then lingers > 80ms (> 50ms batch window) before trailing text settles.
    //    Coordinator must NOT receive activeWorkingMembers:@beta prematurely, and must receive the post-settlement report once idle.
    let betaRound = 0
    let betaSecondRoundEntered = deferred<void>()
    let betaRelease = deferred<void>()
    env.faux.setResponses([
      async (ctx) => {
        const sec = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group'] ?? ''
        if (sec.includes('name="beta"')) {
          betaRound += 1
          if (betaRound === 1) {
            return fauxAssistantMessage(
              [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Beta finished!' })],
              { stopReason: 'toolUse' },
            )
          }
          betaSecondRoundEntered.resolve()
          await betaRelease.promise
          return fauxAssistantMessage('Beta completed trailing summary text.')
        }
        return fauxAssistantMessage('Coordinator processed report.')
      },
      ...Array.from({ length: 8 }, () => async (ctx: { messages: unknown[] }) => {
        const sec = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group'] ?? ''
        if (sec.includes('name="beta"')) {
          betaRound += 1
          if (betaRound === 2) {
            betaSecondRoundEntered.resolve()
            await betaRelease.promise
          }
          return fauxAssistantMessage('Beta completed trailing summary text.')
        }
        return fauxAssistantMessage('Coordinator noted idle completion.')
      }),
    ])

    const beta = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Handle beta task with done + slow trailing text.', name: 'beta' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }

    await betaSecondRoundEntered.promise
    // Hold longer than COORDINATOR_BATCH_WINDOW_MS (50ms) while beta is still mid-turn!
    await new Promise((r) => setTimeout(r, 90))
    const midTurnReports = (await kernel.getConversationDetail(coord.id, { limit: 20 })).entries.filter(
      (e) => e.kind === 'helm.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
    )
    assert.equal(midTurnReports.length, 0, 'done post must NOT trigger 50ms race report while worker is still settling trailing text')

    betaRelease.resolve()
    await kernel.waitForIdle(beta.workerConversationId)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)

    // Coordinator must have received final report after beta settled with empty activeWorkingMembers!
    const coordDetail = await kernel.getConversationDetail(coord.id, { limit: 50 })
    const reports = coordDetail.entries
      .filter((e) => e.kind === 'helm.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'))
      .map((e) => JSON.stringify(e.data ?? ''))
    assert.equal(reports.length, 1, 'coordinator must receive report once worker settles idle')
    assert.match(reports[0]!, /\[done\] @beta/)
    assert.match(reports[0]!, /activeWorkingMembers: \(none\)/)

    // 2) Active worker conversation lock blocks deletion while active, releases after close or archive
    await assert.rejects(
      () => kernel.deleteConversation(beta.workerConversationId),
      (err: unknown) => err instanceof HelmError && err.code === 'conversation_managed_by_plugin' && err.status === 409,
    )
    await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'archive_worker', { groupId, name: 'beta' }, { conversationId: coord.id })
    await kernel.deleteConversation(beta.workerConversationId)

    // 3) failed-turn catchup: if worker settles with outcome=failed after a new wakeup was queued mid-turn, queued wakeup delivers
    let gammaFailDone = false
    let gammaRecoveredDelivered = false
    env.faux.setResponses([fauxAssistantMessage('Gamma ready')])
    const failingWorker = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Fail initial turn cleanly.', name: 'gamma' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }
    await kernel.waitForIdle(failingWorker.workerConversationId)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)

    // Fail gamma's next turn AFTER deterministically awaiting an inbound brief queued mid-turn
    env.faux.setResponses([
      async () => {
        if (!gammaFailDone) {
          gammaFailDone = true
          await kernel.plugins.invokeAction(
            SWARM_PLUGIN_ID,
            'board_post',
            { groupId, to: ['gamma'], kind: 'brief', body: 'Retry queued after fail' },
            { conversationId: coord.id },
          )
          throw new Error('simulated worker crash')
        }
        gammaRecoveredDelivered = true
        return fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Gamma recovered queued wakeup' })],
          { stopReason: 'toolUse' },
        )
      },
      () => {
        gammaRecoveredDelivered = true
        return fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Gamma recovered queued wakeup' })],
          { stopReason: 'toolUse' },
        )
      },
      fauxAssistantMessage('Gamma done'),
      fauxAssistantMessage('Coordinator noted failure & recovery'),
      fauxAssistantMessage('Coordinator noted done'),
    ] as never)
    await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'board_post',
      { groupId, to: ['gamma'], kind: 'brief', body: 'Run failing turn' },
      { conversationId: coord.id },
    )
    await waitFor(() => gammaRecoveredDelivered === true)
    await kernel.waitForIdle(failingWorker.workerConversationId)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)
    assert.equal(gammaRecoveredDelivered, true)

    // 4) Worker with worktree deleted while plugin disabled: startup reconciles hold, archives member, and posts [blocker]
    let deltaStep = 0
    env.faux.setResponses([
      () => {
        deltaStep += 1
        if (deltaStep === 1) {
          return fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Delta done before delete.' })],
            { stopReason: 'toolUse' },
          )
        }
        return fauxAssistantMessage('Temp ready')
      },
      fauxAssistantMessage('Temp ready'),
      fauxAssistantMessage('Coordinator ack'),
      fauxAssistantMessage('Coordinator noted deleted delta'),
    ])
    const wtWorker = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Hold worktree then get deleted while disabled.', name: 'delta', isolation: 'worktree' },
      { conversationId: coord.id },
    )) as { workerConversationId: number; worktreeId: string }
    await kernel.waitForIdle(wtWorker.workerConversationId)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)
    await waitFor(() => {
      const s = kernel.getConversation(wtWorker.workerConversationId).status
      return s !== 'working' && s !== 'blocked' && kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0
    })

    await kernel.plugins.disable(SWARM_PLUGIN_ID, { force: true })
    await kernel.deleteConversation(wtWorker.workerConversationId)
    await kernel.plugins.enable(SWARM_PLUGIN_ID)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(coord.id)

    const statusAfterReconcile = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_status', { groupId })) as BoardViewDoc
    const deltaMember = statusAfterReconcile.members.find((m) => m.name === 'delta')!
    assert.equal(deltaMember.lifecycle, 'archived')
    assert.ok(
      statusAfterReconcile.posts.some((p) => p.from === 'system' && p.kind === 'blocker' && p.body.includes('@delta')),
      'must emit system [blocker] when worker conversation was deleted while plugin disabled',
    )
    // Released hold means workflow cleanup succeeds without hold lock error!
    await kernel.plugins.invokeAction(WORKFLOW_ID, 'cleanup_worktree', { worktreeId: wtWorker.worktreeId, force: true })
  } finally {
    await env.close()
  }
})

test('swarm-int12: external runtime & nodeId rejection, flat forkFrom, skill whitelist gating, bounded index lazy load & prompt metadata', { timeout: 60_000 }, async (t) => {
  const env = await openSwarmEnv(useTempDir(t, 'helm-swarm-int8-'))
  try {
    const { kernel } = env.app
    // 1) External runtime profile rejected with 400 unsupported_runtime
    await kernel.services.profiles.save({
      id: 'ext-agent',
      name: 'External Agent',
      runtime: { kind: 'herdr', agent: 'codex' },
    })
    // Restricted profile without swarm skill
    await kernel.services.profiles.save({
      id: 'no-swarm-skill',
      name: 'No Swarm Skill',
      skills: [],
    })

    const noSkillCoord = await kernel.createConversation({
      title: 'Restricted Coord',
      profileId: 'no-swarm-skill',
      cwd: env.repoDir,
    })
    await assert.rejects(
      () => kernel.submitInput(noSkillCoord.id, '/skill:swarm try orchestrating'),
      (err: unknown) => err instanceof HelmError && err.code === 'input_blocked',
      'Profile with skills=[] must block /skill:swarm trigger',
    )

    // Even if create_group is called directly, active section omits phantom load_skill instruction
    const { groupId: noSkillGroupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Direct Group No Skill',
      conversationId: noSkillCoord.id,
    })) as { groupId: string }
    let noSkillCoordSection = ''
    let availableActionsInCoordTurn = ''
    env.faux.setResponses([
      (ctx) => {
        const meta = captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[])
        noSkillCoordSection = meta.sectionsById['swarm.active_group'] ?? ''
        availableActionsInCoordTurn = meta.sectionsById['prompt.actions'] ?? ''
        return fauxAssistantMessage('Noted without skill.')
      },
    ])
    await kernel.submitInput(noSkillCoord.id, 'Check sections')
    await kernel.waitForIdle(noSkillCoord.id)
    assert.equal(noSkillCoordSection.includes('load_skill('), false)
    assert.equal(availableActionsInCoordTurn.includes('complete_board_members'), false, 'exposeToPrompt:false hides UI completer from <available_actions>')
    assert.equal(availableActionsInCoordTurn.includes('list_mentionable'), false, 'exposeToPrompt:false hides profile @ completer')
    assert.match(availableActionsInCoordTurn, /manage_channel/, 'coordinator manages channels via run_action catalog')
    await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: noSkillGroupId }, { conversationId: noSkillCoord.id })

    // 2) Dispatch validation & flat forkFrom & structuredOutput tool envelope
    const coord = await kernel.createConversation({ title: 'Flat Coord', profileId: 'assistant', cwd: env.repoDir })
    const { groupId } = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Flat Squad',
      conversationId: coord.id,
    })) as { groupId: string }

    await assert.rejects(
      () =>
        kernel.plugins.invokeAction(
          SWARM_PLUGIN_ID,
          'dispatch_worker',
          { groupId, name: 'ext', prompt: 'Should fail', profileId: 'ext-agent' },
          { conversationId: coord.id },
        ),
      (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime' && err.status === 400,
    )
    await assert.rejects(
      () =>
        kernel.plugins.invokeAction(
          SWARM_PLUGIN_ID,
          'dispatch_worker',
          { groupId, name: 'badnode', prompt: 'Should fail', nodeId: 'nonexistent-node' },
          { conversationId: coord.id },
        ),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
    )

    env.faux.setResponses([
      fauxAssistantMessage('Alpha settled reply'),
      fauxAssistantMessage('Beta forked settled reply'),
      fauxAssistantMessage('Coordinator noted stalls'),
      fauxAssistantMessage('Coordinator noted stalls'),
    ])
    const alpha = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { groupId, name: 'alpha', prompt: 'Seed alpha conversation' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }
    await kernel.waitForIdle(alpha.workerConversationId)

    const beta = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { groupId, name: 'beta', prompt: 'Fork from peer alpha', forkFrom: 'alpha' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }
    await kernel.waitForIdle(beta.workerConversationId)
    assert.equal(
      kernel.getConversation(beta.workerConversationId).parentConversationId,
      coord.id,
      'forkFrom peer must keep flat parentConversationId pointing to coordinator',
    )

    // Tool call envelope verification: swarm_board_status exposes concise text + structuredOutput object
    const toolRes = (await kernel.plugins.executeTool(
      'swarm_board_status',
      { groupId },
      { conversationId: coord.id },
    )) as { output: string; structuredOutput: BoardViewDoc }
    assert.ok(typeof toolRes.output === 'string' && toolRes.output.includes('Flat Squad'))
    assert.equal(toolRes.structuredOutput.group.id, groupId)

    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId }, { conversationId: coord.id })

    // 3) Bounded index (MAX_INDEX_CLOSED_GROUPS = 50) + lazy closed group loading for evicted archived coordinator/worker
    const evictedCoord = await kernel.createConversation({ title: 'Evicted Hist Coord', profileId: 'assistant', cwd: env.repoDir })
    const evictedGroup = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Evicted Historic Group',
      conversationId: evictedCoord.id,
    })) as { groupId: string }
    let evictedStep = 0
    env.faux.setResponses([
      () => {
        evictedStep += 1
        if (evictedStep === 1) {
          return fauxAssistantMessage(
            [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Evicted worker done' })],
            { stopReason: 'toolUse' },
          )
        }
        return fauxAssistantMessage('Evicted worker settled')
      },
      fauxAssistantMessage('Evicted worker settled'),
      fauxAssistantMessage('Coord ack'),
    ])
    const evictedWorker = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { groupId: evictedGroup.groupId, name: 'evictedw', prompt: 'Worker in evicted group' },
      { conversationId: evictedCoord.id },
    )) as { workerConversationId: number }
    await kernel.waitForIdle(evictedWorker.workerConversationId)
    await waitFor(() => kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await kernel.waitForIdle(evictedCoord.id)
    await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'close_group',
      { groupId: evictedGroup.groupId },
      { conversationId: evictedCoord.id },
    )

    // Create and close 51 more groups so total closed groups = 53 > 50 (with updatedAt strictly newer)
    for (let i = 0; i < 51; i += 1) {
      const c = await kernel.createConversation({ title: `Hist ${i}`, profileId: 'assistant', cwd: env.repoDir })
      const g = (await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
        title: `Hist Group ${i}`,
        conversationId: c.id,
      })) as { groupId: string }
      await kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: g.groupId }, { conversationId: c.id })
    }

    // Disable + re-enable swarm plugin to exercise startup lazy-load & bounded index sync
    await kernel.plugins.disable(SWARM_PLUGIN_ID, { force: true })
    await kernel.plugins.enable(SWARM_PLUGIN_ID)
    const idxAfterReload = kernel.plugins.getPublicDoc(SWARM_PLUGIN_ID, 'index').value as SwarmIndexDoc
    assert.ok(idxAfterReload.groups.length <= 50, `closed groups in index must be bounded to <= 50 (got ${idxAfterReload.groups.length})`)
    assert.equal(idxAfterReload.groups.some((g) => g.id === evictedGroup.groupId), false, 'oldest evicted group is absent from bounded index')

    // Neither evicted coordinator nor evicted worker fails when viewing panel via archived scope!
    const byArchivedCoord = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'board_status',
      {},
      { conversationId: evictedCoord.id },
    )) as BoardViewDoc
    assert.equal(byArchivedCoord.group.id, evictedGroup.groupId)
    assert.ok(byArchivedCoord.posts.length >= 1, 'lazy-loaded board.jsonl restores posts for archived coordinator')

    const byArchivedWorker = (await kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'board_status',
      {},
      { conversationId: evictedWorker.workerConversationId },
    )) as BoardViewDoc
    assert.equal(byArchivedWorker.group.id, evictedGroup.groupId)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// int7: 真实子进程 SIGKILL 中断 worktree 成员生成 -> 重启无缝续跑、保留 worktree 并正常关组回收
// ---------------------------------------------------------------------------

function isSettledStatus(status: string): boolean {
  return status === 'idle' || status === 'done'
}

test('swarm-int7: real SIGKILL mid-turn resumes streaming worktree worker with zero duplicate input, keeps worktree active, and cleans up on close_group', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-swarm-sigkill-worker-')
  const dataDir = join(root, 'data')
  const repoDir = join(root, 'repo')
  gitTemplate.cloneTo(repoDir)

  const seederScript = `
    import { writeSync } from 'node:fs'
    import { createPluginBuildProvider } from ${JSON.stringify(PLUGIN_BUILD_URL)}
    import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(PI_AI_FAUX_URL)}
    import { createHelm } from ${JSON.stringify(HUB_APP_URL)}

    const faux = fauxProvider({
      models: [{ id: 'faux-1' }],
      tokensPerSecond: 2,
      tokenSize: { min: 1, max: 1 },
    })
    faux.setResponses([
      fauxAssistantMessage('这是一段Swarm成员在隔离worktree中慢速流式执行任务确保被真实SIGKILL中断的输出内容'),
    ])
    const app = await createHelm({
      buildProvider: createPluginBuildProvider(),
      dataDir: ${JSON.stringify(dataDir)},
      cwd: ${JSON.stringify(repoDir)},
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    const coord = await app.kernel.createConversation({
      title: 'Kill Worker Coord',
      profileId: 'assistant',
      cwd: ${JSON.stringify(repoDir)},
    })
    const { groupId } = await app.kernel.plugins.invokeAction(
      'builtin:swarm',
      'create_group',
      { title: 'Kill Recovery Squad', conversationId: coord.id },
    ) as { groupId: string }
    const worker = await app.kernel.plugins.invokeAction(
      'builtin:swarm',
      'dispatch_worker',
      { prompt: 'Execute task inside isolated worktree and post done.', name: 'coder', isolation: 'worktree' },
      { conversationId: coord.id },
    ) as { workerConversationId: number }

    for (let i = 0; i < 400; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
      if (
        faux.state.callCount >= 1 &&
        app.kernel.getConversation(worker.workerConversationId).status === 'working'
      ) {
        break
      }
    }
    if (faux.state.callCount < 1) {
      process.stderr.write('seeder did not reach worker faux call\\n')
      process.exit(3)
    }
    writeSync(1, 'SEED_RESULT=' + JSON.stringify({ coordId: coord.id, groupId, workerId: worker.workerConversationId }) + '\\n')
    process.kill(process.pid, 'SIGKILL')
  `
  const { stdout } = await spawnSigkillSeeder(t, root, 'seed-worker-kill.mts', seederScript)
  const seedLine = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('SEED_RESULT='))
  assert.ok(seedLine !== undefined, `missing SEED_RESULT line in stdout: ${stdout}`)
  const seeded = JSON.parse(seedLine.slice('SEED_RESULT='.length)) as {
    coordId: number
    groupId: string
    workerId: number
  }

  const metaPath = join(dataDir, 'plugins', 'builtin%3Aswarm', 'groups', seeded.groupId, 'meta.json')
  const preMeta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
  const preCoder = preMeta.members.find((m) => m.name === 'coder')
  assert.ok(preCoder?.worktreeId !== undefined, 'pre-restart worker must hold worktreeId')

  const faux = makeFauxProvider({ models: [{ id: 'faux-1' }] })
  setSwarmRoleResponses(faux, {
    coder: [
      fauxAssistantMessage(
        [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Recovered from SIGKILL and finished worktree task.' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Worker finished after SIGKILL recovery.'),
    ],
    coordinator: [fauxAssistantMessage('Coordinator received recovery done report.')],
  })

  const app = await createHelm({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: repoDir,
    model: 'faux/faux-1',
    providers: [faux.provider],
  })
  try {
    try {
      await waitFor(
        () =>
          isSettledStatus(app.kernel.getConversation(seeded.workerId).status) &&
          isSettledStatus(app.kernel.getConversation(seeded.coordId).status) &&
          app.kernel.getConversation(seeded.workerId).completionSeq >= 1 &&
          app.kernel.getConversation(seeded.coordId).completionSeq >= 1 &&
          app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
        { timeoutMs: 8_000 },
      )
    } catch (err) {
      const wSummary = app.kernel.getConversation(seeded.workerId)
      const cSummary = app.kernel.getConversation(seeded.coordId)
      const wDetail = await app.kernel.getConversationDetail(seeded.workerId, { limit: 20 })
      const cDetail = await app.kernel.getConversationDetail(seeded.coordId, { limit: 20 })
      throw new Error(
        `${(err as Error).message}\nworker=${JSON.stringify(wSummary)}\ncoord=${JSON.stringify(cSummary)}\nwEntries=${JSON.stringify(wDetail.entries)}\ncEntries=${JSON.stringify(cDetail.entries)}`,
      )
    }
    await app.kernel.waitForIdle(seeded.workerId)
    await app.kernel.waitForIdle(seeded.coordId)

    // Worktree stayed alive during recovery and cleanup runs cleanly on close_group.
    const inspectedBeforeClose = (await app.kernel.plugins.invokeAction('builtin:workflow', 'inspect_worktree', {
      worktreeId: preCoder.worktreeId,
      diff: false,
    })) as { exists: boolean }
    assert.equal(inspectedBeforeClose.exists, true)

    const workerDetail = await app.kernel.getConversationDetail(seeded.workerId, { limit: 50 })
    const workerInputs = workerDetail.entries.filter((e) => e.kind === 'helm.input')
    assert.equal(workerInputs.length, 1, `expected 1 deduplicated wakeup input, got ${workerInputs.length}`)

    const read = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: seeded.groupId })) as {
      posts: BoardPost[]
    }
    assert.equal(read.posts.filter((p) => p.from === 'system').length, 0)
    assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'coder').length, 1)

    const coordDetail = await app.kernel.getConversationDetail(seeded.coordId, { limit: 50 })
    const reports = coordDetail.entries.filter(
      (e) => e.kind === 'helm.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
    )
    assert.equal(reports.length, 1)
    assert.match(JSON.stringify(reports[0]!.data ?? ''), /\[done\] @coder/)

    await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'close_group', { groupId: seeded.groupId })
    const inspectedAfterClose = (await app.kernel.plugins.invokeAction('builtin:workflow', 'inspect_worktree', {
      worktreeId: preCoder.worktreeId,
      diff: false,
    })) as { exists: boolean }
    assert.equal(inspectedAfterClose.exists, false)
    assert.equal(app.kernel.getConversation(seeded.coordId).tags.includes(ARCHIVED_COORDINATOR_TAG), true)
    assert.equal(app.kernel.getConversation(seeded.coordId).tags.includes(COORDINATOR_TAG), false)
    assert.equal(app.kernel.getConversation(seeded.workerId).tags.includes(ARCHIVED_WORKER_TAG), true)
    assert.equal(app.kernel.getConversation(seeded.workerId).tags.includes(WORKER_TAG), false)
  } finally {
    await app.close()
  }
})

// ---------------------------------------------------------------------------
// int8: replay:'safe' 工具在 tool_result 强杀窗口下的端到端去重重放（dispatch_worker 与 board_post）
// ---------------------------------------------------------------------------

test('swarm-int8: SIGKILL before toolResult commit replays swarm_dispatch_worker and swarm_board_post idempotently with replay=safe', { timeout: 60_000 }, async (t) => {
  // ---- Phase A: SIGKILL inside onToolResult(swarm_dispatch_worker) ----
  const rootA = useTempDir(t, 'helm-swarm-replay-dispatch-')
  const dataDirA = join(rootA, 'data')
  const repoDirA = join(rootA, 'repo')
  gitTemplate.cloneTo(repoDirA)

  const seedDispatchScript = `
    import { writeSync } from 'node:fs'
    import { createPluginBuildProvider } from ${JSON.stringify(PLUGIN_BUILD_URL)}
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
    import { createHelm } from ${JSON.stringify(HUB_APP_URL)}

    const faux = fauxProvider({ models: [{ id: 'faux-1' }], tokensPerSecond: 500 })
    let coordId = 0
    faux.setResponses([
      (ctx) => {
        // Hold worker turn if scheduled before coordinator tool_result trap fires.
        const isWorker = ctx.messages.some(
          (m) => m['role'] === 'system' && JSON.stringify(m['sections'] ?? '').includes('role="worker"'),
        )
        if (isWorker) {
          return new Promise(() => {})
        }
        return fauxAssistantMessage(
          [
            fauxToolCall('swarm_dispatch_worker', {
              name: 'coder',
              isolation: 'worktree',
              prompt: 'Complete task once after dispatch replay.',
            }),
          ],
          { stopReason: 'toolUse' },
        )
      },
      () => new Promise(() => {}),
    ])

    const app = await createHelm({
      buildProvider: createPluginBuildProvider(),
      dataDir: ${JSON.stringify(dataDirA)},
      cwd: ${JSON.stringify(repoDirA)},
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    await app.kernel.plugins.register({
      id: 'test:sigkill-dispatch-trap',
      name: 'sigkill dispatch trap',
      definePlugin(ctx) {
        ctx.hook.onToolResult((ev) => {
          if (ev.toolName === 'swarm_dispatch_worker') {
            writeSync(1, 'TRAPPED_DISPATCH=' + JSON.stringify({ callId: ev.callId }) + '\\n')
            process.kill(process.pid, 'SIGKILL')
          }
          return { action: 'continue' }
        })
      },
    })
    const coord = await app.kernel.createConversation({
      title: 'Replay Dispatch Coord',
      profileId: 'assistant',
      cwd: ${JSON.stringify(repoDirA)},
    })
    coordId = coord.id
    const { groupId } = (await app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID_LITERAL, 'create_group', {
      title: 'Replay Dispatch Squad',
      conversationId: coord.id,
    })) as { groupId: string }
    writeSync(1, 'GROUP_INFO=' + JSON.stringify({ coordId: coord.id, groupId }) + '\\n')
    await app.kernel.submitInput(coord.id, 'Dispatch coder worker.')
    await new Promise(() => {})
  `.replace('SWARM_PLUGIN_ID_LITERAL', JSON.stringify(SWARM_PLUGIN_ID))

  const resA = await spawnSigkillSeeder(t, rootA, 'seed-dispatch-kill.mts', seedDispatchScript)
  const groupLineA = resA.stdout.split(/\r?\n/).find((l) => l.startsWith('GROUP_INFO='))
  assert.ok(groupLineA !== undefined && resA.stdout.includes('TRAPPED_DISPATCH='), `unexpected stdout: ${resA.stdout}`)
  const infoA = JSON.parse(groupLineA.slice('GROUP_INFO='.length)) as { coordId: number; groupId: string }

  const fauxA = makeFauxProvider({ models: [{ id: 'faux-1' }] })
  setSwarmRoleResponses(fauxA, {
    coordinator: [
      fauxAssistantMessage('Coordinator observed idempotent dispatch replay result.'),
      fauxAssistantMessage('Coordinator acknowledged coder done report.'),
    ],
    coder: [
      fauxAssistantMessage(
        [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Finished after dispatch replay.' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Coder finished cleanly.'),
    ],
  })

  const appA = await createHelm({
    buildProvider: createPluginBuildProvider(),
    dataDir: dataDirA,
    cwd: repoDirA,
    model: 'faux/faux-1',
    providers: [fauxA.provider],
  })
  try {
    try {
      await waitFor(
        () =>
          isSettledStatus(appA.kernel.getConversation(infoA.coordId).status) &&
          appA.kernel.getConversation(infoA.coordId).completionSeq >= 2 &&
          appA.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
        { timeoutMs: 8_000 },
      )
    } catch (err) {
      const cSummary = appA.kernel.getConversation(infoA.coordId)
      const cDetail = await appA.kernel.getConversationDetail(infoA.coordId, { limit: 20 })
      const convs = appA.kernel.listConversations()
      throw new Error(
        `${(err as Error).message}\ncoord=${JSON.stringify(cSummary)}\nconvs=${JSON.stringify(convs)}\ncEntries=${JSON.stringify(cDetail.entries)}`,
      )
    }
    const metaA = JSON.parse(
      readFileSync(join(dataDirA, 'plugins', 'builtin%3Aswarm', 'groups', infoA.groupId, 'meta.json'), 'utf8'),
    ) as CollabGroupRecord
    assert.equal(metaA.members.length, 1, 'replaying swarm_dispatch_worker must not duplicate members')
    const coderA = metaA.members[0]!
    await appA.kernel.waitForIdle(coderA.conversationId)
    await waitFor(() => appA.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await appA.kernel.waitForIdle(infoA.coordId)

    const wtList = (await appA.kernel.plugins.invokeAction('builtin:workflow', 'list_worktrees', {})) as {
      worktrees: Array<{ status: string }>
    }
    assert.equal(
      wtList.worktrees.filter((w) => w.status === 'active').length,
      1,
      'replaying swarm_dispatch_worker must reuse the single acquired worktree',
    )
    const coordDetailA = await appA.kernel.getConversationDetail(infoA.coordId, { limit: 50 })
    const dispatchErrors = coordDetailA.entries.filter(
      (e) =>
        e.kind === 'pi.toolResult' &&
        JSON.stringify(e.data ?? '').includes('swarm_dispatch_worker') &&
        (e.data as { isError?: boolean } | undefined)?.isError === true,
    )
    assert.equal(dispatchErrors.length, 0, 'replay of swarm_dispatch_worker must not raise 409 conflict')
    const workerDetailA = await appA.kernel.getConversationDetail(coderA.conversationId, { limit: 50 })
    assert.equal(workerDetailA.entries.filter((e) => e.kind === 'helm.input').length, 1)
  } finally {
    await appA.close()
  }

  // ---- Phase B: SIGKILL inside onToolResult(swarm_board_post) ----
  const rootB = useTempDir(t, 'helm-swarm-replay-post-')
  const dataDirB = join(rootB, 'data')
  const repoDirB = join(rootB, 'repo')
  gitTemplate.cloneTo(repoDirB)

  const seedPostScript = `
    import { writeSync } from 'node:fs'
    import { createPluginBuildProvider } from ${JSON.stringify(PLUGIN_BUILD_URL)}
    import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(PI_AI_FAUX_URL)}
    import { createHelm } from ${JSON.stringify(HUB_APP_URL)}

    const faux = fauxProvider({ models: [{ id: 'faux-1' }], tokensPerSecond: 500 })
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Single idempotent done post.' })],
        { stopReason: 'toolUse' },
      ),
      () => new Promise(() => {}),
    ])
    const app = await createHelm({
      buildProvider: createPluginBuildProvider(),
      dataDir: ${JSON.stringify(dataDirB)},
      cwd: ${JSON.stringify(repoDirB)},
      model: 'faux/faux-1',
      providers: [faux.provider],
    })
    await app.kernel.plugins.register({
      id: 'test:sigkill-post-trap',
      name: 'sigkill post trap',
      definePlugin(ctx) {
        ctx.hook.onToolResult((ev) => {
          if (ev.toolName === 'swarm_board_post') {
            writeSync(1, 'TRAPPED_POST=1\\n')
            process.kill(process.pid, 'SIGKILL')
          }
          return { action: 'continue' }
        })
      },
    })
    const coord = await app.kernel.createConversation({
      title: 'Post Replay Coord',
      profileId: 'assistant',
      cwd: ${JSON.stringify(repoDirB)},
    })
    const { groupId } = (await app.kernel.plugins.invokeAction('builtin:swarm', 'create_group', {
      title: 'Post Replay Squad',
      conversationId: coord.id,
    })) as { groupId: string }
    const worker = (await app.kernel.plugins.invokeAction(
      'builtin:swarm',
      'dispatch_worker',
      { prompt: 'Post done once.', name: 'coder' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }
    writeSync(1, 'POST_INFO=' + JSON.stringify({ coordId: coord.id, groupId, workerId: worker.workerConversationId }) + '\\n')
    await new Promise(() => {})
  `
  const resB = await spawnSigkillSeeder(t, rootB, 'seed-post-kill.mts', seedPostScript)
  const postLineB = resB.stdout.split(/\r?\n/).find((l) => l.startsWith('POST_INFO='))
  assert.ok(postLineB !== undefined && resB.stdout.includes('TRAPPED_POST=1'), `unexpected stdout: ${resB.stdout}`)
  const infoB = JSON.parse(postLineB.slice('POST_INFO='.length)) as {
    coordId: number
    groupId: string
    workerId: number
  }

  const fauxB = makeFauxProvider({ models: [{ id: 'faux-1' }] })
  setSwarmRoleResponses(fauxB, {
    coder: [fauxAssistantMessage('Coder completed after board_post replay.')],
    coordinator: [fauxAssistantMessage('Coordinator acknowledged single done report.')],
  })
  const appB = await createHelm({
    buildProvider: createPluginBuildProvider(),
    dataDir: dataDirB,
    cwd: repoDirB,
    model: 'faux/faux-1',
    providers: [fauxB.provider],
  })
  try {
    await waitFor(
      () =>
        isSettledStatus(appB.kernel.getConversation(infoB.workerId).status) &&
        isSettledStatus(appB.kernel.getConversation(infoB.coordId).status) &&
        appB.kernel.getConversation(infoB.workerId).completionSeq >= 1 &&
        appB.kernel.getConversation(infoB.coordId).completionSeq >= 1 &&
        appB.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
      { timeoutMs: 8_000 },
    )
    const readB = (await appB.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: infoB.groupId })) as {
      posts: BoardPost[]
    }
    const donePosts = readB.posts.filter((p) => p.kind === 'done' && p.from === 'coder')
    assert.equal(donePosts.length, 1, `replaying swarm_board_post must keep exactly 1 done post, got ${donePosts.length}`)
    const coordDetailB = await appB.kernel.getConversationDetail(infoB.coordId, { limit: 50 })
    const reportsB = coordDetailB.entries.filter(
      (e) => e.kind === 'helm.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report'),
    )
    assert.equal(reportsB.length, 1)
  } finally {
    await appB.close()
  }
})

// ---------------------------------------------------------------------------
// int9: 启动单真源收敛 — WAL 尾行截断回滚 + 孤儿/错配标签收敛 + 孤儿 Swarm Worktree 清理（不越权）
// ---------------------------------------------------------------------------

test('swarm-int9: boot reconciliation rolls back uncommitted WAL tail, converges orphan/stale tags, and cleans orphan swarm worktree holds without touching workflow holds', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-swarm-orphans-')
  const env1 = await openSwarmEnv(root)
  let groupId = ''
  let group2Id = ''
  let coordId = 0
  let coderId = 0
  let orphanCoordId = 0
  let orphanWorkerId = 0
  let swarmOrphanWtId = ''
  let workflowWtId = ''
  let committedHeadSeq = 0

  try {
    const coord = await env1.app.kernel.createConversation({ title: 'Clean Coord', profileId: 'assistant', cwd: env1.repoDir })
    coordId = coord.id
    const created = (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'WAL & Orphan Squad',
      conversationId: coord.id,
    })) as { groupId: string }
    groupId = created.groupId

    setSwarmRoleResponses(env1.faux, {
      coder: [
        fauxAssistantMessage(
          [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Initial committed work.' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('Coder finished cleanly.'),
      ],
      coordinator: [fauxAssistantMessage('Coordinator noted initial done.')],
    })
    const dispatched = (await env1.app.kernel.plugins.invokeAction(
      SWARM_PLUGIN_ID,
      'dispatch_worker',
      { prompt: 'Post initial done.', name: 'coder' },
      { conversationId: coord.id },
    )) as { workerConversationId: number }
    coderId = dispatched.workerConversationId

    await env1.app.kernel.waitForIdle(coderId)
    await waitFor(() => env1.app.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)
    await env1.app.kernel.waitForIdle(coordId)

    // Archive coder, then re-apply stale WORKER_TAG to simulate crash between meta.json commit and tag swap.
    await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'archive_worker', {
      groupId,
      name: 'coder',
    })
    await env1.app.kernel.updateConversation(coderId, { tags: [WORKER_TAG] })

    // Orphan coordinator clone & orphan worker carrying stale live tags outside meta.json.
    const orphanCoord = await env1.app.kernel.createConversation({
      title: 'Forked Orphan Coord',
      profileId: 'assistant',
      cwd: env1.repoDir,
      tags: [COORDINATOR_TAG],
    })
    orphanCoordId = orphanCoord.id

    const orphanWorker = await env1.app.kernel.createConversation({
      title: 'Orphan Worker',
      profileId: 'assistant',
      cwd: env1.repoDir,
      tags: [WORKER_TAG],
    })
    orphanWorkerId = orphanWorker.id

    // Orphan builtin:swarm worktree hold + foreign builtin:workflow worktree hold.
    const wtSwarmConv = await env1.app.kernel.createConversation({
      title: 'Swarm Orphan WT Holder',
      profileId: 'assistant',
      cwd: env1.repoDir,
    })
    const swarmWt = (await env1.app.kernel.plugins.invokeAction('builtin:workflow', 'acquire_worktree', {
      conversationId: wtSwarmConv.id,
      parentConversationId: coord.id,
      requestCwd: env1.repoDir,
      hold: { pluginId: SWARM_PLUGIN_ID, holdId: 'orphan-crash-hold', label: 'Orphaned swarm hold' },
    })) as { worktreeId: string }
    swarmOrphanWtId = swarmWt.worktreeId

    const wtWorkflowConv = await env1.app.kernel.createConversation({
      title: 'Foreign Workflow WT Holder',
      profileId: 'assistant',
      cwd: env1.repoDir,
    })
    const workflowWt = (await env1.app.kernel.plugins.invokeAction('builtin:workflow', 'acquire_worktree', {
      conversationId: wtWorkflowConv.id,
      parentConversationId: coord.id,
      requestCwd: env1.repoDir,
      hold: { pluginId: 'builtin:workflow', holdId: 'foreign-hold', label: 'Foreign workflow hold' },
    })) as { worktreeId: string }
    workflowWtId = workflowWt.worktreeId
    const created2 = (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Partial Tail Squad',
      conversationId: (
        await env1.app.kernel.createConversation({ title: 'Partial Tail Coord', profileId: 'assistant', cwd: env1.repoDir })
      ).id,
    })) as { groupId: string }
    group2Id = created2.groupId
  } finally {
    await env1.close()
  }

  // Inject uncommitted complete WAL tail post on group1 and partial truncated JSON tail on group2.
  const groupDir2 = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', group2Id)
  const boardPath2 = join(groupDir2, 'board.jsonl')
  writeFileSync(boardPath2, `{"seq":1,"groupId":"${group2Id}"`, 'utf8')
  const groupDir = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId)
  const metaBeforeRestart = JSON.parse(readFileSync(join(groupDir, 'meta.json'), 'utf8')) as CollabGroupRecord
  committedHeadSeq = metaBeforeRestart.headSeq
  const boardPath = join(groupDir, 'board.jsonl')
  const existingBoard = readFileSync(boardPath, 'utf8')
  const dirtyPost: BoardPost = {
    groupId,
    seq: committedHeadSeq + 1,
    channel: 'main',
    from: 'coordinator',
    to: ['all'],
    resolvedTargets: [],
    wake: false,
    kind: 'comment',
    refs: [],
    body: 'Uncommitted crash post that must be rolled back',
    createdAt: Date.now(),
  }
  writeFileSync(
    boardPath,
    `${existingBoard}${JSON.stringify(dirtyPost)}\n`,
    'utf8',
  )

  const faux2 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
  const app2 = await createHelm({
    buildProvider: createPluginBuildProvider(),
    dataDir: env1.dataDir,
    cwd: env1.repoDir,
    model: 'faux/faux-1',
    providers: [faux2.provider],
  })
  try {
    await waitFor(() => app2.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0)

    // 1) WAL rolled back cleanly to committed headSeq.
    const read = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as { posts: BoardPost[] }
    assert.equal(read.posts.every((p) => p.seq <= committedHeadSeq), true)
    assert.equal(read.posts.some((p) => p.body.includes('Uncommitted crash post')), false)
    const repairedLines = readFileSync(boardPath, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(repairedLines.length, committedHeadSeq)

    const read2 = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId: group2Id })) as { posts: BoardPost[] }
    assert.equal(read2.posts.length, 0)
    assert.equal(readFileSync(boardPath2, 'utf8'), '')

    // 2) Tags converged strictly against meta.json.
    assert.equal(app2.kernel.getConversation(coordId).tags.includes(COORDINATOR_TAG), true)
    assert.equal(app2.kernel.getConversation(orphanCoordId).tags.includes(COORDINATOR_TAG), false)
    assert.equal(app2.kernel.getConversation(coderId).tags.includes(WORKER_TAG), false)
    assert.equal(app2.kernel.getConversation(coderId).tags.includes(ARCHIVED_WORKER_TAG), true)
    assert.equal(app2.kernel.getConversation(orphanWorkerId).tags.includes(WORKER_TAG), false)

    // 3) Orphaned builtin:swarm worktree hold was released and removed; builtin:workflow hold remained intact.
    const swarmWtInspect = (await app2.kernel.plugins.invokeAction('builtin:workflow', 'inspect_worktree', {
      worktreeId: swarmOrphanWtId,
      diff: false,
    })) as { exists: boolean }
    assert.equal(swarmWtInspect.exists, false)
    const workflowWtInspect = (await app2.kernel.plugins.invokeAction('builtin:workflow', 'inspect_worktree', {
      worktreeId: workflowWtId,
      diff: false,
    })) as { exists: boolean }
    assert.equal(workflowWtInspect.exists, true)
  } finally {
    await app2.close()
  }
})

// ---------------------------------------------------------------------------
// int10: runtime.started 对账 — inflightWakeup 未提交死锁恢复、漏收 turn_settled 哑巴续催与异常自动 blocker
// ---------------------------------------------------------------------------

test('swarm-int10: runtime.started reconciliation wakes uncommitted inflightWakeup, nudges silent-exit member, and posts blocker for errored member', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-swarm-reconcile-')
  const env1 = await openSwarmEnv(root)
  let groupId = ''
  let group2Id = ''
  let coordId = 0
  let workerAId = 0
  let workerALastEntryId = 0
  let workerBId = 0
  let workerCId = 0

  try {
    const coord = await env1.app.kernel.createConversation({ title: 'Reconcile Coord', profileId: 'assistant', cwd: env1.repoDir })
    coordId = coord.id
    const created = (await env1.app.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'create_group', {
      title: 'Missed Settlement Squad',
      conversationId: coord.id,
    })) as { groupId: string }
    groupId = created.groupId

    const convA = await env1.app.kernel.createConversation({
      title: 'Worker A',
      profileId: 'assistant',
      cwd: env1.repoDir,
      tags: [WORKER_TAG],
    })
    workerAId = convA.id
    workerALastEntryId = convA.lastEntryId ?? 0

    const convB = await env1.app.kernel.createConversation({
      title: 'Worker B',
      profileId: 'assistant',
      cwd: env1.repoDir,
      tags: [WORKER_TAG],
    })
    workerBId = convB.id

    const convC = await env1.app.kernel.createConversation({
      title: 'Worker C',
      profileId: 'assistant',
      cwd: env1.repoDir,
      tags: [WORKER_TAG],
    })
    workerCId = convC.id

    // Seed real pre-restart turns for workerB (silent idle completion) and workerC (error stopReason)
    // before registering them into meta.json so pre-crash turn_settled didn't run on them yet.
    env1.faux.setResponses([
      fauxAssistantMessage('Silent exit response without calling swarm_board_post.'),
      fauxAssistantMessage('Partial failure output.', { stopReason: 'error', errorMessage: 'simulated model crash' }),
    ])
    await env1.app.kernel.submitInput(workerBId, '[swarm_worker_brief] Finish task B.', {
      origin: 'agent',
      requestId: `swarm-wakeup:${groupId}:workerB:1-2`,
    })
    await env1.app.kernel.waitForIdle(workerBId)

    await env1.app.kernel.submitInput(workerCId, '[swarm_worker_brief] Finish task C.', {
      origin: 'agent',
      requestId: `swarm-wakeup:${groupId}:workerC:1-3`,
    })
    await waitFor(() => env1.app.kernel.getConversation(workerCId).status !== 'working')
  } finally {
    await env1.close()
  }

  // Persist post-crash disk state: 3 briefs in board.jsonl + inflightWakeup / missed settlements in meta.json.
  const groupDir = join(env1.dataDir, 'plugins', 'builtin%3Aswarm', 'groups', groupId)
  const metaPath = join(groupDir, 'meta.json')
  const boardPath = join(groupDir, 'board.jsonl')
  const now = Date.now()
  const posts: BoardPost[] = [
    {
      groupId,
      seq: 1,
      channel: 'main',
      from: 'coordinator',
      to: ['workerA'],
      resolvedTargets: ['workerA'],
      wake: true,
      kind: 'brief',
      refs: [],
      body: 'Task A brief pending uncommitted inflightWakeup.',
      createdAt: now - 30,
    },
    {
      groupId,
      seq: 2,
      channel: 'main',
      from: 'coordinator',
      to: ['workerB'],
      resolvedTargets: ['workerB'],
      wake: true,
      kind: 'brief',
      refs: [],
      body: 'Task B brief ended silently before onMemberTurnSettled.',
      createdAt: now - 20,
    },
    {
      groupId,
      seq: 3,
      channel: 'main',
      from: 'coordinator',
      to: ['workerC'],
      resolvedTargets: ['workerC'],
      wake: true,
      kind: 'brief',
      refs: [],
      body: 'Task C brief crashed with model error before onMemberTurnSettled.',
      createdAt: now - 10,
    },
  ]
  writeFileSync(boardPath, `${posts.map((p) => JSON.stringify(p)).join('\n')}\n`, 'utf8')

  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CollabGroupRecord
  meta.headSeq = 3
  meta.members = [
    {
      name: 'workerA',
      conversationId: workerAId,
      profileId: 'assistant',
      access: 'readwrite',
      isolation: 'inherit',
      nodeId: 'local',
      cwd: env1.repoDir,
      channels: ['main'],
      lifecycle: 'active',
      readCursorSeq: 0,
      pendingWakeupSeq: 1,
      lastWakeTaskSeq: 1,
      inflightWakeup: {
        requestId: `swarm-wakeup:${groupId}:workerA:1-1`,
        fromSeq: 1,
        toSeq: 1,
        baseCompletionSeq: 0,
        baseLastEntryId: workerALastEntryId,
      },
      createdAt: now - 30,
    },
    {
      name: 'workerB',
      conversationId: workerBId,
      profileId: 'assistant',
      access: 'readwrite',
      isolation: 'inherit',
      nodeId: 'local',
      cwd: env1.repoDir,
      channels: ['main'],
      lifecycle: 'active',
      readCursorSeq: 2,
      pendingWakeupSeq: 2,
      lastWakeTaskSeq: 2,
      lastWakeCompletionSeq: 0,
      createdAt: now - 20,
    },
    {
      name: 'workerC',
      conversationId: workerCId,
      profileId: 'assistant',
      access: 'readwrite',
      isolation: 'inherit',
      nodeId: 'local',
      cwd: env1.repoDir,
      channels: ['main'],
      lifecycle: 'active',
      readCursorSeq: 3,
      pendingWakeupSeq: 3,
      lastWakeTaskSeq: 3,
      lastWakeCompletionSeq: 0,
      createdAt: now - 10,
    },
  ]
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  const faux2 = makeFauxProvider({ models: [{ id: 'faux-1' }] })
  setSwarmRoleResponses(faux2, {
    workerA: [
      fauxAssistantMessage(
        [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Worker A completed after inflightWakeup recovery.' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Worker A done.'),
    ],
    workerB: [
      fauxAssistantMessage(
        [fauxToolCall('swarm_board_post', { to: ['coordinator'], kind: 'done', body: 'Worker B completed after recovery nudge.' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Worker B done.'),
    ],
    coordinator: [
      fauxAssistantMessage('Coordinator acknowledged recovery update 1.'),
      fauxAssistantMessage('Coordinator acknowledged recovery update 2.'),
      fauxAssistantMessage('Coordinator acknowledged recovery update 3.'),
    ],
  })

  const app2 = await createHelm({
    buildProvider: createPluginBuildProvider(),
    dataDir: env1.dataDir,
    cwd: env1.repoDir,
    model: 'faux/faux-1',
    providers: [faux2.provider],
  })
  try {
    try {
      await waitFor(
        () =>
          isSettledStatus(app2.kernel.getConversation(workerAId).status) &&
          app2.kernel.getConversation(workerAId).completionSeq >= 1 &&
          isSettledStatus(app2.kernel.getConversation(workerBId).status) &&
          app2.kernel.getConversation(workerBId).completionSeq >= 2 &&
          isSettledStatus(app2.kernel.getConversation(coordId).status) &&
          app2.kernel.getConversation(coordId).completionSeq >= 1 &&
          app2.kernel.plugins.activeTaskCount(SWARM_PLUGIN_ID) === 0,
        { timeoutMs: 8_000 },
      )
    } catch (err) {
      const a = app2.kernel.getConversation(workerAId)
      const b = app2.kernel.getConversation(workerBId)
      const c = app2.kernel.getConversation(workerCId)
      const cr = app2.kernel.getConversation(coordId)
      const dB = await app2.kernel.getConversationDetail(workerBId, { limit: 20 })
      const dCoord = await app2.kernel.getConversationDetail(coordId, { limit: 20 })
      throw new Error(
        `${(err as Error).message}\nworkerA=${JSON.stringify(a)}\nworkerB=${JSON.stringify(b)}\nworkerC=${JSON.stringify(c)}\ncoord=${JSON.stringify(cr)}\nbEntries=${JSON.stringify(dB.entries)}\ncoordEntries=${JSON.stringify(dCoord.entries)}`,
      )
    }
    await app2.kernel.waitForIdle(workerAId)
    await app2.kernel.waitForIdle(workerBId)
    await app2.kernel.waitForIdle(coordId)

    const read = (await app2.kernel.plugins.invokeAction(SWARM_PLUGIN_ID, 'board_read', { groupId })) as {
      posts: BoardPost[]
    }
    assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'workerA').length, 1)
    assert.equal(read.posts.filter((p) => p.kind === 'done' && p.from === 'workerB').length, 1)
    const blockerC = read.posts.find((p) => p.kind === 'blocker' && p.from === 'system' && p.to.includes('coordinator'))
    assert.ok(blockerC !== undefined, `expected auto system blocker for errored workerC, got ${JSON.stringify(read.posts)}`)
    assert.match(blockerC.body, /workerC/)

    const detailB = await app2.kernel.getConversationDetail(workerBId, { limit: 50 })
    const nudgesB = detailB.entries.filter(
      (e) => e.kind === 'helm.input' && JSON.stringify(e.data ?? '').includes('swarm_silent_exit_nudge'),
    )
    assert.equal(nudgesB.length, 1, `expected 1 silent-exit nudge for workerB, got ${nudgesB.length}`)

    const detailC = await app2.kernel.getConversationDetail(workerCId, { limit: 50 })
    assert.equal(
      detailC.entries.some((e) => JSON.stringify(e.data ?? '').includes('swarm_silent_exit_nudge')),
      false,
      'errored workerC must receive auto blocker rather than silent-exit nudge',
    )

    const coordDetail = await app2.kernel.getConversationDetail(coordId, { limit: 50 })
    const coordReportText = JSON.stringify(
      coordDetail.entries.filter((e) => e.kind === 'helm.input' && JSON.stringify(e.data ?? '').includes('swarm_board_report')),
    )
    assert.match(coordReportText, /@workerA/)
    assert.match(coordReportText, /@workerB/)
    assert.match(coordReportText, /@workerC/)
  } finally {
    await app2.close()
  }
})
