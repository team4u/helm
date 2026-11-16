/**
 * 版本感知装配 hook 测试（use-version-watcher.ts）：
 * bootId 首次/变化触发、clean 自动刷新与 dirty 挂起/补刷、visibility/focus
 * 5s 节流、hidden/visible 轮询行为、vite:preloadError 兜底、WebView-safe
 * 刷新导航阶梯（同址 replace → cache-buster 升级重试、手动不被自动闸门短路、
 * 同入口跨页防环）、卸载后 listener/timer 清理，以及 HelmStoreProvider 对
 * kernelBootId 的快照暴露。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

import { makeTestStore, HelmStoreContext } from './helpers/store.js'
import { sseClientTimings } from '../src/lib/live-state.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import {
  useVersionWatcher,
  versionWatchTimings,
  type VersionWatcherView,
} from '../src/shell/use-version-watcher.js'
import {
  FINGERPRINT_RELOAD_GUARD_KEY,
  PRELOAD_RELOAD_GUARD_KEY,
  RELOAD_CACHE_BUSTER_PARAM,
  type VersionReloadLocation,
} from '../src/shell/version-watch-model.js'
import { clearComposerDirty, setComposerDirty, type ComposerDirtySnapshot } from '../src/conversation/composer-dirty.js'
import { useComposerSend, type ComposerSendApi } from '../src/conversation/composer-send.js'
import type { ConversationSummary } from '@helm/protocol'
import {
  clearStandbyDraft,
  resetStandbyDrafts,
  standbyDraftKey,
  updateStandbyDraft,
} from '../src/conversation/standby-model.js'

const CURRENT_ENTRY = '/assets/index-current.js'
const NEW_ENTRY = '/assets/index-newhash.js'

/** 与 Vite 构建产物同构的 index.html 正文。 */
const builtIndexHtml = (src: string): string =>
  `<!doctype html><html lang="zh-CN"><head><title>Helm</title>` +
  `<script type="module" crossorigin src="${src}"></script></head>` +
  `<body><div id="root"></div></body></html>`

/** 在当前（happy-dom）document 注入生产入口 module script；返回清理函数。 */
function installProductionEntry(src: string): () => void {
  document.head.innerHTML = `<script type="module" crossorigin src="${src}"></script>`
  return () => {
    document.head.innerHTML = ''
  }
}

function setVisible(visible: boolean): void {
  Object.defineProperty(document, 'hidden', { value: !visible, configurable: true })
  Object.defineProperty(document, 'visibilityState', { value: visible ? 'visible' : 'hidden', configurable: true })
}

function dispatchVisibility(visible: boolean): void {
  setVisible(visible)
  document.dispatchEvent(new Event('visibilitychange'))
}

const CLEAN_COMPOSER: ComposerDirtySnapshot = { hasDraftText: false, editingEntry: false, hasAttachments: false, busy: false }

interface Harness {
  renderStore: (bootId: string | null, overrides?: Partial<HelmStoreValue>) => void
  view: () => VersionWatcherView
  fetchCalls: Array<{ url: string; init: RequestInit }>
  reloads: () => number
  respond: (builder: () => Response | Promise<Response>) => void
  /** location 注入模式下记录的 replace 导航 URL（reload 注入模式为空数组）。 */
  replaceUrls: () => string[]
  unmount: () => void
}

/** 可变 location 替身：replace 只记录不导航（模拟 WebView 吞掉导航、页面仍存活）。 */
function makeStubLocation(base: { pathname?: string; search?: string; hash?: string }): {
  location: VersionReloadLocation
  replaceUrls: string[]
} {
  const replaceUrls: string[] = []
  return {
    location: {
      pathname: base.pathname ?? '/',
      search: base.search ?? '',
      hash: base.hash ?? '',
      replace: (url: string) => {
        replaceUrls.push(url)
      },
    },
    replaceUrls,
  }
}

/** 挂载 hook（经 makeTestStore 提供上下文）；/index.html 响应体可运行时切换。
 *  缺省注入计数 reload；传 nav.location 时改用 location.replace 阶梯（观察真实导航 URL）。 */
