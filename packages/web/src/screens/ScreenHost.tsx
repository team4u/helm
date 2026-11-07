export interface ScreenHostProps {
  pluginId: string
  screenId: string
  isSplit?: boolean
  onCloseSplit?: () => void
}

export function ScreenHost({ pluginId, screenId }: ScreenHostProps) {
  return (
    <div className="helm-pane" style={{ padding: 24 }}>
      <div>
        Screen: {pluginId}/{screenId}
      </div>
    </div>
  )
}
