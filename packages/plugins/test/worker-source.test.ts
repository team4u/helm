/**
 * worker-source.ts 独立测试（多级工作流 DSL 扩展，设计 §2.2-2.3/§4.1）。
 *
 * 直接以 WORKER_SOURCE 启动真实 worker_threads + node:vm（与 runtime.ts 同一
 * 构造方式），用最小宿主协议（call/response/progress/complete/error）锁定：
 * - agent() 原有语义不变（文本透传 / schema 解析 / 失败 null）；
 * - AGENT_OPTIONS 新增 cwd / timeoutMs / gateTimeoutMs / maxAttempts 的校验与
 *   下发（resume×cwd 互斥；gateTimeoutMs 仅在设置 gate 时可用；范围先行拒绝）；
 * - agent.withMeta(prompt, opts) 与 goal(spec)（默认 maxAttempts=3；宿主必须回传
 *   { ok: boolean, ... } 元数据对象，回退文本/ null 显式报错不静默降级）；
 * - workflow() 嵌套上限 MAX_WORKFLOW_NESTING_DEPTH=4（保留 256 nested cap）；
 * - 每个 scope 递增 scopeId（根 0），agent payload 携带 scopeId。
 *
 * runtime/service 侧尚未合入：本文件只锁 worker ↔ host 消息面。待 runtime 侧
 * 配合项见各用例注释（withMeta 响应包装、scopeId 隔离 completedByLabel、
 * maxAttempts 重试循环、cwd/timeoutMs/gateTimeoutMs 下发 spawn）。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { Worker } from 'node:worker_threads'
import {
  MAX_WORKFLOW_NESTING_DEPTH,
  WORKER_SOURCE,
  type AgentWithMetaResult,
} from '../src/workflow/engine/worker-source.js'

const timeout = { timeout: 60_000 } as const

/* ---------------------------------------------------------------------------
 * 最小宿主协议 harness
 * ------------------------------------------------------------------------- */

interface AgentCallPayload {
  prompt: string
  label?: string
  model?: string
  agentType?: string
  isolation?: string
  gate?: string
  resume?: string
  effort?: string
  schema?: unknown
  attachments?: string[]
  maxSubagentDepth?: number
  cwd?: string
  timeoutMs?: number
  gateTimeoutMs?: number
  maxAttempts?: number
  scopeId?: number
  withMeta?: boolean
}

interface WorkerOutcome {
  status: 'complete' | 'error'
  value?: unknown
  error?: string
  agentCalls: AgentCallPayload[]
  workflowRefs: Array<{ name?: string; scriptPath?: string }>
}

interface HarnessOptions {
  args?: unknown
  nestedCap?: number
  onAgent?: (payload: AgentCallPayload) => unknown
  /** 按 name 提供嵌套 workflow() 的脚本源码。 */
  workflows?: Record<string, string>
}

function runWorkerSource(body: string, options: HarnessOptions = {}): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        body,
        metaJson: JSON.stringify({ name: 'harness', description: 'worker-source harness' }),
        argsJson: options.args === undefined ? undefined : JSON.stringify(options.args),
        itemCap: 4096,
        nestedCap: options.nestedCap ?? 256,
      },
    })
    const outcome: WorkerOutcome = { status: 'error', agentCalls: [], workflowRefs: [] }
    let settled = false
    const finish = (final: Partial<WorkerOutcome>): void => {
      if (settled) return
      settled = true
      Object.assign(outcome, final)
      void worker.terminate().then(
        () => resolve(outcome),
        () => resolve(outcome),
      )
    }
    worker.on('message', (message: any) => {
      if (message.type === 'progress') return
      if (message.type === 'complete') {
        finish({
          status: 'complete',
          value: message.resultJson === undefined ? undefined : JSON.parse(message.resultJson),
        })
        return
      }
      if (message.type === 'error') {
        finish({ status: 'error', error: String(message.message) })
        return
      }
      if (message.type !== 'call') return
      if (message.method === 'agent') {
        outcome.agentCalls.push(message.payload)
        const value = options.onAgent ? options.onAgent(message.payload) : `ok:${message.payload.prompt}`
        worker.postMessage({ type: 'response', callId: message.callId, ok: true, value })
        return
      }
      if (message.method === 'workflow') {
        outcome.workflowRefs.push(message.payload)
        const source = message.payload?.name !== undefined ? options.workflows?.[message.payload.name] : undefined
        if (source === undefined) {
          worker.postMessage({
            type: 'response',
            callId: message.callId,
            ok: false,
            error: `harness has no source for workflow '${message.payload?.name}'`,
          })
          return
        }
        worker.postMessage({
          type: 'response',
          callId: message.callId,
          ok: true,
          value: { name: message.payload.name, body: source },
        })
        return
      }
      worker.postMessage({
        type: 'response',
        callId: message.callId,
        ok: false,
        error: `harness cannot run method '${message.method}'`,
      })
    })
    worker.on('error', (error) => {
      if (!settled) {
        settled = true
        reject(error)
      }
    })
    worker.on('exit', (code) => {
      if (!settled) {
        settled = true
        reject(new Error(`worker exited unexpectedly (code ${code})`))
      }
    })
  })
}

