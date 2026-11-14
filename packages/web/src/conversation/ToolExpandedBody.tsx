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
 * - 所有「展开全部」只展开本地已有完整文本；服务端截断（truncated）如实
 *   提示不可取回；
 * - 组件文件只导出组件与类型，纯转换均在 *-model.ts。
 */
import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ToolEditDiff } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { formatBytes } from '../lib/format.js'
import { CopyButton } from './CopyButton.js'
import { SyntaxCode } from './SyntaxCode.js'
import type { ToolTrace } from './timeline-model.js'
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
  writeBodyData,
} from './tool-body-model.js'

export interface ToolBodyProps {
  tool: ToolTrace
  conversationId: number
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
      {expanded ? '收起' : `展开剩余 ${hidden} 行`}
    </button>
  )
}

function PendingDiffView({ pending }: { pending: PendingEditDiff | undefined }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  if (pending === undefined) {
    return <span className="trace-tool-note">缺少 oldText/newText 入参，无法计算变更片段（见下方原始数据）。</span>
  }
  if (pending.kind === 'skipped') {
    return (
      <span className="trace-tool-note">
        片段差异未计算：{pending.reason}。为避免阻塞界面已跳过差异计算，可展开原始数据查看完整 oldText/newText。
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
          片段差异过长，仅保留前 {pending.rows.length} 行；+{pending.addedLines} −{pending.removedLines}
          统计覆盖全部变更行，完整内容见下方原始数据。
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
            ? <div className="trace-diff-note">… 已省略未改动的行 …</div>
            : null}
          <DiffRowView row={row} numbered />
        </Fragment>
      ))}
      {rows.length > DIFF_FOLD_ROWS ? <DiffFoldButton hidden={hidden} expanded={expanded} onToggle={() => setExpanded((v) => !v)} /> : null}
      {diff.truncated ? (
        <div className="trace-diff-note">
          部分差异因长度限制或脱敏省略，展开也无法取回未传输内容；+
          {diff.addedLines} −{diff.removedLines} 统计覆盖整个替换。
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 原始数据（入参 JSON + 原始输出 + 结构化结果，验证/复制兜底，绝不丢参数）
// ---------------------------------------------------------------------------

function RawToolData({ tool, defaultOpen = false }: { tool: ToolTrace; defaultOpen?: boolean }): ReactNode {
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
        原始数据
      </button>
      {open ? (
        <div className="trace-raw-body">
          {inputJson !== undefined ? (
            <div>
              <div className="trace-code-head"><span className="trace-section-label">入参（JSON）</span><CopyButton text={inputJson} label="复制入参 JSON" /></div>
              <pre className="code-block-pre code-block-pre-flush">{inputJson}</pre>
            </div>
          ) : null}
          {tool.resultText !== undefined ? (
            <div>
              <div className="trace-code-head"><span className="trace-section-label">原始输出</span><CopyButton text={tool.resultText} label="复制原始输出" /></div>
              <pre className="code-block-pre code-block-pre-flush">{tool.resultText}</pre>
            </div>
          ) : null}
          {structuredJson !== undefined ? (
            <div>
              <div className="trace-code-head"><span className="trace-section-label">结构化结果（JSON）</span><CopyButton text={structuredJson} label="复制结构化结果" /></div>
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

function EditToolBody({ tool }: ToolBodyProps): ReactNode {
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
        <div className="trace-section-label">待执行的变更片段{inputPath !== undefined ? ` · ${inputPath}` : ''}</div>
        <PendingDiffView pending={pending} />
        <RawToolData tool={tool} />
      </>
    )
  }
  if (tool.status === 'error' || tool.isError) {
    return (
      <>
        <div className="trace-section-label">错误{inputPath !== undefined ? ` · ${inputPath}` : ''}</div>
        <pre className="code-block-pre code-block-pre-flush trace-error-pre">
          {tool.resultText !== undefined && tool.resultText !== '' ? tool.resultText : '（无错误详情）'}
        </pre>
        <div className="trace-section-label">请求的变更片段（执行失败，不判定文件是否已变）</div>
        <PendingDiffView pending={pending} />
        <RawToolData tool={tool} />
      </>
    )
  }
  if (tool.status === 'done') {
    if (resultCheck !== undefined && resultCheck.ok) {
      return (
        <>
          <div className="trace-section-label">
            已应用的差异 · {resultCheck.value.path} · +{resultCheck.value.diff.addedLines} −
            {resultCheck.value.diff.removedLines}
          </div>
          <AppliedDiffView diff={resultCheck.value.diff} />
          <RawToolData tool={tool} />
        </>
      )
    }
    return (
      <>
        <div className="trace-section-label">执行成功 · 差异数据不可用</div>
        <div className="callout callout--error" role="alert">
          <HelmIcon name="alert-triangle" size={12} />
          <span className="callout-text">
            edit 成功但差异元数据缺失或非法（
            {resultCheck === undefined ? '缺少 structuredOutput' : resultCheck.reason}
            ），无法展示真实文件差异；以下保留原始入参与输出，不伪造文件上下文。
          </span>
        </div>
        <RawToolData tool={tool} defaultOpen />
      </>
    )
  }
  // unknown：与 running/done/error 明确区分，不虚构执行状态
  return (
    <>
      <div className="trace-section-label">结果未知{inputPath !== undefined ? ` · ${inputPath}` : ''}</div>
      <span className="trace-tool-note">工具未返回结果（可能未执行或已中断），不判定变更是否已应用；原始入参如下。</span>
      <RawToolData tool={tool} defaultOpen />
    </>
  )
}

// ---------------------------------------------------------------------------
// write / read / bash
// ---------------------------------------------------------------------------

const WRITE_PREVIEW_LINES = 12

function WriteToolBody({ tool }: ToolBodyProps): ReactNode {
  const data = useMemo(() => writeBodyData(tool), [tool])
  const [expanded, setExpanded] = useState(false)
  const failed = tool.status === 'error' || tool.isError
  const label =
    tool.status === 'running'
      ? '待写入'
      : failed
        ? '写入内容（执行失败）'
        : tool.status === 'done'
          ? '写入内容'
          : '写入内容（结果未知）'
  const slice = data.content !== undefined ? headLines(data.content, WRITE_PREVIEW_LINES) : undefined
  const foldable = slice !== undefined && slice.hiddenLines > 0
  return (
    <>
      <div className="trace-section-label">
        {label}
        {data.path !== undefined ? ` · ${data.path}` : ''}
        {data.bytesWritten !== undefined ? ` · 已写入 ${formatBytes(data.bytesWritten)}` : ''}
      </div>
      {failed ? (
        <pre className="code-block-pre code-block-pre-flush trace-error-pre">
          {tool.resultText !== undefined && tool.resultText !== '' ? tool.resultText : '（无错误详情）'}
        </pre>
      ) : null}
      {data.content === undefined ? (
        <span className="trace-tool-note">缺少 content 入参（见下方原始数据）。</span>
      ) : (
        <div className="trace-code-sec">
          <div className="trace-code-head">
            <span className="trace-tool-note">
              {expanded || !foldable ? `共 ${data.lineCount} 行` : `前 ${slice!.totalLines - slice!.hiddenLines} / ${slice!.totalLines} 行`}
            </span>
            <CopyButton text={data.content} label="复制源码" />
          </div>
          <SyntaxCode code={expanded ? data.content : slice!.visible} language={data.language} />
          {foldable ? (
            <button type="button" className="trace-inline-btn" onClick={() => setExpanded((v) => !v)}>
              <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {expanded ? '收起' : `展开全部（共 ${data.lineCount} 行）`}
            </button>
          ) : null}
        </div>
      )}
      <RawToolData tool={tool} defaultOpen={failed} />
    </>
  )
}

const READ_PREVIEW_LINES = 12

function ReadToolBody({ tool }: ToolBodyProps): ReactNode {
  const data = useMemo(() => readBodyData(tool), [tool])
  const [expanded, setExpanded] = useState(false)
  const failed = tool.status === 'error' || tool.isError
  if (failed) {
    return (
      <>
        <div className="trace-section-label">读取失败</div>
        <pre className="code-block-pre code-block-pre-flush trace-error-pre">
          {tool.resultText !== undefined && tool.resultText !== '' ? tool.resultText : '（无错误详情）'}
        </pre>
        <RawToolData tool={tool} defaultOpen />
      </>
    )
  }
  if (data.content === undefined) {
    return (
      <>
        <div className="trace-section-label">{tool.status === 'running' ? '读取中' : '读取结果'}</div>
        <span className="trace-tool-note">{tool.status === 'running' ? '尚无读取内容。' : '无内容输出。'}</span>
        <RawToolData tool={tool} defaultOpen={tool.status !== 'running'} />
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
          <div className="trace-section-label">读取结果（含产物引用）</div>
          <pre className="code-block-pre code-block-pre-flush">{shown}</pre>
          {foldable ? (
            <button type="button" className="trace-inline-btn" onClick={() => setExpanded((v) => !v)}>
              <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {expanded ? '收起' : `展开全部（共 ${slice.totalLines} 行）`}
            </button>
          ) : null}
          <span className="trace-tool-note">以上为输出头部预览，完整内容见下方产物入口。</span>
        </>
      ) : (
        <div className="trace-code-sec">
          <div className="trace-section-label">读取结果</div>
          <div className="trace-code-head">
            <span className="trace-tool-note">
              {expanded || !foldable ? `共 ${slice.totalLines} 行` : `前 ${slice.totalLines - slice.hiddenLines} / ${slice.totalLines} 行`}
            </span>
            <CopyButton text={data.content} label="复制内容" />
          </div>
          <SyntaxCode code={shown} language={data.language} />
          {foldable ? (
            <button type="button" className="trace-inline-btn" onClick={() => setExpanded((v) => !v)}>
              <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {expanded ? '收起' : `展开全部（共 ${slice.totalLines} 行）`}
            </button>
          ) : null}
        </div>
      )}
      <RawToolData tool={tool} />
    </>
  )
}

const BASH_TAIL_LINES = 8

function BashToolBody({ tool }: ToolBodyProps): ReactNode {
  const data = useMemo(() => bashBodyData(tool), [tool])
  const [expanded, setExpanded] = useState(false)
  const hasOutput = data.output !== undefined && data.output !== ''
  const slice = hasOutput ? tailLines(data.output!, BASH_TAIL_LINES) : undefined
  return (
    <>
      {data.command !== undefined ? (
        <>
          <div className="trace-section-label">命令</div>
          <div className="trace-cmd-head">
            <code>{data.command}</code>
            <CopyButton text={data.command} />
          </div>
        </>
      ) : null}
      {data.timedOut || data.exitCode !== undefined ? (
        <div className="trace-tool-note">
          {data.exitCode === null
            ? '无退出码'
            : data.exitCode !== undefined
              ? `退出码 ${data.exitCode}${data.exitCode !== 0 ? '（非 0）' : ''}`
              : null}
          {data.timedOut ? ' · 已超时' : ''}
        </div>
      ) : null}
      {slice === undefined ? (
        tool.status === 'running' ? (
          <span className="trace-tool-note">执行中，暂无输出。</span>
        ) : tool.status === 'done' && !tool.isError ? (
          <span className="trace-tool-note">（无输出）</span>
        ) : null
      ) : (
        <>
          <div className="trace-section-label">输出{tool.status === 'running' ? '（执行中）' : ''}</div>
          <pre className="code-block-pre code-block-pre-flush">{expanded ? data.output : slice.visible}</pre>
          {slice.hiddenLines > 0 ? (
            <div className="trace-out-foot">
              {!expanded ? <span className="trace-tool-note">已折叠前 {slice.hiddenLines} 行</span> : null}
              <button type="button" className="trace-inline-btn" onClick={() => setExpanded((value) => !value)}>
                <HelmIcon name={expanded ? 'chevron-up' : 'chevron-down'} size={11} />
                {expanded ? '收起' : `展开全部（共 ${slice.totalLines} 行）`}
              </button>
            </div>
          ) : null}
        </>
      )}
      <RawToolData tool={tool} />
    </>
  )
}

// ---------------------------------------------------------------------------
// 通用工具（键值 + 输出预览 + 原始数据兜底）
// ---------------------------------------------------------------------------

const GENERIC_RESULT_PREVIEW_LINES = 40

function GenericToolBody({ tool }: ToolBodyProps): ReactNode {
  const kv = useMemo(() => inputKvEntries(tool.input), [tool.input])
  const [resultExpanded, setResultExpanded] = useState(false)
  const slice = tool.resultText !== undefined ? headLines(tool.resultText, GENERIC_RESULT_PREVIEW_LINES) : undefined
  return (
    <>
      {kv.length > 0 ? (
        <>
          <div className="trace-section-label">入参</div>
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
          <div className="trace-section-label">输出</div>
          <pre className="code-block-pre code-block-pre-flush">
            {resultExpanded ? tool.resultText : slice.visible}
          </pre>
          {slice.hiddenLines > 0 ? (
            <button type="button" className="trace-inline-btn" onClick={() => setResultExpanded((value) => !value)}>
              <HelmIcon name={resultExpanded ? 'chevron-up' : 'chevron-down'} size={11} />
              {resultExpanded ? '收起' : `展开全部（共 ${slice.totalLines} 行）`}
            </button>
          ) : null}
        </>
      ) : null}
      <RawToolData tool={tool} />
    </>
  )
}

// ---------------------------------------------------------------------------
// 产物入口 + 分派表
// ---------------------------------------------------------------------------

function ArtifactEntry({ tool, conversationId }: ToolBodyProps): ReactNode {
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
      打开完整产物 #{artifactRef}
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

export function ToolRawBody({ tool, conversationId }: ToolBodyProps): ReactNode {
  return <>
    <RawToolData tool={tool} defaultOpen />
    {tool.artifactRef !== undefined ? <ArtifactEntry tool={tool} conversationId={conversationId} /> : null}
  </>
}

export function ToolExpandedBody({ tool, conversationId }: ToolBodyProps): ReactNode {
  const Body = Object.hasOwn(TOOL_BODY_MAP, tool.toolName) ? TOOL_BODY_MAP[tool.toolName]! : GenericToolBody
  return (
    <div className="trace-tool-body">
      <Body tool={tool} conversationId={conversationId} />
      {tool.artifactRef !== undefined ? <ArtifactEntry tool={tool} conversationId={conversationId} /> : null}
    </div>
  )
}
