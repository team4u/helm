import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewSpec } from '@helmx/protocol/browser'
import { HelmxIcon } from '@helmx/plugin-client'
import { PluginUiView } from '../ui/PluginUiView.js'
import { ToolExpandedBody, ToolRawBody } from './ToolExpandedBody.js'
import { MarkdownView } from './MarkdownView.js'
import {
  buildToolViewProps,
  toolStatusIcon,
  toolSummaryText,
  type FoldableStep,
  type ProcessShortcutCommand,
  type ToolTrace,
} from './timeline-model.js'
import { summarizeStepGroup, toolRowStats } from './tool-body-model.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatDurationMs } from '../lib/format.js'
import { Tooltip } from '../ui/Tooltip.js'

// ---------------------------------------------------------------------------
// 工具单行轨迹 / 思考折叠组（ConversationTimeline 的行级渲染单元）
// ---------------------------------------------------------------------------

/**
 * 运行中工具的实时已耗时秒表：起点为派发该调用的响应结束时刻（消息 timestamp+durationMs，
 * 见 timeline-model appendEntry），本地每秒跳字，工具落定随行卸载（无孤儿定时器）。
 * tabular-nums 防止秒位跳动抖宽。
 */
function RunningElapsed({ startedAt }: { startedAt: number }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="tabular-nums">{formatDurationMs(Math.max(0, now - startedAt))}</span>
}

