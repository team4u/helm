/**
 * external plugin directory <dataDir>/plugins/<dir>/ automatically discover and motion state load dedicated items test.
 *
 * combine discipline: real createHelm(true SQLite + true PluginHost + true assistant)+
 * faux provider + real disk on external plugin .mjs entry; do not mock app, do not fake host.
 *
 * override:
 * - convention entry (index.mjs) and plugin.json(main designate entry) two kinds of discover form;
 * - external plugin by default deactivate register,enable after action / public doc / client.tsx compile all link available;
 * - config.json.pluginEnabled = true external plugin across restarts auto-recovery enable;
 * - ordinary plugin under pure data directory (without plugin.json / index.js) static default skip;
 * - corrupt plugin.json / smoke fill builtin: id / out of bounds main(contains symlink real path out of bounds)/
 *   setup compatibility alias / non- string clientRoot explicit errors, never static default swallow wrong;
 * - EACCES etc. real IO fault explicit errors (do not mistakenly judge is pure data directory skip); only ENOENT/ENOTDIR treated as missing.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock; command add total timeout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmError } from '@helm/protocol'
import { loadExternalPlugins } from '../../kernel/src/plugins/external-loader.js'
import { pluginDataDirName } from '../../kernel/src/plugins/plugin-dir-name.js'
import { createHubTestApp, openHubTestEnv, type HubTestApp } from './helpers/hub-test-env.js'

// ---------------------------------------------------------------------------
// test base create
// ---------------------------------------------------------------------------

/** convention entry form external plugin source (index.mjs + client.tsx + action + public doc). */
const CONVENTION_PLUGIN_SRC = `
export default {
  id: 'demo-external',
  name: 'demo external plugin',
  version: '1.0.0',
  async definePlugin(ctx) {
    const status = ctx.doc('status', { count: 0 }, { public: true })
    ctx.action({
      id: 'bump',
      description: 'counter add one',
      inputSchema: { type: 'object', properties: { step: { type: 'number' } }, additionalProperties: false },
      outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false },
      handler: (input) => {
        status.update((cur) => ({ count: cur.count + (input?.step ?? 1) }))
        return { count: status.get().count }
      },
    })
    ctx.ui.screen({
      id: 'demo-panel',
      label: 'demo panel',
      client: { module: 'client.tsx', export: 'Panel' },
    })
  },
}
`

const CONVENTION_CLIENT_TSX = `import { useState } from 'react'
export function Panel(props: { title: string }) {
  const [n] = useState(props.title)
  return n
}
`

interface TestEnv {
  dataDir: string
  app: HubTestApp
  close(): Promise<void>
}

async function makeEnv(): Promise<TestEnv> {
  const env = await openHubTestEnv({ prefix: 'helm-ext-plugin-' })
  return {
    dataDir: env.dataDir,
    app: env.app,
    close: env.close,
  }
}

/** in designate dataDir on start createHelm(external plugin discover failed error assertion use). */
async function makeEnvIn(dataDir: string): Promise<HubTestApp> {
  return (await createHubTestApp({ dataDir, cwd: dataDir })).app
}

/** write a convention entry form external plugin directory. */
function writeConventionPlugin(pluginsDir: string, dir = 'demo-external'): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'index.mjs'), CONVENTION_PLUGIN_SRC)
  writeFileSync(join(dirPath, 'client.tsx'), CONVENTION_CLIENT_TSX)
  return dirPath
}

/** in dataDir  config.json in persist pluginEnabled.<id> = value. */
async function persistEnabled(dataDir: string, pluginId: string, value: boolean): Promise<void> {
  const configPath = join(dataDir, 'config.json')
  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  }
  const enabled = (config.pluginEnabled ?? {}) as Record<string, boolean>
  enabled[pluginId] = value
  config.pluginEnabled = enabled
  writeFileSync(configPath, JSON.stringify(config, null, 2))
}

// ---------------------------------------------------------------------------
// automatically discover and register
// ---------------------------------------------------------------------------

