/**
 * 工作流历史列表完整性回归（tsx --test；真实 WorkflowService + 注入故障的 state store）。
 *
 * 静态遗留 C：listRuns 旧实现对每条历史 loadRecord 包 catch{} 静默跳过，
 * loadRecord 只查 null/id 一致就 TS 强转 RunRecord——索引指向缺失记录、错
 * ID、损坏记录或 store 抛错时，列表/snapshot 返回看似成功的少项数组或伪
 * 摘要。本文件按诚实性纪律回归：
 *
 * 1. 索引指向缺失记录（record 从未写入/被外部删改）→ listRuns 显式
 *    workflow_index_corrupt（500，details.runId 指认），不返回少项成功；
 * 2. 索引指向错 ID 记录（store 键下躺着别的 run 的 record）→ 同上显式失败；
 * 3. 持久记录形状非法（status 越界 / 必需字段缺失）→ getRun/listRuns 均
 *    workflow_record_corrupt（500），不再是 TS 强转出的伪摘要；
 * 4. 底层 store get 抛错（IO 故障）→ 显式失败带 runId/key 诊断，不吞；
 * 5. 正常路径不受影响：活跃 run 实时列出、终态 run 跨重启列出、活跃与
 *    历史去重、createdAt 倒序、普通 getRun 不存在保持 404 not_found；
 * 6. HTTP 层可见故障（createHubHandler + 真 AuthService 进程 token）：
 *    GET /api/workflows/runs 返回 500 workflow_index_corrupt 错误信封，
 *    绝非 200 少项数组；
 * 7. CLI 层非零退出（真 createHelm + port 0 Hub + tsx 子进程真 CLI）：
 *    helm workflows runs 在索引损坏时 exitCode !== 0 且 stderr 带错误码，
 *    不打印伪列表。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { HelmError } from '@helm/protocol'
import { WorkflowService, type WorkflowServiceHost, type WorkflowStateStore } from '../src/builtin-plugins/workflow/engine/service.js'
import { createHubHandler, startHub } from '../src/http/index.js'
import { AuthService } from '../src/services/index.js'
import type { EventHub, KernelRuntimeLike } from '../src/http/index.js'
import { createHelm } from '../src/app.js'
import { createWorkflowPlugin } from '../src/builtin-plugins/workflow.js'
import { PluginHost, type PluginHostBackend, type PluginSessionDocStore } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'

const timeout = { timeout: 60_000 } as const

/** 内存会话文档存储（workflow 插件 runs 分片用；与真实契约同键语义）。 */
const memorySessionDocData = new Map<string, string>()
const memorySessionDocs: PluginSessionDocStore = {
  get(pluginId, name, conversationId) { return memorySessionDocData.get(`${pluginId}\0${name}\0${conversationId}`) },
  put(pluginId, name, conversationId, valueJson) { memorySessionDocData.set(`${pluginId}\0${name}\0${conversationId}`, valueJson) },
  delete(pluginId, name, conversationId) { memorySessionDocData.delete(`${pluginId}\0${name}\0${conversationId}`) },
  listConversationIds(pluginId, name) {
    return [...memorySessionDocData.keys()]
      .filter((k) => k.startsWith(`${pluginId}\0${name}\0`))
      .map((k) => Number(k.split('\0')[2]))
      .sort((a, b) => a - b)
  },
  async flush() {},
}

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

// ---------------------------------------------------------------------------
// 辅助：state store / service host（对齐 workflow-metadata.test.ts 基座）
// ---------------------------------------------------------------------------

function makeStateStore(): WorkflowStateStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    get<T>(key: string, initial: T): T {
      // 键存在即返回存储值（含 null）：与真实 documentStore 的 JSON 语义
      // 一致（存了 null 读回 null），不得用 ?? 把 null 吞成 initial。
      return map.has(key) ? (map.get(key) as T) : initial
    },
    set<T>(key: string, value: T): void {
      map.set(key, value)
    },
  }
}

/** 读取即抛错（IO 故障注入；failKeys 为空则恢复只读）。 */
function makeFailingGetStore(failKeys: string[]): WorkflowStateStore & { map: Map<string, unknown>; failKeys: string[] } {
  const inner = makeStateStore()
  return {
    map: inner.map,
    failKeys,
    get<T>(key: string, initial: T): T {
      if (failKeys.includes(key)) throw new Error(`simulated store read failure: ${key}`)
      return inner.get<T>(key, initial)
    },
    set<T>(key: string, value: T): void {
      inner.set(key, value)
    },
  }
}

