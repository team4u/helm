/**
 * 内置插件显示元数据 LocalizedText 契约测试：
 * - 定义层（PluginDefinition.name/description）、UI 扩展点（label/title/
 *   description）与 configSchema（label/description）必须声明为
 *   `{ en, 'zh-CN' }` 双语资源且各语文案非空（本地化铺开的登记不变量）；
 * - 注册期执行文案（action/tool 的 description、promptSnippet/
 *   promptGuidelines、cli.description 与 input/outputSchema 内全部
 *   description 机器描述）固定英文：类型为纯 string（不得变 LocalizedText）
 *   且不含中文字符；
 * - 采集方式：对 14 个内置插件工厂以全透传录制 ctx 执行 definePlugin，
 *   只读登记事实，不 mock 行为（getConfig 返回空对象触发缺省路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseNonEmptyLocalizedText, type LocalizedText, type PluginDefinition } from '@helmx/protocol'
import { sanitizedHostEnv, useTempDir } from './helpers/plugin-test-env.js'

import { createProfilePlugin } from '../src/profile.js'
import { createWorkflowPlugin } from '../src/workflow.js'
import { createWorktreePlugin } from '../src/worktree.js'
import { createSwarmPlugin } from '../src/swarm.js'
import { createMemoryPlugin } from '../src/memory.js'
import { createAppsPlugin } from '../src/apps.js'
import { createJsonRenderPlugin } from '../src/json-render.js'
import { createMermaidPlugin } from '../src/mermaid.js'
import { createTriggersPlugin } from '../src/triggers.js'
import { createHerdrPlugin } from '../src/herdr.js'
import { createSuperAgentPlugin } from '../src/superagent.js'
import { createMagpiePlugin } from '../src/magpie.js'
import { createTokenSpeedPlugin } from '../src/token-speed.js'
import { createTasksPlugin } from '../src/tasks.js'

const timeout = { timeout: 60_000 } as const

/** 全部内置插件工厂（与 @helmx/hub 注册清单一一对应）。 */
const FACTORIES: ReadonlyArray<() => PluginDefinition> = [
  createProfilePlugin,
  createWorkflowPlugin,
  createWorktreePlugin,
  createSwarmPlugin,
  createMemoryPlugin,
  createAppsPlugin,
  createJsonRenderPlugin,
  createMermaidPlugin,
  createTriggersPlugin,
  createHerdrPlugin,
  createSuperAgentPlugin,
  createMagpiePlugin,
  createTokenSpeedPlugin,
  createTasksPlugin,
]

interface RecordedAction {
  id?: string
  description?: unknown
  promptSnippet?: unknown
  promptGuidelines?: unknown
  cli?: { description?: unknown } | undefined
  inputSchema?: unknown
  outputSchema?: unknown
}

interface RecordedTool {
  name?: string
  description?: unknown
  promptSnippet?: unknown
  promptGuidelines?: unknown
  inputSchema?: unknown
}

interface Registration {
  definition: PluginDefinition
  ui: Array<{ surface: string; spec: Record<string, unknown> }>
  actions: RecordedAction[]
  tools: RecordedTool[]
  configSchema: Record<string, Record<string, unknown>>[]
}

/**
 * 录制型 ctx：ui/action/tool/configSchema 四个声明面精确捕获，其余任何
 * 属性/调用（host、doc、service、hook……）经全透传 Proxy 吸收，保证
 * definePlugin 注册路径完整走通且不触发真实副作用。
 */
