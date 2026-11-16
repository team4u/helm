/**
 * plugin governance and fault isolated increase strong dedicated items test (design document 20261111).
 *
 * override four items capability:
 * 1. external plugin fault isolated state machine:scan/load/define/enable phase failed fall back register is
 *    status:'failed'(contains structure error diagnose), do not block assert createHelm;loadFailed
 *    occupy item enable directly 409 plugin_load_failed; fix source code after reload restore;
 *    define phase failed fix after enable self-heal is active;
 * 2. durable asset occupy (inUse) and deactivate preflight: service self declaration + host through use reference probe
 *    (profile_runtime / profile_model / conversation_model);409 plugin_in_use
 *    + force force deactivate;liveTasks hard block assert force also do not skip;inUse check exception explicit
 *    plugin_in_use_check_failed never static default when empty;
 * 3. turn_settled single plugin exception isolated: single handle throws or illegal artifact do not block assert downstream,
 *    warning notification alert;transform keep on one legal payload;
 * 4. plugin config layer trace source: disk only store explicit override value (do not solid default),getConfig together into
 *    default,getConfigSources zone configured/default/unset,null reset.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock; command add total timeout.
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
// test base create
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

/** carries subject to control Profile / conversation store backend fixture (host reference probe assertion use). */
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
  // sharing collect hang to backend on (fixture internal communication, does not participate contract)
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

/** in disk write a external plugin directory (index.mjs form). */
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
    assert.ok(err instanceof HelmError, `expectation HelmError, actual:${String(err)}`)
    assert.equal(err.code, code)
    if (status !== undefined) assert.equal(err.status, status)
    caught = err
    return true
  })
  assert.ok(caught instanceof HelmError)
  return caught
}

// ---------------------------------------------------------------------------
// 1. external plugin fault isolated state machine (failed state and restore)
// ---------------------------------------------------------------------------

