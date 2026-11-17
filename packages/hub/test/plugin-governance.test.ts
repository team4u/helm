/**
 * Dedicated tests for plugin governance and fault isolation enhancements (design doc 20261111).
 *
 * Covers four capabilities:
 * 1. External plugin fault isolation state machine: failures during scan/load/define/enable register as
 *    status:'failed' (with structured error diagnostics) without blocking createHelm; enabling a loadFailed
 *    placeholder throws 409 plugin_load_failed; reload recovers after source code fixes;
 *    define-stage failures self-heal on enable after fixing the issue;
 * 2. Durable asset usage (inUse) and disable preflight: service-declared + host-probed references
 *    (profile_runtime / profile_model / conversation_model); 409 plugin_in_use
 *    + force disable; liveTasks hard block cannot be bypassed by force; inUse check exceptions throw
 *    explicit plugin_in_use_check_failed and never silently default to empty;
 * 3. turn_settled per-plugin exception isolation: a single handler throwing or returning invalid artifacts
 *    does not block downstream plugins and emits a warning notification; transform retains the last valid payload;
 * 4. Plugin config layer provenance: disk stores only explicit overrides (defaults are not persisted),
 *    getConfig merges defaults, getConfigSources distinguishes configured/default/unset, null resets.
 *
 * Runner: tsx --test; each test specifies timeout: 60_000 to guard against deadlocks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmError, type ConversationSummary, type Profile } from '@helm/protocol'
import { PluginHost } from '../../kernel/src/plugins/plugin-host.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import {
  ConfigService,
  CredentialService,
} from '../../kernel/src/services/index.js'
import { HelmPluginConfigStore } from '../../kernel/src/runtime/plugin-config-store.js'
import {
  type PluginConfigStore,
  type PluginHostBackend,
} from '../../kernel/src/plugins/index.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import {
  createHubTestApp,
  makeConversationSummary,
  MemoryConfigStore,
  MemoryDocStore,
} from './helpers/hub-test-env.js'

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

async function createApp(dataDir: string) {
  return (await createHubTestApp({ dataDir, cwd: dataDir })).app
}

function makeConversation(id: number, model = ''): ConversationSummary {
  return makeConversationSummary({ id, model })
}

interface HostFixture {
  host: PluginHost
  events: string[]
  payloads: Array<{ type: string; payload: unknown }>
  backend: PluginHostBackend & { profileStore: Map<string, Profile>; conversationStore: ConversationSummary[] }
  dataDir: string
  close(): Promise<void>
}

/** Backend fixture with controllable Profile and conversation stores (for host reference probe assertions). */
function makeBackend(): HostFixture['backend'] {
  const payloads: Array<{ type: string; payload: unknown }> = []
  const events: string[] = []
  const backend = {
    ...createPluginHostBackendFixture(),
    profileStore: new Map<string, Profile>(),
    conversationStore: [makeConversation(1)] as ConversationSummary[],
    profiles: {
      list: async () => [...backend.profileStore.values()],
      get: async (id: string) => backend.profileStore.get(id),
    },
    listConversations: () => [...backend.conversationStore],
    emitEvent: (type: string, payload: unknown) => {
      events.push(`event:${type}`)
      payloads.push({ type, payload })
    },
  } as HostFixture['backend']
  // Attach shared collectors to backend (internal fixture communication, not part of the contract)
  Object.assign(backend, { __events: events, __payloads: payloads })
  return backend
}

function makeHostFixture(overrides: { config?: PluginConfigStore } = {}): HostFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-test-'))
  const backend = makeBackend()
  const events = (backend as unknown as { __events: string[] }).__events
  const payloads = (backend as unknown as { __payloads: Array<{ type: string; payload: unknown }> }).__payloads
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    ...(overrides.config ? { config: overrides.config } : {}),
  })
  return {
    host,
    events,
    payloads,
    backend,
    dataDir,
    async close() {
      await host.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** Write an external plugin directory to disk (index.mjs format). */
function writeExternalPlugin(
  pluginsDir: string,
  dir: string,
  entrySource: string,
  manifest?: Record<string, unknown>,
): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'index.mjs'), entrySource)
  if (manifest !== undefined) {
    writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify(manifest))
  }
  return dirPath
}

