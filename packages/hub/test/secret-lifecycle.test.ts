/**
 * SecretStash lifecycle converge test:
 * - TTL(inject clock lazy expires): expires only stop inject (envFor/has/stats),byUuid old value
 *   continue used to all output redaction (contains across chunk streaming KMP); same name override old value same redaction;
 * - SecretLifetime boundary validate:ttlMs finite correct safe integer and do not over 24h,scope enumeration,
 *   unknown key reject (AskDoc spec and stash.put shared use the same set reject);
 * - turn effect domain by out generate compute order precise ownership: this turn register follow compute reclaim, compute after register
 *   (async approval persisted/late hook) belong under one turn do not by mistakenly scan, conversation level do not subject to compute affect,
 *   idle do not clean scan; stop inject != stop redaction;clear(conversationId) reclaim redaction old value;
 * - AskService connect line:secretLifetime only secret field allows, illegal shape 400,
 *   legal value original pass-through stash(not declaration = conversation level, and old behavior consistent);
 * - buildSpawnEnv most small authorization: default does not carry any parent conversation secret, explicit secretNames one by one name
 *   inject, missing/expired name explicit 404, illegal shape 400;
 * - Herdr pane end-to-end: remote pane by default without business secret but keep managed HELM_*(contains node channel
 *   hubUrl back connect) and Profile explicit variable; same name Profile value do not by not grant parent secret override;
 *   explicit grant when secret value right threat; grant missing name in create window side effect before explicit reject;
 * - workflow journal refer grain:secretNames reference and invoke key(grant change do not re- use old cache).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type PluginDefinition, type Profile } from '@helm/protocol'
import {
  CredentialService,
  MAX_SECRET_TTL_MS,
  SecretStash,
  validateSecretLifetime,
} from '../../kernel/src/services/index.js'
import { createHubHandler } from '../../kernel/src/http/hub.js'
import { agentJournalKey } from '../../plugins/src/workflow/engine/journal.js'
import { AskService } from '../../kernel/src/runtime/asks.js'
import { HelmStore } from '../../kernel/src/runtime/store.js'
import { openHelmDatabase } from '../../kernel/src/runtime/sqlite.js'
import { RuntimeAgentSpawn } from '../../kernel/src/runtime/runtime-agent-spawn.js'
import { HerdrExecutor, type ExecutorHost } from '../../plugins/src/herdr/executor.js'
import { PaneRegistry, EMPTY_MANAGED_DOC, type ManagedDoc } from '../../plugins/src/herdr/panes.js'
import { AskCoordinator } from '../../plugins/src/herdr/asks.js'
import { MetadataProjector } from '../../plugins/src/herdr/metadata.js'
import type { HerdrEvent, HerdrTarget, HerdrTransport } from '../../plugins/src/herdr/contracts.js'
import { createHubTestApp, waitFor } from './helpers/hub-test-env.js'

// ---------------------------------------------------------------------------
// SecretStash:TTL(fake clock)
// ---------------------------------------------------------------------------

/** fake clock stash:now can any push enter. */
function fakeClockStash(): { stash: SecretStash; now: { ms: number } } {
  const now = { ms: 1_000_000 }
  return { stash: new SecretStash({ now: () => now.ms }), now }
}

test('TTL: inject clock lazy expires - - expires only stop inject, redaction continue (contains streaming across chunk)', { timeout: 60_000 }, () => {
  const { stash, now } = fakeClockStash()
  stash.put(7, 'DEPLOY_TOKEN', 'tok-abc-123', { ttlMs: 5_000 })
  assert.deepEqual(stash.envFor(7), { DEPLOY_TOKEN: 'tok-abc-123' })
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), true)

  now.ms += 4_999
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), true, 'expires before one moment still inject')
  assert.deepEqual(stash.stats(), { conversations: 1, secrets: 1 })

  now.ms += 1
  assert.deepEqual(stash.envFor(7), {}, 'expires i.e. stop inject (read path lazy reclaim)')
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), false)
  assert.deepEqual(stash.stats(), { conversations: 1, secrets: 0 })

  // stop inject != stop redaction: old value still replace is placeholder.
  assert.equal(stash.redact('leak: tok-abc-123').includes('tok-abc-123'), false)
  assert.ok(stash.redact('leak: tok-abc-123').startsWith('leak: [REDACTED:stash:'))

  // streaming redactor across chunk tear match in expires after still redaction (KMP suffix keep).
  const stream = stash.createStreamingRedactor()
  const out = stream.push('prefix tok-abc-') + stream.push('123 tail') + stream.flush()
  assert.equal(out.includes('tok-abc-123'), false)
  assert.ok(out.includes('[REDACTED:stash:'))
})

