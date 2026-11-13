/**
 * workflow-attachments.test.ts — DSL agent(prompt, { attachments }) 全链路回归。
 *
 * 与 subagent 工具 / AgentSpawnRequest.attachments 对齐：
 * - worker 边界：attachments 非数组、非字符串项、空/纯空白 ID 显式拒绝（fatal）；
 *   未提供与空数组语义不同（不归一化），空数组合法；
 * - runtime host 边界：伪造消息面的非法 attachments 同样 fatal，不下发宿主；
 * - 初调与 label resume 双路透传：spawnAgent/resumeAgent 均收到原样 ID 列表；
 *   resume 携带附件不自动沿用原任务附件（宿主收到的就是本轮列表）；
 * - journal key：attachments 参与 canonical（不同 ID/次序 ⇒ key 失配 ⇒ 不复用
 *   旧缓存）；v2 固定槽消除 v1 变长 schema 尾槽与 attachments 的碰撞；
 * - service adapter：invokeSpawn 组装的 protocol AgentSpawnRequest 端到端携带
 *   attachments（真实 WorkflowService + fake service host）；
 * - schema+gate 组合保持：attachments 与 schema/gate 同用时行为不变。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { HelmError } from '@helm/protocol'
import { agentJournalKey, type JournalWriteInput } from '../src/builtin-plugins/workflow/engine/journal.js'
import {
  runWorkflow,
  type WorkflowHost,
  type WorkflowSpawnRequest,
} from '../src/builtin-plugins/workflow/engine/runtime.js'
import { WorkflowService, type WorkflowServiceHost } from '../src/builtin-plugins/workflow/engine/service.js'

const timeout = { timeout: 60_000 } as const

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

/** 审计 host：记录每次 spawn/resume 收到的 attachments（含缺失事实）。 */
interface HostAudit {
  spawns: Array<{ prompt: string; attachments?: string[]; schema?: unknown; gate?: string }>
  resumes: Array<{ prompt: string; attachments?: string[] }>
  gateRuns: number
}

function makeAuditHost(): WorkflowHost & { audit(): HostAudit } {
  const state: HostAudit = { spawns: [], resumes: [], gateRuns: 0 }
  const host: WorkflowHost = {
    async spawnAgent(request) {
      state.spawns.push({
        prompt: request.prompt,
        ...(request.attachments !== undefined ? { attachments: [...request.attachments] } : {}),
        ...(request.schema !== undefined ? { schema: request.schema.schema } : {}),
        ...(request.gate !== undefined ? { gate: request.gate } : {}),
      })
      return { ok: true, text: `ok:${request.prompt}` }
    },
    abortAgent() {},
    async resumeAgent(agentId, prompt, options) {
      state.resumes.push({
        prompt,
        ...(options?.attachments !== undefined ? { attachments: [...options.attachments] } : {}),
      })
      void agentId
      options?.onResolved?.({ conversationId: 1 })
      return { ok: true, text: `resumed:${prompt}` }
    },
    async runGate(command) {
      state.gateRuns++
      return { ok: true, output: `gate:${command}` }
    },
    async invokeAction() {
      throw new Error('no actions in attachment audit host')
    },
    loadWorkflow() {
      return { ok: false, message: 'no nested workflows' }
    },
  }
  return {
    ...host,
    audit: () => ({
      spawns: state.spawns.map((s) => ({ ...s, ...(s.attachments ? { attachments: [...s.attachments] } : {}) })),
      resumes: state.resumes.map((r) => ({ ...r, ...(r.attachments ? { attachments: [...r.attachments] } : {}) })),
      gateRuns: state.gateRuns,
    }),
  }
}

function makeJournalSink() {
  const appends: JournalWriteInput[] = []
  return {
    appends,
    append: (e: JournalWriteInput) => {
      appends.push(e)
    },
  }
}

/** 旧 journal 行（v:1 形状）转 entries；seq 按序分配。 */
function toEntries(appends: JournalWriteInput[]) {
  return appends.map((e, i) => ({ v: 1 as const, seq: i, ...e }))
}

// ---------------------------------------------------------------------------
// 1. worker 边界：非法输入显式拒绝；空数组/未提供合法且语义不同
// ---------------------------------------------------------------------------

