/**
 * subagent / SubagentWorkflow 工具入参完整性与 buildSpawnEnv 回归。
 *
 * 覆盖：
 * - subagent 声明（before_turn tools 载荷：agentType/cwd/isolation/resume/
 *   model/effort 均进 inputSchema）与真实 faux 工具调用全链——各值原样进入
 *   agent_spawn hook，原生 spawn 真子会话执行，工具输出独立回报执行元数据
 *   （conversationId 等续接标识，不混入业务 result）；
 * - resume 续接标识贯通（第二次调用 resume=<conversationId>，钩子载荷与
 *   输出尾行均可见，且续接原会话不新建）；
 * - 不合法 isolation 被 SDK 参数校验显式拒绝（invalid_arguments），钩子
 *   绝不触发——不静默丢字段降级执行；
 * - agent_spawn handled 外部后端：onResolved 回传 executionId/effectiveCwd/
 *   worktree，工具 structuredOutput.execution 与文本尾行独立回报；
 * - SubagentWorkflow：script + args（任意 JSON 对象原样到达真实引擎，绝不
 *   String 化）、scriptPath、resumeFromRunId 断点恢复经真实 WorkflowService；
 * - KernelRuntime.buildSpawnEnv / buildManagedEnv：仅会话 stash + 受管五变量
 *   + 受管 token（覆盖 stash 同名伪造），绝不携带 process.env（PATH/HOME/
 *   自定义 spy 键均不外泄）；无受管 token 时不透传任何 HELM_TOKEN；秘密与
 *   受管 token 均在 stash 脱敏登记内（日志/模型上下文只见 [REDACTED]）。
 * - runGate/runShell options.env：本机 Gate 与实际 Herdr 任务同环境
 *   （process.env < options.env < 受管变量三级合并；HELM 固定值与受管
 *   token 不被注入劫持；无受管 token 时剥除一切来源的 HELM_TOKEN）。
 *
 * 诚实性纪律：模型输出全部来自 faux 脚本；spawn/workflow/HTTP 层为真实执行
 * （真子会话、真 worker 线程、真 journal），绝不 mock 引擎或伪造完成结果。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import type { AgentSpawnRequest } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHelm } from '../src/app.js'
import { KernelRuntime } from '../src/runtime/index.js'
import { buildManagedEnv, runShell } from '../src/runtime/tools.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import { SecretStash } from '../src/services/index.js'

interface FauxHandle {
  setResponses(messages: unknown[]): void
  state: { callCount: number }
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
  rootDir = mkdtempSync(join(tmpdir(), 'helm-subagent-tools-test-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** 工具结果 entry 文本（pi.tool-result 的 model[0].content 文本块拼接）。 */