function conversationSummary(id: number) {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [] as string[],
    cwd: '/tmp',
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

function makeServiceHost(): WorkflowServiceHost {
  return {
    async spawnAgent() {
      return 'text'
    },
    async invokeAction() {
      throw new Error('no actions in this host')
    },
    listActions() {
      return []
    },
    getConversation: (id: number) => conversationSummary(id),
    async abortConversation() {},
    emitEvent() {},
  }
}

/** 跑两个真实 run（不同完成时间），返回 service 与 state。 */
async function runTwoSettledRuns(dataDir: string, state: WorkflowStateStore): Promise<WorkflowService> {
  const service = new WorkflowService({ dataDir, host: makeServiceHost(), state })
  const first = await service.run({ conversationId: 1, script: META('hist-int-1') + 'return 1' })
  await service.wait(first.id)
  const second = await service.run({ conversationId: 1, script: META('hist-int-2') + 'return 2' })
  await service.wait(second.id)
  return service
}

/**
 * 在插件 records 文档存储上重建两个终态 run（直接实例化引擎写入同构
 * PluginDocStore，再把键值复制进目标 store；用于 PluginHost 级损坏注入测试）。
 */
async function seedRecordsDocInto(
  store: { set(key: string, value: unknown): void },
  dataDir: string,
): Promise<Array<{ id: string }>> {
  const engineState = makeStateStore()
  const service = await runTwoSettledRuns(dataDir, engineState)
  const doc: Record<string, unknown> = {}
  for (const [key, value] of engineState.map) doc[key] = value
  store.set('builtin:workflow:records', doc)
  const index = doc['workflow/runs'] as Array<{ id: string }>
  await service.close()
  return index
}

// ---------------------------------------------------------------------------
// service 层：索引/记录边界故障显式失败
// ---------------------------------------------------------------------------

describe('WorkflowService listRuns integrity', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-list-int-'))

  after(() => rmSync(dataDir, { recursive: true, force: true }))

  it('normal path: active + settled runs, restart, dedupe, createdAt desc, getRun 404 preserved', timeout, async (t) => {
    const state = makeStateStore()
    const service = await runTwoSettledRuns(dataDir, state)
    // 再来一个活跃 run（挂起 spawn 以验证实时列出 + 去重）。
    const ready = deferred()
    const resume = deferred()
    const host = makeServiceHost()
    const realSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (request) => {
      ready.resolve()
      await resume.promise
      return realSpawn(request)
    }
    const activeService = new WorkflowService({ dataDir, host, state })
    t.after(async () => {
      resume.resolve()
      await activeService.close()
      await service.close()
    })
    const active = await activeService.run({ conversationId: 1, script: META('hist-int-active') + 'return await agent("hang")' })
    await ready.promise
    let runs = activeService.listRuns()
    assert.equal(runs.length, 3, 'active + two settled runs all listed')
    const ids = runs.map((r) => r.id)
    assert.ok(ids.includes(active.id) && ids.includes(ids.find((x) => x !== active.id)!))
    // createdAt 倒序（新→旧）。
    for (let i = 1; i < runs.length; i++) {
      assert.ok(runs[i - 1]!.createdAt >= runs[i]!.createdAt, `desc order broken at ${i}`)
    }
    resume.resolve()
    await activeService.wait(active.id)
    // 活跃 run 落终态后去重：不出现两条同 id。
    runs = activeService.listRuns()
    assert.equal(runs.filter((r) => r.id === active.id).length, 1, 'no duplicate after settle')

    // 跨重启（新实例同 state store）仍完整。
    const revived = new WorkflowService({ dataDir, host: makeServiceHost(), state })
    const revivedRuns = revived.listRuns()
    assert.equal(revivedRuns.length, 3, 'runs survive restart via state store')

    // 普通 getRun 不存在保持 404 not_found（不是服务故障）。
    assert.throws(
      () => revived.getRun('wf_nosuchrun0000'),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'not_found')
        assert.equal(error.status, 404)
        return true
      },
    )
    await revived.close()
    await service.close()
    await activeService.close()
  })

  it('index shape violations (non-array / null / null-item / bad fields) fail as workflow_index_corrupt with key + identifiable runId', timeout, async () => {
    const cases: Array<{ name: string; value: unknown; wantRunId: string; wantProblem: string }> = [
      { name: 'null 索引', value: null, wantRunId: '#root', wantProblem: '索引非数组' },
      { name: '对象伪装索引', value: { 0: {} }, wantRunId: '#root', wantProblem: '索引非数组' },
      { name: 'null 项', value: [{ id: 'wf_aaaaaaaaaaaa', conversationId: 1, createdAt: 1 }, null], wantRunId: '#1', wantProblem: '第 1 项非对象' },
      { name: 'id 非字符串', value: [{ id: 42, conversationId: 1, createdAt: 1 }], wantRunId: '#0', wantProblem: 'id 非字符串' },
      {
        name: 'conversationId 非法',
        value: [{ id: 'wf_bbbbbbbbbbbb', conversationId: 0, createdAt: 1 }],
        wantRunId: 'wf_bbbbbbbbbbbb',
        wantProblem: 'conversationId 非正整数',
      },
      {
        name: 'createdAt 非法',
        value: [{ id: 'wf_cccccccccccc', conversationId: 1, createdAt: 'soon' }],
        wantRunId: 'wf_cccccccccccc',
        wantProblem: 'createdAt 非有限数值',
      },
    ]
    for (const c of cases) {
      const state = makeStateStore()
      state.set('workflow/runs', c.value)
      const service = new WorkflowService({ dataDir, host: makeServiceHost(), state })
      assert.throws(
        () => service.listRuns(),
        (error: unknown) => {
          assert.ok(error instanceof HelmError, `[${c.name}] expect HelmError, got: ${String(error)}`)
          assert.equal(error.code, 'workflow_index_corrupt', c.name)
          assert.equal(error.status, 500, c.name)
          const details = error.details as { key?: string; runId?: string }
          assert.equal(details.key, 'workflow/runs', c.name)
          assert.equal(details.runId, c.wantRunId, `${c.name}: identifiable runId`)
          assert.ok(error.message.includes(c.wantProblem), `[${c.name}] message should name the problem: ${error.message}`)
          return true
        },
        `[${c.name}] old code would TypeError on entry.id or fake a list`,
      )
      await service.close()
    }
  })

  it('global createdAt desc order: two actives straddle a newer settled run; dedupe holds', timeout, async (t) => {
    const state = makeStateStore()
    const host = makeServiceHost()
    const ready = [deferred(), deferred()]
    const resume = [deferred(), deferred()]
    const realSpawn = host.spawnAgent.bind(host)
    let hangSlot = 0
    host.spawnAgent = async (request) => {
      const slot = hangSlot++
      ready[slot]!.resolve()
      await resume[slot]!.promise
      return realSpawn(request)
    }
    const service = new WorkflowService({ dataDir, host, state })
    t.after(async () => {
      for (const gate of resume) gate.resolve()
      await service.close()
    })
    // 旧活跃 run 先启（active.values() 插入序在前），随后夹一个较新的终态历史。
    const olderActive = await service.run({ conversationId: 1, script: META('ord-a') + 'return await agent("hang-a")' })
    await ready[0]!.promise
    const settled = await service.run({ conversationId: 1, script: META('ord-mid') + 'return 1' })
    await service.wait(settled.id)
    const newerActive = await service.run({ conversationId: 1, script: META('ord-b') + 'return await agent("hang-b")' })
    await ready[1]!.promise

    const runs = service.listRuns()
    assert.equal(runs.length, 3, 'two actives + one settled')
    // 全局新建在前：newerActive > settled > olderActive（旧实现按 active 插入
    // 序会把较早的活跃 run 排在较新的终态历史之前）。
    assert.deepEqual(
      runs.map((r) => r.id),
      [newerActive.id, settled.id, olderActive.id],
      `global createdAt desc broken: ${JSON.stringify(runs.map((r) => [r.id, r.createdAt]))}`,
    )
    for (let i = 1; i < runs.length; i++) {
      assert.ok(runs[i - 1]!.createdAt >= runs[i]!.createdAt)
    }
    // 活跃项去重：每个 id 仅一条。
    for (const id of [olderActive.id, newerActive.id, settled.id]) {
      assert.equal(runs.filter((r) => r.id === id).length, 1)
    }
    for (const gate of resume) gate.resolve()
    await service.wait(olderActive.id)
    await service.wait(newerActive.id)
    // 终态后再列：仍 3 条、仍倒序、无重复。
    const final = service.listRuns()
    assert.equal(final.length, 3)
    assert.deepEqual(final.map((r) => r.id), [newerActive.id, settled.id, olderActive.id])
    await service.close()
  })

  it('loadRecord tolerates non-object stored values: string corrupt, never TypeError; 404 preserved', timeout, async () => {
    const state = makeStateStore()
    const service = await runTwoSettledRuns(dataDir, state)
    const index = state.get<Array<{ id: string }>>('workflow/runs', [])
    const victim = index[0]!.id
    // 键下是字符串（store 返回非对象非 null）：损坏，不是 TypeError。
    state.set(`workflow/run/${victim}`, 'garbage')
    assert.throws(
      () => service.getRun(victim),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'workflow_record_corrupt')
        assert.ok(error.message.includes('非对象结构'), error.message)
        return true
      },
    )
    // 键下是 null（真实 documentStore 存 JSON null 读回 null）：不存在，404。
    state.set(`workflow/run/${victim}`, null)
    assert.throws(
      () => service.getRun(victim),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'not_found')
        assert.equal(error.status, 404)
        return true
      },
    )
    // 普通 getRun 不存在保持 404。
    assert.throws(
      () => service.getRun('wf_nosuchrun0000'),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'not_found')
        return true
      },
    )
    await service.close()
  })

  it('index entry pointing at a missing record fails explicitly (no silent short list)', timeout, async () => {
    const state = makeStateStore()
    const service = await runTwoSettledRuns(dataDir, state)
    // 模拟索引指向缺失记录：删掉 store 中的 record doc（外部删改）。
    const index = state.get<Array<{ id: string }>>('workflow/runs', [])
    assert.equal(index.length, 2)
    const victim = index[0]!.id
    state.map.delete(`workflow/run/${victim}`)
    assert.throws(
      () => service.listRuns(),
      (error: unknown) => {
        assert.ok(error instanceof HelmError, `expect HelmError, got: ${String(error)}`)
        assert.equal(error.code, 'workflow_index_corrupt')
        assert.equal(error.status, 500)
        assert.equal((error as HelmError).details && (error.details as { runId?: string }).runId, victim)
        assert.ok(error.message.includes(victim), 'diagnostic names the runId')
        return true
      },
    )
    await service.close()
  })

  it('index entry whose stored record carries a different id fails explicitly', timeout, async () => {
    const state = makeStateStore()
    const service = await runTwoSettledRuns(dataDir, state)
    const index = state.get<Array<{ id: string }>>('workflow/runs', [])
    const victim = index[1]!.id
    const record = state.get<Record<string, unknown> | null>(`workflow/run/${victim}`, null)
    assert.ok(record !== null)
    // 键下躺着别的 run 的 record（id 不符）。
    state.set(`workflow/run/${victim}`, { ...record, id: 'wf_someother9999' })
    assert.throws(
      () => service.listRuns(),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'workflow_index_corrupt')
        assert.equal((error.details as { runId?: string }).runId, victim)
        return true
      },
    )
    // 单 run 语境：loadRecord 的 id 不符仍按 not_found（404）报——列表语境
    // 才升级为索引损坏。
    assert.throws(
      () => service.getRun(victim),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'not_found')
        return true
      },
    )
    await service.close()
  })

  it('record with invalid shape (status out of enum / missing name) fails as workflow_record_corrupt', timeout, async () => {
    const state = makeStateStore()
    const service = await runTwoSettledRuns(dataDir, state)
    const index = state.get<Array<{ id: string }>>('workflow/runs', [])
    const victim = index[0]!.id
    const record = state.get<Record<string, unknown> | null>(`workflow/run/${victim}`, null)
    assert.ok(record !== null)

    // status 越界：TS 强转旧实现会造出 status:"weird" 的伪摘要。
    state.set(`workflow/run/${victim}`, { ...record, status: 'weird' })
    assert.throws(
      () => service.getRun(victim),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'workflow_record_corrupt')
        assert.equal(error.status, 500)
        assert.ok(error.message.includes('status'), `message should name the problem: ${error.message}`)
        return true
      },
    )
    assert.throws(
      () => service.listRuns(),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'workflow_record_corrupt')
        assert.equal((error.details as { runId?: string }).runId, victim)
        return true
      },
    )

    // 必需字段缺失（name 没了）。
    state.set(`workflow/run/${victim}`, { ...record, status: 'completed', name: undefined })
    assert.throws(
      () => service.listRuns(),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'workflow_record_corrupt')
        return true
      },
    )
    await service.close()
  })

  it('store get() throwing surfaces as explicit corrupt error with runId diagnostics', timeout, async () => {
    const state = makeStateStore()
    const service = await runTwoSettledRuns(dataDir, state)
    const index = state.get<Array<{ id: string }>>('workflow/runs', [])
    const victim = index[0]!.id
    // IO 故障注入：新 service 用「读取该 run doc 即抛错」的 store（真实
    // documentStore 损坏同路径），其余数据从原 store 复制。
    const failing = makeFailingGetStore([`workflow/run/${victim}`])
    for (const [k, v] of state.map) failing.map.set(k, v)
    const failingService = new WorkflowService({ dataDir, host: makeServiceHost(), state: failing })
    assert.throws(
      () => failingService.listRuns(),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'workflow_record_corrupt', 'store 抛错直接以记录级 corrupt 信封透传')
        assert.ok(error.message.includes('simulated store read failure'), `cause surfaced: ${error.message}`)
        assert.equal((error.details as { runId?: string }).runId, victim)
        return true
      },
    )
    // 单 run 语境同样显式（不吞成 not_found）。
    assert.throws(
      () => failingService.getRun(victim),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'workflow_record_corrupt')
        assert.equal((error.details as { runId?: string }).runId, victim)
        return true
      },
    )
    await service.close()
  })

  it('restart (init) over an index entry with missing record does not mask later listRuns failure', timeout, async () => {
    // init 恢复只关心 running 记录；索引损坏仍由 listRuns 显式报错——两条
    // 路径互不掩盖。这里保证 init 不抛、不删除索引（诊断面留给 listRuns）。
    const state = makeStateStore()
    const service = await runTwoSettledRuns(dataDir, state)
    const index = state.get<Array<{ id: string; conversationId: number; createdAt: number }>>('workflow/runs', [])
    const victim = index[0]!.id
    state.map.delete(`workflow/run/${victim}`)
    const revived = new WorkflowService({ dataDir, host: makeServiceHost(), state })
    await revived.init() // 记录缺失不炸 init（恢复只处理存在的 running 记录）
    assert.throws(() => revived.listRuns(), /workflow_index_corrupt|工作流 run 索引损坏/)
    const after = state.get<Array<{ id: string }>>('workflow/runs', [])
    assert.equal(after.length, 2, 'index is not silently pruned')
    await revived.close()
    await service.close()
  })
})

