/**
 * 计算节点管理弹窗纯函数模块：
 * 节点 ID 校验、受控机接入命令生成、容量与时长格式化、
 * SemVer 版本比较与节点自升级门控。
 * 全部无副作用，便于单测与 Fast Refresh 隔离。
 */

import type { NodeInfo, NodeUpgradeCheckResult } from '@helm/protocol'
import { formatBytes } from '../lib/format.js'

export { formatBytes }

/** 节点 ID 约束（与内核 issueNodeToken 校验同源：字母数字开头，可含 . _ -，最长 128）。 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type NodeIdValidation = { ok: true; nodeId: string } | { ok: false; error: string }

/** 校验接入节点 ID 输入：trim、保留字与字符集规则。 */
export function validateNodeIdInput(raw: string): NodeIdValidation {
  const nodeId = raw.trim()
  if (nodeId === '') return { ok: false, error: '请输入节点 ID' }
  if (nodeId === 'local') return { ok: false, error: 'local 是内建本机节点，无需签发接入令牌' }
  if (!NODE_ID_PATTERN.test(nodeId)) {
    return { ok: false, error: '节点 ID 需以字母或数字开头，仅含字母、数字、. _ -，最长 128 字符' }
  }
  return { ok: true, nodeId }
}

export interface NodeConnectGuide {
  /** 前台连接（调试用）：绑定 JOIN 令牌并前台常驻运行，Ctrl+C 退出，不安装守护进程。 */
  connectCommand: string
  /** 后台启动守护进程：复用磁盘上已绑定身份，无需令牌。 */
  startDaemonCommand: string
  /** 一键接入：以 --token 绑定节点身份并后台 detached 启动（推荐）。 */
  oneLineCommand: string
  serviceInstallCommand: string
  doctorCommand: string
}

/** 生成受控机接入命令集（hubOrigin 如 http://192.168.1.10:3202）。 */
export function buildNodeConnectGuide(
  hubOrigin: string,
  issued: { nodeId: string; token: string },
): NodeConnectGuide {
  // connect 是前台常驻命令（Ctrl/Cmd+C 才退出），用 && 串联后续命令永远不会执行；
  // 一步接入用 start -d：其 detach 路径支持 --token 绑定身份后拉起后台守护进程，
  // 且子进程 argv 不含 token（避免长期驻留进程的命令行泄漏令牌）。
  return {
    connectCommand: `helm-node connect ${hubOrigin} --token ${issued.token}`,
    startDaemonCommand: 'helm-node start -d',
    oneLineCommand: `helm-node start -d --hub ${hubOrigin} --token ${issued.token}`,
    serviceInstallCommand: 'helm-node service install',
    doctorCommand: 'helm-node doctor',
  }
}

/** 运行时长格式化（天/小时/分钟）。 */
export function formatUptime(uptimeSec: number | undefined): string {
  if (uptimeSec === undefined || !Number.isFinite(uptimeSec) || uptimeSec < 0) return '--'
  const totalMin = Math.floor(uptimeSec / 60)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days} 天`)
  if (hours > 0) parts.push(`${hours} 小时`)
  if (parts.length < 2) parts.push(`${minutes} 分钟`)
  return parts.join(' ')
}

export interface NodeUsageInfo {
  usedBytes: number
  totalBytes: number
  percent: number
  label: string
}

/** 会话/选择器展示用的节点选项文案：id + 本机/离线标注。 */
export function nodeOptionLabel(node: NodeInfo): string {
  if (node.kind === 'local') return `${node.id} (本机)`
  return node.online ? node.id : `${node.id} (离线)`
}

/** 节点版本展示：确保带 v 前缀（'0.1.0' -> 'v0.1.0'）；空或空白返回 null。 */
export function formatNodeVersion(version?: string): string | null {
  const trimmed = (version ?? '').trim()
  if (trimmed === '') return null
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`
}

/** SemVer 解析结果（build metadata 按规范忽略，不参与比较）。 */
export interface ParsedNodeSemver {
  major: number
  minor: number
  patch: number
  /** 预发布标识段（如 ['beta', '1']）；正式版为空数组。 */
  prerelease: string[]
}