function toolResultText(detail: { entries: Array<{ kind: string; model?: unknown[] }> }, toolName: string): string {
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

/** agent_spawn 观察插件：记录每次载荷，返回 void（continue）。 */
function spawnObserver(spawns: AgentSpawnRequest[]) {
  return {
    id: 'test:spawn-observer',
    name: 'spawn 观察者',
    definePlugin(ctx: { hook: { onAgentSpawn(fn: (p: AgentSpawnRequest) => void): void } }) {
      ctx.hook.onAgentSpawn((payload) => {
        spawns.push(payload)
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 1. subagent 工具：声明 + 完整入参进入 hook + 原生执行元数据回报
// ---------------------------------------------------------------------------

describe('subagent 工具完整入参与执行元数据', { timeout: 60_000 }, () => {
  it('声明含全部新入参；agentType/cwd/model/effort 原样进入 agent_spawn hook；输出独立回报 conversationId', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sa1')
    const { models, faux } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: models as never,
      watchdogIntervalMs: 0,
    })
    try {
      const spawns: AgentSpawnRequest[] = []
      await kernel.plugins.register(spawnObserver(spawns))

      // before_turn 捕获工具声明（本回合真实触发）。
      let declared: { name: string; inputSchema: Record<string, unknown> } | undefined
      await kernel.plugins.register({
        id: 'test:declare-observer',
        name: '声明观察者',
        definePlugin(ctx) {
          ctx.hook.onBeforeTurn((payload) => {
            const tools = (payload as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools
            declared = tools.find((t) => t.name === 'subagent')
          })
        },
      })

      const childCwd = join(dir, 'child-work')
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('subagent', {
              prompt: '子任务',
              agentType: 'assistant',
              cwd: childCwd,
              model: 'faux/faux-1',
              effort: 'low',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('子代理的回答'),
        fauxAssistantMessage('主回合完成'),
      ])

      await kernel.submitInput(1, '派生子代理')
      await kernel.waitForIdle(1)

      // 声明：全部新字段进入 inputSchema（模型可见）。
      assert.ok(declared, 'before_turn 应捕获 subagent 声明')
      const props = declared!.inputSchema['properties'] as Record<string, unknown>
      for (const field of ['agentType', 'cwd', 'isolation', 'resume', 'model', 'effort']) {
        assert.ok(props[field], `subagent 声明应含 ${field}`)
      }
      const isolationSchema = props['isolation'] as { enum?: unknown[] }
      assert.deepEqual(isolationSchema.enum, ['worktree'], 'isolation 声明应仅允许 worktree')

      // hook 载荷：各值原样到达（未静默丢字段）。
      assert.equal(spawns.length, 1, 'agent_spawn 钩子应恰好触发一次')
      const payload = spawns[0]!
      assert.equal(payload.prompt, '子任务')
      assert.equal(payload.agentType, 'assistant')
      assert.equal(payload.cwd, childCwd)
      assert.equal(payload.model, 'faux/faux-1')
      assert.equal(payload.effort, 'low')
      assert.equal(payload.isolation, undefined, '未传 isolation 时不得凭空出现')

      // 原生执行：真子会话派生；工具文本独立回报 conversationId（续接标识）。
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      const child = kernel
        .listConversations()
        .find((c) => c.parentConversationId === 1)
      assert.ok(child, '应派生真子会话')
      assert.ok(
        text.includes(`conversationId=${child.id}`),
        `工具输出应含续接标识 conversationId=${child.id}，实得：${text.slice(-200)}`,
      )
      assert.ok(text.includes('子代理的回答'), '业务结果原样回传')
      assert.ok(
        text.includes(`cwd=${childCwd}`),
        `执行元数据应含 effectiveCwd=${childCwd}`,
      )
      assert.equal(await kernel.getLastAssistantText(1), '主回合完成')
    } finally {
      await kernel.close()
    }
  })

  it('resume 续接：以首调返回的 conversationId 续接原会话，不新建；钩子载荷与尾行均可见 resume', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sa2')
    const { models, faux } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: models as never,
      watchdogIntervalMs: 0,
    })
    try {
      const spawns: AgentSpawnRequest[] = []
      await kernel.plugins.register(spawnObserver(spawns))

      // 首调：派生子会话。
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '第一轮' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('第一轮回答'),
        fauxAssistantMessage('首回合完成'),
      ])
      await kernel.submitInput(1, '首调')
      await kernel.waitForIdle(1)
      const child = kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, '首调应派生子会话')
      assert.equal(spawns.length, 1)

      // 续接：resume = 首调返回的 conversationId。
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '第二轮', resume: String(child.id) })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('续接回答'),
        fauxAssistantMessage('续接回合完成'),
      ])
      await kernel.submitInput(1, '续接')
      await kernel.waitForIdle(1)

      assert.equal(spawns.length, 2, '续接也应经 agent_spawn 钩子')
      assert.equal(spawns[1]!.resume, String(child.id), 'resume 原样进入钩子载荷')
      const children = kernel.listConversations().filter((c) => c.parentConversationId === 1)
      assert.equal(children.length, 1, '续接不得新建子会话')

      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      assert.ok(
        text.includes(`resume=${child.id}`) && text.includes(`conversationId=${child.id}`),
        `续接输出应同时含 resume 与 conversationId 标识：${text.slice(-200)}`,
      )
      assert.ok(text.includes('续接回答'))
    } finally {
      await kernel.close()
    }
  })

  it("不合法 isolation（'docker'）被显式拒绝：钩子绝不触发，不静默丢字段降级执行", { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sa3')
    const { models, faux } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: models as never,
      watchdogIntervalMs: 0,
    })
    try {
      const spawns: AgentSpawnRequest[] = []
      await kernel.plugins.register(spawnObserver(spawns))

      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '坏隔离', isolation: 'docker' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('主回合仍完成'),
      ])
      await kernel.submitInput(1, '坏 isolation')
      await kernel.waitForIdle(1)

      assert.equal(spawns.length, 0, '非法 isolation 绝不进入 agent_spawn 钩子')
      assert.equal(
        kernel.listConversations().filter((c) => c.parentConversationId === 1).length,
        0,
        '不得派生任何子会话',
      )
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      assert.ok(
        text.includes('isolation') && text.includes('worktree'),
        `拒绝信息应显式指出 isolation 非法：${text.slice(0, 300)}`,
      )
      assert.ok(!text.includes('subagent_failed'), 'SDK 参数校验拒绝（非工具内部失败路径）')
    } finally {
      await kernel.close()
    }
  })

  it('agent_spawn handled 外部后端：onResolved 回传 executionId/effectiveCwd/worktree，工具独立回报不混入业务 result', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sa4')
    const { models, faux } = makeFauxModels()
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: models as never,
      watchdogIntervalMs: 0,
    })
    try {
      // 外部后端语义（如 builtin:herdr）：接管执行并经 onResolved 回传元数据。
      await kernel.plugins.register({
        id: 'test:external-backend',
        name: '外部后端',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn((payload) => {
            const req = payload as AgentSpawnRequest
            req.onResolved?.({
              executionId: 'pane-9',
              effectiveCwd: '/srv/wt/helm-42',
              worktree: { path: '/srv/wt/helm-42', branch: 'helm/wf-run-1' },
            })
            return { action: 'handled', result: { external: 'done', detail: 7 } }
          })
        },
      })

      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', { prompt: '外部任务', agentType: 'herdr:agy' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('外部回合完成'),
      ])
      await kernel.submitInput(1, '外部后端')
      await kernel.waitForIdle(1)

      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'subagent')
      // 文本尾行：外部执行标识可见（模型可作续接/对账凭据）。
      assert.ok(text.includes('executionId=pane-9'), `输出应含 executionId：${text.slice(-200)}`)
      assert.ok(text.includes('cwd=/srv/wt/helm-42'))
      assert.ok(text.includes('worktree=/srv/wt/helm-42@helm/wf-run-1'))
      // 业务 result 原样；元数据独立行，不混入 result 对象本身。
      assert.ok(text.includes('external'))
      assert.equal(
        kernel.listConversations().filter((c) => c.parentConversationId === 1).length,
        0,
        'handled 后端接管时不得派生原生子会话',
      )
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. SubagentWorkflow 工具：scriptPath / args（不 String 化）/ resumeFromRunId
// ---------------------------------------------------------------------------

