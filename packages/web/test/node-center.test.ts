import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import type { HelmLocale } from '@helm/protocol/browser'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()
const ReactDOMClient = await import('react-dom/client')

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement

// Import the components and models under test
import {
  buildNodeCategoryCounts,
  filterNodes,
  formatNodePlatformArch,
  getNodeDisplayName,
  isNodeLocal,
  isNodeOnline,
  summarizeNodes,
  type NodeCategoryTab,
  type NodeInfo,
} from '../src/nodes/node-center-model.js'
import { NodeCard } from '../src/nodes/NodeCard.js'
import { NodeDetailDrawer } from '../src/nodes/NodeDetailDrawer.js'
import { NodeCenter } from '../src/nodes/NodeCenter.js'
import { createWebTranslator } from '../src/i18n/catalog.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

function mockNodes(): Array<NodeInfo & { kind: 'local' | 'byom'; online: boolean }> {
  return [
    {
      id: 'local',
      kind: 'local',
      label: '本机开发微内核',
      online: true,
      platform: 'linux',
      arch: 'x64',
      os: 'linux',
      version: '0.1.0',
      hostname: 'dev-box',
      cwd: '/root/code/helm',
      hubUrl: 'ipc:///tmp/helm.sock',
      tools: ['bash', 'read', 'write', 'edit'],
      health: {
        collectedAt: Date.now(),
        uptimeSec: 86400,
        loadAvg: [0.45, 0.32, 0.28],
        cpuUsagePercent: 12,
        load1: 0.45,
        load5: 0.32,
        load15: 0.28,
        memFreeBytes: 8 * 1024 * 1024 * 1024,
        memTotalBytes: 16 * 1024 * 1024 * 1024,
        diskFreeBytes: 80 * 1024 * 1024 * 1024,
        diskTotalBytes: 256 * 1024 * 1024 * 1024,
      },
    },
    {
      id: 'worker-gpu-1',
      kind: 'byom',
      label: 'GPU 推理集群节点 A',
      online: true,
      status: 'online',
      platform: 'linux',
      arch: 'arm64',
      os: 'linux',
      version: '0.2.1',
      hostname: 'gpu-server-01',
      cwd: '/opt/helm-worker',
      hubUrl: 'http://192.168.1.100:3202',
      tools: ['bash', 'read', 'write', 'edit', 'env_exec'],
      health: {
        collectedAt: Date.now(),
        uptimeSec: 3600 * 72,
        loadAvg: [3.12, 2.85, 2.14],
        cpuUsagePercent: 68,
        load1: 3.12,
        load5: 2.85,
        load15: 2.14,
        memFreeBytes: 32 * 1024 * 1024 * 1024,
        memTotalBytes: 64 * 1024 * 1024 * 1024,
        diskFreeBytes: 500 * 1024 * 1024 * 1024,
        diskTotalBytes: 1024 * 1024 * 1024 * 1024,
      },
    },
    {
      id: 'worker-offline',
      kind: 'byom',
      label: '离线备用计算节点',
      online: false,
      connected: false,
      status: 'offline',
      platform: 'darwin',
      arch: 'arm64',
      os: 'darwin',
      version: '0.1.8',
      hostname: 'mac-mini-m2',
      cwd: '/Users/admin/helm',
      tools: ['bash', 'read'],
    },
  ]
}

// ---------------------------------------------------------------------------
// 1. Pure model tests: search filtering, category counting, online metrics
// ---------------------------------------------------------------------------

test('node-center-model: isNodeOnline accepts all three online shapes', { timeout: 60_000 }, () => {
  assert.equal(isNodeOnline({ id: 'a', online: true }), true)
  assert.equal(isNodeOnline({ id: 'b', status: 'online' }), true)
  assert.equal(isNodeOnline({ id: 'c', connected: true }), true)
  assert.equal(isNodeOnline({ id: 'd', online: false, status: 'offline', connected: false }), false)
  assert.equal(isNodeOnline({ id: 'e' }), false)
})

test('node-center-model: isNodeLocal detects the local node', { timeout: 60_000 }, () => {
  assert.equal(isNodeLocal({ id: 'local' }), true)
  assert.equal(isNodeLocal({ id: 'any-id', kind: 'local' }), true)
  assert.equal(isNodeLocal({ id: 'worker-1', kind: 'byom' }), false)
})

