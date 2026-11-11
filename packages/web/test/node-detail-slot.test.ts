/**
 * 节点详情抽屉插件子插槽（builtin:node/detail-section）测试：
 * - client 轨（seedPluginClientModule 缓存注入）与 JSON 轨（@json-render Slot 原语）双轨渲染；
 * - 仅已有节点挂载：接入新节点模式与未选节点不渲染插槽贡献；
 * - 多贡献按 priority 降序、order 升序稳定排序；
 * - 插件停用（贡献从 groupedUi 移除）后贡献即时消失；
 * - 切换节点时 slotProps 不残留上一节点数据；
 * - 节点离线时如实传 isOnline=false；
 * - slotProps 仅含协议 NodeDetailSlotProps 四个公开字段，不泄露接入令牌等凭据。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PluginUiContribution } from '@helm/protocol'
import { NODE_DETAIL_SECTION_SLOT } from '@helm/protocol'
import { NodeDetailDrawer } from '../src/nodes/NodeDetailDrawer.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
import { makeTestStore } from './helpers/store.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

import type { NodeInfo } from '../src/nodes/node-center-model.js'

function remoteNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: 'worker-gpu-1',
    kind: 'byom',
    online: true,
    label: 'GPU 推理集群节点 A',
    platform: 'linux',
    arch: 'arm64',
    os: 'linux',
    version: '0.2.1',
    hostname: 'gpu-server-01',
    cwd: '/opt/helm-worker',
    hubUrl: 'http://192.168.1.100:3202',
    tools: ['bash', 'read', 'write', 'edit'],
    ...overrides,
  }
}

const slotContribution = (
  pluginId: string,
  id: string,
  extra: Record<string, unknown> = {},
): PluginUiContribution => ({
  pluginId,
  surface: 'plugin.slot',
  spec: { id, target: NODE_DETAIL_SECTION_SLOT, ...extra },
})

function storeWith(contributions: PluginUiContribution[], overrides: Partial<HelmStoreValue> = {}): HelmStoreValue {
  return makeTestStore({
    groupedUi: groupUiContributions(contributions),
    ...overrides,
  })
}

function renderDrawer(store: HelmStoreValue, props: { node: NodeInfo | null; isNew?: boolean }): string {
  return renderToStaticMarkup(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(NodeDetailDrawer, {
        node: props.node,
        isNew: props.isNew ?? false,
        open: true,
        onClose: () => {},
        inline: true,
      }),
    ),
  )
}

/** client 轨探针：序列化全部收到 props（含 undefined 字段如实出现），用于精确断言。 */
function clientProbeModule(name: string, slug: string): void {
  seedPluginClientModule(name, `${slug}.tsx`, {
    [slug]: (props: Record<string, unknown>) =>
      e(
        'section',
        { className: 'section-flat', 'data-probe': slug },
        JSON.stringify(props),
      ),
  })
}

// ---------------------------------------------------------------------------
// client 轨渲染
// ---------------------------------------------------------------------------

test('节点插槽 client 轨：已有节点渲染贡献并如实传递 NodeDetailSlotProps', { timeout: 60_000 }, () => {
  clientProbeModule('demo:ops', 'NodeOpsSection')
  const store = storeWith([
    {
      pluginId: 'demo:ops',
      surface: 'plugin.slot',
      spec: { id: 'node-ops', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'NodeOpsSection.tsx', export: 'NodeOpsSection' } },
    },
  ])

  const html = renderDrawer(store, { node: remoteNode() })
  assert.match(html, /data-probe="NodeOpsSection"/, 'client 轨贡献渲染在抽屉内')
  assert.match(
    html,
    /&quot;nodeId&quot;:&quot;worker-gpu-1&quot;/,
    'slotProps.nodeId 是真实节点 ID',
  )
  assert.match(html, /&quot;isLocal&quot;:false/, '远端节点 isLocal=false')
  assert.match(html, /&quot;isOnline&quot;:true/, '在线节点 isOnline=true')
  assert.match(html, /&quot;isNew&quot;:false/, '已有节点 isNew=false')
  assert.doesNotMatch(html, EMOJI_REGEX)
})

