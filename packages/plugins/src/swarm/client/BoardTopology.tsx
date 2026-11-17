/**
 * Adaptive collaboration topology:
 * - Wide full-screen: orthogonal Manhattan SVG collaboration graph (coordinator
 *   + member nodes + aggregated handoff edges; click member -> 540px drawer,
 *   click edge -> filter stream);
 * - Split pane or narrow viewport (<= 680px): compact horizontal role pill bar.
 *
 * Component & type exports only (Fast Refresh compliant).
 */
import { useId, useMemo } from 'react'
import type { ReactNode } from 'react'
import { HelmIcon, StatusLight, usePluginLocale, usePluginTranslator } from '@helm/plugin-client'
import {
  computeOrthogonalTopology,
  type BoardViewDoc,
} from './board-model.ts'
import {
  SW_TOPO_COORDINATOR_NODE,
  SW_TOPO_GRAPH_ARIA,
  SW_TOPO_NO_MEMBERS,
  swMemberLiveStateLabel,
  swUnreadCursorBadge,
} from './copy.ts'

export interface BoardTopologySectionProps {
  board: BoardViewDoc
  compact: boolean
  highlightedWorker?: string
  activeEdgeFilter?: { from: string; to: string }
  activeMemberFilter?: string
  onOpenMemberDrawer: (memberName: string) => void
  onToggleEdgeFilter: (edge: { from: string; to: string }) => void
  onToggleMemberFilter: (memberName: string) => void
}

export function BoardTopologySection({
  board,
  compact,
  highlightedWorker,
  activeEdgeFilter,
  activeMemberFilter,
  onOpenMemberDrawer,
  onToggleEdgeFilter,
  onToggleMemberFilter,
}: BoardTopologySectionProps): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const markerBaseId = useId().replace(/:/g, '')

  const layout = useMemo(
    () => computeOrthogonalTopology(board, t(SW_TOPO_COORDINATOR_NODE)),
    [board, t],
  )

  if (compact) {
    return (
      <div className="sw-role-pill-bar" data-topology-mode="pills">
        <button
          type="button"
          className={`sw-role-pill${activeMemberFilter === 'coordinator' ? ' is-selected' : ''}`}
          data-member="coordinator"
          onClick={() => onToggleMemberFilter('coordinator')}
        >
          <HelmIcon name="shield" size={11} />
          <span className="mono">@coordinator</span>
        </button>
        {board.members.length === 0 ? (
          <span className="sw-muted">{t(SW_TOPO_NO_MEMBERS)}</span>
        ) : (
          board.members.map((member) => {
            const unread = Math.max(0, member.pendingWakeupSeq - member.readCursorSeq)
            const isHighlighted = highlightedWorker === member.name
            return (
              <button
                key={member.name}
                type="button"
                data-member={member.name}
                className={`sw-role-pill${isHighlighted ? ' is-highlighted' : ''}${member.lifecycle === 'archived' ? ' is-archived' : ''}`}
                onClick={() => onOpenMemberDrawer(member.name)}
              >
                <StatusLight
                  status={member.liveState}
                  label={swMemberLiveStateLabel(member.liveState, locale)}
                />
                <HelmIcon name={member.isolation === 'worktree' ? 'git-branch' : 'bot'} size={11} />
                <span className="mono">@{member.name}</span>
                {member.access === 'readonly' ? (
                  <span className="badge badge-neutral">ro</span>
                ) : null}
                {unread > 0 ? (
                  <span className="badge badge-warn tabular-nums">
                    {swUnreadCursorBadge(unread, locale)}
                  </span>
                ) : null}
              </button>
            )
          })
        )}
      </div>
    )
  }

  const arrowId = `sw-arrow-${markerBaseId}`
  const arrowActiveId = `sw-arrow-active-${markerBaseId}`

  return (
    <div className="sw-topo-svg-wrap" data-topology-mode="svg">
      <svg
        className="sw-topo-svg"
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={t(SW_TOPO_GRAPH_ARIA)}
      >
        <defs>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" className="sw-topo-arrow-fill" />
          </marker>
          <marker
            id={arrowActiveId}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" className="sw-topo-arrow-fill-active" />
          </marker>
        </defs>

        {layout.edges.map((edge) => {
          const selected =
            activeEdgeFilter?.from === edge.from && activeEdgeFilter?.to === edge.to
          return (
            <g
              key={edge.key}
              className={`sw-topo-edge${selected ? ' is-selected' : ''}`}
              data-edge={edge.key}
              role="button"
              tabIndex={0}
              aria-label={`${edge.from} -> ${edge.to} (${edge.count})`}
              onClick={() => onToggleEdgeFilter({ from: edge.from, to: edge.to })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onToggleEdgeFilter({ from: edge.from, to: edge.to })
                }
              }}
            >
              <path d={edge.path} className="sw-topo-edge-hit" />
              <path
                d={edge.path}
                className="sw-topo-edge-line"
                markerEnd={`url(#${selected ? arrowActiveId : arrowId})`}
              />
              <text x={edge.labelX} y={edge.labelY} textAnchor="middle" className="sw-topo-edge-label">
                {`${edge.count}x #${edge.lastSeq}`}
              </text>
            </g>
          )
        })}

        {layout.nodes.map((node) => {
          const member = node.member
          const isHighlighted =
            (!node.isCoordinator && highlightedWorker === node.id) ||
            (node.isCoordinator && activeMemberFilter === 'coordinator')
          const state = member?.liveState ?? 'idle'
          const subtitle = node.isCoordinator
            ? `#${board.group.coordinatorConversationId}`
            : `${member?.profileId ?? ''} · ${state}${member?.access === 'readonly' ? ' · ro' : ''}`

          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              className={`sw-topo-node state-${state}${isHighlighted ? ' is-highlighted' : ''}${member?.lifecycle === 'archived' ? ' is-archived' : ''}`}
              data-member={node.id}
              role="button"
              tabIndex={0}
              aria-label={node.label}
              onClick={() => {
                if (node.isCoordinator) onToggleMemberFilter('coordinator')
                else onOpenMemberDrawer(node.id)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (node.isCoordinator) onToggleMemberFilter('coordinator')
                  else onOpenMemberDrawer(node.id)
                }
              }}
            >
              <rect
                x={0}
                y={0}
                width={node.width}
                height={node.height}
                rx={8}
                ry={8}
                className="sw-topo-node-rect"
              />
              <circle cx={14} cy={19} r={4} className={`sw-topo-dot dot-${state}`} />
              <text x={24} y={23} className="sw-topo-node-title">
                {node.label}
              </text>
              <text x={14} y={41} className="sw-topo-node-sub">
                {subtitle}
              </text>
              {node.unreadCount > 0 ? (
                <text x={node.width - 10} y={22} textAnchor="end" className="sw-topo-node-unread">
                  {`+${node.unreadCount}`}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      {board.members.length === 0 ? (
        <div className="sw-muted sw-topo-empty-note">{t(SW_TOPO_NO_MEMBERS)}</div>
      ) : null}
    </div>
  )
}