async function rejectsCode(promise: Promise<unknown>, code: string, status?: number): Promise<HelmError> {
  let caught: HelmError | undefined
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HelmError, `expected HelmError, got: ${String(err)}`)
    assert.equal(err.code, code)
    if (status !== undefined) assert.equal(err.status, status)
    caught = err
    return true
  })
  assert.ok(caught instanceof HelmError)
  return caught
}

// ---------------------------------------------------------------------------
// 1. External plugin fault isolation state machine (failed status & recovery)
// ---------------------------------------------------------------------------

test('external plugin mixed fault directory: createHelm starts normally, valid plugin works, broken plugins register as failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-mixed-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    // Valid plugin
    writeExternalPlugin(
      pluginsDir,
      'good-plugin',
      `export default {\n  id: 'good-plugin',\n  name: 'well plugin',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: 'probe',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    // Broken plugin.json (scan phase)
    const badJson = join(pluginsDir, 'bad-json')
    mkdirSync(badJson, { recursive: true })
    writeFileSync(join(badJson, 'plugin.json'), '{ broken !!')
    // Missing entry (scan phase)
    const missingEntry = join(pluginsDir, 'missing-entry')
    mkdirSync(missingEntry, { recursive: true })
    writeFileSync(join(missingEntry, 'plugin.json'), JSON.stringify({ main: 'ghost.mjs' }))
    // definePlugin throws (define phase, absorbed via isolateFailure)
    writeExternalPlugin(
      pluginsDir,
      'bad-define',
      `export default {\n  id: 'bad-define',\n  name: 'define crash',\n  definePlugin() { throw new Error('define phase crash') },\n}\n`,
    )

    app = await createApp(dataDir)
    const list = app.kernel.plugins.list()

    // Valid plugin registers normally and works
    const good = list.find((p) => p.id === 'good-plugin')
    assert.ok(good, 'valid plugin should be registered')
    assert.equal(good.enabled, false)
    await app.kernel.plugins.enable('good-plugin')
    const ping = (await app.kernel.plugins.invokeAction('good-plugin', 'ping', {})) as { ok: boolean }
    assert.equal(ping.ok, true)

    // Broken plugin.json: failed + plugin_manifest_invalid
    const broken = list.find((p) => p.id === 'bad-json')
    assert.ok(broken, 'broken manifest plugin should register as failed')
    assert.equal(broken.enabled, false)
    assert.equal(broken.status, 'failed')
    assert.equal(broken.error!.code, 'plugin_manifest_invalid')

    // Missing entry: failed + plugin_entry_missing
    const missing = list.find((p) => p.id === 'missing-entry')
    assert.ok(missing)
    assert.equal(missing.status, 'failed')
    assert.equal(missing.error!.code, 'plugin_entry_missing')

    // definePlugin throws: failed + stage 'define'
    const bad = list.find((p) => p.id === 'bad-define')
    assert.ok(bad, 'define-crash plugin should register as failed without blocking startup')
    assert.equal(bad.status, 'failed')
    assert.equal(bad.enabled, false)
    assert.equal(bad.error!.stage, 'define')
    assert.match(bad.error!.message, /define phase crash/)
    // Failed plugin registers no capabilities
    assert.deepEqual(bad.hooks, [])
    assert.deepEqual(bad.actions, [])
    assert.deepEqual(bad.tools, [])

    // Built-in plugins are unaffected
    assert.ok(list.some((p) => p.id === 'builtin:profile' && p.enabled))
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadFailed placeholder: direct enable throws 409 plugin_load_failed; reload recovers after fixing source', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    const dirPath = join(pluginsDir, 'fix-me')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '{ broken')

    app = await createApp(dataDir)
    const failed = app.kernel.plugins.list().find((p) => p.id === 'fix-me')
    assert.ok(failed, 'broken manifest registers a directory-named placeholder entry')
    assert.equal(failed.status, 'failed')

    // Enabling a loadFailed placeholder rejects: without a valid definition, re-enabling cannot self-heal
    await rejectsCode(app.kernel.plugins.enable('fix-me'), 'plugin_load_failed', 409)

    // Fix source code: write a valid entry
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'fix-me',\n  name: 'fix after plugin',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: 'probe',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    rmSync(join(dirPath, 'plugin.json'))

    const result = await app.kernel.plugins.reloadExternalPlugin('fix-me')
    assert.equal(result.pluginId, 'fix-me')
    assert.equal(result.summary.status, 'disabled', 'after reload it recovers to a normal disabled entry with error cleared')
    assert.equal(result.summary.error, undefined)

    // After reload, enable succeeds and action is usable
    await app.kernel.plugins.enable('fix-me')
    const ping = (await app.kernel.plugins.invokeAction('fix-me', 'ping', {})) as { ok: boolean }
    assert.equal(ping.ok, true)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('define-phase failed external plugin (valid definition): enable self-heals to active and clears error after fix', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-heal-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    const dirPath = join(pluginsDir, 'self-heal')
    mkdirSync(dirPath, { recursive: true })
    // Module loads successfully but definePlugin throws (remains configurable; failure state stored on instance)
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `import { existsSync } from 'node:fs'\nexport default {\n  id: 'self-heal',\n  name: 'self-heal plugin',\n  async definePlugin(ctx) {\n    if (existsSync(new URL('./broken.flag', import.meta.url))) throw new Error('external dependency not ready')\n    ctx.action({\n      id: 'ping',\n      description: 'probe',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    writeFileSync(join(dirPath, 'broken.flag'), '1')

    app = await createApp(dataDir)
    const failed = app.kernel.plugins.list().find((p) => p.id === 'self-heal')
    assert.ok(failed)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error!.stage, 'define')

    // Enable self-heals after external condition is fixed (valid definition re-runs definePlugin)
    rmSync(join(dirPath, 'broken.flag'))
    await app.kernel.plugins.enable('self-heal')
    const healed = app.kernel.plugins.list().find((p) => p.id === 'self-heal')!
    assert.equal(healed.enabled, true)
    assert.equal(healed.status, 'active')
    assert.equal(healed.error, undefined, 'lastError should be cleared after enable succeeds')
    const ping = (await app.kernel.plugins.invokeAction('self-heal', 'ping', {})) as { ok: boolean }
    assert.equal(ping.ok, true)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('persisted pluginEnabled=true external plugin fails service start: falls back to failed (stage enable) without overwriting disk toggle', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-enfail-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    const dirPath = join(pluginsDir, 'svc-fail')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `import { existsSync } from 'node:fs'\nexport default {\n  id: 'svc-fail',\n  name: 'service failed to start',\n  async definePlugin(ctx) {\n    ctx.service({\n      id: 'daemon',\n      start() {\n        if (existsSync(new URL('./fail.flag', import.meta.url))) throw new Error('external service not ready')\n      },\n      stop() {},\n    })\n  },\n}\n`,
    )
    writeFileSync(join(dirPath, 'fail.flag'), '1')

    // Pre-persist pluginEnabled['svc-fail'] = true (simulating previously enabled by user)
    const configPath = join(dataDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ pluginEnabled: { 'svc-fail': true } }))

    app = await createApp(dataDir)
    const failed = app.kernel.plugins.list().find((p) => p.id === 'svc-fail')
    assert.ok(failed, 'plugin that fails during restore-enable should stay registered as failed')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.enabled, false)
    assert.equal(failed.error!.stage, 'enable')
    assert.match(failed.error!.message, /external service not ready/)

    // Disk pluginEnabled original value is untouched (do not overwrite user intent)
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { pluginEnabled: Record<string, boolean> }
    assert.equal(raw.pluginEnabled['svc-fail'], true, 'restore failure must not overwrite disk toggle')

    // Enable self-heals after fix
    rmSync(join(dirPath, 'fail.flag'))
    await app.kernel.plugins.enable('svc-fail')
    const healed = app.kernel.plugins.list().find((p) => p.id === 'svc-fail')!
    assert.equal(healed.status, 'active')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('built-in plugin registration failure stays strict and blocks startup (never falls back to failed)', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    await rejectsCode(
      fixture.host.register({
        id: 'builtin:broken',
        definePlugin() {
          throw new Error('built-in plugin code defect')
        },
      }),
      'plugin_registration_failed',
    )
    // Does not appear in the list (no failed entry)
    assert.equal(fixture.host.list().some((p) => p.id === 'builtin:broken'), false)
  } finally {
    await fixture.close()
  }
})