test('node-center-model: getNodeDisplayName formats display names', { timeout: 60_000 }, () => {
  assert.equal(getNodeDisplayName({ id: 'local', label: '工作区核心' }), '工作区核心')
  assert.equal(getNodeDisplayName({ id: 'local' }), 'Local kernel')
  assert.equal(getNodeDisplayName({ id: 'node-x' }), 'node-x')
})

test('node-center-model zh-CN: getNodeDisplayName resolves fallbacks through the zh translator', { timeout: 60_000 }, () => {
  const zh = createWebTranslator('zh-CN')
  assert.equal(getNodeDisplayName({ id: 'local' }, zh), '本机内核')
  assert.equal(getNodeDisplayName({ id: '' }, zh), '未知节点')
  // Labels always win and are trimmed, regardless of locale
  assert.equal(getNodeDisplayName({ id: 'x', label: '  GPU 推理集群节点 A  ' }, zh), 'GPU 推理集群节点 A')
  // The default translator keeps the English bridge behavior
  assert.equal(getNodeDisplayName({ id: 'local' }), 'Local kernel')
})

test('node-center-model: formatNodePlatformArch combines platform and architecture', { timeout: 60_000 }, () => {
  assert.equal(formatNodePlatformArch({ id: '1', platform: 'linux', arch: 'x64' }), 'linux / x64')
  assert.equal(formatNodePlatformArch({ id: '2', os: 'darwin', arch: 'arm64' }), 'darwin / arm64')
  assert.equal(formatNodePlatformArch({ id: '3', platform: 'win32' }), 'win32')
  assert.equal(formatNodePlatformArch({ id: '4' }), '--')
})

test('node-center-model: buildNodeCategoryCounts and summarizeNodes count every category metric accurately', { timeout: 60_000 }, () => {
  const nodes = mockNodes()
  const counts = buildNodeCategoryCounts(nodes)

  assert.equal(counts.all, 3)
  assert.equal(counts.local, 1)
  assert.equal(counts.remote, 2)
  assert.equal(counts.online, 2)
  assert.equal(counts.offline, 1)

  const summary = summarizeNodes(nodes)
  assert.equal(summary.total, 3)
  assert.equal(summary.online, 2)
  assert.equal(summary.local, 1)
  assert.equal(summary.remote, 2)
})

test('node-center-model: filterNodes category tab filtering', { timeout: 60_000 }, () => {
  const nodes = mockNodes()

  const all = filterNodes(nodes, { query: '', categoryTab: 'all' })
  assert.equal(all.length, 3)

  const local = filterNodes(nodes, { query: '', categoryTab: 'local' })
  assert.equal(local.length, 1)
  assert.equal(local[0]?.id, 'local')

  const remote = filterNodes(nodes, { query: '', categoryTab: 'remote' })
  assert.equal(remote.length, 2)
  assert.ok(remote.every((n) => n.id !== 'local'))

  const online = filterNodes(nodes, { query: '', categoryTab: 'online' })
  assert.equal(online.length, 2)
  assert.ok(online.every((n) => isNodeOnline(n)))

  const offline = filterNodes(nodes, { query: '', categoryTab: 'offline' })
  assert.equal(offline.length, 1)
  assert.equal(offline[0]?.id, 'worker-offline')
})

test('node-center-model: filterNodes multi-dimensional search (id, label, platform, arch, version, os, hostname)', { timeout: 60_000 }, () => {
  const nodes = mockNodes()

  // 1. Match ID
  assert.equal(filterNodes(nodes, { query: 'worker-gpu', categoryTab: 'all' }).length, 1)

  // 2. Match label
  assert.equal(filterNodes(nodes, { query: '推理集群', categoryTab: 'all' }).length, 1)

  // 3. Match platform / OS
  assert.equal(filterNodes(nodes, { query: 'darwin', categoryTab: 'all' }).length, 1)

  // 4. Match arch
  assert.equal(filterNodes(nodes, { query: 'arm64', categoryTab: 'all' }).length, 2)

  // 5. Match version
  assert.equal(filterNodes(nodes, { query: '0.2.1', categoryTab: 'all' }).length, 1)

  // 6. Match hostname
  assert.equal(filterNodes(nodes, { query: 'dev-box', categoryTab: 'all' }).length, 1)

  // 7. No search hits
  assert.equal(filterNodes(nodes, { query: 'non-existing-keyword', categoryTab: 'all' }).length, 0)

  // 8. Combined search and category filter
  assert.equal(filterNodes(nodes, { query: 'arm64', categoryTab: 'offline' }).length, 1)
})

