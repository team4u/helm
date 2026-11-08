import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactMetadata, ConversationSummary } from '@helm/protocol'
import { conversationsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { matchesUiScope, type HelmStoreValue } from '../lib/types.js'
import { useHelmStore } from '../lib/store-context.js'
import { collectEnabledPluginIds, isSkillVisible } from '../shell/sidebar-model.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { AskDock } from './AskDock.js'
import { getComposerPlaceholder, useIsMobile } from './composer-model.js'
import { formatBytes } from './timeline-model.js'

export interface ComposerProps {
  conversation: ConversationSummary
  /** 请求回填文本（时间线「编辑并重发」）；每次递增 tick 保证同文本也能再次触发。 */
  prefill: { text: string; tick: number } | null
}

interface PendingAttachment {
  artifactId: string
  name: string
  size: number
  mimeType: string
}

type PopoverKind = 'slash' | 'artifact' | null

// ---------------------------------------------------------------------------
// ModelPicker
// ---------------------------------------------------------------------------

function ModelPicker({ conversation }: { conversation: ConversationSummary }) {
  const store = useHelmStore()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        rootRef.current?.querySelector('button')?.focus()
      }
    }
    document.addEventListener('pointerdown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const pick = async (model: string): Promise<void> => {
    setOpen(false)
    if (model === conversation.model) return
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, { model })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '切换模型失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setPending(false)
    }
  }

  const pickThinking = async (level: string): Promise<void> => {
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, { thinkingLevel: level })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '切换思考等级失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setPending(false)
    }
  }

  const rawShortName = conversation.model.split('/').pop() ?? conversation.model
  const shortName = rawShortName.trim() !== '' ? rawShortName : '默认模型'
  const currentModel = store.models.find((model) => model.id === conversation.model)
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  // 当前生效档位：显式覆盖优先，否则会话继承的默认档位；off 或不支持时不展示
  const activeLevel = conversation.thinkingLevelOverride ?? conversation.thinkingLevel ?? 'off'
  const showLevel = supportsThinking && activeLevel !== 'off'

  return (
    <span className="composer-picker-root" ref={rootRef}>
      <button
        type="button"
        className="btn btn-ghost btn-sm composer-model-button"
        disabled={pending}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`模型与思考档位：${shortName}${showLevel ? ` · ${activeLevel}` : ''}`}
        title={`当前模型：${conversation.model}${showLevel ? ` · 思考 ${activeLevel}` : ''}`}
      >
        {pending ? <HelmIcon name="loader" size={12} className="spin-slow" /> : null}
        <span className="composer-model-label">{shortName}</span>
        {showLevel ? <span className="composer-model-level">· {activeLevel}</span> : null}
        <HelmIcon name="chevron-down" size={12} />
      </button>
      {open ? (
        <div className="composer-popover composer-model-popover">
          <button
            type="button"
            className="popover-item"
            onClick={() => void pick('')}
            title="清除显式覆盖，重算 Profile/全局继承链"
          >
            跟随 Profile 默认（清除覆盖）
          </button>
          <input className="input" aria-label="搜索模型" placeholder="搜索模型…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {store.models.filter((model) => model.available && model.id.toLowerCase().includes(query.toLowerCase())).map((m) => (
            <button
              key={m.id}
              title={m.id}
              type="button"
              className={`popover-item${m.id === conversation.model ? ' popover-item-active' : ''}`}
              onClick={() => void pick(m.id)}
            >
              <span className="mono">{m.modelId}</span>
              <span className="popover-item-meta">{m.provider}{m.thinkingLevels.length > 1 ? ' · 思考 ' + m.thinkingLevels[m.thinkingLevels.length - 1] : ''}</span>
            </button>
          ))}
          {store.models.every((model) => !model.available) && (
            <div className="popover-item" style={{ cursor: 'default', color: 'var(--fg-subtle)' }}>暂无可用模型；请先在「模型与凭据」配置供应商密钥</div>
          )}
          {supportsThinking ? (
            <>
              <div className="popover-header">
                思考档位
                <span style={{ color: 'var(--fg-subtle)' }}>{shortName}</span>
              </div>
              <div className="composer-thinking-row">
                <button
                  type="button"
                  className={`btn btn-sm${conversation.thinkingLevelOverride ? '' : ' btn-primary'}`}
                  disabled={pending}
                  title="跟随模型 / Profile 默认档位"
                  onClick={() => void pickThinking('')}
                >
                  默认
                </button>
                {currentLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={`btn btn-sm${conversation.thinkingLevelOverride === level ? ' btn-primary' : ''}`}
                    disabled={pending}
                    onClick={() => void pickThinking(level)}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 斜杠 / 产物引用浮层
// ---------------------------------------------------------------------------

interface PopoverItem {
  id: string
  label: string
  hint?: string
  apply: string
}

function CommandPopover({
  kind,
  query,
  artifacts,
  onPick,
  onClose,
}: {
  kind: 'slash' | 'artifact'
  query: string
  artifacts: ArtifactMetadata[]
  onPick: (apply: string, caretSuffix?: string) => void
  onClose: () => void
}) {
  const [active, setActive] = useState(0)
  const store = useHelmStore()

  const items = useMemo<PopoverItem[]>(() => {
    const q = query.toLowerCase()
    if (kind === 'slash') {
      const builtin: PopoverItem[] = [
        { id: '/new', label: '/new', hint: '重置上下文', apply: '/new' },
        { id: '/clear', label: '/clear', hint: '重置上下文', apply: '/clear' },
        { id: '/compact', label: '/compact', hint: '精简上下文', apply: '/compact' },
      ]
      // 插件未启用时其自举技能不出现在 / 斜杠菜单
      const enabledPluginIds = collectEnabledPluginIds(store.plugins)
      const skills: PopoverItem[] = store.skills
        .filter((s) => isSkillVisible(s, enabledPluginIds))
        .map((s) => ({
          id: `/skill:${s.id}`,
          label: `/skill:${s.id}`,
          hint: s.name,
          apply: `/skill:${s.id} `,
        }))
      return [...builtin, ...skills].filter((i) => i.id.toLowerCase().includes(q))
    }
    return artifacts
      .filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
      .map((a) => ({
        id: `@${a.id}`,
        label: `@${a.name}`,
        hint: `${a.mimeType} · ${formatBytes(a.size)}`,
        apply: `@${a.id} `,
      }))
  }, [kind, query, artifacts, store.skills, store.plugins])

  useEffect(() => {
    setActive(0)
  }, [kind, query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (items.length === 0) {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % items.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + items.length) % items.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[active]
        if (item !== undefined) onPick(item.apply)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items, active, onPick, onClose])

  if (items.length === 0) {
    return (
      <div className="composer-popover">
        <div className="popover-item" style={{ color: 'var(--fg-muted)' }}>
          {kind === 'slash' ? '没有匹配的命令或技能' : '没有匹配的会话产物'}
        </div>
      </div>
    )
  }

  return (
    <div className="composer-popover">
      <div className="popover-header">
        {kind === 'slash' ? '命令与技能' : '引用会话产物'}
        <span style={{ color: 'var(--fg-subtle)' }}>↑↓ 选择 · Enter 确认 · Esc 关闭</span>
      </div>
      {items.slice(0, 12).map((item, idx) => (
        <button
          key={item.id}
          type="button"
          className={`popover-item${idx === active ? ' popover-item-active' : ''}`}
          onMouseEnter={() => setActive(idx)}
          onClick={() => onPick(item.apply)}
        >
          <span className="mono">{item.label}</span>
          {item.hint !== undefined ? <span className="popover-item-meta">{item.hint}</span> : null}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Composer 主体
// ---------------------------------------------------------------------------

export function Composer({ conversation, prefill }: ComposerProps) {
  const store = useHelmStore()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [popover, setPopover] = useState<PopoverKind>(null)
  const [popoverQuery, setPopoverQuery] = useState('')
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(0)
  const sendingRef = useRef(false)
  const uploadingRef = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const extrasRef = useRef<HTMLDetailsElement | null>(null)
  const dragDepthRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [widgetsExpanded, setWidgetsExpanded] = useState(false)

  const artifacts = store.conversationArtifacts[conversation.id] ?? []
  const working = conversation.status === 'working' || conversation.status === 'blocked'
  const isMobile = useIsMobile(680)
  const widgets = store.groupedUi.composerWidgets.filter((w) => matchesUiScope(conversation, w.spec.scope))
  const pills = store.groupedUi.composerPills.filter((p) => matchesUiScope(conversation, p.spec.scope))

  const autoGrow = useCallback((): void => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [])
  useLayoutEffect(() => {
    autoGrow()
  }, [text, isMobile, autoGrow])
  useEffect(() => {
    const el = textareaRef.current
    if (el === null) return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      autoGrow()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [autoGrow])
  useEffect(() => {
    const extras = extrasRef.current
    if (extras === null) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!extras.contains(event.target as Node)) extras.open = false
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && extras.open) {
        extras.open = false
        extras.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isMobile, pills.length, widgets.length])

  // 回填（编辑并重发）：prefill 引用变化即触发，同文本重复回填也生效
  useEffect(() => {
    if (prefill === null) return
    setText(prefill.text)
    textareaRef.current?.focus()
  }, [prefill])

  const notifyError = useCallback(
    (title: string, err: unknown) => {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title,
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    },
    [store, conversation.id],
  )

  const uploadFiles = useCallback(
    async (files: ReadonlyArray<File>): Promise<void> => {
      uploadingRef.current += files.length
      setUploading(uploadingRef.current)
      for (const file of files) {
        try {
          if (file.size > 15 * 1024 * 1024) throw new Error('文件超过 15 MiB 上限')
          const meta = await conversationsApi.uploadArtifact(conversation.id, file)
          setAttachments((prev) => [
            ...prev,
            { artifactId: meta.id, name: meta.name, size: meta.size, mimeType: meta.mimeType },
          ])
        } catch (err) {
          notifyError(`附件上传失败：${file.name}`, err)
        } finally {
          uploadingRef.current--
          setUploading(uploadingRef.current)
        }
      }
    },
    [conversation.id, notifyError],
  )

  // 斜杠 / @ 引用检测：光标前最近一个 / 或 @ 起始 token。
  const detectPopover = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const slashMatch = /(?:^|\s)\/([a-zA-Z0-9:_-]*)$/.exec(before)
    if (slashMatch !== null) {
      setPopover('slash')
      setPopoverQuery(slashMatch[1] ?? '')
      return
    }
    const atMatch = /(?:^|\s)@([a-zA-Z0-9_.\-]*)$/.exec(before)
    if (atMatch !== null) {
      setPopover('artifact')
      setPopoverQuery(atMatch[1] ?? '')
      return
    }
    setPopover(null)
  }

  const applyPopover = (apply: string): void => {
    const el = textareaRef.current
    if (el === null) {
      setPopover(null)
      return
    }
    const caret = el.selectionStart ?? text.length
    const before = text.slice(0, caret)
    const tokenRe = /(?:^|\s)([/@][a-zA-Z0-9:_.\-]*)$/
    const m = tokenRe.exec(before)
    const start = m !== null ? caret - (m[1]?.length ?? 0) : caret
    const next = `${text.slice(0, start)}${apply}${text.slice(caret)}`
    setText(next)
    setPopover(null)
    requestAnimationFrame(() => {
      const pos = start + apply.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const runSlashCommand = (raw: string): boolean => {
    const cmd = raw.trim()
    if (cmd === '/new' || cmd === '/clear') {
      void conversationsApi
        .reset(conversation.id)
        .then(() => {
          store.pushNotice({ type: 'notification', level: 'info', title: '上下文已重置', conversationId: conversation.id })
        })
        .catch((err: unknown) => notifyError('重置上下文失败', err))
      return true
    }
    if (cmd === '/compact') {
      void conversationsApi
        .compact(conversation.id)
        .then(() => {
          store.pushNotice({ type: 'notification', level: 'info', title: '精简任务已提交', conversationId: conversation.id })
        })
        .catch((err: unknown) => notifyError('精简上下文失败', err))
      return true
    }
    return false
  }

  const send = async (busyMode: 'followUp' | 'steer' = 'followUp'): Promise<void> => {
    const payload = text.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0) return
    if (runSlashCommand(payload)) {
      setText('')
      return
    }
    sendingRef.current = true
    setSending(true)
    const sentAttachments = new Set(attachments.map((attachment) => attachment.artifactId))
    const draft = text
    setText('')
    setPopover(null)
    try {
      await conversationsApi.submitInput(conversation.id, {
        text: payload,
        origin: 'human',
        ...(working ? { whenBusy: busyMode } : {}),
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.artifactId) } : {}),
      })
      setAttachments((current) => current.filter((attachment) => !sentAttachments.has(attachment.artifactId)))
    } catch (err) {
      setText((current) => (current === '' ? draft : current))
      notifyError('发送失败', err)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  const abortTurn = async (): Promise<void> => {
    try {
      await conversationsApi.abort(conversation.id)
    } catch (err) {
      notifyError('中止回合失败', err)
    }
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length > 0) {
      e.preventDefault()
      void uploadFiles(files)
    }
  }

  const onDragEnter = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepthRef.current += 1
    if (e.dataTransfer.types.includes('Files')) setDragging(true)
  }

  const onDragLeave = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) void uploadFiles(files)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (popover !== null && (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape')) {
      return // 由浮层全局捕获处理
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(working && (e.metaKey || e.ctrlKey) ? 'steer' : 'followUp')
      return
    }
    if (e.key === 'ArrowUp' && text === '') {
      const lastHuman = lastHumanInputText(store, conversation.id)
      if (lastHuman !== undefined) {
        e.preventDefault()
        setText(lastHuman)
        requestAnimationFrame(() => textareaRef.current?.focus())
      }
    }
  }

  return (
    <div className="composer-shell">
      <div className="composer-inner">
        {widgets.length > 0 && (!isMobile || widgetsExpanded) ? (
          <div className="composer-widgets">
            {widgets.map((w) => (
              <div key={`${w.pluginId}/${w.spec.id}`} className="composer-widget-item">
                <PluginUiView
                  pluginId={w.pluginId}
                  spec={w.spec}
                  conversationId={conversation.id}
                  label={`挂件 ${w.spec.id}`}
                  slotProps={{ conversation }}
                />
              </div>
            ))}
          </div>
        ) : null}
        <AskDock conversationId={conversation.id} />
        <div
          className="composer-box"
          data-dragging={dragging ? 'true' : undefined}
          onDragEnter={onDragEnter}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {attachments.length > 0 ? (
            <div className="composer-attachments">
              {attachments.map((att) => (
                <span key={att.artifactId} className="attachment-chip">
                  <HelmIcon name="paperclip" size={11} />
                  <span>{att.name}</span>
                  <span className="mono tabular-nums">{formatBytes(att.size)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ height: 16, padding: '0 3px' }}
                    title="移除附件"
                    onClick={() => setAttachments((prev) => prev.filter((a) => a.artifactId !== att.artifactId))}
                  >
                    <HelmIcon name="x" size={10} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            aria-label="输入消息"
            ref={textareaRef}
            className="composer-textarea selectable"
            value={text}
            rows={1}
            placeholder={getComposerPlaceholder(working, isMobile)}
            onChange={(e) => {
              setText(e.target.value)
              detectPopover(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
          />
          {popover !== null ? (
            <CommandPopover
              kind={popover}
              query={popoverQuery}
              artifacts={artifacts}
              onPick={applyPopover}
              onClose={() => setPopover(null)}
            />
          ) : null}
          <div className="composer-toolbar">
            <div className="composer-toolbar-left">
              <button
                type="button"
                className="btn btn-ghost btn-sm composer-icon-button"
                title="上传附件"
                aria-label="上传附件"
                onClick={() => fileInputRef.current?.click()}
              >
                <HelmIcon name="plus" size={19} />
              </button>
              <ModelPicker conversation={conversation} />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  if (files.length > 0) void uploadFiles(files)
                }}
              />
              {!isMobile ? (
                <span className="composer-pills">
                  {pills.map((p) => (
                    <span key={`${p.pluginId}/${p.spec.id}`} className="composer-pill-item">
                      <PluginUiView
                        pluginId={p.pluginId}
                        spec={p.spec}
                        conversationId={conversation.id}
                        label={`胶囊 ${p.spec.id}`}
                        slotProps={{ conversation }}
                      />
                    </span>
                  ))}
                </span>
              ) : pills.length > 0 || widgets.length > 0 ? (
                <details className="composer-extras" ref={extrasRef}>
                  <summary className="btn btn-ghost btn-sm composer-icon-button" aria-label="会话工具" title="会话工具">
                    <HelmIcon name="more" size={18} />
                  </summary>
                  <div className="composer-popover composer-extras-popover">
                    {pills.map((p) => (
                      <div key={`${p.pluginId}/${p.spec.id}`} className="composer-pill-item">
                        <PluginUiView
                          pluginId={p.pluginId}
                          spec={p.spec}
                          conversationId={conversation.id}
                          label={`胶囊 ${p.spec.id}`}
                          slotProps={{ conversation }}
                        />
                      </div>
                    ))}
                    {widgets.length > 0 ? (
                      <button
                        type="button"
                        className="popover-item"
                        aria-expanded={widgetsExpanded}
                        onClick={(event) => {
                          setWidgetsExpanded((v) => !v)
                          event.currentTarget.closest('details')?.removeAttribute('open')
                        }}
                      >
                        <HelmIcon name="layers" size={15} />
                        {widgetsExpanded ? '收起' : '查看'}{widgets.length === 1 ? widgets[0]?.spec.title ?? '会话面板' : `会话面板 (${widgets.length})`}
                      </button>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>
            <span className="composer-toolbar-right">
              {!working ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary btn-pill btn-send"
                  disabled={sending || uploading > 0 || text.trim() === ''}
                  onClick={() => void send()}
                  title="发送 (Enter)；Shift+Enter 换行"
                  aria-label={uploading > 0 ? `上传中 (${uploading})` : '发送'}
                >
                  <HelmIcon name={sending || uploading > 0 ? 'loader' : 'arrow-up'} size={18} className={sending || uploading > 0 ? 'spin-slow' : undefined} />
                </button>
              ) : text.trim() === '' ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger btn-pill btn-send"
                  onClick={() => void abortTurn()}
                  title="停止当前执行"
                  aria-label="停止当前执行"
                >
                  <HelmIcon name="square" size={14} />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger btn-send"
                    onClick={() => void abortTurn()}
                    title="停止当前执行"
                    aria-label="停止当前执行"
                  >
                    <HelmIcon name="square" size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm composer-steer-button"
                    disabled={sending || uploading > 0}
                    onClick={() => void send('steer')}
                    title="立即插入当前回合引导方向 (⌘/Ctrl+Enter)"
                    aria-label="插话引导"
                  >
                    <HelmIcon name={sending ? 'loader' : 'corner-down-right'} size={17} />
                    <span className="composer-action-label">插话引导</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary btn-pill btn-send"
                    disabled={sending || uploading > 0}
                    onClick={() => void send('followUp')}
                    title="排在当前回合结束后自动发送 (Enter)"
                    aria-label={uploading > 0 ? `上传中 (${uploading})` : '排队发送'}
                  >
                    <HelmIcon name={sending || uploading > 0 ? 'loader' : 'arrow-up'} size={18} className={sending || uploading > 0 ? 'spin-slow' : undefined} />
                  </button>
                </>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 空输入框按 ↑ 回填：直接从 store 详情中取最后一条人类输入。 */
function lastHumanInputText(store: HelmStoreValue, conversationId: number): string | undefined {
  const detail = store.conversationDetails[conversationId]
  if (detail === undefined) return undefined
  for (let i = detail.entries.length - 1; i >= 0; i--) {
    const entry = detail.entries[i]!
    if (entry.kind !== 'helm.input' && entry.kind !== 'pi.user') continue
    const data = entry.data as { text?: unknown } | undefined
    if (typeof data?.text === 'string' && data.text.trim() !== '') return data.text
  }
  return undefined
}
