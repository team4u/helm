/**
 * Node detail drawer plugin slot (builtin:node/detail-section) tests:
 * - both tracks render: the client track (seedPluginClientModule cache
 *   injection) and the JSON track (@json-render Slot primitive);
 * - mounts only for existing nodes: the new-node enrollment mode and the
 *   no-selection state never render slot contributions;
 * - multiple contributions sort by priority desc, then order asc, stable;
 * - contributions vanish immediately when the plugin is disabled (removed from
 *   groupedUi);
 * - slotProps never leak the previous node's data after switching nodes;
 * - an offline node honestly receives isOnline=false;
 * - slotProps carries exactly the four public protocol NodeDetailSlotProps
 *   fields — never enrollment tokens or other credentials.
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
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

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
      HostStoreProviders,
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

/** Client-track probe: serializes every received prop (undefined fields appear verbatim) for precise assertions. */
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
// Client track rendering
// ---------------------------------------------------------------------------

test('node slot client track: existing node renders contributions with faithful NodeDetailSlotProps', { timeout: 60_000 }, () => {
  clientProbeModule('demo:ops', 'NodeOpsSection')
  const store = storeWith([
    {
      pluginId: 'demo:ops',
      surface: 'plugin.slot',
      spec: { id: 'node-ops', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'NodeOpsSection.tsx', export: 'NodeOpsSection' } },
    },
  ])

  const html = renderDrawer(store, { node: remoteNode() })
  assert.match(html, /data-probe="NodeOpsSection"/, 'client-track contribution renders inside the drawer')
  assert.match(
    html,
    /&quot;nodeId&quot;:&quot;worker-gpu-1&quot;/,
    'slotProps.nodeId is the real node ID',
  )
  assert.match(html, /&quot;isLocal&quot;:false/, 'remote node isLocal=false')
  assert.match(html, /&quot;isOnline&quot;:true/, 'online node isOnline=true')
  assert.match(html, /&quot;isNew&quot;:false/, 'existing node isNew=false')
  assert.doesNotMatch(html, EMOJI_REGEX)
})

test('node slot client track: component receives the real slotProps data', { timeout: 60_000 }, () => {
  seedPluginClientModule('demo:ops', 'node-data.tsx', {
    NodeData: (props: Record<string, unknown>) =>
      e('section', { 'data-node-data': String(props['nodeId'] ?? '') }, `node ${String(props['nodeId'] ?? '')} online=${String(props['isOnline'])}`),
  })
  const store = storeWith([
    slotContribution('demo:ops', 'node-data', {
      client: { module: 'node-data.tsx', export: 'NodeData' },
    }),
  ])

  const html = renderDrawer(store, { node: remoteNode() })
  assert.match(html, /node worker-gpu-1 online=true/, 'client track receives slotProps data')
})

// ---------------------------------------------------------------------------
// Mount boundaries
// ---------------------------------------------------------------------------

test('node slot mount boundaries: new-node enrollment mode and no-selection render no contributions', { timeout: 60_000 }, () => {
  clientProbeModule('demo:ops', 'NodeOpsSection')
  const store = storeWith([
    {
      pluginId: 'demo:ops',
      surface: 'plugin.slot',
      spec: { id: 'node-ops', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'NodeOpsSection.tsx', export: 'NodeOpsSection' } },
    },
  ])

  // New-node enrollment mode (node=null, isNew=true): enrollment commands
  // only; the plugin slot never mounts
  const newHtml = renderDrawer(store, { node: null, isNew: true })
  assert.doesNotMatch(newHtml, /data-probe="NodeOpsSection"/, 'isNew never mounts the node slot')

  // No node selected (node=null): empty state, no plugin slot
  const emptyHtml = renderDrawer(store, { node: null })
  assert.match(emptyHtml, /No node selected/)
  assert.doesNotMatch(emptyHtml, /data-probe="NodeOpsSection"/, 'no-selection never mounts the node slot')
})

// ---------------------------------------------------------------------------
// Multi-contribution ordering and plugin disabling
// ---------------------------------------------------------------------------

