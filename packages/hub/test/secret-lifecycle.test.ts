/**
 * SecretStash lifecycle convergence tests:
 * - TTL (injected clock lazy expiration): expiration stops injection only (`envFor`/`has`/`stats`), while old values
 *   continue to be redacted across all outputs (including cross-chunk streaming KMP); same-name overwrites still redact old values;
 * - `SecretLifetime` boundary validation: `ttlMs` must be a finite positive safe integer <= 24h, `scope` enum,
 *   rejects unknown keys (`AskDoc` spec and `stash.put` share the same validation);
 * - Turn scope owned precisely by monotonic settlement counter: turn-scoped entries settle on `settleTurn` while
 *   entries registered after settlement (async approvals / late hooks) belong to the next turn and are not swept;
 *   conversation-scoped entries survive settlement, idle does not sweep, `clear(conversationId)` reclaims redaction values;
 * - `AskService` wiring: `secretLifetime` allowed only on `secret` fields, invalid shapes reject 400,
 *   omitted defaults to conversation-scoped (matching legacy behavior);
 * - `buildSpawnEnv` least privilege: carries zero parent secrets by default, injects only explicitly named
 *   `secretNames`, missing/expired names fail explicitly 404, invalid shapes fail 400;
 * - Herdr pane end-to-end: remote panes carry no business secrets by default while keeping managed `HELM_*`
 *   (including node-reported `hubUrl`) and explicit Profile env vars; Profile vars are not overwritten by ungranted
 *   parent secrets; explicit grants override same-named Profile vars; missing grants reject before pane creation;
 * - Workflow journal key: incorporates `secretNames` so grant changes invalidate stale cache hits.
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

/** Fake-clock stash: `now` advances arbitrarily. */
function fakeClockStash(): { stash: SecretStash; now: { ms: number } } {
  const now = { ms: 1_000_000 }
  return { stash: new SecretStash({ now: () => now.ms }), now }
}

test('TTL: lazy expiration stops injection only while redaction continues (including cross-chunk streaming)', { timeout: 60_000 }, () => {
  const { stash, now } = fakeClockStash()
  stash.put(7, 'DEPLOY_TOKEN', 'tok-abc-123', { ttlMs: 5_000 })
  assert.deepEqual(stash.envFor(7), { DEPLOY_TOKEN: 'tok-abc-123' })
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), true)

  now.ms += 4_999
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), true, 'still injected right before expiration')
  assert.deepEqual(stash.stats(), { conversations: 1, secrets: 1 })

  now.ms += 1
  assert.deepEqual(stash.envFor(7), {}, 'stops injecting upon expiration (lazy sweep on read)')
  assert.equal(stash.has(7, 'DEPLOY_TOKEN'), false)
  assert.deepEqual(stash.stats(), { conversations: 1, secrets: 0 })

  // Stopping injection does not stop redaction: old value continues to be replaced with a placeholder.
  assert.equal(stash.redact('leak: tok-abc-123').includes('tok-abc-123'), false)
  assert.ok(stash.redact('leak: tok-abc-123').startsWith('leak: [REDACTED:stash:'))

  // Streaming redactor still redacts values split across chunks after expiration (KMP suffix retention).
  const stream = stash.createStreamingRedactor()
  const out = stream.push('prefix tok-abc-') + stream.push('123 tail') + stream.flush()
  assert.equal(out.includes('tok-abc-123'), false)
  assert.ok(out.includes('[REDACTED:stash:'))
})

test('TTL: overwriting same name continues redacting the old value even after injection stops', { timeout: 60_000 }, () => {
  const { stash, now } = fakeClockStash()
  stash.put(7, 'KEY', 'old-value', { ttlMs: 1_000 })
  now.ms += 2_000
  stash.put(7, 'KEY', 'new-value')
  assert.deepEqual(stash.envFor(7), { KEY: 'new-value' }, 'new value takes effect')
  const text = stash.redact('old-value / new-value')
  assert.equal(text.includes('old-value'), false, 'expired old value continues to be redacted')
  assert.equal(text.includes('new-value'), false)
})

