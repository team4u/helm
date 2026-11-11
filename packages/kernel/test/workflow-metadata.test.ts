/**
 * 工作流元数据与外部执行对齐测试（tsx --test；确定性 fake host，不控制真实 Herdr）。
 *
 * 覆盖：
 * - fake handled 外部 spawn：gate/worktree 经 spawn 请求透传、onResolved 元数据
 *   （conversationId/executionId/effectiveCwd/worktree）进入节点、onGateResult
 *   恰好一次、引擎免二次执行（runGate fallback 不触发）；
 * - 外部 executionId 存在而 gate 回报缺失 → 显式 gate_result_missing，绝不本机补跑；
 * - onResolved/onGateResult 边界校验（非法形状显式失败）；
 * - native 路径 onResolved 幂等（多次回调只记最新，runId 命名空间保持）；
 * - WorkflowService.listRuns：活跃 run 实时 nodes、终态含非保存脚本 run、
 *   跨重启（新 service 实例 + 同 state store）可列出；
 * - getRun/toSummary 透传 replayedFrom；resume 元数据链路；
 * - onRunSettled：每 run 恰一次、wait/close 等待其结束、异常显式进入诊断；
 * - 节点元数据（label/prompt/schema/gate/tokens/durationMs/worktree）完整入
 *   nodes，不混入用户返回值；progress 折叠保留元数据；
 * - 元数据脱敏：prompt/effectiveCwd/worktree/gate.output 逐值 redact 落 record。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentExecutionInfo,
  AgentSpawnRequest,
  WorkflowRunSummary,
} from '@helm/protocol'
import { runWorkflow, type WorkflowHost } from '../src/builtin-plugins/workflow/engine/runtime.js'
import {
  WorkflowService,
  type WorkflowServiceHost,
  type WorkflowStateStore,
} from '../src/builtin-plugins/workflow/engine/service.js'

const timeout = { timeout: 60_000 } as const

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

// ---------------------------------------------------------------------------
// 辅助：state store / service host
// ---------------------------------------------------------------------------

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

function conversationSummary(id: number, cwd = '/tmp') {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'default',
    tags: [] as string[],
    cwd,
    model: 'x/y',
    thinkingLevel: '',
    status: 'idle' as const,
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

interface ExternalSpawnHostOptions {
  /** spawn 内执行 gate 并回报（外部执行环境行为）。 */
  externalGate?: { ok: boolean; output: string }
  /** 抑制 gate 回报（触发 gate_result_missing）。 */
  suppressGateReport?: boolean
  /** 回传的执行元数据。 */
  executionInfo?: AgentExecutionInfo
  /** spawn 结果文本。 */
  resultText?: string
  /** 幂等测试：onResolved 回调次数。 */
  resolvedCalls?: number
}

interface ExternalSpawnHostExtras {
  spawns: AgentSpawnRequest[]
  gateReports: number
  runGateCalls: number
}

/**
 * fake handled 外部 spawn 宿主：记录 spawn 请求全文、模拟外部执行环境
 * （gate 在"外部"执行并经 onGateResult 回报、onResolved 回传元数据）。
 * 引擎 runGate 若被调用说明出现二次执行（记数暴露）。
 */
function makeExternalSpawnHost(
  options: ExternalSpawnHostOptions = {},
): WorkflowServiceHost & ExternalSpawnHostExtras {
  const spawns: AgentSpawnRequest[] = []
  const extras: ExternalSpawnHostExtras = { spawns, gateReports: 0, runGateCalls: 0 }
  return {
    spawns,
    get gateReports() {
      return extras.gateReports
    },
    get runGateCalls() {
      return extras.runGateCalls
    },
    async spawnAgent(request) {
      spawns.push(request)
      if (request.onResolved !== undefined) {
        const calls = options.resolvedCalls ?? 1
        for (let i = 0; i < calls; i++) {
          request.onResolved(
            options.executionInfo ?? { conversationId: 77, effectiveCwd: '/tmp' },
          )
        }
      }
      if (request.gate !== undefined && !options.suppressGateReport && request.onGateResult !== undefined) {
        extras.gateReports++
        request.onGateResult(options.externalGate ?? { ok: true, output: 'gate-ok' })
      }
      return options.resultText ?? 'external-result'
    },
    async invokeAction() {
      throw new Error('no actions in external host')
    },
    listActions() {
      return []
    },
    getConversation: (id: number) => conversationSummary(id),
    async abortConversation() {},
    emitEvent() {},
    async runGate() {
      extras.runGateCalls++
      return { ok: true, output: 'local-fallback' }
    },
  }
}