function mountWatcher(initialHtml = builtIndexHtml(CURRENT_ENTRY), nav: { location?: VersionReloadLocation } = {}): Harness {
  const fetchCalls: Array<{ url: string; init: RequestInit }> = []
  let buildResponse = (): Response | Promise<Response> =>
    new Response(initialHtml, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} })
    return buildResponse()
  }) as typeof fetch

  let reloadCount = 0
  const replaceCalls: string[] = []
  // location 注入模式：包装 replace 记录导航 URL（替身本身不导航，页面持续存活，
  // 恰好模拟 WebView 吞掉导航的真实处境）。
  const navLocation: VersionReloadLocation | undefined = nav.location
  const wrappedLocation: VersionReloadLocation | undefined = navLocation === undefined ? undefined : {
    pathname: navLocation.pathname,
    search: navLocation.search,
    hash: navLocation.hash,
    replace: (url: string) => {
      replaceCalls.push(url)
      navLocation.replace(url)
    },
  }
  let currentView: VersionWatcherView | null = null
  const WatcherProbe = (): React.ReactNode => {
    currentView = useVersionWatcher(
      wrappedLocation !== undefined
        ? { location: wrappedLocation }
        : { reload: () => { reloadCount += 1 } },
    )
    return null
  }
  const StoreHost = ({ store }: { store: HelmStoreValue }): React.ReactNode => (
    <HelmStoreContext.Provider value={store}>
      <WatcherProbe />
    </HelmStoreContext.Provider>
  )

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root: Root = createRoot(host)
  const renderStore = (bootId: string | null, overrides: Partial<HelmStoreValue> = {}): void => {
    act(() => {
      root.render(<StoreHost store={makeTestStore({ kernelBootId: bootId, ...overrides })} />)
    })
  }
  renderStore(null)
  return {
    renderStore,
    view: () => currentView!,
    fetchCalls,
    reloads: () => (wrappedLocation !== undefined ? replaceCalls.length : reloadCount),
    respond: (builder) => {
      buildResponse = builder
    },
    replaceUrls: () => [...replaceCalls],
    unmount: () => {
      act(() => {
        root.unmount()
      })
      globalThis.fetch = originalFetch
      host.remove()
    },
  }
}

/** 等待探测 Promise 落定并让 React 提交期间的状态更新进入 act 环境。 */
const flush = async (ms = 10): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

function withTimings<T>(patch: Partial<typeof versionWatchTimings>, fn: () => Promise<T>): Promise<T> {
  const original = { ...versionWatchTimings }
  Object.assign(versionWatchTimings, patch)
  return fn().finally(() => {
    Object.assign(versionWatchTimings, original)
  })
}

let harness: Harness | undefined
let entryCleanup: (() => void) | undefined

afterEach(() => {
  harness?.unmount()
  harness = undefined
  entryCleanup?.()
  entryCleanup = undefined
  resetStandbyDrafts()
  setComposerDirty('watch-test-composer', CLEAN_COMPOSER)
  clearComposerDirty('watch-composer-instance')
  try {
    sessionStorage.removeItem(PRELOAD_RELOAD_GUARD_KEY)
    sessionStorage.removeItem(FINGERPRINT_RELOAD_GUARD_KEY)
  } catch {
    /* happy-dom 环境恒可用；防御性兜底 */
  }
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  setVisible(true)
})

// ---------------------------------------------------------------------------
// bootId 触发与 clean 刷新
// ---------------------------------------------------------------------------

test('bootId 首次快照只建基线不探测；之后变化立即探测且指纹未变不刷新', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  await flush()
  assert.equal(h.fetchCalls.length, 0, '挂载本身不探测')

  h.renderStore('boot-1')
  await flush()
  assert.equal(h.fetchCalls.length, 0, '首次 snapshot 不视为更新，不触发探测')

  h.renderStore('boot-2')
  await flush()
  assert.equal(h.fetchCalls.length, 1)
  assert.match(h.fetchCalls[0]!.url, /^\/index\.html\?helmv=/, '探测 URL 携带防缓存唯一参数')
  assert.equal(h.fetchCalls[0]!.init.cache, 'no-store')
  assert.equal(h.view().updateAvailable, false, '入口指纹未变不算新版本')
  assert.equal(h.reloads(), 0)
})

test('bootId 变化后探测到新入口：clean 状态自动 reload 一次，后续探测不重复刷新', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  h.renderStore('boot-1')
  await flush()

  h.respond(() => new Response(builtIndexHtml(NEW_ENTRY), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))
  h.renderStore('boot-2')
  await flush()
  assert.equal(h.view().updateAvailable, true)
  assert.equal(h.reloads(), 1, 'clean 检测到新版本立即 reload')

  h.renderStore('boot-3')
  await flush()
  assert.equal(h.fetchCalls.length, 2)
  assert.equal(h.reloads(), 1, 'reload 已触发过，不重复')
})

test('dev 入口（无 /assets/ module script）整体休眠：任何触发都不探测不刷新', { timeout: 60_000 }, async () => {
  harness = mountWatcher()
  const h = harness
  h.renderStore('boot-1')
  await flush()
  h.renderStore('boot-2')
  await flush()
  act(() => {
    dispatchVisibility(true)
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('vite:preloadError'))
  })
  await flush()
  assert.equal(h.fetchCalls.length, 0)
  assert.equal(h.view().updateAvailable, false)
  assert.equal(h.reloads(), 0)
})

