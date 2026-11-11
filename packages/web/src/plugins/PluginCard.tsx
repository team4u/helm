import React from 'react'
import type { PluginSummary } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { Switch } from '../ui/Switch.js'
import { getPluginDescription } from './plugin-card-model.js'

export interface PluginCardProps {
  plugin: PluginSummary
  selected: boolean
  onSelect: () => void
  onToggle: (enabled: boolean) => Promise<void> | void
  toggling?: boolean
}

/**
 * 根据插件 ID 推导线性矢量图标名称
 */
function getPluginIcon(id: string): string {
  const norm = (id ?? '').toLowerCase()
  if (norm.includes('profile')) return 'bot'
  if (norm.includes('memory')) return 'sparkles'
  if (norm.includes('workflow')) return 'workflow'
  if (norm.includes('herdr')) return 'terminal'
  if (norm.includes('superagent')) return 'sparkles'
  if (norm.includes('trigger')) return 'webhook'
  if (norm.includes('json-render')) return 'layout'
  if (norm.includes('mermaid')) return 'git-branch'
  if (norm.includes('magpie')) return 'globe'
  if (norm.includes('tool')) return 'wrench'
  return 'boxes'
}

/**
 * 全屏插件中心单张插件卡片视图组件：
 * - 响应式网格流单元，遵循 1px 发丝边框与克制低饱和设计规范；
 * - 顶部展示图标、名称、ID、版本与常驻徽章；
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
  const iconName = getPluginIcon(plugin.id)
  const description = getPluginDescription(plugin)
  const isLocked = plugin.locked === true
  const isSwitchDisabled = isLocked || toggling

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
      {/* 顶部头部：图标 + 标题/版本/锁定标签 */}
      <div className="plugin-card-header">
        <div className="plugin-card-icon-wrap">
          <HelmIcon name={iconName} size={18} />
        </div>
        <div className="plugin-card-meta">
          <div className="plugin-card-title-row">
            <span className="plugin-card-name" title={plugin.name || plugin.id}>
              {plugin.name || plugin.id}
            </span>
            {versionLabel && (
              <span className="plugin-card-version" title={`版本 ${versionLabel}`}>
                {versionLabel}
              </span>
            )}
            {isLocked && (
              <span className="plugin-card-locked-badge" title="常驻核心插件，不可停用">
                <HelmIcon name="lock" size={10} />
                <span>常驻</span>
              </span>
            )}
          </div>
          <div className="plugin-card-id mono" title={plugin.id}>
            {plugin.id}
          </div>
        </div>
      </div>

      {/* 中部：简短描述 */}
      <div className="plugin-card-desc" title={description}>
        {description}
      </div>

      {/* 底栏：能力胶囊徽章 + 启停 Switch 开关 */}
      <div className="plugin-card-footer">
        <div className="plugin-card-pills">
          {(plugin.tools?.length ?? 0) > 0 && (
            <span className="plugin-card-pill" title={`${plugin.tools.length} 个 Agent Tools`}>
              <HelmIcon name="wrench" size={11} />
              <span>{`${plugin.tools.length} Tools`}</span>
            </span>
          )}
          {(plugin.actions?.length ?? 0) > 0 && (
            <span className="plugin-card-pill" title={`${plugin.actions.length} 个 CLI/HTTP Actions`}>
              <HelmIcon name="zap" size={11} />
              <span>{`${plugin.actions.length} Actions`}</span>
            </span>
          )}
          {(plugin.hooks?.length ?? 0) > 0 && (
            <span className="plugin-card-pill" title={`${plugin.hooks.length} 个内核生命周期钩子`}>
              <HelmIcon name="layers" size={11} />
              <span>{`${plugin.hooks.length} Hooks`}</span>
            </span>
          )}
        </div>

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
            aria-label={`${plugin.name || plugin.id} 开关`}
            title={isLocked ? '常驻插件不可停用' : plugin.enabled ? '点击停用' : '点击启用'}
          />
        </div>
      </div>
    </div>
  )
}
