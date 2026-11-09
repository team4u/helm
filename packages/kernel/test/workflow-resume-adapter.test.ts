/**
 * workflow-resume-adapter.test.ts — WorkflowService 生产适配参数链回归。
 *
 * 主代理定位的两处真实缺陷（本套件为 RED→GREEN 回归）：
 * 1. service.invokeSpawn 无条件注入 cwd:parent.cwd：
 *    - resume 时 proto.cwd=parent.cwd 经 updateConversation 重置已建子会话
 *      的实际 cwd（Worktree/自定义目录被父目录覆盖）；
 *    - spawn 时压过 Profile/parent/Hub 解析链，外部执行行（herdr）失去
 *      Profile.runtime.workspace 路由能力。
 * 2. 引擎 resumeAgent(agentId,prompt) 不接 schema/gate/onGateResult，
 *    service.makeEngineHost 造空 request：DSL agent('续接',{resume,schema,gate})
 *    的 Schema 没下传、外部 Gate 不在远端执行而可能本机 fallback。
 *
 * 分层（诚实性纪律：不冒充外网 E2E）：
 * - Part A 受控端口：真实 WorkflowService + 真 worker/journal 账本，唯
 *   spawnAgent 是捕获端口（模拟外部执行环境：executionId + onGateResult），
 *   断言 protocol.AgentSpawnRequest 生产参数面；
 * - Part B 真链路：真实 KernelRuntime + faux provider + 真 SDK + 真 shell
 *   （bash pwd 取证 + gate sentinel 计数），证明父会话 cwd 继承、子会话
 *   实际 cwd 不被父 cwd 覆盖、Gate 在子 cwd 恰好执行一次且本机 fallback
 *   （kernel.runGate）零调用。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AgentSpawnRequest } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/builtin-plugins/workflow/engine/service.js'

const timeout = { timeout: 60_000 } as const

const META = (name: string) => `export const meta = { name: "${name}", description: "adapter regression" }\n`

/** 状态 store fake（与 workflow.test.ts 同构的进程内 Map）。 */
function makeStateStore(): WorkflowStateStore {
  const map = new Map<string, unknown>()
  return {
    get<T>(key: string, initial: T): T {
      return (map.get(key) as T | undefined) ?? initial
    },
    set<T>(key: string, value: T): void {
      map.set(key, value)
    },
  }
}

// ---------------------------------------------------------------------------
// Part A：受控 WorkflowService 端口——生产参数面（真实引擎 + 捕获端口）
// ---------------------------------------------------------------------------

interface CapturedSpawn {
  /** 调用序（0 = 首调，1 = resume）。 */
  seq: number
  request: AgentSpawnRequest
}

/**
 * 外部执行环境 fake：onResolved 回报 executionId（外部路径事实），gate 按
 * 配置决定是否经 onGateResult 回报。runGate 计数是「本机 fallback 是否被
 * 触发」的唯一事实来源。
 */
function makeExternalHost(options: {
  /** resume 调用是否经 onGateResult 回报（外部执行环境内执行 gate）。 */
  resumeReportsGate?: boolean
  /** resume 返回给脚本的文本（需为 schema 合法 JSON）。 */
  resumeText?: string
}): WorkflowServiceHost & {
  spawns: CapturedSpawn[]
  gateFallbackRuns: number
} {
  const spawns: CapturedSpawn[] = []
  let gateFallbackRuns = 0
  const host: WorkflowServiceHost = {
    async spawnAgent(request) {
      const seq = spawns.length
      spawns.push({ seq, request })
      if (request.resume === undefined) {
        // 首调：外部执行环境确定（如 herdr 窗格），回传 executionId/effectiveCwd。
        request.onResolved?.({ executionId: 'pane-remote-1', effectiveCwd: '/remote/workspace' })
        return typeof request.schema === 'undefined' ? 'first done' : '{"ok":true}'
      }
      // resume：严格续接外部执行环境；gate 按 options 决定回报。
      request.onResolved?.({ executionId: 'pane-remote-1', effectiveCwd: '/remote/workspace' })
      if (options.resumeReportsGate !== false && request.gate !== undefined) {
        request.onGateResult?.({ ok: true, output: 'remote gate passed' })
      }
      return options.resumeText ?? '{"answer":42}'
    },
    async invokeAction() {
      throw new Error('no actions in Part A')
    },
    listActions() {
      return []
    },
    getConversation(id: number) {
      return {
        id,
        title: `conv-${id}`,
        profileId: 'assistant',
        tags: [],
        cwd: '/parent/cwd',
        model: 'faux/faux-1',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }
    },
    async abortConversation() {},
    emitEvent() {},
    async runGate() {
      gateFallbackRuns++
      return { ok: true, output: 'local fallback' }
    },
  }
  return { ...host, spawns, get gateFallbackRuns() { return gateFallbackRuns } }
}