// ---------------------------------------------------------------------------
// dirty 挂起与 clean 补刷
// ---------------------------------------------------------------------------

test('会话 Composer 有本地草稿时不自动 reload：挂起提示 + 立即刷新动作；dirty 转清后自动补刷一次', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  act(() => {
    setComposerDirty('watch-test-composer', { ...CLEAN_COMPOSER, hasDraftText: true })
  })
  h.renderStore('boot-1')
  await flush()

  h.respond(() => new Response(builtIndexHtml(NEW_ENTRY), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))
  h.renderStore('boot-2')
  await flush()
  assert.equal(h.view().updateAvailable, true, '新版本已探测到')
  assert.equal(h.view().deferReason, 'draft', '本地草稿挂起')
  assert.equal(h.reloads(), 0, 'dirty 时不自动 reload')

  // dirty 快照翻转（仍在输入）不重复触发刷新，也不堆积提示状态
  act(() => {
    setComposerDirty('watch-test-composer', { ...CLEAN_COMPOSER, hasDraftText: true, editingEntry: true })
  })
  await flush()
  assert.equal(h.reloads(), 0)

  act(() => {
    setComposerDirty('watch-test-composer', CLEAN_COMPOSER)
  })
  await flush()
  assert.equal(h.reloads(), 1, 'dirty 转清自动补刷')
})

test('待命草稿（任意坐标非空正文）同样挂起；草稿清空后补刷', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  const key = standbyDraftKey({ panel: 'primary', profileId: 'p1' })
  act(() => {
    updateStandbyDraft(key, { text: '未发送的首条消息' })
  })
  h.renderStore('boot-1')
  await flush()

  h.respond(() => new Response(builtIndexHtml(NEW_ENTRY), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))
  h.renderStore('boot-2')
  await flush()
  assert.equal(h.view().deferReason, 'draft', '待命草稿挂起')
  assert.equal(h.reloads(), 0)

  act(() => {
    clearStandbyDraft(key)
  })
  await flush()
  assert.equal(h.reloads(), 1)
})

test('探测失败不误判：dirty 现场保持原状，不产生待刷新提示', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  h.renderStore('boot-1')
  await flush()

  h.respond(() => new Response('server error', { status: 500 }))
  h.renderStore('boot-2')
  await flush()
  assert.equal(h.fetchCalls.length, 1)
  assert.equal(h.view().updateAvailable, false, 'HTTP 错误不当作版本变更')
  assert.equal(h.reloads(), 0)
})

// ---------------------------------------------------------------------------
// 异步探测竞态与卸载守卫
// ---------------------------------------------------------------------------

/** 受控延迟响应：测试持有 release 决定第一次探测何时返回。 */
function deferredResponse(): { promise: Promise<Response>; release: (response: Response) => void } {
  let release!: (response: Response) => void
  const promise = new Promise<Response>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const htmlOf = (entry: string): Response =>
  new Response(builtIndexHtml(entry), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })

test('在途探测期间 bootId 变化不吞快速触发：完成后立刻补探并采用最新结果', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  h.renderStore('boot-1')
  await flush()

  const first = deferredResponse()
  let call = 0
  h.respond(() => (call++ === 0 ? first.promise : Promise.resolve(htmlOf(NEW_ENTRY))))
  await withTimings({ visibilityThrottleMs: 0, pollIntervalMs: 60_000 }, async () => {
    act(() => {
      dispatchVisibility(true)
    })
    await flush()
    assert.equal(h.fetchCalls.length, 1, '第一次探测在途')

    // 在途期间内核换代：快速触发进入补探队列，而不是被丢弃
    h.renderStore('boot-2')
    await flush()
    assert.equal(h.fetchCalls.length, 1, '在途期间不并发探测')

    act(() => {
      first.release(htmlOf(CURRENT_ENTRY))
    })
    await flush()
    assert.equal(h.fetchCalls.length, 2, '在途完成后立刻补探')
    assert.equal(h.view().updateAvailable, true, '补探采用最新入口')
    assert.equal(h.reloads(), 1, 'clean 检测到新版本补刷')
  })
})

test('卸载时在途探测回包被丢弃：不推进状态、不触发 reload', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  const first = deferredResponse()
  h.respond(() => first.promise)
  await withTimings({ visibilityThrottleMs: 0, pollIntervalMs: 60_000 }, async () => {
    act(() => {
      dispatchVisibility(true)
    })
    await flush()
    assert.equal(h.fetchCalls.length, 1, '探测在途')

    h.unmount()
    act(() => {
      first.release(htmlOf(NEW_ENTRY))
    })
    await flush()
    assert.equal(h.reloads(), 0, '卸载后的回包不触发 reload')
    assert.equal(h.view().updateAvailable, false, '卸载后不推进状态')
  })
})