describe('SubagentWorkflow 工具入参贯通（真实引擎）', { timeout: 60_000 }, () => {
  it('args 为任意 JSON 对象原样到达真实引擎（args.items.map 可用，绝不 String 化）；scriptPath 与 resumeFromRunId 均贯通', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wf1')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: models as never,
      watchdogIntervalMs: 0,
    })
    try {
      // --- script + args（对象）：脚本内 args.items.map 依赖真实结构 ---
      const doubleScript =
        'export const meta = { name: "tool-args-obj", description: "t" }\n' +
        'return args.items.map((x) => x * 2)'
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('SubagentWorkflow', { script: doubleScript, args: { items: [1, 2, 3] } })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('编排回合完成'),
      ])
      await app.kernel.submitInput(1, '跑编排')
      await app.kernel.waitForIdle(1)

      const detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'SubagentWorkflow')
      const runId = extractRunId(text)
      assert.ok(runId, `工具输出应含 runId：${text.slice(0, 300)}`)
      const result = (await app.workflows.wait(runId)) as unknown
      assert.deepEqual(result, [2, 4, 6], 'args.items.map 真实计算——args 为对象而非字符串')

      // --- scriptPath：文件路径入口 ---
      const scriptFile = join(dir, 'wf-script-file.js')
      writeFileSync(
        scriptFile,
        'export const meta = { name: "tool-script-path", description: "t" }\nreturn args.base + 30',
      )
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('SubagentWorkflow', { scriptPath: scriptFile, args: { base: 12 } })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('scriptPath 回合完成'),
      ])
      await app.kernel.submitInput(1, '跑 scriptPath')
      await app.kernel.waitForIdle(1)
      const detail2 = await app.kernel.getConversationDetail(1, { limit: 50 })
      const runId2 = extractRunId(toolResultText(detail2, 'SubagentWorkflow'))
      assert.ok(runId2, 'scriptPath 调用应返回新 runId')
      assert.equal(await app.workflows.wait(runId2), 42, 'scriptPath 脚本真实执行')

      // --- resumeFromRunId：断点恢复（账本前缀重放，结果与原 run 一致） ---
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('SubagentWorkflow', { resumeFromRunId: runId })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('恢复回合完成'),
      ])
      await app.kernel.submitInput(1, '断点恢复')
      await app.kernel.waitForIdle(1)
      const detail3 = await app.kernel.getConversationDetail(1, { limit: 50 })
      const runId3 = extractRunId(toolResultText(detail3, 'SubagentWorkflow'))
      assert.ok(runId3, 'resume 调用应返回新 runId')
      assert.deepEqual(await app.workflows.wait(runId3), [2, 4, 6], '重放结果与原 run 一致')
      const resumedSummary = app.workflows.getRun(runId3)
      assert.equal(resumedSummary.replayedFrom, runId, 'resume run 应标记账本重放来源')
    } finally {
      await app.close()
    }
  })

  it('非法组合（script 与 scriptPath 同时提供）经工具显式失败，不伪造运行', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wf2')
    const { models, faux } = makeFauxModels()
    const app = await createHelm({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      models: models as never,
      watchdogIntervalMs: 0,
    })
    try {
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('SubagentWorkflow', {
              script: 'export const meta = { name: "x", description: "t" }\nreturn 1',
              scriptPath: '/tmp/other.js',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('回合完成'),
      ])
      await app.kernel.submitInput(1, '非法组合')
      await app.kernel.waitForIdle(1)
      const detail = await app.kernel.getConversationDetail(1, { limit: 50 })
      const text = toolResultText(detail, 'SubagentWorkflow')
      assert.ok(
        text.includes('workflow_failed') && text.includes('恰好提供一个'),
        `应显式报错而非伪造运行：${text.slice(0, 300)}`,
      )
    } finally {
      await app.close()
    }
  })
})

