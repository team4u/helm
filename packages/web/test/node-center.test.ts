import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import * as ReactDOMClient from 'react-dom/client'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement

// 导入待测组件与模型
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
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore } from './helpers/store.js'

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
// 1. 模型纯函数测试：搜索过滤、分类计数、在线统计
// ---------------------------------------------------------------------------

test('node-center-model: isNodeOnline 多态判定', { timeout: 60_000 }, () => {
  assert.equal(isNodeOnline({ id: 'a', online: true }), true)
  assert.equal(isNodeOnline({ id: 'b', status: 'online' }), true)
  assert.equal(isNodeOnline({ id: 'c', connected: true }), true)
  assert.equal(isNodeOnline({ id: 'd', online: false, status: 'offline', connected: false }), false)
  assert.equal(isNodeOnline({ id: 'e' }), false)
})

test('node-center-model: isNodeLocal 识别本机', { timeout: 60_000 }, () => {
  assert.equal(isNodeLocal({ id: 'local' }), true)
  assert.equal(isNodeLocal({ id: 'any-id', kind: 'local' }), true)
  assert.equal(isNodeLocal({ id: 'worker-1', kind: 'byom' }), false)
})

test('node-center-model: getNodeDisplayName 名称格式化', { timeout: 60_000 }, () => {
  assert.equal(getNodeDisplayName({ id: 'local', label: '工作区核心' }), '工作区核心')
  assert.equal(getNodeDisplayName({ id: 'local' }), '本机内核')
  assert.equal(getNodeDisplayName({ id: 'node-x' }), 'node-x')
})

test('node-center-model: formatNodePlatformArch 平台与架构组合', { timeout: 60_000 }, () => {
  assert.equal(formatNodePlatformArch({ id: '1', platform: 'linux', arch: 'x64' }), 'linux / x64')
  assert.equal(formatNodePlatformArch({ id: '2', os: 'darwin', arch: 'arm64' }), 'darwin / arm64')
  assert.equal(formatNodePlatformArch({ id: '3', platform: 'win32' }), 'win32')
  assert.equal(formatNodePlatformArch({ id: '4' }), '--')
})

