import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ArtifactMetadata, ConversationSummary, PluginSummary, PluginUiContribution } from '@helm/protocol'
import { buildTimelineItems, findLatestProcessTurnKey, type TimelineItem } from '../src/conversation/timeline-model.js'
import {
  artifactFormatLabel,
  artifactKindLabel,
  buildWorkbenchFooter,
  buildWorkbenchTabs,
  countDeliverableArtifacts,
  partitionArtifactsByKind,
} from '../src/conversation/workbench-model.js'
import { createWebTranslator } from '../src/i18n/catalog.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { seedPluginClientModule, resetPluginClientCache } from '../src/lib/plugin-client.js'
import { resetSessionDocSubscriptions } from '../src/lib/session-docs.js'
import { makeTestStore } from './helpers/store.js'

try {
  GlobalRegistrator.register()
} catch {
  // 已注册
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { createRoot } = await import('react-dom/client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
const { ConversationPane } = await import('../src/conversation/ConversationPane.js')
const { WorkbenchDrawer } = await import('../src/conversation/WorkbenchDrawer.js')

const e = React.createElement
const origFetch = globalThis.fetch
const origCreateObjectUrl = URL.createObjectURL
const origRevokeObjectUrl = URL.revokeObjectURL

const roots: Array<{ root: Root; host: HTMLElement }> = []

afterEach(async () => {
  while (roots.length > 0) {
    const item = roots.pop()!
    await act(async () => {
      item.root.unmount()
    })
    item.host.remove()
  }
  document.body.innerHTML = ''
  globalThis.fetch = origFetch
  URL.createObjectURL = origCreateObjectUrl
  URL.revokeObjectURL = origRevokeObjectUrl
  resetSessionDocSubscriptions()
  resetPluginClientCache()
})

function mountNode() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push({ root, host })
  return {
    host,
    render: async (store: HelmStoreValue, node: React.ReactNode) => {
      await act(async () => {
        root.render(e(HostStoreProviders, { value: store }, node))
      })
    },
  }
}

function makeConversation(
  id: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title: `测试会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    nodeId: 'local',
    cwd: '/root/code/helm',
    model: 'faux/model',
    thinkingLevel: 'medium',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    ...overrides,
  }
}

function makeArtifact(
  id: string,
  kind: ArtifactMetadata['kind'],
  name: string,
  mimeType = 'text/plain',
  size = 128,
): ArtifactMetadata {
  return {
    id,
    conversationId: 1,
    kind,
    name,
    path: `artifacts/1/${name}`,
    mimeType,
    size,
    createdAt: 1_700_000_000_000,
  }
}

function makeTimelineWithProcessTurns(prefix: string): TimelineItem[] {
  return [
    {
      kind: 'assistant',
      key: `${prefix}:turn:1`,
      entryIds: [`${prefix}:1`],
      live: false,
      segments: [
        {
          kind: 'step-group',
          key: `${prefix}:steps:1`,
          stepCount: 2,
          steps: [
            { kind: 'thinking', thinking: { key: `${prefix}:think:1`, text: `${prefix}-早期思考内容` } },
            {
              kind: 'tool',
              tool: {
                key: `${prefix}:tool:1`,
                callId: `${prefix}:call-1`,
                toolName: 'read_file',
                input: { path: 'README.md' },
                status: 'done',
                isError: false,
                resultText: 'README',
              },
            },
          ],
        },
        { kind: 'text', key: `${prefix}:txt:1`, text: `${prefix} 第一轮答复` },
      ],
    },
    {
      kind: 'assistant',
      key: `${prefix}:turn:2`,
      entryIds: [`${prefix}:2`],
      live: false,
      segments: [
        {
          kind: 'step-group',
          key: `${prefix}:steps:2`,
          stepCount: 2,
          steps: [
            { kind: 'thinking', thinking: { key: `${prefix}:think:2`, text: `${prefix}-最新思考推理详情` } },
            {
              kind: 'tool',
              tool: {
                key: `${prefix}:tool:2`,
                callId: `${prefix}:call-2`,
                toolName: 'bash',
                input: { command: 'pnpm test' },
                status: 'done',
                isError: false,
                resultText: 'pass',
              },
            },
          ],
        },
        { kind: 'text', key: `${prefix}:txt:2`, text: `${prefix} 最新一轮答复` },
      ],
    },
    {
      kind: 'assistant',
      key: `${prefix}:turn:3-plain`,
      entryIds: [`${prefix}:3`],
      live: false,
      segments: [{ kind: 'text', key: `${prefix}:txt:3`, text: `${prefix} 纯文本无过程步骤答复` }],
    },
  ]
}

test('timeline-model findLatestProcessTurnKey 选中最新一条含过程步骤的助手回合', { timeout: 60_000 }, () => {
  const items = makeTimelineWithProcessTurns('model')
  assert.equal(findLatestProcessTurnKey(items), 'model:turn:2')
  assert.equal(findLatestProcessTurnKey([items[2]!]), undefined)
  assert.equal(findLatestProcessTurnKey([]), undefined)
})

test('ConversationTimeline Ctrl+O 仅作用于目标面板最新含过程回合且与手动点击不冲突', { timeout: 60_000 }, async () => {
  const convPrimary = makeConversation(1)
  const convSplit = makeConversation(2)
  const convDrawer = makeConversation(3)
  const primaryItems = makeTimelineWithProcessTurns('primary')
  const splitItems = makeTimelineWithProcessTurns('split')
  const drawerItems: TimelineItem[] = [
    {
      kind: 'assistant',
      key: 'drawer:turn:only-think',
      entryIds: ['drawer:1'],
      live: false,
      segments: [
        {
          kind: 'step-group',
          key: 'drawer:steps:1',
          stepCount: 1,
          steps: [{ kind: 'thinking', thinking: { key: 'drawer:think:1', text: '抽屉内单条思考' } }],
        },
      ],
    },
  ]

  const store = makeTestStore({
    conversations: [convPrimary, convSplit, convDrawer],
    conversationDetails: {
      1: { ...convPrimary, entries: [] },
      2: { ...convSplit, entries: [] },
      3: { ...convDrawer, entries: [] },
    },
  })

  const ui = mountNode()
  await ui.render(
    store,
    e(
      'div',
      null,
      e(
        'div',
        { 'data-helm-panel': 'primary', id: 'panel-primary' },
        e(ConversationTimeline, {
          conversation: convPrimary,
          detailEntries: [],
          timelineItems: primaryItems,
          onRequestEdit: () => {},
        }),
        e(
          'div',
          { className: 'conversation-drawer', id: 'panel-drawer' },
          e(ConversationTimeline, {
            conversation: convDrawer,
            detailEntries: [],
            timelineItems: drawerItems,
            onRequestEdit: () => {},
          }),
        ),
      ),
      e(
        'div',
        { 'data-helm-panel': 'split', id: 'panel-split' },
        e(ConversationTimeline, {
          conversation: convSplit,
          detailEntries: [],
          timelineItems: splitItems,
          onRequestEdit: () => {},
        }),
      ),
    ),
  )

  const primaryRoot = ui.host.querySelector('#panel-primary > .timeline-container')!
  const drawerRoot = ui.host.querySelector('#panel-drawer > .timeline-container')!
  const splitRoot = ui.host.querySelector('#panel-split > .timeline-container')!
  const primaryToggles = [...primaryRoot.querySelectorAll<HTMLButtonElement>('[data-process-toggle="root"]')]
  assert.equal(primaryToggles.length, 2)
  const primaryTurn1Toggle = primaryToggles[0]!
  const primaryTurn2Toggle = primaryRoot.querySelector('[data-latest-process-turn="true"] [data-process-toggle="root"]') as HTMLButtonElement
  const splitTurn2Toggle = splitRoot.querySelector('[data-latest-process-turn="true"] [data-process-toggle="root"]') as HTMLButtonElement
  const drawerToggle = drawerRoot.querySelector('[data-latest-process-turn="true"] [data-process-toggle="root"]') as HTMLButtonElement

  assert.equal(primaryTurn1Toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(primaryTurn2Toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(splitTurn2Toggle.getAttribute('aria-expanded'), 'false')
  assert.equal(drawerToggle.getAttribute('aria-expanded'), 'false')

  // 按 Ctrl+O（primary 面板）：仅展开 primary 最新含过程回合（含思考详情）
  await act(async () => {
    window.dispatchEvent(new CustomEvent('helm:shortcut', { detail: { action: 'toggle-process-groups', panel: 'primary' } }))
  })
  assert.equal(primaryTurn2Toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(primaryTurn1Toggle.getAttribute('aria-expanded'), 'false', '较早回合应保持折叠')
  assert.equal(splitTurn2Toggle.getAttribute('aria-expanded'), 'false', '分屏面板不应被误触')
  assert.equal(drawerToggle.getAttribute('aria-expanded'), 'false', '子会话抽屉不应响应 Ctrl+O')
  assert.match(primaryRoot.textContent ?? '', /primary-最新思考推理详情/)

  // 再次按 Ctrl+O（primary 面板）：折叠最新含过程回合
  await act(async () => {
    window.dispatchEvent(new CustomEvent('helm:shortcut', { detail: { action: 'toggle-process-groups', panel: 'primary' } }))
  })
  assert.equal(primaryTurn2Toggle.getAttribute('aria-expanded'), 'false')

  // 手动点击展开后，再按 Ctrl+O 应基于真实 DOM 展开态直接收起（不与手动状态打架）
  await act(async () => {
    primaryTurn2Toggle.click()
  })
  assert.equal(primaryTurn2Toggle.getAttribute('aria-expanded'), 'true')
  await act(async () => {
    window.dispatchEvent(new CustomEvent('helm:shortcut', { detail: { action: 'toggle-process-groups', panel: 'primary' } }))
  })
  assert.equal(primaryTurn2Toggle.getAttribute('aria-expanded'), 'false')

  // 手动点击折叠后，再按 Ctrl+O 应直接展开
  await act(async () => {
    primaryTurn2Toggle.click()
  })
  assert.equal(primaryTurn2Toggle.getAttribute('aria-expanded'), 'true')
  await act(async () => {
    primaryTurn2Toggle.click()
  })
  assert.equal(primaryTurn2Toggle.getAttribute('aria-expanded'), 'false')
  await act(async () => {
    window.dispatchEvent(new CustomEvent('helm:shortcut', { detail: { action: 'toggle-process-groups', panel: 'primary' } }))
  })
  assert.equal(primaryTurn2Toggle.getAttribute('aria-expanded'), 'true')

  // 单独对 split 面板发 Ctrl+O：只展开 split 面板
  await act(async () => {
    window.dispatchEvent(new CustomEvent('helm:shortcut', { detail: { action: 'toggle-process-groups', panel: 'split' } }))
  })
  assert.equal(splitTurn2Toggle.getAttribute('aria-expanded'), 'true')
})

test('ConversationPane 顶栏类名、分屏隐藏容器、标题 Popover 与抽屉环境条及按钮顺序正确', { timeout: 60_000 }, async () => {
  const conv = makeConversation(42, {
    title: '端到端联调主会话',
    profileId: 'coder',
    nodeId: 'gpu-box-1',
    cwd: '/srv/app/repo',
    ownedBy: 'helm',
  })
  const baseStore = makeTestStore({
    conversations: [conv],
    conversationDetails: { 42: { ...conv, entries: [] } },
    conversationArtifacts: {
      42: [makeArtifact('spill-only', 'spill', 'tool-out.txt')],
    },
  })

  const ui = mountNode()
  // 1) 主屏无分屏态：有 .pane-action-label、.pane-split-btn、标题点击打开详情 Popover，工作台在仅有 spill 时仍可点击
  await ui.render(baseStore, e(ConversationPane, { conversationId: 42 }))

  const workbenchBtn = ui.host.querySelector('button[aria-label="Workbench"]') as HTMLButtonElement | null
  assert.ok(workbenchBtn)
  assert.ok(workbenchBtn.querySelector('.pane-action-label'), '工作台文字须包裹 .pane-action-label')
  assert.equal(workbenchBtn.querySelector('.pane-action-label')?.textContent, 'Workbench')

  const splitWrapper = ui.host.querySelector('.pane-split-btn')
  assert.ok(splitWrapper, '非分屏态应由 .pane-split-btn 包裹分屏触发按钮')
  assert.ok(splitWrapper.querySelector('button[aria-label*="split"]'))

  const titleBtn = ui.host.querySelector('.pane-title-btn') as HTMLButtonElement | null
  assert.ok(titleBtn, '顶栏标题应可点击展开元信息 Popover')
  await act(async () => {
    titleBtn.click()
  })
  const popover = document.body.querySelector('.pane-title-popover')
  assert.ok(popover, '点击标题后应渲染 .pane-title-popover')
  assert.match(popover.textContent ?? '', /#42/)
  assert.match(popover.textContent ?? '', /gpu-box-1/)
  assert.match(popover.textContent ?? '', /\/srv\/app\/repo/)
  assert.match(popover.textContent ?? '', /helm/)

  // 2) 分屏激活态：分屏关闭按钮不被 .pane-split-btn 隐藏
  await ui.render(
    { ...baseStore, splitTarget: { kind: 'conversation', conversationId: 99 } },
    e(ConversationPane, { conversationId: 42 }),
  )
  assert.ok(ui.host.querySelector('.pane-split-btn') === null, '已激活分屏时关闭分屏按钮不受 .pane-split-btn 隐藏')

  // 3) 抽屉模式：展示环境条，且 [×] 关闭按钮严格位于 .pane-actions 最右侧（在全屏和更多菜单之后）
  await ui.render(
    baseStore,
    e(ConversationPane, { conversationId: 42, isDrawer: true, onCloseDrawer: () => {} }),
  )
  const envBar = ui.host.querySelector('.pane-drawer-env-bar')
  assert.ok(envBar, '抽屉态必须渲染精简环境上下文条')
  assert.match(envBar.textContent ?? '', /#42/)
  assert.match(envBar.textContent ?? '', /coder/)
  assert.match(envBar.textContent ?? '', /gpu-box-1:\/srv\/app\/repo/)
  assert.match(envBar.textContent ?? '', /Owner helm/)

  const actionsContainer = ui.host.querySelector('.pane-actions')
  assert.ok(actionsContainer)
  const children = [...actionsContainer.children]
  const fullscreenIdx = children.findIndex((el) => el.getAttribute('aria-label') === 'Open this conversation fullscreen')
  const moreIdx = children.findIndex((el) => el.classList.contains('pane-more-menu'))
  const closeIdx = children.findIndex((el) => el.classList.contains('conversation-drawer-close-btn'))
  assert.ok(fullscreenIdx >= 0 && moreIdx > fullscreenIdx && closeIdx === children.length - 1, '抽屉 [×] 必须严格固定在最右侧')
})

test('workbench-model 与 ArtifactsTab 严格分离正式产物与 spill、去重计数并支持预览下载与插件工作台', { timeout: 60_000 }, async () => {
  const registered = makeArtifact('art-reg', 'registered', 'summary-report.md', 'text/markdown', 2048)
  const uploaded = makeArtifact('art-up', 'upload', 'diagram.png', 'image/png', 4096)
  const spill1 = makeArtifact('art-spill-1', 'spill', 'bash-stdout-001.log', 'text/plain', 65_536)
  const spill2 = makeArtifact('art-spill-2', 'spill', 'bash-stdout-002.log', 'text/plain', 32_768)

  const partitioned = partitionArtifactsByKind([registered, uploaded, spill1, spill2])
  assert.equal(partitioned.deliverables.length, 2)
  assert.equal(partitioned.spills.length, 2)
  assert.equal(countDeliverableArtifacts([registered, uploaded, spill1, spill2]), 2)
  assert.equal(countDeliverableArtifacts([spill1, spill2]), 0)

  const tabs = buildWorkbenchTabs({
    groupedUi: groupUiContributions([]),
    pluginDocs: {},
    artifactCount: countDeliverableArtifacts([registered, uploaded, spill1]),
    conversationId: 1,
    locale: 'en',
  })
  assert.equal(tabs[0]?.label, 'Artifacts')
  assert.equal(tabs[0]?.count, 2)
  assert.deepEqual(buildWorkbenchFooter(tabs), [])

  // 面板 label 属 LocalizedText 显示元数据：按 locale 解析（纯字符串透传）
  const localizedPanels = [
    { pluginId: 'builtin:superagent', surface: 'workbench.panel' as const, spec: { id: 'runs', label: { en: 'Workflow runs', 'zh-CN': '工作流运行' } } },
    { pluginId: 'community:logger', surface: 'workbench.panel' as const, spec: { id: 'logs', label: 'Logger panels' } },
  ]
  assert.equal(
    buildWorkbenchTabs({ groupedUi: groupUiContributions(localizedPanels), pluginDocs: {}, artifactCount: 0, conversationId: undefined, locale: 'zh-CN' })
      .find((tab) => tab.id === 'plugin:builtin:superagent/runs')?.label,
    '工作流运行',
  )
  assert.equal(
    buildWorkbenchTabs({ groupedUi: groupUiContributions(localizedPanels), pluginDocs: {}, artifactCount: 0, conversationId: undefined, locale: 'en' })
      .find((tab) => tab.id === 'plugin:builtin:superagent/runs')?.label,
    'Workflow runs',
  )
  assert.equal(
    buildWorkbenchTabs({ groupedUi: groupUiContributions(localizedPanels), pluginDocs: {}, artifactCount: 0, conversationId: undefined, locale: 'zh-CN' })
      .find((tab) => tab.id === 'plugin:community:logger/logs')?.label,
    'Logger panels',
    '纯字符串 label 任意 locale 原样',
  )

  const fetchedUrls: string[] = []
  let failDownload = false
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    fetchedUrls.push(url)
    if (url.includes('/api/artifacts/') && !url.includes('inline=1') && failDownload) {
      return new Response('download err', { status: 500, statusText: 'Internal Server Error' })
    }
    if (url.includes('/api/artifacts/')) {
      return new Response(new Blob(['hello-artifact'], { type: 'text/plain' }), { status: 200 })
    }
    return new Response('', { status: 200, headers: { 'x-helm-client-hash': 'seeded' } })
  }) as typeof fetch

  URL.createObjectURL = (() => 'blob:mock-artifact-url') as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL

  const conv = makeConversation(1)
  const modals: unknown[] = []
  const notices: unknown[] = []
  const plugin: PluginSummary = {
    id: 'builtin:workflow',
    name: '工作流',
    version: '1',
    enabled: true,
    locked: false,
    hooks: [],
    actions: [],
    tools: [],
  }
  const wfPanel: PluginUiContribution = {
    pluginId: 'builtin:workflow',
    surface: 'workbench.panel',
    spec: {
      id: 'tasks',
      label: '任务图谱',
      order: 10,
      client: { module: 'index.tsx', export: 'TasksPanel' },
    },
  }
  // 验证无 JS bundle 插件页签可直接走内置 json 渲染且支持按 runId/插件页签打开
  const storeMixed = makeTestStore({
    conversations: [conv],
    plugins: [plugin],
    groupedUi: groupUiContributions([wfPanel]),
    workbenchOpen: true,
    workbenchTab: 'artifacts',
    conversationArtifacts: { 1: [registered, uploaded, spill1, spill2] },
    setActiveModal: (modal) => { modals.push(modal) },
    pushNotice: (notice) => { notices.push(notice) },
  })

  const ui = mountNode()
  await ui.render(storeMixed, e(WorkbenchDrawer, { conversationId: 1, inline: true }))

  // 页签标题绝不出现 `产物 (2) 2`
  const tabTexts = [...ui.host.querySelectorAll('.tab-btn')].map((el) => el.textContent?.trim())
  assert.ok(tabTexts.includes('Artifacts2'), `预期单次计数徽章，实际: ${JSON.stringify(tabTexts)}`)
  assert.ok(!tabTexts.some((t) => t?.includes('(2)')))
  assert.ok(!tabTexts.some((t) => /MEMORY/i.test(t ?? '')), '不添加 MEMORY.md 标签页')

  // 关闭按钮位于 .tabs-bar 末尾且不在可滚动 tabs 容器内部
  const tabsBar = ui.host.querySelector('.helm-workbench .tabs-bar')!
  const closeBtn = tabsBar.lastElementChild?.querySelector('.workbench-close-btn') ?? (
    tabsBar.lastElementChild?.classList.contains('workbench-close-btn') ? tabsBar.lastElementChild : null
  )
  assert.ok(closeBtn, '关闭按钮 [×] 应位于工作台 tabs-bar 最右侧')
  assert.ok(ui.host.querySelector('.workbench-tabs-scroll .workbench-close-btn') === null)

  // 正式产物区可见注册产物与上传附件，不含 spill 文件名
  const deliverablesSection = ui.host.querySelector('[aria-label="Registered artifacts"]')!
  assert.match(deliverablesSection.textContent ?? '', /summary-report\.md/)
  assert.match(deliverablesSection.textContent ?? '', /Registered artifact/)
  assert.match(deliverablesSection.textContent ?? '', /diagram\.png/)
  assert.match(deliverablesSection.textContent ?? '', /Uploaded attachment/)
  assert.doesNotMatch(deliverablesSection.textContent ?? '', /bash-stdout-001\.log/)

  // spill 区默认折叠且显示计数 2
  const spillToggle = ui.host.querySelector('.artifact-spill-toggle') as HTMLButtonElement
  assert.ok(spillToggle)
  assert.equal(spillToggle.getAttribute('aria-expanded'), 'false')
  assert.match(spillToggle.textContent ?? '', /Oversized tool output snapshot/)
  assert.match(spillToggle.textContent ?? '', /2/)
  assert.doesNotMatch(ui.host.textContent ?? '', /bash-stdout-001\.log/)

  // 展开 spill 区后可见完整条目并支持预览与下载
  await act(async () => {
    spillToggle.click()
  })
  assert.equal(spillToggle.getAttribute('aria-expanded'), 'true')
  const spillList = ui.host.querySelector('.artifact-spill-list')!
  assert.match(spillList.textContent ?? '', /bash-stdout-001\.log/)
  assert.match(spillList.textContent ?? '', /bash-stdout-002\.log/)

  const previewSpillBtn = spillList.querySelector('button[aria-label="Preview bash-stdout-001.log"]') as HTMLButtonElement
  await act(async () => {
    previewSpillBtn.click()
  })
  assert.deepEqual(modals[0], { kind: 'artifact-preview', artifactId: 'art-spill-1', conversationId: 1 })

  // 触发下载报错时推送错误通知而不崩溃，恢复正常后可触发下载请求
  failDownload = true
  const downloadRegBtn = ui.host.querySelector('button[aria-label="Download summary-report.md"]') as HTMLButtonElement
  await act(async () => {
    downloadRegBtn.click()
    await new Promise((r) => setTimeout(r, 20))
  })
  assert.equal(notices.length, 1)
  assert.ok(fetchedUrls.includes('/api/artifacts/art-up/content?inline=1'), '图片产物应懒加载缩略图')
  assert.ok(fetchedUrls.includes('/api/artifacts/art-reg/content'))

  failDownload = false
  await act(async () => {
    downloadRegBtn.click()
    await new Promise((r) => setTimeout(r, 20))
  })
  assert.equal(notices.length, 1, '下载成功不应新增错误通知')

  // 仅存在 spill（无正式产物）的另一会话（id=2）时：页签不展示虚假交付计数徽章，
  // 交付区提示空态，且切换会话后 spill 折叠态自动重置为默认折叠
  const conv2 = makeConversation(2)
  const spillOnlyStore = makeTestStore({
    conversations: [conv, conv2],
    workbenchOpen: true,
    workbenchTab: 'artifacts',
    conversationArtifacts: { 1: [registered, uploaded, spill1, spill2], 2: [spill1] },
  })
  await ui.render(spillOnlyStore, e(WorkbenchDrawer, { conversationId: 2, inline: true }))
  const spillOnlyTabBtn = ui.host.querySelector('.tab-btn')!
  assert.equal(spillOnlyTabBtn.textContent?.trim(), 'Artifacts')
  assert.match(ui.host.textContent ?? '', /No registered artifacts or uploaded attachments yet/)
  assert.equal(ui.host.querySelector('.artifact-spill-toggle')?.getAttribute('aria-expanded'), 'false')

  // 验证指定插件工作台页签（workflow tasks 等）可正常渲染，且在非 artifacts 页签下“产物”页签计数仍唯一清晰
  const wfTabStore = { ...storeMixed, workbenchTab: 'plugin:builtin:workflow/tasks' }
  seedPluginClientModule('builtin:workflow', 'index.tsx', {
    TasksPanel: ({ conversation }: { conversation?: { id?: number } }) =>
      e('div', null, `工作流任务树面板 #${conversation?.id ?? 0}`),
  })
  await ui.render(wfTabStore, e(WorkbenchDrawer, { conversationId: 1, inline: true }))
  assert.match(ui.host.textContent ?? '', /工作流任务树面板 #1/)
  const inactiveArtifactsTab = [...ui.host.querySelectorAll('.tab-btn')].find((el) => el.textContent?.includes('Artifacts'))
  assert.equal(inactiveArtifactsTab?.textContent?.trim(), 'Artifacts2', '切换至其他页签时产物计数亦不可重复')

  // buildTimelineItems 保持向后导出完整性
  assert.deepEqual(buildTimelineItems([]), [])
})