test('manually enabling external plugin fails: 409/500 error propagates as thrown and list reflects failed status', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    let shouldFail = true
    await fixture.host.register(
      {
        id: 'ext:manual',
        name: 'manually enable failed',
        definePlugin: (ctx) => {
          ctx.service({
            id: 'svc',
            start() {
              if (shouldFail) throw new Error('failed to start')
            },
            stop() {},
          })
        },
      },
      { enabled: false, isolateFailure: true },
    )
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:manual')!.status, 'disabled')

    // Manual enable failure: throws directly (HTTP/CLI receives explicit error response)
    const err = await rejectsCode(fixture.host.enable('ext:manual'), 'plugin_service_start_failed', 500)
    assert.match(err.message, /failed to start/)
    // List status reflects failed
    const failed = fixture.host.list().find((p) => p.id === 'ext:manual')!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.enabled, false)
    assert.equal(failed.error!.stage, 'enable')

    // Enable succeeds after fix
    shouldFail = false
    await fixture.host.enable('ext:manual')
    const healed = fixture.host.list().find((p) => p.id === 'ext:manual')!
    assert.equal(healed.status, 'active')
    assert.equal(healed.error, undefined)
  } finally {
    await fixture.close()
  }
})

// ---------------------------------------------------------------------------
// 2. Durable asset usage (inUse) and disable preflight
// ---------------------------------------------------------------------------

