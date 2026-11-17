import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import {
  PluginClientContext,
  useConversation,
  usePluginContext,
  type LocalizedText,
} from '@helm/plugin-client'
import type { ConversationLive, ConversationSummary, HelmSnapshot } from '@helm/protocol/browser'
import { HelmStoreProvider } from '../src/lib/HelmStoreProvider.js'
import { HelmExternalStore } from '../src/lib/helm-store.js'
import { StoreRequestManager } from '../src/lib/request-manager.js'
import {
  useCatalogAssets,
  useConversationArtifacts,
  useConversationDetail,
  useConversationLive,
  useConversationSummary,
  useLocationTargets,
  useModels,
} from '../src/lib/store-context.js'
import { useWebLocale } from '../src/i18n/use-web-locale.js'
import { applySnapshot, applyTransientLiveFrame, emptyLiveState } from '../src/lib/live-state.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import { resetPluginClientCache } from '../src/lib/plugin-client.js'
import { ConversationPane } from '../src/conversation/ConversationPane.js'
import { ConversationTimeline } from '../src/conversation/ConversationTimeline.js'
import { CommandPaletteModal } from '../src/modals/CommandPaletteModal.js'
import { ModelCenter } from '../src/models/ModelCenter.js'
import { NodeCenter } from '../src/nodes/NodeCenter.js'
import { PluginCenter } from '../src/plugins/PluginCenter.js'
import { ProfileCenter } from '../src/profiles/ProfileCenter.js'
import { Sidebar } from '../src/shell/Sidebar.js'
import { SkillCenter } from '../src/skills/SkillCenter.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const encoder = new TextEncoder()

interface ControlledSse {
  stream: ReadableStream<Uint8Array>
  send: (text: string) => void
  end: () => void
}

function createControlledSse(signal?: AbortSignal | null): ControlledSse {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    signal?.removeEventListener('abort', finish)
    try {
      controller?.close()
    } catch {
      /* idempotent */
    }
  }
  signal?.addEventListener('abort', finish, { once: true })
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      if (signal?.aborted) finish()
    },
    cancel() {
      finish()
    },
  })
  return {
    stream,
    send: (text: string) => {
      if (!ended) controller?.enqueue(encoder.encode(text))
    },
    end: finish,
  }
}

const makeConv = (id: number, title: string, status: ConversationSummary['status'] = 'idle'): ConversationSummary => ({
  id,
  title,
  profileId: 'assistant',
  tags: [],
  cwd: '/tmp/ws',
  model: 'anthropic/claude-sonnet-4-5',
  thinkingLevel: 'off',
  status,
  stateChangeSeq: 1,
  completionSeq: 0,
  unread: false,
  pinned: false,
  pendingAskCount: 0,
  createdAt: 100,
  updatedAt: 100 + id,
})

const makeSnapshot = (): HelmSnapshot => ({
  bootId: 'boot-rerender-test',
  seq: 1,
  conversations: [
    makeConv(1, 'Streaming Conv', 'working'),
    makeConv(2, 'Inactive Split Conv', 'idle'),
  ],
  conversationLives: [],
  pendingAsks: [],
  plugins: [
    {
      id: 'builtin:profile',
      name: 'Profile',
      locked: true,
      enabled: true,
      hooks: [],
      actions: [],
      tools: [],
    },
    {
      id: 'test:plugin',
      name: 'Test Plugin',
      locked: false,
      enabled: true,
      hooks: [],
      actions: [],
      tools: [],
    },
  ],
  ui: [],
  pluginDocs: [],
  nodes: [
    {
      id: 'local',
      kind: 'local',
      online: true,
      hostname: 'local',
      connectedAt: 100,
      lastSeenAt: 100,
    },
  ],
})

const snapshotSse = (payload: object): string => `event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`
const liveSse = (live: ConversationLive): string => `event: conversation.live\ndata: ${JSON.stringify({ live })}\n\n`

const mountedCleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (mountedCleanups.length > 0) {
    const fn = mountedCleanups.pop()
    await fn?.()
  }
})

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timeout: ${label}`)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
    })
  }
}

test('conversation.live 流式增量只重渲染订阅对应会话的子树，不级联重渲染静态面板、Sidebar 与其他分屏会话', { timeout: 60_000 }, async () => {
  window.history.replaceState(null, '', '#/c/1')
  const originalFetch = globalThis.fetch
  let sseStream: ControlledSse | undefined
  let resolvedEventsCount = 0

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === '/api/events' || url.startsWith('/api/events?')) {
      const s = createControlledSse(init?.signal ?? null)
      sseStream = s
      resolvedEventsCount++
      s.send(snapshotSse(makeSnapshot()))
      return new Response(s.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url === '/api/profiles') {
      return new Response(
        JSON.stringify([{ id: 'assistant', name: 'Assistant', model: 'anthropic/claude-sonnet-4-5', isDefault: true, skills: [] }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url === '/api/providers') {
      return new Response(
        JSON.stringify([{ id: 'anthropic', name: 'Anthropic', custom: false, models: [] }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url === '/api/credentials') {
      return new Response(
        JSON.stringify([{ id: 'anthropic', configured: true, source: 'env' }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url === '/api/models') {
      return new Response(
        JSON.stringify({
          models: [{ provider: 'anthropic', modelId: 'claude-sonnet-4-5', available: true }],
          thinkingLevels: { 'anthropic/claude-sonnet-4-5': ['off', 'medium'] },
          defaultModel: 'anthropic/claude-sonnet-4-5',
          defaultThinkingLevel: 'off',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url === '/api/models/providers') {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/api/skills') {
      return new Response(
        JSON.stringify([{ id: 'skill-a', name: 'Skill A', description: 'Skill A desc', source: 'builtin' }]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url === '/api/actions') {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/api/nodes') {
      return new Response(JSON.stringify(makeSnapshot().nodes), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.startsWith('/api/conversations/1/artifacts') || url.startsWith('/api/conversations/2/artifacts')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.startsWith('/api/conversations/1')) {
      return new Response(
        JSON.stringify({
          ...makeConv(1, 'Streaming Conv', 'working'),
          entries: [],
          lastEntryId: null,
          hasMore: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.startsWith('/api/conversations/2')) {
      return new Response(
        JSON.stringify({
          ...makeConv(2, 'Inactive Split Conv', 'idle'),
          entries: [],
          lastEntryId: null,
          hasMore: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const commitCounts: Record<string, number> = {
    sidebar: 0,
    modelCenter: 0,
    skillCenter: 0,
    pluginCenter: 0,
    profileCenter: 0,
    nodeCenter: 0,
    commandPalette: 0,
    timeline2: 0,
    pane1: 0,
    hookProbe2: 0,
    hookProbe1: 0,
    sdkProbe1: 0,
  }
  const bump = (key: keyof typeof commitCounts): void => {
    commitCounts[key] = (commitCounts[key] ?? 0) + 1
  }

  let observedConv1DetailLoaded = false
  let observedConv2SummaryReady = false
  let latestProbe1Text = ''
  let latestProbe2Text = ''
  let latestSdk1Text = ''
  let latestSdkLocale = ''

  const LiveProbe1 = (): React.ReactNode => {
    const live = useConversationLive(1)
    const detail = useConversationDetail(1)
    bump('hookProbe1')
    observedConv1DetailLoaded = detail !== undefined
    latestProbe1Text = live?.text ?? ''
    return <div data-testid="probe-1">{latestProbe1Text}</div>
  }

  const InactiveConvSubtree = (): React.ReactNode => {
    const summary = useConversationSummary(2)
    const detail = useConversationDetail(2)
    const live = useConversationLive(2)
    const artifacts = useConversationArtifacts(2)
    bump('hookProbe2')
    observedConv2SummaryReady = summary !== undefined
    latestProbe2Text = live?.text ?? ''
    void artifacts
    if (!summary) return null
    return (
      <ConversationTimeline
        conversation={summary}
        detailEntries={detail?.entries ?? []}
        live={live}
        onRequestEdit={() => {}}
      />
    )
  }

  const pluginStubCtx: NonNullable<React.ContextType<typeof PluginClientContext>> = {
    pluginId: 'test:plugin',
    callAction: async () => undefined,
    openScreen: () => {},
    openConversationDrawer: () => {},
    openSplitScreen: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: () => {},
    submitInput: async () => {},
    getPluginSessionDoc: async () => undefined,
    getPluginDoc: async () => undefined,
    theme: 'dark',
    locale: 'en',
    translate: (text: LocalizedText) => (typeof text === 'string' ? text : ''),
  }

  const SdkProbe1 = (): React.ReactNode => {
    const conv = useConversation(1)
    const pluginCtx = usePluginContext()
    bump('sdkProbe1')
    latestSdk1Text = conv.live?.text ?? ''
    latestSdkLocale = pluginCtx.locale
    return <div data-testid="sdk-1">{latestSdk1Text}</div>
  }

  const noop = (): void => {}
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined

  mountedCleanups.push(async () => {
    const r = root
    if (r !== undefined) await act(async () => { r.unmount() })
    sseStream?.end()
    host.remove()
    globalThis.fetch = originalFetch
    localStorage.removeItem('helm:token')
    window.history.replaceState(null, '', '#/')
    resetPluginClientCache()
  })

  await act(async () => {
    root = createRoot(host)
    root.render(
      <HelmStoreProvider>
        <React.Profiler id="sidebar" onRender={() => bump('sidebar')}>
          <Sidebar />
        </React.Profiler>
        <React.Profiler id="model-center" onRender={() => bump('modelCenter')}>
          <ModelCenter />
        </React.Profiler>
        <React.Profiler id="skill-center" onRender={() => bump('skillCenter')}>
          <SkillCenter />
        </React.Profiler>
        <React.Profiler id="plugin-center" onRender={() => bump('pluginCenter')}>
          <PluginCenter />
        </React.Profiler>
        <React.Profiler id="profile-center" onRender={() => bump('profileCenter')}>
          <ProfileCenter />
        </React.Profiler>
        <React.Profiler id="node-center" onRender={() => bump('nodeCenter')}>
          <NodeCenter />
        </React.Profiler>
        <React.Profiler id="command-palette" onRender={() => bump('commandPalette')}>
          <CommandPaletteModal onClose={noop} />
        </React.Profiler>
        <React.Profiler id="pane-1" onRender={() => bump('pane1')}>
          <ConversationPane conversationId={1} isSplit={false} />
        </React.Profiler>
        <React.Profiler id="timeline-2" onRender={() => bump('timeline2')}>
          <InactiveConvSubtree />
        </React.Profiler>
        <LiveProbe1 />
        <PluginClientContext.Provider value={pluginStubCtx}>
          <SdkProbe1 />
        </PluginClientContext.Provider>
      </HelmStoreProvider>,
    )
  })

  await waitUntil(
    () => resolvedEventsCount > 0 && sseStream !== undefined && observedConv1DetailLoaded && observedConv2SummaryReady,
    'initial snapshot, assets, and conversation details settled',
  )
  // 让 mount 后的异步加载尾巴彻底落定
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40))
  })

  // 重置基准计数：验证此后 10 帧 conversation.live(1) 推送的重渲染边界
  for (const key of Object.keys(commitCounts)) commitCounts[key] = 0

  for (let i = 1; i <= 10; i++) {
    const tokenText = `streaming token #${i}`
    await act(async () => {
      sseStream!.send(
        liveSse({
          conversationId: 1,
          text: tokenText,
          tools: [],
          updatedAt: 1000 + i,
        }),
      )
    })
  }

  await waitUntil(
    () => latestProbe1Text === 'streaming token #10' && latestSdk1Text === 'streaming token #10',
    'conversation #1 live probes observe frame #10',
  )

  // 1) 正向断言：目标活跃会话 DOM、Host live hook 与 @helm/plugin-client useConversation(1) / usePluginContext 全部实时更新
  assert.ok(host.textContent?.includes('streaming token #10'), 'ConversationPane(1) DOM 应实时显示最新流式文本')
  assert.equal(latestSdk1Text, 'streaming token #10', '@helm/plugin-client useConversation(1) 应实时更新')
  assert.equal(latestSdkLocale, 'en', '@helm/plugin-client usePluginContext() 应可用且 locale 正确')
  assert.ok((commitCounts.pane1 ?? 0) >= 1, '活跃会话 ConversationPane(1) 应响应 live 更新')
  assert.ok((commitCounts.hookProbe1 ?? 0) >= 1, 'useConversationLive(1) 订阅者应重渲染')
  assert.ok((commitCounts.sdkProbe1 ?? 0) >= 1, 'SDK useConversation(1) 订阅者应实时更新')

  // 2) 负向隔离断言：无关静态面板、Sidebar、CommandPalette 及未活跃分屏会话 0 次多余重渲染
  assert.equal(commitCounts.sidebar, 0, 'Sidebar 不应因 conversation.live(1) 重渲染')
  assert.equal(commitCounts.modelCenter, 0, 'ModelCenter 不应因 conversation.live(1) 重渲染')
  assert.equal(commitCounts.skillCenter, 0, 'SkillCenter 不应因 conversation.live(1) 重渲染')
  assert.equal(commitCounts.pluginCenter, 0, 'PluginCenter 不应因 conversation.live(1) 重渲染')
  assert.equal(commitCounts.profileCenter, 0, 'ProfileCenter 不应因 conversation.live(1) 重渲染')
  assert.equal(commitCounts.nodeCenter, 0, 'NodeCenter 不应因 conversation.live(1) 重渲染')
  assert.equal(commitCounts.commandPalette, 0, 'CommandPaletteModal 不应因 conversation.live(1) 重渲染')
  assert.equal(commitCounts.timeline2, 0, '未活跃会话 #2 ConversationTimeline 不应因 #1 流式更新而重渲染')
  assert.equal(commitCounts.hookProbe2, 0, '未活跃会话 #2 的 live/detail/summary/artifacts hooks 不应因 #1 帧触发重渲染')

  // 3) 精准靶向验证：向 #2 推送一帧 conversation.live(2)，只有 #2 与 #1 以外不相关面板仍保持 0 次重渲染
  for (const key of Object.keys(commitCounts)) commitCounts[key] = 0
  await act(async () => {
    sseStream!.send(
      liveSse({
        conversationId: 2,
        text: 'conv 2 streaming frame',
        tools: [],
        updatedAt: 2000,
      }),
    )
  })

  await waitUntil(() => latestProbe2Text === 'conv 2 streaming frame', 'conversation #2 receives its own live frame')
  assert.ok((commitCounts.hookProbe2 ?? 0) >= 1, '#2 收到自己的 live 帧时应精准更新')
  assert.ok((commitCounts.timeline2 ?? 0) >= 1, '#2 ConversationTimeline 应响应 #2 的 live 帧')
  assert.equal(commitCounts.hookProbe1, 0, '#1 订阅者不应因 #2 的 live 帧触发重渲染')
  assert.equal(commitCounts.sidebar, 0, 'Sidebar 不应因 #2 的 live 帧重渲染')
  assert.equal(commitCounts.modelCenter, 0, 'ModelCenter 不应因 #2 的 live 帧重渲染')
  assert.equal(commitCounts.skillCenter, 0, 'SkillCenter 不应因 #2 的 live 帧重渲染')
  assert.equal(commitCounts.pluginCenter, 0, 'PluginCenter 不应因 #2 的 live 帧重渲染')
})

