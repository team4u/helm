/**
 * builtin:profile 跨 Profile 协作目录测试（真 PluginHost + 真 ProfileService
 * + 真文件系统；不 mock 计算结果）。
 *
 * 覆盖：
 * - 纯函数：SYSTEM.md 摘要提取（frontmatter/代码块/标题跳过、转义、码点截断）、
 *   目录排除规则（自身/humanSelectable/托管插件停用/runtime 无接管）、
 *   位置展示继承语义、目录 XML 渲染转义与 runtime 标注；
 * - 集成（真实 PluginHost）：before_turn 目录注入（fork/worker 类子会话同样
 *   注入、无派工工具不注入、工具剥离后不注入——模拟默认优先级钩子先剥离
 *   subagent）、
 *   workflow 插件停用/启用对目录的影响、候选增删改实时生效、
 *   候选 SYSTEM 缺失不告警不伪造、候选 IO 错误显式上抛；
 * - 动作契约：list_mentionable 幂等补全（上下文会话身份不可被 body 伪造、
 *   显式 conversationId 校验、query 过滤、不再按父链排除子会话、schema 输出校验）、
 *   composerCompleter 声明进入 listUi 且停用即消失。
 * runner: tsx --test；每项 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  type ConversationSummary,
  type PluginDefinition,
  type PluginUiContribution,
  type Profile,
} from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import { ProfileService } from '../src/services/index.js'
import { createProfileFileHost } from './helpers/profile-file-host.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { createProfilePlugin } from '../src/builtin-plugins/profile.js'
import {
  PROFILE_SUMMARY_MAX_CODEPOINTS,
  activeRuntimeKinds,
  describeHint,
  describePosition,
  extractSystemSummary,
  isCollaborationCandidate,
  renderProfileCatalogSection,
  toCatalogEntry,
  truncateCodePoints,
} from '../src/builtin-plugins/profile/catalog.js'
import { createWorkflowPlugin } from '../src/builtin-plugins/workflow.js'

// ---------------------------------------------------------------------------
// 测试基建
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

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  const now = Date.now()
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

interface ControlledBackend extends PluginHostBackend {
  conversations: Map<number, ConversationSummary>
  notifications: Array<{ title: string; body: string; level: string }>
}

class MemorySessionDocStore {
  readonly store = new Map<string, string>()
  get(_pluginId: string, name: string, conversationId: number): string | undefined {
    return this.store.get(`${name}\0${conversationId}`)
  }
  put(_pluginId: string, name: string, conversationId: number, valueJson: string): void {
    this.store.set(`${name}\0${conversationId}`, valueJson)
  }
  delete(_pluginId: string, name: string, conversationId: number): void {
    this.store.delete(`${name}\0${conversationId}`)
  }
  listConversationIds(): number[] {
    return []
  }
  async flush(): Promise<void> {}
}

function makeControlledBackend(): ControlledBackend {
  const conversations = new Map<number, ConversationSummary>()
  conversations.set(1, makeConversation(1))
  const notifications: Array<{ title: string; body: string; level: string }> = []
  const backend: ControlledBackend = {
    ...createPluginHostBackendFixture(),
    conversations,
    notifications,
    async dispatchTrigger() {},
    async submitInput() {},
    async createConversation(init) {
      const id = Math.max(0, ...conversations.keys()) + 1
      const summary = makeConversation(id, {
        title: init.title ?? 'new',
        profileId: init.profileId ?? 'assistant',
        ...(init.parentConversationId !== undefined ? { parentConversationId: init.parentConversationId } : {}),
      })
      conversations.set(id, summary)
      return summary
    },
    listConversations() {
      return [...conversations.values()]
    },
    getConversation(id) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      return found
    },
    async updateConversation(id, patch) {
      const found = conversations.get(id)
      if (!found) throw new HelmError('not_found', `会话不存在：${id}`, 404)
      const next = { ...found, ...patch }
      conversations.set(id, next)
      return next
    },
    manageConversation() {
      return () => {}
    },
    markConversationOwnership() {},
    async createAsk() {
      throw new HelmError('unsupported', 'test', 400)
    },
    async cancelAsk() {},
    registerAskSeqResolver() {
      return () => {}
    },
    onEvent() {
      return () => {}
    },
    async abortConversation() {},
    async spawnAgent() {
      return {}
    },
    async runGate() {
      return { ok: true, output: '' }
    },
    async prepareInterruptedConversations() {},
    async invokeAction() {
      return {}
    },
    prepareAction() {
      return { idempotent: false }
    },
    async execEnv() {
      throw new HelmError('unsupported', 'fixture', 501)
    },
    listActions() {
      return []
    },
    emitEvent(type, payload) {
      if (type === 'notification') notifications.push(payload as { title: string; body: string; level: string })
    },
  }
  return backend
}

/** 声明 profile.runtime UI 贡献的第三方运行时插件（kind 通用，不假设插件 id）。 */
function makeRuntimePlugin(id: string, kind: string): PluginDefinition {
  return {
    id,
    name: `runtime ${kind}`,
    definePlugin(ctx) {
      ctx.ui.profileRuntime({ id: kind, kind, label: `外部 ${kind} 运行时` })
    },
  }
}