test('TTL: same name override old value - - old value stop inject after still by redaction (two value all cannot back visible)', { timeout: 60_000 }, () => {
  const { stash, now } = fakeClockStash()
  stash.put(7, 'KEY', 'old-value', { ttlMs: 1_000 })
  now.ms += 2_000
  stash.put(7, 'KEY', 'new-value')
  assert.deepEqual(stash.envFor(7), { KEY: 'new-value' }, 'new value takes effect')
  const text = stash.redact('old-value / new-value')
  assert.equal(text.includes('old-value'), false, 'expired old value continue redaction')
  assert.equal(text.includes('new-value'), false)
})

test('TTL cap boundary: exactly 24h legal, exceeds/non- integer/non- correct/non- count value reject', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'OK_TTL', 'v', { ttlMs: MAX_SECRET_TTL_MS })
  assert.equal(stash.has(7, 'OK_TTL'), true)
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER * 2, Infinity, NaN, '3000', null]) {
    assert.throws(
      () => stash.put(7, 'BAD_TTL', 'v', { ttlMs: bad as number }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      `ttlMs=${String(bad)} must reject`,
    )
  }
  assert.throws(
    () => validateSecretLifetime({ ttlMs: MAX_SECRET_TTL_MS + 1 }, 't'),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
  )
})

test('SecretLifetime shape:scope enumeration, unknown key, non- object all reject; empty object legal (=default semantics)', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  assert.throws(
    () => stash.put(7, 'S', 'v', { scope: 'session' } as never),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
  )
  assert.throws(
    () => stash.put(7, 'S', 'v', { ttl: 5_000 } as never),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    "unknown key 'ttl'(ttlMs piece together write wrong leak must explicit failed, cannot static default becomes without TTL)",
  )
  assert.throws(() => stash.put(7, 'S', 'v', null as never), /validation_error|must be an object/)
  assert.throws(() => stash.put(7, 'S', 'v', [1] as never), /validation_error|must be an object/)
  assert.throws(() => stash.put(7, 'S', 'v', new Date() as never), /validation_error|must be an object/)
  assert.throws(() => stash.put(7, 'S', 'v', new Map() as never), /validation_error|must be an object/)
  stash.put(7, 'S', 'v', {})
  assert.equal(stash.has(7, 'S'), true, 'empty object = default conversation level')
})

// ---------------------------------------------------------------------------
// SecretStash:turn effect domain (out generate compute order)
// ---------------------------------------------------------------------------

test('turn: this turn register follow compute reclaim (stop inject), redaction continue; conversation level do not subject to compute affect', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'TURN_KEY', 'turn-secret', { scope: 'turn' })
  stash.put(7, 'SESSION_KEY', 'session-secret')
  stash.settleTurn(7)
  assert.equal(stash.has(7, 'TURN_KEY'), false)
  assert.equal(stash.has(7, 'SESSION_KEY'), true, 'conversation level (default) do not follow turn compute reclaim')
  assert.deepEqual(stash.envFor(7), { SESSION_KEY: 'session-secret' })
  assert.equal(stash.redact('turn-secret').includes('turn-secret'), false, 'compute after old value continue redaction')
})

