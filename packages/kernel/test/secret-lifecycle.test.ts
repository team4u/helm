/**
 * SecretStash 生命周期收敛测试：
 * - TTL（注入 clock 惰性失效）：到期仅停止注入（envFor/has/stats），byUuid 旧值
 *   继续用于全部输出脱敏（含跨 chunk 流式 KMP）；同名覆盖旧值同样脱敏；
 * - SecretLifetime 边界校验：ttlMs 有限正 safe integer 且不超 24h、scope 枚举、
 *   未知键拒绝（AskDoc spec 与 stash.put 共用同一套拒绝）；
 * - turn 作用域按「出生结算序」精确归属：本回合登记随结算回收、结算后登记
 *   （异步审批落地/late hook）属下一回合不被误扫、会话级不受结算影响、
 *   idle 不清扫；停止注入 != 停止脱敏；clear(conversationId) 回收脱敏旧值；
 * - AskService 接线：secretLifetime 仅 secret 字段允许、非法形状 400、
 *   合法值原样透传 stash（未声明 = 会话级，与旧行为一致）；
 * - buildSpawnEnv 最小授权：缺省不携带任何父会话机密、显式 secretNames 逐名
 *   注入、缺失/过期名字显式 404、非法形状 400；
 * - Herdr 窗格端到端：远端窗格默认无业务机密但保留受管 HELM_*（含节点通道
 *   hubUrl 回连）与 Profile 显式变量；同名 Profile 值不被未授予的父机密覆盖；
 *   显式授予时机密值权威；授予缺失名字在建窗副作用前显式拒绝；
 * - workflow journal 指纹：secretNames 参与调用 key（授予变化不复用旧缓存）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type PluginDefinition, type Profile } from '@helm/protocol'
import {
  MAX_SECRET_TTL_MS,
  SecretStash,
  validateSecretLifetime,
} from '../src/services/index.js'
import { agentJournalKey } from '../src/builtin-plugins/workflow/engine/journal.js'
import { createHelm } from '../src/app.js'
import { AskService } from '../src/runtime/asks.js'
import { HelmStore } from '../src/runtime/store.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { RuntimeAgentSpawn } from '../src/runtime/runtime-agent-spawn.js'
import { HerdrExecutor, type ExecutorHost } from '../src/builtin-plugins/herdr/executor.js'
import { PaneRegistry, EMPTY_MANAGED_DOC, type ManagedDoc } from '../src/builtin-plugins/herdr/panes.js'
import { AskCoordinator } from '../src/builtin-plugins/herdr/asks.js'
import { MetadataProjector } from '../src/builtin-plugins/herdr/metadata.js'
import type { HerdrEvent, HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'

// ---------------------------------------------------------------------------
// SecretStash：TTL（fake clock）
// ---------------------------------------------------------------------------

/** fake clock stash：now 可任意推进。 */
function fakeClockStash(): { stash: SecretStash; now: { ms: number } } {
  const now = { ms: 1_000_000 }
  return { stash: new SecretStash({ now: () => now.ms }), now }
}

test('TTL：注入 clock 惰性失效——到期仅停注入，脱敏继续（含流式跨 chunk）', { timeout: 60_000 }, () => {
  const { stash, now } = fakeClockStash()
  stash.put(7, 'DEPLOY_TOKEN', 'tok-abc-123', { ttlMs: 5_000 })
  assert.deepEqual(stash.envFor(7), { DEPLOY_TOKEN: 'tok-abc-123' })
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), true)

  now.ms += 4_999
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), true, '到期前一刻仍注入')
  assert.deepEqual(stash.stats(), { conversations: 1, secrets: 1 })

  now.ms += 1
  assert.deepEqual(stash.envFor(7), {}, '到期即停止注入（读路径惰性回收）')
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), false)
  assert.deepEqual(stash.stats(), { conversations: 1, secrets: 0 })

  // 停止注入 != 停止脱敏：旧值仍替换为占位符。
  assert.equal(stash.redact('leak: tok-abc-123').includes('tok-abc-123'), false)
  assert.ok(stash.redact('leak: tok-abc-123').startsWith('leak: [REDACTED:stash:'))

  // 流式 redactor 跨 chunk 撕裂匹配在到期后依旧脱敏（KMP 后缀保持）。
  const stream = stash.createStreamingRedactor()
  const out = stream.push('prefix tok-abc-') + stream.push('123 tail') + stream.flush()
  assert.equal(out.includes('tok-abc-123'), false)
  assert.ok(out.includes('[REDACTED:stash:'))
})

test('TTL：同名覆盖旧值——旧值停止注入后仍被脱敏（两个值都不可回显）', { timeout: 60_000 }, () => {
  const { stash, now } = fakeClockStash()
  stash.put(7, 'KEY', 'old-value', { ttlMs: 1_000 })
  now.ms += 2_000
  stash.put(7, 'KEY', 'new-value')
  assert.deepEqual(stash.envFor(7), { KEY: 'new-value' }, '新值生效')
  const text = stash.redact('old-value / new-value')
  assert.equal(text.includes('old-value'), false, '已过期旧值继续脱敏')
  assert.equal(text.includes('new-value'), false)
})