/** 默认优先级剥离派工工具的钩子插件（模拟路由模式收敛后无派工工具）。 */
function makeToolStripperPlugin(names: string[]): PluginDefinition {
  const strip = new Set(names)
  return {
    id: 'test:tool-stripper',
    name: 'tool stripper',
    definePlugin(ctx) {
      ctx.hook.onBeforeTurn((turn) => {
        const tools = turn.tools.filter((t) => !strip.has(t.name))
        return { action: 'transform', value: { ...turn, tools } }
      })
    },
  }
}

function tool(name: string) {
  return { name, description: name, inputSchema: { type: 'object' as const } }
}

interface Env {
  dataDir: string
  host: PluginHost
  backend: ControlledBackend
  profiles: ProfileService
  close(): Promise<void>
}

async function makeEnv(extraPlugins: PluginDefinition[] = [], withSessionDocs = false): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-profile-collab-'))
  const profiles = new ProfileService(dataDir)
  await profiles.ensureDefault()
  const backend = Object.assign(makeControlledBackend(), createProfileFileHost(dataDir, profiles))
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
    ...(withSessionDocs ? { sessionDocs: new MemorySessionDocStore() } : {}),
  })
  await host.register(createProfilePlugin(), { enabled: true })
  for (const plugin of extraPlugins) await host.register(plugin, { enabled: true })
  return {
    dataDir,
    host,
    backend,
    profiles,
    async close() {
      await host.dispose().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** 写候选 Profile（真实 ProfileService 落盘）+ SYSTEM.md。 */
async function seedProfile(
  profiles: ProfileService,
  dataDir: string,
  input: Partial<Profile> & { id: string },
  systemMd?: string,
): Promise<void> {
  await profiles.save({ humanSelectable: true, tags: [], ...input } as never)
  if (systemMd !== undefined) {
    writeFileSync(join(dataDir, 'profiles', input.id, 'SYSTEM.md'), systemMd)
  }
}

// ---------------------------------------------------------------------------
// 纯函数：SYSTEM.md 摘要提取
// ---------------------------------------------------------------------------

test('extractSystemSummary：跳过 frontmatter / 代码块 / 标题，取首个自然段', () => {
  const md = [
    '---',
    'name: 秘密元数据',
    'secret: 不应出现在摘要',
    '---',
    '# 角色标题',
    '',
    '数据库迁移专家，专注 PostgreSQL 与大数据量表结构演进。',
    '第二行同段落也会折叠。',
    '',
    '后续段落不取。',
  ].join('\n')
  const summary = extractSystemSummary(md)
  assert.equal(summary, '数据库迁移专家，专注 PostgreSQL 与大数据量表结构演进。 第二行同段落也会折叠。')
  assert.ok(!summary!.includes('秘密元数据'), 'frontmatter 不进入摘要')
  assert.ok(!summary!.includes('角色标题'), '标题行不进入摘要')
})

test('extractSystemSummary：围栏代码块与列表/引用/HTML 行跳过', () => {
  const md = [
    '```yaml',
    '# 代码内的伪标题',
    'db: config',
    '```',
    '- 列表项不是自然段',
    '> 引用行也不是',
    '<div>html 标签行跳过</div>',
    '| 表格 | 行 |',
    '真正的自然段在这里。',
  ].join('\n')
  assert.equal(extractSystemSummary(md), '真正的自然段在这里。')
})

test('extractSystemSummary：无自然段返回 undefined（不伪造）', () => {
  assert.equal(extractSystemSummary('# 只有标题\n\n---\nfrontmatter 未闭合也安全'), undefined)
  assert.equal(extractSystemSummary(''), undefined)
  assert.equal(extractSystemSummary('   \n\n'), undefined)
  assert.equal(extractSystemSummary('```\nall code\n```'), undefined)
})

test('extractSystemSummary 与 truncateCodePoints：100 码点截断（代理对计 1）', () => {
  const long = '首段 ' + '字'.repeat(200)
  const summary = extractSystemSummary(long)!
  assert.ok([...summary].length <= PROFILE_SUMMARY_MAX_CODEPOINTS)
  assert.ok(summary.endsWith('…'), '截断加省略号')
  const emoji = '😀'.repeat(150) // 代理对
  assert.equal([...truncateCodePoints(emoji, 10)].length, 10)
  assert.equal(truncateCodePoints('short', 100), 'short')
})

// ---------------------------------------------------------------------------
// 纯函数：目录排除规则与渲染
// ---------------------------------------------------------------------------

const RUNTIME_KINDS = new Set(['herdr'])

test('isCollaborationCandidate：排除自身 / humanSelectable:false / 托管插件停用 / runtime 无接管', () => {
  const base = { id: 'coder', name: 'Coder' } as Profile
  assert.equal(isCollaborationCandidate({ ...base, id: 'assistant' }, 'assistant', new Set(), RUNTIME_KINDS), false, '排除自身')
  assert.equal(isCollaborationCandidate({ ...base, humanSelectable: false }, 'assistant', new Set(), RUNTIME_KINDS), false)
  assert.equal(
    isCollaborationCandidate({ ...base, managedByPlugin: 'builtin:superagent' }, 'assistant', new Set(), RUNTIME_KINDS),
    false,
    '托管插件未启用',
  )
  assert.equal(
    isCollaborationCandidate({ ...base, managedByPlugin: 'builtin:superagent' }, 'assistant', new Set(['builtin:superagent']), RUNTIME_KINDS),
    true,
    '托管插件已启用',
  )
  assert.equal(
    isCollaborationCandidate({ ...base, runtime: { kind: 'herdr', agent: 'agy' } }, 'assistant', new Set(), new Set<string>()),
    false,
    'runtime.kind 无接管贡献',
  )
  assert.equal(
    isCollaborationCandidate({ ...base, runtime: { kind: 'herdr', agent: 'agy' } }, 'assistant', new Set(), RUNTIME_KINDS),
    true,
    'runtime.kind 已有接管贡献',
  )
  assert.equal(isCollaborationCandidate(base, 'assistant', new Set(), RUNTIME_KINDS), true, '普通 Profile 通过')
})

test('activeRuntimeKinds：只认 profile.runtime surface 的 kind 字符串', () => {
  const ui: PluginUiContribution[] = [
    { pluginId: 'builtin:herdr', surface: 'profile.runtime', spec: { kind: 'herdr', label: 'x' } },
    { pluginId: 'p2', surface: 'profile.runtime', spec: { kind: 'other', label: 'y' } },
    { pluginId: 'p3', surface: 'screen', spec: { kind: 'not-a-runtime' } },
    { pluginId: 'p4', surface: 'profile.runtime', spec: { label: 'kind 缺失' } },
  ]
  assert.deepEqual([...activeRuntimeKinds(ui)].sort(), ['herdr', 'other'])
})

test('toCatalogEntry：runtime 标注与 workspace 覆盖 cwd；describePosition 继承语义', () => {
  const native = toCatalogEntry({ id: 'coder', name: 'Coder' } as Profile)
  assert.equal(native.runtimeKind, 'native')
  assert.equal(describePosition(native), undefined, '无显式配置 → 继承（不谎报 local）')

  const external = toCatalogEntry({
    id: 'ops',
    name: 'Ops',
    nodeId: 'node-a',
    cwd: '/top/cwd',
    runtime: { kind: 'herdr', agent: 'agy', workspace: '/ws/override' },
  } as Profile)
  assert.equal(external.runtimeKind, 'herdr')
  assert.equal(external.cwd, '/ws/override', 'runtime.workspace 覆盖顶层 cwd')
  assert.equal(describePosition(external), 'node-a · /ws/override')

  const nodeOnly = toCatalogEntry({ id: 'n', name: 'N', nodeId: 'node-b' } as Profile)
  assert.equal(describePosition(nodeOnly), 'node-b · 继承当前会话目录', '部分显式时明确标注继承项')
  assert.ok(describeHint({ ...nodeOnly, summary: undefined }).includes('node-b'), 'hint 含显式节点')
  assert.ok(
    describeHint({ id: 'p', name: 'P', runtimeKind: 'native', summary: undefined }).includes(
      '继承当前会话节点与目录',
    ),
    '全继承时 hint 明确标注',
  )
})

test('renderProfileCatalogSection：动态字段 XML 转义 + runtime 标注 + 边界指引', () => {
  const section = renderProfileCatalogSection(
    [
      { id: 'coder', name: 'C&A<>"', runtimeKind: 'native', summary: '专&注<迁移>' },
      { id: 'ops', name: 'Ops', runtimeKind: 'herdr', nodeId: 'node-a', cwd: '/ws' },
    ],
    { dispatchToolNames: ['subagent'] },
  )
  assert.ok(section.includes('id="coder" name="C&amp;A&lt;&gt;&quot;"'))
  assert.ok(section.includes('专&amp;注&lt;迁移&gt;'), '摘要正文转义')
  assert.ok(section.includes('runtime="native"'))
  assert.ok(section.includes('runtime="external:herdr"'))
  assert.ok(section.includes('at="node-a · /ws"'))
  assert.ok(section.includes('不自动读取对方 SYSTEM/MEMORY 全文'))
  assert.ok(section.includes('当前会话有权使用的产物'))
  assert.ok(section.includes('没有自动文件同步'))
  assert.ok(section.includes('external 运行时生命周期由其插件管理'))
  assert.ok(!/\p{Extended_Pictographic}/u.test(section), '无 Emoji')

  const noTools = renderProfileCatalogSection([{ id: 'x', name: 'X', runtimeKind: 'native' }], {
    dispatchToolNames: [],
  })
  assert.ok(noTools.includes('本回合无派工工具'))
})

// ---------------------------------------------------------------------------
// 集成：before_turn 目录注入
// ---------------------------------------------------------------------------

test('before_turn：顶层 + 有派工工具时注入 profile.catalog；候选实时重读', { timeout: 60_000 }, async () => {
  const env = await makeEnv([createWorkflowPlugin()], true)
  try {
    await seedProfile(env.profiles, env.dataDir, { id: 'coder', name: '编码专家' }, '# Coder\n\n擅长重构与测试。')
    const turn = {
      conversation: makeConversation(1),
      sections: [],
      tools: [tool('subagent'), tool('SubagentWorkflow')],
      inputs: [],
      messages: [],
    }
    const result = await env.host.runHook('before_turn', turn as never)
    assert.ok(result.action === 'transform')
    const catalog = sectionsOf(result, turn).find((s) => s.id === 'profile.catalog')
    assert.ok(catalog, '顶层且有派工工具 → 注入目录')
    assert.ok(catalog.text.includes('id="coder"'))
    assert.ok(catalog.text.includes('擅长重构与测试'), '候选 SYSTEM 摘要进入目录')
    assert.ok(!catalog.text.includes('id="assistant"'), '排除自身')

    // 增删改实时生效：删 coder、加 ops
    await env.profiles.delete('coder')
    await seedProfile(env.profiles, env.dataDir, { id: 'ops', name: '运维' }, '# Ops\n外部执行。')
    const again = await env.host.runHook('before_turn', { ...turn, sections: [] } as never)
    const againCatalog = sectionsOf(again, turn).find((s) => s.id === 'profile.catalog')
    if (againCatalog === undefined) throw new Error('增删改后应保留 profile.catalog')
    assert.ok(againCatalog.text.includes('id="ops"'))
    assert.ok(!againCatalog.text.includes('id="coder"'), '删除的候选下次回合消失')
  } finally {
    await env.close()
  }
})

test('before_turn：子会话不再一刀切排除；无派工工具不注入（workflow 停用 / 工具被剥离）', { timeout: 60_000 }, async () => {
  const env = await makeEnv([createWorkflowPlugin()], true)
  try {
    await seedProfile(env.profiles, env.dataDir, { id: 'coder', name: '编码' })
    const parentTurn = {
      conversation: makeConversation(1),
      sections: [],
      tools: [tool('subagent')],
      inputs: [],
      messages: [],
    }
    // 顶层有工具 → 注入
    const topLevel = await env.host.runHook('before_turn', parentTurn as never)
    assert.ok(sectionsOf(topLevel, parentTurn).some((s) => s.id === 'profile.catalog'))

    // 子会话（parentConversationId 存在，如 fork / SuperAgent worker）有工具同样
    // 注入：不再按父链一刀切（真正子代理由 builtin:workflow 钩子剥离工具后
    // 在此自然不注入）。
    const subTurn = {
      ...parentTurn,
      conversation: makeConversation(2, { parentConversationId: 1 }),
    }
    const sub = await env.host.runHook('before_turn', subTurn as never)
    assert.ok(sectionsOf(sub, subTurn).some((s) => s.id === 'profile.catalog'), 'fork/worker 类子会话同样注入（不再父链一刀切）')

    // 顶层但派工工具被默认优先级钩子剥离（模拟路由模式收敛）→ 低优先级目录钩子看到最终清单，不注入
    const stripperEnv = await makeEnv([createWorkflowPlugin(), makeToolStripperPlugin(['subagent', 'SubagentWorkflow'])], true)
    try {
      const stripped = await stripperEnv.host.runHook('before_turn', parentTurn as never)
      assert.ok(
        !sectionsOf(stripped, parentTurn).some((s) => s.id === 'profile.catalog'),
        '工具剥离后不注入（不教唆幻影工具）',
      )
    } finally {
      await stripperEnv.close()
    }

    // builtin:workflow 停用 → listTools 不再含派工工具 → 按实际清单不注入
    await env.host.disable('builtin:workflow')
    const noWorkflowTurn = { ...parentTurn, sections: [], tools: dispatchToolsOf(env.host) }
    const noWorkflow = await env.host.runHook('before_turn', noWorkflowTurn as never)
    assert.ok(!sectionsOf(noWorkflow, noWorkflowTurn).some((s) => s.id === 'profile.catalog'), 'workflow 停用不注入')

    // 重新启用 → 恢复注入（启停下次回合生效）
    await env.host.enable('builtin:workflow')
    const reEnabledTurn = { ...parentTurn, sections: [], tools: dispatchToolsOf(env.host) }
    const reEnabled = await env.host.runHook('before_turn', reEnabledTurn as never)
    assert.ok(sectionsOf(reEnabled, reEnabledTurn).some((s) => s.id === 'profile.catalog'), '重新启用恢复注入')
  } finally {
    await env.close()
  }
})

/** 从真实 PluginHost.listTools 派生本回合工具清单（启停即时反映，不手造幻影）。 */
function dispatchToolsOf(host: PluginHost): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return host.listTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }))
}