// ---------------------------------------------------------------------------
// 弹窗与焦点保护（保守挂起条件）
// ---------------------------------------------------------------------------

test('任意 activeModal（含只读 artifact-preview）挂起自动刷新；关闭后自动补刷', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))

  h.renderStore('boot-2', { activeModal: { kind: 'artifact-preview', artifactId: 'art-1', conversationId: 1 } })
  await flush()
  assert.equal(h.view().updateAvailable, true)
  assert.equal(h.view().deferReason, 'modal', '只读弹窗同样保守挂起')
  assert.equal(h.reloads(), 0)

  // 同 bootId 仅关闭弹窗：不靠新探测，挂起解除即补刷
  h.renderStore('boot-2', { activeModal: null })
  await flush()
  assert.equal(h.view().deferReason, null)
  assert.equal(h.reloads(), 1, '弹窗关闭自动补刷')
})

test('草稿 + 弹窗同时在场：deferReason 如实组合，两者都解除后才补刷', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  act(() => {
    setComposerDirty('watch-test-composer', { ...CLEAN_COMPOSER, hasDraftText: true })
  })
  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))

  h.renderStore('boot-2', { activeModal: { kind: 'command-palette' } })
  await flush()
  assert.equal(h.view().deferReason, 'draft-and-modal')
  assert.equal(h.reloads(), 0)

  // 先关弹窗：仍有草稿，不刷
  h.renderStore('boot-2', { activeModal: null })
  await flush()
  assert.equal(h.view().deferReason, 'draft')
  assert.equal(h.reloads(), 0)

  // 再清草稿：补刷
  act(() => {
    setComposerDirty('watch-test-composer', CLEAN_COMPOSER)
  })
  await flush()
  assert.equal(h.reloads(), 1)
})

test('焦点在 input/textarea 时保守挂起（文案并入未提交内容）；失焦后补刷', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  const input = document.createElement('input')
  document.body.appendChild(input)
  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))

  act(() => {
    input.focus()
  })
  await flush()
  assert.equal(h.view().deferReason, 'draft', '焦点保护并入未提交内容文案')

  h.renderStore('boot-2')
  await flush()
  assert.equal(h.view().updateAvailable, true)
  assert.equal(h.reloads(), 0, '焦点内不自动刷新')

  act(() => {
    input.blur()
  })
  await flush()
  assert.equal(h.view().deferReason, null)
  assert.equal(h.reloads(), 1, '失焦且无其他现场后补刷')
  input.remove()
})

// ---------------------------------------------------------------------------
// Composer 实例脏状态上报生命周期（桥接端到端）
// ---------------------------------------------------------------------------

const HOST_CONVERSATION: ConversationSummary = {
  id: 7,
  title: '桥接测试会话',
  profileId: 'assistant',
  tags: [],
  cwd: '/tmp',
  model: 'faux/faux-1',
  thinkingLevel: 'off',
  status: 'idle',
  stateChangeSeq: 1,
  completionSeq: 0,
  unread: false,
  pinned: false,
  pendingAskCount: 0,
  createdAt: 1,
  updatedAt: 1,
}

test('Composer 实例上报与卸载清报：旧实例残留不阻塞刷新', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness

  // 独立渲染一个真实 useComposerSend 宿主（与 watcher 共享模块级桥接 store）
  let sendApi: ComposerSendApi | null = null
  const ComposerSendHost = (): React.ReactNode => {
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
    sendApi = useComposerSend({
      conversation: HOST_CONVERSATION,
      prefill: null,
      textareaRef,
      slashPluginCommands: [],
      envConfigurable: false,
      working: false,
      dirtyKey: 'watch-composer-instance',
    })
    return null
  }
  const composerHost = document.createElement('div')
  document.body.appendChild(composerHost)
  const composerRoot = createRoot(composerHost)
  act(() => {
    composerRoot.render(
      <HelmStoreContext.Provider value={makeTestStore({})}>
        <ComposerSendHost />
      </HelmStoreContext.Provider>,
    )
  })
  assert.equal(h.view().deferReason, null, '空草稿不挂起')

  act(() => {
    sendApi!.setDraftState('未发送的草稿')
  })
  await flush()
  assert.equal(h.view().deferReason, 'draft', '实例上报挂起')

  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))
  h.renderStore('boot-2')
  await flush()
  assert.equal(h.view().updateAvailable, true)
  assert.equal(h.reloads(), 0, '草稿在场不刷新')

  // 卸载 Composer 实例：上报随 effect cleanup 清除，聚合转清自动补刷
  act(() => {
    composerRoot.unmount()
  })
  await flush()
  assert.equal(h.reloads(), 1, '实例卸载清报后补刷，不残留阻塞')
  composerHost.remove()
})

