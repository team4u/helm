/**
 * ConversationRowActionsMenu：左栏会话行「更多操作」菜单。
 *
 * - 菜单形态：Radix DropdownMenu 封装（Web 规范：操作菜单必须 DropdownMenu），
 *   内容经 Portal 挂载到 body，不再被侧栏滚动容器裁剪；受控 open 由 Radix
 *   负责点击外部 / Escape 关闭与焦点管理，无任何手写浮层与全局监听；
 * - 宿主内置动作：归档会话 / 恢复会话（Web 宿主策略：宿主命名空间 tag，
 *   经现有会话 PATCH 落库；仅对可人工归档管理的会话提供，见 sidebar-model）；
 * - 插件动作：conversation.row.action 微插槽逐项渲染 PluginMicroAction（menu 形态，
 *   inDropdown 参与 Radix 键盘导航；onSelect preventDefault 阻止自动关闭，
 *   需 onInvoked 受控关闭菜单）；
 * - 无任何可渲染动作时整体不渲染，零视觉残留；
 * - Trigger 点击不冒泡（不触发所在行切换会话）；
 * - scope 过滤由 action-model.matchConversationActions 按实际会话判定。
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useGroupedUi, useStoreActions } from '../lib/store-context.js'
import { conversationsApi } from '../lib/api.js'
import { PluginMicroAction } from './PluginMicroAction.js'
import { matchConversationActions } from '../conversation/action-model.js'
import { patchConversationArchived } from '../shell/archive-ops.js'
import { ConfirmDialog } from './AlertDialog.js'
import {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from './DropdownMenu.js'
import {
  isConversationArchivable,
  isConversationArchived,
  isConversationDeletable,
  partitionSidebarUi,
} from '../shell/sidebar-model.js'

export function ConversationRowActionsMenu({
  conversation,
  enableDelete = false,
}: {
  conversation: ConversationSummary
  /** 额外提供「删除会话」项（带确认弹窗；仅对可人类删除的会话渲染）。
   * 侧栏会话行保持默认 false（删除走会话面板），总览卡等大操作面开启。 */
  enableDelete?: boolean
}): ReactNode {
  const groupedUi = useGroupedUi()
  const { pushNotice } = useStoreActions()
  const { t } = useWebLocale()
  const [open, setOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  const actions = matchConversationActions(groupedUi.uiActions, 'conversation:row', conversation)

  // 宿主归档动作可达性：人类自有的根会话可归档；已归档会话始终提供恢复
  // （当前会话若已归档，仍须提供恢复入口）。keptAliveTag 成员视同插件接管。
  const { sectionTags, keptAliveTags } = useMemo(
    () => partitionSidebarUi([], groupedUi.sidebarSections),
    [groupedUi.sidebarSections],
  )
  const archived = isConversationArchived(conversation)
  const hostArchiveAction: 'archive' | 'restore' | null = isConversationArchivable(conversation, sectionTags, keptAliveTags)
    ? archived
      ? 'restore'
      : 'archive'
    : null
  const canDelete = enableDelete && isConversationDeletable(conversation)

  if (actions.length === 0 && hostArchiveAction === null && !canDelete) return null

  const runHostArchiveAction = async (): Promise<void> => {
    if (archiving || hostArchiveAction === null) return
    setArchiving(true)
    try {
      await patchConversationArchived(conversation, hostArchiveAction === 'archive')
      pushNotice({
        type: 'notification',
        level: 'info',
        title: hostArchiveAction === 'archive' ? t('conv.pane.archived') : t('conv.pane.restored'),
        body:
          hostArchiveAction === 'archive'
            ? t('conv.row.archivedBody', { id: conversation.id })
            : t('conv.row.restoredBody', { id: conversation.id }),
      })
      setOpen(false)
    } catch (err) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: hostArchiveAction === 'archive' ? t('conv.row.archiveFailed') : t('conv.row.restoreFailed'),
        body: t('conv.row.errorBody', {
          id: conversation.id,
          error: err instanceof Error ? err.message : String(err),
        }),
      })
    } finally {
      setArchiving(false)
    }
  }

  const menuLabel = hostArchiveAction === null ? t('conv.row.pluginActions') : t('conv.row.actions')

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="btn btn-ghost btn-icon-xs"
          title={menuLabel}
          aria-label={t('conv.row.menuAria', { id: conversation.id, label: menuLabel })}
          onClick={(e) => e.stopPropagation()}
        >
          <HelmxIcon name="more" size={13} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent className="pane-more-popover" align="end" sideOffset={4}>
          {hostArchiveAction !== null && (
            <DropdownMenuItem
              disabled={archiving}
              title={
                hostArchiveAction === 'archive'
                  ? t('conv.row.archiveTitle')
                  : t('conv.row.restoreTitle')
              }
              onSelect={() => {
                void runHostArchiveAction()
              }}
            >
              <span className="pane-more-item-label">
                <HelmxIcon
                  name={archiving ? 'loader' : hostArchiveAction === 'archive' ? 'archive' : 'rotate-ccw'}
                  size={13}
                  className={archiving ? 'spin-slow' : undefined}
                />
                {hostArchiveAction === 'archive' ? t('conv.pane.archiveConversation') : t('conv.pane.restoreConversation')}
              </span>
            </DropdownMenuItem>
          )}
          {actions.map((action) => (
            <PluginMicroAction
              key={`row:${action.pluginId}/${action.spec.id}`}
              action={action}
              variant="menu"
              inDropdown
              conversationId={conversation.id}
              slotProps={{ conversation }}
              onInvoked={() => setOpen(false)}
            />
          ))}
          {canDelete && (
            <>
              <DropdownMenuSeparator className="popover-separator" />
              <DropdownMenuItem
                className="popover-item popover-item-danger"
                danger
                disabled={deleting}
                title={t('conv.pane.deleteConfirmDesc')}
                onSelect={() => {
                  setDeleteConfirmOpen(true)
                }}
              >
                <span className="pane-more-item-label">
                  <HelmxIcon name="trash-2" size={13} />
                  {t('conv.pane.deleteConversation')}
                </span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenuPortal>
      {canDelete && (
        <ConfirmDialog
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          title={t('conv.pane.deleteConfirmTitle', { id: conversation.id })}
          description={t('conv.pane.deleteConfirmDesc')}
          confirmText={t('conv.pane.deleteConversation')}
          danger
          onConfirm={() => {
            setDeleteConfirmOpen(false)
            void (async () => {
              setDeleting(true)
              try {
                await conversationsApi.remove(conversation.id)
                // 导航（若该会话正被打开）由 conversation.deleted SSE 事件统一
                // 处理，这里不做任何目标切换——与会话面板删除同语义。
                pushNotice({
                  type: 'notification',
                  level: 'info',
                  title: t('conv.pane.conversationDeleted'),
                  body: t('conv.pane.conversationDeletedBody', { id: conversation.id }),
                })
              } catch (err) {
                pushNotice({
                  type: 'notification',
                  level: 'error',
                  title: t('conv.pane.deleteFailed'),
                  body: err instanceof Error ? err.message : String(err),
                })
              } finally {
                setDeleting(false)
              }
            })()
          }}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}
    </DropdownMenu>
  )
}
