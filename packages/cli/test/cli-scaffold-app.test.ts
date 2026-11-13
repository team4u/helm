/**
 * plugins init --template app 脚手架测试（unit 档，不起真实 Hub）。
 *
 * 覆盖：
 * - 模板名校验：app 受支持，非法值拒绝并列出全部合法模板；
 * - 生成内容：plugin.json（clientRoot/应用命名）、后端（public doc + 双 Schema 动作 +
 *   ctx.ui.screen + 侧栏入口）、前端（@helm/plugin-client 宿主原语）、零 Emoji；
 * - 端到端（诚实性：真代码、零 mock doctor）：对生成目录跑真实 doctorPluginDir
 *   四阶段自检，并经真实 PluginHost + createAppsPlugin 的 validate 动作（doctor 端口
 *   直连真实 doctorPluginDir）断言 ok:true；同链路断言 full 模板如实报 missing_app_screen。
 *
 * 跨包导入说明：与 web 测试直接 import kernel 源码同机制（tsx 源级解析、仅测试消费），
 * 不引入 @helm/cli 对 @helm/kernel 的运行时依赖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/index.js'
import { doctorPluginDir } from '../../kernel/src/plugins/plugin-doctor.js'
import { PluginHost, type PluginDocStore } from '../../kernel/src/plugins/plugin-host.js'
import { createAppsPlugin, APPS_PLUGIN_ID } from '../../kernel/src/builtin-plugins/apps.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'

async function run(
  argv: string[],
  dataDir: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, {
    env: { HELM_HUB_URL: 'http://127.0.0.1:1', HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test' },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  })
  return { code, out, err }
}

/** Emoji 排查（含常用表情与符号区段；生成文案必须为零 Emoji）。 */
const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u

/** 生成目录内的全部文本文件相对路径（emoji 扫描用）。 */
async function scaffoldFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(path.join(dir, 'client'))
  return ['plugin.json', 'index.ts', 'README.md', ...entries.map((e) => `client/${e}`)]
}

/** 内存 doc store（与 kernel apps-plugin 测试同契约，仅测试内使用）。 */
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
 * 真实 apps validate 链路：真实 PluginHost 注册 builtin:apps 并启用，其宿主 plugins
 * 端口的 doctor 直连真实 doctorPluginDir（与 Hub 生产路径同一实现，仅免起 HTTP Hub）。
 */
async function validateViaRealAppsPlugin(dir: string): Promise<ValidateResult> {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'helm-cli-scaffold-validate-'))
  const backend = {
    ...createPluginHostBackendFixture(),
    skills: {
      list: () => Promise.resolve([]),
      readFile: () => Promise.resolve(''),
      directory: () => Promise.resolve('/skills'),
      ensureSkill: async () => {},
    },
    plugins: {
      doctorPlugin: (target: { dir?: string; id?: string }) => doctorPluginDir(target.dir!),
    },
    emitEvent: () => {},
  }
  const host = new PluginHost({ dataDir, host: backend as never, docs: new MemoryDocStore() })
  try {
    await host.register(createAppsPlugin({ hubCwd: dataDir }), { enabled: true })
    return (await host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir })) as ValidateResult
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
}