test('WorkbenchDrawer and workbench-model support en and zh-CN localization', { timeout: 60_000 }, async () => {
  const zh = createWebTranslator('zh-CN')
  assert.equal(artifactKindLabel('registered', zh), '注册产物')
  assert.equal(artifactKindLabel('upload', zh), '上传附件')
  assert.equal(artifactKindLabel('spill', zh), '输出快照')
  assert.equal(artifactFormatLabel('image/png', 'diagram.png', zh), '图片')
  assert.equal(artifactFormatLabel('text/plain', 'notes.txt', zh), '文本')
  assert.equal(artifactFormatLabel('application/octet-stream', 'data', zh), '文件')

  const zhTabs = buildWorkbenchTabs({
    groupedUi: groupUiContributions([]),
    pluginDocs: {},
    artifactCount: 1,
    conversationId: 1,
    locale: 'zh-CN',
    t: zh,
  })
  assert.equal(zhTabs[0]?.label, '产物')

  const conv = makeConversation(1)
  const registered: ArtifactMetadata = {
    id: 'art-zh-reg',
    conversationId: 1,
    kind: 'registered',
    name: 'report.md',
    path: '/tmp/report.md',
    mimeType: 'text/markdown',
    size: 512,
    createdAt: 1_700_000_000_000,
  }
  const storeZh = makeTestStore({
    locale: 'zh-CN',
    conversations: [conv],
    workbenchOpen: true,
    workbenchTab: 'artifacts',
    conversationArtifacts: { 1: [registered] },
  })
  const ui = mountNode()
  await ui.render(storeZh, e(WorkbenchDrawer, { conversationId: 1, inline: true }))
  assert.ok(ui.host.querySelector('[aria-label="工作台抽屉"]') !== null)
  assert.ok(ui.host.querySelector('[aria-label="关闭工作台"]') !== null)
  assert.ok(ui.host.querySelector('[aria-label="正式产物"]') !== null)
  assert.match(ui.host.textContent ?? '', /产物1/)
  assert.match(ui.host.textContent ?? '', /注册产物/)
  assert.match(ui.host.textContent ?? '', /预览/)
  assert.match(ui.host.textContent ?? '', /下载/)

  await ui.render({ ...storeZh, locale: 'en' }, e(WorkbenchDrawer, { conversationId: 1, inline: true }))
  assert.ok(ui.host.querySelector('[aria-label="Workbench drawer"]') !== null)
  assert.ok(ui.host.querySelector('[aria-label="Close workbench"]') !== null)
  assert.match(ui.host.textContent ?? '', /Artifacts1/)
  assert.match(ui.host.textContent ?? '', /Registered artifact/)
})

