/**
 * 工作流引擎测试（tsx --test，真实 worker_threads + node:vm，非 mock 沙箱）。
 *
 * 覆盖：
 * - 确定性边界：Date.now/Math.random/new Date()/new globalThis.Date()/eval/Function 全拒绝；
 * - abort 强杀死循环脚本不挂主线程，且不遗留 worker；
 * - meta 纯字面量边界（插值/变量/超时）；
 * - pipeline 无屏障（早 item 进 stage2 无需等全部 stage1）；并发上限；
 * - agent schema 校验失败与 gate 恰好执行一次；
 * - journal 前缀重放命中与失配断链（resumed 行同按 index+key 逐项匹配，副作用零重复；
 *   伪造 resumed 标记的不一致行拒绝作缓存）；action completed 不重跑、started 无终态
 *   显式 workflow_action_uncertain、action 写失败 fatal、重放补记失败 fatal；
 * - 非法 action JSON 拒绝；service 级 run/wait/abort/getRun/恢复语义；
 * - 失败终态统一写 record（坏 meta / state flush 故障不留假 running、无 unhandled）；
 * - journal 缺失/读错误/failed action 恢复拒绝；args 恢复一致；abort 等待子会话；
 * - redact 值级脱敏；caps 正数边界；agentId 跨 run 命名空间隔离（并发身份）；
 * - 真 SDK 集成：faux provider + KernelRuntime spawn 链，不显式指定 agentType
 *   的 workflow 直接用 assistant 默认 profile 执行。
 *
 * host 为确定性 fake（引擎测试），不代表真实模型联调。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { EnvExecResponse } from '@helm/protocol'
import type { WorkflowJournalEntry } from '../src/builtin-plugins/workflow/engine/journal.js'
import { HelmError } from '@helm/protocol'
import {
  JournalWriter,
  actionJournalKey,
  agentJournalKey,
  readJournal,
  type JournalWriteInput,
} from '../src/builtin-plugins/workflow/engine/journal.js'
import { extractMeta, WorkflowMetaError } from '../src/builtin-plugins/workflow/engine/meta.js'
import { type WorkflowEntry, type WorkflowActionEntry } from '../src/builtin-plugins/workflow/engine/progress.js'
import { normalizeWorkflowArgs, runWorkflow, type WorkflowHost, type WorkflowSpawnResult } from '../src/builtin-plugins/workflow/engine/runtime.js'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/builtin-plugins/workflow/engine/service.js'

const timeout = { timeout: 60_000 } as const

// ---------------------------------------------------------------------------
// 确定性 host fake
// ---------------------------------------------------------------------------

interface FakeHostOptions {
  agentResult?: (prompt: string) => string
  actionHandler?: (actionId: string, input: unknown) => unknown
  prepareAction?: WorkflowHost['prepareAction']
  spawnDelayMs?: number
  runGate?: WorkflowHost['runGate']
}

/** host fake 的可断言侧面（真字段，不用 getter 骗 as）。 */
interface FakeHostExtras {
  calls: string[]
  actionCalls: number
}

function makeFakeHost(options: FakeHostOptions = {}): WorkflowHost & FakeHostExtras {
  const extras: FakeHostExtras = { calls: [], actionCalls: 0 }
  return {
    calls: extras.calls,
    get actionCalls(): number {
      return extras.actionCalls
    },
    async spawnAgent(request) {
      extras.calls.push(`agent:${request.index}:${request.prompt}`)
      if (options.spawnDelayMs) await new Promise((r) => setTimeout(r, options.spawnDelayMs))
      return { ok: true, text: options.agentResult ? options.agentResult(request.prompt) : `ok:${request.prompt}` }
    },
    abortAgent() {},
    async invokeAction(actionId, input) {
      extras.actionCalls++
      extras.calls.push(`action:${actionId}:${JSON.stringify(input)}`)
      const result = options.actionHandler ? await options.actionHandler(actionId, input) : { echoed: input }
      return { pluginId: 'p', actionId, result }
    },
    ...(options.prepareAction !== undefined ? { prepareAction: options.prepareAction } : {}),
    ...(options.runGate !== undefined ? { runGate: options.runGate } : {}),
    loadWorkflow() {
      return { ok: false, message: 'no nested workflows in fake host' }
    },
  }
}

