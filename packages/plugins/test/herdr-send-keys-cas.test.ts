/**
 * agent.send_keys 协议级 CAS、RPC 解析边界与 Ask 审批桥协调器全链路回归：
 * - 纯契约：buildSendKeysParams / parsePong / isStaleStateError / parseAgentResult / parsePaneRead；
 * - AskCoordinator 纯状态机：seq 回退墓碑失效、乱序旧观测不作废 pending、settleAllAsSuperseded 清空条目、
 *   keysSent=false 卡死同 seq 的 reopenUnresolved 逃生门；
 * - 全链路（真实 PluginHost + UDS 行协议 fixture）：
 *   a) 能力通告时 send_keys 携带 expected_state_seq 且按 target 冻结单次 ping；
 *   b) stale_state 竞态拒绝不重试、不记发送成功、Ask 安全收敛；
 *   c) 未通告 CAS 能力显式 herdr_cas_unsupported、pong 坏形状显式 herdr_protocol_violation；
 *   d) askId 三段归属校验与权威 agent.get 现查真实 seq；
 *   e) 启动期 blocked 先审批后 prompt、自愈追问遇 blocked 走同一审批桥；
 *   f) 远端无事件权威轮询销单、入库晚于首次销单收敛、身份漂移 herdr_ownership_lost 零发键；
 *   g) Ask 轮询瞬时故障退避容忍、持续失败先销单再保留现场、abort 销单失败退避有界、
 *      keepalive 窗格事件不登记幽灵 creating 审批条目。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError } from '@helm/protocol'
import {
  HerdrFakeBackend,
  StandardFakeHerdrTransport,
  agentInfoOf,
  herdrFileNameOf,
  openHerdrUnitEnv,
  scriptHerdrSuccess,
  spawnHerdrDirect,
  type HerdrUnitEnv,
} from './helpers/herdr-unit-fixture.js'
import { MemoryDocStore, waitFor as baseWaitFor } from './helpers/plugin-test-env.js'
import type { HerdrTransport } from '../src/herdr/contracts.js'
import { AskCoordinator, askKey } from '../src/herdr/asks.js'
import {
  SEND_KEYS_CAS_CAPABILITY,
  buildSendKeysParams,
  isStaleStateError,
  parseAgentResult,
  parsePaneRead,
  parsePong,
} from '../src/herdr/rpc.js'

const waitFor = (predicate: () => boolean | Promise<boolean>, timeoutMs = 8_000, intervalMs = 10): Promise<void> =>
  baseWaitFor(predicate, { timeoutMs, intervalMs, message: 'waitFor 超时：条件在限定时间内未成立' })

function prepareBlockedOutput(env: HerdrUnitEnv): void {
  env.transport.pongVersion = 'cas-test-server'
  env.transport.promptStatus = 'blocked'
  env.transport.onPrompt = (pane, text) => {
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${herdrFileNameOf(text)}`, 'approved')
  }
}

// ---------------------------------------------------------------------------
// 纯契约：RPC 解析边界与 AskCoordinator 状态机
// ---------------------------------------------------------------------------

test('契约: buildSendKeysParams / parsePong / isStaleStateError / parseAgentResult / parsePaneRead 严格边界', { timeout: 60_000 }, () => {
  assert.deepEqual(buildSendKeysParams({ target: 'ws:p1', keys: ['y'], expectedStateSeq: 41 }), {
    target: 'ws:p1',
    keys: ['y'],
    expected_state_seq: 41,
  })
  for (const bad of [
    { target: '', keys: ['y'], expectedStateSeq: 1 },
    { target: 'p', keys: [], expectedStateSeq: 1 },
    { target: 'p', keys: [''], expectedStateSeq: 1 },
    { target: 'p', keys: ['y'], expectedStateSeq: -1 },
    { target: 'p', keys: ['y'], expectedStateSeq: 1.5 },
    { target: 'p', keys: ['y'], expectedStateSeq: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => buildSendKeysParams(bad), HelmError)
  }

  const supported = parsePong({
    type: 'pong',
    version: '0.9.6-dev',
    protocol: 22,
    capabilities: { live_handoff: false, [SEND_KEYS_CAS_CAPABILITY]: true },
  })
  assert.equal(supported.sendKeysCas, true)
  assert.equal(supported.version, '0.9.6-dev')
  assert.equal(supported.protocol, 22)
  assert.equal(
    parsePong({
      type: 'pong',
      version: '0.9.5',
      protocol: 22,
      capabilities: { live_handoff: false, detached_server_daemon: false, endpoint_protocol_generation: 1 },
    }).sendKeysCas,
    false,
  )
  assert.equal(parsePong({ type: 'pong', version: 'v', protocol: 22 }).sendKeysCas, false)
  assert.equal(parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: null }).sendKeysCas, false)
  assert.equal(parsePong({ type: 'pong', version: 'v', protocol: 22, capabilities: { [SEND_KEYS_CAS_CAPABILITY]: false } }).sendKeysCas, false)

  for (const bad of [
    { type: 'ok' },
    { type: 'pong', protocol: 22 },
    { type: 'pong', version: '', protocol: 22 },
    { type: 'pong', version: 'v' },
    { type: 'pong', version: 'v', protocol: '22' },
    { type: 'pong', version: 'v', protocol: -1 },
    { type: 'pong', version: 'v', protocol: 22, capabilities: 'none' },
    { type: 'pong', version: 'v', protocol: 22, capabilities: [] },
    { type: 'pong', version: 'v', protocol: 22, capabilities: { [SEND_KEYS_CAS_CAPABILITY]: 'yes' } },
  ]) {
    assert.throws(() => parsePong(bad), (error: unknown) => (error as HelmError).code === 'herdr_protocol_violation')
  }

  assert.equal(isStaleStateError(new HelmError('stale_state', 'seq mismatch', 409)), true)
  assert.equal(isStaleStateError({ code: 'stale_state' }), true)
  assert.equal(isStaleStateError(new HelmError('herdr_timeout', 'no response', 504)), false)
  assert.equal(isStaleStateError(new Error('plain')), false)
  assert.equal(isStaleStateError(undefined), false)

  const badAgent = (agent: Record<string, unknown>) => ({ type: 'agent_info', agent })
  for (const fn of [
    () => parseAgentResult(badAgent({ pane_id: 'p', tab_id: 't', workspace_id: 'w', agent_status: 'idle' }), 'agent.get', 'agent_info'),
    () => parseAgentResult(badAgent({ pane_id: 'p', tab_id: 't', workspace_id: 'w', agent_status: 'idle', state_change_seq: 1.5 }), 'agent.get', 'agent_info'),
    () => parseAgentResult(badAgent({ pane_id: 'p', tab_id: 't', workspace_id: 'w', agent_status: 'idle', state_change_seq: -1 }), 'agent.get', 'agent_info'),
    () => parseAgentResult(badAgent({ pane_id: 'p', tab_id: 't', workspace_id: 'w', agent_status: 'exploded', state_change_seq: 1 }), 'agent.get', 'agent_info'),
    () => parsePaneRead({ type: 'pane_read', read: { pane_id: 'p', text: 42 } }),
    () => parsePaneRead({ type: 'pane_read', read: { pane_id: 'p' } }),
  ]) {
    assert.throws(fn, (e: unknown) => (e as HelmError).code === 'herdr_protocol_violation')
  }
  assert.equal(parsePaneRead({ type: 'pane_read', read: { pane_id: 'w1:p1', text: '' } }).text, '')
})

test('AskCoordinator 纯状态机：seq 回退墓碑失效、乱序旧观测不作废 pending、全量清空、livelock 逃生门', { timeout: 60_000 }, () => {
  // 1) 权威 seq 回退时墓碑同步失效。
  const asks1 = new AskCoordinator(() => {})
  const b1 = asks1.beginBlocked(undefined, 'w1:p1', 5)
  assert.ok('owner' in b1)
  asks1.settle(b1.owner, { keysSent: true })
  asks1.observeAuthority({ paneId: 'w1:p1', seq: 4, status: 'blocked' })
  assert.equal(asks1.get(undefined, 'w1:p1', 5), undefined)

  // 2) 乱序旧观测不作废 pending 条目，seq 推进仍作废。
  const asks2 = new AskCoordinator(() => {})
  const b2 = asks2.beginBlocked(undefined, 'w7:p1', 6)
  assert.ok('owner' in b2)
  asks2.markPending(b2.owner)
  assert.equal(asks2.observeAuthority({ paneId: 'w7:p1', seq: 4, status: 'blocked' }).length, 0)
  assert.equal(asks2.get(undefined, 'w7:p1', 6), b2.owner)
  const advanced = asks2.observeAuthority({ paneId: 'w7:p1', seq: 7, status: 'idle' })
  assert.equal(advanced.length, 1)
  assert.equal(advanced[0]!.askId, b2.owner.askId)
  assert.equal(asks2.get(undefined, 'w7:p1', 6), undefined)

  // 3) settleAllAsSuperseded 跨启用周期零残留。
  const asks3 = new AskCoordinator(() => {})
  const b3 = asks3.beginBlocked(undefined, 'w9:p1', 3)
  assert.ok('owner' in b3)
  asks3.markPending(b3.owner)
  asks3.settleAllAsSuperseded()
  assert.equal(asks3.pendingCount(), 0)
  assert.equal(asks3.describe().length, 0)
  assert.equal(asks3.get(undefined, 'w9:p1', 3), undefined)

  // 4) keysSent=false 卡死同 seq 可经 reopenUnresolved 重开审批。
  const asks4 = new AskCoordinator(() => {})
  const b4 = asks4.beginBlocked(undefined, 'w8:p1', 4)
  assert.ok('owner' in b4)
  asks4.settle(b4.owner, { keysSent: false })
  const reopened = asks4.reopenUnresolved(undefined, 'w8:p1', 4)
  assert.ok(reopened !== undefined)
  assert.equal(reopened!.askId, `${b4.owner.key}:r1`)
  assert.equal(reopened!.phase, 'creating')
})

// ---------------------------------------------------------------------------
// 全链路：CAS 能力门禁、stale_state 竞态与 askId 权威复核
// ---------------------------------------------------------------------------

test('审批桥 CAS: 能力通告时 send_keys 携带 expected_state_seq=条目 seq，ping 探测恰好一次', { timeout: 60_000 }, async () => {
  const env = await openHerdrUnitEnv()
  try {
    prepareBlockedOutput(env)
    const resultPromise = spawnHerdrDirect(env, { agentType: 'herdr:agy', cwd: join(env.dataDir, 'work') })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const askId = String(env.backend.createdAsks[0]!['id'])
    const entrySeq = Number(askId.slice(askId.lastIndexOf(':') + 1))
    assert.ok(Number.isSafeInteger(entrySeq) && entrySeq > 0)
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    const pingCalls = env.transport.calls.filter((c) => c.method === 'ping')
    assert.equal(pingCalls.length, 1)
    const sendCall = env.transport.calls.find((c) => c.method === 'agent.send_keys')!
    assert.ok(env.transport.calls.indexOf(pingCalls[0]!) < env.transport.calls.indexOf(sendCall))
    assert.equal(sendCall.params['expected_state_seq'], entrySeq)
    assert.deepEqual(sendCall.params['keys'], ['y'])
    const pane = [...env.transport.panes.values()][0]!
    env.transport.advancePane(pane.paneId, 'done')
    assert.equal(await resultPromise, 'approved')
    assert.ok(env.backend.notifications.some((n) => n.title === 'Herdr approval sent'))
  } finally {
    await env.close()
  }
})

test('审批桥 CAS: stale_state 拒绝时不重试、不记发送成功、Ask 安全收敛', { timeout: 60_000 }, async () => {
  const env = await openHerdrUnitEnv()
  try {
    prepareBlockedOutput(env)
    env.transport.raceKeysOnSend = true
    const resultPromise = spawnHerdrDirect(env, { agentType: 'herdr:agy', cwd: join(env.dataDir, 'work') })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const askId = String(env.backend.createdAsks[0]!['id'])
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.calls.filter((c) => c.method === 'agent.send_keys').length === 1)
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.send_keys').length, 1)
    assert.deepEqual(env.transport.sendKeysLog, [])
    await waitFor(() => env.backend.notifications.some((n) => n.title === 'Herdr approval superseded'))
    assert.ok(!env.backend.notifications.some((n) => n.title === 'Herdr approval sent'))
    const pane = [...env.transport.panes.values()][0]!
    env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    await delay(40)
    assert.equal(env.backend.createdAsks.length, 1)
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.send_keys').length, 1)
    env.transport.advancePane(pane.paneId, 'done')
    assert.equal(await resultPromise, 'approved')
  } finally {
    await env.close()
  }
})

test('审批桥 CAS: 未通告能力显式 herdr_cas_unsupported 零盲发；pong 坏形状显式 herdr_protocol_violation', { timeout: 60_000 }, async () => {
  const env1 = await openHerdrUnitEnv()
  try {
    prepareBlockedOutput(env1)
    env1.transport.pongCapabilities = {
      live_handoff: false,
      detached_server_daemon: false,
      endpoint_protocol_generation: 1,
    }
    const p1 = spawnHerdrDirect(env1, { agentType: 'herdr:agy', cwd: join(env1.dataDir, 'work') })
    await waitFor(() => env1.backend.createdAsks.length === 1)
    const askId = String(env1.backend.createdAsks[0]!['id'])
    env1.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await assert.rejects(p1, (error: unknown) => {
      assert.ok(error instanceof HelmError)
      assert.equal(error.code, 'herdr_cas_unsupported')
      assert.ok(error.message.includes(SEND_KEYS_CAS_CAPABILITY))
      assert.ok(error.message.includes('cas-test-server'))
      return true
    })
    assert.equal(env1.transport.calls.filter((c) => c.method === 'agent.send_keys').length, 0)
    const list = (await env1.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string }> }
    assert.equal(list.panes[0]!.outcome, 'failed')
  } finally {
    await env1.close()
  }

  const env2 = await openHerdrUnitEnv()
  try {
    prepareBlockedOutput(env2)
    env2.transport.pongResultOverride = { type: 'ok' }
    const p2 = spawnHerdrDirect(env2, { agentType: 'herdr:agy', cwd: join(env2.dataDir, 'work') })
    await waitFor(() => env2.backend.createdAsks.length === 1)
    const askId = String(env2.backend.createdAsks[0]!['id'])
    env2.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await assert.rejects(p2, (error: unknown) => error instanceof HelmError && error.code === 'herdr_protocol_violation')
    assert.equal(env2.transport.calls.filter((c) => c.method === 'agent.send_keys').length, 0)
  } finally {
    await env2.close()
  }
})

test('askId 三段归属校验：CAS resolver 拒绝伪造 id，现查权威 agent.get 真实 seq', { timeout: 60_000 }, async () => {
  const env = await openHerdrUnitEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnHerdrDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const pane = [...env.transport.panes.values()][0]!
    const realAskId = env.backend.createdAsks[0]!['id'] as string
    assert.equal(realAskId, askKey(undefined, pane.paneId, pane.seq))
    const resolver = [...env.backend.askSeqResolvers][0]!
    assert.equal(await resolver(realAskId), pane.seq)
    assert.equal(await resolver('herdr:local:ws-other:p9:5'), undefined)
    assert.equal(await resolver('not-an-ask-id'), undefined)
    env.transport.advancePane(pane.paneId, 'working')
    assert.equal(await resolver(realAskId), pane.seq)
    await waitFor(() => env.backend.cancelledAsks.some((c) => c.id === realAskId))
    const promptCall = env.transport.calls.find((c) => c.method === 'agent.prompt')!
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${herdrFileNameOf(promptCall.params['text'] as string)}`, 'resolver-ok')
    env.transport.advancePane(pane.paneId, 'done')
    assert.equal(await resultPromise, 'resolver-ok')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 启动期/自愈追问审批桥、远端轮询销单、身份漂移与退避有界容错
// ---------------------------------------------------------------------------

test('启动 blocked 先审批后 prompt；自愈追问遇 blocked 走同一审批桥完成交接', { timeout: 60_000 }, async () => {
  // 1) 启动期 blocked：审批先于 prompt。
  const env1 = await openHerdrUnitEnv()
  try {
    scriptHerdrSuccess(env1, 'after-startup')
    const original = env1.transport.call.bind(env1.transport)
    const transport: HerdrTransport = env1.transport
    transport.call = async (target, method, params) => {
      const pane = env1.transport.panes.get(String(params['target']))
      if (method === 'agent.prompt' && pane?.agentStatus === 'blocked') {
        throw new HelmError('agent_blocked', 'must approve first', 409)
      }
      const result = await original(target, method, params)
      if (method === 'agent.start') {
        const started = env1.transport.panes.get(String(params['pane_id']))!
        started.agentStatus = 'blocked'
        started.seq += 1
        return { type: 'agent_started', agent: agentInfoOf(started) }
      }
      return result
    }
    const controller = new AbortController()
    const observed = spawnHerdrDirect(env1, { agentType: 'herdr:pi', signal: controller.signal }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      await waitFor(() => env1.backend.createdAsks.length === 1 || env1.transport.calls.some((call) => call.method === 'agent.prompt'), 1_000)
      assert.equal(env1.backend.createdAsks.length, 1, '启动审批应先于 prompt')
      const pane = [...env1.transport.panes.values()][0]!
      env1.backend.answerAsk(String(env1.backend.createdAsks[0]!['id']), { id: 'answer', status: 'answered', answers: { decision: 'allow-y' } })
      await waitFor(() => env1.transport.sendKeysLog.length === 1)
      env1.transport.advancePane(pane.paneId, 'idle')
      assert.deepEqual(await observed, { value: 'after-startup' })
    } finally {
      controller.abort()
      await observed
    }
  } finally {
    await env1.close()
  }

  // 2) 自愈追问遇 blocked：同一审批桥等待，缺文件不直接判失败。
  const env2 = await openHerdrUnitEnv()
  try {
    env2.transport.promptStatus = ['done', 'blocked']
    env2.transport.onPrompt = () => {}
    const resultPromise = spawnHerdrDirect(env2, { agentType: 'herdr:agy' })
    await waitFor(() => env2.backend.createdAsks.length === 1)
    const askId = env2.backend.createdAsks[0]!['id'] as string
    env2.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env2.transport.sendKeysLog.length === 1)
    const pane = [...env2.transport.panes.values()][0]!
    const healPrompt = env2.transport.calls.filter((c) => c.method === 'agent.prompt').pop()!
    env2.transport.outputFiles.set(`${pane.cwd}/.helm/${herdrFileNameOf(healPrompt.params['text'] as string)}`, 'healed-after-ask')
    env2.transport.advancePane(pane.paneId, 'done')
    assert.equal(await resultPromise, 'healed-after-ask')
  } finally {
    await env2.close()
  }
})

test('远端无 socket 事件权威轮询销单 + 创建 Ask 入库晚于首次销单仍收敛无残留', { timeout: 60_000 }, async () => {
  // 1) 远端无事件轮询销单并重建下一轮 blocked Ask。
  const env1 = await openHerdrUnitEnv()
  const c1 = new AbortController()
  let obs1: Promise<unknown> | undefined
  try {
    env1.transport.promptStatus = 'blocked'
    env1.transport.emit = () => {}
    obs1 = spawnHerdrDirect(env1, { agentType: 'herdr:pi@remote-host', signal: c1.signal }).catch((e: unknown) => e)
    await waitFor(() => env1.backend.createdAsks.length === 1)
    const pane = [...env1.transport.panes.values()][0]!
    const firstId = String(env1.backend.createdAsks[0]!['id'])
    pane.seq += 1
    pane.agentStatus = 'working'
    await waitFor(() => env1.backend.cancelledAsks.some((ask) => ask.id === firstId), 1_500)
    pane.seq += 1
    pane.agentStatus = 'blocked'
    await waitFor(() => env1.backend.createdAsks.length === 2, 1_500)
    assert.notEqual(env1.backend.createdAsks[1]!['id'], firstId)
  } finally {
    c1.abort()
    await obs1
    await env1.close()
  }

  // 2) createAsk 入库晚于首次销单时，后续轮询仍销掉真实 pending Ask。
  const backend = new HerdrFakeBackend()
  const rawCreate = backend.createAsk.bind(backend)
  let releaseGate!: () => void
  let creating = false
  const gate = new Promise<void>((resolve) => { releaseGate = resolve })
  backend.createAsk = async (spec) => {
    creating = true
    await gate
    return rawCreate(spec)
  }
  const env2 = await openHerdrUnitEnv({ backend })
  const c2 = new AbortController()
  let obs2: Promise<unknown> | undefined
  try {
    scriptHerdrSuccess(env2, 'terminal-completed')
    env2.transport.promptStatus = 'blocked'
    obs2 = spawnHerdrDirect(env2, { agentType: 'herdr:pi@remote-host', signal: c2.signal }).catch((e: unknown) => e)
    await waitFor(() => creating)
    const pane = [...env2.transport.panes.values()][0]!
    pane.seq += 1
    pane.agentStatus = 'done'
    await waitFor(() => backend.cancelledAsks.length > 0)
    assert.equal(backend.createdAsks.length, 0)
    releaseGate()
    assert.equal(await obs2, 'terminal-completed')
    assert.equal(backend.pendingAskResolvers.size, 0)
  } finally {
    releaseGate()
    c2.abort()
    await obs2
    await env2.close()
  }
})

test('审批等待期间 Agent 身份变化抛 herdr_ownership_lost 绝不发键；keepalive 窗格事件不登记幽灵 creating', { timeout: 60_000 }, async () => {
  const docs = new MemoryDocStore()
  const env = await openHerdrUnitEnv({ docs })
  let observed: Promise<unknown> | undefined
  try {
    // A) keepalive 窗格收到 blocked 事件不预登记幽灵 pendingAsk。
    scriptHerdrSuccess(env, 'done-ok')
    await spawnHerdrDirect(env, { agentType: 'herdr:pi' })
    const keepPane = [...env.transport.panes.values()][0]!
    await delay(5)
    const updatedAtBefore = docs.get('builtin:herdr:overview', { updatedAt: 0 } as { updatedAt: number }).updatedAt
    keepPane.seq += 1
    keepPane.agentStatus = 'blocked'
    env.transport.emit({ type: 'pane.updated', paneId: keepPane.paneId })
    await waitFor(() => docs.get('builtin:herdr:overview', { updatedAt: 0 } as { updatedAt: number }).updatedAt > updatedAtBefore)
    await delay(30)
    assert.equal(docs.get('builtin:herdr:overview', { asks: [] } as { asks: unknown[] }).asks.length, 0)

    // B) 审批等待期间 Agent 身份漂移：答案绝不发到人类进程且不误关窗格。
    env.transport.promptStatus = 'blocked'
    env.transport.onPrompt = undefined
    observed = spawnHerdrDirect(env, { agentType: 'herdr:pi' }).catch((error: unknown) => error)
    await waitFor(() => env.backend.createdAsks.length === 1)
    const activePane = [...env.transport.panes.values()].at(-1)!
    activePane.name = 'human-agent'
    const askId = String(env.backend.createdAsks[0]!['id'])
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    assert.equal(((await observed) as HelmError).code, 'herdr_ownership_lost')
    assert.equal(env.transport.sendKeysLog.length, 0)
    assert.equal(env.transport.tabs.get(activePane.tabId)?.closed, false)
  } finally {
    await observed
    await env.close()
  }
})

test('Ask 存续轮询容错：瞬时 herdr_timeout 退避容忍、持续失败先销单保留现场、abort 销单风暴有界', { timeout: 60_000 }, async () => {
  // 1) 瞬时 herdr_timeout 两次后恢复。
  const env1 = await openHerdrUnitEnv()
  const c1 = new AbortController()
  let obs1: Promise<unknown> | undefined
  try {
    scriptHerdrSuccess(env1, 'transient-ok')
    env1.transport.promptStatus = 'blocked'
    let failuresLeft = 0
    let injected = 0
    const orig1 = env1.transport.call.bind(env1.transport)
    ;(env1.transport as HerdrTransport).call = async (target, method, params) => {
      if (method === 'agent.get' && failuresLeft > 0) {
        failuresLeft -= 1
        injected += 1
        throw new HelmError('herdr_timeout', 'transient blip', 504)
      }
      return orig1(target, method, params)
    }
    obs1 = spawnHerdrDirect(env1, { agentType: 'herdr:pi', signal: c1.signal }).then((value) => ({ value }), (error: unknown) => ({ error }))
    await waitFor(() => env1.backend.createdAsks.length === 1)
    failuresLeft = 2
    await waitFor(() => injected === 2, 5_000)
    await delay(50)
    const pane = [...env1.transport.panes.values()][0]!
    const askId = String(env1.backend.createdAsks[0]!['id'])
    env1.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env1.transport.sendKeysLog.length === 1)
    env1.transport.advancePane(pane.paneId, 'idle')
    assert.deepEqual(await obs1, { value: 'transient-ok' })
    assert.equal(env1.backend.pendingAskResolvers.size, 0)
  } finally {
    c1.abort()
    await obs1
    await env1.close()
  }

  // 2) 持续失败：先销宿主 AskDoc 再显式失败，保留现场。
  const env2 = await openHerdrUnitEnv()
  const c2 = new AbortController()
  let obs2: Promise<unknown> | undefined
  try {
    scriptHerdrSuccess(env2, 'never-reached')
    env2.transport.promptStatus = 'blocked'
    let persistentFailure = false
    const orig2 = env2.transport.call.bind(env2.transport)
    ;(env2.transport as HerdrTransport).call = async (target, method, params) => {
      if (method === 'agent.get' && persistentFailure) {
        throw new HelmError('herdr_timeout', 'node down', 504)
      }
      return orig2(target, method, params)
    }
    obs2 = spawnHerdrDirect(env2, { agentType: 'herdr:pi', signal: c2.signal }).catch((error: unknown) => error)
    await waitFor(() => env2.backend.createdAsks.length === 1)
    persistentFailure = true
    const askId = String(env2.backend.createdAsks[0]!['id'])
    const error = (await obs2) as HelmError
    assert.equal(error.code, 'herdr_timeout')
    assert.ok(env2.backend.cancelledAsks.some((ask) => ask.id === askId && ask.reason === 'cancelled'))
    assert.equal(env2.backend.pendingAskResolvers.size, 0)
    const pane = [...env2.transport.panes.values()][0]!
    assert.equal(env2.transport.tabs.get(pane.tabId)!.closed, false)
  } finally {
    c2.abort()
    await obs2
    await env2.close()
  }

  // 3) abort 后 cancelAsk 持续抛错时退避有界，不形成风暴。
  const backend3 = new HerdrFakeBackend()
  const cancelCalls: string[] = []
  backend3.cancelAsk = async (id: string) => {
    cancelCalls.push(id)
    throw new HelmError('ask_store_broken', 'cancel boom', 500)
  }
  const env3 = await openHerdrUnitEnv({ backend: backend3, transport: new StandardFakeHerdrTransport() })
  const c3 = new AbortController()
  let obs3: Promise<unknown> | undefined
  try {
    scriptHerdrSuccess(env3, 'never')
    env3.transport.promptStatus = 'blocked'
    obs3 = spawnHerdrDirect(env3, { agentType: 'herdr:pi', signal: c3.signal }).catch((error: unknown) => error)
    await waitFor(() => env3.backend.createdAsks.length === 1)
    const askId = String(env3.backend.createdAsks[0]!['id'])
    c3.abort()
    assert.equal(((await obs3) as HelmError).code, 'aborted')
    await waitFor(() => cancelCalls.filter((id) => id === askId).length >= 5, 3_000, 10)
    await delay(50)
    const count = cancelCalls.filter((id) => id === askId).length
    assert.ok(count >= 5 && count <= 7, `销单尝试有界（实际 ${count} 次）`)
    const stormNotifications = backend3.notifications.filter((n) => n.title === 'Herdr approval cancellation failed').length
    assert.ok(stormNotifications <= 7)
  } finally {
    c3.abort()
    await obs3
    await env3.close()
  }
})