test('ConversationPane 加载失败分屏分支：错误 + 重试 + 关闭分屏入口共存', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    loadErrors: { 'conversation:42': '500 内部错误' },
  })
  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ConversationPane, { conversationId: 42, isSplit: true, onCloseSplit: () => {} })),
  )
  assert.ok(html.includes('failed to load'), '分屏加载失败应显示错误')
  assert.ok(html.includes('500 内部错误'))
  assert.ok(html.includes('Retry'))
  assert.ok(html.includes('split-close-btn'), '加载失败分屏分支必须有显式关闭入口')
  assert.ok(html.includes('Close split view'))
})

test('ConversationPane 加载中分屏分支：仍有显式关闭分屏入口', { timeout: 60_000 }, () => {
  const store = makeTestStore({})
  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ConversationPane, { conversationId: 42, isSplit: true, onCloseSplit: () => {} })),
  )
  assert.ok(html.includes('Loading conversation'), '应显示加载中态')
  assert.ok(html.includes('split-close-btn'), '加载中分屏分支必须有显式关闭入口')
})

test('ConversationPane 非分屏分支：早退不渲染分屏关闭按钮', { timeout: 60_000 }, () => {
  const store = makeTestStore({})
  const html = renderToString(
    e(HostStoreProviders, { value: store }, e(ConversationPane, { conversationId: 42 })),
  )
  assert.ok(!html.includes('split-close-btn'))
})

