/**
 * Dedicated tests for backend TypeScript plugin transpilation & loading (`backend-ts-loader` + `external-loader` TS entrypoints).
 *
 * Composition discipline: real `createHelm` (real SQLite + real `PluginHost` + real external plugin source dirs) +
 * faux provider; no mocked app or host. All fixtures use isolated temporary `dataDir`s.
 *
 * Covers:
 * - Convention `index.ts` and `plugin.json` `main` pointing to `.ts` / `.tsx`;
 * - Relative local TS dependencies (`.js` specifiers -> `.ts` files, extensionless, `index.ts`);
 * - Node built-in modules and third-party npm dependencies (`node_modules` inside plugin dir);
 * - `@helm/protocol` class identity matching the host (`HelmError instanceof` with zero duplicate bundle);
 * - `import.meta.url` asset resolution pointing to real plugin source files (not cache paths);
 * - Relative `.json` imports inside plugins (host-patched `type: 'json'`);
 * - Alias identity across `.js` mapping, explicit `.ts`, and symlinks;
 * - Syntax errors returning `plugin_load_failed` with file + line/column diagnostics;
 * - Single initialization per entry URL (module identity);
 * - Escape containment (isolated `dataDir` + reachable outside file + execution sentinels):
 *   `main` traversal, entry symlinks, dependency symlinks all reject without executing outside code;
 * - TS release: hooks deregister once all roots are released.
 *
 * Note: `app.close().catch(() => {})` avoids masking test assertions with a known built-in workflow
 * stop-window cleanup issue (`host.listConversations` guarded inside stop window).
 *
 * Runner: `tsx --test`; every test declares `{ timeout: 60_000 }`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { HelmError as HostHelmError } from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { loadExternalPlugins } from '../../kernel/src/plugins/external-loader.js'
import { registerPluginTsRoot } from '../../kernel/src/plugins/backend-ts-loader.js'
import { createHubTestApp } from './helpers/hub-test-env.js'

/** Type-safe access to test-process globals (module-init counters / escape execution sentinels). */
function globalFlag(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name]
}

async function createApp(dataDir: string) {
  // Composition root `createHelm` disables superagent by default, leaving no periodic timers to tear down.
  return (await createHubTestApp({ dataDir, cwd: dataDir })).app
}

/** Loader source path (loaded directly in pure Node child processes via native `--experimental-strip-types`). */
const loaderSrc = fileURLToPath(new URL('../../kernel/src/plugins/backend-ts-loader.ts', import.meta.url))

// ---------------------------------------------------------------------------
// Fixture writers
// ---------------------------------------------------------------------------

/**
 * TS backend plugin fixture: `index.ts` entrypoint + local TS deps + Node builtins + npm dep +
 * `@helm` host class identity + `import.meta.url` asset lookup + relative `.json` + init counter.
 */