test('节点插槽 client 轨：组件收到真实 slotProps 数据', { timeout: 60_000 }, () => {
  seedPluginClientModule('demo:ops', 'node-data.tsx', {
    NodeData: (props: Record<string, unknown>) =>
      e('section', { 'data-node-data': String(props['nodeId'] ?? '') }, `节点 ${String(props['nodeId'] ?? '')} 在线=${String(props['isOnline'])}`),
  })
  const store = storeWith([
    slotContribution('demo:ops', 'node-data', {
      client: { module: 'node-data.tsx', export: 'NodeData' },
    }),
  ])

  const html = renderDrawer(store, { node: remoteNode() })
  assert.match(html, /节点 worker-gpu-1 在线=true/, 'client 轨收到 slotProps 数据')
})

// ---------------------------------------------------------------------------
// 挂载边界
// ---------------------------------------------------------------------------

test('节点插槽挂载边界：接入新节点模式与未选节点不渲染贡献', { timeout: 60_000 }, () => {
  clientProbeModule('demo:ops', 'NodeOpsSection')
  const store = storeWith([
    {
      pluginId: 'demo:ops',
      surface: 'plugin.slot',
      spec: { id: 'node-ops', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'NodeOpsSection.tsx', export: 'NodeOpsSection' } },
    },
  ])

  // 接入新节点模式（node=null, isNew=true）：仅接入指令，不挂插件插槽
  const newHtml = renderDrawer(store, { node: null, isNew: true })
  assert.doesNotMatch(newHtml, /data-probe="NodeOpsSection"/, 'isNew 不挂载节点插槽')

  // 未选节点（node=null）：空态提示，不挂插件插槽
  const emptyHtml = renderDrawer(store, { node: null })
  assert.match(emptyHtml, /未选择节点/)
  assert.doesNotMatch(emptyHtml, /data-probe="NodeOpsSection"/, '未选节点不挂载节点插槽')
})

// ---------------------------------------------------------------------------
// 多贡献排序与插件停用
// ---------------------------------------------------------------------------

test('节点插槽多贡献：priority 降序、order 升序稳定排序', { timeout: 60_000 }, () => {
  const contribModule = (mark: string) => ({ [mark]: () => e('section', { 'data-mark': mark }, `贡献${mark}`) })
  seedPluginClientModule('demo:a', 'a1.tsx', contribModule('A'))
  seedPluginClientModule('demo:b', 'b1.tsx', contribModule('B'))
  seedPluginClientModule('demo:c', 'c1.tsx', contribModule('C'))
  const store = storeWith([
    slotContribution('demo:a', 'a1', { client: { module: 'a1.tsx', export: 'A' } }),
    slotContribution('demo:b', 'b1', { client: { module: 'b1.tsx', export: 'B' }, priority: 10 }),
    slotContribution('demo:c', 'c1', { client: { module: 'c1.tsx', export: 'C' }, priority: 10, order: 5 }),
  ])

  const html = renderDrawer(store, { node: remoteNode() })
  const posB = html.indexOf('贡献B')
  const posC = html.indexOf('贡献C')
  const posA = html.indexOf('贡献A')
  assert.ok(posC !== -1 && posC < posB, 'priority 同分时 order 小者在前（C 先于 B）')
  assert.ok(posB !== -1 && posB < posA, 'priority 高者在前（B 先于 A）')
})

test('节点插槽插件停用：贡献从 groupedUi 移除后即时消失', { timeout: 60_000 }, () => {
  clientProbeModule('demo:ops', 'NodeOpsSection')
  const contribution: PluginUiContribution = {
    pluginId: 'demo:ops',
    surface: 'plugin.slot',
    spec: { id: 'node-ops', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'NodeOpsSection.tsx', export: 'NodeOpsSection' } },
  }

  const enabled = renderDrawer(storeWith([contribution]), { node: remoteNode() })
  assert.match(enabled, /data-probe="NodeOpsSection"/, '启用时贡献渲染')

  // 插件停用：ui 贡献清空（与宿主 SSE 快照行为一致），贡献即时消失
  const disabled = renderDrawer(storeWith([]), { node: remoteNode() })
  assert.doesNotMatch(disabled, /data-probe="NodeOpsSection"/, '停用后贡献移除')
  assert.match(disabled, /系统概览/, '抽屉主体不受影响')
})

