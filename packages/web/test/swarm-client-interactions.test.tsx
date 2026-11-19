/**
 * builtin:swarm 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖（收敛后形态：无独立 BoardScreen，编排心智模型对齐 builtin:workflow）：
 * 1. UI 扩展注册不变量（registerSwarmUi：toolView 覆盖全部 swarm_* 工具且 replaceRow、
 *    COMPOSER_DOCK_SLOT 活动托盘、workbench.panel 'groups' 仅参与者作用域、
 *    swarm:board-report / swarm:board-wakeup 单行回执渲染器、@/# composerCompleter、
 *    零 screen / 零顶栏 action / 零 sidebarItem、双语 LocalizedText、零 Emoji）；
 * 2. SwarmToolView 26px 工具轨迹行：dispatch 完成态点击打开成员会话抽屉、黑板发布行点击
 *    打开协同工作台面板、无法定目标的行展开原始详情、错误态如实展示首行、zh-CN 自然语言；
 * 3. SwarmActiveTray：无活跃事项返回 null；working/blocked 成员渲染 32px HUD（人数、进度、
 *    自然语言动态、时长），展开行点击打开 ConversationDrawer，主控视角才出现中止按钮；
 * 4. SwarmWorkbenchPanel：实时 board-view 渲染编排卡（目标、自然状态、成员行点击开抽屉、
 *    最近动态自然 kind 标签、worktree 分支事实），无实时投影时显式 board_status 一次性回退
 *    （失败可重试、不白屏不伪造运行中），完整记录展开按需 board_read；
 * 5. 单行回执胶囊点击打开协同工作台面板；
 * 6. swarm/client 全目录静态铁律：零 Emoji、零原生 select/checkbox、零 history.*、
 *    零本地 .status-dot/.helmx-status-light 样式定义、客户端导出仅含 PascalCase 组件。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { act } from 'react'
import {
  COMPOSER_DOCK_SLOT,
  parseNonEmptyLocalizedText,
  type CallActionOptions,
  type ConversationSummary,
  type HelmxPluginContext,
  type LocalizedText,
  type PluginClientContext as PluginClientContextType,
  type TimelineRendererProps,
  type ToolViewProps,
} from '@helmx/protocol'
import type { PluginClientHostPort, PluginSessionDocKey } from '@helmx/plugin-client'
import {
  boardProgressOf,
  isMemberDelivered,
  parseBoardPost,
  parseBoardReadPosts,
  parseBoardView,
  postDigestLine,
} from '../../plugins/src/swarm/client/board-model.js'
import { SWARM_WORKBENCH_PANEL_TARGET } from '../../plugins/src/swarm/client/models.js'
import { registerSwarmUi } from '../../plugins/src/swarm/ui.js'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const { createRoot } = await import('react-dom/client')
const { PluginClientContext, PluginClientHostContext, resolveLocalizedText } = await import('@helmx/plugin-client')
const { importBuiltinClientModule, mountSharedPluginNamespaces } = await import('./helpers/builtin-clients.js')

const e = React.createElement
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

mountSharedPluginNamespaces({ realHooks: true })

interface SwarmClientComponents {
  SwarmToolView: (p: ToolViewProps) => React.ReactElement
  SwarmActiveTray: (p: { conversation?: ConversationSummary }) => React.ReactElement
  SwarmWorkbenchPanel: (p: { conversation?: ConversationSummary }) => React.ReactElement
  SwarmBoardReportPill: (p: TimelineRendererProps) => React.ReactElement
  SwarmBoardWakeupPill: (p: TimelineRendererProps) => React.ReactElement
}

let rawModule: Record<string, unknown>
let components: SwarmClientComponents

before(async () => {
  const mod = await importBuiltinClientModule('builtin:swarm')
  rawModule = mod
  components = {
    SwarmToolView: mod['SwarmToolView'] as SwarmClientComponents['SwarmToolView'],
    SwarmActiveTray: mod['SwarmActiveTray'] as SwarmClientComponents['SwarmActiveTray'],
    SwarmWorkbenchPanel: mod['SwarmWorkbenchPanel'] as SwarmClientComponents['SwarmWorkbenchPanel'],
    SwarmBoardReportPill: mod['SwarmBoardReportPill'] as SwarmClientComponents['SwarmBoardReportPill'],
    SwarmBoardWakeupPill: mod['SwarmBoardWakeupPill'] as SwarmClientComponents['SwarmBoardWakeupPill'],
  }
}, { timeout: 60_000 })

interface ActionCallRecord {
  actionId: string
  input: unknown
  options?: CallActionOptions
}

interface SpyCtx extends PluginClientContextType {
  drawerCalls: number[]
  workbenchCalls: Array<string | undefined>
  actionCalls: ActionCallRecord[]
  notifyCalls: Array<{ message: string; tone?: string }>
}

function makeSpyCtx(overrides: Partial<SpyCtx> & Partial<PluginClientContextType> = {}): SpyCtx {
  const drawerCalls: number[] = []
  const workbenchCalls: Array<string | undefined> = []
  const actionCalls: ActionCallRecord[] = []
  const notifyCalls: Array<{ message: string; tone?: string }> = []
  const locale = overrides.locale ?? 'en'
  const base: PluginClientContextType = {
    pluginId: 'builtin:swarm',
    callAction: async (actionId, input, options) => {
      actionCalls.push({ actionId, input, ...(options !== undefined ? { options } : {}) })
      return {}
    },
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: (id) => {
      drawerCalls.push(id)
    },
    openArtifact: () => {},
    openWorkbench: (panelId) => {
      workbenchCalls.push(panelId)
    },
    closeWorkbench: () => {},
    notify: (message, tone) => {
      notifyCalls.push({ message, tone })
    },
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    conversationId: 1,
    theme: 'dark',
    locale,
    translate: (text) => resolveLocalizedText(text, locale),
  }
  return Object.assign(base, {
    drawerCalls,
    workbenchCalls,
    actionCalls,
    notifyCalls,
    ...overrides,
  })
}

function convSummary(
  id: number,
  title: string,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title,
    profileId: 'coder',
    tags: [],
    cwd: '/tmp',
    model: 'openai/gpt-5',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }
}

const DEFAULT_CONVERSATIONS: ConversationSummary[] = [
  convSummary(50, '主控协同任务', { tags: ['swarm-coordinator'] }),
  convSummary(51, 'author 工作区', { tags: ['swarm-worker'], status: 'working', doing: 'writing auth module' }),
  convSummary(52, 'verifier 审阅', { tags: ['swarm-worker'] }),
]

const EMPTY_SESSION_DOC_STATE = Object.freeze({
  hasValue: false,
  deleted: false,
  connected: false,
})

let stubDocs: Record<string, unknown> = {}
let stubSessionStates: Record<string, { value: unknown; hasValue: boolean; deleted: boolean; connected: boolean }> = {}
let stubConversationLives: Record<number, unknown> = {}
let stubPendingAsks: unknown[] = []
let stubLoadErrors: Record<string, string> = {}

function setStubState(options: {
  docs?: Record<string, unknown>
  sessionDocs?: Record<string, unknown>
  conversationLives?: Record<number, unknown>
  pendingAsks?: unknown[]
  loadErrors?: Record<string, string>
}): void {
  if (options.docs !== undefined) stubDocs = options.docs
  if (options.sessionDocs !== undefined) {
    const next: typeof stubSessionStates = {}
    for (const [k, v] of Object.entries(options.sessionDocs)) {
      if (v !== undefined) {
        next[k] = { value: v, hasValue: true, deleted: false, connected: true }
      }
    }
    stubSessionStates = next
  }
  if (options.conversationLives !== undefined) stubConversationLives = options.conversationLives
  if (options.pendingAsks !== undefined) stubPendingAsks = options.pendingAsks
  if (options.loadErrors !== undefined) stubLoadErrors = options.loadErrors
}

const noopUnsubscribe = (): (() => void) => () => {}
const noopEnsurePluginDoc = async (): Promise<unknown> => undefined
const noopLoadConversationDetail = async (): Promise<void> => {}

async function mount(
  ctx: PluginClientContextType,
  element: React.ReactElement,
  conversations: ConversationSummary[] = DEFAULT_CONVERSATIONS,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const pluginDocs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(stubDocs)) {
    if (v !== undefined) {
      pluginDocs[`builtin:swarm/${k}`] = v
    }
  }
  const getSessionDocState = (key: PluginSessionDocKey) =>
    stubSessionStates[`${key.pluginId}/${key.docName}/${key.conversationId}`] ?? EMPTY_SESSION_DOC_STATE
  const hostPort = {
    authenticated: false,
    conversations,
    pluginDocs,
    ensurePluginDoc: noopEnsurePluginDoc,
    subscribeSessionDoc: noopUnsubscribe,
    getSessionDocState,
    conversationDetails: {},
    conversationLives: stubConversationLives,
    pendingAsks: stubPendingAsks,
    loadErrors: stubLoadErrors,
    loadConversationDetail: noopLoadConversationDetail,
  } as unknown as PluginClientHostPort
  await act(async () => {
    root.render(
      e(
        PluginClientHostContext.Provider,
        { value: hostPort },
        e(PluginClientContext.Provider, { value: ctx }, element),
      ),
    )
  })
  await act(async () => {})
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function resetDefaultStubs(): void {
  setStubState({
    docs: {
      index: { workers: [], groups: [] },
      'board-badges': { byConversation: {} },
    },
    sessionDocs: {},
    conversationLives: {},
    pendingAsks: [],
    loadErrors: {},
  })
}

before(() => {
  resetDefaultStubs()
}, { timeout: 60_000 })

function coordinatorIndexFixture(): Record<string, unknown> {
  return {
    workers: [
      {
        conversationId: 51,
        coordinatorConversationId: 50,
        profileId: 'coder',
        groupId: 'grp-live',
        name: 'author',
        createdAt: 1000,
      },
      {
        conversationId: 52,
        coordinatorConversationId: 50,
        profileId: 'reviewer',
        groupId: 'grp-live',
        name: 'verifier',
        createdAt: 1000,
      },
    ],
    groups: [
      {
        id: 'grp-live',
        title: '协同审改组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 3,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
  }
}

function boardViewFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    group: {
      id: 'grp-live',
      title: '协同审改组',
      objective: '零回归完成鉴权改造',
      coordinatorConversationId: 50,
      status: 'active',
      activeWorkerCount: 2,
      headSeq: 3,
      channels: [{ name: 'main' }],
      createdAt: Date.now() - 3 * 60_000,
      updatedAt: 2000,
    },
    headline: {
      text: 'author handoff #2 awaiting verifier',
      tone: 'info',
      kind: 'normal',
    },
    members: [
      {
        name: 'author',
        conversationId: 51,
        profileId: 'coder',
        access: 'readwrite',
        isolation: 'worktree',
        nodeId: 'local',
        cwd: '/repo-wt/author',
        worktreeId: 'wt-author-1',
        channels: ['main'],
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 1,
        lastPostSeq: 2,
        createdAt: 1000,
        liveState: 'done',
        model: 'openai/gpt-5',
      },
      {
        name: 'verifier',
        conversationId: 52,
        profileId: 'reviewer',
        access: 'readonly',
        isolation: 'inherit',
        nodeId: 'local',
        cwd: '/repo',
        channels: ['main'],
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 2,
        createdAt: 1000,
        liveState: 'working',
        model: 'anthropic/claude-sonnet-4-5',
      },
    ],
    edges: [
      { from: 'coordinator', to: 'author', count: 1, lastSeq: 1, lastKind: 'brief' },
      { from: 'author', to: 'verifier', count: 1, lastSeq: 2, lastKind: 'handoff' },
    ],
    posts: [
      {
        seq: 1,
        groupId: 'grp-live',
        channel: 'main',
        from: 'coordinator',
        to: ['author'],
        resolvedTargets: ['author'],
        wake: true,
        kind: 'brief',
        refs: [],
        body: 'Implement token refresh in isolated worktree.',
        createdAt: 1100,
      },
      {
        seq: 2,
        groupId: 'grp-live',
        channel: 'main',
        from: 'author',
        to: ['verifier'],
        resolvedTargets: ['verifier'],
        wake: true,
        kind: 'handoff',
        refs: [1],
        body: 'Token refresh implemented, ready for review.',
        worktreeSnapshot: {
          worktreeId: 'wt-author-1',
          branch: 'helmx/author',
          commitsAhead: 2,
          dirtyCount: 1,
          changedFilesPreview: ['src/auth.ts'],
        },
        createdAt: 1500,
      },
    ],
    activeWorkingMembers: ['verifier'],
    ...overrides,
  }
}

function toolViewProps(overrides: Partial<ToolViewProps> = {}): ToolViewProps {
  return {
    callId: 'call-1',
    toolName: 'swarm_board_post',
    status: 'done',
    conversationId: 50,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. UI registrations & Fast Refresh contract
// ---------------------------------------------------------------------------

test('UI 注册契约：toolView/slot/workbenchPanel/回执/补全源，零 screen 与顶栏 action，双语文案非空且客户端导出仅含组件', { timeout: 60_000 }, () => {
  const recorded: Array<{ method: string; spec: Record<string, unknown> }> = []
  const uiProxy = new Proxy(
    {},
    {
      get(_target, prop: string) {
        return (spec: Record<string, unknown>) => {
          recorded.push({ method: prop, spec })
        }
      },
    },
  )
  registerSwarmUi({ ui: uiProxy } as unknown as HelmxPluginContext)

  const toolViews = recorded.filter((r) => r.method === 'toolView')
  assert.equal(toolViews.length, 1, '仅注册一个统一 toolView')
  const toolViewSpec = toolViews[0]!.spec
  assert.equal(toolViewSpec['replaceRow'], true, '必须整行替换默认工具轨迹行')
  assert.deepEqual(
    [...(toolViewSpec['toolNames'] as string[])].sort(),
    [
      'swarm_abort_worker',
      'swarm_archive_worker',
      'swarm_board_post',
      'swarm_board_read',
      'swarm_board_status',
      'swarm_close_group',
      'swarm_create_group',
      'swarm_dispatch_worker',
      'swarm_inspect_worker',
      'swarm_switch_worker_model',
      'swarm_update_group',
    ],
    '覆盖当前全部 swarm_* 模型工具',
  )

  const slots = recorded.filter((r) => r.method === 'slot')
  assert.deepEqual(
    slots.map((s) => ({ target: s.spec['target'], scope: s.spec['scope'] })),
    [{ target: COMPOSER_DOCK_SLOT, scope: { tags: ['swarm-coordinator', 'swarm-worker'] } }],
    'COMPOSER_DOCK_SLOT 活动托盘仅对协同会话挂载',
  )

  const panels = recorded.filter((r) => r.method === 'workbenchPanel').map((r) => r.spec)
  assert.equal(panels.length, 1, '仅注册一个会话作用域工作台面板')
  assert.equal(panels[0]!['id'], 'groups')
  assert.deepEqual(
    panels[0]!['scope'],
    { tags: ['swarm-coordinator', 'swarm-coordinator-archived', 'swarm-worker', 'swarm-worker-archived'] },
    '普通会话不出现该 Tab；结单历史主控与已归档成员仍可访问历史编组',
  )
  assert.deepEqual(panels[0]!['badge'], { doc: 'board-badges', byConversationField: 'byConversation' })
  assert.equal(SWARM_WORKBENCH_PANEL_TARGET, 'plugin:builtin:swarm/groups', '客户端面板目标与注册 id 锁定一致')

  assert.equal(recorded.filter((r) => r.method === 'screen').length, 0, '删除独立全屏 Board 控制台')
  assert.equal(recorded.filter((r) => r.method === 'action').length, 0, '删除顶栏独立 board action 入口')
  assert.equal(recorded.filter((r) => r.method === 'sidebarItem').length, 0, '不注册侧边栏入口')
  assert.equal(recorded.filter((r) => r.method === 'command').length, 0, '不注册 ui.command')

  const renderers = recorded
    .filter((r) => r.method === 'timelineRenderer')
    .map((r) => (r.spec['matchMeta'] as { renderer: string }).renderer)
  assert.deepEqual(renderers, ['swarm:board-report', 'swarm:board-wakeup'], '后端仍写入的回执行保留极简渲染器')

  const completers = recorded.filter((r) => r.method === 'composerCompleter').map((r) => ({
    id: r.spec['id'],
    trigger: r.spec['trigger'],
    source: r.spec['source'],
  }))
  assert.deepEqual(completers, [
    { id: 'swarm-board-members', trigger: '@', source: { kind: 'action', actionId: 'complete_board_members' } },
    { id: 'swarm-board-channels', trigger: '#', source: { kind: 'action', actionId: 'complete_board_channels' } },
  ])

  for (const { method, spec } of recorded) {
    for (const field of ['label', 'title', 'description'] as const) {
      if (spec[field] !== undefined) {
        const parsed = parseNonEmptyLocalizedText(spec[field] as LocalizedText)
        assert.notEqual(parsed, undefined, `${method}#${String(spec['id'])}.${field} 必须是非空双语 LocalizedText`)
        const map = spec[field] as Record<string, string>
        assert.ok((map['en'] ?? '').trim().length > 0)
        assert.ok((map['zh-CN'] ?? '').trim().length > 0)
        assert.equal(EMOJI_RE.test(map['en'] ?? ''), false)
        assert.equal(EMOJI_RE.test(map['zh-CN'] ?? ''), false)
      }
    }
  }

  // Fast Refresh：编译产物模块除 __helmxClientCss 外全部为大写开头的组件函数
  for (const [exportName, value] of Object.entries(rawModule)) {
    if (exportName === '__helmxClientCss') continue
    assert.match(exportName, /^[A-Z]/, `client 入口导出必须为 PascalCase 组件：${exportName}`)
    assert.equal(typeof value, 'function', `导出 ${exportName} 必须为组件函数`)
  }
})

// ---------------------------------------------------------------------------
// 2. SwarmToolView trace rows
// ---------------------------------------------------------------------------

test('SwarmToolView：dispatch 完成态点击打开成员会话抽屉，黑板发布行打开工作台面板，运行中无目标行展开原始详情', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx({ conversationId: 50 })

  // dispatch_worker done：解析结果 JSON 中的 workerConversationId，点击打开子会话抽屉
  const dispatchMount = await mount(
    spy,
    e(components.SwarmToolView, toolViewProps({
      toolName: 'swarm_dispatch_worker',
      input: { name: 'author', prompt: 'Implement token refresh in isolated worktree and post handoff when done' },
      result: JSON.stringify({ workerConversationId: 51, groupId: 'grp-live', name: 'author', postSeq: 1 }),
      durationMs: 4200,
    })),
  )
  try {
    const text = dispatchMount.host.textContent ?? ''
    assert.match(text, /Dispatch member/, '自然语言工具名')
    assert.match(text, /@author/, '成员名摘要')
    assert.match(text, /Implement token refresh/, '派工任务摘要')
    assert.equal(dispatchMount.host.querySelector('.sw-trace-row-btn') !== null, true)
    await act(async () => {
      dispatchMount.host.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!.click()
    })
    assert.deepEqual(spy.drawerCalls, [51], '点击打开成员会话抽屉')
    assert.equal(spy.workbenchCalls.length, 0, '成员行不打开工作台')
  } finally {
    dispatchMount.unmount()
  }

  // swarm_board_post done：编组级动作点击打开协同工作台面板
  const postMount = await mount(
    spy,
    e(components.SwarmToolView, toolViewProps({
      callId: 'call-2',
      toolName: 'swarm_board_post',
      input: { to: ['verifier'], kind: 'handoff', body: 'Token refresh implemented, ready for review.' },
      result: JSON.stringify({ post: { seq: 2, groupId: 'grp-live', kind: 'handoff', body: 'Token refresh implemented, ready for review.', from: 'coordinator', to: ['verifier'], resolvedTargets: ['verifier'], wake: true, refs: [], channel: 'main', createdAt: 1500 } }),
    })),
  )
  try {
    const text = postMount.host.textContent ?? ''
    assert.match(text, /Handoff/, 'kind 映射为自然语言动词')
    assert.match(text, /-> @verifier/, '目标自然化')
    assert.match(text, /ready for review/, '正文摘要')
    assert.match(text, /#2/, '#seq 仅作辅助信息')
    await act(async () => {
      postMount.host.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!.click()
    })
    assert.deepEqual(spy.workbenchCalls, ['plugin:builtin:swarm/groups'], '编组级行打开协同工作台面板')
  } finally {
    postMount.unmount()
  }

  // 运行中的 abort_worker（无法确定目标）：点击展开原始详情，不伪造目标
  const runningMount = await mount(
    spy,
    e(components.SwarmToolView, toolViewProps({
      callId: 'call-3',
      toolName: 'swarm_abort_worker',
      input: { groupId: 'grp-live', name: 'someone-new' },
      status: 'running',
      startedAt: 1000,
    })),
  )
  try {
    const rowBtn = runningMount.host.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!
    assert.equal(rowBtn.getAttribute('aria-expanded'), 'false', '未知目标行为详情展开开关')
    await act(async () => {
      rowBtn.click()
    })
    assert.equal(rowBtn.getAttribute('aria-expanded'), 'true')
    assert.equal(runningMount.host.querySelector('.tool-call-details') !== null, true, '展开原始工具数据')
    assert.deepEqual(spy.drawerCalls, [51], '未新增抽屉调用（未伪造目标）')
  } finally {
    runningMount.unmount()
  }

  assert.deepEqual(
    spy.actionCalls.map((c) => c.actionId),
    [],
    '纯展示行不触发任何动作',
  )
})

test('SwarmToolView：错误态如实展示错误首行与状态灯，zh-CN 显示自然中文摘要', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx({ conversationId: 50 })
  const errMount = await mount(
    spy,
    e(components.SwarmToolView, toolViewProps({
      callId: 'call-e1',
      toolName: 'swarm_close_group',
      input: { groupId: 'grp-live' },
      status: 'error',
      result: 'swarm_worktree_unmerged: author worktree has 3 unmerged commits\nresolve or keepWorktree',
    })),
  )
  try {
    const text = errMount.host.textContent ?? ''
    assert.match(text, /Close swarm group/)
    assert.match(text, /swarm_worktree_unmerged: author worktree has 3 unmerged commits/, '错误首行原样呈现')
    assert.equal(errMount.host.querySelector('.trace-row-error') !== null, true, '错误行样式')
    assert.equal(errMount.host.querySelectorAll('.helmx-status-light').length, 1, '主状态灯唯一')
  } finally {
    errMount.unmount()
  }

  const zhSpy = makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
  const zhMount = await mount(
    zhSpy,
    e(components.SwarmToolView, toolViewProps({
      callId: 'call-e2',
      toolName: 'swarm_board_post',
      input: { to: ['coordinator'], kind: 'blocker', body: '集成环境不可用，等待基础设施恢复。' },
    })),
    DEFAULT_CONVERSATIONS,
  )
  try {
    const text = zhMount.host.textContent ?? ''
    assert.match(text, /黑板发布/, 'zh-CN 工具名')
    assert.match(text, /受阻/, 'kind 自然语言动词')
  } finally {
    zhMount.unmount()
  }
})

// ---------------------------------------------------------------------------
// 3. SwarmActiveTray
// ---------------------------------------------------------------------------

test('SwarmActiveTray：无活跃事项返回 null；working/blocked 成员渲染 HUD 与可展开行，主控视角对两者均可中止', { timeout: 60_000 }, async () => {
  // 无 board-view 投影：不渲染任何内容（0px 占位）
  setStubState({ docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } } })
  const idleSpy = makeSpyCtx({ conversationId: 50 })
  const idleMount = await mount(idleSpy, e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }))
  try {
    assert.equal(idleMount.host.textContent ?? '', '', '无实时投影时返回 null')
  } finally {
    idleMount.unmount()
  }

  setStubState({
    docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
    sessionDocs: { 'builtin:swarm/board-view/50': boardViewFixture() },
  })

  // 主控视角：HUD + 展开行 + working 成员可中止
  const coordSpy = makeSpyCtx({ conversationId: 50 })
  const coordMount = await mount(
    coordSpy,
    e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
  )
  try {
    const text = coordMount.host.textContent ?? ''
    assert.match(text, /1 working/, 'working 计数')
    assert.match(text, /1\/2 delivered/, '进度')
    assert.match(text, /handoff/i, '自然语言动态')
    const toggle = coordMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    await act(async () => {
      toggle.click()
    })
    const row = coordMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-main')!
    assert.match(coordMount.host.textContent ?? '', /@verifier/, '展开显示在途成员')
    assert.match(coordMount.host.textContent ?? '', /#52/, '会话编号辅助信息')
    await act(async () => {
      row.click()
    })
    assert.deepEqual(coordSpy.drawerCalls, [52], '成员行打开 ConversationDrawer')
    const abortBtn = coordMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-actions .btn-danger')
    assert.ok(abortBtn !== null, '主控视角对运行中成员提供真实中止动作')
    await act(async () => {
      abortBtn.click()
    })
    assert.deepEqual(
      coordSpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
      [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'verifier' } }],
      '中止走 abort_worker 动作',
    )
  } finally {
    coordMount.unmount()
  }

  // Worker 视角：可见展开行但无中止按钮（权限如实）
  const workerSpy = makeSpyCtx({ conversationId: 51 })
  const workerMount = await mount(
    workerSpy,
    e(components.SwarmActiveTray, { conversation: convSummary(51, 'author', { tags: ['swarm-worker'] }) }),
  )
  try {
    const toggle = workerMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
    await act(async () => {
      toggle.click()
    })
    assert.ok(workerMount.host.querySelector('.btn-danger') === null, 'Worker 视角不出现中止按钮')
    assert.ok(workerMount.host.querySelector('.sw-tray-workbench') !== null, '工作台入口保留')
  } finally {
    workerMount.unmount()
  }

  // 回归：blocked 成员对主控同样可中止（后端 abortWorker 支持 working 与 blocked）
  const blockedFixture = boardViewFixture()
  ;(blockedFixture.members as Array<{ liveState: string }>)[1]!.liveState = 'blocked'
  setStubState({
    docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
    sessionDocs: { 'builtin:swarm/board-view/50': blockedFixture },
  })
  const blockedSpy = makeSpyCtx({ conversationId: 50 })
  const blockedMount = await mount(
    blockedSpy,
    e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
  )
  try {
    const blockedText = blockedMount.host.textContent ?? ''
    assert.match(blockedText, /1 blocked/, 'blocked 计数')
    const toggle = blockedMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
    await act(async () => {
      toggle.click()
    })
    const abortBtn = blockedMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-actions .btn-danger')
    assert.ok(abortBtn !== null, '主控视角对 blocked 成员同样提供中止动作')
    await act(async () => {
      abortBtn.click()
    })
    assert.deepEqual(
      blockedSpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
      [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'verifier' } }],
      'blocked 成员中止同样走 abort_worker',
    )
  } finally {
    blockedMount.unmount()
  }

  // 全员静默（无 working/blocked）：托盘消失
  const quietFixture = boardViewFixture()
  for (const m of (quietFixture.members as Array<{ liveState: string }>).slice(1)) m.liveState = 'idle'
  ;(quietFixture.members as Array<{ liveState: string }>)[0]!.liveState = 'idle'
  setStubState({
    docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
    sessionDocs: { 'builtin:swarm/board-view/50': quietFixture },
  })
  const quietSpy = makeSpyCtx({ conversationId: 50 })
  const quietMount = await mount(quietSpy, e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }))
  try {
    assert.equal(quietMount.host.textContent ?? '', '', '无在途成员时返回 null')
  } finally {
    quietMount.unmount()
  }

  // 组已结单：即使投影残留也不显示
  const closedFixture = boardViewFixture()
  ;(closedFixture.group as { status: string }).status = 'closed'
  setStubState({
    docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
    sessionDocs: { 'builtin:swarm/board-view/50': closedFixture },
  })
  const closedSpy = makeSpyCtx({ conversationId: 50 })
  const closedMount = await mount(closedSpy, e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }))
  try {
    assert.equal(closedMount.host.textContent ?? '', '', '结单组不渲染托盘')
  } finally {
    closedMount.unmount()
  }

  resetDefaultStubs()
})

// ---------------------------------------------------------------------------
// 4. SwarmWorkbenchPanel
// ---------------------------------------------------------------------------

test('SwarmWorkbenchPanel：实时 board-view 编排卡（成员行开抽屉、自然 kind、worktree 事实），Worker 会话同视图', { timeout: 60_000 }, async () => {
  setStubState({
    docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
    sessionDocs: { 'builtin:swarm/board-view/50': boardViewFixture() },
  })
  const spy = makeSpyCtx({ conversationId: 50 })
  const mountPanel = await mount(
    spy,
    e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
  )
  try {
    const text = mountPanel.host.textContent ?? ''
    assert.match(text, /协同审改组/, '编组标题')
    assert.match(text, /零回归完成鉴权改造/, '协同目标')
    assert.match(text, /In progress/, '自然状态标签')
    assert.match(text, /Handoff/, '动态 kind 自然语言')
    assert.match(text, /helmx\/author/, 'worktree 分支事实')
    assert.match(text, /#2/, '#seq 辅助信息')
    assert.equal(mountPanel.host.querySelector('.sw-panel-fallback-note') !== null, false, '实时模式不标注快照来源')

    const memberRow = mountPanel.host.querySelector<HTMLButtonElement>('.sw-panel-member-row')!
    await act(async () => {
      memberRow.click()
    })
    assert.deepEqual(spy.drawerCalls, [52], '排序后首个成员（verifier 排前）点击打开抽屉')
    assert.deepEqual(spy.actionCalls, [], '纯实时投影不触发动作调用')
  } finally {
    mountPanel.unmount()
  }

  // Worker 会话展示同一事实视图（board-view 以主控会话键控）
  const workerSpy = makeSpyCtx({ conversationId: 51 })
  const workerPanel = await mount(
    workerSpy,
    e(components.SwarmWorkbenchPanel, { conversation: convSummary(51, 'author', { tags: ['swarm-worker'] }) }),
  )
  try {
    assert.match(workerPanel.host.textContent ?? '', /协同审改组/, 'Worker 看到所属编组同一视图')
  } finally {
    workerPanel.unmount()
  }

  // 结单历史主控（swarm-coordinator-archived）经 board_status 回退仍能看到已完成编排卡
  const closedIndex2 = coordinatorIndexFixture()
  ;((closedIndex2.groups as Array<{ status: string }>)[0]!).status = 'closed'
  const closedBoard2 = boardViewFixture()
  ;(closedBoard2.group as { status: string }).status = 'closed'
  setStubState({ docs: { index: closedIndex2, 'board-badges': { byConversation: {} } }, sessionDocs: {} })
  const archivedSpy = makeSpyCtx({
    conversationId: 50,
    callAction: async (actionId: string) => {
      if (actionId === 'board_status') return closedBoard2
      return {}
    },
  })
  const archivedPanel = await mount(
    archivedSpy,
    e(components.SwarmWorkbenchPanel, {
      conversation: convSummary(50, '主控（已结单）', { tags: ['swarm-coordinator-archived'] }),
    }),
  )
  try {
    const text = archivedPanel.host.textContent ?? ''
    assert.match(text, /Completed/, '历史主控看到已完成编排卡')
    assert.match(text, /协同审改组/)
  } finally {
    archivedPanel.unmount()
  }
  resetDefaultStubs()
})

test('SwarmWorkbenchPanel：看板帖子正文按 Markdown 渲染，长帖折叠预览切片同样渲染且展开显示全文', { timeout: 60_000 }, async () => {
  const board = boardViewFixture()
  const posts = board.posts as Array<{ body: string }>
  // seq1 短帖：粗体 + 行内代码（不折叠，全文 Markdown）
  posts[0]!.body = 'Implement **token refresh** in `src/auth.ts`.'
  // seq2 长帖（>8 行触发折叠）：首行即 Markdown，尾部放折叠态不可见标记
  posts[1]!.body = [
    'Token refresh **implemented**, see `src/auth.ts`:',
    '',
    '- 刷新令牌轮转',
    '- 过期容错与重试',
    '- 审计日志补齐',
    '- 并发场景回归',
    'TAIL_MARKER_UNCOLLAPSED_ONLY',
    '- 文档同步',
    '- 变更摘要归档',
    'END_OF_LONG_POST',
  ].join('\n')
  setStubState({
    docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
    sessionDocs: { 'builtin:swarm/board-view/50': board },
  })
  const spy = makeSpyCtx({ conversationId: 50 })
  const panel = await mount(
    spy,
    e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
  )
  try {
    const bodyHosts = [...panel.host.querySelectorAll<HTMLElement>('.sw-panel-post-text')]
    assert.ok(bodyHosts.length === 2, '两个帖子的正文容器')

    // 短帖全文渲染为 Markdown 元素，不再出现字面 ** 反引号语法
    const shortBody = bodyHosts[0]!
    assert.ok(shortBody.querySelector('strong') !== null, '粗体渲染为 strong 元素')
    assert.ok(shortBody.querySelector('code') !== null, '行内代码渲染为 code 元素')
    assert.ok((shortBody.textContent ?? '').includes('**') === false, '正文无字面 ** 语法残留')

    // 长帖折叠态：预览切片同样按 Markdown 渲染，尾部内容与折叠标记不出现在正文
    const longBody = bodyHosts[1]!
    assert.ok(longBody.querySelector('strong') !== null, '折叠预览切片同样按 Markdown 渲染')
    assert.ok(longBody.querySelector('code') !== null, '折叠预览切片渲染行内代码')
    assert.ok((longBody.textContent ?? '').includes('TAIL_MARKER_UNCOLLAPSED_ONLY') === false, '折叠态不显示尾部内容')
    assert.ok((longBody.textContent ?? '').includes('END_OF_LONG_POST') === false, '折叠态不显示末行')

    // 展开后显示完整正文（含尾部标记），收展按钮语义保持
    const toggle = panel.host.querySelector<HTMLButtonElement>('.sw-panel-post-toggle')
    assert.ok(toggle !== null, '长帖存在收展按钮')
    assert.ok(toggle.getAttribute('aria-expanded') === 'false', '初始折叠')
    await act(async () => {
      toggle.click()
    })
    assert.ok(toggle.getAttribute('aria-expanded') === 'true', '点击后展开')
    assert.ok((longBody.textContent ?? '').includes('TAIL_MARKER_UNCOLLAPSED_ONLY') === true, '展开后显示尾部内容')
    assert.ok((longBody.textContent ?? '').includes('END_OF_LONG_POST') === true, '展开后显示末行')
  } finally {
    panel.unmount()
  }
  resetDefaultStubs()
})

test('SwarmWorkbenchPanel：无实时投影时显式 board_status 回退（含错误重试与完整记录 board_read），空态只读引导', { timeout: 60_000 }, async () => {
  // closed 历史组（index 仍登记）：无 board-view 投影，走一次性 board_status
  const closedIndex = coordinatorIndexFixture()
  ;((closedIndex.groups as Array<{ status: string }>)[0]!).status = 'closed'
  const closedBoard = boardViewFixture()
  ;((closedBoard.group as { status: string })).status = 'closed'
  ;(closedBoard.group as { retainedWorktrees?: unknown[] }).retainedWorktrees = [
    { memberName: 'author', worktreeId: 'wt-author-1', branch: 'helmx/author', path: '/repo-wt/author', commitsAhead: 2 },
  ]
  setStubState({ docs: { index: closedIndex, 'board-badges': { byConversation: {} } } })

  const actionLog: string[] = []
  const spy = makeSpyCtx({
    conversationId: 50,
    callAction: async (actionId: string) => {
      actionLog.push(actionId)
      if (actionId === 'board_status') return closedBoard
      if (actionId === 'board_read') {
        return { groupId: 'grp-live', headSeq: 3, posts: (closedBoard as { posts: unknown[] }).posts }
      }
      return {}
    },
  })
  const panel = await mount(
    spy,
    e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
  )
  try {
    const text = panel.host.textContent ?? ''
    assert.match(text, /Completed/, '结单自然状态')
    assert.match(text, /snapshot/i, '标注一次性快照来源')
    assert.match(text, /helmx\/author/, '保留待合入分支清单')
    assert.deepEqual(
      spy.actionCalls.map((c) => c.actionId).concat(actionLog),
      ['board_status'],
      '回退仅调用一次 board_status',
    )

    const historyToggle = panel.host.querySelector<HTMLButtonElement>('.sw-panel-history-toggle')!
    await act(async () => {
      historyToggle.click()
    })
    assert.deepEqual(
      actionLog,
      ['board_status', 'board_read'],
      '展开完整记录按需 board_read',
    )
  } finally {
    panel.unmount()
  }

  // board_status 失败：显式错误 + Retry，不白屏不伪造运行中
  const failSpy = makeSpyCtx({
    conversationId: 50,
    callAction: async (actionId: string) => {
      if (actionId === 'board_status') throw new Error('group store offline')
      return {}
    },
  })
  const failPanel = await mount(
    failSpy,
    e(components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
  )
  try {
    const text = failPanel.host.textContent ?? ''
    assert.match(text, /Failed to load swarm group status/)
    assert.match(text, /group store offline/, '错误原文如实')
    assert.equal(failPanel.host.textContent?.includes('In progress'), false, '不伪造运行中')
    const retryBtn = failPanel.host.querySelector<HTMLButtonElement>('.sw-panel .btn')
    assert.ok(retryBtn !== null, '提供重试')
  } finally {
    failPanel.unmount()
  }

  // 普通会话（无 link）：只读空态引导
  const emptySpy = makeSpyCtx({ conversationId: 99 })
  const emptyPanel = await mount(
    emptySpy,
    e(components.SwarmWorkbenchPanel, { conversation: convSummary(99, '普通会话') }),
  )
  try {
    const text = emptyPanel.host.textContent ?? ''
    assert.match(text, /No swarm group in this conversation/)
    assert.match(text, /\/skill:swarm/)
  } finally {
    emptyPanel.unmount()
  }
  resetDefaultStubs()
})

// ---------------------------------------------------------------------------
// 5. Timeline receipt pills
// ---------------------------------------------------------------------------

test('单行回执胶囊：展示计数/动态/成员，点击打开协同工作台面板', { timeout: 60_000 }, async () => {
  const spy = makeSpyCtx({ conversationId: 50 })
  const reportMount = await mount(
    spy,
    e(components.SwarmBoardReportPill, {
      conversationId: 50,
      entry: {
        id: 'e-10',
        kind: 'helmx.input',
        data: {
          meta: {
            renderer: 'swarm:board-report',
            groupId: 'grp-live',
            fromSeq: 4,
            toSeq: 6,
            postCount: 3,
            headline: 'verifier approved #5',
          },
        },
      },
    }),
  )
  try {
    const text = reportMount.host.textContent ?? ''
    assert.match(text, /Swarm report/)
    assert.match(text, /#4\.\.#6/)
    assert.match(text, /3 posts/)
    assert.match(text, /verifier approved #5/)
    const pill = reportMount.host.querySelector<HTMLButtonElement>('.sw-receipt-pill')!
    assert.ok(pill !== null, '回执卡片本体为按钮')
    assert.ok(reportMount.host.querySelector('.sw-receipt-open') === null, '无尾部 chevron 按钮')
    assert.match(pill.getAttribute('aria-label') ?? '', /Open swarm workbench/, '整卡可点的可访问名称')
    await act(async () => {
      pill.click()
    })
    assert.deepEqual(spy.workbenchCalls, ['plugin:builtin:swarm/groups'], '点击卡片本体打开协同工作台面板')
  } finally {
    reportMount.unmount()
  }

  const wakeupSpy = makeSpyCtx({ conversationId: 51 })
  const wakeupMount = await mount(
    wakeupSpy,
    e(components.SwarmBoardWakeupPill, {
      conversationId: 51,
      entry: {
        id: 'e-11',
        kind: 'helmx.input',
        data: {
          meta: {
            renderer: 'swarm:board-wakeup',
            groupId: 'grp-live',
            workerName: 'author',
            fromSeq: 5,
            toSeq: 5,
            postCount: 1,
          },
        },
      },
    }),
  )
  try {
    assert.match(wakeupMount.host.textContent ?? '', /@author/)
    const pill = wakeupMount.host.querySelector<HTMLButtonElement>('.sw-receipt-pill')!
    assert.ok(wakeupMount.host.querySelector('.sw-receipt-open') === null, '唤醒卡片同样无尾部 chevron 按钮')
    await act(async () => {
      pill.click()
    })
    assert.deepEqual(wakeupSpy.workbenchCalls, ['plugin:builtin:swarm/groups'])
  } finally {
    wakeupMount.unmount()
  }
})

// ---------------------------------------------------------------------------
// 6. Pure model spot checks & static hard rules
// ---------------------------------------------------------------------------

test('纯模型抽查：严格边界解析、正交交付进度、SwarmToolView/ActiveTray/Panel 回退补齐', { timeout: 60_000 }, async () => {
  const validView = parseBoardView(boardViewFixture())
  assert.ok(validView !== undefined)
  assert.equal(postDigestLine('line one\nline two', 10), 'line one')
  assert.equal(postDigestLine('   \n second  line ', 40), 'second line', '空白折叠取首行')
  assert.equal(parseBoardView({ group: null }), undefined, '非法结构显式拒绝')
  assert.equal(parseBoardView(undefined), undefined)

  // Strict parsing rejects bad enums/missing required fields rather than fabricating defaults
  const badStatus = boardViewFixture()
  ;(badStatus.group as { status: string }).status = 'weird'
  assert.equal(parseBoardView(badStatus), undefined)

  const badKindPost = (boardViewFixture().posts as Array<Record<string, unknown>>)[0]!
  assert.equal(parseBoardPost({ ...badKindPost, kind: 'invented' }), undefined)
  assert.equal(parseBoardPost({ ...badKindPost, channel: '' }), undefined)
  assert.equal(parseBoardReadPosts({ posts: [{ ...badKindPost, kind: 'bad' }] }), undefined)

  // Orthogonal completion progress: active + idle + caught-up cursor + lastOutboundEdge done/handoff
  const baseMember = validView!.members[0]!
  assert.equal(
    isMemberDelivered({
      ...baseMember,
      liveState: 'idle',
      lastOutboundEdge: { seq: 2, to: ['verifier'], kind: 'handoff' },
    }),
    true,
  )
  assert.equal(
    isMemberDelivered({
      ...baseMember,
      liveState: 'idle',
      lastOutboundEdge: undefined,
    }),
    false,
  )
  assert.deepEqual(
    boardProgressOf([
      { ...baseMember, liveState: 'idle', lastOutboundEdge: { seq: 2, to: ['coordinator'], kind: 'done' } },
      { ...validView!.members[1]!, liveState: 'working' },
    ]),
    { done: 1, total: 2 },
  )

  // SwarmToolView scopes @member lookup to current group, renders .trace-row, prefers structuredOutput
  setStubState({
    docs: {
      index: {
        workers: [
          { conversationId: 901, coordinatorConversationId: 900, profileId: 'coder', groupId: 'grp-other', name: 'author', createdAt: 1 },
          { conversationId: 51, coordinatorConversationId: 50, profileId: 'coder', groupId: 'grp-live', name: 'author', createdAt: 2 },
        ],
        groups: [],
      },
      'board-badges': { byConversation: {} },
    },
  })
  const tvSpy = makeSpyCtx({ conversationId: 50 })
  const tvMount = await mount(
    tvSpy,
    e(components.SwarmToolView, toolViewProps({
      toolName: 'swarm_inspect_worker',
      input: { groupId: 'grp-live', name: 'author' },
      result: 'Member @author (#51)',
      structuredOutput: { groupId: 'grp-live', conversationId: 51, name: 'author' },
    })),
  )
  try {
    const btn = tvMount.host.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!
    assert.ok(btn.classList.contains('trace-row'), '必须挂载宿主 .trace-row 基础类')
    await act(async () => {
      btn.click()
    })
    assert.deepEqual(tvSpy.drawerCalls, [51], '按当前组过滤同短名成员，绝不跳到并发他组 #901')
  } finally {
    tvMount.unmount()
  }

  // SwarmActiveTray consumes live.tools / pendingAsks from useConversation(includeDetail: false)
  setStubState({
    docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
    sessionDocs: { 'builtin:swarm/board-view/50': boardViewFixture() },
    conversationLives: {
      52: {
        conversationId: 52,
        text: '',
        tools: [{ callId: 'c1', toolName: 'bash', input: { command: 'pnpm test:unit' }, status: 'running' }],
        updatedAt: Date.now(),
      },
    },
  })
  const liveTraySpy = makeSpyCtx({ conversationId: 50 })
  const liveTray = await mount(
    liveTraySpy,
    e(components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
  )
  try {
    assert.match(liveTray.host.textContent ?? '', /pnpm test:unit/)
    await act(async () => {
      liveTray.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!.click()
    })
    assert.match(liveTray.host.querySelector('.sw-tray-row-live')?.textContent ?? '', /bash: pnpm test:unit/)
  } finally {
    liveTray.unmount()
  }

  // Archived worker evicted from index falls back via board_status({}) + board_read({ groupId })
  const evictedBoard = boardViewFixture()
  ;(evictedBoard.group as { id: string; status: string }).id = 'grp-evicted'
  ;(evictedBoard.group as { status: string }).status = 'closed'
  setStubState({ docs: { index: { workers: [], groups: [] }, 'board-badges': { byConversation: {} } }, sessionDocs: {} })
  const calls: Array<{ actionId: string; input: unknown }> = []
  const archWorkerSpy = makeSpyCtx({
    conversationId: 52,
    callAction: async (actionId: string, input: unknown) => {
      calls.push({ actionId, input })
      if (actionId === 'board_status') return evictedBoard
      if (actionId === 'board_read') return { groupId: 'grp-evicted', headSeq: 3, posts: evictedBoard.posts }
      return {}
    },
  })
  const archWorkerPanel = await mount(
    archWorkerSpy,
    e(components.SwarmWorkbenchPanel, {
      conversation: convSummary(52, 'verifier archived', { tags: ['swarm-worker-archived'] }),
    }),
  )
  try {
    assert.match(archWorkerPanel.host.textContent ?? '', /Completed/)
    assert.match(archWorkerPanel.host.textContent ?? '', /helmx\/author/)
    assert.deepEqual(calls, [{ actionId: 'board_status', input: {} }])
    await act(async () => {
      archWorkerPanel.host.querySelector<HTMLButtonElement>('.sw-panel-history-toggle')!.click()
    })
    assert.deepEqual(calls[1], { actionId: 'board_read', input: { groupId: 'grp-evicted', limit: 200 } })
  } finally {
    archWorkerPanel.unmount()
  }
  resetDefaultStubs()
})

test('静态铁律检查：swarm/client 全目录零 Emoji / 原生控件 / history / 本地状态灯样式', { timeout: 60_000 }, () => {
  const clientDir = fileURLToPath(new URL('../../plugins/src/swarm/client', import.meta.url))
  const files = readdirSync(clientDir).filter((f) => /\.(ts|tsx|css)$/.test(f))
  assert.ok(files.length >= 10, `预期改动后的 client 目录文件数（实际 ${files.length}）`)
  for (const file of files) {
    const content = readFileSync(join(clientDir, file), 'utf8')
    assert.equal(EMOJI_RE.test(content), false, `严禁包含 Emoji：${file}`)
    assert.equal(/<select[\s>]/.test(content), false, `严禁原生 <select>：${file}`)
    assert.equal(/type=['"]checkbox['"]/i.test(content), false, `严禁原生 checkbox：${file}`)
    assert.equal(/history\.(push|replace)State/.test(content), false, `严禁直接操作 history：${file}`)
    if (file.endsWith('.css')) {
      assert.equal(
        /(^|\n)\.status-dot\b/.test(content),
        false,
        `状态灯样式归属宿主，插件不得本地定义：${file}`,
      )
      assert.equal(
        /(^|\n)\.helmx-status-light\b/.test(content),
        false,
        `状态灯样式归属宿主，插件不得本地定义：${file}`,
      )
    }
  }
})
