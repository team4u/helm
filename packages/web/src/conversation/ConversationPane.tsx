export interface ConversationPaneProps {
  conversationId: number
  isSplit?: boolean
  onCloseSplit?: () => void
}

export function ConversationPane({ conversationId }: ConversationPaneProps) {
  return (
    <div className="helm-pane" style={{ padding: 24 }}>
      <div>Conversation #{conversationId}</div>
    </div>
  )
}
