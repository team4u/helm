import React from 'react'
import { HelmIcon } from '../lib/icons.js'
import { getProviderIconName, type ProviderItem } from './model-center-model.js'

export interface ModelCardProps {
  provider: ProviderItem
  selected?: boolean
  onSelect: () => void
}

/**
 * 全屏模型中心单张供应商卡片组件：
 * - 响应式网格流单元，遵循 1px 发丝边框与克制低饱和设计规范；
 * - 头部展示供应商矢量图标、名称、ID 与配置状态徽章（已配置 / 未配置）；
 * - 中部展示供应商能力描述；
 * - 底部展示可用模型数与类型胶囊（商业云端 / 本地私有）；
 * - 交互支持点击或 Enter / Space 激活选中，selected 态添加 .is-selected 类名；
 * - 严格遵循零 Emoji 规范与 WAI-ARIA 键盘无障碍交互。
 */
export function ModelCard({
  provider,
  selected = false,
  onSelect,
}: ModelCardProps): React.JSX.Element {
  const iconName = getProviderIconName(provider.id)

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
    'primary-card',
    selected && 'is-selected',
    provider.configured ? 'is-configured' : 'is-unconfigured',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={cardClasses}
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      aria-selected={selected}
      aria-label={`${provider.name} 供应商卡片`}
    >
      {/* 头部：图标、名称、状态徽章、ID */}
      <div className="primary-card-header">
        <div className="primary-card-icon-wrap">
          <HelmIcon name={iconName} size={18} />
        </div>
        <div className="primary-card-meta">
          <div className="primary-card-title-row">
            <span className="primary-card-name">{provider.name}</span>
            {provider.configured ? (
              <span className="badge badge-ok">已配置</span>
            ) : (
              <span className="badge badge-neutral">未配置</span>
            )}
          </div>
          <span className="text-xs text-subtle mono">{provider.id}</span>
        </div>
      </div>

      {/* 中部：描述 */}
      <div className="primary-card-desc">
        {provider.description || '支持标准接口调用的大语言模型供应商。'}
      </div>

      {/* 底部：可用模型数量与类型胶囊 */}
      <div className="primary-card-footer">
        <span className="badge badge-neutral mono">
          {provider.modelsCount} 个模型可用
        </span>
        <span className="primary-card-pill">
          {provider.type === 'commercial' ? '商业云端' : '本地私有'}
        </span>
      </div>
    </div>
  )
}