function makeRecordingContext(sink: Registration): Record<string, unknown> {
  const makeAllPurposeProxy = (): object =>
    new Proxy(passthrough, {
      get(target, prop) {
        if (prop === Symbol.toPrimitive) return () => '[recording-passthrough]'
        if (prop === 'then') return undefined
        return makeAllPurposeProxy()
      },
      apply: () => makeAllPurposeProxy(),
      construct: () => makeAllPurposeProxy(),
    })
  const passthrough = (..._args: unknown[]): unknown => makeAllPurposeProxy()
  const uiSurface = (surface: string) => (spec: Record<string, unknown>) => sink.ui.push({ surface, spec })
  return new Proxy(
    {
      getConfig: () => ({}),
      ui: new Proxy(
        {},
        {
          get: (_t, surface) => {
            assert.ok(typeof surface === 'string' && surface.length > 0, 'ctx.ui 扩展面名必须可记录')
            return uiSurface(surface)
          },
        },
      ),
      action: (spec: RecordedAction) => sink.actions.push(spec),
      tool: (spec: RecordedTool) => sink.tools.push(spec),
      configSchema: (schema: Record<string, Record<string, unknown>>) => sink.configSchema.push(schema),
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target]
        return makeAllPurposeProxy()
      },
    },
  )
}

function recordAllPlugins(): Registration[] {
  return FACTORIES.map((factory) => {
    const sink: Registration = { definition: factory(), ui: [], actions: [], tools: [], configSchema: [] }
    sink.definition.definePlugin(makeRecordingContext(sink) as never)
    return sink
  })
}

/** 双语资源断言：必须是 { en, 'zh-CN' } 形态且两种语文案 trim 后非空。 */
function assertFullyLocalized(where: string, value: unknown): void {
  assert.ok(typeof value === 'object' && value !== null, `${where} 必须声明为 { en, 'zh-CN' } 双语资源（当前：${JSON.stringify(value)}）`)
  assert.notEqual(parseNonEmptyLocalizedText(value as LocalizedText), undefined, `${where} 必须通过 parseNonEmptyLocalizedText 边界校验`)
  const map = value as Record<string, unknown>
  for (const locale of ['en', 'zh-CN'] as const) {
    const text = map[locale]
    assert.ok(typeof text === 'string' && text.trim().length > 0, `${where} 缺少非空 ${locale} 文案`)
  }
}

const HAN = /[\u4e00-\u9fff]/

/** 深走 JSON Schema（input/outputSchema）：全部 description 机器描述固定英文。 */
function assertEnglishSchemaDescriptions(where: string, node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertEnglishSchemaDescriptions(`${where}[${i}]`, child))
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'description' && typeof value === 'string') {
      assert.equal(HAN.test(value), false, `${where}.description 执行文案必须固定英文（不得中文/不得 LocalizedText）`)
      continue
    }
    assertEnglishSchemaDescriptions(`${where}.${key}`, value)
  }
}

test('显示元数据：全部内置插件 name/description 与 UI/configSchema 文案为 en+zh-CN 双语资源', timeout, () => {
  const registrations = recordAllPlugins()
  assert.equal(registrations.length, 14, '内置插件工厂数量')
  for (const { definition, ui, configSchema } of registrations) {
    assertFullyLocalized(`${definition.id} definition.name`, definition.name)
    assertFullyLocalized(`${definition.id} definition.description`, definition.description)
    for (const { surface, spec } of ui) {
      const where = `${definition.id} ${surface}#${String(spec['id'])}`
      for (const field of ['label', 'title', 'description'] as const) {
        if (spec[field] !== undefined) assertFullyLocalized(`${where}.${field}`, spec[field])
      }
    }
    for (const schema of configSchema) {
      for (const [key, field] of Object.entries(schema)) {
        assert.ok(field && typeof field === 'object', `${definition.id} config.${key} 必须是对象`)
        const record = field as Record<string, unknown>
        assertFullyLocalized(`${definition.id} config.${key}.label`, record['label'])
        if (record['description'] !== undefined) {
          assertFullyLocalized(`${definition.id} config.${key}.description`, record['description'])
        }
      }
    }
  }
})

