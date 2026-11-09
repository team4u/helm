import { Dialog, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '../ui/Dialog.js'
import { ConversationPane } from './ConversationPane.js'

export interface ConversationDrawerProps {
  conversationId: number
  onClose: () => void
}

/**
 * 子代理会话侧边抽屉：
 * - 基于 Radix UI Dialog 封装，原语统一；
 * - 点击遮罩或右上角关闭按钮均可退出抽屉；
 * - 原生支持 ESC 键关闭与焦点圈定；
 * - 内部直接复用 ConversationPane，支持完整时间线、流式输出与继续提问；
 * - 抽屉模式与全屏会话共享底层 store，不产生状态割裂。
 */
export function ConversationDrawer({ conversationId, onClose }: ConversationDrawerProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <div className="conversation-drawer-wrapper">
          <DialogOverlay
            className="conversation-drawer-backdrop"
            aria-label="关闭子会话抽屉"
          />
          <DialogContent
            className="conversation-drawer"
            aria-label={`子会话 #${conversationId} 抽屉`}
          >
            <DialogTitle style={{ display: 'none' }}>
              {`子会话 #${conversationId} 抽屉`}
            </DialogTitle>
            <ConversationPane
              conversationId={conversationId}
              isDrawer
              onCloseDrawer={onClose}
            />
          </DialogContent>
        </div>
      </DialogPortal>
    </Dialog>
  )
}