test('turn: old turn end do not clean new turn secret - - compute after register belong under one turn,idle do not clean scan', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'A', 'a', { scope: 'turn' })
  stash.settleTurn(7) // turn A compute:A reclaim (out generate order 0 < 1).
  // async approval persisted/late hook: compute after register (out generate order 1), belong under one turn.
  stash.put(7, 'B', 'b', { scope: 'turn' })
  stash.put(7, 'C', 'c', { scope: 'turn' })
  // without any idle scan: under one turn in progress B/C continuous inject.
  assert.deepEqual(stash.envFor(7), { B: 'b', C: 'c' })
  stash.settleTurn(7) // turn B compute: reclaim out generate order < 2  B/C, does not affect under one turn.
  assert.deepEqual(stash.envFor(7), {})
  assert.equal(stash.redact('b c').includes('b c'), false, 'old value continue redaction')
})

test('turn: compute after (counter already push enter) again register turn secret in this time compute memory', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.settleTurn(7)
  stash.put(7, 'LATE', 'late-value', { scope: 'turn' })
  stash.settleTurn(7)
  // LATE out generate order 1: second time compute (counter 1→2) should reclaim it; but tight follow first time compute register
  // after, under once compute before it must store - - on one case already override store side, this in reclaim side closed ring.
  assert.equal(stash.has(7, 'LATE'), false)
})

test('turn: by conversation isolated - - conversation 7 compute do not touch conversation 8  turn secret', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'K', 'v7', { scope: 'turn' })
  stash.put(8, 'K', 'v8', { scope: 'turn' })
  stash.settleTurn(7)
  assert.equal(stash.has(8, 'K'), true)
  assert.deepEqual(stash.envFor(8), { K: 'v8' })
})

test('clear: conversation level reclaim also stop inject and redaction old value;stats reset to zero', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'A', 'gone-value', { scope: 'turn' })
  stash.settleTurn(7)
  stash.put(7, 'B', 'live-value')
  stash.clear(7)
  assert.deepEqual(stash.envFor(7), {})
  assert.equal(stash.redact('gone-value live-value').includes('gone-value'), true, 'clear after old value no longer replace (already reclaim)')
  assert.equal(stash.has(7, 'B'), false)
  assert.deepEqual(stash.stats(), { conversations: 0, secrets: 0 })
})

// ---------------------------------------------------------------------------
// AskService connect line (real store + SecretStash)
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

test('AskService:secretLifetime only secret field allows; illegal shape 400 reject', { timeout: 60_000 }, async () => {
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
      'non- secret field declaration secretLifetime must reject',
    )
    await assert.rejects(
      ctx.service.createAsk({
        conversationId: 1,
        ownerPluginId: 't',
        title: 'x',
        fields: [{ name: 'tok', label: 't', type: 'text', secret: true, secretLifetime: { ttlMs: 0 } }],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      'illegal ttlMs must in write store before reject',
    )
    await assert.rejects(
      ctx.service.createAsk({
        conversationId: 1,
        ownerPluginId: 't',
        title: 'x',
        fields: [{ name: 'tok', label: 't', type: 'text', secret: true, secretLifetime: { scopes: 'turn' } as never }],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      'unknown key must reject',
    )
  } finally {
    await ctx.close()
  }
})

test('AskService: legal secretLifetime pass-through stash; not declaration = conversation level (do not follow compute reclaim)', { timeout: 60_000 }, async () => {
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
    assert.deepEqual(ctx.stash.envFor(1), { SESSION_TOKEN: 'session-tok' }, 'turn follow compute stop inject, not declaration = conversation level')
    assert.equal(ctx.stash.redact('turn-tok').includes('turn-tok'), false)
    // two pen ask all already reach terminal state,createAsk promise already compute (do not pending).
    assert.equal((await settled).status, 'answered')
    assert.equal((await plain).status, 'answered')
  } finally {
    await ctx.close()
  }
})

/** polling store until appear pending ask(createAsk async store). */
async function pollPending(service: AskService): Promise<{ id: string }> {
  for (let i = 0; i < 200; i += 1) {
    const pending = service.listPendingByConversation(1)
    if (pending.length > 0) return { id: pending[pending.length - 1]!.id }
    await delay(5)
  }
  throw new Error('pending ask not store')
}

// ---------------------------------------------------------------------------
// buildSpawnEnv: external spawn most small authorization
// ---------------------------------------------------------------------------

/** most small RuntimeAgentSpawn install match (only drive buildSpawnEnv; the rest port throw). */
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
      throw new Error('this test does not trigger')
    }) as never,
    markConversationOwnership: () => undefined,
  })
}