// ---------------------------------------------------------------------------
// HTTP 层：编排经 builtin:workflow 插件动作（/api/actions）；真实 handler +
// 真 AuthService 进程 token，故障以 500 错误信封可见。
// ---------------------------------------------------------------------------

class NoopEventHub implements EventHub {
  response(): Response {
    return new Response(null, { status: 204 })
  }
}

/** 最小后端（编排插件经 ctx.host 触达的能力；引擎自持 state store）。 */
function makeBackend(): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => ({}) as never,
    listConversations: () => [],
    getConversation: () => ({}) as never,
    updateConversation: async () => ({}) as never,
    abortConversation: async () => {},
    getConversationActivity: () => ({ consecutiveErrors: 0 }),
    getConversationOwnership: () => 'human' as const,
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    listActions: () => [],
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({}) as never,
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    emitEvent: () => {},
  }
}

describe('workflow listRuns failure visibility over HTTP (plugin actions)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-http-int-'))
  let auth: AuthService
  let token: string

  before(async () => {
    auth = new AuthService(dataDir)
    const handler = createHubHandler(
      { dataDir, auth, events: new NoopEventHub(), plugins: new PluginHost({ dataDir, host: makeBackend(), docs: { get: <T>(_k: string, initial: T): T => initial, set: () => {} , flush: async () => {}} }) } as unknown as KernelRuntimeLike,
    )
    // 直接调 handler（不经网络）：setup 拿用户 token 备用。
    const res = await handler(
      new Request('http://127.0.0.1/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'integration-test-password' }),
      }),
    )
    assert.equal(res.status, 200)
    token = ((await res.json()) as { token: string }).token
  })

  after(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('POST /api/actions/.../runs returns 500 workflow_index_corrupt envelope, never a short 200 list', timeout, async () => {
    // 插件 records 文档存储（PluginDocStore 键 builtin:workflow:records）：
    // 先重建真实终态 run 数据，注册后删一条 record 注入外部损坏。
    const recordsDoc: Record<string, unknown> = {}
    const docsStore = {
      get: <T>(key: string, initial: T): T => (key === 'builtin:workflow:records' ? (JSON.parse(JSON.stringify(recordsDoc)) as T) : initial),
      set: (key: string, value: unknown): void => {
        if (key === 'builtin:workflow:records') {
          const copy = JSON.parse(JSON.stringify(value as Record<string, unknown>)) as Record<string, unknown>
          for (const k of Object.keys(recordsDoc)) delete recordsDoc[k]
          Object.assign(recordsDoc, copy)
        }
      },
      flush: async () => {},
    }
    const index = await seedRecordsDocInto(docsStore, join(dataDir, 'corrupt-index-seed'))
    const host = new PluginHost({
      dataDir: join(dataDir, 'corrupt-index-plugins'),
      host: makeBackend(),
      docs: docsStore,
      sessionDocs: memorySessionDocs,
    })
    await host.register(createWorkflowPlugin())
    delete recordsDoc[`workflow/run/${index[0]!.id}`]
    const handler = createHubHandler(
      { dataDir, auth, events: new NoopEventHub(), plugins: host } as unknown as KernelRuntimeLike,
    )
    const res = await handler(
      new Request('http://127.0.0.1/api/actions/builtin%3Aworkflow/runs', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      }),
    )
    assert.equal(res.status, 500, 'index corruption must be a server error, not a short 200 list')
    const body = (await res.json()) as { error: { code: string; details?: { runId?: string } } }
    assert.equal(body.error.code, 'workflow_index_corrupt')
    await host.dispose()
  })

  it('inspect action for a corrupt record returns 500 workflow_record_corrupt (404 kept for missing)', timeout, async () => {
    const recordsDoc: Record<string, unknown> = {}
    const docsStore = {
      get: <T>(key: string, initial: T): T => (key === 'builtin:workflow:records' ? (JSON.parse(JSON.stringify(recordsDoc)) as T) : initial),
      set: (key: string, value: unknown): void => {
        if (key === 'builtin:workflow:records') {
          const copy = JSON.parse(JSON.stringify(value as Record<string, unknown>)) as Record<string, unknown>
          for (const k of Object.keys(recordsDoc)) delete recordsDoc[k]
          Object.assign(recordsDoc, copy)
        }
      },
      flush: async () => {},
    }
    const index = await seedRecordsDocInto(docsStore, join(dataDir, 'corrupt-record-seed'))
    const victim = index[0]!.id
    const host = new PluginHost({
      dataDir: join(dataDir, 'corrupt-record-plugins'),
      host: makeBackend(),
      docs: docsStore,
      sessionDocs: memorySessionDocs,
    })
    await host.register(createWorkflowPlugin())
    // 注册后（prepare 已通过）再注入损坏：模拟持久层外部篡改，验证 HTTP
    // 动作边界的显式 500（不是短列表或假成功）。
    const record = recordsDoc[`workflow/run/${victim}`] as Record<string, unknown>
    recordsDoc[`workflow/run/${victim}`] = { ...record, status: 42 }
    const handler = createHubHandler(
      { dataDir, auth, events: new NoopEventHub(), plugins: host } as unknown as KernelRuntimeLike,
    )
    const corrupt = await handler(
      new Request('http://127.0.0.1/api/actions/builtin%3Aworkflow/inspect', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: { runId: victim } }),
      }),
    )
    assert.equal(corrupt.status, 500)
    const corruptBody = (await corrupt.json()) as { error: { code: string } }
    assert.equal(corruptBody.error.code, 'workflow_record_corrupt')

    const missing = await handler(
      new Request('http://127.0.0.1/api/actions/builtin%3Aworkflow/inspect', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ input: { runId: 'wf_nosuchrun0000' } }),
      }),
    )
    assert.equal(missing.status, 404, 'plain getRun not-found keeps its 404 semantics')
    await host.dispose()
  })
})

