import React, { useState } from 'react'
import { copyToClipboard, CopyButton, HelmIcon, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle, PluginSlot } from '@helm/plugin-client'
import { nodesApi, type NodeUpgradeCheckResult } from '../lib/api.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  buildNodeConnectGuide,
  formatBytes,
  formatUptime,
  formatUsage,
  validateNodeIdInput,
} from '../modals/nodes-modal-model.js'
import {
  formatNodePlatformArch,
  getNodeDisplayName,
  isNodeLocal,
  isNodeOnline,
  type NodeInfo,
} from './node-center-model.js'
import { NODE_DETAIL_SECTION_SLOT } from '@helm/protocol/browser'

export interface NodeDetailDrawerProps {
  node: NodeInfo | null
  open: boolean
  onClose: () => void
  /** Render inline (uniform assertions for tests and SSR). */
  inline?: boolean
  /** Whether the drawer is in the new-node enrollment mode. */
  isNew?: boolean
  onTokenIssued?: (token: string) => void
  onRefresh?: () => Promise<unknown> | void
}

/**
 * Right slide-over drawer of the full-screen Compute Nodes Center
 * (NodeDetailDrawer):
 * - built on Radix Dialog primitives as a 520px-560px drawer;
 * - header: node icon, friendly name, online badge, mono node ID and a close
 *   button;
 * - node system overview: OS, CPU architecture, Node version, hostname,
 *   working directory, connection channel, uptime;
 * - node health check: check trigger button, CPU load, memory and disk
 *   capacity figures, version diagnostics;
 * - remote node enrollment & commands: issue an access token (via
 *   nodesApi.issueToken), one-click copy of the enrollment command line with
 *   copy feedback;
 * - registered tool capability list: the bash / read / write / edit vector;
 * - plugin extension slot: existing nodes mount builtin:node/detail-section
 *   after the system overview (other plugins inject node-scoped sections;
 *   only the public node snapshot is passed — never enrollment tokens or
 *   other credentials);
 * - strictly zero Emoji and Fast Refresh compliant.
 */
