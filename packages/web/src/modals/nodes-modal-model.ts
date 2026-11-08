/**
 * 计算节点管理弹窗纯函数模块：
 * 节点 ID 校验、受控机接入命令生成、容量与时长格式化。
 * 全部无副作用，便于单测与 Fast Refresh 隔离。
 */

import type { NodeInfo } from '@helm/protocol'

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

/** 字节数人类可读化（GiB / MiB / KiB）。 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '--'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${Math.round(bytes)} B`
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
