import React from 'react'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { summarizeCardModels, type ProviderItem } from './model-center-model.js'

export interface ModelCardProps {
  provider: ProviderItem
  selected?: boolean
  onSelect: () => void
}

/**
 * Single provider card in the full-screen model center:
 * - responsive grid-flow cell following the 1px hairline-border, restrained
 *   low-saturation design rules;
 * - header shows the provider name, ID and configuration badge
 *   (configured / not configured);
 * - middle shows the capability description plus a preview of configured
 *   model short names (first 3 + remaining count);
 * - footer shows the available model count;
 * - click or Enter / Space activates the selection; the selected state adds
 *   the .is-selected class;
 * - strictly zero Emoji and WAI-ARIA keyboard-accessible interactions.
 */
export function ModelCard({
  provider,
  selected = false,
  onSelect,
}: ModelCardProps): React.JSX.Element {
  const { t } = useWebLocale()

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
      aria-label={t('models.cardAria', { name: provider.name })}
    >
      {/* Header: name, status badge, ID left-aligned */}
      <div className="primary-card-header">
        <div className="primary-card-meta">
          <div className="primary-card-title-row">
            <span className="primary-card-name" title={provider.name}>
              {provider.name}
            </span>
            {provider.configured ? (
              <span className="badge badge-ok">{t('models.configured')}</span>
            ) : (
              <span className="badge badge-neutral">{t('models.notConfigured')}</span>
            )}
            {provider.dynamic && <span className="badge badge-neutral">{t('models.dynamicBadge')}</span>}
            {provider.custom && <span className="badge badge-neutral">{t('models.customBadge')}</span>}
          </div>
          <span className="text-subtle mono break-word">{provider.id}</span>
        </div>
      </div>

      {/* Middle: description */}
      <div className="primary-card-desc">
        {provider.description || t('models.cardFallbackDescription')}
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
              title={t('models.moreModels', { count: remainingCount })}
            >
              +{remainingCount}
            </span>
          )}
        </div>
      )}

      {/* Bottom: available model count */}
      <div className="primary-card-footer">
        <span className="badge badge-neutral mono tabular-nums">
          {t('models.modelsAvailable', { count: provider.modelsCount })}
        </span>
      </div>
    </div>
  )
}
