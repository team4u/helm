import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  AskSpec,
  ConversationAttachmentRef,
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  ProfileStarterPrompt,
} from '@helm/protocol'
import { artifactsApi } from '../lib/api.js'
import { HelmIcon, CopyButton } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { AssistantTurnView, AssistantModelBoundary } from './AssistantTurn.js'
import {
  buildActiveEntryIndex,
  buildAssistantModelBoundaries,
  buildTimelineItems,
  collectSiblingCalls,
  findLatestProcessTurnKey,
  lastEditableHumanInput,
  queuedAgentTextCollapse,
  resolveAssistantAnchorEntry,
  type DividerItem,
  type EditRequestTarget,
  type HumanInputItem,
  type PluginCardItem,
  type ProcessShortcutCommand,
  type TimelineItem,
} from './timeline-model.js'
import { useTimelineEntryActions } from './timeline-actions.js'
import { resolveActiveOutlineEntryId } from './outline-model.js'
import { calibrateAnchorAfterSmoothScroll, calibrateInitialStickToBottom, type AnchorAlignment } from './timeline-scroll-calibration.js'
import { captureTimelineScrollAnchor, restoreTimelineScrollAnchor } from './timeline-scroll-anchor.js'
import {
  OUTLINE_ACTIVE_LINE_PX,
  resolveActiveAnchorIndex,
  resolveContainmentClass,
  supportsTimelineContainment,
  timelineAnchorId,
  type ContainmentExclusions,
} from './timeline-containment-model.js'
import { matchTimelineEntryActions, timelineEntryActionContextOf } from './action-model.js'
import { PluginMicroAction } from '../ui/PluginMicroAction.js'
import { Tooltip } from '../ui/Tooltip.js'
import { formatBytes, formatDurationMs, formatFullTimestamp, formatMessageTime } from '../lib/format.js'

export interface OutlineScrollRequest {
  entryId: string
  headingIndex?: number
  /** 回合内业务卡二级锚：匹配 AssistantTurn 顶层 tool.view 卡 trace 元素的 `data-outline-card-id`（即 tool.key）。 */
  cardId?: string
  tick: number
}

export interface ConversationTimelineProps {
  conversation: ConversationSummary
  detailEntries: ReadonlyArray<ConversationEntry>
  live?: ConversationLive
  /** 外层已预计算的归一化时间线列表（避免 ConversationPane 与 Timeline 重复计算）。 */
  timelineItems?: ReadonlyArray<TimelineItem>
  /** 发送请求在途且服务端尚未 working/blocked（轻量等待行，与 working 行互斥）。 */
  sendingPending?: boolean
  /** 大纲点击/回车触发的滚动定位请求（每次递增 tick 支持重复点击同一条目）。 */
  outlineScrollRequest?: OutlineScrollRequest | null
  /** 滚动过程中通知外层当前视口顶部焦点的 entryId（供大纲浮层高亮当前位置）。 */
  onActiveEntryChange?: (entryId: string | undefined) => void
  /** 请求将文本回填 Composer 并聚焦（编辑并重发；可携带历史 entryId 与附件）。 */
  onRequestEdit: (target: EditRequestTarget) => void
  /** 点击空白会话引导词：仅请求回填草稿，不是历史编辑。 */
  onRequestStarter?: (text: string) => void
  /** 当前会话 Profile 的引导词列表（空列表/未定义不渲染按钮）。 */
  starters?: ProfileStarterPrompt[]
}

// ---------------------------------------------------------------------------
// 附件渲染（图片缩略图 + 非图片芯片）
// ---------------------------------------------------------------------------

