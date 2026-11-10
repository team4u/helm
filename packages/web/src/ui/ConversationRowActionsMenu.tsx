/**
 * ConversationRowActionsMenu：左栏会话行「插件操作」悬停菜单
 * （conversation.row.action 微插槽宿主挂载）。
 *
 * - 悬停显示「更多插件操作」图标按钮（无插件动作时整体不渲染，零视觉残留）；
 * - 点击展开极简下拉菜单，逐项渲染 PluginMicroAction（menu 形态）；
 * - 点击外部 / Escape 关闭；菜单点击不冒泡（不触发所在行切换会话）；
 * - scope 过滤由 action-model.matchConversationActions 按实际会话判定。
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginMicroAction } from './PluginMicroAction.js'
import { matchConversationActions } from '../conversation/action-model.js'

export function ConversationRowActionsMenu({ conversation }: { conversation: ConversationSummary }): ReactNode {
  const store = useHelmStore()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  const actions = matchConversationActions(store.groupedUi.uiActions, 'conversation:row', conversation)

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

  if (actions.length === 0) return null

  return (
    <span className="conv-row-actions-menu" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="btn btn-ghost btn-icon-xs"
        title="插件会话操作"
        aria-label={`会话 #${conversation.id} 插件操作`}
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