function writeTsPlugin(pluginsDir: string, dir = 'ts-demo'): { dirPath: string; counterName: string } {
  // Per-directory init counter (isolated across fixtures, detects duplicate loads of the same dir).
  const counterName = `__init_${dir.replace(/[^A-Za-z0-9_]/g, '_')}`
  const dirPath = join(pluginsDir, dir)
  mkdirSync(join(dirPath, 'lib'), { recursive: true })
  mkdirSync(join(dirPath, 'assets'), { recursive: true })
  // Plugin-local npm dependency (real `type: "module"` ESM package).
  mkdirSync(join(dirPath, 'node_modules', 'demo-dep'), { recursive: true })
  writeFileSync(join(dirPath, 'node_modules', 'demo-dep', 'package.json'), JSON.stringify({ name: 'demo-dep', version: '1.0.0', type: 'module', main: 'index.js' }))
  writeFileSync(join(dirPath, 'node_modules', 'demo-dep', 'index.js'), 'export const depName = "demo-dep-ok"\n')

  // Entrypoint: convention `index.ts`.
  writeFileSync(
    join(dirPath, 'index.ts'),
    `import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { depName } from 'demo-dep'
import { HelmError } from '@helm/protocol'
import { addTen } from './lib/math.js'
import { greet } from './lib/greet'
import { shape } from './lib/shapes/index.js'
import cfg from './config.json'

declare global { var ${counterName}: number | undefined }
globalThis.${counterName} = (globalThis.${counterName} ?? 0) + 1
const mod = await import('./lib/lazy.ts')
const metaUrl = import.meta.url

async function definePlugin(ctx: any) {
  ctx.action({
    id: 'probe',
    description: 'transpile load all link probe needle',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      required: ['builtinOk', 'npmDep', 'hostClassSame', 'metaUrl', 'lazyValue', 'assetSha', 'addTen', 'greet', 'shape', 'jsonTag'],
      additionalProperties: false,
      properties: {
        builtinOk: { type: 'boolean' },
        npmDep: { type: 'string' },
        hostClassSame: { type: 'boolean' },
        metaUrl: { type: 'string' },
        lazyValue: { type: 'string' },
        assetSha: { type: 'string' },
        addTen: { type: 'number' },
        greet: { type: 'string' },
        shape: { type: 'string' },
        jsonTag: { type: 'string' },
      },
    },
    handler: () => {
      const assetPath = new URL('./assets/banner.txt', metaUrl)
      const asset = readFileSync(assetPath, 'utf8')
      return {
        builtinOk: createHash('sha256').update('x').digest('hex').length === 64,
        npmDep: depName,
        // Host identity: plugin constructor and host constructor share the exact same prototype chain.
        hostClassSame: Object.getPrototypeOf(HostHelmErrorPrototypeMarker) === HelmError.prototype,

        metaUrl,
        lazyValue: mod.lazyValue,
        assetSha: createHash('sha256').update(asset).digest('hex').slice(0, 8),
        addTen: addTen(32),
        greet: greet('helm'),
        shape: shape(),
        jsonTag: cfg.tag,
      }
    },
  })
}

// Placeholder for host identity check (rewritten below to compare against imported marker).
var HostHelmErrorPrototypeMarker: object


export default { id: '${dir}', name: 'TS demo plugin', version: '1.0.0', definePlugin }
`,
  )
  // `.js` specifier -> `.ts` file (standard TypeScript ESM import convention)
  writeFileSync(join(dirPath, 'lib', 'math.ts'), 'export function addTen(n: number): number {\n  return n + 10\n}\n')
  // Extensionless relative specifier
  writeFileSync(join(dirPath, 'lib', 'greet.ts'), 'export const greet = (who: string): string => `hi-${who}`\n')
  // Directory index: `./lib/shapes/index.js` -> `shapes/index.ts`
  mkdirSync(join(dirPath, 'lib', 'shapes'), { recursive: true })
  writeFileSync(join(dirPath, 'lib', 'shapes', 'index.ts'), 'export const shape = (): string => "circle"\n')
  // Dynamically imported TS dependency
  writeFileSync(join(dirPath, 'lib', 'lazy.ts'), 'export const lazyValue = "lazy-ok"\n')
  // Relative `.json` (host patches import attributes)
  writeFileSync(join(dirPath, 'config.json'), JSON.stringify({ tag: 'json-ok' }))
  // Asset resolved relative to `import.meta.url`
  writeFileSync(join(dirPath, 'assets', 'banner.txt'), 'helm-ts-plugin-asset\n')

  // Host class identity: marker module imports `HelmError` from `@helm/protocol` (resolved via host),
  // and entrypoint compares constructors/prototypes — any duplicate bundle would fail equality.
  const markerPath = join(dirPath, 'lib', 'host-marker.ts')
  writeFileSync(
    markerPath,
    "import { HelmError } from '@helm/protocol'\nexport const marker = new HelmError('marker', 'marker')\nexport const ctor = HelmError\n",
  )
  // Replace placeholder with explicit marker import comparison.
  const entryPathFile = join(dirPath, 'index.ts')
  const entry = readFileSync(entryPathFile, 'utf8')
  const patched = entry
    .replace(
      "import cfg from './config.json'",
      "import cfg from './config.json'\nimport { marker as hostMarker, ctor as hostCtor } from './lib/host-marker'",
    )
    .replace(
      'Object.getPrototypeOf(HostHelmErrorPrototypeMarker) === HelmError.prototype',
      'hostCtor === HelmError && Object.getPrototypeOf(hostMarker) === HelmError.prototype && hostMarker instanceof HelmError',
    )
  writeFileSync(entryPathFile, patched)
  return { dirPath, counterName }
}

