/**
 * builtin:tasks 插件 client 组件测试（真实编译产物 + 共享宿主 SDK + DOM 事件）。
 *
 * 覆盖：
 * 1. 纯函数模型：宽松 board doc 解析（非法载荷诚实空板）、cwd basename、
 *    deriveTaskLiveView 优先级（error > blocked > 主会话 working > 后代在途 > done > idle）、
 *    跳转目标（最新 blocked 优先）、blockedBy/isReadyToStart；
 * 2. TaskBoardScreen 桌面四列分桶与双轨实时状态灯（working / blocked / error /
 *    子会话在途 / 未交卷停滞 / 会话缺失 / 依赖等待）、needsAttention 置顶稳定排序；
 * 3. 项目/角色/节点/搜索筛选与 ScreenProps.params 深链联动（setParams 回写）；
 * 4. 卡片交互：主体点击打开 720px 会话抽屉（blocked 子会话优先直达）、详情按钮
 *    setParams 深链任务抽屉、分屏按钮 openSplitScreen；
 * 5. 「开工」「通过」「合并结单」「打回返工」「新建待办」「聊一个新任务」完整触发
 *    正确 callAction / openScreen，错误如实展示不吞错；
 * 6. TaskToolView 聊天内活体回执（实时列徽标 + 指示灯联动 board doc 与会话摘要、
 *    点击开抽屉或跳看板深链、错误首行如实、看板外任务诚实标注）；
 * 7. 移动端四胶囊「需我处理 / 待验收 / 进行中 / 待办」(+已完成) 过滤与 tab 参数联动；
 * 7.5 审阅修订：非法 doc 显式无效面板与重载、通用后台徽标事实驱动 background 灯
 *     （停滞不误报）、看板外依赖不伪造阻塞、停滞任务显式继续（submitInput 人工触发）、
 *     mergePending 待验收互斥禁用、历史深链看板外任务显式提示 + inspect 加载完整记录、
 *     哈希派生工具名动词族解析；
 * 8. 实际输出铁律：渲染 DOM 无原生 select/无 Emoji（非源码 regex 扫描）、
 *    编译模块导出仅含 PascalCase 组件。
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type {
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  ScreenProps,
  ToolViewProps,
} from '@helmx/protocol'
import type { PluginClientHostPort } from '@helmx/plugin-client'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const { createRoot } = await import('react-dom/client')
const { PluginClientContext, PluginClientHostContext } = await import('@helmx/plugin-client')
const { importBuiltinClientModule, mountSharedPluginNamespaces } = await import('./helpers/builtin-clients.js')
// 静态导入会在 ensureHappyDom() 之前求值 @helmx/plugin-client（连带 Radix），
// 使其在 window 注册前捕获降级路径；models.ts 必须在 happy-dom 就绪后动态导入。
const {
  cwdBasename,
  deriveTaskLiveView,
  parseTaskBoardDoc,
  parseTaskToolFacts,
} = await import('../../plugins/src/tasks/client/models.ts')
type TaskRecord = import('../../plugins/src/tasks/client/models.ts').TaskRecord

const e = React.createElement
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

mountSharedPluginNamespaces({ realHooks: true })

interface TasksClientComponents {
  TaskBoardScreen: (p: ScreenProps & { inlineDrawer?: boolean }) => React.ReactElement
  TaskToolView: (p: ToolViewProps) => React.ReactElement
}

let components: TasksClientComponents
let rawModule: Record<string, unknown>

before(async () => {
  const mod = await importBuiltinClientModule('builtin:tasks')
  rawModule = mod
  components = {
    TaskBoardScreen: mod['TaskBoardScreen'] as TasksClientComponents['TaskBoardScreen'],
    TaskToolView: mod['TaskToolView'] as TasksClientComponents['TaskToolView'],
  }
}, { timeout: 60_000 })

// ---------------------------------------------------------------------------
// Fixtures & harness
// ---------------------------------------------------------------------------

interface ActionCallRecord {
  actionId: string
  input: unknown
}

interface SpyCtx extends PluginClientContextType {
  drawerCalls: number[]
  screenCalls: string[]
  splitCalls: string[]
  actionCalls: ActionCallRecord[]
  notifyCalls: Array<{ message: string; tone?: string }>
}

function makeSpyCtx(overrides: Partial<SpyCtx> = {}): SpyCtx {
  const drawerCalls: number[] = []
  const screenCalls: string[] = []
  const splitCalls: string[] = []
  const actionCalls: ActionCallRecord[] = []
  const notifyCalls: Array<{ message: string; tone?: string }> = []
  const base: PluginClientContextType = {
    pluginId: 'builtin:tasks',
    callAction: async (actionId, input) => {
      actionCalls.push({ actionId, input })
      return {}
    },
    submitInput: async () => {},
    openScreen: (target) => {
      screenCalls.push(target)
    },
    openSplitScreen: (target) => {
      splitCalls.push(target)
    },
    openConversationDrawer: (id) => {
      drawerCalls.push(id)
    },
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: (message, tone) => {
      notifyCalls.push({ message, tone })
    },
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark',
    locale: 'en',
    translate: (text) => {
      if (typeof text === 'string') return text
      return (text as { en?: string }).en ?? ''
    },
  }
  return Object.assign(base, { drawerCalls, screenCalls, splitCalls, actionCalls, notifyCalls, ...overrides })
}

function conv(id: number, title: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title,
    profileId: 'assistant',
    tags: ['task'],
    cwd: '/repo/helm',
    model: 'openai/gpt-5',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: id * 100,
    updatedAt: id * 100,
    ...extra,
  }
}

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    brief: `Brief for ${id}`,
    column: 'backlog',
    assigneeProfileId: 'assistant',
    dependsOn: [],
    reworkCount: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

const EMPTY_SESSION_DOC_STATE = Object.freeze({
  hasValue: false,
  deleted: false,
  connected: false,
})

let stubConversations: ConversationSummary[] = []
let stubBoard: unknown = undefined
let stubBackground: { unknown: boolean; byConversation: Map<number, { active: boolean; summary: string }> } | undefined = undefined

/** Failed tests leak mounted roots (and the shared now-ticker keeps the loop alive); drain them after the run. */
const cleanups: Array<() => void> = []
after(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function setStubState(options: {
  conversations?: ConversationSummary[]
  board?: unknown
  background?: { unknown: boolean; byConversation: Map<number, { active: boolean; summary: string }> }
}): void {
  if (options.conversations !== undefined) stubConversations = options.conversations
  if ('board' in options) stubBoard = options.board
  // 后台事实切片每次显式覆盖（缺省复位为未接线），避免跨测试泄漏
  stubBackground = options.background
}

async function mount(
  ctx: PluginClientContextType,
  element: React.ReactElement,
): Promise<{ host: HTMLElement; unmount: () => void }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      e(
        PluginClientHostContext.Provider,
        { value: boardHostPort() },
        e(PluginClientContext.Provider, { value: ctx }, element),
      ),
    )
  })
  await act(async () => {})
  let tornDown = false
  const teardown = () => {
    if (tornDown) return
    tornDown = true
    act(() => root.unmount())
    host.remove()
  }
  cleanups.push(teardown)
  return { host, unmount: teardown }
}

function boardHostPort(): PluginClientHostPort {
  return {
    authenticated: false,
    theme: 'dark',
    conversations: stubConversations,
    conversationDetails: {},
    conversationLives: {},
    pendingAsks: [],
    loadErrors: {},
    plugins: [{ id: 'builtin:tasks', enabled: true, publicConfig: { defaultPlannerProfile: 'planner' } }],
    screens: [],
    pluginDocs: stubBoard === undefined ? {} : { 'builtin:tasks/board': stubBoard },
    ...(stubBackground !== undefined ? { conversationBackground: stubBackground } : {}),
    ensurePluginDoc: async () => undefined,
    subscribeSessionDoc: () => () => {},
    getSessionDocState: () => EMPTY_SESSION_DOC_STATE,
    loadConversationDetail: async () => {},
  } as unknown as PluginClientHostPort
}