test('buildSpawnEnv: default zero secret (most small authorization), managed HELM_* complete', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'DEPLOY_TOKEN', 'tok-7')
  stash.put(7, 'API_KEY', 'key-7')
  const backend = spawnEnvBackend(stash, { token: 'managed-token' })
  const env = backend.buildSpawnEnv(7, '/w', 'local')
  assert.equal(env['DEPLOY_TOKEN'], undefined, 'default does not carry any parent conversation secret')
  assert.equal(env['API_KEY'], undefined)
  assert.equal(env['HELM_ENV'], '1')
  assert.equal(env['HELM_CONVERSATION_ID'], '7')
  assert.equal(env['HELM_CWD'], '/w')
  assert.equal(env['HELM_NODE_ID'], 'local')
  assert.equal(env['HELM_DATA_DIR'], '/tmp/helm-spawnenv-data')
  assert.equal(env['HELM_TOKEN'], 'managed-token', 'managed token and secret grant correct hand over')
})

test('buildSpawnEnv: explicit secretNames one by one name inject; not choose in do not inject', { timeout: 60_000 }, () => {
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

test('buildSpawnEnv: missing/expired/already compute name explicit 404, never static default empty inject', { timeout: 60_000 }, () => {
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
      `${name}(missing/TTL expired/turn already compute) must explicit failed`,
    )
  }
})

