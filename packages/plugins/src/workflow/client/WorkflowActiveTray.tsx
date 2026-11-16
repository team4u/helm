/**
 * builtin:workflow 底部在途活动托盘（COMPOSER_DOCK_SLOT 扩展点）：
 * 仅当当前会话或其后代存在在途任务（running / blocked / 后台子代理）时
 * 渲染 32px 紧凑单行 HUD，支持展开并发列表与一键直达工作台/抽屉/中止/转后台；
 * 全部收敛结算后返回 null（0px，绝不占位）。
 */
import { useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { formatDurationMs, useConversations, usePluginContext } from '@helm/plugin-client'
import { useElapsedNowMs, usePluginSessionDoc } from './hooks.ts'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { buildActiveTraySummary } from './model-active-tray.ts'
import { requestWorkbenchRunFocus } from './workbench-focus.ts'

export function WorkflowActiveTray(props: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const conversationId = props.conversation?.id ?? ctx.conversationId
  const runsDoc = usePluginSessionDoc<{ runs: WorkflowRunSummary[] }>(
    'runs',
    conversationId !== undefined ? { conversationId } : undefined,
  )
  const conversations = useConversations()
  const [expanded, setExpanded] = useState(false)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)
  const listId = useId()

  useEffect(() => {
    setExpanded(false)
  }, [conversationId])

  const ownedBy =
    props.conversation?.ownedBy ??
    conversations.find((c) => c.id === conversationId)?.ownedBy

  const summary = useMemo(
    () =>
      conversationId === undefined
        ? undefined
        : buildActiveTraySummary({
            rootConversationId: conversationId,
            conversations,
            runs: runsDoc?.runs ?? [],
            viewer: { conversationId, ownedBy },
          }),
    [conversationId, conversations, runsDoc, ownedBy],
  )

  const hasTimer = summary !== undefined && summary.items.length > 0 && summary.earliestStartedAt !== undefined
  const nowMs = useElapsedNowMs(hasTimer)

  if (conversationId === undefined || summary === undefined || summary.items.length === 0) {
    return null
  }

  const runAction = (key: string, actionId: string, runId: string, successMessage?: string): void => {
    if (busyKey !== undefined) return
    setBusyKey(key)
    void ctx
      .callAction(actionId, { runId })
      .then(() => {
        if (successMessage !== undefined) ctx.notify(successMessage)
      })
      .catch((err: unknown) => {
        ctx.notify(`${actionId === 'abort' ? '中止' : '转入后台'}失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      })
      .finally(() => {
        setBusyKey(undefined)
      })
  }

  const countText =
    summary.blockedCount > 0
      ? summary.runningCount > 0
        ? `${summary.blockedCount} 项待审批 · ${summary.runningCount} 项运行中`
        : `${summary.blockedCount} 项待审批`
      : `${summary.activeCount} 项运行中`

  const singleProgress =
    summary.items.length === 1 ? summary.items[0]!.progress : undefined

  const frontlineText =
    summary.approvals.length > 0
      ? summary.approvals.map((a) => a.text).join(' · ')
      : summary.frontline.length > 0
        ? summary.frontline.map((f) => f.text).join(' · ')
        : summary.items.map((i) => i.title).slice(0, 2).join(' · ')

  const hudElapsed =
    nowMs !== undefined && summary.earliestStartedAt !== undefined && nowMs >= summary.earliestStartedAt
      ? formatDurationMs(nowMs - summary.earliestStartedAt)
      : undefined

  return (
    <div
      className={`workflow-active-tray${summary.blockedCount > 0 ? ' workflow-active-tray-warn' : ''}`}
      role="region"
      aria-label="在途编排任务"
    >
      <div className="workflow-active-tray-bar">
        <div className="workflow-active-tray-left">
          <Icon
            name={summary.blockedCount > 0 ? 'clock' : 'loader'}
            size={12}
            className={summary.blockedCount > 0 ? 'workflow-tray-icon-warn' : `${SPIN} workflow-tray-icon-accent`}
          />
          <span className={`badge ${summary.blockedCount > 0 ? 'badge-warn' : 'badge-accent'} workflow-trace-badge`}>
            {countText}
          </span>
          {singleProgress !== undefined ? (
            <span className="badge badge-neutral workflow-trace-badge tabular-nums">
              {`${singleProgress.done}/${singleProgress.total}`}
            </span>
          ) : null}
          {frontlineText !== '' ? (
            <span className="workflow-active-tray-frontline">{frontlineText}</span>
          ) : null}
        </div>
        <div className="workflow-active-tray-right">
          {hudElapsed !== undefined ? (
            <span className="workflow-active-tray-elapsed tabular-nums">{hudElapsed}</span>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-up'} size={11} />
            <span>{expanded ? '收起' : '展开'}</span>
          </button>
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => {
              const singleRunId = summary.items.length === 1 ? summary.items[0]?.runId : undefined
              if (singleRunId !== undefined) requestWorkbenchRunFocus(conversationId, singleRunId)
              ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
            }}
          >
            <Icon name="git-branch" size={11} />
            <span>工作台</span>
          </button>
        </div>
      </div>
      {expanded ? (
        <div id={listId} className="workflow-active-tray-list">
          {summary.items.map((item) => {
            const itemElapsed =
              nowMs !== undefined && item.startedAt !== undefined && nowMs >= item.startedAt
                ? formatDurationMs(nowMs - item.startedAt)
                : undefined
            return (
              <div key={item.key} className="workflow-active-tray-row">
                <div className="workflow-active-tray-row-main">
                  <Icon
                    name={item.isBlocked ? 'clock' : 'loader'}
                    size={11}
                    className={item.isBlocked ? 'workflow-tray-icon-warn' : `${SPIN} workflow-tray-icon-accent`}
                  />
                  <span className="workflow-active-tray-row-title">{item.title}</span>
                  {item.progress !== undefined ? (
                    <span className="badge badge-neutral workflow-trace-badge tabular-nums">
                      {`${item.progress.done}/${item.progress.total}`}
                    </span>
                  ) : null}
                  {item.doing !== undefined ? (
                    <span className="workflow-active-tray-row-doing">{item.doing}</span>
                  ) : null}
                </div>
                <div className="workflow-active-tray-row-actions">
                  {itemElapsed !== undefined ? (
                    <span className="workflow-active-tray-elapsed tabular-nums">{itemElapsed}</span>
                  ) : null}
                  {item.canDetach && item.runId !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-xs"
                      disabled={busyKey !== undefined}
                      onClick={() =>
                        runAction(
                          `detach:${item.runId}`,
                          'detach',
                          item.runId!,
                          `已转入后台（运行 ${item.runId}）：当前调用将收到后台句柄，完成后自动汇报`,
                        )
                      }
                    >
                      <Icon name="arrow-down-to-line" size={11} />
                      <span>转入后台</span>
                    </button>
                  ) : null}
                  {item.canAbort && item.runId !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-xs btn-danger"
                      disabled={busyKey !== undefined}
                      onClick={() => runAction(`abort:${item.runId}`, 'abort', item.runId!)}
                    >
                      <Icon name="square" size={11} />
                      <span>中止</span>
                    </button>
                  ) : null}
                  {item.conversationId !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => ctx.openConversationDrawer(item.conversationId!)}
                    >
                      <span>查看</span>
                    </button>
                  ) : item.runId !== undefined ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      onClick={() => {
                        requestWorkbenchRunFocus(conversationId, item.runId!)
                        ctx.openWorkbench(`plugin:${ctx.pluginId}/tasks`)
                      }}
                    >
                      <span>详情</span>
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
