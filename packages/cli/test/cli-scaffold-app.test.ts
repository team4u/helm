/**
 * Tests for `plugins init --template app` scaffolding (unit tier, no real Hub).
 *
 * Covers:
 * - template name validation: accepts `app`, rejects invalid names while listing valid templates;
 * - generated artifacts: `plugin.json` (clientRoot/app naming), backend (public doc + dual-schema actions +
 *   ctx.ui.screen + sidebar shortcut), frontend (@helm/plugin-client host primitives), zero Emoji;
 * - end-to-end (honesty rule: real code, zero mock doctor): runs real `doctorPluginDir` 4-stage check,
 *   then validates through real `PluginHost` + `createAppsPlugin` validate action (ok:true),
 *   and verifies `full` template reports `missing_app_screen`.
 *
 * Cross-package imports: matches web tests importing kernel source (tsx source-level resolution in tests only),
 * adding no runtime dependency from `@helm/cli` to `@helm/kernel`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { doctorPluginDir } from '../../kernel/src/plugins/plugin-doctor.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { PluginHost, type PluginDocStore } from '../../kernel/src/plugins/plugin-host.js'
import { createAppsPlugin, APPS_PLUGIN_ID } from '../../plugins/src/apps.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import {
  cleanupDir,
  makeCliEnv,
  makeTempDir,
  runCliCaptured,
  useTempDir,
} from './helpers/cli-harness.js'

/** Emoji pattern (common emoticon and symbol ranges; generated text must contain zero Emoji). */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u

/** Relative paths of all generated text files for Emoji scanning. */
async function scaffoldFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(path.join(dir, 'client'))
  return ['plugin.json', 'index.ts', 'README.md', ...entries.map((e) => `client/${e}`)]
}

/** In-memory doc store (matches kernel apps-plugin test contract; test-only). */
class MemoryDocStore implements PluginDocStore {
  private values = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.values.has(key) ? (this.values.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value))
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.values.delete(key)
    }
  }
  async flush(): Promise<void> {}
}

interface ValidateResult {
  ok: boolean
  checks: Array<{ id: string; error?: { code: string } }>
  screenIds: string[]
  screenBasis: string
}

/**
 * Real apps validate chain: real PluginHost registers and enables builtin:apps, with host
 * plugins.doctor connected directly to real doctorPluginDir (same implementation as Hub production path, without starting HTTP Hub).
 */
async function validateViaRealAppsPlugin(dir: string): Promise<ValidateResult> {
  const dataDir = await makeTempDir('helm-cli-scaffold-validate-')
  const backend = {
    ...createPluginHostBackendFixture(),
    skills: {
      list: () => Promise.resolve([]),
      readFile: () => Promise.resolve(''),
      directory: () => Promise.resolve('/skills'),
      ensureSkill: async () => {},
    },
    plugins: {
      doctorPlugin: (target: { dir?: string; id?: string }) =>
        doctorPluginDir(target.dir!, { buildProvider: createPluginBuildProvider() }),
    },
    emitEvent: () => {},
  }
  const host = new PluginHost({ dataDir, host: backend as never, docs: new MemoryDocStore(), buildProvider: createPluginBuildProvider() })
  try {
    await host.register(createAppsPlugin({ hubCwd: dataDir }), { enabled: true })
    return (await host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir })) as ValidateResult
  } finally {
    await host.dispose().catch(() => {})
    await cleanupDir(dataDir)
  }
}

test('plugins init --template app: template validation and output file list', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-cli-app-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  const r = await runCliCaptured(['plugins', 'init', 'desk-app', '--template', 'app', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { pluginId: string; dir: string; template: string; files: string[]; nextSteps: string[] }
  assert.equal(body.pluginId, 'desk-app')
  assert.equal(body.template, 'app')
  for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'client/index.tsx', 'client/styles.css', 'README.md']) {
    assert.ok(body.files.includes(f), `output should include ${f}: ${JSON.stringify(body.files)}`)
  }
  // app template next steps point directly to apps workflow (verifiable locally without publishing)
  assert.ok(body.nextSteps.some((s) => s.startsWith('helm apps validate ')), JSON.stringify(body.nextSteps))
  assert.ok(body.nextSteps.some((s) => s.startsWith('helm apps publish ')))

  // Invalid template rejected while listing all valid templates
  const bad = await runCliCaptured(['plugins', 'init', 'bad-tpl-app', '--template', 'webapp', '--json'], env)
  assert.notEqual(bad.code, 0)
  assert.ok(bad.err.includes('minimal') && bad.err.includes('full') && bad.err.includes('app'))
})

