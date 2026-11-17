import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSummary } from '@helm/protocol/browser'
import { conversationsApi } from '../lib/api.js'
import { HelmIcon, Select, type SelectOption } from '@helm/plugin-client'
import { useNodes, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { nodeOptionLabel } from '../modals/nodes-modal-model.js'
import {
  envDraftError,
  envDraftOnNodeChange,
  type EnvDraft,
  type SessionEnvBlocker,
  ENV_BLOCKER_CLEAR,
} from './composer-model.js'

// ---------------------------------------------------------------------------
// Starting-environment bar for empty conversations (locks once the chat starts)
// (extracted from Composer.tsx)
// ---------------------------------------------------------------------------

/** Shown for empty conversations (or after /reset with no new messages): a
 * draft-style configuration of the starting execution node and working
 * directory. Picking a node only updates the draft (no immediate submit);
 * switching nodes clears the cwd draft (the protocol has no per-node default
 * directory — old-node paths are never carried over); saving issues one
 * PATCH { nodeId, cwd } confirmed by its return value; with the node unchanged
 * the cwd is editable alone — Enter saves / Escape cancels. */
export function SessionEnvBar({
  conversation,
  sendBlocked,
  onBlockerChange,
}: {
  conversation: ConversationSummary
  sendBlocked: boolean
  onBlockerChange: (blocker: SessionEnvBlocker) => void
}) {
  const nodes = useNodes()
  const { pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [draft, setDraft] = useState<EnvDraft>(() => ({
    nodeId: conversation.nodeId || 'local',
    cwd: conversation.cwd,
  }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentNodeId = conversation.nodeId || 'local'
  const nodeKnown = nodes.some((n) => n.id === currentNodeId)
  const draftNode = nodes.find((n) => n.id === draft.nodeId)
  const draftNodeKnown = draft.nodeId === currentNodeId ? nodeKnown : nodes.some((n) => n.id === draft.nodeId)
  // Confirmed coordinate anchor: a successful save trusts the PATCH return
  // value (the SSE summary may lag; never depend on its timing).
  const [confirmed, setConfirmed] = useState<EnvDraft>(() => ({ nodeId: currentNodeId, cwd: conversation.cwd }))
  const lastCoordinatesRef = useRef<EnvDraft>({ nodeId: currentNodeId, cwd: conversation.cwd })
  const unchanged = draft.nodeId === confirmed.nodeId && draft.cwd === confirmed.cwd
  const validationError = envDraftError(draft, t)
  const dirty = !unchanged
  const blocked = saving || dirty
  const blocker: SessionEnvBlocker = blocked
    ? { blocked: true, reason: saving ? t('composer.env.blockerSaving') : t('composer.env.saveOrCancelFirst') }
    : ENV_BLOCKER_CLEAR

  // Report the block state back to the Composer (send gating).
  useEffect(() => {
    onBlockerChange(blocker)
  }, [blocker.blocked, blocker.reason, onBlockerChange])

  // Conversation coordinates updated externally (SSE / another entry point)
  // while no unsaved local edits exist: sync anchor and draft.
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
    const err = envDraftError(draft, t)
    if (err !== null) {
      setError(err)
      return
    }
    if (unchanged) return
    setSaving(true)
    setError(null)
    try {
      // One PATCH submits nodeId + cwd together; the return value confirms
      // the save (no reliance on SSE timing).
      const saved = await conversationsApi.patch(conversation.id, { nodeId: draft.nodeId, cwd: draft.cwd.trim() })
      const nextConfirmed: EnvDraft = { nodeId: saved.nodeId || 'local', cwd: saved.cwd }
      setConfirmed(nextConfirmed)
      setDraft(nextConfirmed)
      pushNotice({
        type: 'notification',
        level: 'info',
        title: t('composer.env.savedTitle'),
        body: `#${conversation.id} -> ${saved.nodeId || 'local'}:${saved.cwd}`,
        conversationId: conversation.id,
      })
    } catch (e) {
      // Keep the draft on failure and surface the error explicitly; never
      // roll back silently.
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.env.saveFailed'),
        body: message,
        conversationId: conversation.id,
      })
    } finally {
      setSaving(false)
    }
  }

  const cancel = (): void => {
    if (saving) return
    // The PATCH confirmation may arrive before SSE: cancel keeps the latest
    // confirmed coordinates.
    setDraft(confirmed)
    setError(null)
  }

  const nodeOptions = useMemo<SelectOption<string>[]>(() => {
    const list: SelectOption<string>[] = nodes.map((n) => ({
      value: n.id,
      label: nodeOptionLabel(n),
      icon: n.id === 'local' ? 'monitor' : 'network',
      meta: n.id !== 'local' ? (n.online ? t('common.online') : t('common.offline')) : undefined,
    }))
    if (!draftNodeKnown) {
      list.push({
        value: draft.nodeId,
        label: t('composer.env.nodeUnknownOption', { nodeId: draft.nodeId }),
        icon: 'alert-circle',
      })
    }
    return list
  }, [nodes, draftNodeKnown, draft.nodeId, t])

  return (
    <div className="composer-env-bar" data-dirty={dirty ? 'true' : undefined}>
      <span className="composer-env-item">
        <Select
          className="composer-env-select"
          aria-label={t('composer.env.nodeAria')}
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
          aria-label={t('composer.env.cwdAria')}
          aria-invalid={error !== null}
          value={draft.cwd}
          disabled={saving || sendBlocked}
          placeholder={draft.nodeId === currentNodeId ? t('composer.env.cwdPlaceholderSameNode') : t('composer.env.cwdPlaceholder')}
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
            {t('common.save')}
          </button>
          <button type="button" className="btn btn-sm" disabled={saving} onClick={cancel}>
            {t('common.cancel')}
          </button>
        </span>
      ) : null}
      {error !== null ? (
        <span className="composer-env-error" role="alert" title={error}>{error}</span>
      ) : draftNode !== undefined && !draftNode.online && draft.nodeId !== 'local' ? (
        <span className="composer-env-warn">{t('composer.env.nodeOfflineAfterSave')}</span>
      ) : null}
      <span className="composer-env-hint">{t('composer.env.lockedHint')}</span>
    </div>
  )
}
