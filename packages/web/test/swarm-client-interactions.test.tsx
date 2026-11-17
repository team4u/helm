/**
 * builtin:swarm 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖：
 * 1. UI 扩展注册不变量（registerSwarmUi：无 sidebarItem、无 start-swarm-group、ui.command 注册 slash:'swarm' + insert:'/swarm '、board screen、双向顶栏动作、单行回执渲染器、@/# composerCompleter、绝不占用 COMPOSER_DOCK_SLOT、双语 LocalizedText）；
 * 2. 主控与组内 Worker 顶栏双向定位角标按钮（Worker 自动附带 worker=<name>）与 swarm:board-report / swarm:board-wakeup 单行回执胶囊 #seq 跳转；
 * 3. SwarmBoardScreen 实时 sessionDoc 宽屏正交 SVG 拓扑、频道 Tabs 切换、分屏与 <=680px 窄屏自动收敛紧凑角色胶囊条、stall/blocker/unmerged Callout 急救按钮、两态 close_group、底部人工发帖栏（MultiSelect + 正交 wake Switch + 15px 输入框）；
 * 4. 右侧 540px 成员详情抽屉（working 态 abort_worker、空闲态 Radix 模型 Select -> switch_worker_model、跨插件 builtin:workflow inspect_worktree 快照与请求主控合入 submitInput、子会话抽屉与归档）；
 * 5. closed 历史组（含 retainedWorktrees）与 coordinatorDetached 组自动退避 board_status + board_read 无白屏加载；
 * 6. 空态页纯只读 /swarm 引导、failure Retry、zh-CN 双语文案、零 Emoji、零原生 <select>/<input type="checkbox"> 与 Fast Refresh 组件导出纯度。
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
  type HelmPluginContext,
  type LocalizedText,
  type PluginClientContext as PluginClientContextType,
  type ScreenProps,
  type TimelineRendererProps,
} from '@helm/protocol'
import type { PluginClientHostPort, PluginSessionDocKey } from '@helm/plugin-client'
import {
  buildBoardScreenTarget,
  computeOrthogonalTopology,
  parseBoardView,
  parseWorktreeInspectSnapshot,
} from '../../plugins/src/swarm/client/board-model.js'
import { registerSwarmUi } from '../../plugins/src/swarm/ui.js'
import { ensureHappyDom, typeIntoControl } from './helpers/dom-harness.js'

ensureHappyDom()

const { createRoot } = await import('react-dom/client')
const { PluginClientContext, PluginClientHostContext, resolveLocalizedText } = await import('@helm/plugin-client')
const { importBuiltinClientModule, mountSharedPluginNamespaces } = await import('./helpers/builtin-clients.js')

const e = React.createElement
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

mountSharedPluginNamespaces({ realHooks: true })

interface SwarmClientComponents {
  SwarmBoardScreen: (p: ScreenProps) => React.ReactElement
  SwarmOpenBoardAction: (p: { conversation?: ConversationSummary }) => React.ReactElement
  SwarmBoardReportPill: (p: TimelineRendererProps) => React.ReactElement
  SwarmBoardWakeupPill: (p: TimelineRendererProps) => React.ReactElement
}

let rawModule: Record<string, unknown>
let components: SwarmClientComponents

before(async () => {
  const mod = await importBuiltinClientModule('builtin:swarm')
  rawModule = mod
  components = {
    SwarmBoardScreen: mod['SwarmBoardScreen'] as SwarmClientComponents['SwarmBoardScreen'],
    SwarmOpenBoardAction: mod['SwarmOpenBoardAction'] as SwarmClientComponents['SwarmOpenBoardAction'],
    SwarmBoardReportPill: mod['SwarmBoardReportPill'] as SwarmClientComponents['SwarmBoardReportPill'],
    SwarmBoardWakeupPill: mod['SwarmBoardWakeupPill'] as SwarmClientComponents['SwarmBoardWakeupPill'],
  }
}, { timeout: 60_000 })

interface ActionCallRecord {
  actionId: string
  input: unknown
  options?: CallActionOptions
}

interface SubmitCallRecord {
  text: string
  options?: { conversationId?: number; whenBusy?: string }
}

interface SpyCtx extends PluginClientContextType {
  screenCalls: string[]
  splitCalls: string[]
  drawerCalls: number[]
  actionCalls: ActionCallRecord[]
  submitCalls: SubmitCallRecord[]
  artifactCalls: string[]
  notifyCalls: Array<{ message: string; tone?: string }>
}

function makeSpyCtx(overrides: Partial<SpyCtx> = {}): SpyCtx {
  const screenCalls: string[] = []
  const splitCalls: string[] = []
  const drawerCalls: number[] = []
  const actionCalls: ActionCallRecord[] = []
  const submitCalls: SubmitCallRecord[] = []
  const artifactCalls: string[] = []
  const notifyCalls: Array<{ message: string; tone?: string }> = []
  const locale = overrides.locale ?? 'en'
  const base: PluginClientContextType = {
    pluginId: 'builtin:swarm',
    callAction: async (actionId, input, options) => {
      actionCalls.push({ actionId, input, ...(options !== undefined ? { options } : {}) })
      return {}
    },
    submitInput: async (text, options) => {
      submitCalls.push({ text, ...(options !== undefined ? { options } : {}) })
    },
    openScreen: (target) => {
      screenCalls.push(target)
    },
    openSplitScreen: (target) => {
      splitCalls.push(target)
    },
    openConversationDrawer: (id) => {
      drawerCalls.push(id)
    },
    openArtifact: (id) => {
      artifactCalls.push(id)
    },
    openWorkbench: () => {},
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
    screenCalls,
    splitCalls,
    drawerCalls,
    actionCalls,
    submitCalls,
    artifactCalls,
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
  convSummary(11, '修复构建与单测', { model: 'openai/gpt-5' }),
  convSummary(12, 'subagent 12', { model: 'anthropic/claude-sonnet-4-5' }),
]

const EMPTY_SESSION_DOC_STATE = Object.freeze({
  hasValue: false,
  deleted: false,
  connected: false,
})

let stubDocs: Record<string, unknown> = {}
let stubSessionStates: Record<string, { value: unknown; hasValue: boolean; deleted: boolean; connected: boolean }> = {}

function setStubState(options: {
  docs?: Record<string, unknown>
  sessionDocs?: Record<string, unknown>
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
}

const noopUnsubscribe = (): (() => void) => () => {}
const noopEnsurePluginDoc = async (): Promise<unknown> => undefined

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
  })
}

before(() => {
  resetDefaultStubs()
}, { timeout: 60_000 })

// ---------------------------------------------------------------------------
// 1. UI registrations & Fast Refresh contract
// ---------------------------------------------------------------------------

test('UI 注册契约：registerSwarmUi 注册看板 Screen/顶栏动作/单行回执/补全源，零 COMPOSER_DOCK_SLOT，双语文案非空且客户端导出仅含组件', { timeout: 60_000 }, () => {
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
  registerSwarmUi({ ui: uiProxy } as unknown as HelmPluginContext)

  const slots = recorded.filter((r) => r.method === 'slot')
  assert.equal(
    slots.some((s) => s.spec['target'] === COMPOSER_DOCK_SLOT),
    false,
    '严禁占用 WorkflowActiveTray 独占的 COMPOSER_DOCK_SLOT',
  )
  assert.equal(slots.length, 0, '不注册任何冲突 slot')

  const sidebarItems = recorded.filter((r) => r.method === 'sidebarItem')
  assert.equal(sidebarItems.length, 0, '移除侧边栏入口，不再注册 sidebarItem')

  const commands = recorded.filter((r) => r.method === 'command').map((r) => ({
    id: r.spec['id'],
    slash: r.spec['slash'],
    insert: r.spec['insert'],
    icon: r.spec['icon'],
    scope: r.spec['scope'],
  }))
  assert.deepEqual(commands, [
    { id: 'swarm', slash: 'swarm', insert: '/swarm ', icon: 'network', scope: undefined },
  ])

  const screens = recorded.filter((r) => r.method === 'screen').map((r) => ({
    id: r.spec['id'],
    exportName: (r.spec['client'] as { export: string }).export,
  }))
  assert.deepEqual(screens, [{ id: 'board', exportName: 'SwarmBoardScreen' }])

  const actions = recorded.filter((r) => r.method === 'action').map((r) => ({
    id: r.spec['id'],
    target: r.spec['target'],
    placement: r.spec['placement'],
    scope: r.spec['scope'],
  }))
  assert.deepEqual(actions, [
    {
      id: 'open-swarm-board',
      target: 'conversation:header',
      placement: 'toolbar',
      scope: { tags: ['swarm-coordinator', 'swarm-worker'] },
    },
  ])

  const renderers = recorded
    .filter((r) => r.method === 'timelineRenderer')
    .map((r) => (r.spec['matchMeta'] as { renderer: string }).renderer)
  assert.deepEqual(renderers, ['swarm:board-report', 'swarm:board-wakeup'])

  const completers = recorded.filter((r) => r.method === 'composerCompleter').map((r) => ({
    id: r.spec['id'],
    trigger: r.spec['trigger'],
    scope: r.spec['scope'],
    source: r.spec['source'],
  }))
  assert.deepEqual(completers, [
    {
      id: 'swarm-board-members',
      trigger: '@',
      scope: { tags: ['swarm-coordinator', 'swarm-worker'] },
      source: { kind: 'action', actionId: 'complete_board_members' },
    },
    {
      id: 'swarm-board-channels',
      trigger: '#',
      scope: { tags: ['swarm-coordinator', 'swarm-worker'] },
      source: { kind: 'action', actionId: 'complete_board_channels' },
    },
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

  // Fast Refresh：编译产物模块除 __helmClientCss 外全部为大写开头的组件函数，且不再导出 SwarmStartGroupAction
  assert.equal('SwarmStartGroupAction' in rawModule, false, '移除废弃的 SwarmStartGroupAction 导出')
  for (const [exportName, value] of Object.entries(rawModule)) {
    if (exportName === '__helmClientCss') continue
    assert.match(exportName, /^[A-Z]/, `client 入口导出必须为 PascalCase 组件：${exportName}`)
    assert.equal(typeof value, 'function', `导出 ${exportName} 必须为组件函数`)
  }
})

// ---------------------------------------------------------------------------
// 2. Header Bidirectional Entry & Timeline Receipt Pills
// ---------------------------------------------------------------------------

test('SwarmOpenBoardAction 与单行回执胶囊：主控与 Worker 双向定位看板，点击 #seq 聚焦对应流转卡', { timeout: 60_000 }, async () => {
  const swarmIndex = {
    workers: [
      {
        conversationId: 41,
        coordinatorConversationId: 40,
        profileId: 'coder',
        groupId: 'grp-1',
        name: 'author',
        createdAt: 1,
      },
    ],
    groups: [
      {
        id: 'grp-1',
        title: '鉴权联调',
        coordinatorConversationId: 40,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 6,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  }
  const badgesDoc = {
    byConversation: {
      '40': { groupId: 'grp-1', coordinatorConversationId: 40, count: 2, tone: 'warn', footerText: 'author blocked' },
      '41': { groupId: 'grp-1', coordinatorConversationId: 40, count: 2, tone: 'accent' },
    },
  }
  setStubState({ docs: { index: swarmIndex, 'board-badges': badgesDoc } })
  const prevWidth = window.innerWidth
  window.innerWidth = 1280
  try {
    // 主控会话点击 -> 打开看板
    const coordSpy = makeSpyCtx({ conversationId: 40 })
    const coordMount = await mount(
      coordSpy,
      e(components.SwarmOpenBoardAction, { conversation: convSummary(40, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      assert.ok(coordMount.host.querySelector('.badge-warn') !== null, 'warn 态势映射至角标样式')
      assert.match(coordMount.host.textContent ?? '', /2/)
      await act(async () => {
        coordMount.host.querySelector('button')!.click()
      })
      assert.deepEqual(coordSpy.splitCalls, ['screen:builtin:swarm/board?groupId=grp-1'])
    } finally {
      coordMount.unmount()
    }

    // Worker 子会话点击 -> 自动附带 worker=author 参数
    const workerSpy = makeSpyCtx({ conversationId: 41 })
    const workerMount = await mount(
      workerSpy,
      e(components.SwarmOpenBoardAction, { conversation: convSummary(41, 'Author', { tags: ['swarm-worker'] }) }),
    )
    try {
      await act(async () => {
        workerMount.host.querySelector('button')!.click()
      })
      assert.deepEqual(workerSpy.splitCalls, ['screen:builtin:swarm/board?groupId=grp-1&worker=author'])
    } finally {
      workerMount.unmount()
    }

    // 单行回执胶囊（swarm:board-report / swarm:board-wakeup）点击 #seq 打开分屏定位 seq
    const reportSpy = makeSpyCtx({ conversationId: 40 })
    const reportMount = await mount(
      reportSpy,
      e(components.SwarmBoardReportPill, {
        conversationId: 40,
        entry: {
          id: 'e-10',
          kind: 'helm.input',
          data: {
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-1',
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
      assert.match(reportMount.host.textContent ?? '', /#4\.\.#6/)
      assert.match(reportMount.host.textContent ?? '', /3 posts/)
      assert.match(reportMount.host.textContent ?? '', /verifier approved #5/)
      const seqBtn = reportMount.host.querySelector<HTMLButtonElement>('.sw-seq-jump-btn')
      assert.ok(seqBtn !== null)
      await act(async () => {
        seqBtn.click()
      })
      assert.deepEqual(reportSpy.splitCalls, ['screen:builtin:swarm/board?groupId=grp-1&seq=6'])
    } finally {
      reportMount.unmount()
    }

    const wakeupSpy = makeSpyCtx({ conversationId: 41 })
    const wakeupMount = await mount(
      wakeupSpy,
      e(components.SwarmBoardWakeupPill, {
        conversationId: 41,
        entry: {
          id: 'e-11',
          kind: 'helm.input',
          data: {
            meta: {
              renderer: 'swarm:board-wakeup',
              groupId: 'grp-1',
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
      const seqBtn = wakeupMount.host.querySelector<HTMLButtonElement>('.sw-seq-jump-btn')
      assert.ok(seqBtn !== null)
      await act(async () => {
        seqBtn.click()
      })
      assert.deepEqual(wakeupSpy.splitCalls, ['screen:builtin:swarm/board?groupId=grp-1&worker=author&seq=5'])
    } finally {
      wakeupMount.unmount()
    }
  } finally {
    window.innerWidth = prevWidth
    resetDefaultStubs()
  }
})

// ---------------------------------------------------------------------------
// 3. SwarmBoardScreen: Topology, Tabs, Rescue Callouts, Post Bar, 540px Drawer & Dual-Channel Fallback
// ---------------------------------------------------------------------------

function makeBoardFixture(overrides: Record<string, unknown> = {}) {
  const longText = Array.from({ length: 12 }, (_, idx) => `Line ${idx + 1}: detailed audit findings for #1`).join('\n')
  return {
    group: {
      id: 'grp-live',
      title: '协同审改组',
      objective: '零回归完成鉴权改造',
      coordinatorConversationId: 50,
      coordinatorGuard: true,
      status: 'active',
      activeWorkerCount: 2,
      headSeq: 3,
      channels: [
        { name: 'main' },
        { name: 'review', topic: 'Cross review' },
      ],
      createdAt: 1000,
      updatedAt: 2000,
    },
    headline: {
      text: 'Stall: @verifier has unread handoff #2 without reply',
      tone: 'warn',
      kind: 'stall',
      targetMember: 'verifier',
      refSeq: 2,
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
        channels: ['main', 'review'],
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 1,
        lastPostSeq: 2,
        createdAt: 1000,
        liveState: 'idle',
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
        channels: ['main', 'review'],
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
        channel: 'review',
        from: 'author',
        to: ['verifier'],
        resolvedTargets: ['verifier'],
        wake: true,
        kind: 'handoff',
        refs: [1],
        body: longText,
        worktreeSnapshot: {
          worktreeId: 'wt-author-1',
          branch: 'helm/author',
          commitsAhead: 2,
          dirtyCount: 1,
          changedFilesPreview: ['src/auth.ts'],
        },
        createdAt: 1500,
      },
      {
        seq: 3,
        groupId: 'grp-live',
        channel: 'main',
        from: 'author',
        to: ['coordinator'],
        resolvedTargets: ['coordinator'],
        wake: false,
        kind: 'comment',
        refs: [2],
        body: 'FYI: benchmark baseline recorded for #2.',
        createdAt: 1600,
      },
    ],
    activeWorkingMembers: ['verifier'],
    ...overrides,
  }
}

test('SwarmBoardScreen：宽屏渲染正交 SVG 拓扑与连线过滤，频道 Tabs，isSplit/<=680px 收敛紧凑角色胶囊条，急救按钮与人工发帖栏', { timeout: 60_000 }, async () => {
  const boardView = makeBoardFixture()
  const swarmIndex = {
    workers: [],
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
  setStubState({
    docs: { index: swarmIndex, 'board-badges': { byConversation: {} } },
    sessionDocs: { 'builtin:swarm/board-view/50': boardView },
  })

  const prevWidth = window.innerWidth
  window.innerWidth = 1280
  const paramPatches: Array<Record<string, string | undefined>> = []
  const spy = makeSpyCtx({ conversationId: 50 })

  const wide = await mount(
    spy,
    e(components.SwarmBoardScreen, {
      pluginId: 'builtin:swarm',
      screenId: 'board',
      isSplit: false,
      params: { groupId: 'grp-live' },
      setParams: (patch) => {
        paramPatches.push(patch)
      },
    }),
    [
      convSummary(50, '主控会话', { model: 'google/gemini-2.5-pro', tags: ['swarm-coordinator'] }),
      convSummary(51, 'Author', { model: 'openai/gpt-5', tags: ['swarm-worker'] }),
      convSummary(52, 'Verifier', { model: 'anthropic/claude-sonnet-4-5', tags: ['swarm-worker'] }),
    ],
  )
  try {
    // 零原生 <select>、零原生 checkbox、零 Emoji
    assert.equal(wide.host.querySelectorAll('select').length, 0, '严禁原生 <select>')
    assert.equal(wide.host.querySelectorAll('input[type="checkbox"]').length, 0, '严禁原生 checkbox')
    assert.equal(EMOJI_RE.test(wide.host.textContent ?? ''), false, '看板主舞台零 Emoji')

    // 1) 宽屏全屏渲染 SVG 正交拓扑图与聚合连线
    assert.ok(wide.host.querySelector('[data-topology-mode="svg"] svg') !== null, '宽屏渲染正交 SVG 协同图')
    const edgeEl = wide.host.querySelector<SVGGElement>('[data-edge="author->verifier"]')
    assert.ok(edgeEl !== null, '渲染聚合流转边 author->verifier')
    assert.equal(wide.host.querySelectorAll('.sw-post-card').length, 3, '初始展示全部 3 条流转卡')

    // 点击频道 Tab 写入 channel 参数
    const reviewTab = [...wide.host.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) =>
      el.textContent?.includes('#review'),
    )
    assert.ok(reviewTab !== undefined, '渲染 #review 频道 Tab')
    await act(async () => {
      reviewTab.click()
    })
    assert.deepEqual(paramPatches[paramPatches.length - 1], { channel: 'review' })

    // 点击 SVG 连线筛选流转流
    await act(async () => {
      edgeEl.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    assert.equal(wide.host.querySelectorAll('.sw-post-card').length, 1, '按连线过滤仅剩 #2')
    assert.equal(wide.host.querySelector('.sw-post-card')?.getAttribute('data-seq'), '2')

    // 长文折叠与展开 + Worktree 内联摘要展示
    assert.match(wide.host.textContent ?? '', /helm\/author · \+2 commits · 1 dirty/)
    const expandBtn = [...wide.host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Expand full text'),
    )
    assert.ok(expandBtn !== undefined, '长正文默认折叠并提供展开按钮')
    await act(async () => {
      expandBtn.click()
    })
    assert.match(wide.host.textContent ?? '', /Line 12: detailed audit findings/)

    // 点击清除筛选恢复全量流转卡，并验证 wake=false 被动留言徽标与 #ref 跳读
    const clearBtn = [...wide.host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Clear filter'),
    )
    assert.ok(clearBtn !== undefined)
    await act(async () => {
      clearBtn.click()
    })
    assert.equal(wide.host.querySelectorAll('.sw-post-card').length, 3)
    assert.match(wide.host.textContent ?? '', /Note only \(wake=false\)/, '被动留言展示未唤醒徽标')

    const refPill = wide.host.querySelector<HTMLButtonElement>('.sw-post-card[data-seq="3"] .sw-ref-pill')
    assert.ok(refPill !== null)
    await act(async () => {
      refPill.click()
    })
    assert.deepEqual(paramPatches[paramPatches.length - 1], { seq: '2' }, '点击 #ref 写入 seq 参数跳读')

    // 2) stall 急救横幅 Callout 一键唤醒
    const wakeBtn = [...wide.host.querySelectorAll<HTMLButtonElement>('.callout button')].find((b) =>
      b.textContent?.includes('Wake Now'),
    )
    assert.ok(wakeBtn !== undefined, 'stall 态势渲染 Callout 一键唤醒按钮')
    await act(async () => {
      wakeBtn.click()
    })
    assert.equal(spy.actionCalls[0]?.actionId, 'board_post')
    assert.deepEqual((spy.actionCalls[0]?.input as { to: string[]; wake: boolean }).to, ['verifier'])
    assert.equal((spy.actionCalls[0]?.input as { wake: boolean }).wake, true)

    // 3) coordinatorGuard Switch 与两态 close_group 按钮（保留分支 vs 全清关闭）
    const guardSwitch = wide.host.querySelector<HTMLElement>('.sw-board-control-right [role="switch"]')
    assert.ok(guardSwitch !== null)
    await act(async () => {
      guardSwitch.click()
    })
    assert.equal(spy.actionCalls[1]?.actionId, 'update_group')
    assert.deepEqual(spy.actionCalls[1]?.input, { groupId: 'grp-live', coordinatorGuard: false })

    const unlockMergeBtn = [...wide.host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Unlock & Keep Branches'),
    )
    assert.ok(unlockMergeBtn !== undefined)
    await act(async () => {
      unlockMergeBtn.click()
    })
    assert.equal(spy.actionCalls[2]?.actionId, 'close_group')
    assert.deepEqual(spy.actionCalls[2]?.input, {
      groupId: 'grp-live',
      keepWorktree: true,
      abortRunning: true,
    })

    const cleanCloseBtn = [...wide.host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Close & Clean Up'),
    )
    assert.ok(cleanCloseBtn !== undefined)
    await act(async () => {
      cleanCloseBtn.click()
    })
    const cleanCloseCall = spy.actionCalls.find(
      (c) => c.actionId === 'close_group' && (c.input as { keepWorktree?: boolean }).keepWorktree === undefined,
    )
    assert.deepEqual(cleanCloseCall?.input, { groupId: 'grp-live' })

    // 4) 底部人工直连栏：MultiSelect 选择 #review 频道 + wake 开关切换 + 15px 输入框提交 board_post
    const multiTrigger = wide.host.querySelector<HTMLButtonElement>('.sw-post-target-select .helm-select-trigger')
    assert.ok(multiTrigger !== null, '渲染 MultiSelect 目标选择器')
    await act(async () => {
      multiTrigger.click()
    })
    const reviewOpt = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
      el.textContent?.includes('#review'),
    )
    assert.ok(reviewOpt !== undefined, 'MultiSelect 包含 #review 子频道目标')
    await act(async () => {
      reviewOpt.click()
    })

    const postWakeSwitch = wide.host.querySelector<HTMLElement>('.sw-human-post-controls [role="switch"]')
    assert.ok(postWakeSwitch !== null)
    await act(async () => {
      postWakeSwitch.click()
    })

    const postInput = wide.host.querySelector<HTMLTextAreaElement>('.sw-post-input')
    assert.ok(postInput !== null, '渲染 15px 人工输入框')
    await act(async () => {
      typeIntoControl(postInput, 'Please prioritize auth token expiry edge case.')
    })

    const postBtn = wide.host.querySelector<HTMLButtonElement>('.sw-post-send-btn')
    assert.ok(postBtn !== null)
    await act(async () => {
      postBtn.click()
    })
    const lastPostCall = spy.actionCalls.find(
      (c) => c.actionId === 'board_post' && (c.input as { body?: string }).body?.includes('token expiry'),
    )
    assert.ok(lastPostCall !== undefined, '底部人工输入栏触发 board_post')
    assert.deepEqual(lastPostCall.input, {
      groupId: 'grp-live',
      to: ['#review'],
      kind: 'handoff',
      wake: false,
      body: 'Please prioritize auth token expiry edge case.',
    })
  } finally {
    wide.unmount()
  }

  // 5) isSplit: true 自动收敛为紧凑横排角色胶囊条
  const split = await mount(
    spy,
    e(components.SwarmBoardScreen, {
      pluginId: 'builtin:swarm',
      screenId: 'board',
      isSplit: true,
      params: { groupId: 'grp-live', worker: 'author' },
      setParams: () => {},
    }),
  )
  try {
    assert.ok(split.host.querySelector('[data-topology-mode="pills"]') !== null, '分屏模式收敛为紧凑角色胶囊条')
    assert.ok(split.host.querySelector('[data-topology-mode="svg"]') === null, '分屏不渲染宽幅 SVG')
    const highlighted = split.host.querySelector('.sw-role-pill[data-member="author"]')
    assert.ok(highlighted?.classList.contains('is-highlighted') === true, 'worker 参数高亮对应角色胶囊')
    const verifierLight = split.host.querySelector('.sw-role-pill[data-member="verifier"] .helm-status-light-working')
    assert.ok(verifierLight !== null, '紧凑胶囊复用 StatusLight 渲染 working 状态灯')
    assert.equal(verifierLight.getAttribute('aria-label'), 'Working')
    assert.ok(verifierLight.querySelector('.status-dot-working') !== null)
  } finally {
    split.unmount()
  }

  // 6) <= 680px 窄屏全屏同样自动收敛为紧凑横排角色胶囊条
  window.innerWidth = 520
  const narrow = await mount(
    spy,
    e(components.SwarmBoardScreen, {
      pluginId: 'builtin:swarm',
      screenId: 'board',
      isSplit: false,
      params: { groupId: 'grp-live' },
      setParams: () => {},
    }),
  )
  try {
    assert.ok(narrow.host.querySelector('[data-topology-mode="pills"]') !== null, '<=680px 窄屏收敛为紧凑胶囊条')
  } finally {
    narrow.unmount()
    window.innerWidth = prevWidth
    resetDefaultStubs()
  }
})

test('右侧 540px 成员详情抽屉：working 态暴露 abort_worker，空闲态暴露模型 Select、workflow inspect_worktree 快照与合入请求', { timeout: 60_000 }, async () => {
  const blockerBoard = makeBoardFixture({
    headline: {
      text: 'Blocker: @author quota exhausted on openai/gpt-5',
      tone: 'err',
      kind: 'blocker',
      targetMember: 'author',
    },
  })
  const swarmIndex = {
    workers: [],
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
  setStubState({
    docs: { index: swarmIndex, 'board-badges': { byConversation: {} } },
    sessionDocs: { 'builtin:swarm/board-view/50': blockerBoard },
  })

  const spy = makeSpyCtx({ conversationId: 50 })
  spy.callAction = async (actionId, input, options) => {
    spy.actionCalls.push({ actionId, input, ...(options !== undefined ? { options } : {}) })
    if (actionId === 'inspect_worktree') {
      return {
        record: {
          id: 'wt-author-1',
          path: '/repo-wt/author',
          branch: 'helm/author',
          nodeId: 'local',
          baseCommit: 'abcdef1234567890',
          status: 'active',
          origin: 'native',
        },
        exists: true,
        currentBranch: 'helm/author',
        dirtyFiles: ['M src/auth.ts'],
        dirtyFileCount: 1,
        dirtyFilesTruncated: false,
        commitsAhead: 2,
        diffStat: ' src/auth.ts | 14 ++++++++++++--',
        diffPreview: '+export function verifyToken() {}',
        diffTruncated: false,
        diffBase: 'baseCommit',
      }
    }
    return {}
  }

  const prevWidth = window.innerWidth
  window.innerWidth = 1280
  const { host, unmount } = await mount(
    spy,
    e(components.SwarmBoardScreen, {
      pluginId: 'builtin:swarm',
      screenId: 'board',
      isSplit: true,
      params: { groupId: 'grp-live' },
      setParams: () => {},
    }),
    [
      convSummary(50, '主控', { model: 'google/gemini-2.5-pro' }),
      convSummary(51, 'Author', { model: 'openai/gpt-5' }),
      convSummary(52, 'Verifier', { model: 'anthropic/claude-sonnet-4-5' }),
    ],
  )
  try {
    // 1) 点击 working 态成员 @verifier -> 打开 540px 抽屉 -> 暴露 Abort Current Turn
    const verifierPill = host.querySelector<HTMLButtonElement>('.sw-role-pill[data-member="verifier"]')
    assert.ok(verifierPill !== null)
    await act(async () => {
      verifierPill.click()
    })

    let drawer = document.body.querySelector('.primary-drawer-content.sw-member-drawer')
    assert.ok(drawer !== null, '打开右侧 540px primary-drawer-content 抽屉')
    assert.ok(
      drawer.querySelector('.primary-drawer-title-row .helm-status-light-working .status-dot-working') !== null,
      '抽屉头部复用 StatusLight 渲染成员态指示灯',
    )
    const abortBtn = [...drawer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Abort Current Turn'),
    )
    assert.ok(abortBtn !== undefined, 'working 态暴露 abort_worker 按钮')
    assert.ok(drawer.querySelector('[aria-label="Member model selector"]') === null, 'working 态不渲染模型切换 Select')

    await act(async () => {
      abortBtn.click()
    })
    assert.deepEqual(spy.actionCalls[0], {
      actionId: 'abort_worker',
      input: { groupId: 'grp-live', name: 'verifier', workerConversationId: 52 },
    })

    // 关闭抽屉后，通过 blocker 急救条「Switch Model / Inspect」一键打开空闲态 @author 抽屉
    const closeBtn = drawer.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
    assert.ok(closeBtn !== null)
    await act(async () => {
      closeBtn.click()
    })

    const rescueInspectBtn = [...host.querySelectorAll<HTMLButtonElement>('.callout button')].find((b) =>
      b.textContent?.includes('Switch Model / Inspect'),
    )
    assert.ok(rescueInspectBtn !== undefined, 'blocker 急救条提供一键打开成员切模抽屉按钮')
    await act(async () => {
      rescueInspectBtn.click()
    })
    await act(async () => {})

    drawer = document.body.querySelector('.primary-drawer-content.sw-member-drawer')
    assert.ok(drawer !== null)
    assert.equal(drawer.querySelectorAll('select').length, 0, '抽屉内严禁原生 <select>')

    // 验证跨插件调用 builtin:workflow inspect_worktree 并渲染快照
    const wtCall = spy.actionCalls.find((c) => c.actionId === 'inspect_worktree')
    assert.deepEqual(wtCall, {
      actionId: 'inspect_worktree',
      input: { worktreeId: 'wt-author-1' },
      options: { pluginId: 'builtin:workflow' },
    })
    assert.match(drawer.textContent ?? '', /helm\/author/)
    assert.match(drawer.textContent ?? '', /verifyToken/)

    // 验证空闲态 Radix Select 切换模型 -> switch_worker_model
    const modelCombo = drawer.querySelector<HTMLElement>('[role="combobox"][aria-label="Member model selector"]')
    assert.ok(modelCombo !== null, '空闲态渲染 Radix 模型 Select')
    await act(async () => {
      modelCombo.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    const geminiOpt = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((el) =>
      el.textContent?.includes('google/gemini-2.5-pro'),
    )
    assert.ok(geminiOpt !== undefined, '模型下拉包含可选模型 google/gemini-2.5-pro')
    await act(async () => {
      geminiOpt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    const switchCall = spy.actionCalls.find((c) => c.actionId === 'switch_worker_model')
    assert.deepEqual(switchCall, {
      actionId: 'switch_worker_model',
      input: {
        groupId: 'grp-live',
        name: 'author',
        workerConversationId: 51,
        model: 'google/gemini-2.5-pro',
      },
    })

    // 验证 Request Coordinator Merge -> submitInput 到主控会话 #50
    const mergeBtn = [...drawer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Request Coordinator Merge'),
    )
    assert.ok(mergeBtn !== undefined)
    await act(async () => {
      mergeBtn.click()
    })
    assert.equal(spy.submitCalls.length, 1)
    assert.equal(spy.submitCalls[0]?.options?.conversationId, 50)
    assert.match(spy.submitCalls[0]?.text ?? '', /wt-author-1/)

    // 验证打开子会话抽屉与归档成员
    const openSubBtn = [...drawer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Open Sub-Conversation Drawer'),
    )
    assert.ok(openSubBtn !== undefined)
    await act(async () => {
      openSubBtn.click()
    })
    assert.deepEqual(spy.drawerCalls, [51])

    const archiveBtn = [...drawer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Archive Member'),
    )
    assert.ok(archiveBtn !== undefined)
    await act(async () => {
      archiveBtn.click()
    })
    const archiveCall = spy.actionCalls.find((c) => c.actionId === 'archive_worker')
    assert.deepEqual(archiveCall, {
      actionId: 'archive_worker',
      input: { groupId: 'grp-live', name: 'author', workerConversationId: 51 },
    })
  } finally {
    window.innerWidth = prevWidth
    unmount()
    resetDefaultStubs()
  }
})

test('双通道无白屏回退与 zh-CN 双语空态：closed 历史组及 coordinatorDetached 组自动调用 board_status + board_read，空态页支持中文启动', { timeout: 60_000 }, async () => {
  const swarmIndex = {
    workers: [],
    groups: [
      {
        id: 'grp-closed',
        title: '已结单保留分支组',
        coordinatorConversationId: 60,
        status: 'closed',
        activeWorkerCount: 0,
        headSeq: 4,
        createdAt: 1000,
        updatedAt: 3000,
        closedAt: 3000,
      },
      {
        id: 'grp-detached',
        title: '主控已删遗留组',
        coordinatorConversationId: 61,
        coordinatorDetached: true,
        status: 'active',
        activeWorkerCount: 1,
        headSeq: 1,
        createdAt: 1000,
        updatedAt: 2500,
      },
    ],
  }
  // 故意不挂载任何 sessionDoc，验证无白屏自动退避
  setStubState({ docs: { index: swarmIndex, 'board-badges': { byConversation: {} } }, sessionDocs: {} })

  const spy = makeSpyCtx({ conversationId: 60 })
  spy.callAction = async (actionId, input) => {
    spy.actionCalls.push({ actionId, input })
    const gid = (input as { groupId?: string })?.groupId
    if (actionId === 'board_status' && gid === 'grp-closed') {
      return makeBoardFixture({
        group: {
          id: 'grp-closed',
          title: '已结单保留分支组',
          coordinatorConversationId: 60,
          coordinatorGuard: false,
          status: 'closed',
          activeWorkerCount: 0,
          headSeq: 4,
          channels: [{ name: 'main' }],
          retainedWorktrees: [
            {
              memberName: 'author',
              worktreeId: 'wt-ret-1',
              branch: 'helm/feature-a',
              path: '/repo-wt/feature-a',
              commitsAhead: 3,
            },
          ],
          createdAt: 1000,
          updatedAt: 3000,
          closedAt: 3000,
        },
        headline: { text: 'Closed with 1 retained branch ready to merge', tone: 'ok', kind: 'closed' },
        posts: [],
        activeWorkingMembers: [],
      })
    }
    if (actionId === 'board_read' && gid === 'grp-closed') {
      return {
        groupId: 'grp-closed',
        headSeq: 4,
        posts: [
          {
            seq: 4,
            groupId: 'grp-closed',
            channel: 'main',
            from: 'verifier',
            to: ['coordinator'],
            resolvedTargets: ['coordinator'],
            wake: true,
            kind: 'done',
            refs: [],
            body: '[done] All integration checks green; branch helm/feature-a ready.',
            createdAt: 2900,
          },
        ],
      }
    }
    if (actionId === 'board_status' && gid === 'grp-detached') {
      return makeBoardFixture({
        group: {
          id: 'grp-detached',
          title: '主控已删遗留组',
          coordinatorConversationId: 61,
          coordinatorDetached: true,
          coordinatorGuard: true,
          status: 'active',
          activeWorkerCount: 1,
          headSeq: 1,
          channels: [{ name: 'main' }],
          createdAt: 1000,
          updatedAt: 2500,
        },
        headline: { text: 'Coordinator conversation deleted', tone: 'warn', kind: 'unmerged' },
        posts: [],
        activeWorkingMembers: [],
      })
    }
    if (actionId === 'board_read' && gid === 'grp-detached') {
      return { groupId: 'grp-detached', headSeq: 1, posts: [] }
    }
    return {}
  }

  // 1) closed 历史组退避加载 + 合并 board_read 记录 + 请求主控合入保留分支
  const closedMount = await mount(
    spy,
    e(components.SwarmBoardScreen, {
      pluginId: 'builtin:swarm',
      screenId: 'board',
      isSplit: true,
      params: { groupId: 'grp-closed' },
      setParams: () => {},
    }),
  )
  try {
    assert.deepEqual(
      spy.actionCalls.map((c) => c.actionId),
      ['board_status', 'board_read'],
      'closed 组自动并发拉取 board_status 与 board_read',
    )
    assert.match(closedMount.host.textContent ?? '', /All integration checks green/, '合并渲染 board_read 返回的历史消息')
    assert.match(closedMount.host.textContent ?? '', /helm\/feature-a/, '展示 retainedWorktrees 待合入分支')

    const mergeBtn = [...closedMount.host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Request Coordinator Merge'),
    )
    assert.ok(mergeBtn !== undefined)
    await act(async () => {
      mergeBtn.click()
    })
    assert.equal(spy.submitCalls.length, 1)
    assert.equal(spy.submitCalls[0]?.options?.conversationId, 60)
    assert.match(spy.submitCalls[0]?.text ?? '', /helm\/feature-a/)
  } finally {
    closedMount.unmount()
  }

  // 2) coordinatorDetached 组同样自动走 board_status + board_read 无白屏，且暴露解锁按钮
  spy.actionCalls.length = 0
  const detachedMount = await mount(
    spy,
    e(components.SwarmBoardScreen, {
      pluginId: 'builtin:swarm',
      screenId: 'board',
      isSplit: true,
      params: { groupId: 'grp-detached' },
      setParams: () => {},
    }),
  )
  try {
    assert.deepEqual(
      spy.actionCalls.map((c) => c.actionId),
      ['board_status', 'board_read'],
      'coordinatorDetached 组自动走退避快照读取',
    )
    assert.match(detachedMount.host.textContent ?? '', /Coordinator detached/)
    assert.ok(
      [...detachedMount.host.querySelectorAll<HTMLButtonElement>('button')].some((b) =>
        b.textContent?.includes('Unlock Coordinator to Merge'),
      ),
      'unmerged 态势暴露一键保留分支解锁按钮',
    )
  } finally {
    detachedMount.unmount()
  }

  // 3) zh-CN 双语空态与加载态验证（纯只读引导，零弹窗零表单）
  resetDefaultStubs()
  const zhSpy = makeSpyCtx({ locale: 'zh-CN', conversationId: 90 })
  const zhEmptyMount = await mount(
    zhSpy,
    e(components.SwarmBoardScreen, {
      pluginId: 'builtin:swarm',
      screenId: 'board',
      isSplit: false,
      params: {},
      setParams: () => {},
    }),
    [convSummary(90, '新建架构攻坚', { ownedBy: 'human', tags: [] })],
  )
  try {
    assert.match(zhEmptyMount.host.textContent ?? '', /协同流转看板/)
    assert.match(zhEmptyMount.host.textContent ?? '', /暂无协同工作组/)
    assert.match(zhEmptyMount.host.textContent ?? '', /\/swarm/)
    assert.equal(zhEmptyMount.host.querySelectorAll('select').length, 0)
    assert.equal(zhEmptyMount.host.querySelectorAll('button').length, 0, '空态页不再渲染启动按钮或弹窗触发器')
  } finally {
    zhEmptyMount.unmount()
    resetDefaultStubs()
  }
})

test('空态页纯只读 /swarm 引导与失败重试：board_status 失败展示错误横幅并支持 Retry', { timeout: 60_000 }, async () => {
  resetDefaultStubs()
  const spy = makeSpyCtx({ conversationId: undefined })
  const emptyMount = await mount(
    spy,
    e(components.SwarmBoardScreen, {
      pluginId: 'builtin:swarm',
      screenId: 'board',
      isSplit: false,
      params: {},
      setParams: () => {},
    }),
    [
      convSummary(71, '第一个会话', { ownedBy: 'human', tags: [] }),
      convSummary(72, '第二个会话', { ownedBy: 'human', tags: [] }),
    ],
  )
  try {
    assert.match(emptyMount.host.textContent ?? '', /No collaboration groups yet/)
    assert.match(emptyMount.host.textContent ?? '', /\/swarm <task>/)
    assert.equal(emptyMount.host.querySelectorAll('select').length, 0)
    assert.equal(emptyMount.host.querySelectorAll('button').length, 0)
    assert.equal(spy.actionCalls.length, 0)
  } finally {
    emptyMount.unmount()
  }

  // board_status 首次抛错 -> 渲染错误 Callout + Retry -> 重试成功渲染看板
  let attempts = 0
  const retrySpy = makeSpyCtx({ conversationId: undefined })
  retrySpy.callAction = async (actionId, input) => {
    retrySpy.actionCalls.push({ actionId, input })
    if (actionId === 'board_status') {
      attempts += 1
      if (attempts === 1) throw new Error('network transient failure')
      return makeBoardFixture({
        group: {
          id: 'grp-retry',
          title: '重试恢复组',
          coordinatorConversationId: 75,
          coordinatorGuard: true,
          status: 'closed',
          activeWorkerCount: 0,
          headSeq: 1,
          channels: [{ name: 'main' }],
          createdAt: 1000,
          updatedAt: 2000,
        },
        headline: { text: 'Recovered board status', tone: 'ok', kind: 'closed' },
        posts: [],
        activeWorkingMembers: [],
      })
    }
    return { groupId: 'grp-retry', headSeq: 1, posts: [] }
  }

  const retryMount = await mount(
    retrySpy,
    e(components.SwarmBoardScreen, {
      pluginId: 'builtin:swarm',
      screenId: 'board',
      isSplit: true,
      params: { groupId: 'grp-retry' },
      setParams: () => {},
    }),
  )
  try {
    assert.match(retryMount.host.textContent ?? '', /network transient failure/)
    const retryBtn = [...retryMount.host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Retry'),
    )
    assert.ok(retryBtn !== undefined)
    await act(async () => {
      retryBtn.click()
    })
    assert.match(retryMount.host.textContent ?? '', /Recovered board status/)
  } finally {
    retryMount.unmount()
    resetDefaultStubs()
  }
})

test('纯模型与静态铁律检查：多列正交 SVG 同列外轨连线、严格快照边界校验，以及 swarm/client 全目录 5 条硬铁律', { timeout: 60_000 }, () => {
  assert.equal(buildBoardScreenTarget({}), 'screen:builtin:swarm/board')
  assert.equal(
    buildBoardScreenTarget({ groupId: 'g1', channel: 'review', worker: 'author', seq: 9 }),
    'screen:builtin:swarm/board?groupId=g1&channel=review&worker=author&seq=9',
  )
  assert.equal(parseWorktreeInspectSnapshot({ invalid: true }), undefined, '非法快照显式拒绝不编造数据')

  // > 4 名成员自动双列排布并支持同列对等成员外轨正交连线
  const sixMembers = Array.from({ length: 6 }, (_, i) => ({
    name: `m${i + 1}`,
    conversationId: 100 + i,
    profileId: 'coder',
    access: 'readwrite',
    isolation: 'worktree',
    nodeId: 'local',
    cwd: `/wt/${i}`,
    channels: ['main'],
    lifecycle: 'active',
    readCursorSeq: 0,
    pendingWakeupSeq: 0,
    createdAt: 1,
    liveState: 'idle',
  }))
  const parsed = parseBoardView(
    makeBoardFixture({
      members: sixMembers,
      edges: [{ from: 'm1', to: 'm3', count: 2, lastSeq: 8, lastKind: 'handoff' }],
    }),
  )
  assert.ok(parsed !== undefined)
  const layout = computeOrthogonalTopology(parsed, 'coordinator')
  assert.equal(layout.nodes.length, 7, '1 coordinator + 6 peer workers')
  assert.equal(layout.edges.length, 1)
  assert.match(layout.edges[0]!.path, /^M \d+ \d+ L \d+ \d+ L \d+ \d+ L \d+ \d+$/)

  // 静态扫描 packages/plugins/src/swarm/client 与 ui.ts：零 Emoji、零原生 <select>、零 checkbox、零 history.*、.tsx 仅导出组件/类型
  const swarmDir = fileURLToPath(new URL('../../plugins/src/swarm', import.meta.url))
  const clientDir = join(swarmDir, 'client')
  const files = [
    join(swarmDir, 'ui.ts'),
    ...readdirSync(clientDir).map((f) => join(clientDir, f)),
  ]
  for (const file of files) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx') && !file.endsWith('.css')) continue
    const content = readFileSync(file, 'utf8')
    assert.equal(EMOJI_RE.test(content), false, `严禁包含 Emoji：${file}`)
    assert.equal(/<select[\s>]/.test(content), false, `严禁原生 <select>：${file}`)
    assert.equal(/type=['"]checkbox['"]/i.test(content), false, `严禁原生 checkbox：${file}`)
    assert.equal(/history\.(push|replace)State/.test(content), false, `严禁直接操作 history：${file}`)
    if (file.endsWith('.css')) {
      assert.equal(
        /(^|\n)\.status-dot\b/.test(content),
        false,
        `严禁在插件 CSS 重定义或覆盖宿主公共 .status-dot：${file}`,
      )
      assert.equal(
        /(^|\n)\.helm-status-light\b/.test(content),
        false,
        `严禁在插件 CSS 覆盖宿主 .helm-status-light：${file}`,
      )
    }
    if (file.endsWith('.tsx')) {
      const nonPascal = [
        ...content.matchAll(/^export\s+(?!interface\b|type\b)(?:const|let|var|function|class)\s+([a-z][A-Za-z0-9_]*)/gm),
      ]
      const valueReexports = [...content.matchAll(/^export\s+\{[^}]+\}/gm)]
      assert.equal(nonPascal.length, 0, `Fast Refresh 违规非组件导出：${file}`)
      assert.equal(valueReexports.length, 0, `Fast Refresh 违规值重导出：${file}`)
    }
  }
})
