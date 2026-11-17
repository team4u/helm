/**
 * 全屏视图宿主：所有 screen 一律经 PluginUiView 渲染（json / client 双轨，零插件 ID 特判）。
 * 主屏 / 分屏分别由 App 传入对应 target；本组件把 params / isSplit / setParams
 * 组装为协议标准 ScreenProps 经 slotProps 注入插件组件。
 */
import * as React from 'react'
import { useMemo } from 'react'
import { HelmIcon } from '@helm/plugin-client'
import { resolveLocalizedText, type ScreenSpec } from '@helm/protocol/browser'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useHelmStore } from '../lib/store-context.js'
import type { ResolvedTarget } from '../lib/types.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'

export interface ScreenHostProps {
  pluginId: string
  screenId: string
  isSplit?: boolean
  onCloseSplit?: () => void
}

export function ScreenHost({ pluginId, screenId, isSplit, onCloseSplit }: ScreenHostProps): React.JSX.Element {
  const store = useHelmStore()
  const { locale, t } = useWebLocale()
  const matched = store.groupedUi.screens.find(
    (s) => s.pluginId === pluginId && (s.spec as { id?: string }).id === screenId,
  )

  // 参数取自当前屏（主/分屏各自独立），setParams 同样绑定到当前屏的 store 方法。
  const target: ResolvedTarget | null = isSplit ? store.splitTarget : store.primaryTarget
  const slotProps = useMemo<Record<string, unknown>>(() => {
    const params =
      target !== null && target.kind === 'screen' && target.pluginId === pluginId && target.screenId === screenId
        ? target.params ?? {}
        : {}
    return {
      pluginId,
      screenId,
      isSplit: isSplit === true,
      params,
      setParams: (patch: Record<string, string | undefined>, options?: { push?: boolean }) =>
        store.setScreenParams(patch, { split: isSplit === true, push: options?.push }),
    }
  }, [pluginId, screenId, isSplit, target, store])

  const toggleSplit = () => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (store.splitTarget !== null) {
      store.closeSplit()
      return
    }
    store.openTarget(
      {
        kind: 'screen',
        pluginId,
        screenId,
        params: target !== null && target.kind === 'screen' ? target.params : undefined,
      },
      { split: true },
    )
  }

  if (matched === undefined) {
    return (
      <div className="helm-pane">
        <div className="pane-topbar">
          <div className="pane-title-group">
            <HelmIcon name="alert-triangle" size={14} />
            <span className="pane-title">
              {t('shell.screen.notFoundTitle', { pluginId, screenId })}
            </span>
          </div>
          <div className="pane-actions">
            {isSplit ? (
              <CloseSplitButton onCloseSplit={onCloseSplit} />
            ) : (
              <SplitToggleButton
                isSplitActive={store.splitTarget !== null}
                onToggleSplit={toggleSplit}
              />
            )}
          </div>
        </div>
        <div className="timeline-scroll">
          <div className="callout callout-warn">
            <HelmIcon name="alert-triangle" size={13} />
            <span>
              {t('shell.screen.notFoundBody', { pluginId, screenId })}
            </span>
          </div>
        </div>
      </div>
    )
  }

  // 视图标题（ScreenSpec.label）属 LocalizedText 显示元数据：按 store 权威 locale 解析。
  const spec = matched.spec as ScreenSpec

  return (
    <div className="helm-pane">
      <div className="pane-topbar">
        <div className="pane-title-group">
          {spec.icon !== undefined && <HelmIcon name={spec.icon} size={14} />}
          <span className="pane-title">{resolveLocalizedText(spec.label, locale) || `${pluginId}/${screenId}`}</span>
        </div>
        <div className="pane-actions">
          {isSplit ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton
              isSplitActive={store.splitTarget !== null}
              onToggleSplit={toggleSplit}
            />
          )}
        </div>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-inner screen-host-stage" data-screen-host="true" style={{ maxWidth: 1100 }}>
          <PluginUiView
            pluginId={pluginId}
            spec={spec}
            slotProps={slotProps}
            label={t('shell.screen.viewLabel', { id: screenId })}
          />
        </div>
      </div>
    </div>
  )
}