// ---------------------------------------------------------------------------
// 2. Card component SSR rendering and interaction tests
// ---------------------------------------------------------------------------

test('NodeCard: SSR renders node name, architecture badge, online indicator with zero Emoji', { timeout: 60_000 }, () => {
  const nodes = mockNodes()
  const localNode = nodes[0]!
  const remoteNode = nodes[1]!
  const offlineNode = nodes[2]!

  // 1. Online local node
  const localHtml = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(NodeCard, {
        node: localNode,
        selected: false,
        onSelect: () => {},
      }),
    ),
  )

  assert.match(localHtml, /primary-card/)
  assert.match(localHtml, /本机开发微内核/)
  assert.match(localHtml, /local/)
  assert.match(localHtml, /linux \/ x64/)
  assert.match(localHtml, /status-dot-done status-dot-working/)
  assert.match(localHtml, /Online/)
  assert.match(localHtml, /bash/)
  assert.match(localHtml, /read/)
  assert.doesNotMatch(localHtml, EMOJI_REGEX)

  // 2. Selected-state class names
  const selectedHtml = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(NodeCard, {
        node: remoteNode,
        selected: true,
        onSelect: () => {},
      }),
    ),
  )
  assert.match(selectedHtml, /is-selected/)
  assert.match(selectedHtml, /aria-selected="true"/)
  assert.match(selectedHtml, /GPU 推理集群节点 A/)
  assert.match(selectedHtml, /worker-gpu-1/)
  assert.match(selectedHtml, /linux \/ arm64/)
  assert.doesNotMatch(selectedHtml, EMOJI_REGEX)

  // 3. Offline node
  const offlineHtml = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(NodeCard, {
        node: offlineNode,
        selected: false,
        onSelect: () => {},
      }),
    ),
  )
  assert.match(offlineHtml, /离线/)
  assert.doesNotMatch(offlineHtml, /status-dot-done/)
  assert.doesNotMatch(offlineHtml, EMOJI_REGEX)
})

test('NodeCard: click and Enter/Space keyboard interaction activate onSelect', { timeout: 60_000 }, () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let selectCount = 0
  const node = mockNodes()[0]!

  act(() => {
    root.render(
      e(
        HostStoreProviders,
        { value: makeTestStore() },
        e(NodeCard, {
          node,
          selected: false,
          onSelect: () => {
            selectCount++
          },
        }),
      ),
    )
  })

  const card = container.querySelector('.primary-card') as HTMLElement
  assert.ok(card, 'must render .primary-card')

  act(() => {
    card.click()
  })
  assert.equal(selectCount, 1)

  act(() => {
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  assert.equal(selectCount, 2)

  act(() => {
    card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
  })
  assert.equal(selectCount, 3)

  act(() => {
    root.unmount()
  })
  container.remove()
})

// ---------------------------------------------------------------------------
// 3. Drawer component SSR rendering tests (inline={true})
// ---------------------------------------------------------------------------

test('NodeDetailDrawer: SSR renders system overview, health data, enrollment command with zero Emoji', { timeout: 60_000 }, () => {
  const remoteNode = mockNodes()[1]!
  const store = makeTestStore()

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(NodeDetailDrawer, {
        node: remoteNode,
        open: true,
        onClose: () => {},
        inline: true,
      }),
    ),
  )

  // 1. Structure and semantics
  assert.match(html, /role="dialog"/)
  assert.match(html, /primary-drawer-content/)
  assert.match(html, /GPU 推理集群节点 A/)
  assert.match(html, /worker-gpu-1/)
  assert.match(html, /Online/)

  // 2. System overview
  assert.match(html, /System overview/)
  assert.match(html, /Operating system/)
  assert.match(html, /CPU architecture/)
  assert.match(html, /arm64/)
  assert.match(html, /gpu-server-01/)
  assert.match(html, /\/opt\/helm-worker/)

  // 3. Health check and resource load
  assert.match(html, /Health check and resource load/)
  assert.match(html, /Health check/)
  assert.match(html, /CPU usage/)
  assert.match(html, /68%/)
  assert.match(html, /System load/)

  // 4. Controlled machine enrollment command and one-line command
  assert.match(html, /Controlled machine enrollment command/)
  assert.match(html, /helm-node start -d/)
  assert.match(html, /--token/)
  assert.match(html, /Issue access token/)
  assert.match(html, /helm-node doctor/)

  // 5. Registered tools
  assert.match(html, /Registered tools/)
  assert.match(html, /env_exec/)

  // 6. Zero Emoji
  assert.doesNotMatch(html, EMOJI_REGEX)
})

