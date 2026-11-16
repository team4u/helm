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
import type { ProfileDetailSlotProps } from '@helm/protocol'
import { Switch, usePluginContext, usePluginLocale, usePluginTranslator } from '@helm/plugin-client'

import { Loader2, Save } from 'lucide-react'
import {
  MEMORY_DIRTY_HINT,
  MEMORY_DISABLED_HINT,
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
  memoryLineCount,
} from './copy.ts'
import './index.css'

interface MemoryGetResult {
  profileId: string
  enabled: boolean
  content: string
  initialized: boolean
}

type Operation = 'load' | 'toggle' | 'save'
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

  useEffect(() => {
    if (effectiveId === '') {
      setState(null)
      setError(null)
      setBusy(null)
      draftRef.current = null
      setDraft(null)
      return
    }

    const token = ++generation.current
    setState(null)
    setError(null)
    setBusy({ profileId: effectiveId, generation: token, value: 'load' })
    draftRef.current = null
    setDraft(null)
    void load(effectiveId, token)

    return () => {
      if (generation.current === token) generation.current += 1
    }
  }, [effectiveId, load])

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
        </>
      )}
    </section>
  )
}