test('StoreRequestManager 并发去重、epoch 取消、不可见会话中止与 dispose 清理契约', { timeout: 60_000 }, async () => {
  const manager = new StoreRequestManager()
  let executions = 0
  let resolveFirst!: (val: string) => void
  const p1 = manager.runControlled<string>({
    key: 'conversation:10',
    exec: () => {
      executions++
      return new Promise<string>((resolve) => {
        resolveFirst = resolve
      })
    },
  })
  const p2 = manager.runControlled<string>({
    key: 'conversation:10',
    exec: () => {
      executions++
      return Promise.resolve('duplicate')
    },
  })
  assert.equal(p1, p2, '同一 key 并发请求必须共享同一个 in-flight Promise')
  assert.equal(executions, 1, '同一 key 去重后底层 exec 只调用一次')
  resolveFirst('ok-10')
  assert.equal(await p1, 'ok-10')

  // 切换可见会话应取消不再可见的会话请求，保留仍可见的会话请求
  let abortedConv2 = false
  let abortedConv1 = false
  let staleAfterAbort = false
  const req1 = manager.runControlled<string>({
    key: 'conversation:1',
    exec: ({ signal }) =>
      new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          abortedConv1 = true
          resolve('aborted-1')
        })
        setTimeout(() => resolve('kept-1'), 30)
      }),
  })
  const req2 = manager.runControlled<string>({
    key: 'history:2',
    exec: ({ signal, isStale }) =>
      new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          abortedConv2 = true
          staleAfterAbort = isStale()
          resolve('aborted-2')
        })
      }),
  })

  manager.syncVisibleConversations(new Set([1, 2]))
  manager.syncVisibleConversations(new Set([1]))
  assert.equal(abortedConv2, true, '会话 2 移出可见集合时应中止其进行中请求')
  assert.equal(staleAfterAbort, true, '被中止请求的 isStale() 应立刻变为 true')
  assert.equal(await req2, undefined, 'stale 请求应被舍弃并返回 undefined')
  assert.equal(abortedConv1, false, '仍可见的会话 1 不得被中止')
  assert.equal(await req1, 'kept-1')

  // delay + dispose 应取消未触发定时器
  let timerFired = false
  manager.delay(() => {
    timerFired = true
  }, 50)
  manager.dispose()
  await new Promise((resolve) => setTimeout(resolve, 75))
  assert.equal(timerFired, false, 'dispose() 应清理所有挂起 delay 定时器')
})

