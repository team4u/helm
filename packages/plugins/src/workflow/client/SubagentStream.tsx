/**
 * Subagent live stream expansion component: renders compact activity lines
 * (prompt / thinking / tool / reply). The follow-bottom scroll hook is held
 * by the parent card (keeping the "never steal scroll after the user scrolls
 * up" state across collapse/expand) and injected into this presentational
 * component via ref / onScroll.
 */
import type { ReactNode, RefObject } from 'react'
import { resolveLocalizedText, usePluginLocale } from '@helm/plugin-client'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { toolResultPreviewTruncated } from './model-format.ts'
import {
  STREAM_PROMPT_TAG,
  STREAM_REPLY_TAG,
  STREAM_THINKING_TAG,
  STREAM_TRUNCATED,
  streamPreviewSeparator,
} from './copy.ts'
import type { SubagentStreamLine } from './model-subagent-stream.ts'

export function SubagentStream(props: {
  lines: SubagentStreamLine[]
  followRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
}): ReactNode {
  const { lines, followRef, onScroll } = props
  const locale = usePluginLocale()
  return (
    <div className="subagent-live-stream" ref={followRef} onScroll={onScroll}>
      {lines.slice(-30).map((line) =>
        line.kind === 'prompt' ? (
          <div key={line.key} className="subagent-stream-line subagent-stream-prompt">
            <span className="subagent-stream-tag">{resolveLocalizedText(STREAM_PROMPT_TAG, locale)}</span>
            <span className="subagent-stream-body">{line.text}</span>
          </div>
        ) : line.kind === 'thinking' ? (
          <div key={line.key} className="subagent-stream-line subagent-stream-thinking">
            <span className="subagent-stream-tag">{resolveLocalizedText(STREAM_THINKING_TAG, locale)}</span>
            <span className="subagent-stream-body">{line.text}</span>
          </div>
        ) : line.kind === 'tool' ? (
          <div key={line.key} className="subagent-stream-line subagent-stream-tool">
            <Icon name={line.status === 'running' ? 'loader' : line.isError ? 'x' : 'check'} size={11} className={line.status === 'running' ? SPIN : undefined} />
            <span className="subagent-stream-body">
            {line.toolName} {line.summary}{line.resultPreview !== undefined ? `${streamPreviewSeparator(locale)}${line.resultPreview}` : ''}
            {toolResultPreviewTruncated(line.resultPreview) ? <span className="subagent-stream-truncated">{resolveLocalizedText(STREAM_TRUNCATED, locale)}</span> : null}
          </span>
          </div>
        ) : (
          <div key={line.key} className="subagent-stream-line">
            <span className="subagent-stream-tag">{resolveLocalizedText(STREAM_REPLY_TAG, locale)}</span>
            <span className="subagent-stream-body">{line.text}</span>
          </div>
        ),
      )}
    </div>
  )
}