// ---------------------------------------------------------------------------
// visibility / focus 节流与轮询
// ---------------------------------------------------------------------------

test('visibilitychange 变 visible 与 focus 立即探测，5s 节流窗口内不重复', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  await withTimings({ visibilityThrottleMs: 80, pollIntervalMs: 60_000 }, async () => {
    act(() => {
      dispatchVisibility(false)
    })
    await flush()
    assert.equal(h.fetchCalls.length, 0, 'hidden 的 visibilitychange 不探测')

    act(() => {
      dispatchVisibility(true)
    })
    await flush()
    assert.equal(h.fetchCalls.length, 1)

    act(() => {
      dispatchVisibility(true)
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    assert.equal(h.fetchCalls.length, 1, '节流窗口内 visibility/focus 不重复探测')

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    assert.equal(h.fetchCalls.length, 2, '窗口过后放行')
  })
})

test('visible 期间按周期轮询；hidden 暂停；恢复 visible 后继续', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  await withTimings({ pollIntervalMs: 40, visibilityThrottleMs: 0 }, async () => {
    harness = mountWatcher()
    const h = harness
    await flush(280)
    assert.ok(h.fetchCalls.length >= 2, 'visible 期间周期探测')

    const beforeHidden = h.fetchCalls.length
    act(() => {
      dispatchVisibility(false)
    })
    await flush(240)
    assert.equal(h.fetchCalls.length, beforeHidden, 'hidden 期间不轮询')

    act(() => {
      dispatchVisibility(true)
    })
    await flush(200)
    assert.ok(h.fetchCalls.length > beforeHidden, '恢复 visible 后继续轮询')
  })
})

// ---------------------------------------------------------------------------
// vite:preloadError 兜底
// ---------------------------------------------------------------------------

test('vite:preloadError：clean 立即刷新且只刷一次；重复事件不重复刷新', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  await flush()
  act(() => {
    window.dispatchEvent(new Event('vite:preloadError'))
  })
  await flush()
  assert.equal(h.reloads(), 1)
  act(() => {
    window.dispatchEvent(new Event('vite:preloadError'))
  })
  await flush()
  assert.equal(h.reloads(), 1, '防重复刷新')
})

test('vite:preloadError + dirty：挂起提示不被后续指纹未变的探测解除；转清补刷', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  act(() => {
    setComposerDirty('watch-test-composer', { ...CLEAN_COMPOSER, hasAttachments: true })
  })
  await flush()
  act(() => {
    window.dispatchEvent(new Event('vite:preloadError'))
  })
  await flush()
  assert.equal(h.view().updateAvailable, true, '资产失效即使指纹未变也提示待刷新')
  assert.equal(h.reloads(), 0)

  // 后续探测（bootId 首基线 -> 变化）返回相同指纹：挂起提示保持（chunk 已损坏）
  h.renderStore('boot-1')
  await flush()
  assert.equal(h.fetchCalls.length, 0, '首基线不探测')
  h.renderStore('boot-2')
  await flush()
  assert.ok(h.fetchCalls.length >= 1)
  assert.equal(h.view().updateAvailable, true)

  act(() => {
    setComposerDirty('watch-test-composer', CLEAN_COMPOSER)
  })
  await flush()
  assert.equal(h.reloads(), 1)
})

// ---------------------------------------------------------------------------
// preloadError 跨 reload 防环与 Vite 事件契约
// ---------------------------------------------------------------------------

test('preloadError 事件被接管：cancelable 事件 preventDefault，Vite 不再重抛错误', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  await flush()
  const event = new Event('vite:preloadError', { cancelable: true })
  act(() => {
    window.dispatchEvent(event)
  })
  await flush()
  assert.equal(event.defaultPrevented, true, 'handler 恒接管并取消默认重抛')
  assert.equal(h.reloads(), 1, 'clean 且名额可用时自动刷新')
})

test('preloadError 自动重试每 tab 仅一次：名额用完保留提示，仅允许手动刷新', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  // 模拟本 tab 此前已用完自动重试名额（跨 reload 的 sessionStorage 标记）
  sessionStorage.setItem(PRELOAD_RELOAD_GUARD_KEY, '1')
  harness = mountWatcher()
  const h = harness
  await flush()
  const event = new Event('vite:preloadError', { cancelable: true })
  act(() => {
    window.dispatchEvent(event)
  })
  await flush()
  assert.equal(h.reloads(), 0, '名额已用完不再自动 reload（防环）')
  assert.equal(h.view().updateAvailable, true, '保留待刷新提示')
  assert.equal(event.defaultPrevented, true, '仍接管事件，错误不重抛')

  // 挂起条件反复变化（失焦/聚焦）也不得绕过名额自动刷新
  const input = document.createElement('input')
  document.body.appendChild(input)
  act(() => {
    input.focus()
  })
  act(() => {
    input.blur()
  })
  await flush()
  assert.equal(h.reloads(), 0)
  input.remove()

  // 手动「立即刷新」不受名额限制
  act(() => {
    h.view().reloadNow()
  })
  await flush()
  assert.equal(h.reloads(), 1)
})

