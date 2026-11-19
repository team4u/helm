/**
 * Compact 1-line timeline receipt pills for the durable `swarm:board-report`
 * and `swarm:board-wakeup` inputs (still written by the backend group store —
 * these rows are real conversation facts, not synthetic UI entries). The whole
 * pill is the click target and opens the swarm workbench panel of the current
 * conversation (same full-row-button mental model as the member rows and the
 * 26px tool traces — no trailing chevron affordance); the raw #seq stays as
 * auxiliary info.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import type { ReactNode } from 'react'
import type { TimelineRendererProps } from '@helmx/protocol'
import { HelmxIcon, resolveLocalizedText, usePluginContext, usePluginLocale } from '@helmx/plugin-client'
import { parseBoardReportMeta, parseBoardWakeupMeta } from './board-model.ts'
import { SWARM_WORKBENCH_PANEL_TARGET } from './models.ts'
import {
  SW_BOARD_REPORT_PILL,
  SW_BOARD_WAKEUP_PILL,
  SW_PILL_OPEN_WORKBENCH,
  swReceiptCountLabel,
} from './copy.ts'

function seqRangeLabel(fromSeq: number | undefined, toSeq: number | undefined): string | undefined {
  if (fromSeq !== undefined && toSeq !== undefined && fromSeq !== toSeq) return `#${fromSeq}..#${toSeq}`
  const focus = toSeq ?? fromSeq
  return focus !== undefined ? `#${focus}` : undefined
}

export function SwarmBoardReportPill(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const meta = parseBoardReportMeta(props)
  const seqLabel = seqRangeLabel(meta.fromSeq, meta.toSeq)
  return (
    <button
      type="button"
      className="sw-receipt-pill"
      aria-label={resolveLocalizedText(SW_PILL_OPEN_WORKBENCH, locale)}
      onClick={() => ctx.openWorkbench(SWARM_WORKBENCH_PANEL_TARGET)}
    >
      <span className="badge badge-accent">
        <HelmxIcon name="network" size={11} />
        <span>{resolveLocalizedText(SW_BOARD_REPORT_PILL, locale)}</span>
      </span>
      {seqLabel !== undefined ? (
        <span className="sw-receipt-seq mono tabular-nums">{seqLabel}</span>
      ) : null}
      {meta.postCount !== undefined ? (
        <span className="sw-receipt-count tabular-nums">{swReceiptCountLabel(meta.postCount, locale)}</span>
      ) : null}
      {meta.headline !== undefined && meta.headline !== '' ? (
        <span className="sw-receipt-headline" title={meta.headline}>{meta.headline}</span>
      ) : null}
    </button>
  )
}

export function SwarmBoardWakeupPill(props: TimelineRendererProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const meta = parseBoardWakeupMeta(props)
  const seqLabel = seqRangeLabel(meta.fromSeq, meta.toSeq)
  return (
    <button
      type="button"
      className="sw-receipt-pill"
      aria-label={resolveLocalizedText(SW_PILL_OPEN_WORKBENCH, locale)}
      onClick={() => ctx.openWorkbench(SWARM_WORKBENCH_PANEL_TARGET)}
    >
      <span className="badge badge-neutral">
        <HelmxIcon name="bell" size={11} />
        <span>{resolveLocalizedText(SW_BOARD_WAKEUP_PILL, locale)}</span>
      </span>
      {meta.workerName !== undefined && meta.workerName !== '' ? (
        <span className="badge badge-neutral mono">@{meta.workerName}</span>
      ) : null}
      {seqLabel !== undefined ? (
        <span className="sw-receipt-seq mono tabular-nums">{seqLabel}</span>
      ) : null}
      {meta.postCount !== undefined ? (
        <span className="sw-receipt-count tabular-nums">{swReceiptCountLabel(meta.postCount, locale)}</span>
      ) : null}
    </button>
  )
}
