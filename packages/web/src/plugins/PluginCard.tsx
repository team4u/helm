import React, { useContext, useMemo } from 'react'
import type { PluginSummary } from '@helm/protocol/browser'
import { DEFAULT_HELM_LOCALE, resolveLocalizedText } from '@helm/protocol/browser'
import { HelmIcon, Switch } from '@helm/plugin-client'
import { createWebTranslator } from '../i18n/catalog.js'
import { HelmStoreContext } from '../lib/store-context.js'
import {
  getPluginDescription,
  listPluginScreens,
} from './plugin-card-model.js'
import { isPluginFailed } from './plugin-center-model.js'

export interface PluginCardProps {
  plugin: PluginSummary
  selected: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => Promise<void> | void
  toggling?: boolean
}

/**
 * 全屏插件中心单张插件卡片视图组件：
 * - 响应式网格流单元，遵循 1px 发丝边框与克制低饱和设计规范；
 * - 顶部展示名称、ID（严格靠左对齐）、版本与常驻徽章，零图标杂音；
 * - 中部展示简要功能说明；
 * - 底部展示能力胶囊小徽章（Tools / Actions / Hooks）与快捷启停开关；
 * - 全程零 Emoji，符合无障碍与键盘导航规范。
 */
export function PluginCard({
  plugin,
  selected,
  onSelect,
  onToggle,
  toggling = false,
}: PluginCardProps): React.JSX.Element {
  const store = useContext(HelmStoreContext)
  // 展示名 / 描述属 LocalizedText 显示元数据：按 store 的权威 locale 解析；
  // 组件保留无 Provider 的 SSR 渲染容忍（缺省英文桥接）。
  const locale = store?.locale ?? DEFAULT_HELM_LOCALE
  const t = useMemo(() => createWebTranslator(locale), [locale])
  const name = resolveLocalizedText(plugin.name, locale) || plugin.id
  const description = getPluginDescription(plugin, locale, t)
  const isLocked = plugin.locked === true
  // 已启用且有 Screen 贡献时提供快捷打开（主屏/右屏），经 store.openTarget 唯一导航。
  const primaryScreen =
    store !== null && plugin.enabled
      ? listPluginScreens(store.groupedUi, plugin.id)[0] ?? null
      : null
  // 源码/清单加载阶段失败（scan/load）：模块未成功导入，无有效 definition 可重试启用
  const isLoadBroken = plugin.error?.stage === 'scan' || plugin.error?.stage === 'load'
  const isSwitchDisabled = isLocked || toggling || isLoadBroken

  const switchTitle = isLocked
    ? t('plugins.card.switchLockedTitle')
    : isLoadBroken
      ? t('plugins.card.switchLoadBrokenTitle')
      : plugin.enabled
        ? t('plugins.card.switchDisableTitle')
        : t('plugins.card.switchEnableTitle')

  const handleCardClick = () => {
    onSelect()
  }

  const handleCardKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  const cardClasses = [
    'plugin-card',
    selected && 'is-selected',
    plugin.enabled ? 'is-enabled' : 'is-disabled',
    isPluginFailed(plugin) && 'is-failed',
  ]
    .filter(Boolean)
    .join(' ')

  const versionLabel = plugin.version ? `v${plugin.version.replace(/^v/, '')}` : null

  return (
    <div
      className={cardClasses}
      role="button"
      tabIndex={0}
      aria-selected={selected}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      data-plugin-id={plugin.id}
    >
      {/* Top header: title/version/locked badge + ID left-aligned */}
      <div className="plugin-card-header">
        <div className="plugin-card-meta">
          <div className="plugin-card-title-row">
            <span className="plugin-card-name" title={name}>
              {name}
            </span>
            {versionLabel && (
              <span className="plugin-card-version" title={t('plugins.card.versionTitle', { version: versionLabel })}>
                {versionLabel}
              </span>
            )}
            {isLocked && (
              <span className="plugin-card-locked-badge" title={t('plugins.card.lockedTitle')}>
                <HelmIcon name="lock" size={10} />
                <span>{t('plugins.resident')}</span>
              </span>
            )}
            {isPluginFailed(plugin) && (
              <span
                className="badge badge-err"
                title={plugin.error?.message || t('plugins.card.failedFallbackTitle')}
              >
                <HelmIcon name="alert-circle" size={10} />
                <span>{t('plugins.status.error')}</span>
              </span>
            )}
          </div>
          <div className="plugin-card-id mono" title={plugin.id}>
            {plugin.id}
          </div>
        </div>
      </div>

      {/* Middle: short description (with an error summary on failure for quick triage without opening the drawer) */}
      <div
        className="plugin-card-desc"
        title={
          isPluginFailed(plugin) && plugin.error?.message
            ? `${description}\n${plugin.error.message}`
            : description
        }
      >
        {isPluginFailed(plugin) && plugin.error?.message ? (
          <>
            {description}
            <div className="plugin-card-error-summary">{plugin.error.message}</div>
          </>
        ) : (
          description
        )}
      </div>

      {/* Bottom bar: capability pills + enable/disable switch */}
      <div className="plugin-card-footer">
        <div className="plugin-card-pills">
          {(plugin.tools?.length ?? 0) > 0 && (
            <span className="plugin-card-pill" title={t('plugins.card.toolsTitle', { count: plugin.tools.length })}>
              <HelmIcon name="wrench" size={11} />
              <span>{`${plugin.tools.length} Tools`}</span>
            </span>
          )}
          {(plugin.actions?.length ?? 0) > 0 && (
            <span className="plugin-card-pill" title={t('plugins.card.actionsTitle', { count: plugin.actions.length })}>
              <HelmIcon name="zap" size={11} />
              <span>{`${plugin.actions.length} Actions`}</span>
            </span>
          )}
          {(plugin.hooks?.length ?? 0) > 0 && (
            <span className="plugin-card-pill" title={t('plugins.card.hooksTitle', { count: plugin.hooks.length })}>
              <HelmIcon name="layers" size={11} />
              <span>{`${plugin.hooks.length} Hooks`}</span>
            </span>
          )}
        </div>

        <div className="plugin-card-actions">
          {primaryScreen !== null && (
            <button
              type="button"
              className="btn btn-xs plugin-card-open-btn"
              title={t('plugins.card.openViewTitle')}
              aria-label={t('plugins.card.openViewAria', { name })}
              onClick={(e) => {
                e.stopPropagation()
                store?.openTarget({
                  kind: 'screen',
                  pluginId: primaryScreen.pluginId,
                  screenId: primaryScreen.screenId,
                })
              }}
            >
              <HelmIcon name="play" size={10} />
              <span>{t('plugins.openView')}</span>
            </button>
          )}
          <div
            className="plugin-card-switch-wrap"
            onClick={(e) => {
              e.stopPropagation()
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
            }}
          >
            <Switch
              checked={plugin.enabled}
              disabled={isSwitchDisabled}
              onChange={(checked) => {
                void onToggle(checked)
              }}
              aria-label={t('plugins.card.switchAria', { name })}
              title={switchTitle}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