export function NodeDetailDrawer({
  node,
  open,
  onClose,
  inline = false,
  isNew = false,
  onTokenIssued,
  onRefresh,
}: NodeDetailDrawerProps): React.JSX.Element {
  const { t } = useWebLocale()
  const [issuedToken, setIssuedToken] = useState<string | null>(null)
  const [newNodeId, setNewNodeId] = useState('')
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)
  const [copiedToken, setCopiedToken] = useState(false)

  const [checkingHealth, setCheckingHealth] = useState(false)
  const [healthResult, setHealthResult] = useState<NodeUpgradeCheckResult | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)

  const isLocal = node ? isNodeLocal(node) : false
  const isOnline = node ? isNodeOnline(node) : false
  const displayName = isNew
    ? t('nodes.drawer.newTitle')
    : node
      ? getNodeDisplayName(node, t)
      : t('nodes.drawer.titleFallback')
  const iconName = isLocal ? 'laptop' : 'server'
  const platformArch = node ? formatNodePlatformArch(node) : '--'

  const hubOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:3202'

  const targetNodeId = isNew ? newNodeId.trim() : node?.id ?? ''

  const guide = targetNodeId
    ? buildNodeConnectGuide(hubOrigin, {
        nodeId: targetNodeId,
        token: issuedToken || '<TOKEN>',
      })
    : null

  const handleIssueToken = async () => {
    if (isNew) {
      const validation = validateNodeIdInput(newNodeId)
      if (!validation.ok) {
        setTokenError(validation.error)
        return
      }
    }

    if (!targetNodeId) {
      setTokenError(t('nodes.drawer.invalidNodeId'))
      return
    }

    setIssuing(true)
    setTokenError(null)

    try {
      const res = await nodesApi.issueToken(targetNodeId)
      setIssuedToken(res.token)
      if (onTokenIssued) {
        onTokenIssued(res.token)
      }
      if (onRefresh) {
        await onRefresh()
      }
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : String(err))
    } finally {
      setIssuing(false)
    }
  }

  const handleCopyCmd = async () => {
    if (!guide) return
    const ok = await copyToClipboard(guide.oneLineCommand)
    if (ok) {
      setCopiedCmd(true)
      setTimeout(() => setCopiedCmd(false), 2000)
    }
  }

  const handleCopyToken = async () => {
    if (!issuedToken) return
    const ok = await copyToClipboard(issuedToken)
    if (ok) {
      setCopiedToken(true)
      setTimeout(() => setCopiedToken(false), 2000)
    }
  }

  const handleHealthCheck = async () => {
    if (!node?.id) return
    setCheckingHealth(true)
    setHealthError(null)

    try {
      const res = await nodesApi.checkUpgrade(node.id)
      setHealthResult(res)
    } catch (err) {
      setHealthError(err instanceof Error ? err.message : String(err))
    } finally {
      setCheckingHealth(false)
    }
  }

  const health = node?.health
  const memUsage = health ? formatUsage(health.memFreeBytes, health.memTotalBytes) : null
  const diskUsage = health ? formatUsage(health.diskFreeBytes, health.diskTotalBytes) : null
  const uptime = formatUptime(health?.uptimeSec ?? node?.uptimeSec)
  const tools =
    Array.isArray(node?.tools) && node.tools.length > 0
      ? node.tools
      : ['bash', 'read', 'write', 'edit']

  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content"
          role="dialog"
          aria-label={displayName}
        >
          {/* Header metadata */}
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-icon-wrap">
                <HelmIcon name={iconName} size={22} />
              </div>
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title break-word">
                    {displayName}
                  </DialogTitle>
                  {!isNew && (
                    <span
                      className={`badge ${isOnline ? 'badge-ok' : 'badge-neutral'}`}
                    >
                      <HelmIcon name={isOnline ? 'check' : 'circle'} size={10} />
                      <span>{isOnline ? t('common.online') : t('common.offline')}</span>
                    </span>
                  )}
                  {isLocal && (
                    <span className="badge badge-neutral">{t('nodes.local')}</span>
                  )}
                  {node?.version && (
                    <span className="badge badge-neutral mono">
                      {node.version.startsWith('v') ? node.version : `v${node.version}`}
                    </span>
                  )}
                </div>
                {!isNew && node?.id && (
                  <div className="mono text-subtle break-word">{node.id}</div>
                )}
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm"
                aria-label={t('common.close')}
                title={t('common.close')}
                onClick={onClose}
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* Drawer body */}
          <div className="primary-drawer-body">
            {!node && !isNew ? (
              <div className="primary-center-empty">{t('nodes.drawer.noSelection')}</div>
            ) : (
              <>
                {/* 1. Node system overview */}
                {!isNew && node && (
                  <section className="section-flat">
                    <div className="section-flat-header">
                      <HelmIcon name="cpu" size={13} />
                      <span className="section-flat-title">{t('nodes.drawer.overview')}</span>
                    </div>

                    <div className="form-grid">
                      <span className="form-grid-label">{t('nodes.drawer.os')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.os || node.platform || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.arch')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.arch || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.version')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.version || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.hostname')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.hostname || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.cwd')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.cwd || '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.channel')}</span>
                      <span className="mono selectable form-grid-value">
                        {node.hubUrl || (isLocal ? t('nodes.drawer.localIpc') : '--')}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.uptime')}</span>
                      <span className="mono selectable form-grid-value">{uptime}</span>
                    </div>
                  </section>
                )}

                {/* 1.5 Plugin extension slots (other plugins inject node sections into builtin:node/detail-section) */}
                {!isNew && node && (
                  <PluginSlot
                    ownerPluginId="builtin:node"
                    name={NODE_DETAIL_SECTION_SLOT}
                    slotProps={{
                      nodeId: node.id,
                      isLocal,
                      isOnline,
                      isNew: false,
                    }}
                  />
                )}

                {/* 2. Node health check */}
                {!isNew && node && (
                  <section className="section-flat">
                    <div className="section-flat-header flex-row-between">
                      <div className="flex-row">
                        <HelmIcon name="activity" size={13} />
                        <span className="section-flat-title">{t('nodes.drawer.healthSection')}</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={checkingHealth}
                        onClick={() => void handleHealthCheck()}
                      >
                        <HelmIcon name="activity" size={12} />
                        <span>{checkingHealth ? t('nodes.drawer.checking') : t('nodes.drawer.healthAction')}</span>
                      </button>
                    </div>

                    <div className="form-grid">
                      <span className="form-grid-label">{t('nodes.drawer.cpuUsage')}</span>
                      <span className="mono selectable form-grid-value">
                        {health?.cpuUsagePercent !== undefined
                          ? `${health.cpuUsagePercent}%`
                          : '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.systemLoad')}</span>
                      <span className="mono selectable form-grid-value">
                        {health?.loadAvg
                          ? `${health.loadAvg[0]?.toFixed(2) ?? '--'} / ${health.loadAvg[1]?.toFixed(2) ?? '--'} / ${health.loadAvg[2]?.toFixed(2) ?? '--'}`
                          : health?.load1 !== undefined
                            ? `${health.load1} / ${health.load5 ?? '--'} / ${health.load15 ?? '--'}`
                            : '--'}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.memUsage')}</span>
                      <span className="mono selectable form-grid-value">
                        {memUsage?.label ??
                          (health?.memTotalBytes !== undefined
                            ? formatBytes(health.memTotalBytes)
                            : '--')}
                      </span>

                      <span className="form-grid-label">{t('nodes.drawer.diskSpace')}</span>
                      <span className="mono selectable form-grid-value">
                        {diskUsage?.label ??
                          (health?.diskTotalBytes !== undefined
                            ? formatBytes(health.diskTotalBytes)
                            : '--')}
                      </span>
                    </div>

                    {healthResult && (
                      <div
                        className={`callout ${healthResult.updateAvailable ? 'callout-warn' : 'callout-ok'}`}
                        role="status"
                      >
                        <HelmIcon
                          name={healthResult.updateAvailable ? 'alert-triangle' : 'check'}
                          size={13}
                        />
                        <span className="callout-text">
                          {healthResult.updateAvailable
                            ? t('nodes.drawer.updateAvailable', { version: healthResult.latestVersion })
                            : t('nodes.drawer.upToDate')}
                        </span>
                      </div>
                    )}

                    {healthError && (
                      <div className="callout callout-error" role="alert">
                        <HelmIcon name="alert-circle" size={13} />
                        <span className="callout-text">{healthError}</span>
                      </div>
                    )}
                  </section>
                )}

                {/* 3. Remote node access token and start command (when the node is remote or used to enroll a new node) */}
                {(!isLocal || isNew) && (
                  <section className="section-flat border-accent">
                    <div className="section-flat-header">
                      <HelmIcon name="key" size={13} />
                      <span className="section-flat-title">{t('nodes.drawer.enrollSection')}</span>
                    </div>

                    {isNew && (
                      <div className="form-grid">
                        <label htmlFor="new-node-id-input" className="form-grid-label">
                          {t('nodes.drawer.nodeId')}
                        </label>
                        <input
                          id="new-node-id-input"
                          type="text"
                          className="input mono"
                          placeholder={t('nodes.drawer.nodeIdPlaceholder')}
                          value={newNodeId}
                          onChange={(e) => setNewNodeId(e.target.value)}
                        />
                      </div>
                    )}

                    <div className="flex-row">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={issuing || (isNew && !newNodeId.trim())}
                        onClick={() => void handleIssueToken()}
                      >
                        <HelmIcon name="key" size={12} />
                        <span>{issuedToken ? t('nodes.drawer.reissueToken') : t('nodes.drawer.issueToken')}</span>
                      </button>
                    </div>

                    {tokenError && (
                      <div className="callout callout-error" role="alert">
                        <HelmIcon name="alert-circle" size={13} />
                        <span className="callout-text">{tokenError}</span>
                      </div>
                    )}

                    {issuedToken && (
                      <div className="flex-col">
                        <div className="text-subtle">{t('nodes.drawer.tokenLabel')}</div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {issuedToken}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void handleCopyToken()}
                            title={t('nodes.drawer.copyToken')}
                          >
                            <HelmIcon name={copiedToken ? 'check' : 'copy'} size={12} />
                            <span>{copiedToken ? t('nodes.drawer.copied') : t('nodes.drawer.copyToken')}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {guide && (
                      <div className="flex-col">
                        <div className="text-subtle">{t('nodes.drawer.oneLineLabel')}</div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {guide.oneLineCommand}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void handleCopyCmd()}
                            title={t('nodes.drawer.copyCommandTitle')}
                          >
                            <HelmIcon name={copiedCmd ? 'check' : 'copy'} size={12} />
                            <span>{copiedCmd ? t('nodes.drawer.copied') : t('nodes.drawer.copyCommand')}</span>
                          </button>
                        </div>

                        <div className="text-subtle">
                          {t('nodes.drawer.maintenanceLabel')}
                        </div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {guide.startDaemonCommand}
                          </code>
                          <CopyButton text={guide.startDaemonCommand} />
                        </div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {guide.doctorCommand}
                          </code>
                          <CopyButton text={guide.doctorCommand} />
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {/* 4. Registered tool capabilities */}
                {!isNew && (
                  <section className="section-flat">
                    <div className="section-flat-header">
                      <HelmIcon name="wrench" size={13} />
                      <span className="section-flat-title">{t('nodes.drawer.toolsSection')}</span>
                    </div>

                    <div className="primary-card-pills">
                      {tools.map((tool) => (
                        <span
                          key={tool}
                          className="primary-card-pill mono"
                          title={t('nodes.drawer.toolTitle', { tool })}
                        >
                          <HelmIcon name="terminal" size={11} />
                          <span>{tool}</span>
                        </span>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>

          {/* Drawer footer */}
          <div className="primary-drawer-footer">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
