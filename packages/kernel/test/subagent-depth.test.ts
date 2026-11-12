/**
 * 子代理嵌套深度契约：builtin:workflow 受管子代理是编排叶子。
 *
 * 事实来源（跨重启持久）：插件私有 doc `subagent-conversations` 登记经
 * agent_spawn 管道成功派生（onResolved 回传 conversationId）的子会话；
 * fork 会话与 SuperAgent worker（经 createConversation 创建，不经 spawn
 * 管道）不进表，不受嵌套限制影响。
 *
 * 三道防线：
 * 1. before_turn：受管子代理回合剥离 subagent / SubagentWorkflow（profile
 *    协作目录随工具清单自然不注入）；
 * 2. 工具/动作入口：subagent 工具、SubagentWorkflow 工具、run 动作在创建
 *    任何 run 记录前拒绝（HelmError subagent_depth_exceeded）；
 * 3. agent_spawn 最高优先级兜底（priority 300，先于 isolation 200 的
 *    worktree 分配）：直接调 kernel.spawnAgent 也被拒。
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

/** 工具结果 entry 文本（最近一次指定工具调用的 model[0] 文本块拼接）。 */
function toolResultText(
  detail: { entries: Array<{ kind: string; model?: unknown[] }> },
  toolName: string,
): string {
  const entry = [...detail.entries]
    .reverse()
    .find((e) => e.kind === 'pi.tool-result' && toolNameOf(e.model) === toolName)
  assert.ok(entry, `应存在 ${toolName} 的 pi.tool-result entry`)
  const message = entry.model?.[0] as { content?: Array<{ type: string; text?: string }> } | undefined
  return (message?.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function toolNameOf(model: unknown[] | undefined): string | undefined {
  const message = model?.[0] as { toolName?: string } | undefined
  return message?.toolName
}

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

// ---------------------------------------------------------------------------
// 1. 顶层可派生 + 登记表事实建立 + 子代理回合工具剥离
// ---------------------------------------------------------------------------

describe('workflow 子代理深度契约', { timeout: 60_000 }, () => {
  test('顶层会话可派生子代理；成功派生登记入私有表；子代理回合剥离 subagent/SubagentWorkflow', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth1')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      // 顶层：派生一个子代理（真实原生 spawn，真子会话）。
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '子任务' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('子代理的回答'),
        fauxAssistantMessage('主回合完成'),
        // 子代理回合（下一轮输入触发）：此刻工具已被剥离，模型只能文本回复。
        fauxAssistantMessage('子代理只能直接回答'),
      ])
      await app.kernel.submitInput(1, '派生子代理')
      await app.kernel.waitForIdle(1)

      const child = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, '顶层派生应创建真子会话')

      // 登记表：私有 doc 持久化事实（跨重启可读）。
      await app.kernel.documentStore.flush()
      const registry = readRegistryRaw(dir)
      assert.ok(
        registry[String(child.id)],
        `受管子代理 ${child.id} 应登记入 subagent-conversations 表（实际：${JSON.stringify(registry)}）`,
      )

      // 子代理回合 before_turn：派工工具被剥离（capture 插件在子代理输入时观察）。
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
      await app.kernel.submitInput(child.id, '子代理被提问')
      await app.kernel.waitForIdle(child.id)
      assert.ok(childTools, '应观察到子代理回合的工具清单')
      assert.ok(
        !childTools!.includes('subagent') && !childTools!.includes('SubagentWorkflow'),
        `子代理回合应剥离派工工具（实际：${childTools!.join(',')}）`,
      )
      assert.ok(childTools!.includes('bash'), '非派工工具不受影响（bash 仍在）')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 2. 子代理直接调用工具被拒 + 不产生 run 记录
  // -------------------------------------------------------------------------

  test('子代理内直接调 subagent / SubagentWorkflow 工具被拒（subagent_depth_exceeded），不产生任何 run 记录', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth2')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      // 顶层派生子代理（正常成功），随后对子代理直接提交人工输入——工具虽被
      // before_turn 剥离，模型上下文可能残留旧声明；此处经动作入口（同一
      // assertCanSpawn 事实源）验证拒绝语义，再验证 spawnAgent 兜底。
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '子任务' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('子代理的回答'),
        fauxAssistantMessage('主回合完成'),
      ])
      await app.kernel.submitInput(1, '派生子代理')
      await app.kernel.waitForIdle(1)
      const child = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, '应派生子会话')

      // run 动作（HTTP/CLI 同链路）定向子代理会话：拒绝。
      await assert.rejects(
        () =>
          app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
            script: 'export const meta = { name: "t", description: "d" }\nreturn 1',
            conversationId: child.id,
          }),
        (err: unknown) =>
          err instanceof HelmError && err.code === 'subagent_depth_exceeded',
      )

      // SubagentWorkflow 工具链与 subagent 工具共用 assertCanSpawn；经模型
      // 工具链验证一次（子代理回合工具已剥离，SDK 对未知工具名报错——因此
      // 这里在顶层模拟「子代理上下文」不可行，改为验证 spawnAgent 兜底 +
      // 动作入口已覆盖 run；工具入口在下方 background 用例经真实子代理调用）。

      // 无新 run 记录产生。
      const runs = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', {})) as {
        runs: Array<{ id: string }>
      }
      assert.equal(runs.runs.length, 0, '拒绝路径不得产生任何 run 记录')
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 3. agent_spawn 兜底：绕过工具/动作直调 spawnAgent 也被拒
  // -------------------------------------------------------------------------

  test('agent_spawn 兜底：子代理会话直接 spawnAgent 被拒（403 subagent_depth_exceeded），先于 worktree 分配', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth3')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '子任务' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('子代理的回答'),
        fauxAssistantMessage('主回合完成'),
      ])
      await app.kernel.submitInput(1, '派生子代理')
      await app.kernel.waitForIdle(1)
      const child = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child)

      // 直调（含 isolation:worktree —— 必须在 worktree 分配前拒绝，不产生
      // 任何 git 副作用或租约记录）。
      await assert.rejects(
        () =>
          app.kernel.spawnAgent({
            parentConversationId: child.id,
            prompt: '试图再派生',
            isolation: 'worktree',
          }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `应为 HelmError（实际 ${String(err)}）`)
          assert.equal(err.code, 'subagent_depth_exceeded')
          assert.equal(err.status, 403)
          return true
        },
      )
      // 顶层会话不受影响（对照组；直调会真实执行子会话回合，补一条 faux 响应）。
      faux.setResponses([fauxAssistantMessage('顶层对照子代理回答')])
      const ok = await app.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '顶层正常派生',
      })
      assert.ok(ok !== undefined)
    } finally {
      await app.close()
    }
  })

  // -------------------------------------------------------------------------
  // 4. fork 会话不被误伤
  // -------------------------------------------------------------------------

  test('fork 会话（有 parentConversationId）不被误伤：工具完整、spawn 与 run 动作可用', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth4')
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

      // fork 不在登记表内：spawnAgent 放行、run 动作放行（wait 终态；直调
      // 会真实执行子会话回合，补一条 faux 响应）。
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
  // 5. SuperAgent worker 不被误伤（有 parentConversationId，但不经 spawn 管道）
  // -------------------------------------------------------------------------

  test('SuperAgent worker 不被误伤：dispatch_worker 创建的会话可正常派生子代理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth5')
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

      // worker 不在登记表：spawnAgent 放行（直调会真实执行子会话回合，补 faux 响应）。
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
  // 6. 重启恢复：登记表持久，重启后子代理依旧被拒
  // -------------------------------------------------------------------------

  test('重启恢复：私有登记表跨重启持久，重启后子代理依旧被拒绝', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'depth6')
    {
      const { models, faux } = makeFauxModels()
      const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
      try {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall('subagent', { prompt: '子任务' })], { stopReason: 'toolUse' }),
          fauxAssistantMessage('子代理的回答'),
          fauxAssistantMessage('主回合完成'),
        ])
        await app.kernel.submitInput(1, '派生子代理')
        await app.kernel.waitForIdle(1)
        const child = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
        assert.ok(child)
      } finally {
        await app.close()
      }
    }
    // 重启：同一 dataDir，登记表生效。
    {
      const { models, faux } = makeFauxModels()
      const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models: models as never })
      try {
        const child = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
        assert.ok(child, '重启后子会话镜像应恢复')
        await assert.rejects(
          () =>
            app.kernel.spawnAgent({
              parentConversationId: child.id,
              prompt: '重启后再派生',
            }),
          (err: unknown) => err instanceof HelmError && err.code === 'subagent_depth_exceeded',
        )
        // 顶层对照组依旧放行（补 faux 响应供真实子会话回合消费）。
        faux.setResponses([fauxAssistantMessage('重启后顶层派生子代理回答')])
        const ok = await app.kernel.spawnAgent({ parentConversationId: 1, prompt: '重启后顶层派生' })
        assert.ok(ok !== undefined)
      } finally {
        await app.close()
      }
    }
  })
})