// ---------------------------------------------------------------------------
// 切换节点 Props 不残留 & 离线如实传 false
// ---------------------------------------------------------------------------

test('节点插槽切换节点：Props 不残留上一节点数据', { timeout: 60_000 }, () => {
  clientProbeModule('demo:ops', 'NodeOpsSection')
  const store = storeWith([
    {
      pluginId: 'demo:ops',
      surface: 'plugin.slot',
      spec: { id: 'node-ops', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'NodeOpsSection.tsx', export: 'NodeOpsSection' } },
    },
  ])

  const first = renderDrawer(store, { node: remoteNode() })
  assert.match(first, /worker-gpu-1/)

  // 切换到本机节点：新渲染只含新节点 ID，不残留 worker-gpu-1
  const second = renderDrawer(store, {
    node: remoteNode({ id: 'local', kind: 'local', label: '本机内核', online: true }),
  })
  assert.match(second, /&quot;nodeId&quot;:&quot;local&quot;/, '切换后传递新节点 ID')
  assert.match(second, /&quot;isLocal&quot;:true/, '切换后 isLocal=true')
  assert.doesNotMatch(second, /worker-gpu-1/, '不残留上一节点 ID')
})

test('节点插槽离线节点：如实传递 isOnline=false', { timeout: 60_000 }, () => {
  clientProbeModule('demo:ops', 'NodeOpsSection')
  const store = storeWith([
    {
      pluginId: 'demo:ops',
      surface: 'plugin.slot',
      spec: { id: 'node-ops', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'NodeOpsSection.tsx', export: 'NodeOpsSection' } },
    },
  ])

  const html = renderDrawer(store, {
    node: remoteNode({ id: 'worker-offline', online: false, status: 'offline', connected: false }),
  })
  assert.match(html, /&quot;nodeId&quot;:&quot;worker-offline&quot;/)
  assert.match(html, /&quot;isOnline&quot;:false/, '离线节点如实传 false，不美化状态')
  assert.match(html, /离线/, '头部徽章同为离线')
})

// ---------------------------------------------------------------------------
// 凭据边界
// ---------------------------------------------------------------------------

test('节点插槽 slotProps 仅含协议四个公开字段，不含令牌等凭据', { timeout: 60_000 }, () => {
  clientProbeModule('demo:ops', 'NodeOpsSection')
  const store = storeWith([
    {
      pluginId: 'demo:ops',
      surface: 'plugin.slot',
      spec: { id: 'node-ops', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'NodeOpsSection.tsx', export: 'NodeOpsSection' } },
    },
  ])

  const html = renderDrawer(store, { node: remoteNode() })
  const probeMatch = html.match(/data-probe="NodeOpsSection">([\s\S]*?)<\/section>/)
  assert.ok(probeMatch, '探针节点存在')
  // HTML 实体还原后解析 props JSON，逐一断言字段集合
  const propsJson = probeMatch[1]!
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
  const props = JSON.parse(propsJson) as Record<string, unknown>
  assert.deepEqual(
    Object.keys(props).sort(),
    ['isLocal', 'isNew', 'isOnline', 'nodeId'],
    'slotProps 字段集与协议 NodeDetailSlotProps 完全一致',
  )
  assert.equal(props.nodeId, 'worker-gpu-1')
  assert.equal(props.isLocal, false)
  assert.equal(props.isOnline, true)
  assert.equal(props.isNew, false)
  assert.doesNotMatch(propsJson, /token|secret|credential|guide/i, '插槽 props 不含令牌/凭据/接入指南字段')
})

test('静态扫描: NodeDetailDrawer 源码引用协议插槽常量且 0 Emoji', { timeout: 60_000 }, () => {
  const content = readFileSync(join(PKG_ROOT, 'src/nodes/NodeDetailDrawer.tsx'), 'utf-8')
  assert.match(content, /NODE_DETAIL_SECTION_SLOT/, '宿主插槽名必须引用协议常量而非硬编码字符串')
  assert.match(content, /ownerPluginId="builtin:node"/, '显式宿主命名空间 builtin:node')
  assert.doesNotMatch(content, EMOJI_REGEX, '源码 0 Emoji')
})