const META_OK: AgentWithMetaResult<{ done: boolean }> = {
  ok: true,
  output: { done: true },
  attempts: 3,
  execution: {
    nodeId: 'local',
    conversationId: 42,
    effectiveCwd: '/repo/wt/helm/spawn-deadbeef',
    worktree: { id: 'wt-1', path: '/repo/wt/helm/spawn-deadbeef', branch: 'helm/spawn-deadbeef' },
  },
  gate: { ok: true, output: '', exitCode: 0, timedOut: false },
}

const META_FAILED: AgentWithMetaResult = {
  ok: false,
  output: null,
  attempts: 2,
  error: 'gate_failed',
  timedOut: true,
  gate: { ok: false, output: 'tests failed', exitCode: 1, timedOut: false },
}

/* ---------------------------------------------------------------------------
 * agent() 原有语义不变
 * ------------------------------------------------------------------------- */

describe('worker-source agent() semantics unchanged', () => {
  it('plain agent() returns host text as-is', timeout, async () => {
    const outcome = await runWorkerSource('const r = await agent("hi"); return r')
    assert.equal(outcome.status, 'complete')
    assert.equal(outcome.value, 'ok:hi')
    assert.equal(outcome.agentCalls.length, 1)
    assert.equal(outcome.agentCalls[0]?.prompt, 'hi')
    assert.equal(outcome.agentCalls[0]?.scopeId, 0)
    // 非 meta 调用不得携带 withMeta 标记（runtime 侧按该字段切换响应包装）。
    assert.ok(outcome.agentCalls[0]?.withMeta === undefined)
  })

  it('agent() with schema parses host JSON; host null resolves to null', timeout, async () => {
    const outcome = await runWorkerSource(
      'const a = await agent("q", { schema: { type: "object" } });\n' +
        'const b = await agent("f");\n' +
        'return { a: a, b: b }',
      { onAgent: (payload) => (payload.schema !== undefined ? '{"done":true}' : null) },
    )
    assert.equal(outcome.status, 'complete')
    assert.deepStrictEqual(outcome.value, { a: { done: true }, b: null })
  })

  it('unknown option key is still rejected', timeout, async () => {
    const outcome = await runWorkerSource('await agent("hi", { nope: 1 })')
    assert.equal(outcome.status, 'error')
    assert.match(outcome.error ?? '', /opts\.nope is not a recognised option/)
  })
})

/* ---------------------------------------------------------------------------
 * AGENT_OPTIONS 扩展：cwd / timeoutMs / gateTimeoutMs / maxAttempts
 * ------------------------------------------------------------------------- */