test('TTL 上限边界：恰好 24h 合法，超出/非整数/非正/非数值拒绝', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'OK_TTL', 'v', { ttlMs: MAX_SECRET_TTL_MS })
  assert.equal(stash.has(7, 'OK_TTL'), true)
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER * 2, Infinity, NaN, '3000', null]) {
    assert.throws(
      () => stash.put(7, 'BAD_TTL', 'v', { ttlMs: bad as number }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      `ttlMs=${String(bad)} 必须拒绝`,
    )
  }
  assert.throws(
    () => validateSecretLifetime({ ttlMs: MAX_SECRET_TTL_MS + 1 }, 't'),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
  )
})

test('SecretLifetime 形状：scope 枚举、未知键、非对象均拒绝；空对象合法（=缺省语义）', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  assert.throws(
    () => stash.put(7, 'S', 'v', { scope: 'session' } as never),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
  )
  assert.throws(
    () => stash.put(7, 'S', 'v', { ttl: 5_000 } as never),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    "未知键 'ttl'（ttlMs 拼写错漏必须显式失败，不能静默变成无 TTL）",
  )
  assert.throws(() => stash.put(7, 'S', 'v', null as never), /validation_error|需为对象/)
  assert.throws(() => stash.put(7, 'S', 'v', [1] as never), /validation_error|需为对象/)
  assert.throws(() => stash.put(7, 'S', 'v', new Date() as never), /validation_error|需为对象/)
  assert.throws(() => stash.put(7, 'S', 'v', new Map() as never), /validation_error|需为对象/)
  stash.put(7, 'S', 'v', {})
  assert.equal(stash.has(7, 'S'), true, '空对象 = 缺省会话级')
})

// ---------------------------------------------------------------------------
// SecretStash：turn 作用域（出生结算序）
// ---------------------------------------------------------------------------

test('turn：本回合登记随结算回收（停止注入），脱敏继续；会话级不受结算影响', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'TURN_KEY', 'turn-secret', { scope: 'turn' })
  stash.put(7, 'SESSION_KEY', 'session-secret')
  stash.settleTurn(7)
  assert.equal(stash.has(7, 'TURN_KEY'), false)
  assert.equal(stash.has(7, 'SESSION_KEY'), true, '会话级（缺省）不随回合结算回收')
  assert.deepEqual(stash.envFor(7), { SESSION_KEY: 'session-secret' })
  assert.equal(stash.redact('turn-secret').includes('turn-secret'), false, '结算后旧值继续脱敏')
})

test('turn：旧回合结束不清新回合机密——结算后登记属下一回合，idle 不清扫', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'A', 'a', { scope: 'turn' })
  stash.settleTurn(7) // 回合 A 结算：A 回收（出生序 0 < 1）。
  // 异步审批落地/late hook：结算之后登记（出生序 1），属下一回合。
  stash.put(7, 'B', 'b', { scope: 'turn' })
  stash.put(7, 'C', 'c', { scope: 'turn' })
  // 无任何 idle 扫描：下一回合进行中 B/C 持续注入。
  assert.deepEqual(stash.envFor(7), { B: 'b', C: 'c' })
  stash.settleTurn(7) // 回合 B 结算：回收出生序 < 2 的 B/C，不影响下一回合。
  assert.deepEqual(stash.envFor(7), {})
  assert.equal(stash.redact('b c').includes('b c'), false, '旧值继续脱敏')
})

test('turn：结算后（counter 已推进）再登记的 turn 机密在本次结算内存活', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.settleTurn(7)
  stash.put(7, 'LATE', 'late-value', { scope: 'turn' })
  stash.settleTurn(7)
  // LATE 出生序 1：第二次结算（counter 1→2）应回收它；但紧随第一次结算登记
  // 后、下一次结算前它必须存活——上一用例已覆盖存活面，这里回收面闭环。
  assert.equal(stash.has(7, 'LATE'), false)
})

test('turn：按会话隔离——会话 7 的结算不碰会话 8 的 turn 机密', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'K', 'v7', { scope: 'turn' })
  stash.put(8, 'K', 'v8', { scope: 'turn' })
  stash.settleTurn(7)
  assert.equal(stash.has(8, 'K'), true)
  assert.deepEqual(stash.envFor(8), { K: 'v8' })
})

test('clear：会话级回收同时停止注入与脱敏旧值；stats 归零', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'A', 'gone-value', { scope: 'turn' })
  stash.settleTurn(7)
  stash.put(7, 'B', 'live-value')
  stash.clear(7)
  assert.deepEqual(stash.envFor(7), {})
  assert.equal(stash.redact('gone-value live-value').includes('gone-value'), true, 'clear 后旧值不再替换（已回收）')
  assert.equal(stash.has(7, 'B'), false)
  assert.deepEqual(stash.stats(), { conversations: 0, secrets: 0 })
})

// ---------------------------------------------------------------------------
// AskService 接线（真实 store + SecretStash）
// ---------------------------------------------------------------------------

