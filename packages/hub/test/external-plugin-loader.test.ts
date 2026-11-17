/**
 * Dedicated tests for auto-discovery and dynamic loading of external plugins under `<dataDir>/plugins/<dir>/`.
 *
 * Composition discipline: real `createHelm` (real SQLite + real `PluginHost` + real assistant) +
 * faux provider + real `.mjs` external plugin entrypoints on disk; no mocking of app or host.
 *
 * Covers:
 * - Convention entrypoints (`index.mjs`) and `plugin.json` (`main`-designated entrypoints);
 * - External plugins register disabled by default; once enabled, actions / public docs / `client.tsx` compilation all work;
 * - External plugins with persisted `config.json.pluginEnabled = true` auto-enable across restarts;
 * - Plain plugin data directories (without `plugin.json` / `index.js`) are skipped by default;
 * - Corrupt `plugin.json` / spoofed `builtin:` ID / out-of-bounds `main` (including symlink realpath escapes) /
 *   legacy `setup` alias / non-string `clientRoot` fail explicitly instead of being swallowed;
 * - Real I/O errors such as `EACCES` fail explicitly rather than being mistaken for plain data directories; only `ENOENT`/`ENOTDIR` count as missing.
 *
 * Runner: `tsx --test`; every test declares `{ timeout: 60_000 }` against deadlocks.
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
// Test fixtures
// ---------------------------------------------------------------------------

/** Convention-entrypoint external plugin source (`index.mjs` + `client.tsx` + action + public doc). */
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

/** Starts `createHelm` against `dataDir` (used by discovery failure assertions). */
async function makeEnvIn(dataDir: string): Promise<HubTestApp> {
  return (await createHubTestApp({ dataDir, cwd: dataDir })).app
}

/** Writes a convention-entrypoint external plugin directory. */
function writeConventionPlugin(pluginsDir: string, dir = 'demo-external'): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'index.mjs'), CONVENTION_PLUGIN_SRC)
  writeFileSync(join(dirPath, 'client.tsx'), CONVENTION_CLIENT_TSX)
  return dirPath
}

/** Persists `pluginEnabled.<id> = value` into `<dataDir>/config.json`. */
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
// Auto-discovery and registration
// ---------------------------------------------------------------------------