describe('worker-source new agent options', () => {
  it('forwards cwd and range-valid timeoutMs / gateTimeoutMs / maxAttempts in the payload', timeout, async () => {
    const outcome = await runWorkerSource(
      'await agent("work", { cwd: "/repo/modules/a", timeoutMs: 300000, gate: "pnpm test", gateTimeoutMs: 60000, maxAttempts: 3 })'
    )
    assert.equal(outcome.status, 'complete')
    const payload = outcome.agentCalls[0]
    assert.equal(payload?.cwd, '/repo/modules/a')
    assert.equal(payload?.timeoutMs, 300000)
    assert.equal(payload?.gateTimeoutMs, 60000)
    assert.equal(payload?.maxAttempts, 3)
    assert.equal(payload?.gate, 'pnpm test')
    assert.equal(payload?.scopeId, 0)
  })

  it('cwd composes with isolation worktree and accepts boundary values', timeout, async () => {
    const outcome = await runWorkerSource(
      'await agent("w", { cwd: "/repo", isolation: "worktree", timeoutMs: 1000, gate: "true", gateTimeoutMs: 600000, maxAttempts: 1 })'
    )
    assert.equal(outcome.status, 'complete')
    assert.equal(outcome.agentCalls[0]?.isolation, 'worktree')
    assert.equal(outcome.agentCalls[0]?.timeoutMs, 1000)
    assert.equal(outcome.agentCalls[0]?.gateTimeoutMs, 600000)
    assert.equal(outcome.agentCalls[0]?.maxAttempts, 1)
  })

  it('resume and cwd are mutually exclusive', timeout, async () => {
    const outcome = await runWorkerSource('await agent("fix", { resume: "impl", cwd: "/repo" })')
    assert.equal(outcome.status, 'error')
    assert.match(outcome.error ?? '', /opts\.resume and opts\.cwd are mutually exclusive/)
  })

  it('rejects cwd that is empty or blank', timeout, async () => {
    const blank = await runWorkerSource('await agent("x", { cwd: "  " })')
    assert.equal(blank.status, 'error')
    assert.match(blank.error ?? '', /opts\.cwd requires a non-empty string/)
  })

  it('rejects timeoutMs outside 1000..3600000 or non-integer', timeout, async () => {
    for (const bad of [999, 3600001, 1500.5, '1000']) {
      const outcome = await runWorkerSource(`await agent("x", { timeoutMs: ${JSON.stringify(bad)} })`)
      assert.equal(outcome.status, 'error', `timeoutMs ${String(bad)} should fail`)
      assert.match(outcome.error ?? '', /opts\.timeoutMs must be an integer between 1000 and 3600000/)
    }
  })

  it('gateTimeoutMs requires gate and rejects out-of-range values', timeout, async () => {
    const noGate = await runWorkerSource('await agent("x", { gateTimeoutMs: 60000 })')
    assert.equal(noGate.status, 'error')
    assert.match(noGate.error ?? '', /opts\.gateTimeoutMs requires opts\.gate/)

    for (const bad of [999, 600001, 2000.5]) {
      const outcome = await runWorkerSource(`await agent("x", { gate: "pnpm test", gateTimeoutMs: ${JSON.stringify(bad)} })`)
      assert.equal(outcome.status, 'error', `gateTimeoutMs ${String(bad)} should fail`)
      assert.match(outcome.error ?? '', /opts\.gateTimeoutMs must be an integer between 1000 and 600000/)
    }
  })

  it('rejects maxAttempts outside 1..10 or non-integer', timeout, async () => {
    for (const bad of [0, 11, 2.5]) {
      const outcome = await runWorkerSource(`await agent("x", { maxAttempts: ${JSON.stringify(bad)} })`)
      assert.equal(outcome.status, 'error', `maxAttempts ${String(bad)} should fail`)
      assert.match(outcome.error ?? '', /opts\.maxAttempts must be an integer between 1 and 10/)
    }
    const ten = await runWorkerSource('await agent("x", { maxAttempts: 10 })')
    assert.equal(ten.status, 'complete')
    assert.equal(ten.agentCalls[0]?.maxAttempts, 10)
  })
})

/* ---------------------------------------------------------------------------
 * agent.withMeta() / goal()
 * ------------------------------------------------------------------------- */

