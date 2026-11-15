/**
 * ConversationRowActionsMenu：左栏会话行「更多操作」悬停菜单。
 *
 * - 宿主内置动作：归档会话 / 恢复会话（Web 宿主策略：宿主命名空间 tag，
 *   经现有会话 PATCH 落库；仅对可人工归档管理的会话提供，见 sidebar-model）；
 * - 插件动作：conversation.row.action 微插槽逐项渲染 PluginMicroAction（menu 形态）；
 * - 无任何可渲染动作时整体不渲染，零视觉残留；
 * - 点击外部 / Escape 关闭；菜单点击不冒泡（不触发所在行切换会话）；
 * - scope 过滤由 action-model.matchConversationActions 按实际会话判定。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { HelmIcon } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { PluginMicroAction } from './PluginMicroAction.js'
import { matchConversationActions } from '../conversation/action-model.js'
import { patchConversationArchived } from '../shell/archive-ops.js'
import {
  isConversationArchivable,
  isConversationArchived,
  partitionSidebarUi,
} from '../shell/sidebar-model.js'

export function ConversationRowActionsMenu({
  conversation,
  showHostArchiveAction = true,
}: {
  conversation: ConversationSummary
  showHostArchiveAction?: boolean
}): ReactNode {
  const store = useHelmStore()
  const [open, setOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  const actions = matchConversationActions(store.groupedUi.uiActions, 'conversation:row', conversation)

  // 宿主归档动作可达性：人类自有的根会话可归档；已归档会话始终提供恢复
  // （当前会话若已归档，仍须提供恢复入口）。
  const sectionTags = useMemo(
    () => partitionSidebarUi([], store.groupedUi.sidebarSections).sectionTags,
    [store.groupedUi.sidebarSections],
  )
  const archived = isConversationArchived(conversation)
  const hostArchiveAction: 'archive' | 'restore' | null = !showHostArchiveAction
    ? null
    : isConversationArchivable(conversation, sectionTags)
      ? archived
        ? 'restore'
        : 'archive'
      : null

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (actions.length === 0 && hostArchiveAction === null) return null

  const runHostArchiveAction = async (): Promise<void> => {
    if (archiving || hostArchiveAction === null) return
    setArchiving(true)
    try {
      await patchConversationArchived(conversation, hostArchiveAction === 'archive')
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: hostArchiveAction === 'archive' ? '已归档会话' : '已恢复会话',
        body:
          hostArchiveAction === 'archive'
            ? `会话 #${conversation.id} 已移入侧栏「已归档」分组`
            : `会话 #${conversation.id} 已恢复至智能体列表`,
      })
      setOpen(false)
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: hostArchiveAction === 'archive' ? '归档会话失败' : '恢复会话失败',
        body: `会话 #${conversation.id}：${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      setArchiving(false)
    }
  }

  const menuLabel = hostArchiveAction === null ? '插件会话操作' : '会话操作'

  return (
    <span className="conv-row-actions-menu" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="btn btn-ghost btn-icon-xs"
        title={menuLabel}
        aria-label={`会话 #${conversation.id} ${menuLabel}`}
        aria-expanded={open}
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <HelmIcon name="more" size={13} />
      </button>
      {open ? (
        <div className="pane-more-popover conv-row-actions-popover">
          {hostArchiveAction !== null && (
            <button
              type="button"
              className="popover-item"
              disabled={archiving}
              title={
                hostArchiveAction === 'archive'
                  ? '归档后从智能体列表移入侧栏「已归档」分组'
                  : '恢复到原智能体的会话列表'
              }
              onClick={(e) => {
                e.stopPropagation()
                void runHostArchiveAction()
              }}
            >
              <span className="pane-more-item-label">
                <HelmIcon
                  name={archiving ? 'loader' : hostArchiveAction === 'archive' ? 'archive' : 'rotate-ccw'}
                  size={13}
                  className={archiving ? 'spin-slow' : undefined}
                />
                {hostArchiveAction === 'archive' ? '归档会话' : '恢复会话'}
              </span>
            </button>
          )}
          {actions.map((action) => (
            <PluginMicroAction
              key={`row:${action.pluginId}/${action.spec.id}`}
              action={action}
              variant="menu"
              conversationId={conversation.id}
              slotProps={{ conversation }}
              onInvoked={() => setOpen(false)}
            />
          ))}
        </div>
      ) : null}
    </span>
  )
}