test('preloadError 名额拒绝后：真实指纹变化仍正常自动刷新（不受 preload 名额限制）', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  sessionStorage.setItem(PRELOAD_RELOAD_GUARD_KEY, '1')
  harness = mountWatcher()
  const h = harness
  h.renderStore('boot-1')
  await flush()
  act(() => {
    window.dispatchEvent(new Event('vite:preloadError'))
  })
  await flush()
  assert.equal(h.reloads(), 0)
  assert.equal(h.view().updateAvailable, true)

  h.respond(() => htmlOf(NEW_ENTRY))
  h.renderStore('boot-2')
  await flush()
  assert.equal(h.reloads(), 1, '指纹变化驱动的正常刷新不受名额限制')
})

test('storage 不可用兜底：preloadError 拒绝自动刷新，保留提示', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  await flush()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new DOMException('Storage disabled', 'SecurityError')
    },
  })
  try {
    act(() => {
      window.dispatchEvent(new Event('vite:preloadError'))
    })
    await flush()
    assert.equal(h.reloads(), 0, 'storage 不可用宁可提示，绝不跨页循环')
    assert.equal(h.view().updateAvailable, true)
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, 'sessionStorage', descriptor)
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  }
})

// ---------------------------------------------------------------------------
// WebView-safe 刷新：导航阶梯、手动不短路、升级重试与跨页防环
// ---------------------------------------------------------------------------

test('手动「立即刷新」不被一次性闸门短路：自动刷新已尝试（页面未真正导航）后仍可再触发', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))
  h.renderStore('boot-2')
  await flush()
  assert.equal(h.view().updateAvailable, true)
  assert.equal(h.reloads(), 1, 'clean 自动刷新已尝试一次（注入 reload 不卸载页面，模拟导航被吞）')

  act(() => {
    h.view().reloadNow()
  })
  await flush()
  assert.equal(h.reloads(), 2, '再次手动点击必须仍能发起刷新（旧行为被 reloadTriggeredRef 短路）')

  act(() => {
    h.view().reloadNow()
  })
  await flush()
  assert.equal(h.reloads(), 3, '手动动作可重复触发，不受自动闸门/名额约束')
})

test('WebView 吞掉同址导航时自动升级 cache-buster：URL 保留 pathname/query/hash 且不累积', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  const stub = makeStubLocation({ pathname: '/', search: '?x=1', hash: '#/c/7' })
  harness = mountWatcher(builtIndexHtml(CURRENT_ENTRY), { location: stub.location })
  const h = harness
  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))
  await withTimings({ reloadEscalateMs: 60 }, async () => {
    h.renderStore('boot-2')
    await flush()
    assert.equal(h.reloads(), 1, 'clean 自动刷新第一次尝试')
    assert.deepEqual(h.replaceUrls(), ['/?x=1#/c/7'], '首次是干净同址导航：保留 query/hash、不加任何参数')

    // 替身 replace 不卸载页面 = 导航被容器吞掉：升级重试自动发生
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    assert.equal(h.reloads(), 2, '页面仍存活 → 升级为 cache-buster 导航重试一次')
    const escalated = h.replaceUrls()[1]!
    assert.match(escalated, new RegExp(`[?]x=1&${RELOAD_CACHE_BUSTER_PARAM}=`), '既有 query 参数保留，buster 追加其后')
    assert.ok(escalated.endsWith('#/c/7'), 'hash 路由原样保留')

    // 升级重试后不再自动升级（防循环）；手动动作仍可用且直接进入带 buster 的尝试
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    assert.equal(h.reloads(), 2, '自动升级至多一次，不循环')
    act(() => {
      h.view().reloadNow()
    })
    await flush()
    assert.equal(h.reloads(), 3, '手动刷新在自动尝试/升级之后仍可发起')
    const manual = h.replaceUrls()[2]!
    assert.equal(manual.match(new RegExp(`${RELOAD_CACHE_BUSTER_PARAM}=`, 'g'))?.length, 1, '地址中至多一个 buster（新值替换旧值）')
    assert.ok(manual.endsWith('#/c/7'), 'hash 保留')
  })
})