test('convention entrypoint index.mjs is auto-discovered at createHelm startup and registered disabled by default', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    // Pre-populate external plugin directory before `createHelm` (simulating manual user placement).
    writeConventionPlugin(join(dataDir, 'plugins'))
    // Also pre-populate a built-in plugin data dir as distractor: `builtin:memory`.
    const memoryDataDir = join(dataDir, 'plugins', pluginDataDirName('builtin:memory'))
    mkdirSync(memoryDataDir, { recursive: true })
    writeFileSync(join(memoryDataDir, 'notes.md'), 'memory plugin data')

    const app = await makeEnvIn(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary, 'external plugin should be auto-registered')
      assert.equal(summary.enabled, false, 'external plugins default to disabled (least privilege)')
      assert.equal(summary.locked, false, 'external plugins cannot mark themselves locked')
      // Built-in memory data directory must not be misidentified as an external plugin.
      const memoryPlugins = app.kernel.plugins.list().filter((p) => p.id === 'builtin:memory')
      assert.equal(memoryPlugins.length, 1)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('enabled external plugin exposes working action, public doc, and client.tsx compilation', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const app = await makeEnvIn(dataDir)
    try {
      await app.kernel.plugins.enable('demo-external')
      // Action: input schema validation + output schema validation + doc side effect.
      const result = (await app.kernel.plugins.invokeAction('demo-external', 'bump', { step: 5 })) as { count: number }
      assert.equal(result.count, 5)
      // Public doc snapshot visible.
      const doc = app.kernel.plugins.getPublicDoc('demo-external', 'status')
      assert.deepEqual(doc.value, { count: 5 })
      // `clientRoot` defaults to plugin directory: `client.tsx` compiles to ESM output.
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

test('plugin.json (main-designated entrypoint) external plugin is discovered and registered', { timeout: 60_000 }, async () => {
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
      assert.ok(summary, 'plugin.json plugin should be auto-registered')
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
// Cross-restart persistence restoration
// ---------------------------------------------------------------------------

test('external plugin with persisted pluginEnabled=true auto-enables across restarts', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const first = await makeEnvIn(dataDir)
    // Explicitly enable -> persists `pluginEnabled["demo-external"] = true`.
    await first.kernel.plugins.enable('demo-external')
    const persisted = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { pluginEnabled?: Record<string, boolean> }
    assert.equal(persisted.pluginEnabled?.['demo-external'], true)
    await first.close()

    // Second startup: persisted true auto-enables without manual enable call.
    const second = await makeEnvIn(dataDir)
    try {
      const summary = second.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary, 'external plugin should still be registered after restart')
      assert.equal(summary.enabled, true, 'external plugin with persisted true should auto-enable after restart')
      // Action is immediately invocable after auto-enable.
      const result = (await second.kernel.plugins.invokeAction('demo-external', 'bump', { step: 2 })) as { count: number }
      assert.equal(result.count, 2)
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('external plugin with persisted pluginEnabled=false remains disabled after restart', { timeout: 60_000 }, async () => {
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
      assert.equal(summary.enabled, false, 'persisted false stays disabled rather than reverting to declaration default')
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Plain data directories skipped silently
// ---------------------------------------------------------------------------

test('plain plugin data directories (no plugin.json or convention entrypoint) are silently ignored', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const pluginsDir = join(dataDir, 'plugins')
    // Various plain data directory shapes: arbitrary data files, subdirectories, hidden dirs, empty dirs.
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
      assert.ok(!ids.includes('some-plugin-data'), 'plain data dir should not be registered')
      assert.ok(!ids.includes('.hidden'), 'hidden dir should not participate in discovery')
      assert.ok(!ids.includes('empty-dir'), 'empty dir should not be registered')
      assert.ok(ids.includes('builtin:profile'), 'built-in plugins remain unaffected')
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Explicit errors (honesty discipline: never silently swallow faults)
// ---------------------------------------------------------------------------

/**
 * Asserts single-directory fault fallback registration: `createHelm` starts normally (never rejects),
 * and the broken plugin appears in `plugins.list()` with `status: 'failed'`, `enabled: false`, and matching `error.code`.
 */
async function assertFailedRegistration(
  dataDir: string,
  expectedCode: string,
  messagePattern?: RegExp,
): Promise<void> {
  const app = await makeEnvIn(dataDir)
  try {
    const summary = app.kernel.plugins.list().find((p) => p.error !== undefined)
    assert.ok(summary, `faulty plugin should register as failed entry: ${JSON.stringify(app.kernel.plugins.list().map((p) => p.id))}`)
    assert.equal(summary.enabled, false, 'faulty plugin stays disabled')
    assert.equal(summary.status, 'failed')
    assert.equal(summary.error!.code, expectedCode)
    if (messagePattern !== undefined) assert.match(summary.error!.message, messagePattern)
  } finally {
    await app.close()
  }
}

test('corrupt plugin.json registers as failed without silently skipping or blocking startup', { timeout: 60_000 }, async () => {
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

test('plugin.json as JSON array (non-object) registers as failed', { timeout: 60_000 }, async () => {
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

test('external plugin spoofing builtin: id registers as failed instead of passing through', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'fake-builtin')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'builtin:evil',\n  name: 'spoofed built-in',\n  async definePlugin() {},\n}\n`,
    )

    await assertFailedRegistration(dataDir, 'invalid_plugin_definition', /builtin:/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('external plugin with colon in id registers as failed (aligned with managed plugin package id rules)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'colon-plugin')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'vendor:plugin',\n  name: 'contains smoke number',\n  async definePlugin() {},\n}\n`,
    )

    await assertFailedRegistration(dataDir, 'invalid_plugin_definition', /smoke number/)
    // Failed registration must not create a data directory for the colon-bearing ID (`ctx.dataDir` invariant).
    assert.equal(existsSync(join(dataDir, 'plugins', 'vendor:plugin')), false)
    assert.equal(existsSync(join(dataDir, 'plugins', 'vendor%3Aplugin')), false)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json main escaping plugin directory registers as failed (guards against path traversal)', { timeout: 60_000 }, async () => {
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

test('missing entrypoint declared in plugin.json registers as failed', { timeout: 60_000 }, async () => {
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

test('entrypoint symlink pointing outside plugin directory registers as failed on realpath escape', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-outside-'))
  try {
    writeFileSync(join(outside, 'evil.mjs'), 'export default { id: "evil", name: "evil", definePlugin() {} }')
    const dirPath = join(dataDir, 'plugins', 'symlink-escape')
    mkdirSync(dirPath, { recursive: true })
    // Lexically inside the dir, realpath outside (symlink escape).
    symlinkSync(join(outside, 'evil.mjs'), join(dirPath, 'entry.mjs'))
    writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: 'entry.mjs' }))

    await assertFailedRegistration(dataDir, 'plugin_manifest_invalid', /symlink/)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('non-string clientRoot registers as failed at boundary (without introducing fake sandbox promises)', { timeout: 60_000 }, async () => {
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

test('convention entrypoint without manifest rejects symlink escape without importing external module', { timeout: 60_000 }, async () => {
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

test('entrypoint probe encountering real I/O fault (ELOOP symlink cycle) registers as failed instead of plain data dir', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'symlink-loop')
    mkdirSync(dirPath, { recursive: true })
    // Self-referential symlink cycle: statSync throws ELOOP (real I/O fault, works even as root/Windows).
    symlinkSync(join(dirPath, 'index.mjs'), join(dirPath, 'index.mjs'))

    await assertFailedRegistration(dataDir, 'plugin_scan_failed')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('external plugin omitting clientRoot defaults clientRoot to the plugin directory itself', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const app = await makeEnvIn(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary, 'external plugin should be auto-registered')
      await app.kernel.plugins.enable('demo-external')
      // `clientRoot` defaults to plugin directory so `client.tsx` compiles.
      const client = await app.kernel.plugins.getClientModule('demo-external', 'client.tsx')
      assert.ok(client.code.length > 0)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('exporting only legacy setup alias (no definePlugin) registers as failed (no alias fallback)', { timeout: 60_000 }, async () => {
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

test('module export without name registers per protocol contract (falls back to id for display name)', { timeout: 60_000 }, async () => {
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
      assert.ok(summary, 'external plugin without name should still register per protocol contract')
      assert.equal(summary.name, 'no-name-plugin', 'display name falls back to id (matching built-in plugins)')
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

test('empty string name registers as failed', { timeout: 60_000 }, async () => {
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

test('module export with neither definePlugin nor setup registers as failed', { timeout: 60_000 }, async () => {
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

test('plugin.json clientRoot "./client" takes effect automatically when omitted from module export', { timeout: 60_000 }, async () => {
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
      assert.ok(summary, 'external plugin should be auto-registered')
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
// Standalone loader direct call (bypasses createHelm; verifies return value and missing dir behavior)
// ---------------------------------------------------------------------------

test('loadExternalPlugins direct call returns registered IDs and returns [] when plugins dir is missing', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // createHelm already ran once; register a distinct dir under the same dataDir to avoid ID collision.
    const dirPath = join(env.dataDir, 'plugins', 'direct-loader')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'direct-loader',\n  name: 'direct tune',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'noop',\n      description: 'empty operation',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    const registered = await loadExternalPlugins(env.dataDir, env.app.kernel.plugins)
    assert.ok(registered.includes('direct-loader'), `should register direct-loader, got: ${JSON.stringify(registered)}`)

    const summary = env.app.kernel.plugins.list().find((p) => p.id === 'direct-loader')
    assert.ok(summary)
    assert.equal(summary.enabled, false)

    // Missing `plugins` directory returns `[]` without throwing.
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
