/**
 * plugins init --template app foot manually frame test (unit Profile, do not start real Hub).
 *
 * override:
 * - template name validate:app subject to support, illegal value reject and column out all legal template;
 * - generate content:plugin.json(clientRoot/should use naming), backend (public doc + double Schema action +
 *   ctx.ui.screen + sidebar entry), frontend (@helm/plugin-client host original language), zero Emoji;
 * - end-to-end (honest: true code, zero mock doctor): for generate directory run real doctorPluginDir
 *   four phase self inspect, and via real PluginHost + createAppsPlugin  validate action (doctor port
 *   direct connect real doctorPluginDir) assertion ok:true; same link assertion full template such as report missing_app_screen.
 *
 * across package import note: and web test directly import kernel source code same mechanism (tsx source level parse, only test consume),
 * does not introduce @helm/cli for @helm/kernel runtime dependency.
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

/** Emoji troubleshoot (contains common use table situation and symbol zone segment; generate text proposal must is zero Emoji). */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u

/** generate directory inside all text file relative path (emoji scan use). */
async function scaffoldFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(path.join(dir, 'client'))
  return ['plugin.json', 'index.ts', 'README.md', ...entries.map((e) => `client/${e}`)]
}

/** memory doc store(and kernel apps-plugin test same contract, only test inside use). */
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
 * real apps validate link: real PluginHost register builtin:apps and enable, its host plugins
 * port doctor direct connect real doctorPluginDir(and Hub produce path the same implement, only exempt start HTTP Hub).
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

test('plugins init --template app: template name validate and produce out manifest', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-cli-app-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  const r = await runCliCaptured(['plugins', 'init', 'desk-app', '--template', 'app', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { pluginId: string; dir: string; template: string; files: string[]; nextSteps: string[] }
  assert.equal(body.pluginId, 'desk-app')
  assert.equal(body.template, 'app')
  for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'client/index.tsx', 'client/styles.css', 'README.md']) {
    assert.ok(body.files.includes(f), `produce out should contains ${f}:${JSON.stringify(body.files)}`)
  }
  // app template after continue step directly points to apps closed ring (independent of publish to host i.e. can verify)
  assert.ok(body.nextSteps.some((s) => s.startsWith('helm apps validate ')), JSON.stringify(body.nextSteps))
  assert.ok(body.nextSteps.some((s) => s.startsWith('helm apps publish ')))

  // illegal template value reject, and errors column out all legal template
  const bad = await runCliCaptured(['plugins', 'init', 'bad-tpl-app', '--template', 'webapp', '--json'], env)
  assert.notEqual(bad.code, 0)
  assert.ok(bad.err.includes('minimal') && bad.err.includes('full') && bad.err.includes('app'))
})

test('plugins init --template app: backend and frontend content contract', { timeout: 60_000 }, async (t) => {
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
  assert.equal(manifest.name, 'desk-app should use')
  assert.equal(manifest.main, 'index.ts')
  assert.equal(manifest.clientRoot, './client')

  const index = await fsp.readFile(path.join(dir, 'index.ts'), 'utf8')
  // ctx.doc public durable document (public supply frontend subscribe)+ write after flush
  assert.ok(index.includes('ctx.doc<'), 'should declaration type public doc')
  assert.ok(index.includes('{ public: true }'), 'doc should be public')
  assert.ok(index.includes('.flush()'), 'write operation after should flush')
  // double Schema action (input+output missing one will in doctor register phase by refuse)
  assert.ok(index.includes("id: 'add_item'") && index.includes("id: 'set_done'"))
  assert.ok(index.includes('inputSchema') && index.includes('outputSchema'))
  assert.ok(index.includes('exposeAsTool: true'))
  // full-stack should use hard want seek:screen main view + sidebar direct reach entry
  assert.ok(index.includes('ctx.ui.screen('))
  assert.ok(index.includes("client: { module: 'index.tsx', export: 'MainScreen' }"))
  assert.ok(index.includes('ctx.ui.sidebarItem('))
  assert.ok(index.includes("target: 'screen:desk-app/main'"), 'sidebar entry should points to this plugin screen')

  const client = await fsp.readFile(path.join(dir, 'client', 'index.tsx'), 'utf8')
  for (const primitive of ['Screen', 'ScreenSection', 'DataTable', 'KvGrid', 'Checkbox', 'usePluginDoc', 'usePluginContext']) {
    assert.ok(client.includes(primitive), `frontend should use host original language/sharing Hook ${primitive}`)
  }
  assert.ok(client.includes('export function MainScreen'), 'frontend should export MainScreen and screen declaration consistent')
  assert.ok(!/\b(font-medium|text-subtle|text-xs)\b/.test(client), 'must not leftover fake Tailwind class name')
  assert.ok(client.includes("'items'"), 'frontend subscribe same name public doc')

  const css = await fsp.readFile(path.join(dir, 'client', 'styles.css'), 'utf8')
  assert.ok(css.includes('var(--'), 'patch fill style should away host CSS variable')

  // zero Emoji iron rule (all generate file scan)
  for (const f of await scaffoldFiles(dir)) {
    const text = await fsp.readFile(path.join(dir, f), 'utf8')
    assert.ok(!EMOJI_PATTERN.test(text), `generate file ${f} must not contains Emoji`)
  }
})

test('plugins init --template app end-to-end: real doctor four phase + real apps validate via', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-cli-app-')
  const r = await runCliCaptured(['plugins', 'init', 'eval-app', '--template', 'app', '--json'], makeCliEnv('http://127.0.0.1:1', dataDir))
  assert.equal(r.code, 0, r.err)
  const { dir } = JSON.parse(r.out) as { dir: string }

  // real doctor:manifest/backend/register/client four phase + screen catch
  const report = await doctorPluginDir(dir, { buildProvider: createPluginBuildProvider() })
  assert.ok(report.ok, `doctor should via:${JSON.stringify(report.checks)}`)
  assert.deepEqual(
    report.checks.map((c) => c.id),
    ['manifest', 'backend', 'register', 'client'],
  )
  assert.deepEqual(report.screens, ['main'])

  // real builtin:apps validate action (doctor port direct connect real implement)
  const validation = await validateViaRealAppsPlugin(dir)
  assert.equal(validation.ok, true, JSON.stringify(validation.checks))
  assert.deepEqual(validation.screenIds, ['main'])
  assert.equal(validation.screenBasis, 'host-doctor')
})

test('compare:full template doctor via but apps validate such as report missing_app_screen', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-cli-app-')
  const r = await runCliCaptured(['plugins', 'init', 'panel-only', '--template', 'full', '--json'], makeCliEnv('http://127.0.0.1:1', dataDir))
  assert.equal(r.code, 0, r.err)
  const { dir } = JSON.parse(r.out) as { dir: string }

  const report = await doctorPluginDir(dir, { buildProvider: createPluginBuildProvider() })
  assert.ok(report.ok)
  assert.deepEqual(report.screens, [], 'full template only register workbenchPanel, do not declaration screen')

  const validation = await validateViaRealAppsPlugin(dir)
  assert.equal(validation.ok, false, 'full template is not full-stack should use,validate should failed')
  const missing = validation.checks.find((c) => c.id === 'missing_app_screen')
  assert.ok(missing?.error, 'should contain missing_app_screen failed items')
  assert.equal(missing.error.code, 'missing_app_screen')
})
