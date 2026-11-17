/**
 * Header toolbar bidirectional board entry button & compact 1-line timeline
 * receipt pills for 'swarm:board-report' and 'swarm:board-wakeup'.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ConversationSummary, TimelineRendererProps } from '@helm/protocol'
import {
  HelmIcon,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helm/plugin-client'
import type { SwarmIndexDoc } from './models.ts'
import {
  buildBoardScreenTarget,
  isNarrowViewport,
  parseBoardBadges,
  parseBoardReportMeta,
  parseBoardWakeupMeta,
  resolveConversationBoardLink,
  type BoardBadgesDoc,
} from './board-model.ts'
import {
  SW_BOARD_OPEN_IN_SPLIT,
  SW_BOARD_REPORT_PILL,
  SW_BOARD_WAKEUP_PILL,
  SW_OPEN_BOARD_BUTTON,
  swOpenBoardTitle,
  swReceiptCountLabel,
} from './copy.ts'

export interface SwarmOpenBoardActionProps {
  conversation?: ConversationSummary
}

export function SwarmOpenBoardAction(props: SwarmOpenBoardActionProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const rawBadges = usePluginDoc<BoardBadgesDoc>('board-badges')
  const badges = useMemo(() => parseBoardBadges(rawBadges), [rawBadges])

  const conversationId = props.conversation?.id ?? ctx.conversationId
  const link = useMemo(
    () => resolveConversationBoardLink(conversationId, badges, index),
    [conversationId, badges, index],
  )

  const handleOpen = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const target = buildBoardScreenTarget({
      groupId: link?.groupId,
      worker: link?.workerName,
    })
    const width = typeof window !== 'undefined' ? window.innerWidth : undefined
    if (isNarrowViewport(width)) {
      ctx.openScreen(target)
    } else {
      ctx.openSplitScreen(target)
    }
  }

  const badgeToneClass =
    link?.tone === 'warn'
      ? 'badge-warn'
      : link?.tone === 'accent'
        ? 'badge-accent'
        : 'badge-neutral'
  const title = swOpenBoardTitle(link?.footerText, locale)

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm sw-header-board-btn"
      title={title}
      aria-label={title}
      onClick={handleOpen}
    >
      <HelmIcon name={link?.tone === 'warn' ? 'alert-triangle' : 'workflow'} size={12} />
      <span className="pane-action-label">{t(SW_OPEN_BOARD_BUTTON)}</span>
      {link !== undefined ? (
        <span className={`badge ${badgeToneClass} tabular-nums`}>{link.count}</span>
      ) : null}
    </button>
  )
}

export function SwarmBoardReportPill(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const meta = parseBoardReportMeta(props)

  const focusSeq = meta.toSeq ?? meta.fromSeq
  const seqLabel =
    meta.fromSeq !== undefined && meta.toSeq !== undefined && meta.fromSeq !== meta.toSeq
      ? `#${meta.fromSeq}..#${meta.toSeq}`
      : focusSeq !== undefined
        ? `#${focusSeq}`
        : undefined

  const openAtSeq = (): void => {
    const target = buildBoardScreenTarget({
      groupId: meta.groupId,
      seq: focusSeq,
    })
    const width = typeof window !== 'undefined' ? window.innerWidth : undefined
    if (isNarrowViewport(width)) {
      ctx.openScreen(target)
    } else {
      ctx.openSplitScreen(target)
    }
  }

  return (
    <div className="sw-receipt-pill">
      <span className="badge badge-accent">
        <HelmIcon name="workflow" size={11} />
        <span>{t(SW_BOARD_REPORT_PILL)}</span>
      </span>
      {seqLabel !== undefined ? (
        <button
          type="button"
          className="btn btn-xs btn-ghost mono sw-seq-jump-btn"
          title={t(SW_BOARD_OPEN_IN_SPLIT)}
          onClick={openAtSeq}
        >
          {seqLabel}
        </button>
      ) : null}
      {meta.postCount !== undefined ? (
        <span className="sw-receipt-count tabular-nums">{swReceiptCountLabel(meta.postCount, locale)}</span>
      ) : null}
      {meta.headline !== undefined && meta.headline !== '' ? (
        <span className="sw-receipt-headline" title={meta.headline}>
          {meta.headline}
        </span>
      ) : null}
    </div>
  )
}

export function SwarmBoardWakeupPill(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const meta = parseBoardWakeupMeta(props)

  const focusSeq = meta.toSeq ?? meta.fromSeq
  const seqLabel =
    meta.fromSeq !== undefined && meta.toSeq !== undefined && meta.fromSeq !== meta.toSeq
      ? `#${meta.fromSeq}..#${meta.toSeq}`
      : focusSeq !== undefined
        ? `#${focusSeq}`
        : undefined

  const openAtSeq = (): void => {
    const target = buildBoardScreenTarget({
      groupId: meta.groupId,
      worker: meta.workerName,
      seq: focusSeq,
    })
    const width = typeof window !== 'undefined' ? window.innerWidth : undefined
    if (isNarrowViewport(width)) {
      ctx.openScreen(target)
    } else {
      ctx.openSplitScreen(target)
    }
  }

  return (
    <div className="sw-receipt-pill">
      <span className="badge badge-neutral">
        <HelmIcon name="bell" size={11} />
        <span>{t(SW_BOARD_WAKEUP_PILL)}</span>
      </span>
      {meta.workerName !== undefined && meta.workerName !== '' ? (
        <span className="badge badge-neutral mono">@{meta.workerName}</span>
      ) : null}
      {seqLabel !== undefined ? (
        <button
          type="button"
          className="btn btn-xs btn-ghost mono sw-seq-jump-btn"
          title={t(SW_BOARD_OPEN_IN_SPLIT)}
          onClick={openAtSeq}
        >
          {seqLabel}
        </button>
      ) : null}
      {meta.postCount !== undefined ? (
        <span className="sw-receipt-count tabular-nums">{swReceiptCountLabel(meta.postCount, locale)}</span>
      ) : null}
    </div>
  )
}
