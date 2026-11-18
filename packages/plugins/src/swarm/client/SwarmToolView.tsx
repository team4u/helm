/**
 * builtin:swarm tool-call timeline one-line renderer (26px `.trace-row`):
 * - natural-language summary per swarm tool (dispatch / handoff / review /
 *   delivered / blocked verbs), derived with wide-object guards from the call
 *   input plus the kernel-serialized JSON result text (zero fabricated facts);
 * - member-addressing rows open the sub-conversation drawer; group-level
 *   orchestration rows open the swarm workbench panel; rows without a
 *   resolvable target expand the raw tool details instead;
 * - honest status: running / done / error keep their real light states and the
 *   error text's first line is shown verbatim.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolViewProps } from '@helm/protocol'
import {
  HelmIcon,
  StatusLight,
  formatDurationMs,
  resolveLocalizedText,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  useToolActivity,
} from '@helm/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import {
  parseToolResultRecord,
  resolveSwarmToolClickTarget,
  resolveSwarmToolFacts,
  type SwarmToolClickTarget,
  type SwarmToolFacts,
} from './model-tool-view.ts'
import { ToolCallDetailsInline } from './ToolCallDetailsInline.tsx'
import { useElapsedNowMs } from './hooks.ts'
import { SWARM_WORKBENCH_PANEL_TARGET } from './models.ts'
import {
  POST_KIND_LABELS,
  TRACE_ABORT,
  TRACE_ARCHIVE,
  TRACE_BOARD_POST,
  TRACE_BOARD_READ,
  TRACE_BOARD_STATUS,
  TRACE_CLOSE_GROUP,
  TRACE_COLLAPSE_DETAILS,
  TRACE_CREATE_GROUP,
  TRACE_DISPATCH,
  TRACE_EXPAND_DETAILS,
  TRACE_INSPECT,
  TRACE_SWITCH_MODEL,
  TRACE_UNKNOWN_TOOL,
  TRACE_UPDATE_GROUP,
  postKindLabel,
  traceAbortedNoop,
  traceOpenMemberLabel,
  traceOpenWorkbenchLabel,
  tracePostCount,
  traceRetainedCount,
  traceStatusDone,
  traceStatusError,
  traceStatusRunning,
} from './copy.ts'
import type { HelmLocale } from '@helm/plugin-client'

const TOOL_TITLE_KEYS: Readonly<Record<string, typeof TRACE_DISPATCH>> = {
  swarm_create_group: TRACE_CREATE_GROUP,
  swarm_update_group: TRACE_UPDATE_GROUP,
  swarm_dispatch_worker: TRACE_DISPATCH,
  swarm_board_post: TRACE_BOARD_POST,
  swarm_board_read: TRACE_BOARD_READ,
  swarm_board_status: TRACE_BOARD_STATUS,
  swarm_abort_worker: TRACE_ABORT,
  swarm_switch_worker_model: TRACE_SWITCH_MODEL,
  swarm_inspect_worker: TRACE_INSPECT,
  swarm_archive_worker: TRACE_ARCHIVE,
  swarm_close_group: TRACE_CLOSE_GROUP,
}

function toolTitleKey(toolName: string, locale: HelmLocale): string {
  const key = TOOL_TITLE_KEYS[toolName] ?? TRACE_UNKNOWN_TOOL
  return resolveLocalizedText(key, locale)
}

function naturalPostTargets(targets: string[] | undefined): string | undefined {
  if (targets === undefined || targets.length === 0) return undefined
  return targets
    .map((t) => (t === 'all' ? 'all' : t === 'coordinator' ? 'coordinator' : t.startsWith('#') ? t : `@${t}`))
    .join(', ')
}

function buildTraceSummary(facts: SwarmToolFacts, locale: HelmLocale): string {
  const parts: string[] = []
  switch (facts.toolName) {
    case 'swarm_create_group':
    case 'swarm_update_group':
      parts.push(facts.groupTitle ?? '')
      break
    case 'swarm_dispatch_worker':
      if (facts.memberName !== undefined) parts.push(`@${facts.memberName}`)
      if (facts.taskExcerpt !== undefined) parts.push(facts.taskExcerpt)
      break
    case 'swarm_board_post': {
      if (facts.postKind !== undefined && facts.postKind in POST_KIND_LABELS) {
        parts.push(postKindLabel(facts.postKind, locale))
      }
      const targets = naturalPostTargets(facts.postTargets)
      if (targets !== undefined) parts.push(`-> ${targets}`)
      if (facts.taskExcerpt !== undefined) parts.push(facts.taskExcerpt)
      break
    }
    case 'swarm_board_read':
      if (facts.postCount !== undefined) parts.push(tracePostCount(facts.postCount, locale))
      break
    case 'swarm_abort_worker':
      if (facts.memberName !== undefined) parts.push(`@${facts.memberName}`)
      if (facts.aborted === false) parts.push(traceAbortedNoop(locale))
      break
    case 'swarm_switch_worker_model':
      if (facts.memberName !== undefined) parts.push(`@${facts.memberName}`)
      if (facts.model !== undefined) parts.push(facts.model)
      break
    case 'swarm_inspect_worker':
    case 'swarm_archive_worker':
      if (facts.memberName !== undefined) parts.push(`@${facts.memberName}`)
      break
    case 'swarm_close_group':
      if (facts.retainedCount !== undefined && facts.retainedCount > 0) {
        parts.push(traceRetainedCount(facts.retainedCount, locale))
      }
      break
    default:
      break
  }
  return parts.filter((p) => p !== '').join(' · ')
}

export function SwarmToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()

  const resultRecord = useMemo(() => parseToolResultRecord(props.result), [props.result])
  const facts = useMemo(
    () => resolveSwarmToolFacts(props.toolName, props.input, resultRecord),
    [props.toolName, props.input, resultRecord],
  )

  const memberLookup = useMemo(() => {
    const byName = new Map<string, number>()
    if (Array.isArray(index?.workers)) {
      for (const w of index.workers) {
        if (typeof w?.name === 'string' && w.name !== '' && typeof w.conversationId === 'number') {
          if (!byName.has(w.name)) byName.set(w.name, w.conversationId)
        }
      }
    }
    return (name: string): number | undefined => byName.get(name)
  }, [index])

  const clickTarget = useMemo(
    () => resolveSwarmToolClickTarget(facts, { memberLookup }),
    [facts, memberLookup],
  )

  const isRunning = props.status === 'running'
  const isError = props.status === 'error'
  useToolActivity(props.callId, isRunning)

  const nowMs = useElapsedNowMs(isRunning)
  const elapsedMs = isRunning
    ? props.startedAt !== undefined && nowMs !== undefined
      ? Math.max(0, nowMs - props.startedAt)
      : undefined
    : props.durationMs

  const lightStatus = isRunning ? 'running' : isError ? 'error' : 'done'
  const lightLabel = isRunning
    ? traceStatusRunning(locale)
    : isError
      ? traceStatusError(locale)
      : traceStatusDone(locale)

  const errorFirstLine =
    isError && typeof props.result === 'string' && props.result.trim() !== ''
      ? (props.result.split(/\r?\n/, 1)[0] ?? '').trim()
      : undefined

  const title = toolTitleKey(props.toolName, locale)
  const summary = buildTraceSummary(facts, locale)
  // 错误态优先如实展示错误首行（即使没有常规摘要也必须可见）。
  const displaySummary =
    isError && errorFirstLine !== undefined && errorFirstLine !== '' ? errorFirstLine : summary
  const seqBadge = facts.seq !== undefined ? `#${facts.seq}` : undefined

  const handleActivate = (): void => {
    if (clickTarget?.kind === 'member') {
      ctx.openConversationDrawer(clickTarget.conversationId)
      return
    }
    if (clickTarget?.kind === 'group') {
      ctx.openWorkbench(SWARM_WORKBENCH_PANEL_TARGET)
      return
    }
    setDetailsOpen((prev) => !prev)
  }

  const labelTarget =
    clickTarget?.kind === 'member' && facts.memberName !== undefined
      ? traceOpenMemberLabel(facts.memberName, locale)
      : clickTarget?.kind === 'group'
        ? traceOpenWorkbenchLabel(locale)
        : resolveLocalizedText(detailsOpen ? TRACE_COLLAPSE_DETAILS : TRACE_EXPAND_DETAILS, locale)

  const ariaTitle = [title, summary, seqBadge].filter(Boolean).join(' ')

  return (
    <div className="trace-entry">
      <button
        type="button"
        className={`sw-trace-row-btn${isError ? ' trace-row-error' : ''}`}
        aria-label={`${ariaTitle} — ${labelTarget}`}
        aria-expanded={clickTarget === undefined ? detailsOpen : undefined}
        aria-controls={clickTarget === undefined ? detailsId : undefined}
        onClick={handleActivate}
      >
        <span className="trace-row-left">
          <HelmIcon name={facts.toolName === 'swarm_dispatch_worker' ? 'bot' : 'network'} size={12} />
          <span className="trace-tool-name sw-trace-name" title={title}>{title}</span>
          {displaySummary !== '' ? (
            <span
              className={`trace-tool-summary${isError ? ' sw-trace-error' : ''}`}
              title={displaySummary}
            >
              {displaySummary}
            </span>
          ) : null}
        </span>
        <span className="trace-row-right sw-trace-right">
          {seqBadge !== undefined ? (
            <span className="badge badge-neutral sw-trace-badge tabular-nums">{seqBadge}</span>
          ) : null}
          <StatusLight status={lightStatus} label={lightLabel} />
          {elapsedMs !== undefined ? (
            <span className="trace-duration tabular-nums">{formatDurationMs(elapsedMs)}</span>
          ) : null}
          <HelmIcon
            name={
              clickTarget?.kind === 'member'
                ? 'external-link'
                : clickTarget?.kind === 'group'
                  ? 'chevron-right'
                  : detailsOpen
                    ? 'chevron-down'
                    : 'chevron-right'
            }
            size={11}
          />
        </span>
      </button>
      {clickTarget === undefined ? (
        <div id={detailsId} hidden={!detailsOpen}>
          {detailsOpen ? (
            <ToolCallDetailsInline input={props.input} result={props.result} artifactRef={props.artifactRef} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