test('NodeDetailDrawer: new-node enrollment mode (isNew={true}) renders correctly', { timeout: 60_000 }, () => {
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(NodeDetailDrawer, {
        node: null,
        open: true,
        isNew: true,
        onClose: () => {},
        inline: true,
      }),
    ),
  )

  assert.match(html, /Connect a new compute node/)
  assert.match(html, /Node ID/)
  assert.match(html, /Issue access token/)
  assert.doesNotMatch(html, EMOJI_REGEX)
})

// ---------------------------------------------------------------------------
// 4. Node center primary view SSR rendering and state wiring (inlineDrawer={true})
// ---------------------------------------------------------------------------

test('NodeCenter: SSR renders top bar, search toolbar, category pills, grid flow with zero Emoji', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    nodes: mockNodes() as any,
    primaryTarget: { kind: 'nodes' },
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(NodeCenter, {
        inlineDrawer: true,
      }),
    ),
  )

  // 1. Top bar
  assert.match(html, /primary-center/)
  assert.match(html, /node-center/)
  assert.match(html, /Compute Nodes Center/)
  assert.match(html, /Connect node/)

  // 2. Search bar and category pills
  assert.match(html, /primary-search-box/)
  assert.match(html, /Search node ID, name, platform, version or OS/)
  assert.match(html, /primary-category-pill/)
  assert.match(html, /All/)
  assert.match(html, /本机/)
  assert.match(html, /Remote/)
  assert.match(html, /Online/)
  assert.match(html, /离线/)

  // 3. Card grid
  assert.match(html, /primary-center-grid/)
  assert.match(html, /本机开发微内核/)
  assert.match(html, /GPU 推理集群节点 A/)
  assert.match(html, /离线备用计算节点/)

  // 4. Zero Emoji
  assert.doesNotMatch(html, EMOJI_REGEX)
})

test('NodeCenter: split mode supports isSplit and onCloseSplit', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    nodes: mockNodes() as any,
    primaryTarget: { kind: 'nodes' },
  })

  let closed = false
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(NodeCenter, {
        isSplit: true,
        onCloseSplit: () => {
          closed = true
        },
        inlineDrawer: true,
      }),
    ),
  )

  assert.match(html, /is-split/)
  assert.match(html, /Close split view/)
})

test('NodeCenter: selecting a node opens the drawer details via primaryTarget', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    nodes: mockNodes() as any,
    primaryTarget: { kind: 'nodes', nodeId: 'worker-gpu-1' },
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(NodeCenter, {
        inlineDrawer: true,
      }),
    ),
  )

  // Drawer opened
  assert.match(html, /role="dialog"/)
  assert.match(html, /GPU 推理集群节点 A/)
  assert.match(html, /System overview/)
})

test('NodeCenter: empty node list renders a friendly empty state with reset button', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    nodes: [],
    primaryTarget: { kind: 'nodes' },
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(NodeCenter, {
        inlineDrawer: true,
      }),
    ),
  )

  assert.match(html, /primary-center-empty/)
  assert.match(html, /No matching compute nodes/)
  assert.doesNotMatch(html, EMOJI_REGEX)
})

// ---------------------------------------------------------------------------
// 5. Source static scans: zero-Emoji rules
// ---------------------------------------------------------------------------

test('static scan: no inline style remains in nodes/ sources', { timeout: 60_000 }, () => {
  const files = [
    'src/nodes/node-center-model.ts',
    'src/nodes/NodeCard.tsx',
    'src/nodes/NodeDetailDrawer.tsx',
    'src/nodes/NodeCenter.tsx',
  ]

  for (const rel of files) {
    const full = join(PKG_ROOT, rel)
    const content = readFileSync(full, 'utf-8')
    assert.ok(!content.includes('style='), `${rel} sources must not keep inline style`)
  }
})

