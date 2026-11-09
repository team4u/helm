/**
 * builtin:herdr 插件 client.tsx 轨道测试：真实编译 + 插件定义契约。
 *
 * 覆盖：
 * - 真实 esbuild 编译 client/index.tsx 成功，产物含 HerdrOverviewScreen 具名导出
 *   与样式文本导出（styles.css 随依赖闭包合并）；
 * - createHerdrPlugin 定义注册 screen（client 引用）与 profileRuntime（kind: herdr，
 *   23 种 CLI 候选）后，PluginHost.listUi 如实产出；
 * - 停用插件后 listUi 不再包含其贡献（UI 即时消失，无残留）。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmError, type ConversationSummary } from '@helm/protocol'
import { PluginHost, type PluginHostBackend, type PluginDocStore } from '../src/plugins/index.js'
import { compilePluginClientModule } from '../src/plugins/client-compiler.js'
import { createHerdrPlugin } from '../src/builtin-plugins/herdr.js'
import type { HerdrPluginDependencies } from '../src/builtin-plugins/herdr/contracts.js'

let dataDir: string
let pluginHost: PluginHost

function summary(id: number): ConversationSummary {
  return {
    id, title: `conv-${id}`, profileId: 'assistant', tags: [], cwd: '/tmp', model: '', thinkingLevel: '',
    status: 'idle', stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 1, updatedAt: 1,
  }
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  async flush(): Promise<void> {}
}

function makeBackend(): PluginHostBackend {
  return {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => summary(42),
    listConversations: () => [summary(1)],
    getConversation: (id: number) => {
      throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    },
    updateConversation: async (id: number) => summary(id),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    abortConversation: async () => {},
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    cleanupWorktree: async () => ({ removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false }),
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    listActions: () => [],
    emitEvent: () => {},
  }
}

function makeDeps(): HerdrPluginDependencies {
  return {
    defaultCwd: '/tmp',
    profiles: { get: async () => undefined },
    buildSpawnEnv: () => ({}),
    redact: (text: string) => text,
    runLocalGate: async () => ({ ok: true, output: '' }),
    getArtifact: async () => {
      throw new HelmError('not_found', '无产物', 404)
    },
    blockedBackoffBaseMs: 5,
    blockedBackoffCapMs: 20,
    pollIntervalMs: 5,
  }
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helm-herdr-client-'))
  pluginHost = new PluginHost({ dataDir, host: makeBackend(), docs: new MemoryDocStore() })
})

after(async () => {
  await pluginHost.dispose().catch(() => {})
  await rm(dataDir, { recursive: true, force: true })
})

test('client/index.tsx 真实编译：产物含 HerdrOverviewScreen 导出与样式文本', { timeout: 60_000 }, async () => {
  const definition = createHerdrPlugin(makeDeps())
  assert.ok(definition.clientRoot, '插件定义必须提供 clientRoot')
  const { code, contentHash } = await compilePluginClientModule('builtin:herdr', definition.clientRoot!, 'index.tsx', dataDir)
  assert.ok(typeof code === 'string' && code.length > 0, '编译产物非空')
  assert.ok(code.includes('HerdrOverviewScreen'), '产物含 HerdrOverviewScreen 具名导出')
  // styles.css 经 esbuild 原生 CSS bundling 合并为 __helmClientCss 导出
  assert.ok(code.includes('__helmClientCss'), '产物含样式文本导出 __helmClientCss')
  assert.ok(contentHash.length > 0, '内容 hash 非空')
})

test('模型函数：筛选 / 统计 / 参数解析纯函数（models.ts 编译产物导入）', { timeout: 60_000 }, async () => {
  const definition = createHerdrPlugin(makeDeps())
  const cacheDir = await mkdtemp(join(tmpdir(), 'helm-herdr-models-'))
  try {
    const { code } = await compilePluginClientModule('builtin:herdr', definition.clientRoot!, 'models.ts', cacheDir)
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)) as Record<string, unknown>
    const parseFilters = mod['parseFilters'] as (p: Record<string, string>) => Record<string, string>
    const filtersToParamsPatch = mod['filtersToParamsPatch'] as (f: Record<string, string>) => Record<string, string | undefined>
    const filterPanes = mod['filterPanes'] as (p: unknown[], f: unknown) => unknown[]
    const computeStats = mod['computeStats'] as (p: unknown[], n: string[]) => Record<string, number>
    const parseManagedMap = mod['parseManagedMap'] as (r: unknown) => Record<string, number>
    const parseReadText = mod['parseReadText'] as (r: unknown) => string
    const suggestions = mod['HERDR_AGENT_SUGGESTIONS'] as string[]

    // 深链参数解析：非法值回退 all
    assert.deepEqual(
      parseFilters({ node: 'remote-1', owner: 'helm', status: 'bogus' }),
      { node: 'remote-1', owner: 'helm', status: 'all' },
    )

    // patch：'all' 以 undefined 清除（URL 最小化）
    assert.deepEqual(
      filtersToParamsPatch({ node: 'all', owner: 'helm', status: 'all' }),
      { node: undefined, owner: 'helm', status: undefined },
    )

    // 筛选：node/owner/status 三维 AND
    const panes = [
      { nodeId: 'local', paneId: 'p1', ownedBy: 'helm', agentStatus: 'working' },
      { nodeId: 'remote', paneId: 'p2', ownedBy: 'human', agentStatus: 'idle' },
      { nodeId: 'remote', paneId: 'p3', ownedBy: 'helm', agentStatus: 'blocked' },
    ]
    assert.equal(filterPanes(panes, { node: 'remote', owner: 'all', status: 'all' }).length, 2)
    assert.deepEqual(computeStats(panes, ['local', 'remote']), { total: 3, working: 1, blocked: 1, nodes: 2 })

    // list 动作结果解析：paneKey -> parentConversationId（非法值忽略，不伪造）
    assert.deepEqual(
      parseManagedMap({
        panes: [
          { paneId: 'p1', nodeId: 'local', parentConversationId: 7 },
          { paneId: 'p2', nodeId: 'remote', parentConversationId: 'not-a-number' },
        ],
      }),
      { 'local:p1': 7 },
    )

    // read 结果解析：text 字段直取，缺失时 JSON 序列化兜底（不伪造空串）
    assert.equal(parseReadText({ text: 'tail' }), 'tail')
    assert.equal(parseReadText({ noText: 1 }), '{"noText":1}')

    // 23 种 CLI 候选完整（Herdr detect::agent_label 全集）
    assert.equal(suggestions.length, 23)
    assert.ok(suggestions.includes('agy') && suggestions.includes('pi'))
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('插件注册：screen client 引用与 profileRuntime 贡献如实进入 listUi', { timeout: 60_000 }, async () => {
  await pluginHost.register(createHerdrPlugin(makeDeps()), { enabled: true })
  const ui = pluginHost.listUi()
  const screen = ui.find((u) => u.surface === 'screen' && (u.spec as { id: string }).id === 'overview')
  assert.ok(screen, 'overview screen 贡献存在')
  assert.deepEqual((screen!.spec as { client?: unknown }).client, { module: 'index.tsx', export: 'HerdrOverviewScreen' })

  const runtime = ui.find((u) => u.surface === 'profile.runtime')
  assert.ok(runtime, 'profile.runtime 贡献存在')
  const runtimeSpec = runtime!.spec as { kind: string; label: string; agentSuggestions?: string[] }
  assert.equal(runtimeSpec.kind, 'herdr')
  assert.equal(runtimeSpec.label, '外部 Herdr 运行时')
  assert.equal(runtimeSpec.agentSuggestions?.length, 23)

  const sidebar = ui.find((u) => u.surface === 'sidebar.item' && (u.spec as { id: string }).id === 'herdr')
  assert.ok(sidebar, 'sidebar.item 贡献存在')
})

test('停用后 UI 贡献即时消失', { timeout: 60_000 }, async () => {
  await pluginHost.disable('builtin:herdr')
  const ui = pluginHost.listUi()
  assert.equal(ui.some((u) => u.pluginId === 'builtin:herdr'), false, '停用后不残留任何 UI 贡献')
})