function extractRunId(text: string): string | undefined {
  const match = text.match(/"id":"(wf_[0-9a-zA-Z_-]+)"/)
  return match?.[1]
}

// ---------------------------------------------------------------------------
// 3. buildSpawnEnv / buildManagedEnv：外部 spawn 环境边界
// ---------------------------------------------------------------------------

describe('buildSpawnEnv 外部环境构造', { timeout: 60_000 }, () => {
  it('仅会话 stash + 受管五变量 + 受管 token；绝不携带 process.env（PATH/HOME/spy 键）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'env1')
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      hubUrl: 'http://127.0.0.1:3999',
      model: 'faux/faux-1',
      watchdogIntervalMs: 0,
    })
    try {
      process.env['HELM_SPAWN_SPY'] = 'host-secret'
      kernel.stash.put(9, 'MY_API_KEY', 'sekrit-value')
      // stash 同名伪造：受管变量必须覆盖（HELM_CWD/HELM_TOKEN 不可被会话秘密劫持）。
      kernel.stash.put(9, 'HELM_CWD', '/evil')
      kernel.stash.put(9, 'HELM_TOKEN', 'stash-spoofed-token')

      const env = kernel.buildSpawnEnv(9, '/srv/work')
      assert.equal(env['MY_API_KEY'], 'sekrit-value', '会话秘密应注入（spawn env 设计目标）')
      assert.equal(env['HELM_ENV'], '1')
      assert.equal(env['HELM_HUB_URL'], 'http://127.0.0.1:3999')
      assert.equal(env['HELM_CONVERSATION_ID'], '9')
      assert.equal(env['HELM_CWD'], '/srv/work', '受管 HELM_CWD 覆盖 stash 同名伪造')
      assert.equal(env['HELM_DATA_DIR'], dir)
      const token = env['HELM_TOKEN']
      assert.ok(token && token !== 'stash-spoofed-token', 'HELM_TOKEN 必须是受管 token（覆盖 stash 伪造）')
      assert.ok(token!.length > 8)

      // 绝不携带宿主 process.env：PATH/HOME 与 spy 键均不得外泄到远端。
      assert.equal(env['PATH'], undefined, 'spawn env 不得携带宿主 PATH')
      assert.equal(env['HOME'], undefined, 'spawn env 不得携带宿主 HOME')
      assert.equal(env['HELM_SPAWN_SPY'], undefined, '宿主自定义环境变量不得外泄')
      delete process.env['HELM_SPAWN_SPY']

      // 秘密与受管 token 均在脱敏登记内：日志/模型上下文只见 [REDACTED]。
      assert.ok(kernel.stash.redact(`x${token}y`).includes('[REDACTED'), '受管 token 必须可被脱敏')
      const redacted = kernel.stash.redact(`prefix${'sekrit-value'}suffix`)
      assert.ok(!redacted.includes('sekrit-value'), 'stash 秘密明文不得出现在脱敏产物')
    } finally {
      delete process.env['HELM_SPAWN_SPY']
      await kernel.close()
    }
  })

  it('非法入参显式拒绝（conversationId 非正整数 / 空 cwd）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'env2')
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      watchdogIntervalMs: 0,
    })
    try {
      assert.throws(() => kernel.buildSpawnEnv(0, '/x'), (err: unknown) => {
        assert.ok(err instanceof HelmError && err.code === 'validation_error')
        return true
      })
      assert.throws(() => kernel.buildSpawnEnv(1.5, '/x'), (err: unknown) => {
        assert.ok(err instanceof HelmError && err.code === 'validation_error')
        return true
      })
      assert.throws(() => kernel.buildSpawnEnv(1, ''), (err: unknown) => {
        assert.ok(err instanceof HelmError && err.code === 'validation_error')
        return true
      })
    } finally {
      await kernel.close()
    }
  })

  it('buildManagedEnv：无受管 token provider 时不透传任何 HELM_TOKEN（继承语义不存在——本构造无 process.env 基底）', { timeout: 60_000 }, () => {
    const stash = new SecretStash()
    stash.put(3, 'HELM_TOKEN', 'spoof')
    const deps: HelmToolDeps = {
      dataDir: '/d',
      defaultCwd: '/base',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: (id) => stash.envFor(id),
      redact: (t) => stash.redact(t),
      artifacts: null as never,
    }
    const env = buildManagedEnv(deps, '/work', 3)
    assert.equal(env['HELM_TOKEN'], undefined, '无 provider 时 stash 同名伪造也不得透传')
    const withProvider = buildManagedEnv({ ...deps, processToken: () => 'managed-tok' }, '/work', 3)
    assert.equal(withProvider['HELM_TOKEN'], 'managed-tok', '有 provider 时受管 token 覆盖伪造')
  })
})

