import { Component, type ReactNode } from 'react'
import { HelmIcon } from '../icons.js'

/**
 * A plugin render failure only affects the current extension view; the host
 * navigation and other conversations remain usable. The fixed texts below
 * (default label / heading / retry button) are SDK defaults in English; pass
 * the label prop to override the default for host-side localization.
 */
export class ViewBoundary extends Component<{ children: ReactNode; label?: string }, { message: string | null }> {
  state: { message: string | null } = { message: null }
  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) }
  }
  render() {
    if (!this.state.message) return this.props.children
    return <div className="callout callout--error" role="alert">
      <HelmIcon name="alert-triangle" />
      <div>
        <strong>{this.props.label ?? 'View'} failed to render</strong>
        <p className="selectable">{this.state.message}</p>
        <button className="btn btn-sm" onClick={() => this.setState({ message: null })}>Render again</button>
      </div>
    </div>
  }
}