test('external plugin mixed fault directory:createHelm normal start, well plugin available, broken plugin one by one register is failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-mixed-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    // well plugin
    writeExternalPlugin(
      pluginsDir,
      'good-plugin',
      `export default {\n  id: 'good-plugin',\n  name: 'well plugin',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: 'probe',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    // broken plugin.json(scan phase)
    const badJson = join(pluginsDir, 'bad-json')
    mkdirSync(badJson, { recursive: true })
    writeFileSync(join(badJson, 'plugin.json'), '{ broken !!')
    // entry missing (scan phase)
    const missingEntry = join(pluginsDir, 'missing-entry')
    mkdirSync(missingEntry, { recursive: true })
    writeFileSync(join(missingEntry, 'plugin.json'), JSON.stringify({ main: 'ghost.mjs' }))
    // definePlugin throws (define phase, via isolateFailure absorb)
    writeExternalPlugin(
      pluginsDir,
      'bad-define',
      `export default {\n  id: 'bad-define',\n  name: 'define crash',\n  definePlugin() { throw new Error('define phase crash') },\n}\n`,
    )

    app = await createApp(dataDir)
    const list = app.kernel.plugins.list()

    // well plugin normal register and available
    const good = list.find((p) => p.id === 'good-plugin')
    assert.ok(good, 'well plugin should by register')
    assert.equal(good.enabled, false)
    await app.kernel.plugins.enable('good-plugin')
    const ping = (await app.kernel.plugins.invokeAction('good-plugin', 'ping', {})) as { ok: boolean }
    assert.equal(ping.ok, true)

    // broken plugin.json:failed + plugin_manifest_invalid
    const broken = list.find((p) => p.id === 'bad-json')
    assert.ok(broken, 'broken manifest plugin should register is failed item')
    assert.equal(broken.enabled, false)
    assert.equal(broken.status, 'failed')
    assert.equal(broken.error!.code, 'plugin_manifest_invalid')

    // entry missing:failed + plugin_entry_missing
    const missing = list.find((p) => p.id === 'missing-entry')
    assert.ok(missing)
    assert.equal(missing.status, 'failed')
    assert.equal(missing.error!.code, 'plugin_entry_missing')

    // definePlugin throws:failed + stage 'define'
    const bad = list.find((p) => p.id === 'bad-define')
    assert.ok(bad, 'define crash plugin should register is failed item (do not whole block assert)')
    assert.equal(bad.status, 'failed')
    assert.equal(bad.enabled, false)
    assert.equal(bad.error!.stage, 'define')
    assert.match(bad.error!.message, /define phase crash/)
    // failed plugin without any capability register
    assert.deepEqual(bad.hooks, [])
    assert.deepEqual(bad.actions, [])
    assert.deepEqual(bad.tools, [])

    // built-in plugin do not subject to affect
    assert.ok(list.some((p) => p.id === 'builtin:profile' && p.enabled))
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadFailed occupy item:enable directly 409 plugin_load_failed; fix source code after reload restore available', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-reload-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    const dirPath = join(pluginsDir, 'fix-me')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '{ broken')

    app = await createApp(dataDir)
    const failed = app.kernel.plugins.list().find((p) => p.id === 'fix-me')
    assert.ok(failed, 'broken manifest register is directory name occupy item')
    assert.equal(failed.status, 'failed')

    // loadFailed item enable reject: without valid definition, heavy enable cannot self-heal
    await rejectsCode(app.kernel.plugins.enable('fix-me'), 'plugin_load_failed', 409)

    // fix source code: write legal entry
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'fix-me',\n  name: 'fix after plugin',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: 'probe',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    rmSync(join(dirPath, 'plugin.json'))

    const result = await app.kernel.plugins.reloadExternalPlugin('fix-me')
    assert.equal(result.pluginId, 'fix-me')
    assert.equal(result.summary.status, 'disabled', 'reload after restore is normal disabled item (error empty)')
    assert.equal(result.summary.error, undefined)

    // reload after enable succeeded, action available
    await app.kernel.plugins.enable('fix-me')
    const ping = (await app.kernel.plugins.invokeAction('fix-me', 'ping', {})) as { ok: boolean }
    assert.equal(ping.ok, true)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('define phase failed external plugin (valid definition): fix after enable self-heal is active,error empty', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-heal-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    const pluginsDir = join(dataDir, 'plugins')
    const dirPath = join(pluginsDir, 'self-heal')
    mkdirSync(dirPath, { recursive: true })
    // module load succeeded but definePlugin throws (subject to config control:state file store in when failed)
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

    // fix external condition after enable self-heal (definition valid, heavy run definePlugin)
    rmSync(join(dirPath, 'broken.flag'))
    await app.kernel.plugins.enable('self-heal')
    const healed = app.kernel.plugins.list().find((p) => p.id === 'self-heal')!
    assert.equal(healed.enabled, true)
    assert.equal(healed.status, 'active')
    assert.equal(healed.error, undefined, 'enable after success lastError empty')
    const ping = (await app.kernel.plugins.invokeAction('self-heal', 'ping', {})) as { ok: boolean }
    assert.equal(ping.ok, true)
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('persist pluginEnabled=true external plugin service failed to start: fall back failed(stage enable) and do not override disk switch', { timeout: 60_000 }, async () => {
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

    // pre- persist pluginEnabled['svc-fail'] = true(simulated user once enable)
    const configPath = join(dataDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ pluginEnabled: { 'svc-fail': true } }))

    app = await createApp(dataDir)
    const failed = app.kernel.plugins.list().find((p) => p.id === 'svc-fail')
    assert.ok(failed, 'restore enable failed plugin should keep is failed item')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.enabled, false)
    assert.equal(failed.error!.stage, 'enable')
    assert.match(failed.error!.message, /external service not ready/)

    // disk pluginEnabled original value do not motion (do not override user intent)
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { pluginEnabled: Record<string, boolean> }
    assert.equal(raw.pluginEnabled['svc-fail'], true, 'restore failed must not override disk switch')

    // fix after enable self-heal
    rmSync(join(dirPath, 'fail.flag'))
    await app.kernel.plugins.enable('svc-fail')
    const healed = app.kernel.plugins.list().find((p) => p.id === 'svc-fail')!
    assert.equal(healed.status, 'active')
  } finally {
    await app?.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('built-in plugin register failed keep strictly block assert (do not fall back failed)', { timeout: 60_000 }, async () => {
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
    // do not appear in manifest (without failed item)
    assert.equal(fixture.host.list().some((p) => p.id === 'builtin:broken'), false)
  } finally {
    await fixture.close()
  }
})

test('manually enable external plugin failed:409/500 error such as on throw, also list reverse reflect failed', { timeout: 60_000 }, async () => {
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

    // manually enable failed: error on throw (HTTP/CLI receives explicit error response)
    const err = await rejectsCode(fixture.host.enable('ext:manual'), 'plugin_service_start_failed', 500)
    assert.match(err.message, /failed to start/)
    // list state reverse reflect failed
    const failed = fixture.host.list().find((p) => p.id === 'ext:manual')!
    assert.equal(failed.status, 'failed')
    assert.equal(failed.enabled, false)
    assert.equal(failed.error!.stage, 'enable')

    // fix after enable succeeded
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
// 2. durable asset occupy (inUse) and deactivate preflight
// ---------------------------------------------------------------------------

test('service declaration inUse: by default 409 plugin_in_use carry usages;force after deactivate succeeded', { timeout: 60_000 }, async () => {
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

    // has occupy: by default 409 intercept
    const err = await rejectsCode(fixture.host.disable('ext:scheduler'), 'plugin_in_use', 409)
    const usages = (err.details as { usages: Array<{ kind: string; id: string; label: string }> }).usages
    assert.deepEqual(usages, [{ kind: 'cron_job', id: 'j1', label: 'cron job "j1" (0 * * * *)' }])
    // reject path no side effects: keep enable
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:scheduler')!.enabled, true)

    // force: know situation deactivate
    await fixture.host.disable('ext:scheduler', { force: true })
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:scheduler')!.enabled, false)

    // occupy empty after by default deactivate also directly succeeded
    await fixture.host.enable('ext:scheduler')
    jobs = []
    await fixture.host.disable('ext:scheduler')
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:scheduler')!.enabled, false)
  } finally {
    await fixture.close()
  }
})

test('inUse check throw exception or return illegal shape: explicit plugin_in_use_check_failed, never static default when empty', { timeout: 60_000 }, async () => {
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
      assert.equal(fixture.host.list().find((p) => p.id === 'ext:bad-inuse')!.enabled, true, 'check failed does not change state')
    } finally {
      await fixture.close()
    }
  }
})

test('host reference probe:profile_runtime / profile_model / conversation_model three class occupy', { timeout: 60_000 }, async () => {
  const base = await makeHostFixture()
  // carries provider mount port fixture(reference probe need to provider declaration real register).
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
    // occupy type plugin: declaration profileRuntime kind + two provider
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

    // without reference when (fixture profiles.list / listConversations available but without hit): directly deactivate succeeded
    await fixture.host.disable('ext:runtime')
    await fixture.host.enable('ext:runtime')

    // Profile bind set runtime.kind
    fixture.backend.profileStore.set('coder', {
      id: 'coder',
      name: 'encode role',
      runtime: { kind: 'myrt', agent: 'pi' },
    })
    // Profile by default model points to prov-a
    fixture.backend.profileStore.set('writer', { id: 'writer', name: 'write act role', model: 'prov-a/some-model' })
    // conversation model points to prov-a
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

    // force after deactivate succeeded
    await fixture.host.disable('ext:runtime', { force: true })
  } finally {
    await fixture.close()
  }
})

test('liveTasks hard block assert:force also never skip (state consistency takes precedence)', { timeout: 60_000 }, async () => {
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
    // liveTasks hard block assert:force also reject
    await rejectsCode(fixture.host.disable('ext:busy', { force: true }), 'plugin_has_live_tasks', 409)
    // converge after force deactivate succeeded (inUse know situation let through)
    panes.clear()
    await fixture.host.disable('ext:busy', { force: true })
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:busy')!.enabled, false)
  } finally {
    await fixture.close()
  }
})

test('builtin:triggers inUse: enable cron task and webhook end point block deactivate,force let through', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-gov-triggers-'))
  let app: Awaited<ReturnType<typeof createApp>> | undefined
  try {
    app = await createApp(dataDir)
    const TRIGGERS = 'builtin:triggers'
    await app.kernel.plugins.enable(TRIGGERS)

    // initial without task: deactivate succeeded (then re- enable)
    await app.kernel.plugins.disable(TRIGGERS)
    await app.kernel.plugins.enable(TRIGGERS)

    // create enable cron task + webhook end point
    await app.kernel.plugins.invokeAction(TRIGGERS, 'cron_create', { id: 'daily', schedule: '0 9 * * *', text: 'morning report' })
    await app.kernel.plugins.invokeAction(TRIGGERS, 'cron_create', { id: 'off', schedule: '0 9 * * *', text: 'x', enabled: false })
    await app.kernel.plugins.invokeAction(TRIGGERS, 'webhook_create', { id: 'hook1', secret: 'whsec_gov' })

    const err = await rejectsCode(app.kernel.plugins.disable(TRIGGERS), 'plugin_in_use', 409)
    const usages = (err.details as { usages: Array<{ kind: string; id: string }> }).usages
    // only contains enable cron(off do not compute)+ webhook end point
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
// 3. turn_settled single plugin exception isolated
// ---------------------------------------------------------------------------

test('turn_settled: high priority plugin throws by isolated alert, downstream superagent style handle per common execute and receives on one legal payload', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    const seen: Array<{ by: string; outcome: string; error?: string }> = []
    // high priority broken plugin: throw exception
    await fixture.host.register({
      id: 'broken-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => {
          throw new Error('boom in settler')
        }, { priority: 10 })
      },
    })
    // in priority broken plugin: illegal action
    await fixture.host.register({
      id: 'bad-action-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled(() => ({ action: 'block', reason: 'nope' }) as never, { priority: 5 })
      },
    })
    // low priority well plugin: read transform after payload continue compute (superagent style)
    await fixture.host.register({
      id: 'good-settler',
      definePlugin: (ctx) => {
        ctx.hook.onTurnSettled((payload) => {
          seen.push({ by: 'good', outcome: payload.outcome, error: payload.error })
          return { action: 'continue' }
        })
      },
    })
    // legal transform plugin (introduce at well broken between): confirm isolated after payload does not fall back
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
    // pipeline whole do not throws: normal return transform(eventually payload)
    assert.equal(result.action, 'transform')
    if (result.action === 'transform') {
      assert.equal(result.value.error, 'transformed-note')
    }
    // downstream well plugin per common execute, receives transform after payload
    assert.deepEqual(seen, [{ by: 'good', outcome: 'failed', error: 'transformed-note' }])

    // two broken plugin each receives a warning notification
    const notes = fixture.payloads
      .filter((e) => e.type === 'notification')
      .map((e) => e.payload as { level: string; title: string; body: string })
    assert.equal(notes.length, 2, `should has two alert, actual ${notes.length}`)
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

test('turn_settled: intercept type hook (before_turn) still fail-closed;turn_settled isolated transform break payload do not block assert', { timeout: 60_000 }, async () => {
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

    // turn_settled transform break must want field: isolated the plugin, payload keep on one legal value
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
    assert.equal(downstreamSeen, 'completed', 'downstream receives on one legal payload (not by break value pollute)')
  } finally {
    await fixture.close()
  }
})

test('turn_settled handled normal short route; entry payload illegal still explicit throws (kernel bug not silently)', { timeout: 60_000 }, async () => {
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

    // entry initial payload illegal: directly throws (does not enter isolated pattern)
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
// 4. plugin config layer trace source (sources), do not solid default and null reset
// ---------------------------------------------------------------------------

/** establish carries configSchema plugin host fixture(real HelmPluginConfigStore). */
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

test('config do not solid default: disk only store explicit override value;getConfig together into default;sources three state trace source', { timeout: 60_000 }, async () => {
  const f = await makeConfigFixture()
  try {
    // not config: all fall back (endpoint/timeout has default,apiKey unset)
    let values = f.host.getConfig('ext:cfg')
    assert.equal(values.endpoint, 'http://127.0.0.1:3425')
    assert.equal(values.timeout, 5000)
    assert.equal('apiKey' in values, false)
    let sources = f.host.getConfigSources('ext:cfg')
    assert.deepEqual(sources, { endpoint: 'default', timeout: 'default', apiKey: 'unset' })

    // explicit config timeout + apiKey
    await f.host.setConfig('ext:cfg', { timeout: 8000, apiKey: 'sk-123' })
    const rawConfig = JSON.parse(readFileSync(join(f.dataDir, 'config.json'), 'utf8')) as {
      plugins?: Record<string, Record<string, unknown>>
    }
    // disk only contains timeout: 8000(excludes endpoint solid default value)
    assert.deepEqual(rawConfig.plugins?.['ext:cfg'], { timeout: 8000 })

    values = f.host.getConfig('ext:cfg')
    assert.equal(values.endpoint, 'http://127.0.0.1:3425', 'not config field motion state together into default')
    assert.equal(values.timeout, 8000)
    assert.equal(values.apiKey, 'sk-123')
    sources = f.host.getConfigSources('ext:cfg')
    assert.deepEqual(sources, { endpoint: 'default', timeout: 'configured', apiKey: 'configured' })
  } finally {
    await f.close()
  }
})

test('null reset:timeout fall back default,apiKey clear secret; disk key delete', { timeout: 60_000 }, async () => {
  const f = await makeConfigFixture()
  try {
    await f.host.setConfig('ext:cfg', { timeout: 8000, apiKey: 'sk-123' })
    // null reset two field
    await f.host.setConfig('ext:cfg', { timeout: null, apiKey: null })

    // disk explicit key by delete (bucket is empty when whole remove plugins['ext:cfg'] item)
    const rawConfig = JSON.parse(readFileSync(join(f.dataDir, 'config.json'), 'utf8')) as {
      plugins?: Record<string, Record<string, unknown>>
    }
    assert.equal(
      rawConfig.plugins?.['ext:cfg'],
      undefined,
      'null reset after disk plugin bucket by clean up',
    )
    // credentials.json for should secret key by delete
    const credRaw = JSON.parse(readFileSync(join(f.credentialsDir, 'credentials.json'), 'utf8')) as {
      pluginSecrets?: Record<string, Record<string, string>>
    }
    assert.equal(credRaw.pluginSecrets?.['ext:cfg'], undefined, 'secret key by delete')

    // valid value and source restore fall back state
    const values = f.host.getConfig('ext:cfg')
    assert.equal(values.timeout, 5000, 'reset after fall back schema.default')
    assert.equal('apiKey' in values, false)
    const sources = f.host.getConfigSources('ext:cfg')
    assert.deepEqual(sources, { endpoint: 'default', timeout: 'default', apiKey: 'unset' })
  } finally {
    await f.close()
  }
})

test('required validate: required and without default field missing or by null clear when 400 validation_error', { timeout: 60_000 }, async () => {
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
    // fully not config:required missing errors
    await rejectsCode(store.set('ext:req', {}, schema), 'validation_error', 400)
    // config after succeeded
    await store.set('ext:req', { token: 't1' }, schema)
    assert.equal(store.get('ext:req').token, 't1')
    // null clear required field: errors (required and without default cannot clear)
    await rejectsCode(store.set('ext:req', { token: null }, schema), 'validation_error', 400)
    // unknown field reject
    await rejectsCode(store.set('ext:req', { nope: 'x' }, schema), 'validation_error', 400)
    // non- secret type validate
    await rejectsCode(store.set('ext:req', { token: 42 }, schema), 'validation_error', 400)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('null reset unknown field:validation_error; plugin schema adjust default after fall back value motion state with follow', { timeout: 60_000 }, async () => {
  const f = await makeConfigFixture()
  try {
    // unknown field (even if null) also reject
    await rejectsCode(f.host.setConfig('ext:cfg', { unknown: null }), 'validation_error', 400)

    // schema.default upgrade after: disk without solid value,get motion state reverse reflect new by default (via second host simulated upgrade)
    await f.host.setConfig('ext:cfg', { timeout: 9000 })
    await f.host.setConfig('ext:cfg', { timeout: null })
    // not config when get together into is when before schema  default(5000)
    assert.equal(f.host.getConfig('ext:cfg').timeout, 5000)

    // not registered plugin getConfig: without schema when only return store value (do not together into)
    assert.deepEqual(f.host.getConfig('ext:unknown'), {})
  } finally {
    await f.close()
  }
})

test('PluginSummary status semantics:active/disabled/failed three state and error attach carries', { timeout: 60_000 }, async () => {
  const fixture = await makeHostFixture()
  try {
    // active: normal enable
    await fixture.host.register({
      id: 'ext:alive',
      definePlugin: () => {},
    })
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:alive')!.status, 'active')

    // disabled: deactivate (without fault)
    await fixture.host.disable('ext:alive')
    const disabled = fixture.host.list().find((p) => p.id === 'ext:alive')!
    assert.equal(disabled.status, 'disabled')
    assert.equal(disabled.error, undefined)

    // failed: external plugin define failed fall back
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

    // failed after unregister + re- register (fix after same name plugin): is normal state
    await fixture.host.unregister('ext:dead')
    await fixture.host.register(
      {
        id: 'ext:dead',
        definePlugin: () => {},
      },
      { enabled: false, isolateFailure: true },
    )
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:dead')!.status, 'disabled')
    assert.equal(fixture.host.list().find((p) => p.id === 'ext:dead')!.error, undefined, 're- register after error empty')
  } finally {
    await fixture.close()
  }
})
