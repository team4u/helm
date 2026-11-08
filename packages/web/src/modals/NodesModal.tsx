import { useEffect, useMemo, useState } from 'react'
import type { NodeInfo } from '@helm/protocol'
import { conversationsApi, nodesApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { CopyButton } from '../conversation/CopyButton.js'
import {
  buildNodeConnectGuide,
  formatBytes,
  formatUptime,
  formatUsage,
  validateNodeIdInput,
  type NodeConnectGuide,
} from './nodes-modal-model.js'

/** 一次性明文令牌 + 受控机接入命令卡片（刚签发/轮换时展示）。 */
function TokenGuideCard({
  guide,
  token,
}: {
  guide: NodeConnectGuide
  token: string
}) {
  const rows: Array<{ label: string; command: string; hint?: string }> = [
    { label: '一键连接并启动', command: guide.oneLineCommand },
    { label: '连接 Hub', command: guide.connectCommand },
    { label: '后台启动守护进程', command: guide.startDaemonCommand },
    { label: '安装系统服务（可选）', command: guide.serviceInstallCommand },
    { label: '诊断', command: guide.doctorCommand, hint: '连接异常时在受控机运行' },
  ]
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--accent)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <HelmIcon name="key" size={13} />
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>接入令牌（仅本次展示）</span>
        <span className="badge badge-warn">
          <HelmIcon name="alert-triangle" size={10} />
          明文接入令牌仅展示一次（服务端仅存 SHA-256 摘要）
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <code
          className="mono selectable"
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, padding: '4px 8px', background: 'var(--bg-inset)', borderRadius: 6, wordBreak: 'break-all' }}
        >
          {token}
        </code>
        <CopyButton text={token} label="复制令牌" />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
        在受控机执行以下命令完成接入（需已安装 helm-node）：
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((row) => (
          <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11.5, color: 'var(--fg-muted)', flexShrink: 0 }}>{row.label}</span>
              {row.hint && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{row.hint}</span>}
              <span style={{ flex: 1 }} />
              <CopyButton text={row.command} />
            </div>
            <code
              className="mono selectable"
              style={{ fontSize: 11.5, padding: '4px 8px', background: 'var(--bg-inset)', borderRadius: 6, wordBreak: 'break-all' }}
            >
              {row.command}
            </code>
          </div>
        ))}
      </div>
    </section>
  )
}

/** 离线 BYOM 节点的接入命令模板提示（无当次明文 token 时）。 */
function OfflineHintCard({ guide }: { guide: NodeConnectGuide }) {
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <HelmIcon name="alert-circle" size={13} />
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>该节点当前未连接</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        若已在受控机执行过 connect，运行 <code className="mono">{guide.startDaemonCommand}</code> 即可恢复连接；若丢失令牌，可点击上方「轮换令牌」重新签发。
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <code
          className="mono selectable"
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, padding: '4px 8px', background: 'var(--bg-inset)', borderRadius: 6 }}
        >
          {guide.doctorCommand}
        </code>
        <CopyButton text={guide.doctorCommand} />
      </div>
    </section>
  )
}

/** 键值信息行。 */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '2px 12px', alignItems: 'baseline' }}>
      <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{label}</span>
      <span className="mono selectable" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{value}</span>
    </div>
  )
}

function formatTime(ms: number | undefined): string {
  if (ms === undefined) return '--'
  return new Date(ms).toLocaleString()
}

/** 健康快照卡片：负载 / 运行时长 / 内存 / 磁盘。 */
function HealthCard({ node }: { node: NodeInfo }) {
  const health = node.health
  if (!health) {
    return (
      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <HelmIcon name="activity" size={13} />
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>健康快照</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>暂无健康数据（节点离线或尚未上报心跳）。</div>
      </section>
    )
  }
  const [la1 = 0, la5 = 0, la15 = 0] = health.loadAvg ?? []
  const mem = formatUsage(health.memFreeBytes, health.memTotalBytes)
  const disk = formatUsage(health.diskFreeBytes, health.diskTotalBytes)
  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <HelmIcon name="activity" size={13} />
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>健康快照</span>
        <span className="badge badge-neutral">采集于 {formatTime(health.collectedAt)}</span>
      </div>
      <InfoRow label="负载" value={`1m ${la1.toFixed(2)} / 5m ${la5.toFixed(2)} / 15m ${la15.toFixed(2)}`} />
      <InfoRow label="运行时长" value={formatUptime(health.uptimeSec)} />
      <InfoRow
        label="物理内存"
        value={
          mem
            ? `${mem.label}（可用 ${formatBytes(health.memFreeBytes)}）`
            : `${formatBytes(health.memFreeBytes)} 可用 / ${formatBytes(health.memTotalBytes)}`
        }
      />
      <InfoRow label="磁盘" value={disk ? disk.label : '--'} />
    </section>
  )
}

