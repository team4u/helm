/**
 * workflow-resume-replay.test.ts — resume 账本重放的副作用零重复回归（真实引擎）。
 *
 * 定位缺陷：runtime 曾因旧账本含任意一次 agent({ resume })（resumed 标记）就整体
 * 禁用前缀重放（prefixIntact=false），导致 resume run 把已确认成功的 action 与
 * agent 全部 live 重跑——外部副作用重复执行，违反设计"成功前缀复用、已完成动作
 * 不重复"。真实 Herdr smoke 验收因此被降级为"结果相似"，本套件把验收拉回
 * "不重复副作用"的硬断言：外部 handler 调用计数在重放时严格不增。
 *
 * 全部用真实 runWorkflow（真 worker_threads + node:vm）与可控外部 host：
 * ① action + agent（含 resume 调用）首次全部成功 → 保存真实 journal → 同脚本
 *   重放：所有外部 handler 计数零新增、结果严格等价（deepEqual，非相似）；
 * ② 缓存前缀之后新增需要 live resume 的步骤：显式失败（replayed 上下文不可
 *   续接），先前 action 计数不变，不伪造 live child；
 * ③ gate 参与 agent journal key：改 gate 命令后 key 失配，新 gate 确实执行；
 *   gate 未变时重放不重跑 gate；
 * ④ 正常 native/live 同 label resume（无账本）行为不变。
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { WorkflowJournalEntry } from '@helm/protocol'
import {
  actionJournalKey,
  agentJournalKey,
  type JournalWriteInput,
} from '../src/workflow/journal.js'
import { runWorkflow, type WorkflowHost, type WorkflowSpawnResult } from '../src/workflow/runtime.js'

const timeout = { timeout: 60_000 } as const

const META = (name: string) => `export const meta = { name: "${name}", description: "test" }\n`

/**
 * 可控外部 host：每个外部接缝（spawn/resume/gate/action）都带调用计数与
 * 调用日志。计数是"副作用是否重复"的唯一事实来源，不作任何缓存。
 */
interface HostAudit {
  spawns: number
  resumes: number
  gateRuns: number
  actionCalls: number
  /** spawn/resume 收到的 prompt 列表（区分调用来源）。 */
  prompts: string[]
  /** resume 调用是否发生（伪造 live child 检测）。 */
  resumedLabels: string[]
}

function makeAuditedHost(): WorkflowHost & { audit(): HostAudit } {
  const state: HostAudit = {
    spawns: 0,
    resumes: 0,
    gateRuns: 0,
    actionCalls: 0,
    prompts: [],
    resumedLabels: [],
  }
  const host: WorkflowHost = {
    async spawnAgent(request) {
      state.spawns++
      state.prompts.push(request.prompt)
      return { ok: true, text: `ok:${request.prompt}` }
    },
    abortAgent() {},
    async resumeAgent(agentId, prompt) {
      state.resumes++
      state.prompts.push(prompt)
      state.resumedLabels.push(agentId)
      return { ok: true, text: `resumed:${prompt}` }
    },
    async runGate(command) {
      state.gateRuns++
      return { ok: command !== 'false', output: `gate:${command}` }
    },
    async invokeAction(actionId, input) {
      state.actionCalls++
      return { pluginId: 'p', actionId, result: { echoed: input, n: state.actionCalls } }
    },
    loadWorkflow() {
      return { ok: false, message: 'no nested workflows in audited host' }
    },
  }
  return { ...host, audit: () => ({ ...state, prompts: [...state.prompts], resumedLabels: [...state.resumedLabels] }) }
}

/** 以数组为底的 journal append（真实 runWorkflow 的记账回调，非 mock 引擎）。 */
function makeJournalSink() {
  const appends: JournalWriteInput[] = []
  const toEntries = (): WorkflowJournalEntry[] =>
    appends.map((e, i) => ({ v: 1, seq: i, ...e }) as WorkflowJournalEntry)
  return {
    append: (e: JournalWriteInput) => {
      appends.push(e)
    },
    appends,
    toEntries,
  }
}