test('NodeCard & NodeDetailDrawer: fixed top-right .btn-icon-sm and unified .callout-ok / .callout-error', { timeout: 60_000 }, async () => {
  const cardHtml = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: makeTestStore() },
      e(NodeCard, { node: mockNodes()[1]!, onSelect: () => {} }),
    ),
  )
  assert.match(cardHtml, /GPU 推理集群节点 A/)
  assert.ok(!cardHtml.includes('primary-card-desc'), 'NodeCard status badges must not be wrapped by the 2-line clamp container')

  const store = makeTestStore({ nodes: mockNodes() as never })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: '节点内核离线' }), { status: 503 })) as typeof fetch

  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(NodeDetailDrawer, {
            node: mockNodes()[1]!,
            open: true,
            inline: true,
            onClose: () => {},
          }),
        ),
      )
    })

    assert.ok(container.querySelector('.btn-icon-sm'), 'NodeDetailDrawer close button must use .btn-icon-sm')
    const healthBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Health check'),
    )
    assert.ok(healthBtn)
    await act(async () => {
      healthBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {})
    const errCallout = container.querySelector('.callout.callout-error')
    assert.ok(errCallout, 'a failed health check must surface the unified .callout-error')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})

// ---------------------------------------------------------------------------
// 6. zh-CN locale rendering and live locale switching
// ---------------------------------------------------------------------------

test('NodeCenter zh-CN: renders center chrome, category pills and NodeDetailDrawer copy in Chinese', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    locale: 'zh-CN',
    nodes: mockNodes() as any,
    primaryTarget: { kind: 'nodes', nodeId: 'worker-gpu-1' },
  })

  const html = renderToString(
    e(
      HostStoreProviders,
      { value: store },
      e(NodeCenter, { inlineDrawer: true }),
    ),
  )

  // Center chrome and search placeholder
  assert.match(html, /计算节点中心/)
  assert.match(html, /接入节点/)
  assert.match(html, /搜索节点 ID、名称、平台架构、版本或操作系统…/)

  // Category pills (shared common.* plus domain copy) follow the locale
  assert.match(html, /全部/)
  assert.match(html, /本机/)
  assert.match(html, /远端/)
  assert.match(html, /在线/)
  assert.match(html, /离线/)

  // Drawer copy localized (system overview labels + tools section)
  assert.match(html, /系统概览/)
  assert.match(html, /操作系统/)
  assert.match(html, /注册工具能力/)
  assert.equal(EMOJI_REGEX.test(html), false)
})

test('NodeCenter locale switch: setLocale re-renders en -> zh-CN -> en in place', { timeout: 60_000 }, async () => {
  function LocaleSwitchHarness(): React.JSX.Element {
    const [locale, setLocale] = React.useState<HelmLocale>('en')
    const store = React.useMemo(
      () =>
        makeTestStore({
          locale,
          setLocale: (next: HelmLocale) => setLocale(next),
          nodes: mockNodes() as any,
          primaryTarget: { kind: 'nodes' },
        }),
      [locale],
    )
    return e(
      HostStoreProviders,
      { value: store },
      e(NodeCenter, { inlineDrawer: true }),
      e(
        'button',
        { type: 'button', onClick: () => setLocale(locale === 'en' ? 'zh-CN' : 'en') },
        'switch-locale',
      ),
    )
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  try {
    await act(async () => {
      root.render(e(LocaleSwitchHarness))
    })
    assert.match(container.textContent ?? '', /Compute Nodes Center/)
    assert.match(container.textContent ?? '', /Remote/, 'en category pill label')

    const switchBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'switch-locale',
    ) as HTMLButtonElement
    assert.ok(switchBtn !== undefined, 'locale switch harness button must exist')

    await act(async () => {
      switchBtn.click()
    })
    assert.match(container.textContent ?? '', /计算节点中心/, 'consumers re-render in Chinese immediately')
    assert.match(container.textContent ?? '', /远端/, 'zh category pill label')

    await act(async () => {
      switchBtn.click()
    })
    assert.match(container.textContent ?? '', /Compute Nodes Center/, 'switching back to en restores English immediately')
    assert.match(container.textContent ?? '', /Remote/)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
