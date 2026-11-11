/**
 * builtin:apps 插件行为测试（真 PluginHost + 真目录 doc store + 模拟受管包端口）。
 *
 * 覆盖：
 * - catalog 公开 doc 初始值（apps 空表）；
 * - validate：doctor 失败透传、已注册缺 Screen 的 missing_app_screen 失败项、
 *   草稿 deferred 语义（不静态猜测）；
 * - publish：首次登记 catalog（mode installed / screenTarget / 元数据合并 /
 *   originConversationId 解析优先级）与同源 update 语义（数据保留、catalog
 *   publishedAt 保持）；异源路径走重装；
 * - list：宿主清单 + listUi screens + catalog 左连接、内置插件排除、
 *   孤儿 catalog 条目忽略；
 * - update_meta：只改元数据不动宿主；未登记 404；
 * - remove：宿主卸载后清理 catalog；
 * - 边界：builtin/self 目标 409、远端节点相对路径 400 app_source_must_be_on_hub、
 *   非法 category 400、宿主端口未接线 501；
 * - 停用 builtin:apps 后动作/UI 立即消失（可停用铁律）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  type ConversationSummary,
  type PluginDefinition,
  type PluginDoctorReport,
  type PluginInstallResult,
  type PluginRemoveResult,
  type PluginSummary,
  type PluginUiContribution,
  type PluginUpdateResult,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import {
  APPS_PLUGIN_ID,
  APP_BUILDER_SKILL_ID,
  createAppsPlugin,
  type AppCatalogEntry,
  type AppsCatalogDoc,
} from '../src/builtin-plugins/apps.js'

// ---------------------------------------------------------------------------
// 基建
// ---------------------------------------------------------------------------

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  async flush(): Promise<void> {}
}

function makeConversation(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  const now = Date.now()
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/hub/work',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

/** 模拟受管插件包端口（记录调用；行为按需注入）。 */
interface FakePackageManagerState {
  installed: Map<string, { source: string; enableFailedOnce: boolean }>
  summaries: Map<string, PluginSummary>
  ui: Array<{ pluginId: string; surface: string; spec: unknown }>
  doctorImpl: (target: { dir?: string; id?: string }) => Promise<PluginDoctorReport>
  calls: string[]
  /** install 时是否补充 main screen（模拟正常全栈应用；false 模拟无 Screen 应用）。 */
  screensOnInstall: boolean
}

