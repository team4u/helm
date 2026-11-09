import { useEffect } from 'react'
import { ConversationPane } from './ConversationPane.js'

export interface ConversationDrawerProps {
  conversationId: number
  onClose: () => void
}

/**
 * 子代理会话侧边抽屉：
 * - 点击遮罩或右上角关闭按钮均可退出抽屉；
 * - 支持 ESC 键关闭（由宿主与本地 keydown 兜底）；
 * - 内部直接复用 ConversationPane，支持完整时间线、流式输出与继续提问；
 * - 抽屉模式与全屏会话共享底层 store，不产生状态割裂。
 */
export function ConversationDrawer({ conversationId, onClose }: ConversationDrawerProps) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="conversation-drawer-wrapper"
      role="dialog"
      aria-modal="true"
      aria-label={`子会话 #${conversationId} 抽屉`}
    >
      <button
        type="button"
        className="conversation-drawer-backdrop"
        aria-label="关闭子会话抽屉"
        onClick={onClose}
      />
      <aside className="conversation-drawer">
        <ConversationPane
          conversationId={conversationId}
          isDrawer
          onCloseDrawer={onClose}
        />
      </aside>
    </div>
  )
}
