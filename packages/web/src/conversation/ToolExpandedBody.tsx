/**
 * 宿主内置工具展开体（Quiet Surface 26px 轨迹行展开后的正文）。
 *
 * 契约：
 * - 仅在无插件 tool.view 接管时使用（TraceRow 判定后渲染，本组件不自查）；
 * - 小型 toolName => component 分派表（edit/write/read/bash），其余走通用
 *   键值形态；不做可扩展框架、不注册新 tool.view；
 * - edit 完成态必须先通过 EDIT_TOOL_RESULT_SCHEMA 校验才显示内核真实差异（成功才
 *   承诺“已应用”）；运行态只显示待执行片段（无文件行号），失败态显示“请求的
 *   变更片段（执行失败）”——写盘中途失败/结果管道失败时不能断言文件未变；
 *   缺失或非法元数据显式诊断并保留原始数据入口，绝不伪造已应用差异；
 * - 所有「展开全部」只展开本地已有完整文本；服务端截断（resultTruncation，
 *   随 toolResult 消息的 truncated/totalChars/totalLines 携带）时展开按钮即
 *   「展开全文」取回入口（单一入口）：按 GET /api/conversations/:id/entries/:entryId
 *   取回原文并原位回填，失败显式呈现；复制入口在取回前禁用，绝不把预览冒充全文；
 * - 组件文件只导出组件与类型，纯转换均在 *-model.ts。
 */
import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolEditDiff } from '@helm/protocol/browser'
import { HelmIcon, CopyButton } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
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
  /** 结果文本全文取回状态（服务端截断时驱动取回按钮、错误呈现与复制门禁）。 */
  resultFetch: ToolResultFullTextState
}

// ---------------------------------------------------------------------------
// 差异行渲染（已应用：真实行号；待执行片段：无行号）
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

/** 较长差异的本地折叠阈值（数据已在客户端，展开可完整还原）。 */
const DIFF_FOLD_ROWS = 32

function DiffFoldButton({ hidden, expanded, onToggle }: { hidden: number; expanded: boolean; onToggle: () => void }): ReactNode {
  return (
    <button type="button" className="trace-inline-btn trace-diff-more" onClick={onToggle}>
      <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
      {expanded ? 'Collapse' : `Expand remaining ${hidden} lines`}
    </button>
  )
}

function PendingDiffView({ pending }: { pending: PendingEditDiff | undefined }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  if (pending === undefined) {
    return <span className="trace-tool-note">Missing oldText/newText arguments; cannot compute change hunks (see raw data below).</span>
  }
  if (pending.kind === 'skipped') {
    return (
      <span className="trace-tool-note">
        Hunk diff not computed: {pending.reason}. Diff computation was skipped to keep the UI responsive; expand the raw data for the full oldText/newText.
      </span>
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
          Hunk diff too long; only the first {pending.rows.length} lines kept; +{pending.addedLines} −{pending.removedLines}
          Stats cover all changed lines; see raw data below for the full content.
        </div>
      ) : null}
    </div>
  )
}