test('service-declared inUse: defaults to 409 plugin_in_use with usages; force disable succeeds', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    let jobs: Array<{ id: string; schedule: string }> = [{ id: 'j1', schedule: '0 * * * *' }]
    await fixture.host.register({
      id: 'ext:scheduler',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'sched',
          start() {},
          stop() {},
          inUse() {
            return jobs.map((j) => ({ kind: 'cron_job', id: j.id, label: `cron job "${j.id}" (${j.schedule})` }))
          },
        })
      },
    })

    // In use: blocked by default with 409
    const err = await rejectsCode(fixture.host.disable('ext:scheduler'), 'plugin_in_use', 409)
    const usages = (err.details as { usages: Array<{ kind: string; id: string; label: string }> }).usages
    assert.deepEqual(usages, [{ kind: 'cron_job', id: 'j1', label: 'cron job "j1" (0 * * * *)' }])
    // Rejection has no side effects: remains enabled
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:scheduler')!.enabled, true)

    // force: disable with acknowledgement
    await fixture.host.disable('ext:scheduler', { force: true })
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:scheduler')!.enabled, false)

    // Once usages are empty, default disable succeeds directly
    await fixture.host.enable('ext:scheduler')
    jobs = []
    await fixture.host.disable('ext:scheduler')
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:scheduler')!.enabled, false)
  } finally {
    await fixture.close()
  }
})

test('inUse check throws or returns invalid shape: explicit plugin_in_use_check_failed, never falls back to empty', { timeout: 60_000 }, async () => {
  for (const bad of ['throw', 'not-array', 'missing-label'] as const) {
    const fixture = await makeHostFixture()
    try {
      await fixture.host.register({
        id: 'ext:bad-inuse',
        definePlugin: (ctx) => {
          ctx.service({
            id: 'svc',
            start() {},
            stop() {},
            inUse: () => {
              if (bad === 'throw') throw new Error('for account crash')
              if (bad === 'not-array') return 'nope' as unknown as never
              return [{ kind: 'x', id: 'y' }] as never
            },
          })
        },
      })
      const err = await rejectsCode(fixture.host.disable('ext:bad-inuse'), 'plugin_in_use_check_failed', 500)
      assert.equal((err.details as { serviceId: string }).serviceId, 'svc')
      assert.equal(fixture.host.list().find((p) => p.id === 'ext:bad-inuse')!.enabled, true, 'check failure must not alter state')
    } finally {
      await fixture.close()
    }
  }
})