test('升级 timer 被后续手动导航取代：待决窗口内手动点击只发一次导航，不追加自动升级', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  const stub = makeStubLocation({ hash: '#/c/3' })
  harness = mountWatcher(builtIndexHtml(CURRENT_ENTRY), { location: stub.location })
  const h = harness
  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))
  await withTimings({ reloadEscalateMs: 150 }, async () => {
    h.renderStore('boot-2')
    await flush()
    assert.equal(h.reloads(), 1, '自动刷新第一次尝试（升级 timer 待决）')

    // 升级窗口内用户手动点击：新导航取代旧尝试，旧 timer 必须作废
    act(() => {
      h.view().reloadNow()
    })
    await flush()
    assert.equal(h.reloads(), 2, '手动点击发出一条导航')
    assert.match(h.replaceUrls()[1]!, new RegExp(`${RELOAD_CACHE_BUSTER_PARAM}=`), '手动点击直接进入带 buster 的尝试')

    // 越过原升级期限后不再有追加的自动导航（旧行为会在这里多发一条）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    assert.equal(h.reloads(), 2, '一次用户操作只对应一次导航，不追加自动升级')
    assert.equal(h.view().updateAvailable, true, '页面未卸载（替身不导航）：提示保留')
  })
})

test('升级窗口内出现本地输入现场：放弃自动升级；转清后自动路径也不再重复导航，手动仍可用', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  const stub = makeStubLocation({ hash: '#/c/9' })
  harness = mountWatcher(builtIndexHtml(CURRENT_ENTRY), { location: stub.location })
  const h = harness
  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))
  await withTimings({ reloadEscalateMs: 60 }, async () => {
    h.renderStore('boot-2')
    await flush()
    assert.equal(h.reloads(), 1, '自动刷新第一次尝试')

    // 用户在升级窗口内开始输入：升级重试让位（保守保护未提交内容）
    act(() => {
      setComposerDirty('watch-test-composer', { ...CLEAN_COMPOSER, hasDraftText: true })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    assert.equal(h.reloads(), 1, '升级窗口内出现草稿：不自动升级')

    act(() => {
      setComposerDirty('watch-test-composer', CLEAN_COMPOSER)
    })
    await flush()
    assert.equal(h.reloads(), 1, '自动路径一次性闸门：转清补刷不重复自动导航（防循环）')

    act(() => {
      h.view().reloadNow()
    })
    await flush()
    assert.equal(h.reloads(), 2, '手动「立即刷新」始终可用')
  })
})

test('同目标入口的自动刷新跨页仅一次：上一页未落地不再自动刷，横幅与手动动作保留', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  // 模拟上一页已对同一新入口自动发起过刷新（WebView 回吐旧缓存、未真正落地）
  sessionStorage.setItem(FINGERPRINT_RELOAD_GUARD_KEY, NEW_ENTRY)
  harness = mountWatcher()
  const h = harness
  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))
  h.renderStore('boot-2')
  await flush()
  assert.equal(h.view().updateAvailable, true, '待刷新提示保留')
  assert.equal(h.reloads(), 0, '同入口自动刷新不再重复发起（跨页防环）')

  act(() => {
    h.view().reloadNow()
  })
  await flush()
  assert.equal(h.reloads(), 1, '手动刷新不受跨页防环约束')
})

test('storage 不可用：指纹驱动的自动刷新同样拒绝（fail-closed 防跨页无限刷新），保留横幅与手动', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  harness = mountWatcher()
  const h = harness
  h.renderStore('boot-1')
  await flush()
  h.respond(() => htmlOf(NEW_ENTRY))
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new DOMException('Storage disabled', 'SecurityError')
    },
  })
  try {
    h.renderStore('boot-2')
    await flush()
    assert.equal(h.view().updateAvailable, true, '待刷新提示保留')
    assert.equal(h.reloads(), 0, 'storage 不可用拒绝自动刷新（禁 storage 的 WebView + 回吐旧缓存 = 无限循环）')

    // 挂起条件反复变化（失焦/聚焦）也不得绕过 fail-closed 自动刷新
    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => {
      input.focus()
    })
    act(() => {
      input.blur()
    })
    await flush()
    assert.equal(h.reloads(), 0)
    input.remove()

    act(() => {
      h.view().reloadNow()
    })
    await flush()
    assert.equal(h.reloads(), 1, '手动「立即刷新」不受影响')
  } finally {
    if (descriptor !== undefined) Object.defineProperty(globalThis, 'sessionStorage', descriptor)
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  }
})

// ---------------------------------------------------------------------------
// 卸载清理
// ---------------------------------------------------------------------------