// ---------------------------------------------------------------------------
// CLI 层：真 createHelm + port 0 Hub + tsx 子进程真 CLI，非零退出可见
// ---------------------------------------------------------------------------

const testDir = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(testDir, '..', '..', '..')
const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')

function runCliChild(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, out, err })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

test('CLI: helm workflows runs 在索引损坏时非零退出并显示错误码（真 Hub + 真 CLI 子进程）', timeout, async () => {
  const { createModels } = await import('@earendil-works/pi-ai/models')
  const { fauxProvider } = await import('@earendil-works/pi-ai/providers/faux')

  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-cli-int-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const plugins = app.kernel.plugins
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    // 正常跑两个 run（终态，经编排插件动作 wait:true），制造真实索引与记录。
    const conversationId = app.kernel.listConversations()[0]!.id
    await plugins.invokeAction('builtin:workflow', 'run', { script: META('cli-int-1') + 'return 1', wait: true }, { conversationId })
    await plugins.invokeAction('builtin:workflow', 'run', { script: META('cli-int-2') + 'return 2', wait: true }, { conversationId })

    hub = await startHub({ kernel: app.kernel as never, port: 0 })
    const setupRes = await fetch(`${hub.url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'cli-integration-password' }),
    })
    const userToken = ((await setupRes.json()) as { token: string }).token

    // 先验证健康路径：CLI 列出全部 run。
    const healthy = await runCliChild(['workflows', 'runs', '--json'], {
      ...process.env,
      HELM_HUB_URL: hub.url,
      HELM_DATA_DIR: join(dataDir, 'cli-home'),
      HELM_TOKEN: userToken,
    })
    assert.equal(healthy.code, 0, `healthy list should exit 0: ${healthy.err}`)
    assert.equal((JSON.parse(healthy.out) as { runs: unknown[] }).runs.length, 2)

    // 注入索引损坏：从插件 records 文档中删一条 run 记录（模拟外部损坏）。
    // 引擎 state 现住在插件私有 doc（PluginDocStore 键 builtin:workflow:records，
    // 即 state.sqlite helm_plugin_docs 插件命名空间），不再是 __global documentStore。
    // 经第二连接直改 SQLite 行：真实外部损坏路径（进程内 store 镜像与库同步
    // 更新会在下次 get 重读时按存储值反序列化——HelmStore.getPluginDoc 每次读
    // 内存镜像，放这里改为写库 + 内存镜像同键，双通道保持一致）。
    const runsList = (await plugins.invokeAction('builtin:workflow', 'runs', {})) as { runs: Array<{ id: string }> }
    assert.equal(runsList.runs.length, 2)
    const victim = runsList.runs[0]!.id
    const documentStore = (app.kernel as unknown as {
      documentStore: { get<T>(key: string, initial: T): T; set<T>(key: string, value: T): void }
    }).documentStore
    const records = documentStore.get<Record<string, unknown>>('builtin:workflow:records', {})
    assert.ok(Object.keys(records).length > 0, '插件 records 文档必须已持久化')
    delete records[`workflow/run/${victim}`]
    documentStore.set('builtin:workflow:records', records)

    const broken = await runCliChild(['workflows', 'runs', '--json'], {
      ...process.env,
      HELM_HUB_URL: hub.url,
      HELM_DATA_DIR: join(dataDir, 'cli-home'),
      HELM_TOKEN: userToken,
    })
    assert.notEqual(broken.code, 0, 'corrupt index must make CLI exit non-zero')
    assert.ok(broken.err.includes('workflow_index_corrupt'), `stderr should carry the error code: ${broken.err}`)
    assert.ok(broken.err.includes(victim), `stderr should name the runId: ${broken.err}`)
    assert.ok(!broken.out.includes('[{'), 'CLI must not print a fake successful list')
  } finally {
    await hub?.close()
    await app.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})