// ---------------------------------------------------------------------------
// ① 副作用零重复：action + agent + agent({ resume }) 成功前缀整段重放
// ---------------------------------------------------------------------------

describe('workflow resume replay side-effect safety', () => {
  it('replays a successful prefix containing a resumed agent call without re-running any external handler', timeout, async () => {
    // 首次 run：action → agent(label a) → agent({ resume: 'a' })。
    // resume 调用在账本中落 resumed:true 行——这是缺陷触发器。
    const script =
      META('replay-resumed') +
      `
      const v = await action("p.echo", { x: 1 })
      const a = await agent("first", { label: "a" })
      const b = await agent("again", { resume: "a" })
      return [v, a, b]
    `
    const host1 = makeAuditedHost()
    const sink1 = makeJournalSink()
    const first = await runWorkflow({ script, host: host1, journal: sink1 })
    assert.equal(first.status, 'completed', first.error)
    assert.deepEqual(first.value, [{ echoed: { x: 1 }, n: 1 }, 'ok:first', 'resumed:again'])
    const afterFirst = host1.audit()
    assert.equal(afterFirst.actionCalls, 1)
    assert.equal(afterFirst.spawns, 1)
    assert.equal(afterFirst.resumes, 1)

    // 真实账本必须含 resumed 标记行（触发器确实存在，不是人为构造）。
    const entries = sink1.toEntries()
    const resumedLines = entries.filter((e) => e.type === 'agent' && e.resumed === true)
    assert.equal(resumedLines.length, 1, 'journal must record the resumed agent call')

    // 同脚本重放：新 host，所有外部计数必须保持为零。
    const host2 = makeAuditedHost()
    const sink2 = makeJournalSink()
    const replay = await runWorkflow({
      script,
      host: host2,
      journal: { entries, append: sink2.append },
    })
    assert.equal(replay.status, 'completed', replay.error)
    assert.deepEqual(replay.value, first.value, 'replay result must be strictly equal')
    const audit = host2.audit()
    assert.equal(audit.actionCalls, 0, 'replay must not re-execute the action side effect')
    assert.equal(audit.spawns, 0, 'replay must not re-spawn agents')
    assert.equal(audit.resumes, 0, 'replay must not re-resume agents')
    assert.equal(audit.gateRuns, 0)

    // 重放 run 的新账本保留 resumed 标记（缓存分支记账不丢字段）。
    const replayEntries = sink2.toEntries()
    const replayResumed = replayEntries.filter((e) => e.type === 'agent' && e.resumed === true)
    assert.equal(replayResumed.length, 1, 'replay bookkeeping must preserve the resumed mark')
    assert.equal(replay.replayedCount, 3, 'all three calls replay from the journal')
  })

  // -------------------------------------------------------------------------
  // ② 缓存前缀之后需要 live resume：显式失败，不伪造 live child
  // -------------------------------------------------------------------------

  it('a live resume required after a cached prefix fails explicitly without faking a live child', timeout, async () => {
    // 脚本带开关：第二次调用只在前缀之后新增（前缀调用完全一致）。
    const script = (withTail: boolean) =>
      META('replay-then-live-resume') +
      `
      const v = await action("p.echo", { x: 1 })
      const a = await agent("first", { label: "a" })
      ${withTail ? 'const b = await agent("tail", { resume: "a" })' : ''}
      return [v, a${withTail ? ', b' : ''}]
    `
    const host1 = makeAuditedHost()
    const sink1 = makeJournalSink()
    const first = await runWorkflow({ script: script(false), host: host1, journal: sink1 })
    assert.equal(first.status, 'completed', first.error)
    assert.equal(host1.audit().actionCalls, 1)
    const entries = sink1.toEntries()

    // 重放前缀 + 尾部新增 resume：'a' 只存在于缓存（replayed）上下文，
    // 无活会话可续接。必须显式失败，且先前 action 不重复执行。
    const host2 = makeAuditedHost()
    const replay = await runWorkflow({
      script: script(true),
      host: host2,
      journal: { entries, append: () => {} },
    })
    assert.equal(replay.status, 'failed', `live resume after cached prefix must fail: ${JSON.stringify(replay.value)}`)
    assert.ok(replay.error !== undefined)
    assert.match(replay.error, /replayed \(cached\) context .* cannot be resumed/, 'must clearly state a replayed context is not resumable')
    const audit = host2.audit()
    assert.equal(audit.actionCalls, 0, 'the replayed action prefix must not re-execute')
    assert.equal(audit.resumes, 0, 'must not fake a live resume against a replayed child')
    assert.equal(audit.spawns, 0, 'must not re-spawn earlier prefix agents to rebuild context')
  })

  // -------------------------------------------------------------------------
  // ③ gate 参与 journal key：改 gate → key 失配 → 新 gate 确实执行
  // -------------------------------------------------------------------------

  it('changing the gate command breaks the agent journal key so the new gate really runs', timeout, async () => {
    // key 结构断言：gate 进入 canonical 槽（不同 gate ⇒ 不同 key）。
    const base = { prompt: 'g', label: 'gl' }
    const keyNoGate = agentJournalKey(base)
    const keyGateTrue = agentJournalKey({ ...base, gate: 'true' })
    const keyGateFalse = agentJournalKey({ ...base, gate: 'false' })
    assert.notEqual(keyNoGate, keyGateTrue, 'gate presence must change the agent key')
    assert.notEqual(keyGateTrue, keyGateFalse, 'different gate commands must produce different keys')

    const script = (gate: string) =>
      META('replay-gate') + `const v = await agent("g", { label: "gl", gate: "${gate}" })\nreturn v`

    // 首次：gate "true" 真实执行。
    const host1 = makeAuditedHost()
    const sink1 = makeJournalSink()
    const first = await runWorkflow({ script: script('true'), host: host1, journal: sink1 })
    assert.equal(first.status, 'completed', first.error)
    assert.equal(first.value, 'ok:g')
    assert.equal(host1.audit().gateRuns, 1)
    assert.equal(host1.audit().spawns, 1)
    const entries = sink1.toEntries()

    // 同 gate 重放：gate 不重跑、agent 不重 spawn（参数未变不重跑）。
    const host2 = makeAuditedHost()
    const replaySame = await runWorkflow({
      script: script('true'),
      host: host2,
      journal: { entries, append: () => {} },
    })
    assert.equal(replaySame.status, 'completed', replaySame.error)
    assert.equal(replaySame.value, 'ok:g')
    assert.equal(host2.audit().gateRuns, 0, 'unchanged gate must not re-run on replay')
    assert.equal(host2.audit().spawns, 0)

    // 改 gate：key 失配 ⇒ agent 重跑 + 新 gate 真实执行（false 令其失败）。
    const host3 = makeAuditedHost()
    const replayChanged = await runWorkflow({
      script: script('false'),
      host: host3,
      journal: { entries, append: () => {} },
    })
    assert.equal(replayChanged.status, 'completed')
    const audit3 = host3.audit()
    assert.equal(audit3.spawns, 1, 'changed gate must re-run the agent live')
    assert.equal(audit3.gateRuns, 1, 'changed gate must actually execute the new command')
    assert.equal(replayChanged.value, null, 'failing gate collapses the agent to null')
  })

  // -------------------------------------------------------------------------
  // ④ 正常 native/live 同 label resume（无账本）行为不变
  // -------------------------------------------------------------------------

  it('native same-label resume without a journal still resumes the live child', timeout, async () => {
    const host = makeAuditedHost()
    const script =
      META('live-resume') +
      `
      const a = await agent("first", { label: "a" })
      const b = await agent("again", { resume: "a" })
      return [a, b]
    `
    const result = await runWorkflow({ script, host, journal: { append: () => {} } })
    assert.equal(result.status, 'completed', result.error)
    assert.deepEqual(result.value, ['ok:first', 'resumed:again'])
    const audit = host.audit()
    assert.equal(audit.spawns, 1, 'first call spawns')
    assert.equal(audit.resumes, 1, 'second call resumes the same live child')
  })

  // -------------------------------------------------------------------------
  // 伪造/不一致 resumed 行不被当合法缓存（拒绝而非放行）
  // ---------------------------------------------------------------------------

  it('an inconsistent journal line (plain agent key marked resumed:true) is not a legal cache and breaks the prefix', timeout, async () => {
    // 普通 agent 调用（payload 无 resume）却落了 resumed:true —— 两者不可能由
    // 引擎真实产生一致写出。该行按失配处理：live 重跑，绝不当作合法缓存复用。
    const key = agentJournalKey({ prompt: 'p' })
    const entries: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'agent', index: 0, key, ok: true, text: 'x', resumed: true },
    ]
    const host = makeAuditedHost()
    const result = await runWorkflow({
      script: META('inconsistent-resumed') + 'return await agent("p")',
      host,
      journal: { entries, append: () => {} },
    })
    assert.equal(result.status, 'completed', result.error)
    assert.equal(result.value, 'ok:p')
    assert.equal(host.audit().spawns, 1, 'inconsistent resumed line must not be replayed as cache')
    assert.equal(result.replayedCount, 0)
  })

  it('an inconsistent journal line (resume call missing the resumed mark) fails the resume explicitly (no forged cache)', timeout, async () => {
    // 反向不一致：resume 调用的账本行却缺失 resumed 标记——同样不可能由引擎
    // 真实写出，拒绝作合法缓存。断链后该 resume 只能续接缓存子上下文，引擎
    // 以「replayed context 不可续接」显式失败，不伪造缓存文本、不重建假续接。
    const script =
      META('inconsistent-resumed-2') +
      'const a = await agent("first", { label: "a" })\nconst b = await agent("again", { resume: "a" })\nreturn [a, b]'
    const firstKey = agentJournalKey({ prompt: 'first', label: 'a' })
    const resumeKey = agentJournalKey({ prompt: 'again', resume: 'a' })
    const entries: WorkflowJournalEntry[] = [
      { v: 1, seq: 0, type: 'agent', index: 0, key: firstKey, ok: true, text: 'ok:first' },
      // 不一致 fixture：resume 调用的行却无 resumed 标记。
      { v: 1, seq: 1, type: 'agent', index: 1, key: resumeKey, ok: true, text: 'forged' },
    ]
    const host = makeAuditedHost()
    const result = await runWorkflow({ script, host, journal: { entries, append: () => {} } })
    assert.equal(result.status, 'failed', 'inconsistent resume line must not be replayed as cache')
    assert.match(result.error ?? '', /replayed \(cached\) context .* cannot be resumed/)
    assert.equal(result.replayedCount, 1, 'the consistent first line still replays')
    const audit = host.audit()
    assert.equal(audit.spawns, 0, 'must not re-run the cached prefix agent')
    assert.equal(audit.resumes, 0, 'must not fake a live resume')
  })
})

