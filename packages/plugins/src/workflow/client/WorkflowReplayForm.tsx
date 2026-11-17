/**
 * Completed-run replay form component (consumed by WorkflowRunCardBody):
 * source run identity + args override input + cache semantics note; args
 * parsing and action dispatch are held by the parent card.
 */
import type { ReactNode } from 'react'
import type { WorkflowRunSummary } from '../../contracts.js'
import { resolveLocalizedText, usePluginLocale } from '@helm/plugin-client'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import {
  REPLAY_ARGS_PLACEHOLDER,
  replayArgsAria,
  REPLAY_HINT,
  replayMeta,
  REPLAY_SUBMIT,
  REPLAY_SUBMIT_ARIA,
  REPLAY_SUBMIT_TITLE,
} from './copy.ts'

export function WorkflowReplayForm(props: {
  run: WorkflowRunSummary
  replayArgs: string
  onReplayArgsChange: (value: string) => void
  replayError: string | undefined
  busy: boolean
  onReplay: () => void
}): ReactNode {
  const { run, busy, replayArgs, replayError } = props
  const locale = usePluginLocale()
  return (
    <div className="workflow-replay-form">
      <div className="workflow-replay-meta">
        {replayMeta(run.id, run.conversationId, run.savedName, locale)}
      </div>
      <div className="workflow-replay-hint">{resolveLocalizedText(REPLAY_HINT, locale)}</div>
      <div className="workflow-replay-row">
        <input
          className="workflow-replay-args"
          type="text"
          placeholder={resolveLocalizedText(REPLAY_ARGS_PLACEHOLDER, locale)}
          value={replayArgs}
          onChange={(e) => props.onReplayArgsChange(e.target.value)}
          aria-label={replayArgsAria(run.id, locale)}
        />
        <button
          type="button"
          className="btn btn-xs"
          disabled={busy}
          onClick={props.onReplay}
          aria-label={resolveLocalizedText(REPLAY_SUBMIT_ARIA, locale)}
          title={resolveLocalizedText(REPLAY_SUBMIT_TITLE, locale)}
        >
          <Icon name="rotate-cw" size={11} className={busy ? SPIN : undefined} />
          {resolveLocalizedText(REPLAY_SUBMIT, locale)}
        </button>
      </div>
      {replayError !== undefined ? <div className="callout callout--error">{replayError}</div> : null}
    </div>
  )
}