test('HelmExternalStore 领域隔离、reportLoad 幂等空操作与缺 Provider 显式抛错契约', { timeout: 60_000 }, async () => {
  const store = new HelmExternalStore({
    primaryTarget: { kind: 'conversation', conversationId: 1 },
    splitTarget: null,
    workbenchOpen: false,
    workbenchTab: 'artifacts',
    activeModal: null,
  })
  let live1Notifications = 0
  let live2Notifications = 0
  let catalogNotifications = 0
  let conversationsNotifications = 0
  let loadErrorsNotifications = 0

  const unsub1 = store.subscribeConversationLive(1, () => { live1Notifications++ })
  const unsub2 = store.subscribeConversationLive(2, () => { live2Notifications++ })
  const unsubCat = store.subscribeDomain('catalog', () => { catalogNotifications++ })
  const unsubConvs = store.subscribeDomain('conversations', () => { conversationsNotifications++ })
  const unsubErr = store.subscribeDomain('loadErrorsMap', () => { loadErrorsNotifications++ })

  store.reportLoad('assets:profiles', undefined)
  assert.equal(loadErrorsNotifications, 0, '缺失错误键时清除错误应为空操作，不触发通知')

  store.updateLive((prev) => applySnapshot(prev, makeSnapshot()))
  live1Notifications = 0
  live2Notifications = 0
  catalogNotifications = 0
  conversationsNotifications = 0

  store.updateLive((prev) => applyTransientLiveFrame(prev, {
    live: { conversationId: 1, text: 'hello', tools: [], updatedAt: 500 },
  }))
  assert.equal(live1Notifications, 1, '仅 conversation 1 live 订阅者应收到通知')
  assert.equal(live2Notifications, 0, 'conversation 2 live 订阅者不得收到 #1 更新通知')
  assert.equal(catalogNotifications, 0, 'catalog 领域不得收到 #1 live 更新通知')
  assert.equal(conversationsNotifications, 0, 'conversations 列表领域不得收到 #1 live 增量通知')

  unsub1()
  unsub2()
  unsubCat()
  unsubConvs()
  unsubErr()
  store.dispose()

  // 单轨供给契约：不在 HelmExternalStoreContext.Provider 内时切片 hooks 显式抛错（绝不静默回退）
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: Root | undefined
  mountedCleanups.push(async () => {
    const r = root
    if (r !== undefined) await act(async () => { r.unmount() })
    host.remove()
  })

  // Hook 无条件调用、渲染路径恒定；错误经错误边界如实捕获（Rules of Hooks 友好）
  let observedError: unknown = null
  class CaptureBoundary extends React.Component<
    { children: React.ReactNode },
    { hasError: boolean }
  > {
    override state = { hasError: false }
    static getDerivedStateFromError(): { hasError: boolean } {
      return { hasError: true }
    }
    override componentDidCatch(error: unknown): void {
      observedError = error
    }
    override render(): React.ReactNode {
      return this.state.hasError ? null : this.props.children
    }
  }
  const OutsideProviderProbe = (): React.ReactNode => {
    const live = useConversationLive(1)
    return live === undefined ? null : React.createElement('div', null, live.text)
  }
  await act(async () => {
    root = createRoot(host)
    root.render(
      <CaptureBoundary>
        <OutsideProviderProbe />
      </CaptureBoundary>,
    )
  })
  assert.ok(observedError instanceof Error, '缺 Provider 时 keyed 切片 hook 必须显式抛错')
  assert.match(observedError.message, /must be called inside/)
})
