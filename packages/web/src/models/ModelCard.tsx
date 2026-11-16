import React from 'react'
import { summarizeCardModels, type ProviderItem } from './model-center-model.js'

export interface ModelCardProps {
  provider: ProviderItem
  selected?: boolean
  onSelect: () => void
}

/**
 * 全屏模型中心单张供应商卡片组件：
 * - 响应式网格流单元，遵循 1px 发丝边框与克制低饱和设计规范；
 * - 头部展示供应商名称、ID 与配置状态徽章（已配置 / 未配置）；
 * - 中部展示供应商能力描述及已配置模型短名预览（前 3 个 + 剩余数量）；
 * - 底部展示可用模型数；
 * - 交互支持点击或 Enter / Space 激活选中，selected 态添加 .is-selected 类名；
 * - 严格遵循零 Emoji 规范与 WAI-ARIA 键盘无障碍交互。
 */
export function ModelCard({
  provider,
  selected = false,
  onSelect,
}: ModelCardProps): React.JSX.Element {
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

  const { previewNames, remainingCount } = provider.configured
    ? summarizeCardModels(provider, 3)
    : { previewNames: [], remainingCount: 0 }

  return (
    <div
      className={cardClasses}
      role="button"
      tabIndex={0}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
      aria-selected={selected}
      aria-label={`${provider.name} provider card`}
    >
      {/* Header: name, status badge, ID left-aligned */}
      <div className="primary-card-header">
        <div className="primary-card-meta">
          <div className="primary-card-title-row">
            <span className="primary-card-name" title={provider.name}>
              {provider.name}
            </span>
            {provider.configured ? (
              <span className="badge badge-ok">Configured</span>
            ) : (
              <span className="badge badge-neutral">Not configured</span>
            )}
            {provider.dynamic && <span className="badge badge-neutral">Dynamic</span>}
            {provider.custom && <span className="badge badge-neutral">Custom</span>}
          </div>
          <span className="text-subtle mono break-word">{provider.id}</span>
        </div>
      </div>

      {/* Middle: description */}
      <div className="primary-card-desc">
        {provider.description || 'LLM provider with standard API access.'}
      </div>

      {/* Configured providers show the first 3 available model names plus the remaining count */}
      {previewNames.length > 0 && (
        <div className="primary-card-pills">
          {previewNames.map((name) => (
            <span key={name} className="primary-card-pill mono" title={name}>
              {name}
            </span>
          ))}
          {remainingCount > 0 && (
            <span
              className="primary-card-pill tabular-nums"
              title={`${remainingCount} more models available`}
            >
              +{remainingCount}
            </span>
          )}
        </div>
      )}

      {/* Bottom: available model count */}
      <div className="primary-card-footer">
        <span className="badge badge-neutral mono tabular-nums">
          {provider.modelsCount} models available
        </span>
      </div>
    </div>
  )
}
