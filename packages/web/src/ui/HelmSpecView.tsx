export interface HelmSpecViewProps {
  pluginId?: string
  spec?: Record<string, unknown>
  docs?: string[]
  data?: Record<string, unknown>
  conversationId?: number
}

export function HelmSpecView({ spec }: HelmSpecViewProps) {
  if (!spec) return null
  return <div className="card">{JSON.stringify(spec)}</div>
}