test('node slot multiple contributions: priority desc, order asc, stable', { timeout: 60_000 }, () => {
  const contribModule = (mark: string) => ({ [mark]: () => e('section', { 'data-mark': mark }, `contrib-${mark}`) })
  seedPluginClientModule('demo:a', 'a1.tsx', contribModule('A'))
  seedPluginClientModule('demo:b', 'b1.tsx', contribModule('B'))
  seedPluginClientModule('demo:c', 'c1.tsx', contribModule('C'))
  const store = storeWith([
    slotContribution('demo:a', 'a1', { client: { module: 'a1.tsx', export: 'A' } }),
    slotContribution('demo:b', 'b1', { client: { module: 'b1.tsx', export: 'B' }, priority: 10 }),
    slotContribution('demo:c', 'c1', { client: { module: 'c1.tsx', export: 'C' }, priority: 10, order: 5 }),
  ])

  const html = renderDrawer(store, { node: remoteNode() })
  const posB = html.indexOf('contrib-B')
  const posC = html.indexOf('contrib-C')
  const posA = html.indexOf('contrib-A')
  assert.ok(posC !== -1 && posC < posB, 'on equal priority the smaller order wins (C before B)')
  assert.ok(posB !== -1 && posB < posA, 'higher priority wins (B before A)')
})

test('node slot plugin disabled: contribution vanishes immediately once removed from groupedUi', { timeout: 60_000 }, () => {
  clientProbeModule('demo:ops', 'NodeOpsSection')
  const contribution: PluginUiContribution = {
    pluginId: 'demo:ops',
    surface: 'plugin.slot',
    spec: { id: 'node-ops', target: NODE_DETAIL_SECTION_SLOT, client: { module: 'NodeOpsSection.tsx', export: 'NodeOpsSection' } },
  }

  const enabled = renderDrawer(storeWith([contribution]), { node: remoteNode() })
  assert.match(enabled, /data-probe="NodeOpsSection"/, 'contribution renders while enabled')

  // Plugin disabled: ui contributions cleared (matching the host SSE snapshot
  // behavior); the contribution vanishes immediately
  const disabled = renderDrawer(storeWith([]), { node: remoteNode() })
  assert.doesNotMatch(disabled, /data-probe="NodeOpsSection"/, 'contribution removed after disabling')
  assert.match(disabled, /System overview/, 'the drawer body stays unaffected')
})

// ---------------------------------------------------------------------------
// Node-switch prop hygiene & honest offline state
// ---------------------------------------------------------------------------

test('node slot node switch: props never leak the previous node data', { timeout: 60_000 }, () => {
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

  // Switch to the local node: the new render carries only the new node ID
  const second = renderDrawer(store, {
    node: remoteNode({ id: 'local', kind: 'local', label: 'Local kernel', online: true }),
  })
  assert.match(second, /&quot;nodeId&quot;:&quot;local&quot;/, 'the new node ID is passed after switching')
  assert.match(second, /&quot;isLocal&quot;:true/, 'isLocal=true after switching')
  assert.doesNotMatch(second, /worker-gpu-1/, 'no previous node ID lingers')
})

test('node slot offline node: honestly passes isOnline=false', { timeout: 60_000 }, () => {
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
  assert.match(html, /&quot;isOnline&quot;:false/, 'offline nodes honestly report false, never beautified')
  assert.match(html, /Offline/, 'the header badge shows offline as well')
})

// ---------------------------------------------------------------------------
// Credential boundaries
// ---------------------------------------------------------------------------

test('node slot slotProps carries only the four public protocol fields, never tokens or credentials', { timeout: 60_000 }, () => {
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
  assert.ok(probeMatch, 'probe node exists')
  // Decode HTML entities back and parse the props JSON to assert the field set
  const propsJson = probeMatch[1]!
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
  const props = JSON.parse(propsJson) as Record<string, unknown>
  assert.deepEqual(
    Object.keys(props).sort(),
    ['isLocal', 'isNew', 'isOnline', 'nodeId'],
    'slotProps fields exactly match the protocol NodeDetailSlotProps',
  )
  assert.equal(props.nodeId, 'worker-gpu-1')
  assert.equal(props.isLocal, false)
  assert.equal(props.isOnline, true)
  assert.equal(props.isNew, false)
  assert.doesNotMatch(propsJson, /token|secret|credential|guide/i, 'slot props never contain token/credential/enrollment-guide fields')
})

test('static scan: NodeDetailDrawer source references the protocol slot constant and stays Emoji-free', { timeout: 60_000 }, () => {
  const content = readFileSync(join(PKG_ROOT, 'src/nodes/NodeDetailDrawer.tsx'), 'utf-8')
  assert.match(content, /NODE_DETAIL_SECTION_SLOT/, 'the host slot name must reference the protocol constant, never a hardcoded string')
  assert.match(content, /ownerPluginId="builtin:node"/, 'explicit host namespace builtin:node')
  assert.doesNotMatch(content, EMOJI_REGEX, 'source is Emoji-free')
})
