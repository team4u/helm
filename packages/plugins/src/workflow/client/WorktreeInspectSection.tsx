/**
 * builtin:workflow plugin managed worktree read-only change overview
 * component (collapsible): when expanded it runs real read-only git commands
 * on the target node via the inspect_worktree action (owned by the sibling
 * builtin:worktree plugin; calls address it cross-plugin), showing registration
 * metadata, status stats and a capped diff preview; "Ask the main
 * conversation to review and merge" only submits a review request text to
 * the parent conversation (the official submitInput capability) — the Web
 * side performs no git writes and does not re-implement a merge state
 * machine.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CopyButton, resolveLocalizedText, usePluginContext, usePluginLocale } from '@helmx/plugin-client'
import { Icon } from './WorkflowIcon.tsx'
import { buildWorktreeReviewRequest, buildWorktreeSelector, parseWorktreeInspectResult } from './model-worktree.ts'
import type { WorktreeInspectView } from './model-worktree.ts'
import {
  SPIN,
  WT_BRANCH_MISMATCH,
  WT_COLLAPSE_TITLE,
  WT_COPY_REVIEW,
  WT_DIFF_NOTE,
  WT_DIFF_PREVIEW_SECTION,
  WT_DIFF_TRUNCATED,
  wtDiffStatSection,
  WT_EXPAND_TITLE,
  WT_INSPECTING,
  wtInspectFailed,
  wtInspectInvalid,
  WT_KV_AHEAD,
  WT_KV_BASE,
  WT_KV_BRANCH,
  WT_KV_DIRTY,
  WT_KV_HEAD,
  wtAheadCount,
  wtDirtyCount,
  WT_NO_BASE,
  WT_NO_DIFF,
  WT_NO_DIRTY,
  WT_OVERVIEW,
  WT_REINSPECT_TITLE,
  WT_REFRESH,
  WT_RETRY,
  WT_REVIEW_BUTTON,
  WT_REVIEW_TITLE,
  WT_SUBMITTED,
  WT_UNAVAILABLE_MISSING,
  WT_UNAVAILABLE_REMOVED,
  wtSubmitFailed,
  wtUnavailableCta,
  wtBaseValue,
  wtBranchMismatchBadgeTitle,
} from './copy.ts'

/**
 * Managed worktree read-only change overview (collapsible): when expanded it
 * runs real read-only git commands on the target node via the
 * inspect_worktree action, showing registration metadata, status stats and a
 * capped diff preview; "Ask the main conversation to review and merge" only
 * submits a review request text to the parent conversation (the official
 * submitInput capability) — the Web side performs no git writes and does not
 * re-implement a merge state machine.
 */