test('TTL cap boundary: 24h is valid; exceeding/non-integer/non-positive/non-numeric reject', { timeout: 60_000 }, () => {
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

test('SecretLifetime shape: rejects invalid scope, unknown keys, non-objects; empty object equals default semantics', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  assert.throws(
    () => stash.put(7, 'S', 'v', { scope: 'session' } as never),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
  )
  assert.throws(
    () => stash.put(7, 'S', 'v', { ttl: 5_000 } as never),
    (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    "unknown key 'ttl' (typo for ttlMs) must fail explicitly instead of silently omitting TTL",
  )
  assert.throws(() => stash.put(7, 'S', 'v', null as never), /validation_error|must be an object/)
  assert.throws(() => stash.put(7, 'S', 'v', [1] as never), /validation_error|must be an object/)
  assert.throws(() => stash.put(7, 'S', 'v', new Date() as never), /validation_error|must be an object/)
  assert.throws(() => stash.put(7, 'S', 'v', new Map() as never), /validation_error|must be an object/)
  stash.put(7, 'S', 'v', {})
  assert.equal(stash.has(7, 'S'), true, 'empty object defaults to conversation-scoped')
})

// ---------------------------------------------------------------------------
// SecretStash: turn scope (monotonic settlement counter)
// ---------------------------------------------------------------------------

test('turn: current-turn secrets settle out of injection while redaction stays; conversation scope unaffected', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'TURN_KEY', 'turn-secret', { scope: 'turn' })
  stash.put(7, 'SESSION_KEY', 'session-secret')
  stash.settleTurn(7)
  assert.equal(stash.has(7, 'TURN_KEY'), false)
  assert.equal(stash.has(7, 'SESSION_KEY'), true, 'conversation-scoped secrets (default) survive turn settlement')
  assert.deepEqual(stash.envFor(7), { SESSION_KEY: 'session-secret' })
  assert.equal(stash.redact('turn-secret').includes('turn-secret'), false, 'old value remains redacted after settlement')
})

test('turn: post-settlement registrations belong to next turn; idle does not sweep', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'A', 'a', { scope: 'turn' })
  stash.settleTurn(7) // Turn A settles: A reclaimed (settlement seq 0 < 1).
  // Async approval / late hook: registered after settlement (settlement seq 1), belongs to next turn.
  stash.put(7, 'B', 'b', { scope: 'turn' })
  stash.put(7, 'C', 'c', { scope: 'turn' })
  // No idle sweep: B/C stay injected across the next turn.
  assert.deepEqual(stash.envFor(7), { B: 'b', C: 'c' })
  stash.settleTurn(7) // Turn B settles: reclaims seq < 2 (B/C) without affecting future turns.
  assert.deepEqual(stash.envFor(7), {})
  assert.equal(stash.redact('b c').includes('b c'), false, 'old values remain redacted')
})

test('turn: turn secret registered after settlement settles on the subsequent settlement', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.settleTurn(7)
  stash.put(7, 'LATE', 'late-value', { scope: 'turn' })
  stash.settleTurn(7)
  // `LATE` has settlement seq 1: second settlement (1 -> 2) reclaims it while keeping it live until then.
  assert.equal(stash.has(7, 'LATE'), false)
})

test('turn: isolated per conversation — settling conv 7 leaves conv 8 turn secrets intact', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'K', 'v7', { scope: 'turn' })
  stash.put(8, 'K', 'v8', { scope: 'turn' })
  stash.settleTurn(7)
  assert.equal(stash.has(8, 'K'), true)
  assert.deepEqual(stash.envFor(8), { K: 'v8' })
})

test('clear: reclaims conversation secrets, stops injection and old-value redaction, resets stats', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'A', 'gone-value', { scope: 'turn' })
  stash.settleTurn(7)
  stash.put(7, 'B', 'live-value')
  stash.clear(7)
  assert.deepEqual(stash.envFor(7), {})
  assert.equal(stash.redact('gone-value live-value').includes('gone-value'), true, 'old values stop redacting once cleared')
  assert.equal(stash.has(7, 'B'), false)
  assert.deepEqual(stash.stats(), { conversations: 0, secrets: 0 })
})

// ---------------------------------------------------------------------------
// AskService integration (real store + SecretStash)
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

