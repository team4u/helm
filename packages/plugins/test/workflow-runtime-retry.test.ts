/**
 * workflow-runtime-retry.test.ts — runtime 失败句柄登记、scopeId 命名空间与
 * gate 结果扩展（exitCode/timedOut）回归。
 *
 * 覆盖《20261115-多级工作流与失败自动重试设计文档》§2.3 / §4.1 的 runtime 侧：
 * ① 失败调用只要拿到 conversationId/executionId（onResolved 回报或失败分支
 *   executionInfo 回传）即登记 resume 句柄——同 run 内后续
 *   agent({ resume: label }) 经 host.resumeAgent 续接同一子会话，不再 fatal；
 * ② 失败且无任何执行环境元数据时不登记（旧语义：失败不等于可续接）；
 * ③ 手动 control.retry 复用同一 attempt 环重跑（maxAttempts 自动触发依赖
 *   worker 侧载荷接线，由后续套件覆盖；此处锁定环本身不回归）；
 * ④ WorkflowGateResult.exitCode/timedOut 透传：宿主回报与 runGate fallback
 *   两条路径的失败文案都携带结构化原因。
 *
 * 全部用真实 runWorkflow（真 worker_threads）+ 可控 fake host。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { WorkflowAgentEntry } from '../src/workflow/engine/progress.js'
import {
  agentRetryPrompt,
  MAX_AGENT_ATTEMPTS,
  runWorkflow,
  scopedResumeKey,
  type WorkflowControl,
  type WorkflowHost,
} from '../src/workflow/engine/runtime.js'

const timeout = { timeout: 60_000 } as const

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

function baseHost(overrides: Partial<WorkflowHost> = {}): WorkflowHost {
  return {
    async spawnAgent() {
      return { ok: true, text: 'ok' }
    },
    abortAgent() {},
    async invokeAction(actionId) {
      return { pluginId: 'p', actionId, result: null }
    },
    loadWorkflow() {
      return { ok: false, message: 'no nested workflows in retry host' }
    },
    ...overrides,
  }
}

function agentEntriesOf(progress: readonly { type: string }[]): WorkflowAgentEntry[] {
  return progress.filter((e) => e.type === 'workflow_agent') as WorkflowAgentEntry[]
}

// ---------------------------------------------------------------------------
// ① 失败句柄登记：拿到执行环境即可 resume
// ---------------------------------------------------------------------------

describe('workflow runtime failure handle registration', () => {
  it('registers a resume handle when a failed attempt observed conversationId/executionId via onResolved', timeout, async () => {
    const calls: string[] = []
    const host = baseHost({
      async spawnAgent(request) {
        calls.push(`spawn:${request.agentId}:${request.prompt}`)
        request.onResolved?.({ conversationId: 42, executionId: 'exec-9' })
        return { ok: false, error: '[agent_timeout] turn timed out' }
      },
    })
    host.resumeAgent = async (agentId, prompt) => {
      calls.push(`resume:${agentId}:${prompt}`)
      return { ok: true, text: `fixed:${prompt}` }
    }
    const result = await runWorkflow({
      script:
        META('failure-handle') +
        'const first = await agent("build it", { label: "unit" })\n' +
        'const second = await agent("fix the failure", { resume: "unit" })\n' +
        'return [first, second]',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.value, [null, 'fixed:fix the failure'])
    // 续接的是同一 agentId（同一子会话），不是重新 spawn。
    assert.deepEqual(calls, ['spawn:wf-agent-0:build it', 'resume:wf-agent-0:fix the failure'])
    const errorEntry = agentEntriesOf(result.progress).find((e) => e.state === 'error')
    assert.ok(errorEntry, 'failed attempt still records an error progress entry')
    assert.equal(errorEntry.conversationId, 42)
    assert.equal(errorEntry.executionId, 'exec-9')
  })

  it('registers a resume handle from executionInfo returned on the failure branch', timeout, async () => {
    // §2.3.1：service 失败分支把 executionInfo 放进失败结果回传（不丢弃
    // conversationId）。runtime 必须在失败分支吸收它并登记句柄。
    const host = baseHost({
      async spawnAgent() {
        return {
          ok: false,
          error: 'schema validation failed',
          executionInfo: { conversationId: 99 },
        }
      },
    })
    host.resumeAgent = async () => ({ ok: true, text: 'recovered' })
    const result = await runWorkflow({
      script:
        META('failure-exec-info') +
        'await agent("make json", { label: "j" })\n' +
        'return await agent("repair it", { resume: "j" })',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, 'recovered')
  })

  it('does not register a handle when the failure carries no execution metadata (old semantics)', timeout, async () => {
    const host = baseHost({
      async spawnAgent() {
        return { ok: false, error: 'boom' }
      },
    })
    // 提供 resumeAgent 能力，确保 fatal 来自“label 未登记”而非宿主能力缺失。
    host.resumeAgent = async () => ({ ok: true, text: 'never' })
    const result = await runWorkflow({
      script:
        META('failure-no-handle') +
        'await agent("x", { label: "solo" })\n' +
        'await agent("y", { resume: "solo" })',
      host,
    })
    assert.equal(result.status, 'failed')
    assert.ok(
      result.error!.includes('no agent has completed under the label "solo"'),
      `unexpected error: ${result.error}`,
    )
  })
})

// ---------------------------------------------------------------------------
// ③ 自动重试尝试级账本与跨重启恢复
// ---------------------------------------------------------------------------

describe('workflow runtime attempt journal replay', () => {
  it('journals each attempt and resumes from a persisted conversation handle', timeout, async () => {
    const writes: Array<Record<string, unknown>> = []
    const calls: string[] = []
    const host = baseHost({
      async spawnAgent(request) {
        calls.push(`spawn:${request.index}`)
        request.onResolved?.({ conversationId: 77 })
        return { ok: false, error: 'gate failed' }
      },
      async resumeAgent(agentId, prompt, options) {
        calls.push(`resume:${agentId}:${options?.resumeRef ?? 'mapped'}:${prompt.includes('[attempt 1 failed]')}`)
        return { ok: true, text: 'fixed' }
      },
    })
    const first = await runWorkflow({
      script: META('attempt-journal') + 'return await agent.withMeta("job", { label: "worker", maxAttempts: 2 })',
      host,
      journal: { append(entry) { writes.push({ ...entry }) } },
    })
    assert.equal(first.status, 'completed', first.error)
    assert.deepEqual(first.value, { ok: true, output: 'fixed', attempts: 2, execution: { conversationId: 77 } })
    assert.deepEqual(calls, ['spawn:0', 'resume:wf-agent-0:77:true'])
    assert.equal(writes.length, 2)
    assert.equal(writes[0]!.type, 'agent')
    assert.equal(writes[0]!.ok, false)
    assert.equal(writes[0]!.attempt, 1)
    assert.equal(writes[0]!.index, 0)
    assert.equal(writes[1]!.ok, true)
    assert.equal(writes[1]!.attempt, 2)
    assert.equal(writes[1]!.index, 1)

    const replayCalls: string[] = []
    const replayWrites: Array<Record<string, unknown>> = []
    const replayHost = baseHost({
      async spawnAgent() {
        replayCalls.push('spawn')
        throw new Error('replay must not spawn')
      },
      async resumeAgent(agentId, _prompt, options) {
        replayCalls.push(`resume:${agentId}:${options?.resumeRef ?? 'missing'}`)
        throw new Error('completed attempt must be reused')
      },
    })
    const resumed = await runWorkflow({
      script: META('attempt-journal') + 'return await agent.withMeta("job", { label: "worker", maxAttempts: 2 })',
      host: replayHost,
      journal: {
        entries: writes as never,
        append(entry) { replayWrites.push({ ...entry }) },
      },
    })
    assert.equal(resumed.status, 'completed')
    assert.deepEqual(resumed.value, { ok: true, output: 'fixed', attempts: 2, execution: { conversationId: 77 } }, JSON.stringify({ writes, replayCalls, replayWrites, progress: resumed.progress, error: resumed.error }))
    assert.deepEqual(replayCalls, [])
    assert.deepEqual(replayWrites.map((entry) => [entry.index, entry.attempt, entry.ok]), [[0, 1, false], [1, 2, true]])
  })
})

// ---------------------------------------------------------------------------
// ④ 手动 retry 环（maxAttempts 自动重试共用该环）
// ---------------------------------------------------------------------------

describe('workflow runtime manual retry ring', () => {
  it('control.retry aborts the in-flight call and re-runs it with attempt counter', timeout, async () => {
    let spawns = 0
    let releaseFirst: ((r: { ok: boolean; text?: string; error?: string }) => void) | undefined
    const host = baseHost({
      async spawnAgent(request) {
        spawns++
        request.onResolved?.({ conversationId: 7 })
        if (spawns === 1) {
          return new Promise((resolve) => {
            releaseFirst = resolve
          })
        }
        return { ok: true, text: 'second-run' }
      },
    })
    host.abortAgent = (agentId) => {
      releaseFirst?.({ ok: false, error: `aborted:${agentId}` })
      releaseFirst = undefined
    }
    let control: WorkflowControl | undefined
    const result = await runWorkflow({
      script: META('manual-retry') + 'const v = await agent("job", { label: "m" })\nreturn v',
      host,
      onControl(c) {
        control = c
      },
      onProgress(entries) {
        // 首条带 startedAt 的进度行发出后，spawn 已在途；微任务时机上
        // live.started 必已置位，retry(0) 确定命中。
        for (const entry of entries) {
          if (entry.type !== 'workflow_agent' || control === undefined) continue
          const agent = entry as WorkflowAgentEntry
          if (agent.startedAt !== undefined) {
            const c = control
            control = undefined
            void queueMicrotask(() => {
              if (!c.retry(0)) throw new Error('retry(0) must hit the live agent')
            })
          }
        }
      },
    })
    assert.equal(spawns, 2)
    assert.equal(result.status, 'completed')
    assert.equal(result.value, 'second-run')
    const done = agentEntriesOf(result.progress).find((e) => e.state === 'done')
    assert.ok(done, 'retry ring settles with a done entry')
    assert.equal(done.attempt, 2)
  })
})

// ---------------------------------------------------------------------------
// ④ gate 结果扩展：exitCode / timedOut
// ---------------------------------------------------------------------------

describe('workflow gate result exitCode/timedOut', () => {
  it('host-reported gate failure mentions the exit code and is not re-run', timeout, async () => {
    const host = baseHost({
      async spawnAgent() {
        return { ok: true, text: 't', gate: { ok: false, output: '', exitCode: 2, timedOut: false } }
      },
    })
    let gateRuns = 0
    host.runGate = async () => {
      gateRuns++
      return { ok: true, output: '' }
    }
    const result = await runWorkflow({
      script: META('gate-exit') + 'const v = await agent("g", { gate: "exit 2" })\nreturn v',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, null)
    assert.equal(gateRuns, 0, 'host-reported gate must not be re-run by the fallback')
    const errorEntry = agentEntriesOf(result.progress).find((e) => e.state === 'error')
    assert.ok(errorEntry)
    assert.ok(
      errorEntry.error!.includes('exit code 2'),
      `error mentions exit code: ${errorEntry.error}`,
    )
    // progress 面的 gate 形状收敛在 progress.ts（另属主）；此处按结构断言透传。
    const gate = errorEntry.gate as { ok: boolean; output: string; exitCode?: number | null; timedOut?: boolean } | undefined
    assert.ok(gate)
    assert.equal(gate.exitCode, 2)
    assert.equal(gate.timedOut, false)
  })

  it('runGate fallback timeout failure reports a timeout reason', timeout, async () => {
    const host = baseHost()
    host.runGate = async () => ({ ok: false, output: '', exitCode: null, timedOut: true })
    const result = await runWorkflow({
      script: META('gate-timeout') + 'const v = await agent("g2", { gate: "sleep 999" })\nreturn v',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, null)
    const errorEntry = agentEntriesOf(result.progress).find((e) => e.state === 'error')
    assert.ok(errorEntry)
    assert.ok(
      errorEntry.error!.includes('timed out'),
      `error mentions timeout: ${errorEntry.error}`,
    )
  })
})

// ---------------------------------------------------------------------------
// 纯函数：scope 命名空间键与重试 prompt
// ---------------------------------------------------------------------------

describe('scoped resume keys and retry prompt helpers', () => {
  it('namespaces labels by scope with root defaulting to 0 (old semantics)', timeout, () => {
    assert.equal(scopedResumeKey(undefined, 'a'), '0:a')
    assert.equal(scopedResumeKey(0, 'a'), '0:a')
    assert.equal(scopedResumeKey(2, 'a'), '2:a')
    assert.notEqual(scopedResumeKey(1, 'a'), scopedResumeKey(2, 'a'))
  })

  it('appends an incremental failure block to the original prompt', timeout, () => {
    const prompt = agentRetryPrompt('do the task', 1, 'gate failed')
    assert.ok(prompt.startsWith('do the task\n\n[attempt 1 failed]\ngate failed\n'))
    assert.ok(prompt.endsWith('Fix the problem above and complete the original task.'))
    assert.equal(MAX_AGENT_ATTEMPTS, 10)
  })
})