// semver.org 官方文法（数值段禁前导零），另容忍 v 前缀。
const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** 解析 SemVer；空白或非法（如 0.1、01.2.3、garbage）返回 null。 */
export function parseNodeSemver(version: string): ParsedNodeSemver | null {
  const match = SEMVER_PATTERN.exec(version.trim())
  if (match === null) return null
  const major = match[1] ?? '0'
  const minor = match[2] ?? '0'
  const patch = match[3] ?? '0'
  const prerelease = match[4]
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease !== undefined ? prerelease.split('.') : [],
  }
}

/** 预发布段比较：正式 > 预发布；数字段按数值、数字 < 字母数字、段多者大。 */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const da = a[i]
    const db = b[i]
    if (da === undefined) return -1
    if (db === undefined) return 1
    const na = /^\d+$/.test(da)
    const nb = /^\d+$/.test(db)
    if (na && nb) {
      if (Number(da) > Number(db)) return 1
      if (Number(da) < Number(db)) return -1
    } else if (na !== nb) {
      return na ? -1 : 1
    } else if (da > db) {
      return 1
    } else if (da < db) {
      return -1
    }
  }
  return 0
}

/** SemVer 优先级比较：a > b 返回 1、a < b 返回 -1、相等返回 0；任一侧非法无法比较返回 0。 */
export function compareNodeSemver(a: string, b: string): number {
  const pa = parseNodeSemver(a)
  const pb = parseNodeSemver(b)
  if (pa === null || pb === null) return 0
  const core: Array<[number, number]> = [
    [pa.major, pb.major],
    [pa.minor, pb.minor],
    [pa.patch, pb.patch],
  ]
  for (const [va, vb] of core) {
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

/** 节点版本是否落后于 Hub（local 节点）版本：任一为空或非法 SemVer 视为无法判定（false）。 */
export function isNodeBehindHub(nodeVersion?: string, hubVersion?: string): boolean {
  if (parseNodeSemver(nodeVersion ?? '') === null || parseNodeSemver(hubVersion ?? '') === null) return false
  return compareNodeSemver(hubVersion ?? '', nodeVersion ?? '') > 0
}

/** 确认升级门控结果：ok 为可点击；hint 为禁用原因（ok 时为 null）。 */
export interface NodeUpgradeConfirmability {
  ok: boolean
  hint: string | null
}

/** 确认升级门控：离线、缺检查且无明确合法目标、已最新且无 force/目标时拒绝。 */
export function canConfirmNodeUpgrade(input: {
  online: boolean
  check: NodeUpgradeCheckResult | null
  targetVersion: string
  force: boolean
}): NodeUpgradeConfirmability {
  if (!input.online) return { ok: false, hint: '节点已离线，无法升级' }
  const explicit = input.targetVersion.trim()
  if (explicit !== '' && parseNodeSemver(explicit) === null) {
    return { ok: false, hint: '目标版本不是合法 SemVer（示例 0.2.0）' }
  }
  if (input.check === null) {
    return explicit === ''
      ? { ok: false, hint: '请先检查更新，或填写明确的目标版本' }
      : { ok: true, hint: null }
  }
  if (input.check.updateAvailable) return { ok: true, hint: null }
  if (explicit === '' && !input.force) {
    return { ok: false, hint: '当前已是最新版本；可勾选强制重装/重试，或填写目标版本' }
  }
  return { ok: true, hint: null }
}

/** 确认升级将安装的目标：显式输入优先；否则固定为本次检查的 latestVersion（无检查且无输入为 null）。 */
export function resolveUpgradeTarget(
  check: NodeUpgradeCheckResult | null,
  targetVersion: string,
): string | null {
  const explicit = targetVersion.trim()
  if (explicit !== '') return explicit
  return check !== null && check.latestVersion.trim() !== '' ? check.latestVersion : null
}

/** 占用量计算（free + total -> used / 百分比 / 文案）；数据缺失返回 null。 */
export function formatUsage(
  freeBytes: number | undefined,
  totalBytes: number | undefined,
): NodeUsageInfo | null {
  if (
    freeBytes === undefined ||
    totalBytes === undefined ||
    !Number.isFinite(freeBytes) ||
    !Number.isFinite(totalBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes
  ) {
    return null
  }
  const usedBytes = totalBytes - freeBytes
  const percent = Math.round((usedBytes / totalBytes) * 100)
  return {
    usedBytes,
    totalBytes,
    percent,
    label: `${formatBytes(usedBytes)} / ${formatBytes(totalBytes)}（${percent}%）`,
  }
}