// ---------------------------------------------------------------------------
// actionJournalKey 稳定性（guard：key 计算不受对象字段顺序影响）
// ---------------------------------------------------------------------------

describe('journal key stability', () => {
  it('agentJournalKey is stable across key insertion order and distinguishes every option', timeout, () => {
    const a = agentJournalKey({ prompt: 'p', label: 'l', model: 'm', agentType: 't', effort: 'e', isolation: 'worktree', gate: 'g' })
    const b = agentJournalKey({ gate: 'g', isolation: 'worktree', effort: 'e', agentType: 't', model: 'm', label: 'l', prompt: 'p' })
    assert.equal(a, b, 'canonical key must not depend on input object key order')
    assert.notEqual(a, agentJournalKey({ prompt: 'p', label: 'l', model: 'm', agentType: 't', effort: 'e', isolation: 'worktree' }), 'gate must participate')
    assert.notEqual(agentJournalKey({ prompt: 'p' }), agentJournalKey({ prompt: 'p', schema: '{"type":"object"}' }), 'schema must participate')
  })

  it('actionJournalKey distinguishes actionId and serialized input', timeout, () => {
    assert.notEqual(actionJournalKey('a', '{}'), actionJournalKey('b', '{}'))
    assert.notEqual(actionJournalKey('a', '{"x":1}'), actionJournalKey('a', '{"x":2}'))
  })
})