test('buildSpawnEnv:secretNames illegal shape (duplicate/broken name/non- array)400 reject', { timeout: 60_000 }, () => {
  const backend = spawnEnvBackend(new SecretStash())
  for (const bad of [['A', 'A'], ['bad-name!'], [''], 42]) {
    assert.throws(
      () => backend.buildSpawnEnv(7, '/w', 'local', { secretNames: bad as string[] }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  }
})

test('buildSpawnEnv:TTL boundary single time sampling - -clock one by one time push enter will not appear store in check, take value when expired false succeeded empty inject', { timeout: 60_000 }, () => {
  // clock each time read +1: old implement first has after envFortwo time sampling will in TTL boundary across boundary
  // (has when not expired,envFor when expired), grant name single store in yet return excludes the key false succeeded env.
  // single time envFor choose read + based on actual return key judge missing after, same batch same moment decide.
  const counter = { ms: 1_000 }
  const stash = new SecretStash({ now: () => (counter.ms += 1) })
  stash.put(7, 'EDGE_KEY', 'edge-value', { ttlMs: 2 }) // put sampling 1001 → expiresAt 1003
  const backend = spawnEnvBackend(stash)
  // this time grant unique sampling t=1002(not expired): carry value succeeded (old implement this where has(1002) ,
  // envFor(1003) expired → empty inject false succeeded).
  const env = backend.buildSpawnEnv(7, '/w', 'local', { secretNames: ['EDGE_KEY'] })
  assert.equal(env['EDGE_KEY'], 'edge-value', 'boundary inside single time sampling: want particle carries value succeeded, want particle 404, never false succeeded empty inject')
  // under one moment (t≥1003 expired): explicit 404.
  assert.throws(
    () => backend.buildSpawnEnv(7, '/w', 'local', { secretNames: ['EDGE_KEY'] }),
    (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
  )
})

// ---------------------------------------------------------------------------
// Herdr pane end-to-end (real executor + real kernel buildSpawnEnv together into)
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

/** subject to control transport: record tab.create env and gate env;prompt i.e. complete (write handover file), can hang onPrompted in Gate before push enter clock/change write stash. */
class FakeTransport implements HerdrTransport {
  panes = new Map<string, FakePane>()
  tabEnvs: Array<Record<string, string>> = []
  gateEnvs: Array<Record<string, string>> = []
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  /** prompt complete call back (handover file before write): test in Gate before inject clock push enter/stash change write. */
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
 * real execute install match:buildSpawnEnv use real RuntimeAgentSpawn(true SecretStash +
 * buildManagedEnv together into),Profile 'ci-runner' points to remote node-a(channel on report can reach
 * hubUrl),runtime.env carry CI_FLAG / same name DEPLOY_TOKEN / managed override attempt
 * HELM_CWD. parent conversation 7 stash pre- placement DEPLOY_TOKEN / API_KEY.
 * optional clock inject stash(fake clock TTL);onPrompted in handover after completion,Gate before trigger.
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
      throw new HelmError('unsupported', 'happy path without Ask', 501)
    }) as never,
    cancelAsk: (() => {
      throw new HelmError('unsupported', 'happy path without Ask', 501)
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
          throw new HelmError('unsupported', 'this test do not via IPC', 501)
        },
        envFor: () => {
          throw new HelmError('unsupported', 'this test do not use envFor', 501)
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

test('herdr pane: remote by default without business secret; managed HELM_* and Profile variable correct,Profile do not by mistakenly delete also must not override managed key', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  try {
    const outcome = (await env.executor.handle({
      parentConversationId: 7,
      prompt: 'deploy it',
      agentType: 'ci-runner',
    })) as { action: string }
    assert.equal(outcome.action, 'handled')
    const paneEnv = env.transport.tabEnvs[0]!
    // business secret default do not inject.
    assert.equal(paneEnv['API_KEY'], undefined, 'not grant parent conversation secret does not enter pane')
    assert.equal(paneEnv['DEPLOY_TOKEN'], 'profile-deploy', 'same name Profile explicit value original keep (parent secret not grant, missing mistakenly delete)')
    // Profile legal variable keep.
    assert.equal(paneEnv['CI_FLAG'], 'profile-yes')
    // managed HELM_*: kernel right threat,Profile must not override.
    assert.equal(paneEnv['HELM_ENV'], '1')
    assert.equal(paneEnv['HELM_CWD'] ?? paneEnv['HELM_CWD'], paneEnv['HELM_CWD'])
    assert.notEqual(paneEnv['HELM_CWD'], '/hijack', 'Profile override managed HELM_CWD by fixed override reject')
    assert.equal(paneEnv['HELM_CONVERSATION_ID'], '7')
    assert.equal(paneEnv['HELM_NODE_ID'], 'node-a')
    assert.equal(paneEnv['HELM_DATA_DIR'], undefined, 'remote do not inject Hub local machine DATA_DIR')
    // node channel on report can reach hubUrl + managed token back connect keep.
    assert.equal(paneEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202')
    assert.equal(paneEnv['HELM_TOKEN'], 'managed-token')
  } finally {
    await env.close()
  }
})

test('herdr pane: explicit secretNames one by one name grant (secret right threat override Profile same name value), not grant name still do not inject', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  env.stash.put(7, '__proto__', 'pane-prototype-named-secret')
  try {
    const outcome = (await env.executor.handle({
      parentConversationId: 7,
      prompt: 'deploy it',
      agentType: 'ci-runner',
      secretNames: ['DEPLOY_TOKEN', '__proto__'],
    })) as { action: string }
    assert.equal(outcome.action, 'handled')
    const paneEnv = env.transport.tabEnvs[0]!
    assert.equal(paneEnv['DEPLOY_TOKEN'], 'secret-deploy-7', 'explicit grant secret value right threat (override Profile same name config)')
    assert.equal(paneEnv['API_KEY'], undefined, 'not choose in secret still do not inject')
    assert.equal(paneEnv['CI_FLAG'], 'profile-yes')
    assert.equal(Object.hasOwn(paneEnv, '__proto__'), true)
    assert.equal(paneEnv['__proto__'], 'pane-prototype-named-secret')
  } finally {
    await env.close()
  }
})

test('herdr pane: grant missing secret in create window side effect before explicit reject (404 secret_not_found)', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  try {
    await assert.rejects(
      env.executor.handle({
        parentConversationId: 7,
        prompt: 'deploy it',
        agentType: 'ci-runner',
        secretNames: ['NOT_IN_STASH'],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
    )
    assert.equal(env.transport.calls.length, 0, 'reject occur in any create window side effect before')
  } finally {
    await env.close()
  }
})

test('herdr Gate: secret do not cache - -Gate start before from when before stash re- authorization take value (create window after same name round swap with new value execute)', { timeout: 60_000 }, async () => {
  // create window when grant v1; task after completion,Gate before same name round swap is v2:Gate child process gets must be
  // when before stash  v2, never is create window moment cache v1(paneEnvs only store baseline).
  const env = await openPaneEnv()
  const creationValue = env.stash.envFor(7)['DEPLOY_TOKEN']!
  env.transport.onPrompted = () => {
    env.stash.put(7, 'DEPLOY_TOKEN', 'rotated-value')
  }
  try {
    const outcome = (await env.executor.handle({
      parentConversationId: 7,
      prompt: 'deploy it',
      agentType: 'ci-runner',
      gate: 'true',
      secretNames: ['DEPLOY_TOKEN'],
    })) as { action: string }
    assert.equal(outcome.action, 'handled')
    assert.equal(env.transport.tabEnvs[0]!['DEPLOY_TOKEN'], creationValue, 'create window moment inject is when when v1')
    assert.equal(env.transport.gateEnvs.length, 1, 'Gate exactly execute once')
    const gateEnv = env.transport.gateEnvs[0]!
    assert.equal(gateEnv['DEPLOY_TOKEN'], 'rotated-value', 'Gate take when before stash value (non- create window moment cache value)')
    assert.equal(gateEnv['CI_FLAG'], 'profile-yes', 'Gate baseline keep Profile legal variable')
    assert.equal(gateEnv['HELM_ENV'], '1', 'Gate baseline keep managed variable')
    assert.equal(gateEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202', 'Gate baseline keep node back connect')
  } finally {
    await env.close()
  }
})

test('herdr Gate:TTL in agent work during expires - -Gate child process start before 404 reject (zero Gate side effect)', { timeout: 60_000 }, async () => {
  const clock = { ms: 10_000 }
  const env = await openPaneEnv({
    clock: () => clock.ms,
    onPrompted: () => {
      clock.ms += 100 // TTL 50ms: task during push enter clock across expires point
    },
  })
  try {
    env.stash.put(7, 'SHORT_TTL', 'short-lived', { ttlMs: 50 })
    await assert.rejects(
      env.executor.handle({
        parentConversationId: 7,
        prompt: 'deploy it',
        agentType: 'ci-runner',
        gate: 'true',
        secretNames: ['SHORT_TTL'],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
      'work during expires grant:Gate before explicit 404, not silently fall back, do not inject old value',
    )
    assert.equal(env.transport.gateEnvs.length, 0, 'Gate child process zero start (no side effects)')
  } finally {
    await env.close()
  }
})

test('herdr Gate: grant do not across task along use - - after continue task do not carries secretNames when Gate only use baseline (do not inject old grant value)', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  const creationValue = env.stash.envFor(7)['DEPLOY_TOKEN']!
  try {
    // task 1: carries grant + Gate → Gate environment contains secret value.
    await env.executor.handle({
      parentConversationId: 7,
      prompt: 'first time deploy',
      agentType: 'ci-runner',
      gate: 'true',
      secretNames: ['DEPLOY_TOKEN'],
    })
    assert.equal(env.transport.gateEnvs[0]!['DEPLOY_TOKEN'], creationValue)
    // task 2(new pane): do not carries grant + Gate → baseline inside same name Profile value takes effect, never inject task 1 old grant value.
    await env.executor.handle({
      parentConversationId: 7,
      prompt: 'second time deploy do not carries secret',
      agentType: 'ci-runner',
      gate: 'true',
    })
    const gateEnv = env.transport.gateEnvs[1]!
    assert.equal(gateEnv['DEPLOY_TOKEN'], 'profile-deploy', 'without grant when same name Profile explicit value takes effect (do not along use old grant)')
    assert.equal(gateEnv['API_KEY'], undefined, 'other secret same do not inject')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// workflow journal refer grain
// ---------------------------------------------------------------------------

test('agentJournalKey:secretNames reference and refer grain (grant change do not re- use old cache; default and undefined same key, without across version do not change promise)', { timeout: 60_000 }, () => {
  const base = { prompt: 'p', agentType: 'ci-runner' }
  const without = agentJournalKey(base)
  assert.equal(agentJournalKey({ ...base, secretNames: undefined }), without, 'undefined and default same key(same is null slot)')
  const withGrant = agentJournalKey({ ...base, secretNames: ['DEPLOY_TOKEN'] })
  assert.notEqual(withGrant, without)
  assert.notEqual(agentJournalKey({ ...base, secretNames: ['API_KEY'] }), withGrant, 'different grant different key')
})

// ---------------------------------------------------------------------------
// real turn compute join motion (createHelm + faux:completed/failed/aborted + late hook)
// ---------------------------------------------------------------------------

test('real turn compute:completed/failed/aborted all stop inject turn secret; old value still redaction;late hook register under one turn', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-secret-turnsettle-'))
  // slow fast stream (1 tok/s,4 character/token):aborted scenario must real in-flight stream can by cancel; short back re- still second level complete.
  const { app, faux } = await createHubTestApp({
    dataDir,
    cwd: dataDir,
    fauxOptions: { tokensPerSecond: 1, tokenSize: { min: 4, max: 4 } },
  })
  try {
    const kernel = app.kernel
    const stash = kernel.services.stash
    const outcomes: string[] = []
    let latePut = false
    await kernel.plugins!.register({
      id: 'test:secret-settle-probe',
      name: 'secret compute probe needle',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          outcomes.push(payload.outcome)
          // late hook(only in first time compute register, verify reclaim boundary): compute chain inside register turn secret
          // (settleTurn already first row push enter counter)→ belong under one turn.
          if (!latePut) {
            latePut = true
            stash.put(payload.conversation.id, 'LATE_HOOK_KEY', `late-${payload.conversation.id}`, { scope: 'turn' })
          }
        })
      },
    } satisfies PluginDefinition)

    // --- completed: real succeeded turn
    const conv = await kernel.createConversation({ title: 'secret turn' })
    stash.put(conv.id, 'TURN_TOKEN', 'turn-tok-value', { scope: 'turn' })
    stash.put(conv.id, 'SESSION_TOKEN', 'session-tok-value')
    faux.setResponses([fauxAssistantMessage('complete answer')])
    await kernel.submitInput(conv.id, 'one question')
    await kernel.waitForIdle(conv.id)
    await waitFor(() => outcomes.length >= 1, { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(outcomes[0], 'completed')
    assert.equal(stash.has(conv.id, 'TURN_TOKEN'), false, 'completed compute after turn secret stop inject (payload.conversation.id real join motion)')
    assert.equal(stash.has(conv.id, 'SESSION_TOKEN'), true, 'conversation level do not subject to compute affect')
    assert.equal(stash.envFor(conv.id)['LATE_HOOK_KEY'], `late-${conv.id}`, 'late hook register turn secret store (belong under one turn)')
    assert.equal(stash.redact('turn-tok-value').includes('turn-tok-value'), false, 'compute after old value still redaction')

    // --- late hook register follow under once compute reclaim
    faux.setResponses([fauxAssistantMessage('second answer')])
    await kernel.submitInput(conv.id, 'second question')
    await kernel.waitForIdle(conv.id)
    await waitFor(() => outcomes.length >= 2, { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(outcomes[1], 'completed')
    assert.equal(stash.has(conv.id, 'LATE_HOOK_KEY'), false, 'late register follow under once turn compute reclaim')

    // --- failed: real failed turn (faux stopReason=error)
    const failed = await kernel.createConversation({ title: 'failed turn' })
    stash.put(failed.id, 'FAIL_TURN', 'fail-secret', { scope: 'turn' })
    faux.setResponses([fauxAssistantMessage('boom', { stopReason: 'error' })])
    await kernel.submitInput(failed.id, 'will failed issue')
    await kernel.waitForIdle(failed.id)
    await waitFor(() => outcomes.includes('failed'), { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(stash.has(failed.id, 'FAIL_TURN'), false, 'failed compute same reclaim turn secret')
    assert.equal(stash.redact('fail-secret').includes('fail-secret'), false)

    // --- aborted: slow fast streaming in real in-flight cancel
    const abortedConv = await kernel.createConversation({ title: 'abort turn' })
    stash.put(abortedConv.id, 'ABORT_TURN', 'abort-secret', { scope: 'turn' })
    faux.setResponses([fauxAssistantMessage('this is one segment by slow fast streaming output long text ensure abort when turn still in streaming in')])
    await kernel.submitInput(abortedConv.id, 'will by abort issue')
    await kernel.abortConversation(abortedConv.id)
    await kernel.waitForIdle(abortedConv.id)
    await waitFor(() => outcomes.includes('aborted'), { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(stash.has(abortedConv.id, 'ABORT_TURN'), false, 'aborted compute same reclaim turn secret')
    assert.equal(stash.redact('abort-secret').includes('abort-secret'), false)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// original generate execute row honest reject (without external runtime consume when never pretend grant succeeded)
// ---------------------------------------------------------------------------

test('original generate execute row: non-empty secretNames explicit unsupported_secret_grant(by default plugin collection without external runtime not silently ignore); empty array etc. same not grant', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-secret-native-'))
  // by default plugin collection:builtin:herdr deactivate → agent_spawn without external runtime take over, original generate execute row must explicit reject.
  const { app, faux } = await createHubTestApp({ dataDir, cwd: dataDir })
  try {
    const kernel = app.kernel
    kernel.services.stash.put(1, 'NATIVE_KEY', 'native-secret')
    await assert.rejects(
      kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'original generate task carries secret grant',
        agentType: 'assistant',
        secretNames: ['NATIVE_KEY'],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'unsupported_secret_grant',
      'original generate sub-conversation cannot bear connect parent conversation secret grant: explicit errors, not silently ignore, do not pretend subagent already acquire',
    )
    // empty array = not grant: original generate execute row normal execute (faux sub-conversation real complete).
    faux.setResponses([fauxAssistantMessage('original generate answer')])
    const result = await kernel.spawnAgent({
      parentConversationId: 1,
      prompt: 'empty grant task',
      secretNames: [],
    })
    assert.ok(result !== undefined, 'empty array etc. same not grant, original generate execute do not subject to affect')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// plugin config naming empty between and motion state credentials isolated (original plugin-config-namespace.test.ts)
// ---------------------------------------------------------------------------

// motion state credentials and configSchema secret shared use credentials.json, but only declaration config can out station.
test('plugin config HTTP in restart and deactivate when all hide motion state credentials, and keep already declaration config redaction', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-config-namespace-'))
  const pluginId = 'test:dynamic-credentials'
  const dynamicSecret = 'dynamic-hook-signing-key-7e4a'
  const configSecret = 'declared-config-key-94b2'
  const credentials = new CredentialService(dataDir)
  await credentials.setPluginSecret(pluginId, 'webhook:demo', dynamicSecret)
  await credentials.setPluginSecret(pluginId, 'apiKey', configSecret)
  let app: Awaited<ReturnType<typeof createHubTestApp>>['app'] | undefined
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      ({ app } = await createHubTestApp({ dataDir, cwd: dataDir }))
      await app.kernel.plugins.register({
        id: pluginId,
        definePlugin(ctx) {
          ctx.configSchema({
            apiKey: { type: 'string', secret: true },
            retries: { type: 'number', default: 3 },
          })
        },
      }, { enabled: false })
      const credential = app.kernel.auth.createProcessToken()
      try {
        const handler = createHubHandler(app.kernel)
        const response = await handler(new Request(`http://localhost/api/plugins/${encodeURIComponent(pluginId)}/config`, {
          headers: { authorization: `Bearer ${credential.token}` },
        }))
        assert.equal(response.status, 200)
        const body = await response.text()
        assert.ok(!body.includes(dynamicSecret), 'deactivate plugin motion state secret key must not via config interface leak leak')
        assert.ok(!body.includes('webhook:demo'), 'motion state secret key must not into is public config field')
        assert.ok(!body.includes(configSecret), 'declaration secret must mask code')
        const parsed = JSON.parse(body) as { values: Record<string, unknown> }
        assert.equal(parsed.values.apiKey, '******')
        assert.equal(Object.hasOwn(parsed.values, 'webhook:demo'), false)
      } finally {
        credential.dispose()
      }
      await app.close()
      app = undefined
    }
  } finally {
    await app?.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
