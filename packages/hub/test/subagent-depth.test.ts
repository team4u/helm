/**
 * 子代理嵌套深度契约：builtin:workflow 受管子代理默认可嵌套 2 层。
 *
 * 事实来源（跨重启持久）：插件私有 doc `subagent-conversations` 登记经
 * agent_spawn 管道成功派生（onResolved 回传 conversationId）的子会话，
 * 条目含 depth / parentConversationId / maxSubagentDepth（子树上限快照）；
 * fork 会话与 SuperAgent worker（经 createConversation 创建，不经 spawn
 * 管道）不进表，不受嵌套限制影响。登记事实缺失或损坏时显式拒绝。
 *
 * 三道防线：
 * 1. before_turn：达到子树上限的叶子回合剥离 subagent / SubagentWorkflow
 *    （一层子代理默认保留派工工具，可继续派二层）；
 * 2. 工具/动作入口：subagent 工具、SubagentWorkflow 工具、run 动作在创建
 *    任何 run 记录前拒绝（HelmError subagent_depth_exceeded，携带事实）；
 * 3. agent_spawn 最高优先级兜底（priority 300，先于 isolation 200 的
 *    worktree 分配）：直接调 kernel.spawnAgent 也被拒并登记新事实。
 *
 * 显式扩展：AgentSpawnRequest.maxSubagentDepth（subagent 工具入参同名字段）
 * 授予子树深度上限（1..5），受管子代理不得提高继承上限；宿主插件配置
 * 提供全局缺省值的读写入口。
 *
 * 诚实性纪律：全部真实执行（faux 模型、真子会话、真 doc 持久化、真
 * 重启恢复），不 mock 引擎、不伪造拒绝结果。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmError } from '@helm/protocol'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHelm } from '../src/app.js'

interface FauxHandle {
  setResponses(messages: unknown[]): void
  getPendingResponseCount(): number
  provider: { id: string }
}

function makeFauxModels(): { models: ReturnType<typeof createModels>; faux: FauxHandle } {
  const models = createModels()
  const faux = fauxProvider() as unknown as FauxHandle
  models.setProvider(faux.provider as never)
  return { models, faux }
}

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-subagent-depth-test-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** 读插件私有登记表持久值（flush 后从 state.sqlite 直读，验证跨重启事实）。 */
function readRegistryRaw(dataDir: string): Record<string, unknown> {
  const db = new DatabaseSync(join(dataDir, 'state.sqlite'), { readOnly: true })
  try {
    const row = db
      .prepare("SELECT value FROM helm_plugin_docs WHERE plugin_id = '__global' AND name = ?")
      .get('builtin:workflow:subagent-conversations') as { value: string } | undefined
    if (row === undefined) return {}
    return JSON.parse(row.value) as Record<string, unknown>
  } finally {
    db.close()
  }
}

