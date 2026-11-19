/**
 * Host built-in tool expanded bodies (the content under a Quiet Surface 26px trace row).
 *
 * Contract:
 * - Used only when no plugin tool.view took over (TraceRow decides before rendering; this
 *   component does not re-check);
 * - A small toolName => component dispatch table (edit/write/read/bash); everything else
 *   takes the generic key-value shape; no extensible framework, no new tool.view registry;
 * - The edit completed state must pass EDIT_TOOL_RESULT_SCHEMA validation before showing
 *   the kernel's real diff (only success promises "applied"); the running state shows
 *   pending hunks only (no file line numbers), the failure state shows "requested change
 *   hunks (execution failed)" — a mid-write failure or a result-pipeline failure must not
 *   assert the file is unchanged; missing or invalid metadata gets an explicit diagnostic
 *   with the raw-data entry preserved — never fabricate an applied diff;
 * - Every "expand all" only expands locally complete text; with server truncation
 *   (resultTruncation, carried on the toolResult message as truncated/totalChars/totalLines)
 *   the expand button becomes the single "expand full text" fetch entry: fetch the original
 *   via GET /api/conversations/:id/entries/:entryId and backfill in place, surfacing
 *   failures explicitly; the copy entry stays disabled until fetched — a preview is never
 *   passed off as full text;
 * - The component file exports only components and types; pure transforms live in *-model.ts.
 */
import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolEditDiff } from '@helmx/protocol/browser'
import { HelmxIcon, CopyButton } from '@helmx/plugin-client'
import { useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatBytes } from '../lib/format.js'
import { SyntaxCode } from './SyntaxCode.js'
import type { ToolTrace } from './timeline-model.js'
import { useToolResultFullText, type ToolResultFullTextState } from './use-tool-result-full-text.js'
import {
  buildPendingEditDiff,
  checkEditToolResult,
  decorateAppliedDiffRows,
  type AppliedDiffRowView,
  type PendingDiffRow,
  type PendingEditDiff,
  type WordSegment,
} from './edit-diff-model.js'
import {
  bashBodyData,
  headLines,
  inputKvEntries,
  inputPathOf,
  prettyJson,
  readBodyData,
  tailLines,
  truncationPreviewNote,
  writeBodyData,
} from './tool-body-model.js'

export interface ToolBodyProps {
  tool: ToolTrace
  conversationId: number
  /** Full-text fetch state for the result text (drives the fetch button, error display, and the copy gate under server truncation). */
  resultFetch: ToolResultFullTextState
}

// ---------------------------------------------------------------------------
// Diff row rendering (applied: real line numbers; pending hunks: no numbers)
// ---------------------------------------------------------------------------