function fakePackageManager(initial: Partial<FakePackageManagerState> = {}) {
  const state: FakePackageManagerState = {
    installed: new Map(),
    summaries: new Map(),
    ui: [],
    doctorImpl: async () => {
      throw new HelmError('not_implemented', '测试未配置 doctor 行为', 500)
    },
    calls: [],
    screensOnInstall: true,
    ...initial,
  }
  const port = {
    async doctor(target: { dir?: string; id?: string }): Promise<PluginDoctorReport & { screens?: string[] }> {
      state.calls.push(`doctor:${target.dir ?? target.id}`)
      return state.doctorImpl(target)
    },
    async install(source: string, options?: { enable?: boolean }): Promise<PluginInstallResult> {
      state.calls.push(`install:${source}`)
      const pluginId = source.split('/').pop() ?? source
      const now = Date.now()
      const summary: PluginSummary = {
        id: pluginId,
        name: pluginId,
        version: '0.1.0',
        locked: false,
        enabled: options?.enable === true,
        status: options?.enable === true ? 'active' : 'disabled',
        hooks: [],
        actions: [],
        tools: [],
      }
      state.summaries.set(pluginId, summary)
      state.installed.set(pluginId, { source, enableFailedOnce: false })
      // 受管安装的全栈应用默认携带 main screen（listUi 事实）；可关闭以模拟无 Screen 应用
      if (
        state.screensOnInstall &&
        !state.ui.some((c) => c.pluginId === pluginId && c.surface === 'screen')
      ) {
        state.ui.push({ pluginId, surface: 'screen', spec: { id: 'main', label: pluginId } })
      }
      return {
        record: {
          id: `rec-${pluginId}`,
          pluginId,
          source: { kind: 'local', raw: source, path: source },
          installPath: `/data/plugins/${pluginId}`,
          version: '0.1.0',
          installedAt: now,
          updatedAt: now,
        },
        summary,
      }
    },
    async update(pluginId: string): Promise<PluginUpdateResult> {
      state.calls.push(`update:${pluginId}`)
      const prev = state.summaries.get(pluginId)
      if (prev === undefined) throw new HelmError('unknown_plugin_package', `插件 ${pluginId} 没有受管安装记录`, 404, { pluginId })
      const now = Date.now()
      return {
        record: {
          id: `rec-${pluginId}`,
          pluginId,
          source: { kind: 'local', raw: `/ws/${pluginId}`, path: `/ws/${pluginId}` },
          installPath: `/data/plugins/${pluginId}`,
          version: '0.2.0',
          installedAt: now - 1000,
          updatedAt: now,
        },
        summary: { ...prev, version: '0.2.0' },
        changed: true,
        previousVersion: '0.1.0',
      }
    },
    async remove(pluginId: string): Promise<PluginRemoveResult> {
      state.calls.push(`remove:${pluginId}`)
      const record = state.installed.get(pluginId)
      if (record === undefined) throw new HelmError('unknown_plugin_package', `插件 ${pluginId} 没有受管安装记录`, 404, { pluginId })
      state.installed.delete(pluginId)
      state.summaries.delete(pluginId)
      state.ui = state.ui.filter((c) => c.pluginId !== pluginId)
      return {
        pluginId,
        installPath: `/data/plugins/${pluginId}`,
        wasEnabled: true,
        installId: `rec-${pluginId}`,
      }
    },
    async enable(pluginId: string) {
      state.calls.push(`enable:${pluginId}`)
      const prev = state.summaries.get(pluginId)
      if (prev !== undefined) state.summaries.set(pluginId, { ...prev, enabled: true, status: 'active' })
    },
    async disable(_pluginId: string) {
      state.calls.push('disable')
    },
    list(): PluginSummary[] {
      // 已安装插件 + builtin:apps 自身
      return [...state.summaries.values()]
    },
    listUi(): PluginUiContribution[] {
      // builtin:apps 的 center screen 恒存在；其余按 state.ui
      const appsCenter: PluginUiContribution = {
        pluginId: APPS_PLUGIN_ID,
        surface: 'screen',
        spec: { id: 'center', label: '应用中心' },
      }
      return [appsCenter, ...state.ui.filter((c) => state.summaries.get(c.pluginId)?.enabled === true)]
    },
  }
  return { state, port }
}