describe('WorkflowService 生产适配：spawn/resume 端口参数面', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-adapter-'))
  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('首调不带 cwd 注入，resume 原样携带 schema+gate 且不传 agentType/cwd/isolation', timeout, async () => {
    const host = makeExternalHost({ resumeReportsGate: true })
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const script =
        META('adapter-params') +
        'const a = await agent("第一阶段", { label: "a" })\n' +
        'const b = await agent("续接并验收", { resume: "a", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false }, gate: "pnpm test" })\n' +
        'return [a, b]'
      const started = await service.run({ script, conversationId: 1 })
      const result = (await service.wait(started.id)) as unknown[]
      const summary = service.getRun(started.id)
      assert.equal(summary.status, 'completed', `run 应完成：${summary.error ?? JSON.stringify(summary.nodes)}`)
      assert.deepEqual(result, ['first done', { answer: 42 }], 'schema 结构化结果应回传脚本')

      assert.equal(host.spawns.length, 2, '恰好两次 spawnAgent 调用（首调 + resume）')
      const [first, second] = host.spawns

      // 首调：不得注入 cwd（cwd 由后端 request>Profile>parent>Hub 链决定）；
      // 外部执行环境元数据经 onResolved 回传。
      assert.equal(first!.seq, 0)
      assert.ok(!(('cwd' in first!.request)), `首调不得注入 cwd（实得 ${JSON.stringify(first!.request.cwd)}）`)
      assert.equal(first!.request.workflowRunId, started.id, '首调携带 workflowRunId')
      assert.equal(first!.request.resume, undefined, '首调不是 resume')

      // resume：schema/gate 原样下传；agentType/cwd/model/isolation 缺省不传
      // （不偷偷重配旧上下文）；resume ref 指向本 run 首调记录。
      assert.equal(second!.seq, 1)
      assert.ok(!('cwd' in second!.request), `resume 不得携带 cwd（实得 ${JSON.stringify(second!.request.cwd)}）`)
      assert.ok(!('agentType' in second!.request), `resume 不得携带 agentType（实得 ${JSON.stringify(second!.request.agentType)}）`)
      assert.ok(!('isolation' in second!.request), `resume 不得携带 isolation（实得 ${JSON.stringify(second!.request.isolation)}）`)
      assert.ok(!('model' in second!.request), `resume 不得携带 model（实得 ${JSON.stringify(second!.request.model)}）`)
      assert.deepEqual(
        second!.request.schema,
        { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false },
        'schema 必须原样下传 resume 调用',
      )
      assert.equal(second!.request.gate, 'pnpm test', 'gate 必须原样下传 resume 调用')
      assert.equal(typeof second!.request.resume, 'string', 'resume ref 必须下传')
      assert.match(String(second!.request.resume), /^wf_[0-9a-f]+:wf-agent-0$/, 'resume ref 为 runId 命名空间的稳定 agentId')

      // 外部 gate 已回报：引擎不得落本机 fallback（sentinel 计数为 0）。
      assert.equal(host.gateFallbackRuns, 0, 'onGateResult 已回报时不得执行本机 runGate fallback')
      // resume 继承首调 label（同 'a'），用 prompt 定位续接节点。
      const resumeNode = summary.nodes?.find((n) => n.kind === 'agent' && n.prompt === '续接并验收')
      assert.ok(resumeNode, '应存在 resume agent 节点')
      assert.ok(resumeNode!.gate?.ok === true, `resume 节点应记录外部 gate 回报：${JSON.stringify(resumeNode!.gate)}`)
    } finally {
      await service.close()
    }
  })

  it('外部 resume 不回报 gate：显式 gate_result_missing 失败，绝不本机补跑', timeout, async () => {
    const host = makeExternalHost({ resumeReportsGate: false })
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const script =
        META('adapter-gate-missing') +
        'const a = await agent("第一阶段", { label: "a" })\n' +
        'const b = await agent("续接不回报", { resume: "a", gate: "pnpm test" })\n' +
        'return [a, b]'
      const started = await service.run({ script, conversationId: 1 })
      const result = (await service.wait(started.id)) as unknown[]
      const summary = service.getRun(started.id)

      // 引擎契约：agent 失败折叠为 null；节点必须显式 failed 且错误指向
      // gate_result_missing（外部执行环境未回报），本机 runGate 零调用。
      assert.deepEqual(result, ['first done', null], '失败 agent 折叠为 null（不伪造结果）')
      const resumeNode = summary.nodes?.find((n) => n.kind === 'agent' && n.prompt === '续接不回报')
      assert.ok(resumeNode, `应存在失败的 resume 节点：${JSON.stringify(summary.nodes)}`)
      assert.equal(resumeNode!.status, 'failed')
      assert.match(resumeNode!.error ?? '', /gate_result_missing/, `错误应指向 gate_result_missing：${resumeNode!.error}`)
      assert.match(resumeNode!.error ?? '', /pane-remote-1/, '错误诊断应携带 executionId')
      assert.equal(host.gateFallbackRuns, 0, '外部 gate 未回报时绝不本机补跑（runGate 零调用）')
    } finally {
      await service.close()
    }
  })

  it('Profile 外部路由（herdr 形态）：invokeSpawn 不注入 cwd，保留 Profile.workspace 路由空间', timeout, async () => {
    // herdr 插件接管 agent_spawn 时读同一个 protocol.AgentSpawnRequest：
    // cwd 缺省才走 Profile.runtime.workspace > parent > Hub 链。此处断言
    // invokeSpawn 出参面不携带 cwd（herdr resolveCwd 的 request.cwd 优先级
    // 最高，注入即破坏 Profile 路由）。真链由 builtin:herdr 侧覆盖。
    const host = makeExternalHost({ resumeReportsGate: false })
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const script = META('adapter-herdr-route') + 'return await agent("herdr 路由", { agentType: "herdr:agy", label: "h" })'
      const started = await service.run({ script, conversationId: 1 })
      await service.wait(started.id)
      assert.equal(host.spawns.length, 1)
      const request = host.spawns[0]!.request
      assert.equal(request.agentType, 'herdr:agy', 'agentType 原样下传（herdr 拦截入口）')
      assert.ok(!('cwd' in request), `外部路由 spawn 不得注入 cwd（实得 ${JSON.stringify(request.cwd)}）`)
    } finally {
      await service.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Part B：真 KernelRuntime 链路——cwd 继承与 resume 不被父 cwd 覆盖
// ---------------------------------------------------------------------------

interface RealEnv {
  kernel: KernelRuntime
  faux: ReturnType<typeof fauxProvider>
  dataDir: string
  /** kernel.runGate（本机 fallback）调用计数。 */
  gateFallbackRuns: number
  close(): Promise<void>
}

/** 真 KernelRuntime + faux；runGate 包装计数（fallback sentinel）。 */
async function openRealEnv(dataDir: string): Promise<RealEnv> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models,
    autoResume: false,
    watchdogIntervalMs: 0,
  })
  const originalRunGate = kernel.runGate.bind(kernel)
  let gateFallbackRuns = 0
  ;(kernel as unknown as { runGate: typeof kernel.runGate }).runGate = (command, options) => {
    gateFallbackRuns++
    return originalRunGate(command, options)
  }
  return {
    kernel,
    faux,
    dataDir,
    get gateFallbackRuns() {
      return gateFallbackRuns
    },
    async close() {
      await kernel.close()
    },
  }
}