test('node-center-model: buildNodeCategoryCounts 与 summarizeNodes 准确统计各分类指标', { timeout: 60_000 }, () => {
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

test('node-center-model: filterNodes 分类 Tab 过滤', { timeout: 60_000 }, () => {
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

test('node-center-model: filterNodes 多维搜索过滤（id, label, platform, arch, version, os, hostname）', { timeout: 60_000 }, () => {
  const nodes = mockNodes()

  // 1. 匹配 ID
  assert.equal(filterNodes(nodes, { query: 'worker-gpu', categoryTab: 'all' }).length, 1)

  // 2. 匹配 Label
  assert.equal(filterNodes(nodes, { query: '推理集群', categoryTab: 'all' }).length, 1)

  // 3. 匹配 Platform / OS
  assert.equal(filterNodes(nodes, { query: 'darwin', categoryTab: 'all' }).length, 1)

  // 4. 匹配 Arch
  assert.equal(filterNodes(nodes, { query: 'arm64', categoryTab: 'all' }).length, 2)

  // 5. 匹配 Version
  assert.equal(filterNodes(nodes, { query: '0.2.1', categoryTab: 'all' }).length, 1)

  // 6. 匹配 Hostname
  assert.equal(filterNodes(nodes, { query: 'dev-box', categoryTab: 'all' }).length, 1)

  // 7. 搜索无结果
  assert.equal(filterNodes(nodes, { query: 'non-existing-keyword', categoryTab: 'all' }).length, 0)

  // 8. 组合搜索与分类过滤
  assert.equal(filterNodes(nodes, { query: 'arm64', categoryTab: 'offline' }).length, 1)
})

// ---------------------------------------------------------------------------
// 2. 卡片组件 SSR 渲染与交互测试
// ---------------------------------------------------------------------------

test('NodeCard: SSR 渲染包含节点名、架构徽章、在线指示器与 0 Emoji', { timeout: 60_000 }, () => {
  const nodes = mockNodes()
  const localNode = nodes[0]!
  const remoteNode = nodes[1]!
  const offlineNode = nodes[2]!

  // 1. 在线本机节点
  const localHtml = renderToStaticMarkup(
    e(NodeCard, {
      node: localNode,
      selected: false,
      onSelect: () => {},
    }),
  )

  assert.match(localHtml, /primary-card/)
  assert.match(localHtml, /本机开发微内核/)
  assert.match(localHtml, /local/)
  assert.match(localHtml, /linux \/ x64/)
  assert.match(localHtml, /status-dot-done status-dot-working/)
  assert.match(localHtml, /在线/)
  assert.match(localHtml, /bash/)
  assert.match(localHtml, /read/)
  assert.doesNotMatch(localHtml, EMOJI_REGEX)

  // 2. 选中态类名
  const selectedHtml = renderToStaticMarkup(
    e(NodeCard, {
      node: remoteNode,
      selected: true,
      onSelect: () => {},
    }),
  )
  assert.match(selectedHtml, /is-selected/)
  assert.match(selectedHtml, /aria-selected="true"/)
  assert.match(selectedHtml, /GPU 推理集群节点 A/)
  assert.match(selectedHtml, /worker-gpu-1/)
  assert.match(selectedHtml, /linux \/ arm64/)
  assert.doesNotMatch(selectedHtml, EMOJI_REGEX)

  // 3. 离线节点
  const offlineHtml = renderToStaticMarkup(
    e(NodeCard, {
      node: offlineNode,
      selected: false,
      onSelect: () => {},
    }),
  )
  assert.match(offlineHtml, /离线/)
  assert.doesNotMatch(offlineHtml, /status-dot-done/)
  assert.doesNotMatch(offlineHtml, EMOJI_REGEX)
})

test('NodeCard: 点击与 Enter/Space 键盘交互激活 onSelect', { timeout: 60_000 }, () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)

  let selectCount = 0
  const node = mockNodes()[0]!

  act(() => {
    root.render(
      e(NodeCard, {
        node,
        selected: false,
        onSelect: () => {
          selectCount++
        },
      }),
    )
  })

  const card = container.querySelector('.primary-card') as HTMLElement
  assert.ok(card, '必须渲染 .primary-card')

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
// 3. 抽屉组件 SSR 渲染测试 (inline={true})
// ---------------------------------------------------------------------------

test('NodeDetailDrawer: SSR 渲染系统概览、体检信息、接入命令行与 0 Emoji', { timeout: 60_000 }, () => {
  const remoteNode = mockNodes()[1]!
  const store = makeTestStore()

  const html = renderToStaticMarkup(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(NodeDetailDrawer, {
        node: remoteNode,
        open: true,
        onClose: () => {},
        inline: true,
      }),
    ),
  )

  // 1. 结构与语义
  assert.match(html, /role="dialog"/)
  assert.match(html, /primary-drawer-content/)
  assert.match(html, /GPU 推理集群节点 A/)
  assert.match(html, /worker-gpu-1/)
  assert.match(html, /在线/)

  // 2. 系统概览
  assert.match(html, /系统概览/)
  assert.match(html, /操作系统/)
  assert.match(html, /CPU 架构/)
  assert.match(html, /arm64/)
  assert.match(html, /gpu-server-01/)
  assert.match(html, /\/opt\/helm-worker/)

  // 3. 健康体检与资源负载
  assert.match(html, /健康体检与资源负载/)
  assert.match(html, /健康体检/)
  assert.match(html, /CPU 占用/)
  assert.match(html, /68%/)
  assert.match(html, /系统负载/)

  // 4. 受控机接入指令与一键接入命令
  assert.match(html, /受控机接入指令/)
  assert.match(html, /helm-node start -d/)
  assert.match(html, /--token/)
  assert.match(html, /签发接入令牌/)
  assert.match(html, /helm-node doctor/)

  // 5. 注册工具能力
  assert.match(html, /注册工具能力/)
  assert.match(html, /env_exec/)

  // 6. 零 Emoji
  assert.doesNotMatch(html, EMOJI_REGEX)
})

test('NodeDetailDrawer: 接入新节点模式 (isNew={true}) 正确渲染', { timeout: 60_000 }, () => {
  const html = renderToStaticMarkup(
    e(
      HelmStoreContext.Provider,
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

  assert.match(html, /接入新计算节点/)
  assert.match(html, /节点 ID/)
  assert.match(html, /签发接入令牌/)
  assert.doesNotMatch(html, EMOJI_REGEX)
})

// ---------------------------------------------------------------------------
// 4. 节点中心主视图 SSR 渲染与状态联动测试 (inlineDrawer={true})
// ---------------------------------------------------------------------------

test('NodeCenter: SSR 渲染顶栏、检索工具栏、分类药丸、网格流与 0 Emoji', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    nodes: mockNodes() as any,
    primaryTarget: { kind: 'nodes' },
  })

  const html = renderToStaticMarkup(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(NodeCenter, {
        inlineDrawer: true,
      }),
    ),
  )

  // 1. 顶栏
  assert.match(html, /primary-center/)
  assert.match(html, /node-center/)
  assert.match(html, /计算节点中心/)
  assert.match(html, /接入节点/)

  // 2. 检索栏与分类药丸
  assert.match(html, /primary-search-box/)
  assert.match(html, /搜索节点 ID、名称、平台架构、版本或操作系统/)
  assert.match(html, /primary-category-pill/)
  assert.match(html, /全部/)
  assert.match(html, /本机/)
  assert.match(html, /远端/)
  assert.match(html, /在线/)
  assert.match(html, /离线/)

  // 3. 卡片网格
  assert.match(html, /primary-center-grid/)
  assert.match(html, /本机开发微内核/)
  assert.match(html, /GPU 推理集群节点 A/)
  assert.match(html, /离线备用计算节点/)

  // 4. 零 Emoji
  assert.doesNotMatch(html, EMOJI_REGEX)
})

test('NodeCenter: 分屏模式支持 isSplit 与 onCloseSplit', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    nodes: mockNodes() as any,
    primaryTarget: { kind: 'nodes' },
  })

  let closed = false
  const html = renderToStaticMarkup(
    e(
      HelmStoreContext.Provider,
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
  assert.match(html, /关闭分屏/)
})

