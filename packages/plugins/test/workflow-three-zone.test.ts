/**
 * builtin:workflow 三区零重复与无损信息客户端全链路验收测试：
 * 1. 底部活动托盘（WorkflowActiveTray）：无在途返回 null（0px），有在途渲染 32px 单行 HUD，
 *    支持展开列清单与中止/转入后台/直达工作台/子会话抽屉，全部收敛后自动归零。
 * 2. 时间线单行 26px `.trace-row` 收口：
 *    - SubagentToolView：原生子会话点击开抽屉、外部代理点击定位工作台 run.id、前置错误可原地展开、
 *      后台派发句柄在途阶段绝不展示 ~34ms 派发确认耗时；
 *    - WorkflowToolView：点击定位工作台对应 run.id，无大卡片与节点展开噪声；
 *    - BackgroundReportCard：完成默认折叠单行回执（清洗 Markdown/JSON 摘要），失败/中止/损坏默认
 *      自动展开，展开无损呈现 runId、投递时间、完整 result、otherRunningTasks（含 runId）与复制按钮。
 * 3. 右侧工作台去重与无损承载（WorkflowWorkbenchPanel）：
 *    - 移除重复工作流库列表，保留跳转「工作流库」按钮；
 *    - 响应 workbench-focus 请求直开并高亮目标 run.id；
 *    - WorkflowRunCardBody 去除重复 .phase-bar、提供无损 kv-grid（运行 ID/时间/源/定义）与 Radix Popover `···` 菜单；
 *    - SubagentLiveCard / ExternalRunSummary / WorkflowNodeCards 无损展示任务标题（含 entries 回退）、坐标与时间戳。
 * 4. 图标与设计约束：WorkflowIcon 支持 search/play、零 Emoji、零 callout--warn 拼写错、Fast Refresh 只导出组件与类型。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { CLIENT_SHARED_GLOBALS, compilePluginClientModule } from '@helm/plugin-build'
import { PLUGIN_CLIENT_CSS_EXPORT, type ConversationDetail, type ConversationEntry, type ConversationSummary } from '@helm/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'

GlobalRegistrator.register()

const req = createRequire(new URL('../../plugin-client/package.json', import.meta.url))
const React = req('react') as typeof import('react')
const ReactDOM = req('react-dom') as typeof import('react-dom')
const ReactDOMClient = req('react-dom/client') as typeof import('react-dom/client')
const ReactJsxRuntime = req('react/jsx-runtime') as Record<string, unknown>
const LucideReact = req('lucide-react') as Record<string, unknown>
const SDK = await import('../../plugin-client/src/index.js')

const g = globalThis as Record<string, unknown>
g.React = React
g.IS_REACT_ACT_ENVIRONMENT = true
g[CLIENT_SHARED_GLOBALS['react']] = React
g[CLIENT_SHARED_GLOBALS['react-dom']] = ReactDOM
g[CLIENT_SHARED_GLOBALS['react-dom/client']] = ReactDOMClient
g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']] = ReactJsxRuntime
g[CLIENT_SHARED_GLOBALS['lucide-react']] = LucideReact
g[CLIENT_SHARED_GLOBALS['@helm/plugin-client']] = SDK

const e = React.createElement
const { act } = React
const { createRoot } = ReactDOMClient

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOW_CLIENT_DIR = resolve(__dirname, '../src/workflow/client')
const HERDR_CLIENT_DIR = resolve(__dirname, '../src/herdr/client')

interface WorkflowClientModule {
  WorkflowActiveTray: React.ComponentType<Record<string, unknown>>
  SubagentToolView: React.ComponentType<Record<string, unknown>>
  WorkflowToolView: React.ComponentType<Record<string, unknown>>
  BackgroundReportCard: React.ComponentType<Record<string, unknown>>
  WorkflowWorkbenchPanel: React.ComponentType<Record<string, unknown>>
  WorkflowLibraryScreen: React.ComponentType<Record<string, unknown>>
  SubagentLiveCard: React.ComponentType<Record<string, unknown>>
  ExternalRunSummary: React.ComponentType<Record<string, unknown>>
  [PLUGIN_CLIENT_CSS_EXPORT]?: string
}

let tempDir: string
let mod: WorkflowClientModule

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'helm-wf-three-zone-'))
  const bundle = await compilePluginClientModule('builtin:workflow', WORKFLOW_CLIENT_DIR, 'index.tsx', tempDir)
  const url = `data:text/javascript;base64,${Buffer.from(bundle.code, 'utf8').toString('base64')}`
  mod = (await import(url)) as WorkflowClientModule
})

after(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

interface HostStubLog {
  actions: Array<{ pluginId: string; actionId: string; input: unknown }>
  drawers: number[]
  workbenchTabs: string[]
  workbenchOpens: boolean[]
  screens: string[]
  notices: Array<{ message: string; tone: string }>
}

function createConv(overrides: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${overrides.id}`,
    profileId: 'default',
    tags: [],
    cwd: '/workspace/demo',
    nodeId: 'local',
    model: 'anthropic/claude-sonnet-4-5',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_010_000,
    ...overrides,
  }
}

function createHostHarness(init: {
  conversationId: number
  conversations?: ConversationSummary[]
  conversationDetails?: Record<number, ConversationDetail>
  runsByConversation?: Record<number, WorkflowRunSummary[]>
  pluginDocs?: Record<string, unknown>
}) {
  const log: HostStubLog = {
    actions: [],
    drawers: [],
    workbenchTabs: [],
    workbenchOpens: [],
    screens: [],
    notices: [],
  }
  const conversations = init.conversations ?? [createConv({ id: init.conversationId, ownedBy: 'human' })]
  const sessionRuns = new Map<number, WorkflowRunSummary[]>()
  for (const [k, v] of Object.entries(init.runsByConversation ?? {})) {
    sessionRuns.set(Number(k), v)
  }
  const sessionStates = new Map<string, { hasValue: boolean; deleted: boolean; connected: boolean; value: unknown }>()
  const listeners = new Set<() => void>()

  const getState = (key: { pluginId: string; docName: string; conversationId: number }) => {
    const cacheKey = `${key.pluginId}/${key.docName}/${key.conversationId}`
    let cur = sessionStates.get(cacheKey)
    const runs = sessionRuns.get(key.conversationId) ?? []
    const nextVal = key.docName === 'runs' ? { runs } : undefined
    if (cur === undefined || (key.docName === 'runs' && (cur.value as { runs: WorkflowRunSummary[] }).runs !== runs)) {
      cur = { hasValue: true, deleted: false, connected: true, value: nextVal }
      sessionStates.set(cacheKey, cur)
    }
    return cur
  }

  const port: import('../../plugin-client/src/index.js').PluginClientHostPort = {
    authenticated: true,
    theme: 'dark',
    conversations,
    conversationDetails: init.conversationDetails ?? {},
    conversationLives: {},
    pendingAsks: [],
    loadErrors: {},
    plugins: [],
    screens: [],
    pluginDocs: init.pluginDocs ?? {},
    ensurePluginDoc: async () => undefined,
    getPluginSessionDoc: async (_p, _d, convId) => ({ runs: sessionRuns.get(convId) ?? [] }),
    subscribeSessionDoc: (_key, listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSessionDocState: getState,
    invokePluginAction: async (pluginId, actionId, input) => {
      log.actions.push({ pluginId, actionId, input })
      if (actionId === 'save') {
        const fromRunId = (input as { fromRunId?: string })?.fromRunId ?? 'wf_x'
        return {
          created: true,
          workflow: { name: `saved-${fromRunId}`, path: `/tmp/${fromRunId}.js`, updatedAt: 1, size: 10 },
        }
      }
      return { ok: true }
    },
    submitConversationInput: async () => undefined,
    openTarget: (target) => {
      log.screens.push(target)
    },
    openConversationDrawer: (id) => {
      log.drawers.push(id)
    },
    openArtifactPreview: () => undefined,
    setWorkbenchOpen: (open) => {
      log.workbenchOpens.push(open)
    },
    setWorkbenchTab: (tab) => {
      log.workbenchTabs.push(tab)
    },
    notify: (message, tone) => {
      log.notices.push({ message, tone })
    },
    loadConversationDetail: () => undefined,
    slots: {
      collectItems: () => [],
      renderItem: () => null,
    },
    markdown: {
      view: ({ text }) => e('div', { 'data-testid': 'markdown-view' }, text),
      codeBlock: ({ code }) => e('pre', null, code),
    },
  }

  const ctx = SDK.createPluginClientContext(port, 'builtin:workflow', init.conversationId)

  const mountNode = (node: React.ReactNode) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        e(
          SDK.PluginClientHostContext.Provider,
          { value: port },
          e(SDK.PluginClientContext.Provider, { value: ctx }, node),
        ),
      )
    })
    return {
      container,
      unmount: () => {
        act(() => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  const setRuns = (conversationId: number, runs: WorkflowRunSummary[]) => {
    sessionRuns.set(conversationId, runs)
    act(() => {
      for (const listener of [...listeners]) listener()
    })
  }

  return { log, port, ctx, mountNode, setRuns }
}

describe('Workflow 三区零重复与无损呈现', () => {
  test('WorkflowActiveTray：无在途归零 0px，在途展示 32px HUD 并支持展开动作与收敛消失', { timeout: 60_000 }, async () => {
    const runningWf: WorkflowRunSummary = {
      id: 'wf_tray_1',
      name: '构建与测试流水线',
      conversationId: 1,
      status: 'running',
      kind: 'workflow',
      syncForeground: true,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_005_000,
      nodes: [
        { id: 'build', label: '编译构建', kind: 'action', status: 'done' },
        { id: 'test', label: '运行测试', kind: 'agent', status: 'running', conversationId: 11 },
      ],
    }

    const harness = createHostHarness({
      conversationId: 1,
      conversations: [
        createConv({ id: 1, ownedBy: 'human' }),
        createConv({ id: 11, parentConversationId: 1, status: 'working', title: '执行测试子会话' }),
      ],
      runsByConversation: { 1: [] },
    })

    const mounted = harness.mountNode(e(mod.WorkflowActiveTray, { conversation: createConv({ id: 1, ownedBy: 'human' }) }))
    try {
      // 1. 仅存在 1 个 running 子会话，未进 runs 时也按 executionTree 展示 32px HUD 且可打开子会话抽屉
      assert.ok(mounted.container.querySelector('.workflow-active-tray-bar') !== null, '有在途子会话时应渲染 32px HUD')
      const initToggle = mounted.container.querySelector('button[aria-expanded]') as HTMLButtonElement
      act(() => {
        initToggle.click()
      })
      const viewChildBtn = [...mounted.container.querySelectorAll('.workflow-active-tray-list button')].find((b) =>
        b.textContent?.includes('查看'),
      )
      assert.ok(viewChildBtn !== undefined, '独立在途子会话行应有查看按钮')
      act(() => {
        ;(viewChildBtn as HTMLButtonElement).click()
      })
      assert.equal(harness.log.drawers.at(-1), 11)
      act(() => {
        initToggle.click()
      })

      // 2. 全部 idle / settled 时归零返回 null（0px）
      harness.port.conversations[1]!.status = 'idle'
      harness.setRuns(1, [])
      assert.equal(mounted.container.querySelector('.workflow-active-tray'), null, '无在途任务时应返回 null（0px）')
      assert.equal(mounted.container.innerHTML, '', '归零时不得残留空包装节点')

      // 3. 注入运行中前台同步工作流 -> 渲染 32px 单行 HUD，支持展开并触发转后台 / 中止 / 工作台定位
      harness.port.conversations[1]!.status = 'working'
      harness.setRuns(1, [runningWf])
      const trayBar = mounted.container.querySelector('.workflow-active-tray-bar')
      assert.ok(trayBar !== null, '运行中工作流应显示托盘栏')
      assert.ok(mounted.container.textContent?.includes('1/2'), '应展示进度计数 1/2')

      // 点击展开托盘列表
      const toggleBtn = mounted.container.querySelector('button[aria-expanded]') as HTMLButtonElement | null
      assert.ok(toggleBtn !== null, '应有展开托盘列表按钮')
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false')
      act(() => {
        toggleBtn.click()
      })
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true')
      const list = mounted.container.querySelector('.workflow-active-tray-list')
      assert.ok(list !== null, '展开后应显示并发在途任务列表')

      // 验证「转入后台」与「中止」按钮调用正确 action
      const buttons = [...list.querySelectorAll('button')]
      const detachBtn = buttons.find((b) => b.textContent?.includes('转入后台'))
      assert.ok(detachBtn !== undefined, '前台同步 human 会话应允许转入后台')
      await act(async () => {
        detachBtn.click()
      })
      assert.equal(harness.log.actions.at(-1)?.actionId, 'detach')
      assert.deepEqual(harness.log.actions.at(-1)?.input, { runId: 'wf_tray_1' })

      const wbBtn = [...mounted.container.querySelectorAll('.workflow-active-tray-bar button')].find((b) =>
        b.textContent?.includes('工作台'),
      )
      assert.ok(wbBtn !== undefined, '应有一键直达工作台按钮')
      act(() => {
        ;(wbBtn as HTMLButtonElement).click()
      })
      assert.ok(harness.log.workbenchTabs.includes('plugin:builtin:workflow/tasks'))
      assert.equal(harness.log.workbenchOpens.at(-1), true)

      const detailBtn = [...list.querySelectorAll('button')].find((b) => b.textContent?.includes('详情'))
      assert.ok(detailBtn !== undefined, '工作流在途行应有详情定位按钮')
      act(() => {
        detailBtn.click()
      })
      assert.equal(harness.log.workbenchTabs.at(-1), 'plugin:builtin:workflow/tasks')

      // 4. 全部收敛结算 -> 自动归零 0px
      harness.port.conversations[1]!.status = 'idle'
      harness.setRuns(1, [
        {
          ...runningWf,
          status: 'completed',
          updatedAt: 1_700_000_020_000,
          nodes: runningWf.nodes?.map((n) => ({ ...n, status: 'done' as const })),
        },
      ])
      assert.equal(mounted.container.innerHTML, '', '任务全部结算后底部托盘必须归零消失')
    } finally {
      mounted.unmount()
    }
  })

  test('SubagentToolView：收口为 26px .trace-row，禁暴露后台句柄 ~34ms，点击分流抽屉/工作台/内联错误', { timeout: 60_000 }, () => {
    const childConv = createConv({ id: 21, parentConversationId: 1, parentToolCallId: 'call_native', status: 'idle', title: '子会话 21' })
    const bgRun: WorkflowRunSummary = {
      id: 'wf_ext_99',
      name: 'codex 代码审校',
      conversationId: 1,
      parentToolCallId: 'call_ext',
      status: 'completed',
      kind: 'subagent',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_012_000,
      nodes: [{ id: 'ext', label: 'Codex CLI', kind: 'agent', status: 'done', executionId: 'exec_99' }],
    }
    const harness = createHostHarness({
      conversationId: 1,
      conversations: [createConv({ id: 1 }), childConv],
      runsByConversation: { 1: [bgRun] },
    })

    // 1. 原生子会话：仅 .trace-row，无 .subagent-live-card，点击开抽屉 #21
    const nativeMount = harness.mountNode(
      e(mod.SubagentToolView, {
        callId: 'call_native',
        toolName: 'subagent',
        input: { prompt: '排查登录问题' },
        status: 'done',
        result: JSON.stringify({ conversationId: 21 }),
        durationMs: 4200,
        conversationId: 1,
      }),
    )
    try {
      assert.equal(nativeMount.container.querySelector('.subagent-live-card'), null, '时间线严禁挂载大卡片')
      const btn = nativeMount.container.querySelector('button.trace-row') as HTMLButtonElement | null
      assert.ok(btn !== null, '应渲染单行 .trace-row 按钮')
      assert.ok(btn.textContent?.includes('子代理 #21'))
      assert.ok(btn.textContent?.includes('排查登录问题'))
      act(() => {
        btn.click()
      })
      assert.deepEqual(harness.log.drawers, [21], '点击原生子代理 .trace-row 应直达 ConversationDrawer #21')
    } finally {
      nativeMount.unmount()
    }

    // 2. 后台子代理派发句柄在途阶段：status='done' + background:true + durationMs:34 -> 严禁展示 34ms，点击定位工作台 runId
    const handleMount = harness.mountNode(
      e(mod.SubagentToolView, {
        callId: 'call_bg_handle',
        toolName: 'subagent',
        input: { prompt: '执行后台审计', background: true },
        status: 'done',
        result: JSON.stringify({ ok: true, background: true, runId: 'wf_bg_handle', status: 'running' }),
        durationMs: 34,
        conversationId: 1,
      }),
    )
    try {
      const text = handleMount.container.textContent ?? ''
      assert.ok(text.includes('后台运行中'), '后台句柄在途阶段应标注后台运行中')
      assert.ok(!text.includes('34ms'), '绝不可将派发确认耗时 34ms 当成子会话总耗时展示')
      const btn = handleMount.container.querySelector('button.trace-row') as HTMLButtonElement
      act(() => {
        btn.click()
      })
      assert.equal(harness.log.workbenchTabs.at(-1), 'plugin:builtin:workflow/tasks', '点击后台句柄行应打开工作台')
    } finally {
      handleMount.unmount()
    }

    // 3. 未落库前置失败：可原地展开 ToolCallDetailsInline
    const errorMount = harness.mountNode(
      e(mod.SubagentToolView, {
        callId: 'call_err',
        toolName: 'subagent',
        input: { prompt: '非法参数测试' },
        status: 'error',
        result: 'Invalid nodeId parameter',
        conversationId: 1,
      }),
    )
    try {
      const btn = errorMount.container.querySelector('button.trace-row') as HTMLButtonElement
      assert.ok(btn.classList.contains('trace-row-error'))
      assert.equal(btn.getAttribute('aria-expanded'), 'false')
      act(() => {
        btn.click()
      })
      assert.equal(btn.getAttribute('aria-expanded'), 'true', '前置错误行点击后原地展开详情')
      assert.ok(errorMount.container.textContent?.includes('Invalid nodeId parameter'))
    } finally {
      errorMount.unmount()
    }
  })

  test('WorkflowToolView + WorkflowWorkbenchPanel：时间线点击精准聚焦工作台 run.id，去重工作流库，Popover 更多菜单与无损元数据', { timeout: 60_000 }, async () => {
    const entriesWithTask: ConversationEntry[] = [
      {
        seq: 1,
        kind: 'helm.input',
        createdAt: 1_700_000_000_000,
        data: { text: '从 entries 提取的任务首行标题', origin: 'agent' },
      } as ConversationEntry,
    ]
    const childConv = createConv({
      id: 30,
      parentConversationId: 1,
      status: 'idle',
      title: '子代理 30',
      nodeId: 'remote-a',
      cwd: '/srv/repo',
    })
    const standaloneChild = createConv({
      id: 31,
      parentConversationId: 1,
      status: 'idle',
      title: '子代理 31',
      nodeId: 'remote-b',
      cwd: '/srv/standalone',
    })
    const runOlder: WorkflowRunSummary = {
      id: 'wf_older',
      name: '旧运行（未聚焦应默认折叠）',
      conversationId: 1,
      status: 'completed',
      kind: 'workflow',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_005_000,
      nodes: [{ id: 's1', label: 'Step 1', kind: 'action', status: 'done' }],
    }
    const runTarget: WorkflowRunSummary = {
      id: 'wf_target',
      name: '目标多阶段工作流',
      conversationId: 1,
      parentToolCallId: 'call_wf_target',
      status: 'completed',
      kind: 'workflow',
      script: 'export default () => {}',
      replayedFrom: 'wf_seed',
      createdAt: 1_700_000_010_000,
      updatedAt: 1_700_000_025_000,
      phases: [{ id: 'p1', title: '分析阶段', status: 'done' }],
      nodes: [
        {
          id: 'n1',
          label: '外部审计',
          phaseId: 'p1',
          kind: 'agent',
          status: 'done',
          executionId: 'pane-42',
          startedAt: 1_700_000_011_000,
          durationMs: 8000,
        },
        {
          id: 'n2',
          label: '原生审查',
          phaseId: 'p1',
          kind: 'agent',
          status: 'done',
          conversationId: 30,
          durationMs: 4000,
        },
      ],
    }

    const harness = createHostHarness({
      conversationId: 1,
      conversations: [createConv({ id: 1 }), childConv, standaloneChild],
      conversationDetails: {
        30: { summary: childConv, entries: [] },
        31: { summary: standaloneChild, entries: entriesWithTask },
      },
      runsByConversation: { 1: [runOlder, runTarget] },
    })

    // 1. 时间线 WorkflowToolView 仅渲染 26px .trace-row，点击触发聚焦 + 打开工作台
    const tlMount = harness.mountNode(
      e(mod.WorkflowToolView, {
        callId: 'call_wf_target',
        toolName: 'SubagentWorkflow',
        input: { name: '目标多阶段工作流' },
        status: 'done',
        result: JSON.stringify({ runId: 'wf_target' }),
        conversationId: 1,
      }),
    )
    try {
      assert.equal(tlMount.container.querySelector('.workflow-run-card'), null, '时间线严禁渲染运行大卡片')
      const traceBtn = tlMount.container.querySelector('button.trace-row') as HTMLButtonElement
      assert.ok(traceBtn !== null)
      assert.ok(traceBtn.textContent?.includes('目标多阶段工作流'))
      assert.ok(traceBtn.textContent?.includes('2/2 节点'))
      act(() => {
        traceBtn.click()
      })
      assert.equal(harness.log.workbenchTabs.at(-1), 'plugin:builtin:workflow/tasks')
    } finally {
      tlMount.unmount()
    }

    // 2. 挂载右侧工作台：自动展开并高亮 wf_target，移除重复 WorkflowLibrarySection
    const wbMount = harness.mountNode(e(mod.WorkflowWorkbenchPanel, {}))
    try {
      assert.equal(wbMount.container.querySelector('.workflow-lib-section'), null, '工作台必须去除重复工作流库列表')
      const libBtn = [...wbMount.container.querySelectorAll('button')].find((b) => b.textContent?.includes('工作流库'))
      assert.ok(libBtn !== undefined, '工作台应提供轻量「工作流库」跳转按钮')
      act(() => {
        libBtn.click()
      })
      assert.equal(harness.log.screens.at(-1), 'screen:builtin:workflow/library')

      // 目标 run 应处于聚焦并展开状态
      const focusedWrap = wbMount.container.querySelector('[data-run-id="wf_target"]')
      assert.ok(focusedWrap !== null && focusedWrap.classList.contains('workflow-workbench-run-focused'), '应定位并高亮目标 run.id')
      assert.equal(focusedWrap.querySelector('.phase-bar'), null, '应去除重复 .phase-bar')
      assert.ok(focusedWrap.textContent?.includes('wf_target'), '工作台无损显示 runId')
      assert.ok(focusedWrap.textContent?.includes('wf_seed'), '工作台无损显示 replayedFrom 源 run')
      assert.ok(focusedWrap.textContent?.includes('pane-42'), '工作台无损显示外部 executionId')
      assert.ok(focusedWrap.textContent?.includes('remote-a:/srv/repo'), '工作台 SubagentLiveCard 无损显示 nodeId:cwd 物理坐标')
      assert.ok(wbMount.container.textContent?.includes('remote-b:/srv/standalone'), '工作台独立子会话卡无损显示 nodeId:cwd')
      assert.ok(wbMount.container.textContent?.includes('从 entries 提取的任务首行标题'), '工作台 SubagentLiveCard 应从 detail.entries 提取任务标题')

      // 低频操作（重放 / 保存为工作流）收纳入 Radix Popover `···`
      const moreBtn = focusedWrap.querySelector('button[aria-label="更多操作"]') as HTMLButtonElement | null
      assert.ok(moreBtn !== null, '工作流卡应有 ··· 更多操作 Popover 按钮')
      assert.equal(focusedWrap.textContent?.includes('保存为工作流'), false, '收起态不应铺满低频按钮')
      act(() => {
        moreBtn.click()
      })
      const saveBtn = [...focusedWrap.querySelectorAll('button')].find((b) => b.textContent?.includes('保存为工作流'))
      assert.ok(saveBtn !== undefined, '打开更多操作 Popover 后应包含「保存为工作流」')
      await act(async () => {
        saveBtn.click()
      })
      assert.equal(harness.log.actions.at(-1)?.actionId, 'save')
      assert.deepEqual(harness.log.actions.at(-1)?.input, { fromRunId: 'wf_target' })
    } finally {
      wbMount.unmount()
    }
  })

  test('BackgroundReportCard：完成默认收口 26px .trace-row，失败/中止/损坏默认自动展开，展开无损显示 runId/时间/在途快照', { timeout: 60_000 }, () => {
    const harness = createHostHarness({ conversationId: 1 })

    const makeReportEntry = (
      seq: number,
      kind: 'subagent_report' | 'workflow_report',
      payload: Record<string, unknown>,
      createdAt: number,
    ): ConversationEntry =>
      ({
        seq,
        kind: 'helm.input',
        createdAt,
        data: {
          origin: 'trigger',
          meta: { kind, backgroundRunId: payload.runId },
          text: `[后台任务回报]\n${JSON.stringify(payload)}`,
        },
      }) as ConversationEntry

    // 1. 完成态：默认折叠为 26px .trace-row，清理 Markdown 摘要，点击原地展开无损字段
    const okEntry = makeReportEntry(
      1,
      'subagent_report',
      {
        runId: 'wf_rpt_ok',
        status: 'completed',
        execution: { kind: 'conversation', conversationId: 45 },
        result: '## 审计结论\n**全部通过** `pnpm test` 0 失败',
        otherRunningTasks: [{ runId: 'wf_sib_1', name: '并行构建', kind: 'workflow' }],
      },
      1_700_000_030_000,
    )
    const okMount = harness.mountNode(e(mod.BackgroundReportCard, { entry: okEntry, entryIndex: 0, conversationId: 1 }))
    try {
      const toggle = okMount.container.querySelector('button.workflow-trace-toggle') as HTMLButtonElement
      assert.ok(toggle !== null)
      assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'completed 汇报默认收口折叠')
      const summary = okMount.container.querySelector('.trace-tool-summary')?.textContent ?? ''
      assert.ok(!summary.includes('##') && !summary.includes('**'), '折叠摘要应清洗 Markdown 噪音符号')
      assert.ok(summary.includes('审计结论'))

      const bodyId = toggle.getAttribute('aria-controls')!
      const bodyWrap = okMount.container.querySelector(`#${CSS.escape(bodyId)}`) as HTMLElement
      assert.equal(bodyWrap.hasAttribute('hidden'), true)

      act(() => {
        toggle.click()
      })
      assert.equal(toggle.getAttribute('aria-expanded'), 'true')
      assert.equal(bodyWrap.hasAttribute('hidden'), false)
      const expandedText = bodyWrap.textContent ?? ''
      assert.ok(expandedText.includes('wf_rpt_ok'), '展开后必须显式渲染 runId')
      assert.ok(expandedText.includes('投递时间'), '展开后必须渲染投递时间戳')
      assert.ok(expandedText.includes('全部通过'), '展开后无损渲染完整 Markdown 正文')
      assert.ok(expandedText.includes('并行构建') && expandedText.includes('wf_sib_1'), '展开后无损显示 otherRunningTasks 名称与 runId')
    } finally {
      okMount.unmount()
    }

    // 2. 失败态、中止态与格式异常态：默认自动展开
    const failEntry = makeReportEntry(
      2,
      'workflow_report',
      {
        runId: 'wf_rpt_fail',
        status: 'failed',
        error: 'Gate check failed with exit code 1',
        otherRunningTasks: [],
      },
      1_700_000_040_000,
    )
    const failMount = harness.mountNode(e(mod.BackgroundReportCard, { entry: failEntry, entryIndex: 1, conversationId: 1 }))
    try {
      const toggle = failMount.container.querySelector('button.workflow-trace-toggle') as HTMLButtonElement
      assert.equal(toggle.getAttribute('aria-expanded'), 'true', '失败汇报必须默认自动展开')
      assert.ok(failMount.container.querySelector('.callout--error')?.textContent?.includes('Gate check failed'))
    } finally {
      failMount.unmount()
    }

    const abortedEntry = makeReportEntry(
      3,
      'subagent_report',
      {
        runId: 'wf_rpt_abort',
        status: 'aborted',
        error: 'Aborted by operator',
        otherRunningTasks: [],
      },
      1_700_000_045_000,
    )
    const abortedMount = harness.mountNode(e(mod.BackgroundReportCard, { entry: abortedEntry, entryIndex: 2, conversationId: 1 }))
    try {
      const toggle = abortedMount.container.querySelector('button.workflow-trace-toggle') as HTMLButtonElement
      assert.equal(toggle.getAttribute('aria-expanded'), 'true', '中止汇报必须默认自动展开')
      assert.ok(abortedMount.container.querySelector('.callout--error')?.textContent?.includes('Aborted by operator'))
    } finally {
      abortedMount.unmount()
    }

    const invalidEntry = {
      seq: 4,
      kind: 'helm.input',
      data: {
        origin: 'trigger',
        meta: { kind: 'subagent_report', backgroundRunId: 'wf_bad' },
        text: 'broken-raw-report-text',
      },
    } as ConversationEntry
    const invalidMount = harness.mountNode(e(mod.BackgroundReportCard, { entry: invalidEntry, entryIndex: 3, conversationId: 1 }))
    try {
      const toggle = invalidMount.container.querySelector('button.workflow-trace-toggle') as HTMLButtonElement
      assert.equal(toggle.getAttribute('aria-expanded'), 'true', '数据异常汇报必须默认自动展开')
      assert.ok(invalidMount.container.textContent?.includes('汇报数据格式异常'))
      assert.ok(invalidMount.container.textContent?.includes('broken-raw-report-text'))
    } finally {
      invalidMount.unmount()
    }
  })

  test('WorkflowIcon / 零 Emoji / 零 callout--warn / Fast Refresh 静态守卫', { timeout: 60_000 }, async () => {
    // 1. 验证 WorkflowLibraryScreen 渲染 search Lucide 图标而非 circle 兜底
    const harness = createHostHarness({
      conversationId: 1,
      pluginDocs: {
        'builtin:workflow/library': {
          workflows: [{ name: 'ci', path: '/tmp/ci.js', updatedAt: 1_700_000_000_000, size: 120 }],
          updatedAt: 1_700_000_000_000,
        },
      },
    })
    const libMount = harness.mountNode(
      e(mod.WorkflowLibraryScreen, {
        pluginId: 'builtin:workflow',
        screenId: 'library',
        isSplit: false,
        params: {},
        setParams: () => undefined,
        close: () => undefined,
      }),
    )
    try {
      const searchSvg = libMount.container.querySelector('.workflow-lib-search svg')
      assert.ok(searchSvg !== null, '工作流库搜索栏应渲染 Lucide 图标')
      assert.equal(searchSvg.classList.contains('lucide-circle'), false, 'search 图标不得回退到 circle 占位')
    } finally {
      libMount.unmount()
    }

    // 2. 全量扫描 workflow/client/*.tsx 与 herdr/client/*.tsx：零 Emoji、零 callout--warn、仅导出组件与 TS 类型
    const emojiRe = /\p{Extended_Pictographic}/u
    for (const dir of [WORKFLOW_CLIENT_DIR, HERDR_CLIENT_DIR]) {
      const files = await readdir(dir)
      for (const file of files) {
        if (!file.endsWith('.tsx')) continue
        const src = await readFile(join(dir, file), 'utf8')
        assert.equal(emojiRe.test(src), false, `${file} 禁止出现 Emoji`)
        assert.equal(/\bcallout--warn\b(?!ing)/.test(src), false, `${file} 必须使用宿主类名 callout--warning 而非 callout--warn`)
        for (const line of src.split(/\r?\n/)) {
          if (!line.startsWith('export ')) continue
          const ok =
            /^export (async )?function [A-Z]/.test(line) ||
            /^export (type|interface) /.test(line) ||
            /^export \{ [A-Z][^}]* \}/.test(line) ||
            /^export type \{/.test(line)
          assert.ok(ok, `${file} 违反 Fast Refresh 仅导出组件/类型约定: ${line}`)
        }
      }
    }
  })
})
