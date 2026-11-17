import React from 'react'
import { HelmIcon } from '@helm/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
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
 * Compute node card view (NodeCard):
 * - uses the shared .primary-card structure with 1px hairline borders;
 * - header: status pulse indicator (breathing animation when online, neutral
 *   when offline), HelmIcon (laptop for local, server for remote), node name
 *   and the mono node ID;
 * - middle: platform/OS and CPU architecture badges (e.g. linux / x64),
 *   version and host uptime;
 * - bottom: online/offline connection badge plus supported tool capability
 *   pills (bash / read / write / edit, ...);
 * - interaction: click and Enter / Space keyboard activation; the selected
 *   state highlights .is-selected;
 * - strictly zero Emoji and Fast Refresh compliant.
 */
export function NodeCard({
  node,
  selected = false,
  onSelect,
}: NodeCardProps): React.JSX.Element {
  const { t } = useWebLocale()
  const isLocal = isNodeLocal(node)
  const isOnline = isNodeOnline(node)
  const displayName = getNodeDisplayName(node, t)
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
              title={isOnline ? t('nodes.statusOnlineTitle') : t('nodes.statusOfflineTitle')}
              aria-label={isOnline ? t('common.online') : t('common.offline')}
            />
            <span className="primary-card-name" title={displayName}>
              {displayName}
            </span>
            {isLocal && (
              <span className="badge badge-neutral" title={t('nodes.localTitle')}>
                {t('nodes.local')}
              </span>
            )}
            {version && (
              <span className="badge badge-neutral mono" title={t('nodes.versionTitle', { version })}>
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
          <span className="badge badge-neutral mono" title={t('nodes.platformTitle')}>
            {platformArch}
          </span>
        )}
        {node.hostname && (
          <span className="mono text-subtle break-word" title={t('nodes.hostnameTitle', { hostname: node.hostname })}>
            {node.hostname}
          </span>
        )}
        {uptime !== '--' && (
          <span className="text-subtle" title={t('nodes.uptimeTitle', { uptime })}>
            {uptime}
          </span>
        )}
      </div>

      {/* Bottom: heartbeat/connection status + capability pills */}
      <div className="primary-card-footer">
        <div className="primary-card-pills">
          {tools.slice(0, 4).map((tool) => (
            <span key={tool} className="primary-card-pill mono" title={t('nodes.cardToolTitle', { tool })}>
              <HelmIcon name="terminal" size={10} />
              <span>{tool}</span>
            </span>
          ))}
          {tools.length > 4 && (
            <span
              className="primary-card-pill text-subtle tabular-nums"
              title={t('nodes.moreTools', { count: tools.length - 4 })}
            >
              +{tools.length - 4}
            </span>
          )}
        </div>

        <div className="flex-row">
          <span className={`badge ${isOnline ? 'badge-ok' : 'badge-neutral'}`}>
            {isOnline ? t('common.online') : t('common.offline')}
          </span>
        </div>
      </div>
    </div>
  )
}