test('convention entry index.mjs external plugin in createHelm at startup by automatically discover and by default deactivate register', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    // pre- placement external plugin directory (first at createHelm, simulated user manually work put)
    writeConventionPlugin(join(dataDir, 'plugins'))
    // also pre- placement a built-in plugin will under pure data directory form interference items:builtin:memory
    const memoryDataDir = join(dataDir, 'plugins', pluginDataDirName('builtin:memory'))
    mkdirSync(memoryDataDir, { recursive: true })
    writeFileSync(join(memoryDataDir, 'notes.md'), 'memory plugin data')

    const app = await makeEnvIn(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary, 'external plugin should by automatically register')
      assert.equal(summary.enabled, false, 'external plugin by default deactivate (most small permission)')
      assert.equal(summary.locked, false, 'external plugin cannot self seal locked')
      // inside placement memory data directory do not by mistakenly recognize (still only once builtin:memory)
      const memoryPlugins = app.kernel.plugins.list().filter((p) => p.id === 'builtin:memory')
      assert.equal(memoryPlugins.length, 1)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('external plugin enable after action / public doc / client.tsx compile all link available', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const app = await makeEnvIn(dataDir)
    try {
      await app.kernel.plugins.enable('demo-external')
      // action: reference schema validate + out reference schema validate + doc side effect
      const result = (await app.kernel.plugins.invokeAction('demo-external', 'bump', { step: 5 })) as { count: number }
      assert.equal(result.count, 5)
      // public doc snapshot visible
      const doc = app.kernel.plugins.getPublicDoc('demo-external', 'status')
      assert.deepEqual(doc.value, { count: 5 })
      // clientRoot by default points to plugin directory:client.tsx can compile out ESM artifact
      const client = await app.kernel.plugins.getClientModule('demo-external', 'client.tsx')
      assert.ok(client.code.length > 0)
      assert.match(client.code, /__helm_shared_react/)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json(main designate entry) external plugin by correct discover and register', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'manifest-plugin')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: 'src/entry.mjs' }))
    mkdirSync(join(dirPath, 'src'), { recursive: true })
    writeFileSync(
      join(dirPath, 'src', 'entry.mjs'),
      `export default {\n  id: 'manifest-plugin',\n  name: 'manifest plugin',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: 'back sound',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },\n      handler: () => ({ pong: true }),\n    })\n  },\n}\n`,
    )
    const app = await makeEnvIn(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'manifest-plugin')
      assert.ok(summary, 'plugin.json plugin should by automatically register')
      assert.equal(summary.enabled, false)
      await app.kernel.plugins.enable('manifest-plugin')
      const result = (await app.kernel.plugins.invokeAction('manifest-plugin', 'ping', {})) as { pong: boolean }
      assert.equal(result.pong, true)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// across restarts persist restore
// ---------------------------------------------------------------------------

test('pluginEnabled persist true external plugin across restarts auto-recovery enable', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const first = await makeEnvIn(dataDir)
    // explicit enable  pluginEnabled["demo-external"] = true
    await first.kernel.plugins.enable('demo-external')
    const persisted = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { pluginEnabled?: Record<string, boolean> }
    assert.equal(persisted.pluginEnabled?.['demo-external'], true)
    await first.close()

    // second start: persist true auto-recovery enable, no need to manually enable
    const second = await makeEnvIn(dataDir)
    try {
      const summary = second.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary, 'external plugin after restart still should by register')
      assert.equal(summary.enabled, true, 'persist true external plugin after restart automatically enable')
      // automatically enable after action directly can tune
      const result = (await second.kernel.plugins.invokeAction('demo-external', 'bump', { step: 2 })) as { count: number }
      assert.equal(result.count, 2)
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('pluginEnabled persist false external plugin after restart keep deactivate', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const first = await makeEnvIn(dataDir)
    await first.kernel.plugins.enable('demo-external')
    await first.kernel.plugins.disable('demo-external')
    await first.close()

    const second = await makeEnvIn(dataDir)
    try {
      const summary = second.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary)
      assert.equal(summary.enabled, false, 'persist false keep deactivate, do not back declaration default')
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// data directory static default skip
// ---------------------------------------------------------------------------

test('ordinary plugin under pure data directory (without plugin.json / convention entry) by static default ignore', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const pluginsDir = join(dataDir, 'plugins')
    // each pure data directory form: random data file, subdirectory, hide directory, empty directory
    const herdrDataDir = join(pluginsDir, pluginDataDirName('builtin:herdr'))
    mkdirSync(join(herdrDataDir, 'state'), { recursive: true })
    writeFileSync(join(herdrDataDir, 'state', 'cache.json'), '{}')
    mkdirSync(join(pluginsDir, 'some-plugin-data'), { recursive: true })
    writeFileSync(join(pluginsDir, 'some-plugin-data', 'MEMORY.md'), 'data only')
    mkdirSync(join(pluginsDir, '.hidden'), { recursive: true })
    writeFileSync(join(pluginsDir, '.hidden', 'index.mjs'), 'export default {}')
    mkdirSync(join(pluginsDir, 'empty-dir'), { recursive: true })

    const app = await makeEnvIn(dataDir)
    try {
      const ids = app.kernel.plugins.list().map((p) => p.id)
      assert.ok(!ids.includes('some-plugin-data'), 'pure data directory do not register')
      assert.ok(!ids.includes('.hidden'), 'hide directory does not participate discover')
      assert.ok(!ids.includes('empty-dir'), 'empty directory do not register')
      assert.ok(ids.includes('builtin:profile'), 'built-in plugin do not subject to affect')
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// explicit errors (honest discipline: never static default swallow wrong)
// ---------------------------------------------------------------------------

/**
 * assertion single directory fault by fall back register:createHelm normal start (do not reject), for should plugin in
 * plugins.list() in status: 'failed',enabled: false,error.code precise match.
 */
async function assertFailedRegistration(
  dataDir: string,
  expectedCode: string,
  messagePattern?: RegExp,
): Promise<void> {
  const app = await makeEnvIn(dataDir)
  try {
    const summary = app.kernel.plugins.list().find((p) => p.error !== undefined)
    assert.ok(summary, `fault plugin should by register is failed item:${JSON.stringify(app.kernel.plugins.list().map((p) => p.id))}`)
    assert.equal(summary.enabled, false, 'fault plugin keep deactivate')
    assert.equal(summary.status, 'failed')
    assert.equal(summary.error!.code, expectedCode)
    if (messagePattern !== undefined) assert.match(summary.error!.message, messagePattern)
  } finally {
    await app.close()
  }
}

test('corrupt plugin.json fall back register is failed, never static default skip also do not block assert start', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'broken-manifest')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '{ not valid json !!')
    writeFileSync(join(dirPath, 'index.mjs'), 'export default { id: "x", name: "x", definePlugin() {} }')

    await assertFailedRegistration(dataDir, 'plugin_manifest_invalid')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json is JSON array (non- object) fall back register is failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'array-manifest')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '[1, 2, 3]')
    writeFileSync(join(dirPath, 'index.mjs'), 'export default { id: "x", name: "x", definePlugin() {} }')

    await assertFailedRegistration(dataDir, 'plugin_manifest_invalid')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('smoke fill builtin: id external plugin fall back register is failed, never static default let through', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'fake-builtin')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'builtin:evil',\n  name: 'smoke fill inside placement',\n  async definePlugin() {},\n}\n`,
    )

    await assertFailedRegistration(dataDir, 'invalid_plugin_definition', /builtin:/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('contains smoke number id external plugin fall back register is failed(and managed plugin package id rule align)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'colon-plugin')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'vendor:plugin',\n  name: 'contains smoke number',\n  async definePlugin() {},\n}\n`,
    )

    await assertFailedRegistration(dataDir, 'invalid_plugin_definition', /smoke number/)
    // failed register must not is contains smoke number id create data directory (source directory i.e. ctx.dataDir invariant)
    assert.equal(existsSync(join(dataDir, 'plugins', 'vendor:plugin')), false)
    assert.equal(existsSync(join(dataDir, 'plugins', 'vendor%3Aplugin')), false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json main exceeds out plugin directory fall back register is failed(guard against path through exceeds)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const outside = mkdtempSync(join(tmpdir(), 'helm-ext-outside-'))
    try {
      writeFileSync(join(outside, 'evil.mjs'), 'export default { id: "evil", name: "evil", definePlugin() {} }')
      const dirPath = join(dataDir, 'plugins', 'traversal')
      mkdirSync(dirPath, { recursive: true })
      writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: '../../evil.mjs' }))

      await assertFailedRegistration(dataDir, 'plugin_manifest_invalid')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json declaration entry file missing fall back register is failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'missing-entry')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: 'ghost.mjs' }))

    await assertFailedRegistration(dataDir, 'plugin_entry_missing')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('entry symlink points to plugin directory outside: term method path do not out of bounds but real path out of bounds, fall back register is failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-outside-'))
  try {
    writeFileSync(join(outside, 'evil.mjs'), 'export default { id: "evil", name: "evil", definePlugin() {} }')
    const dirPath = join(dataDir, 'plugins', 'symlink-escape')
    mkdirSync(dirPath, { recursive: true })
    // term method in directory inside, real in directory outside (symlink escape)
    symlinkSync(join(outside, 'evil.mjs'), join(dirPath, 'entry.mjs'))
    writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: 'entry.mjs' }))

    await assertFailedRegistration(dataDir, 'plugin_manifest_invalid', /symlink/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('clientRoot non- string in boundary fall back register is failed(does not introduce fake sandbox promise)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'bad-client-root')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'bad-client-root',\n  name: 'illegal clientRoot',\n  clientRoot: 123,\n  definePlugin() {},\n}\n`,
    )

    await assertFailedRegistration(dataDir, 'invalid_plugin_definition', /clientRoot/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('without manifest convention entry same reject symlink out of bounds, fall back register is failed, do not import external module', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-convention-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'convention-escape')
    mkdirSync(dirPath, { recursive: true })
    const outside = join(dataDir, 'outside.mjs')
    writeFileSync(outside, 'throw new Error("outside_module_was_imported")')
    symlinkSync(outside, join(dirPath, 'index.mjs'))
    await assertFailedRegistration(dataDir, 'plugin_manifest_invalid')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('entry probe encounters real IO fault (ELOOP symlink ring) fall back register is failed, do not mistakenly judge is pure data directory (root user same takes effect)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'symlink-loop')
    mkdirSync(dirPath, { recursive: true })
    // self refer symlink ring:statSync throw ELOOP(real IO fault, non- missing),root/win all can trigger
    symlinkSync(join(dirPath, 'index.mjs'), join(dirPath, 'index.mjs'))

    await assertFailedRegistration(dataDir, 'plugin_scan_failed')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('not declaration clientRoot external plugin by default clientRoot is plugin directory itself', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const app = await makeEnvIn(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary, 'external plugin should by automatically register')
      await app.kernel.plugins.enable('demo-external')
      // clientRoot by default points to plugin directory (client.tsx compile can parse)
      const client = await app.kernel.plugins.getClientModule('demo-external', 'client.tsx')
      assert.ok(client.code.length > 0)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('only export setup alias (without definePlugin) fall back register is failed: items item explicit does not compatibility alias', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'setup-alias')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'setup-alias',\n  name: 'old form',\n  setup() {},\n}\n`,
    )

    await assertFailedRegistration(dataDir, 'invalid_plugin_definition', /definePlugin/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('module export without name: same inside placement contract register succeeded (render name back id), do not another add required constraint', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'no-name')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'no-name-plugin',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: 'back sound',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    const app = await makeEnvIn(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'no-name-plugin')
      assert.ok(summary, 'without name external plugin should can register (same protocol contract)')
      assert.equal(summary.name, 'no-name-plugin', 'render name back id(and built-in plugin same right)')
      await app.kernel.plugins.enable('no-name-plugin')
      const result = (await app.kernel.plugins.invokeAction('no-name-plugin', 'ping', {})) as { ok: boolean }
      assert.equal(result.ok, true)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('name provide but is empty string: fall back register is failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'empty-name')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'empty-name',\n  name: '',\n  definePlugin() {},\n}\n`,
    )
    await assertFailedRegistration(dataDir, 'invalid_plugin_definition', /name/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('module export since without definePlugin also without setup fall back register is failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'no-setup')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'index.mjs'), 'export default { id: "no-setup", name: "without entry" }')

    await assertFailedRegistration(dataDir, 'invalid_plugin_definition')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json declaration clientRoot: "./client"(module export not duplicate declaration when) automatically takes effect, can compile client/index.tsx', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'manifest-client-root')
    mkdirSync(join(dirPath, 'client'), { recursive: true })
    writeFileSync(
      join(dirPath, 'plugin.json'),
      JSON.stringify({ id: 'manifest-client-root', main: 'index.mjs', clientRoot: './client' }),
    )
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {
  id: 'manifest-client-root',
  definePlugin(ctx) {
    ctx.ui.screen({
      id: 'main',
      label: 'main screen',
      client: { module: 'index.tsx', export: 'MainScreen' },
    })
  },
}
`,
    )
    writeFileSync(
      join(dirPath, 'client', 'index.tsx'),
      `export function MainScreen() { return null }\n`,
    )
    const app = await makeEnvIn(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'manifest-client-root')
      assert.ok(summary, 'external plugin should by automatically register')
      await app.kernel.plugins.enable('manifest-client-root')
      const client = await app.kernel.plugins.getClientModule('manifest-client-root', 'index.tsx')
      assert.ok(client.code.length > 0)
      assert.ok(client.exports.includes('MainScreen'))
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// independent loader direct tune (do not via createHelm, verify return value and empty directory semantics)
// ---------------------------------------------------------------------------

test('loadExternalPlugins direct tune: return register id list;plugins directory missing return empty array', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // createHelm already consume once; for the same dataDir again direct tune (same id registered → explicit conflict)
    const dirPath = join(env.dataDir, 'plugins', 'direct-loader')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'direct-loader',\n  name: 'direct tune',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'noop',\n      description: 'empty operation',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    const registered = await loadExternalPlugins(env.dataDir, env.app.kernel.plugins)
    assert.ok(registered.includes('direct-loader'), `should register direct-loader, actual:${JSON.stringify(registered)}`)

    const summary = env.app.kernel.plugins.list().find((p) => p.id === 'direct-loader')
    assert.ok(summary)
    assert.equal(summary.enabled, false)

    // plugins directory whole missing → empty array (do not throws)
    const empty = mkdtempSync(join(tmpdir(), 'helm-ext-empty-'))
    try {
      const result = await loadExternalPlugins(empty, env.app.kernel.plugins)
      assert.deepEqual(result, [])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    await env.close()
  }
})
