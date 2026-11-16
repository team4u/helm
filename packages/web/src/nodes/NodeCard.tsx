import React from 'react'
import { HelmIcon } from '@helm/plugin-client'
import { formatUptime } from '../modals/nodes-modal-model.js'
import {
  formatNodePlatformArch,
  getNodeDisplayName,
  isNodeLocal,
  isNodeOnline,
  type NodeInfo,
} from './node-center-model.js'

export interface NodeCardProps {
  node: NodeInfo
  selected?: boolean
  onSelect: () => void
}

/**
 * 计算节点卡片视图组件（NodeCard）：
 * - 采用 .primary-card 统一样式结构与 1px 发丝边框；
 * - 头部：状态脉冲指示灯（在线高亮呼吸动效，离线中性）、HelmIcon（本机 laptop，远程 server）、节点名称与 mono 节点 ID；
 * - 中部：平台系统与 CPU 架构徽章（如 linux / x64）、版本号与主机运行时长；
 * - 底部：在线/离线连接状态徽章与支持的工具能力胶囊标签（bash / read / write / edit 等）；
 * - 交互：支持点击与 Enter / Space 键盘导航激活；选中时高亮 .is-selected；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
 */
export function NodeCard({
  node,
  selected = false,
  onSelect,
}: NodeCardProps): React.JSX.Element {
  const isLocal = isNodeLocal(node)
  const isOnline = isNodeOnline(node)
  const displayName = getNodeDisplayName(node)
  const platformArch = formatNodePlatformArch(node)
  const iconName = isLocal ? 'laptop' : 'server'
  const version = node.version
    ? (node.version.startsWith('v') ? node.version : `v${node.version}`)
    : null
  const uptime = formatUptime(node.health?.uptimeSec ?? node.uptimeSec)
  const tools =
    Array.isArray(node.tools) && node.tools.length > 0
      ? node.tools
      : ['bash', 'read', 'write', 'edit']

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  const cardClasses = [
    'primary-card',
    'node-card',
    selected && 'is-selected',
    isOnline ? 'is-online' : 'is-offline',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cardClasses}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      data-node-id={node.id}
    >
      {/* Header: status light, node icon, node name, ID */}
      <div className="primary-card-header">
        <div className="primary-card-icon-wrap">
          <HelmIcon name={iconName} size={18} />
        </div>
        <div className="primary-card-meta">
          <div className="primary-card-title-row">
            <span
              className={`status-dot ${isOnline ? 'status-dot-done status-dot-working' : ''}`}
              title={isOnline ? 'Node online and running' : 'Node offline'}
              aria-label={isOnline ? 'Online' : 'Offline'}
            />
            <span className="primary-card-name" title={displayName}>
              {displayName}
            </span>
            {isLocal && (
              <span className="badge badge-neutral" title="Microkernel local node">
                Local
              </span>
            )}
            {version && (
              <span className="badge badge-neutral mono" title={`Version ${version}`}>
                {version}
              </span>
            )}
          </div>
          <div className="primary-card-id mono text-subtle break-word" title={node.id}>
            {node.id}
          </div>
        </div>
      </div>

      {/* Middle: platform, architecture and runtime overview */}
      <div className="flex-row-wrap">
        {platformArch !== '--' && (
          <span className="badge badge-neutral mono" title="Platform and architecture">
            {platformArch}
          </span>
        )}
        {node.hostname && (
          <span className="mono text-subtle break-word" title={`Hostname: ${node.hostname}`}>
            {node.hostname}
          </span>
        )}
        {uptime !== '--' && (
          <span className="text-subtle" title={`Uptime: ${uptime}`}>
            {uptime}
          </span>
        )}
      </div>

      {/* Bottom: heartbeat/connection status + capability pills */}
      <div className="primary-card-footer">
        <div className="primary-card-pills">
          {tools.slice(0, 4).map((tool) => (
            <span key={tool} className="primary-card-pill mono" title={`Tool: ${tool}`}>
              <HelmIcon name="terminal" size={10} />
              <span>{tool}</span>
            </span>
          ))}
          {tools.length > 4 && (
            <span
              className="primary-card-pill text-subtle tabular-nums"
              title={`${tools.length - 4} more tools`}
            >
              +{tools.length - 4}
            </span>
          )}
        </div>

        <div className="flex-row">
          <span className={`badge ${isOnline ? 'badge-ok' : 'badge-neutral'}`}>
            {isOnline ? 'Online' : 'Offline'}
          </span>
        </div>
      </div>
    </div>
  )
}
