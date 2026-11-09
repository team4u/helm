import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactMetadata, ConversationAttachmentRef, ConversationSummary, WhenBusy } from '@helm/protocol'
import { assetsApi, conversationsApi } from '../lib/api.js'
import {
  buildSlashMenuItems,
  commandActionPluginId,
  insertAtCaret,
  matchExactPluginSlash,
  pluginSlashCommandsFor,
  removeTokenBeforeCaret,
  type QualifiedCommand,
} from '../lib/commands-model.js'
import { HelmIcon } from '../lib/icons.js'
import { matchesUiScope } from '../lib/types.js'
import { useHelmStore } from '../lib/store-context.js'
import { nodeOptionLabel } from '../modals/nodes-modal-model.js'
import { collectEnabledPluginIds, isSkillVisible } from '../shell/sidebar-model.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '../ui/Popover.js'
import { Select, type SelectOption } from '../ui/Select.js'
import { Tabs, TabsList, TabsTrigger } from '../ui/Tabs.js'
import { Tooltip } from '../ui/Tooltip.js'
import { AskDock } from './AskDock.js'
import { focusWithCaret, useComposerController } from './composer-controller.js'
import {
  attachmentsOfEditTarget,
  busyEnterMode,
  canConfigureSessionEnv,
  draftVersionOf,
  envDraftError,
  envDraftOnNodeChange,
  getComposerPlaceholder,
  isHistoricalEdit,
  shouldRestoreEditOnFailure,
  useIsMobile,
  type ComposerDraftVersion,
  type EnvDraft,
  type PendingAttachment,
  type SessionEnvBlocker,
  ENV_BLOCKER_CLEAR,
} from './composer-model.js'
import { lastEditableHumanInput } from './timeline-model.js'
import { formatBytes } from '../lib/format.js'

export interface ComposerProps {
  conversation: ConversationSummary
  /** 请求回填文本（时间线「编辑并重发」）；每次递增 tick 保证同文本也能再次触发。 */
  prefill: { text: string; entryId?: number; attachments?: ConversationAttachmentRef[]; tick: number } | null
  /** 真实发送请求开始/结束时通知父层（在途反馈；斜杠命令不触发）。 */
  onSendingChange?: (sending: boolean) => void
}

type PopoverKind = 'slash' | 'artifact' | null

// ---------------------------------------------------------------------------
// ModelPicker
// ---------------------------------------------------------------------------

