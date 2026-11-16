/**
 * backend plugin TS transpile load dedicated items test (backend-ts-loader + external-loader TS entry).
 *
 * combine discipline: real createHelm(true SQLite + true PluginHost + true external plugin source file directory)+
 * faux provider; do not mock app, do not fake host.fixture all in temporary development dataDir
 * (tmpdir under independent prefix, never trigger touch old system data directory).
 *
 * override (want seek true verify items):
 * - convention entry index.ts and plugin.json main points to .ts / .tsx discover and transpile load;
 * - each other for local TS dependency closed package (.js note symbol -> .ts file, without extension,index.ts);
 * - Node inside placement module import and third way npm dependency (plugin directory node_modules true package);
 * - @helm/protocol and host the same construct (plugin inside gets HelmError is exactly test process
 *   directly import that construct, without second module);
 * - import.meta.url asset path points to plugin real source file (do not because cache path drift);
 * - plugin inside each other for .json import (host patch note type=json);
 * - the same dependency via .js mapping and explicit .ts two note symbol import is the same module instance (alias identity);
 * - language method error explicit plugin_load_failed(contains file and row column number diagnose);
 * - the same plugin entry many time reference only initialize once (module identity);
 * - exceeds contract (each scenario independent dataDir + real can reach outside file + execute sentinel):
 *   main through exceeds, entry symlink, dependency symlink all reject; outside code do not transpile;
 * - TS release: all release after process hook reverse register (after continue outside/inside .ts no longer by this load transpile).
 *
 * note:app.close() swallow wrong - - inside placement workflow stop chain store in known base seat defect (subject to control stop window
 * inside host.listConversations guard reject leads to plugin_dispose_failed), do not mask this file
 * assertion; base seat fix after can restore bare await.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock; command add total timeout.
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

/** test process global side table (plugin module level initialize counter / exceeds execute sentinel) type security access. */
function globalFlag(name: string): unknown {
  return (globalThis as Record<string, unknown>)[name]
}

async function createApp(dataDir: string) {
  // note:watchdogIntervalMs option already follow kernel set when inspection hand off builtin:superagent remove;
  // combine layer createHelm by default enable superagent=false, without cron job need to close.
  return (await createHubTestApp({ dataDir, cwd: dataDir })).app
}

/** this load source code path (pure node child process directly load: only use can erase language method, original generate strip-types can read). */
const loaderSrc = fileURLToPath(new URL('../../kernel/src/plugins/backend-ts-loader.ts', import.meta.url))

// ---------------------------------------------------------------------------
// fixture write tool
// ---------------------------------------------------------------------------

/**
 * TS backend plugin fixture: entry index.ts + local TS dependency closed package + Node inside placement + npm dependency +
 * @helm construct the same + import.meta.url asset locate + each other for .json + module level initialize counter.
 */
