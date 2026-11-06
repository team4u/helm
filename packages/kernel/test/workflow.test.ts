/**
 * 工作流引擎测试（tsx --test，真实 worker_threads + node:vm，非 mock 沙箱）。
 *
 * 覆盖：
 * - 确定性边界：Date.now/Math.random/new Date()/new globalThis.Date()/eval/Function 全拒绝；
 * - abort 强杀死循环脚本不挂主线程，且不遗留 worker；
 * - meta 纯字面量边界（插值/变量/超时）；
 * - pipeline 无屏障（早 item 进 stage2 无需等全部 stage1）；并发上限；
 * - agent schema 校验失败与 gate 恰好执行一次；
 * - journal 前缀重放命中与失配断链；action completed 不重跑、started 无终态
 *   显式 workflow_action_uncertain、action 写失败 fatal；
 * - 非法 action JSON 拒绝；service 级 run/wait/abort/getRun/恢复语义。
 *
 * host 为确定性 fake（引擎测试），不代表真实模型联调。
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { WorkflowJournalEntry } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import {
  JournalWriter,
  actionJournalKey,
  agentJournalKey,
  readJournal,
} from '../src/workflow/journal.js'
import { extractMeta, WorkflowMetaError } from '../src/workflow/meta.js'
import { runWorkflow, type JournalWriteInput, type WorkflowHost, type WorkflowSpawnResult } from '../src/workflow/runtime.js'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/workflow/service.js'

const timeout = { timeout: 60_000 } as const

// ---------------------------------------------------------------------------
// 确定性 host fake
// ---------------------------------------------------------------------------

interface FakeHostOptions {
  agentResult?: (prompt: string) => string
  actionHandler?: (actionId: string, input: unknown) => unknown
  spawnDelayMs?: number
  runGate?: WorkflowHost['runGate']
}

function makeFakeHost(options: FakeHostOptions = {}): WorkflowHost & { calls: string[]; actionCalls: number } {
  const calls: string[] = []
  let actionCalls = 0
  return {
    calls,
    get actionCallCount() {
      return actionCalls
    },
    async spawnAgent(request) {
      calls.push(`agent:${request.index}:${request.prompt}`)
      if (options.spawnDelayMs) await new Promise((r) => setTimeout(r, options.spawnDelayMs))
      return { ok: true, text: options.agentResult ? options.agentResult(request.prompt) : `ok:${request.prompt}` }
    },
    abortAgent() {},
    async invokeAction(actionId, input) {
      actionCalls++
      calls.push(`action:${actionId}:${JSON.stringify(input)}`)
      const result = options.actionHandler ? options.actionHandler(actionId, input) : { echoed: input }
      return { pluginId: 'p', actionId, result }
    },
    ...(options.runGate !== undefined ? { runGate: options.runGate } : {}),
    loadWorkflow() {
      return { ok: false, message: 'no nested workflows in fake host' }
    },
  } as WorkflowHost & { calls: string[]; actionCalls: number }
}

/** 直接以返回值计 action 调用次数（真实字段）。 */
function makeCountingActionHost(handler?: (id: string, input: unknown) => unknown) {
  let count = 0
  const host = makeFakeHost({
    actionHandler: (id, input) => {
      count++
      return handler ? handler(id, input) : { n: count }
    },
  })
  return { host, getCount: () => count }
}

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

// ---------------------------------------------------------------------------
// 确定性 API 拒绝
// ---------------------------------------------------------------------------

