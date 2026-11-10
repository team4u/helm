/**
 * 计算节点中心（NodeCenter）纯函数模型与分类过滤
 *
 * 提供节点多维检索（ID / Label / 平台 / 架构 / 版本 / OS / 主机名）、
 * 状态判定（在线 / 离线 / 本机 / 远端）、分类标签统计与概要指标汇总。
 * 全部无副作用，纯函数隔离，保障 Fast Refresh 与单元测试防死锁。
 */

import type {
  NodeHealthSnapshot as ProtocolNodeHealthSnapshot,
  NodeInfo as ProtocolNodeInfo,
} from '@helm/protocol'

/** 节点分类药丸标签类型 */
export type NodeCategoryTab = 'all' | 'local' | 'remote' | 'online' | 'offline'

/** 节点健康快照，兼容 ProtocolNodeHealthSnapshot 并支持可选 CPU 与单项负载字段 */
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
 * 节点中心使用的统一节点模型。
 * 兼容标准 ProtocolNodeInfo 并扩展 label、arch、os、status、connected、tools、cwd、health 等可选展示字段。
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

/** 节点过滤选项 */
export interface NodeFilterOptions {
  query: string
  categoryTab: NodeCategoryTab
}

/** 节点中心统计汇总指标 */
export interface NodeSummaryStats {
  total: number
  online: number
  local: number
  remote: number
}

/**
 * 判断节点是否处于在线连通状态
 * 兼容 node.online、node.status === 'online' 与 node.connected === true
 */
export function isNodeOnline(node: NodeInfo): boolean {
  return Boolean(
    node.online === true ||
    node.status === 'online' ||
    node.connected === true,
  )
}

/**
 * 判断节点是否为本机内核节点（id 为 'local' 或 kind 为 'local'）
 */
export function isNodeLocal(node: NodeInfo): boolean {
  return node.id === 'local' || node.kind === 'local'
}

/**
 * 获取节点友好展示名称：
 * 优先取 label；其次若为本机节点则返回“本机内核”；否则回退为节点 ID
 */
export function getNodeDisplayName(node: NodeInfo): string {
  if (node.label && node.label.trim() !== '') {
    return node.label.trim()
  }
  if (node.id === 'local') {
    return '本机内核'
  }
  return node.id || '未知节点'
}

/**
 * 格式化展示节点的平台与架构（如 "linux / x64"、"darwin / arm64"）
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

/**
 * 计算各类目标签下的节点数量
 */
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

/**
 * 汇总计算节点统计指标（总量、在线、本机、远端）
 */
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
 * 按多维条件过滤计算节点列表（纯函数，返回新数组，不修改原数组）
 *
 * 搜索规则：大小写不敏感匹配 node.id, node.label, node.platform, node.arch, node.version, node.os, node.hostname
 * 分类规则：
 * - all: 全部节点
 * - local: node.id === 'local'
 * - remote: node.id !== 'local'
 * - online: node.status === 'online' || node.connected === true || node.online === true
 * - offline: 非 online
 */
export function filterNodes(
  nodes: NodeInfo[],
  options: { query: string; categoryTab: NodeCategoryTab },
): NodeInfo[] {
  if (!Array.isArray(nodes)) return []

  const query = (options.query ?? '').trim().toLowerCase()
  const tab = options.categoryTab ?? 'all'

  return nodes.filter((node) => {
    // 1. 分类筛选
    if (tab === 'local' && node.id !== 'local') return false
    if (tab === 'remote' && node.id === 'local') return false
    if (tab === 'online' && !isNodeOnline(node)) return false
    if (tab === 'offline' && isNodeOnline(node)) return false

    // 2. 关键字搜索匹配
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