function ModelPicker({ conversation }: { conversation: ConversationSummary }) {
  const store = useHelmStore()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLSpanElement | null>(null)

  const refreshCatalog = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const res = await assetsApi.refreshModels()
      await store.refreshAssets()
      const errors = Object.entries(res.errors ?? {})
      if (errors.length > 0) {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: '部分供应商目录刷新失败',
          body: errors.map(([p, err]) => `${p}: ${err}`).join('; '),
          conversationId: conversation.id,
        })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '已刷新模型目录',
          body: `共 ${store.models.length} 个可用模型`,
          conversationId: conversation.id,
        })
      }
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '刷新模型目录失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setRefreshing(false)
    }
  }

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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="btn btn-ghost btn-sm composer-model-button"
            disabled={pending}
            aria-expanded={open}
            aria-label={`模型与思考档位：${shortName}${showLevel ? ` · ${activeLevel}` : ''}`}
            title={`当前模型：${conversation.model}${showLevel ? ` · 思考 ${activeLevel}` : ''}`}
          >
            {pending ? <HelmIcon name="loader" size={12} className="spin-slow" /> : null}
            <span className="composer-model-label">{shortName}</span>
            {showLevel ? <span className="composer-model-level">· {activeLevel}</span> : null}
            <HelmIcon name="chevron-down" size={12} />
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="composer-popover composer-model-popover"
          >
            <button
              type="button"
              className="popover-item"
              onClick={() => void pick('')}
              title="清除显式覆盖，重算 Profile/全局继承链"
            >
              跟随 Profile 默认（清除覆盖）
            </button>
            <div className="composer-model-search-bar" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="search-box" style={{ flex: 1, minWidth: 0 }}>
                <HelmIcon name="search" size={13} />
                <input
                  className="input"
                  aria-label="搜索模型"
                  placeholder="搜索模型…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Tooltip content="刷新动态模型目录" side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-sm composer-model-refresh-btn"
                  disabled={refreshing}
                  title="刷新动态模型目录"
                  aria-label="刷新动态模型目录"
                  onClick={(e) => {
                    e.stopPropagation()
                    void refreshCatalog()
                  }}
                >
                  <HelmIcon name="rotate-cw" size={13} className={refreshing ? 'spin-slow' : undefined} />
                </button>
              </Tooltip>
            </div>
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
                <Tabs
                  value={conversation.thinkingLevelOverride || ''}
                  onValueChange={(val) => {
                    if (val === '') {
                      void pickThinking('')
                    } else {
                      const level = val
                      void pickThinking(level)
                    }
                  }}
                  variant="segmented"
                  style={{ width: '100%' }}
                >
                  <TabsList className="segmented-control composer-thinking-row" aria-label="思考档位">
                    <TabsTrigger
                      value=""
                      disabled={pending}
                      title="跟随模型 / Profile 默认档位"
                      onClick={() => void pickThinking('')}
                    >
                      默认
                    </TabsTrigger>
                    {currentLevels.map((level) => (
                      <TabsTrigger
                        key={level}
                        value={level}
                        disabled={pending}
                        onClick={() => void pickThinking(level)}
                      >
                        {level}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </>
            ) : null}
          </PopoverContent>
        </PopoverPortal>
      </Popover>
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
  /** 回填草稿的触发词（插件命令改用 run 直接执行，不回填）。 */
  apply?: string
  /** 插件命令：选中即执行（不回填触发词到草稿）。 */
  run?: () => void
}
function CommandPopover({
  kind,
  query,
  artifacts,
  slashItems,
  onPick,
  onClose,
}: {
  kind: 'slash' | 'artifact'
  query: string
  artifacts: ArtifactMetadata[]
  /** 已合并好的斜杠菜单条目（含插件命令）；省略时回退宿主内置三源构建。 */
  slashItems?: ReadonlyArray<PopoverItem>
  onPick: (apply: string, caretSuffix?: string) => void
  onClose: () => void
}) {
  const [active, setActive] = useState(0)
  const store = useHelmStore()

  const items = useMemo<PopoverItem[]>(() => {
    const q = query.toLowerCase()
    if (kind === 'slash') {
      if (slashItems !== undefined) {
        return slashItems.filter((i) => i.id.toLowerCase().includes(q) || i.label.toLowerCase().includes(q))
      }
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
  }, [kind, query, artifacts, slashItems, store.skills, store.plugins])

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
        if (item !== undefined) {
          if (item.run !== undefined) item.run()
          else if (item.apply !== undefined) onPick(item.apply)
        }
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
          onClick={() => {
            if (item.run !== undefined) item.run()
            else if (item.apply !== undefined) onPick(item.apply)
          }}
        >
          <span className="mono">{item.label}</span>
          {item.hint !== undefined ? <span className="popover-item-meta">{item.hint}</span> : null}
        </button>
      ))}
    </div>
  )
}
// ---------------------------------------------------------------------------
// 空会话起始环境配置条（开聊即锁定）
// ---------------------------------------------------------------------------


/** 空会话（或 /reset 后未再发消息）时展示：草稿式配置起始执行节点与工作目录。
 * 选节点只进入草稿不立即提交；跨节点切换清空 cwd 草稿（协议无节点默认目录，绝不沿用旧节点路径）；
 * 保存一次 PATCH { nodeId, cwd }，以返回值确认；未改节点时 cwd 单独可改，Enter 保存 / Escape 取消。 */