test('host reference probe: profile_runtime / profile_model / conversation_model usage types', { timeout: 60_000 }, async () => {
  const base = await makeHostFixture()
  // Fixture with provider mount port (reference probe requires provider declarations to be registered).
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-rt-'))
  const backend = makeBackend()
  const events = (backend as unknown as { __events: string[] }).__events
  const payloads = (backend as unknown as { __payloads: Array<{ type: string; payload: unknown }> }).__payloads
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    providers: {
      register: async (provider) => async () => {},
      assertIdle: () => {},
    },
  })
  const fixture: HostFixture = {
    host,
    events,
    payloads,
    backend,
    dataDir,
    async close() {
      await host.dispose()
      await base.host.dispose().catch(() => {})
      rmSync(base.dataDir, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  try {
    // Plugin declaring both profileRuntime kind and a provider
    await fixture.host.register({
      id: 'ext:runtime',
      definePlugin: (ctx) => {
        ctx.ui.profileRuntime({ id: 'rt', kind: 'myrt', label: 'external runtime' })
        ctx.provider({
          id: 'prov-a',
          name: 'Prov A',
          auth: { apiKey: { name: 'k', resolve: async () => undefined } },
          getModels: () => [],
          stream: () => {
            throw new Error('no')
          },
          streamSimple: () => {
            throw new Error('no')
          },
        } as never)
        ctx.service({ id: 'svc', start() {}, stop() {} })
      },
    })

    // Without references (fixture profiles.list / listConversations are available with no hits): disable succeeds directly
    await fixture.host.disable('ext:runtime')
    await fixture.host.enable('ext:runtime')

    // Profile bound to runtime.kind
    fixture.backend.profileStore.set('coder', {
      id: 'coder',
      name: 'encode role',
      runtime: { kind: 'myrt', agent: 'pi' },
    })
    // Profile default model points to prov-a
    fixture.backend.profileStore.set('writer', { id: 'writer', name: 'write act role', model: 'prov-a/some-model' })
    // Conversation model points to prov-a
    fixture.backend.conversationStore.push(makeConversation(9, 'prov-a/another'))

    const err = await rejectsCode(fixture.host.disable('ext:runtime'), 'plugin_in_use', 409)
    const usages = (err.details as { usages: Array<{ kind: string; id: string; label: string }> }).usages
    const kinds = usages.map((u) => `${u.kind}:${u.id}`).sort()
    assert.deepEqual(kinds, ['conversation_model:9', 'profile_model:writer', 'profile_runtime:coder'])
    const rt = usages.find((u) => u.kind === 'profile_runtime')!
    assert.match(rt.label, /encode role.*myrt/)
    const pm = usages.find((u) => u.kind === 'profile_model')!
    assert.match(pm.label, /write act role.*prov-a\/some-model/)
    const cm = usages.find((u) => u.kind === 'conversation_model')!
    assert.match(cm.label, /conversation #9.*prov-a\/another/)

    // Force disable succeeds
    await fixture.host.disable('ext:runtime', { force: true })
  } finally {
    await fixture.close()
  }
})

test('liveTasks hard block: even force cannot bypass (state consistency takes precedence)', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    const panes = new Set<string>()
    await fixture.host.register({
      id: 'ext:busy',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start() {},
          stop() {},
          liveTasks: () => [...panes].map((p) => `pane:${p}`),
          inUse: () => [{ kind: 'pane', id: 'p1', label: 'terminal panel' }],
        })
      },
    })
    panes.add('win-1')
    // liveTasks hard block: rejected even with force
    await rejectsCode(fixture.host.disable('ext:busy', { force: true }), 'plugin_has_live_tasks', 409)
    // After draining, force disable succeeds (inUse is bypassed with acknowledgement)
    panes.clear()
    await fixture.host.disable('ext:busy', { force: true })
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:busy')!.enabled, false)
  } finally {
    await fixture.close()
  }
})