function AppliedDiffView({ diff }: { diff: ToolEditDiff }): ReactNode {
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
            ? <div className="trace-diff-note">… unchanged lines omitted …</div>
            : null}
          <DiffRowView row={row} numbered />
        </Fragment>
      ))}
      {rows.length > DIFF_FOLD_ROWS ? <DiffFoldButton hidden={hidden} expanded={expanded} onToggle={() => setExpanded((v) => !v)} /> : null}
      {diff.truncated ? (
        <div className="trace-diff-note">
          Some diff content was omitted due to length limits or redaction and cannot be recovered by expanding; +
          {diff.addedLines} −{diff.removedLines} stats cover the whole replacement.
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 服务端截断：取回全文脚注与复制门禁（预览绝不当全文复制）
// ---------------------------------------------------------------------------

/** 截断取回脚注：preview/loading/complete 如实呈现，failed 显式报错并可重试。 */
function TruncatedOutputFooter({
  tool,
  resultFetch,
  hiddenNote,
}: {
  tool: ToolTrace
  resultFetch: ToolResultFullTextState
  /** 追加在截断说明前的本地折叠事实（如「已折叠前 N 行」，仅描述预览本身）。 */
  hiddenNote?: string
}): ReactNode {
  const truncation = tool.resultTruncation
  if (truncation === undefined) return null
  if (resultFetch.phase === 'failed') {
    return (
      <div className="callout callout--error" role="alert">
        <HelmIcon name="alert-triangle" size={12} />
        <span className="callout-text">
          Failed to fetch full text: {resultFetch.error ?? 'Unknown error'}. The content above is still the server preview, not the full output.
        </span>
        <button type="button" className="trace-inline-btn" onClick={resultFetch.load}>
          <HelmIcon name="rotate-ccw" size={11} />
          Retry fetch
        </button>
      </div>
    )
  }
  if (resultFetch.phase === 'complete') {
    // 回填后标记仍未消失：服务端契约异常，如实说明，不谎称已取得更多内容。
    return <div className="trace-tool-note">The server entry was fetched but is still marked truncated; no extra content was obtained.</div>
  }
  const total = truncation.totalLines !== undefined ? ` (${truncation.totalLines} lines in total)` : ''
  const note = truncationPreviewNote(truncation)
  return (
    <div className="trace-out-foot">
      <span className="trace-tool-note">
        {hiddenNote !== undefined ? `${hiddenNote} · ${note}` : note}
        {tool.artifactRef !== undefined ? '; the entry holds only the Spill preview — see the artifact entry below for the full text' : ''}
      </span>
      <button
        type="button"
        className="trace-inline-btn"
        disabled={resultFetch.phase === 'loading'}
        onClick={resultFetch.load}
      >
        <HelmIcon
          name={resultFetch.phase === 'loading' ? 'loader' : 'download'}
          size={11}
          className={resultFetch.phase === 'loading' ? 'spin-slow' : undefined}
        />
        {resultFetch.phase === 'loading' ? 'Fetching full text…' : `Expand full text${total}`}
      </button>
    </div>
  )
}

/** 结果文本复制门禁：服务端截断且未取回原文前禁用复制，绝不静默复制预览冒充全文。 */
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
  const isArtifactPreview = tool.artifactRef !== undefined
  if (tool.resultTruncation === undefined && !isArtifactPreview) return <CopyButton text={text} label={label} />
  const title = isArtifactPreview
    ? 'This is a Spill artifact preview; open the full artifact to view or copy the whole text'
    : resultFetch.phase === 'loading'
      ? 'Fetching full text from the server; copy becomes available once done'
      : 'Output is a server-truncated preview; the full text must be fetched before copying'
  return (
    <button type="button" className="btn btn-ghost btn-sm" disabled title={title} aria-label={`${label} (disabled: preview content)`}>
      <HelmIcon name="copy" size={12} />
      <span>{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// 原始数据（入参 JSON + 原始输出 + 结构化结果，验证/复制兜底，绝不丢参数）
// ---------------------------------------------------------------------------

function RawToolData({ tool, resultFetch, defaultOpen = false }: { tool: ToolTrace; resultFetch: ToolResultFullTextState; defaultOpen?: boolean }): ReactNode {
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
        <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
        Raw data
      </button>
      {open ? (
        <div className="trace-raw-body">
          {inputJson !== undefined ? (
            <div>
              <div className="trace-code-head"><span className="trace-section-label">Input (JSON)</span><CopyButton text={inputJson} label="Copy input JSON" /></div>
              <pre className="code-block-pre code-block-pre-flush">{inputJson}</pre>
            </div>
          ) : null}
          {tool.resultText !== undefined ? (
            <div>
              <div className="trace-code-head">
                <span className="trace-section-label">Raw output</span>
                <ResultCopyGate text={tool.resultText} label="Copy raw output" tool={tool} resultFetch={resultFetch} />
              </div>
              <pre className="code-block-pre code-block-pre-flush">{tool.resultText}</pre>
              {tool.resultTruncation !== undefined ? <TruncatedOutputFooter tool={tool} resultFetch={resultFetch} /> : null}
            </div>
          ) : null}
          {structuredJson !== undefined ? (
            <div>
              <div className="trace-code-head"><span className="trace-section-label">Structured result (JSON)</span><CopyButton text={structuredJson} label="Copy structured result" /></div>
              <pre className="code-block-pre code-block-pre-flush">{structuredJson}</pre>
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
        <div className="trace-section-label">Pending change hunks{inputPath !== undefined ? ` · ${inputPath}` : ''}</div>
        <PendingDiffView pending={pending} />
        <RawToolData tool={tool} resultFetch={resultFetch} />
      </>
    )
  }
  if (tool.status === 'error' || tool.isError) {
    return (
      <>
        <div className="trace-section-label">Error{inputPath !== undefined ? ` · ${inputPath}` : ''}</div>
        <pre className="code-block-pre code-block-pre-flush trace-error-pre">
          {tool.resultText !== undefined && tool.resultText !== '' ? tool.resultText : '(no error details)'}
        </pre>
        {tool.resultTruncation !== undefined ? <TruncatedOutputFooter tool={tool} resultFetch={resultFetch} /> : null}
        <div className="trace-section-label">Requested change hunks (execution failed; file state undetermined)</div>
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
            Applied diff · {resultCheck.value.path} · +{resultCheck.value.diff.addedLines} −
            {resultCheck.value.diff.removedLines}
          </div>
          <AppliedDiffView diff={resultCheck.value.diff} />
          <RawToolData tool={tool} resultFetch={resultFetch} />
        </>
      )
    }
    return (
      <>
        <div className="trace-section-label">Execution succeeded · diff data unavailable</div>
        <div className="callout callout--error" role="alert">
          <HelmIcon name="alert-triangle" size={12} />
          <span className="callout-text">
            edit succeeded but diff metadata is missing or invalid (
            {resultCheck === undefined ? 'missing structuredOutput' : resultCheck.reason}
            ), so the real file diff cannot be shown; the raw input and output are kept below without fabricating file context.
          </span>
        </div>
        <RawToolData tool={tool} resultFetch={resultFetch} defaultOpen />
      </>
    )
  }
  // unknown：与 running/done/error 明确区分，不虚构执行状态
  return (
    <>
      <div className="trace-section-label">Result unknown{inputPath !== undefined ? ` · ${inputPath}` : ''}</div>
      <span className="trace-tool-note">The tool returned no result (possibly not executed or interrupted); whether the change applied is undetermined; raw input below.</span>
      <RawToolData tool={tool} resultFetch={resultFetch} defaultOpen />
    </>
  )
}

// ---------------------------------------------------------------------------
// write / read / bash
// ---------------------------------------------------------------------------

const WRITE_PREVIEW_LINES = 12

function WriteToolBody({ tool, resultFetch }: ToolBodyProps): ReactNode {
  const data = useMemo(() => writeBodyData(tool), [tool])
  const [expanded, setExpanded] = useState(false)
  const failed = tool.status === 'error' || tool.isError
  const label =
    tool.status === 'running'
      ? 'Pending write'
      : failed
        ? 'Write content (execution failed)'
        : tool.status === 'done'
          ? 'Write content'
          : 'Write content (result unknown)'
  const slice = data.content !== undefined ? headLines(data.content, WRITE_PREVIEW_LINES) : undefined
  const foldable = slice !== undefined && slice.hiddenLines > 0
  return (
    <>
      <div className="trace-section-label">
        {label}
        {data.path !== undefined ? ` · ${data.path}` : ''}
        {data.bytesWritten !== undefined ? ` · wrote ${formatBytes(data.bytesWritten)}` : ''}
      </div>
      {failed ? (
        <>
          <pre className="code-block-pre code-block-pre-flush trace-error-pre">
            {tool.resultText !== undefined && tool.resultText !== '' ? tool.resultText : '(no error details)'}
          </pre>
          {tool.resultTruncation !== undefined ? <TruncatedOutputFooter tool={tool} resultFetch={resultFetch} /> : null}
        </>
      ) : null}
      {data.content === undefined ? (
        <span className="trace-tool-note">Missing content argument (see raw data below).</span>
      ) : (
        <div className="trace-code-sec">
          <div className="trace-code-head">
            <span className="trace-tool-note">
              {expanded || !foldable ? `${data.lineCount} lines in total` : `first ${slice!.totalLines - slice!.hiddenLines} / ${slice!.totalLines} lines`}
            </span>
            <CopyButton text={data.content} label="Copy source" />
          </div>
          <SyntaxCode code={expanded ? data.content : slice!.visible} language={data.language} />
          {foldable ? (
            <button type="button" className="trace-inline-btn" onClick={() => setExpanded((v) => !v)}>
              <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {expanded ? 'Collapse' : `Expand all (${data.lineCount} lines)`}
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
  const data = useMemo(() => readBodyData(tool), [tool])
  const [expanded, setExpanded] = useState(false)
  const failed = tool.status === 'error' || tool.isError
  // 服务端截断只约束原始输出文本通道；structuredOutput.content（details 通道）完整传回，不受影响。
  const truncated = data.fromResultText && tool.resultTruncation !== undefined
  if (failed) {
    return (
      <>
        <div className="trace-section-label">Read failed</div>
        <pre className="code-block-pre code-block-pre-flush trace-error-pre">
          {tool.resultText !== undefined && tool.resultText !== '' ? tool.resultText : '(no error details)'}
        </pre>
        {tool.resultTruncation !== undefined ? <TruncatedOutputFooter tool={tool} resultFetch={resultFetch} /> : null}
        <RawToolData tool={tool} resultFetch={resultFetch} defaultOpen />
      </>
    )
  }
  if (data.content === undefined) {
    return (
      <>
        <div className="trace-section-label">{tool.status === 'running' ? 'Reading' : 'Read result'}</div>
        <span className="trace-tool-note">{tool.status === 'running' ? 'Nothing read yet.' : 'No content output.'}</span>
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
          <div className="trace-section-label">Read result (with artifact references)</div>
          <pre className="code-block-pre code-block-pre-flush">{shown}</pre>
          {truncated ? (
            <TruncatedOutputFooter
              tool={tool}
              resultFetch={resultFetch}
              hiddenNote={foldable && !expanded ? `${slice.hiddenLines} lines collapsed below` : undefined}
            />
          ) : foldable ? (
            <button type="button" className="trace-inline-btn" onClick={() => setExpanded((v) => !v)}>
              <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {expanded ? 'Collapse' : `Expand all (${slice.totalLines} lines)`}
            </button>
          ) : null}
          <span className="trace-tool-note">This is the head preview of the output; see the artifact entry below for the full content.</span>
        </>
      ) : (
        <div className="trace-code-sec">
          <div className="trace-section-label">Read result</div>
          <div className="trace-code-head">
            <span className="trace-tool-note">
              {expanded || !foldable
                ? truncated
                  ? `${slice.totalLines} lines previewed`
                  : `${slice.totalLines} lines in total`
                : truncated
                  ? `first ${slice.totalLines - slice.hiddenLines} / ${slice.totalLines} lines previewed`
                  : `first ${slice.totalLines - slice.hiddenLines} / ${slice.totalLines} lines`}
            </span>
            {truncated ? (
              <ResultCopyGate text={data.content} label="Copy content" tool={tool} resultFetch={resultFetch} />
            ) : (
              <CopyButton text={data.content} label="Copy content" />
            )}
          </div>
          <SyntaxCode code={shown} language={data.language} />
          {truncated ? (
            <TruncatedOutputFooter
              tool={tool}
              resultFetch={resultFetch}
              hiddenNote={foldable && !expanded ? `${slice.hiddenLines} lines collapsed below` : undefined}
            />
          ) : foldable ? (
            <button type="button" className="trace-inline-btn" onClick={() => setExpanded((v) => !v)}>
              <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {expanded ? 'Collapse' : `Expand all (${slice.totalLines} lines)`}
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
  const data = useMemo(() => bashBodyData(tool), [tool])
  const [expanded, setExpanded] = useState(false)
  const hasOutput = data.output !== undefined && data.output !== ''
  const slice = hasOutput ? tailLines(data.output!, BASH_TAIL_LINES) : undefined
  return (
    <>
      {data.command !== undefined ? (
        <>
          <div className="trace-section-label">Command</div>
          <div className="trace-cmd-head">
            <code>{data.command}</code>
            <CopyButton text={data.command} />
          </div>
        </>
      ) : null}
      {data.timedOut || data.exitCode !== undefined ? (
        <div className="trace-tool-note">
          {data.exitCode === null
            ? 'No exit code'
            : data.exitCode !== undefined
              ? `Exit code ${data.exitCode}${data.exitCode !== 0 ? '(non-zero)' : ''}`
              : null}
          {data.timedOut ? ' · timed out' : ''}
        </div>
      ) : null}
      {slice === undefined ? (
        tool.status === 'running' ? (
          <span className="trace-tool-note">Executing; no output yet.</span>
        ) : tool.status === 'done' && !tool.isError ? (
          <span className="trace-tool-note">(no output)</span>
        ) : null
      ) : (
        <>
          <div className="trace-section-label">Output{tool.status === 'running' ? '(executing)' : ''}</div>
          <pre className="code-block-pre code-block-pre-flush">{expanded ? data.output : slice.visible}</pre>
          {tool.resultTruncation !== undefined ? (
            <TruncatedOutputFooter
              tool={tool}
              resultFetch={resultFetch}
              hiddenNote={slice.hiddenLines > 0 && !expanded ? `${slice.hiddenLines} lines collapsed above` : undefined}
            />
          ) : slice.hiddenLines > 0 ? (
            <div className="trace-out-foot">
              {!expanded ? <span className="trace-tool-note">{slice.hiddenLines} lines collapsed above</span> : null}
              <button type="button" className="trace-inline-btn" onClick={() => setExpanded((value) => !value)}>
                <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
                {expanded ? 'Collapse' : `Expand all (${slice.totalLines} lines)`}
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
// 通用工具（键值 + 输出预览 + 原始数据兜底）
// ---------------------------------------------------------------------------

const GENERIC_RESULT_PREVIEW_LINES = 40

function GenericToolBody({ tool, resultFetch }: ToolBodyProps): ReactNode {
  const kv = useMemo(() => inputKvEntries(tool.input), [tool.input])
  const [resultExpanded, setResultExpanded] = useState(false)
  const slice = tool.resultText !== undefined ? headLines(tool.resultText, GENERIC_RESULT_PREVIEW_LINES) : undefined
  return (
    <>
      {kv.length > 0 ? (
        <>
          <div className="trace-section-label">Input</div>
          <div className="kv-list trace-kv">
            {kv.map((entry) => (
              <Fragment key={entry.key}>
                <span className="kv-key">{entry.key}</span>
                {entry.block ? (
                  <pre className="kv-val trace-kv-block code-block-pre code-block-pre-flush">{entry.value}</pre>
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
          <div className="trace-section-label">Output</div>
          <pre className="code-block-pre code-block-pre-flush">
            {resultExpanded ? tool.resultText : slice.visible}
          </pre>
          {tool.resultTruncation !== undefined ? (
            <TruncatedOutputFooter
              tool={tool}
              resultFetch={resultFetch}
              hiddenNote={slice.hiddenLines > 0 && !resultExpanded ? `${slice.hiddenLines} lines collapsed below` : undefined}
            />
          ) : slice.hiddenLines > 0 ? (
            <button type="button" className="trace-inline-btn" onClick={() => setResultExpanded((value) => !value)}>
              <HelmIcon name={resultExpanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {resultExpanded ? 'Collapse' : `Expand all (${slice.totalLines} lines)`}
            </button>
          ) : null}
        </>
      ) : null}
      <RawToolData tool={tool} resultFetch={resultFetch} />
    </>
  )
}

// ---------------------------------------------------------------------------
// 产物入口 + 分派表
// ---------------------------------------------------------------------------

function ArtifactEntry({ tool, conversationId }: { tool: ToolTrace; conversationId: number }): ReactNode {
  const store = useHelmStore()
  const artifactRef = tool.artifactRef
  if (artifactRef === undefined) return null
  return (
    <button
      type="button"
      className="btn btn-sm btn-primary"
      onClick={() => store.setActiveModal({ kind: 'artifact-preview', artifactId: artifactRef, conversationId })}
    >
      <HelmIcon name="external-link" size={12} />
      Open full artifact #{artifactRef}
    </button>
  )
}

/** 小型内置分派表：非扩展框架，未命中的工具走通用键值形态。 */
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