/** 直写插件私有 doc（app 已关闭时使用；验证损坏记录显式拒绝）。 */
function writePluginDocRaw(dataDir: string, name: string, value: unknown): void {
  const db = new DatabaseSync(join(dataDir, 'state.sqlite'))
  try {
    db.prepare(
      `INSERT INTO helm_plugin_docs (plugin_id, name, value, updated_at) VALUES ('__global', ?, ?, ?)
       ON CONFLICT(plugin_id, name) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(name, JSON.stringify(value), Date.now())
  } finally {
    db.close()
  }
}

/** 登记表条目断言辅助：归一化读取 depth / parentConversationId / maxSubagentDepth。 */
function registryEntry(dataDir: string, conversationId: number): Record<string, unknown> {
  const raw = readRegistryRaw(dataDir)[String(conversationId)]
  assert.ok(raw !== undefined && typeof raw === 'object', `会话 ${conversationId} 应登记入 subagent-conversations 表`)
  return raw as Record<string, unknown>
}

/**
 * 派生一条真实子会话链（与生产路径同构：onResolved 参与登记表记账）：
 * parents 依次为链上父会话，返回全部新会话 id。
 */
async function spawnChain(
  app: Awaited<ReturnType<typeof createHelm>>,
  faux: FauxHandle,
  parents: number[],
): Promise<number[]> {
  const created: number[] = []
  for (const parent of parents) {
    let childId: number | undefined
    faux.setResponses([fauxAssistantMessage(`子代理 ${parent} 的回答`)])
    await app.kernel.spawnAgent({
      parentConversationId: parent,
      prompt: `从 ${parent} 派生`,
      onResolved: (info) => {
        if (info.conversationId !== undefined) childId = info.conversationId
      },
    })
    assert.ok(childId !== undefined, `应从 ${parent} 派生子会话并回传 conversationId`)
    created.push(childId)
  }
  return created
}



// ---------------------------------------------------------------------------
// 1. 顶层派生一层：事实登记 + 一层子代理保留派工工具
// ---------------------------------------------------------------------------

describe('workflow 子代理深度契约（默认上限 2）', { timeout: 60_000 }, () => {
  test('顶层会话派生一层：登记 depth=1/父链/子树上限=2；一层子代理回合保留 subagent/SubagentWorkflow', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth1')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      // 顶层：派生一个子代理（真实原生 spawn，真子会话；显式同步等待结果）。
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '子任务', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('子代理的回答'),
        fauxAssistantMessage('主回合完成'),
      ])
      await app.kernel.submitInput(1, '派生子代理')
      await app.kernel.waitForIdle(1)

      const child = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, '顶层派生应创建真子会话')

      // 登记表：私有 doc 持久化深度事实（跨重启可读）。
      await app.kernel.documentStore.flush()
      const entry = registryEntry(dir, child.id)
      assert.equal(entry['depth'], 1, '顶层直接派生的一层子代理 depth=1')
      assert.equal(entry['parentConversationId'], 1)
      assert.equal(entry['maxSubagentDepth'], 2, '缺省子树上限为默认值 2')

      // 一层子代理回合 before_turn：派工工具保留（默认可继续派二层）。
      let childTools: string[] | undefined
      await app.kernel.plugins.register({
        id: 'test:depth-observer',
        name: '深度观察者',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            const payload = turn as unknown as { conversation: { id: number }; tools: Array<{ name: string }> }
            if (payload.conversation.id === child.id) {
              childTools = payload.tools.map((t) => t.name)
            }
          })
        },
      })
      faux.setResponses([fauxAssistantMessage('一层子代理直接回答')])
      await app.kernel.submitInput(child.id, '子代理被提问')
      await app.kernel.waitForIdle(child.id)
      assert.ok(childTools, '应观察到子代理回合的工具清单')
      assert.ok(
        childTools!.includes('subagent') && childTools!.includes('SubagentWorkflow'),
        `一层子代理回合应保留派工工具（实际：${childTools!.join(',')}）`,
      )
      assert.ok(childTools!.includes('bash'), '非派工工具不受影响（bash 仍在）')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 2. 一层子代理经真实工具链继续派二层：登记 depth=2；二层回合剥离派工工具
  // -------------------------------------------------------------------------

  test('一层子代理经 subagent 工具继续派二层：登记 depth=2/父链；二层子代理回合剥离派工工具', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth2')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      // 模型消费顺序（同步 spawn 逐层 await，顺序确定）：
      // 顶层 toolUse(subagent) → 一层子代理 toolUse(subagent) → 二层子代理文本
      // → 一层续答 → 顶层续答。
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '一层任务', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '二层任务', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('二层子代理的回答'),
        fauxAssistantMessage('一层子代理完成'),
        fauxAssistantMessage('主回合完成'),
      ])
      await app.kernel.submitInput(1, '派生一层，让它继续派二层')
      await app.kernel.waitForIdle(1)

      const child1 = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child1, '应派生一层子会话')
      await app.kernel.waitForIdle(child1.id)
      const child2 = app.kernel.listConversations().find((c) => c.parentConversationId === child1.id)
      assert.ok(child2, '一层子代理应经工具链派生二层子会话')

      await app.kernel.documentStore.flush()
      const e1 = registryEntry(dir, child1.id)
      assert.equal(e1['depth'], 1)
      assert.equal(e1['parentConversationId'], 1)
      const e2 = registryEntry(dir, child2.id)
      assert.equal(e2['depth'], 2, '二层子代理 depth=2')
      assert.equal(e2['parentConversationId'], child1.id)
      assert.equal(e2['maxSubagentDepth'], 2, '子树上限继承父会话生效上限')

      // 二层子代理回合 before_turn：派工工具被剥离（达到上限即叶子）。
      let leafTools: string[] | undefined
      await app.kernel.plugins.register({
        id: 'test:depth-observer',
        name: '深度观察者',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((turn) => {
            const payload = turn as unknown as { conversation: { id: number }; tools: Array<{ name: string }> }
            if (payload.conversation.id === child2.id) {
              leafTools = payload.tools.map((t) => t.name)
            }
          })
        },
      })
      faux.setResponses([fauxAssistantMessage('二层叶子只能直接回答')])
      await app.kernel.submitInput(child2.id, '叶子被提问')
      await app.kernel.waitForIdle(child2.id)
      assert.ok(leafTools, '应观察到二层子代理回合的工具清单')
      assert.ok(
        !leafTools!.includes('subagent') && !leafTools!.includes('SubagentWorkflow'),
        `二层子代理回合应剥离派工工具（实际：${leafTools!.join(',')}）`,
      )
      assert.ok(leafTools!.includes('bash'), '非派工工具不受影响（bash 仍在）')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 3. 二层拒绝：spawnAgent 兜底 + run 动作入口，均不产生副作用
  // -------------------------------------------------------------------------

  test('二层子代理拒绝再派生：spawnAgent 403 subagent_depth_exceeded（含事实）；run 动作定向二层被拒且无 run 记录；一层对照组放行', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth3')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      const child2 = (await spawnChain(app, faux, [child1]))[0]!

      // 直调（含 isolation:worktree —— 必须在 worktree 分配前拒绝，不产生
      // 任何 git 副作用或租约记录）。
      await assert.rejects(
        () =>
          app.kernel.spawnAgent({
            parentConversationId: child2,
            prompt: '试图派三层',
            isolation: 'worktree',
          }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `应为 HelmError（实际 ${String(err)}）`)
          assert.equal(err.code, 'subagent_depth_exceeded')
          assert.equal(err.status, 403)
          const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
          assert.equal(details?.depth, 2, '错误详情应携带 depth=2 事实')
          assert.equal(details?.maxSubagentDepth, 2)
          return true
        },
      )

      // run 动作（HTTP/CLI 同链路）定向二层会话：拒绝。
      await assert.rejects(
        () =>
          app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
            script: 'export const meta = { name: "t", description: "d" }\nreturn 1',
            conversationId: child2,
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )

      // 无新 run 记录产生。
      const runs = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as {
        runs: Array<{ id: string }>
      }
      assert.equal(runs.runs.length, 0, '拒绝路径不得产生任何 run 记录')

      // 一层对照组：直调 spawnAgent 放行（一层默认可继续派二层）。
      const anotherChild2 = (await spawnChain(app, faux, [child1]))[0]!
      assert.ok(anotherChild2 > 0)
      await app.kernel.documentStore.flush()
      assert.equal(registryEntry(dir, anotherChild2)['depth'], 2)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 4. 一层子代理可运行工作流（run 动作放行），其引擎节点派生按 depth 记账
  // -------------------------------------------------------------------------

  test('一层子代理可运行 SubagentWorkflow：run 动作放行，节点派生的子会话登记 depth=2', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth4')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      faux.setResponses([fauxAssistantMessage('引擎节点子代理回答')])
      const run = (await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
        script:
          'export const meta = { name: "nested-one", description: "d" }\nconst t = await agent("节点任务")\nreturn t',
        conversationId: child1,
        wait: true,
      })) as { run: { status: string; result: unknown; nodes?: Array<{ conversationId?: number }> } }
      assert.equal(run.run.status, 'completed', JSON.stringify(run.run))
      const nodeConv = run.run.nodes?.find((n) => n.conversationId !== undefined)?.conversationId
      assert.ok(nodeConv, '引擎节点应真实派生子会话')
      await app.kernel.documentStore.flush()
      const entry = registryEntry(dir, nodeConv)
      assert.equal(entry['depth'], 2, '一层会话 run 的引擎节点派生登记 depth=2')
      assert.equal(entry['parentConversationId'], child1)
      // 二层节点是叶子：直调 spawnAgent 被拒。
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: nodeConv, prompt: '三层尝试' }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 5. 后台拒绝契约：受管子代理（helm-owned）显式 background:true 被显式拒绝
  // -------------------------------------------------------------------------

  test('受管子代理显式 background:true：显式拒绝（防早结算），不派生、不建 run；同步缺省仍可用', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth5')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      const child1 = (await spawnChain(app, faux, [1]))[0]!
      // 一层子代理是 helm-owned 自动化会话：显式 background:true 必须显式报错，
      // 不得静默改写为同步，也不得派生子会话/创建 run（防自动化调用方早结算）。
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '被拒的后台任务', background: true })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('一层续答'),
      ])
      await app.kernel.submitInput(child1, '派一个后台子代理')
      await app.kernel.waitForIdle(child1)

      const detail = await app.kernel.getConversationDetail(child1, { limit: 30 })
      const toolText = [...detail.entries]
        .reverse()
        .map((e) => JSON.stringify(e.model ?? ''))
        .find((t) => t.includes('"subagent"')) ?? ''
      assert.ok(
        toolText.includes('subagent_failed') && toolText.includes('background'),
        `拒绝信息应显式指出 background 不被允许：${toolText.slice(0, 300)}`,
      )
      const { runs } = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {
        conversationId: child1,
      })) as { runs: Array<{ id: string; kind?: string }> }
      assert.equal(runs.length, 0, '被拒调用不得创建任何 run 记录')
      assert.equal(
        app.kernel.listConversations().filter((c) => c.parentConversationId === child1).length,
        0,
        '被拒调用不得派生子会话',
      )

      // 同一受管会话缺省（省略 background）仍走同步路径：直接等待结果。
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '同步二层任务' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('同步二层回答'),
        fauxAssistantMessage('一层同步续答'),
      ])
      await app.kernel.submitInput(child1, '再派一个同步子代理')
      await app.kernel.waitForIdle(child1)
      const child2 = app.kernel.listConversations().find((c) => c.parentConversationId === child1)
      assert.ok(child2, '缺省同步调用应正常派生二层子会话')
      await app.kernel.documentStore.flush()
      const entry = registryEntry(dir, child2.id)
      assert.equal(entry['depth'], 2, '同步派生的二层子代理同样登记 depth=2')

      // 二层子代理是叶子：直调 spawnAgent 被拒。
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: child2.id, prompt: '三层尝试' }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 6. fork 会话不被误伤
  // -------------------------------------------------------------------------

  test('fork 会话（有 parentConversationId）不被误伤：工具完整、spawn 与 run 动作可用', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth6')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      // 顶层完成一个回合（提供可分叉条目）。
      faux.setResponses([fauxAssistantMessage('顶层回答')])
      await app.kernel.submitInput(1, '你好')
      await app.kernel.waitForIdle(1)
      const detail = await app.kernel.getConversationDetail(1, { limit: 10 })
      const numericEntry = detail.entries.find((e) => Number.isInteger(Number(e.id)) && Number(e.id) > 0)
      assert.ok(numericEntry, '应有可分叉条目（数字 entryId）')
      const entryId = Number(numericEntry!.id)

      const forked = await app.kernel.forkConversation(1, { entryId })
      assert.equal(forked.parentConversationId, 1, 'fork 会话同样有父链')

      // fork 不在登记表内：spawnAgent 放行、run 动作放行（wait 终态）。
      faux.setResponses([fauxAssistantMessage('fork 子代理回答')])
      const spawned = await app.kernel.spawnAgent({
        parentConversationId: forked.id,
        prompt: 'fork 会话正常派生',
      })
      assert.ok(spawned !== undefined)
      const run = (await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
        script: 'export const meta = { name: "fork-ok", description: "d" }\nreturn 7',
        conversationId: forked.id,
        wait: true,
      })) as { run: { status: string; result: unknown } }
      assert.equal(run.run.status, 'completed')
      assert.equal(run.run.result, 7)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 7. SuperAgent worker 不被误伤（有 parentConversationId，但不经 spawn 管道）
  // -------------------------------------------------------------------------

  test('SuperAgent worker 不被误伤：dispatch_worker 创建的会话可正常派生子代理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth7')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      await app.kernel.plugins.enable('builtin:superagent')
      const dispatched = (await app.kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
        prompt: 'worker 任务',
        profileId: 'assistant',
      })) as { workerConversationId: number }
      const worker = app.kernel.getConversation(dispatched.workerConversationId)
      assert.equal(worker.parentConversationId !== undefined, true, 'worker 有父链')

      // worker 不在登记表：spawnAgent 放行。
      faux.setResponses([fauxAssistantMessage('worker 派生子代理回答'), fauxAssistantMessage('worker 回合完成')])
      const spawned = await app.kernel.spawnAgent({
        parentConversationId: worker.id,
        prompt: 'worker 正常派生',
      })
      assert.ok(spawned !== undefined)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 8. 重启恢复：depth/父链事实跨重启持久，二层依旧被拒、一层仍可派
  // -------------------------------------------------------------------------

  test('重启恢复：深度事实跨重启持久，二层依旧被拒、一层仍可派新二层', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth8')
    {
      const { models, faux } = makeFauxModels()
      const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
      try {
        const child1 = (await spawnChain(app, faux, [1]))[0]!
        await spawnChain(app, faux, [child1])
      } finally {
        await app.close()
      }
    }
    // 重启：同一 dataDir，登记表事实生效。
    {
      const { models, faux } = makeFauxModels()
      const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
      try {
        const child1 = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
        assert.ok(child1, '重启后一层子会话镜像应恢复')
        const child2 = app.kernel
          .listConversations()
          .find((c) => c.parentConversationId === child1.id)
        assert.ok(child2, '重启后二层子会话镜像应恢复')

        await assert.rejects(
          () =>
            app.kernel.spawnAgent({
              parentConversationId: child2.id,
              prompt: '重启后派三层',
            }),
          (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
        )
        // 一层对照组依旧放行（重启后仍可派新二层）。
        const newChild2 = (await spawnChain(app, faux, [child1.id]))[0]!
        assert.ok(newChild2 > 0)
        await app.kernel.documentStore.flush()
        assert.equal(registryEntry(dir, newChild2)['depth'], 2)
      } finally {
        await app.close()
      }
    }
  })

  // -------------------------------------------------------------------------
  // 9. 无兼容读取：缺 depth/上限字段的损坏条目必须显式报错
  // -------------------------------------------------------------------------

  test('登记事实缺失时显式失败，不猜测深度与权限', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth9')
    let legacyChildId = 0
    {
      const { models, faux } = makeFauxModels()
      const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
      try {
        const child1 = (await spawnChain(app, faux, [1]))[0]!
        legacyChildId = child1
        await app.kernel.documentStore.flush()
      } finally {
        await app.close()
      }
    }
    // 模拟旧记录：剥掉新事实字段（旧契约仅 agentType/runId/createdAt）。
    {
      const registry = readRegistryRaw(dir)
      const legacy = registry[String(legacyChildId)] as Record<string, unknown>
      assert.ok(legacy, '旧会话应有登记条目')
      writePluginDocRaw(dir, 'builtin:workflow:subagent-conversations', {
        [String(legacyChildId)]: {
          ...(typeof legacy['agentType'] === 'string' ? { agentType: legacy['agentType'] } : {}),
          createdAt: legacy['createdAt'] ?? Date.now(),
        },
      })
    }
    const { models } = makeFauxModels()
    await assert.rejects(
      () => createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never }),
      /深度登记无效/,
    )
  })

  // -------------------------------------------------------------------------
  // 10. 显式扩展请求字段：maxSubagentDepth=3 允许三层；无效值显式拒绝
  // -------------------------------------------------------------------------

  test('显式深度授予：maxSubagentDepth=3 时三层可用、三层为叶子；新登记继承授予上限', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth10')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      faux.setResponses([fauxAssistantMessage('一层回答')])
      let grantedChild = 0
      await app.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '授予三层的子树',
        maxSubagentDepth: 3,
        onResolved: (info) => {
          if (info.conversationId !== undefined) grantedChild = info.conversationId
        },
      })
      assert.ok(grantedChild > 0, '应派生子会话并回传 conversationId')
      const child1 = grantedChild
      await app.kernel.documentStore.flush()
      assert.equal(registryEntry(dir, child1)['maxSubagentDepth'], 3, '登记表应快照显式授予的上限')
      assert.equal(registryEntry(dir, child1)['depth'], 1)

      // 三层链全部可用（1 → 2 → 3），三层为叶子。
      const child2 = (await spawnChain(app, faux, [child1]))[0]!
      const child3 = (await spawnChain(app, faux, [child2]))[0]!
      await app.kernel.documentStore.flush()
      assert.equal(registryEntry(dir, child2)['maxSubagentDepth'], 3, '子代理继承子树授予上限')
      assert.equal(registryEntry(dir, child3)['depth'], 3)
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: child3, prompt: '四层尝试' }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'subagent_depth_exceeded')
          const details = err.details as { depth?: number; maxSubagentDepth?: number } | undefined
          assert.equal(details?.depth, 3)
          assert.equal(details?.maxSubagentDepth, 3)
          return true
        },
      )

      // 无效值显式拒绝（不静默钳制）：越界 / 非整数。
      for (const invalid of [0, 6, 2.5]) {
        await assert.rejects(
          () =>
            app.kernel.spawnAgent({
              parentConversationId: 1,
              prompt: '无效授予',
              maxSubagentDepth: invalid,
            }),
          (err: unknown) => {
            assert.ok(err instanceof HelmError, `maxSubagentDepth=${invalid} 应为 HelmError`)
            assert.equal(err.code, 'validation_error')
            return true
          },
        )
      }
      // 子代理不能自行提高继承的上限，也不能设置低于目标层级的上限。
      for (const ceiling of [4, 1]) {
        await assert.rejects(
          () => app.kernel.spawnAgent({ parentConversationId: child1, prompt: '越界授权', maxSubagentDepth: ceiling }),
          (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
        )
      }
      // 拒绝路径不登记任何新事实。
      await app.kernel.documentStore.flush()
      const registry = readRegistryRaw(dir)
      assert.equal(Object.keys(registry).length, 3, '仅应登记三层链的 3 个条目')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 11. 全局配置通过宿主统一入口写入，并在重启后影响新任务树。
  // -------------------------------------------------------------------------

  test('插件配置 maxSubagentDepth 可读写、跨重启持久，非法数值显式拒绝派生', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth11')
    {
      const { models, faux } = makeFauxModels()
      const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
      try {
        assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2)
        for (const invalid of [0, 99, 2.5, Number.NaN]) {
          await assert.rejects(
            () => app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: invalid }),
            /maxSubagentDepth|字段 maxSubagentDepth/,
            `配置值 ${String(invalid)} 应在持久化边界被拒绝`,
          )
        }
        assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2, '非法配置不得污染有效配置')
        await app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: 1 })
        const child = (await spawnChain(app, faux, [1]))[0]!
        await assert.rejects(
          () => app.kernel.spawnAgent({ parentConversationId: child, prompt: '超出全局一层' }),
          (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
        )
      } finally {
        await app.close()
      }
    }
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 1)
      const child = (await spawnChain(app, faux, [1]))[0]!
      await assert.rejects(
        () => app.kernel.spawnAgent({ parentConversationId: child, prompt: '重启后仍超限' }),
        (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )
      await app.kernel.plugins.setConfig('builtin:workflow', { maxSubagentDepth: null })
      assert.equal(app.kernel.plugins.getConfig('builtin:workflow').maxSubagentDepth, 2)
    } finally {
      await app.close()
    }
  })
})