interface TurnLike {
  conversation: ConversationSummary
  sections: Array<{ id: string; text: string }>
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  inputs: unknown[]
  messages: Array<Record<string, unknown>>
}

/** 提取钩子链后的最终 sections（continue 时用原 turn sections，不断言 transform）。 */
function sectionsOf(result: { action: string; value?: unknown }, turn: TurnLike): Array<{ id: string; text: string }> {
  return result.action === 'transform' ? (result.value as TurnLike).sections : turn.sections
}

test('before_turn：托管插件停用隐藏其 Profile；runtime 无接管贡献不进目录', { timeout: 60_000 }, async () => {
  const runtimePlugin = makeRuntimePlugin('test:rt', 'customrt')
  const env = await makeEnv([runtimePlugin, createWorkflowPlugin()], true)
  try {
    await seedProfile(env.profiles, env.dataDir, {
      id: 'custom-worker',
      name: '自定义运行时工人',
      managedByPlugin: 'test:rt',
      runtime: { kind: 'customrt', agent: 'cli-x' },
    })
    await seedProfile(env.profiles, env.dataDir, {
      id: 'orphan-rt',
      name: '无接管运行时',
      runtime: { kind: 'noplugin', agent: 'cli-y' },
    })
    const turn = {
      conversation: makeConversation(1),
      sections: [],
      tools: [tool('subagent')],
      inputs: [],
      messages: [],
    }
    const first = await env.host.runHook('before_turn', turn as never)
    const catalog = sectionsOf(first, turn).find((s) => s.id === 'profile.catalog')
    if (catalog === undefined) throw new Error('启用runtime Profile后应保留profile.catalog')
    assert.ok(catalog.text.includes('id="custom-worker"'), '接管插件启用的 runtime Profile 进入目录')
    assert.ok(catalog.text.includes('runtime="external:customrt"'))
    assert.ok(!catalog.text.includes('orphan-rt'), '无接管贡献的 runtime Profile 不进目录（不误导原生调用）')

    // 接管插件停用：托管 Profile 随之隐藏；仅剩被排除的 orphan 后目录为空 → 不再注入。
    // （custom-worker 绑定 runtime kind 为本插件声明的 profile_runtime 占用 → force 知情停用）
    await env.host.disable('test:rt', { force: true })
    const after = await env.host.runHook('before_turn', { ...turn, sections: [] } as never)
    const afterSections = after.action === 'transform' ? after.value.sections : turn.sections
    const afterCatalog = afterSections.find((s: { id: string }) => s.id === 'profile.catalog')
    assert.ok(
      afterCatalog === undefined || !afterCatalog.text.includes('custom-worker'),
      '接管插件停用后隐藏其托管 Profile（目录为空时不注入）',
    )
  } finally {
    await env.close()
  }
})