describe('worker-source agent.withMeta()', () => {
  it('sends withMeta: true and returns the host meta object verbatim', timeout, async () => {
    const outcome = await runWorkerSource(
      'const r = await agent.withMeta("plan", { label: "plan", cwd: "/repo", gate: "pnpm test", maxAttempts: 3 });\n' +
        'return r',
      { onAgent: () => META_OK },
    )
    assert.equal(outcome.status, 'complete')
    assert.deepStrictEqual(outcome.value, META_OK)
    const payload = outcome.agentCalls[0]
    assert.equal(payload?.withMeta, true)
    assert.equal(payload?.label, 'plan')
    assert.equal(payload?.cwd, '/repo')
    assert.equal(payload?.maxAttempts, 3)
  })

  it('returns failure meta (ok: false, output null) without null-coalescing', timeout, async () => {
    const outcome = await runWorkerSource('return await agent.withMeta("fix")', { onAgent: () => META_FAILED })
    assert.equal(outcome.status, 'complete')
    assert.deepStrictEqual(outcome.value, META_FAILED)
  })

  it('fails loudly when the host answers with plain text instead of a meta object', timeout, async () => {
    // 现 runtime 对 agent 调用回传纯文本；withMeta 契约未接线时必须显式报错，
    // 绝不把裸文本伪装成元数据对象（待 runtime 侧按 withMeta 标记切换响应包装）。
    const outcome = await runWorkerSource('return await agent.withMeta("x")', { onAgent: () => 'ok:x' })
    assert.equal(outcome.status, 'error')
    assert.match(outcome.error ?? '', /agent\.withMeta\(\): the host returned a result that is not an execution meta object/)

    const nulled = await runWorkerSource('return await agent.withMeta("x")', { onAgent: () => null })
    assert.equal(nulled.status, 'error')
    assert.match(nulled.error ?? '', /is not an execution meta object/)
  })

  it('shares the full option validation surface with agent()', timeout, async () => {
    const outcome = await runWorkerSource(
      'await agent.withMeta("x", { timeoutMs: 10 })'
    )
    assert.equal(outcome.status, 'error')
    assert.match(outcome.error ?? '', /opts\.timeoutMs must be an integer between 1000 and 3600000/)
  })
})

describe('worker-source goal()', () => {
  it('defaults maxAttempts to 3 and maps objective to the prompt', timeout, async () => {
    const outcome = await runWorkerSource(
      'const r = await goal({ objective: "ship it", label: "impl", gate: "pnpm test" });\n' + 'return r',
      { onAgent: () => META_OK },
    )
    assert.equal(outcome.status, 'complete')
    assert.deepStrictEqual(outcome.value, META_OK)
    const payload = outcome.agentCalls[0]
    assert.equal(payload?.prompt, 'ship it')
    assert.equal(payload?.label, 'impl')
    assert.equal(payload?.gate, 'pnpm test')
    assert.equal(payload?.maxAttempts, 3)
    assert.equal(payload?.withMeta, true)
  })

  it('honours explicit maxAttempts and forwards cwd/timeoutMs/gateTimeoutMs', timeout, async () => {
    const outcome = await runWorkerSource(
      'return await goal({ objective: "o", cwd: "/repo", maxAttempts: 5, timeoutMs: 300000, gate: "pnpm test", gateTimeoutMs: 30000 })',
      { onAgent: () => META_OK },
    )
    assert.equal(outcome.status, 'complete')
    const payload = outcome.agentCalls[0]
    assert.equal(payload?.maxAttempts, 5)
    assert.equal(payload?.cwd, '/repo')
    assert.equal(payload?.timeoutMs, 300000)
    assert.equal(payload?.gateTimeoutMs, 30000)
  })

  it('rejects missing objective, non-object spec and unknown keys', timeout, async () => {
    const missing = await runWorkerSource('await goal({ label: "x" })')
    assert.equal(missing.status, 'error')
    assert.match(missing.error ?? '', /goal\(\) spec\.objective requires a non-empty string/)

    const nonObject = await runWorkerSource('await goal("ship it")')
    assert.equal(nonObject.status, 'error')
    assert.match(nonObject.error ?? '', /goal\(spec\) expects an options object/)

    const unknown = await runWorkerSource('await goal({ objective: "o", wish: 1 })')
    assert.equal(unknown.status, 'error')
    assert.match(unknown.error ?? '', /goal\(\) spec\.wish is not a recognised option/)
  })
})