function writeTsPlugin(pluginsDir: string, dir = 'ts-demo'): { dirPath: string; counterName: string } {
  // module level initialize counter by plugin directory isolated (multiple fixture mutual do not interference, but same directory duplicate load can detect)
  const counterName = `__init_${dir.replace(/[^A-Za-z0-9_]/g, '_')}`
  const dirPath = join(pluginsDir, dir)
  mkdirSync(join(dirPath, 'lib'), { recursive: true })
  mkdirSync(join(dirPath, 'assets'), { recursive: true })
  // plugin local npm dependency (true package form:type:module + ESM entry)
  mkdirSync(join(dirPath, 'node_modules', 'demo-dep'), { recursive: true })
  writeFileSync(join(dirPath, 'node_modules', 'demo-dep', 'package.json'), JSON.stringify({ name: 'demo-dep', version: '1.0.0', type: 'module', main: 'index.js' }))
  writeFileSync(join(dirPath, 'node_modules', 'demo-dep', 'index.js'), 'export const depName = "demo-dep-ok"\n')

  // entry: convention index.ts
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
        // host the same: plugin gets construct and host register instance sharing the same construct/prototype chain
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

// host the same construct mark record occupy (by fixture write logic replace is real compare)
var HostHelmErrorPrototypeMarker: object


export default { id: '${dir}', name: 'TS demo plugin', version: '1.0.0', definePlugin }
`,
  )
  // .js note symbol -> .ts file (TS habit mapping)
  writeFileSync(join(dirPath, 'lib', 'math.ts'), 'export function addTen(n: number): number {\n  return n + 10\n}\n')
  // without extension note symbol
  writeFileSync(join(dirPath, 'lib', 'greet.ts'), 'export const greet = (who: string): string => `hi-${who}`\n')
  // directory index:./lib/shapes/index.js -> shapes/index.ts
  mkdirSync(join(dirPath, 'lib', 'shapes'), { recursive: true })
  writeFileSync(join(dirPath, 'lib', 'shapes', 'index.ts'), 'export const shape = (): string => "circle"\n')
  // motion state import  TS dependency
  writeFileSync(join(dirPath, 'lib', 'lazy.ts'), 'export const lazyValue = "lazy-ok"\n')
  // each other for .json(host patch note import attribute)
  writeFileSync(join(dirPath, 'config.json'), JSON.stringify({ tag: 'json-ok' }))
  // import.meta.url each other for locate asset
  writeFileSync(join(dirPath, 'assets', 'banner.txt'), 'helm-ts-plugin-asset\n')

  // host construct the same: in plugin directory write a marker module (plugin inside via @helm/* host parse
  // obtain to the same instance), entry handler compare it and its import  HelmError construct - -
  // if store in second module copy, then two prototype chain different.
  const markerPath = join(dirPath, 'lib', 'host-marker.ts')
  writeFileSync(
    markerPath,
    "import { HelmError } from '@helm/protocol'\nexport const marker = new HelmError('marker', 'marker')\nexport const ctor = HelmError\n",
  )
  // heavy write opening in occupy compare: change is explicit import marker, compare the same module diagram under construct the same
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

/** plugin.json main points to .tsx  fixture(pure logic tsx: excludes React JSX, only verify extension track path). */
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
// all link: real createHelm + fixture + start stop
// ---------------------------------------------------------------------------

test('convention entry index.ts external plugin:TS dependency closed package / Node inside placement / npm dependency / @helm the same construct / json / import.meta.url asset locate all link available', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const { counterName } = writeTsPlugin(join(dataDir, 'plugins'))
    const app = await createApp(dataDir)
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'ts-demo')
      assert.ok(summary, 'TS external plugin should by automatically register')
      assert.equal(summary.enabled, false, 'by default deactivate')
      await app.kernel.plugins.enable('ts-demo')

      const r = (await app.kernel.plugins.invokeAction('ts-demo', 'probe', {})) as Record<string, unknown>
      assert.equal(r.builtinOk, true, 'node:crypto / node:fs inside placement module available')
      assert.equal(r.npmDep, 'demo-dep-ok', 'plugin directory node_modules third way npm dependency available')
      assert.equal(r.hostClassSame, true, '@helm/protocol and host the same construct (prototype chain consistent, without second module)')
      assert.equal(r.lazyValue, 'lazy-ok', 'run phase motion state import  TS dependency available')
      assert.equal(r.addTen, 42, 'each other for .js note symbol mapping to .ts file')
      assert.equal(r.greet, 'hi-helm', 'without extension each other for note symbol parse')
      assert.equal(r.shape, 'circle', 'directory index.ts parse')
      assert.equal(r.jsonTag, 'json-ok', 'plugin inside each other for .json import available (host patch note import attribute)')

      // import.meta.url points to plugin real source file (file URL, without query string pollute, asset can read)
      const metaUrl = r.metaUrl as string
      assert.ok(metaUrl.startsWith('file://'), `import.meta.url should be file URL:${metaUrl}`)
      assert.ok(!metaUrl.includes('?'), `import.meta.url must not carries query string:${metaUrl}`)
      const metaPath = fileURLToPath(metaUrl)
      assert.ok(metaPath.endsWith(join('ts-demo', 'index.ts')), `should points to plugin entry source file:${metaPath}`)
      assert.equal(r.assetSha as string, '83877507', 'via import.meta.url locate plugin asset read correct')

      // module identity: same process same URL only initialize once (entry already by createHelm load once)
      assert.equal(globalFlag(counterName), 1, 'plugin entry module only initialize once')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json main points to .tsx entry by correct transpile load (pure logic tsx)', { timeout: 60_000 }, async () => {
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

test('alias identity: the same dependency via .js mapping and explicit .ts two note symbol import is the same module instance (contains symlink dependency)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-alias-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'alias')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    // real dependency + points to it inside symlink: three path (.js mapping / explicit .ts / symlink)
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
      // three note symbol points to the same module instance: module level initialize counter only +1
      assert.equal(globalFlag('__aliasInit'), 1, '.js mapping / explicit .ts / symlink three note symbol is the same module instance')
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

test('TS entry language method error fall back register is failed(contains file and row column number diagnose), never static default', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'broken-ts')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'index.ts'), 'export function f(: string {\n  return 1\n}\n')
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, 'language method error plugin should register is failed item')
      assert.equal(failed.error!.code, 'plugin_load_failed')
      assert.ok(failed.error!.message.includes('broken-ts/index.ts'), `diagnose should contains source file path:${failed.error!.message}`)
      assert.ok(/:\d+:\d+/.test(failed.error!.message), `diagnose should contains row column number:${failed.error!.message}`)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('TS dependency closed package in language method error same fall back register is failed', { timeout: 60_000 }, async () => {
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
// exceeds contract: each scenario independent dataDir + real can reach outside file + execute sentinel
// ---------------------------------------------------------------------------

/** create a real can reach outside directory and evil source file (import execute will translate motion sentinel), return path. */
function makeOutsideEvil(sentinel: string): string {
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-out-'))
  const evil = join(outside, 'evil.ts')
  writeFileSync(evil, `globalThis.${sentinel} = (globalThis.${sentinel} ?? 0) + 1\nexport default { id: 'evil', definePlugin() {} }\n`)
  return evil
}

test('exceeds contract 1:plugin.json main path through exceeds to outside real file, fall back register failed,evil never execute', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc1-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'traversal')
    mkdirSync(dirPath, { recursive: true })
    // outside real file put in dataDir (plugin directory outside,mkdtemp can write zone inside):
    // do not write to tmpdir on two level - - non- root environment (CI runner) for the layer without write permission.
    // main '../../evil.ts' each other for plugin directory parse to dataDir/evil.ts, exceeds out plugin.
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
    assert.equal(globalFlag('__escMainSentinel'), undefined, 'main through exceeds by refuse:evil source code never can by import execute')
    rmSync(reachable, { force: true })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('exceeds contract 2: convention entry symlink points to outside real .ts,realpath out of bounds explicit reject,evil never execute', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc2-'))
  const evil = makeOutsideEvil('__escEntrySentinel')
  try {
    const dirPath = join(dataDir, 'plugins', 'entry-symlink')
    mkdirSync(dirPath, { recursive: true })
    // term method in directory inside,realpath in directory outside (symlink escape), target real store in
    symlinkSync(evil, join(dirPath, 'index.ts'))
    const app = await createApp(dataDir)
    try {
      const failed = app.kernel.plugins.list().find((p) => p.error !== undefined)
      assert.ok(failed, `should be HelmError register, actual: without failed item`)
      assert.ok(
        failed.error!.code === 'plugin_manifest_invalid' || failed.error!.code === 'plugin_load_failed',
        `entry symlink exceeds should explicit reject, actual code:${failed.error!.code}`,
      )
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escEntrySentinel'), undefined, 'entry symlink exceeds by refuse:evil never can by import execute')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(evil, { force: true })
  }
})

test('exceeds contract 3: plugin inside dependency symlink points to outside real .ts, transpile scope reject,evil never execute', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc3-'))
  const evil = makeOutsideEvil('__escDepSentinel')
  try {
    const dirPath = join(dataDir, 'plugins', 'dep-symlink')
    mkdirSync(join(dirPath, 'lib'), { recursive: true })
    // legal entry + inside term method dependency, but dependency is symlink points to outside real evil.ts
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
      assert.ok(failed, `should be HelmError register, actual: without failed item`)
      assert.equal(failed.error!.code, 'plugin_load_failed', 'outside symlink dependency must not by transpile, explicit failed')
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escDepSentinel'), undefined, 'dependency symlink exceeds by refuse:evil never can by import execute')
    rmSync(evil, { force: true })
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(join(tmpdir(), 'helm-ext-out-'), { recursive: true, force: true })
  }
})

test('exceeds contract 4:fallback note symbol (.js family) mapping to outside real .ts, reject transpile,evil never execute; explicit .ts note symbol away Node original generate (non- this load transpile scope)', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-esc4-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'dotdot')
    mkdirSync(dirPath, { recursive: true })
    // ../../evil.js(.js family fallback) from plugins/dotdot/ starting from mapping to dataDir/evil.ts(real store in, outside)
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
      assert.ok(failed, `should be HelmError register, actual: without failed item`)
      // fallback  .js mapping to outside .ts: reject transpile, explicit plugin_load_failed
      assert.equal(failed.error!.code, 'plugin_load_failed')
      assert.ok(failed.error!.message.includes('reject transpile'), `diagnose should note reject reason:${failed.error!.message}`)
    } finally {
      await app.close().catch(() => {})
    }
    assert.equal(globalFlag('__escDotdotSentinel'), undefined, 'fallback exceeds mapping never can trigger outside source code execute')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// module identity and lifecycle
// ---------------------------------------------------------------------------

test('module identity: same plugin entry static + motion state import many where reference only initialize once', { timeout: 60_000 }, async () => {
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
      assert.equal(globalFlag('__identityInit'), 1, 'static and motion state import points to the same module instance')
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

test('TS release and fallback mapping (pure node child process, produce runtime fidelity): register phase mapping available, release after disappear,fallback exceeds reject', { timeout: 60_000 }, async () => {
  const dirPath = mkdtempSync(join(tmpdir(), 'helm-ext-rootrel-'))
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-rootout-'))
  try {
    // fixture: inside mapped.ts(.js mapping target), without extension target,symlink alias;
    // outside evil.ts(fallback exceeds target, real can reach)
    writeFileSync(join(dirPath, 'mapped.ts'), 'export const v = 42\n')
    writeFileSync(join(dirPath, 'greet.ts'), 'export const g = 7\n')
    symlinkSync(join(dirPath, 'mapped.ts'), join(dirPath, 'alias.ts'))
    writeFileSync(join(outside, 'evil.ts'), "globalThis.__childEvil = (globalThis.__childEvil ?? 0) + 1\nexport const e = 'evil'\n")
    writeFileSync(
      join(dirPath, 'entry.ts'),
      "import { v } from './mapped.js'\nimport { g } from './greet'\nimport { v as viaAlias } from './alias.js'\nexport const w = v + g\nexport const a = viaAlias\n",
    )
    // escape.ts inside fallback exceeds note symbol: from plugin starting from points to outside outside/evil.ts
    // (real can reach; use relative compute correct ../ deep, do not manually piece together)
    // escape.ts inside fallback exceeds note symbol: from plugin starting from points to outside outside/evil.ts
    // (real can reach; use relative compute correct ../ deep, end segment swap into .js with construct fallback form)
    const escapeSpec = relative(dirPath, join(outside, 'evil.ts')).split(sep).join('/').replace(/evil\.ts$/, 'evil.js')
    writeFileSync(
      join(dirPath, 'escape.ts'),
      `import { e } from '${escapeSpec}'\nexport const t = e\n`,
    )
    // child process (pure node, do not via tsx: unique real away this load fallback runtime):
    // 1) register phase .js mapping / without extension / symlink alias all load and single time initialize;
    // 2) fallback exceeds (../evil.js -> outside evil.ts) reject and sentinel do not translate;
    // 3) all release after .js mapping disappear (ERR_MODULE_NOT_FOUND).
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
      assert.fail(`pure node child process failed:${out.slice(0, 800)}`)
    }
    assert.ok(result.includes('CHILD_OK'), `pure node child process should all contract via, output:${result}`)
  } finally {
    rmSync(dirPath, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('registerPluginTsRoot reference counter: duplicate register merge, counter reset to zero after can again register', { timeout: 60_000 }, async () => {
  const dirPath = mkdtempSync(join(tmpdir(), 'helm-ext-root-'))
  try {
    writeFileSync(join(dirPath, 'still.ts'), 'export const v = 1\n')
    const transform = createPluginBuildProvider().transformBackendTs
    const release1 = registerPluginTsRoot(dirPath, { transform })
    const release2 = registerPluginTsRoot(dirPath, { transform })
    release1()
    // counter not reset to zero: directory still in transpile scope (.js -> .ts mapping still available)
    const m = (await import(`file://${join(dirPath, 'still.js')}`)) as { v: number }
    assert.equal(m.v, 1, 'counter not reset to zero before transpile scope still takes effect')
    release2()
    // reset to zero after can again register (hook re- lazy register), cycle can duplicate
    const release3 = registerPluginTsRoot(dirPath, { transform })
    release3()
  } finally {
    rmSync(dirPath, { recursive: true, force: true })
  }
})