/** Fixture with `plugin.json` `main` pointing to `.tsx` (pure-logic TSX without React JSX). */
function writeTsxManifestPlugin(pluginsDir: string): string {
  const dirPath = join(pluginsDir, 'tsx-manifest')
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: 'src/entry.tsx' }))
  mkdirSync(join(dirPath, 'src'), { recursive: true })
  writeFileSync(
    join(dirPath, 'src', 'entry.tsx'),
    `async function definePlugin(ctx: any) {
  ctx.action({
    id: 'ping',
    description: 'tsx entry probe needle',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object', required: ['pong'], additionalProperties: false, properties: { pong: { type: 'boolean' } } },
    handler: () => ({ pong: true }),
  })
}
export default { id: 'tsx-manifest', name: 'TSX manifest plugin', definePlugin }
`,
  )
  return dirPath
}

// ---------------------------------------------------------------------------
// End-to-end: real createHelm + fixtures + enable/disable
// ---------------------------------------------------------------------------

test('convention entry index.ts: TS deps / builtins / npm dep / @helm identity / json / import.meta.url asset work end-to-end', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const { counterName } = writeTsPlugin(join(dataDir, 'plugins'))
    const app = await createApp(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'ts-demo')
      assert.ok(summary, 'TS external plugin should auto-register')
      assert.equal(summary.enabled, false, 'disabled by default')
      await app.kernel.plugins.enable('ts-demo')

      const r = (await app.kernel.plugins.invokeAction('ts-demo', 'probe', {})) as Record<string, unknown>
      assert.equal(r.builtinOk, true, 'node:crypto / node:fs builtin modules work')
      assert.equal(r.npmDep, 'demo-dep-ok', 'plugin node_modules third-party npm dependency works')
      assert.equal(r.hostClassSame, true, '@helm/protocol shares constructor identity with host (no duplicate copy)')
      assert.equal(r.lazyValue, 'lazy-ok', 'runtime dynamic import of TS dependency works')
      assert.equal(r.addTen, 42, 'relative .js specifier maps to .ts file')
      assert.equal(r.greet, 'hi-helm', 'extensionless relative specifier resolves')
      assert.equal(r.shape, 'circle', 'directory index.ts resolves')
      assert.equal(r.jsonTag, 'json-ok', 'relative .json import works inside plugin (host-patched import attribute)')

      // `import.meta.url` points to real plugin source file (`file://` URL, no query noise, assets readable).
      const metaUrl = r.metaUrl as string
      assert.ok(metaUrl.startsWith('file://'), `import.meta.url should be a file URL: ${metaUrl}`)
      assert.ok(!metaUrl.includes('?'), `import.meta.url must not carry query params: ${metaUrl}`)
      const metaPath = fileURLToPath(metaUrl)
      assert.ok(metaPath.endsWith(join('ts-demo', 'index.ts')), `should point to plugin entrypoint source: ${metaPath}`)
      assert.equal(r.assetSha as string, '83877507', 'plugin asset read via import.meta.url matches expected hash')

      // Module identity: single initialization per URL in the process.
      assert.equal(globalFlag(counterName), 1, 'plugin entry module initializes only once')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json main pointing to .tsx entrypoint transpiles and loads (pure-logic tsx)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    writeTsxManifestPlugin(join(dataDir, 'plugins'))
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('tsx-manifest')
      const r = (await app.kernel.plugins.invokeAction('tsx-manifest', 'ping', {})) as { pong: boolean }
      assert.equal(r.pong, true)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('alias identity: importing the same dependency via .js mapping, explicit .ts, and symlink yields one module instance', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-alias-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'alias')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    // Real dep + internal symlink: three import paths (`.js` mapping / explicit `.ts` / symlink).
    writeFileSync(
      join(dirPath, 'lib', 'shared.ts'),
      `declare global { var __aliasInit: number | undefined }
globalThis.__aliasInit = (globalThis.__aliasInit ?? 0) + 1
export const tag = 'shared'
`,
    )
    symlinkSync(join(dirPath, 'lib', 'shared.ts'), join(dirPath, 'lib', 'alias.ts'))
    writeFileSync(
      join(dirPath, 'index.ts'),
      `import { tag as viaJs } from './lib/shared.js'
import { tag as viaTs } from './lib/shared.ts'
import { tag as viaSymlink } from './lib/alias.js'
export default {
  id: 'alias',
  definePlugin(ctx: any) {
    ctx.action({
      id: 'tags',
      description: 'alias identity probe needle',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['viaJs', 'viaTs', 'viaSymlink'], additionalProperties: false, properties: { viaJs: { type: 'string' }, viaTs: { type: 'string' }, viaSymlink: { type: 'string' } } },
      handler: () => ({ viaJs, viaTs, viaSymlink }),
    })
  },
}
`,
    )
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('alias')
      // All three specifiers resolve to the same module instance (init counter increments once).
      assert.equal(globalFlag('__aliasInit'), 1, '.js mapping / explicit .ts / symlink must resolve to one module instance')
      const r = (await app.kernel.plugins.invokeAction('alias', 'tags', {})) as Record<string, string>
      assert.equal(r.viaJs, 'shared')
      assert.equal(r.viaTs, 'shared')
      assert.equal(r.viaSymlink, 'shared')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS entrypoint syntax error registers as failed with file and line/column diagnostics', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'broken-ts')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'index.ts'), 'export function f(: string {\n  return 1\n}\n')
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, 'plugin with syntax error should register as failed')
      assert.equal(failed.error!.code, 'plugin_load_failed')
      assert.ok(failed.error!.message.includes('broken-ts/index.ts'), `diagnostic should include source path: ${failed.error!.message}`)
      assert.ok(/:\d+:\d+/.test(failed.error!.message), `diagnostic should include line:column: ${failed.error!.message}`)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS dependency syntax error likewise registers as failed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'broken-dep')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    writeFileSync(join(dirPath, 'index.ts'), "import { x } from './lib/bad.js'\nexport default { id: 'broken-dep', tag: x, definePlugin() {} }\n")
    writeFileSync(join(dirPath, 'lib', 'bad.ts'), 'export const x = {{{\n')
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed)
      assert.equal(failed.error!.code, 'plugin_load_failed')
      assert.ok(failed.error!.message.includes('lib/bad.ts'))
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Escape containment: isolated dataDir + reachable outside file + execution sentinel per scenario
// ---------------------------------------------------------------------------

