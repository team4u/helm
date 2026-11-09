import { useEffect, useMemo, useRef, useState } from 'react'
import type { NodeInfo } from '@helm/protocol'
import { conversationsApi, nodesApi } from '../lib/api.js'
import { formatDateTime } from '../lib/format.js'
import type { NodeUpgradeCheckResult } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { CopyButton } from '../conversation/CopyButton.js'
import { Checkbox } from '../ui/Checkbox.js'
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '../ui/Dialog.js'
import { deepLinkSelection, shouldSyncSelectionToStore } from './list-modal-selection.js'
import {
  buildNodeConnectGuide,
  canConfirmNodeUpgrade,
  formatBytes,
  formatNodeVersion,
  formatUptime,
  formatUsage,
  isNodeBehindHub,
  resolveUpgradeTarget,
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
    { label: '一键接入（后台守护）', command: guide.oneLineCommand },
    {
      label: '前台连接（调试用）',
      command: guide.connectCommand,
      hint: '前台常驻，按 Ctrl+C 退出',
    },
    { label: '启动守护进程（已绑定身份）', command: guide.startDaemonCommand },
    {
      label: '安装系统服务（可选）',
      command: guide.serviceInstallCommand,
      hint: '需先完成上方接入以绑定节点身份',
    },
    { label: '诊断', command: guide.doctorCommand, hint: '连接异常时在受控机运行' },
  ]
  return (
    <section className="section-flat border-accent">
      <div className="section-flat-header">
        <HelmIcon name="key" size={13} />
        <span className="section-flat-title">接入令牌（仅本次展示）</span>
        <span className="badge badge-warn">
          <HelmIcon name="alert-triangle" size={10} />
          明文接入令牌仅展示一次（服务端仅存 SHA-256 摘要）
        </span>
      </div>
      <div className="flex-row">
        <code className="code-box selectable flex-1">
          {token}
        </code>
        <CopyButton text={token} label="复制令牌" />
      </div>
      <div className="text-muted">
        在受控机执行以下命令完成接入（需已安装 helm-node）：
      </div>
      <div className="flex-col">
        {rows.map((row) => (
          <div key={row.label} className="flex-col-xs">
            <div className="flex-row">
              <span className="text-muted flex-shrink-0">{row.label}</span>
              {row.hint && <span className="text-subtle">{row.hint}</span>}
              <span className="flex-1" />
              <CopyButton text={row.command} />
            </div>
            <code className="code-box selectable">
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
    <section className="section-flat">
      <div className="section-flat-header">
        <HelmIcon name="alert-circle" size={13} />
        <span className="section-flat-title">该节点当前未连接</span>
      </div>
      <div className="text-muted">
        若已在受控机绑定过身份，运行 <code className="mono">{guide.startDaemonCommand}</code> 即可启动后台守护进程恢复连接；若丢失令牌，可点击上方「轮换令牌」重新签发。
      </div>
      <div className="flex-row">
        <code className="code-box selectable flex-1">
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
    <div className="form-grid">
      <span className="form-grid-label">{label}</span>
      <span className="mono selectable form-grid-value">{value}</span>
    </div>
  )
}

/** 健康快照卡片：负载 / 运行时长 / 内存 / 磁盘。 */
function HealthCard({ node }: { node: NodeInfo }) {
  const health = node.health
  if (!health) {
    return (
      <section className="section-flat">
        <div className="section-flat-header">
          <HelmIcon name="activity" size={13} />
          <span className="section-flat-title">健康快照</span>
        </div>
        <div className="text-subtle">暂无健康数据（节点离线或尚未上报心跳）。</div>
      </section>
    )
  }
  const [la1 = 0, la5 = 0, la15 = 0] = health.loadAvg ?? []
  const mem = formatUsage(health.memFreeBytes, health.memTotalBytes)
  const disk = formatUsage(health.diskFreeBytes, health.diskTotalBytes)
  return (
    <section className="section-flat">
      <div className="section-flat-header">
        <HelmIcon name="activity" size={13} />
        <span className="section-flat-title">健康快照</span>
        <span className="badge badge-neutral">采集于 {formatDateTime(health.collectedAt)}</span>
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
function IssuePanel({
  existingNodeIds,
  onIssued,
}: {
  /** 当前已知节点 ID（store.nodes）：已存在节点禁止在此签发，避免误轮换。 */
  existingNodeIds: ReadonlySet<string>
  onIssued: (nodeId: string, token: string) => void
}) {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)

  const issue = async () => {
    if (issuing) return
    const validated = validateNodeIdInput(input)
    if (!validated.ok) {
      setError(validated.error)
      return
    }
    if (existingNodeIds.has(validated.nodeId)) {
      setError(
        `节点 ${validated.nodeId} 已存在，重新签发会使旧令牌立即失效；请在左侧列表选中该节点后使用「轮换令牌」`,
      )
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
    <section className="section-flat">
      <div className="section-flat-header">
        <HelmIcon name="plus" size={13} />
        <span className="section-flat-title">接入新节点</span>
      </div>
      <div className="text-muted">
        输入受控机的节点 ID（如 macbook-pro、gpu-box），签发一次性接入令牌；随后在受控机执行签发结果中的一键接入命令，绑定身份并后台启动守护进程。
      </div>
      <div className="flex-row">
        <input
          className="input mono flex-1"
          value={input}
          autoFocus
          placeholder="节点 ID，如 macbook-pro"
          aria-label="新节点 ID"
          disabled={issuing}
          onChange={(e) => {
            setInput(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !issuing) void issue()
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

/** 受控节点（byom）自升级卡片：检查更新（npm 最新）/ 显式目标 / 对齐 Hub / 强制重装。 */
function NodeUpgradeCard({
  node,
  hubVersion,
  check,
  checking,
  checkError,
  targetVersion,
  onTargetVersionChange,
  force,
  onForceChange,
  upgrading,
  upgradeError,
  onRecheck,
  onUpgrade,
}: {
  node: NodeInfo
  /** Hub（local 节点）版本：仅作显式目标建议，是否可安装以 npm 检查为准。 */
  hubVersion: string | undefined
  check: NodeUpgradeCheckResult | null
  checking: boolean
  checkError: string | null
  targetVersion: string
  onTargetVersionChange: (value: string) => void
  force: boolean
  onForceChange: (value: boolean) => void
  upgrading: boolean
  upgradeError: string | null
  onRecheck: () => void
  onUpgrade: () => void
}) {
  const currentLabel = formatNodeVersion(check?.currentVersion ?? node.version) ?? '未知'
  // 检查失败时旧 check 仅保留回滚记录展示，不作为门控与「最新」结论依据。
  const effectiveCheck = checkError === null ? check : null
  const confirmability = canConfirmNodeUpgrade({
    online: node.online,
    check: effectiveCheck,
    targetVersion,
    force,
  })
  const resolvedTarget = resolveUpgradeTarget(effectiveCheck, targetVersion)
  const canForce = node.online && (targetVersion.trim() !== '' || (effectiveCheck !== null && (!effectiveCheck.updateAvailable || effectiveCheck.blocked !== undefined)))
  const offlineTitle = '节点已离线，无法升级'
  return (
    <section className="section-flat">
      <div className="section-flat-header">
        <HelmIcon name="arrow-up" size={13} />
        <span className="section-flat-title">节点自升级</span>
        <span className="badge badge-neutral mono">当前 {currentLabel}</span>
        {effectiveCheck !== null && !checking && effectiveCheck.updateAvailable && (
          <span className="badge badge-ok mono">
            <HelmIcon name="arrow-up" size={10} />
            发现新版本 v{effectiveCheck.latestVersion}
          </span>
        )}
        {effectiveCheck !== null && !checking && !effectiveCheck.updateAvailable && (
          <span className="badge badge-neutral">npm 当前已是最新版本 (v{effectiveCheck.currentVersion})</span>
        )}
      </div>

      {checking && (
        <div className="flex-row text-muted">
          <HelmIcon name="loader" size={13} />
          正在检查最新版本...
        </div>
      )}

      {!checking && checkError !== null && (
        <div className="jr-callout jr-callout-err">
          <HelmIcon name="alert-circle" size={13} />
          <span className="selectable">{checkError}</span>
          <span className="flex-1" />
          <button
            className="btn btn-sm"
            disabled={checking || upgrading || !node.online}
            title={node.online ? undefined : offlineTitle}
            onClick={onRecheck}
          >
            <HelmIcon name="refresh-cw" size={12} />
            重新检查
          </button>
        </div>
      )}

      {!checking && check !== null && check.blocked && (
        <div className="jr-callout jr-callout-warn selectable">
          <HelmIcon name="shield-alert" size={13} className="flex-shrink-0" />
          <span>
            上次升级至 v{check.blocked.version} 失败回滚原因：{check.blocked.reason}（时间：{check.blocked.at}）
          </span>
        </div>
      )}

      <div className="flex-row-wrap">
        <input
          className="input mono flex-1"
          value={targetVersion}
          placeholder="留空则安装本次检查到的最新版本"
          aria-label="指定目标版本（可选）"
          disabled={upgrading}
          onChange={(e) => onTargetVersionChange(e.target.value)}
        />
        <Checkbox checked={force} onChange={onForceChange} disabled={upgrading || !canForce} label="强制重装/重试" />
      </div>
      {canForce && (
        <div className="text-subtle">
          勾选后将按目标版本强制重装（即使已是该版本），可用于重试失败回滚。
        </div>
      )}

      {isNodeBehindHub(node.version, hubVersion) && (
        <div className="flex-row-wrap">
          <button
            className="btn btn-sm"
            disabled={upgrading}
            title="以 Hub 当前版本作为显式目标；实际安装仍要求该版本已在 npm 发布"
            onClick={() => onTargetVersionChange((hubVersion ?? '').trim().replace(/^v/, ''))}
          >
            <HelmIcon name="arrow-up" size={12} />
            目标对齐 Hub {formatNodeVersion(hubVersion)}
          </button>
          <span className="text-subtle">
            检查最新（npm）与对齐 Hub 是两个不同目标，Hub 开发版本未必已发布。
          </span>
        </div>
      )}

      {confirmability.ok && resolvedTarget !== null && (
        <div className="text-muted">
          本次将安装 <span className="mono selectable">{formatNodeVersion(resolvedTarget) ?? resolvedTarget}</span>
          {targetVersion.trim() === '' ? '（固定为本次检查到的 npm 最新版本）' : '（显式指定目标）'}
        </div>
      )}

      {upgradeError !== null && (
        <div className="jr-callout jr-callout-err">
          <HelmIcon name="alert-circle" size={13} />
          <span className="selectable">{upgradeError}</span>
        </div>
      )}

      <div className="flex-row">
        <span className="flex-1" />
        <button
          className="btn btn-sm"
          disabled={checking || upgrading || !node.online}
          title={node.online ? undefined : offlineTitle}
          onClick={onRecheck}
        >
          <HelmIcon name={checking ? 'loader' : 'refresh-cw'} size={12} />
          重新检查
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={checking || upgrading || !node.online || !confirmability.ok}
          title={!node.online ? offlineTitle : confirmability.ok ? undefined : (confirmability.hint ?? undefined)}
          onClick={onUpgrade}
        >
          <HelmIcon name={upgrading ? 'loader' : 'arrow-up'} size={12} />
          {upgrading ? '升级中...' : '确认升级'}
        </button>
      </div>

      <div className="text-subtle">
        升级会先等待在途命令完成、校验安装包完整性并启动新进程，确认新进程已连接 Hub 后完成切换；若新版本启动异常将回退至当前版本。升级期间节点可能短暂离线。
      </div>
    </section>
  )
}

/** 右栏「节点详情」模式。 */
function NodeDetailPanel({
  node,
  hubVersion,
  issuedToken,
  onTokenIssued,
  onClose,
}: {
  node: NodeInfo
  /** Hub（local 节点）版本，用于展示远端节点落后提示。 */
  hubVersion: string | undefined
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
  // 受控节点自升级：面板展开状态与检查/升级进度。
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [upgradeCheck, setUpgradeCheck] = useState<NodeUpgradeCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [targetVersion, setTargetVersion] = useState('')
  const [force, setForce] = useState(false)
  const [upgrading, setUpgrading] = useState(false)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  // 远端节点新建会话必须显式指定目标机绝对路径工作目录：内核拒绝盲跑节点默认
  // 目录（init.cwd > profile.cwd > 父会话 cwd 均缺失时显式报错），也不拿 Hub
  // cwd 冒充远端路径；本机节点保持缺省 Hub 目录，无需输入。
  const [newConversationCwd, setNewConversationCwd] = useState('')
  const needsCwd = node.kind === 'byom'
  const cwdValid = !needsCwd || newConversationCwd.trim() !== ''

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
      // 先呈现一次性明文令牌再刷新列表：若刷新失败/延迟，令牌也不丢失。
      onTokenIssued(issued.token)
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '节点令牌已轮换',
        body: `${node.id} 旧令牌已失效，请用新令牌在受控机重新接入`,
      })
      await store.refreshNodes()
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
    if (creating || !cwdValid) return
    setCreating(true)
    try {
      const conv = await conversationsApi.create({
        nodeId: node.id,
        ...(needsCwd ? { cwd: newConversationCwd.trim() } : {}),
      })
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

  const runUpgradeCheck = async () => {
    if (checking || !node.online) return
    setChecking(true)
    setCheckError(null)
    try {
      const result = await nodesApi.checkUpgrade(node.id)
      setUpgradeCheck(result)
    } catch (err) {
      // 检查失败：保留旧 check 仅供回滚记录展示，不再作为门控与「最新」结论依据。
      setCheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  const openUpgrade = () => {
    setUpgradeOpen(true)
    if (upgradeCheck === null && checkError === null) void runUpgradeCheck()
  }

  const runUpgrade = async () => {
    // 面板打开后掉线 / 进行中 / 门控未过：早返回，不发起请求。
    if (upgrading || checking || !node.online) return
    if (!canConfirmNodeUpgrade({ online: node.online, check: checkError === null ? upgradeCheck : null, targetVersion, force }).ok) return
    const resolved = resolveUpgradeTarget(checkError === null ? upgradeCheck : null, targetVersion)
    if (resolved === null) return
    setUpgrading(true)
    setUpgradeError(null)
    try {
      const res = await nodesApi.upgrade(node.id, {
        targetVersion: resolved,
        ...(force ? { force: true } : {}),
      })
      if (!res.ok) {
        // 节点明确返回失败：如实报错，不显示成功通知。
        const message = `节点返回升级未成功（previousVersion v${res.previousVersion}，targetVersion v${res.targetVersion}）`
        setUpgradeError(message)
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title: '升级节点未成功',
          body: `${node.id}：${message}`,
        })
        return
      }
      if (res.upgraded) {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '节点升级完成',
          body: `${node.id} 已从 v${res.previousVersion} 升级至 v${res.targetVersion}，新进程已连接 Hub 并确认接管`,
        })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '节点无需升级',
          body: `${node.id} 已在目标版本 v${res.targetVersion}`,
        })
      }
      // 升级后当前版本已变：清空旧检查结果，下次进入面板重新拉取。
      setUpgradeCheck(null)
      setCheckError(null)
      setForce(false)
      await store.refreshNodes()
      if (node.online) void runUpgradeCheck()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setUpgradeError(message)
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '升级节点失败',
        body: message,
      })
    } finally {
      setUpgrading(false)
    }
  }

  return (
    <>
      <section className="section-flat">
        <div className="flex-row-wrap">
          <span className="mono font-semibold">
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
          {formatNodeVersion(node.version) !== null && (
            <span className="badge badge-neutral mono">{formatNodeVersion(node.version)}</span>
          )}
          {node.kind === 'byom' && isNodeBehindHub(node.version, hubVersion) && (
            <span
              className="badge badge-warn mono"
              title={`节点版本低于 Hub 当前版本 ${formatNodeVersion(hubVersion) ?? ''}；能否安装该版本以 npm 检查结果为准`}
            >
              低于 Hub {formatNodeVersion(hubVersion)}
            </span>
          )}
          <span className="flex-1" />
          {node.kind === 'local' && (
            <button className="btn btn-sm" disabled={creating} onClick={() => void createConversation()}>
              <HelmIcon name="plus" size={12} />
              在此节点新建对话
            </button>
          )}
          {node.kind === 'byom' && (
            <>
              <button
                className="btn btn-sm"
                aria-label="检查更新与升级节点"
                disabled={!node.online}
                title={node.online ? undefined : '节点已离线，无法升级'}
                onClick={openUpgrade}
              >
                <HelmIcon name={checking ? 'loader' : 'arrow-up'} size={12} />
                检查更新 / 升级
              </button>
              <button className="btn btn-sm" disabled={rotating} onClick={() => void rotate()}>
                <HelmIcon name={rotating ? 'loader' : 'key'} size={12} />
                轮换令牌
              </button>
              {confirmRemove ? (
                <span className="flex-row">
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

      {needsCwd && (
        <section className="section-flat">
          <div className="section-flat-header">
            <HelmIcon name="folder" size={13} />
            <span className="section-flat-title">在此节点新建对话</span>
          </div>
          <div className="text-muted">
            填写目标机器上的工作目录绝对路径。
          </div>
          <div className="flex-row">
            <input
              className="input mono flex-1"
              value={newConversationCwd}
              placeholder="如 /home/user/project（目标机绝对路径）"
              aria-label="新对话工作目录，目标节点绝对路径"
              onChange={(e) => setNewConversationCwd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && cwdValid && !creating) void createConversation()
              }}
            />
            <button className="btn btn-primary btn-sm" disabled={!cwdValid || creating} onClick={() => void createConversation()}>
              <HelmIcon name={creating ? 'loader' : 'plus'} size={12} />
              {creating ? '创建中...' : '创建对话'}
            </button>
          </div>
        </section>
      )}

      {node.kind === 'byom' && (upgradeOpen || upgradeCheck !== null) && (
        <NodeUpgradeCard
          node={node}
          hubVersion={hubVersion}
          check={upgradeCheck}
          checking={checking}
          checkError={checkError}
          targetVersion={targetVersion}
          onTargetVersionChange={setTargetVersion}
          force={force}
          onForceChange={setForce}
          upgrading={upgrading}
          upgradeError={upgradeError}
          onRecheck={() => void runUpgradeCheck()}
          onUpgrade={() => void runUpgrade()}
        />
      )}

      <section className="section-flat">
        <div className="section-flat-header">
          <HelmIcon name="terminal" size={13} />
          <span className="section-flat-title">连接与环境</span>
        </div>
        <InfoRow label="version" value={formatNodeVersion(node.version) ?? '--'} />
        <InfoRow label="hostname" value={node.hostname ?? '--'} />
        <InfoRow label="platform" value={node.platform ?? '--'} />
        <InfoRow label="hubUrl" value={node.hubUrl ?? '--'} />
        <InfoRow label="connectedAt" value={formatDateTime(node.connectedAt)} />
        <InfoRow label="lastSeenAt" value={formatDateTime(node.lastSeenAt)} />
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
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null)

  const refreshNodes = store.refreshNodes
  useEffect(() => {
    void refreshNodes()
  }, [refreshNodes])

  // 移除事件到达后选中节点可能已不存在：兜底切回首项（local 恒在首位）。
  const nodes = store.nodes
  const hubVersion = nodes.find((n) => n.id === 'local')?.version
  const existingNodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])
  // 刚签发节点在 store 列表到位前（HTTP 刷新未返回、SSE 未推送）用占位详情
  // 先行选中并呈现令牌；仅声明 id/kind/离线，不伪造在线/健康/连接信息，
  // 真实字段由节点注册后经 node.changed / refreshNodes 覆盖。
  const issuedButUnlisted =
    selectedId !== null && selectedId === pendingNodeId && !nodes.some((n) => n.id === selectedId)
  const selected: NodeInfo | undefined = issuedButUnlisted
    ? { id: selectedId!, kind: 'byom', online: false }
    : nodes.find((n) => n.id === selectedId)
  // store 引用快照：effect 只依赖节点列表与选中，不因无关 SSE 帧重跑。
  const storeRef = useRef(store)
  storeRef.current = store
  useEffect(() => {
    if (pendingNodeId !== null && nodes.some((n) => n.id === pendingNodeId)) setPendingNodeId(null)
    // 列表为空（刷新后快照未到）时不覆盖深链 initialNodeId；仅当选中节点确实不存在时
    // 回退首项。回退属本地决策，经守卫写回（仅弹窗仍是 nodes 时）。
    if (selected === undefined && !issuingMode && nodes.length > 0) {
      const next = nodes[0]!.id
      setSelectedId(next)
      if (shouldSyncSelectionToStore(storeRef.current.activeModal, 'nodes', next)) {
        storeRef.current.setActiveModal({ kind: 'nodes', nodeId: next })
      }
    }
  }, [selected, issuingMode, nodes, pendingNodeId])

  // 外部深链（URL 前进/后退）切换节点：本地跟随但不写回 store（源头即 store/URL，防回环）。
  const initialNodeIdRef = useRef(initialNodeId)
  useEffect(() => {
    if (initialNodeId === initialNodeIdRef.current) return
    initialNodeIdRef.current = initialNodeId
    const next = deepLinkSelection(selectedId, initialNodeId)
    if (next === null) return
    setSelectedId(next)
    setIssuingMode(false)
    setPendingNodeId(null)
  }, [initialNodeId, selectedId])

  const selectNode = (id: string) => {
    setSelectedId(id)
    if (shouldSyncSelectionToStore(store.activeModal, 'nodes', id)) {
      store.setActiveModal({ kind: 'nodes', nodeId: id })
    }
  }

  const onIssued = (nodeId: string, token: string) => {
    setIssuedTokens((prev) => ({ ...prev, [nodeId]: token }))
    setSelectedId(nodeId)
    setPendingNodeId(nodeId)
    setIssuingMode(false)
    if (shouldSyncSelectionToStore(store.activeModal, 'nodes', nodeId)) {
      store.setActiveModal({ kind: 'nodes', nodeId })
    }
    void refreshNodes()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop">
          <DialogContent
            className="modal"
            style={{ maxWidth: 880 }}
            aria-label="计算节点管理"
          >
            <div className="modal-header">
              <DialogTitle className="modal-title flex-row">
                <HelmIcon name="network" size={15} />
                计算节点
              </DialogTitle>
              <DialogClose asChild>
                <button className="btn btn-ghost btn-sm" aria-label="关闭" title="关闭">
                  <HelmIcon name="x" size={14} />
                </button>
              </DialogClose>
            </div>
            <div className="modal-body asset-modal-body">
          <div className="list asset-modal-list">
            <div className="flex-row">
              <button
                className={`btn btn-sm flex-1${issuingMode ? ' btn-primary' : ''}`}
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
              <div className="empty-state empty-state-compact">暂无已知节点</div>
            )}
            {nodes.map((node) => {
              const isSelected = selectedId === node.id && !issuingMode
              return (
                <button
                  key={node.id}
                  className={`list-item-btn${isSelected ? ' is-active' : ''}`}
                  aria-pressed={isSelected}
                  onClick={() => {
                    setIssuingMode(false)
                    selectNode(node.id)
                  }}
                >
                  <span className="list-item-btn-title">
                    <span className="flex-row">
                      <HelmIcon name={node.kind === 'local' ? 'monitor' : 'network'} size={11} />
                      {node.id}
                    </span>
                  </span>
                  <span className="list-item-btn-meta">
                    <span className="badge badge-neutral">{node.kind === 'local' ? '本机' : 'BYOM'}</span>
                    <span className={node.online ? 'badge badge-ok' : 'badge badge-neutral'}>
                      <HelmIcon name={node.online ? 'check-circle' : 'circle'} size={10} />
                      {node.online ? '在线' : '离线'}
                    </span>
                    {formatNodeVersion(node.version) !== null && (
                      <span className="badge mono">{formatNodeVersion(node.version)}</span>
                    )}
                    {node.kind === 'byom' && isNodeBehindHub(node.version, hubVersion) && (
                      <span
                        className="badge badge-warn mono"
                        title={`节点版本低于 Hub 当前版本 ${formatNodeVersion(hubVersion) ?? ''}；能否安装该版本以 npm 检查结果为准`}
                      >
                        低于 Hub {formatNodeVersion(hubVersion)}
                      </span>
                    )}
                  </span>
                  {(node.hostname !== undefined || node.platform !== undefined) && (
                    <span className="mono text-muted">
                      {[node.hostname, node.platform].filter(Boolean).join(' / ')}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          <div className="asset-modal-main">
            {issuingMode ? (
              <IssuePanel existingNodeIds={existingNodeIds} onIssued={onIssued} />
            ) : selected ? (
              <NodeDetailPanel
                key={selected.id}
                node={selected}
                hubVersion={hubVersion}
                issuedToken={issuedTokens[selected.id]}
                onTokenIssued={(token) => setIssuedTokens((prev) => ({ ...prev, [selected.id]: token }))}
                onClose={() => selectNode('local')}
              />
            ) : (
              <div className="empty-state">
                选择左侧节点查看详情
              </div>
            )}
          </div>
        </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
