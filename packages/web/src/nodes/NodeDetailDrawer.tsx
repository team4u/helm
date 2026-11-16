import React, { useState } from 'react'
import { copyToClipboard, CopyButton, HelmIcon, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle, PluginSlot } from '@helm/plugin-client'
import { nodesApi, type NodeUpgradeCheckResult } from '../lib/api.js'
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
import { NODE_DETAIL_SECTION_SLOT } from '@helm/protocol'

export interface NodeDetailDrawerProps {
  node: NodeInfo | null
  open: boolean
  onClose: () => void
  /** 显式指定是否内联渲染（便于测试与 SSR 统一断言） */
  inline?: boolean
  /** 是否处于接入新节点模式 */
  isNew?: boolean
  onTokenIssued?: (token: string) => void
  onRefresh?: () => Promise<unknown> | void
}

/**
 * 全屏计算节点中心右侧滑出抽屉（NodeDetailDrawer）：
 * - 基于 Radix Dialog 原语实现 520px-560px 抽屉；
 * - 头部：节点图标、友好名称、在线状态徽章、mono 节点 ID 与关闭按钮；
 * - 节点系统概览：操作系统、CPU架构、Node版本、主机名、工作目录、连接地址、运行时长；
 * - 节点健康体检：体检触发按钮、CPU 负载、内存与磁盘容量图表、版本诊断；
 * - 远程节点接入与命令：签发接入令牌（调用 nodesApi.issueToken）、一键复制接入命令行及复制反馈；
 * - 注册工具能力列表：bash / read / write / edit 矢量能力清单；
 * - 插件扩展子插槽：已有节点在系统概览后挂载 builtin:node/detail-section
 *   （其他插件注入节点维度扩展区块；仅传节点公开快照，不含接入令牌等凭据）；
 * - 严格遵循零 Emoji 铁律与 Fast Refresh 规范。
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
  const displayName = isNew ? '接入新计算节点' : node ? getNodeDisplayName(node) : '节点详情'
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
      setTokenError('请指定有效的节点 ID')
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
          {/* 头部元信息 */}
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
                      <span>{isOnline ? '在线' : '离线'}</span>
                    </span>
                  )}
                  {isLocal && (
                    <span className="badge badge-neutral">本机</span>
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
                aria-label="关闭"
                title="关闭"
                onClick={onClose}
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* 抽屉主体 */}
          <div className="primary-drawer-body">
            {!node && !isNew ? (
              <div className="primary-center-empty">未选择节点</div>
            ) : (
              <>
                {/* 1. 节点系统概览 */}
                {!isNew && node && (
                  <section className="section-flat">
                    <div className="section-flat-header">
                      <HelmIcon name="cpu" size={13} />
                      <span className="section-flat-title">系统概览</span>
                    </div>

                    <div className="form-grid">
                      <span className="form-grid-label">操作系统</span>
                      <span className="mono selectable form-grid-value">
                        {node.os || node.platform || '--'}
                      </span>

                      <span className="form-grid-label">CPU 架构</span>
                      <span className="mono selectable form-grid-value">
                        {node.arch || '--'}
                      </span>

                      <span className="form-grid-label">Node 版本</span>
                      <span className="mono selectable form-grid-value">
                        {node.version || '--'}
                      </span>

                      <span className="form-grid-label">主机名</span>
                      <span className="mono selectable form-grid-value">
                        {node.hostname || '--'}
                      </span>

                      <span className="form-grid-label">工作目录</span>
                      <span className="mono selectable form-grid-value">
                        {node.cwd || '--'}
                      </span>

                      <span className="form-grid-label">连接通道</span>
                      <span className="mono selectable form-grid-value">
                        {node.hubUrl || (isLocal ? '本地 IPC / Socket' : '--')}
                      </span>

                      <span className="form-grid-label">运行时长</span>
                      <span className="mono selectable form-grid-value">{uptime}</span>
                    </div>
                  </section>
                )}

                {/* 1.5 插件扩展子插槽（其他插件向 builtin:node/detail-section 注入节点扩展区块） */}
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

                {/* 2. 节点健康体检 */}
                {!isNew && node && (
                  <section className="section-flat">
                    <div className="section-flat-header flex-row-between">
                      <div className="flex-row">
                        <HelmIcon name="activity" size={13} />
                        <span className="section-flat-title">健康体检与资源负载</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={checkingHealth}
                        onClick={() => void handleHealthCheck()}
                      >
                        <HelmIcon name="activity" size={12} />
                        <span>{checkingHealth ? '体检中…' : '健康体检'}</span>
                      </button>
                    </div>

                    <div className="form-grid">
                      <span className="form-grid-label">CPU 占用</span>
                      <span className="mono selectable form-grid-value">
                        {health?.cpuUsagePercent !== undefined
                          ? `${health.cpuUsagePercent}%`
                          : '--'}
                      </span>

                      <span className="form-grid-label">系统负载</span>
                      <span className="mono selectable form-grid-value">
                        {health?.loadAvg
                          ? `${health.loadAvg[0]?.toFixed(2) ?? '--'} / ${health.loadAvg[1]?.toFixed(2) ?? '--'} / ${health.loadAvg[2]?.toFixed(2) ?? '--'}`
                          : health?.load1 !== undefined
                            ? `${health.load1} / ${health.load5 ?? '--'} / ${health.load15 ?? '--'}`
                            : '--'}
                      </span>

                      <span className="form-grid-label">内存使用</span>
                      <span className="mono selectable form-grid-value">
                        {memUsage?.label ??
                          (health?.memTotalBytes !== undefined
                            ? formatBytes(health.memTotalBytes)
                            : '--')}
                      </span>

                      <span className="form-grid-label">磁盘空间</span>
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
                            ? `存在可用更新：v${healthResult.latestVersion}`
                            : '节点内核运行正常，版本已处于最新状态'}
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

                {/* 3. 远程节点接入令牌与启动命令（当节点是 remote 或用于接入新节点时） */}
                {(!isLocal || isNew) && (
                  <section className="section-flat border-accent">
                    <div className="section-flat-header">
                      <HelmIcon name="key" size={13} />
                      <span className="section-flat-title">受控机接入指令</span>
                    </div>

                    {isNew && (
                      <div className="form-grid">
                        <label htmlFor="new-node-id-input" className="form-grid-label">
                          节点 ID
                        </label>
                        <input
                          id="new-node-id-input"
                          type="text"
                          className="input mono"
                          placeholder="例如 gpu-worker-1"
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
                        <span>{issuedToken ? '重新签发令牌' : '签发接入令牌'}</span>
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
                        <div className="text-subtle">接入令牌（一次性展示）：</div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {issuedToken}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void handleCopyToken()}
                            title="复制令牌"
                          >
                            <HelmIcon name={copiedToken ? 'check' : 'copy'} size={12} />
                            <span>{copiedToken ? '已复制' : '复制令牌'}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {guide && (
                      <div className="flex-col">
                        <div className="text-subtle">一键接入命令行（后台守护进程启动）：</div>
                        <div className="flex-row flex-row-wrap">
                          <code className="code-box selectable flex-1 mono">
                            {guide.oneLineCommand}
                          </code>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => void handleCopyCmd()}
                            title="复制命令行"
                          >
                            <HelmIcon name={copiedCmd ? 'check' : 'copy'} size={12} />
                            <span>{copiedCmd ? '已复制' : '复制命令'}</span>
                          </button>
                        </div>

                        <div className="text-subtle">
                          常用维护命令：
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

                {/* 4. 注册工具能力列表 */}
                {!isNew && (
                  <section className="section-flat">
                    <div className="section-flat-header">
                      <HelmIcon name="wrench" size={13} />
                      <span className="section-flat-title">注册工具能力</span>
                    </div>

                    <div className="primary-card-pills">
                      {tools.map((tool) => (
                        <span
                          key={tool}
                          className="primary-card-pill mono"
                          title={`工具: ${tool}`}
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

          {/* 抽屉底部 */}
          <div className="primary-drawer-footer">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              关闭
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
