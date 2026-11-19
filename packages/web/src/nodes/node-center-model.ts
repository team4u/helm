/**
 * Compute Node Center (NodeCenter) pure-function model and category filtering.
 *
 * Provides multi-dimensional node search (ID / label / platform / arch /
 * version / OS / hostname), status predicates (online / offline / local /
 * remote), category-pill counting and summary metrics. All side-effect free
 * and purely functional to keep Fast Refresh and unit tests deadlock-safe.
 *
 * i18n: display-copy-producing helpers take an optional trailing `t`
 * translator (English bridge by default).
 */

import type {
  NodeHealthSnapshot as ProtocolNodeHealthSnapshot,
  NodeInfo as ProtocolNodeInfo,
} from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

/** Node category pill tab type. */
export type NodeCategoryTab = 'all' | 'local' | 'remote' | 'online' | 'offline'

/** Node health snapshot: ProtocolNodeHealthSnapshot-compatible plus optional CPU and per-load fields. */
export interface NodeHealthSnapshot extends Partial<ProtocolNodeHealthSnapshot> {
  cpuUsagePercent?: number
  load1?: number
  load5?: number
  load15?: number
  loadAvg?: [number, number, number]
  uptimeSec?: number
  memFreeBytes?: number
  memTotalBytes?: number
  diskFreeBytes?: number
  diskTotalBytes?: number
  collectedAt?: number
}

/**
 * Unified node model for the node center: standard ProtocolNodeInfo plus
 * optional display fields (label, arch, os, status, connected, tools, cwd, health).
 */
export interface NodeInfo extends Omit<Partial<ProtocolNodeInfo>, 'health'> {
  id: string
  kind?: 'local' | 'byom'
  online?: boolean
  label?: string
  platform?: string
  arch?: string
  version?: string
  os?: string
  status?: string
  connected?: boolean
  hostname?: string
  cwd?: string
  tools?: string[]
  health?: NodeHealthSnapshot
  hubUrl?: string
  uptimeSec?: number
}

/** Node filter options. */
export interface NodeFilterOptions {
  query: string
  categoryTab: NodeCategoryTab
}

/** Node center summary metrics. */
export interface NodeSummaryStats {
  total: number
  online: number
  local: number
  remote: number
}

/**
 * Whether the node is online and reachable: accepts node.online,
 * node.status === 'online' or node.connected === true.
 */
export function isNodeOnline(node: NodeInfo): boolean {
  return Boolean(
    node.online === true ||
    node.status === 'online' ||
    node.connected === true,
  )
}

/** Whether the node is the built-in local kernel node (id 'local' or kind 'local'). */
export function isNodeLocal(node: NodeInfo): boolean {
  return node.id === 'local' || node.kind === 'local'
}

/**
 * Friendly display name for a node: prefer the label; fall back to the
 * localized local-kernel name for the built-in node, then to the node ID.
 */
export function getNodeDisplayName(
  node: NodeInfo,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  if (node.label && node.label.trim() !== '') {
    return node.label.trim()
  }
  if (node.id === 'local') {
    return t('nodes.displayName.localKernel')
  }
  return node.id || t('nodes.displayName.unknown')
}

/**
 * Format the node platform and architecture for display (e.g.
 * "linux / x64", "darwin / arm64").
 */
export function formatNodePlatformArch(node: NodeInfo): string {
  const os = (node.platform || node.os || '').trim()
  const arch = (node.arch || '').trim()

  if (os && arch) {
    return `${os} / ${arch}`
  }
  if (os) {
    return os
  }
  if (arch) {
    return arch
  }
  return '--'
}

/** Count nodes per category-pill key. */
export function buildNodeCategoryCounts(nodes: NodeInfo[]): Record<NodeCategoryTab, number> {
  const list = Array.isArray(nodes) ? nodes : []
  let local = 0
  let remote = 0
  let online = 0
  let offline = 0

  for (const node of list) {
    if (node.id === 'local') {
      local++
    } else {
      remote++
    }

    if (isNodeOnline(node)) {
      online++
    } else {
      offline++
    }
  }

  return {
    all: list.length,
    local,
    remote,
    online,
    offline,
  }
}

/** Summarize node metrics (total, online, local, remote). */
export function summarizeNodes(nodes: NodeInfo[]): NodeSummaryStats {
  const counts = buildNodeCategoryCounts(nodes)
  return {
    total: counts.all,
    online: counts.online,
    local: counts.local,
    remote: counts.remote,
  }
}

/**
 * Filter the node list by multi-dimensional conditions (pure function:
 * returns a new array, never mutates the input).
 *
 * Search: case-insensitive match against node.id, node.label, node.platform,
 * node.arch, node.version, node.os, node.hostname.
 * Categories:
 * - all: every node
 * - local: node.id === 'local'
 * - remote: node.id !== 'local'
 * - online: node.status === 'online' || node.connected === true || node.online === true
 * - offline: not online
 */
export function filterNodes(
  nodes: NodeInfo[],
  options: { query: string; categoryTab: NodeCategoryTab },
): NodeInfo[] {
  if (!Array.isArray(nodes)) return []

  const query = (options.query ?? '').trim().toLowerCase()
  const tab = options.categoryTab ?? 'all'

  return nodes.filter((node) => {
    // 1. Category filter
    if (tab === 'local' && node.id !== 'local') return false
    if (tab === 'remote' && node.id === 'local') return false
    if (tab === 'online' && !isNodeOnline(node)) return false
    if (tab === 'offline' && isNodeOnline(node)) return false

    // 2. Keyword search match
    if (query) {
      const matchId = (node.id ?? '').toLowerCase().includes(query)
      const matchLabel = (node.label ?? '').toLowerCase().includes(query)
      const matchPlatform = (node.platform ?? '').toLowerCase().includes(query)
      const matchArch = (node.arch ?? '').toLowerCase().includes(query)
      const matchVersion = (node.version ?? '').toLowerCase().includes(query)
      const matchOs = (node.os ?? '').toLowerCase().includes(query)
      const matchHostname = (node.hostname ?? '').toLowerCase().includes(query)

      if (
        !matchId &&
        !matchLabel &&
        !matchPlatform &&
        !matchArch &&
        !matchVersion &&
        !matchOs &&
        !matchHostname
      ) {
        return false
      }
    }

    return true
  })
}