test('执行文案：action/tool 注册描述固定英文纯 string（不本地化、无中文）', timeout, () => {
  const registrations = recordAllPlugins()
  for (const { definition, actions, tools } of registrations) {
    for (const action of actions) {
      const where = `${definition.id} action#${String(action.id)}`
      assert.ok(typeof action.description === 'string' && action.description.length > 0, `${where}.description 必须是非空纯 string`)
      assert.equal(HAN.test(action.description), false, `${where}.description 必须固定英文`)
      const cliDescription = action.cli?.description
      if (cliDescription !== undefined) {
        assert.ok(typeof cliDescription === 'string', `${where} cli.description 必须是纯 string`)
        assert.equal(HAN.test(cliDescription as string), false, `${where} cli.description 必须固定英文`)
      }
      for (const field of ['promptSnippet', 'promptGuidelines'] as const) {
        const value = action[field as keyof RecordedAction]
        if (value === undefined) continue
        assert.equal(HAN.test(JSON.stringify(value)), false, `${where}.${field} 必须固定英文`)
      }
      assertEnglishSchemaDescriptions(`${where}.inputSchema`, action.inputSchema)
      assertEnglishSchemaDescriptions(`${where}.outputSchema`, action.outputSchema)
    }
    for (const tool of tools) {
      const where = `${definition.id} tool#${String(tool.name)}`
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${where}.description 必须是非空纯 string`)
      assert.equal(HAN.test(tool.description), false, `${where}.description 必须固定英文`)
      for (const field of ['promptSnippet', 'promptGuidelines'] as const) {
        const value = tool[field as keyof RecordedTool]
        if (value === undefined) continue
        assert.equal(HAN.test(JSON.stringify(value)), false, `${where}.${field} 必须固定英文`)
      }
      assertEnglishSchemaDescriptions(`${where}.inputSchema`, tool.inputSchema)
    }
  }
})

const FORBIDDEN_LAZY_SUBMODULES = [
  'herdr/runtime-bootstrap',
  'herdr/executor',
  'herdr/transport',
  'herdr/overview',
  'herdr/asks',
  'herdr/metadata',
  'herdr/probes',
  'herdr/rpc',
  'herdr/panes',
  'herdr/spawn-rules',
  'herdr/host-ports',
  'herdr/approval-bridge',
  'superagent/runtime-bootstrap',
  'superagent/watchdog',
  'superagent/actions',
  'superagent/hooks',
  'superagent/assets',
]

function runLazyProbeSubprocess(opts: {
  mode: 'src' | 'dist'
  repoRoot: string
  dataDir: string
}): { loadedPluginsModules: string[]; summary: Array<{ id: string; enabled: boolean; status: string }>; configKeys: Record<string, string[]> } {
  const ext = opts.mode === 'dist' ? 'js' : 'ts'
  const baseDir = opts.mode === 'dist' ? 'dist' : 'src'
  const script = `
    import { registerHooks } from 'node:module';
    const loaded = [];
    registerHooks({
      load(url, ctx, nextLoad) {
        loaded.push(url);
        return nextLoad(url, ctx);
      },
    });
    const { PluginHost } = await import(${JSON.stringify(`./packages/kernel/${baseDir}/plugins/plugin-host.${ext}`)});
    const { createHerdrPlugin } = await import(${JSON.stringify(`./packages/plugins/${baseDir}/herdr.${ext}`)});
    const { createSuperAgentPlugin } = await import(${JSON.stringify(`./packages/plugins/${baseDir}/superagent.${ext}`)});
    const docs = new Map();
    const host = new PluginHost({
      dataDir: ${JSON.stringify(opts.dataDir)},
      buildProvider: {
        compileClientModule: async () => { throw new Error('compileClientModule should not run when disabled'); },
        transformBackendTs: () => { throw new Error('transformBackendTs should not run when disabled'); },
      },
      host: { onEvent: () => () => {}, emitEvent: () => {}, redact: (s) => s },
      docs: {
        get: (k, init) => (docs.has(k) ? structuredClone(docs.get(k)) : structuredClone(init)),
        set: (k, v) => { docs.set(k, structuredClone(v)); },
        deletePlugin: () => {},
        flush: async () => {},
      },
    });
    await host.register(createHerdrPlugin(), { enabled: false });
    await host.register(createSuperAgentPlugin(), { enabled: false });
    const summary = host.list().map((p) => ({ id: p.id, enabled: p.enabled, status: p.status }));
    const configKeys = {
      herdr: Object.keys(host.getConfigSources('builtin:herdr')).sort(),
      superagent: Object.keys(host.getConfigSources('builtin:superagent')).sort(),
    };
    await host.dispose();
    console.log(JSON.stringify({
      loadedPluginsModules: loaded.filter((u) => u.includes('/packages/plugins/')),
      summary,
      configKeys,
    }));
  `
  const nodeArgs = opts.mode === 'src'
    ? ['--import', 'tsx', '--input-type=module', '-e', script]
    : ['--input-type=module', '-e', script]
  const env = sanitizedHostEnv({
    ...(opts.mode === 'src' ? { TSX_TSCONFIG_PATH: join(opts.repoRoot, 'tsconfig.dev.json') } : {}),
  })
  const res = spawnSync(process.execPath, nodeArgs, {
    cwd: opts.repoRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(res.status, 0, `${opts.mode} subprocess exited ${String(res.status)}:\nstdout=${res.stdout}\nstderr=${res.stderr}`)
  return JSON.parse(res.stdout.trim()) as {
    loadedPluginsModules: string[]
    summary: Array<{ id: string; enabled: boolean; status: string }>
    configKeys: Record<string, string[]>
  }
}

test('懒加载边界：herdr 与 superagent 停用态注册不加载重型运行时子模块且保留完整声明元数据', timeout, (t) => {
  const testDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(testDir, '..', '..', '..')
  const dataDir = useTempDir(t, 'helmx-lazy-plugins-')

  // 1) 声明元数据同步采集仍完整暴露（herdr 4 动作；superagent 10 动作 + 7 工具）
  const registrations = recordAllPlugins()
  const herdrReg = registrations.find((r) => r.definition.id === 'builtin:herdr')!
  assert.deepEqual(herdrReg.actions.map((a) => a.id).sort(), ['focus', 'list', 'read', 'steer'])
  const saReg = registrations.find((r) => r.definition.id === 'builtin:superagent')!
  assert.deepEqual(
    saReg.actions.map((a) => a.id).sort(),
    [
      'archive_worker',
      'dispatch_worker',
      'inspect_worker',
      'recall_context',
      'set_router_mode',
      'subscribe_thread',
      'watchdog_abort',
      'watchdog_inspect',
      'watchdog_recover',
      'watchdog_tick',
    ],
  )
  assert.deepEqual(
    saReg.tools.map((tool) => tool.name).sort(),
    [
      'dispatch_worker',
      'inspect_worker',
      'recall_context',
      'subscribe_thread',
      'watchdog_abort',
      'watchdog_inspect',
      'watchdog_recover',
    ],
  )

  // 2) 子进程实测（src/ 必跑；若 dist/ 已构建则同步验证构建产物）：enabled:false 注册后重型子模块未进入 Node 模块加载集
  const modes: Array<'src' | 'dist'> = ['src']
  if (
    existsSync(join(repoRoot, 'packages/plugins/dist/herdr.js')) &&
    existsSync(join(repoRoot, 'packages/plugins/dist/superagent.js')) &&
    existsSync(join(repoRoot, 'packages/kernel/dist/plugins/plugin-host.js'))
  ) {
    modes.push('dist')
  }

  for (const mode of modes) {
    const result = runLazyProbeSubprocess({ mode, repoRoot, dataDir: join(dataDir, mode) })
    assert.deepEqual(result.summary, [
      { id: 'builtin:herdr', enabled: false, status: 'disabled' },
      { id: 'builtin:superagent', enabled: false, status: 'disabled' },
    ])
    assert.deepEqual(result.configKeys['herdr'], ['session', 'socketPath', 'startupTimeoutMs'])
    assert.deepEqual(result.configKeys['superagent'], [
      'abortAfterMs',
      'errorThreshold',
      'mutedSources',
      'routerMode',
      'stalledAfterMs',
      'watchdogEnabled',
    ])
    for (const forbidden of FORBIDDEN_LAZY_SUBMODULES) {
      const hit = result.loadedPluginsModules.find((url) => url.includes(forbidden))
      assert.equal(hit, undefined, `[${mode}] 停用态注册不得加载重型子模块 ${forbidden}（实际命中：${String(hit)}）`)
    }
  }
})