/** 子会话内真实 bash pwd 取证（SDK 实际 cwd 的事实来源）。 */
function pwdToolCall() {
  return fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd' })], { stopReason: 'toolUse' })
}

describe('真 KernelRuntime：cwd 继承与 resume 目录保真', () => {
  let rootDir: string
  before(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'wf-adapter-real-'))
  })
  after(() => rmSync(rootDir, { recursive: true, force: true }))

  it('父会话非 Hub cwd 由新 child 继承（request>Profile>parent>Hub 链）', timeout, async () => {
    const dir = join(rootDir, 'inherit')
    const parentDir = join(dir, 'parent-work')
    mkdirSync(parentDir, { recursive: true })
    const env = await openRealEnv(dir)
    try {
      // 父会话 cwd 显式非 Hub（dataDir）；首调不带 cwd 的 workflow agent
      // 必须经 parent 回退继承 parentDir（而不是 Hub dataDir）。
      const parent = await env.kernel.createConversation({ title: '工作会话', cwd: parentDir })
      const service = new WorkflowService({
        dataDir: dir,
        state: env.kernel.documentStore,
        host: {
          spawnAgent: (request) => env.kernel.spawnAgent(request),
          invokeAction: async (_p, actionId) => {
            throw new Error(`no actions: ${actionId}`)
          },
          listActions: () => [],
          getConversation: (id) => env.kernel.getConversation(id),
          abortConversation: (id) => env.kernel.abortConversation(id),
          emitEvent: () => {},
        },
      })
      await service.init()

      env.faux.setResponses([pwdToolCall(), fauxAssistantMessage('首段完成')])
      const script = META('real-inherit') + 'return await agent("首段", { label: "a" })'
      const started = await service.run({ script, conversationId: parent.id })
      const result = await service.wait(started.id)
      const summary = service.getRun(started.id)
      assert.equal(summary.status, 'completed', `run 应完成：${summary.error ?? ''}`)
      assert.equal(result, '首段完成')

      const node = summary.nodes?.find((n) => n.kind === 'agent')
      assert.ok(node, '应有 agent 节点')
      assert.equal(node!.effectiveCwd, parentDir, `onResolved effectiveCwd 应继承父会话：${node!.effectiveCwd}`)
      assert.ok(node!.conversationId !== undefined, '原生路径回传 conversationId')

      // SDK 实际 cwd 取证：子会话内 bash pwd 输出 parentDir。
      const childId = node!.conversationId!
      const detail = await env.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, '子会话应有 bash 工具结果（pwd 取证）')
      const bashText = JSON.stringify(bashEntry.model ?? '')
      assert.ok(bashText.includes(parentDir), `bash pwd 应输出父会话 cwd：${bashText.slice(0, 300)}`)
      await service.close()
    } finally {
      await env.close()
    }
  })

  it('子会话经真实 action 改 cwd 后 resume：bash pwd 与 Gate 均在子 cwd，不被父 cwd 覆盖', timeout, async () => {
    const dir = join(rootDir, 'resume-cwd')
    const parentDir = join(dir, 'parent-work')
    const childDir = join(dir, 'child-work')
    mkdirSync(parentDir, { recursive: true })
    mkdirSync(childDir, { recursive: true })
    const env = await openRealEnv(dir)
    try {
      const parent = await env.kernel.createConversation({ title: '续接会话', cwd: parentDir })

      // 真实 ctx.action：两节点之间把空闲子会话 SDK 目录真实 configure 到
      // childDir（复用宿主 updateConversation：真实 SDK configure + 镜像持久化）。
      let capturedChildId = 0
      await env.kernel.plugins.register({
        id: 'test:move',
        name: '目录迁移',
        definePlugin(ctx) {
          ctx.action<Record<string, never>, { movedTo: string }>({
            id: 'move',
            description: '把子会话工作目录迁移到 childDir',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            outputSchema: {
              type: 'object',
              properties: { movedTo: { type: 'string' } },
              required: ['movedTo'],
              additionalProperties: false,
            },
            handler: async () => {
              if (capturedChildId === 0) throw new Error('子会话尚未捕获（onResolved 未回报）')
              await env.kernel.updateConversation(capturedChildId, { cwd: childDir })
              return { movedTo: childDir }
            },
          })
        },
      })

      const service = new WorkflowService({
        dataDir: dir,
        state: env.kernel.documentStore,
        host: {
          // 包装端口：捕获 onResolved 回报的 conversationId 供 action 迁移。
          spawnAgent: (request) =>
            env.kernel.spawnAgent({
              ...request,
              onResolved: (info) => {
                if (info.conversationId !== undefined) capturedChildId = info.conversationId
                request.onResolved?.(info)
              },
            }),
          invokeAction: async (pluginId, actionId, input, context) => {
            const result = await env.kernel.plugins.invokeAction(pluginId, actionId, input, context)
            return result
          },
          listActions: () => env.kernel.plugins.listActions(),
          getConversation: (id) => env.kernel.getConversation(id),
          abortConversation: (id) => env.kernel.abortConversation(id),
          emitEvent: (type, payload) => env.kernel.events.publish(type, payload),
          // 与生产 app.ts 同接线：gate 本机 fallback（native 路径已在子会话内
          // 执行，sentinel 断言此口零调用）。
          runGate: (command, context) => env.kernel.runGate(command, context),
        },
      })
      await service.init()

      // gate sentinel：子 cwd 内真实执行恰好一次（追加计数文件）。
      const gateCountFile = join(childDir, 'gate-runs')
      writeFileSync(gateCountFile, '', { flag: 'w' })
      const gateCmd = `printf x >> "${gateCountFile}" && [ "$(pwd)" = "${childDir}" ]`

      const schema = {
        type: 'object',
        properties: { answer: { type: 'number' } },
        required: ['answer'],
        additionalProperties: false,
      }

      const script =
        META('real-resume-cwd') +
        'const a = await agent("第一阶段", { label: "a" })\n' +
        'await action("test:move.move", {})\n' +
        `const b = await agent("续接（bash pwd 取证）", { resume: "a", schema: ${JSON.stringify(schema)}, gate: ${JSON.stringify(gateCmd)} })\n` +
        'return [a, b]'

      // faux 序列（首调 1 文本；resume：bash pwd 工具调用 → 结构化工具提交 → 收尾文本）。
      env.faux.setResponses([
        fauxAssistantMessage('首段完成'),
        pwdToolCall(),
        fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { answer: 7 } })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('续接完成'),
      ])

      const started = await service.run({ script, conversationId: parent.id })
      const result = (await service.wait(started.id)) as unknown[]
      const summary = service.getRun(started.id)
      assert.equal(summary.status, 'completed', `run 应完成：${summary.error ?? JSON.stringify(summary.nodes)}`)
      assert.deepEqual(result, ['首段完成', { answer: 7 }], 'resume 结构化结果应经 Schema 复检回传')

      // 子会话镜像 cwd 仍是 childDir（不被父 parentDir 覆盖）。
      assert.ok(capturedChildId > 0, '应捕获子会话 id')
      assert.equal(env.kernel.getConversation(capturedChildId).cwd, childDir, '子会话镜像 cwd 保持 childDir')

      // SDK 实际 cwd 取证：resume 回合 bash pwd 输出 childDir。
      const detail = await env.kernel.getConversationDetail(capturedChildId, { limit: 80 })
      const bashEntries = [...detail.entries]
        .filter((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntries.length >= 1, '子会话应有 bash 工具结果（pwd 取证）')
      const lastBash = JSON.stringify(bashEntries[bashEntries.length - 1]!.model ?? '')
      assert.ok(lastBash.includes(childDir), `resume 后 bash pwd 应输出子会话 cwd：${lastBash.slice(0, 300)}`)

      // Gate 在子 cwd 真实 shell 恰好执行一次；本机 fallback 零调用。
      assert.equal(readFileSync(gateCountFile, 'utf8'), 'x', 'gate 恰好执行一次且在子 cwd（pwd 校验含在内）')
      assert.equal(env.gateFallbackRuns, 0, 'native 路径 gate 已在子会话内执行，不得落本机 runGate fallback')

      // 节点元数据如实：resume 节点记录 gate 回报（用 prompt 定位，resume 继承首调 label）。
      const nodes = summary.nodes?.filter((n) => n.kind === 'agent') ?? []
      assert.equal(nodes.length, 2)
      const resumeNode = nodes.find((n) => n.prompt === '续接（bash pwd 取证）')
      assert.ok(resumeNode, '应存在 resume 节点')
      assert.ok(resumeNode!.gate?.ok === true, `resume 节点应记录 gate 回报：${JSON.stringify(resumeNode!.gate)}`)
      await service.close()
    } finally {
      await env.close()
    }
  })
})