test('AskService: secretLifetime only allowed on secret fields; invalid shapes reject 400', { timeout: 60_000 }, async () => {
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
      'non-secret field declaring secretLifetime must reject',
    )
    await assert.rejects(
      ctx.service.createAsk({
        conversationId: 1,
        ownerPluginId: 't',
        title: 'x',
        fields: [{ name: 'tok', label: 't', type: 'text', secret: true, secretLifetime: { ttlMs: 0 } }],
      }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      'invalid ttlMs must reject before persistence',
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

test('AskService: valid secretLifetime passes through to stash; omitted defaults to conversation scope', { timeout: 60_000 }, async () => {
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
    assert.deepEqual(ctx.stash.envFor(1), { SESSION_TOKEN: 'session-tok' }, 'turn-scoped stops injecting on settle; omitted stays conversation-scoped')
    assert.equal(ctx.stash.redact('turn-tok').includes('turn-tok'), false)
    // Both asks settled cleanly (promises resolved rather than pending).
    assert.equal((await settled).status, 'answered')
    assert.equal((await plain).status, 'answered')
  } finally {
    await ctx.close()
  }
})

/** Polls until a pending ask appears (`createAsk` persists asynchronously). */
async function pollPending(service: AskService): Promise<{ id: string }> {
  for (let i = 0; i < 200; i += 1) {
    const pending = service.listPendingByConversation(1)
    if (pending.length > 0) return { id: pending[pending.length - 1]!.id }
    await delay(5)
  }
  throw new Error('pending ask not persisted')
}

// ---------------------------------------------------------------------------
// buildSpawnEnv: external spawn least privilege
// ---------------------------------------------------------------------------

/** Minimal `RuntimeAgentSpawn` assembly (drives `buildSpawnEnv` only; unused ports throw). */
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

test('buildSpawnEnv: zero secrets by default (least privilege), managed HELM_* intact', { timeout: 60_000 }, () => {
  const { stash } = fakeClockStash()
  stash.put(7, 'DEPLOY_TOKEN', 'tok-7')
  stash.put(7, 'API_KEY', 'key-7')
  const backend = spawnEnvBackend(stash, { token: 'managed-token' })
  const env = backend.buildSpawnEnv(7, '/w', 'local')
  assert.equal(env['DEPLOY_TOKEN'], undefined, 'carries zero parent conversation secrets by default')
  assert.equal(env['API_KEY'], undefined)
  assert.equal(env['HELM_ENV'], '1')
  assert.equal(env['HELM_CONVERSATION_ID'], '7')
  assert.equal(env['HELM_CWD'], '/w')
  assert.equal(env['HELM_NODE_ID'], 'local')
  assert.equal(env['HELM_DATA_DIR'], '/tmp/helm-spawnenv-data')
  assert.equal(env['HELM_TOKEN'], 'managed-token', 'managed token is independent of secret grants')
})

test('buildSpawnEnv: explicit secretNames injects named secrets only; ungranted secrets stay excluded', { timeout: 60_000 }, () => {
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

test('buildSpawnEnv: missing/expired/settled secret names fail 404 instead of silently injecting empty', { timeout: 60_000 }, () => {
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
      `${name} (missing/TTL expired/turn settled) must fail explicitly`,
    )
  }
})

test('buildSpawnEnv: invalid secretNames shape (duplicates / invalid names / non-array) rejects 400', { timeout: 60_000 }, () => {
  const backend = spawnEnvBackend(new SecretStash())
  for (const bad of [['A', 'A'], ['bad-name!'], [''], 42]) {
    assert.throws(
      () => backend.buildSpawnEnv(7, '/w', 'local', { secretNames: bad as string[] }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  }
})

test('buildSpawnEnv: single TTL clock sample avoids false-success empty injection at expiration boundary', { timeout: 60_000 }, () => {
  // Clock advances +1 per read: a two-sample `has` then `envFor` would cross the boundary
  // (`has` succeeds, `envFor` expires) and falsely succeed with a missing key.
  // A single `envFor` read followed by checking returned keys makes the decision atomic.
  const counter = { ms: 1_000 }
  const stash = new SecretStash({ now: () => (counter.ms += 1) })
  stash.put(7, 'EDGE_KEY', 'edge-value', { ttlMs: 2 }) // put samples 1001 -> expiresAt 1003
  const backend = spawnEnvBackend(stash)
  // Single sample at t=1002 (valid): succeeds with value.
  const env = backend.buildSpawnEnv(7, '/w', 'local', { secretNames: ['EDGE_KEY'] })
  assert.equal(env['EDGE_KEY'], 'edge-value', 'single clock sample at boundary must either return value or 404, never empty success')
  // Next read (t>=1003 expired): explicit 404.
  assert.throws(
    () => backend.buildSpawnEnv(7, '/w', 'local', { secretNames: ['EDGE_KEY'] }),
    (e: unknown) => e instanceof HelmError && e.code === 'secret_not_found',
  )
})

// ---------------------------------------------------------------------------
// Herdr pane end-to-end (real executor + real kernel buildSpawnEnv integration)
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

/** Controlled transport: records `tab.create` env and gate env; prompt completes immediately (writing handover file); `onPrompted` hook allows advancing clock / mutating stash before Gate. */
class FakeTransport implements HerdrTransport {
  panes = new Map<string, FakePane>()
  tabEnvs: Array<Record<string, string>> = []
  gateEnvs: Array<Record<string, string>> = []
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  /** Callback invoked on prompt completion (prior to writing handover file): lets tests advance clock or mutate stash before Gate. */
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
 * Real executor assembly: `buildSpawnEnv` uses real `RuntimeAgentSpawn` (real `SecretStash` + `buildManagedEnv`).
 * Profile `'ci-runner'` targets remote `node-a` (with node-reported `hubUrl`) and carries `CI_FLAG`,
 * same-named `DEPLOY_TOKEN`, and an attempted `HELM_CWD` override. Parent conv 7 has `DEPLOY_TOKEN`/`API_KEY`.
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

test('herdr pane: remote pane gets zero business secrets by default; managed HELM_* overrides Profile while Profile vars remain intact', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  try {
    const outcome = (await env.executor.handle({
      parentConversationId: 7,
      prompt: 'deploy it',
      agentType: 'ci-runner',
    })) as { action: string }
    assert.equal(outcome.action, 'handled')
    const paneEnv = env.transport.tabEnvs[0]!
    // Business secrets are not injected by default.
    assert.equal(paneEnv['API_KEY'], undefined, 'ungranted parent conversation secret must not enter pane')
    assert.equal(paneEnv['DEPLOY_TOKEN'], 'profile-deploy', 'explicit Profile value stays intact when parent secret is not granted')
    // Valid Profile variables are preserved.
    assert.equal(paneEnv['CI_FLAG'], 'profile-yes')
    // Managed `HELM_*`: kernel holds highest precedence; Profile cannot overwrite.
    assert.equal(paneEnv['HELM_ENV'], '1')
    assert.equal(paneEnv['HELM_CWD'] ?? paneEnv['HELM_CWD'], paneEnv['HELM_CWD'])
    assert.notEqual(paneEnv['HELM_CWD'], '/hijack', 'Profile attempt to override managed HELM_CWD must be overridden by kernel')
    assert.equal(paneEnv['HELM_CONVERSATION_ID'], '7')
    assert.equal(paneEnv['HELM_NODE_ID'], 'node-a')
    assert.equal(paneEnv['HELM_DATA_DIR'], undefined, 'remote panes must not receive Hub local DATA_DIR')
    // Node-reported `hubUrl` + managed token preserved for callback connection.
    assert.equal(paneEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202')
    assert.equal(paneEnv['HELM_TOKEN'], 'managed-token')
  } finally {
    await env.close()
  }
})

test('herdr pane: explicit secretNames grants override same-named Profile vars; ungranted secrets stay excluded', { timeout: 60_000 }, async () => {
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
    assert.equal(paneEnv['DEPLOY_TOKEN'], 'secret-deploy-7', 'explicitly granted secret overrides same-named Profile config')
    assert.equal(paneEnv['API_KEY'], undefined, 'ungranted secret remains excluded')
    assert.equal(paneEnv['CI_FLAG'], 'profile-yes')
    assert.equal(Object.hasOwn(paneEnv, '__proto__'), true)
    assert.equal(paneEnv['__proto__'], 'pane-prototype-named-secret')
  } finally {
    await env.close()
  }
})

test('herdr pane: missing granted secret rejects 404 secret_not_found before any pane creation side effects', { timeout: 60_000 }, async () => {
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
    assert.equal(env.transport.calls.length, 0, 'rejection occurs before any pane creation side effects')
  } finally {
    await env.close()
  }
})

test('herdr Gate: secrets are not cached across phases — Gate re-authorizes from live stash (picks up rotations)', { timeout: 60_000 }, async () => {
  // Pane creation receives v1; after task completes and before Gate starts, secret rotates to v2:
  // Gate child process must observe live stash v2 rather than cached v1 from pane creation.
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
    assert.equal(env.transport.tabEnvs[0]!['DEPLOY_TOKEN'], creationValue, 'pane creation injects initial v1')
    assert.equal(env.transport.gateEnvs.length, 1, 'Gate runs exactly once')
    const gateEnv = env.transport.gateEnvs[0]!
    assert.equal(gateEnv['DEPLOY_TOKEN'], 'rotated-value', 'Gate reads live stash value rather than creation-time cache')
    assert.equal(gateEnv['CI_FLAG'], 'profile-yes', 'Gate baseline preserves valid Profile vars')
    assert.equal(gateEnv['HELM_ENV'], '1', 'Gate baseline preserves managed vars')
    assert.equal(gateEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202', 'Gate baseline preserves node hubUrl')
  } finally {
    await env.close()
  }
})

test('herdr Gate: secret expiring during agent work rejects 404 before Gate child process spawns (zero Gate side effects)', { timeout: 60_000 }, async () => {
  const clock = { ms: 10_000 }
  const env = await openPaneEnv({
    clock: () => clock.ms,
    onPrompted: () => {
      clock.ms += 100 // TTL 50ms: clock advances past expiration during task work
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
      'expired grant must fail explicitly 404 before Gate instead of falling back or injecting stale value',
    )
    assert.equal(env.transport.gateEnvs.length, 0, 'Gate child process must not spawn (zero side effects)')
  } finally {
    await env.close()
  }
})

test('herdr Gate: grants do not leak to subsequent tasks — task without secretNames receives baseline only', { timeout: 60_000 }, async () => {
  const env = await openPaneEnv()
  const creationValue = env.stash.envFor(7)['DEPLOY_TOKEN']!
  try {
    // Task 1: carries grant + Gate -> Gate env receives granted secret.
    await env.executor.handle({
      parentConversationId: 7,
      prompt: 'first time deploy',
      agentType: 'ci-runner',
      gate: 'true',
      secretNames: ['DEPLOY_TOKEN'],
    })
    assert.equal(env.transport.gateEnvs[0]!['DEPLOY_TOKEN'], creationValue)
    // Task 2 (new pane): omits grant + Gate -> Profile baseline applies without reusing Task 1 grant.
    await env.executor.handle({
      parentConversationId: 7,
      prompt: 'second time deploy do not carries secret',
      agentType: 'ci-runner',
      gate: 'true',
    })
    const gateEnv = env.transport.gateEnvs[1]!
    assert.equal(gateEnv['DEPLOY_TOKEN'], 'profile-deploy', 'same-named Profile var applies when ungranted (no prior grant reuse)')
    assert.equal(gateEnv['API_KEY'], undefined, 'other secrets likewise stay excluded')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// Workflow journal key granularity
// ---------------------------------------------------------------------------

test('agentJournalKey incorporates secretNames (grant changes miss stale cache; undefined matches omitted)', { timeout: 60_000 }, () => {
  const base = { prompt: 'p', agentType: 'ci-runner' }
  const without = agentJournalKey(base)
  assert.equal(agentJournalKey({ ...base, secretNames: undefined }), without, 'undefined matches omitted (same empty slot)')
  const withGrant = agentJournalKey({ ...base, secretNames: ['DEPLOY_TOKEN'] })
  assert.notEqual(withGrant, without)
  assert.notEqual(agentJournalKey({ ...base, secretNames: ['API_KEY'] }), withGrant, 'different grants yield different keys')
})

// ---------------------------------------------------------------------------
// Real turn settlement integration (createHelm + faux: completed/failed/aborted + late hook)
// ---------------------------------------------------------------------------

test('real turn settlement: completed/failed/aborted all stop turn secret injection while redacting; late hook registers for next turn', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-secret-turnsettle-'))
  // Slow token stream (1 tok/s, 4 chars/token) so abort hits while streaming, while short replies stay quick.
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
          // Late hook (registers only on first settlement to verify reclamation boundary):
          // registering during settlement (`settleTurn` already bumped seq) belongs to the next turn.
          if (!latePut) {
            latePut = true
            stash.put(payload.conversation.id, 'LATE_HOOK_KEY', `late-${payload.conversation.id}`, { scope: 'turn' })
          }
        })
      },
    } satisfies PluginDefinition)

    // --- completed: real successful turn
    const conv = await kernel.createConversation({ title: 'secret turn' })
    stash.put(conv.id, 'TURN_TOKEN', 'turn-tok-value', { scope: 'turn' })
    stash.put(conv.id, 'SESSION_TOKEN', 'session-tok-value')
    faux.setResponses([fauxAssistantMessage('complete answer')])
    await kernel.submitInput(conv.id, 'one question')
    await kernel.waitForIdle(conv.id)
    await waitFor(() => outcomes.length >= 1, { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(outcomes[0], 'completed')
    assert.equal(stash.has(conv.id, 'TURN_TOKEN'), false, 'completed settlement stops turn secret injection')
    assert.equal(stash.has(conv.id, 'SESSION_TOKEN'), true, 'conversation-scoped secrets survive settlement')
    assert.equal(stash.envFor(conv.id)['LATE_HOOK_KEY'], `late-${conv.id}`, 'late hook registration remains live for the next turn')
    assert.equal(stash.redact('turn-tok-value').includes('turn-tok-value'), false, 'old value remains redacted after settlement')

    // --- late hook secret is reclaimed on the subsequent settlement
    faux.setResponses([fauxAssistantMessage('second answer')])
    await kernel.submitInput(conv.id, 'second question')
    await kernel.waitForIdle(conv.id)
    await waitFor(() => outcomes.length >= 2, { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(outcomes[1], 'completed')
    assert.equal(stash.has(conv.id, 'LATE_HOOK_KEY'), false, 'late registration reclaims on the next turn settlement')

    // --- failed: real failed turn (faux stopReason=error)
    const failed = await kernel.createConversation({ title: 'failed turn' })
    stash.put(failed.id, 'FAIL_TURN', 'fail-secret', { scope: 'turn' })
    faux.setResponses([fauxAssistantMessage('boom', { stopReason: 'error' })])
    await kernel.submitInput(failed.id, 'will failed issue')
    await kernel.waitForIdle(failed.id)
    await waitFor(() => outcomes.includes('failed'), { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(stash.has(failed.id, 'FAIL_TURN'), false, 'failed settlement likewise reclaims turn secret')
    assert.equal(stash.redact('fail-secret').includes('fail-secret'), false)

    // --- aborted: real in-flight cancellation during slow token stream
    const abortedConv = await kernel.createConversation({ title: 'abort turn' })
    stash.put(abortedConv.id, 'ABORT_TURN', 'abort-secret', { scope: 'turn' })
    faux.setResponses([fauxAssistantMessage('this is one segment by slow fast streaming output long text ensure abort when turn still in streaming in')])
    await kernel.submitInput(abortedConv.id, 'will by abort issue')
    await kernel.abortConversation(abortedConv.id)
    await kernel.waitForIdle(abortedConv.id)
    await waitFor(() => outcomes.includes('aborted'), { timeoutMs: 8_000, intervalMs: 15 })
    assert.equal(stash.has(abortedConv.id, 'ABORT_TURN'), false, 'aborted settlement likewise reclaims turn secret')
    assert.equal(stash.redact('abort-secret').includes('abort-secret'), false)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Native executor honest rejection (never pretend grants work when no external runtime consumes them)
// ---------------------------------------------------------------------------

test('native executor: non-empty secretNames rejects with unsupported_secret_grant; empty array is a no-op', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-secret-native-'))
  // Default plugin set disables `builtin:herdr` -> no external runtime intercepts `agent_spawn`, so native executor must reject explicitly.
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
      'native child conversations cannot inherit parent secret grants and must fail explicitly',
    )
    // Empty array = no grant: native executor runs normally (real faux child conversation completes).
    faux.setResponses([fauxAssistantMessage('original generate answer')])
    const result = await kernel.spawnAgent({
      parentConversationId: 1,
      prompt: 'empty grant task',
      secretNames: [],
    })
    assert.ok(result !== undefined, 'empty secretNames acts as no grant and does not block native execution')
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Plugin config namespace and dynamic credential isolation (formerly plugin-config-namespace.test.ts)
// ---------------------------------------------------------------------------

// Dynamic credentials and configSchema secrets share credentials.json, but only declared config fields may leave the endpoint.
test('plugin config HTTP hides dynamic credentials across restarts and disablement while redacting declared secrets', { timeout: 60_000 }, async () => {
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
        assert.ok(!body.includes(dynamicSecret), 'disabled plugin dynamic secret must not leak via config endpoint')
        assert.ok(!body.includes('webhook:demo'), 'dynamic secret key must not surface as a public config field')
        assert.ok(!body.includes(configSecret), 'declared secret must be masked')
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