async function openAskCtx(): Promise<{ service: AskService; stash: SecretStash; close(): Promise<void> }> {
  const root = mkdtempSync(join(tmpdir(), 'helm-secret-ask-'))
  const db = await openHelmDatabase(join(root, 'state.db'))
  const store = new HelmStore(db)
  await store.load()
  const stash = new SecretStash()
  const service = new AskService({
    store,
    stash,
    onEvent: () => {},
    onConvPendingChanged: () => {},
    validateConversation: () => true,
  })
  return {
    service,
    stash,
    async close() {
      await store.close()
      await db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('AskService：secretLifetime 仅 secret 字段允许；非法形状 400 拒绝', { timeout: 60_000 }, async () => {
  const ctx = await openAskCtx()
  try {
    await assert.rejects(
      ctx.service.createAsk({
        conversationId: 1,
        ownerPluginId: 't',
        title: 'x',
        fields: [{ name: 'plain', label: 'p', type: 'text', secretLifetime: { scope: 'turn' } }],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      '非 secret 字段声明 secretLifetime 必须拒绝',
    )
    await assert.rejects(
      ctx.service.createAsk({
        conversationId: 1,
        ownerPluginId: 't',
        title: 'x',
        fields: [{ name: 'tok', label: 't', type: 'text', secret: true, secretLifetime: { ttlMs: 0 } }],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      '非法 ttlMs 必须在写库前拒绝',
    )
    await assert.rejects(
      ctx.service.createAsk({
        conversationId: 1,
        ownerPluginId: 't',
        title: 'x',
        fields: [{ name: 'tok', label: 't', type: 'text', secret: true, secretLifetime: { scopes: 'turn' } as never }],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      '未知键必须拒绝',
    )
  } finally {
    await ctx.close()
  }
})

test('AskService：合法 secretLifetime 透传 stash；未声明 = 会话级（不随结算回收）', { timeout: 60_000 }, async () => {
  const ctx = await openAskCtx()
  try {
    const settled = ctx.service.createAsk({
      conversationId: 1,
      ownerPluginId: 't',
      title: 'x',
      fields: [{ name: 'TURN_TOKEN', label: 't', type: 'text', secret: true, secretLifetime: { scope: 'turn' } }],
    })
    await ctx.service.answerAsk((await pollPending(ctx.service)).id, { TURN_TOKEN: 'turn-tok' })
    const plain = ctx.service.createAsk({
      conversationId: 1,
      ownerPluginId: 't',
      title: 'y',
      fields: [{ name: 'SESSION_TOKEN', label: 's', type: 'text', secret: true }],
    })
    await ctx.service.answerAsk((await pollPending(ctx.service)).id, { SESSION_TOKEN: 'session-tok' })

    assert.deepEqual(ctx.stash.envFor(1), { TURN_TOKEN: 'turn-tok', SESSION_TOKEN: 'session-tok' })
    ctx.stash.settleTurn(1)
    assert.deepEqual(ctx.stash.envFor(1), { SESSION_TOKEN: 'session-tok' }, 'turn 随结算停注入，未声明 = 会话级')
    assert.equal(ctx.stash.redact('turn-tok').includes('turn-tok'), false)
    // 两笔 ask 均已达终态，createAsk promise 已结算（不悬挂）。
    assert.equal((await settled).status, 'answered')
    assert.equal((await plain).status, 'answered')
  } finally {
    await ctx.close()
  }
})

/** 轮询 store 直到出现 pending ask（createAsk 异步入库）。 */
async function pollPending(service: AskService): Promise<{ id: string }> {
  for (let i = 0; i < 200; i += 1) {
    const pending = service.listPendingByConversation(1)
    if (pending.length > 0) return { id: pending[pending.length - 1]!.id }
    await delay(5)
  }
  throw new Error('pending ask 未入库')
}

// ---------------------------------------------------------------------------
// buildSpawnEnv：外部 spawn 最小授权
// ---------------------------------------------------------------------------

/** 最小 RuntimeAgentSpawn 装配（只驱动 buildSpawnEnv；其余端口 throw）。 */
function spawnEnvBackend(stash: SecretStash, options: { token?: string; nodeHubUrl?: string } = {}) {
  return new RuntimeAgentSpawn({
    store: { getConv: () => ({ nodeId: 'local' }) } as never,
    toolDeps: {
      dataDir: '/tmp/helm-spawnenv-data',
      defaultCwd: '/tmp/helm-spawnenv-default',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: (id: number) => stash.envFor(id),
      redact: (t: string) => stash.redact(t),
      ...(options.token !== undefined ? { processToken: () => options.token } : {}),
      envFabric: {
        getNodeHubUrl: (nodeId: string) => (nodeId === 'node-a' ? options.nodeHubUrl : undefined),
      } as never,
    } as never,
    harness: {} as never,
    registry: {} as never,
    tracker: {} as never,
    conversations: {} as never,
    events: {} as never,
    envFabric: {} as never,
    modelsRegistry: {} as never,
    hookBridge: {} as never,
    stashService: stash,
    updateConversation: (() => {
      throw new Error('本测试不触发')
    }) as never,
    markConversationOwnership: () => undefined,
  })
}

test('buildSpawnEnv：缺省零机密（最小授权），受管 HELM_* 完整', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'DEPLOY_TOKEN', 'tok-7')
  stash.put(7, 'API_KEY', 'key-7')
  const backend = spawnEnvBackend(stash, { token: 'managed-token' })
  const env = backend.buildSpawnEnv(7, '/w', 'local')
  assert.equal(env['DEPLOY_TOKEN'], undefined, '缺省不携带任何父会话机密')
  assert.equal(env['API_KEY'], undefined)
  assert.equal(env['HELM_ENV'], '1')
  assert.equal(env['HELM_CONVERSATION_ID'], '7')
  assert.equal(env['HELM_CWD'], '/w')
  assert.equal(env['HELM_NODE_ID'], 'local')
  assert.equal(env['HELM_DATA_DIR'], '/tmp/helm-spawnenv-data')
  assert.equal(env['HELM_TOKEN'], 'managed-token', '受管 token 与机密授予正交')
})

test('buildSpawnEnv：显式 secretNames 逐名注入；未选中的不注入', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'A_KEY', 'va')
  stash.put(7, 'B_KEY', 'vb')
  stash.put(7, '__proto__', 'prototype-named-secret')
  const env = spawnEnvBackend(stash).buildSpawnEnv(7, '/w', 'local', { secretNames: ['A_KEY', '__proto__'] })
  assert.equal(env['A_KEY'], 'va')
  assert.equal(env['B_KEY'], undefined)
  assert.equal(Object.hasOwn(env, '__proto__'), true)
  assert.equal(env['__proto__'], 'prototype-named-secret')
})

test('buildSpawnEnv：缺失/过期/已结算名字显式 404，绝不静默空注入', { timeout: 60_000 }, () => {
  const { stash, now } = fakeClockStash()
  stash.put(7, 'GONE_TTL', 'v', { ttlMs: 1_000 })
  now.ms += 2_000
  stash.put(7, 'GONE_TURN', 'v', { scope: 'turn' })
  stash.settleTurn(7)
  const backend = spawnEnvBackend(stash)
  for (const name of ['NOPE', 'GONE_TTL', 'GONE_TURN', 'toString', 'constructor', '__proto__']) {
    assert.throws(
      () => backend.buildSpawnEnv(7, '/w', 'local', { secretNames: [name] }),
      (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
      `${name}（缺失/TTL 过期/回合已结算）必须显式失败`,
    )
  }
})

test('buildSpawnEnv：secretNames 非法形状（重复/坏名/非数组）400 拒绝', { timeout: 60_000 }, () => {
  const backend = spawnEnvBackend(new SecretStash())
  for (const bad of [['A', 'A'], ['bad-name!'], [''], 42]) {
    assert.throws(
      () => backend.buildSpawnEnv(7, '/w', 'local', { secretNames: bad as string[] }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  }
})

test('buildSpawnEnv：TTL 边界单次采样——clock 逐次推进不会出现「存在性检查过了、取值时过期」的假成功空注入', { timeout: 60_000 }, () => {
  // clock 每次读取 +1：旧实现「先 has 后 envFor」两次采样会在 TTL 边界跨界
  // （has 时未过期、envFor 时已过期），授予名单存在却返回不含该键的假成功 env。
  // 单次 envFor 选择读取 + 基于实际返回键判缺失后，同批同刻判定。
  const counter = { ms: 1_000 }
  const stash = new SecretStash({ now: () => (counter.ms += 1) })
  stash.put(7, 'EDGE_KEY', 'edge-value', { ttlMs: 2 }) // put 采样 1001 → expiresAt 1003
  const backend = spawnEnvBackend(stash)
  // 本次授予唯一采样 t=1002（未过期）：携带值成功（旧实现此处 has(1002) 过、
  // envFor(1003) 过期 → 空注入假成功）。
  const env = backend.buildSpawnEnv(7, '/w', 'local', { secretNames: ['EDGE_KEY'] })
  assert.equal(env['EDGE_KEY'], 'edge-value', '边界内单次采样：要么带值成功，要么 404，绝不假成功空注入')
  // 下一刻（t≥1003 已过期）：显式 404。
  assert.throws(
    () => backend.buildSpawnEnv(7, '/w', 'local', { secretNames: ['EDGE_KEY'] }),
    (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
  )
})

// ---------------------------------------------------------------------------
// Herdr 窗格端到端（真实 executor + 真实内核 buildSpawnEnv 合成）
// ---------------------------------------------------------------------------

interface FakePane {
  paneId: string
  tabId: string
  status: 'idle' | 'working' | 'blocked' | 'done' | 'unknown'
  seq: number
  cwd: string
  launchPending: boolean
  name?: string
}

/** 受控 transport：记录 tab.create env 与 gate env；prompt 即完成（写交接文件），可挂 onPrompted 在 Gate 前推进时钟/改写 stash。 */
class FakeTransport implements HerdrTransport {
  panes = new Map<string, FakePane>()
  tabEnvs: Array<Record<string, string>> = []
  gateEnvs: Array<Record<string, string>> = []
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  /** prompt 完成回调（交接文件写入前）：测试在 Gate 前注入时钟推进/stash 改写。 */
  onPrompted?: () => void

  private paneOf(ref: unknown): FakePane {
    const id = typeof ref === 'string' ? ref : String((ref as { pane_id?: unknown })?.pane_id ?? '')
    const pane = this.panes.get(id)
    if (!pane) throw new HelmError('agent_not_found', `no pane ${id}`, 404)
    return pane
  }

  private infoOf(pane: FakePane) {
    return {
      pane_id: pane.paneId,
      tab_id: pane.tabId,
      workspace_id: 'ws',
      agent_status: pane.status,
      interactive_ready: pane.status !== 'unknown',
      state_change_seq: pane.seq,
      cwd: pane.cwd,
      ...(pane.name !== undefined ? { name: pane.name } : {}),
    }
  }

  async call(_target: HerdrTarget, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    switch (method) {
      case 'tab.create': {
        const n = this.panes.size + 1
        const paneId = `ws:p${n}`
        this.panes.set(paneId, {
          paneId,
          tabId: `ws:t${n}`,
          status: 'idle',
          seq: 1,
          cwd: (params['cwd'] as string) ?? '/tmp',
          launchPending: false,
        })
        this.tabEnvs.push((params['env'] as Record<string, string>) ?? {})
        return {
          type: 'tab_created',
          tab: { tab_id: `ws:t${n}`, workspace_id: 'ws' },
          root_pane: { pane_id: paneId, workspace_id: 'ws', tab_id: `ws:t${n}` },
        }
      }
      case 'agent.start': {
        const pane = this.paneOf(params['pane_id'])
        pane.name = params['name'] as string
        pane.status = 'unknown'
        pane.launchPending = true
        pane.seq = 0
        return { type: 'agent_started', argv: [], agent: this.infoOf(pane) }
      }
      case 'agent.wait': {
        const pane = this.paneOf(params['target'])
        if (pane.status === 'unknown' && pane.launchPending) {
          await delay(2)
          pane.status = 'idle'
          pane.launchPending = false
          pane.seq += 1
        }
        return { type: 'agent_info', agent: this.infoOf(pane) }
      }
      case 'agent.prompt': {
        const pane = this.paneOf(params['target'])
        pane.status = 'done'
        pane.seq += 1
        this.onPrompted?.()
        const fileName = (params['text'] as string).match(/wf-out-[A-Za-z0-9_.-]+\.(json|md)/)?.[0] ?? ''
        mkdirSync(join(pane.cwd, '.helm'), { recursive: true })
        writeFileSync(join(pane.cwd, '.helm', fileName), 'herdr-done')
        return { type: 'agent_prompted', agent: this.infoOf(pane) }
      }
      case 'agent.get':
        return { type: 'agent_info', agent: this.infoOf(this.paneOf(params['target'])) }
      case 'agent.read':
        return { type: 'pane_read', read: { pane_id: this.paneOf(params['target']).paneId, text: 'tail' } }
      case 'tab.close':
        return { type: 'ok' }
      default:
        throw new HelmError('method_not_found', `fake: ${method}`, 400)
    }
  }

  async readOutput(_t: HerdrTarget, cwd: string, fileName: string): Promise<string> {
    return (await import('node:fs')).readFileSync(join(cwd, '.helm', fileName), 'utf-8')
  }

  async removeOutput(_t: HerdrTarget, cwd: string, fileName: string): Promise<void> {
    ;(await import('node:fs')).rmSync(join(cwd, '.helm', fileName))
  }

  async runGate(_t: HerdrTarget, _command: string, _cwd: string, _signal: AbortSignal | undefined, env?: Record<string, string>): Promise<{ ok: boolean; output: string }> {
    this.gateEnvs.push(env ?? {})
    return { ok: true, output: 'gate ok' }
  }

  async subscribe(): Promise<() => void> {
    return () => {}
  }
}

interface PaneEnv {
  executor: HerdrExecutor
  transport: FakeTransport
  stash: SecretStash
  dataDir: string
  close(): Promise<void>
}

/**
 * 真实执行器装配：buildSpawnEnv 用真实 RuntimeAgentSpawn（真 SecretStash +
 * buildManagedEnv 合成），Profile 'ci-runner' 指向远端 node-a（通道上报可达
 * hubUrl），runtime.env 携带 CI_FLAG / 同名 DEPLOY_TOKEN / 受管覆盖尝试
 * HELM_CWD。父会话 7 stash 预置 DEPLOY_TOKEN / API_KEY。
 * 可选 clock 注入 stash（fake clock TTL）；onPrompted 在交接完成后、Gate 前触发。
 */
async function openPaneEnv(options: { clock?: () => number; onPrompted?: () => void } = {}): Promise<PaneEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-paneenv-'))
  const transport = new FakeTransport()
  if (options.onPrompted !== undefined) transport.onPrompted = options.onPrompted
  const stash = options.clock !== undefined ? new SecretStash({ now: options.clock }) : new SecretStash()
  stash.put(7, 'DEPLOY_TOKEN', 'secret-deploy-7')
  stash.put(7, 'API_KEY', 'secret-api-7')
  const spawnBackend = spawnEnvBackend(stash, { token: 'managed-token', nodeHubUrl: 'http://10.0.0.5:3202' })
  const profiles = new Map<string, Profile>([
    [
      'ci-runner',
      {
        id: 'ci-runner',
        runtime: {
          kind: 'herdr',
          agent: 'agy',
          nodeId: 'node-a',
          env: { CI_FLAG: 'profile-yes', DEPLOY_TOKEN: 'profile-deploy', HELM_CWD: '/hijack' },
        },
      } as Profile,
    ],
  ])
  let doc: ManagedDoc = { ...EMPTY_MANAGED_DOC, panes: [...EMPTY_MANAGED_DOC.panes] }
  const registry = new PaneRegistry({ get: () => doc, set: (next) => { doc = next } }, doc)
  const host: ExecutorHost = {
    parentCwdOf: () => dataDir,
    parentNodeIdOf: () => undefined,
    askConversationId: (id) => id,
    notify: () => undefined,
    startupTimeoutMs: () => 5_000,
    createAsk: (() => {
      throw new HelmError('unsupported', 'happy path 无 Ask', 501)
    }) as never,
    cancelAsk: (() => {
      throw new HelmError('unsupported', 'happy path 无 Ask', 501)
    }) as never,
  }
  const executor = new HerdrExecutor(
    {
      profiles: { get: async (id) => profiles.get(id) },
      buildSpawnEnv: (conversationId, cwd, nodeId, options) =>
        spawnBackend.buildSpawnEnv(conversationId, cwd, nodeId, options),
      redact: (t) => stash.redact(t),
      runLocalGate: async () => ({ ok: true, output: 'gate ok' }),
      nodeChannel: {
        isOnline: () => true,
        getNodeHubUrl: () => 'http://10.0.0.5:3202',
        ipcCall: () => {
          throw new HelmError('unsupported', '本测试不经 IPC', 501)
        },
        envFor: () => {
          throw new HelmError('unsupported', '本测试不用 envFor', 501)
        },
      },
      transport,
    },
    registry,
    new AskCoordinator(() => undefined),
    new MetadataProjector(async () => ({}), () => undefined),
    host,
    transport,
    {},
    10,
  )
  return { executor, transport, stash, dataDir, async close() { rmSync(dataDir, { recursive: true, force: true }) } }
}

test('herdr 窗格：远端默认无业务机密；受管 HELM_* 与 Profile 变量正确，Profile 不被误删也不得覆盖受管键', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  try {
    const outcome = (await env.executor.handle({
      parentConversationId: 7,
      prompt: '部署它',
      agentType: 'ci-runner',
    })) as { action: string }
    assert.equal(outcome.action, 'handled')
    const paneEnv = env.transport.tabEnvs[0]!
    // 业务机密缺省不注入。
    assert.equal(paneEnv['API_KEY'], undefined, '未授予的父会话机密不进入窗格')
    assert.equal(paneEnv['DEPLOY_TOKEN'], 'profile-deploy', '同名 Profile 显式值原样保留（父机密未授予，不存在误删）')
    // Profile 合法变量保留。
    assert.equal(paneEnv['CI_FLAG'], 'profile-yes')
    // 受管 HELM_*：内核权威，Profile 不得覆盖。
    assert.equal(paneEnv['HELM_ENV'], '1')
    assert.equal(paneEnv['HELM_CWD'] ?? paneEnv['HELM_CWD'], paneEnv['HELM_CWD'])
    assert.notEqual(paneEnv['HELM_CWD'], '/hijack', 'Profile 覆盖受管 HELM_CWD 被固定覆盖拒绝')
    assert.equal(paneEnv['HELM_CONVERSATION_ID'], '7')
    assert.equal(paneEnv['HELM_NODE_ID'], 'node-a')
    assert.equal(paneEnv['HELM_DATA_DIR'], undefined, '远端不注入 Hub 本机 DATA_DIR')
    // 节点通道上报的可达 hubUrl + 受管 token 回连保留。
    assert.equal(paneEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202')
    assert.equal(paneEnv['HELM_TOKEN'], 'managed-token')
  } finally {
    await env.close()
  }
})

test('herdr 窗格：显式 secretNames 逐名授予（机密权威覆盖 Profile 同名值），未授予名仍不注入', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  env.stash.put(7, '__proto__', 'pane-prototype-named-secret')
  try {
    const outcome = (await env.executor.handle({
      parentConversationId: 7,
      prompt: '部署它',
      agentType: 'ci-runner',
      secretNames: ['DEPLOY_TOKEN', '__proto__'],
    })) as { action: string }
    assert.equal(outcome.action, 'handled')
    const paneEnv = env.transport.tabEnvs[0]!
    assert.equal(paneEnv['DEPLOY_TOKEN'], 'secret-deploy-7', '显式授予的机密值权威（覆盖 Profile 同名配置）')
    assert.equal(paneEnv['API_KEY'], undefined, '未选中的机密仍不注入')
    assert.equal(paneEnv['CI_FLAG'], 'profile-yes')
    assert.equal(Object.hasOwn(paneEnv, '__proto__'), true)
    assert.equal(paneEnv['__proto__'], 'pane-prototype-named-secret')
  } finally {
    await env.close()
  }
})

test('herdr 窗格：授予缺失机密在建窗副作用前显式拒绝（404 secret_not_found）', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  try {
    await assert.rejects(
      env.executor.handle({
        parentConversationId: 7,
        prompt: '部署它',
        agentType: 'ci-runner',
        secretNames: ['NOT_IN_STASH'],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
    )
    assert.equal(env.transport.calls.length, 0, '拒绝发生在任何建窗副作用之前')
  } finally {
    await env.close()
  }
})

test('herdr Gate：机密不缓存——Gate 启动前从当前 stash 重新授权取值（建窗后同名轮换以新值执行）', { timeout: 60_000 }, async () => {
  // 建窗时授予 v1；任务完成后、Gate 前同名轮换为 v2：Gate 子进程拿到的必须是
  // 当前 stash 的 v2，绝不是建窗时刻缓存的 v1（paneEnvs 只存基线）。
  const env = await openPaneEnv()
  const creationValue = env.stash.envFor(7)['DEPLOY_TOKEN']!
  env.transport.onPrompted = () => {
    env.stash.put(7, 'DEPLOY_TOKEN', 'rotated-value')
  }
  try {
    const outcome = (await env.executor.handle({
      parentConversationId: 7,
      prompt: '部署它',
      agentType: 'ci-runner',
      gate: 'true',
      secretNames: ['DEPLOY_TOKEN'],
    })) as { action: string }
    assert.equal(outcome.action, 'handled')
    assert.equal(env.transport.tabEnvs[0]!['DEPLOY_TOKEN'], creationValue, '建窗时刻注入的是当时的 v1')
    assert.equal(env.transport.gateEnvs.length, 1, 'Gate 恰好执行一次')
    const gateEnv = env.transport.gateEnvs[0]!
    assert.equal(gateEnv['DEPLOY_TOKEN'], 'rotated-value', 'Gate 取当前 stash 值（非建窗时刻缓存值）')
    assert.equal(gateEnv['CI_FLAG'], 'profile-yes', 'Gate 基线保留 Profile 合法变量')
    assert.equal(gateEnv['HELM_ENV'], '1', 'Gate 基线保留受管变量')
    assert.equal(gateEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202', 'Gate 基线保留节点回连')
  } finally {
    await env.close()
  }
})

test('herdr Gate：TTL 在 agent 工作期间到期——Gate 子进程启动前 404 拒绝（零 Gate 副作用）', { timeout: 60_000 }, async () => {
  const clock = { ms: 10_000 }
  const env = await openPaneEnv({
    clock: () => clock.ms,
    onPrompted: () => {
      clock.ms += 100 // TTL 50ms：任务期间推进时钟跨过到期点
    },
  })
  try {
    env.stash.put(7, 'SHORT_TTL', 'short-lived', { ttlMs: 50 })
    await assert.rejects(
      env.executor.handle({
        parentConversationId: 7,
        prompt: '部署它',
        agentType: 'ci-runner',
        gate: 'true',
        secretNames: ['SHORT_TTL'],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
      '工作期间到期的授予：Gate 前显式 404，不静默降级、不注入旧值',
    )
    assert.equal(env.transport.gateEnvs.length, 0, 'Gate 子进程零启动（无副作用）')
  } finally {
    await env.close()
  }
})

test('herdr Gate：授予不跨任务沿用——后续任务不带 secretNames 时 Gate 只用基线（不注入旧授予值）', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  const creationValue = env.stash.envFor(7)['DEPLOY_TOKEN']!
  try {
    // 任务 1：带授予 + Gate → Gate 环境含机密值。
    await env.executor.handle({
      parentConversationId: 7,
      prompt: '第一次部署',
      agentType: 'ci-runner',
      gate: 'true',
      secretNames: ['DEPLOY_TOKEN'],
    })
    assert.equal(env.transport.gateEnvs[0]!['DEPLOY_TOKEN'], creationValue)
    // 任务 2（新窗格）：不带授予 + Gate → 基线内同名 Profile 值生效，绝不注入任务 1 的旧授予值。
    await env.executor.handle({
      parentConversationId: 7,
      prompt: '第二次部署不带机密',
      agentType: 'ci-runner',
      gate: 'true',
    })
    const gateEnv = env.transport.gateEnvs[1]!
    assert.equal(gateEnv['DEPLOY_TOKEN'], 'profile-deploy', '无授予时同名 Profile 显式值生效（不沿用旧授予）')
    assert.equal(gateEnv['API_KEY'], undefined, '其它机密同样不注入')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// workflow journal 指纹
// ---------------------------------------------------------------------------

test('agentJournalKey：secretNames 参与指纹（授予变化不复用旧缓存；缺省与 undefined 同 key，无跨版本不变承诺）', { timeout: 60_000 }, () => {
  const base = { prompt: 'p', agentType: 'ci-runner' }
  const without = agentJournalKey(base)
  assert.equal(agentJournalKey({ ...base, secretNames: undefined }), without, 'undefined 与缺省同 key（同为 null 槽）')
  const withGrant = agentJournalKey({ ...base, secretNames: ['DEPLOY_TOKEN'] })
  assert.notEqual(withGrant, without)
  assert.notEqual(agentJournalKey({ ...base, secretNames: ['API_KEY'] }), withGrant, '不同授予不同 key')
})

// ---------------------------------------------------------------------------
// 真实回合结算联动（createHelm + faux：completed/failed/aborted + late hook）
// ---------------------------------------------------------------------------

async function waitFor(cond: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await delay(15)
  }
}

test('真实回合结算：completed/failed/aborted 均停注入 turn 机密；旧值仍脱敏；late hook 登记留下一回合', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-secret-turnsettle-'))
  // 慢速流（1 tok/s、4 字符/token）：aborted 场景需真实在途流可被取消；短回复仍秒级完成。
  const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 4, max: 4 } })
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    const kernel = app.kernel
    const stash = kernel.services.stash
    const outcomes: string[] = []
    let latePut = false
    await kernel.plugins!.register({
      id: 'test:secret-settle-probe',
      name: '机密结算探针',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          outcomes.push(payload.outcome)
          // late hook（只在首次结算登记，验证回收边界）：结算链内登记 turn 机密
          // （settleTurn 已先行推进计数）→ 属下一回合。
          if (!latePut) {
            latePut = true
            stash.put(payload.conversation.id, 'LATE_HOOK_KEY', `late-${payload.conversation.id}`, { scope: 'turn' })
          }
        })
      },
    } satisfies PluginDefinition)

    // --- completed：真实成功回合
    const conv = await kernel.createConversation({ title: '机密回合' })
    stash.put(conv.id, 'TURN_TOKEN', 'turn-tok-value', { scope: 'turn' })
    stash.put(conv.id, 'SESSION_TOKEN', 'session-tok-value')
    faux.setResponses([fauxAssistantMessage('完成回答')])
    await kernel.submitInput(conv.id, '第一问')
    await kernel.waitForIdle(conv.id)
    await waitFor(() => outcomes.length >= 1)
    assert.equal(outcomes[0], 'completed')
    assert.equal(stash.has(conv.id, 'TURN_TOKEN'), false, 'completed 结算后 turn 机密停注入（payload.conversation.id 真实联动）')
    assert.equal(stash.has(conv.id, 'SESSION_TOKEN'), true, '会话级不受结算影响')
    assert.equal(stash.envFor(conv.id)['LATE_HOOK_KEY'], `late-${conv.id}`, 'late hook 登记的 turn 机密存活（属下一回合）')
    assert.equal(stash.redact('turn-tok-value').includes('turn-tok-value'), false, '结算后旧值仍脱敏')

    // --- late hook 登记随下一次结算回收
    faux.setResponses([fauxAssistantMessage('第二答')])
    await kernel.submitInput(conv.id, '第二问')
    await kernel.waitForIdle(conv.id)
    await waitFor(() => outcomes.length >= 2)
    assert.equal(outcomes[1], 'completed')
    assert.equal(stash.has(conv.id, 'LATE_HOOK_KEY'), false, 'late 登记随下一次回合结算回收')

    // --- failed：真实失败回合（faux stopReason=error）
    const failed = await kernel.createConversation({ title: '失败回合' })
    stash.put(failed.id, 'FAIL_TURN', 'fail-secret', { scope: 'turn' })
    faux.setResponses([fauxAssistantMessage('boom', { stopReason: 'error' })])
    await kernel.submitInput(failed.id, '会失败的问题')
    await kernel.waitForIdle(failed.id)
    await waitFor(() => outcomes.includes('failed'))
    assert.equal(stash.has(failed.id, 'FAIL_TURN'), false, 'failed 结算同样回收 turn 机密')
    assert.equal(stash.redact('fail-secret').includes('fail-secret'), false)

    // --- aborted：慢速流式中真实在途取消
    const abortedConv = await kernel.createConversation({ title: '中止回合' })
    stash.put(abortedConv.id, 'ABORT_TURN', 'abort-secret', { scope: 'turn' })
    faux.setResponses([fauxAssistantMessage('这是一段被慢速流式输出的长文本确保中止时回合仍在流式中')])
    await kernel.submitInput(abortedConv.id, '会被中止的问题')
    await kernel.abortConversation(abortedConv.id)
    await kernel.waitForIdle(abortedConv.id)
    await waitFor(() => outcomes.includes('aborted'))
    assert.equal(stash.has(abortedConv.id, 'ABORT_TURN'), false, 'aborted 结算同样回收 turn 机密')
    assert.equal(stash.redact('abort-secret').includes('abort-secret'), false)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 原生执行行诚实拒绝（无外部运行时消费时绝不假装授予成功）
// ---------------------------------------------------------------------------

test('原生执行行：非空 secretNames 显式 unsupported_secret_grant（默认插件集无外部运行时不静默忽略）；空数组等同未授予', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-secret-native-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  // 默认插件集：builtin:herdr 停用 → agent_spawn 无外部运行时接管，原生执行行必须显式拒绝。
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  try {
    const kernel = app.kernel
    kernel.services.stash.put(1, 'NATIVE_KEY', 'native-secret')
    await assert.rejects(
      kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '原生任务带机密授予',
        agentType: 'assistant',
        secretNames: ['NATIVE_KEY'],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'unsupported_secret_grant',
      '原生子会话不能承接父会话机密授予：显式报错，不静默忽略、不假装子代理已取得',
    )
    // 空数组 = 未授予：原生执行行正常执行（faux 子会话真实完成）。
    faux.setResponses([fauxAssistantMessage('原生回答')])
    const result = await kernel.spawnAgent({
      parentConversationId: 1,
      prompt: '空授予任务',
      secretNames: [],
    })
    assert.ok(result !== undefined, '空数组等同未授予，原生执行不受影响')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