/* ---------------------------------------------------------------------------
 * workflow() 嵌套与 scopeId
 * ------------------------------------------------------------------------- */

describe('worker-source workflow() nesting and scopeId', () => {
  it('exports MAX_WORKFLOW_NESTING_DEPTH = 4', () => {
    assert.equal(MAX_WORKFLOW_NESTING_DEPTH, 4)
  })

  it('allows 4 nested workflow levels and assigns incrementing scopeIds', timeout, async () => {
    const outcome = await runWorkerSource('return await workflow("a")', {
      workflows: {
        a: 'return await workflow("b")',
        b: 'return await workflow("c")',
        c: 'return await agent("deep")',
      },
    })
    assert.equal(outcome.status, 'complete')
    assert.equal(outcome.value, 'ok:deep')
    assert.equal(outcome.agentCalls.length, 1)
    // 根 scope 0 → a=1 → b=2 → c=3：第 4 层内的 agent 调用携带 scopeId 3。
    assert.equal(outcome.agentCalls[0]?.scopeId, 3)
  })

  it('rejects a 5th nesting level', timeout, async () => {
    const outcome = await runWorkerSource('return await workflow("a")', {
      workflows: {
        a: 'return await workflow("b")',
        b: 'return await workflow("c")',
        c: 'return await workflow("d")',
        d: 'return await workflow("e")',
      },
    })
    assert.equal(outcome.status, 'error')
    assert.match(outcome.error ?? '', /workflow\(\) cannot be nested more than 4 levels deep/)
  })

  it('keeps the 256 nested-call cap (total, orthogonal to depth)', timeout, async () => {
    const outcome = await runWorkerSource('return await workflow("a")', {
      nestedCap: 2,
      workflows: {
        a: 'return await workflow("b")',
        b: 'return await workflow("c")',
        c: 'return 1',
      },
    })
    assert.equal(outcome.status, 'error')
    assert.match(outcome.error ?? '', /exceeded its cap of 2 nested workflow\(\) calls/)
  })

  it('sibling sub-workflows get distinct incrementing scopeIds (same label allowed)', timeout, async () => {
    const outcome = await runWorkerSource(
      'const r0 = await agent("root");\n' +
        'const w1 = await workflow("a");\n' +
        'const w2 = await workflow("b");\n' +
        'return [r0, w1, w2]',
      {
        workflows: {
          a: 'return await agent("in-a", { label: "plan" })',
          b: 'return await agent("in-b", { label: "plan" })',
        },
      },
    )
    assert.equal(outcome.status, 'complete')
    assert.deepStrictEqual(outcome.value, ['ok:root', 'ok:in-a', 'ok:in-b'])
    assert.deepStrictEqual(
      outcome.agentCalls.map((call) => call.scopeId),
      [0, 1, 2],
    )
    // 并发子工作流可共用简短 label：隔离由 scopeId 承担（runtime 侧待按
    // ${scopeId}:${label} 登记 completedByLabel）。
    assert.equal(outcome.agentCalls[1]?.label, 'plan')
    assert.equal(outcome.agentCalls[2]?.label, 'plan')
  })

  it('exposes goal to nested workflow scopes', timeout, async () => {
    const outcome = await runWorkerSource('return await workflow("a")', {
      workflows: {
        a: 'const r = await goal({ objective: "child goal" });\nreturn r.output',
      },
      onAgent: (payload) => {
        if (payload.withMeta === true) return { ok: true, output: 'child-done', attempts: 1 }
        return `ok:${payload.prompt}`
      },
    })
    assert.equal(outcome.status, 'complete')
    assert.equal(outcome.value, 'child-done')
    assert.equal(outcome.agentCalls[0]?.scopeId, 1)
    assert.equal(outcome.agentCalls[0]?.maxAttempts, 3)
  })
})
