/**
 * Inline raw tool input/output details block (client-local twin of the
 * workflow plugin's inline details: the plugin client bundle cannot import
 * across clientRoots). Component & type exports only (Fast Refresh compliant).
 */
import { useMemo, useState } from 'react'
import { resolveLocalizedText, usePluginContext, usePluginLocale } from '@helm/plugin-client'
import {
  TRACE_DETAILS_INPUT,
  TRACE_DETAILS_OUTPUT,
  TRACE_DETAILS_SUMMARY,
} from './copy.ts'

interface ToolCallDetailsInlineProps {
  /** Raw input of this tool call. */
  input?: unknown
  /** Raw output text of this tool call. */
  result?: unknown
  /** Artifact reference detected in the output (kernel spill marker / art_ prefix). */
  artifactRef?: string
}

function stringifyPretty(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? undefined
  } catch {
    return String(value)
  }
}

export function ToolCallDetailsInline({ input, result, artifactRef }: ToolCallDetailsInlineProps) {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [open, setOpen] = useState(false)
  const inputJson = useMemo(() => stringifyPretty(input), [input])
  const resultText = useMemo(() => stringifyPretty(result), [result])

  return (
    <details
      className="tool-call-details"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <summary>{resolveLocalizedText(TRACE_DETAILS_SUMMARY, locale)}</summary>
      <div className="trace-expanded-body selectable">
        {inputJson !== undefined ? (
          <div>
            <div className="trace-section-label">{resolveLocalizedText(TRACE_DETAILS_INPUT, locale)}</div>
            <pre className="code-block-pre"><code>{inputJson}</code></pre>
          </div>
        ) : null}
        {resultText !== undefined ? (
          <div>
            <div className="trace-section-label">{resolveLocalizedText(TRACE_DETAILS_OUTPUT, locale)}</div>
            <pre className="code-block-pre"><code>{resultText}</code></pre>
          </div>
        ) : null}
        {artifactRef !== undefined ? (
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => ctx.openArtifact(artifactRef)}
          >
            {artifactRef}
          </button>
        ) : null}
      </div>
    </details>
  )
}
