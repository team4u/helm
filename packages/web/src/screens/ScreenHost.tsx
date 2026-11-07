/**
 * 全屏视图宿主：仅 builtin:herdr/overview 同构映射为专用 Screen，
 * 其余一律走通用声明式 @json-render Spec 渲染（零插件 ID 特判）。
 */
import type { ReactNode } from 'react'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { HerdrOverviewScreen } from './HerdrOverviewScreen.js'

export interface ScreenHostProps {
  pluginId: string
  screenId: string
  isSplit?: boolean
  onCloseSplit?: () => void
}

export function ScreenHost({ pluginId, screenId, isSplit, onCloseSplit }: ScreenHostProps): React.JSX.Element {
  const store = useHelmStore()
  const available = store.groupedUi.screens.some((item) => item.pluginId === pluginId && item.spec.id === screenId)
  if (!available) return <GenericSpecScreen pluginId={pluginId} screenId={screenId} isSplit={isSplit} onCloseSplit={onCloseSplit} />
  // 专用 Screen：仅内核内置的 Herdr 富交互总览视图。
  if (pluginId === 'builtin:herdr' && screenId === 'overview') {
    return <HerdrOverviewScreen isSplit={isSplit} onCloseSplit={onCloseSplit} />
  }
  return <GenericSpecScreen pluginId={pluginId} screenId={screenId} isSplit={isSplit} onCloseSplit={onCloseSplit} />
}

/** 通用兜底：groupedUi.screens 命中即用 PluginUiView 渲染（json/client 双轨）。 */
function GenericSpecScreen({
  pluginId,
  screenId,
  isSplit,
  onCloseSplit,
}: {
  pluginId: string
  screenId: string
  isSplit?: boolean
  onCloseSplit?: () => void
}): ReactNode {
  const store = useHelmStore()
  const matched = store.groupedUi.screens.find(
    (s) => s.pluginId === pluginId && (s.spec as { id?: string }).id === screenId,
  )

  if (matched === undefined) {
    return (
      <div className="helm-pane">
        <div className="pane-topbar">
          <div className="pane-title-group">
            <HelmIcon name="alert-triangle" size={14} />
            <span className="pane-title">
              未找到视图 {pluginId}/{screenId}
            </span>
          </div>
          {isSplit && (
            <div className="pane-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={onCloseSplit}>
                <HelmIcon name="x" size={12} />
                关闭分屏
              </button>
            </div>
          )}
        </div>
        <div className="timeline-scroll">
          <div className="jr-callout jr-callout-warn">
            <HelmIcon name="alert-triangle" size={13} />
            <span>
              该视图不存在或所属插件未启用（{pluginId}/{screenId}）。请确认插件已在设置中启用。
            </span>
          </div>
        </div>
      </div>
    )
  }

  const spec = matched.spec as {
    label?: string
    icon?: string
    json?: Record<string, unknown>
    docs?: string[]
    client?: { module: string; export: string }
  }

  return (
    <div className="helm-pane">
      <div className="pane-topbar">
        <div className="pane-title-group">
          {spec.icon !== undefined && <HelmIcon name={spec.icon} size={14} />}
          <span className="pane-title">{spec.label ?? `${pluginId}/${screenId}`}</span>
        </div>
        {isSplit && (
          <div className="pane-actions">
            <button type="button" className="btn btn-sm btn-ghost" onClick={onCloseSplit}>
              <HelmIcon name="x" size={12} />
              关闭分屏
            </button>
          </div>
        )}
      </div>
      <div className="timeline-scroll">
        <div className="timeline-inner" style={{ maxWidth: 1100 }}>
          <PluginUiView
            pluginId={pluginId}
            spec={spec}
            slotProps={{ pluginId, screenId }}
            label={`视图 ${screenId}`}
          />
        </div>
      </div>
    </div>
  )
}