test('plugins init --template app: backend and frontend content contracts', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-cli-app-')
  const r = await runCliCaptured(['plugins', 'init', 'desk-app', '--template', 'app', '--json'], makeCliEnv('http://127.0.0.1:1', dataDir))
  assert.equal(r.code, 0, r.err)
  const { dir } = JSON.parse(r.out) as { dir: string }

  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'plugin.json'), 'utf8')) as {
    id: string
    name: string
    main: string
    clientRoot: string
  }
  assert.equal(manifest.id, 'desk-app')
  assert.equal(manifest.name, 'desk-app App')
  assert.equal(manifest.main, 'index.ts')
  assert.equal(manifest.clientRoot, './client')

  const index = await fsp.readFile(path.join(dir, 'index.ts'), 'utf8')
  // ctx.doc public persistent document (for frontend subscription) + flush after write
  assert.ok(index.includes('ctx.doc<'), 'should declare typed public doc')
  assert.ok(index.includes('{ public: true }'), 'doc should be public')
  assert.ok(index.includes('.flush()'), 'write handlers should flush')
  // Dual-schema actions (omitting input/output fails at doctor register)
  assert.ok(index.includes("id: 'add_item'") && index.includes("id: 'set_done'"))
  assert.ok(index.includes('inputSchema') && index.includes('outputSchema'))
  assert.ok(index.includes('exposeAsTool: true'))
  // Full-stack app requirement: main screen + sidebar shortcut
  assert.ok(index.includes('ctx.ui.screen('))
  assert.ok(index.includes("client: { module: 'index.tsx', export: 'MainScreen' }"))
  assert.ok(index.includes('ctx.ui.sidebarItem('))
  assert.ok(index.includes("target: 'screen:desk-app/main'"), 'sidebar entry should target this plugin screen')

  const client = await fsp.readFile(path.join(dir, 'client', 'index.tsx'), 'utf8')
  for (const primitive of ['Screen', 'ScreenSection', 'DataTable', 'KvGrid', 'Checkbox', 'usePluginDoc', 'usePluginContext']) {
    assert.ok(client.includes(primitive), `frontend should use host primitive/hook ${primitive}`)
  }
  assert.ok(client.includes('export function MainScreen'), 'frontend should export MainScreen matching screen declaration')
  assert.ok(!/\b(font-medium|text-subtle|text-xs)\b/.test(client), 'must not contain pseudo-Tailwind class names')
  assert.ok(client.includes("'items'"), 'frontend subscribes to matching public doc')

  const css = await fsp.readFile(path.join(dir, 'client', 'styles.css'), 'utf8')
  assert.ok(css.includes('var(--'), 'extra styles should use host CSS variables')

  // Zero-Emoji invariant across all generated files
  for (const f of await scaffoldFiles(dir)) {
    const text = await fsp.readFile(path.join(dir, f), 'utf8')
    assert.ok(!EMOJI_PATTERN.test(text), `generated file ${f} must not contain Emoji`)
  }
})

test('plugins init --template app end-to-end: real 4-stage doctor + real apps validate pass', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-cli-app-')
  const r = await runCliCaptured(['plugins', 'init', 'eval-app', '--template', 'app', '--json'], makeCliEnv('http://127.0.0.1:1', dataDir))
  assert.equal(r.code, 0, r.err)
  const { dir } = JSON.parse(r.out) as { dir: string }

  // Real doctor: manifest/backend/register/client 4 stages + screen capture
  const report = await doctorPluginDir(dir, { buildProvider: createPluginBuildProvider() })
  assert.ok(report.ok, `doctor should pass: ${JSON.stringify(report.checks)}`)
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ['manifest', 'backend', 'register', 'client'],
  )
  assert.deepEqual(report.screens, ['main'])

  // Real builtin:apps validate action (doctor port wired directly to real implementation)
  const validation = await validateViaRealAppsPlugin(dir)
  assert.equal(validation.ok, true, JSON.stringify(validation.checks))
  assert.deepEqual(validation.screenIds, ['main'])
  assert.equal(validation.screenBasis, 'host-doctor')
})

test('comparison: full template passes doctor but apps validate reports missing_app_screen', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-cli-app-')
  const r = await runCliCaptured(['plugins', 'init', 'panel-only', '--template', 'full', '--json'], makeCliEnv('http://127.0.0.1:1', dataDir))
  assert.equal(r.code, 0, r.err)
  const { dir } = JSON.parse(r.out) as { dir: string }

  const report = await doctorPluginDir(dir, { buildProvider: createPluginBuildProvider() })
  assert.ok(report.ok)
  assert.deepEqual(report.screens, [], 'full template registers workbenchPanel only and declares no screen')

  const validation = await validateViaRealAppsPlugin(dir)
  assert.equal(validation.ok, false, 'full template is not a full-stack app, so validate must fail')
  const missing = validation.checks.find((c) => c.id === 'missing_app_screen')
  assert.ok(missing?.error, 'should include missing_app_screen failure check')
  assert.equal(missing.error.code, 'missing_app_screen')
})