test('NodeCenter: 选中节点时通过 primaryTarget 唤起抽屉详情', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    nodes: mockNodes() as any,
    primaryTarget: { kind: 'nodes', nodeId: 'worker-gpu-1' },
  })

  const html = renderToStaticMarkup(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(NodeCenter, {
        inlineDrawer: true,
      }),
    ),
  )

  // 抽屉被展开
  assert.match(html, /role="dialog"/)
  assert.match(html, /GPU 推理集群节点 A/)
  assert.match(html, /系统概览/)
})

test('NodeCenter: 空节点列表渲染友好空状态与重置按钮', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    nodes: [],
    primaryTarget: { kind: 'nodes' },
  })

  const html = renderToStaticMarkup(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(NodeCenter, {
        inlineDrawer: true,
      }),
    ),
  )

  assert.match(html, /primary-center-empty/)
  assert.match(html, /未找到匹配的计算节点/)
  assert.doesNotMatch(html, EMOJI_REGEX)
})

// ---------------------------------------------------------------------------
// 5. 源码静态扫描 0 Emoji 铁律
// ---------------------------------------------------------------------------

test('静态扫描: nodes/ 目录下所有源码绝对 0 Emoji', { timeout: 60_000 }, () => {
  const files = [
    'src/nodes/node-center-model.ts',
    'src/nodes/NodeCard.tsx',
    'src/nodes/NodeDetailDrawer.tsx',
    'src/nodes/NodeCenter.tsx',
  ]

  for (const rel of files) {
    const full = join(PKG_ROOT, rel)
    const content = readFileSync(full, 'utf-8')
    assert.doesNotMatch(
      content,
      EMOJI_REGEX,
      `${rel} 源码中严禁含有任何 Emoji 表情图标`,
    )
  }
})