/** 可变参数容器：模拟宿主 setScreenParams → 状态更新 → 重新渲染链路。 */
function mutableScreenProps(
  initial: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): { props: ScreenProps & Record<string, unknown> } {
  const params: Record<string, string> = { ...initial }
  const props = {
    pluginId: 'builtin:tasks',
    screenId: 'board',
    isSplit: false,
    get params() {
      return { ...params }
    },
    setParams: (patch: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete params[key]
        else params[key] = value
      }
    },
    ...extra,
  }
  return { props }
}

async function mountBoard(
  ctx: PluginClientContextType,
  props: ScreenProps,
): Promise<{ host: HTMLElement; unmount: () => void; reRender: () => Promise<void> }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = () => {
    root.render(
      e(
        PluginClientHostContext.Provider,
        { value: boardHostPort() },
        e(PluginClientContext.Provider, { value: ctx }, e(components.TaskBoardScreen, props)),
      ),
    )
  }
  await act(async () => {
    render()
  })
  await act(async () => {})
  let tornDown = false
  const teardown = () => {
    if (tornDown) return
    tornDown = true
    act(() => root.unmount())
    host.remove()
  }
  cleanups.push(teardown)
  return {
    host,
    unmount: teardown,
    reRender: async () => {
      await act(async () => {
        render()
      })
    },
  }
}