test('plugins init --template app：模板名校验与产出清单', { timeout: 60_000 }, async () => {
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-app-')
  try {
    const r = await run(['plugins', 'init', 'desk-app', '--template', 'app', '--json'], dataDir)
    assert.equal(r.code, 0, r.err)
    const body = JSON.parse(r.out) as { pluginId: string; dir: string; template: string; files: string[]; nextSteps: string[] }
    assert.equal(body.pluginId, 'desk-app')
    assert.equal(body.template, 'app')
    for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'client/index.tsx', 'client/styles.css', 'README.md']) {
      assert.ok(body.files.includes(f), `产出应含 ${f}：${JSON.stringify(body.files)}`)
    }
    // app 模板的后续步骤直接指向 apps 闭环（不依赖发布到宿主即可验证）
    assert.ok(body.nextSteps.some((s) => s.startsWith('helm apps validate ')), JSON.stringify(body.nextSteps))
    assert.ok(body.nextSteps.some((s) => s.startsWith('helm apps publish ')))

    // 非法模板值拒绝，且报错列出全部合法模板
    const bad = await run(['plugins', 'init', 'bad-tpl-app', '--template', 'webapp', '--json'], dataDir)
    assert.notEqual(bad.code, 0)
    assert.ok(bad.err.includes('minimal') && bad.err.includes('full') && bad.err.includes('app'))
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins init --template app：后端与前端内容契约', { timeout: 60_000 }, async () => {
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-app-')
  try {
    const r = await run(['plugins', 'init', 'desk-app', '--template', 'app', '--json'], dataDir)
    assert.equal(r.code, 0, r.err)
    const { dir } = JSON.parse(r.out) as { dir: string }

    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'plugin.json'), 'utf8')) as {
      id: string
      name: string
      main: string
      clientRoot: string
    }
    assert.equal(manifest.id, 'desk-app')
    assert.equal(manifest.name, 'desk-app 应用')
    assert.equal(manifest.main, 'index.ts')
    assert.equal(manifest.clientRoot, './client')

    const index = await fsp.readFile(path.join(dir, 'index.ts'), 'utf8')
    // ctx.doc 公开持久文档（public 供前端订阅）+ 写后 flush
    assert.ok(index.includes("ctx.doc<"), '应声明类型化 public doc')
    assert.ok(index.includes("{ public: true }"), 'doc 应为 public')
    assert.ok(index.includes('.flush()'), '写操作后应 flush')
    // 双 Schema 动作（input+output 缺一会在 doctor register 阶段被拒）
    assert.ok(index.includes("id: 'add_item'") && index.includes("id: 'set_done'"))
    assert.ok(index.includes('inputSchema') && index.includes('outputSchema'))
    assert.ok(index.includes('exposeAsTool: true'))
    // 全栈应用硬性要求：screen 主视图 + 侧栏直达入口
    assert.ok(index.includes('ctx.ui.screen('))
    assert.ok(index.includes("client: { module: 'index.tsx', export: 'MainScreen' }"))
    assert.ok(index.includes("ctx.ui.sidebarItem("))
    assert.ok(index.includes("target: 'screen:desk-app/main'"), '侧栏入口应指向本插件 screen')

    const client = await fsp.readFile(path.join(dir, 'client', 'index.tsx'), 'utf8')
    for (const primitive of ['Screen', 'ScreenSection', 'DataTable', 'KvGrid', 'Checkbox', 'usePluginDoc', 'usePluginContext']) {
      assert.ok(client.includes(primitive), `前端应使用宿主原语/共享 Hook ${primitive}`)
    }
    assert.ok(client.includes('export function MainScreen'), '前端应导出 MainScreen 与 screen 声明一致')
    assert.ok(!/\b(font-medium|text-subtle|text-xs)\b/.test(client), '不得残留伪 Tailwind 类名')
    assert.ok(client.includes(`'items'`), '前端订阅同名 public doc')

    const css = await fsp.readFile(path.join(dir, 'client', 'styles.css'), 'utf8')
    assert.ok(css.includes('var(--'), '补充样式应走宿主 CSS 变量')

    // 零 Emoji 铁律（全部生成文件扫描）
    for (const f of await scaffoldFiles(dir)) {
      const text = await fsp.readFile(path.join(dir, f), 'utf8')
      assert.ok(!EMOJI_PATTERN.test(text), `生成文件 ${f} 不得包含 Emoji`)
    }
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins init --template app 端到端：真实 doctor 四阶段 + 真实 apps validate 通过', { timeout: 60_000 }, async () => {
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-app-')
  try {
    const r = await run(['plugins', 'init', 'eval-app', '--template', 'app', '--json'], dataDir)
    assert.equal(r.code, 0, r.err)
    const { dir } = JSON.parse(r.out) as { dir: string }

    // 真实 doctor：manifest/backend/register/client 四阶段 + screen 捕获
    const report = await doctorPluginDir(dir)
    assert.ok(report.ok, `doctor 应通过：${JSON.stringify(report.checks)}`)
    assert.deepEqual(
      report.checks.map((c) => c.id),
      ['manifest', 'backend', 'register', 'client'],
    )
    assert.deepEqual(report.screens, ['main'])

    // 真实 builtin:apps validate 动作（doctor 端口直连真实实现）
    const validation = await validateViaRealAppsPlugin(dir)
    assert.equal(validation.ok, true, JSON.stringify(validation.checks))
    assert.deepEqual(validation.screenIds, ['main'])
    assert.equal(validation.screenBasis, 'host-doctor')
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('对照：full 模板 doctor 通过但 apps validate 如实报 missing_app_screen', { timeout: 60_000 }, async () => {
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-app-')
  try {
    const r = await run(['plugins', 'init', 'panel-only', '--template', 'full', '--json'], dataDir)
    assert.equal(r.code, 0, r.err)
    const { dir } = JSON.parse(r.out) as { dir: string }

    const report = await doctorPluginDir(dir)
    assert.ok(report.ok)
    assert.deepEqual(report.screens, [], 'full 模板只注册 workbenchPanel，不声明 screen')

    const validation = await validateViaRealAppsPlugin(dir)
    assert.equal(validation.ok, false, 'full 模板不是全栈应用，validate 应失败')
    const missing = validation.checks.find((c) => c.id === 'missing_app_screen')
    assert.ok(missing?.error, '应包含 missing_app_screen 失败项')
    assert.equal(missing.error.code, 'missing_app_screen')
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})
