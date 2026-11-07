export interface WorkbenchDrawerProps {
  conversationId?: number
}

export function WorkbenchDrawer({ conversationId }: WorkbenchDrawerProps) {
  return (
    <aside className="helm-workbench" style={{ padding: 16 }}>
      <div>Workbench #{conversationId ?? '-'}</div>
    </aside>
  )
}