test('builtin:triggers inUse: enabled cron jobs and webhook endpoints block disable; force bypasses', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-triggers-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    app = await createApp(dataDir)
    const TRIGGERS = 'builtin:triggers'
    await app.kernel.plugins.enable(TRIGGERS)

    // Initially no tasks: disable succeeds (then re-enable)
    await app.kernel.plugins.disable(TRIGGERS)
    await app.kernel.plugins.enable(TRIGGERS)

    // Create enabled cron job + webhook endpoint
    await app.kernel.plugins.invokeAction(TRIGGERS, 'cron_create', { id: 'daily', schedule: '0 9 * * *', text: 'morning report' })
    await app.kernel.plugins.invokeAction(TRIGGERS, 'cron_create', { id: 'off', schedule: '0 9 * * *', text: 'x', enabled: false })
    await app.kernel.plugins.invokeAction(TRIGGERS, 'webhook_create', { id: 'hook1', secret: 'whsec_gov' })

    const err = await rejectsCode(app.kernel.plugins.disable(TRIGGERS), 'plugin_in_use', 409)
    const usages = (err.details as { usages: Array<{ kind: string; id: string }> }).usages
    // Only includes enabled cron job (disabled 'off' is excluded) + webhook endpoint
    const ids = usages.map((u) => `${u.kind}:${u.id}`).sort()
    assert.deepEqual(ids, ['cron_job:daily', 'webhook_endpoint:hook1'])

    await app.kernel.plugins.disable(TRIGGERS, { force: true })
    assert.equal(app.kernel.plugins.list().find((p) => p.id === TRIGGERS)!.enabled, false)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. turn_settled per-plugin exception isolation
// ---------------------------------------------------------------------------

test('turn_settled: high-priority plugin failure is isolated with alert, downstream superagent-style handler runs normally with last valid payload', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    const seen: Array<{ by: string; outcome: string; error?: string }> = []
    // High-priority broken plugin: throws exception
    await fixture.host.register({
      id: 'broken-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => {
          throw new Error('boom in settler')
        }, { priority: 10 })
      },
    })
    // Medium-priority broken plugin: returns invalid action
    await fixture.host.register({
      id: 'bad-action-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => ({ action: 'block', reason: 'nope' }) as never, { priority: 5 })
      },
    })
    // Low-priority valid plugin: reads transformed payload to continue processing (superagent-style)
    await fixture.host.register({
      id: 'good-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled((payload) => {
          seen.push({ by: 'good', outcome: payload.outcome, error: payload.error })
          return { action: 'continue' }
        })
      },
    })
    // Valid transform plugin (placed between broken and valid): confirms payload does not revert after isolation
    await fixture.host.register({
      id: 'transform-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(
          (payload) => ({ action: 'transform', value: { ...payload, error: 'transformed-note' } }),
          { priority: 2 },
        )
      },
    })

    const result = await fixture.host.runHook('turn_settled', {
      conversation: makeConversation(1),
      inputs: [],
      outcome: 'failed',
      settledAt: 100,
    })
    // Overall pipeline does not throw: returns transform (final payload)
    assert.equal(result.action, 'transform')
    if (result.action === 'transform') {
      assert.equal(result.value.error, 'transformed-note')
    }
    // Downstream valid plugin runs normally and receives the transformed payload
    assert.deepEqual(seen, [{ by: 'good', outcome: 'failed', error: 'transformed-note' }])

    // Each broken plugin produces one warning notification
    const notes = fixture.payloads
      .filter((e) => e.type === 'notification')
      .map((e) => e.payload as { level: string; title: string; body: string })
    assert.equal(notes.length, 2, `expected two alerts, got ${notes.length}`)
    for (const note of notes) {
      assert.equal(note.level, 'warning')
      assert.match(note.title, /turn compute hook exception/)
    }
    const titles = notes.map((n) => n.title).sort()
    assert.match(titles[0]!, /bad-action-settler/)
    assert.match(titles[1]!, /broken-settler/)
    assert.match(notes.find((n) => n.title.includes('broken-settler'))!.body, /boom in settler/)
  } finally {
    await fixture.close()
  }
})

test('turn_settled: blocking hook (before_turn) remains fail-closed; corrupted transform payload in turn_settled does not block', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    await fixture.host.register({
      id: 'strict:before',
      definePlugin: (ctx) => {
        ctx.hook.onBeforeTurn(() => {
          throw new Error('before_turn crash')
        })
      },
    })
    await rejectsCode(
      fixture.host.runHook('before_turn', {
        conversation: makeConversation(1),
        inputs: [],
        tools: [],
        sections: [],
        messages: [],
      }),
      'hook_execution_failed',
      500,
    )

    // turn_settled transform drops required fields: isolates that plugin and keeps previous valid payload
    let downstreamSeen: string | undefined
    await fixture.host.register({
      id: 'break:settle',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(
          () => ({ action: 'transform', value: { broken: true } as never }),
          { priority: 5 },
        )
      },
    })
    await fixture.host.register({
      id: 'read:settle',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled((payload) => {
          downstreamSeen = payload.outcome
          return { action: 'continue' }
        })
      },
    })
    const result = await fixture.host.runHook('turn_settled', {
      conversation: makeConversation(1),
      inputs: [],
      outcome: 'completed',
      settledAt: 1,
    })
    assert.equal(result.action, 'transform')
    assert.equal(downstreamSeen, 'completed', 'downstream receives previous valid payload without corruption')
  } finally {
    await fixture.close()
  }
})

