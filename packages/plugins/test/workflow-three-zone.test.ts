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
 *    - SubagentLiveCard / ExternalRunSummary / WorkflowNodeCards 展示任务标题（含 entries 回退），机器坐标留在对话详情中查看。
 * 4. 图标与设计Constraints:WorkflowIcon 支持 search/play、零 Emoji、零 callout--warn 拼写错、Fast Refresh 只导出组件与类型。
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
import {
  PLUGIN_CLIENT_CSS_EXPORT,
  type AskSpec,
  type ConversationDetail,
  type ConversationEntry,
  type ConversationSummary,
} from '@helm/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'

GlobalRegistrator.register()

const req = createRequire(new URL('../../plugin-client/package.json', import.meta.url))
const React = req('react') as typeof import('react')
const ReactDOM = req('react-dom') as unknown
const ReactDOMClient = req('react-dom/client') as {
  createRoot: (container: Element) => { render(node: React.ReactNode): void; unmount(): void }
}
const ReactJsxRuntime = req('react/jsx-runtime') as Record<string, unknown>
const LucideReact = req('lucide-react') as Record<string, unknown>
const SDK = await import('../../plugin-client/src/index.js')

const g = globalThis as Record<string, unknown>
g.React = React
g.IS_REACT_ACT_ENVIRONMENT = true
g[CLIENT_SHARED_GLOBALS['react']!] = React
g[CLIENT_SHARED_GLOBALS['react-dom']!] = ReactDOM
g[CLIENT_SHARED_GLOBALS['react-dom/client']!] = ReactDOMClient
g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']!] = ReactJsxRuntime
g[CLIENT_SHARED_GLOBALS['lucide-react']!] = LucideReact
g[CLIENT_SHARED_GLOBALS['@helm/plugin-client']!] = SDK

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
  activeToolCallIds: Set<string>
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
  pendingAsks?: AskSpec[]
  runsByConversation?: Record<number, WorkflowRunSummary[]>
  pluginDocs?: Record<string, unknown>
  locale?: import('../../plugin-client/src/index.js').HelmLocale
  onAction?: (pluginId: string, actionId: string, input: unknown) => Promise<unknown> | unknown
}) {
  const activeToolCallIds = new Set<string>()
  const log: HostStubLog = {
    actions: [],
    drawers: [],
    workbenchTabs: [],
    workbenchOpens: [],
    screens: [],
    notices: [],
    activeToolCallIds,
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
    locale: init.locale,
    conversations,
    conversationDetails: init.conversationDetails ?? {},
    conversationLives: {},
    pendingAsks: init.pendingAsks ?? [],
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
      if (init.onAction !== undefined) {
        return await init.onAction(pluginId, actionId, input)
      }
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
  const toolActivityRegistry: import('../../plugin-client/src/index.js').ToolActivityRegistry = {
    activeToolCallIds,
    registerActivity: (callId) => {
      activeToolCallIds.add(callId)
      return () => {
        activeToolCallIds.delete(callId)
      }
    },
  }

  const mountNode = (node: React.ReactNode) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        e(
          SDK.PluginClientHostContext.Provider,
          { value: port },
          e(
            SDK.PluginClientContext.Provider,
            { value: ctx },
            e(SDK.ToolActivityContext.Provider, { value: toolActivityRegistry }, node),
          ),
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

    const runningSubagentRun: WorkflowRunSummary = {
      id: 'wf_tray_sub_11',
      name: 'subagent',
      conversationId: 1,
      status: 'running',
      kind: 'subagent',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      nodes: [{ id: 'subagent-0', label: 'subagent', kind: 'agent', status: 'running', conversationId: 11 }],
    }

    const harness = createHostHarness({
      conversationId: 1,
      conversations: [
        createConv({ id: 1, ownedBy: 'human' }),
        createConv({ id: 11, parentConversationId: 1, status: 'working', title: '执行测试子会话' }),
        createConv({ id: 99, parentConversationId: 1, ownedBy: 'human', status: 'working', title: '人类分叉分支（无 WorkflowRun）' }),
      ],
      runsByConversation: { 1: [runningSubagentRun] },
    })

    const mounted = harness.mountNode(e(mod.WorkflowActiveTray, { conversation: createConv({ id: 1, ownedBy: 'human' }) }))
    try {
      // 1. 存在 subagent WorkflowRun 时展示 32px HUD 且可打开子会话抽屉；无 WorkflowRun 的人类分叉 #99 绝不混入
      assert.ok(mounted.container.querySelector('.workflow-active-tray-bar') !== null, '有在途子会话时应渲染 32px HUD')
      const initToggle = mounted.container.querySelector('button.workflow-active-tray-bar-toggle') as HTMLButtonElement
      act(() => {
        initToggle.click()
      })
      assert.equal(mounted.container.textContent?.includes('人类分叉分支'), false, '无 WorkflowRun 的分叉会话不得混入活动托盘')
      const childRowMain = ([...mounted.container.querySelectorAll('.workflow-active-tray-row')].find((r) =>
        (r.textContent ?? '').includes('执行测试子会话'),
      ) as HTMLElement | undefined)?.querySelector('button.workflow-active-tray-row-main') as HTMLButtonElement | undefined
      assert.ok(childRowMain !== undefined, '独立在途子会话行主体是真实详情入口按钮')
      act(() => {
        childRowMain.click()
      })
      assert.equal(harness.log.drawers.at(-1), 11)
      act(() => {
        initToggle.click()
      })

      // 2. runs 清空（仅剩无 WorkflowRun 的分叉 #99 仍在 working）或全部 settled 时归零返回 null（0px）
      harness.port.conversations[1]!.status = 'idle'
      harness.setRuns(1, [])
      assert.ok(mounted.container.querySelector('.workflow-active-tray') === null, '无在途任务时应返回 null（0px）')
      assert.equal(mounted.container.innerHTML, '', '归零时不得残留空包装节点')

      // 3. 注入运行中前台同步工作流 -> 渲染 32px 单行 HUD，支持展开并触发转后台 / 中止 / 工作台定位
      harness.port.conversations[1]!.status = 'working'
      harness.setRuns(1, [runningWf])
      const trayBar = mounted.container.querySelector('.workflow-active-tray-bar')
      assert.ok(trayBar !== null, '运行中工作流应显示托盘栏')
      assert.ok(mounted.container.textContent?.includes('1/2'), '应展示进度计数 1/2')

      // 横栏主体真实按钮展开托盘列表（无独立展开按钮，Workbench 为同级 sibling）
      const toggleBtn = mounted.container.querySelector('button.workflow-active-tray-bar-toggle') as HTMLButtonElement | null
      assert.ok(toggleBtn !== null, '横栏主体即展开开关')
      assert.equal(toggleBtn.tagName, 'BUTTON')
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false')
      act(() => {
        toggleBtn.click()
      })
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true')
      const list = mounted.container.querySelector('.workflow-active-tray-list')
      assert.ok(list !== null, '展开后应显示并发在途任务列表')

      // 验证「转入后台」与「中止」按钮调用正确 action
      const buttons = [...list.querySelectorAll('button')]
      const detachBtn = buttons.find((b) => b.textContent?.includes('Move to background'))
      assert.ok(detachBtn !== undefined, '前台同步 human 会话应允许转入后台')
      await act(async () => {
        detachBtn.click()
      })
      assert.equal(harness.log.actions.at(-1)?.actionId, 'detach')
      assert.deepEqual(harness.log.actions.at(-1)?.input, { runId: 'wf_tray_1' })

      const wbBtn = [...mounted.container.querySelectorAll('.workflow-active-tray-bar button')].find((b) =>
        b.textContent?.includes('Workbench'),
      )
      assert.ok(wbBtn !== undefined, '应有一键直达工作台按钮')
      act(() => {
        ;(wbBtn as HTMLButtonElement).click()
      })
      assert.ok(harness.log.workbenchTabs.includes('plugin:builtin:workflow/tasks'))
      assert.equal(harness.log.workbenchOpens.at(-1), true)

      // 工作流在途行主体点击定位工作台（不再有独立 Details 按钮）
      const wfRowMain = ([...list.querySelectorAll('.workflow-active-tray-row')].find((r) =>
        (r.textContent ?? '').includes('构建与测试流水线'),
      ) as HTMLElement | undefined)?.querySelector('button.workflow-active-tray-row-main') as HTMLButtonElement | undefined
      assert.ok(wfRowMain !== undefined, '工作流在途行主体存在')
      act(() => {
        wfRowMain!.click()
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
      assert.ok(nativeMount.container.querySelector('.subagent-live-card') === null, '时间线严禁挂载大卡片')
      const btn = nativeMount.container.querySelector('button.trace-row') as HTMLButtonElement | null
      assert.ok(btn !== null, '应渲染单行 .trace-row 按钮')
      assert.ok(btn.querySelector('.trace-tool-name')?.textContent?.includes('排查登录问题'))
      assert.ok(btn.querySelector('.workflow-trace-id')?.textContent?.includes('#21'))
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
      assert.ok(text.includes('Running in background'), '后台句柄在途阶段应标注后台运行中')
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
        id: 'e-1',
        kind: 'helm.input',
        createdAt: 1_700_000_000_000,
        data: { text: '从 entries 提取的任务首行标题', origin: 'agent' },
      },
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
      replayedFrom: 'wf_seed',
      createdAt: 1_700_000_010_000,
      updatedAt: 1_700_000_025_000,
      phases: [{ title: '分析阶段' }],
      nodes: [
        {
          id: 'n1',
          label: '外部审计',
          phaseTitle: '分析阶段',
          kind: 'agent',
          status: 'done',
          executionId: 'pane-42',
          startedAt: 1_700_000_011_000,
          durationMs: 8000,
        },
        {
          id: 'n2',
          label: '原生审查',
          phaseTitle: '分析阶段',
          kind: 'agent',
          status: 'done',
          conversationId: 30,
          durationMs: 4000,
        },
      ],
    }

    const runStandalone: WorkflowRunSummary = {
      id: 'wf_standalone_31',
      name: 'subagent',
      conversationId: 1,
      status: 'completed',
      kind: 'subagent',
      createdAt: 1_700_000_006_000,
      updatedAt: 1_700_000_008_000,
      nodes: [{ id: 'subagent-0', label: 'subagent', kind: 'agent', status: 'done', conversationId: 31 }],
    }

    const harness = createHostHarness({
      conversationId: 1,
      conversations: [createConv({ id: 1 }), childConv, standaloneChild],
      conversationDetails: {
        30: { ...childConv, entries: [] },
        31: { ...standaloneChild, entries: entriesWithTask },
      },
      runsByConversation: { 1: [runOlder, runStandalone, runTarget] },
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
      assert.ok(tlMount.container.querySelector('.workflow-run-card') === null, '时间线严禁渲染运行大卡片')
      const traceBtn = tlMount.container.querySelector('button.trace-row') as HTMLButtonElement
      assert.ok(traceBtn !== null)
      assert.ok(traceBtn.textContent?.includes('目标多阶段工作流'))
      assert.ok(traceBtn.textContent?.includes('2/2 nodes'))
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
      assert.ok(wbMount.container.querySelector('.workflow-lib-section') === null, '工作台必须去除重复工作流库列表')
      const libBtn = [...wbMount.container.querySelectorAll('button')].find((b) => b.textContent?.includes('Workflow library'))
      assert.ok(libBtn !== undefined, '工作台应提供轻量「工作流库」跳转按钮')
      act(() => {
        libBtn.click()
      })
      assert.equal(harness.log.screens.at(-1), 'screen:builtin:workflow/library')

      // 目标 run 应处于聚焦并展开状态
      const focusedWrap = wbMount.container.querySelector('[data-run-id="wf_target"]')
      assert.ok(focusedWrap !== null && focusedWrap.classList.contains('workflow-workbench-run-focused'), '应定位并高亮目标 run.id')
      assert.ok(focusedWrap.querySelector('.phase-bar') === null, '应去除重复 .phase-bar')
      assert.ok(focusedWrap.textContent?.includes('wf_target'), '工作台无损显示 runId')
      assert.ok(focusedWrap.textContent?.includes('wf_seed'), '工作台无损显示 replayedFrom 源 run')
      assert.ok(focusedWrap.textContent?.includes('pane-42'), '工作台无损显示外部 executionId')
      assert.ok(!focusedWrap.textContent?.includes('remote-a:/srv/repo'), '工作台子代理卡不重复展示对话详情中的 nodeId:cwd')
      assert.ok(!wbMount.container.textContent?.includes('remote-b:/srv/standalone'), '工作台独立子会话卡不重复展示对话详情中的 nodeId:cwd')
      assert.ok(wbMount.container.textContent?.includes('从 entries 提取的任务首行标题'), '工作台 SubagentLiveCard 应从 detail.entries 提取任务标题')

      // 低频操作（重放 / 保存为工作流）收纳入 Radix Popover `···`
      const moreBtn = focusedWrap.querySelector('button[aria-label="More actions"]') as HTMLButtonElement | null
      assert.ok(moreBtn !== null, '工作流卡应有 ··· 更多操作 Popover 按钮')
      assert.equal(focusedWrap.textContent?.includes('Save as workflow'), false, '收起态不应铺满低频按钮')
      act(() => {
        moreBtn.click()
      })
      const saveBtn = [...focusedWrap.querySelectorAll('button')].find((b) => b.textContent?.includes('Save as workflow'))
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
    ): ConversationEntry => ({
      id: `report-${seq}`,
      kind: 'helm.input',
      createdAt,
      data: {
        origin: 'trigger',
        meta: { kind, backgroundRunId: payload.runId, report: payload },
        text: `[后台任务回报]\n${JSON.stringify(payload)}`,
      },
    })

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
      assert.ok(expandedText.includes('Delivered at'), '展开后必须渲染投递时间戳')
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

    const invalidEntry: ConversationEntry = {
      id: 'report-invalid',
      kind: 'helm.input',
      data: {
        origin: 'trigger',
        meta: { kind: 'subagent_report', backgroundRunId: 'wf_bad' },
        text: 'broken-raw-report-text',
      },
    }
    const invalidMount = harness.mountNode(e(mod.BackgroundReportCard, { entry: invalidEntry, entryIndex: 3, conversationId: 1 }))
    try {
      const toggle = invalidMount.container.querySelector('button.workflow-trace-toggle') as HTMLButtonElement
      assert.equal(toggle.getAttribute('aria-expanded'), 'true', '数据异常汇报必须默认自动展开')
      assert.ok(invalidMount.container.textContent?.includes('Malformed report'))
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

    // 1b. WorkflowIcon 必须完全委托 @helm/plugin-client HelmIcon，禁止私有导入 lucide-react
    const iconSrc = await readFile(join(WORKFLOW_CLIENT_DIR, 'WorkflowIcon.tsx'), 'utf8')
    assert.match(iconSrc, /from '@helm\/plugin-client'/, 'WorkflowIcon 必须复用 @helm/plugin-client')
    assert.doesNotMatch(iconSrc, /from 'lucide-react'/, 'WorkflowIcon 不得私建 lucide-react 映射表')
    assert.match(iconSrc, /<HelmIcon\b/, 'WorkflowIcon 应直接委托 <HelmIcon />')

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

  test('审校回归：WorkflowWorkbenchPanel 执行树去重/外部运行/深层后代隔离/Worktree 检视/父 idle+子 running 自身已完成', { timeout: 60_000 }, () => {
    const bgChild = createConv({
      id: 35,
      parentConversationId: 1,
      parentToolCallId: 'call_bg_35',
      status: 'idle',
      title: '后台原生子代理',
      nodeId: 'local',
      cwd: '/repo/wt-35',
    })
    const grandChild = createConv({
      id: 36,
      parentConversationId: 35,
      status: 'working',
      title: '孙子任务 36',
    })
    const bgSubagentRun: WorkflowRunSummary = {
      id: 'wf_bg_native_35',
      name: '后台原生子代理 run',
      conversationId: 1,
      parentToolCallId: 'call_bg_35',
      status: 'completed',
      kind: 'subagent',
      createdAt: 1_700_000_100_000,
      updatedAt: 1_700_000_105_000,
      nodes: [
        {
          id: 'agent',
          label: '子代理执行',
          kind: 'agent',
          status: 'done',
          conversationId: 35,
          nodeId: 'local',
          worktree: { path: '/tmp/wt-35', branch: 'feat/wt-35', id: 'wt-35', baseCommit: 'd47c2aaed' },
        },
      ],
    }
    const extWithNodesRun: WorkflowRunSummary = {
      id: 'wf_ext_nodes',
      name: '外部 Codex 节点 run',
      conversationId: 1,
      status: 'completed',
      kind: 'subagent',
      createdAt: 1_700_000_110_000,
      updatedAt: 1_700_000_120_000,
      nodes: [
        {
          id: 'codex-1',
          label: 'Codex CLI',
          kind: 'agent',
          status: 'done',
          executionId: 'pane-42',
          nodeId: 'remote-x',
          effectiveCwd: '/srv/ext',
          worktree: { path: '/tmp/wt-ext', branch: 'feat/ext', id: 'wt-ext', baseCommit: 'd47c2aaed' },
        },
      ],
    }
    const grandchildWorkflowRun: WorkflowRunSummary = {
      id: 'wf_grandchild',
      name: '后代会话私有工作流',
      conversationId: 35,
      status: 'running',
      kind: 'workflow',
      createdAt: 1_700_000_130_000,
      updatedAt: 1_700_000_135_000,
      nodes: [{ id: 'g1', label: '后代步骤', kind: 'action', status: 'running' }],
    }
    const startedOnlyWorkflow: WorkflowRunSummary = {
      id: 'wf_started_only',
      name: '仅含开始时间节点的工作流',
      conversationId: 1,
      status: 'running',
      kind: 'workflow',
      createdAt: 1_700_000_140_000,
      updatedAt: 1_700_000_141_000,
      nodes: [{ id: 'only-ts', label: '仅时间节点', kind: 'action', status: 'running', startedAt: 1_700_000_140_500 }],
    }

    const harness = createHostHarness({
      conversationId: 1,
      conversations: [createConv({ id: 1 }), bgChild, grandChild],
      runsByConversation: { 1: [bgSubagentRun, extWithNodesRun, grandchildWorkflowRun, startedOnlyWorkflow] },
    })

    const wbMount = harness.mountNode(e(mod.WorkflowWorkbenchPanel, {}))
    try {
      const rootWraps = [...wbMount.container.querySelectorAll('.workflow-workbench-list > .workflow-workbench-run-wrap')]
      assert.equal(rootWraps.length, 3, '仅渲染 3 个一级节点（后台子代理/外部执行/当前工作流），后代 wf_grandchild 严禁平铺到顶层')
      assert.equal(
        wbMount.container.querySelector('.workflow-workbench-head .badge-neutral')?.textContent,
        '3',
        '顶栏任务计数必须按 tree.length 统计而非双计',
      )

      // 1. 后台原生子代理仅渲染 1 张 SubagentLiveCard（无重复 workflow-run-card），且保留 WorktreeInspectSection 与「自身已完成」
      const bgWrap = wbMount.container.querySelector('[data-run-id="wf_bg_native_35"]')
      assert.ok(bgWrap !== null)
      assert.equal(bgWrap.querySelectorAll('.subagent-live-card').length, 1, '后台原生子代理仅渲染 1 张子代理卡')
      assert.ok(bgWrap.querySelector('.workflow-run-card') === null, '不得重复渲染 WorkflowRunCardBody')
      assert.ok(bgWrap.querySelector('details') === null, '无 callDetails 时不得渲染空 <details> 调用详情')
      assert.ok(bgWrap.querySelector('.worktree-inspect') !== null, '工作台子代理卡必须保留 WorktreeInspectSection')
      assert.ok(bgWrap.textContent?.includes('feat/wt-35'))
      assert.ok(bgWrap.textContent?.includes('Self: Done'), '父 idle + 子 running 时必须显示「自身已完成」而非「自身执行中」')

      // 2. 有 nodes 明细的外部代理 run 走 ExternalRunSummary，不误渲染 WorkflowRunCardBody
      const extWrap = wbMount.container.querySelector('[data-run-id="wf_ext_nodes"]')
      assert.ok(extWrap !== null)
      assert.ok(extWrap.querySelector('.subagent-external-card') !== null, '有节点的外部 run 必须走 ExternalRunSummary')
      assert.ok(extWrap.querySelector('.workflow-run-card') === null)
      assert.ok(extWrap.textContent?.includes('pane-42'))
      assert.ok(!extWrap.textContent?.includes('remote-x:/srv/ext'), '外部执行卡不重复展示对话详情中的 nodeId:cwd')
      assert.ok(extWrap.querySelector('.worktree-inspect') !== null, '外部 run 也应保留 WorktreeInspectSection')

      // 3. 深层后代 wf_grandchild 不得在根工作台平铺出现
      assert.ok(wbMount.container.querySelector('[data-run-id="wf_grandchild"]') === null, '深层后代 run 严禁越层平铺')

      // 4. 仅含 startedAt 的节点明细不被 rows.length > 0 吞掉
      const tsWrap = wbMount.container.querySelector('[data-run-id="wf_started_only"]')
      assert.ok(tsWrap !== null)
      assert.ok(tsWrap.textContent?.includes('Started at'), '仅含 startedAt 时仍应渲染开始时间键值行')
    } finally {
      wbMount.unmount()
    }
  })

  test('审校回归：SubagentToolView 续接去重 + AskDoc 审批优先 + @profile/分支徽章 + WorkflowToolView 终态释放活动', { timeout: 60_000 }, () => {
    const childAskConv = createConv({
      id: 50,
      parentConversationId: 1,
      parentToolCallId: 'call_old_50',
      profileId: 'coder',
      status: 'working',
      pendingAskCount: 1,
      title: '子代理 50',
    })
    const settledWithLiveChildRun: WorkflowRunSummary = {
      id: 'wf_settled_child_live',
      name: '已结算主流程',
      conversationId: 1,
      parentToolCallId: 'call_wf_done',
      status: 'completed',
      kind: 'workflow',
      createdAt: 1_700_000_200_000,
      updatedAt: 1_700_000_210_000,
      nodes: [
        { id: 'c1', label: '后台子节点', kind: 'agent', status: 'done', conversationId: 50 },
      ],
    }
    const pendingAsk: AskSpec = {
      id: 'ask_50',
      conversationId: 50,
      expectedStateSeq: 1,
      title: '确认执行危险命令',
      description: 'confirm?',
      fields: [{ name: 'allow', label: '允许', type: 'confirm' }],
      status: 'pending',
      createdAt: 1_700_000_205_000,
    }
    const oldResult = JSON.stringify({ ok: true, execution: { conversationId: 50 } })
    const newResult = JSON.stringify({
      ok: true,
      execution: {
        conversationId: 50,
        worktree: { path: '/tmp/wt-50', branch: 'feat/sub-wt' },
      },
    })
    const siblingCalls = [
      {
        callId: 'call_old_50',
        toolName: 'subagent',
        input: { prompt: '首次执行' },
        status: 'done' as const,
        result: oldResult,
      },
      {
        callId: 'call_new_50',
        toolName: 'subagent',
        input: { resume: 50, prompt: '继续执行' },
        status: 'running' as const,
        result: newResult,
      },
    ]

    const harness = createHostHarness({
      conversationId: 1,
      conversations: [createConv({ id: 1 }), childAskConv],
      pendingAsks: [pendingAsk],
      runsByConversation: { 1: [settledWithLiveChildRun] },
    })

    // 1. 历史被续接的旧调用：保持已完成，标「已在下文续接」，绝不注册活动
    const oldMount = harness.mountNode(
      e(mod.SubagentToolView, {
        callId: 'call_old_50',
        toolName: 'subagent',
        input: { prompt: '首次执行' },
        status: 'done',
        result: oldResult,
        durationMs: 1200,
        conversationId: 1,
        siblingCalls,
      }),
    )
    try {
      const text = oldMount.container.textContent ?? ''
      assert.ok(text.includes('Resumed below'), '被后续 resume 接替的历史调用应标注「已在下文续接」')
      assert.ok(text.includes('Done'), '被接替的旧调用应保持自身终态而非随新调用变更为执行中/等待审批')
      assert.equal(harness.log.activeToolCallIds.has('call_old_50'), false, '历史被续接调用不得再上报 useToolActivity')
    } finally {
      oldMount.unmount()
    }

    // 2. 最新调用：pendingAsk 优先于 working 显示「等待审批」，展示 @profileId 与 worktree 分支
    const newMount = harness.mountNode(
      e(mod.SubagentToolView, {
        callId: 'call_new_50',
        toolName: 'subagent',
        input: { resume: 50, prompt: '继续执行' },
        status: 'running',
        result: newResult,
        conversationId: 1,
        siblingCalls,
      }),
    )
    try {
      const text = newMount.container.textContent ?? ''
      assert.ok(text.includes('Awaiting approval'), '有待审批 AskDoc 时即使 childSummary.status=working 也必须优先显示「等待审批」')
      assert.equal(text.includes('Running'), false)
      assert.ok(text.includes('@coder'), '原生子代理行应展示 @profileId 胶囊')
      assert.ok(text.includes('feat/sub-wt'), '携带 worktree 时应展示紧凑分支徽章')
      assert.equal(harness.log.activeToolCallIds.has('call_new_50'), true)
    } finally {
      newMount.unmount()
    }

    // 3. WorkflowToolView：run.status 终态后即使子会话仍在工作，useToolActivity 也必须释放
    const wfDoneMount = harness.mountNode(
      e(mod.WorkflowToolView, {
        callId: 'call_wf_done',
        toolName: 'SubagentWorkflow',
        input: { name: '已结算主流程' },
        status: 'done',
        result: JSON.stringify({ runId: 'wf_settled_child_live' }),
        conversationId: 1,
      }),
    )
    try {
      assert.equal(
        harness.log.activeToolCallIds.has('call_wf_done'),
        false,
        'run.status 为终态后即使后代仍在跑，WorkflowToolView 的 useToolActivity 也必须释放',
      )
    } finally {
      wfDoneMount.unmount()
    }
  })

  test('locale 联动：port 传 zh-CN 渲染中文文案，缺省 en 保持英文', { timeout: 60_000 }, async () => {
    const makeReportEntry = (meta: Record<string, unknown>, text: string): ConversationEntry => ({
      id: 'report-locale',
      kind: 'helm.input',
      createdAt: 1_700_000_050_000,
      data: { origin: 'trigger', meta, text },
    })
    const reportPayload = { runId: 'wf_locale', status: 'completed', result: '审校结论：全部通过' }
    const entry = makeReportEntry(
      { kind: 'subagent_report', backgroundRunId: 'wf_locale', report: reportPayload },
      `[后台任务回报]\n${JSON.stringify(reportPayload)}`,
    )
    const childConv = createConv({
      id: 60,
      parentConversationId: 1,
      parentToolCallId: 'call_locale',
      status: 'idle',
      title: '子会话 60',
    })

    const openReport = async (locale: 'en' | 'zh-CN' | undefined) => {
      const harness = createHostHarness({
        conversationId: 1,
        conversations: [createConv({ id: 1 }), childConv],
        runsByConversation: { 1: [] },
        ...(locale !== undefined ? { locale } : {}),
      })
      const mounted = harness.mountNode(e(mod.BackgroundReportCard, { entry, entryIndex: 0, conversationId: 1 }))
      const toggle = mounted.container.querySelector('button.workflow-trace-toggle') as HTMLButtonElement
      act(() => {
        toggle.click()
      })
      const text = (mounted.container.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls')!)}`) as HTMLElement).textContent ?? ''
      mounted.unmount()
      return text
    }

    // zh-CN 渲染中文 kv 标签与徽章；en（缺省）渲染英文——同一份夹具两种口径。
    const zhText = await openReport('zh-CN')
    assert.ok(zhText.includes('投递时间'), 'zh-CN 应渲染中文投递时间标签')
    assert.ok(zhText.includes('任务类型'), 'zh-CN 应渲染中文任务类型标签')
    assert.ok(zhText.includes('后台子代理'), 'zh-CN 应渲染中文任务类型取值')
    const enText = await openReport(undefined)
    assert.ok(enText.includes('Delivered at'), '缺省 en 应渲染英文投递时间标签')
    assert.ok(enText.includes('Background subagent'), '缺省 en 应渲染英文任务类型取值')
    assert.ok(enText.includes('审校结论：全部通过'), 'result 正文是模型输出样例，两种 locale 均原样透传')

    // 子代理轨迹行有 prompt 时主名展示任务标题 + #60，同时状态徽章跟随 zh-CN locale。
    const zhHarness = createHostHarness({
      conversationId: 1,
      conversations: [createConv({ id: 1 }), childConv],
      runsByConversation: { 1: [] },
      locale: 'zh-CN',
    })
    const zhRow = zhHarness.mountNode(
      e(mod.SubagentToolView, {
        callId: 'call_locale',
        toolName: 'subagent',
        input: { prompt: '排查登录问题' },
        status: 'done',
        result: JSON.stringify({ conversationId: 60 }),
        durationMs: 1200,
        conversationId: 1,
      }),
    )
    try {
      assert.ok(zhRow.container.querySelector('.trace-tool-name')?.textContent?.includes('排查登录问题'), 'zh-CN 轨迹行应展示任务标题')
      assert.ok(zhRow.container.querySelector('.workflow-trace-id')?.textContent?.includes('#60'), 'zh-CN 轨迹行应附带 #60')
      assert.ok(zhRow.container.textContent?.includes('已完成'), 'zh-CN 轨迹行应渲染中文终态徽章')
    } finally {
      zhRow.unmount()
    }
  })

  test('locale 联动：SubagentLiveCard 恢复/缓存、WorkflowWorkbenchPanel 批量恢复与 WorkflowNodeCards 细节文案双语', { timeout: 60_000 }, async () => {
    const failedSubagentRun: WorkflowRunSummary = {
      id: 'run_sub_fail_1',
      name: '后台子代理任务',
      conversationId: 1,
      status: 'failed',
      kind: 'subagent',
      createdAt: 1_700_000_100_000,
      updatedAt: 1_700_000_105_000,
      error: 'subagent crashed',
      nodes: [{ id: 'sub', label: '子代理执行', kind: 'agent', status: 'failed', conversationId: 71 }],
    }
    const failedWorkflowRun: WorkflowRunSummary = {
      id: 'wf_fail_node_1',
      name: '失败工作流',
      conversationId: 1,
      status: 'failed',
      kind: 'workflow',
      createdAt: 1_700_000_110_000,
      updatedAt: 1_700_000_120_000,
      nodes: [
        {
          id: 'step-a',
          label: '生成步骤',
          kind: 'agent',
          status: 'failed',
          cached: true,
          prompt: 'do work',
          output: { summary: 'partial' },
          error: 'boom',
          tokens: 1200,
        },
      ],
    }

    const cases = [
      {
        locale: 'en' as const,
        expected: {
          cached: 'Cached',
          resume: 'Resume',
          resumeTitle: 'Resume this failed or aborted background subagent task',
          resumeAria: 'Resume this background subagent task',
          resumeNotify: 'Resume initiated (source run run_sub_fail_1)',
          resumeFailPrefix: 'Failed to resume background subagent: ',
          batchBtn: 'Resume failed (2)',
          batchTitle: 'Batch-resume auto-resumable failed tasks in the current conversation',
          batchStarted: 'Initiated resume for 1 failed task (skipped 1 non-auto-resumable)',
          batchAllSkipped: 'No new resume tasks started (skipped 2 non-auto-resumable tasks)',
          batchNone: 'No failed tasks need resuming',
          batchInvalid: 'Batch resume failed: Batch resume returned an invalid shape (unexpected action payload)',
          prompt: 'Prompt',
          output: 'Output',
          error: 'Error',
          tokens: '1,200 Tokens',
        },
      },
      {
        locale: 'zh-CN' as const,
        expected: {
          cached: '已缓存',
          resume: '恢复',
          resumeTitle: '恢复该失败或中止的后台子代理任务',
          resumeAria: '恢复该后台子代理任务',
          resumeNotify: '已发起恢复（源运行 run_sub_fail_1）',
          resumeFailPrefix: '恢复后台子代理失败：',
          batchBtn: '恢复失败 (2)',
          batchTitle: '批量恢复当前会话下可自动续跑的失败任务',
          batchStarted: '已发起恢复 1 个失败任务，跳过 1 个不可自动恢复任务',
          batchAllSkipped: '未拉起新恢复任务（跳过 2 个不可自动恢复任务）',
          batchNone: '当前没有需要恢复的失败任务',
          batchInvalid: '批量恢复失败：批量恢复返回结构不合法（动作返回非预期形状）',
          prompt: '指令',
          output: '产出',
          error: '错误',
          tokens: '1,200 Token',
        },
      },
    ] as const

    for (const { locale, expected } of cases) {
      // 1. SubagentLiveCard: cached 徽章 + 单卡恢复按钮与成功/失败通知
      let failRunAction = false
      const subHarness = createHostHarness({
        conversationId: 1,
        locale,
        conversations: [
          createConv({ id: 1, ownedBy: 'human' }),
          createConv({ id: 71, parentConversationId: 1, status: 'error', title: '子代理 71' }),
        ],
        runsByConversation: { 1: [failedSubagentRun] },
        onAction: async (_p, actionId) => {
          if (actionId === 'run' && failRunAction) throw new Error('rpc_down')
          return { ok: true }
        },
      })
      const subMount = subHarness.mountNode(
        e(mod.SubagentLiveCard, {
          childConversationId: 71,
          toolStatus: 'error',
          backgroundRun: failedSubagentRun,
          cached: true,
        }),
      )
      try {
        assert.ok(subMount.container.textContent?.includes(expected.cached), `${locale}: cached 徽章应本地化`)
        const resumeBtn = subMount.container.querySelector(`button[aria-label="${expected.resumeAria}"]`) as HTMLButtonElement | null
        assert.ok(resumeBtn !== null, `${locale}: 应存在本地化 aria-label 的恢复按钮`)
        assert.equal(resumeBtn.getAttribute('title'), expected.resumeTitle)
        assert.ok(resumeBtn.textContent?.includes(expected.resume))
        await act(async () => {
          resumeBtn.click()
        })
        assert.equal(subHarness.log.notices.at(-1)?.message, expected.resumeNotify)

        failRunAction = true
        await act(async () => {
          resumeBtn.click()
        })
        assert.equal(subHarness.log.notices.at(-1)?.message, `${expected.resumeFailPrefix}rpc_down`)
        assert.equal(subHarness.log.notices.at(-1)?.tone, 'error')
      } finally {
        subMount.unmount()
      }

      // 2. WorkflowWorkbenchPanel: 批量恢复按钮 + 各类返回分支通知 + 节点 cached / Prompt / Output / Error / Tokens
      let batchResponse: unknown = { resumed: [{ id: 'r_new' }], skipped: [{ runId: 'run_skip', reason: 'uncertain' }] }
      const wbHarness = createHostHarness({
        conversationId: 1,
        locale,
        conversations: [
          createConv({ id: 1, ownedBy: 'human' }),
          createConv({ id: 71, parentConversationId: 1, status: 'error', title: '子代理 71' }),
        ],
        runsByConversation: { 1: [failedWorkflowRun, failedSubagentRun] },
        onAction: async (_p, actionId) => {
          if (actionId === 'resume_failed') return batchResponse
          return { ok: true }
        },
      })
      const wbMount = wbHarness.mountNode(e(mod.WorkflowWorkbenchPanel))
      try {
        const batchBtn = wbMount.container.querySelector(`button[aria-label="${expected.batchBtn}"]`) as HTMLButtonElement | null
        assert.ok(batchBtn !== null, `${locale}: 工作台应渲染本地化批量恢复按钮`)
        assert.equal(batchBtn.getAttribute('title'), expected.batchTitle)
        assert.ok(batchBtn.textContent?.includes(expected.batchBtn))

        // 2a. 部分恢复 + 部分跳过
        await act(async () => {
          batchBtn.click()
        })
        assert.equal(wbHarness.log.notices.at(-1)?.message, expected.batchStarted)

        // 2b. 全部跳过
        batchResponse = { resumed: [], skipped: [{ runId: 's1', reason: 'x' }, { runId: 's2', reason: 'y' }] }
        await act(async () => {
          batchBtn.click()
        })
        assert.equal(wbHarness.log.notices.at(-1)?.message, expected.batchAllSkipped)
        assert.equal(wbHarness.log.notices.at(-1)?.tone, 'warning')

        // 2c. 无需恢复
        batchResponse = { resumed: [], skipped: [] }
        await act(async () => {
          batchBtn.click()
        })
        assert.equal(wbHarness.log.notices.at(-1)?.message, expected.batchNone)

        // 2d. 返回结构非法
        batchResponse = { bad: true }
        await act(async () => {
          batchBtn.click()
        })
        assert.equal(wbHarness.log.notices.at(-1)?.message, expected.batchInvalid)
        assert.equal(wbHarness.log.notices.at(-1)?.tone, 'error')

        // 3. WorkflowNodeCards & WorkflowRunCardBody 本地化标签
        const wfText = wbMount.container.querySelector('[data-run-id="wf_fail_node_1"]')?.textContent ?? ''
        assert.ok(wfText.includes(expected.cached), `${locale}: 节点卡 cached 徽章`)
        assert.ok(wfText.includes(expected.prompt), `${locale}: 节点明细 Prompt 标签`)
        assert.ok(wfText.includes(expected.output), `${locale}: 节点明细 Output 标签`)
        assert.ok(wfText.includes(expected.error), `${locale}: 节点明细 Error 标签`)
        assert.ok(wfText.includes(expected.tokens), `${locale}: 汇总 Tokens 标签`)
      } finally {
        wbMount.unmount()
      }
    }
  })
})
