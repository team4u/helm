/**
 * builtin:memory 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - ProfileMemorySection：注入 builtin:profile/detail-section 子插槽的单 Profile
 *   长期记忆区块（开关 + MEMORY.md 编辑器 + 保存）。
 *
 * 数据不依赖公共文档（记忆全文是磁盘权威）：经 ctx.callAction('get') 按需
 * 拉取当前 Profile 的内容与开关；启停经 'configure'、内容保存经 'set'。
 * 切换 Profile 时带代数竞争保护（旧请求结果不反向覆盖新状态）；后台刷新
 * 不得覆盖未保存的本地草稿（dirty 草稿优先）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProfileDetailSlotProps } from '@helm/protocol'
import { usePluginContext } from '@helm/plugin-client'

import { Loader2, Save } from 'lucide-react'

interface MemoryGetResult {
  profileId: string
  enabled: boolean
  content: string
  initialized: boolean
}

/** 单 Profile 长期记忆区块（Profile 详情抽屉插件子插槽）。 */
export function ProfileMemorySection(props: ProfileDetailSlotProps): ReactNode {
  const ctx = usePluginContext()
  const { profileId, isNew, disabled } = props

  const [state, setState] = useState<MemoryGetResult | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'load' | 'toggle' | 'save' | null>(null)
  const loadGeneration = useRef(0)

  // 新建模式：不拉取，仅提示先创建角色。
  const effectiveId = isNew ? '' : profileId.trim()

  const load = useCallback(
    async (targetId: string) => {
      const generation = ++loadGeneration.current
      setBusy('load')
      setError(null)
      try {
        const result = (await ctx.callAction('get', { profileId: targetId })) as MemoryGetResult
        if (loadGeneration.current !== generation) return
        setState(result)
        // 后台刷新不覆盖未保存的本地草稿：仅当无草稿或草稿属于旧 Profile 时重置。
        setDraft((current) => (current === null ? result.content : current))
      } catch (err) {
        if (loadGeneration.current !== generation) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (loadGeneration.current === generation) setBusy(null)
      }
    },
    [ctx],
  )

  useEffect(() => {
    if (effectiveId === '') return
    void load(effectiveId)
    // 切换 Profile 时清空旧草稿（异步切换不串数据）。
    setDraft(null)
    setState(null)
  }, [effectiveId, load])

  const handleToggle = async (next: boolean) => {
    if (effectiveId === '' || busy !== null) return
    setBusy('toggle')
    setError(null)
    try {
      await ctx.callAction('configure', { profileId: effectiveId, enabled: next })
      await load(effectiveId)
      // 开关即时生效；内容编辑独立保存，不随开关回滚。
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleSave = async () => {
    if (effectiveId === '' || draft === null || busy !== null) return
    setBusy('save')
    setError(null)
    try {
      await ctx.callAction('set', { profileId: effectiveId, text: draft, mode: 'replace' })
      const fresh = (await ctx.callAction('get', { profileId: effectiveId })) as MemoryGetResult
      const generation = ++loadGeneration.current
      setState(fresh)
      setDraft(fresh.content)
      void generation
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
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

  if (effectiveId === '') {
    return null
  }

  const enabled = state?.enabled ?? false
  const serverContent = state?.content ?? ''
  const effectiveDraft = draft ?? serverContent
  const dirty = draft !== null && draft !== serverContent

  return (
    <section className="section-flat">
      <div className="section-flat-header" style={{ justifyContent: 'space-between' }}>
        <span className="section-flat-title">长期记忆 (MEMORY.md)</span>
        <label className="flex-row" style={{ gap: 6, fontSize: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled || busy !== null}
            onChange={(e) => void handleToggle(e.target.checked)}
          />
          <span>启用长期记忆</span>
        </label>
      </div>

      {error !== null && (
        <div className="badge badge-warn" role="alert" style={{ width: '100%', justifyContent: 'flex-start', padding: '4px 8px', fontSize: 12 }}>
          <span>{error}</span>
        </div>
      )}

      {busy === 'load' && state === null ? (
        <div className="flex-row text-subtle text-xs" style={{ gap: 6 }}>
          <Loader2 size={12} className="spin-slow" />
          <span>加载记忆中…</span>
        </div>
      ) : !enabled ? (
        <div className="text-subtle text-xs">
          已为此角色关闭长期记忆：对话中不会注入 MEMORY.md，也不会提供 update_memory 工具。
          开关即时生效，已保存的记忆内容保留在磁盘上。
        </div>
      ) : (
        <>
          <textarea
            className="input mono"
            rows={6}
            placeholder="该角色的长期记忆全文…"
            value={effectiveDraft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="长期记忆"
          />
          <div className="flex-row" style={{ gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={disabled || busy !== null || !dirty}
              onClick={() => void handleSave()}
            >
              {busy === 'save' ? <Loader2 size={13} className="spin-slow" /> : <Save size={13} />}
              <span>{busy === 'save' ? '保存中…' : '保存记忆'}</span>
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
