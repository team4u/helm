/**
 * Inline tool input/output/artifact button details block (internal use by the
 * plugin client components). Clicking the artifact button calls
 * ctx.openArtifact(artifactId) to open the host artifact preview modal.
 */
import { useMemo, useState } from 'react'
import { resolveLocalizedText, usePluginContext, usePluginLocale } from '@helm/plugin-client'
import { stringifyPretty } from './model-format.ts'
import { DETAILS_INPUT, DETAILS_OUTPUT, DETAILS_SUMMARY, detailsOpenArtifactLabel } from './copy.ts'

interface ToolCallDetailsInlineProps {
  /** Raw input of this tool call. */
  input?: unknown
  /** Raw output text of this tool call. */
  result?: unknown
  /** Artifact reference detected in the output (kernel spill marker / art_ prefix). */
  artifactRef?: string
}

export function ToolCallDetailsInline({ input, result, artifactRef }: ToolCallDetailsInlineProps) {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [open, setOpen] = useState(false)
  const inputJson = useMemo(() => stringifyPretty(input), [input])
  const resultText = useMemo(
    () => (typeof result === 'string' ? result : stringifyPretty(result)),
    [result],
  )

  return (
    <details
      className="tool-call-details"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <summary>{resolveLocalizedText(DETAILS_SUMMARY, locale)}</summary>
      <div className="trace-expanded-body selectable">
        {inputJson !== undefined ? (
          <div>
            <div className="trace-section-label">{resolveLocalizedText(DETAILS_INPUT, locale)}</div>
            <pre className="code-block-pre"><code>{inputJson}</code></pre>
          </div>
        ) : null}
        {resultText !== undefined ? (
          <div>
            <div className="trace-section-label">{resolveLocalizedText(DETAILS_OUTPUT, locale)}</div>
            <pre className="code-block-pre"><code>{resultText}</code></pre>
          </div>
        ) : null}
        {artifactRef !== undefined ? (
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => ctx.openArtifact(artifactRef)}
          >
            {detailsOpenArtifactLabel(artifactRef, locale)}
          </button>
        ) : null}
      </div>
    </details>
  )
}