test('动态工作台按 scope/order/public-doc badge 渲染，首帧前保留深链、确认不可用后回退首个页签', { timeout: 60_000 }, async () => {
  const requested = 'plugin:sample/queue'
  const selections: string[] = []
  const docs: Array<[string, string]> = []
  const panels: PluginUiContribution[] = [
    { pluginId: 'sample', surface: 'workbench.panel', spec: { id: 'late', label: '后置面板', order: 30, json: { root: 'text', elements: { text: { type: 'Text', props: { text: '后置内容' } } } } } },
    { pluginId: 'sample', surface: 'workbench.panel', spec: { id: 'hidden', label: '其他档案', order: 0, scope: { profileIds: ['other'] }, badge: { doc: 'hidden', countField: 'count' }, json: {} } },
    { pluginId: 'sample', surface: 'workbench.panel', spec: { id: 'queue', label: '动态队列', order: 10, badge: { doc: 'stats', byConversationField: 'byConversation' }, json: { root: 'text', elements: { text: { type: 'Text', props: { text: '队列内容' } } } } } },
  ]
  let store = makeTestStore({
    sseConnected: false,
    workbenchTab: requested,
    setWorkbenchTab: (tab) => { selections.push(tab) },
    ensurePluginDoc: async (id, doc) => { docs.push([id, doc]); return undefined },
  })
  const ui = mountNode()
  await ui.render(store, e(WorkbenchDrawer, { conversationId: 1, inline: true }))
  assert.deepEqual(selections, [], '初始快照前不能覆盖请求的合法深链')
  const conv = makeConversation(1, { profileId: 'coder' })
  store = {
    ...store,
    sseConnected: true,
    conversations: [conv],
    groupedUi: groupUiContributions(panels),
    pluginDocs: {
      'sample/stats': { byConversation: { '1': { count: 3, tone: 'warn', footerText: '3 项待处理' } } },
      'sample/hidden': { count: 100 },
    },
  }
  await ui.render(store, e(WorkbenchDrawer, { conversationId: 1, inline: true }))
  assert.deepEqual(selections, [], '快照到达后有效深链仍然有效')
  const labels = [...ui.host.querySelectorAll('.tab-btn')].map((button) => button.textContent)
  assert.deepEqual(labels, ['动态队列3', 'Artifacts', '后置面板'])
  assert.match(ui.host.textContent!, /3 项待处理/)
  assert.doesNotMatch(ui.host.textContent!, /其他档案/)
  assert.ok(!docs.some(([, doc]) => doc === 'hidden'), '不可见面板不应加载角标文档')

  await ui.render(store, e(ConversationPane, { conversationId: 1 }))
  const workbench = [...ui.host.querySelectorAll('button')].find((button) => button.textContent?.includes('Workbench'))
  assert.ok(workbench !== undefined)
  assert.match(workbench.textContent!, /3/)
  assert.doesNotMatch(workbench.textContent!, /103/, '顶栏必须与抽屉使用同一 scope')

  store = { ...store, workbenchTab: 'plugin:sample/removed' }
  await ui.render(store, e(WorkbenchDrawer, { conversationId: 1, inline: true }))
  assert.deepEqual(selections, [requested], '不可用页签应回退排序后的首个可用页签，而非硬编码 artifacts')
  assert.match(ui.host.querySelector('.tab-btn-active')?.textContent ?? '', /动态队列/)
  store = { ...store, groupedUi: groupUiContributions([]) }
  await ui.render(store, e(WorkbenchDrawer, { conversationId: 1, inline: true }))
  assert.deepEqual(selections, [requested, 'artifacts'])
  assert.doesNotMatch(ui.host.textContent!, /动态队列|3 项待处理/)
})