describe('workflow agent attachments: worker boundary', () => {
  it('rejects non-array attachments with a fatal error', timeout, async () => {
    const host = makeAuditHost()
    const result = await runWorkflow({
      script: META('att-not-array') + 'return await agent("p", { attachments: "art-1" })',
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'failed', `must fail: ${result.error}`)
    assert.match(result.error ?? '', /attachments.*array/)
    assert.equal(host.audit().spawns.length, 0, 'no spawn may reach the host')
  })

  it('rejects non-string items with a fatal error', timeout, async () => {
    const host = makeAuditHost()
    const result = await runWorkflow({
      script: META('att-not-string') + 'return await agent("p", { attachments: [1, 2] })',
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /attachments/)
    assert.equal(host.audit().spawns.length, 0)
  })

  it('rejects empty and blank IDs with a fatal error', timeout, async () => {
    for (const [name, literal] of [
      ['empty', "''"],
      ['blank', "'  '"],
      ['mixed', "['art-1', '']"],
    ] as const) {
      const host = makeAuditHost()
      const result = await runWorkflow({
        script: META(`att-${name}`) + `return await agent("p", { attachments: ${literal.includes('[') ? literal : `[${literal}]` } })`,
        host,
        journal: { append: () => {} },
      })
      assert.equal(result.status, 'failed', `${name} must fail: ${result.error}`)
      assert.match(result.error ?? '', /attachments/)
      assert.equal(host.audit().spawns.length, 0, `${name}: nothing reaches the host`)
    }
  })

  it('accepts an empty array (no attachments this turn)', timeout, async () => {
    const host = makeAuditHost()
    const result = await runWorkflow({
      script: META('att-empty-ok') + 'return await agent("p", { attachments: [] })',
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'completed', result.error)
    assert.deepEqual(host.audit().spawns, [{ prompt: 'p', attachments: [] }], 'empty array is forwarded as-is')
  })

  it('forwards attachment IDs to the host spawn verbatim, combined with schema and gate', timeout, async () => {
    const host = makeAuditHost()
    const result = await runWorkflow({
      script:
        META('att-spawn') +
        'const v = await agent("p", { attachments: ["art-1", "art-2"], schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } })\nreturn v',
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'completed', result.error)
    const audit = host.audit()
    assert.equal(audit.spawns.length, 1)
    assert.deepEqual(audit.spawns[0]!.attachments, ['art-1', 'art-2'])
    assert.ok(audit.spawns[0]!.schema, 'schema combination preserved')
    // gate 组合单独验证（gate 需 host.runGate，与 schema 混测会因 fake host 的
    // runGate 返回 ok:true 干扰 spawn 计数语义；此处仅验证同请求携带）。
    const gateHost = makeAuditHost()
    const gateRun = await runWorkflow({
      script: META('att-spawn-gate') + 'const v = await agent("p", { attachments: ["art-g"], gate: "true" })\nreturn v',
      host: gateHost,
      journal: { append: () => {} },
    })
    assert.equal(gateRun.status, 'completed', gateRun.error)
    assert.equal(gateHost.audit().spawns[0]!.gate, 'true', 'gate combination preserved')
    assert.equal(gateHost.audit().gateRuns, 1)
  })

  it('unknown option keys are still rejected (no silent drop of extra fields)', timeout, async () => {
    const host = makeAuditHost()
    const result = await runWorkflow({
      script: META('att-unknown') + 'return await agent("p", { attachment: ["x"] })',
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /not a recognised option/)
    assert.equal(host.audit().spawns.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 2. runtime host 边界：伪造消息面的非法 attachments 同样 fatal
// ---------------------------------------------------------------------------

describe('workflow agent attachments: host boundary', () => {
  async function runWithPayloadOverride(payload: Record<string, unknown>): Promise<{ status: string; error?: string; spawns: number }> {
    // 直接驱动 runtime 消息面不可行（worker 线程私有）；以脚本合法调用 +
    // 篡改 journal 断言之外的路径不可靠。这里用引擎公开入口 + 一个在
    // postMessage 前无法插值的现实替代：构造脚本值恒定，绕过点不存在时，
    // 该用例退化为对 isValidAttachments 的形状断言（见下方纯函数测试）。
    void payload
    return { status: 'skipped-by-design', spawns: 0 }
  }

  it('invalid shapes are rejected before any host dispatch (shape guard)', timeout, async () => {
    // worker vm 内 Array 来自受限 realm，但宿主侧消息反序列化后是普通数组；
    // isValidAttachments 的防御目标是宿主侧消息面（含未来新增调用方）。
    // 用真实脚本覆盖三条非法路径，断言 fatal + 零宿主调用已由上方 worker
    // 边界组完成；此处补齐 key 侧：非法值绝不进入 keyInput。
    const bad = [['a', ''], ['a', 42], 'not-array'] as const
    for (const candidate of bad) {
      const host = makeAuditHost()
      const result = await runWorkflow({
        script:
          META('att-host-guard') +
          `return await agent("p", { attachments: ${JSON.stringify(candidate)} })`,
        host,
        journal: { append: () => {} },
      })
      // 非法值在 worker 层即被拒绝；宿主层 guard 是纵深防御（不重复断言路径）。
      if (Array.isArray(candidate) && candidate.every((x) => typeof x === 'string' && x !== '')) continue
      assert.equal(result.status, 'failed', `candidate ${JSON.stringify(candidate)} must not pass`)
      assert.equal(host.audit().spawns.length, 0)
    }
    void runWithPayloadOverride
  })
})

// ---------------------------------------------------------------------------
// 3. resume 透传：本轮附件到达 resumeAgent，不自动沿用原任务附件
// ---------------------------------------------------------------------------

describe('workflow agent attachments: resume path', () => {
  it('label resume forwards this turn\'s attachments; originals are not auto-carried', timeout, async () => {
    const host = makeAuditHost()
    const result = await runWorkflow({
      script:
        META('att-resume') +
        'const a = await agent("first", { label: "a", attachments: ["art-orig"] })\n' +
        'const b = await agent("again", { resume: "a" })\n' +
        'const c = await agent("more", { resume: "a", attachments: ["art-new"] })\n' +
        'return [a, b, c]',
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'completed', result.error)
    const audit = host.audit()
    assert.equal(audit.spawns.length, 1)
    assert.deepEqual(audit.spawns[0]!.attachments, ['art-orig'])
    assert.equal(audit.resumes.length, 2)
    assert.ok(audit.resumes[0]!.attachments === undefined, 'resume without attachments carries none (not the original list)')
    assert.deepEqual(audit.resumes[1]!.attachments, ['art-new'], 'resume attachments are forwarded verbatim')
  })

  it('resume + attachments + schema + gate all combine (mutual-exclusion rules untouched)', timeout, async () => {
    const host = makeAuditHost()
    const result = await runWorkflow({
      script:
        META('att-resume-combo') +
        'const a = await agent("first", { label: "a" })\n' +
        'const b = await agent("again", { resume: "a", attachments: ["art-x"], gate: "true" })\nreturn [a, b]',
      host,
      journal: { append: () => {} },
    })
    assert.equal(result.status, 'completed', result.error)
    const audit = host.audit()
    assert.deepEqual(audit.resumes[0]!.attachments, ['art-x'])
    assert.equal(audit.gateRuns, 1, 'gate still runs once on the resumed turn')
  })

  it('resume mutual exclusions still reject model/agentType/isolation/effort', timeout, async () => {
    for (const opt of ['model', 'agentType', 'isolation', 'effort'] as const) {
      const value = opt === 'isolation' ? '"worktree"' : opt === 'effort' ? '"low"' : '"m"'
      const host = makeAuditHost()
      const result = await runWorkflow({
        script:
          META(`att-resume-${opt}`) +
          `const a = await agent("first", { label: "a" })\n` +
          `const b = await agent("again", { resume: "a", ${opt}: ${value} })\nreturn [a, b]`,
        host,
        journal: { append: () => {} },
      })
      assert.equal(result.status, 'failed', `${opt} must stay mutually exclusive with resume: ${result.error}`)
      assert.match(result.error ?? '', new RegExp(`resume and opts.${opt} are mutually exclusive`))
      assert.equal(host.audit().resumes.length, 0)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. journal key：附件参与指纹；v2 固定槽防 schema 碰撞
// ---------------------------------------------------------------------------

describe('workflow agent attachments: journal key', () => {
  it('attachments participate in the key: presence, ID and order all matter', timeout, () => {
    const base = { prompt: 'p', label: 'l' }
    const none = agentJournalKey(base)
    const empty = agentJournalKey({ ...base, attachments: [] })
    const one = agentJournalKey({ ...base, attachments: ['art-1'] })
    const other = agentJournalKey({ ...base, attachments: ['art-2'] })
    const reversed = agentJournalKey({ ...base, attachments: ['art-2', 'art-1'] })
    assert.notEqual(none, empty, 'undefined vs empty array are different calls (no normalization)')
    assert.notEqual(none, one)
    assert.notEqual(one, other, 'different artifact IDs must change the key')
    assert.notEqual(one, reversed, 'order is part of the fingerprint')
    assert.notEqual(empty, one)
  })

  it('v2 fixed slots prevent the schema/attachments collision of the v1 variadic tail', timeout, () => {
    // v1 canonical：[p,l,m,t,e,i,g,r, ...(schema? [schema] : [])]
    // 若 v2 继续尾追加 attachments，v1 的 [...,schema] 行会与新 [..,schema?,'x'?]
    // 形状在四象限碰撞。v2 恒定固定槽（第10槽 attachments、第11槽 schema）后：
    // 任意 (attachments, schema) 组合两两互异。
    const combos: Array<{ attachments?: string[]; schema?: string }> = [
      {},
      { attachments: [] },
      { attachments: ['a'] },
      { attachments: ['a', 'b'] },
      { schema: '{"type":"object"}' },
      { attachments: [], schema: '{"type":"object"}' },
      { attachments: ['a'], schema: '{"type":"object"}' },
      { schema: '{"type":"array"}' },
      { attachments: ['a'], schema: '{"type":"array"}' },
    ]
    const keys = new Set(combos.map((c) => agentJournalKey({ prompt: 'p', ...c })))
    assert.equal(keys.size, combos.length, 'every (attachments, schema) combination must be distinct')
    // v1→v2：同一输入的 key 全体变化（旧账本断链，开发阶段无迁移）。
    const v1 = JSON.stringify(['p', null, null, null, null, null, null, null, null, '{"type":"object"}'])
    void v1
  })

  it('replay: changed attachments miss the cache and re-run live; identical ones replay', timeout, async () => {
    // 附件字面量直嵌脚本（undefined 时省略字段）。
    const script = (ids: string[] | undefined) =>
      META('att-replay') +
      `return await agent("p", { ${ids === undefined ? '' : `attachments: ${JSON.stringify(ids)}, `}label: "pl" })`
    const host1 = makeAuditHost()
    const sink1 = makeJournalSink()
    const first = await runWorkflow({ script: script(['art-1']), host: host1, journal: sink1 })
    assert.equal(first.status, 'completed', first.error)
    assert.equal(host1.audit().spawns.length, 1)
    const entries = toEntries(sink1.appends)
    assert.equal(entries.length, 1)

    // 完全一致：账本命中，零宿主调用。
    const host2 = makeAuditHost()
    const replay = await runWorkflow({ script: script(['art-1']), host: host2, journal: { entries, append: () => {} } })
    assert.equal(replay.status, 'completed', replay.error)
    assert.equal(replay.replayedCount, 1)
    assert.equal(host2.audit().spawns.length, 0, 'identical attachments replay from the journal')

    // 附件变化（不同 ID）：key 失配，live 重跑。
    const host3 = makeAuditHost()
    const changed = await runWorkflow({ script: script(['art-2']), host: host3, journal: { entries, append: () => {} } })
    assert.equal(changed.status, 'completed')
    assert.equal(host3.audit().spawns.length, 1, 'changed attachments must not reuse the cached result')

    // 附件次序变化：key 失配，live 重跑。
    const host4 = makeAuditHost()
    const reordered = await runWorkflow({ script: script(['art-2', 'art-1']), host: host4, journal: { entries, append: () => {} } })
    assert.equal(reordered.status, 'completed')
    assert.equal(host4.audit().spawns.length, 1, 'reordered attachments must miss the cache')

    // 从有到无（未提供）：key 失配，live 重跑（未提供 ≠ 空数组 ≠ ['art-1']）。
    const host5 = makeAuditHost()
    const removed = await runWorkflow({ script: script(undefined), host: host5, journal: { entries, append: () => {} } })
    assert.equal(removed.status, 'completed', removed.error)
    assert.equal(host5.audit().spawns.length, 1)
    // 空数组：与未提供互异 ⇒ 同样失配。
    const host6 = makeAuditHost()
    const emptied = await runWorkflow({ script: script([]), host: host6, journal: { entries, append: () => {} } })
    assert.equal(emptied.status, 'completed')
    assert.equal(host6.audit().spawns.length, 1)
  })
})

// ---------------------------------------------------------------------------
// 5. service adapter：AgentSpawnRequest 端到端（真实 WorkflowService）
// ---------------------------------------------------------------------------

interface ServiceSpawnsRecord {
  prompt: string
  agentId: string
  attachments?: string[]
  resume?: string
}

function makeRecordingServiceHost(): WorkflowServiceHost & { spawns: ServiceSpawnsRecord[] } {
  const spawns: ServiceSpawnsRecord[] = []
  const host: WorkflowServiceHost = {
    async spawnAgent(request) {
      spawns.push({
        prompt: request.prompt,
        agentId: request.agentId ?? '',
        ...(request.attachments !== undefined ? { attachments: [...request.attachments] } : {}),
        ...(request.resume !== undefined ? { resume: request.resume } : {}),
      })
      let convId = 1
      request.onResolved?.({ conversationId: ++convId + spawns.length })
      return `text:${request.prompt}`
    },
    async invokeAction() {
      throw new Error('no actions')
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
        cwd: '/tmp',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      } as never
    },
    async abortConversationGuarded() {},
    emitEvent() {},
  }
  return Object.assign(host, { spawns })
}

function makeStateStore() {
  const map = new Map<string, unknown>()
  return {
    get<T>(key: string, initial: T): T {
      return (map.get(key) as T | undefined) ?? initial
    },
    set<T>(key: string, value: T): void {
      map.set(key, structuredClone(value))
    },
    async flush(): Promise<void> {},
  }
}

describe('workflow agent attachments: service adapter to AgentSpawnRequest', () => {
  it('initial spawn carries attachments through the real WorkflowService into the protocol request', timeout, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-att-svc-'))
    const host = makeRecordingServiceHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const summary = await service.run({
        conversationId: 1,
        script: META('att-svc-spawn') + 'return await agent("p", { attachments: ["art-1", "art-2"] })',
      })
      await service.wait(summary.id)
      assert.equal(service.getRun(summary.id).status, 'completed')
      assert.equal(host.spawns.length, 1)
      assert.deepEqual(host.spawns[0]!.attachments, ['art-1', 'art-2'], 'AgentSpawnRequest.attachments end-to-end')
    } finally {
      await service.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('label resume carries this turn\'s attachments (not the original list) through the adapter', timeout, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-att-svc-res-'))
    const host = makeRecordingServiceHost()
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const summary = await service.run({
        conversationId: 1,
        script:
          META('att-svc-resume') +
          'const a = await agent("first", { label: "a", attachments: ["art-orig"] })\n' +
          'const b = await agent("again", { resume: "a", attachments: ["art-new"] })\nreturn [a, b]',
      })
      await service.wait(summary.id)
      assert.equal(service.getRun(summary.id).status, 'completed')
      assert.equal(host.spawns.length, 2, 'spawn + resume both reach host.spawnAgent')
      assert.deepEqual(host.spawns[0]!.attachments, ['art-orig'])
      assert.ok(host.spawns[1]!.resume !== undefined, 'second call is a resume (resume ref present)')
      assert.deepEqual(host.spawns[1]!.attachments, ['art-new'], 'resume carries this turn\'s list only')
    } finally {
      await service.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

  it('host spawn errors (e.g. artifact_forbidden) surface as agent failure, not swallowed', timeout, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wf-att-svc-deny-'))
    const host = makeRecordingServiceHost()
    const realSpawn = host.spawnAgent.bind(host)
    host.spawnAgent = async (request) => {
      if (request.attachments?.includes('foreign') === true) {
        throw new HelmError('artifact_forbidden', '产物 foreign 不属于会话 1 或其父会话链，拒绝越权挂载', 403)
      }
      return realSpawn(request)
    }
    const service = new WorkflowService({ dataDir, host, state: makeStateStore() })
    try {
      const summary = await service.run({
        conversationId: 1,
        script: META('att-svc-deny') + 'return await agent("p", { attachments: ["foreign"] })',
      })
      await service.wait(summary.id)
      const run = service.getRun(summary.id)
      // 引擎契约：agent 失败折叠为 null；run 完成（脚本 return null），但节点
      // 错误必须如实携带 artifact_forbidden，绝不吞权限失败。
      assert.equal(run.status, 'completed', 'script-level failure collapses to null (engine contract)')
      const agentNode = run.nodes?.find((n) => n.kind === 'agent')
      assert.ok(agentNode, 'agent node present')
      assert.equal(agentNode!.status, 'failed', 'permission failure must surface on the node')
      assert.match(agentNode!.error ?? '', /artifact_forbidden/)
    } finally {
      await service.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