/** Creates a reachable outside directory and `evil.ts` (flips sentinel if imported) and returns its path. */
function makeOutsideEvil(sentinel: string): string {
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-out-'))
  const evil = join(outside, 'evil.ts')
  writeFileSync(evil, `globalThis.${sentinel} = (globalThis.${sentinel} ?? 0) + 1\nexport default { id: 'evil', definePlugin() {} }\n`)
  return evil
}

test('containment 1: plugin.json main path traversal outside plugin dir fails without executing evil.ts', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc1-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'traversal')
    mkdirSync(dirPath, { recursive: true })
    // Place outside target in `dataDir` (writable in non-root CI environments; outside plugin root).
    // `main: '../../evil.ts'` resolves relative to plugin dir to `dataDir/evil.ts`.
    const reachable = join(dataDir, 'evil.ts')
    writeFileSync(reachable, `globalThis.__escMainSentinel = (globalThis.__escMainSentinel ?? 0) + 1\nexport default { id: 'evil', definePlugin() {} }\n`)
    writeFileSync(dirPath + '/plugin.json', JSON.stringify({ main: '../../evil.ts' }))
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed)
      assert.equal(failed.error!.code, 'plugin_manifest_invalid')
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escMainSentinel'), undefined, 'main traversal must be rejected without executing evil source')
    rmSync(reachable, { force: true })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('containment 2: convention entrypoint symlink pointing outside to real .ts rejects without executing', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc2-'))
  const evil = makeOutsideEvil('__escEntrySentinel')
  try {
    const dirPath = join(dataDir, 'plugins', 'entry-symlink')
    mkdirSync(dirPath, { recursive: true })
    // Lexically inside, realpath outside (symlink escape), target exists on disk.
    symlinkSync(evil, join(dirPath, 'index.ts'))
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, 'should register failed entry instead of passing')
      assert.ok(
        failed.error!.code === 'plugin_manifest_invalid' || failed.error!.code === 'plugin_load_failed',
        `entry symlink escape should reject explicitly, got: ${failed.error!.code}`,
      )
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escEntrySentinel'), undefined, 'entry symlink escape must never execute evil source')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(evil, { force: true })
  }
})