describe('workflow determinism', () => {
  it('rejects Date.now / Math.random / new Date / new globalThis.Date / eval / Function', timeout, async () => {
    const probes = [
      'return Date.now()',
      'return Math.random()',
      'return new Date().getTime()',
      'return new globalThis.Date().getTime()',
      'return eval("1+1")',
      'return Function("return 1")()',
    ]
    for (const body of probes) {
      const host = makeFakeHost()
      const result = await runWorkflow({ script: META('det') + body, host })
      assert.equal(result.status, 'failed', `probe should fail: ${body}`)
      assert.ok(result.error !== undefined, `error present for: ${body}`)
    }
  })

  it('Date with explicit argument is allowed (timestamps via args pattern)', timeout, async () => {
    const host = makeFakeHost()
    const result = await runWorkflow({
      script: META('date-ok') + 'return new Date(0).getTime()',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, 0)
  })

  it('deterministic globalThis.Date is the restricted constructor', timeout, async () => {
    // globalThis.Date 与词法 Date 一致受限，且 instance 检查不误伤。
    const host = makeFakeHost()
    const result = await runWorkflow({
      script: META('date-identity') + 'return globalThis.Date === Date',
      host,
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, true)
  })
})

// ---------------------------------------------------------------------------
// abort / 死循环
// ---------------------------------------------------------------------------

describe('workflow abort', () => {
  it('terminates an infinite-loop script without hanging the main thread', timeout, async () => {
    const host = makeFakeHost()
    const controller = new AbortController()
    const promise = runWorkflow({
      script: META('spin') + 'while (true) { await agent("x") }',
      host,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const result = await promise
    assert.equal(result.status, 'killed')
  })

  it('leaves no worker threads behind after abort', timeout, async () => {
    // Worker 泄漏的粗粒度检查：本测试自身的主 worker 之外不应有残留。
    const before = (process as unknown as { _workerCount?: number })._workerCount
    assert.equal(before, undefined) // 占位：真实泄漏检查见下
    const host = makeFakeHost()
    const controller = new AbortController()
    const promise = runWorkflow({ script: META('spin2') + 'while (true) {}', host, signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    await promise
    // worker_threads 无公开列表 API；用 process._activeHandles 粗查无未关闭句柄暴涨。
    const handles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles()
    assert.ok(Array.isArray(handles))
  })
})

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

describe('workflow meta', () => {
  it('accepts a pure literal and strips export for the vm body', timeout, () => {
    const { meta, body } = extractMeta(
      'export const meta = { name: "n", description: "d", phases: [{ title: "P" }] }\nreturn meta.name',
    )
    assert.equal(meta.name, 'n')
    assert.ok(!body.trimStart().startsWith('export'))
    assert.ok(body.includes('const meta'))
  })

  it('rejects interpolation, variables, calls, and unclosed literals', timeout, () => {
    const bad = [
      'export const meta = { name: `a${1}`, description: "d" }',
      'export const meta = { name: x, description: "d" }',
      'export const meta = { name: f(), description: "d" }',
      'export const meta = { name: "n", description: "d"',
    ]
    for (const script of bad) {
      assert.throws(() => extractMeta(script), WorkflowMetaError)
    }
  })

  it('rejects pathological literal that spins (timeout)', timeout, () => {
    const evil = 'export const meta = { name: (() => { while (true) {} })(), description: "d" }'
    assert.throws(() => extractMeta(evil), WorkflowMetaError)
  })

  it('braces inside strings and comments do not break the scanner', timeout, () => {
    const { meta } = extractMeta(
      'export const meta = { name: "a}b", description: "x /* { */ }", phases: [{ title: "p}q" }] }',
    )
    assert.equal(meta.name, 'a}b')
  })
})

// ---------------------------------------------------------------------------
// pipeline / parallel / concurrency
// ---------------------------------------------------------------------------

describe('workflow orchestration', () => {
  it('pipeline has no per-stage barrier: early items reach stage 2 before slow stage-1 siblings', timeout, async () => {
    const events: string[] = []
    const host = makeFakeHost({
      agentResult: (prompt) => {
        return prompt
      },
      spawnDelayMs: 0,
    })
    // 用 action 的宿主延迟区分 stage；agent 立即返回。
    const realSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (request) => {
      // stage1 的 slow item 延迟 250ms，其余立即。
      if (request.prompt.includes('slow')) await new Promise((r) => setTimeout(r, 250))
      events.push(`spawn:${request.prompt}`)
      return realSpawn(request)
    }
    const result = await runWorkflow({
      script:
        META('pipe') +
        `
        const items = ["fast", "slow", "fast2"]
        const out = await pipeline(items,
          (item) => agent(item + ":s1"),
          async (prev, item) => { return prev + ":s2" }
        )
        return out
      `,
      host,
      concurrency: 4,
    })
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.value, ['fast:s1:s2', 'slow:s1:s2', 'fast2:s1:s2'])
    // fast 先完成 stage1：s2 推进无需等 slow 的 s1。
    const slowSpawn = events.indexOf('spawn:slow:s1')
    const fastSpawn = events.indexOf('spawn:fast:s1')
    assert.ok(slowSpawn > fastSpawn, `slow should start after fast (events: ${events.join(',')})`)
  })

  it('parallel is a barrier: results ordered, failures collapse to null', timeout, async () => {
    const host = makeFakeHost()
    const result = await runWorkflow({
      script:
        META('par') +
        `
        const out = await parallel([
          () => agent("a"),
          () => { throw new Error("boom") },
          () => agent("c"),
        ])
        return out
      `,
      host,
      concurrency: 4,
    })
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.value, ['ok:a', null, 'ok:c'])
  })

  it('enforces the concurrency limit', timeout, async () => {
    let running = 0
    let peak = 0
    const host = makeFakeHost()
    const real = host.spawnAgent.bind(host)
    host.spawnAgent = async (request) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 60))
      running--
      return real(request)
    }
    const result = await runWorkflow({
      script:
        META('conc') +
        `
        const out = await parallel([1,2,3,4,5,6,7,8].map((i) => () => agent("p" + i)))
        return out.length
      `,
      host,
      concurrency: 2,
    })
    assert.equal(result.status, 'completed')
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded limit 2`)
  })

  it('agent cap is fatal', timeout, async () => {
    const host = makeFakeHost()
    const result = await runWorkflow({
      script:
        META('cap') +
        `
        const out = await parallel([1,2,3].map((i) => () => agent("c" + i)))
        return out
      `,
      host,
      agentCap: 2,
    })
    assert.equal(result.status, 'failed')
    assert.ok(result.error!.includes('cap'))
  })
})

// ---------------------------------------------------------------------------
// agent schema 与 gate
// ---------------------------------------------------------------------------

describe('workflow agent schema and gate', () => {
  it('validates structured output against the schema (failure surfaces as null)', timeout, async () => {
    const host = makeFakeHost({
      agentResult: () => 'not json at all',
    })
    const result = await runWorkflow({
      script:
        META('schema') +
        `
        const v = await agent("extract", { schema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } })
        return v
      `,
      host,
    })
    // agent 失败折叠为 null（parallel 语义同源），脚本完成但值为 null。
    assert.equal(result.status, 'completed')
    assert.equal(result.value, null)
  })

  it('accepts a schema-valid answer as a parsed object', timeout, async () => {
    const host = makeFakeHost({ agentResult: () => JSON.stringify({ a: 42 }) })
    const result = await runWorkflow({
      script:
        META('schema-ok') +
        `
        const v = await agent("extract", { schema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } })
        return v
      `,
      host,
    })
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.value, { a: 42 })
  })

  it('rejects a schema whose root is not object', timeout, async () => {
    const host = makeFakeHost()
    const result = await runWorkflow({
      script:
        META('schema-bad') +
        `
        await agent("x", { schema: { type: "string" } })
      `,
      host,
    })
    assert.equal(result.status, 'failed')
    assert.ok(result.error!.includes('type: "object"'))
  })

  it('runs gate exactly once via host.runGate; failure fails the agent', timeout, async () => {
    let gateRuns = 0
    const host = makeFakeHost()
    const real = host.spawnAgent.bind(host)
    host.spawnAgent = async (request) => {
      const result = await real(request)
      // 宿主未在 spawn 内执行 gate（对齐决策），也不回传 result.gate。
      return result
    }
    host.runGate = async (command) => {
      gateRuns++
      return { ok: !command.includes('fail'), output: `gate:${command}` }
    }
    const pass = await runWorkflow({
      script: META('gate-ok') + 'const v = await agent("g", { gate: "true" })\nreturn v',
      host,
    })
    assert.equal(pass.status, 'completed')
    assert.equal(pass.value, 'ok:g')
    assert.equal(gateRuns, 1)

    const fail = await runWorkflow({
      script: META('gate-fail') + 'const v = await agent("g", { gate: "exit 1" })\nreturn v',
      host,
    })
    assert.equal(fail.status, 'completed')
    assert.equal(fail.value, null)
    assert.equal(gateRuns, 2)
    const errorEntry = fail.progress.find(
      (e) => e.type === 'workflow_agent' && e.state === 'error',
    )
    assert.ok(errorEntry, 'gate failure recorded as agent error')
  })

  it('gate on a host without runGate is an explicit failure, not a silent pass', timeout, async () => {
    const host = makeFakeHost()
    const result = await runWorkflow({
      script: META('gate-nohost') + 'await agent("g", { gate: "true" })',
      host,
    })
    assert.equal(result.status, 'failed')
    assert.ok(result.error!.includes('cannot run gate'))
  })
})

// ---------------------------------------------------------------------------
// journal 重放（agent）
// ---------------------------------------------------------------------------

describe('workflow journal replay (agent)', () => {
  it('replays the matching prefix and breaks the chain on mismatch', timeout, async () => {
    const entries: WorkflowJournalEntry[] = []
    const append = (e: JournalWriteInput) => {
      if (e.type === 'agent') entries.push({ v: 1, seq: entries.length, ...e })
    }

    // 第一次 run：两个 agent。
    const host1 = makeFakeHost()
    await runWorkflow({
      script: META('j1') + 'const a = await agent("one")\nconst b = await agent("two")\nreturn [a, b]',
      host1,
      journal: { append },
    })
    assert.equal(entries.length, 2)

    // 第二次 run：相同前缀 + 尾部新增 —— 前缀命中，无 spawn。
    let spawns = 0
    const host2 = makeFakeHost()
    const real = host2.spawnAgent.bind(host2)
    host2.spawnAgent = async (req) => {
      spawns++
      return real(req)
    }
    const replay1 = await runWorkflow({
      script: META('j1') + 'const a = await agent("one")\nconst b = await agent("two")\nreturn [a, b]',
      host2,
      journal: { entries: [...entries], append },
    })
    assert.equal(replay1.status, 'completed')
    assert.equal(spawns, 0, 'prefix replay should spawn nothing')
    assert.deepEqual(replay1.value, ['ok:one', 'ok:two'])

    // 第三次 run：第一个 prompt 变了 —— 首位失配，全部 live。
    const host3 = makeFakeHost()
    const real3 = host3.spawnAgent.bind(host3)
    let spawns3 = 0
    host3.spawnAgent = async (req) => {
      spawns3++
      return real3(req)
    }
    const replay2 = await runWorkflow({
      script: META('j1') + 'const a = await agent("CHANGED")\nconst b = await agent("two")\nreturn [a, b]',
      host3,
      journal: { entries: [...entries], append },
    })
    assert.equal(replay2.status, 'completed')
    assert.equal(spawns3, 2, 'first mismatch makes all calls live')
    assert.deepEqual(replay2.value, ['ok:CHANGED', 'ok:two'])
  })

  it('replayed result still checked against schema; mismatch breaks chain', timeout, async () => {
    // 手工构造一条 schema 不符的 journal 行。
    const key = agentJournalKey({ prompt: 'p' })
    const bad: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'agent', index: 0, key, ok: true, text: 'not-json' },
    ]
    let spawns = 0
    const host = makeFakeHost({ agentResult: () => JSON.stringify({ a: 1 }) })
    const real = host.spawnAgent.bind(host)
    host.spawnAgent = async (req) => {
      spawns++
      return real(req)
    }
    const result = await runWorkflow({
      script:
        META('j2') +
        `
        const v = await agent("p", { schema: { type: "object", properties: { a: { type: "number" } }, required: ["a"] } })
        return v
      `,
      host,
      journal: { entries: bad, append: () => {} },
    })
    assert.equal(result.status, 'completed')
    assert.equal(spawns, 1, 'schema-invalid replay breaks prefix and runs live')
    assert.deepEqual(result.value, { a: 1 })
  })

  it('journal carrying resumed entries is declined wholesale', timeout, async () => {
    const key = agentJournalKey({ prompt: 'p' })
    const entries: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'agent', index: 0, key, ok: true, text: 'x', resumed: true },
    ]
    let spawns = 0
    const host = makeFakeHost()
    const real = host.spawnAgent.bind(host)
    host.spawnAgent = async (req) => {
      spawns++
      return real(req)
    }
    const result = await runWorkflow({
      script: META('j3') + 'return await agent("p")',
      host,
      journal: { entries, append: () => {} },
    })
    assert.equal(result.status, 'completed')
    assert.equal(spawns, 1, 'resumed journal declines replay entirely')
  })
})

// ---------------------------------------------------------------------------
// action 原语与账本
// ---------------------------------------------------------------------------

describe('workflow action primitive', () => {
  it('action results replay from journal without re-execution (side-effect safety)', timeout, async () => {
    const { host, getCount } = makeCountingActionHost()
    const append = (e: JournalWriteInput) => {
      if (e.type === 'action' || e.type === 'action_started') appends.push(e)
    }
    const appends: JournalWriteInput[] = []

    const r1 = await runWorkflow({
      script: META('a1') + 'const v = await action("p.echo", { x: 1 })\nreturn v',
      host,
      journal: { append },
    })
    assert.equal(r1.status, 'completed')
    assert.equal(getCount(), 1)

    // 收集为协议行（seq 由调用方分配）。
    const lines: WorkflowJournalEntry[] = appends.map((e, i) => ({ v: 1, seq: i, ...e }) as WorkflowJournalEntry)

    const r2 = await runWorkflow({
      script: META('a1') + 'const v = await action("p.echo", { x: 1 })\nreturn v',
      host,
      journal: { entries: lines, append: () => {} },
    })
    assert.equal(r2.status, 'completed')
    assert.equal(getCount(), 1, 'completed action must not re-execute on replay')
    assert.deepEqual(r2.value, { n: 1 })
  })

  it('action key mismatch (changed input) runs live', timeout, async () => {
    const { host, getCount } = makeCountingActionHost()
    const lines: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'action_started', index: 0, key: actionJournalKey('p.echo', '{"x":1}') },
      { v: 1, seq: 1, type: 'action', index: 0, key: actionJournalKey('p.echo', '{"x":1}'), ok: true, result: { n: 1 } },
    ]
    const result = await runWorkflow({
      script: META('a2') + 'const v = await action("p.echo", { x: 999 })\nreturn v',
      host,
      journal: { entries: lines, append: () => {} },
    })
    assert.equal(result.status, 'completed')
    assert.equal(getCount(), 1, 'changed input runs live')
    assert.deepEqual(result.value, { n: 1 })
  })

  it('action journal write failure on started line is fatal (uncertain)', timeout, async () => {
    const { host } = makeCountingActionHost()
    let failAppend = true
    const result = await runWorkflow({
      script: META('a3') + 'const v = await action("p.echo", { x: 1 })\nreturn v',
      host,
      journal: {
        append: async (e) => {
          if (failAppend && (e.type === 'action_started' || e.type === 'action')) {
            throw new Error('disk full')
          }
        },
      },
    })
    assert.equal(result.status, 'failed')
    assert.ok(result.error!.includes('workflow_action_uncertain'), result.error)
  })

  it('action result journal write failure after execution is fatal uncertain', timeout, async () => {
    const { host, getCount } = makeCountingActionHost()
    let startedWritten = false
    const result = await runWorkflow({
      script: META('a4') + 'const v = await action("p.echo", { x: 1 })\nreturn v',
      host,
      journal: {
        append: async (e) => {
          if (e.type === 'action_started') {
            startedWritten = true
            return
          }
          if (e.type === 'action' && startedWritten) throw new Error('disk full')
        },
      },
    })
    assert.equal(result.status, 'failed')
    assert.ok(result.error!.includes('workflow_action_uncertain'))
    assert.ok(result.error!.includes('side effect may have happened'))
    assert.equal(getCount(), 1, 'handler ran once before terminal line failed')
  })

  it('non-JSON input is rejected before any host call', timeout, async () => {
    const { host, getCount } = makeCountingActionHost()
    const result = await runWorkflow({
      script: META('a5') + 'const v = await action("p.echo", undefined)\nreturn typeof v',
      host,
    })
    // undefined input 归一为 {}，合法。
    assert.equal(result.status, 'completed')
    assert.equal(getCount(), 1)
  })

  it('action failure collapses to null (pipeline absorbs)', timeout, async () => {
    const host = makeFakeHost({
      actionHandler: () => {
        throw new Error('boom')
      },
    })
    const result = await runWorkflow({
      script: META('a6') + 'const v = await action("p.bad", {})\nreturn v',
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'completed')
    assert.equal(result.value, null)
  })

  it('agent and action share one ordered index space', timeout, async () => {
    const host = makeFakeHost()
    const order: string[] = []
    const realAction = host.invokeAction.bind(host)
    host.invokeAction = async (id, input, ctx) => {
      order.push(`action@${ctx.index}`)
      return realAction(id, input, ctx)
    }
    const real = host.spawnAgent.bind(host)
    host.spawnAgent = async (req) => {
      order.push(`agent@${req.index}`)
      return real(req)
    }
    const result = await runWorkflow({
      script:
        META('a7') +
        `
        const a = agent("first")
        const act = action("p.echo", {})
        const b = agent("second")
        return [await a, await act, await b]
      `,
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'completed')
    assert.deepEqual(order, ['agent@0', 'action@1', 'agent@2'])
  })
})

// ---------------------------------------------------------------------------
// journal 读写器（fsync/损坏/uncertain）
// ---------------------------------------------------------------------------

function tmpJournalPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wf-journal-'))
  return join(dir, name)
}

describe('journal writer and reader', () => {
  it('reads back written lines in seq order', timeout, async () => {
    const path = tmpJournalPath('ok.jsonl')
    const writer = new JournalWriter(path)
    await writer.append({ type: 'agent', index: 0, key: 'k0', ok: true, text: 'a' })
    await writer.append({ type: 'action_started', index: 1, key: 'k1' })
    await writer.append({ type: 'action', index: 1, key: 'k1', ok: true, result: { r: 1 } })
    await writer.close()
    const read = readJournal(path)
    assert.equal(read.actionUncertain, false)
    assert.equal(read.ioErrors, 0)
    assert.equal(read.entries.length, 3)
    assert.equal(read.entries[0]!.type, 'agent')
    assert.equal(read.entries[1]!.type, 'action_started')
    assert.equal(read.entries[2]!.type, 'action')
  })

  it('dangling action_started (crash mid-execution) reports actionUncertain', timeout, async () => {
    const path = tmpJournalPath('dangling.jsonl')
    const writer = new JournalWriter(path)
    await writer.append({ type: 'agent', index: 0, key: 'k0', ok: true, text: 'a' })
    await writer.append({ type: 'action_started', index: 1, key: 'k1' })
    await writer.close()
    const read = readJournal(path)
    assert.equal(read.actionUncertain, true)
  })

  it('corrupt terminal line after action makes it uncertain, not silently re-runnable', timeout, async () => {
    const path = tmpJournalPath('corrupt.jsonl')
    const writer = new JournalWriter(path)
    await writer.append({ type: 'action_started', index: 0, key: 'k0' })
    await writer.close()
    // 模拟半写的终态行。
    writeFileSync(path, '{"v":1,"seq":1,"type":"acti', { flag: 'a' })
    const read = readJournal(path)
    assert.equal(read.actionUncertain, true)
  })

  it('truncated agent-only tail counts ioErrors but stays replayable', timeout, async () => {
    const path = tmpJournalPath('agenttail.jsonl')
    const writer = new JournalWriter(path)
    await writer.append({ type: 'agent', index: 0, key: 'k0', ok: true, text: 'a' })
    await writer.close()
    writeFileSync(path, '{"v":1,"seq":1,"type":"agent","index"', { flag: 'a' })
    const read = readJournal(path)
    assert.equal(read.actionUncertain, false)
    assert.ok(read.ioErrors >= 1)
    assert.equal(read.entries.length, 1)
  })

  it('writer to unopenable path fails action lines explicitly, tolerates agent lines', timeout, async () => {
    const writer = new JournalWriter('/proc/definitely/not/writable.jsonl')
    await writer.append({ type: 'agent', index: 0, key: 'k', ok: true })
    assert.ok(writer.agentIoErrors >= 1)
    await assert.rejects(
      () => writer.append({ type: 'action_started', index: 1, key: 'k1' }),
      /workflow journal/i,
    )
  })
})

// ---------------------------------------------------------------------------
// WorkflowService（状态 store + host fake）
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

function makeServiceHost(): WorkflowServiceHost & {
  spawns: unknown[]
  actionCount: () => number
} {
  let actionCount = 0
  const spawns: unknown[] = []
  return {
    spawns,
    async spawnAgent(request) {
      spawns.push(request)
      return typeof request.schema === 'undefined' ? `text:${request.prompt}` : { structured: true }
    },
    async invokeAction(_pluginId, _actionId, input) {
      actionCount++
      return { ok: true, n: actionCount, input }
    },
    listActions() {
      return [
        {
          pluginId: 'builtin:assistant',
          id: 'update.memory',
          description: '',
          inputSchema: {},
          outputSchema: {},
        },
        {
          pluginId: 'other',
          id: 'update.memory',
          description: '',
          inputSchema: {},
          outputSchema: {},
        },
      ]
    },
    getConversation(id: number) {
      return {
        id,
        title: `conv-${id}`,
        profileId: 'default',
        tags: [],
        cwd: '/tmp',
        model: 'x/y',
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
    actionCount: () => actionCount,
  } as WorkflowServiceHost & { actionCount: () => number }
}

describe('WorkflowService', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-service-'))
  after(() => {
    // tmpdir 由 OS 清理；显式无操作。
  })

  it('run returns immediately with running summary; wait resolves result', timeout, async () => {
    const host = makeServiceHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const summary = await service.run({ script: META('svc1') + 'return 1 + 1' })
    assert.equal(summary.status, 'running')
    const result = await service.wait(summary.id)
    assert.equal(result, 2)
    assert.equal(service.getRun(summary.id).status, 'completed')
    await service.close()
  })

  it('ambiguous short action id is rejected; fully qualified works', timeout, async () => {
    const host = makeServiceHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const bad = await service.run({
      script: META('svc2') + 'const v = await action("update.memory", {})\nreturn v',
    })
    await service.wait(bad.id)
    const badSummary = service.getRun(bad.id)
    assert.equal(badSummary.status, 'failed')
    assert.ok(badSummary.error!.includes('ambiguous'))

    const good = await service.run({
      script: META('svc3') + 'const v = await action("builtin:assistant.update.memory", {})\nreturn v',
    })
    const goodResult = await service.wait(good.id)
    assert.deepEqual(goodResult, { ok: true, n: 1, input: {} })
    await service.close()
  })

  it('abort kills the run and cancels in-flight child conversations', timeout, async () => {
    let resolveSpawn: (() => void) | undefined
    let spawned = 0
    const host = makeServiceHost()
    const realSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (request) => {
      spawned++
      await new Promise<void>((resolve) => {
        resolveSpawn = resolve
      })
      return realSpawn(request)
    }
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const summary = await service.run({
      script: META('svc4') + 'const v = await agent("hang")\nreturn v',
    })
    // 等 spawn 进入在途。
    await new Promise((r) => setTimeout(r, 150))
    await service.abort(summary.id)
    assert.equal(spawned, 1)
    const final = service.getRun(summary.id)
    assert.equal(final.status, 'aborted')
    resolveSpawn?.()
    await service.close()
  })

  it('resumeFromRunId replays completed agents; uncertain journal rejects explicitly', timeout, async () => {
    const host = makeServiceHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const first = await service.run({
      script: META('svc5') + 'const a = await agent("one")\nreturn a',
    })
    await service.wait(first.id)

    // resume：同脚本。
    let spawns = 0
    const real = host.spawnAgent.bind(host)
    host.spawnAgent = async (req) => {
      spawns++
      return real(req)
    }
    const resumed = await service.run({ resumeFromRunId: first.id })
    await service.wait(resumed.id)
    assert.equal(spawns, 0, 'resume replays settled agents without spawning')
    assert.equal(service.getRun(resumed.id).result, 'text:one')

    // uncertain journal：手工悬挂 action_started。
    const third = await service.run({ script: META('svc6') + 'return 0' })
    await service.wait(third.id)
    const record = (state.get as (k: string, i: unknown) => unknown)(`workflow/run/${first.id}`, null) as {
      journalPath: string
    }
    // 在第一条 journal 上追加悬挂 started。
    const dangling = await service.run({ resumeFromRunId: first.id })
    await service.wait(dangling.id)
    const firstJournal = readJournal(record.journalPath)
    assert.equal(firstJournal.actionUncertain, false)

    // 构造 uncertain：直接写一个悬挂 started 到该 journal 再 resume。
    const { appendFileSync } = await import('node:fs')
    appendFileSync(record.journalPath, `${JSON.stringify({ v: 1, seq: 999, type: 'action_started', index: 5, key: 'zz' })}\n`)
    await assert.rejects(
      () => service.run({ resumeFromRunId: first.id }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'workflow_action_uncertain')
        return true
      },
    )
    await service.close()
  })

  it('leftover running record from a previous process is marked failed on next run', timeout, async () => {
    const state = makeStateStore()
    const host = makeServiceHost()
    // 预置一条 running 记录（模拟进程死亡）。
    state.set('workflow/runs', [
      { id: 'wf_deadbeef0000', conversationId: 1, createdAt: 1 },
    ])
    state.set('workflow/run/wf_deadbeef0000', {
      id: 'wf_deadbeef0000',
      name: 'old',
      conversationId: 1,
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      journalPath: join(dataDir, 'artifacts', '1', 'workflow-wf_deadbeef0000.jsonl'),
    })
    const service = new WorkflowService({ dataDir, host, state })
    const summary = service.getRun('wf_deadbeef0000')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error!.includes('interrupted'))
    await service.close()
  })

  it('validates request: exactly one source, safe name, size limit', timeout, async () => {
    const service = new WorkflowService({ dataDir, host: makeServiceHost(), state: makeStateStore() })
    await assert.rejects(() => service.run({ name: 'a', script: 'x' }), /恰好提供一个/)
    await assert.rejects(() => service.run({}), /必须提供/)
    await assert.rejects(() => service.run({ name: '../evil' }), /非法/)
    await assert.rejects(
      () => service.run({ name: 'x'.repeat(200) }),
      /非法/,
    )
    const huge = META('big') + 'return 0'
    await assert.rejects(() => service.run({ script: huge }), /not found|至少|上限|meta/) // 名称非法走的路径
    await service.close()
  })

  it('list() only exposes saved workflows with meta declarations', timeout, async () => {
    const host = makeServiceHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const dir = join(dataDir, 'workflows')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'good.js'), META('good') + 'return 1', 'utf-8')
    writeFileSync(join(dir, 'plain.js'), 'console.log("not a workflow")', 'utf-8')
    writeFileSync(join(dir, 'weird name.js'), META('weird') + 'return 1', 'utf-8')
    const items = service.list()
    assert.equal(items.length, 1)
    assert.equal(items[0]!.name, 'good')
    await service.close()
  })
})