export function WorktreeInspectSection(props: {
  worktree: { id?: string; path: string; branch: string }
  nodeId?: string
  baseCommit?: string
  taskLabel?: string
  parentConversationId: number
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { worktree } = props
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [data, setData] = useState<WorktreeInspectView | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const generation = useRef(0)

  const load = async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const raw = await ctx.callAction('inspect_worktree', buildWorktreeSelector(worktree, props.nodeId), { pluginId: 'builtin:worktree' })
      if (generation.current !== current) return
      const parsed = parseWorktreeInspectResult(raw)
      if (parsed === undefined) {
        setError(wtInspectInvalid(locale))
      } else {
        setData(parsed)
      }
    } catch (err) {
      if (generation.current !== current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }

  useEffect(() => {
    // Fetch on first expansion only; re-expansions reuse the cache (the
    // manual refresh button triggers separately).
    if (open && data === undefined && error === undefined && !loading) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, worktree.path, worktree.id])

  const reviewText = useMemo(
    () =>
      buildWorktreeReviewRequest(
        {
          path: worktree.path,
          branch: data?.branch ?? worktree.branch,
          nodeId: data?.nodeId ?? props.nodeId,
          baseCommit: data?.baseCommit || props.baseCommit,
          taskLabel: props.taskLabel,
          ...(data !== undefined ? { inspect: data } : {}),
        },
        locale,
      ),
    [worktree.path, worktree.branch, props.nodeId, props.baseCommit, props.taskLabel, data, locale],
  )

  const sendReview = (): void => {
    setSending(true)
    ctx
      .submitInput(reviewText, { conversationId: props.parentConversationId, whenBusy: 'steer' })
      .then(() => ctx.notify(resolveLocalizedText(WT_SUBMITTED, locale)))
      .catch((err: unknown) => ctx.notify(wtSubmitFailed(err instanceof Error ? err.message : String(err), locale), 'error'))
      .finally(() => setSending(false))
  }

  const unavailableText =
    data?.unavailableReason === 'removed'
      ? resolveLocalizedText(WT_UNAVAILABLE_REMOVED, locale)
      : data?.unavailableReason === 'directory_missing'
        ? resolveLocalizedText(WT_UNAVAILABLE_MISSING, locale)
        : undefined

  return (
    <div className="worktree-inspect">
      <div className="worktree-inspect-header">
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          onClick={() => setOpen((v) => !v)}
          title={resolveLocalizedText(open ? WT_COLLAPSE_TITLE : WT_EXPAND_TITLE, locale)}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={11} />
          <Icon name="git-branch" size={11} />
          {resolveLocalizedText(WT_OVERVIEW, locale)}
        </button>
        {open && data !== undefined ? (
          <button type="button" className="btn btn-ghost btn-xs" disabled={loading} onClick={() => void load()} title={resolveLocalizedText(WT_REINSPECT_TITLE, locale)}>
            <Icon name="rotate-cw" size={11} className={loading ? SPIN : undefined} />
            {resolveLocalizedText(WT_REFRESH, locale)}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="worktree-inspect-body">
          {loading && data === undefined ? <div className="workflow-phase-empty">{resolveLocalizedText(WT_INSPECTING, locale)}</div> : null}
          {error !== undefined ? (
            <div className="callout callout--error worktree-inspect-error">
              <div>{wtInspectFailed(error, locale)}</div>
              <button type="button" className="btn btn-xs" onClick={() => void load()}>
                {resolveLocalizedText(WT_RETRY, locale)}
              </button>
            </div>
          ) : null}
          {data !== undefined ? (
            <>
              {unavailableText !== undefined ? (
                <div className="callout callout--warning">{wtUnavailableCta(unavailableText, locale)}</div>
              ) : null}
              <div className="kv-grid">
                <span className="kv-key">{resolveLocalizedText(WT_KV_BRANCH, locale)}</span>
                <span className="kv-val mono">
                  {data.currentBranch ?? data.branch}
                  {data.branchChanged === true ? (
                    <span className="badge badge-warn" title={wtBranchMismatchBadgeTitle(data.branch, locale)}>{resolveLocalizedText(WT_BRANCH_MISMATCH, locale)}</span>
                  ) : null}
                </span>
                <span className="kv-key">{resolveLocalizedText(WT_KV_BASE, locale)}</span>
                <span className="kv-val mono" title={data.baseCommit !== '' ? data.baseCommit : undefined}>
                  {data.baseCommit !== '' ? wtBaseValue(data.baseCommit, data.diffBase, locale) : resolveLocalizedText(WT_NO_BASE, locale)}
                </span>
                <span className="kv-key">{resolveLocalizedText(WT_KV_DIRTY, locale)}</span>
                <span className="kv-val">{wtDirtyCount(data.dirtyFileCount, data.dirtyFilesTruncated, locale)}</span>
                {data.commitsAhead !== undefined ? (
                  <>
                    <span className="kv-key">{resolveLocalizedText(WT_KV_AHEAD, locale)}</span>
                    <span className="kv-val">{wtAheadCount(data.commitsAhead, locale)}</span>
                  </>
                ) : null}
                {data.currentHead !== undefined ? (
                  <>
                    <span className="kv-key">{resolveLocalizedText(WT_KV_HEAD, locale)}</span>
                    <span className="kv-val mono">{data.currentHead.slice(0, 12)}</span>
                  </>
                ) : null}
              </div>
              {data.dirtyFiles.length > 0 ? (
                <pre className="code-block-pre worktree-inspect-files"><code>{data.dirtyFiles.join('\n')}</code></pre>
              ) : data.exists ? (
                <div className="workflow-phase-empty">{resolveLocalizedText(WT_NO_DIRTY, locale)}</div>
              ) : null}
              {data.exists ? (
                <div className="worktree-inspect-note">{resolveLocalizedText(WT_DIFF_NOTE, locale)}</div>
              ) : null}
              {data.diffStat !== undefined ? (
                <div>
                  <div className="trace-section-label">{wtDiffStatSection(data.diffBase, locale)}</div>
                  <pre className="code-block-pre workflow-node-pre"><code>{data.diffStat}</code></pre>
                </div>
              ) : null}
              {data.diffPreview !== undefined ? (
                <div>
                  <div className="trace-section-label">
                    {resolveLocalizedText(WT_DIFF_PREVIEW_SECTION, locale)}
                    {data.diffTruncated ? <span className="badge badge-neutral">{resolveLocalizedText(WT_DIFF_TRUNCATED, locale)}</span> : null}
                  </div>
                  <pre className="code-block-pre workflow-node-pre worktree-inspect-diff selectable"><code>{data.diffPreview}</code></pre>
                </div>
              ) : data.exists ? (
                <div className="workflow-phase-empty">{resolveLocalizedText(WT_NO_DIFF, locale)}</div>
              ) : null}
            </>
          ) : null}
          <div className="worktree-inspect-actions">
            <button type="button" className="btn btn-xs" disabled={sending} onClick={sendReview} title={resolveLocalizedText(WT_REVIEW_TITLE, locale)}>
              <Icon name="git-pull-request" size={11} />
              {resolveLocalizedText(WT_REVIEW_BUTTON, locale)}
            </button>
            <CopyButton text={reviewText} label={resolveLocalizedText(WT_COPY_REVIEW, locale)} />
          </div>
        </div>
      ) : null}
    </div>
  )
}