// ---------------------------------------------------------------------------
// 引擎层：fake handled 外部 spawn
// ---------------------------------------------------------------------------

describe('engine external spawn metadata', () => {
  it('passes gate through spawn request; engine skips second execution when gate reported', timeout, async () => {
    let engineGateRuns = 0
    const host: WorkflowHost = {
      async spawnAgent(request) {
        assert.ok(request.gate !== undefined, 'gate must ride the spawn request')
        assert.ok(request.onGateResult !== undefined, 'onGateResult callback must be provided')
        request.onResolved?.({ conversationId: 42, effectiveCwd: '/srv/ext' })
        request.onGateResult?.({ ok: true, output: 'verified' })
        return { ok: true, text: 'done' }
      },
      abortAgent() {},
      async runGate() {
        engineGateRuns++
        return { ok: true, output: '' }
      },
      async invokeAction() {
        throw new Error('unused')
      },
    }
    const result = await runWorkflow({
      script: META('ext-gate') + 'const v = await agent("work", { gate: "true" })\nreturn v',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, 'done')
    assert.equal(engineGateRuns, 0, 'engine must not re-run the gate')
    // 折叠后取最新一条（append-only：同 index 后发替换先发）。
    const agentEntries = result.progress.filter((e) => e.type === 'workflow_agent')
    const agent = agentEntries[agentEntries.length - 1]
    assert.ok(agent !== undefined)
    if (agent.type === 'workflow_agent') {
      assert.equal(agent.gate?.ok, true)
      assert.equal(agent.gate?.output, 'verified')
    }
  })

  it('failed external gate fails the agent with gate output as error', timeout, async () => {
    const host: WorkflowHost = {
      async spawnAgent(request) {
        request.onResolved?.({ conversationId: 42 })
        request.onGateResult?.({ ok: false, output: 'tests failed: 2 broken' })
        return { ok: true, text: 'work done' }
      },
      abortAgent() {},
      async runGate() {
        throw new Error('must not be called')
      },
      async invokeAction() {
        throw new Error('unused')
      },
    }
    const result = await runWorkflow({
      script: META('ext-gate-fail') + 'const v = await agent("work", { gate: "npm test" })\nreturn v',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, null, 'agent failure collapses to null')
    const errorEntries = result.progress.filter(
      (e) => e.type === 'workflow_agent' && e.state === 'error',
    )
    const errorEntry = errorEntries[errorEntries.length - 1]
    assert.ok(errorEntry !== undefined)
    assert.ok(
      errorEntry.type === 'workflow_agent' && (errorEntry.error ?? '').includes('tests failed'),
      'gate output surfaces as agent error',
    )
  })

  it('metadata (executionId/worktree/prompt/schema) lands in progress entries, not the return value', timeout, async () => {
    const host: WorkflowHost = {
      async spawnAgent(request) {
        request.onResolved?.({
          executionId: 'herdr-tab-9',
          effectiveCwd: '/srv/worktree-a',
          worktree: { path: '/srv/worktree-a', branch: 'wf/topic' },
        })
        return { ok: true, text: JSON.stringify({ answer: 1 }) }
      },
      abortAgent() {},
      async invokeAction() {
        throw new Error('unused')
      },
    }
    const result = await runWorkflow({
      script:
        META('ext-meta') +
        'const v = await agent("extract", { schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } })\nreturn v',
      host,
    })
    assert.equal(result.status, 'completed')
    // 返回值是业务输出本身，绝不混入执行元数据。
    assert.deepEqual(result.value, { answer: 1 })
    const agentEntries = result.progress.filter((e) => e.type === 'workflow_agent')
    const agent = agentEntries[agentEntries.length - 1]
    assert.ok(agent !== undefined && agent.type === 'workflow_agent')
    assert.equal(agent.executionId, 'herdr-tab-9')
    assert.equal(agent.effectiveCwd, '/srv/worktree-a')
    assert.deepEqual(agent.worktree, { path: '/srv/worktree-a', branch: 'wf/topic' })
    assert.equal(agent.prompt, 'extract')
    assert.ok(agent.schema !== undefined && (agent.schema as { type?: string }).type === 'object')
  })
})

// ---------------------------------------------------------------------------
// service 层：外部 spawn / gate_result_missing / 校验 / 幂等
// ---------------------------------------------------------------------------

describe('WorkflowService external spawn integration', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-meta-'))

  it('external executionId without gate report fails explicitly (gate_result_missing)', timeout, async () => {
    const host = makeExternalSpawnHost({
      executionInfo: { executionId: 'herdr-tab-3', effectiveCwd: '/srv/remote' },
      suppressGateReport: true,
    })
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const summary = await service.run({
      conversationId: 1,
      script: META('ext-missing-gate') + 'const v = await agent("work", { gate: "make check" })\nreturn v',
    })
    await service.wait(summary.id)
    const final = service.getRun(summary.id)
    assert.equal(final.status, 'completed', 'agent 失败折叠 null，run 完成')
    const node = (final.nodes ?? []).find((n) => n.kind === 'agent')
    assert.ok(node !== undefined)
    assert.equal(node.status, 'failed')
    assert.ok((node.error ?? '').includes('gate_result_missing'), `error: ${node.error}`)
    assert.ok((node.error ?? '').includes('herdr-tab-3'), 'diagnostic names the executionId')
    assert.equal(host.runGateCalls, 0, 'must not run gate locally against a guessed cwd')
    await service.close()
  })

  it('invalid onResolved payload (relative cwd) fails the spawn explicitly', timeout, async () => {
    const host = makeServiceHostWithSpawn((request) => {
      request.onResolved?.({ conversationId: 5, effectiveCwd: 'relative/path' })
      return 'text'
    })
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const summary = await service.run({ conversationId: 1, script: META('bad-resolved') + 'return await agent("x")' })
    await service.wait(summary.id)
    const node = (service.getRun(summary.id).nodes ?? []).find((n) => n.kind === 'agent')
    assert.ok(node !== undefined)
    assert.equal(node.status, 'failed')
    assert.ok((node.error ?? '').includes('execution_info_invalid'), `error: ${node.error}`)
    await service.close()
  })

  it('invalid onGateResult payload (missing output) fails the spawn explicitly', timeout, async () => {
    const host = makeServiceHostWithSpawn((request) => {
      request.onResolved?.({ conversationId: 5 })
      request.onGateResult?.({ ok: true } as { ok: boolean; output: string })
      return 'text'
    })
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const summary = await service.run({
      conversationId: 1,
      script: META('bad-gate') + 'return await agent("x", { gate: "true" })',
    })
    await service.wait(summary.id)
    const node = (service.getRun(summary.id).nodes ?? []).find((n) => n.kind === 'agent')
    assert.ok(node !== undefined)
    assert.equal(node.status, 'failed')
    assert.ok((node.error ?? '').includes('gate_result_invalid'), `error: ${node.error}`)
    await service.close()
  })

  it('onResolved is idempotent: repeated callbacks keep latest metadata, runId namespace preserved', timeout, async () => {
    const host = makeExternalSpawnHost({
      resolvedCalls: 3,
      executionInfo: { conversationId: 101, effectiveCwd: '/tmp/child' },
    })
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const summary = await service.run({ conversationId: 1, script: META('idem') + 'return await agent("x")' })
    await service.wait(summary.id)
    const node = (service.getRun(summary.id).nodes ?? []).find((n) => n.kind === 'agent')
    assert.ok(node !== undefined)
    assert.equal(node.conversationId, 101)
    // runId 命名空间：投给宿主的 agentId 带 run 前缀（防跨 run 串接）。
    const spawnedId = String(host.spawns[0]?.agentId)
    assert.ok(spawnedId.startsWith(`${summary.id}:`), `agentId namespaced: ${spawnedId}`)
    await service.close()
  })

  it('workflowRunId rides every spawn request', timeout, async () => {
    const host = makeExternalSpawnHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const summary = await service.run({ conversationId: 1, script: META('wfid') + 'return await agent("x")' })
    await service.wait(summary.id)
    assert.equal(host.spawns[0]?.workflowRunId, summary.id)
    await service.close()
  })

  function makeServiceHostWithSpawn(
    spawn: (request: AgentSpawnRequest) => unknown,
  ): WorkflowServiceHost {
    return {
      async spawnAgent(request) {
        return spawn(request)
      },
      async invokeAction() {
        throw new Error('unused')
      },
      listActions() {
        return []
      },
      getConversation: (id: number) => conversationSummary(id),
      async abortConversation() {},
      emitEvent() {},
      // 引擎 fallback 端口（外部回报正常时不触发；缺失时 spawn 里的 gate 无法兑付）
      async runGate() {
        return { ok: true, output: 'local' }
      },
    }
  }
})

// ---------------------------------------------------------------------------
// listRuns / replayedFrom / onRunSettled / resume 元数据 / snapshot nodes
// ---------------------------------------------------------------------------

describe('WorkflowService listRuns and settlement', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-list-'))

  it('listRuns returns every persisted run (active with live nodes, settled incl. unsaved scripts)', timeout, async () => {
    const state = makeStateStore()
    const host = makeExternalSpawnHost()
    const service = new WorkflowService({ dataDir, host, state })
    let release: (() => void) | undefined
    let onSpawnStarted: (() => void) | undefined
    const spawnStarted = new Promise<void>((r) => {
      onSpawnStarted = r
    })
    try {
      const first = await service.run({ conversationId: 1, script: META('l1') + 'return 1' })
      await service.wait(first.id)
      // 第二个 run 带 agent（活跃中挂起 spawn 以验证实时 nodes）。
      const realSpawn = host.spawnAgent.bind(host)
      host.spawnAgent = async (request) => {
        onSpawnStarted?.()
        await new Promise<void>((r) => {
          release = r
        })
        return realSpawn(request)
      }
      const second = await service.run({ conversationId: 1, script: META('l2') + 'return await agent("hang")' })
      // 确定性等待 spawn 启动并挂起，此时 live nodes 已注入活跃 run
      await spawnStarted
      let runs = service.listRuns()
      assert.equal(runs.length, 2, 'both runs listed')
      const active = runs.find((r) => r.id === second.id)
      assert.ok(active !== undefined)
      assert.equal(active.status, 'running')
      assert.ok((active.nodes ?? []).length > 0, 'active run carries live nodes')
      release?.()
      await service.wait(second.id)

      // 新实例同 state store（模拟跨重启）：全部 run 仍可列出。
      const revived = new WorkflowService({
        dataDir,
        host: makeExternalSpawnHost(),
        state,
      })
      try {
        runs = revived.listRuns()
        assert.equal(runs.length, 2, 'runs survive restart via state store')
        assert.ok(runs.every((r) => r.status !== 'running'), 'no fake running after revival')
      } finally {
        await revived.close()
      }
    } finally {
      release?.()
      await service.close()
    }
  })

  it('getRun/toSummary carry replayedFrom; resume replays without second gate execution', timeout, async () => {
    const state = makeStateStore()
    const host = makeExternalSpawnHost({ externalGate: { ok: true, output: 'checked' } })
    const service = new WorkflowService({ dataDir, host, state })
    const first = await service.run({
      conversationId: 1,
      script: META('r1') + 'const v = await agent("work", { gate: "true" })\nreturn v',
    })
    await service.wait(first.id)
    assert.equal(service.getRun(first.id).replayedFrom, undefined)

    const resumed = await service.run({ resumeFromRunId: first.id })
    await service.wait(resumed.id)
    assert.equal(service.getRun(resumed.id).replayedFrom, first.id, 'replayedFrom transparent')
    // 恰好一次：首 run 1 次 spawn + 1 次 gate 回报；resume 全重放 0 新增。
    assert.equal(host.spawns.length, 1)
    assert.equal(host.gateReports, 1)
    assert.equal(host.runGateCalls, 0)
    await service.close()
  })

  it('onRunSettled fires exactly once per run; wait/close await it; failures surface as diagnostics', timeout, async () => {
    const state = makeStateStore()
    const settled: string[] = []
    let failNext = false
    const host: WorkflowServiceHost = makeExternalSpawnHost()
    host.onRunSettled = async (summary) => {
      if (failNext) throw new Error('cleanup blew up')
      settled.push(summary.id)
    }
    const service = new WorkflowService({ dataDir, host, state })

    const ok = await service.run({ conversationId: 1, script: META('s1') + 'return 1' })
    await service.wait(ok.id)
    assert.deepEqual(settled, [ok.id], 'exactly once, and wait returned after it finished')

    failNext = true
    const bad = await service.run({ conversationId: 1, script: META('s2') + 'return 2' })
    await assert.rejects(() => service.wait(bad.id), /cleanup blew up/)
    const final = service.getRun(bad.id)
    assert.ok((final.error ?? '').includes('onRunSettled failed'), `error: ${final.error}`)
    assert.equal(final.status, 'completed', 'run itself completed; cleanup failure is a diagnostic')
    await service.close()
  })

  it('node metadata (label/gate/tokens/duration/worktree/prompt) is complete in nodes; secrets redacted', timeout, async () => {
    const SECRET = '{{SECRET_qq11ww}}'
    const state = makeStateStore()
    const host = makeExternalSpawnHost({
      executionInfo: {
        conversationId: 9,
        executionId: 'herdr-tab-1',
        effectiveCwd: `/tmp/wt-${SECRET}`,
        worktree: { path: `/tmp/wt-${SECRET}`, branch: 'wf/x' },
      },
      externalGate: { ok: true, output: `checked ${SECRET}` },
    })
    const service = new WorkflowService({
      dataDir,
      host,
      state,
      redact: (text) => text.replaceAll(SECRET, '{{REDACTED}}'),
    })
    const summary = await service.run({
      conversationId: 1,
      script: META('meta') + `return await agent("do ${SECRET}", { gate: "make check" })`,
    })
    const result = (await service.wait(summary.id)) as string
    // 用户返回值不受影响（运行时原始值）。
    assert.ok(String(result).includes('external-result') || result === 'external-result')
    const node = (service.getRun(summary.id).nodes ?? []).find((n) => n.kind === 'agent')
    assert.ok(node !== undefined)
    assert.equal(node.conversationId, 9)
    assert.equal(node.executionId, 'herdr-tab-1')
    assert.equal(node.gate?.ok, true)
    assert.ok(node.durationMs !== undefined && node.durationMs >= 0)
    assert.ok(node.startedAt !== undefined)
    assert.ok(node.settledAt !== undefined)
    assert.ok(node.label !== undefined && node.label.length > 0)
    // 脱敏：节点的元数据（label/worktree/gate/prompt）不含 secret。
    // （record.script 是 resume 必需的原始源码，给终态策略另行评审，不在本次范围。）
    const nodeJson = JSON.stringify(node)
    assert.ok(!nodeJson.includes(SECRET), `node metadata must be redacted: ${nodeJson}`)
    assert.ok(nodeJson.includes('{{REDACTED}}'))
    await service.close()
  })
})