function DiffRowView({ row, numbered }: { row: AppliedDiffRowView | PendingDiffRow; numbered: boolean }): ReactNode {
  const sign = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '
  const rowClass =
    row.kind === 'add' ? 'trace-diff-row-add' : row.kind === 'remove' ? 'trace-diff-row-remove' : 'trace-diff-row-context'
  const oldNum = numbered && row.kind !== 'add' && 'oldLine' in row ? String(row.oldLine) : ''
  const newNum = numbered && row.kind !== 'remove' && 'newLine' in row ? String(row.newLine) : ''
  const wordClass = row.kind === 'add' ? 'trace-diff-word-add' : 'trace-diff-word-remove'
  return (
    <div className={`trace-diff-row ${rowClass}`}>
      {numbered ? (
        <>
          <span className="trace-diff-num">{oldNum}</span>
          <span className="trace-diff-num">{newNum}</span>
        </>
      ) : null}
      <span className="trace-diff-content">
        <span className="trace-diff-sign">{sign}</span>
        {row.word !== undefined
          ? row.word.map((segment: WordSegment, index: number) =>
              segment.changed ? (
                <span key={index} className={wordClass}>{segment.text}</span>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )
          : row.text === ''
            ? ' '
            : row.text}
      </span>
    </div>
  )
}

/** Local fold threshold for long diffs (data already client-side; expanding restores fully). */
const DIFF_FOLD_ROWS = 32

function DiffFoldButton({ hidden, expanded, onToggle }: { hidden: number; expanded: boolean; onToggle: () => void }): ReactNode {
  const { t } = useWebLocale()
  return (
    <button type="button" className="trace-inline-btn trace-diff-more" onClick={onToggle}>
      <HelmxIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
      {expanded ? t('common.collapse') : t('conv.diff.expandRemaining', { count: hidden })}
    </button>
  )
}

function PendingDiffView({ pending }: { pending: PendingEditDiff | undefined }): ReactNode {
  const { t } = useWebLocale()
  const [expanded, setExpanded] = useState(false)
  if (pending === undefined) {
    return <span className="trace-tool-note">{t('conv.diff.missingArgs')}</span>
  }
  if (pending.kind === 'skipped') {
    return (
      <span className="trace-tool-note">{t('conv.diff.skipped', { reason: pending.reason })}</span>
    )
  }
  const visible = expanded ? pending.rows : pending.rows.slice(0, DIFF_FOLD_ROWS)
  const hidden = pending.rows.length - visible.length
  return (
    <div className="trace-diff trace-diff-pending">
      {visible.map((row: PendingDiffRow, index: number) => (
        <DiffRowView key={index} row={row} numbered={false} />
      ))}
      {pending.rows.length > DIFF_FOLD_ROWS ? <DiffFoldButton hidden={hidden} expanded={expanded} onToggle={() => setExpanded((v) => !v)} /> : null}
      {pending.truncated ? (
        <div className="trace-diff-note">
          {t('conv.diff.tooLong', { count: pending.rows.length, added: pending.addedLines, removed: pending.removedLines })}
          {t('conv.diff.statsCoverAll')}
        </div>
      ) : null}
    </div>
  )
}

function AppliedDiffView({ diff }: { diff: ToolEditDiff }): ReactNode {
  const { t } = useWebLocale()
  const [expanded, setExpanded] = useState(false)
  const rows = useMemo(() => decorateAppliedDiffRows(diff.rows), [diff])
  const visible = expanded ? rows : rows.slice(0, DIFF_FOLD_ROWS)
  const hidden = rows.length - visible.length
  return (
    <div className="trace-diff">
      {visible.map((row: AppliedDiffRowView, index: number) => (
        <Fragment key={index}>
          {row.kind === 'context' && visible[index - 1]?.kind === 'context' &&
            row.oldLine > (visible[index - 1] as Extract<AppliedDiffRowView, { kind: 'context' }>).oldLine + 1
            ? <div className="trace-diff-note">{t('conv.diff.unchangedOmitted')}</div>
            : null}
          <DiffRowView row={row} numbered />
        </Fragment>
      ))}
      {rows.length > DIFF_FOLD_ROWS ? <DiffFoldButton hidden={hidden} expanded={expanded} onToggle={() => setExpanded((v) => !v)} /> : null}
      {diff.truncated ? (
        <div className="trace-diff-note">
          {t('conv.diff.someOmitted', { added: diff.addedLines, removed: diff.removedLines })}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Server truncation: full-text fetch footer and copy gate (a preview is never copied as full text)
// ---------------------------------------------------------------------------

/** Truncation fetch footer: preview/loading/complete rendered honestly; failed shows the error with a retry. */
function TruncatedOutputFooter({
  tool,
  resultFetch,
  hiddenNote,
}: {
  tool: ToolTrace
  resultFetch: ToolResultFullTextState
  /** Local folding fact prepended to the truncation note (e.g. "N lines collapsed above"; describes the preview only). */
  hiddenNote?: string
}): ReactNode {
  const { t } = useWebLocale()
  const truncation = tool.resultTruncation
  if (truncation === undefined) return null
  if (resultFetch.phase === 'failed') {
    return (
      <div className="callout callout--error" role="alert">
        <HelmxIcon name="alert-triangle" size={12} />
        <span className="callout-text">
          {t('conv.trunc.fetchFailed', { error: resultFetch.error ?? t('conv.trunc.unknownError') })}
        </span>
        <button type="button" className="trace-inline-btn" onClick={resultFetch.load}>
          <HelmxIcon name="rotate-ccw" size={11} />
          {t('conv.trunc.retryFetch')}
        </button>
      </div>
    )
  }
  if (resultFetch.phase === 'complete') {
    // The marker survived the backfill: a server contract anomaly — state it honestly, never claim more content was obtained.
    return <div className="trace-tool-note">{t('conv.trunc.stillTruncated')}</div>
  }
  const total = truncation.totalLines !== undefined ? t('conv.trunc.linesTotalParens', { count: truncation.totalLines }) : ''
  const note = truncationPreviewNote(truncation, t)
  return (
    <div className="trace-out-foot">
      <span className="trace-tool-note">
        {hiddenNote !== undefined ? `${hiddenNote} · ${note}` : note}
        {tool.artifactRef !== undefined ? t('conv.trunc.spillNote') : ''}
      </span>
      <button
        type="button"
        className="trace-inline-btn"
        disabled={resultFetch.phase === 'loading'}
        onClick={resultFetch.load}
      >
        <HelmxIcon
          name={resultFetch.phase === 'loading' ? 'loader' : 'download'}
          size={11}
          className={resultFetch.phase === 'loading' ? 'spin-slow' : undefined}
        />
        {resultFetch.phase === 'loading' ? t('conv.trunc.fetchingFullText') : t('conv.trunc.expandFullText', { total })}
      </button>
    </div>
  )
}

/** Result-text copy gate: copying stays disabled under server truncation until the original is fetched — never silently copy a preview as full text. */
function ResultCopyGate({
  text,
  label,
  tool,
  resultFetch,
}: {
  text: string
  label: string
  tool: ToolTrace
  resultFetch: ToolResultFullTextState
}): ReactNode {
  const { t } = useWebLocale()
  const isArtifactPreview = tool.artifactRef !== undefined
  if (tool.resultTruncation === undefined && !isArtifactPreview) return <CopyButton text={text} label={label} />
  const title = isArtifactPreview
    ? t('conv.copy.spillPreviewTitle')
    : resultFetch.phase === 'loading'
      ? t('conv.copy.fetchingTitle')
      : t('conv.copy.truncatedTitle')
  return (
    <button type="button" className="btn btn-ghost btn-sm" disabled title={title} aria-label={t('conv.copy.disabledAria', { label })}>
      <HelmxIcon name="copy" size={12} />
      <span>{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Raw data (input JSON + raw output + structured result; verification/copy fallback, never drops arguments)
// ---------------------------------------------------------------------------

function RawToolData({ tool, resultFetch, defaultOpen = false }: { tool: ToolTrace; resultFetch: ToolResultFullTextState; defaultOpen?: boolean }): ReactNode {
  const { t } = useWebLocale()
  const [open, setOpen] = useState(defaultOpen)
  const inputJson = useMemo(() => (tool.input !== undefined ? prettyJson(tool.input) : undefined), [tool.input])
  const structuredJson = useMemo(
    () => (tool.structuredOutput !== undefined ? prettyJson(tool.structuredOutput) : undefined),
    [tool.structuredOutput],
  )
  if (inputJson === undefined && tool.resultText === undefined && structuredJson === undefined) return null
  return (
    <div className="trace-raw">
      <button type="button" className="trace-inline-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        {t('conv.raw.toggle')}
      </button>
      {open ? (
        <div className="trace-raw-body">
          {inputJson !== undefined ? (
            <div>
              <div className="trace-code-head"><span className="trace-section-label">{t('conv.raw.inputJson')}</span><CopyButton text={inputJson} label={t('conv.raw.copyInputJson')} /></div>
              <pre className="code-block-pre">{inputJson}</pre>
            </div>
          ) : null}
          {tool.resultText !== undefined ? (
            <div>
              <div className="trace-code-head">
                <span className="trace-section-label">{t('conv.raw.output')}</span>
                <ResultCopyGate text={tool.resultText} label={t('conv.raw.copyOutput')} tool={tool} resultFetch={resultFetch} />
              </div>
              <pre className="code-block-pre">{tool.resultText}</pre>
              {tool.resultTruncation !== undefined ? <TruncatedOutputFooter tool={tool} resultFetch={resultFetch} /> : null}
            </div>
          ) : null}
          {structuredJson !== undefined ? (
            <div>
              <div className="trace-code-head"><span className="trace-section-label">{t('conv.raw.structuredJson')}</span><CopyButton text={structuredJson} label={t('conv.raw.copyStructured')} /></div>
              <pre className="code-block-pre">{structuredJson}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

function EditToolBody({ tool, resultFetch }: ToolBodyProps): ReactNode {
  const { t } = useWebLocale()
  const inputPath = inputPathOf(tool.input)
  const pending = useMemo(
    () => tool.status === 'running' || tool.status === 'error' || tool.isError ? buildPendingEditDiff(tool.input) : undefined,
    [tool.input, tool.status, tool.isError],
  )
  const resultCheck = useMemo(
    () => (tool.status === 'done' && !tool.isError ? checkEditToolResult(tool.structuredOutput) : undefined),
    [tool.status, tool.isError, tool.structuredOutput],
  )

  if (tool.status === 'running') {
    return (
      <>
        <div className="trace-section-label">{t('conv.edit.pendingHunks', { path: inputPath !== undefined ? ` · ${inputPath}` : '' })}</div>
        <PendingDiffView pending={pending} />
        <RawToolData tool={tool} resultFetch={resultFetch} />
      </>
    )
  }
  if (tool.status === 'error' || tool.isError) {
    return (
      <>
        <div className="trace-section-label">{t('conv.edit.errorLabel', { path: inputPath !== undefined ? ` · ${inputPath}` : '' })}</div>
        <pre className="code-block-pre trace-error-pre">
          {tool.resultText !== undefined && tool.resultText !== '' ? tool.resultText : t('conv.edit.noErrorDetails')}
        </pre>
        {tool.resultTruncation !== undefined ? <TruncatedOutputFooter tool={tool} resultFetch={resultFetch} /> : null}
        <div className="trace-section-label">{t('conv.edit.requestedHunksFailed')}</div>
        <PendingDiffView pending={pending} />
        <RawToolData tool={tool} resultFetch={resultFetch} />
      </>
    )
  }
  if (tool.status === 'done') {
    if (resultCheck !== undefined && resultCheck.ok) {
      return (
        <>
          <div className="trace-section-label">
            {t('conv.edit.appliedDiff', { path: resultCheck.value.path, added: resultCheck.value.diff.addedLines, removed: resultCheck.value.diff.removedLines })}
          </div>
          <AppliedDiffView diff={resultCheck.value.diff} />
          <RawToolData tool={tool} resultFetch={resultFetch} />
        </>
      )
    }
    return (
      <>
        <div className="trace-section-label">{t('conv.edit.succeededNoDiff')}</div>
        <div className="callout callout--error" role="alert">
          <HelmxIcon name="alert-triangle" size={12} />
          <span className="callout-text">
            {t('conv.edit.invalidMeta', { reason: resultCheck === undefined ? t('conv.edit.missingStructured') : resultCheck.reason })}
          </span>
        </div>
        <RawToolData tool={tool} resultFetch={resultFetch} defaultOpen />
      </>
    )
  }
  // unknown: clearly distinct from running/done/error — never invent an execution state
  return (
    <>
      <div className="trace-section-label">{t('conv.edit.resultUnknown', { path: inputPath !== undefined ? ` · ${inputPath}` : '' })}</div>
      <span className="trace-tool-note">{t('conv.edit.noResult')}</span>
      <RawToolData tool={tool} resultFetch={resultFetch} defaultOpen />
    </>
  )
}

// ---------------------------------------------------------------------------
// write / read / bash
// ---------------------------------------------------------------------------

const WRITE_PREVIEW_LINES = 12

function WriteToolBody({ tool, resultFetch }: ToolBodyProps): ReactNode {
  const { t } = useWebLocale()
  const data = useMemo(() => writeBodyData(tool), [tool])
  const [expanded, setExpanded] = useState(false)
  const failed = tool.status === 'error' || tool.isError
  const label =
    tool.status === 'running'
      ? t('conv.write.pending')
      : failed
        ? t('conv.write.contentFailed')
        : tool.status === 'done'
          ? t('conv.write.content')
          : t('conv.write.contentUnknown')
  const slice = data.content !== undefined ? headLines(data.content, WRITE_PREVIEW_LINES) : undefined
  const foldable = slice !== undefined && slice.hiddenLines > 0
  return (
    <>
      <div className="trace-section-label">
        {label}
        {data.path !== undefined ? ` · ${data.path}` : ''}
        {data.bytesWritten !== undefined ? t('conv.write.wroteBytes', { bytes: formatBytes(data.bytesWritten) }) : ''}
      </div>
      {failed ? (
        <>
          <pre className="code-block-pre trace-error-pre">
            {tool.resultText !== undefined && tool.resultText !== '' ? tool.resultText : t('conv.edit.noErrorDetails')}
          </pre>
          {tool.resultTruncation !== undefined ? <TruncatedOutputFooter tool={tool} resultFetch={resultFetch} /> : null}
        </>
      ) : null}
      {data.content === undefined ? (
        <span className="trace-tool-note">{t('conv.write.missingContent')}</span>
      ) : (
        <div className="trace-code-sec">
          <div className="trace-code-head">
            <span className="trace-tool-note">
              {expanded || !foldable
                ? t('conv.tool.linesTotal', { count: data.lineCount! })
                : t('conv.tool.firstOfLines', { shown: slice!.totalLines - slice!.hiddenLines, total: slice!.totalLines })}
            </span>
            <CopyButton text={data.content} label={t('conv.write.copySource')} />
          </div>
          <SyntaxCode code={expanded ? data.content : slice!.visible} language={data.language} />
          {foldable ? (
            <button type="button" className="trace-inline-btn" onClick={() => setExpanded((v) => !v)}>
              <HelmxIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {expanded ? t('common.collapse') : t('conv.tool.expandAll', { count: data.lineCount! })}
            </button>
          ) : null}
        </div>
      )}
      <RawToolData tool={tool} resultFetch={resultFetch} defaultOpen={failed} />
    </>
  )
}

const READ_PREVIEW_LINES = 12

function ReadToolBody({ tool, resultFetch }: ToolBodyProps): ReactNode {
  const { t } = useWebLocale()
  const data = useMemo(() => readBodyData(tool), [tool])
  const [expanded, setExpanded] = useState(false)
  const failed = tool.status === 'error' || tool.isError
  // Server truncation constrains only the raw output text channel; structuredOutput.content (details channel) transfers in full and is unaffected.
  const truncated = data.fromResultText && tool.resultTruncation !== undefined
  if (failed) {
    return (
      <>
        <div className="trace-section-label">{t('conv.read.failed')}</div>
        <pre className="code-block-pre trace-error-pre">
          {tool.resultText !== undefined && tool.resultText !== '' ? tool.resultText : t('conv.edit.noErrorDetails')}
        </pre>
        {tool.resultTruncation !== undefined ? <TruncatedOutputFooter tool={tool} resultFetch={resultFetch} /> : null}
        <RawToolData tool={tool} resultFetch={resultFetch} defaultOpen />
      </>
    )
  }
  if (data.content === undefined) {
    return (
      <>
        <div className="trace-section-label">{tool.status === 'running' ? t('conv.read.reading') : t('conv.read.result')}</div>
        <span className="trace-tool-note">{tool.status === 'running' ? t('conv.read.nothingYet') : t('conv.read.noOutput')}</span>
        <RawToolData tool={tool} resultFetch={resultFetch} defaultOpen={tool.status !== 'running'} />
      </>
    )
  }
  const slice = headLines(data.content, READ_PREVIEW_LINES)
  const foldable = slice.hiddenLines > 0
  const shown = expanded ? data.content : slice.visible
  return (
    <>
      {data.isSpill ? (
        <>
          <div className="trace-section-label">{t('conv.read.withArtifacts')}</div>
          <pre className="code-block-pre">{shown}</pre>
          {truncated ? (
            <TruncatedOutputFooter
              tool={tool}
              resultFetch={resultFetch}
              hiddenNote={foldable && !expanded ? t('conv.tool.collapsedBelow', { count: slice.hiddenLines }) : undefined}
            />
          ) : foldable ? (
            <button type="button" className="trace-inline-btn" onClick={() => setExpanded((v) => !v)}>
              <HelmxIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {expanded ? t('common.collapse') : t('conv.tool.expandAll', { count: slice.totalLines })}
            </button>
          ) : null}
          <span className="trace-tool-note">{t('conv.read.headPreviewNote')}</span>
        </>
      ) : (
        <div className="trace-code-sec">
          <div className="trace-section-label">{t('conv.read.result')}</div>
          <div className="trace-code-head">
            <span className="trace-tool-note">
              {expanded || !foldable
                ? truncated
                  ? t('conv.tool.linesPreviewed', { count: slice.totalLines })
                  : t('conv.tool.linesTotal', { count: slice.totalLines })
                : truncated
                  ? t('conv.tool.firstOfPreview', { shown: slice.totalLines - slice.hiddenLines, total: slice.totalLines })
                  : t('conv.tool.firstOfLines', { shown: slice.totalLines - slice.hiddenLines, total: slice.totalLines })}
            </span>
            {truncated ? (
              <ResultCopyGate text={data.content} label={t('conv.read.copyContent')} tool={tool} resultFetch={resultFetch} />
            ) : (
              <CopyButton text={data.content} label={t('conv.read.copyContent')} />
            )}
          </div>
          <SyntaxCode code={shown} language={data.language} />
          {truncated ? (
            <TruncatedOutputFooter
              tool={tool}
              resultFetch={resultFetch}
              hiddenNote={foldable && !expanded ? t('conv.tool.collapsedBelow', { count: slice.hiddenLines }) : undefined}
            />
          ) : foldable ? (
            <button type="button" className="trace-inline-btn" onClick={() => setExpanded((v) => !v)}>
              <HelmxIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {expanded ? t('common.collapse') : t('conv.tool.expandAll', { count: slice.totalLines })}
            </button>
          ) : null}
        </div>
      )}
      <RawToolData tool={tool} resultFetch={resultFetch} />
    </>
  )
}

const BASH_TAIL_LINES = 8

function BashToolBody({ tool, resultFetch }: ToolBodyProps): ReactNode {
  const { t } = useWebLocale()
  const data = useMemo(() => bashBodyData(tool), [tool])
  const [expanded, setExpanded] = useState(false)
  const hasOutput = data.output !== undefined && data.output !== ''
  const slice = hasOutput ? tailLines(data.output!, BASH_TAIL_LINES) : undefined
  return (
    <>
      {data.command !== undefined ? (
        <>
          <div className="trace-section-label">{t('conv.bash.command')}</div>
          <div className="trace-cmd-head">
            <code>{data.command}</code>
            <CopyButton text={data.command} />
          </div>
        </>
      ) : null}
      {data.timedOut || data.exitCode !== undefined ? (
        <div className="trace-tool-note">
          {data.exitCode === null
            ? t('conv.bash.noExitCode')
            : data.exitCode !== undefined
              ? data.exitCode !== 0
                ? t('conv.bash.exitCodeNonZero', { code: data.exitCode })
                : t('conv.bash.exitCode', { code: data.exitCode })
              : null}
          {data.timedOut ? t('conv.bash.timedOut') : ''}
        </div>
      ) : null}
      {slice === undefined ? (
        tool.status === 'running' ? (
          <span className="trace-tool-note">{t('conv.bash.executing')}</span>
        ) : tool.status === 'done' && !tool.isError ? (
          <span className="trace-tool-note">{t('conv.bash.noOutput')}</span>
        ) : null
      ) : (
        <>
          <div className="trace-section-label">{tool.status === 'running' ? t('conv.bash.outputExecuting') : t('conv.bash.output')}</div>
          <pre className="code-block-pre">{expanded ? data.output : slice.visible}</pre>
          {tool.resultTruncation !== undefined ? (
            <TruncatedOutputFooter
              tool={tool}
              resultFetch={resultFetch}
              hiddenNote={slice.hiddenLines > 0 && !expanded ? t('conv.tool.collapsedAbove', { count: slice.hiddenLines }) : undefined}
            />
          ) : slice.hiddenLines > 0 ? (
            <div className="trace-out-foot">
              {!expanded ? <span className="trace-tool-note">{t('conv.tool.collapsedAbove', { count: slice.hiddenLines })}</span> : null}
              <button type="button" className="trace-inline-btn" onClick={() => setExpanded((value) => !value)}>
                <HelmxIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
                {expanded ? t('common.collapse') : t('conv.tool.expandAll', { count: slice.totalLines })}
              </button>
            </div>
          ) : null}
        </>
      )}
      <RawToolData tool={tool} resultFetch={resultFetch} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Generic tools (key-value + output preview + raw-data fallback)
// ---------------------------------------------------------------------------

const GENERIC_RESULT_PREVIEW_LINES = 40

function GenericToolBody({ tool, resultFetch }: ToolBodyProps): ReactNode {
  const { t } = useWebLocale()
  const kv = useMemo(() => inputKvEntries(tool.input), [tool.input])
  const [resultExpanded, setResultExpanded] = useState(false)
  const slice = tool.resultText !== undefined ? headLines(tool.resultText, GENERIC_RESULT_PREVIEW_LINES) : undefined
  return (
    <>
      {kv.length > 0 ? (
        <>
          <div className="trace-section-label">{t('conv.generic.input')}</div>
          <div className="kv-list trace-kv">
            {kv.map((entry) => (
              <Fragment key={entry.key}>
                <span className="kv-key">{entry.key}</span>
                {entry.block ? (
                  <pre className="kv-val trace-kv-block code-block-pre">{entry.value}</pre>
                ) : (
                  <span className="kv-val">{entry.value}</span>
                )}
              </Fragment>
            ))}
          </div>
        </>
      ) : null}
      {slice !== undefined ? (
        <>
          <div className="trace-section-label">{t('conv.generic.output')}</div>
          <pre className="code-block-pre">
            {resultExpanded ? tool.resultText : slice.visible}
          </pre>
          {tool.resultTruncation !== undefined ? (
            <TruncatedOutputFooter
              tool={tool}
              resultFetch={resultFetch}
              hiddenNote={slice.hiddenLines > 0 && !resultExpanded ? t('conv.tool.collapsedBelow', { count: slice.hiddenLines }) : undefined}
            />
          ) : slice.hiddenLines > 0 ? (
            <button type="button" className="trace-inline-btn" onClick={() => setResultExpanded((value) => !value)}>
              <HelmxIcon name={resultExpanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {resultExpanded ? t('common.collapse') : t('conv.tool.expandAll', { count: slice.totalLines })}
            </button>
          ) : null}
        </>
      ) : null}
      <RawToolData tool={tool} resultFetch={resultFetch} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Artifact entry + dispatch table
// ---------------------------------------------------------------------------

function ArtifactEntry({ tool, conversationId }: { tool: ToolTrace; conversationId: number }): ReactNode {
  const { setActiveModal } = useStoreActions()
  const { t } = useWebLocale()
  const artifactRef = tool.artifactRef
  if (artifactRef === undefined) return null
  return (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      onClick={() => setActiveModal({ kind: 'artifact-preview', artifactId: artifactRef, conversationId })}
    >
      <HelmxIcon name="external-link" size={12} />
      {t('conv.tool.openFullArtifact', { id: artifactRef })}
    </button>
  )
}

/** Small built-in dispatch table: not an extension framework; unmatched tools take the generic key-value shape. */
const TOOL_BODY_MAP: Record<string, (props: ToolBodyProps) => ReactNode> = {
  edit: EditToolBody,
  write: WriteToolBody,
  read: ReadToolBody,
  bash: BashToolBody,
}

export function ToolRawBody({ tool, conversationId }: { tool: ToolTrace; conversationId: number }): ReactNode {
  const resultFetch = useToolResultFullText(tool, conversationId)
  return <>
    <RawToolData tool={tool} resultFetch={resultFetch} defaultOpen />
    {tool.artifactRef !== undefined ? <ArtifactEntry tool={tool} conversationId={conversationId} /> : null}
  </>
}

export function ToolExpandedBody({ tool, conversationId }: { tool: ToolTrace; conversationId: number }): ReactNode {
  const resultFetch = useToolResultFullText(tool, conversationId)
  const Body = Object.hasOwn(TOOL_BODY_MAP, tool.toolName) ? TOOL_BODY_MAP[tool.toolName]! : GenericToolBody
  return (
    <div className="trace-tool-body">
      <Body tool={tool} conversationId={conversationId} resultFetch={resultFetch} />
      {tool.artifactRef !== undefined ? <ArtifactEntry tool={tool} conversationId={conversationId} /> : null}
    </div>
  )
}
