/**
 * 外部插件目录 <dataDir>/plugins/<dir>/ 自动发现与动态加载器专项测试。
 *
 * 组合纪律：真实 createHelm（真 SQLite + 真 PluginHost + 真 assistant）+
 * faux provider + 真实磁盘上的外部插件 .mjs 入口；不 mock app、不 fake host。
 *
 * 覆盖：
 * - 约定入口（index.mjs）与 plugin.json（main 指定入口）两种发现形态；
 * - 外部插件默认停用注册，enable 后 action / public doc / client.tsx 编译全链路可用；
 * - config.json.pluginEnabled = true 的外部插件跨重启自动恢复启用；
 * - 普通插件留下的纯数据目录（无 plugin.json / index.js）静默跳过；
 * - 损坏 plugin.json / 冒充 builtin: id / 越界 main（含 symlink 真实路径越界）/
 *   setup 兼容别名 / 非 string clientRoot 显式报错，绝不静默吞错；
 * - EACCES 等真实 IO 故障显式报错（不误判为纯数据目录跳过）；仅 ENOENT/ENOTDIR 视为缺失。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import { HelmError } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { loadExternalPlugins } from '../src/plugins/external-loader.js'

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

/** 约定入口形态的外部插件源（index.mjs + client.tsx + action + public doc）。 */
const CONVENTION_PLUGIN_SRC = `
export default {
  id: 'demo-external',
  name: '演示外部插件',
  version: '1.0.0',
  async definePlugin(ctx) {
    const status = ctx.doc('status', { count: 0 }, { public: true })
    ctx.action({
      id: 'bump',
      description: '计数加一',
      inputSchema: { type: 'object', properties: { step: { type: 'number' } }, additionalProperties: false },
      outputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], additionalProperties: false },
      handler: (input) => {
        status.update((cur) => ({ count: cur.count + (input?.step ?? 1) }))
        return { count: status.get().count }
      },
    })
    ctx.ui.screen({
      id: 'demo-panel',
      label: '演示面板',
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
  app: Awaited<ReturnType<typeof createHelm>>
  close(): Promise<void>
}

function makeModels() {
  const models = createModels()
  models.setProvider(fauxProvider().provider)
  return models
}

async function makeEnv(): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
  return {
    dataDir,
    app,
    async close() {
      try {
        await app.close()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
}

/** 在指定 dataDir 上启动 createHelm（外部插件发现失败的错误断言用）。 */
function makeEnvIn(dataDir: string): Promise<Awaited<ReturnType<typeof createHelm>>> {
  return createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
}

/** 写入一个约定入口形态的外部插件目录。 */
function writeConventionPlugin(pluginsDir: string, dir = 'demo-external'): string {
  const dirPath = join(pluginsDir, dir)
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'index.mjs'), CONVENTION_PLUGIN_SRC)
  writeFileSync(join(dirPath, 'client.tsx'), CONVENTION_CLIENT_TSX)
  return dirPath
}

/** 在 dataDir 的 config.json 中持久化 pluginEnabled.<id> = value。 */
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
// 自动发现与注册
// ---------------------------------------------------------------------------

test('约定入口 index.mjs 的外部插件在 createHelm 启动时被自动发现并默认停用注册', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    // 预置外部插件目录（先于 createHelm，模拟用户手工放入）
    writeConventionPlugin(join(dataDir, 'plugins'))
    // 同时预置一个内置插件会留下的纯数据目录形态干扰项：builtin:assistant
    mkdirSync(join(dataDir, 'plugins', 'builtin:assistant'), { recursive: true })
    writeFileSync(join(dataDir, 'plugins', 'builtin:assistant', 'MEMORY.md'), 'assistant data')

    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary, '外部插件应被自动注册')
      assert.equal(summary.enabled, false, '外部插件默认停用（最小权限）')
      assert.equal(summary.locked, false, '外部插件不可自封 locked')
      // 内置 assistant 数据目录不被误认（仍只有一次 builtin:assistant）
      const assistant = app.kernel.plugins.list().filter((p) => p.id === 'builtin:assistant')
      assert.equal(assistant.length, 1)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('外部插件 enable 后 action / public doc / client.tsx 编译全链路可用', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    try {
      await app.kernel.plugins.enable('demo-external')
      // action：入参 schema 校验 + 出参 schema 校验 + doc 副作用
      const result = (await app.kernel.plugins.invokeAction('demo-external', 'bump', { step: 5 })) as { count: number }
      assert.equal(result.count, 5)
      // public doc 快照可见
      const doc = app.kernel.plugins.getPublicDoc('demo-external', 'status')
      assert.deepEqual(doc.value, { count: 5 })
      // clientRoot 默认指向插件目录：client.tsx 可编译出 ESM 产物
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

test('plugin.json（main 指定入口）的外部插件被正确发现与注册', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'manifest-plugin')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: 'src/entry.mjs' }))
    mkdirSync(join(dirPath, 'src'), { recursive: true })
    writeFileSync(
      join(dirPath, 'src', 'entry.mjs'),
      `export default {\n  id: 'manifest-plugin',\n  name: '清单插件',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: '回声',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },\n      handler: () => ({ pong: true }),\n    })\n  },\n}\n`,
    )
    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'manifest-plugin')
      assert.ok(summary, 'plugin.json 插件应被自动注册')
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
// 跨重启持久化恢复
// ---------------------------------------------------------------------------

test('pluginEnabled 持久化 true 的外部插件跨重启自动恢复启用', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const first = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    // 显式 enable 落盘 pluginEnabled["demo-external"] = true
    await first.kernel.plugins.enable('demo-external')
    const persisted = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { pluginEnabled?: Record<string, boolean> }
    assert.equal(persisted.pluginEnabled?.['demo-external'], true)
    await first.close()

    // 二次启动：持久化 true 自动恢复启用，无需手动 enable
    const second = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    try {
      const summary = second.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary, '外部插件重启后仍应被注册')
      assert.equal(summary.enabled, true, '持久化 true 的外部插件重启后自动启用')
      // 自动启用后 action 直接可调
      const result = (await second.kernel.plugins.invokeAction('demo-external', 'bump', { step: 2 })) as { count: number }
      assert.equal(result.count, 2)
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('pluginEnabled 持久化 false 的外部插件重启后保持停用', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const first = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    await first.kernel.plugins.enable('demo-external')
    await first.kernel.plugins.disable('demo-external')
    await first.close()

    const second = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    try {
      const summary = second.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary)
      assert.equal(summary.enabled, false, '持久化 false 保持停用，不回落声明缺省')
    } finally {
      await second.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 数据目录静默跳过
// ---------------------------------------------------------------------------

test('普通插件留下的纯数据目录（无 plugin.json / 约定入口）被静默忽略', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const pluginsDir = join(dataDir, 'plugins')
    // 各种「纯数据目录」形态：随机数据文件、子目录、隐藏目录、空目录
    mkdirSync(join(pluginsDir, 'builtin:herdr', 'state'), { recursive: true })
    writeFileSync(join(pluginsDir, 'builtin:herdr', 'state', 'cache.json'), '{}')
    mkdirSync(join(pluginsDir, 'some-plugin-data'), { recursive: true })
    writeFileSync(join(pluginsDir, 'some-plugin-data', 'MEMORY.md'), 'data only')
    mkdirSync(join(pluginsDir, '.hidden'), { recursive: true })
    writeFileSync(join(pluginsDir, '.hidden', 'index.mjs'), 'export default {}')
    mkdirSync(join(pluginsDir, 'empty-dir'), { recursive: true })

    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    try {
      const ids = app.kernel.plugins.list().map((p) => p.id)
      assert.ok(!ids.includes('some-plugin-data'), '纯数据目录不注册')
      assert.ok(!ids.includes('.hidden'), '隐藏目录不参与发现')
      assert.ok(!ids.includes('empty-dir'), '空目录不注册')
      assert.ok(ids.includes('builtin:assistant'), '内置插件不受影响')
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 显式报错（诚实性纪律：绝不静默吞错）
// ---------------------------------------------------------------------------

test('损坏的 plugin.json 显式报错 plugin_manifest_invalid，绝不静默跳过', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'broken-manifest')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '{ not valid json !!')
    writeFileSync(join(dirPath, 'index.mjs'), 'export default { id: "x", name: "x", definePlugin() {} }')

    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_manifest_invalid',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json 为 JSON 数组（非对象）显式报错 plugin_manifest_invalid', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'array-manifest')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), '[1, 2, 3]')
    writeFileSync(join(dirPath, 'index.mjs'), 'export default { id: "x", name: "x", definePlugin() {} }')

    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_manifest_invalid',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('冒充 builtin: id 的外部插件显式报错，绝不静默放行', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'fake-builtin')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'builtin:evil',\n  name: '冒充内置',\n  async definePlugin() {},\n}\n`,
    )

    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'invalid_plugin_definition' && err.message.includes('builtin:'),
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json main 越出插件目录显式报错（防路径穿越）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const outside = mkdtempSync(join(tmpdir(), 'helm-ext-outside-'))
    try {
      writeFileSync(join(outside, 'evil.mjs'), 'export default { id: "evil", name: "evil", definePlugin() {} }')
      const dirPath = join(dataDir, 'plugins', 'traversal')
      mkdirSync(dirPath, { recursive: true })
      writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: '../../evil.mjs' }))

      await assert.rejects(
        makeEnvIn(dataDir),
        (err: unknown) => err instanceof HelmError && err.code === 'plugin_manifest_invalid',
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('plugin.json 声明的入口文件缺失显式报错 plugin_entry_missing', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'missing-entry')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: 'ghost.mjs' }))

    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_entry_missing',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('入口 symlink 指向插件目录外：词法路径不越界但真实路径越界，显式拒绝', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  const outside = mkdtempSync(join(tmpdir(), 'helm-ext-outside-'))
  try {
    writeFileSync(join(outside, 'evil.mjs'), 'export default { id: "evil", name: "evil", definePlugin() {} }')
    const dirPath = join(dataDir, 'plugins', 'symlink-escape')
    mkdirSync(dirPath, { recursive: true })
    // 词法在目录内、真实在目录外（symlink 逃逸）
    symlinkSync(join(outside, 'evil.mjs'), join(dirPath, 'entry.mjs'))
    writeFileSync(join(dirPath, 'plugin.json'), JSON.stringify({ main: 'entry.mjs' }))

    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'plugin_manifest_invalid' &&
        err.message.includes('符号链接'),
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('clientRoot 非字符串在边界显式拒绝（不引入虚假沙箱承诺）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'bad-client-root')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'bad-client-root',\n  name: '非法 clientRoot',\n  clientRoot: 123,\n  definePlugin() {},\n}\n`,
    )

    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'invalid_plugin_definition' &&
        err.message.includes('clientRoot'),
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('无清单的约定入口同样拒绝 symlink 越界，不导入外部模块', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-convention-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'convention-escape')
    mkdirSync(dirPath, { recursive: true })
    const outside = join(dataDir, 'outside.mjs')
    writeFileSync(outside, 'throw new Error("outside_module_was_imported")')
    symlinkSync(outside, join(dirPath, 'index.mjs'))
    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_manifest_invalid',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('入口探测遇到真实 IO 故障（ELOOP symlink 环）显式报错，不误判为纯数据目录（root 用户同样生效）', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'symlink-loop')
    mkdirSync(dirPath, { recursive: true })
    // 自指 symlink 环：statSync 抛 ELOOP（真实 IO 故障，非缺失），root/win 均可触发
    symlinkSync(join(dirPath, 'index.mjs'), join(dirPath, 'index.mjs'))

    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) => err instanceof HelmError,
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('未声明 clientRoot 的外部插件默认 clientRoot 为插件目录本身', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    writeConventionPlugin(join(dataDir, 'plugins'))
    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'demo-external')
      assert.ok(summary, '外部插件应被自动注册')
      await app.kernel.plugins.enable('demo-external')
      // clientRoot 默认指向插件目录（client.tsx 编译可解析）
      const client = await app.kernel.plugins.getClientModule('demo-external', 'client.tsx')
      assert.ok(client.code.length > 0)
    } finally {
      await app.close()
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('仅导出 setup 别名（无 definePlugin）显式拒绝：项目明确不做兼容别名', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'setup-alias')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'setup-alias',\n  name: '旧形态',\n  setup() {},\n}\n`,
    )

    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'invalid_plugin_definition' &&
        err.message.includes('definePlugin'),
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('模块导出无 name：同内置契约注册成功（展示名回落 id），不另加必填约束', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'no-name')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'no-name-plugin',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'ping',\n      description: '回声',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels(), watchdogIntervalMs: 0 })
    try {
      const summary = app.kernel.plugins.list().find((p) => p.id === 'no-name-plugin')
      assert.ok(summary, '无 name 的外部插件应可注册（同 protocol 契约）')
      assert.equal(summary.name, 'no-name-plugin', '展示名回落 id（与内置插件同权）')
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

test('name 提供但为空串：边界拒绝 invalid_plugin_definition', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'empty-name')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'empty-name',\n  name: '',\n  definePlugin() {},\n}\n`,
    )
    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'invalid_plugin_definition' && err.message.includes('name'),
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('模块导出既无 definePlugin 也无 setup 显式报错 invalid_plugin_definition', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ext-plugin-'))
  try {
    const dirPath = join(dataDir, 'plugins', 'no-setup')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(join(dirPath, 'index.mjs'), 'export default { id: "no-setup", name: "无入口" }')

    await assert.rejects(
      makeEnvIn(dataDir),
      (err: unknown) => err instanceof HelmError && err.code === 'invalid_plugin_definition',
    )
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 独立 loader 直调（不经 createHelm，验证返回值与空目录语义）
// ---------------------------------------------------------------------------

test('loadExternalPlugins 直调：返回注册 id 列表；plugins 目录缺失返回空数组', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // createHelm 已消费一次；对同一 dataDir 再直调（同 id 已注册 → 显式冲突）
    const dirPath = join(env.dataDir, 'plugins', 'direct-loader')
    mkdirSync(dirPath, { recursive: true })
    writeFileSync(
      join(dirPath, 'index.mjs'),
      `export default {\n  id: 'direct-loader',\n  name: '直调',\n  async definePlugin(ctx) {\n    ctx.action({\n      id: 'noop',\n      description: '空操作',\n      inputSchema: { type: 'object', additionalProperties: false },\n      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },\n      handler: () => ({ ok: true }),\n    })\n  },\n}\n`,
    )
    const registered = await loadExternalPlugins(env.dataDir, env.app.kernel.plugins)
    assert.ok(registered.includes('direct-loader'), `应注册 direct-loader，实际：${JSON.stringify(registered)}`)

    const summary = env.app.kernel.plugins.list().find((p) => p.id === 'direct-loader')
    assert.ok(summary)
    assert.equal(summary.enabled, false)

    // plugins 目录整体缺失 → 空数组（不抛错）
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
