import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSummary } from '@helm/protocol/browser'
import { conversationsApi } from '../lib/api.js'
import { HelmIcon, Select, type SelectOption } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { nodeOptionLabel } from '../modals/nodes-modal-model.js'
import {
  envDraftError,
  envDraftOnNodeChange,
  type EnvDraft,
  type SessionEnvBlocker,
  ENV_BLOCKER_CLEAR,
} from './composer-model.js'

// ---------------------------------------------------------------------------
// 空会话起始环境配置条（开聊即锁定）（自 Composer.tsx 拆出）
// ---------------------------------------------------------------------------

/** 空会话（或 /reset 后未再发消息）时展示：草稿式配置起始执行节点与工作目录。
 * 选节点只进入草稿不立即提交；跨节点切换清空 cwd 草稿（协议无节点默认目录，绝不沿用旧节点路径）；
 * 保存一次 PATCH { nodeId, cwd }，以返回值确认；未改节点时 cwd 单独可改，Enter 保存 / Escape 取消。 */
export function SessionEnvBar({
  conversation,
  sendBlocked,
  onBlockerChange,
}: {
  conversation: ConversationSummary
  sendBlocked: boolean
  onBlockerChange: (blocker: SessionEnvBlocker) => void
}) {
  const store = useHelmStore()
  const [draft, setDraft] = useState<EnvDraft>(() => ({
    nodeId: conversation.nodeId || 'local',
    cwd: conversation.cwd,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentNodeId = conversation.nodeId || 'local'
  const nodeKnown = store.nodes.some((n) => n.id === currentNodeId)
  const draftNode = store.nodes.find((n) => n.id === draft.nodeId)
  const draftNodeKnown = draft.nodeId === currentNodeId ? nodeKnown : store.nodes.some((n) => n.id === draft.nodeId)
  // 已确认坐标锚点：保存成功以 PATCH 返回值为准（SSE 摘要可能滞后，不依赖其时序）
  const [confirmed, setConfirmed] = useState<EnvDraft>(() => ({ nodeId: currentNodeId, cwd: conversation.cwd }))
  const lastCoordinatesRef = useRef<EnvDraft>({ nodeId: currentNodeId, cwd: conversation.cwd })
  const unchanged = draft.nodeId === confirmed.nodeId && draft.cwd === confirmed.cwd
  const validationError = envDraftError(draft)
  const dirty = !unchanged
  const blocked = saving || dirty
  const blocker: SessionEnvBlocker = blocked
    ? { blocked: true, reason: saving ? '正在保存会话环境…' : '请先保存或取消起始环境修改' }
    : ENV_BLOCKER_CLEAR

  // 阻塞状态回传 Composer（发送门控）
  useEffect(() => {
    onBlockerChange(blocker)
  }, [blocker.blocked, blocker.reason, onBlockerChange])

  // 会话坐标被外部（SSE / 其他入口）更新且本地无未保存修改时，同步锚点与草稿
  useEffect(() => {
    const previous = lastCoordinatesRef.current
    if (previous.nodeId === currentNodeId && previous.cwd === conversation.cwd) return
    const next = { nodeId: currentNodeId, cwd: conversation.cwd }
    lastCoordinatesRef.current = next
    setConfirmed(next)
    if (dirty) return
    setDraft(next)
  }, [currentNodeId, conversation.cwd, dirty])

  const save = async (): Promise<void> => {
    if (saving || sendBlocked) return
    const err = envDraftError(draft)
    if (err !== null) {
      setError(err)
      return
    }
    if (unchanged) return
    setSaving(true)
    setError(null)
    try {
      // 一次 PATCH 同时提交 nodeId + cwd；以返回值确认保存成功（不依赖 SSE 时序）
      const saved = await conversationsApi.patch(conversation.id, { nodeId: draft.nodeId, cwd: draft.cwd.trim() })
      const nextConfirmed: EnvDraft = { nodeId: saved.nodeId || 'local', cwd: saved.cwd }
      setConfirmed(nextConfirmed)
      setDraft(nextConfirmed)
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '已保存会话环境',
        body: `#${conversation.id} -> ${saved.nodeId || 'local'}:${saved.cwd}`,
        conversationId: conversation.id,
      })
    } catch (e) {
      // 保存失败保留草稿并显式报错，不静默回滚
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '保存会话环境失败',
        body: message,
        conversationId: conversation.id,
      })
    } finally {
      setSaving(false)
    }
  }

  const cancel = (): void => {
    if (saving) return
    // PATCH 确认结果可能早于 SSE 到达，取消时保留最新已确认的坐标。
    setDraft(confirmed)
    setError(null)
  }

  const nodeOptions = useMemo<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = store.nodes.map((n) => ({
      value: n.id,
      label: nodeOptionLabel(n),
      icon: n.id === 'local' ? 'monitor' : 'network',
      meta: n.id !== 'local' ? (n.online ? '在线' : '离线') : undefined,
    }))
    if (!draftNodeKnown) {
      list.push({
        value: draft.nodeId,
        label: `${draft.nodeId}（未知）`,
        icon: 'alert-circle',
      })
    }
    return list
  }, [store.nodes, draftNodeKnown, draft.nodeId])

  return (
    <div className="composer-env-bar" data-dirty={dirty ? 'true' : undefined}>
      <span className="composer-env-item">
        <Select
          className="composer-env-select"
          aria-label="会话执行节点"
          disabled={saving || sendBlocked}
          value={draft.nodeId}
          options={nodeOptions}
          onChange={(e) => {
            setError(null)
            setDraft((prev) => envDraftOnNodeChange(prev, e.target.value))
          }}
        />
      </span>
      <span className="composer-env-item composer-env-cwd-wrap">
        <HelmIcon name="folder" size={12} className="composer-env-cwd-icon" />
        <input
          className="input mono composer-env-cwd-input"
          aria-label="会话工作目录"
          aria-invalid={error !== null}
          value={draft.cwd}
          disabled={saving || sendBlocked}
          placeholder={draft.nodeId === currentNodeId ? '/绝对路径' : '目标节点上的绝对路径，例如 /home/user/work'}
          onChange={(e) => {
            setError(null)
            setDraft((prev) => ({ ...prev, cwd: e.target.value }))
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void save()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
        />
      </span>
      {blocked ? (
        <span className="composer-env-actions">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={saving || validationError !== null}
            onClick={() => void save()}
          >
            {saving ? <HelmIcon name="loader" size={11} className="spin-slow" /> : <HelmIcon name="check" size={11} />}
            保存
          </button>
          <button type="button" className="btn btn-sm" disabled={saving} onClick={cancel}>
            取消
          </button>
        </span>
      ) : null}
      {error !== null ? (
        <span className="composer-env-error" role="alert" title={error}>{error}</span>
      ) : draftNode !== undefined && !draftNode.online && draft.nodeId !== 'local' ? (
        <span className="composer-env-warn">节点离线，保存后仍需节点上线才能执行</span>
      ) : null}
      <span className="composer-env-hint">首条消息发送后锁定</span>
    </div>
  )
}
