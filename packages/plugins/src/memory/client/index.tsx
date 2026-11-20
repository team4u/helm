/**
 * builtin:memory plugin client.tsx components (component exports only, Fast
 * Refresh contract):
 * - ProfileMemorySection: the single-profile long-term memory block (enable
 *   switch + MEMORY.md editor + save) injected into the
 *   builtin:profile/detail-section sub-slot.
 *
 * Data does not depend on public docs (memory content is disk-authoritative):
 * pulled on demand via ctx.callAction('get') for the current profile's
 * content and switch; toggling goes through 'configure', saving through 'set'.
 *
 * Display copy resolves from copy.ts against the active host locale (no
 * independent language state, no localStorage); backend error messages pass
 * through unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProfileDetailSlotProps } from '@helmx/protocol'
import { Switch, usePluginContext, usePluginLocale, usePluginTranslator } from '@helmx/plugin-client'

import { Loader2, MoonStar, Save } from 'lucide-react'
import {
  MEMORY_DIRTY_HINT,
  MEMORY_DISABLED_HINT,
  MEMORY_DREAM_GLOBAL_HINT,
  MEMORY_DREAM_LOAD_FAILED,
  MEMORY_DREAM_PAUSE,
  MEMORY_DREAM_RESUME,
  MEMORY_DREAM_RUN,
  MEMORY_DREAM_RUNNING,
  MEMORY_DREAM_TITLE,
  MEMORY_LOAD_FAILED,
  MEMORY_LOADING,
  MEMORY_NEW_PROFILE_HINT,
  MEMORY_NOT_LOADED,
  MEMORY_PLACEHOLDER,
  MEMORY_RETRY,
  MEMORY_SAVE,
  MEMORY_SAVING,
  MEMORY_SECTION_TITLE,
  MEMORY_SWITCH_LABEL,
  MEMORY_TEXTAREA_LABEL,
  memoryCharCount,
  memoryDreamCandidates,
  memoryDreamLastRun,
  memoryDreamRunResult,
  memoryDreamSchedule,
  memoryLineCount,
} from './copy.ts'
import './index.css'

interface MemoryGetResult {
  profileId: string
  enabled: boolean
  content: string
  initialized: boolean
}

interface DreamStatusResult {
  profileId?: string
  config: { enabled: boolean; hour: number; timezone: string }
  nextRunAt?: number
  running: string[]
  profiles: Array<{
    profileId: string
    candidateCount: number
    memoryChars: number | null
    lastRun?: { ran: boolean; applied?: boolean; conflict?: boolean; reason?: string; error?: string }
  }>
}

interface DreamRunResult {
  profileId: string
  ran: boolean
  reason?: string
  applied?: boolean
  conflict?: boolean
  consumed?: number
}

type Operation = 'load' | 'toggle' | 'save'
type DreamOperation = 'status' | 'run' | 'auto'
interface Versioned<T> {
  profileId: string
  generation: number
  value: T
}

/** Single-profile long-term memory block (profile detail drawer sub-slot). */
export function ProfileMemorySection(props: ProfileDetailSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { profileId, isNew, disabled } = props
  const effectiveId = isNew ? '' : profileId.trim()

  const [state, setState] = useState<Versioned<MemoryGetResult> | null>(null)
  const [draft, setDraft] = useState<Versioned<string> | null>(null)
  const [error, setError] = useState<Versioned<string> | null>(null)
  const [busy, setBusy] = useState<Versioned<Operation> | null>(null)
  const [dreamStatus, setDreamStatus] = useState<Versioned<DreamStatusResult> | null>(null)
  const [dreamNotice, setDreamNotice] = useState<Versioned<string> | null>(null)
  const [dreamError, setDreamError] = useState<Versioned<string> | null>(null)
  const [dreamBusy, setDreamBusy] = useState<Versioned<DreamOperation> | null>(null)
  const generation = useRef(0)
  const requestGeneration = useRef(0)
  const mounted = useRef(false)
  const currentProfile = useRef(effectiveId)
  const draftRef = useRef<Versioned<string> | null>(null)
  const callAction = useRef(ctx.callAction)

  // PluginUiView may rebuild ctx as the store updates; update the delegated
  // references, but never let their identity trigger a reload.
  currentProfile.current = effectiveId
  callAction.current = ctx.callAction

  const isCurrent = useCallback((targetId: string, token: number, requestToken = requestGeneration.current) =>
    mounted.current && currentProfile.current === targetId && generation.current === token && requestGeneration.current === requestToken,
  [])

  const load = useCallback(async (targetId: string, token: number, existingRequestToken?: number): Promise<void> => {
    if (!isCurrent(targetId, token, existingRequestToken)) return
    // Check the profile lifecycle first: an old entry must not invalidate a
    // newer profile's load by bumping the request generation.
    const requestToken = existingRequestToken ?? ++requestGeneration.current
    setBusy({ profileId: targetId, generation: token, value: 'load' })
    setError(null)
    try {
      const result = await callAction.current('get', { profileId: targetId }) as MemoryGetResult
      if (!isCurrent(targetId, token, requestToken)) return
      setState({ profileId: targetId, generation: token, value: result })
      const existingDraft = draftRef.current
      if (existingDraft?.profileId !== targetId || existingDraft.generation !== token) {
        const nextDraft = { profileId: targetId, generation: token, value: result.content }
        draftRef.current = nextDraft
        setDraft(nextDraft)
      }
    } catch (err) {
      if (!isCurrent(targetId, token, requestToken)) return
      // If configure succeeded but the refresh failed, the stale `enabled`
      // value is no longer the current server-side fact either.
      setState(null)
      setError({
        profileId: targetId,
        generation: token,
        value: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (isCurrent(targetId, token, requestToken)) setBusy(null)
    }
  }, [isCurrent])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [])

  /** Dream sub-block: status fetch / manual run / pause-resume auto consolidation. */
  const loadDreamStatus = useCallback(async (targetId: string, token: number): Promise<void> => {
    if (!isCurrent(targetId, token)) return
    try {
      const result = await callAction.current('dream_status', { profileId: targetId }) as DreamStatusResult
      if (!isCurrent(targetId, token)) return
      setDreamStatus({ profileId: targetId, generation: token, value: result })
      setDreamError(null)
    } catch (err) {
      if (!isCurrent(targetId, token)) return
      setDreamStatus(null)
      setDreamError({ profileId: targetId, generation: token, value: err instanceof Error ? err.message : String(err) })
    } finally {
      if (isCurrent(targetId, token)) setDreamBusy((current) => (current?.value === 'status' ? null : current))
    }
  }, [isCurrent])

  useEffect(() => {
    if (effectiveId === '') {
      setState(null)
      setError(null)
      setBusy(null)
      draftRef.current = null
      setDraft(null)
      setDreamStatus(null)
      setDreamNotice(null)
      setDreamError(null)
      setDreamBusy(null)
      return
    }

    const token = ++generation.current
    setState(null)
    setError(null)
    setBusy({ profileId: effectiveId, generation: token, value: 'load' })
    draftRef.current = null
    setDraft(null)
    setDreamStatus(null)
    setDreamNotice(null)
    setDreamError(null)
    setDreamBusy({ profileId: effectiveId, generation: token, value: 'status' })
    void load(effectiveId, token)
    void loadDreamStatus(effectiveId, token)

    return () => {
      if (generation.current === token) generation.current += 1
    }
  }, [effectiveId, load, loadDreamStatus])

  const handleDreamRun = async () => {
    const targetId = effectiveId
    const token = generation.current
    if (targetId === '' || dreamBusy !== null) return
    setDreamBusy({ profileId: targetId, generation: token, value: 'run' })
    setDreamNotice(null)
    setDreamError(null)
    try {
      const result = await callAction.current('dream', { profileId: targetId }) as DreamRunResult
      if (!isCurrent(targetId, token)) return
      setDreamNotice({ profileId: targetId, generation: token, value: memoryDreamRunResult(result, locale) })
      await loadDreamStatus(targetId, token)
    } catch (err) {
      if (!isCurrent(targetId, token)) return
      setDreamError({ profileId: targetId, generation: token, value: err instanceof Error ? err.message : String(err) })
    } finally {
      if (isCurrent(targetId, token)) setDreamBusy(null)
    }
  }

  const handleDreamAutoToggle = async () => {
    const targetId = effectiveId
    const token = generation.current
    const currentConfig = dreamStatus?.profileId === targetId && dreamStatus.generation === token ? dreamStatus.value.config : null
    if (targetId === '' || currentConfig === null || dreamBusy !== null) return
    setDreamBusy({ profileId: targetId, generation: token, value: 'auto' })
    setDreamNotice(null)
    setDreamError(null)
    try {
      await callAction.current('dream_configure', { enabled: !currentConfig.enabled })
      await loadDreamStatus(targetId, token)
    } catch (err) {
      if (!isCurrent(targetId, token)) return
      setDreamError({ profileId: targetId, generation: token, value: err instanceof Error ? err.message : String(err) })
    } finally {
      if (isCurrent(targetId, token)) setDreamBusy(null)
    }
  }

  const handleToggle = async (next: boolean) => {
    const targetId = effectiveId
    const token = generation.current
    if (targetId === '' || state?.profileId !== targetId || state.generation !== token || busy !== null) return
    const requestToken = ++requestGeneration.current
    setBusy({ profileId: targetId, generation: token, value: 'toggle' })
    setError(null)
    try {
      await callAction.current('configure', { profileId: targetId, enabled: next })
      if (!isCurrent(targetId, token, requestToken)) return
      await load(targetId, token, requestToken)
      // The switch takes effect immediately; content editing saves
      // independently and never rolls back with the switch.
    } catch (err) {
      if (!isCurrent(targetId, token, requestToken)) return
      setError({ profileId: targetId, generation: token, value: err instanceof Error ? err.message : String(err) })
    } finally {
      if (isCurrent(targetId, token, requestToken)) setBusy(null)
    }
  }

  const handleSave = async () => {
    const targetId = effectiveId
    const token = generation.current
    const submittedText = draft?.profileId === targetId && draft.generation === token ? draft.value : null
    if (targetId === '' || submittedText === null || busy !== null) return
    const requestToken = ++requestGeneration.current
    setBusy({ profileId: targetId, generation: token, value: 'save' })
    setError(null)
    try {
      await callAction.current('set', { profileId: targetId, text: submittedText, mode: 'replace' })
      if (!isCurrent(targetId, token, requestToken)) return
      const fresh = await callAction.current('get', { profileId: targetId }) as MemoryGetResult
      if (!isCurrent(targetId, token, requestToken)) return
      setState({ profileId: targetId, generation: token, value: fresh })
      const currentDraft = draftRef.current
      if (
        currentDraft?.profileId === targetId &&
        currentDraft.generation === token &&
        currentDraft.value === submittedText
      ) {
        const nextDraft = { profileId: targetId, generation: token, value: fresh.content }
        draftRef.current = nextDraft
        setDraft(nextDraft)
      }
    } catch (err) {
      if (!isCurrent(targetId, token, requestToken)) return
      setError({ profileId: targetId, generation: token, value: err instanceof Error ? err.message : String(err) })
    } finally {
      if (isCurrent(targetId, token, requestToken)) setBusy(null)
    }
  }

  if (isNew) {
    return (
      <section className="section-flat">
        <div className="section-flat-header">
          <span className="section-flat-title">{t(MEMORY_SECTION_TITLE)}</span>
        </div>
        <div className="text-subtle text-xs">{t(MEMORY_NEW_PROFILE_HINT)}</div>
      </section>
    )
  }

  if (effectiveId === '') return null

  const token = generation.current
  const currentState = state?.profileId === effectiveId && state.generation === token ? state.value : null
  const currentDraft = draft?.profileId === effectiveId && draft.generation === token ? draft.value : null
  const currentError = error?.profileId === effectiveId && error.generation === token ? error.value : null
  const currentBusy = busy?.profileId === effectiveId && busy.generation === token ? busy.value : null
  const effectiveDraft = currentDraft ?? currentState?.content ?? ''
  const dirty = currentDraft !== null && currentDraft !== currentState?.content

  return (
    <section className="section-flat">
      <div className="section-flat-header memory-section-header">
        <span className="section-flat-title">{t(MEMORY_SECTION_TITLE)}</span>
        {currentState !== null && (
          <Switch
            checked={currentState.enabled}
            disabled={disabled || currentBusy !== null}
            onChange={(next) => void handleToggle(next)}
            label={t(MEMORY_SWITCH_LABEL)}
          />
        )}
      </div>

      {currentError !== null && (
        <div className="badge badge-warn memory-section-error" role="alert">
          <span>{currentError}</span>
        </div>
      )}

      {currentState === null ? (
        <div className="memory-section-load">
          {currentBusy === 'load' && <Loader2 size={12} className="spin-slow" />}
          {currentError === null ? (
            <span>{currentBusy === 'load' ? t(MEMORY_LOADING) : t(MEMORY_NOT_LOADED)}</span>
          ) : (
            <>
              <span>{t(MEMORY_LOAD_FAILED)}</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={currentBusy !== null}
                onClick={() => void load(effectiveId, token)}
              >
                {t(MEMORY_RETRY)}
              </button>
            </>
          )}
        </div>
      ) : !currentState.enabled ? (
        <div className="text-subtle text-xs">{t(MEMORY_DISABLED_HINT)}</div>
      ) : (
        <>
          <div className="flex-row-between memory-section-meta">
            <span className="mono">
              {memoryCharCount(effectiveDraft.length, locale)}
              {effectiveDraft ? memoryLineCount(effectiveDraft.split('\n').length, locale) : ''}
            </span>
          </div>
          <textarea
            className="input mono memory-section-textarea"
            rows={8}
            placeholder={t(MEMORY_PLACEHOLDER)}
            value={effectiveDraft}
            disabled={disabled}
            onChange={(e) => {
              const nextDraft = { profileId: effectiveId, generation: token, value: e.target.value }
              draftRef.current = nextDraft
              setDraft(nextDraft)
            }}
            aria-label={t(MEMORY_TEXTAREA_LABEL)}
          />
          <div className="flex-row memory-section-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={disabled || currentBusy !== null || !dirty}
              onClick={() => void handleSave()}
            >
              {currentBusy === 'save' ? <Loader2 size={13} className="spin-slow" /> : <Save size={13} />}
              <span>{currentBusy === 'save' ? t(MEMORY_SAVING) : t(MEMORY_SAVE)}</span>
            </button>
            {dirty && <span className="text-subtle text-xs">{t(MEMORY_DIRTY_HINT)}</span>}
          </div>
          <MemoryDreamBlock
            targetId={effectiveId}
            token={token}
            disabled={disabled}
            status={dreamStatus?.profileId === effectiveId && dreamStatus.generation === token ? dreamStatus.value : null}
            notice={dreamNotice?.profileId === effectiveId && dreamNotice.generation === token ? dreamNotice.value : null}
            error={dreamError?.profileId === effectiveId && dreamError.generation === token ? dreamError.value : null}
            busy={dreamBusy?.profileId === effectiveId && dreamBusy.generation === token ? dreamBusy.value : null}
            onRun={() => void handleDreamRun()}
            onAutoToggle={() => void handleDreamAutoToggle()}
          />
        </>
      )}
    </section>
  )
}

interface MemoryDreamBlockProps {
  targetId: string
  token: number
  disabled: boolean
  status: DreamStatusResult | null
  notice: string | null
  error: string | null
  busy: DreamOperation | null
  onRun: () => void
  onAutoToggle: () => void
}

/** Dream sub-block: schedule line + status pills + manual run / pause-resume buttons. */
function MemoryDreamBlock(props: MemoryDreamBlockProps): ReactNode {
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const { status, notice, error, busy, disabled } = props
  const row = status?.profiles.find((p) => p.profileId === props.targetId)
  const autoConfig = status?.config ?? null
  return (
    <div className="memory-dream-block">
      <div className="flex-row-between memory-section-header">
        <span className="text-subtle text-xs memory-dream-title">
          <MoonStar size={12} />
          <span>{t(MEMORY_DREAM_TITLE)}</span>
        </span>
        <div className="flex-row memory-dream-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled || busy !== null || status === null}
            onClick={props.onRun}
          >
            {busy === 'run' ? <Loader2 size={13} className="spin-slow" /> : <MoonStar size={13} />}
            <span>{busy === 'run' ? t(MEMORY_DREAM_RUNNING) : t(MEMORY_DREAM_RUN)}</span>
          </button>
          {autoConfig !== null && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={disabled || busy !== null}
              onClick={props.onAutoToggle}
            >
              <span>{autoConfig.enabled ? t(MEMORY_DREAM_PAUSE) : t(MEMORY_DREAM_RESUME)}</span>
            </button>
          )}
        </div>
      </div>
      <div className="memory-dream-meta">
        {autoConfig !== null ? (
          <>
            <span className="mono">{memoryDreamSchedule(autoConfig, locale)}</span>
            {row !== undefined && <span className="text-subtle">{memoryDreamCandidates(row.candidateCount, locale)}</span>}
            {row?.lastRun !== undefined && <span className="text-subtle">{memoryDreamLastRun(row.lastRun, locale)}</span>}
          </>
        ) : error !== null ? (
          <span className="text-subtle">{t(MEMORY_DREAM_LOAD_FAILED)}</span>
        ) : (
          <span className="text-subtle">{t(MEMORY_LOADING)}</span>
        )}
      </div>
      {notice !== null && <div className="text-subtle text-xs memory-dream-notice">{notice}</div>}
      {error !== null && (
        <div className="badge badge-warn memory-section-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="text-subtle text-xs">{t(MEMORY_DREAM_GLOBAL_HINT)}</div>
    </div>
  )
}