/** 右栏「接入新节点」模式：输入 ID 签发令牌。 */
function IssuePanel({ onIssued }: { onIssued: (nodeId: string, token: string) => void }) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)

  const issue = async () => {
    const validated = validateNodeIdInput(input)
    if (!validated.ok) {
      setError(validated.error)
      return
    }
    setIssuing(true)
    setError(null)
    try {
      const issued = await nodesApi.issueToken(validated.nodeId)
      onIssued(issued.nodeId, issued.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIssuing(false)
    }
  }

  return (
    <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <HelmIcon name="plus" size={13} />
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>接入新节点</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        输入受控机的节点 ID（如 macbook-pro、gpu-box），签发一次性接入令牌后在受控机执行 helm-node connect。
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className="input mono"
          style={{ flex: 1 }}
          value={input}
          autoFocus
          placeholder="节点 ID，如 macbook-pro"
          aria-label="新节点 ID"
          onChange={(e) => {
            setInput(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void issue()
          }}
        />
        <button className="btn btn-primary btn-sm" disabled={issuing} onClick={() => void issue()}>
          <HelmIcon name={issuing ? 'loader' : 'key'} size={12} />
          {issuing ? '签发中...' : '签发接入令牌'}
        </button>
      </div>
      {error && (
        <div className="jr-callout jr-callout-err">
          <HelmIcon name="alert-circle" size={13} />
          <span className="selectable">{error}</span>
        </div>
      )}
    </section>
  )
}

/** 右栏「节点详情」模式。 */
function NodeDetailPanel({
  node,
  issuedToken,
  onTokenIssued,
  onClose,
}: {
  node: NodeInfo
  /** 当次会话内签发/轮换得到的一次性明文令牌（仅本次展示）。 */
  issuedToken: string | undefined
  onTokenIssued: (token: string) => void
  onClose: () => void
}) {
  const store = useHelmStore()
  const [rotating, setRotating] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [creating, setCreating] = useState(false)

  const hubOrigin = useMemo(() => {
    try {
      return window.location.origin
    } catch {
      return 'http://127.0.0.1:3202'
    }
  }, [])
  const guide = useMemo(
    () => buildNodeConnectGuide(hubOrigin, { nodeId: node.id, token: issuedToken ?? 'TOKEN' }),
    [hubOrigin, node.id, issuedToken],
  )

  const rotate = async () => {
    if (rotating) return
    setRotating(true)
    try {
      const issued = await nodesApi.issueToken(node.id)
      await store.refreshNodes()
      onTokenIssued(issued.token)
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '节点令牌已轮换',
        body: `${node.id} 旧令牌已失效，请用新令牌在受控机重新 connect`,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '轮换令牌失败',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRotating(false)
    }
  }

  const remove = async () => {
    if (removing) return
    setRemoving(true)
    try {
      await nodesApi.remove(node.id)
      store.pushNotice({ type: 'notification', level: 'info', title: '节点已移除', body: node.id })
      await store.refreshNodes()
      setConfirmRemove(false)
      onClose()
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '移除节点失败',
        body: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setRemoving(false)
    }
  }

  const createConversation = async () => {
    if (creating) return
    setCreating(true)
    try {
      const conv = await conversationsApi.create({ nodeId: node.id })
      store.openTarget({ kind: 'conversation', conversationId: conv.id })
      store.setActiveModal(null)
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '新建对话失败',
        body: err instanceof Error ? err.message : String(err),
      })
      setCreating(false)
    }
  }

  return (
    <>
      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 13 }} className="mono">
            {node.id}
          </span>
          <span className="badge badge-neutral">
            <HelmIcon name={node.kind === 'local' ? 'monitor' : 'network'} size={10} />
            {node.kind === 'local' ? '本机内建' : '远端节点 BYOM'}
          </span>
          <span className={node.online ? 'badge badge-ok' : 'badge badge-neutral'}>
            <HelmIcon name={node.online ? 'check-circle' : 'circle'} size={10} />
            {node.online ? '在线' : '离线'}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm" disabled={creating} onClick={() => void createConversation()}>
            <HelmIcon name="plus" size={12} />
            在此节点新建对话
          </button>
          {node.kind === 'byom' && (
            <>
              <button className="btn btn-sm" disabled={rotating} onClick={() => void rotate()}>
                <HelmIcon name={rotating ? 'loader' : 'key'} size={12} />
                轮换令牌
              </button>
              {confirmRemove ? (
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <button className="btn btn-danger btn-sm" disabled={removing} onClick={() => void remove()}>
                    <HelmIcon name={removing ? 'loader' : 'trash-2'} size={12} />
                    确认移除
                  </button>
                  <button className="btn btn-sm" onClick={() => setConfirmRemove(false)}>
                    取消
                  </button>
                </span>
              ) : (
                <button className="btn btn-danger btn-sm" onClick={() => setConfirmRemove(true)}>
                  <HelmIcon name="trash-2" size={12} />
                  移除节点
                </button>
              )}
            </>
          )}
        </div>
      </section>

      {(issuedToken !== undefined || (node.kind === 'byom' && !node.online)) && (
        <>
          {issuedToken !== undefined ? (
            <TokenGuideCard guide={guide} token={issuedToken} />
          ) : (
            <OfflineHintCard guide={guide} />
          )}
        </>
      )}

      <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <HelmIcon name="terminal" size={13} />
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>连接与环境</span>
        </div>
        <InfoRow label="hostname" value={node.hostname ?? '--'} />
        <InfoRow label="platform" value={node.platform ?? '--'} />
        <InfoRow label="hubUrl" value={node.hubUrl ?? '--'} />
        <InfoRow label="connectedAt" value={formatTime(node.connectedAt)} />
        <InfoRow label="lastSeenAt" value={formatTime(node.lastSeenAt)} />
      </section>

      <HealthCard node={node} />
    </>
  )
}