export function TraceRow({
  tool,
  conversationId,
  defaultOpen,
  siblingCalls,
}: {
  tool: ToolTrace
  conversationId: number
  defaultOpen: boolean
  /** 当前时间线内全部工具调用轻量摘要（透传给 tool.view 插件组件）。 */
  siblingCalls: ReadonlyArray<import('@helmx/protocol/browser').ToolViewSiblingCall>
}) {
  const [open, setOpen] = useState(defaultOpen)
  const { t } = useWebLocale()

  const rowFailed = Boolean(tool.isError)
  // 运行中行右侧只显示实时已耗时秒表（左侧转圈已表意，与落定后的纯耗时形态一致）；
  // 响应缺少 durationMs 等无法诚实锚定起点的场景右侧留空，不编造起始时间。
  const right: ReactNode =
    tool.status === 'running'
      ? tool.startedAt !== undefined
        ? <RunningElapsed startedAt={tool.startedAt} />
        : ''
      : rowFailed && tool.durationMs === undefined
        ? t('conv.tool.statusFailed')
        : tool.durationMs !== undefined
          ? formatDurationMs(tool.durationMs)
          : tool.status === 'done'
            ? t('conv.tool.statusCompleted')
            : ''
  const rowIcon = toolStatusIcon(tool)

  // 单行极简统计（edit +N −N / write 行数）：只报事实，运行态不伪称成功。
  const stats = useMemo(() => toolRowStats(tool, t), [tool, t])

  // 命中插件 tool.view：replaceRow=true 时插件组件完全替换默认工具行；
  // 未设置时保持外层 trace-row + 下方 trace-toolview 的默认双栏形态。
  // inline 插件视图保留工具行的原始数据入口，专属展开体仅用于宿主工具。
  // 顶层业务卡标记 data-outline-card-id（tool.key）：会话大纲二级锚精确定位。
  const toolView = tool.toolView
  const replaceRow = toolView !== undefined && (toolView.spec as ToolViewSpec).replaceRow === true

  return (
    <div
      className={`trace-entry${rowFailed ? ' trace-entry-error' : ''}`}
      {...(toolView !== undefined ? { 'data-outline-card-id': tool.key } : {})}
    >
      {toolView !== undefined && replaceRow ? (
        <div className="trace-block">
          <PluginUiView
            pluginId={toolView.pluginId}
            spec={toolView.spec}
            conversationId={conversationId}
            label={t('conv.tool.viewLabel', { name: tool.toolName })}
            slotProps={buildToolViewProps(tool, conversationId, siblingCalls)}
          />
        </div>
      ) : (
        <>
          <div
            className={`trace-row${rowFailed ? ' trace-row-error' : ''}`}
            role="button"
            tabIndex={0}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setOpen((v) => !v)
              }
            }}
          >
            <span className="trace-row-left">
              <HelmxIcon
                name={rowIcon}
                size={12}
                className={tool.status === 'running' ? 'spin-slow' : undefined}
              />
              <span className="trace-tool-name">{tool.toolName}</span>
              <span className="trace-tool-summary">{toolSummaryText(tool.toolName, tool.input)}</span>
              {stats !== undefined ? (
                <span className="trace-row-stats" title={stats.title}>
                  {stats.removeCount !== undefined ? (
                    <span className="trace-row-stats-remove">−{stats.removeCount}</span>
                  ) : null}
                  {stats.addCount !== undefined ? (
                    <span className="trace-row-stats-add">+{stats.addCount}</span>
                  ) : null}
                  {stats.text !== undefined ? <span>{stats.text}</span> : null}
                </span>
              ) : null}
            </span>
            <span className="trace-row-right">
              {right !== '' ? <span>{right}</span> : null}
              <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} className="trace-row-chevron" />
            </span>
          </div>
          {toolView !== undefined ? (
            <div className="trace-toolview">
              <PluginUiView
                pluginId={toolView.pluginId}
                spec={toolView.spec}
                conversationId={conversationId}
                label={t('conv.tool.viewLabel', { name: tool.toolName })}
                slotProps={buildToolViewProps(tool, conversationId, siblingCalls)}
              />
            </div>
          ) : null}
          {open ? (
            <div className="trace-expanded-body selectable">
              {toolView === undefined
                ? <ToolExpandedBody tool={tool} conversationId={conversationId} />
                : <ToolRawBody tool={tool} conversationId={conversationId} />}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

export function StepGroup({
  steps,
  active,
  conversationId,
  siblingCalls,
  shortcutToggle,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
  siblingCalls: ReadonlyArray<import('@helmx/protocol/browser').ToolViewSiblingCall>
  shortcutToggle?: ProcessShortcutCommand
}) {
  const firstStep = steps[0]
  if (
    steps.length === 1 &&
    firstStep !== undefined &&
    firstStep.kind === 'thinking' &&
    firstStep.thinking.responseDurationMs === undefined
  ) {
    return (
      <ThinkingRow
        text={firstStep.thinking.text}
        active={firstStep.thinking.active ?? active}
        conversationId={conversationId}
        shortcutToggle={shortcutToggle}
        isRootProcessToggle
      />
    )
  }

  return (
    <MultiStepGroup
      steps={steps}
      active={active}
      conversationId={conversationId}
      siblingCalls={siblingCalls}
      shortcutToggle={shortcutToggle}
    />
  )
}

function MultiStepGroup({
  steps,
  active,
  conversationId,
  siblingCalls,
  shortcutToggle,
}: {
  steps: FoldableStep[]
  active: boolean
  conversationId: number
  siblingCalls: ReadonlyArray<import('@helmx/protocol/browser').ToolViewSiblingCall>
  shortcutToggle?: ProcessShortcutCommand
}) {
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const { t } = useWebLocale()
  const prevActiveRef = useRef(active)
  if (prevActiveRef.current !== active) {
    prevActiveRef.current = active
    if (!active && userOverride !== null) {
      setUserOverride(null)
    }
  }
  const shortcutExpandSeqRef = useRef<number | null>(null)
  const prevShortcutSeqRef = useRef<number | undefined>(shortcutToggle?.seq)
  if (shortcutToggle !== undefined && shortcutToggle.seq !== prevShortcutSeqRef.current) {
    prevShortcutSeqRef.current = shortcutToggle.seq
    setUserOverride(shortcutToggle.open)
    shortcutExpandSeqRef.current = shortcutToggle.open ? shortcutToggle.seq : null
  }
  const open = userOverride ?? active
  const openedByCurrentShortcut =
    shortcutToggle !== undefined &&
    shortcutToggle.open &&
    shortcutExpandSeqRef.current === shortcutToggle.seq

  const summary = useMemo(() => summarizeStepGroup(steps), [steps])
  const hasOnlyThinking = steps.every((s) => s.kind === 'thinking')
  const summaryTitle = hasOnlyThinking
    ? active
      ? t('conv.thinking.stepsActive', { count: steps.length })
      : t('conv.thinking.steps', { count: steps.length })
    : active
      ? t('conv.thinking.execActive', { count: steps.length })
      : t('conv.thinking.exec', { count: steps.length })
  const showErrorBadge = !open && summary.errorCount > 0
  // Parallel tools contribute their own durations; the tooltip explains the cumulative total.
  const durationMs = (summary.modelDurationMs ?? 0) + (summary.toolDurationMs ?? 0)
  const showTime = !active && durationMs > 0
  const timeDetails = [
    summary.modelDurationMs !== undefined
      ? t('conv.thinking.modelTime', { duration: formatDurationMs(summary.modelDurationMs) })
      : undefined,
    summary.toolDurationMs !== undefined
      ? t('conv.thinking.toolsTime', { duration: formatDurationMs(summary.toolDurationMs) })
      : undefined,
    t('conv.thinking.totalTimeTitle'),
  ].filter(Boolean).join('\n')

  return (
    <div className="trace-group">
      <Tooltip content={timeDetails} disabled={!showTime} className="trace-group-time-tooltip">
        <button
          type="button"
          className={`trace-group-summary trace-group-summary-multi${showErrorBadge ? ' trace-group-summary-error' : ''}`}
          aria-expanded={open}
          data-process-toggle="root"
          onClick={() => {
            shortcutExpandSeqRef.current = null
            setUserOverride(!open)
          }}
          title={showTime ? undefined : open ? t('conv.thinking.collapseExec') : t('conv.thinking.expandExec')}
        >
          <span className="trace-group-leading" aria-hidden="true">
            <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
            {active ? <HelmxIcon name="loader" size={11} className="spin-slow" /> : null}
          </span>
          <span className="trace-group-title">{summaryTitle}</span>
          {showErrorBadge ? (
            <span className="trace-group-badge trace-group-badge-error">{t('conv.thinking.errorCount', { count: summary.errorCount })}</span>
          ) : null}
          {showTime ? (
            <span className="trace-group-meta tabular-nums">{formatDurationMs(durationMs)}</span>
          ) : null}
        </button>
      </Tooltip>
      {open ? (
        <div className="trace-group-steps">
          {steps.map((step, idx) =>
            step.kind === 'thinking' ? (
              <ThinkingRow
                key={`think:${idx}`}
                text={step.thinking.text}
                active={step.thinking.active}
                conversationId={conversationId}
                defaultOpen={openedByCurrentShortcut}
                shortcutToggle={shortcutToggle}
              />
            ) : (
              <TraceRow
                key={step.tool.key}
                tool={step.tool}
                conversationId={conversationId}
                defaultOpen={false}
                siblingCalls={siblingCalls}
              />
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}

export function ThinkingRow({
  text,
  conversationId,
  active = false,
  defaultOpen = false,
  shortcutToggle,
  isRootProcessToggle = false,
}: {
  text: string
  conversationId?: number
  active?: boolean
  defaultOpen?: boolean
  shortcutToggle?: ProcessShortcutCommand
  isRootProcessToggle?: boolean
}) {
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const { t } = useWebLocale()
  const prevActiveRef = useRef(active)
  if (prevActiveRef.current !== active) {
    prevActiveRef.current = active
    if (!active && userOverride !== null) {
      setUserOverride(null)
    }
  }
  const prevShortcutSeqRef = useRef<number | undefined>(shortcutToggle?.seq)
  if (shortcutToggle !== undefined && shortcutToggle.seq !== prevShortcutSeqRef.current) {
    prevShortcutSeqRef.current = shortcutToggle.seq
    setUserOverride(shortcutToggle.open)
  }
  const open = userOverride ?? (active || defaultOpen)

  return (
    <div className="trace-group">
      <button
        type="button"
        className="trace-group-summary"
        aria-expanded={open}
        {...(isRootProcessToggle ? { 'data-process-toggle': 'root' } : {})}
        onClick={() => setUserOverride(!open)}
        title={open ? t('conv.thinking.collapseThinking') : t('conv.thinking.expandThinking')}
      >
        <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        {active ? <HelmxIcon name="loader" size={11} className="spin-slow" /> : null}
        {active ? t('conv.thinking.activeLabel') : t('conv.thinking.label')}
      </button>
      {open ? (
        <div className="trace-expanded-body selectable thinking-expanded-body">
          {/* Active thinking blocks are live text still growing; static thinking never uses the streaming path */}
          <MarkdownView text={text} conversationId={conversationId} streaming={active} />
        </div>
      ) : null}
    </div>
  )
}
