/**
 * builtin:memory 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - ProfileMemorySection：注入 builtin:profile/detail-section 子插槽的单 Profile
 *   长期记忆区块（开关 + MEMORY.md 编辑器 + 保存）。
 *
 * 数据不依赖公共文档（记忆全文是磁盘权威）：经 ctx.callAction('get') 按需
 * 拉取当前 Profile 的内容与开关；启停经 'configure'、内容保存经 'set'。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProfileDetailSlotProps } from '@helm/protocol'
import { Switch, usePluginContext } from '@helm/plugin-client'

import { Loader2, Save } from 'lucide-react'
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

/** 单 Profile 长期记忆区块（Profile 详情抽屉插件子插槽）。 */
export function ProfileMemorySection(props: ProfileDetailSlotProps): ReactNode {
  const ctx = usePluginContext()
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

  // PluginUiView 可随 store 更新重建 ctx；更新委托引用，但不让其身份触发重载。
  currentProfile.current = effectiveId
  callAction.current = ctx.callAction

  const isCurrent = useCallback((targetId: string, token: number, requestToken = requestGeneration.current) =>
    mounted.current && currentProfile.current === targetId && generation.current === token && requestGeneration.current === requestToken,
  [])

  const load = useCallback(async (targetId: string, token: number, existingRequestToken?: number): Promise<void> => {
    if (!isCurrent(targetId, token, existingRequestToken)) return
    // 先核对 Profile 生命周期，旧入口不可通过递增请求代数作废新 Profile 的加载。
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
      // configure 已成功但刷新失败时，旧的 enabled 也不再是当前服务端事实。
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
      // 开关即时生效；内容编辑独立保存，不随开关回滚。
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
          <span className="section-flat-title">长期记忆 (MEMORY.md)</span>
        </div>
        <div className="text-subtle text-xs">
          保存并创建角色后，可在此开启或关闭该角色的长期记忆并编辑 MEMORY.md。
        </div>
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
        <span className="section-flat-title">长期记忆 (MEMORY.md)</span>
        {currentState !== null && (
          <Switch
            checked={currentState.enabled}
            disabled={disabled || currentBusy !== null}
            onChange={(next) => void handleToggle(next)}
            label="启用长期记忆"
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
            <span>{currentBusy === 'load' ? '加载记忆中…' : '尚未加载记忆状态'}</span>
          ) : (
            <>
              <span>无法读取记忆状态，未更改此 Profile 的启用状态。</span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={currentBusy !== null}
                onClick={() => void load(effectiveId, token)}
              >
                重试
              </button>
            </>
          )}
        </div>
      ) : !currentState.enabled ? (
        <div className="text-subtle text-xs">
          已为此角色关闭长期记忆：对话中不会注入 MEMORY.md，也不会提供 update_memory 工具。
          开关即时生效，已保存的记忆内容保留在磁盘上。
        </div>
      ) : (
        <>
          <div className="flex-row-between memory-section-meta">
            <span className="mono">
              {effectiveDraft.length} / 65536 字符{effectiveDraft ? ` · ${effectiveDraft.split('\n').length} 行` : ''}
            </span>
          </div>
          <textarea
            className="input mono memory-section-textarea"
            rows={8}
            placeholder="该角色的长期记忆全文（支持 Markdown）…"
            value={effectiveDraft}
            disabled={disabled}
            onChange={(e) => {
              const nextDraft = { profileId: effectiveId, generation: token, value: e.target.value }
              draftRef.current = nextDraft
              setDraft(nextDraft)
            }}
            aria-label="长期记忆"
          />
          <div className="flex-row memory-section-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={disabled || currentBusy !== null || !dirty}
              onClick={() => void handleSave()}
            >
              {currentBusy === 'save' ? <Loader2 size={13} className="spin-slow" /> : <Save size={13} />}
              <span>{currentBusy === 'save' ? '保存中…' : '保存记忆'}</span>
            </button>
            {dirty && (
              <span className="text-subtle text-xs">有未保存的修改（记忆内容独立保存，不随「取消角色编辑」回滚）</span>
            )}
          </div>
        </>
      )}
    </section>
  )
}