function SessionEnvBar({
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

// ---------------------------------------------------------------------------
// Composer 主体
// ---------------------------------------------------------------------------

export function Composer({ conversation, prefill, onSendingChange }: ComposerProps) {
  const store = useHelmStore()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null)
  const [popover, setPopover] = useState<PopoverKind>(null)
  const [popoverQuery, setPopoverQuery] = useState('')
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [envBlocker, setEnvBlocker] = useState<SessionEnvBlocker>(ENV_BLOCKER_CLEAR)
  const sendingRef = useRef(false)
  const uploadingRef = useRef(0)
  const envBlockedRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const extrasRef = useRef<HTMLDetailsElement | null>(null)
  const dragDepthRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [widgetsExpanded, setWidgetsExpanded] = useState(false)
  // 活草稿版本：text / 编辑目标 / 附件任一变化推进，用于发送失败后判断草稿是否已被用户修改
  const liveDraftRef = useRef<ComposerDraftVersion>(draftVersionOf('', null, []))
  const syncLiveDraft = useCallback((text: string, target: number | null, attachments: ReadonlyArray<PendingAttachment>): void => {
    liveDraftRef.current = draftVersionOf(text, target, attachments)
  }, [])

  const artifacts = store.conversationArtifacts[conversation.id] ?? []
  const working = conversation.status === 'working' || conversation.status === 'blocked'
  const isMobile = useIsMobile(680)
  const detail = store.conversationDetails[conversation.id]
  // 历史尚未完整加载且当前页没有 reset 时，不能把缺少消息的分页窗口当作空会话。
  const detailEntries = detail?.nextCursor && !detail.entries.some((entry) => entry.kind === 'pi.reset')
    ? undefined
    : detail?.entries
  const envConfigurable = canConfigureSessionEnv(detailEntries, conversation.status)
  // 发送中立即禁止改环境：避免输入提交与环境修改竞态
  const sendInFlight = sending || uploading > 0
  const handleEnvBlocker = useCallback((blocker: SessionEnvBlocker): void => {
    envBlockedRef.current = blocker.blocked
    setEnvBlocker(blocker)
  }, [])
  // 环境条卸载（开聊锁定 / 状态变化）时复位阻塞，避免残留阻止后续发送
  useEffect(() => {
    if (envConfigurable) return
    envBlockedRef.current = false
    setEnvBlocker(ENV_BLOCKER_CLEAR)
  }, [envConfigurable])
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

  // 回填（编辑并重发）：prefill 引用变化即触发，同文本重复回填也生效。
  // 每次选择编辑目标都整体替换附件（目标无附件则清空），绝不保留上一个目标的草稿残留。
  useEffect(() => {
    if (prefill === null) return
    const target = { text: prefill.text, ...(prefill.entryId !== undefined ? { entryId: prefill.entryId } : {}), ...(prefill.attachments !== undefined ? { attachments: prefill.attachments } : {}) }
    const nextEditing = isHistoricalEdit(target) ? prefill.entryId! : null
    const nextAttachments = attachmentsOfEditTarget(target)
    setText(prefill.text)
    setEditingEntryId(nextEditing)
    setAttachments(nextAttachments)
    syncLiveDraft(prefill.text, nextEditing, nextAttachments)
    textareaRef.current?.focus()
  }, [prefill, syncLiveDraft])

  // 切换会话时退出历史编辑态
  useEffect(() => {
    setEditingEntryId(null)
  }, [conversation.id])

  const cancelEdit = useCallback((): void => {
    setEditingEntryId(null)
    setText('')
    setAttachments([])
    syncLiveDraft('', null, [])
  }, [syncLiveDraft])


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
          setAttachments((prev) => {
            const next = [...prev, { artifactId: meta.id, name: meta.name, size: meta.size, mimeType: meta.mimeType }]
            syncLiveDraft(text, editingEntryId, next)
            return next
          })
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
    syncLiveDraft(next, editingEntryId, attachments)
    setPopover(null)
    requestAnimationFrame(() => {
      const pos = start + apply.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const slashPluginCommands = useMemo(
    () => pluginSlashCommandsFor(store.groupedUi.commands, conversation),
    [store.groupedUi.commands, conversation],
  )

  // 斜杠菜单三源合并：宿主内置命令 + 可见技能 + 满足作用域的插件命令。
  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(store.plugins), [store.plugins])
  const [slashMenuItems, setSlashMenuItems] = useState<Array<{ id: string; label: string; hint?: string; apply?: string; run?: () => void }>>([])
  const runPluginCommandRef = useRef<(cmd: QualifiedCommand) => void>(() => {})
  useEffect(() => {
    setSlashMenuItems(
      buildSlashMenuItems(
        store.skills.filter((s) => isSkillVisible(s, enabledPluginIds)),
        slashPluginCommands,
        (cmd) => runPluginCommandRef.current(cmd),
      ),
    )
  }, [store.skills, enabledPluginIds, slashPluginCommands])

  // ⌘K 与斜杠菜单复用同一动作寻址；失败必须返回给提交者。
  const runPluginCommandFrom = useCallback(async (cmd: QualifiedCommand): Promise<void> => {
    const actionId = cmd.spec.actionId
    if (actionId === undefined) throw new Error('插件命令未绑定动作')
    setPopover(null)
    await store
      .invokePluginAction(commandActionPluginId(cmd), actionId, cmd.spec.input, conversation.id)
      .then(() => {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '命令已执行',
          body: `${cmd.spec.slash !== undefined ? `/${cmd.spec.slash} · ` : ''}${cmd.spec.title}`,
          conversationId: conversation.id,
        })
      })
      .catch((err: unknown) => {
        notifyError(`命令执行失败：/${cmd.spec.slash ?? cmd.spec.id}`, err)
        throw err
      })
  }, [store, conversation.id, notifyError])

  const commandPendingRef = useRef(false)
  // 命令成功后才消费触发词；用户已经修改草稿时不得覆盖新内容。
  const runPluginCommand = useCallback((cmd: QualifiedCommand): void => {
    if (commandPendingRef.current) return
    commandPendingRef.current = true
    const el = textareaRef.current
    const before = liveDraftRef.current
    const caret = el?.selectionStart ?? before.text.length
    const { next, nextCaret } = removeTokenBeforeCaret(before.text, caret)
    void runPluginCommandFrom(cmd).then(() => {
      if (!shouldRestoreEditOnFailure(liveDraftRef.current, before)) return
      setText(next)
      syncLiveDraft(next, editingEntryId, attachments)
      if (el !== null) focusWithCaret(el, nextCaret)
    }).catch(() => { /* 动作调用已发送明确失败通知，保留原草稿。 */ }).finally(() => { commandPendingRef.current = false })
  }, [editingEntryId, attachments, syncLiveDraft, runPluginCommandFrom])
  runPluginCommandRef.current = runPluginCommand

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

  const setDraftState = useCallback((next: string): void => {
    setText(next)
    syncLiveDraft(next, editingEntryId, attachments)
  }, [editingEntryId, attachments, syncLiveDraft])

  const insertTextState = useCallback((fragment: string): void => {
    const el = textareaRef.current
    const currentText = liveDraftRef.current.text
    if (el === null) {
      const appended = currentText + fragment
      setText(appended)
      syncLiveDraft(appended, editingEntryId, attachments)
      return
    }
    const caret = el.selectionStart ?? currentText.length
    const { next, nextCaret } = insertAtCaret(currentText, caret, fragment, el.selectionEnd ?? caret)
    setText(next)
    syncLiveDraft(next, editingEntryId, attachments)
    focusWithCaret(el, nextCaret)
  }, [text, editingEntryId, attachments, syncLiveDraft, textareaRef])

  const send = useCallback(async (busyMode: WhenBusy = 'steer', strict = false): Promise<void> => {
    const draft = liveDraftRef.current.text
    const payload = draft.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0 || commandPendingRef.current) {
      if (strict) throw new Error('当前草稿为空或输入区已有在途操作')
      return
    }
    // 未保存环境或环境保存中不允许发送（同时覆盖 Enter 与发送按钮）
    if (envBlockedRef.current) {
      store.pushNotice({
        type: 'notification',
        level: 'warning',
        title: '请先保存或取消起始环境修改',
        body: envBlocker.reason ?? undefined,
        conversationId: conversation.id,
      })
      if (strict) throw new Error('请先保存或取消起始环境修改')
      return
    }
    // 插件斜杠命令：草稿首 token 精确命中满足作用域的插件命令时执行（仅非编辑态）。
    const pluginCmd = matchExactPluginSlash(payload, slashPluginCommands)
    const editing = editingEntryId !== null
    if (!editing && pluginCmd !== undefined) {
      commandPendingRef.current = true
      const before = liveDraftRef.current
      try {
        await runPluginCommandFrom(pluginCmd)
        if (shouldRestoreEditOnFailure(liveDraftRef.current, before)) {
          setText('')
          syncLiveDraft('', editingEntryId, attachments)
        }
      } catch (error) {
        if (strict) throw error
      } finally {
        commandPendingRef.current = false
      }
      return
    }
    // 编辑态正文中出现 /new 等管理命令只是被编辑消息的文本，不立即执行；
    // 仅非编辑输入才作为会话管理命令立即执行。
    const slash = editing ? false : runSlashCommand(payload)
    if (slash) {
      setText('')
      syncLiveDraft('', editingEntryId, attachments)
      return
    }
    const targetEntryId = editingEntryId
    const sentAttachments = new Set(attachments.map((attachment) => attachment.artifactId))
    // 冻结发送瞬间草稿：失败时只有 Composer 仍处于乐观清空后的期望状态
    // （用户未新输入、未选其他目标、未改附件）才回滚，旧 target 不得误绑新输入。
    const frozenDraft = draftVersionOf(draft, targetEntryId, attachments)
    const expectedAfterClear = draftVersionOf('', null, attachments)
    sendingRef.current = true
    setSending(true)
    onSendingChange?.(true)
    setText('')
    setPopover(null)
    // 乐观退出编辑态；失败时在 catch 中按冻结版本回滚
    setEditingEntryId(null)
    syncLiveDraft('', null, attachments)
    try {
      await conversationsApi.submitInput(conversation.id, {
        text: payload,
        origin: 'human',
        ...(targetEntryId !== null ? { replaceFromEntryId: targetEntryId } : working ? { whenBusy: busyMode } : {}),
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.artifactId) } : {}),
      })
      setAttachments((current) => current.filter((attachment) => !sentAttachments.has(attachment.artifactId)))
    } catch (err) {
      // 仅当 Composer 仍处于乐观清空后的期望状态才恢复文本与编辑目标；
      // 用户已开始新输入 / 已选择其他编辑目标则保持现状，旧 target 不回灌。
      const restore = shouldRestoreEditOnFailure(liveDraftRef.current, expectedAfterClear)
      if (restore) {
        setText(draft)
        if (frozenDraft.targetEntryId !== null) setEditingEntryId(frozenDraft.targetEntryId)
        syncLiveDraft(draft, frozenDraft.targetEntryId, attachments)
      }
      notifyError(targetEntryId !== null ? '更新消息失败' : '发送失败', err)
      if (strict) throw err
    } finally {
      sendingRef.current = false
      setSending(false)
      onSendingChange?.(false)
    }
  }, [text, attachments, editingEntryId, working, runSlashCommand, syncLiveDraft, onSendingChange, notifyError, store, conversation.id, uploadingRef, envBlocker, runPluginCommandFrom, slashPluginCommands])

  // 显式文本提交：不消费草稿 / 编辑锚点 / 附件（插件命令结果等非用户键入内容）。
  // 与 send 共用 sendingRef 并发保护与 onSendingChange 在途反馈；失败如实 reject。
  const sendExplicit = useCallback(async (raw: string, whenBusy?: WhenBusy): Promise<void> => {
    const payload = raw.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0) {
      throw new Error('composer_send_invalid')
    }
    if (envBlockedRef.current) {
      store.pushNotice({
        type: 'notification',
        level: 'warning',
        title: '请先保存或取消起始环境修改',
        body: envBlocker.reason ?? undefined,
        conversationId: conversation.id,
      })
      throw new Error('composer_env_blocked')
    }
    sendingRef.current = true
    setSending(true)
    onSendingChange?.(true)
    try {
      await conversationsApi.submitInput(conversation.id, {
        text: payload,
        origin: 'human',
        ...(working ? { whenBusy: whenBusy ?? 'steer' } : {}),
      })
    } catch (err) {
      notifyError('发送失败', err)
      throw err
    } finally {
      sendingRef.current = false
      setSending(false)
      onSendingChange?.(false)
    }
  }, [working, onSendingChange, notifyError, store, conversation.id, uploadingRef, envBlocker])

  const composer = useComposerController({
    text,
    readDraft: () => liveDraftRef.current.text,
    attachments,
    sending,
    textareaRef,
    setDraftState,
    insertTextState,
    submitDraft: (whenBusy) => send(whenBusy ?? 'steer', true),
    submitExplicitText: sendExplicit,
  })

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
    if (e.key === 'Escape' && popover === null && editingEntryId !== null) {
      e.preventDefault()
      cancelEdit()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (editingEntryId !== null) {
        void send('followUp')
        return
      }
      void send(working ? busyEnterMode(e.metaKey || e.ctrlKey) : 'followUp')
      return
    }
    if (e.key === 'ArrowUp' && text === '' && editingEntryId === null) {
      const target = lastEditableHumanInput(detail?.entries ?? [])
      if (target !== undefined) {
        e.preventDefault()
        setText(target.text)
        setEditingEntryId(target.entryId ?? null)
        // ↑ 进入历史编辑同样整体替换附件（含空附件清空旧草稿）
        setAttachments(attachmentsOfEditTarget(target))
        syncLiveDraft(target.text, target.entryId ?? null, attachmentsOfEditTarget(target))
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
                  slotProps={{ conversation, composer }}
                  composer={composer}
                />
              </div>
            ))}
          </div>
        ) : null}
        <AskDock conversationId={conversation.id} />
        {envConfigurable ? (
          <SessionEnvBar
            key={`env-${conversation.id}`}
            conversation={conversation}
            sendBlocked={sendInFlight}
            onBlockerChange={handleEnvBlocker}
          />
        ) : null}
        <div
          className="composer-box"
          data-dragging={dragging ? 'true' : undefined}
          onDragEnter={onDragEnter}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {editingEntryId !== null ? (
            <div className="composer-edit-banner" role="status">
              <span className="composer-edit-banner-text">
                <HelmIcon name="edit" size={12} />
                <span>{working
                  ? '正在编辑历史消息 · 重新发送将覆盖此条及后续对话，并停止当前执行'
                  : '正在编辑历史消息 · 重新发送将覆盖此条及后续对话（含之后的人类消息）'}</span>
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm composer-edit-cancel"
                onClick={cancelEdit}
                title="取消编辑 (Esc)"
              >
                <HelmIcon name="x" size={12} />
                <span>取消</span>
              </button>
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <div className="composer-attachments">
              {attachments.map((att) => (
                <span key={att.artifactId} className="attachment-chip">
                  <HelmIcon name="paperclip" size={11} />
                  <span>{att.name}</span>
                  <span className="mono tabular-nums">{formatBytes(att.size)}</span>
                  <Tooltip content={`移除附件 ${att.name}`} side="top">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-xs"
                      title="移除附件"
                      aria-label={`移除附件 ${att.name}`}
                      onClick={() => setAttachments((prev) => {
                        const next = prev.filter((a) => a.artifactId !== att.artifactId)
                        syncLiveDraft(text, editingEntryId, next)
                        return next
                      })}
                    >
                      <HelmIcon name="x" size={10} />
                    </button>
                  </Tooltip>
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
              syncLiveDraft(e.target.value, editingEntryId, attachments)
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
              slashItems={slashMenuItems}
              onPick={applyPopover}
              onClose={() => setPopover(null)}
            />
          ) : null}
          <div className="composer-toolbar">
            <div className="composer-toolbar-left">
              <Tooltip content="上传附件" side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm composer-icon-button"
                  title="上传附件"
                  aria-label="上传附件"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HelmIcon name="plus" size={19} />
                </button>
              </Tooltip>
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
                        slotProps={{ conversation, composer }}
                        composer={composer}
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
                          slotProps={{ conversation, composer }}
                          composer={composer}
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
              {!working || editingEntryId !== null ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary btn-pill btn-send"
                  disabled={sending || uploading > 0 || envBlocker.blocked || text.trim() === ''}
                  onClick={() => void send()}
                  title={editingEntryId !== null
                    ? working
                      ? '更新并重新生成（将覆盖此条及后续对话并停止当前执行） (Enter)'
                      : '更新并重新生成（将覆盖此条及后续对话） (Enter)'
                    : envBlocker.blocked
                      ? envBlocker.reason ?? '请先保存或取消起始环境修改'
                      : '发送 (Enter)；Shift+Enter 换行'}
                  aria-label={editingEntryId !== null ? '更新并重新生成' : uploading > 0 ? `上传中 (${uploading})` : '发送'}
                >
                  <HelmIcon name={sending || uploading > 0 ? 'loader' : 'arrow-up'} size={18} className={sending || uploading > 0 ? 'spin-slow' : undefined} />
                </button>
              ) : text.trim() === '' ? (
                <Tooltip content="停止当前执行" side="top">
                  <button
                    type="button"
                    className="btn btn-sm btn-danger btn-pill btn-send"
                    onClick={() => void abortTurn()}
                    title="停止当前执行"
                    aria-label="停止当前执行"
                  >
                    <HelmIcon name="square" size={14} />
                  </button>
                </Tooltip>
              ) : (
                <>
                  <Tooltip content="停止当前执行" side="top">
                    <button
                      type="button"
                      className="btn btn-sm btn-danger btn-send"
                      onClick={() => void abortTurn()}
                      title="停止当前执行"
                      aria-label="停止当前执行"
                    >
                      <HelmIcon name="square" size={14} />
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm composer-queue-button"
                    disabled={sending || uploading > 0 || envBlocker.blocked}
                    onClick={() => void send('followUp')}
                    title="当前回合结束后处理（⌘/Ctrl+Enter）"
                    aria-label="排队发送"
                  >
                    <HelmIcon name={sending ? 'loader' : 'clock'} size={16} />
                    <span className="composer-action-label">排队发送</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary btn-pill btn-send"
                    disabled={sending || uploading > 0 || envBlocker.blocked}
                    onClick={() => void send('steer')}
                    title="下一个步骤边界注入（Enter）"
                    aria-label={uploading > 0 ? `上传中 (${uploading})` : editingEntryId !== null ? '更新并重新生成' : '插话引导'}
                  >
                    <HelmIcon name={sending || uploading > 0 ? 'loader' : 'corner-down-right'} size={17} className={sending || uploading > 0 ? 'spin-slow' : undefined} />
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
