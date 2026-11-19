import { Component, type ReactNode } from 'react'
import type { LocaleTranslator } from '@helmx/protocol/browser'
import { HelmxIcon } from '../icons.js'
import { usePluginTranslator } from '../i18n.js'
import { uiCopy } from '../ui-copy.js'

export interface ViewBoundaryProps {
  children: ReactNode
  label?: string
}

/** A render failure stays inside its extension view and can be retried. */
class RenderBoundary extends Component<ViewBoundaryProps & { translate: LocaleTranslator }, { message: string | null }> {
  state: { message: string | null } = { message: null }
  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) }
  }
  render() {
    if (!this.state.message) return this.props.children
    const t = this.props.translate
    const label = this.props.label ?? t(uiCopy.view)
    return <div className="callout callout--error" role="alert">
      <HelmxIcon name="alert-triangle" />
      <div>
        <strong>{t({ en: `${label} failed to render`, 'zh-CN': `${label}渲染失败` })}</strong>
        <p className="selectable">{this.state.message}</p>
        <button className="btn btn-sm" onClick={() => this.setState({ message: null })}>{t(uiCopy.renderAgain)}</button>
      </div>
    </div>
  }
}

/** Keep the error state intact when the shared UI locale changes. */
export function ViewBoundary(props: ViewBoundaryProps): ReactNode {
  const translate = usePluginTranslator()
  return <RenderBoundary {...props} translate={translate} />
}
