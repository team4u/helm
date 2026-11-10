import { Component, type ReactNode } from 'react'
import { HelmIcon } from '../lib/icons.js'

/** 插件渲染异常只影响当前扩展视图，宿主导航和其他会话仍可使用。 */
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
        <strong>{this.props.label ?? '界面'}渲染失败</strong>
        <p className="selectable">{this.state.message}</p>
        <button className="btn btn-sm" onClick={() => this.setState({ message: null })}>重新渲染</button>
      </div>
    </div>
  }
}