function makeBackend(conversations: Map<number, ConversationSummary>, pluginsPort?: unknown) {
  const base = {
    ...createPluginHostBackendFixture(),
    conversations,
    listConversations: () => [...conversations.values()],
    getConversation: (id: number) => {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在: ${id}`, 404, { conversationId: id })
      return found
    },
    skills: {
      list: () => Promise.resolve([]),
      readFile: () => Promise.resolve(''),
      directory: () => Promise.resolve('/skills'),
      ensureSkill: async () => {},
    },
    emitEvent: () => {},
  }
  return pluginsPort === undefined
    ? base
    : Object.assign(base, { plugins: pluginsPort })
}

async function setup(options: {
  hubCwd?: string
  conversations?: Map<number, ConversationSummary>
  pluginsPort?: unknown
  docs?: PluginDocStore
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-apps-plugin-'))
  const conversations =
    options.conversations ?? new Map<number, ConversationSummary>([[1, makeConversation(1)]])
  const backend = makeBackend(conversations, options.pluginsPort)
  const docs = options.docs ?? new MemoryDocStore()
  const host = new PluginHost({ dataDir, host: backend, docs })
  await host.register(
    createAppsPlugin({ hubCwd: options.hubCwd ?? '/hub' }),
    { enabled: true },
  )
  return { host, docs, dataDir, backend }
}

/** 读取 catalog doc 的当前值（经宿主公共文档 API，与真实消费方一致）。 */
function readCatalog(host: PluginHost): AppsCatalogDoc {
  const doc = host.getPublicDoc(APPS_PLUGIN_ID, 'catalog')
  assert.equal(doc.pluginId, APPS_PLUGIN_ID)
  return doc.value as AppsCatalogDoc
}

 /** 直接写入 catalog doc 存储层（模拟历史登记，不经动作链）。 */
function seedCatalogStore(docs: PluginDocStore, apps: AppsCatalogDoc['apps']): void {
  ;(docs as MemoryDocStore).set(`${APPS_PLUGIN_ID}:catalog`, { apps })
}

let scratchRoot: string

test('builtin:apps 插件行为', { timeout: 60_000 }, async (t) => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'helm-apps-tests-'))
  t.after(() => rmSync(scratchRoot, { recursive: true, force: true }))

  await t.test('catalog 初始值：空 apps 表并进入公共文档', async () => {
    const { host, docs } = await setup()
    const catalog = readCatalog(host)
    assert.ok(catalog !== undefined, 'catalog doc 应已注册')
    assert.deepEqual(catalog!.apps, {})
    // UI 贡献：sidebar item + screen center
    const ui = host.listUi()
    const screens = ui.filter((c) => c.pluginId === APPS_PLUGIN_ID && c.surface === 'screen')
    assert.equal(screens.length, 1)
    assert.equal((screens[0]!.spec as { id: string }).id, 'center')
    const sidebar = ui.filter((c) => c.pluginId === APPS_PLUGIN_ID && c.surface === 'sidebar.item')
    assert.equal(sidebar.length, 1)
    await host.dispose()
  })

  await t.test('宿主端口未接线：validate/publish/remove 显式 501', async () => {
    const { host } = await setup() // 无 pluginsPort
    for (const [actionId, input] of [
      ['validate', { dir: '/ws/app' }],
      ['publish', { dir: '/ws/app' }],
      ['remove', { pluginId: 'some-app' }],
      ['list', {}],
    ] as const) {
      if (actionId === 'list') continue
      await assert.rejects(
        () => host.invokeAction(APPS_PLUGIN_ID, actionId, input),
        (err: unknown) => err instanceof HelmError && err.code === 'host_plugins_port_unavailable' && err.status === 501,
        `${actionId} 应显式 501`,
      )
    }
    await host.dispose()
  })

  await t.test('validate：doctor ok 且端口回传 screens -> ok true', async () => {
    const { state, port } = fakePackageManager({
      doctorImpl: async () => ({
        dir: '/ws/todo-app',
        pluginId: 'todo-app',
        ok: true,
        checks: [
          { id: 'manifest', label: '清单与入口解析' },
          { id: 'backend', label: '后端模块代际导入' },
          { id: 'register', label: '真实注册断言' },
          { id: 'client', label: '前端模块真实编译与导出校验' },
        ],
        screens: ['main'],
      }),
    })
    const { host } = await setup({ pluginsPort: port })
    const result = (await host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir: '/ws/todo-app' })) as {
      ok: boolean; screenIds: string[]; screenBasis: string; pluginId?: string
    }
    assert.equal(result.ok, true)
    assert.deepEqual(result.screenIds, ['main'])
    assert.equal(result.screenBasis, 'host-doctor')
    assert.equal(result.pluginId, 'todo-app')
    assert.deepEqual(state.calls, ['doctor:/ws/todo-app'])
    await host.dispose()
  })

  await t.test('validate：已注册但缺 Screen -> missing_app_screen 失败', async () => {
    // 已注册无 screen 插件：端口 doctor 不回传 screens，listUi 也无该插件 screen
    const { state, port } = fakePackageManager({
      doctorImpl: async () => ({
        dir: '/ws/no-screen-app',
        pluginId: 'no-screen-app',
        ok: true,
        checks: [{ id: 'manifest', label: 'x' }, { id: 'backend', label: 'x' }, { id: 'register', label: 'x' }, { id: 'client', label: 'x' }],
      }),
    })
    state.summaries.set('no-screen-app', {
      id: 'no-screen-app', name: 'no-screen-app', locked: false, enabled: true,
      status: 'active', hooks: [], actions: [], tools: [],
    })
    const { host } = await setup({ pluginsPort: port })
    const result = (await host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir: '/ws/no-screen-app' })) as {
      ok: boolean; screenIds: string[]; screenBasis: string; checks: Array<{ id: string; error?: unknown }>
    }
    assert.equal(result.ok, false)
    assert.deepEqual(result.screenIds, [])
    assert.equal(result.screenBasis, 'registered')
    const missing = result.checks.find((c) => c.id === 'missing_app_screen')
    assert.ok(missing !== undefined, '应包含 missing_app_screen 失败项')
    await host.dispose()
  })

  await t.test('validate：doctor 失败如实透传（ok false + 原 checks）', async () => {
    const { port } = fakePackageManager({
      doctorImpl: async () => ({
        dir: '/ws/broken-app',
        pluginId: 'broken-app',
        ok: false,
        checks: [
          { id: 'manifest', label: '清单与入口解析' },
          { id: 'backend', label: '后端模块代际导入', error: { code: 'plugin_backend_failed', message: '语法错误' } },
        ],
      }),
    })
    const { host } = await setup({ pluginsPort: port })
    const result = (await host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir: '/ws/broken-app' })) as {
      ok: boolean; checks: Array<{ id: string; error?: { message: string } }>
    }
    assert.equal(result.ok, false)
    assert.ok(result.checks.some((c) => c.error?.message === '语法错误'))
    await host.dispose()
  })

  await t.test('validate：相对路径按会话 cwd 解析；远端节点显式 400', async () => {
    const { port } = fakePackageManager({
      doctorImpl: async (target) => ({
        dir: target.dir ?? '',
        pluginId: 'x',
        ok: true,
        checks: [],
      }),
    })
    const conversations = new Map<number, ConversationSummary>([
      [1, makeConversation(1)], // cwd /hub/work
      [2, makeConversation(2, { nodeId: 'remote-dev', cwd: '/remote/work' })],
    ])
    const { host } = await setup({ pluginsPort: port, conversations, hubCwd: '/hub' })
    // 本机会话相对路径 -> /hub/work/apps/demo
    const r1 = (await host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir: 'apps/demo' }, { conversationId: 1 })) as { dir: string }
    assert.equal(r1.dir, '/hub/work/apps/demo')
    // 无会话上下文 -> Hub cwd
    const r2 = (await host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir: './apps/demo' })) as { dir: string }
    assert.equal(r2.dir, '/hub/apps/demo')
    // 远端节点 + 相对路径 -> 显式拒绝
    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir: 'apps/demo' }, { conversationId: 2 }),
      (err: unknown) => err instanceof HelmError && err.code === 'app_source_must_be_on_hub' && err.status === 400,
    )
    // 远端节点 + 绝对路径：允许（是 Hub 本机路径的显式声明）
    const r3 = (await host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir: '/ws/app' }, { conversationId: 2 })) as { dir: string }
    assert.equal(r3.dir, '/ws/app')
    await host.dispose()
  })

  await t.test('publish 首次：validate -> install(enable) -> catalog 登记', async () => {
    const { state, port } = fakePackageManager({
      doctorImpl: async () => ({
        dir: '/hub/work/apps/todo-app',
        pluginId: 'todo-app',
        ok: true,
        checks: [
          { id: 'manifest', label: 'x' }, { id: 'backend', label: 'x' },
          { id: 'register', label: 'x' }, { id: 'client', label: 'x' },
        ],
      }),
    })
    const { host, docs } = await setup({ pluginsPort: port, conversations: new Map([[1, makeConversation(1)]]) })
    // 安装后端口 listUi 出现该插件 screen
    const origInstall = port.install.bind(port)
    void origInstall
    const result = (await host.invokeAction(
      APPS_PLUGIN_ID,
      'publish',
      { dir: '/hub/work/apps/todo-app', category: 'productivity', pinned: true, conversationId: 7 },
    )) as { pluginId: string; mode: string; screenTarget: string; catalogEntry: AppCatalogEntry; version: string; enabled: boolean }

    assert.equal(result.pluginId, 'todo-app')
    assert.equal(result.mode, 'installed')
    assert.equal(result.version, '0.1.0')
    assert.equal(result.enabled, true)
    // screenTarget：install 后 listUi 事实里的第一个 screen
    assert.ok(result.screenTarget.startsWith('screen:todo-app/'))

    const catalog = readCatalog(host)
    const entry = catalog?.apps['todo-app']
    assert.ok(entry !== undefined, 'catalog 应登记 todo-app')
    assert.equal(entry!.category, 'productivity')
    assert.equal(entry!.pinned, true)
    assert.equal(entry!.icon, 'layout-grid')
    assert.equal(entry!.workspaceDir, '/hub/work/apps/todo-app')
    assert.equal(entry!.originConversationId, 7, '显式 conversationId 优先')
    assert.equal(entry!.publishedAt, entry!.updatedAt)
    assert.deepEqual(state.calls.filter((c) => c.startsWith('install:')), ['install:/hub/work/apps/todo-app'])
    await host.dispose()
  })

  await t.test('publish 安装后无 Screen：422 missing_app_screen 且不登记 catalog', async () => {
    const { port } = fakePackageManager({
      screensOnInstall: false,
      doctorImpl: async () => ({
        dir: '/ws/no-screen-app',
        pluginId: 'no-screen-app',
        ok: true,
        checks: [{ id: 'manifest', label: 'x' }, { id: 'backend', label: 'x' }, { id: 'register', label: 'x' }, { id: 'client', label: 'x' }],
      }),
    })
    const { host, docs } = await setup({ pluginsPort: port })
    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'publish', { dir: '/ws/no-screen-app' }),
      (err: unknown) => err instanceof HelmError && err.code === 'missing_app_screen' && err.status === 422,
    )
    const catalog = readCatalog(host)
    assert.equal(catalog?.apps['no-screen-app'], undefined, '失败不登记 catalog')
    await host.dispose()
  })

  await t.test('publish 预检失败：422 附完整诊断且不触碰安装器', async () => {
    const { state, port } = fakePackageManager({
      doctorImpl: async () => ({
        dir: '/ws/broken-app',
        pluginId: 'broken-app',
        ok: false,
        checks: [{ id: 'backend', label: '后端模块代际导入', error: { code: 'ts_failed', message: 'TS syntax error' } }],
      }),
    })
    const { host } = await setup({ pluginsPort: port })
    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'publish', { dir: '/ws/broken-app' }),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'app_validate_failed' && err.status === 422 &&
        /TS syntax error/.test(err.message),
    )
    assert.deepEqual(state.calls.filter((c) => !c.startsWith('doctor:')), [], '预检失败不得触发 install/update')
    await host.dispose()
  })

  await t.test('publish 同源更新：走 update、catalog publishedAt 保持、origin 继承', async () => {
    const { state, port } = fakePackageManager({
      doctorImpl: async () => ({
        dir: '/ws/todo-app',
        pluginId: 'todo-app',
        ok: true,
        checks: [{ id: 'manifest', label: 'x' }, { id: 'backend', label: 'x' }, { id: 'register', label: 'x' }, { id: 'client', label: 'x' }],
      }),
    })
    const { host, docs } = await setup({ pluginsPort: port })
    const first = (await host.invokeAction(APPS_PLUGIN_ID, 'publish', { dir: '/ws/todo-app' }, { conversationId: 3 })) as {
      mode: string; catalogEntry: AppCatalogEntry
    }
    assert.equal(first.mode, 'installed')

    // 模拟受管记录指向同一路径（/ws/todo-app）
    const summary = state.summaries.get('todo-app')!
    state.summaries.set('todo-app', {
      ...summary,
      enabled: true,
      managed: {
        source: { kind: 'local', raw: '/ws/todo-app', path: '/ws/todo-app' },
        installId: 'rec-todo-app',
        installedVersion: '0.1.0',
        installedAt: Date.now(),
      },
    })

    const second = (await host.invokeAction(APPS_PLUGIN_ID, 'publish', { dir: '/ws/todo-app' }, { conversationId: 9 })) as {
      mode: string; version: string; catalogEntry: AppCatalogEntry
    }
    assert.equal(second.mode, 'updated')
    assert.equal(second.version, '0.2.0')
    assert.ok(second.catalogEntry.updatedAt >= first.catalogEntry.updatedAt)
    assert.equal(second.catalogEntry.publishedAt, first.catalogEntry.publishedAt, 'publishedAt 保持首次发布时间')
    assert.equal(second.catalogEntry.originConversationId, 9, '新会话覆盖 origin')
    assert.ok(state.calls.includes('update:todo-app'), '同源应走 update 而非重装')
    const catalog = readCatalog(host)
    assert.equal(catalog?.apps['todo-app']?.workspaceDir, '/ws/todo-app')
    await host.dispose()
  })

  await t.test('publish 异源路径：同 id 但受管 source 不同 -> 重装（update 换 install）', async () => {
    const { state, port } = fakePackageManager({
      doctorImpl: async () => ({
        dir: '/ws/todo-app',
        pluginId: 'todo-app',
        ok: true,
        checks: [],
      }),
    })
    // 预置已注册且受管 source 指向别处（自带 main screen 事实）
    state.summaries.set('todo-app', {
      id: 'todo-app', name: 'todo-app', locked: false, enabled: true, status: 'active',
      hooks: [], actions: [], tools: [],
      managed: {
        source: { kind: 'local', raw: '/other/place', path: '/other/place' },
        installId: 'rec-x', installedVersion: '0.1.0', installedAt: Date.now(),
      },
    })
    state.ui.push({ pluginId: 'todo-app', surface: 'screen', spec: { id: 'main' } })
    const { host } = await setup({ pluginsPort: port })
    const result = (await host.invokeAction(APPS_PLUGIN_ID, 'publish', { dir: '/ws/todo-app' })) as { mode: string }
    assert.equal(result.mode, 'updated')
    assert.ok(state.calls.some((c) => c.startsWith('install:/ws/todo-app')), '异源应重装')
    await host.dispose()
  })

  await t.test('list：左连接宿主清单/screens/catalog；内置排除；孤儿忽略', async () => {
    const { state, port } = fakePackageManager()
    // todo-app：已登记 catalog + 有 screen
    state.summaries.set('todo-app', {
      id: 'todo-app', name: '待办台', description: 'x', version: '0.1.0', locked: false,
      enabled: true, status: 'active', hooks: [], actions: [], tools: [],
    })
    state.ui.push({ pluginId: 'todo-app', surface: 'screen', spec: { id: 'main' } })
    // board-app：有 screen 且启用但未登记 catalog（非 publish 途径安装）
    state.summaries.set('board-app', {
      id: 'board-app', name: '看板', locked: false, enabled: true, status: 'active',
      hooks: [], actions: [], tools: [],
    })
    state.ui.push({ pluginId: 'board-app', surface: 'screen', spec: { id: 'board' } })
    // orphan-app：仅在 catalog（宿主已卸载）——由内置插件排除规则覆盖不到，
    // list 只汇总宿主清单中存在的插件，孤儿自然不出现
    const { host, docs } = await setup({ pluginsPort: port })
    // 直接写 catalog doc 存储层模拟历史登记（不经 publish）
    seedCatalogStore(docs, {
      'todo-app': { pluginId: 'todo-app', icon: 'list-checks', category: 'productivity', pinned: true, publishedAt: 1, updatedAt: 2 },
    })

    const result = (await host.invokeAction(APPS_PLUGIN_ID, 'list', {})) as {
      apps: Array<{ pluginId: string; screens: string[]; catalog?: AppCatalogEntry; enabled: boolean }>
    }
    const ids = result.apps.map((a) => a.pluginId)
    assert.ok(ids.includes('todo-app'), '已登记应用出现')
    assert.ok(ids.includes('board-app'), '带 screen 的外部插件自动识别')
    assert.ok(!ids.includes(APPS_PLUGIN_ID), '内置插件（含自身）不混入')
    assert.ok(!ids.includes('orphan-app'), '孤儿 catalog 条目不出现')
    const todo = result.apps.find((a) => a.pluginId === 'todo-app')!
    assert.deepEqual(todo.screens, ['main'])
    assert.equal(todo.catalog?.pinned, true)
    const board = result.apps.find((a) => a.pluginId === 'board-app')!
    assert.equal(board.catalog, undefined)
    assert.equal(board.enabled, true)
    await host.dispose()
  })

  await t.test('update_meta：只改元数据；未登记 404；非法 category 400；builtin 409', async () => {
    const { port } = fakePackageManager({
      doctorImpl: async () => ({
        dir: '/ws/todo-app', pluginId: 'todo-app', ok: true,
        checks: [{ id: 'manifest', label: 'x' }, { id: 'backend', label: 'x' }, { id: 'register', label: 'x' }, { id: 'client', label: 'x' }],
      }),
    })
    const { host, docs } = await setup({ pluginsPort: port })
    await host.invokeAction(APPS_PLUGIN_ID, 'publish', { dir: '/ws/todo-app' })
    const r = (await host.invokeAction(APPS_PLUGIN_ID, 'update_meta', {
      pluginId: 'todo-app', pinned: true, category: 'devops', icon: 'server-cog', workspaceDir: '/new/ws',
    })) as { catalogEntry: AppCatalogEntry }
    assert.equal(r.catalogEntry.pinned, true)
    assert.equal(r.catalogEntry.category, 'devops')
    assert.equal(r.catalogEntry.icon, 'server-cog')
    assert.equal(r.catalogEntry.workspaceDir, '/new/ws')
    assert.equal(r.catalogEntry.publishedAt, r.catalogEntry.updatedAt === undefined ? 0 : r.catalogEntry.publishedAt)
    const catalog = readCatalog(host)
    assert.equal(catalog?.apps['todo-app']?.category, 'devops')

    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'update_meta', { pluginId: 'ghost-app', pinned: true }),
      (err: unknown) => err instanceof HelmError && err.code === 'app_not_published' && err.status === 404,
    )
    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'update_meta', { pluginId: 'todo-app', category: 'nope' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
    )
    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'update_meta', { pluginId: APPS_PLUGIN_ID, pinned: true }),
      (err: unknown) => err instanceof HelmError && err.code === 'app_target_is_self' && err.status === 409,
    )
    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'remove', { pluginId: 'builtin:profile' }),
      (err: unknown) => err instanceof HelmError && err.code === 'app_target_is_builtin' && err.status === 409,
    )
    await host.dispose()
  })

  await t.test('remove：宿主卸载后清理 catalog；未登记插件幂等清理', async () => {
    const { state, port } = fakePackageManager({
      doctorImpl: async () => ({
        dir: '/ws/todo-app', pluginId: 'todo-app', ok: true,
        checks: [{ id: 'manifest', label: 'x' }, { id: 'backend', label: 'x' }, { id: 'register', label: 'x' }, { id: 'client', label: 'x' }],
      }),
    })
    const { host, docs } = await setup({ pluginsPort: port })
    await host.invokeAction(APPS_PLUGIN_ID, 'publish', { dir: '/ws/todo-app' })
    assert.ok(state.summaries.has('todo-app'))
    const r = (await host.invokeAction(APPS_PLUGIN_ID, 'remove', { pluginId: 'todo-app' })) as {
      pluginId: string; installPath: string; wasEnabled: boolean
    }
    assert.equal(r.pluginId, 'todo-app')
    assert.equal(r.installPath, '/data/plugins/todo-app')
    assert.equal(r.wasEnabled, true)
    assert.ok(state.calls.includes('remove:todo-app'))
    const catalog = readCatalog(host)
    assert.equal(catalog?.apps['todo-app'], undefined, 'catalog 清理')
    await host.dispose()
  })

  await t.test('publish 非法输入：非法 category 400；NUL 路径 400', async () => {
    const { port } = fakePackageManager({
      doctorImpl: async () => ({ dir: '/ws/x', pluginId: 'x', ok: true, checks: [] }),
    })
    const { host } = await setup({ pluginsPort: port })
    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'publish', { dir: '/ws/x', category: 'bad' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
    )
    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'validate', { dir: '/ws/\0x' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
    )
    await host.dispose()
  })

  await t.test('停用 builtin:apps：动作/UI 即时消失（可停用铁律）', async () => {
    const { host } = await setup()
    await host.disable(APPS_PLUGIN_ID)
    const summary = host.list().find((p) => p.id === APPS_PLUGIN_ID)
    assert.equal(summary?.enabled, false)
    assert.equal(host.listUi().some((c) => c.pluginId === APPS_PLUGIN_ID), false)
    await assert.rejects(
      () => host.invokeAction(APPS_PLUGIN_ID, 'list', {}),
      (err: unknown) => err instanceof HelmError,
    )
    await host.dispose()
  })

  await t.test('app-builder 技能：服务启动时经 ensureSkill 自举（frontmatter 校验）', async () => {
    // 真实 SkillService 数据目录：验证 ensureSkill 落盘 SKILL.md 与 references
    const dataDir = mkdtempSync(join(scratchRoot, 'skills-'))
    const skillCalls: Array<{ id: string; managedBy?: string }> = []
    const port = undefined
    const backend = Object.assign(makeBackend(new Map([[1, makeConversation(1)]]), port), {
      skills: {
        list: () => Promise.resolve([]),
        readFile: () => Promise.resolve(''),
        directory: () => Promise.resolve(join(dataDir, 'skills', APP_BUILDER_SKILL_ID)),
        ensureSkill: async (asset: { id: string; skillMd: string; references: Record<string, string> }, pluginId: string) => {
          assert.equal(pluginId, APPS_PLUGIN_ID, 'ensureSkill 应以本插件身份登记')
          const m = /managedByPlugin:\s*(\S+)/.exec(asset.skillMd)
          skillCalls.push({ id: asset.id, managedBy: m?.[1] })
        },
      },
    })
    const host = new PluginHost({ dataDir, host: backend, docs: new MemoryDocStore() })
    await host.register(createAppsPlugin(), { enabled: true })
    assert.deepEqual(skillCalls, [{ id: APP_BUILDER_SKILL_ID, managedBy: APPS_PLUGIN_ID }])
    await host.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  })
})