test('before_turn：候选 SYSTEM 缺失不告警不伪造；IO 错误显式上抛（不吞）', { timeout: 60_000 }, async () => {
  const env = await makeEnv([createWorkflowPlugin()], true)
  try {
    await seedProfile(env.profiles, env.dataDir, { id: 'coder', name: '编码' })
    // 新建 Profile 会落默认 SYSTEM.md；显式删除模拟候选资产缺失（目录注入、无 summary、不发告警）
    unlinkSync(join(env.dataDir, 'profiles', 'coder', 'SYSTEM.md'))
    const turn = {
      conversation: makeConversation(1),
      sections: [],
      tools: [tool('subagent')],
      inputs: [],
      messages: [],
    }
    const result = await env.host.runHook('before_turn', turn as never)
    const catalog = sectionsOf(result, turn).find((s) => s.id === 'profile.catalog')
    assert.ok(catalog, '候选缺 SYSTEM 不阻断目录注入')
    assert.ok(/<profile id="coder" name="编码" mention="@coder" runtime="native"( at="[^"]*")?><\/profile>/.test(catalog.text), 'summary 空元素（不伪造）')
    assert.equal(env.backend.notifications.length, 0, '候选缺失不告警（告警纪律只针对当前会话资产）')

    // 当前会话自身 SYSTEM 缺失仍走既有告警（回归保护）
    unlinkSync(join(env.dataDir, 'profiles', 'assistant', 'SYSTEM.md'))
    await env.host.runHook('before_turn', { ...turn, sections: [] } as never)
    assert.ok(
      env.backend.notifications.some((n) => n.title.includes('SYSTEM.md')),
      '当前会话 SYSTEM 缺失仍显式告警',
    )

    // 候选 SYSTEM 变为不可读（EACCES）：钩子链显式失败（hook_execution_failed），不静默降级
    const denied = join(env.dataDir, 'profiles', 'coder', 'SYSTEM.md')
    writeFileSync(denied, '# x\n正文')
    chmodSync(denied, 0o000)
    const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false
    if (!isRoot) {
      await assert.rejects(
        () => env.host.runHook('before_turn', { ...turn, sections: [] } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'hook_execution_failed',
        'IO 错误必须显式失败',
      )
    }
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 动作契约：list_mentionable
// ---------------------------------------------------------------------------

test('list_mentionable：上下文会话为真实身份来源；Workflow 启停实时影响候选', { timeout: 60_000 }, async () => {
  const env = await makeEnv([createWorkflowPlugin()], true)
  try {
    await seedProfile(env.profiles, env.dataDir, { id: 'coder', name: '编码专家' })
    env.backend.conversations.set(2, makeConversation(2, { profileId: 'coder', parentConversationId: 1 }))

    // 有调用上下文：忽略 input.conversationId（不可被 body 伪造身份）
    const byContext = (await env.host.invokeAction(
      'builtin:profile',
      'list_mentionable',
      { query: '', conversationId: 999 },
      { conversationId: 1 },
    )) as { items: Array<{ id: string }> }
    assert.ok(byContext.items.some((i) => i.id === 'coder'), '上下文会话 1（assistant）的候选包含 coder')

    await env.host.disable('builtin:workflow')
    const disabled = (await env.host.invokeAction(
      'builtin:profile', 'list_mentionable', { query: '', conversationId: 1 }, { conversationId: 1 },
    )) as { items: unknown[] }
    assert.equal(disabled.items.length, 0, 'Workflow 停用时不推荐无法调用的角色')
    await env.host.enable('builtin:workflow')
    const enabled = (await env.host.invokeAction(
      'builtin:profile', 'list_mentionable', { query: '', conversationId: 1 }, { conversationId: 1 },
    )) as { items: Array<{ id: string }> }
    assert.ok(enabled.items.some((i) => i.id === 'coder'), 'Workflow 重新启用后候选恢复')

    // 无上下文 + 显式 conversationId：真实 getConversation 校验。补全面不再
    // 按父链排除（fork / SuperAgent worker 同样有父链但应保留协作能力；真正
    // 子代理的回合级剥离由 builtin:workflow 钩子完成），有插件即有候选。
    const subCtx = (await env.host.invokeAction('builtin:profile', 'list_mentionable', { conversationId: 2 })) as {
      items: Array<{ id: string }>
    }
    assert.ok(subCtx.items.length > 0, '子会话上下文不再按父链一刀切排除（fork/worker 误伤修复）')
    assert.ok(!subCtx.items.some((i) => i.id === 'coder'), '排除规则仍生效：自身 Profile 不进候选')

    // 无上下文 + 失效显式目标 → 404
    await assert.rejects(
      () => env.host.invokeAction('builtin:profile', 'list_mentionable', { conversationId: 404 }),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found',
    )

    // 无上下文 + 无显式目标 → validation_error（不猜测默认会话）
    await assert.rejects(
      () => env.host.invokeAction('builtin:profile', 'list_mentionable', {}),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
    )
  } finally {
    await env.close()
  }
})

test('list_mentionable：输出 schema 严格（label/hint/insertText/icon 契约）与 query 过滤', { timeout: 60_000 }, async () => {
  const env = await makeEnv([createWorkflowPlugin()], true)
  try {
    await seedProfile(env.profiles, env.dataDir, { id: 'coder', name: '编码专家' }, '# C\n数据库迁移专家。')
    await seedProfile(env.profiles, env.dataDir, { id: 'reviewer', name: '评审' }, '# R\n代码评审。')

    const all = (await env.host.invokeAction('builtin:profile', 'list_mentionable', { query: '' }, { conversationId: 1 })) as {
      items: Array<{ id: string; label: string; insertText: string; hint: string; icon: string }>
    }
    assert.equal(all.items.length, 2)
    const coder = all.items.find((i) => i.id === 'coder')!
    assert.equal(coder.label, '@coder · 编码专家')
    assert.equal(coder.insertText, '@coder ')
    assert.equal(coder.icon, 'bot')
    assert.ok(coder.hint.includes('数据库迁移专家'), 'hint 含摘要')
    assert.ok(coder.hint.includes('继承当前会话节点与目录'), 'hint 含位置继承说明')

    // query 过滤（id / name / summary 模糊命中）
    const filtered = (await env.host.invokeAction('builtin:profile', 'list_mentionable', { query: '迁移' }, { conversationId: 1 })) as {
      items: Array<{ id: string }>
    }
    assert.deepEqual(filtered.items.map((i) => i.id), ['coder'])

    const none = (await env.host.invokeAction('builtin:profile', 'list_mentionable', { query: '不存在的词' }, { conversationId: 1 })) as {
      items: unknown[]
    }
    assert.equal(none.items.length, 0)
  } finally {
    await env.close()
  }
})

test('list_mentionable：幂等只读（补全源绑定契约）且无副作用', { timeout: 60_000 }, async () => {
  const env = await makeEnv([createWorkflowPlugin()], true)
  try {
    await seedProfile(env.profiles, env.dataDir, { id: 'coder', name: '编码' })
    const manifest = env.host.listActions().find((a) => a.pluginId === 'builtin:profile' && a.id === 'list_mentionable')
    assert.ok(manifest, '动作进入 manifest（HTTP / CLI 自动映射）')
    assert.equal(manifest.idempotent, true, '幂等声明（composerCompleter action 源前置条件）')
    const before = JSON.stringify((env.host as unknown as { docs: MemoryDocStore }).docs ?? [])
    await env.host.invokeAction('builtin:profile', 'list_mentionable', { query: '' }, { conversationId: 1 })
    await env.host.invokeAction('builtin:profile', 'list_mentionable', { query: '' }, { conversationId: 1 })
    assert.equal(before, JSON.stringify((env.host as unknown as { docs: MemoryDocStore }).docs ?? []), '重复调用零写入')
    assert.equal(env.backend.notifications.length, 0)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// UI 贡献：composerCompleter 声明与生命周期
// ---------------------------------------------------------------------------

test('composerCompleter：@ 触发 action 源声明进入 listUi，profile 插件常驻不消失', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const completers = env.host
      .listUi()
      .filter((u) => u.surface === 'composer.completer' && u.pluginId === 'builtin:profile')
    assert.equal(completers.length, 1)
    const spec = completers[0]!.spec as { trigger: string; source: { kind: string; actionId: string }; priority?: number }
    assert.equal(spec.trigger, '@')
    assert.equal(spec.source.kind, 'action')
    assert.equal(spec.source.actionId, 'list_mentionable')
    assert.equal(spec.priority, 100, '插件源间排序声明（不冒称高于宿主内置源）')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 兼容回归：既有消费方（SYSTEM / skills 注入不受影响）
// ---------------------------------------------------------------------------

test('回归：SYSTEM 与 skills 注入不受目录逻辑影响（sections 顺序稳定）', { timeout: 60_000 }, async () => {
  const env = await makeEnv([createWorkflowPlugin()], true)
  try {
    await seedProfile(env.profiles, env.dataDir, { id: 'coder', name: '编码' }, '# C\n摘要。')
    const turn = {
      conversation: makeConversation(1),
      sections: [],
      tools: [tool('subagent')],
      inputs: [],
      messages: [],
    }
    const result = await env.host.runHook('before_turn', turn as never)
    const ids = sectionsOf(result, turn).map((s) => s.id)
    assert.ok(ids.includes('profile.system'), 'SYSTEM 注入保留')
    assert.ok(ids.includes('profile.skills'), 'skills 目录注入保留')
    assert.ok(ids.includes('profile.catalog'), '协作目录注入新增')
    assert.ok(ids.indexOf('profile.system') < ids.indexOf('profile.catalog'), 'SYSTEM 先于目录（默认优先级钩子先运行）')
  } finally {
    await env.close()
  }
})

test('list_mentionable：CLI --current 形态（仅上下文会话，input 完全省略目标与 query）', { timeout: 60_000 }, async () => {
  // 动态命令只把 --current 写入外层 body.conversationId（即 PluginActionContext），
  // input 不自动回填；本用例验证该形态下 handler 能从 context 解析且 query 缺省 ''。
  const env = await makeEnv([createWorkflowPlugin()], true)
  try {
    await seedProfile(env.profiles, env.dataDir, { id: 'coder', name: '编码' })
    const cliForm = (await env.host.invokeAction('builtin:profile', 'list_mentionable', {}, { conversationId: 1 })) as {
      items: Array<{ id: string; label: string }>
    }
    assert.deepEqual(
      cliForm.items.map((i) => i.id),
      ['coder'],
      '空 input + 上下文会话 → 全量候选（query 缺省不过滤）',
    )
    assert.equal(cliForm.items[0]!.label, '@coder · 编码')
  } finally {
    await env.close()
  }
})