// ---------------------------------------------------------------------------
// 4. Gate 执行环境与实际 Herdr 任务一致：options.env 注入机制
// ---------------------------------------------------------------------------

describe('runGate/runShell options.env 注入（本机 Gate 与 Herdr 任务同环境）', { timeout: 60_000 }, () => {
  it('真实 Gate 子进程读自定义 env；HELM 固定值与受管 token 不被注入覆盖；无 provider 时剥除注入的旧 token', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'gate1')
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      hubUrl: 'http://127.0.0.1:3999',
      model: 'faux/faux-1',
      watchdogIntervalMs: 0,
    })
    try {
      // 插件会传 Profile.runtime.env 与管理环境组成的 spawnEnv：自定义 CI 路径
      // 可达，但 HELM 固定值不得被外部注入劫持。
      const spawnEnv: Record<string, string> = {
        CI_TOOL_HOME: '/opt/ci-tools',
        HELM_CWD: '/evil-cwd',
        HELM_HUB_URL: 'http://evil.example',
        HELM_TOKEN: 'injected-stale-token',
      }
      const gate = await kernel.runGate(
        'printf "%s|%s|%s|%s" "$CI_TOOL_HOME" "$HELM_CWD" "$HELM_HUB_URL" "${HELM_TOKEN:+set}"',
        { cwd: dir, conversationId: 1, env: spawnEnv },
      )
      assert.equal(gate.ok, true, `gate 应成功：${gate.output}`)
      const [toolHome, helmCwd, hubUrl, tokenFlag] = gate.output.split('|')
      assert.equal(toolHome, '/opt/ci-tools', '自定义 env 键应真实到达 Gate 子进程')
      assert.equal(helmCwd, dir, '受管 HELM_CWD 不得被注入覆盖')
      assert.equal(hubUrl, 'http://127.0.0.1:3999', '受管 HELM_HUB_URL 不得被注入覆盖')
      assert.equal(tokenFlag, 'set', '受管 token 应覆盖注入的旧 token（非空）')
      assert.ok(!gate.output.includes('injected-stale-token'), '旧 token 值不得泄漏')
    } finally {
      await kernel.close()
    }
  })

  it('无受管 token provider 时 options.env 注入的 HELM_TOKEN 也被剥除（真实子进程不可见）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'gate2')
    mkdirSync(dir, { recursive: true })
    const stash = new SecretStash()
    const deps: HelmToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: (id) => stash.envFor(id),
      redact: (t) => stash.redact(t),
      artifacts: null as never,
    }
    const result = await runShell(deps, 'echo "${HELM_TOKEN:-UNSET} $CUSTOM_KEY"', {
      cwd: dir,
      env: { HELM_TOKEN: 'stale-injected', CUSTOM_KEY: 'visible' },
    })
    assert.equal(result.ok, true)
    assert.ok(result.output.includes('UNSET'), '无 provider 时注入的 HELM_TOKEN 必须被剥除')
    assert.ok(result.output.includes('visible'), '其余注入键正常透传')
  })

  it('process.env 同名键被 options.env 覆盖（基底 < 注入 < 受管变量三级合并）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'gate3')
    const kernel = await KernelRuntime.open({
      dataDir: dir,
      cwd: dir,
      model: 'faux/faux-1',
      watchdogIntervalMs: 0,
    })
    try {
      process.env['HELM_GATE_TEST_BASE'] = 'from-host'
      const gate = await kernel.runGate('printf "%s" "$HELM_GATE_TEST_BASE"', {
        cwd: dir,
        env: { HELM_GATE_TEST_BASE: 'from-inject' },
      })
      delete process.env['HELM_GATE_TEST_BASE']
      assert.equal(gate.ok, true)
      assert.ok(gate.output.includes('from-inject'), `注入应覆盖宿主同名键：${gate.output}`)
    } finally {
      delete process.env['HELM_GATE_TEST_BASE']
      await kernel.close()
    }
  })
})
