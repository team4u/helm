/**
 * Compact next-level child rows inside unified execution tree parent cards
 * (recursive ExecutionNode view component): conversation rows open the
 * drawer of any depth on click / Enter; conversation-less execution rows
 * (deep workflow / external runs) expand their direct children in place (no
 * fabricated conversation entry); clicks never bubble into the parent card.
 */
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { StatusLight, formatDurationMs, resolveLocalizedText, usePluginContext, usePluginLocale } from '@helmx/plugin-client'
import { useElapsedNowMs } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { executionLightStatus } from './model-execution-status.ts'
import {
  execApprovalBadge,
  execCollapseChildrenLabel,
  EXEC_COLLAPSE_CHILDREN_TITLE,
  execConversationTitle,
  execExpandChildrenLabel,
  EXEC_EXPAND_CHILDREN_TITLE,
  execOpenConversationLabel,
  execOpenConversationTitle,
  executionStatusLabel,
} from './copy.ts'
import type { ExecutionNode } from './model-execution-tree.ts'
import { executionNodeTitle, resolveExecutionNodeElapsedMs } from './model-execution-view.ts'

export function ExecutionChildrenRows({ nodes }: { nodes: ExecutionNode[] }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined)
  // One shared stopwatch per level: started only when this level has a real
  // running boundary (runNode / run without runNode); a single interval is
  // reused by every row of this level (no per-row intervals); recursive child
  // levels are separate component instances with their own stopwatches,
  // which does not violate the hooks rules.
  const needsTick = nodes.some(
    (node) =>
      node.runNode?.status === 'running' ||
      (node.runNode === undefined && node.run?.status === 'running'),
  )
  const nowMs = useElapsedNowMs(needsTick)
  if (nodes.length === 0) return null
  return (
    <div className="execution-children" onClick={(e) => e.stopPropagation()}>
      {nodes.map((node) => {
        const aggregated = node.aggregated
        const title = executionNodeTitle(node, locale)
        const isFallbackConvTitle =
          node.conversationId !== undefined && title === execConversationTitle(node.conversationId, locale)
        const openConversation =
          node.conversationId !== undefined ? () => ctx.openConversationDrawer(node.conversationId!) : undefined
        // Conversation-less execution nodes (deep workflow / external runs):
        // expand direct children in place.
        const expandable = openConversation === undefined && node.children.length > 0
        const expanded = expandable && expandedKey === node.key
        const activate =
          openConversation ??
          (expandable ? () => setExpandedKey((current) => (current === node.key ? undefined : node.key)) : undefined)
        const doing =
          aggregated.status === 'working' && node.summary?.doing !== undefined
            ? node.summary.doing.trim()
            : undefined
        // The approval badge counts descendants only (the node's own blocked
        // state is already expressed by the status badge).
        const descendantApprovals = aggregated.blocked - (node.status === 'blocked' ? 1 : 0)
        // Total duration: resolved only from real run/runNode boundaries
        // (running advances dynamically with the parent stopwatch, settled
        // freezes at the persisted duration; omitted honestly without a
        // current-turn boundary).
        const elapsedMs = resolveExecutionNodeElapsedMs(node, nowMs)
        return (
          <Fragment key={node.key}>
            <div
              {...(activate !== undefined
                ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    'aria-label': [
                      title,
                      executionStatusLabel(aggregated.status, locale),
                      openConversation !== undefined
                        ? execOpenConversationLabel(node.conversationId!, locale)
                        : expanded
                          ? execCollapseChildrenLabel(title, locale)
                          : execExpandChildrenLabel(title, locale),
                    ].join(' — '),
                    ...(expandable ? { 'aria-expanded': expanded } : {}),
                  }
                : {})}
              className={`execution-child-row execution-child-${aggregated.status}${activate !== undefined ? ' execution-child-clickable' : ''}`}
              title={
                [
                  title,
                  openConversation !== undefined
                    ? execOpenConversationTitle(node.conversationId!, locale)
                    : expandable
                      ? expanded
                        ? resolveLocalizedText(EXEC_COLLAPSE_CHILDREN_TITLE, locale)
                        : resolveLocalizedText(EXEC_EXPAND_CHILDREN_TITLE, locale)
                      : undefined,
                ]
                  .filter(Boolean)
                  .join('\n')
              }
              onClick={activate}
              onKeyDown={
                activate !== undefined
                  ? (e) => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        activate()
                      }
                    }
                  : undefined
              }
            >
              {expandable ? (
                <Icon
                  name={expanded ? 'chevron-down' : 'chevron-right'}
                  size={11}
                  className="execution-child-expand"
                />
              ) : null}
              <span className="execution-child-title">{title}</span>
              {node.conversationId !== undefined && !isFallbackConvTitle ? (
                <span className="execution-child-id tabular-nums">{`#${node.conversationId}`}</span>
              ) : null}
              {doing !== undefined && doing !== '' ? (
                <span className="execution-child-doing" title={doing}>
                  {doing}
                </span>
              ) : null}
              <span className="execution-child-right">
                {elapsedMs !== undefined ? (
                  <span className="execution-child-elapsed tabular-nums">{formatDurationMs(elapsedMs)}</span>
                ) : null}
                {descendantApprovals > 0 ? (
                  <span className="badge badge-warn">{execApprovalBadge(descendantApprovals, locale)}</span>
                ) : null}
                {node.children.length > 0 ? (
                  <span className="execution-child-count tabular-nums">{`${node.children.filter((c) => c.status === 'done' || c.status === 'error').length}/${node.children.length}`}</span>
                ) : null}
                {(() => {
                  const lightStatus = executionLightStatus(
                    aggregated.status,
                    node.run,
                    node.children.length > 0 && aggregated.error > 0,
                  )
                  return <StatusLight status={lightStatus} label={executionStatusLabel(lightStatus, locale)} />
                })()}
              </span>
            </div>
            {expanded ? <ExecutionChildrenRows nodes={node.children} /> : null}
          </Fragment>
        )
      })}
    </div>
  )
}
