import { useContext, useMemo, useState } from 'react'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
import { CopyButton, HelmIcon, ToolActivityContext } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { PluginMicroAction } from '../ui/PluginMicroAction.js'
import { matchTimelineEntryActions, timelineEntryActionContextOf } from './action-model.js'
import { MarkdownView } from './MarkdownView.js'
import { StepGroup, TraceRow } from './TimelineRows.js'
import { ToolActivityProvider } from './ToolActivityProvider.js'
import { isAssistantTurnBusy, assistantModelFullLabel, assistantModelShortLabel, type AssistantModelIdentity, type AssistantTurn, type ProcessShortcutCommand } from './timeline-model.js'
import { formatDurationMs, formatFullTimestamp, formatMessageTime } from '../lib/format.js'
import { Tooltip } from '../ui/Tooltip.js'

// ---------------------------------------------------------------------------
// 实际生成模型边界（回看最近 assistant 回合模型不同时，锚定新模型 entry 之前；
// 判定纯函数见 timeline-model.ts 的 buildAssistantModelBoundaries）
// ---------------------------------------------------------------------------

export function AssistantModelBoundary({ model }: { model: AssistantModelIdentity }) {
  const full = assistantModelFullLabel(model)
  return (
    <div
      className="model-boundary"
      role="separator"
      aria-label={`实际生成模型切换为 ${full}`}
      title={`实际生成模型已切换：${full}`}
    >
      <span className="model-boundary-label">
        <HelmIcon name="cpu" size={11} />
        <span className="mono">{assistantModelShortLabel(model)}</span>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Assistant 回合（自 ConversationTimeline 拆出的子组件）
// ---------------------------------------------------------------------------

export interface AssistantTurnViewProps {
  turn: AssistantTurn
  conversation: ConversationSummary
  siblingCalls: ReadonlyArray<import('@helm/protocol').ToolViewSiblingCall>
  isLatestTurn?: boolean
  /** 回合锚点对应的真实持久化 pi.assistant 条目（见 resolveAssistantAnchorEntry）。 */
  anchorEntry?: ConversationEntry
  /** Ctrl+O 过程步骤折叠指令（仅最新含过程步骤回合传入）。 */
  processShortcut?: ProcessShortcutCommand
  /** 从回合末条目分叉新会话（ConversationTimeline 统一实例化的动作服务）。 */
  onForkFromHere: (entryId: string) => Promise<void>
}

export function AssistantTurnView(props: AssistantTurnViewProps) {
  return <ToolActivityProvider><AssistantTurnContent {...props} /></ToolActivityProvider>
}

function AssistantTurnContent({ turn, conversation, siblingCalls, isLatestTurn = false, anchorEntry, processShortcut, onForkFromHere }: AssistantTurnViewProps) {
  const store = useHelmStore()
  const activeToolCallIds = useContext(ToolActivityContext)?.activeToolCallIds
  const [forking, setForking] = useState(false)
  const lastText = useMemo(() => {
    const texts = turn.segments.filter((s) => s.kind === 'text') as Array<{ kind: 'text'; text: string }>
    return texts.map((t) => t.text).join('\n\n')
  }, [turn.segments])
  // 流式正文提示：live 回合的最后一个文本段是仍在增长的真 live 文本（流式增量
  // 总并入末段），传 streaming 启用 MarkdownView 流式渲染路径；已结算回合与
  // 其他静态 Markdown 不启用。
  const lastTextSegIndex = useMemo(() => {
    for (let i = turn.segments.length - 1; i >= 0; i--) {
      if (turn.segments[i]!.kind === 'text') return i
    }
    return -1
  }, [turn.segments])

  const forkFromHere = async (): Promise<void> => {
    const entryId = turn.entryIds.length > 0 ? turn.entryIds[turn.entryIds.length - 1]! : undefined
    if (entryId === undefined) return
    setForking(true)
    try {
      await onForkFromHere(entryId)
    } finally {
      setForking(false)
    }
  }

  const isBusy = isAssistantTurnBusy(turn, conversation, { isLatestTurn, activeToolCallIds })
  // 插件微插槽 timeline.entry.action：锚点必须是真实持久化 pi.assistant 条目；
  // live 回合（尚无落库锚点）不渲染，绝不拿 pi.tool-result 或 key 伪造。
  const entryActions =
    !isBusy && anchorEntry !== undefined
      ? matchTimelineEntryActions(
          store.groupedUi.uiActions,
          conversation,
          timelineEntryActionContextOf(anchorEntry),
        )
      : []

  const timeMs = turn.settledAt ?? turn.startedAt
  const displayTime = formatMessageTime(timeMs)
  const durationText = turn.durationMs !== undefined && turn.durationMs > 0 ? formatDurationMs(turn.durationMs) : ''
  const hasTimeInfo = !isBusy && (displayTime !== '' || durationText !== '')
  const fullTimestamp = formatFullTimestamp(timeMs)
  let tooltipText = ''
  if (fullTimestamp !== '' && durationText !== '') {
    tooltipText = `完成于 ${fullTimestamp} · 耗时 ${durationText}`
  } else if (fullTimestamp !== '') {
    tooltipText = `完成于 ${fullTimestamp}`
  } else if (durationText !== '') {
    tooltipText = `耗时 ${durationText}`
  }

  const showHoverBar = !isBusy && (lastText !== '' || turn.entryIds.length > 0)
  // 实际生成模型标签：仅来自本回合已落库 pi.assistant 的可信身份；busy（live/
  // 在途）回合不展示，避免把待生成内容归到任何模型；缺失则不显示。
  const modelFull = turn.model !== undefined ? assistantModelFullLabel(turn.model) : ''
  const modelShort = turn.model !== undefined ? assistantModelShortLabel(turn.model) : ''
  const showModelTag = !isBusy && modelShort !== ''

  return (
    <div className="msg-ai-block" tabIndex={0}>
      {turn.segments.map((seg, segIndex) => {
        if (seg.kind === 'text') {
          return (
            <MarkdownView
              key={seg.key}
              text={seg.text}
              conversationId={conversation.id}
              streaming={turn.live && segIndex === lastTextSegIndex}
            />
          )
        }
        if (seg.kind === 'step-group') {
          return (
            <StepGroup
              key={seg.key}
              steps={seg.steps}
              active={seg.active === true}
              conversationId={conversation.id}
              siblingCalls={siblingCalls}
              shortcutToggle={processShortcut}
            />
          )
        }
        return (
          <TraceRow
            key={seg.key}
            tool={seg.tool}
            conversationId={conversation.id}
            defaultOpen={false}
            siblingCalls={siblingCalls}
          />
        )
      })}
      {turn.live ? (
        <span className="msg-origin-tag" aria-label="正在生成" role="status">
          <HelmIcon name="loader" size={12.5} className="spin-slow" />
        </span>
      ) : null}
      {hasTimeInfo || showHoverBar || showModelTag ? (
        <div className="msg-ai-footer">
          {showModelTag ? (
            <Tooltip content={`实际生成模型：${modelFull}`}>
              <span className="msg-time-meta" title={`实际生成模型：${modelFull}`}>
                <HelmIcon name="cpu" size={11} />
                <span className="mono">{modelShort}</span>
              </span>
            </Tooltip>
          ) : null}
          {hasTimeInfo ? (
            <Tooltip content={tooltipText}>
              <span className="msg-time-meta" title={tooltipText}>
                {displayTime !== '' ? <span>{displayTime}</span> : null}
                {displayTime !== '' && durationText !== '' ? <span className="msg-time-sep">·</span> : null}
                {durationText !== '' ? <span>耗时 {durationText}</span> : null}
              </span>
            </Tooltip>
          ) : null}
          {showHoverBar ? (
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
              {lastText !== '' ? <CopyButton text={lastText} /> : null}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                title="从此处分叉新会话"
                disabled={forking || turn.entryIds.length === 0}
                onClick={() => void forkFromHere()}
              >
                <HelmIcon name={forking ? 'loader' : 'git-fork'} size={12} />
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