test('containment 3: internal dependency symlink pointing outside to real .ts rejects transpilation without executing', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc3-'))
  const evil = makeOutsideEvil('__escDepSentinel')
  try {
    const dirPath = join(dataDir, 'plugins', 'dep-symlink')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    // Valid entry + lexically internal dep whose symlink points outside to `evil.ts`.
    symlinkSync(evil, join(dirPath, 'lib', 'helper.ts'))
    writeFileSync(
      join(dirPath, 'index.ts'),
      `import { x } from './lib/helper.js'
export default { id: 'dep-symlink', tag: x, definePlugin() {} }
`,
    )
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, 'should register failed entry')
      assert.equal(failed.error!.code, 'plugin_load_failed', 'outside symlink dependency must not be transpiled')
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escDepSentinel'), undefined, 'dependency symlink escape must never execute evil source')
    rmSync(evil, { force: true })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(join(tmpdir(), 'helm-ext-out-'), { recursive: true, force: true })
  }
})

test('containment 4: .js-family fallback mapping to outside real .ts rejects transpilation without executing', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc4-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dotdot')
    mkdirSync(dirPath, { recursive: true })
    // `../../evil.js` from `plugins/dotdot/` maps to `dataDir/evil.ts` (exists outside plugin dir).
    writeFileSync(
      join(dataDir, 'evil.ts'),
      "globalThis.__escDotdotSentinel = (globalThis.__escDotdotSentinel ?? 0) + 1\nexport const x = 'evil'\n",
    )
    writeFileSync(
      join(dirPath, 'index.ts'),
      `import { x } from '../../evil.js'
export default { id: 'dotdot', tag: x, definePlugin() {} }
`,
    )
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, 'should register failed entry')
      // Fallback `.js` mapping to outside `.ts`: rejects transpilation with `plugin_load_failed`.
      assert.equal(failed.error!.code, 'plugin_load_failed')
      assert.ok(failed.error!.message.includes('reject transpile'), `diagnostic should note rejection reason: ${failed.error!.message}`)
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escDotdotSentinel'), undefined, 'fallback escape mapping must never execute outside code')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Module identity and lifecycle
// ---------------------------------------------------------------------------