test('卸载后清理 listener 与轮询 timer：事件不再探测，周期不再触发', { timeout: 60_000 }, async () => {
  entryCleanup = installProductionEntry(CURRENT_ENTRY)
  await withTimings({ pollIntervalMs: 40, visibilityThrottleMs: 0 }, async () => {
    harness = mountWatcher()
    const h = harness
    await flush(220)
    assert.ok(h.fetchCalls.length >= 1, '卸载前轮询已产生探测')
    h.unmount()

    const frozen = h.fetchCalls.length
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 140))
    })
    act(() => {
      dispatchVisibility(true)
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('vite:preloadError'))
    })
    await flush(60)
    assert.equal(h.fetchCalls.length, frozen, '卸载后不再探测')
    assert.equal(h.reloads(), 0, '卸载后 preloadError 不刷新')
  })
})

// ---------------------------------------------------------------------------
// Provider 集成：SSE snapshot 的 bootId 暴露为 store.kernelBootId
// ---------------------------------------------------------------------------

test('HelmStoreProvider：snapshot 把 bootId 暴露到 store.kernelBootId，重连换代后推进', { timeout: 60_000 }, async () => {
  const { HelmStoreProvider } = await import('../src/lib/HelmStoreProvider.js')
  const { useHelmStore } = await import('../src/lib/store-context.js')

  const encoder = new TextEncoder()
  const conv = (id: number) => ({
    id,
    title: `c${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'm',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  const snapshotOf = (bootId: string): string =>
    `event: snapshot\ndata: ${JSON.stringify({ bootId, seq: 1, conversations: [conv(1)], pendingAsks: [], plugins: [], ui: [] })}\n\n`

  interface StreamHandle {
    stream: ReadableStream<Uint8Array>
    send: (text: string) => void
    end: () => void
  }
  const makeHandle = (signal?: AbortSignal | null): StreamHandle => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let ended = false
    const finish = (): void => {
      if (ended) return
      ended = true
      signal?.removeEventListener('abort', finish)
      try {
        controller?.close()
      } catch {
        /* 已关/已取消：幂等 */
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
      send: (text) => {
        if (!ended) controller?.enqueue(encoder.encode(text))
      },
      end: finish,
    }
  }

  // 连接请求先到而工厂未注册时挂起（与 sse-resume.test.tsx 同约定的确定性队列）。
  type StreamFactory = (signal: AbortSignal | null) => StreamHandle
  const factories: StreamFactory[] = []
  const waiting: Array<{ signal: AbortSignal | null; resolve: (handle: StreamHandle) => void }> = []
  const liveHandles: StreamHandle[] = []
  const takeHandle = (signal: AbortSignal | null): Promise<StreamHandle> => {
    const factory = factories.shift()
    if (factory !== undefined) return Promise.resolve(factory(signal))
    return new Promise((resolve) => {
      waiting.push({ signal, resolve })
    })
  }
  const nextEvents = (factory: StreamFactory): void => {
    const pending = waiting.shift()
    if (pending !== undefined) {
      pending.resolve(factory(pending.signal))
      return
    }
    factories.push(factory)
  }

  const originalTimings = { ...sseClientTimings }
  Object.assign(sseClientTimings, {
    reconnectBaseMs: 15,
    reconnectCapMs: 60,
    reconnectJitterMs: 5,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/status') {
      return new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (path === '/api/events' || path.startsWith('/api/events?')) {
      const handle = await takeHandle(init?.signal ?? null)
      liveHandles.push(handle)
      return new Response(handle.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  let observedBootId: string | null = null
  const Probe = (): React.ReactNode => {
    const store = useHelmStore()
    observedBootId = store.kernelBootId ?? null
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const waitFor = async (expected: string, ms = 15_000): Promise<void> => {
    const deadline = Date.now() + ms
    while (observedBootId !== expected) {
      if (Date.now() > deadline) throw new Error(`waitFor kernelBootId=${expected} 超时，当前 ${observedBootId}`)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    }
  }
  try {
    // 第一条连接（先注册工厂再挂载，避免连接先到挂起）：boot-1 快照
    nextEvents((signal) => {
      const handle = makeHandle(signal)
      handle.send(snapshotOf('boot-1'))
      return handle
    })
    await act(async () => {
      root.render(
        <HelmStoreProvider>
          <Probe />
        </HelmStoreProvider>,
      )
    })
    await waitFor('boot-1')

    // 断开第一条连接，重连（指数退避）后 boot-2 快照 → kernelBootId 推进
    const first = liveHandles[0]
    assert.ok(first !== undefined)
    nextEvents((signal) => {
      const handle = makeHandle(signal)
      handle.send(snapshotOf('boot-2'))
      return handle
    })
    await act(async () => {
      first.end()
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await waitFor('boot-2')
  } finally {
    await act(async () => {
      root.unmount()
    })
    for (const handle of liveHandles) handle.end()
    Object.assign(sseClientTimings, originalTimings)
    globalThis.fetch = originalFetch
    host.remove()
  }
})