/** React controlled inputs need to bypass the native value setter to trigger onChange. */
function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function click(node: Element | null | undefined): Promise<void> {
  assert.ok(node, 'click target must exist')
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 标准四态看板夹具：覆盖 running / blocked / in_review / backlog / done。 */
function standardBoard(): Record<string, unknown> {
  return {
    tasks: [
      task('T-1', {
        column: 'in_progress',
        conversationId: 10,
        project: 'helm',
        startedAt: Date.now() - 90_000,
        createdAt: 100,
      }),
      task('T-2', {
        column: 'in_progress',
        conversationId: 20,
        createdAt: 200,
      }),
      task('T-3', {
        column: 'in_review',
        conversationId: 30,
        title: 'Auth module',
        submission: {
          summary: 'Auth module done',
          verification: 'pnpm test passed',
          branch: 'feat/auth',
          changedFiles: ['a.ts', 'b.ts'],
          submittedAt: 5000,
        },
        createdAt: 300,
      }),
      task('T-4', { dependsOn: ['T-1'], createdAt: 400 }),
      task('T-5', { createdAt: 500 }),
      task('T-6', { column: 'done', conversationId: 40, completedAt: 600, createdAt: 600 }),
    ],
    updatedAt: 999,
  }
}

function standardConversations(): ConversationSummary[] {
  return [
    conv(10, 'T-1 exec', { status: 'working', doing: 'bash: pnpm test' }),
    conv(11, 'T-1 sub', { parentConversationId: 10, status: 'working' }),
    conv(20, 'T-2 exec', { status: 'blocked', pendingAskCount: 1, doing: 'ask: confirm plan' }),
    conv(30, 'T-3 exec'),
    conv(40, 'T-6 exec'),
  ]
}

// ---------------------------------------------------------------------------
// 1. Pure model functions
// ---------------------------------------------------------------------------

test('parseTaskBoardDoc：非法载荷显式无效（undefined），合法字段宽松解析', { timeout: 60_000 }, () => {
  assert.equal(parseTaskBoardDoc(undefined), undefined)
  assert.equal(parseTaskBoardDoc({ nope: 1 }), undefined)
  assert.equal(parseTaskBoardDoc({ tasks: 'nope' }), undefined)
  const parsed = parseTaskBoardDoc({
    tasks: [
      { id: 'T-1', title: 'ok', brief: 'b', column: 'in_progress', dependsOn: ['T-9'], extra: 1 },
      { id: '', title: 'drop', column: 'backlog' },
      { title: 'no id', column: 'backlog' },
      { id: 'T-2', title: 'bad column', column: 'weird' },
    ],
    updatedAt: 42,
  })
  assert.ok(parsed, '合法载荷应解析成功')
  assert.equal(parsed.tasks.length, 1)
  assert.equal(parsed.tasks[0]?.id, 'T-1')
  assert.deepEqual(parsed.tasks[0]?.dependsOn, ['T-9'])
  assert.equal(parsed.updatedAt, 42)
})

test('cwdBasename：POSIX 与 Windows 分隔符取末段', { timeout: 60_000 }, () => {
  assert.equal(cwdBasename('/root/code/helm'), 'helm')
  assert.equal(cwdBasename('C:\\Users\\fjayb\\projects\\ph'), 'ph')
  assert.equal(cwdBasename('/root/code/helm/'), 'helm')
  assert.equal(cwdBasename(undefined), '')
  assert.equal(cwdBasename('   '), '')
})

test('deriveTaskLiveView：error > blocked > 主 working > 后代在途 > done > idle 优先级', { timeout: 60_000 }, () => {
  const tasks = [task('T-1', { column: 'done' }), task('T-2', { column: 'backlog' })]
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const mk = (overrides: Partial<TaskRecord>, convs: ConversationSummary[]) =>
    deriveTaskLiveView(task('T-9', { column: 'in_progress', ...overrides }), convs, undefined, byId)

  // 主会话 working（含一个 working 后代）
  const running = mk({ conversationId: 10 }, [
    conv(10, 'main', { status: 'working', doing: 'edit file' }),
    conv(11, 'sub', { parentConversationId: 10, status: 'working' }),
  ])
  assert.equal(running.lightStatus, 'running')
  assert.equal(running.liveSummary, 'edit file')
  assert.equal(running.activeChildCount, 1)
  assert.equal(running.jumpConversationId, 10)
  assert.equal(running.needsAttention, false)

  // 后代 blocked（比主会话新）→ blocked 且直达最新 blocked
  const blocked = mk({ conversationId: 10 }, [
    conv(10, 'main', { status: 'idle' }),
    conv(11, 'sub', { parentConversationId: 10, status: 'blocked', createdAt: 2000 }),
  ])
  assert.equal(blocked.lightStatus, 'blocked')
  assert.equal(blocked.jumpConversationId, 11)
  assert.equal(blocked.needsAttention, true)

  // 主会话完成 + 后代 working → background 摘要
  const background = mk({ conversationId: 10 }, [
    conv(10, 'main', { status: 'done' }),
    conv(11, 'sub', { parentConversationId: 10, status: 'working' }),
  ])
  assert.equal(background.lightStatus, 'background')
  assert.equal(background.liveSummary, '1 sub-session active')

  // 子树 error → error 且如实展示 lastError
  const errored = mk({ conversationId: 10 }, [
    conv(10, 'main', { status: 'idle' }),
    conv(11, 'sub', { parentConversationId: 10, status: 'error', lastError: 'model_error: quota' }),
  ])
  assert.equal(errored.lightStatus, 'error')
  assert.equal(errored.liveSummary, 'Error: model_error: quota')
  assert.equal(errored.needsAttention, true)

  // 会话缺失（非 backlog）→ 诚实标记
  const missing = mk({ conversationId: 999 }, [])
  assert.equal(missing.conversationMissing, true)
  assert.equal(missing.liveSummary, 'Execution conversation missing')
  assert.equal(missing.needsAttention, true)

  // 未交卷停滞
  const stalled = mk({ conversationId: 10, silenceState: { nudgedAt: 100, stalledAt: 200 } }, [conv(10, 'main')])
  assert.equal(stalled.needsAttention, true)
  assert.equal(stalled.liveSummary, 'Turn settled, not submitted yet')

  // 依赖：blockedBy 只统计已知未完成前置；看板外依赖不伪造阻塞
  const depTask = task('T-5', { dependsOn: ['T-1', 'T-2'] })
  assert.deepEqual(deriveTaskLiveView(depTask, [], undefined, byId).blockedBy, ['T-2'])
  assert.equal(deriveTaskLiveView(depTask, [], undefined, byId).isReadyToStart, false)
  assert.equal(deriveTaskLiveView(task('T-6', { dependsOn: ['T-1'] }), [], undefined, byId).isReadyToStart, true)
  const offBoard = deriveTaskLiveView(task('T-7', { dependsOn: ['T-1', 'T-99'] }), [], undefined, byId)
  assert.deepEqual(offBoard.blockedBy, [])
  assert.deepEqual(offBoard.offBoardDeps, ['T-99'])
  assert.equal(offBoard.isReadyToStart, true, '看板外依赖（完成截断）不伪造为阻塞，后端 start 为权威门禁')

  // 等待审批 vs 等待子会话确认：文案区分，直达 Ask 现场
  const approval = mk({ conversationId: 10 }, [conv(10, 'main', { status: 'blocked', pendingAskCount: 1, doing: 'ask: pick plan' })])
  assert.equal(approval.approvalPending, true)
  assert.equal(approval.liveSummary, 'Waiting for approval — ask: pick plan')
  const subConfirm = mk({ conversationId: 10 }, [
    conv(10, 'main', { status: 'idle' }),
    conv(11, 'sub', { parentConversationId: 10, status: 'blocked' }),
  ])
  assert.equal(subConfirm.approvalPending, false)
  assert.equal(subConfirm.liveSummary, 'Waiting for sub-session confirmation')

  // 失败现场直达：子树 error 优先于主会话跳转
  const errorSite = mk({ conversationId: 10 }, [
    conv(10, 'main', { status: 'idle' }),
    conv(11, 'sub', { parentConversationId: 10, status: 'error', lastError: 'boom', createdAt: 2000 }),
  ])
  assert.equal(errorSite.jumpConversationId, 11)

  // 共享 SDK 后台快照（web-awareness 契约）：主会话空闲但后台 run 在途 →
  // background 灯 + 真实摘要，停滞不被误报
  const withBackground = deriveTaskLiveView(
    task('T-8', { column: 'in_progress', conversationId: 10, silenceState: { nudgedAt: 1, stalledAt: 2 } }),
    [conv(10, 'main', { status: 'idle' })],
    undefined,
    byId,
    'en',
    { unknown: false, byConversation: new Map([[10, { active: true, summary: '2 Running' }]]) },
  )
  assert.equal(withBackground.lightStatus, 'background')
  assert.equal(withBackground.backgroundActive, true)
  assert.equal(withBackground.liveSummary, '2 Running')
  assert.equal(withBackground.stalled, false, '后台在途时不得误报「回合已停 · 未交卷」')
  assert.equal(withBackground.needsAttention, false)
  // unknown 门（badge doc 未首载/宿主未聚合）：事实不可知 → 零推断，不伪造
  // 在途也不宣称「无后台任务」，停滞保持后端记录的真实语义
  const unknownFacts = deriveTaskLiveView(
    task('T-9', { column: 'in_progress', conversationId: 10, silenceState: { nudgedAt: 1, stalledAt: 2 } }),
    [conv(10, 'main', { status: 'idle' })],
    undefined,
    byId,
    'en',
    { unknown: true, byConversation: new Map([[10, { active: true, summary: '2 Running' }]]) },
  )
  assert.equal(unknownFacts.backgroundActive, false, 'unknown 时不得采信条目')
  assert.equal(unknownFacts.stalled, true)
  assert.equal(unknownFacts.liveSummary, 'Turn settled, not submitted yet')
  // 未接线（undefined）时同样零推断
  const noFacts = deriveTaskLiveView(
    task('T-10', { column: 'in_progress', conversationId: 10, silenceState: { nudgedAt: 1, stalledAt: 2 } }),
    [conv(10, 'main', { status: 'idle' })],
  )
  assert.equal(noFacts.stalled, true)
  assert.equal(noFacts.liveSummary, 'Turn settled, not submitted yet')
})

test('parseTaskToolFacts：宽松提取任务指针（结果优先，输入兜底）', { timeout: 60_000 }, () => {
  const fromResult = parseTaskToolFacts({ title: 'Input title' }, { task: { id: 'T-1', title: 'Real title', conversationId: 7 }, conversationId: 7 })
  assert.equal(fromResult.taskId, 'T-1')
  assert.equal(fromResult.title, 'Real title')
  assert.equal(fromResult.conversationId, 7)
  const fromInput = parseTaskToolFacts({ taskId: 'T-2' }, undefined)
  assert.equal(fromInput.taskId, 'T-2')
  assert.equal(parseTaskToolFacts(undefined, { error: 'x' }).taskId, undefined)
  assert.equal(parseTaskToolFacts({ taskId: 'T-3' }, { unblockedTaskIds: ['T-4', 'T-5'] }).unblockedCount, 2)
})

// ---------------------------------------------------------------------------
// 2. Board screen: four columns + live lights
// ---------------------------------------------------------------------------

test('四列分桶与双轨实时状态灯：needsAttention 置顶、真实 doing/停滞/依赖等待', { timeout: 60_000 }, async (t) => {
  setStubState({ conversations: standardConversations(), board: standardBoard() })
  const { host, unmount } = await mountBoard(makeSpyCtx(), mutableScreenProps().props)
  t.after(unmount)

  const columnCards = (column: string): Element[] => [...host.querySelectorAll(`[data-task-column="${column}"] .task-card`)]
  assert.equal(columnCards('backlog').length, 2)
  assert.equal(columnCards('in_progress').length, 2)
  assert.equal(columnCards('in_review').length, 1)
  assert.equal(columnCards('done').length, 1)

  // in_progress 列 needsAttention（blocked）置顶
  const inProgressIds = columnCards('in_progress').map((c) => c.getAttribute('data-task-id'))
  assert.deepEqual(inProgressIds, ['T-2', 'T-1'])

  const toneOf = (card: Element): string | null =>
    card.querySelector('.helmx-status-light')?.getAttribute('data-tone') ?? null

  // T-1 主会话 working → running 灯 + 真实 doing
  const t1 = columnCards('in_progress').find((c) => c.getAttribute('data-task-id') === 'T-1')
  assert.ok(t1)
  assert.equal(toneOf(t1), 'working')
  assert.match(t1.textContent ?? '', /bash: pnpm test/)

  // T-2 blocked → 需处理 + 等待处理提示
  const t2 = columnCards('in_progress').find((c) => c.getAttribute('data-task-id') === 'T-2')
  assert.ok(t2, 'T-2 卡片应存在')
  assert.ok(t2.classList.contains('is-attention'))
  assert.equal(toneOf(t2), 'blocked')
  assert.match(t2.textContent ?? '', /Waiting for approval — ask: confirm plan/)

  // T-3 in_review：交付摘要 + 分支 + 改动数 + 通过/合并/返工按钮
  const t3 = columnCards('in_review')[0]
  assert.ok(t3)
  assert.match(t3.textContent ?? '', /Auth module done/)
  assert.match(t3.textContent ?? '', /feat\/auth/)
  assert.match(t3.textContent ?? '', /2 changed files/)
  const t3Buttons = [...(t3.querySelectorAll('button') ?? [])]
  assert.ok(t3Buttons.some((b) => b.textContent?.includes('Approve')))
  assert.ok(t3Buttons.some((b) => b.textContent?.includes('Merge & close')))
  assert.ok(t3Buttons.some((b) => b.textContent?.includes('Rework')))

  // T-4 依赖未完成 → 等待 T-1 且无开工按钮；T-5 就绪直出开工
  const t4 = columnCards('backlog').find((c) => c.getAttribute('data-task-id') === 'T-4')
  const t5 = columnCards('backlog').find((c) => c.getAttribute('data-task-id') === 'T-5')
  assert.match(t4?.textContent ?? '', /Waiting for T-1/)
  assert.ok(![...(t4?.querySelectorAll('button') ?? [])].some((b) => b.textContent?.includes('Start')))
  assert.ok(t5)
  assert.match(t5.textContent ?? '', /Ready/)
  assert.ok([...(t5.querySelectorAll('button') ?? [])].some((b) => b.textContent?.includes('Start')))

  // 统计行如实
  assert.match(host.textContent ?? '', /6 tasks · 2 in flight · 1 awaiting review/)
  unmount()
})

test('诚实实时事实：报错、未交卷停滞、会话缺失、子会话在途', { timeout: 60_000 }, async (t) => {
  setStubState({
    conversations: [
      conv(50, 'err', { status: 'error', lastError: 'model_error: quota' }),
      conv(60, 'stalled'),
      conv(70, 'done-main', { status: 'done' }),
      conv(71, 'done-sub', { parentConversationId: 70, status: 'working' }),
    ],
    board: {
      tasks: [
        task('T-7', { column: 'in_progress', conversationId: 50, createdAt: 700 }),
        task('T-8', { column: 'in_progress', conversationId: 60, silenceState: { nudgedAt: 1, stalledAt: 2 }, createdAt: 800 }),
        task('T-9', { column: 'in_progress', conversationId: 999, createdAt: 900 }),
        task('T-10', { column: 'in_progress', conversationId: 70, createdAt: 1000 }),
      ],
      updatedAt: 1,
    },
  })
  const { host, unmount } = await mountBoard(makeSpyCtx(), mutableScreenProps().props)
  t.after(unmount)
  const card = (id: string): Element | undefined =>
    [...host.querySelectorAll('.task-card')].find((c) => c.getAttribute('data-task-id') === id)

  assert.match(card('T-7')?.textContent ?? '', /Error: model_error: quota/)
  assert.match(card('T-8')?.textContent ?? '', /Turn settled, not submitted yet/)
  assert.ok(card('T-8')?.classList.contains('is-attention'))
  assert.match(card('T-9')?.textContent ?? '', /Execution conversation missing/)
  assert.match(card('T-10')?.textContent ?? '', /1 sub-session active/)
  assert.equal(card('T-10')?.querySelector('.helmx-status-light')?.getAttribute('data-tone'), 'working')
  unmount()
})

// ---------------------------------------------------------------------------
// 3. Filters & deep-link params
// ---------------------------------------------------------------------------

test('筛选与深链：q/project/assignee/node 参数过滤、清除按钮回写、触发器标签聚合', { timeout: 60_000 }, async (t) => {
  setStubState({
    conversations: standardConversations(),
    board: {
      tasks: [
        task('T-1', { column: 'in_progress', conversationId: 10, project: 'helm', nodeId: 'local', createdAt: 100 }),
        task('T-2', { column: 'backlog', cwd: '/repo/ph', assigneeProfileId: 'lx', nodeId: 'lx', createdAt: 200 }),
        task('T-3', { column: 'in_review', conversationId: 30, title: 'Auth module', createdAt: 300 }),
      ],
      updatedAt: 1,
    },
  })

  // 深链 project 过滤
  const byProject = await mountBoard(makeSpyCtx(), mutableScreenProps({ project: 'helm' }).props)
  t.after(() => byProject.unmount())
  assert.deepEqual(
    [...byProject.host.querySelectorAll('.task-card')].map((c) => c.getAttribute('data-task-id')),
    ['T-1'],
  )
  byProject.unmount()

  // 深链 q 过滤（标题关键字）
  const byQuery = await mountBoard(makeSpyCtx(), mutableScreenProps({ q: 'auth' }).props)
  t.after(() => byQuery.unmount())
  assert.deepEqual(
    [...byQuery.host.querySelectorAll('.task-card')].map((c) => c.getAttribute('data-task-id')),
    ['T-3'],
  )
  byQuery.unmount()

  // 深链 assignee / node 过滤
  const byAssignee = await mountBoard(makeSpyCtx(), mutableScreenProps({ assignee: 'lx' }).props)
  t.after(() => byAssignee.unmount())
  assert.deepEqual(
    [...byAssignee.host.querySelectorAll('.task-card')].map((c) => c.getAttribute('data-task-id')),
    ['T-2'],
  )
  byAssignee.unmount()
  const byNode = await mountBoard(makeSpyCtx(), mutableScreenProps({ node: 'lx' }).props)
  t.after(() => byNode.unmount())
  assert.deepEqual(
    [...byNode.host.querySelectorAll('.task-card')].map((c) => c.getAttribute('data-task-id')),
    ['T-2'],
  )
  byNode.unmount()

  // 触发器标签聚合（未过滤时显示 All；cwd basename 进入项目选项语境）
  const all = await mountBoard(makeSpyCtx(), mutableScreenProps().props)
  t.after(() => all.unmount())
  const triggers = [...all.host.querySelectorAll('.helmx-select-trigger')].map((t) => t.textContent ?? '')
  assert.ok(triggers.some((label) => label.includes('Project') && label.includes('All')))
  assert.ok(triggers.some((label) => label.includes('Assignee') && label.includes('All')))
  assert.ok(triggers.some((label) => label.includes('Node') && label.includes('All')))
  // T-2 项目标签从 cwd basename 衍生
  const t2card = [...all.host.querySelectorAll('.task-card')].find((c) => c.getAttribute('data-task-id') === 'T-2')
  assert.match(t2card?.textContent ?? '', /ph/)
  all.unmount()

  // 搜索输入受控回写 + 清除按钮（setParams 是唯一导航机制）
  const { props } = mutableScreenProps()
  const live = await mountBoard(makeSpyCtx(), props)
  t.after(() => live.unmount())
  const search = live.host.querySelector<HTMLInputElement>('.primary-search-box input')
  assert.ok(search)
  setInputValue(search, 'helm')
  await act(async () => {})
  assert.equal(props.params['q'], 'helm')
  const clear = live.host.querySelector<HTMLButtonElement>('.primary-search-clear')
  await click(clear)
  assert.equal(props.params['q'], undefined)
  await live.reRender()
  assert.deepEqual(
    [...live.host.querySelectorAll('.task-card')].map((c) => c.getAttribute('data-task-id')).sort(),
    ['T-1', 'T-2', 'T-3'],
  )
  live.unmount()
})

// ---------------------------------------------------------------------------
// 4. Card interactions
// ---------------------------------------------------------------------------

test('卡片交互：主体点击开抽屉（blocked 子会话优先直达）、详情深链、分屏', { timeout: 60_000 }, async (t) => {
  setStubState({
    conversations: [
      conv(10, 'T-1 exec', { status: 'working' }),
      conv(80, 'T-11 exec'),
      conv(81, 'T-11 blocked child', { parentConversationId: 80, status: 'blocked', createdAt: 9000 }),
    ],
    board: {
      tasks: [
        task('T-1', { column: 'in_progress', conversationId: 10, createdAt: 100 }),
        task('T-11', { column: 'in_progress', conversationId: 80, createdAt: 200 }),
        task('T-5', { createdAt: 500 }),
      ],
      updatedAt: 1,
    },
  })
  const ctx = makeSpyCtx()
  const { props } = mutableScreenProps({}, { inlineDrawer: true })
  const { host, unmount, reRender } = await mountBoard(ctx, props)
  t.after(unmount)

  const card = (id: string): Element | undefined =>
    [...host.querySelectorAll('.task-card')].find((c) => c.getAttribute('data-task-id') === id)

  // T-1 主体点击 → 打开会话抽屉
  await click(card('T-1'))
  assert.deepEqual(ctx.drawerCalls, [10])

  // T-11 子树存在更新的 blocked 会话 → 直达 blocked 会话
  await click(card('T-11'))
  assert.deepEqual(ctx.drawerCalls, [10, 81])

  // 详情按钮 → setParams 深链任务抽屉（inline 抽屉渲染完整简报）
  const detailBtn = [...(card('T-1')?.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('aria-label') === 'View task details')
  await click(detailBtn ?? null)
  assert.equal(props.params['task'], 'T-1')
  await reRender()
  const drawer = host.querySelector('.primary-drawer-content')
  assert.ok(drawer, '任务详情抽屉应渲染')
  assert.match(drawer.textContent ?? '', /Brief for T-1/)
  assert.match(drawer.textContent ?? '', /T-1/)

  // 抽屉关闭清掉深链
  const closeBtn = [...(drawer.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('aria-label') === 'Close')
  await click(closeBtn ?? null)
  assert.equal(props.params['task'], undefined)

  // 分屏按钮 → openSplitScreen('conversation:10')
  const splitBtn = [...(card('T-1')?.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('aria-label') === 'Open the execution conversation in the right split pane')
  await click(splitBtn ?? null)
  assert.deepEqual(ctx.splitCalls, ['conversation:10'])

  // backlog 无会话卡片点击 → 详情抽屉（不打开会话）
  await click(card('T-5'))
  assert.equal(props.params['task'], 'T-5')
  assert.deepEqual(ctx.drawerCalls, [10, 81])
  unmount()
})

// ---------------------------------------------------------------------------
// 5. Actions: start / approve / merge & close / rework / create / chat
// ---------------------------------------------------------------------------

test('看板动作：开工/通过直发；合并结单先确认（分支与清理事实）再派发', { timeout: 60_000 }, async (t) => {
  setStubState({ conversations: standardConversations(), board: standardBoard() })
  const ctx = makeSpyCtx()
  const { host, unmount } = await mountBoard(ctx, mutableScreenProps().props)
  t.after(unmount)

  const card = (id: string): Element | undefined =>
    [...host.querySelectorAll('.task-card')].find((c) => c.getAttribute('data-task-id') === id)
  const buttonByText = (root: Element, text: string): HTMLButtonElement | undefined =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))

  await click(buttonByText(card('T-5') ?? host, 'Start'))
  await click(buttonByText(card('T-3') ?? host, 'Approve'))

  // 合并结单涉及 Git 主干：必须先弹确认（展示分支/清理），未确认前不派发
  await click(buttonByText(card('T-3') ?? host, 'Merge & close'))
  assert.deepEqual(ctx.actionCalls.map(({ actionId }) => actionId), ['start', 'approve'], '确认前不得派发 merge_and_close')
  const confirmModal = document.querySelector('.task-modal')
  assert.ok(confirmModal, '合并确认弹窗应挂载')
  assert.match(confirmModal.textContent ?? '', /feat\/auth/, '确认弹窗应展示交付分支')
  assert.match(confirmModal.textContent ?? '', /2 changed files/, '确认弹窗应展示改动文件数')
  assert.match(confirmModal.textContent ?? '', /main branch/, '确认弹窗应说明涉及主干')

  // 取消 → 不派发；再次发起并确认 → 派发 merge_and_close
  await click([...confirmModal.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Cancel')) ?? null)
  assert.ok(document.querySelector('.task-modal') === null)
  assert.deepEqual(ctx.actionCalls.map(({ actionId }) => actionId), ['start', 'approve'])
  await click(buttonByText(card('T-3') ?? host, 'Merge & close'))
  const modal2 = document.querySelector('.task-modal')
  assert.ok(modal2)
  await click([...modal2.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Merge & close task')) ?? null)

  assert.deepEqual(
    ctx.actionCalls.map(({ actionId, input }) => ({ actionId, input })),
    [
      { actionId: 'start', input: { taskId: 'T-5' } },
      { actionId: 'approve', input: { taskId: 'T-3', mergeAction: 'close_only' } },
      { actionId: 'approve', input: { taskId: 'T-3', mergeAction: 'merge_and_close' } },
    ],
  )
  unmount()
})

test('打回返工：弹窗输入意见提交 rework，空意见显式拦截', { timeout: 60_000 }, async (t) => {
  setStubState({ conversations: standardConversations(), board: standardBoard() })
  const ctx = makeSpyCtx()
  const { host, unmount } = await mountBoard(ctx, mutableScreenProps().props)
  t.after(unmount)

  const t3 = [...host.querySelectorAll('.task-card')].find((c) => c.getAttribute('data-task-id') === 'T-3')
  const reworkBtn = [...(t3?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.includes('Rework'))
  await click(reworkBtn ?? null)

  const modal = document.querySelector('.task-modal')
  assert.ok(modal, '返工弹窗应挂载')
  assert.match(modal.textContent ?? '', /Rework T-3/)

  const textarea = modal.querySelector<HTMLTextAreaElement>('textarea')
  assert.ok(textarea)

  // 空意见：提交被前端校验拦截（不触达 callAction）
  const submit = [...modal.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Send rework'))
  await click(submit ?? null)
  assert.equal(ctx.actionCalls.length, 0)
  assert.match(modal.textContent ?? '', /This field is required/)

  // 填入意见 → 提交 rework
  setInputValue(textarea, 'fix the flaky test')
  await click(submit ?? null)
  assert.deepEqual(ctx.actionCalls, [{ actionId: 'rework', input: { taskId: 'T-3', feedback: 'fix the flaky test' } }])
  assert.ok(document.querySelector('.task-modal') === null, '提交成功后弹窗关闭')
  unmount()
})

test('新建待办：表单校验、依赖解析、开关、后端错误如实展示', { timeout: 60_000 }, async (t) => {
  setStubState({ conversations: standardConversations(), board: standardBoard() })
  const ctx = makeSpyCtx()
  const { host, unmount } = await mountBoard(ctx, mutableScreenProps().props)
  t.after(unmount)

  const newBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('New task'))
  await click(newBtn ?? null)
  let modal = document.querySelector('.task-modal')
  assert.ok(modal, '新建弹窗应挂载')

  const inputs = [...modal.querySelectorAll<HTMLInputElement>('input')]
  const titleInput = inputs.find((i) => i.getAttribute('aria-label') === 'Title')
  const briefArea = modal.querySelector<HTMLTextAreaElement>('textarea')
  const projectInput = inputs.find((i) => i.getAttribute('aria-label') === 'Project')
  const depsInput = inputs.find((i) => i.getAttribute('aria-label') === 'Depends on')
  const submit = [...modal.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Create task'))
  assert.ok(titleInput && briefArea && projectInput && depsInput && submit)

  // 空标题：显式校验错误，不发请求
  await click(submit)
  assert.equal(ctx.actionCalls.length, 0)
  assert.match(modal.textContent ?? '', /This field is required/)

  setInputValue(titleInput, 'Add metrics endpoint')
  setInputValue(briefArea, 'Add /metrics with auth.')
  setInputValue(projectInput, 'helm')
  setInputValue(depsInput, 'T-1, T-2， T-3')
  // 打开 planFirst 开关
  const planSwitch = [...modal.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find((b) => b.getAttribute('aria-label') === 'Plan first')
  await click(planSwitch ?? null)

  await click(submit)
  assert.equal(ctx.actionCalls.length, 1)
  assert.deepEqual(ctx.actionCalls[0], {
    actionId: 'create',
    input: {
      title: 'Add metrics endpoint',
      brief: 'Add /metrics with auth.',
      project: 'helm',
      dependsOn: ['T-1', 'T-2', 'T-3'],
      planFirst: true,
      autoMerge: false,
      autoStart: true,
    },
  })
  assert.ok(document.querySelector('.task-modal') === null, '创建成功后弹窗关闭')
  unmount()

  // 后端错误：显式展示不吞错（独立挂载失败上下文）
  const failing = makeSpyCtx({
    callAction: async () => {
      throw new Error('task_dependency_cycle')
    },
  })
  const second = await mountBoard(failing, mutableScreenProps().props)
  t.after(() => second.unmount())
  const newBtn2 = [...second.host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('New task'))
  await click(newBtn2 ?? null)
  modal = document.querySelector('.task-modal')
  assert.ok(modal)
  const inputs2 = [...modal.querySelectorAll<HTMLInputElement>('input')]
  const title2 = inputs2.find((i) => i.getAttribute('aria-label') === 'Title')
  if (title2 !== undefined) setInputValue(title2, 'Bad deps')
  const area2 = modal.querySelector<HTMLTextAreaElement>('textarea')
  assert.ok(area2)
  setInputValue(area2, 'x')
  await click([...modal.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Create task')) ?? null)
  assert.match(modal.textContent ?? '', /task_dependency_cycle/)
  assert.equal(document.querySelector('.task-modal') !== null, true, '失败时弹窗保持打开')
  second.unmount()
})

test('聊一个新任务：按配置的规划角色 openScreen agent 深链', { timeout: 60_000 }, async (t) => {
  setStubState({ conversations: [], board: { tasks: [], updatedAt: 1 } })
  const ctx = makeSpyCtx()
  const { host, unmount } = await mountBoard(ctx, mutableScreenProps().props)
  t.after(unmount)
  assert.match(host.textContent ?? '', /No tasks yet/)
  const chatBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Plan a task'))
  await click(chatBtn ?? null)
  assert.deepEqual(ctx.screenCalls, ['agent:planner'])
  unmount()
})

// ---------------------------------------------------------------------------
// 6. TaskToolView receipts
// ---------------------------------------------------------------------------

function toolProps(overrides: Partial<ToolViewProps> = {}): ToolViewProps {
  return {
    callId: 'call-1',
    toolName: 'task_create',
    status: 'done',
    input: {},
    durationMs: 1200,
    conversationId: 1,
    ...overrides,
  }
}

test('TaskToolView 活体回执：实时列徽标与灯、点击开抽屉、看板深链、错误首行', { timeout: 60_000 }, async (t) => {
  setStubState({
    conversations: [conv(10, 'T-1 exec', { status: 'working', doing: 'writing tests' })],
    board: {
      tasks: [task('T-1', { column: 'in_progress', conversationId: 10, title: 'Fix auth' })],
      updatedAt: 1,
    },
  })
  const ctx = makeSpyCtx()

  // 有执行会话：点击打开抽屉；徽标实时为 In Progress；灯 working
  const first = await mount(ctx, e(components.TaskToolView, toolProps({
    toolName: 'task_create',
    input: { title: 'Fix auth' },
    structuredOutput: { task: { id: 'T-1', title: 'Fix auth', column: 'in_progress', conversationId: 10 }, started: true, conversationId: 10 },
  })))
  t.after(() => first.unmount())
  const row = first.host.querySelector('.task-trace-row')
  assert.ok(row)
  assert.match(row.textContent ?? '', /T-1 · Fix auth/)
  assert.match(row.textContent ?? '', /In Progress/)
  assert.equal(row.querySelector('.helmx-status-light')?.getAttribute('data-tone'), 'working')
  await click(row)
  assert.deepEqual(ctx.drawerCalls, [10])
  first.unmount()

  // 无执行会话：点击跳看板深链
  const second = await mount(ctx, e(components.TaskToolView, toolProps({
    toolName: 'task_create',
    structuredOutput: { task: { id: 'T-5', title: 'Backlog only', column: 'backlog' } },
  })))
  t.after(() => second.unmount())
  const row2 = second.host.querySelector('.task-trace-row')
  assert.ok(row2)
  assert.match(row2.textContent ?? '', /Backlog/)
  await click(row2)
  assert.deepEqual(ctx.screenCalls, ['screen:builtin:tasks/board?task=T-5'])
  second.unmount()

  // 错误态：错误首行如实展示
  const third = await mount(ctx, e(components.TaskToolView, toolProps({
    toolName: 'task_start',
    status: 'error',
    input: { taskId: 'T-1' },
    result: 'task_blocked_by_dependencies: T-9 not done\nsecond line',
  })))
  t.after(() => third.unmount())
  const row3 = third.host.querySelector('.task-trace-row')
  assert.ok(row3)
  assert.match(row3.textContent ?? '', /task_blocked_by_dependencies: T-9 not done/)
  assert.equal(row3.querySelector('.helmx-status-light')?.getAttribute('data-tone'), 'failed')
  third.unmount()

  // 哈希派生工具名（exposeAsTool 形如 tasks_create_ab12cd34）同样解析动词族
  const hashed = await mount(ctx, e(components.TaskToolView, toolProps({
    toolName: 'tasks_create_ab12cd34',
    input: { title: 'Fix auth' },
    structuredOutput: { task: { id: 'T-1', title: 'Fix auth', column: 'in_progress', conversationId: 10 } },
  })))
  const hashedRow = hashed.host.querySelector('.task-trace-row')
  assert.ok(hashedRow)
  assert.match(hashedRow.textContent ?? '', /Create task/, '哈希工具名应回落到动词族标题')
  hashed.unmount()

  // 看板外任务：诚实标注（不伪造运行态）
  const fourth = await mount(ctx, e(components.TaskToolView, toolProps({
    toolName: 'task_approve',
    input: { taskId: 'T-99' },
    structuredOutput: { taskId: 'T-99' },
  })))
  t.after(() => fourth.unmount())
  assert.match(fourth.host.textContent ?? '', /Not on the current board/)
  fourth.unmount()
})

// ---------------------------------------------------------------------------
// 7. Mobile clear-down flow
// ---------------------------------------------------------------------------

test('移动端四胶囊清零流：attention 聚合、tab 切换 setParams 联动、done 可切看', { timeout: 60_000 }, async (t) => {
  setStubState({
    conversations: [
      conv(20, 'T-2 exec', { status: 'blocked', pendingAskCount: 1 }),
      conv(30, 'T-3 exec'),
      conv(10, 'T-1 exec', { status: 'working' }),
    ],
    board: {
      tasks: [
        task('T-1', { column: 'in_progress', conversationId: 10, createdAt: 100 }),
        task('T-2', { column: 'in_progress', conversationId: 20, createdAt: 200 }),
        task('T-3', { column: 'in_review', conversationId: 30, createdAt: 300 }),
        task('T-4', { createdAt: 400 }),
        task('T-6', { column: 'done', createdAt: 600 }),
      ],
      updatedAt: 1,
    },
  })
  const { props } = mutableScreenProps()
  const { host, unmount, reRender } = await mountBoard(makeSpyCtx(), props)
  t.after(unmount)

  const mobileList = (): Element[] => [...host.querySelectorAll('.task-board-mobile-list .task-card')]
  const tabButton = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll<HTMLButtonElement>('.task-board-mobile-tabs .segmented-control-btn')]
      .find((b) => b.textContent?.includes(label))

  // 默认 attention：仅需我处理任务（blocked T-2）
  assert.deepEqual(mobileList().map((c) => c.getAttribute('data-task-id')), ['T-2'])

  // 切到待验收 → setParams 回写 tab 并重渲染
  await click(tabButton('Review') ?? null)
  assert.equal(props.params['tab'], 'in_review')
  await reRender()
  assert.deepEqual(mobileList().map((c) => c.getAttribute('data-task-id')), ['T-3'])

  // 切到进行中：attention 任务已归入需我处理胶囊，进行中仅剩普通运行任务
  await click(tabButton('Running') ?? null)
  assert.equal(props.params['tab'], 'in_progress')
  await reRender()
  assert.deepEqual(mobileList().map((c) => c.getAttribute('data-task-id')), ['T-1'])
  await click(tabButton('Backlog') ?? null)
  await reRender()
  assert.deepEqual(mobileList().map((c) => c.getAttribute('data-task-id')), ['T-4'])
  await click(tabButton('Done') ?? null)
  await reRender()
  assert.deepEqual(mobileList().map((c) => c.getAttribute('data-task-id')), ['T-6'])
  unmount()

  // 深链直达 tab=done
  const deep = await mountBoard(makeSpyCtx(), mutableScreenProps({ tab: 'done' }).props)
  t.after(() => deep.unmount())
  assert.deepEqual(
    [...deep.host.querySelectorAll('.task-board-mobile-list .task-card')].map((c) => c.getAttribute('data-task-id')),
    ['T-6'],
  )
  deep.unmount()
})

// ---------------------------------------------------------------------------
// 7.5 Review fixes: invalid doc / off-board deps & deep link / background / continue / mergePending
// ---------------------------------------------------------------------------

test('非法 board doc：显式无效面板与重载入口，不伪装成空看板', { timeout: 60_000 }, async (t) => {
  setStubState({ conversations: [], board: { tasks: 'corrupted' } })
  const ctx = makeSpyCtx()
  const { host, unmount } = await mountBoard(ctx, mutableScreenProps().props)
  t.after(unmount)
  assert.match(host.textContent ?? '', /Task board data is invalid/)
  const reload = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Reload board'))
  assert.ok(reload, '应提供重载入口')
  assert.equal(host.querySelectorAll('.task-card').length, 0, '不得渲染任何任务卡（不伪造空板任务）')
  await click(reload ?? null)
  assert.equal(ctx.actionCalls.length, 0, '重载走 getPluginDoc，不触发动作')
  unmount()
})

test('后台 run 在途：通用徽标事实驱动 background 灯与真实摘要，停滞不误报', { timeout: 60_000 }, async (t) => {
  setStubState({
    conversations: [conv(10, 'T-1 exec', { status: 'idle' })],
    board: {
      tasks: [task('T-1', { column: 'in_progress', conversationId: 10, silenceState: { nudgedAt: 1, stalledAt: 2 }, createdAt: 100 })],
      updatedAt: 1,
    },
    background: { unknown: false, byConversation: new Map([[10, { active: true, summary: '2 Running' }]]) },
  })
  const { host, unmount } = await mountBoard(makeSpyCtx(), mutableScreenProps().props)
  t.after(unmount)
  const card = host.querySelector('[data-task-id="T-1"]')
  assert.ok(card)
  assert.match(card.textContent ?? '', /2 Running/)
  assert.equal(card.querySelector('.helmx-status-light')?.getAttribute('data-tone'), 'working')
  assert.doesNotMatch(card.textContent ?? '', /Turn settled/)
  assert.ok(!card.classList.contains('is-attention'), '后台在途不算需处理')
  unmount()
})

test('看板外依赖：Ready 不被伪造阻塞并明示看板外计数', { timeout: 60_000 }, async (t) => {
  setStubState({
    conversations: [],
    board: {
      tasks: [
        task('T-1', { column: 'done', createdAt: 100 }),
        task('T-5', { dependsOn: ['T-1', 'T-99'], createdAt: 500 }),
      ],
      updatedAt: 1,
    },
  })
  const { host, unmount } = await mountBoard(makeSpyCtx(), mutableScreenProps().props)
  t.after(unmount)
  const t5 = host.querySelector('[data-task-id="T-5"]')
  assert.ok(t5)
  assert.match(t5.textContent ?? '', /Ready/)
  assert.match(t5.textContent ?? '', /1 off-board dependency/)
  assert.ok([...(t5.querySelectorAll('button') ?? [])].some((b) => b.textContent?.includes('Start')), '看板外依赖不阻断开工入口')
  unmount()
})

test('停滞任务显式继续：按钮触发 submitInput 到执行会话（人工显式，非自动轻推）', { timeout: 60_000 }, async (t) => {
  const submitCalls: Array<{ text: string; conversationId?: number }> = []
  const ctx = makeSpyCtx({
    submitInput: async (text, options) => {
      submitCalls.push({ text, conversationId: options?.conversationId })
    },
  })
  setStubState({
    conversations: [conv(10, 'T-1 exec', { status: 'idle' })],
    board: {
      tasks: [task('T-1', { column: 'in_progress', conversationId: 10, silenceState: { nudgedAt: 1, stalledAt: 2 }, createdAt: 100 })],
      updatedAt: 1,
    },
  })
  const { host, unmount } = await mountBoard(ctx, mutableScreenProps().props)
  t.after(unmount)
  const card = host.querySelector('[data-task-id="T-1"]')
  assert.ok(card)
  assert.match(card.textContent ?? '', /Turn settled, not submitted yet/)
  const continueBtn = [...(card.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Continue'))
  assert.ok(continueBtn, '停滞卡应直出「继续」按钮')
  await click(continueBtn ?? null)
  assert.equal(submitCalls.length, 1)
  assert.equal(submitCalls[0]?.conversationId, 10)
  assert.match(submitCalls[0]?.text ?? '', /task_submit/)
  unmount()
})

test('mergePending 互斥：待验收卡禁用通过/合并/返工并说明原因', { timeout: 60_000 }, async (t) => {
  setStubState({
    conversations: [conv(30, 'T-3 exec')],
    board: {
      tasks: [
        task('T-3', {
          column: 'in_review',
          conversationId: 30,
          mergePending: true,
          submission: { summary: 'merging', branch: 'feat/x', submittedAt: 1 },
          createdAt: 300,
        }),
      ],
      updatedAt: 1,
    },
  })
  const ctx = makeSpyCtx()
  const { host, unmount } = await mountBoard(ctx, mutableScreenProps().props)
  t.after(unmount)
  const t3 = host.querySelector('[data-task-id="T-3"]')
  assert.ok(t3)
  assert.match(t3.textContent ?? '', /Merge in progress/)
  for (const label of ['Approve', 'Merge & close', 'Rework']) {
    const btn: HTMLButtonElement | undefined = [...t3.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes(label),
    )
    assert.ok(btn, `${label} 按钮应存在`)
    assert.equal(btn.disabled, true, `${label} 在合并收尾中应禁用`)
    assert.match(btn.title, /Merge finishing in progress/)
  }
  assert.equal(ctx.actionCalls.length, 0)
  unmount()
})

test('历史深链看板外任务：显式提示 + inspect 加载完整记录', { timeout: 60_000 }, async (t) => {
  const ctx = makeSpyCtx({
    callAction: async (actionId, input) => {
      assert.equal(actionId, 'inspect')
      assert.deepEqual(input, { taskId: 'T-77' })
      return {
        task: {
          id: 'T-77',
          title: 'Archived work',
          brief: 'old brief',
          column: 'done',
          assigneeProfileId: 'assistant',
          dependsOn: [],
          reworkCount: 1,
          createdAt: 1,
          updatedAt: 2,
          submission: { summary: 'shipped long ago', branch: 'feat/old', submittedAt: 3 },
        },
      }
    },
  })
  setStubState({ conversations: [], board: { tasks: [], updatedAt: 1 } })
  const { host, unmount } = await mountBoard(ctx, mutableScreenProps({ task: 'T-77' }).props)
  t.after(unmount)
  assert.match(host.textContent ?? '', /T-77 is not on the current board/, '深链到看板外任务必须显式提示，不得静默空白')
  const inspectBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-off-board-task="T-77"] button')].find((b) =>
    b.textContent?.includes('inspect'),
  )
  assert.ok(inspectBtn)
  await click(inspectBtn ?? null)
  assert.match(host.textContent ?? '', /Archived work/)
  assert.match(host.textContent ?? '', /shipped long ago/)
  assert.match(host.textContent ?? '', /feat\/old/)
  unmount()
})

// ---------------------------------------------------------------------------
// 7.6 Second review round: reworked cards / drawer distinction / empty-state CTAs
// ---------------------------------------------------------------------------

test('被打回卡：隐藏旧交卷、呈现返工修订上下文并可从当前修订继续', { timeout: 60_000 }, async (t) => {
  const submitCalls: Array<{ text: string; conversationId?: number }> = []
  const ctx = makeSpyCtx({
    submitInput: async (text, options) => {
      submitCalls.push({ text, conversationId: options?.conversationId })
    },
  })
  setStubState({
    conversations: [conv(60, 'reworked exec', { status: 'idle' })],
    board: {
      tasks: [
        task('T-8', {
          column: 'in_progress',
          conversationId: 60,
          reworkCount: 1,
          lastReworkFeedback: 'fix the flaky login test',
          submission: { summary: 'stale old submission', branch: 'feat/old', submittedAt: 1 },
          createdAt: 800,
        }),
      ],
      updatedAt: 1,
    },
  })
  const { props } = mutableScreenProps({}, { inlineDrawer: true })
  const { host, unmount, reRender } = await mountBoard(ctx, props)
  t.after(unmount)
  const card = host.querySelector('[data-task-id="T-8"]')
  assert.ok(card)
  assert.doesNotMatch(card.textContent ?? '', /stale old submission/, '被打回回进行中的卡不得展示旧交卷')
  assert.match(card.textContent ?? '', /Rework: fix the flaky login test/, '应呈现当前返工修订上下文')
  const continueBtn = [...(card.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Continue'))
  assert.ok(continueBtn, '返工停滞卡应可从当前修订继续')
  await click(continueBtn ?? null)
  assert.equal(submitCalls.length, 1)
  assert.equal(submitCalls[0]?.conversationId, 60)
  assert.match(submitCalls[0]?.text ?? '', /task_submit/)

  // 详情抽屉同样隐藏被返工取代的旧交卷，但保留返工意见专区
  const detailBtn = [...(card.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('aria-label') === 'View task details')
  await click(detailBtn ?? null)
  await reRender()
  const drawer = host.querySelector('.primary-drawer-content')
  assert.ok(drawer)
  assert.doesNotMatch(drawer.textContent ?? '', /stale old submission/)
  assert.match(drawer.textContent ?? '', /fix the flaky login test/)
  unmount()
})

test('抽屉区分：卡角「会话」按钮开执行会话抽屉，「详情」按钮开任务详情抽屉', { timeout: 60_000 }, async (t) => {
  setStubState({
    conversations: [conv(10, 'T-1 exec', { status: 'working', doing: 'bash: pnpm test' })],
    board: {
      tasks: [task('T-1', { column: 'in_progress', conversationId: 10, createdAt: 100 })],
      updatedAt: 1,
    },
  })
  const ctx = makeSpyCtx()
  const { props } = mutableScreenProps({}, { inlineDrawer: true })
  const { host, unmount, reRender } = await mountBoard(ctx, props)
  t.after(unmount)
  const card = host.querySelector('[data-task-id="T-1"]')
  assert.ok(card)

  // 底部显式「会话」按钮 → 执行会话抽屉（openConversationDrawer），标题明示非任务详情
  const convBtn = [...(card.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Conversation'))
  assert.ok(convBtn, '进行中卡底部应直出「会话」按钮')
  assert.match(convBtn.title, /not the task details/)
  await click(convBtn ?? null)
  assert.deepEqual(ctx.drawerCalls, [10])

  // 「详情」按钮 → 任务详情抽屉（setParams 深链），与执行会话抽屉不同入口
  const detailBtn = [...(card.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('aria-label') === 'View task details')
  assert.match(detailBtn?.title ?? '', /brief, deps, submission/)
  await click(detailBtn ?? null)
  assert.equal(props.params['task'], 'T-1')
  await reRender()
  assert.ok(host.querySelector('.primary-drawer-content'), '任务详情抽屉应渲染')
  unmount()
})

test('空看板 CTA：无任务时仍可一键发起规划对话或新建待办', { timeout: 60_000 }, async (t) => {
  setStubState({ conversations: [], board: { tasks: [], updatedAt: 1 } })
  const ctx = makeSpyCtx()
  const { host, unmount } = await mountBoard(ctx, mutableScreenProps().props)
  t.after(unmount)
  const empty = host.querySelector('.task-board-empty')
  assert.ok(empty)
  const planBtn = [...empty.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Plan a task'))
  assert.ok(planBtn, '空态应提供「聊一个新任务」')
  await click(planBtn ?? null)
  assert.deepEqual(ctx.screenCalls, ['agent:planner'])
  const newBtn = [...empty.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('New task'))
  assert.ok(newBtn, '空态应提供「新建待办」')
  await click(newBtn ?? null)
  assert.ok(document.querySelector('.task-modal'), '新建弹窗应从空态打开')
  unmount()
})

// ---------------------------------------------------------------------------
// 8. Actual-output rules (DOM assertions, not source regex scans)
// ---------------------------------------------------------------------------

test('实际输出铁律：渲染 DOM 无原生 select/无 Emoji、导出仅 PascalCase 组件', { timeout: 60_000 }, async (t) => {
  // 断言实际渲染产物而非源码 regex 扫描（AGENTS §5 三禁）：
  // - 真实挂载的看板 DOM 不得出现原生 <select>（筛选一律 SDK Select）；
  // - 渲染文本不得含 Emoji；
  // - 导航仅经 setParams / ctx.open* 宿主动作（行为测试已锁定）；
  // - 编译模块导出仅为 PascalCase 组件函数（Fast Refresh 契约）。
  setStubState({ conversations: standardConversations(), board: standardBoard() })
  const { host, unmount } = await mountBoard(makeSpyCtx(), mutableScreenProps().props)
  t.after(unmount)
  assert.ok(host.querySelectorAll('.task-card').length > 0, '看板应有任务卡渲染')
  assert.ok(host.querySelectorAll('select').length === 0, '渲染 DOM 不得出现原生 select')
  assert.equal(EMOJI_RE.test(host.textContent ?? ''), false, '渲染文本不得含 Emoji')
  unmount()

  for (const [name, value] of Object.entries(rawModule)) {
    if (name === 'default' || name.startsWith('__')) continue
    assert.ok(/^[A-Z][A-Za-z0-9]*$/.test(name), `客户端应仅导出 PascalCase 组件，发现：${name}`)
    assert.equal(typeof value, 'function', `导出 ${name} 应为组件函数`)
  }
})
