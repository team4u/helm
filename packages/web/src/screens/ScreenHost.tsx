/**
 * 全屏视图宿主：按 pluginId/screenId 路由到专用 Screen（Herdr 总览、
 * SuperAgent 记忆图谱）或通用声明式 @json-render 兜底。
 */
import type { ReactNode } from 'react'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { HelmSpecView } from '../ui/HelmSpecView.js'
import { HerdrOverviewScreen } from './HerdrOverviewScreen.js'
import { RecallGraphScreen } from './RecallGraphScreen.js'

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
  // 专用 Screen：内核内置的两个富交互视图
  if (pluginId === 'builtin:herdr' && screenId === 'overview') {
    return <HerdrOverviewScreen isSplit={isSplit} onCloseSplit={onCloseSplit} />
  }
  if (pluginId === 'builtin:superagent' && screenId === 'recall-graph') {
    return <RecallGraphScreen isSplit={isSplit} onCloseSplit={onCloseSplit} />
  }
  return <GenericSpecScreen pluginId={pluginId} screenId={screenId} isSplit={isSplit} onCloseSplit={onCloseSplit} />
}

/** 通用声明式兜底：groupedUi.screens 命中即用 HelmSpecView 渲染。 */
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
          {spec.json !== undefined ? (
            <HelmSpecView pluginId={pluginId} spec={spec.json} docs={spec.docs} />
          ) : (
            <div className="jr-callout jr-callout-warn">
              <HelmIcon name="alert-triangle" size={13} />
              <span>该视图需要 client.tsx 组件。当前宿主尚未接入该加载通道，请提供 JSON Spec。</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