/** 计算节点管理弹窗：左栏节点列表 + 右栏接入/详情。 */
export function NodesModal({ initialNodeId, onClose }: { initialNodeId?: string; onClose: () => void }) {
  const store = useHelmStore()
  const [selectedId, setSelectedId] = useState<string | null>(initialNodeId ?? store.nodes[0]?.id ?? 'local')
  const [issuingMode, setIssuingMode] = useState(false)
  /** 当次会话内签发/轮换的一次性明文令牌（nodeId -> token）。 */
  const [issuedTokens, setIssuedTokens] = useState<Record<string, string>>({})

  const refreshNodes = store.refreshNodes
  useEffect(() => {
    void refreshNodes()
  }, [refreshNodes])

  // 移除事件到达后选中节点可能已不存在：兜底切回 local。
  const nodes = store.nodes
  const selected = nodes.find((n) => n.id === selectedId)
  useEffect(() => {
    if (selected === undefined && !issuingMode && nodes.length > 0) setSelectedId(nodes[0]!.id)
  }, [selected, issuingMode, nodes])

  const onIssued = (nodeId: string, token: string) => {
    setIssuedTokens((prev) => ({ ...prev, [nodeId]: token }))
    setSelectedId(nodeId)
    setIssuingMode(false)
    void refreshNodes()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 880 }}
        role="dialog"
        aria-modal="true"
        aria-label="计算节点管理"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <HelmIcon name="network" size={15} />
            计算节点
          </span>
          <button className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭" onClick={onClose}>
            <HelmIcon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body asset-modal-body" style={{ flexDirection: 'row', gap: 14, alignItems: 'stretch' }}>
          <div className="list asset-modal-list" style={{ width: 230, minWidth: 230, overflowY: 'auto', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className={`btn btn-sm${issuingMode ? ' btn-primary' : ''}`}
                style={{ flex: 1 }}
                onClick={() => setIssuingMode((v) => !v)}
              >
                <HelmIcon name="plus" size={12} />
                {issuingMode ? '返回列表' : '接入新节点'}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                title="刷新节点列表与健康指标"
                aria-label="刷新节点列表"
                onClick={() => void refreshNodes()}
              >
                <HelmIcon name="refresh-cw" size={13} />
              </button>
            </div>
            {nodes.length === 0 && (
              <div className="row" style={{ color: 'var(--fg-subtle)' }}>暂无已知节点</div>
            )}
            {nodes.map((node) => (
              <button
                key={node.id}
                className="row"
                aria-pressed={selectedId === node.id && !issuingMode}
                style={{
                  width: '100%',
                  background: selectedId === node.id && !issuingMode ? 'var(--bg-active)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 3,
                }}
                onClick={() => {
                  setIssuingMode(false)
                  setSelectedId(node.id)
                }}
              >
                <span style={{ fontWeight: 500, fontSize: 12.5, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                  <HelmIcon name={node.kind === 'local' ? 'monitor' : 'network'} size={11} />
                  {node.id}
                </span>
                <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="badge badge-neutral">{node.kind === 'local' ? '本机' : 'BYOM'}</span>
                  <span className={node.online ? 'badge badge-ok' : 'badge badge-neutral'}>
                    {node.online ? '在线' : '离线'}
                  </span>
                </span>
                {(node.hostname !== undefined || node.platform !== undefined) && (
                  <span className="mono" style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                    {[node.hostname, node.platform].filter(Boolean).join(' / ')}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
            {issuingMode ? (
              <IssuePanel onIssued={onIssued} />
            ) : selected ? (
              <NodeDetailPanel
                key={selected.id}
                node={selected}
                issuedToken={issuedTokens[selected.id]}
                onTokenIssued={(token) => setIssuedTokens((prev) => ({ ...prev, [selected.id]: token }))}
                onClose={() => setSelectedId('local')}
              />
            ) : (
              <div style={{ color: 'var(--fg-subtle)', fontSize: 12.5, padding: '24px 0', textAlign: 'center' }}>
                选择左侧节点查看详情
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