test('module identity: static and dynamic imports of the same plugin dependency initialize only once', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'identity')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    writeFileSync(
      join(dirPath, 'lib', 'shared.ts'),
      `declare global { var __identityInit: number | undefined }
globalThis.__identityInit = (globalThis.__identityInit ?? 0) + 1
export const tag = 'shared'
`,
    )
    writeFileSync(
      join(dirPath, 'index.ts'),
      `import { tag as a } from './lib/shared.js'
const lazy = await import('./lib/shared.js')
export default {
  id: 'identity',
  definePlugin(ctx: any) {
    ctx.action({
      id: 'tags',
      description: 'identity probe needle',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['a', 'b'], additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'string' } } },
      handler: () => ({ a, b: lazy.tag }),
    })
  },
}
`,
    )
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('identity')
      assert.equal(globalFlag('__identityInit'), 1, 'static and dynamic imports point to the same module instance')
      const r = (await app.kernel.plugins.invokeAction('identity', 'tags', {})) as { a: string; b: string }
      assert.equal(r.a, 'shared')
      assert.equal(r.b, 'shared')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS release and fallback mapping (pure Node child process): mappings work while registered, disappear after release, escapes reject', { timeout: 60_000 }, async () => {
  const dirPath = mkdtempSync(join(tmpdir(), 'helm-ext-rootrel-'))
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-rootout-'))
  try {
    // Fixture: internal mapped.ts, extensionless greet.ts, symlink alias.ts; outside evil.ts (escape target).
    writeFileSync(join(dirPath, 'mapped.ts'), 'export const v = 42\n')
    writeFileSync(join(dirPath, 'greet.ts'), 'export const g = 7\n')
    symlinkSync(join(dirPath, 'mapped.ts'), join(dirPath, 'alias.ts'))
    writeFileSync(join(outside, 'evil.ts'), "globalThis.__childEvil = (globalThis.__childEvil ?? 0) + 1\nexport const e = 'evil'\n")
    writeFileSync(
      join(dirPath, 'entry.ts'),
      "import { v } from './mapped.js'\nimport { g } from './greet'\nimport { v as viaAlias } from './alias.js'\nexport const w = v + g\nexport const a = viaAlias\n",
    )
    // `escape.ts` fallback-escape specifier: points from plugin dir to `outside/evil.ts`
    // (computed dynamically via `relative` with `.ts` replaced by `.js` to trigger fallback).
    const escapeSpec = relative(dirPath, join(outside, 'evil.ts')).split(sep).join('/').replace(/evil\.ts$/, 'evil.js')
    writeFileSync(
      join(dirPath, 'escape.ts'),
      `import { e } from '${escapeSpec}'\nexport const t = e\n`,
    )
    // Pure Node child process (no tsx) verifies true production loader runtime:
    // 1) `.js` mapping, extensionless, and symlink alias load while registered;
    // 2) fallback escape (`../evil.js` -> outside `evil.ts`) rejects without flipping sentinel;
    // 3) after releasing all roots, `.js` mapping disappears (`ERR_MODULE_NOT_FOUND`).
    const providerUrl = import.meta.resolve('@helm/plugin-build')
const childSrc = `
const { registerPluginTsRoot } = await import(${JSON.stringify(pathToFileURL(loaderSrc).href)});
const { createPluginBuildProvider } = await import(${JSON.stringify(providerUrl)});
const root = ${JSON.stringify(dirPath)};
const release = registerPluginTsRoot(root, { transform: createPluginBuildProvider().transformBackendTs });
const entry = await import('file://' + root + '/entry.ts');
if (entry.w !== 49 || entry.a !== 42) { console.log('FAIL mapping ' + entry.w + '/' + entry.a); process.exit(1); }
try {
  await import('file://' + root + '/escape.ts');
  console.log('FAIL escape-loaded'); process.exit(1);
} catch (e) {
  if (e.code !== 'plugin_load_failed') { console.log('FAIL escape-code ' + e.code); process.exit(1); }
}
if (globalThis.__childEvil !== undefined) { console.log('FAIL evil-executed'); process.exit(1); }
release();
try {
  await import('file://' + root + '/entry.ts?after');
  console.log('FAIL still-loads-after-release'); process.exit(1);
} catch (e) {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') { console.log('FAIL after-code ' + e.code); process.exit(1); }
}
console.log('CHILD_OK');
`
    const childPath = join(dirPath, 'child.mjs')
    writeFileSync(childPath, childSrc)
    let result: string
    try {
      result = execFileSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 30_000 })
    } catch (e) {
      const out = ((e as { stdout?: string }).stdout ?? '') + '\n' + ((e as { stderr?: string }).stderr ?? '')
      assert.fail(`pure Node child process failed: ${out.slice(0, 800)}`)
    }
    assert.ok(result.includes('CHILD_OK'), `pure Node child process should pass all checks, output: ${result}`)
  } finally {
    rmSync(dirPath, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('registerPluginTsRoot reference counting: merges duplicate registrations and allows re-registration after reaching zero', { timeout: 60_000 }, async () => {
  const dirPath = mkdtempSync(join(tmpdir(), 'helm-ext-root-'))
  try {
    writeFileSync(join(dirPath, 'still.ts'), 'export const v = 1\n')
    const transform = createPluginBuildProvider().transformBackendTs
    const release1 = registerPluginTsRoot(dirPath, { transform })
    const release2 = registerPluginTsRoot(dirPath, { transform })
    release1()
    // Refcount > 0: directory remains in transpilation scope (`.js -> .ts` still resolves).
    const m = (await import(`file://${join(dirPath, 'still.js')}`)) as { v: number }
    assert.equal(m.v, 1, 'transpilation scope remains active while refcount > 0')
    release2()
    // Reached zero: can re-register cleanly (lazy hook re-registration cycle).
    const release3 = registerPluginTsRoot(dirPath, { transform })
    release3()
  } finally {
    rmSync(dirPath, { recursive: true, force: true })
  }
})

test('TS plugin can re-enable after disable without unloading or re-initializing modules', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const { counterName } = writeTsPlugin(join(dataDir, 'plugins'), 'ts-cycle')
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('ts-cycle')
      await app.kernel.plugins.disable('ts-cycle')
      await app.kernel.plugins.enable('ts-cycle')
      const r = (await app.kernel.plugins.invokeAction('ts-cycle', 'probe', {})) as { builtinOk: boolean }
      assert.equal(r.builtinOk, true)
      assert.equal(globalFlag(counterName), 1, 'enable/disable cycle does not re-execute module initialization')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS root releases on ID conflict failure: directory can reload after fixing its ID', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-rel-'))
  try {
    // First register a plugin with `id: 'dup'` via `createHelm`.
    const first = join(dataDir, 'plugins', 'first')
    mkdirSync(first, { recursive: true })
    writeFileSync(join(first, 'index.ts'), `export default { id: 'dup', definePlugin() {} }\n`)
    const app = await createApp(dataDir)
    try {
      // Second directory with colliding ID registers as failed and releases its TS root so it can reload once fixed.
      const second = join(dataDir, 'plugins', 'second')
      mkdirSync(second, { recursive: true })
      writeFileSync(join(second, 'index.ts'), `export default { id: 'dup', definePlugin() {} }\n`)
      const registered0 = await loadExternalPlugins(dataDir, app.kernel.plugins)
      assert.ok(!registered0.includes('dup'), 'conflicting directory must not register successfully')
      const conflicted = app.kernel.plugins.list().find((p) => p.id !== 'dup' && p.error !== undefined)
      assert.ok(conflicted, 'ID conflict should register as a failed entry')
      assert.equal(conflicted.error!.code, 'plugin_already_registered')
      // Turn `first` into a plain data dir so the next scan only probes `second` and verifies clean recovery.
      rmSync(join(first, 'index.ts'))
      // Changing ID lets the same directory reload cleanly without stale transpilation pollution.
      writeFileSync(join(second, 'index.ts'), `export default { id: 'second-fixed', definePlugin(ctx: any) {
        ctx.action({ id: 'ok', description: 'ok', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } }, handler: () => ({ ok: true }) })
      } }\n`)
      const registered = await loadExternalPlugins(dataDir, app.kernel.plugins)
      assert.ok(registered.includes('second-fixed'), `should register successfully after changing ID: ${JSON.stringify(registered)}`)
      await app.kernel.plugins.enable('second-fixed')
      const r = (await app.kernel.plugins.invokeAction('second-fixed', 'ok', {})) as { ok: boolean }
      assert.equal(r.ok, true)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('loadExternalPlugins direct call loads TS plugin disabled by default', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    // Start with empty plugins dir, then add a TS plugin and call `loadExternalPlugins` directly.
    const app = await createApp(dataDir)
    try {
      const extra = join(dataDir, 'plugins', 'ts-extra')
      mkdirSync(extra, { recursive: true })
      writeFileSync(
        join(extra, 'index.ts'),
        `export default {
  id: 'ts-extra',
  definePlugin(ctx: any) {
    ctx.action({
      id: 'ok',
      description: 'ok probe needle',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      handler: () => ({ ok: true }),
    })
  },
}
`,
      )
      const registered = await loadExternalPlugins(dataDir, app.kernel.plugins)
      assert.ok(registered.includes('ts-extra'), `direct scan should register newly added ts-extra: ${JSON.stringify(registered)}`)
      const summary = app.kernel.plugins.list().find((p) => p.id === 'ts-extra')
      assert.ok(summary)
      assert.equal(summary.enabled, false)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('transpilation writes no intermediate artifacts to disk', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const { dirPath } = writeTsPlugin(join(dataDir, 'plugins'), 'ts-clean')
    const before = new Set(readdirSync(dirPath))
    const app = await createApp(dataDir)
    try {
      await app.kernel.plugins.enable('ts-clean')
      await app.kernel.plugins.invokeAction('ts-clean', 'probe', {})
      const after = new Set(readdirSync(dirPath))
      const added = [...after].filter((f) => !before.has(f))
      assert.deepEqual(added, [], `plugin directory must not gain transpiled artifacts or caches: added ${JSON.stringify(added)}`)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
