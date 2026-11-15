/**
 * 统一执行树父卡内下一级紧凑子项行（ExecutionNode 递归视图组件）：
 * 会话行点击 / 回车打开任意深度会话抽屉；无会话执行行（深层 workflow /
 * external run）原位展开其直系子项（不伪造会话入口），点击均不冒泡触发父卡。
 */
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { formatDurationMs, usePluginContext } from '@helm/plugin-client'
import { useElapsedNowMs } from './hooks.ts'
import { SPIN, EXECUTION_BADGE, EXECUTION_ICON, EXECUTION_LABEL } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import type { ExecutionNode } from './model-execution-tree.ts'
import { executionNodeTitle, resolveExecutionNodeElapsedMs } from './model-execution-view.ts'

export function ExecutionChildrenRows({ nodes }: { nodes: ExecutionNode[] }): ReactNode {
  const ctx = usePluginContext()
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined)
  // 父级统一秒表：仅当本级存在运行中的真实边界（runNode / 无 runNode 的
  // run）才启动，单一 interval 供本级全部行复用（避免每行各建 interval）；
  // 递归子层是独立组件实例，各自持表不违反 hooks 规则。
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
        const title = executionNodeTitle(node)
        const openConversation =
          node.conversationId !== undefined ? () => ctx.openConversationDrawer(node.conversationId!) : undefined
        // 无会话执行节点（深层 workflow / external run）：原位展开直系子项。
        const expandable = openConversation === undefined && node.children.length > 0
        const expanded = expandable && expandedKey === node.key
        const activate =
          openConversation ??
          (expandable ? () => setExpandedKey((current) => (current === node.key ? undefined : node.key)) : undefined)
        const doing =
          aggregated.status === 'working' && node.summary?.doing !== undefined
            ? node.summary.doing.trim()
            : undefined
        // 审批徽章只统计后代（自身 blocked 已由状态徽章表达）。
        const descendantApprovals = aggregated.blocked - (node.status === 'blocked' ? 1 : 0)
        // 总耗时：仅以真实 run/runNode 边界解析（运行中随父级秒表动态、结算
        // 定格持久化 duration；无本轮边界如实省略）。
        const elapsedMs = resolveExecutionNodeElapsedMs(node, nowMs)
        return (
          <Fragment key={node.key}>
            <div
              {...(activate !== undefined
                ? {
                    role: 'button' as const,
                    tabIndex: 0,
                    'aria-label': openConversation !== undefined
                      ? `打开会话 #${node.conversationId} 抽屉`
                      : expanded
                        ? `收起 ${title} 直系子项`
                        : `展开 ${title} 直系子项`,
                    ...(expandable ? { 'aria-expanded': expanded } : {}),
                  }
                : {})}
              className={`execution-child-row execution-child-${aggregated.status}${activate !== undefined ? ' execution-child-clickable' : ''}`}
              title={
                [
                  title,
                  openConversation !== undefined
                    ? `点击打开会话 #${node.conversationId} 抽屉`
                    : expandable
                      ? expanded
                        ? '点击收起直系子项'
                        : '点击展开直系子项（深层工作流 / 外部执行，无独立会话）'
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
              <Icon
                name={EXECUTION_ICON[aggregated.status] ?? 'circle'}
                size={11}
                className={aggregated.status === 'working' ? SPIN : undefined}
              />
              {expandable ? (
                <Icon
                  name={expanded ? 'chevron-down' : 'chevron-right'}
                  size={11}
                  className="execution-child-expand"
                />
              ) : null}
              {node.conversationId !== undefined ? (
                <span className="execution-child-id">{`#${node.conversationId}`}</span>
              ) : null}
              <span className="execution-child-title">{title}</span>
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
                  <span className="badge badge-warn">{`审批 ${descendantApprovals}`}</span>
                ) : null}
                {node.children.length > 0 ? (
                  <span className="execution-child-count tabular-nums">{`${aggregated.done}/${aggregated.total}`}</span>
                ) : null}
                <span className={`badge ${EXECUTION_BADGE[aggregated.status] ?? 'badge-neutral'}`}>
                  {EXECUTION_LABEL[aggregated.status] ?? aggregated.status}
                </span>
              </span>
            </div>
            {expanded ? <ExecutionChildrenRows nodes={node.children} /> : null}
          </Fragment>
        )
      })}
    </div>
  )
}