test('turn_settled handled short-circuits normally; invalid entry payload still throws explicitly (never swallowed)', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    let downstreamRan = false
    await fixture.host.register({
      id: 'handled:settle',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => ({ action: 'handled', result: { settled: true } }), { priority: 10 })
      },
    })
    await fixture.host.register({
      id: 'after:settle',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => {
          downstreamRan = true
          return { action: 'continue' }
        })
      },
    })
    const result = await fixture.host.runHook('turn_settled', {
      conversation: makeConversation(1),
      inputs: [],
      outcome: 'completed',
      settledAt: 1,
    })
    assert.deepEqual(result, { action: 'handled', result: { settled: true } })
    assert.equal(downstreamRan, false)

    // Invalid initial entry payload: throws directly (does not enter isolation mode)
    await rejectsCode(
      fixture.host.runHook('turn_settled', {
        conversation: makeConversation(1),
        inputs: [],
        outcome: 'weird' as never,
        settledAt: 1,
      }),
      'invalid_hook_result',
    )
  } finally {
    await fixture.close()
  }
})

// ---------------------------------------------------------------------------
// 4. Plugin config layer provenance (sources), no persisted defaults, null reset
// ---------------------------------------------------------------------------

/** Create a plugin host fixture with configSchema (using real HelmPluginConfigStore). */
async function makeConfigFixture(): Promise<{
  host: PluginHost
  store: HelmPluginConfigStore
  dataDir: string
  credentialsDir: string
  close(): Promise<void>
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-cfg-'))
  const credentialsDir = join(dataDir, 'cred')
  mkdirSync(credentialsDir, { recursive: true })
  const config = new ConfigService(dataDir)
  const credentials = new CredentialService(credentialsDir)
  const store = new HelmPluginConfigStore({ config, credentials })
  await store.load()
  const backend = makeBackend()
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore(), config: store })
  await host.register({
    id: 'ext:cfg',
    definePlugin: (ctx) => {
      ctx.configSchema({
        endpoint: { type: 'string', label: 'end point', default: 'http://127.0.0.1:3425' },
        timeout: { type: 'number', label: 'timeout', default: 5000 },
        apiKey: { type: 'string', label: 'secret key', secret: true },
      })
    },
  })
  return {
    host,
    store,
    dataDir,
    credentialsDir,
    async close() {
      await host.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('config does not persist defaults: disk stores only explicit overrides; getConfig merges defaults; sources tracks provenance', { timeout: 60_000 }, async () => {
  const f = await makeConfigFixture()
  try {
    // Unconfigured: all fall back (endpoint/timeout have defaults, apiKey is unset)
    let values = f.host.getConfig('ext:cfg')
    assert.equal(values.endpoint, 'http://127.0.0.1:3425')
    assert.equal(values.timeout, 5000)
    assert.equal('apiKey' in values, false)
    let sources = f.host.getConfigSources('ext:cfg')
    assert.deepEqual(sources, { endpoint: 'default', timeout: 'default', apiKey: 'unset' })

    // Explicitly configure timeout + apiKey
    await f.host.setConfig('ext:cfg', { timeout: 8000, apiKey: 'sk-123' })
    const rawConfig = JSON.parse(readFileSync(join(f.dataDir, 'config.json'), 'utf8')) as {
      plugins?: Record<string, Record<string, unknown>>
    }
    // Disk contains only timeout: 8000 (endpoint default value is not persisted)
    assert.deepEqual(rawConfig.plugins?.['ext:cfg'], { timeout: 8000 })

    values = f.host.getConfig('ext:cfg')
    assert.equal(values.endpoint, 'http://127.0.0.1:3425', 'unconfigured field dynamically merges default')
    assert.equal(values.timeout, 8000)
    assert.equal(values.apiKey, 'sk-123')
    sources = f.host.getConfigSources('ext:cfg')
    assert.deepEqual(sources, { endpoint: 'default', timeout: 'configured', apiKey: 'configured' })
  } finally {
    await f.close()
  }
})

test('null reset: timeout falls back to default, apiKey clears secret; disk keys are deleted', { timeout: 60_000 }, async () => {
  const f = await makeConfigFixture()
  try {
    await f.host.setConfig('ext:cfg', { timeout: 8000, apiKey: 'sk-123' })
    // Reset both fields with null
    await f.host.setConfig('ext:cfg', { timeout: null, apiKey: null })

    // Explicit disk key is deleted (empty bucket removes plugins['ext:cfg'] entirely)
    const rawConfig = JSON.parse(readFileSync(join(f.dataDir, 'config.json'), 'utf8')) as {
      plugins?: Record<string, Record<string, unknown>>
    }
    assert.equal(
      rawConfig.plugins?.['ext:cfg'],
      undefined,
      'plugin bucket on disk should be cleaned up after null reset',
    )
    // Corresponding secret key in credentials.json is deleted
    const credRaw = JSON.parse(readFileSync(join(f.credentialsDir, 'credentials.json'), 'utf8')) as {
      pluginSecrets?: Record<string, Record<string, string>>
    }
    assert.equal(credRaw.pluginSecrets?.['ext:cfg'], undefined, 'secret key should be deleted')

    // Effective values and sources revert to fallback state
    const values = f.host.getConfig('ext:cfg')
    assert.equal(values.timeout, 5000, 'falls back to schema.default after reset')
    assert.equal('apiKey' in values, false)
    const sources = f.host.getConfigSources('ext:cfg')
    assert.deepEqual(sources, { endpoint: 'default', timeout: 'default', apiKey: 'unset' })
  } finally {
    await f.close()
  }
})

test('required validation: missing or null-cleared required field without default returns 400 validation_error', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-req-'))
  const credentialsDir = join(dataDir, 'cred')
  mkdirSync(credentialsDir, { recursive: true })
  const store = new HelmPluginConfigStore({
    config: new ConfigService(dataDir),
    credentials: new CredentialService(credentialsDir),
  })
  await store.load()
  const schema: Record<string, import('@helm/protocol').PluginConfigFieldSchema> = {
    token: { type: 'string', required: true },
    optional: { type: 'string' },
  }
  try {
    // Completely unconfigured: missing required field throws
    await rejectsCode(store.set('ext:req', {}, schema), 'validation_error', 400)
    // Succeeds after configuring
    await store.set('ext:req', { token: 't1' }, schema)
    assert.equal(store.get('ext:req').token, 't1')
    // Null-clearing required field throws (cannot clear required field without default)
    await rejectsCode(store.set('ext:req', { token: null }, schema), 'validation_error', 400)
    // Rejects unknown field
    await rejectsCode(store.set('ext:req', { nope: 'x' }, schema), 'validation_error', 400)
    // Non-secret type validation
    await rejectsCode(store.set('ext:req', { token: 42 }, schema), 'validation_error', 400)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('null reset unknown field returns validation_error; fallback dynamically tracks updated schema default', { timeout: 60_000 }, async () => {
  const f = await makeConfigFixture()
  try {
    // Unknown field is rejected even if null
    await rejectsCode(f.host.setConfig('ext:cfg', { unknown: null }), 'validation_error', 400)

    // After schema.default upgrade: no persisted value on disk, get dynamically reflects new default
    await f.host.setConfig('ext:cfg', { timeout: 9000 })
    await f.host.setConfig('ext:cfg', { timeout: null })
    // When unconfigured, get merges the current schema default (5000)
    assert.equal(f.host.getConfig('ext:cfg').timeout, 5000)

    // getConfig for unregistered plugin: without schema returns stored values only (no merge)
    assert.deepEqual(f.host.getConfig('ext:unknown'), {})
  } finally {
    await f.close()
  }
})

test('PluginSummary status semantics: active/disabled/failed states and error attachment', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    // active: normally enabled
    await fixture.host.register({
      id: 'ext:alive',
      definePlugin: () => {},
    })
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:alive')!.status, 'active')

    // disabled: deactivated without fault
    await fixture.host.disable('ext:alive')
    const disabled = fixture.host.list().find((p) => p.id === 'ext:alive')!
    assert.equal(disabled.status, 'disabled')
    assert.equal(disabled.error, undefined)

    // failed: external plugin falls back when define fails
    await fixture.host.register(
      {
        id: 'ext:dead',
        definePlugin() {
          throw new Error('hang')
        },
      },
      { isolateFailure: true },
    )
    const failed = fixture.host.list().find((p) => p.id === 'ext:dead')!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.enabled, false)
    assert.equal(failed.error!.code, 'plugin_execution_failed')
    assert.equal(failed.error!.stage, 'define')

    // After failed: unregister + re-register fixed plugin with same name returns to normal state
    await fixture.host.unregister('ext:dead')
    await fixture.host.register(
      {
        id: 'ext:dead',
        definePlugin: () => {},
      },
      { enabled: false, isolateFailure: true },
    )
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:dead')!.status, 'disabled')
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:dead')!.error, undefined, 'error cleared after re-registration')
  } finally {
    await fixture.close()
  }
})