function AttachmentImage({ att, conversationId }: { att: ConversationAttachmentRef; conversationId: number }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const store = useHelmStore()

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    void artifactsApi
      .fetchBlob(att.id)
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
    return () => {
      active = false
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [att.id])

  if (failed !== null) {
    return (
      <span className="attachment-chip" title={`图片加载失败：${failed}`}>
        <HelmIcon name="alert-triangle" size={11} />
        {att.name}
      </span>
    )
  }
  if (url === null) {
    return (
      <span className="attachment-chip">
        <HelmIcon name="loader" size={11} />
        {att.name}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="attachment-image-thumb"
      title={`点击放大：${att.name}`}
      onClick={() =>
        store.setActiveModal({ kind: 'artifact-preview', artifactId: att.id, conversationId })
      }
    >
      <img src={url} alt={att.name} loading="lazy" />
    </button>
  )
}

function AttachmentChips({
  attachments,
  conversationId,
}: {
  attachments: ConversationAttachmentRef[]
  conversationId: number
}) {
  const store = useHelmStore()
  return (
    <span className="msg-attachments-wrap">
      {attachments.map((att) =>
        att.mimeType.startsWith('image/') ? (
          <AttachmentImage key={att.id} att={att} conversationId={conversationId} />
        ) : (
          <button
            key={att.id}
            type="button"
            className="attachment-chip"
            title={`预览 ${att.name}`}
            onClick={() =>
              store.setActiveModal({ kind: 'artifact-preview', artifactId: att.id, conversationId })
            }
          >
            <HelmIcon name="file-text" size={11} />
            <span>{att.name}</span>
            <span className="mono tabular-nums">{formatBytes(att.size)}</span>
          </button>
        ),
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 人类消息胶囊
// ---------------------------------------------------------------------------

const ORIGIN_LABEL: Record<string, string> = {
  agent: '来自智能体汇报',
  trigger: '来自触发器',
}

const QUEUED_MODE_LABEL: Record<'steer' | 'followUp', { icon: string; text: string }> = {
  steer: { icon: 'corner-down-right', text: '插话引导 · 待当前步骤后注入' },
  followUp: { icon: 'clock', text: '排队中 · 待当前回合结束后发送' },
}

function HumanMessage({
  item,
  conversation,
  anchorEntry,
  onRequestEdit,
  onForkFromHere,
  onWithdrawQueuedEdit,
}: {
  item: HumanInputItem
  conversation: ConversationSummary
  /** item.entryId 对应的真实持久化条目；queued（无持久锚点）时 undefined。 */
  anchorEntry?: ConversationEntry
  onRequestEdit: (target: EditRequestTarget) => void
  /** 从该消息分叉新会话（ConversationTimeline 统一实例化的动作服务）。 */
  onForkFromHere: (entryId: string) => Promise<void>
  /** 撤回排队输入并转入编辑（withdrawn → 原文本回填；已落库 → 原地编辑）。 */
  onWithdrawQueuedEdit: (subId: string, target: EditRequestTarget) => Promise<void>
}) {
  const store = useHelmStore()
  const [forking, setForking] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  // 插件微插槽 timeline.entry.action：按当前会话 scope + 真实 entry 的 kind/role 过滤；
  // queued（无持久锚点）或 id 不在当前详情集合内（分页窗口外）不渲染，绝不编造占位 entry。
  const entryActions =
    anchorEntry !== undefined
      ? matchTimelineEntryActions(
          store.groupedUi.uiActions,
          conversation,
          timelineEntryActionContextOf(anchorEntry),
        )
      : []

  const humanTime = formatMessageTime(item.createdAt)
  const humanFullTime = formatFullTimestamp(item.createdAt)
  const hasHumanTime = item.createdAt !== undefined && humanTime !== ''

  // 排队中的非人类长文本（如后台结算汇报原文）：通用可展开收起，不解析业务 payload。
  const [longOpen, setLongOpen] = useState(false)
  const queuedCollapse =
    item.queuedMode !== undefined && item.origin !== 'human'
      ? queuedAgentTextCollapse(item.text)
      : undefined
  const collapseBodyId = useId()

  const editRequest = async (): Promise<void> => {
    // 仅人类输入可原地编辑：agent 汇报 / trigger 注入不是人类编辑对象（铅笔已收起，双重防御）
    if (item.origin !== 'human') return
    const attachments =
      item.attachments !== undefined && item.attachments.length > 0 ? { attachments: item.attachments } : {}
    if (item.queuedMode === undefined) {
      // 已落库历史消息：进入原地编辑；entryId 必须是合法正整数，
      // 非法锚点绝不静默降级为新消息（否则会把「编辑」错发成普通追加）。
      const numericId = Number(item.entryId)
      if (!Number.isSafeInteger(numericId) || numericId <= 0) {
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title: '无法编辑该消息',
          body: `消息锚点无效（entryId=${item.entryId}），已取消编辑。`,
          conversationId: conversation.id,
        })
        return
      }
      onRequestEdit({ text: item.text, entryId: numericId, ...attachments })
      return
    }
    // 排队中消息：先撤回（若刚被置入执行则无缝衔接历史编辑）
    const subId = item.entryId.startsWith('queued:') ? item.entryId.slice('queued:'.length) : item.entryId
    setWithdrawing(true)
    try {
      await onWithdrawQueuedEdit(subId, { text: item.text, ...attachments })
    } finally {
      setWithdrawing(false)
    }
  }

  const forkFromHere = async (): Promise<void> => {
    setForking(true)
    try {
      await onForkFromHere(item.entryId)
    } finally {
      setForking(false)
    }
  }

  return (
    <div className="msg-human-row" tabIndex={0}>
      {item.queuedMode !== undefined ? (
        <span className="msg-origin-tag" role="status">
          <HelmIcon name={QUEUED_MODE_LABEL[item.queuedMode].icon} size={11} />
          {QUEUED_MODE_LABEL[item.queuedMode].text}
        </span>
      ) : item.origin !== 'human' ? (
        <span className="msg-origin-tag">
          <HelmIcon name={item.origin === 'trigger' ? 'webhook' : 'bot'} size={11} />
          {ORIGIN_LABEL[item.origin] ?? item.origin}
        </span>
      ) : null}
      <div className={`msg-human-pill selectable${item.queuedMode !== undefined ? ' msg-human-pill-queued' : ''}${queuedCollapse?.collapsed === true ? ' msg-human-pill-collapsible' : ''}`}>
        <span
          id={collapseBodyId}
          className={queuedCollapse?.collapsed === true && !longOpen ? 'msg-human-collapsed-text' : undefined}
        >
          {queuedCollapse?.collapsed === true && !longOpen ? queuedCollapse.preview : item.text}
        </span>
        {queuedCollapse?.collapsed === true ? (
          <button
            type="button"
            className="msg-human-collapse-btn"
            aria-expanded={longOpen}
            aria-controls={collapseBodyId}
            onClick={() => setLongOpen((current) => !current)}
          >
            <HelmIcon name={longOpen ? 'chevron-up' : 'chevron-down'} size={11} />
            <span>{longOpen ? '收起' : `展开全文（${item.text.length} 字符）`}</span>
          </button>
        ) : null}
      </div>
      {item.attachments !== undefined && item.attachments.length > 0 ? (
        <AttachmentChips attachments={item.attachments} conversationId={conversation.id} />
      ) : null}
      <div className="msg-human-footer">
        <span className="msg-hover-bar">
          {anchorEntry !== undefined
            ? entryActions.map((action) => (
                <PluginMicroAction
                  key={`entry:${action.pluginId}/${action.spec.id}`}
                  action={action}
                  variant="hover"
                  conversationId={conversation.id}
                  entryId={anchorEntry.id}
                  slotProps={{ conversationId: conversation.id, entry: anchorEntry }}
                />
              ))
            : null}
          <CopyButton text={item.text} />
          {item.origin === 'human' ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={item.queuedMode !== undefined ? '撤回排队并编辑' : '编辑并重发'}
              aria-label={item.queuedMode !== undefined ? '撤回排队并编辑' : '编辑并重发'}
              disabled={withdrawing}
              onClick={() => void editRequest()}
            >
              <HelmIcon name={withdrawing ? 'loader' : 'edit'} size={12} className={withdrawing ? 'spin-slow' : undefined} />
            </button>
          ) : null}
          {item.queuedMode === undefined ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="从此消息分叉新会话"
              disabled={forking}
              onClick={() => void forkFromHere()}
            >
              <HelmIcon name={forking ? 'loader' : 'git-fork'} size={12} />
            </button>
          ) : null}
        </span>
        {hasHumanTime ? (
          <Tooltip content={`发送于 ${humanFullTime}`}>
            <span className="msg-time-meta" title={`发送于 ${humanFullTime}`}>{humanTime}</span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 工具行 / 思考组 / Assistant 回合见 TimelineRows.tsx 与 AssistantTurn.tsx
// （自 ConversationTimeline 拆出的行级渲染单元）。
// ---------------------------------------------------------------------------

/** CSS 属性选择器值转义（双引号与反斜杠）；大纲二级锚定位查询用。 */
function escapeAttrSelectorValue(value: string): string {
  return value.replace(/["\\]/g, (ch) => `\\${ch}`)
}

// ---------------------------------------------------------------------------
// 分割线 / 插件卡片 / 历史审批
// ---------------------------------------------------------------------------

function ContextDivider({ item }: { item: DividerItem }) {
  const [open, setOpen] = useState(false)
  // 可展开文本：reset 的交接摘要与 compaction 的精简摘要（同一展开交互）。
  const expandable = item.divider === 'reset' ? item.handoff : item.summary
  const expandLabel = item.divider === 'reset' ? '交接摘要' : '精简摘要'
  return (
    <div className="context-divider-wrap">
      <div className="context-divider">
        <span className="context-divider-label">
          {item.pending === true ? (
            <>
              <HelmIcon name="loader" size={11} className="spin-slow" />
              正在精简上下文…
            </>
          ) : (
            <>
              <HelmIcon name={item.divider === 'reset' ? 'rotate-ccw' : 'archive'} size={11} />
              {item.divider === 'reset' ? '上下文已重置' : '上下文已精简'}
            </>
          )}
        </span>
      </div>
      {expandable !== undefined ? (
        <button
          type="button"
          className="trace-group-summary context-divider-expand-btn"
          onClick={() => setOpen((v) => !v)}
        >
          <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          {open ? `收起${expandLabel}` : `展开${expandLabel}`}
        </button>
      ) : null}
      {open && expandable !== undefined ? (
        <div className="trace-expanded-body selectable trace-expanded-body-flush">
          <div className="trace-section-label">{expandLabel}</div>
          <pre className="code-block-pre code-block-pre-flush">
            <code>{expandable}</code>
          </pre>
        </div>
      ) : null}
    </div>
  )
}

function PluginCard({ item, conversationId }: { item: PluginCardItem; conversationId: number }) {
  const store = useHelmStore()
  const conversation = store.conversations.find((c) => c.id === conversationId)
  // timeline.renderer 自定义条目同样消费 timeline.entry.action：真实 entry kind 匹配；
  // 自定义 kind 无 user/assistant 角色，声明 roles 的动作不命中。
  const entryActions =
    conversation !== undefined
      ? matchTimelineEntryActions(
          store.groupedUi.uiActions,
          conversation,
          timelineEntryActionContextOf(item.entry),
        )
      : []
  return (
    <div className="plugin-card">
      <PluginUiView
        pluginId={item.renderer.pluginId}
        spec={item.renderer.spec}
        conversationId={conversationId}
        label="时间线卡片"
        slotProps={{ entry: item.entry, conversationId }}
      />
      {entryActions.length > 0 ? (
        <span className="plugin-card-hover-bar">
          {entryActions.map((action) => (
            <PluginMicroAction
              key={`entry:${action.pluginId}/${action.spec.id}`}
              action={action}
              variant="hover"
              conversationId={conversationId}
              entryId={item.entry.id}
              slotProps={{ conversationId, entry: item.entry }}
            />
          ))}
        </span>
      ) : null}
    </div>
  )
}

const RESOLVED_ASK_LABEL: Record<string, string> = {
  answered: '已批准',
  cancelled: '已取消',
  superseded: '已由终端处理 (superseded)',
}

function ResolvedAskRow({ ask, status }: { ask: AskSpec; status: 'answered' | 'cancelled' | 'superseded' }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="trace-entry">
      <div className="trace-row" role="button" tabIndex={0} onClick={() => setOpen((v) => !v)}>
        <span className="trace-row-left">
          <HelmIcon name="check-circle" size={12} />
          <span className="trace-tool-name">审批</span>
          <span className="trace-tool-summary">{ask.title}</span>
        </span>
        <span className="trace-row-right">{RESOLVED_ASK_LABEL[status] ?? status}</span>
      </div>
      {open ? (
        <div className="trace-expanded-body selectable">
          {ask.description !== undefined ? <span>{ask.description}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 高亮定位
// ---------------------------------------------------------------------------

function useEntryHighlight(
  conversationId: number,
  localHighlightedEntryId: string | null,
): (entryId: string) => string {
  const store = useHelmStore()
  return (entryId: string): string => {
    const h = store.highlightedEntry
    const matchedStore = h !== null && h.conversationId === conversationId && h.entryId === entryId
    const matchedLocal = localHighlightedEntryId === entryId
    return matchedStore || matchedLocal ? ' entry-highlighted' : ''
  }
}

function useHighlightScroll(
  conversationId: number,
  armCalibration: (target: HTMLElement, alignment: AnchorAlignment) => void,
): (node: HTMLDivElement | null) => void {
  const store = useHelmStore()
  const h = store.highlightedEntry
  // 稳定 ref 避免普通 rerender 重复定位；StrictMode 重新挂载 ref 时须重新
  // 武装校准，因为首次挂载的任务已经由 effect cleanup 取消。
  return useCallback((node: HTMLDivElement | null): void => {
    if (node === null || h?.conversationId !== conversationId) return
    if (node.dataset.entryId !== h.entryId) return
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
    armCalibration(node, 'center')
  }, [conversationId, h?.conversationId, h?.entryId, armCalibration])
}

// ---------------------------------------------------------------------------
// 回合失败诊断（当前未清除失败的内联展示；随下一回合开始自动消失）
// ---------------------------------------------------------------------------

/** 失败回合内联诊断块：内容来自 ConversationSummary.lastError（同一权威状态源），
 * 不新增持久化 timeline item；lastError 空缺时只给明确通用文案，绝不编造详情。 */
function TurnErrorNotice({
  conversation,
  detailEntries,
  onRequestEdit,
}: {
  conversation: ConversationSummary
  detailEntries: ReadonlyArray<ConversationEntry>
  onRequestEdit: (target: EditRequestTarget) => void
}) {
  // 最近一条可编辑的人类输入：复用与 Composer ↑ 相同的安全解析（校验 entryId、
  // 不跨 reset 边界、复用已有 attachments）；无法可靠定位则不提供快捷操作，
  // 绝不误编辑旧消息。
  const editTarget = useMemo(() => lastEditableHumanInput(detailEntries), [detailEntries])
  return (
    <div className="callout callout--error" role="alert" aria-label="本回合失败">
      <HelmIcon name="alert-triangle" size={12} />
      <span className="callout-text">
        本回合失败：{conversation.lastError?.trim() || '模型或服务请求未成功，未产生回答。'}
        {editTarget !== undefined ? (
          <>
            {' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="编辑并重发最近一条消息"
              aria-label="编辑并重发最近一条消息"
              onClick={() => onRequestEdit(editTarget)}
            >
              <HelmIcon name="edit" size={12} />
              编辑并重发
            </button>
          </>
        ) : null}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 主时间线
// ---------------------------------------------------------------------------

export function ConversationTimeline({
  conversation,
  detailEntries,
  live,
  timelineItems,
  sendingPending = false,
  outlineScrollRequest,
  onActiveEntryChange,
  onRequestEdit,
  onRequestStarter,
  starters,
}: ConversationTimelineProps) {
  const store = useHelmStore()
  // 行级动作服务（分叉 / 排队撤回转编辑）统一实例化一次，行组件经 props 消费。
  const entryActions = useTimelineEntryActions(conversation, onRequestEdit)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [localHighlightEntryId, setLocalHighlightEntryId] = useState<string | null>(null)
  const [processToggle, setProcessToggle] = useState<{ turnKey: string; command: ProcessShortcutCommand } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const processToggleSeqRef = useRef(0)
  const latestProcessTurnKeyRef = useRef<string | undefined>(undefined)
  const stickToBottomRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const lastHumanRef = useRef<{ conversationId: number; key: string | undefined } | null>(null)
  const lastOutlineTickRef = useRef<number | null>(null)
  const lastActiveEntryRef = useRef<string | undefined>(undefined)
  const outlineHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeCalibrationRef = useRef<{
    conversationId: number
    kind: 'anchor' | 'initial-bottom'
    cancel: () => void
  } | null>(null)
  // 一次性初始贴底窗口资格：consumed = 已被用户输入/自然收敛/显式定位取代，
  // 本会话内不再重启；换会话/StrictMode 重演的 cleanup 只取消（active=false）
  // 不消费，重挂后可重新启动，避免一次性资格被 effect 重演提前耗尽。
  const initialBottomRef = useRef<{ active: boolean; consumed: boolean }>({ active: false, consumed: false })

  const stopFollowingBottom = useCallback((): void => {
    stickToBottomRef.current = false
    initialBottomRef.current.consumed = true
    if (activeCalibrationRef.current?.kind === 'initial-bottom') activeCalibrationRef.current.cancel()
  }, [])

  // 启动最终锚点校准并接管在途任务（新定位/搜索高亮互斥，旧的立即 cancel）。
  // 行 ref 在 commit 阶段可能先于父级 scrollRef 挂载（子先于父），从目标自身
  // 向上定位滚动容器，不依赖 ref 挂载顺序。
  const armScrollCalibration = useCallback(
    (target: HTMLElement, alignment: AnchorAlignment): void => {
      const scroller = target.closest<HTMLElement>('.timeline-scroll')
      if (scroller === null) return
      stopFollowingBottom()
      activeCalibrationRef.current?.cancel()
      activeCalibrationRef.current = {
        conversationId: conversation.id,
        kind: 'anchor',
        cancel: calibrateAnchorAfterSmoothScroll({ scroller, target, alignment }),
      }
    },
    [conversation.id, stopFollowingBottom],
  )

  const highlightScrollRef = useHighlightScroll(conversation.id, armScrollCalibration)
  const highlightClass = useEntryHighlight(conversation.id, localHighlightEntryId)

  // 换会话/卸载：仅作废属于旧会话的在途校准（挂载/换会话时 ref callback 先于
  // 本 effect 运行，新会话刚启动的校准不能被本轮 cleanup 或 setup 误杀）与高亮
  // 清除定时器（同一组件实例复用滚动容器）；切换会话重置贴底吸附初态。
  // 初始贴底窗口同样只取消不消费：StrictMode 的 cleanup→setup 重演后可重启。
  useEffect(() => {
    stickToBottomRef.current = true
    lastScrollTopRef.current = 0
    // 重置大纲 tick 消费记录：换会话/StrictMode 重挂后，尚在生效的定位请求
    // 必须重新执行（否则 setup 重置的贴底初态会抢走定位目的地）。
    lastOutlineTickRef.current = null
    initialBottomRef.current.active = false
    initialBottomRef.current.consumed = false
    setProcessToggle(null)
    const ownedConversationId = conversation.id
    return () => {
      const active = activeCalibrationRef.current
      if (active !== null && active.conversationId === ownedConversationId) {
        active.cancel()
        activeCalibrationRef.current = null
      }
      if (outlineHighlightTimerRef.current !== null) {
        clearTimeout(outlineHighlightTimerRef.current)
        outlineHighlightTimerRef.current = null
      }
    }
  }, [conversation.id])

  // 启动一次性初始贴底校准（详见 timeline-scroll-calibration.ts）。仅在：
  // 未消费、未在途、仍处于贴底吸附态（搜索/大纲定位 effect 已先行释放贴底，
  // 显式定位优先）且滚动容器就绪时启动；窗口结束后不再因 rerender 复活。
  const beginInitialBottomCalibration = useCallback((): void => {
    const state = initialBottomRef.current
    if (state.consumed || state.active) return
    if (!stickToBottomRef.current) return
    const scroller = scrollRef.current
    if (scroller === null) return
    activeCalibrationRef.current?.cancel()
    state.active = true
    const cancel = calibrateInitialStickToBottom({
      scroller,
      onEnd: (reason) => {
        state.active = false
        if (reason !== 'cancelled') state.consumed = true
        if (reason === 'user-input') stickToBottomRef.current = false
        const active = activeCalibrationRef.current
        if (active !== null && active.cancel === cancel) activeCalibrationRef.current = null
      },
    })
    activeCalibrationRef.current = { conversationId: conversation.id, kind: 'initial-bottom', cancel }
  }, [conversation.id])

  const isWorking = conversation.status === 'working'
  const isCompacting = conversation.contextUsage?.compacting === true
  const items = useMemo(
    () =>
      timelineItems ??
      buildTimelineItems(detailEntries, {
        ...(live !== undefined ? { live } : {}),
        working: isWorking,
        compacting: isCompacting,
        timelineRenderers: store.groupedUi.timelineRenderers,
        toolViews: store.groupedUi.toolViews,
      }),
    [timelineItems, detailEntries, live, isWorking, isCompacting, store.groupedUi.timelineRenderers, store.groupedUi.toolViews],
  )

  // timeline.entry.action 锚点索引：以 props 传入的 detailEntries（经 rewind
  // 覆盖过滤，与渲染层同口径）定位真实 ConversationEntry。
  const activeEntriesById = useMemo(() => buildActiveEntryIndex(detailEntries), [detailEntries])

  const hasLiveTurn = items.some((item) => item.kind === 'assistant' && item.live)
  const resolvedAsks = store.resolvedAsksByConv[conversation.id] ?? []

  // 全量工具调用轻量摘要：一次性收集，透传给每个 tool.view 插件组件
  //（siblingCalls 供其自行计算同目标多次调用折叠 / resume 续接关系）。
  const siblingCalls = useMemo(() => collectSiblingCalls(items), [items])

  // 实际生成模型边界索引（纯函数一次扫描）：为每个发生模型切换的 assistant
  // 回合按 key 索引新模型身份，渲染层只查表，不堆业务判断。
  const modelBoundaries = useMemo(() => buildAssistantModelBoundaries(items), [items])

  const lastAssistantKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === 'assistant') return items[i]!.key
    }
    return undefined
  }, [items])

  const latestProcessTurnKey = useMemo(() => findLatestProcessTurnKey(items), [items])
  latestProcessTurnKeyRef.current = latestProcessTurnKey

  // Ctrl+O 全局快捷键分发：按面板（primary/split）精准切换最新含过程步骤助手回合的折叠态；
  // 通过查询当下 DOM 真实 aria-expanded 状态决定开合方向，确保与手动点击零打架。
  useEffect(() => {
    const onShortcut = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return
      const detail = event.detail as unknown
      if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return
      const { action, panel } = detail as { action?: unknown; panel?: unknown }
      if (action !== 'toggle-process-groups' || (panel !== 'primary' && panel !== 'split')) return
      const root = rootRef.current
      if (root === null) return
      if (root.closest('.conversation-drawer') !== null) return
      const myPanel = root.closest('[data-helm-panel]')?.getAttribute('data-helm-panel') ?? 'primary'
      if (panel !== myPanel) return
      const targetTurnKey = latestProcessTurnKeyRef.current
      if (targetTurnKey === undefined) return
      const turnEl = innerRef.current?.querySelector<HTMLElement>('[data-latest-process-turn="true"]')
      const rootToggles = turnEl?.querySelectorAll<HTMLElement>('[data-process-toggle="root"]')
      const anyOpen =
        rootToggles !== undefined &&
        Array.from(rootToggles).some((el) => el.getAttribute('aria-expanded') === 'true')
      const nextSeq = ++processToggleSeqRef.current
      setProcessToggle({
        turnKey: targetTurnKey,
        command: { open: !anyOpen, seq: nextSeq },
      })
    }
    window.addEventListener('helm:shortcut', onShortcut)
    return () => window.removeEventListener('helm:shortcut', onShortcut)
  }, [])

  // 历史行渲染隔离（content-visibility）：仅浏览器支持时启用；live 流式回合、
  // 排队输入、最新 assistant 回合与高亮/大纲定位目标行在 resolveContainmentClass
  // 内解除隔离，保证测量与滚动定位以真实布局进行。
  const containmentEnabled = useMemo(() => supportsTimelineContainment(), [])

  // 必须解除隔离的锚点：搜索高亮（store）、大纲闪烁高亮（local）与当前定位请求目标。
  const releasedEntryIds = useMemo(() => {
    const ids = new Set<string>()
    const h = store.highlightedEntry
    if (h !== null && h.conversationId === conversation.id && h.entryId !== '') ids.add(h.entryId)
    if (localHighlightEntryId !== null && localHighlightEntryId !== '') ids.add(localHighlightEntryId)
    const requested = outlineScrollRequest?.entryId
    if (requested !== undefined && requested !== '') ids.add(requested)
    return ids
  }, [store.highlightedEntry, conversation.id, localHighlightEntryId, outlineScrollRequest])

  const cvExclusions = useMemo<ContainmentExclusions>(
    () => ({ releasedEntryIds, latestAssistantKey: lastAssistantKey }),
    [releasedEntryIds, lastAssistantKey],
  )

  // 锚点集合签名：仅当行集合（锚点 id 序列）变化时才重建阅读锚点观察器；
  // 流式内容增长（items 引用变化但锚点不变）不触发重绑。
  const anchorSignature = useMemo(() => items.map((item) => timelineAnchorId(item)).join('\n'), [items])
  // 观察器只读取最近一次提交的回调，不因父组件的新闭包反复重绑。
  const notifyActiveEntryChange = useStableCallback((entryId: string | undefined): void => {
    onActiveEntryChange?.(entryId)
  })
  const anchorTrackingEnabled = onActiveEntryChange !== undefined

  // 贴底吸附：主动上滚即刻脱离贴底（解除死区牢笼，无论离底多近均尊重上滚意图）；
  // 仅在主动向底滚动至近底区或实质触底时才恢复贴底。
  // 初始贴底窗口期内 scroll 事件的 top 下降可能只是估高转真实布局的位移（浏览器
  // 对收缩后超界的 scrollTop 下调同样派发 scroll），不据此判定用户意图——窗口期
  // 的用户接管由校准器的物理输入监听同步取消并释放贴底。
  // 常驻方向性输入释放：wheel 上滚（deltaY<0）与上滚方向键在事件监听内同步释放
  // 贴底，不等 scroll 事件（scroll 异步派发，流式增长触发的 ResizeObserver 跟底
  // 写入可能先于 scroll 到达，仅靠 scroll 判定会把用户已上滚的位置拉回底部）。
  // 只处理明确向上的输入；点击/触摸/向下输入不阻止 working 正常跟底。
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onScroll = (): void => {
      const top = el.scrollTop
      if (initialBottomRef.current.active) {
        lastScrollTopRef.current = top
        return
      }
      const distanceFromBottom = el.scrollHeight - top - el.clientHeight
      if (top < lastScrollTopRef.current) {
        // 输入框收起或内容收缩会把 scrollTop 夹紧到新底部；保留既有跟随意图，
        // 既不误判为用户上翻，也不恢复用户已经解除的贴底。
        if (distanceFromBottom > 1) stickToBottomRef.current = false
      } else if (distanceFromBottom <= 32 && (top > lastScrollTopRef.current || distanceFromBottom <= 8)) {
        stickToBottomRef.current = true
      }
      lastScrollTopRef.current = top
    }
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) stopFollowingBottom()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
        stopFollowingBottom()
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('keydown', onKeyDown, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [stopFollowingBottom])

  // 视口当前阅读锚点追踪（供大纲浮层高亮）：IntersectionObserver 观察区域
  // 下缘收窄到「容器顶 + OUTLINE_ACTIVE_LINE_PX 基准线」，行相交 ⟺ 行顶已
  // 越过基准线，最后一个相交索引与 resolveActiveOutlineEntryId 语义对齐
  //（见 timeline-containment-model），屏外行不被 rect 测量强制布局；锚点集合
  // 或容器高度变化时重绑，无 IO 环境退化为 rAF 节流整列测量。
  useEffect(() => {
    if (!anchorTrackingEnabled) return
    const scroller = scrollRef.current
    const inner = innerRef.current
    if (scroller === null || inner === null) return

    const anchors = Array.from(inner.querySelectorAll<HTMLElement>('[data-entry-id]')).filter(
      (el) => (el.dataset.entryId ?? '') !== '',
    )
    const entryIds = anchors.map((el) => el.dataset.entryId!)
    const publish = (nextActive: string | undefined): void => {
      if (nextActive === lastActiveEntryRef.current) return
      lastActiveEntryRef.current = nextActive
      notifyActiveEntryChange(nextActive)
    }

    if (typeof IntersectionObserver === 'undefined') {
      // 退化路径：rAF 节流，每帧至多测量一次（而非每个 scroll 事件一次）。
      let frame = 0
      const measure = (): void => {
        frame = 0
        const containerTop = scroller.getBoundingClientRect().top
        const offsets: Array<{ entryId: string; top: number }> = []
        for (const node of anchors) {
          offsets.push({ entryId: node.dataset.entryId!, top: node.getBoundingClientRect().top - containerTop })
        }
        publish(resolveActiveOutlineEntryId(offsets, OUTLINE_ACTIVE_LINE_PX))
      }
      const schedule = (): void => {
        if (frame === 0) frame = requestAnimationFrame(measure)
      }
      schedule()
      scroller.addEventListener('scroll', schedule, { passive: true })
      return () => {
        scroller.removeEventListener('scroll', schedule)
        if (frame !== 0) cancelAnimationFrame(frame)
      }
    }

    const intersecting = new Set<number>()
    const indexByEl = new Map<HTMLElement, number>()
    anchors.forEach((el, index) => indexByEl.set(el, index))
    const onEntries = (entries: IntersectionObserverEntry[]): void => {
      for (const entry of entries) {
        const idx = indexByEl.get(entry.target as HTMLElement)
        if (idx === undefined) continue
        if (entry.isIntersecting) intersecting.add(idx)
        else intersecting.delete(idx)
      }
      const next = resolveActiveAnchorIndex(intersecting, entryIds.length)
      publish(next === -1 ? undefined : entryIds[next])
    }
    let io: IntersectionObserver | null = null
    const buildObserver = (): void => {
      io?.disconnect()
      intersecting.clear()
      // 基准线随容器高度变化（分屏/缩放）：由 ResizeObserver 触发重绑。
      const bottomInset = Math.max(0, scroller.clientHeight - OUTLINE_ACTIVE_LINE_PX)
      io = new IntersectionObserver(onEntries, { root: scroller, rootMargin: `0px 0px -${bottomInset}px 0px` })
      for (const el of anchors) io.observe(el)
    }
    buildObserver()
    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => buildObserver())
      ro.observe(scroller)
    }
    return () => {
      io?.disconnect()
      ro?.disconnect()
    }
  }, [anchorTrackingEnabled, anchorSignature, notifyActiveEntryChange])

  // 响应大纲面板点击定位：目标行已在同一渲染中解除渲染隔离（releasedEntryIds
  // 含请求 entryId），本 effect 于 DOM commit 后以真实布局测量定位；heading 按
  // DOM 顺序取序数（渲染隔离保留完整 DOM，与大纲提取一致）。tick 仅在目标
  // 真实存在并处理后消费：目标尚未加载（历史分页未及）时不消费也不标记，
  // 锚点集合变化后重试，绝不把请求静默丢弃。
  useEffect(() => {
    if (!outlineScrollRequest || outlineScrollRequest.tick === lastOutlineTickRef.current) return
    const container = innerRef.current
    if (container === null) return

    let targetWrapper: HTMLElement | null = null
    for (const el of container.querySelectorAll<HTMLElement>('[data-entry-id]')) {
      if (el.dataset.entryId === outlineScrollRequest.entryId) {
        targetWrapper = el
        break
      }
    }
    if (targetWrapper === null) return
    lastOutlineTickRef.current = outlineScrollRequest.tick
    stickToBottomRef.current = false

    let scrollEl: HTMLElement = targetWrapper
    if (outlineScrollRequest.cardId !== undefined) {
      const cardEl = targetWrapper.querySelector<HTMLElement>(
        `[data-outline-card-id="${escapeAttrSelectorValue(outlineScrollRequest.cardId)}"]`,
      )
      if (cardEl !== null) {
        scrollEl = cardEl
      }
    } else if (outlineScrollRequest.headingIndex !== undefined) {
      const headings = targetWrapper.querySelectorAll<HTMLElement>('.msg-ai-body h1, .msg-ai-body h2, .msg-ai-body h3')
      const matchedHeading = headings[outlineScrollRequest.headingIndex]
      if (matchedHeading !== undefined) {
        scrollEl = matchedHeading
      }
    }
    // 大纲定位：目标对齐到滚动区顶部（而非居中），便于从该条消息开始向下阅读。
    scrollEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
    armScrollCalibration(scrollEl, 'start')
    setLocalHighlightEntryId(outlineScrollRequest.entryId)
    if (anchorTrackingEnabled) {
      lastActiveEntryRef.current = outlineScrollRequest.entryId
      notifyActiveEntryChange(outlineScrollRequest.entryId)
    }
    if (outlineHighlightTimerRef.current !== null) clearTimeout(outlineHighlightTimerRef.current)
    outlineHighlightTimerRef.current = setTimeout(() => {
      outlineHighlightTimerRef.current = null
      setLocalHighlightEntryId((current) => (current === outlineScrollRequest.entryId ? null : current))
    }, 2400)
  }, [outlineScrollRequest, anchorTrackingEnabled, notifyActiveEntryChange, anchorSignature, armScrollCalibration])

  // 监听内部容器高度变化（思考流式增长、命令追加、分组自动展开/收起）。
  // 仅在会话仍有活跃生成（isWorking / hasLiveTurn）且当前处于贴底吸附态时跟随到底部；
  // 已结算静止会话的历史浏览不因 content-visibility 估高纠正、折叠展开或异步资源加载而误置底。
  useEffect(() => {
    const inner = innerRef.current
    const scroller = scrollRef.current
    if (inner === null || scroller === null || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const el = scrollRef.current
      if (el === null || !stickToBottomRef.current) return
      if (!isWorking && !hasLiveTurn) return
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
    })
    ro.observe(inner)
    // Composer 高度、移动端键盘等只改变视口，不一定改变 inner 的尺寸。
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [isWorking, hasLiveTurn])

  useEffect(() => {
    if (store.highlightedEntry?.conversationId === conversation.id) stopFollowingBottom()
  }, [store.highlightedEntry, conversation.id, stopFollowingBottom])

  const lastHumanKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === 'human') return items[i]!.key
    }
    return undefined
  }, [items])

  const lastTurnSummary = useMemo(() => {
    const last = items[items.length - 1]
    if (last?.kind !== 'assistant') return ''
    return last.segments
      .map((s) => (s.kind === 'step-group' ? `g:${s.stepCount}:${s.active ? 1 : 0}` : s.kind === 'tool' ? `t:${s.tool.key}:${s.tool.status}` : `x:${s.text.length}`))
      .join(',')
  }, [items])

  const contentFingerprint = `${items.length}:${detailEntries.length}:${conversation.status}:${conversation.contextUsage?.compacting === true ? 1 : 0}:${lastTurnSummary}:${live?.updatedAt ?? 0}:${live?.thinking?.length ?? 0}:${live?.text.length ?? 0}:${live?.queuedInputs?.map((q) => `${q.id}:${q.mode}`).join(',') ?? ''}:${resolvedAsks.length}`
  // 会话历史就绪（conversationDetails 存在，含合法空会话）：loading 的空白
  // mount 不启动初始贴底窗口，避免硬上界在空白期被空转耗尽。
  const detailsReady = store.conversationDetails[conversation.id] !== undefined
  useEffect(() => {
    if (detailsReady) {
      const previous = lastHumanRef.current
      // 初始化历史只记录锚点；已就绪的空会话随后首次发送仍是新增输入，须贴底。
      if (previous?.conversationId === conversation.id && lastHumanKey !== undefined && lastHumanKey !== previous.key) {
        stickToBottomRef.current = true
      }
      lastHumanRef.current = { conversationId: conversation.id, key: lastHumanKey }
    }
    const el = scrollRef.current
    if (el !== null && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
      lastScrollTopRef.current = el.scrollTop
    }
    // 历史就绪后启动一次性初始贴底校准（窗口内部自守卫：已消费/在途/已释放
    // 贴底时不动作）；数据延迟就绪时由 detailsReady 依赖在本 effect 重启时启动。
    if (detailsReady) beginInitialBottomCalibration()
  }, [contentFingerprint, lastHumanKey, detailsReady, conversation.id, beginInitialBottomCalibration])

  const loading = !detailsReady

  const loadEarlierEntries = (): void => {
    stopFollowingBottom()
    const scroller = scrollRef.current
    if (scroller === null) return
    const anchor = captureTimelineScrollAnchor(scroller)
    setLoadingOlder(true)
    void store.loadEarlierEntries(conversation.id).finally(() => {
      setLoadingOlder(false)
      requestAnimationFrame(() => restoreTimelineScrollAnchor(scroller, anchor))
    })
  }

  // 引导词仅出现在「确实空白」的会话：历史已加载完且无更早分页、无在途
  // 发送/运行、无排队输入与待审批。任一不满足都不渲染，避免误判。
  const conversationDetail = store.conversationDetails[conversation.id]
  const startersVisible =
    starters !== undefined &&
    starters.length > 0 &&
    onRequestStarter !== undefined &&
    !loading &&
    conversationDetail?.nextCursor === undefined &&
    !isWorking &&
    conversation.status !== 'blocked' &&
    !sendingPending &&
    (live?.queuedInputs?.length ?? 0) === 0 &&
    items.length === 0 &&
    resolvedAsks.length === 0

  return (
    <div ref={rootRef} className="timeline-container">
      <div ref={scrollRef} className="timeline-scroll">
      {store.conversationDetails[conversation.id]?.nextCursor && (
        <button className="btn btn-ghost btn-sm" disabled={loadingOlder} onClick={loadEarlierEntries}>
          {loadingOlder ? '正在加载历史…' : '加载更早的消息'}
        </button>
      )}
      {store.loadErrors[`history:${conversation.id}`] && <p className="callout callout--error" role="alert">{store.loadErrors[`history:${conversation.id}`]}</p>}
      {loading ? (
        <div className="timeline-loading-state">
          <HelmIcon name="loader" size={14} className="spin-slow" />
          正在加载会话…
        </div>
      ) : null}
      {!loading && !sendingPending && !isWorking && items.length === 0 && resolvedAsks.length === 0 ? (
        <div className="timeline-empty-state">
          <HelmIcon name="message-square" size={22} />
          <span>向助理描述目标，或从左侧选择会话开始</span>
        </div>
      ) : null}
      {startersVisible ? (
        <div className="timeline-starters">
          {starters.map((starter, index) => (
            <button
              key={`starter-${index}-${starter.label}`}
              type="button"
              className="timeline-starter-btn"
              title={starter.prompt}
              onClick={() => onRequestStarter?.(starter.prompt)}
            >
              <HelmIcon name="corner-down-right" size={11} />
              <span className="timeline-starter-label">{starter.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div ref={innerRef} className="timeline-inner">
        {items.map((item) => {
          // 渲染隔离类：仅历史完成行获得（live/排队/最新 assistant 回合/解除目标行
          // 由 resolveContainmentClass 返回空串，正常渲染）。
          const cvClass = resolveContainmentClass(item, cvExclusions, containmentEnabled)
          if (item.kind === 'human') {
            return (
              <div
                key={item.key}
                className={`timeline-human-wrap ${highlightClass(item.entryId)}${cvClass !== '' ? ` ${cvClass}` : ''}`}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
              >
                <HumanMessage
                  item={item}
                  conversation={conversation}
                  anchorEntry={activeEntriesById.get(item.entryId)}
                  onRequestEdit={onRequestEdit}
                  onForkFromHere={entryActions.forkFromHere}
                  onWithdrawQueuedEdit={entryActions.withdrawQueuedForEdit}
                />
              </div>
            )
          }
          if (item.kind === 'divider') {
            return (
              <div
                key={item.key}
                className={`${highlightClass(item.entryId)}${cvClass !== '' ? ` ${cvClass}` : ''}`.trim()}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
              >
                <ContextDivider item={item} />
              </div>
            )
          }
          if (item.kind === 'plugin-card') {
            return (
              <div
                key={item.key}
                className={`${highlightClass(item.entryId)}${cvClass !== '' ? ` ${cvClass}` : ''}`.trim()}
                ref={highlightScrollRef}
                data-entry-id={item.entryId}
              >
                <PluginCard item={item} conversationId={conversation.id} />
              </div>
            )
          }
          const anchorId = timelineAnchorId(item)
          const modelBoundary = modelBoundaries.get(item.key)
          return (
            <div
              key={item.key}
              className={`${highlightClass(anchorId)}${cvClass !== '' ? ` ${cvClass}` : ''}`.trim()}
              ref={highlightScrollRef}
              data-entry-id={anchorId}
              data-latest-process-turn={item.key === latestProcessTurnKey ? 'true' : undefined}
            >
              {modelBoundary !== undefined ? <AssistantModelBoundary model={modelBoundary} /> : null}
              <AssistantTurnView
                turn={item}
                conversation={conversation}
                siblingCalls={siblingCalls}
                anchorEntry={resolveAssistantAnchorEntry(item.entryIds, activeEntriesById)}
                isLatestTurn={item.key === lastAssistantKey}
                processShortcut={processToggle?.turnKey === item.key ? processToggle.command : undefined}
                onForkFromHere={entryActions.forkFromHere}
              />
            </div>
          )
        })}
        {(isWorking && !hasLiveTurn) || (sendingPending && !isWorking) ? (
          <div className="msg-ai-block" role="status" aria-live="polite">
            <span className="msg-origin-tag" aria-label="正在生成">
              <HelmIcon name="loader" size={12.5} className="spin-slow" />
            </span>
          </div>
        ) : null}
        {resolvedAsks.map(({ ask, status }) => (
          <ResolvedAskRow key={`ask:${ask.id}`} ask={ask} status={status} />
        ))}
        {conversation.status === 'error' ? (
          <TurnErrorNotice conversation={conversation} detailEntries={detailEntries} onRequestEdit={onRequestEdit} />
        ) : null}
      </div>
      <div ref={bottomRef} className="timeline-scroll-anchor" />
      </div>
    </div>
  )
}