/** 直接以返回值计 action 调用次数（真实字段）。 */
function makeCountingActionHost(
  handlerOrOptions?:
    | ((id: string, input: unknown) => unknown)
    | {
        handler?: (id: string, input: unknown) => unknown
        prepareAction?: WorkflowHost['prepareAction']
      },
) {
  let count = 0
  const opts =
    typeof handlerOrOptions === 'function'
      ? { handler: handlerOrOptions }
      : (handlerOrOptions ?? {})
  const host = makeFakeHost({
    actionHandler: (id, input) => {
      count++
      return opts.handler ? opts.handler(id, input) : { n: count }
    },
    ...(opts.prepareAction !== undefined ? { prepareAction: opts.prepareAction } : {}),
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
      agentCap: 10,
    })
    setTimeout(() => controller.abort(), 150)
    const result = await promise
    assert.ok(result.status === 'killed' || result.status === 'failed', `status: ${result.status}`)
  })

  it('terminates a synchronous spin loop via worker terminate', timeout, async () => {
    const host = makeFakeHost()
    const controller = new AbortController()
    const promise = runWorkflow({ script: META('spin-sync') + 'while (true) {}', host, signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    const result = await promise
    assert.equal(result.status, 'killed')
  })

  it('leaves no worker threads behind after abort', timeout, async () => {
    const host = makeFakeHost()
    const controller = new AbortController()
    const promise = runWorkflow({ script: META('spin2') + 'while (true) {}', host, signal: controller.signal })
    setTimeout(() => controller.abort(), 200)
    await promise
    // worker_threads 无公开列表 API；用 process._getActiveHandles 粗查无未关闭句柄暴涨。
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

  it('caps of zero/negative/non-integer are rejected by the service (deadlock guard)', timeout, async () => {
    const make = (opts: { concurrency?: number; agentCap?: number }) =>
      () =>
        new WorkflowService({
          dataDir: mkdtempSync(join(tmpdir(), 'wf-caps-')),
          host: makeServiceHost(),
          state: makeStateStore(),
          ...opts,
        })
    // 构造即拒绝（零许可信号量会让 run 在首个调度点死锁）。
    assert.throws(make({ concurrency: 0 }), /正整数/)
    assert.throws(make({ agentCap: -1 }), /正整数/)
    assert.throws(make({ agentCap: 0 }), /正整数/)
    assert.throws(make({ agentCap: 1.5 }), /正整数/)
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
      // 纯文本命令（如 "true"）通过；含 exit/fail 语义的失败。
      const ok = command === 'true'
      return { ok, output: `gate:${command}` }
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
      if (e.type === 'agent') entries.push({ v: 1, seq: entries.length, ...e } as WorkflowJournalEntry)
    }

    // 第一次 run：两个 agent。
    const host1 = makeFakeHost()
    await runWorkflow({
      script: META('j1') + 'const a = await agent("one")\nconst b = await agent("two")\nreturn [a, b]',
      host: host1,
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
      host: host2,
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
      host: host3,
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

  it('inconsistent journal line (plain agent key falsely marked resumed:true) is rejected as cache and runs live', timeout, async () => {
    // 普通调用（keyInput 无 resume）的账本行不可能携带 resumed:true：这是
    // 伪造/不一致 fixture，不得当合法缓存复用。注意：真正的 resume 调用行
    // （key 含 resume 槽）已合法参与逐项前缀匹配（见 workflow-resume-replay
    // 套件的副作用零重复回归），不再整段禁用重放。
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
    assert.equal(result.value, 'ok:p', 'live result, not the forged cached text')
    assert.equal(spawns, 1, 'inconsistent resumed mark must not be replayed as cache')
    assert.equal(result.replayedCount, 0)
  })
})

// ---------------------------------------------------------------------------
// action 原语与账本
// ---------------------------------------------------------------------------

describe('workflow action primitive', () => {
  it('action results replay from journal without re-execution (side-effect safety)', timeout, async () => {
    const { host, getCount } = makeCountingActionHost()
    const appends: JournalWriteInput[] = []
    const append = (e: JournalWriteInput) => {
      if (e.type === 'action' || e.type === 'action_started') appends.push(e)
    }

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

  it('action key mismatch (changed input) runs live for idempotent action', timeout, async () => {
    const { host, getCount } = makeCountingActionHost()
    const lines: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'action_started', index: 0, key: actionJournalKey('p.echo', '{"x":1}'), idempotent: true },
      { v: 1, seq: 1, type: 'action', index: 0, key: actionJournalKey('p.echo', '{"x":1}'), ok: true, result: { n: 1 }, idempotent: true },
    ]
    const result = await runWorkflow({
      script: META('a2') + 'const v = await action("p.echo", { x: 999 }, { idempotent: true })\nreturn v',
      host,
      journal: { entries: lines, append: () => {} },
    })
    assert.equal(result.status, 'completed')
    assert.equal(getCount(), 1, 'changed input runs live for idempotent action')
    assert.deepEqual(result.value, { n: 1 })
  })

  it('action key mismatch for non-idempotent action rejects replay to prevent repeating side effects', timeout, async () => {
    const { host, getCount } = makeCountingActionHost()
    const lines: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'action_started', index: 0, key: actionJournalKey('p.echo', '{"x":1}') },
      { v: 1, seq: 1, type: 'action', index: 0, key: actionJournalKey('p.echo', '{"x":1}'), ok: true, result: { n: 1 } },
    ]
    const result = await runWorkflow({
      script: META('a2-non-idem') + 'const v = await action("p.echo", { x: 999 })\nreturn v',
      host,
      journal: { entries: lines, append: () => {} },
    })
    assert.equal(result.status, 'failed')
    assert.equal(getCount(), 0, 'must not run live on non-idempotent input mismatch')
    assert.match(result.error ?? '', /workflow_action_uncertain/)
  })

  it('resume with failed idempotent action and non-idempotent action suffix rejects entering live', timeout, async () => {
    let nonIdemCalled = 0
    let idemCalled = 0
    const host = makeFakeHost({
      actionHandler: (id) => {
        if (id === 'p.non_idem') {
          nonIdemCalled++
          return { sent: true }
        }
        idemCalled++
        return { read: true }
      },
    })
    const key0 = actionJournalKey('p.idem', '{}')
    const key1 = actionJournalKey('p.non_idem', '{}')
    const lines: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'action_started', index: 0, key: key0, idempotent: true },
      { v: 1, seq: 1, type: 'action', index: 0, key: key0, ok: false, error: 'temp fail', idempotent: true },
      { v: 1, seq: 2, type: 'action_started', index: 1, key: key1 },
      { v: 1, seq: 3, type: 'action', index: 1, key: key1, ok: true, result: { sent: true } },
    ]
    const result = await runWorkflow({
      script:
        META('idem-fail-non-idem-suffix') +
        `
        const r0 = await action("p.idem", {}, { idempotent: true })
        const r1 = await action("p.non_idem", {})
        return [r0, r1]
      `,
      host,
      journal: { entries: lines, append: () => {} },
    })
    assert.equal(result.status, 'failed')
    assert.equal(nonIdemCalled, 0, 'must not call non-idempotent action handler on unsafe suffix')
    assert.equal(idemCalled, 0, 'must block replay before live execution')
    assert.match(result.error ?? '', /workflow_action_uncertain/)
  })

  it('a fatal replay conflict cannot be caught or bypassed by concurrent calls', timeout, async () => {
    for (const body of [
      'try { await action("p.read", {}) } catch {} return await action("p.write", {})',
      'return await parallel([() => action("p.read", {}), () => action("p.write", {})])',
    ]) {
      const { host, getCount } = makeCountingActionHost()
      const result = await runWorkflow({
        script: META('fatal-replay-guard') + body,
        host,
        journal: {
          entries: [
            { v: 1, seq: 0, type: 'action', index: 0, key: actionJournalKey('p.read', '{}'), ok: false, idempotent: true },
            { v: 1, seq: 1, type: 'action', index: 1, key: actionJournalKey('p.write', '{}'), ok: true, result: {} },
          ],
          append: () => {},
        },
      })
      assert.equal(result.status, 'failed', result.error)
      assert.match(result.error ?? '', /workflow_action_uncertain/)
      assert.equal(getCount(), 0, 'fatal replay conflicts must stop every subsequent handler')
    }
  })

  it('resume with all idempotent actions in suffix safely proceeds to live retry', timeout, async () => {
    let act0Called = 0
    let act1Called = 0
    const host = makeFakeHost({
      actionHandler: (id) => {
        if (id === 'p.idem0') {
          act0Called++
          return { v: 0 }
        }
        act1Called++
        return { v: 1 }
      },
    })
    const key0 = actionJournalKey('p.idem0', '{}')
    const key1 = actionJournalKey('p.idem1', '{}')
    const lines: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'action_started', index: 0, key: key0, idempotent: true },
      { v: 1, seq: 1, type: 'action', index: 0, key: key0, ok: false, error: 'retryable', idempotent: true },
      { v: 1, seq: 2, type: 'action_started', index: 1, key: key1, idempotent: true },
      { v: 1, seq: 3, type: 'action', index: 1, key: key1, ok: true, result: { v: 1 }, idempotent: true },
    ]
    const result = await runWorkflow({
      script:
        META('all-idem-suffix') +
        `
        const r0 = await action("p.idem0", {}, { idempotent: true })
        const r1 = await action("p.idem1", {}, { idempotent: true })
        return [r0, r1]
      `,
      host,
      journal: { entries: lines, append: () => {} },
    })
    assert.equal(result.status, 'completed')
    assert.equal(act0Called, 1, 'idempotent action 0 retried live')
    assert.equal(act1Called, 1, 'idempotent action 1 re-executed live')
    assert.deepEqual(result.value, [{ v: 0 }, { v: 1 }])
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

  it('replay bookkeeping failure is fatal, not silently tolerated', timeout, async () => {
    // 重放命中后向新账本补记终态行失败：必须 fatal（否则新 run 账本缺终态，
    // 下次 resume 可能重执行该 action 的副作用）。
    const { host, getCount } = makeCountingActionHost()
    const lines: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'action_started', index: 0, key: actionJournalKey('p.echo', '{"x":1}') },
      { v: 1, seq: 1, type: 'action', index: 0, key: actionJournalKey('p.echo', '{"x":1}'), ok: true, result: { n: 1 } },
    ]
    const result = await runWorkflow({
      script: META('a-replay-fatal') + 'const v = await action("p.echo", { x: 1 })\nreturn v',
      host,
      journal: {
        entries: lines,
        append: async () => {
          throw new Error('disk full')
        },
      },
    })
    assert.equal(result.status, 'failed', 'replay bookkeeping failure must fail the run')
    assert.ok(result.error!.includes('replay bookkeeping failed'), result.error)
    assert.equal(getCount(), 0, 'no side effect during replay')
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

  it('agent and action share one ordered index space and obey concurrency semaphore', timeout, async () => {
    let currentInFlight = 0
    let maxInFlight = 0
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    const host = makeFakeHost({
      spawnDelayMs: 40,
      actionHandler: async () => {
        currentInFlight++
        maxInFlight = Math.max(maxInFlight, currentInFlight)
        await delay(40)
        currentInFlight--
        return { ok: true }
      },
    })
    const realSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (req) => {
      currentInFlight++
      maxInFlight = Math.max(maxInFlight, currentInFlight)
      try {
        return await realSpawn(req)
      } finally {
        currentInFlight--
      }
    }

    const result = await runWorkflow({
      script:
        META('mixed-concurrency') +
        `
        const a = agent("first")
        const act = action("p.echo", {})
        const b = agent("second")
        const act2 = action("p.echo2", {})
        return [await a, await act, await b, await act2]
      `,
      host,
      concurrency: 2,
      journal: { append: () => {} },
    })

    assert.equal(result.status, 'completed')
    // 验证并发上限严格为 2
    assert.ok(maxInFlight <= 2, `max in-flight must obey concurrency:2, was ${maxInFlight}`)
    assert.ok(maxInFlight >= 2, `expected concurrency of 2 reached, was ${maxInFlight}`)

    // 验证 index 分配严格单调
    const indices = result.progress
      .filter((p) => p.type === 'workflow_agent' || p.type === 'workflow_action')
      .map((p) => `${p.type}@${p.index}`)
    assert.ok(indices.includes('workflow_agent@0'))
    assert.ok(indices.includes('workflow_action@1'))
    assert.ok(indices.includes('workflow_agent@2'))
    assert.ok(indices.includes('workflow_action@3'))
  })

  it('aborted workflow does not execute queued actions behind semaphore', timeout, async () => {
    let actionCount = 0
    let agentCount = 0
    const abortCtrl = new AbortController()

    const host = makeFakeHost({
      actionHandler: async (id) => {
        actionCount++
        if (id === 'p.slow') {
          // 在执行慢动作时触发中止
          abortCtrl.abort()
          await new Promise((r) => setTimeout(r, 50))
        }
        return { ok: true }
      },
    })
    const realSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (req) => {
      agentCount++
      return realSpawn(req)
    }

    const result = await runWorkflow({
      script:
        META('abort-queue') +
        `
        const a1 = action("p.slow", {})
        const a2 = action("p.queued", {})
        const ag = agent("queued agent")
        return [await a1, await a2, await ag]
      `,
      host,
      concurrency: 1,
      signal: abortCtrl.signal,
    })

    assert.equal(result.status, 'killed')
    // 只有首个 slow 启动了，队列中的 a2 与 ag 绝不被调用
    assert.equal(actionCount, 1)
    assert.equal(agentCount, 0)
  })

  it('prepareAction pre-flight rejection writes idempotent failure line without action_started', timeout, async () => {
    let prepareCalls = 0
    const appends: JournalWriteInput[] = []
    const append = (e: JournalWriteInput) => {
      appends.push(e)
    }

    const { host, getCount } = makeCountingActionHost({
      prepareAction: (actionId) => {
        prepareCalls++
        throw new Error(`Pre-flight rejection for ${actionId}`)
      },
    })

    const result = await runWorkflow({
      script: META('prep-reject') + 'const v = await action("p.bad", { x: 1 })\nreturn v',
      host,
      journal: { append },
    })

    assert.equal(result.status, 'completed')
    // handler 绝对未执行
    assert.equal(getCount(), 0)
    assert.equal(prepareCalls, 1)
    // 失败折叠为 null
    assert.equal(result.value, null)

    // 绝无 action_started，只有一条 ok:false 且带有 idempotent:true 的 action 终态行
    assert.equal(appends.some((e) => e.type === 'action_started'), false)
    const actionLines = appends.filter((e) => e.type === 'action')
    assert.equal(actionLines.length, 1)
    assert.equal(actionLines[0]?.ok, false)
    assert.equal(actionLines[0]?.idempotent, true)

    // 验证由该 appends 构建的账本，readJournal 确认 actionUncertain 为 false
    const path = tmpJournalPath('prep-fail.jsonl')
    const writer = new JournalWriter(path)
    for (const line of appends) await writer.append(line)
    await writer.close()
    const read = readJournal(path)
    assert.equal(read.actionUncertain, false)
    assert.equal(read.failedActions, 0)
  })

  it('action() opts validation and label/phase propagation', timeout, async () => {
    const { host } = makeCountingActionHost()
    // 1) 正常传递 opts (idempotent, label, phase)
    const result = await runWorkflow({
      script:
        META('opts-ok') +
        `
        phase("init-phase")
        const res = await action("p.echo", { k: "v" }, { label: "custom-label", phase: "override-phase", idempotent: true })
        return res
      `,
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'completed')
    const actNode = result.progress.find((p) => p.type === 'workflow_action') as Extract<
      WorkflowEntry,
      { type: 'workflow_action' }
    >
    assert.ok(actNode)
    assert.equal(actNode.label, 'custom-label')
    assert.equal(actNode.phaseTitle, 'override-phase')

    // 2) 未知 opts 键报错
    const badKeyRes = await runWorkflow({
      script: META('opts-bad-key') + 'await action("p.echo", {}, { unknownKey: true })\nreturn 1',
      host,
    })
    assert.equal(badKeyRes.status, 'failed')
    assert.match(badKeyRes.error ?? '', /action\(\) unknown option 'unknownKey'/)

    // 3) 非布尔 idempotent 报错
    const badIdemRes = await runWorkflow({
      script: META('opts-bad-idem') + 'await action("p.echo", {}, { idempotent: "true" })\nreturn 1',
      host,
    })
    assert.equal(badIdemRes.status, 'failed')
    assert.match(badIdemRes.error ?? '', /action\(\) opts.idempotent must be a boolean/)
  })

  it('idempotent action replay semantics: ok:true replays without re-execution, ok:false allowed to resume', timeout, async () => {
    const { host, getCount } = makeCountingActionHost({
      prepareAction: (actionId) => ({ pluginId: 'p', actionId, idempotent: true }),
    })
    const appends: JournalWriteInput[] = []
    const append = (e: JournalWriteInput) => {
      appends.push(e)
    }

    // 第一次运行成功，记录账本
    const r1 = await runWorkflow({
      script: META('idem-replay') + 'const v = await action("p.echo", { a: 1 }, { idempotent: true })\nreturn v',
      host,
      journal: { append },
    })
    assert.equal(r1.status, 'completed')
    assert.equal(getCount(), 1)

    // 转换为 JournalEntry 列表并重放：幂等动作成功时 100% 缓存复用，handler 不重复执行
    const lines: WorkflowJournalEntry[] = appends.map((e, i) => ({ v: 1, seq: i, ...e }) as WorkflowJournalEntry)
    const r2 = await runWorkflow({
      script: META('idem-replay') + 'const v = await action("p.echo", { a: 1 }, { idempotent: true })\nreturn v',
      host,
      journal: { entries: lines, append: () => {} },
    })
    assert.equal(r2.status, 'completed')
    assert.equal(getCount(), 1, 'idempotent action on replay must reuse result without re-executing')
    assert.equal(r2.replayedCount, 1)

    // 若原账本中幂等动作失败（ok: false, idempotent: true）：
    const failKey = actionJournalKey('p.echo', '{"a":1}')
    const failLines: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'action_started', index: 0, key: failKey, idempotent: true },
      { v: 1, seq: 1, type: 'action', index: 0, key: failKey, ok: false, error: 'transient error', idempotent: true },
    ]
    // 写入文件并用 readJournal 验证 actionUncertain 为 false
    const failJournalPath = tmpJournalPath('idem-fail.jsonl')
    const writer = new JournalWriter(failJournalPath)
    for (const l of failLines) await writer.append(l)
    await writer.close()
    const readFail = readJournal(failJournalPath)
    assert.equal(readFail.actionUncertain, false, 'idempotent failure must not lock journal uncertain')
    assert.equal(readFail.failedActions, 0)
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

  it('dangling action_started (crash mid-execution) reports actionUncertain regardless of seq position', timeout, async () => {
    const path = tmpJournalPath('dangling.jsonl')
    const writer = new JournalWriter(path)
    await writer.append({ type: 'agent', index: 0, key: 'k0', ok: true, text: 'a' })
    await writer.append({ type: 'action_started', index: 1, key: 'k1' })
    await writer.close()
    const read = readJournal(path)
    assert.equal(read.actionUncertain, true)
    // started 之后又写了 agent 行（seq 更大）也必须 uncertain：终态行可能因
    // 损坏丢失，"started 落盘后 handler 被允许执行"是唯一事实。
    const path2 = tmpJournalPath('dangling-mid.jsonl')
    const w2 = new JournalWriter(path2)
    await w2.append({ type: 'action_started', index: 1, key: 'k1' })
    await w2.append({ type: 'agent', index: 0, key: 'k0', ok: true, text: 'after' })
    await w2.close()
    assert.equal(readJournal(path2).actionUncertain, true)
  })

  it('failed action terminal line (ok:false) is uncertain for resume (side effect may have happened)', timeout, async () => {
    const path = tmpJournalPath('failed-action.jsonl')
    const writer = new JournalWriter(path)
    await writer.append({ type: 'action_started', index: 0, key: 'k0' })
    await writer.append({ type: 'action', index: 0, key: 'k0', ok: false, error: 'boom' })
    await writer.close()
    const read = readJournal(path)
    assert.equal(read.actionUncertain, true)
    assert.equal(read.failedActions, 1)
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

  it('unknown-type parsed line is conservatively uncertain (not guessed as agent)', timeout, async () => {
    const path = tmpJournalPath('unknown-type.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({ v: 1, seq: 0, type: 'agent', index: 0, key: 'k0', ok: true, text: 'a' }),
        JSON.stringify({ v: 1, seq: 1, type: 'gate', index: 1, key: 'kx', ok: true }),
        '',
      ].join('\n'),
    )
    const read = readJournal(path)
    assert.equal(read.actionUncertain, true, 'unknown line type must be conservatively uncertain')
    assert.ok(read.ioErrors >= 1)
  })

  it('truncated agent-only tail counts ioErrors but stays replayable', timeout, async () => {
    const path = tmpJournalPath('agenttail.jsonl')
    const writer = new JournalWriter(path)
    await writer.append({ type: 'agent', index: 0, key: 'k0', ok: true, text: 'a' })
    await writer.close()
    // 引擎 writer 的行序：{ ...entry, v, seq } → type 在首键。
    writeFileSync(path, '{"type":"agent","index":0,"key":"k0","ok":tr', { flag: 'a' })
    const read = readJournal(path)
    assert.equal(read.actionUncertain, false)
    assert.ok(read.ioErrors >= 1)
    assert.equal(read.entries.length, 1)
  })

  it('unreadable journal file (EISDIR) reports readFailed + uncertain; missing file (ENOENT) is empty', timeout, async () => {
    // chmod 000 对 root 无效；目录路径产生真实 EISDIR 读错误（非 ENOENT）。
    const path = tmpJournalPath('eisdir.jsonl')
    mkdirSync(path, { recursive: true })
    const read = readJournal(path)
    assert.equal(read.actionUncertain, true)
    assert.ok(read.readFailed !== undefined, 'readFailed must be reported')
    assert.equal(read.readFailed!.code, 'EISDIR')
    const missing = readJournal(join(tmpJournalPath('missing-dir'), 'nope.jsonl'))
    assert.equal(missing.actionUncertain, false)
    assert.equal(missing.entries.length, 0)
    assert.equal(missing.readFailed, undefined)
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

  it('dangling action_started with idempotent:true reports actionUncertain as false', timeout, async () => {
    const path = tmpJournalPath('idem-dangling.jsonl')
    const writer = new JournalWriter(path)
    await writer.append({ type: 'agent', index: 0, key: 'k0', ok: true, text: 'a' })
    await writer.append({ type: 'action_started', index: 1, key: 'k1', idempotent: true })
    await writer.close()
    const read = readJournal(path)
    assert.equal(read.actionUncertain, false, 'dangling idempotent action_started should not be uncertain')
  })

  it('failed action with idempotent:true reports actionUncertain as false and failedActions=0', timeout, async () => {
    const path = tmpJournalPath('idem-failed.jsonl')
    const writer = new JournalWriter(path)
    await writer.append({ type: 'action_started', index: 0, key: 'k0', idempotent: true })
    await writer.append({ type: 'action', index: 0, key: 'k0', ok: false, error: 'err', idempotent: true })
    await writer.close()
    const read = readJournal(path)
    assert.equal(read.actionUncertain, false, 'idempotent ok:false action must not make journal uncertain')
    assert.equal(read.failedActions, 0)
  })

  it('invalid idempotent value (non-boolean/false) is treated as corrupt uncertain', timeout, async () => {
    const path = tmpJournalPath('idem-corrupt.jsonl')
    writeFileSync(path, '{"v":1,"seq":0,"type":"action_started","index":0,"key":"k0","idempotent":false}\n')
    const read = readJournal(path)
    assert.equal(read.actionUncertain, true, 'idempotent:false or invalid must be treated as corrupt/uncertain')
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

/** 可注入故障的 state store：flush 按计数抛错。 */
function makeFailingFlushStore(failAfter: number): WorkflowStateStore & { flushes: number } {
  const inner = makeStateStore()
  let flushes = 0
  const store: WorkflowStateStore & { flushes: number } = {
    get: inner.get,
    set: inner.set,
    get flushes() {
      return flushes
    },
    async flush() {
      flushes++
      if (flushes > failAfter) throw new Error('simulated store flush failure')
    },
  }
  return store
}

interface ServiceHostExtras {
  spawns: Array<Record<string, unknown>>
  actionCount: () => number
  aborted: number[]
  abortConversation: WorkflowServiceHost['abortConversation']
}

function makeServiceHost(options: { actionFail?: boolean } = {}): WorkflowServiceHost & ServiceHostExtras {
  let actionCount = 0
  const spawns: Array<Record<string, unknown>> = []
  const aborted: number[] = []
  const host: WorkflowServiceHost & ServiceHostExtras = {
    spawns,
    aborted,
    async spawnAgent(request) {
      spawns.push(request as unknown as Record<string, unknown>)
      return typeof request.schema === 'undefined' ? `text:${request.prompt}` : { structured: true }
    },
    async invokeAction(_pluginId, _actionId, input) {
      actionCount++
      if (options.actionFail) throw new Error('action boom')
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
    async abortConversation(id: number) {
      aborted.push(id)
    },
    emitEvent() {},
    actionCount: () => actionCount,
  }
  return host
}

describe('WorkflowService', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-service-'))

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

  it('bad meta fails terminally in the record (not left running)', timeout, async () => {
    const host = makeServiceHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    // 坏 meta：meta 块插值——引擎 validate 前 extractMeta 即抛。
    const summary = await service.run({
      script: 'export const meta = { name: `bad${1}`, description: "d" }\nreturn 1',
    })
    await service.wait(summary.id)
    const final = service.getRun(summary.id)
    assert.equal(final.status, 'failed', 'bad meta must reach a failed terminal state')
    assert.ok(final.error !== undefined && final.error.length > 0)
    // 状态 store 里的 record 也必须是终态（跨重启不再依赖内存 summary）。
    const record = state.get<{ status: string } | null>(`workflow/run/${summary.id}`, null)
    assert.ok(record !== null)
    assert.equal(record.status, 'failed')
    await service.close()
  })

  it('store flush failure after run leaves no dangling active and wait reports the failure', timeout, async () => {
    const host = makeServiceHost()
    // 首次 flush（running 快照）成功，此后全部失败——终态写入失败。
    const state = makeFailingFlushStore(1)
    const service = new WorkflowService({ dataDir, host, state })
    const summary = await service.run({ script: META('svc-flush') + 'return 42' })
    // wait 必须如实抛出终态落盘失败，不假成功。
    await assert.rejects(
      () => service.wait(summary.id),
      /simulated store flush failure/,
    )
    // active 必须已摘除（不留假 running），getRun 回落 store 仍可 inspect。
    // （内存 summary 的 error 已附 persist failed 说明。）
    const record = state.get<{ status: string } | null>(`workflow/run/${summary.id}`, null)
    assert.ok(record !== null)
    // 写入 store 的终态可能成功（set 同步镜像先于 flush），关键是明确失败已上报。
    // close 对已损坏的 store 同样如实抛 flush 错误（诚实传播，非静默）。
    await assert.rejects(() => service.close(), /simulated store flush failure/)
  })

  it('first state flush failure rejects run without leaving active or writer', timeout, async () => {
    const host = makeServiceHost()
    const state = makeFailingFlushStore(0) // 首次 flush 即失败
    const service = new WorkflowService({ dataDir, host, state })
    await assert.rejects(
      () => service.run({ script: META('svc-flush0') + 'return 1' }),
      /simulated store flush failure/,
    )
    // 不留 active：abort 对不存在的 run 报 not_found（而非假 running）。
    await assert.rejects(() => service.abort('wf_nonexistent0000'), /不存在/)
    await assert.rejects(() => service.close(), /simulated store flush failure/)
  })

  it('ambiguous short action id is rejected; fully qualified works', timeout, async () => {
    const host = makeServiceHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    const bad = await service.run({
      script: META('svc2') + 'const v = await action("update.memory", {})\nreturn v',
    })
    const badResult = await service.wait(bad.id)
    // 歧义短 id 在 resolveActionId 抛 HelmError；引擎把 action 失败折叠为 null。
    assert.equal(badResult, null)
    const badSummary = service.getRun(bad.id)
    const nodes = badSummary.nodes ?? []
    const actionNode = nodes.find((n) => n.kind === 'action')
    assert.ok(actionNode !== undefined, 'action node present')
    assert.equal(actionNode!.status, 'failed')
    assert.ok((actionNode!.error ?? '').includes('命中多个插件'), actionNode!.error)

    const good = await service.run({
      script: META('svc3') + 'const v = await action("builtin:assistant.update.memory", {})\nreturn v',
    })
    const goodResult = await service.wait(good.id)
    assert.deepEqual(goodResult, { ok: true, n: 1, input: {} })
    await service.close()
  })

  it('abort kills the run and awaits in-flight child conversation aborts', timeout, async () => {
    let resolveSpawn: (() => void) | undefined
    let spawned = 0
    let childConvId = 0
    const host = makeServiceHost()
    const realSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (request) => {
      spawned++
      childConvId = 100 + spawned
      request.onResolved?.({ conversationId: childConvId })
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
    // abort 返回时子会话中止已确被执行（不再是 fire-and-forget）。
    assert.deepEqual(host.aborted, [childConvId])
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
    const record = state.get<{ journalPath: string } | null>(`workflow/run/${first.id}`, null)
    assert.ok(record !== null)
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

  it('resume with failed-action journal is rejected (side effect may have happened)', timeout, async () => {
    const host = makeServiceHost({ actionFail: true })
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const first = await service.run({
      script: META('svc-failed-action') + 'const v = await action("builtin:assistant.update.memory", {})\nreturn v',
    })
    await service.wait(first.id)
    assert.equal(host.actionCount(), 1)
    const record0 = state.get<{ journalPath: string } | null>(`workflow/run/${first.id}`, null)
    assert.ok(record0 !== null)

    // handler 抛错的 action 终态行 ok:false：resume 必须拒绝自动重试。
    await assert.rejects(
      () => service.run({ resumeFromRunId: first.id }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'workflow_action_uncertain')
        assert.ok((error as HelmError).message.includes('ok:false'))
        return true
      },
    )
    assert.equal(host.actionCount(), 1, 'failed action must not auto-retry on resume')
    await service.close()
  })

  it('resume with unreadable journal rejects with journal_read_failed (never empty-ledger rerun)', timeout, async () => {
    const host = makeServiceHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const first = await service.run({
      script: META('svc-unreadable') + 'const a = await agent("one")\nconst b = await agent("two")\nreturn [a, b]',
    })
    await service.wait(first.id)
    const record = state.get<{ journalPath: string } | null>(`workflow/run/${first.id}`, null)
    assert.ok(record !== null)
    const spawnsBefore = host.spawns.length
    // 用目录顶替 journal 文件：真实 EISDIR 读错误（root 下 chmod 无效）。
    rmSync(record.journalPath)
    mkdirSync(record.journalPath)
    try {
      await assert.rejects(
        () => service.run({ resumeFromRunId: first.id }),
        (error: unknown) => {
          assert.ok(error instanceof HelmError)
          assert.equal(error.code, 'journal_read_failed')
          return true
        },
      )
      // 未执行任何 handler：假空账本重跑是本次修复的红线。
      assert.equal(host.spawns.length, spawnsBefore)
    } finally {
      rmSync(record.journalPath, { recursive: true, force: true })
    }
    await service.close()
  })

  it('args are persisted and reused on resume (deterministic branches preserved)', timeout, async () => {
    const host = makeServiceHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const first = await service.run({
      script: META('svc-args') + 'const a = await agent(args.topic)\nreturn a',
      args: { topic: 'hello' },
    })
    await service.wait(first.id)
    assert.equal(service.getRun(first.id).result, 'text:hello')

    // resume 不带 args：沿用原 args（确定性分支不变），且全部重放（0 spawn）。
    const resumed = await service.run({ resumeFromRunId: first.id })
    await service.wait(resumed.id)
    assert.equal(host.spawns.length, 1, 'only the first run spawned')
    assert.equal(service.getRun(resumed.id).result, 'text:hello')

    // 显式提供不同 args 允许失配转 live。
    const changed = await service.run({ resumeFromRunId: first.id, args: { topic: 'changed' } })
    await service.wait(changed.id)
    assert.equal(host.spawns.length, 2)
    assert.equal(service.getRun(changed.id).result, 'text:changed')
    await service.close()
  })

  it('concurrent runs namespace agentIds (no cross-run clobber in global agentSessions)', timeout, async () => {
    // 引擎内 agentId 是 wf-agent-N，跨 run 重复。service 必须给投给宿主的
    // proto.agentId 加 runId 前缀，否则 KernelRuntime 的全局 agentSessions
    // 会互相覆盖，两个同 parent 的并行 run 会续接错 child。
    const host = makeServiceHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore(), concurrency: 4 })
    const [s1, s2] = await Promise.all([
      service.run({ script: META('conc-id-1') + 'const a = await agent("one")\nreturn a' }),
      service.run({ script: META('conc-id-2') + 'const a = await agent("two")\nreturn a' }),
    ])
    await Promise.all([service.wait(s1.id), service.wait(s2.id)])
    assert.equal(host.spawns.length, 2)
    const agentIds = host.spawns.map((r) => r['agentId'])
    assert.notEqual(agentIds[0], agentIds[1], 'proto.agentId must be namespaced per run')
    for (const id of agentIds) {
      assert.ok(typeof id === 'string' && /^wf_[0-9a-f]+:wf-agent-\d+$/.test(id), `namespaced id: ${String(id)}`)
    }
    await service.close()
  })

  it('resume uses this-run convId first (two parallel runs with resume do not cross wires)', timeout, async () => {
    // 每个 run 各 spawn 一个 agent（不同 child conv），再 resume 该 agent：
    // resume ref 必须解析到本 run 的 child，不能经全局映射串到另一 run。
    let nextConv = 500
    const resumeRefs: string[][] = []
    const host = makeServiceHost()
    const realSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (request) => {
      if (request.resume !== undefined) {
        resumeRefs.push([String(request.agentId), String(request.resume)])
        return `resumed:${request.resume}`
      }
      const convId = ++nextConv
      request.onResolved?.({ conversationId: convId })
      return realSpawn(request)
    }
    const service = new WorkflowService({ dataDir, host, state: makeStateStore(), concurrency: 4 })
    const script = (name: string, tag: string) =>
      META(name) +
      `const a = await agent("${tag}")\nconst b = await agent("${tag}", { resume: "${tag}" })\nreturn [a, b]`
    const [s1, s2] = await Promise.all([
      service.run({ script: script('conc-res-1', 'left') }),
      service.run({ script: script('conc-res-2', 'right') }),
    ])
    await Promise.all([service.wait(s1.id), service.wait(s2.id)])
    assert.equal(resumeRefs.length, 2, 'each run resumed its own agent')
    // resume ref 必须是本 run 记录的 convId（纯数字），不是 agentId 字符串。
    for (const [agentId, ref] of resumeRefs) {
      assert.ok(ref !== undefined && /^\d+$/.test(ref), `resume must use this-run convId, got "${String(ref)}" for ${String(agentId)}`)
    }
    // agentId 已带 runId 命名空间：按 run 过滤（完成顺序可能跨 run 交错）。
    const refOf = (runId: string): number => {
      const hit = resumeRefs.find(([agentId]) => String(agentId).startsWith(`${runId}:`))
      assert.ok(hit !== undefined, `run ${runId} must have its own resume ref`)
      return Number(hit[1])
    }
    const conv1 = refOf(s1.id)
    const conv2 = refOf(s2.id)
    assert.notEqual(conv1, conv2, 'two runs must resume distinct children')
    // 各 run 结果自洽：resume 返回以自己 convId 为后缀。
    const r1 = (service.getRun(s1.id).result ?? []) as string[]
    const r2 = (service.getRun(s2.id).result ?? []) as string[]
    assert.ok(r1[1] !== undefined && r1[1].endsWith(String(conv1)), `r1=${JSON.stringify(r1)} conv1=${conv1}`)
    assert.ok(r2[1] !== undefined && r2[1].endsWith(String(conv2)), `r2=${JSON.stringify(r2)} conv2=${conv2}`)
    await service.close()
  })

  it('leftover running record from a previous process is marked failed on next run', timeout, async () => {
    const state = makeStateStore()
    const host = makeServiceHost()
    // 预置一条 running 记录（模拟进程死亡）。
    state.set('workflow/runs', [{ id: 'wf_deadbeef0000', conversationId: 1, createdAt: 1 }])
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
    await service.init()
    const summary = service.getRun('wf_deadbeef0000')
    assert.equal(summary.status, 'failed')
    assert.ok(summary.error!.includes('interrupted'))
    await service.close()
  })

  it('init failure is retryable (a crashed first init does not permanently mark recovered)', timeout, async () => {
    // 提交型 store：set 序列化入缓冲、get 解析返回副本（对齐真实 documentStore
    // / 8d10ef7 语义：flush 失败 = 写未持久，读回仍见 running；对象引用不互串）。
    const committed = new Map<string, string>()
    const pending = new Map<string, string>()
    let flushOk = false
    const state: WorkflowStateStore = {
      get<T>(key: string, initial: T): T {
        const raw = committed.get(key)
        if (raw === undefined) return initial
        return JSON.parse(raw) as T
      },
      set<T>(key: string, value: T): void {
        pending.set(key, JSON.stringify(value))
      },
      async flush() {
        if (!flushOk) throw new Error('simulated store flush failure')
        for (const [k, v] of pending) committed.set(k, v)
        pending.clear()
      },
    }
    // 预置 running 记录（已提交）。
    committed.set(
      'workflow/runs',
      JSON.stringify([{ id: 'wf_deadbeef0001', conversationId: 1, createdAt: 1 }]),
    )
    committed.set(
      'workflow/run/wf_deadbeef0001',
      JSON.stringify({
        id: 'wf_deadbeef0001',
        name: 'old',
        conversationId: 1,
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        journalPath: join(dataDir, 'artifacts', '1', 'workflow-wf_deadbeef0001.jsonl'),
      }),
    )
    const host = makeServiceHost()
    const service = new WorkflowService({ dataDir, host, state })
    // 首次 init：标记写入缓冲但 flush 失败——读回仍 running，且未标 recovered。
    await assert.rejects(() => service.init(), /simulated store flush failure/)
    assert.equal(
      state.get<{ status: string } | null>('workflow/run/wf_deadbeef0001', null)?.status,
      'running',
      'uncommitted mark must not be visible',
    )
    // 重试必须重新执行恢复（而非静默跳过）：flush 仍失败，再次如实抛错。
    await assert.rejects(() => service.init(), /simulated store flush failure/)
    // store 修复后重试：完整成功并提交 failed 终态。
    flushOk = true
    await service.init()
    assert.equal(service.getRun('wf_deadbeef0001').status, 'failed')
    await service.close()
  })

  it('redact hook scrubs string values in persisted args/result/error (value-level, not stringify)', timeout, async () => {
    const SECRET = 'sk-super-secret-123'
    const host = makeServiceHost()
    const state = makeStateStore()
    const service = new WorkflowService({
      dataDir,
      host,
      state,
      redact: (text) => text.replaceAll(SECRET, '{{REDACTED}}'),
    })
    const summary = await service.run({
      script: META('svc-redact') + 'return { nested: { token: args.token }, list: [args.token] }',
      args: { token: SECRET },
    })
    const result = (await service.wait(summary.id)) as { nested: { token: string }; list: string[] }
    // 内存结果保持原值（运行时用原始值）……不：service 持久面统一脱敏，summary/result 也是持久面。
    assert.equal(result.nested.token, '{{REDACTED}}')
    assert.equal(result.list[0], '{{REDACTED}}')
    const record = state.get<{ args?: unknown; result?: unknown } | null>(`workflow/run/${summary.id}`, null)
    assert.ok(!JSON.stringify(record).includes(SECRET), 'persisted record must not contain the secret')
    await service.close()
  })

  it('validates request: exactly one source, safe name, size limit', timeout, async () => {
    const service = new WorkflowService({ dataDir, host: makeServiceHost(), state: makeStateStore() })
    await assert.rejects(() => service.run({ name: 'a', script: 'x' }), /恰好提供一个/)
    await assert.rejects(() => service.run({}), /必须提供/)
    await assert.rejects(() => service.run({ name: '../evil' }), /非法/)
    await assert.rejects(() => service.run({ name: 'x'.repeat(200) }), /非法/)
    await service.close()
  })

  it('saved-name symlink escaping the workflows dir is rejected', timeout, async () => {
    const service = new WorkflowService({ dataDir, host: makeServiceHost(), state: makeStateStore() })
    const dir = join(dataDir, 'workflows')
    mkdirSync(dir, { recursive: true })
    const outside = join(dataDir, 'outside.js')
    writeFileSync(outside, META('outside') + 'return 1')
    const link = join(dir, 'escape.js')
    try {
      rmSync(link, { force: true })
      const { symlinkSync } = await import('node:fs')
      symlinkSync(outside, link)
      await assert.rejects(() => service.run({ name: 'escape' }), /符号链接|非法|不可读/)
    } finally {
      rmSync(link, { force: true })
      rmSync(outside, { force: true })
    }
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

  it('progress timeline is persisted periodically, not only at terminal state', timeout, async () => {
    const host = makeServiceHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    // phase() 声明 + 长脚本：onProgress 节流窗口内落 progress。
    const summary = await service.run({
      script:
        META('svc-progress') +
        `
        phase("working")
        log("step one")
        await agent("slow")
        return 1
      `,
    })
    await service.wait(summary.id)
    const record = state.get<{ progress?: Array<{ kind: string }> } | null>(`workflow/run/${summary.id}`, null)
    assert.ok(record !== null)
    const kinds = (record.progress ?? []).map((p) => p.kind)
    assert.ok(kinds.includes('phase'), `phase persisted: ${JSON.stringify(kinds)}`)
    assert.ok(kinds.includes('log'), `log persisted: ${JSON.stringify(kinds)}`)
    await service.close()
  })

  it('env.exec builtin action executes commands via host.execEnv and handles allowFailure', timeout, async () => {
    const executed: Array<{ command: string | string[]; allowFailure?: boolean }> = []
    const baseHost = makeServiceHost()
    const host: WorkflowServiceHost = {
      ...baseHost,
      execEnv: async (req) => {
        executed.push({ command: req.command })
        if (Array.isArray(req.command) && req.command.includes('fail-cmd')) {
          return { ok: false, exitCode: 1, output: 'command failed output', timedOut: false }
        }
        return { ok: true, exitCode: 0, output: 'hello-env-exec', timedOut: false }
      },
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })

    // 1) 正常执行 env.exec（带 label 与 idempotent: true）
    const summary1 = await service.run({
      script:
        META('env-exec-1') +
        `
        const res = await action("env.exec", { command: ["echo", "hello"] }, { label: "run-echo", idempotent: true })
        return res
      `,
    })
    const res1 = await service.wait(summary1.id)
    assert.deepEqual(res1, { ok: true, exitCode: 0, output: 'hello-env-exec', timedOut: false })
    const run1 = service.getRun(summary1.id)
    assert.equal(run1.status, 'completed')
    const node1 = run1.nodes?.find((n) => n.id === 'action-0')
    assert.equal(node1?.label, 'run-echo')

    // 2) 无冲突短名 exec 解析为 env.exec
    const summary2 = await service.run({
      script: META('env-exec-2') + 'const res = await action("exec", { command: "uptime" })\nreturn res',
    })
    const res2 = await service.wait(summary2.id)
    assert.deepEqual(res2, { ok: true, exitCode: 0, output: 'hello-env-exec', timedOut: false })

    // 3) 非零退出码且 allowFailure 未设：抛 env_exec_failed，节点失败折叠为 null
    const summary3 = await service.run({
      script: META('env-exec-3') + 'const res = await action("env.exec", { command: ["fail-cmd"] })\nreturn res',
    })
    const res3 = await service.wait(summary3.id)
    assert.equal(res3, null)
    const run3 = service.getRun(summary3.id)
    const node3 = run3.nodes?.find((n) => n.id === 'action-0')
    assert.equal(node3?.status, 'failed')
    assert.match(node3?.error ?? '', /命令执行失败.*exitCode=1/)

    // 4) 非零退出码但 allowFailure: true：正常返回结果对象
    const summary4 = await service.run({
      script:
        META('env-exec-4') +
        'const res = await action("env.exec", { command: ["fail-cmd"], allowFailure: true })\nreturn res',
    })
    const res4 = await service.wait(summary4.id)
    assert.deepEqual(res4, { ok: false, exitCode: 1, output: 'command failed output', timedOut: false })

    // 5) 非法参数（如空 command 或未知选项）在 Pre-flight 阶段拒绝，节点折叠为 null 且不记 action_started
    const summary5 = await service.run({
      script: META('env-exec-5') + 'const res = await action("env.exec", { command: "", badField: 123 })\nreturn res',
    })
    const res5 = await service.wait(summary5.id)
    assert.equal(res5, null)
    const run5 = service.getRun(summary5.id)
    const node5 = run5.nodes?.find((n) => n.id === 'action-0')
    assert.equal(node5?.status, 'failed')
    assert.match(node5?.error ?? '', /env\.exec/)

    await service.close()
  })

  it('env.exec fails with 501 when host does not configure execEnv', timeout, async () => {
    const baseHost = makeServiceHost()
    // host 没有 execEnv
    const host: WorkflowServiceHost = {
      ...baseHost,
      execEnv: undefined,
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    const summary = await service.run({
      script: META('env-exec-unsupported') + 'const res = await action("env.exec", { command: "date" })\nreturn res',
    })
    const res = await service.wait(summary.id)
    assert.equal(res, null)
    const run = service.getRun(summary.id)
    const node = run.nodes?.find((n) => n.id === 'action-0')
    assert.equal(node?.status, 'failed')
    assert.match(node?.error ?? '', /当前工作流宿主未配置 env\.exec 命令执行端口/)
    await service.close()
  })

  it('preflight rejection (unknown/ambiguous/inputSchema) preserves completed prefix and allows resume', timeout, async () => {
    let agent1Runs = 0
    let fixedActionRuns = 0
    const baseHost = makeServiceHost()
    const host: WorkflowServiceHost = {
      ...baseHost,
      spawnAgent: async () => {
        agent1Runs++
        return { ok: true, text: 'agent-1-done' }
      },
      invokeAction: async (pluginId, actionId, input) => {
        if (actionId === 'good_act') {
          fixedActionRuns++
          return { success: true }
        }
        return baseHost.invokeAction(pluginId, actionId, input)
      },
      listActions: () => [
        {
          pluginId: 'builtin:assistant',
          id: 'good_act',
          description: '',
          idempotent: true,
          inputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false },
          outputSchema: {},
        },
      ],
      prepareAction: (pluginId, actionId, input) => {
        if (actionId === 'good_act') {
          const raw = input as Record<string, unknown>
          if (typeof raw?.count !== 'number') {
            throw new HelmError('validation_error', 'count must be number', 400)
          }
          return { idempotent: true }
        }
        throw new HelmError('unknown_action', `unknown action: ${actionId}`, 404)
      },
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })

    // 第一轮：Step 1 agent 成功，Step 2 action preflight 失败（未知动作）
    const sum1 = await service.run({
      script:
        META('resume-preflight') +
        `
        const s1 = await agent("step1")
        const s2 = await action("unknown_action_xyz", {})
        if (!s2) throw new Error("step 2 failed")
        return [s1, s2]
      `,
    })
    await service.wait(sum1.id).catch(() => {})
    assert.equal(agent1Runs, 1)
    const run1 = service.getRun(sum1.id)
    assert.equal(run1.status, 'failed')

    // 检查账本没有 action_started，actionUncertain 为 false
    const rec1 = state.get<{ journalPath: string } | null>(`workflow/run/${sum1.id}`, null)
    assert.ok(rec1)
    const journal1 = readJournal(rec1.journalPath)
    assert.equal(journal1.actionUncertain, false)
    assert.equal(journal1.entries.some((e) => e.type === 'action_started'), false)

    // 第二轮：改正脚本，resumeFromRunId。Step 1 必须 100% 缓存命中，不重新跑 agent；Step 2 执行成功！
    const sum2 = await service.run({
      script:
        META('resume-preflight') +
        `
        const s1 = await agent("step1")
        const s2 = await action("builtin:assistant.good_act", { count: 42 }, { idempotent: true, label: "my-good-step", phase: "execution" })
        return [s1, s2]
      `,
      resumeFromRunId: sum1.id,
    })
    const res2 = await service.wait(sum2.id)
    assert.deepEqual(res2, ['{"ok":true,"text":"agent-1-done"}', { success: true }])
    assert.equal(agent1Runs, 1, 'step1 agent was cached and not re-executed')
    assert.equal(fixedActionRuns, 1, 'good_act executed')

    // 验证 opts.phase 与 opts.label 在 summary.nodes 中生效
    const run2 = service.getRun(sum2.id)
    assert.equal(run2.status, 'completed')
    const actionNode = run2.nodes?.find((n) => n.id === 'action-1')
    assert.ok(actionNode)
    assert.equal(actionNode.label, 'my-good-step')
    assert.equal(actionNode.phaseTitle, 'execution')

    await service.close()
  })

  it('validateEnvExecInput preflight rejects relative cwd, invalid nodeId, and out-of-range timeoutMs without action_started', timeout, async () => {
    const baseHost = makeServiceHost()
    const host: WorkflowServiceHost = {
      ...baseHost,
      execEnv: async () => ({ ok: true, exitCode: 0, output: 'ok', timedOut: false }),
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })

    // 1) 相对路径 cwd 必须在 preflight 拦截
    const sumRel = await service.run({
      script: META('preflight-rel-cwd') + 'const res = await action("env.exec", { command: "ls", cwd: "relative/path" })\nreturn res',
    })
    const resRel = await service.wait(sumRel.id)
    assert.equal(resRel, null)
    const runRel = service.getRun(sumRel.id)
    const nodeRel = runRel.nodes?.find((n) => n.id === 'action-0')
    assert.equal(nodeRel?.status, 'failed')
    assert.match(nodeRel?.error ?? '', /cwd 必须为跨平台绝对路径/)
    const recRel = state.get<{ journalPath: string } | null>(`workflow/run/${sumRel.id}`, null)
    assert.ok(recRel)
    const jRel = readJournal(recRel.journalPath)
    assert.equal(jRel.actionUncertain, false)
    assert.equal(jRel.entries.some((e) => e.type === 'action_started'), false)

    // 2) 非法 nodeId 必须在 preflight 拦截
    const sumNode = await service.run({
      script: META('preflight-bad-node') + 'const res = await action("env.exec", { command: "ls", nodeId: "_bad:node!*" })\nreturn res',
    })
    const resNode = await service.wait(sumNode.id)
    assert.equal(resNode, null)
    const runNode = service.getRun(sumNode.id)
    const nodeNode = runNode.nodes?.find((n) => n.id === 'action-0')
    assert.equal(nodeNode?.status, 'failed')
    assert.match(nodeNode?.error ?? '', /nodeId 需匹配/)
    const recNode = state.get<{ journalPath: string } | null>(`workflow/run/${sumNode.id}`, null)
    assert.ok(recNode)
    const jNode = readJournal(recNode.journalPath)
    assert.equal(jNode.actionUncertain, false)
    assert.equal(jNode.entries.some((e) => e.type === 'action_started'), false)

    // 3) 越界 timeoutMs 必须在 preflight 拦截
    const sumTimeout = await service.run({
      script: META('preflight-bad-timeout') + 'const res = await action("env.exec", { command: "ls", timeoutMs: 999_999_999 })\nreturn res',
    })
    const resTimeout = await service.wait(sumTimeout.id)
    assert.equal(resTimeout, null)
    const runTimeout = service.getRun(sumTimeout.id)
    const nodeTimeout = runTimeout.nodes?.find((n) => n.id === 'action-0')
    assert.equal(nodeTimeout?.status, 'failed')
    assert.match(nodeTimeout?.error ?? '', /timeoutMs 必须是 1 到 600000 之间的整数/)
    const recTimeout = state.get<{ journalPath: string } | null>(`workflow/run/${sumTimeout.id}`, null)
    assert.ok(recTimeout)
    const jTimeout = readJournal(recTimeout.journalPath)
    assert.equal(jTimeout.actionUncertain, false)
    assert.equal(jTimeout.entries.some((e) => e.type === 'action_started'), false)

    await service.close()
  })

  it('unawaited env.exec cancels and drains the pending execution channel on script error', timeout, async () => {
    const sentinelFile = join(dataDir, `sentinel-${Date.now()}.txt`)
    const baseHost = makeServiceHost()
    const host: WorkflowServiceHost = {
      ...baseHost,
      execEnv: async (req, signal) => {
        const cmd = Array.isArray(req.command) ? req.command.join(' ') : req.command
        return new Promise<EnvExecResponse>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          if (cmd.includes('delay-write')) {
            timer = setTimeout(() => {
              writeFileSync(sentinelFile, 'executed', 'utf-8')
              resolve({ ok: true, exitCode: 0, output: 'written', timedOut: false })
            }, 1000)
          } else {
            resolve({ ok: true, exitCode: 0, output: 'fast-done', timedOut: false })
          }

          signal?.addEventListener('abort', () => {
            if (timer) clearTimeout(timer)
            resolve({ ok: false, exitCode: null, output: 'aborted', timedOut: false })
          }, { once: true })
        })
      },
    }
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })

    // 未 await 慢命令就立即 throw 模拟早期失败
    const sum = await service.run({
      script:
        META('unawaited-exec-leak') +
        `
        action("env.exec", { command: "delay-write" }) // 未 await！
        await action("env.exec", { command: "fast-check" }) // 确保前一条已经进入通道
        throw new Error("early crash")
      `,
    })
    await service.wait(sum.id)
    const run = service.getRun(sum.id)
    assert.equal(run.status, 'failed')

    // 等待超过计划延迟时间（1200ms）
    await new Promise((r) => setTimeout(r, 1200))

    // 哨兵文件绝不能被写入（在途命令必须已被 abort 取消并完成通道清理）
    assert.equal(existsSync(sentinelFile), false, 'sentinel file must not be written by unawaited leaked command')

    await service.close()
  })
})

// ---------------------------------------------------------------------------
// 真 SDK 集成（faux provider）：默认 agentType 走 assistant profile
// ---------------------------------------------------------------------------

describe('workflow real-SDK integration (faux provider)', () => {
  it('agent() without explicit agentType spawns via default assistant profile end to end', timeout, async () => {
    // 动态加载真 KernelRuntime 组装链（faux provider + 真 spawn.ts + 真 profiles）。
    const { KernelRuntime } = await import('../src/runtime/index.js')
    const { fauxProvider, fauxAssistantMessage } = await import(
      '@earendil-works/pi-ai/providers/faux'
    )
    const { createModels } = await import('@earendil-works/pi-ai/models')

    const dataDir = mkdtempSync(join(tmpdir(), 'wf-sdk-'))
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)

    const runtime = await KernelRuntime.open({
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      models,
      autoResume: false,
    })
    try {
      const service = new WorkflowService({
        dataDir,
        state: runtime.documentStore,
        host: {
          spawnAgent: (request) => runtime.spawnAgent(request),
          invokeAction: async (pluginId, actionId, input) => {
            throw new HelmError('unknown_action', `测试宿主无动作：${pluginId}.${actionId}`, 404)
          },
          listActions: () => [],
          getConversation: (id) => runtime.getConversation(id),
          abortConversation: (id) => runtime.abortConversation(id),
          emitEvent: () => {},
        },
      })
      await service.init()

      // faux 脚本：子会话回答固定文本。
      faux.setResponses([fauxAssistantMessage('child says hi')])

      // 不显式指定 agentType：默认必须经 assistant profile（ensureDefault 保证存在）。
      const summary = await service.run({
        script: META('sdk-default') + 'const a = await agent("ping")\nreturn a',
      })
      const result = await service.wait(summary.id)
      assert.equal(service.getRun(summary.id).status, 'completed', service.getRun(summary.id).error)
      assert.equal(result, 'child says hi')
      await service.close()
    } finally {
      await runtime.close()
    }
  })

  it('normalizeWorkflowArgs：正确解包单层/双层 JSON 字符串并保持标量与对象原样', timeout, () => {
    assert.equal(normalizeWorkflowArgs(undefined), undefined)
    assert.equal(normalizeWorkflowArgs(null), null)
    assert.equal(normalizeWorkflowArgs(42), 42)
    assert.equal(normalizeWorkflowArgs(true), true)
    assert.equal(normalizeWorkflowArgs('hello world'), 'hello world')
    assert.deepEqual(normalizeWorkflowArgs({ a: 1 }), { a: 1 })
    assert.deepEqual(normalizeWorkflowArgs([1, 2, 3]), [1, 2, 3])

    // JSON 对象字符串解包为真对象
    assert.deepEqual(normalizeWorkflowArgs('{"n": 42, "sentinel": "XYZZY"}'), { n: 42, sentinel: 'XYZZY' })
    // JSON 数组字符串解包为真数组
    assert.deepEqual(normalizeWorkflowArgs('["星辰", "大海"]'), ['星辰', '大海'])
    // 空对象与空数组
    assert.deepEqual(normalizeWorkflowArgs('{}'), {})
    assert.deepEqual(normalizeWorkflowArgs('[]'), [])
    // 带换行与空白的 JSON 字符串
    assert.deepEqual(normalizeWorkflowArgs(' \n {"items": [1, 2]} \n '), { items: [1, 2] })
    // 双重序列化的 JSON
    assert.deepEqual(normalizeWorkflowArgs(JSON.stringify('{"items": [10, 20]}')), { items: [10, 20] })
    // 损坏的 JSON 语法安全兜底原样返回，不抛异常
    assert.equal(normalizeWorkflowArgs('{ broken json'), '{ broken json')
    assert.equal(normalizeWorkflowArgs('[ broken json'), '[ broken json')
  })

  it('service.run：字符串形式的 args 自动规范化并持久化为对象，脚本内 args.topics.map 正常执行', timeout, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-str-args-'))
    const host = makeServiceHost()
    const state = makeStateStore()
    const service = new WorkflowService({ dataDir, host, state })
    try {
      const summary = await service.run({
        script: META('svc-str-args') + 'return args.topics.map((t) => t.toUpperCase())',
        args: '{"topics": ["star", "ocean"]}',
      })
      const result = await service.wait(summary.id)
      assert.equal(service.getRun(summary.id).status, 'completed', service.getRun(summary.id).error)
      assert.deepEqual(result, ['STAR', 'OCEAN'], '脚本内 args 为真实对象，map 正常计算')

      // 持久化记录必须是真实对象，不得为字符串
      const stored = state.get<{ args?: unknown } | null>(`workflow/run/${summary.id}`, null)
      assert.ok(stored, 'run 应持久化')
      assert.equal(typeof stored.args, 'object', '持久化 args 必须为对象而非字符串')
      assert.deepEqual(stored.args, { topics: ['star', 'ocean'] })
    } finally {
      await service.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('real env.exec child processes are cancelled on early return and script failure', timeout, async () => {
    const { createHelm } = await import('../src/app.js')
    const { fauxProvider } = await import('@earendil-works/pi-ai/providers/faux')
    const { createModels } = await import('@earendil-works/pi-ai/models')
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-exec-cleanup-'))
    const models = createModels()
    models.setProvider(fauxProvider().provider)
    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
    // 插件化后编排引擎仅经 builtin:workflow 动作总线驱动（不再暴露 app.workflows）。
    const workflows = app.kernel.plugins!
    const runWorkflow = (request: Record<string, unknown>) =>
      workflows.invokeAction('builtin:workflow', 'run', request) as Promise<
        import('@helm/protocol').WorkflowRunSummary
      >
    try {
      const sentinels: string[] = []
      for (const [index, ending] of ['return "early"', 'throw new Error("early failure")'].entries()) {
        const ready = join(dataDir, `ready-${index}`)
        const sentinel = join(dataDir, `sentinel-${index}`)
        sentinels.push(sentinel)
        const slowCommand = [process.execPath, '-e',
          `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(ready)}, "ready"); ` +
          `setTimeout(() => fs.writeFileSync(${JSON.stringify(sentinel)}, "leaked"), 1500);`,
        ]
        const readyCommand = [process.execPath, '-e',
          `const fs = require("node:fs"); const deadline = setTimeout(() => process.exit(2), 5000); ` +
          `const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(ready)})) { clearTimeout(deadline); clearInterval(poll); } }, 5);`,
        ]
        // wait:true 在终态 failed 时按动作契约显式拏（不伪造成功）；拏后经 runs 取真实终态。
        await assert.rejects(
          runWorkflow({
            script: META(`real-exec-cleanup-${index}`) +
              `action("env.exec", { command: ${JSON.stringify(slowCommand)}, timeoutMs: 10000 });\n` +
              `const ready = await action("env.exec", { command: ${JSON.stringify(readyCommand)}, timeoutMs: 10000 });\n` +
              `if (!ready?.ok) throw new Error("child readiness check failed");\n${ending}`,
            wait: true,
          }),
          (error: unknown) => error instanceof HelmError && error.code === 'workflow_failed',
        )
        const listed = (await workflows.invokeAction('builtin:workflow', 'runs', {})) as unknown as {
          runs: Array<import('@helm/protocol').WorkflowRunSummary>
        }
        // 取本脚本名下终态 failed 的那一条。
        const failedRuns = listed.runs.filter((r) => r.name === `real-exec-cleanup-${index}`)
        assert.ok(failedRuns.length >= 1, 'run 应出现在 runs 清单')
        const failedRun = failedRuns[0]!
        assert.equal(failedRun.status, 'failed', failedRun.error)
        assert.match(failedRun.error ?? '', index === 0 ? /unawaited launch/ : /early failure/)
        assert.ok(existsSync(ready), 'the actual child must have started before the workflow ends')
      }
      await new Promise((resolve) => setTimeout(resolve, 1700))
      for (const sentinel of sentinels) {
        assert.equal(existsSync(sentinel), false, 'a cancelled child process must never write the delayed sentinel')
      }
    } finally {
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('env.exec in real KernelRuntime executes command without consuming tokens', timeout, async () => {
    const { KernelRuntime } = await import('../src/runtime/index.js')
    const { fauxProvider } = await import('@earendil-works/pi-ai/providers/faux')
    const { createModels } = await import('@earendil-works/pi-ai/models')

    const dataDir = mkdtempSync(join(tmpdir(), 'wf-env-exec-real-'))
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)

    const runtime = await KernelRuntime.open({
      dataDir,
      cwd: dataDir,
      model: 'faux/faux-1',
      models,
      autoResume: false,
    })
    try {
      const service = new WorkflowService({
        dataDir,
        state: runtime.documentStore,
        host: {
          spawnAgent: (request) => runtime.spawnAgent(request),
          invokeAction: async (pluginId, actionId, input, context) => {
            return runtime.plugins.invokeAction(pluginId, actionId, input, context)
          },
          prepareAction: (pluginId, actionId, input, context) => {
            return runtime.plugins.prepareAction(pluginId, actionId, input, context)
          },
          execEnv: async (req, signal) => {
            const res = await runtime.execEnv(req, undefined, signal)
            return {
              ...res,
              output: runtime.stash.redact(res.output),
            }
          },
          listActions: () => runtime.plugins.listActions(),
          getConversation: (id) => runtime.getConversation(id),
          abortConversation: (id) => runtime.abortConversation(id),
          emitEvent: () => {},
        },
      })
      await service.init()

      const summary = await service.run({
        script:
          META('real-exec') +
          `
          const res = await action("env.exec", { command: ["node", "-e", "process.stdout.write('hello-from-node')"] }, { idempotent: true, label: "run-node" })
          return res
        `,
      })
      const result = (await service.wait(summary.id)) as { ok: boolean; exitCode: number; output: string; timedOut: boolean }
      assert.equal(service.getRun(summary.id).status, 'completed', service.getRun(summary.id).error)
      assert.equal(result.ok, true)
      assert.equal(result.exitCode, 0)
      assert.equal(result.output, 'hello-from-node')
      assert.equal(result.timedOut, false)

      const run = service.getRun(summary.id)
      const actionNode = run.nodes?.find((n) => n.id === 'action-0')
      assert.equal(actionNode?.label, 'run-node')

      await service.close()
    } finally {
      await runtime.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