test('TS plugin deactivate after can again enable; deactivate do not unload module (identity stable, does not repeat initialize)', { timeout: 60_000 }, async () => {
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
      assert.equal(globalFlag(counterName), 1, 'start stop loop does not repeat execute module initialize')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('id conflict failed after TS release: same directory swap id heavy write after can re- load succeeded', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-rel-'))
  try {
    // first via createHelm register a id=dup plugin (first directory by consume)
    const first = join(dataDir, 'plugins', 'first')
    mkdirSync(first, { recursive: true })
    writeFileSync(join(first, 'index.ts'), `export default { id: 'dup', definePlugin() {} }\n`)
    const app = await createApp(dataDir)
    try {
      // again put same id second directory: conflict fall back register is failed item (no longer on throw block assert),
      // by release; after continue same directory can fix reload.
      const second = join(dataDir, 'plugins', 'second')
      mkdirSync(second, { recursive: true })
      writeFileSync(join(second, 'index.ts'), `export default { id: 'dup', definePlugin() {} }\n`)
      const registered0 = await loadExternalPlugins(dataDir, app.kernel.plugins)
      assert.ok(!registered0.includes('dup'), 'conflict directory must not register succeeded')
      const conflicted = app.kernel.plugins.list().find((p) => p.id !== 'dup' && p.error !== undefined)
      assert.ok(conflicted, 'id conflict should fall back register is failed item')
      assert.equal(conflicted.error!.code, 'plugin_already_registered')
      // first already by createHelm consume: remove its entry mark record (fall back is data directory), after continue direct tune
      // only scan second, verify conflict release after same directory can fix reload
      rmSync(join(first, 'index.ts'))
      // change id after same directory re- load succeeded (by correct release/heavy register, transpile scope do not subject to pollute)
      writeFileSync(join(second, 'index.ts'), `export default { id: 'second-fixed', definePlugin(ctx: any) {
        ctx.action({ id: 'ok', description: 'ok', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', required: ['ok'], additionalProperties: false, properties: { ok: { type: 'boolean' } } }, handler: () => ({ ok: true }) })
      } }\n`)
      const registered = await loadExternalPlugins(dataDir, app.kernel.plugins)
      assert.ok(registered.includes('second-fixed'), `change id after should register succeeded:${JSON.stringify(registered)}`)
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

test('loadExternalPlugins direct tune TS plugin: by default deactivate register and action available', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-ts-'))
  try {
    // empty directory start (createHelm without external plugin); again put TS plugin direct tune scan
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
      assert.ok(registered.includes('ts-extra'), `direct tune scan should register new put ts-extra:${JSON.stringify(registered)}`)
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

test('transpile do not produce out any disk middle artifact', { timeout: 60_000 }, async () => {
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
      assert.deepEqual(added, [], `plugin directory must not appear any transpile artifact/cache: new increase ${JSON.stringify(added)}`)
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
