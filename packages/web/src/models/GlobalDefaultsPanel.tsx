import React, { useEffect, useRef, useState } from 'react'
import { assetsApi } from '../lib/api.js'
import { HelmIcon } from '@helm/plugin-client'
import { useOptionalModels, useOptionalStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { ModelPickerControl } from '../conversation/ModelPicker.js'

export interface DefaultModelInfo {
  defaultModel: string
  defaultThinkingLevel: string
  defaultCompactionModel?: string
  defaultCompactionThinkingLevel?: string
}

export interface GlobalDefaultsPanelProps {
  /** Currently effective global default model info (fetched by ModelCenter). */
  defaultModelInfo: DefaultModelInfo | null
  /** Reports a successful save back to the ModelCenter state. */
  onSaved: (info: DefaultModelInfo) => void
}

/**
 * Inline configuration form inside the "Global default" tab:
 * - reuses `ModelPickerControl` (same single-row `model · thinking` picker as
 *   the conversation composer) for both the global default model and the global
 *   compaction model;
 * - saving goes through `assetsApi.setDefaultModel` (empty strings clear keys);
 * - loading carries a generation guard (`loadGeneration`) so stale responses
 *   never overwrite newer state while the model catalog refreshes;
 * - strictly zero Emoji and built on design primitives.
 */
export function GlobalDefaultsPanel({
  defaultModelInfo,
  onSaved,
}: GlobalDefaultsPanelProps): React.JSX.Element {
  const storeModels = useOptionalModels()
  const actions = useOptionalStoreActions()
  const { t } = useWebLocale()
  const catalogModels = storeModels ?? []

  const [formModel, setFormModel] = useState(() => defaultModelInfo?.defaultModel ?? '')
  const [formLevel, setFormLevel] = useState(() => defaultModelInfo?.defaultThinkingLevel ?? '')
  const [formCompactionModel, setFormCompactionModel] = useState(
    () => defaultModelInfo?.defaultCompactionModel ?? '',
  )
  const [formCompactionLevel, setFormCompactionLevel] = useState(
    () => defaultModelInfo?.defaultCompactionThinkingLevel ?? '',
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const loadGeneration = useRef(0)

  // Sync the local form when external state changes (deep-link navigation /
  // catalog refresh); only for passive property synchronization.
  useEffect(() => {
    if (defaultModelInfo) {
      const gen = ++loadGeneration.current
      setFormModel(defaultModelInfo.defaultModel ?? '')
      setFormLevel(defaultModelInfo.defaultThinkingLevel ?? '')
      setFormCompactionModel(defaultModelInfo.defaultCompactionModel ?? '')
      setFormCompactionLevel(defaultModelInfo.defaultCompactionThinkingLevel ?? '')
      return () => {
        loadGeneration.current = Math.max(loadGeneration.current, gen)
      }
    }
  }, [defaultModelInfo])

  const pickModelWithLevel = (
    nextModel: string,
    currentLevel: string,
    setModel: (value: string) => void,
    setLevel: (value: string) => void,
  ) => {
    setModel(nextModel)
    const levels =
      nextModel === ''
        ? []
        : catalogModels.find((m) => m.id === nextModel)?.thinkingLevels ?? []
    if (currentLevel !== '' && !levels.includes(currentLevel)) {
      setLevel('')
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    const gen = ++loadGeneration.current
    try {
      const res = await assetsApi.setDefaultModel(
        formModel,
        formLevel,
        formCompactionModel,
        formCompactionLevel,
      )
      if (gen !== loadGeneration.current) return
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      onSaved({
        defaultModel: res.defaultModel,
        defaultThinkingLevel: res.defaultThinkingLevel,
        defaultCompactionModel: res.defaultCompactionModel,
        defaultCompactionThinkingLevel: res.defaultCompactionThinkingLevel,
      })
      const noticeBody = res.defaultModel
        ? t('models.defaults.noticeSetTo', { model: res.defaultModel })
        : res.defaultCompactionModel
          ? t('models.defaults.noticeCompactionSetTo', { model: res.defaultCompactionModel })
          : t('models.defaults.noticeCleared')
      actions?.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.defaults.noticeUpdated'),
        body: noticeBody,
      })
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2400)
    } catch (err) {
      if (gen !== loadGeneration.current) return
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      if (gen === loadGeneration.current) setSaving(false)
    }
  }

  const handleReset = () => {
    setFormModel(defaultModelInfo?.defaultModel ?? '')
    setFormLevel(defaultModelInfo?.defaultThinkingLevel ?? '')
    setFormCompactionModel(defaultModelInfo?.defaultCompactionModel ?? '')
    setFormCompactionLevel(defaultModelInfo?.defaultCompactionThinkingLevel ?? '')
    setSaveError(null)
  }

  return (
    <div className="model-defaults-panel">
      <div className="section-flat">
        <div className="section-flat-header">
          <HelmIcon name="sliders" size={14} />
          <span className="section-flat-title">{t('models.defaults.section')}</span>
        </div>
        <p className="text-muted">
          {t('models.defaults.inheritanceHelp')}
        </p>

        <div className="form-grid form-grid-align-start">
          <label htmlFor="model-defaults-model" className="form-grid-label">
            {t('models.defaults.modelLabel')}
          </label>
          <div className="flex-col-xs">
            <ModelPickerControl
              buttonId="model-defaults-model"
              buttonAriaLabel={t('models.defaults.modelAria')}
              buttonTitle={formModel || t('models.defaults.optionUnset')}
              placeholderLabel={t('models.defaults.optionUnset')}
              effectiveModel={formModel}
              selectedModel={formModel || undefined}
              activeThinkingLevel={formLevel}
              resetLabel={t('models.defaults.optionUnset')}
              resetTitle={t('models.defaults.optionUnset')}
              popoverSide="bottom"
              enableShortcut={false}
              disabled={saving}
              onPickModel={(id) => pickModelWithLevel(id, formLevel, setFormModel, setFormLevel)}
              onResetDefault={() => {
                setFormModel('')
                setFormLevel('')
              }}
              onPickThinking={(lvl) => setFormLevel(lvl)}
            />
            <span className="text-subtle">{t('models.defaults.modelHint')}</span>
          </div>

          <label htmlFor="model-defaults-compaction-model" className="form-grid-label">
            {t('models.defaults.compactionLabel')}
          </label>
          <div className="flex-col-xs">
            <ModelPickerControl
              buttonId="model-defaults-compaction-model"
              buttonAriaLabel={t('models.defaults.compactionAria')}
              buttonTitle={formCompactionModel || t('models.defaults.compactionOptionUnset')}
              placeholderLabel={t('models.defaults.compactionOptionUnset')}
              effectiveModel={formCompactionModel}
              selectedModel={formCompactionModel || undefined}
              activeThinkingLevel={formCompactionLevel}
              resetLabel={t('models.defaults.compactionOptionUnset')}
              resetTitle={t('models.defaults.compactionOptionUnset')}
              popoverSide="bottom"
              enableShortcut={false}
              disabled={saving}
              onPickModel={(id) =>
                pickModelWithLevel(
                  id,
                  formCompactionLevel,
                  setFormCompactionModel,
                  setFormCompactionLevel,
                )
              }
              onResetDefault={() => {
                setFormCompactionModel('')
                setFormCompactionLevel('')
              }}
              onPickThinking={(lvl) => setFormCompactionLevel(lvl)}
            />
            <span className="text-subtle">{t('models.defaults.compactionHint')}</span>
          </div>
        </div>

        <div className="model-defaults-form-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            <HelmIcon name="check" size={14} />
            <span>{saving ? t('models.saving') : t('models.defaults.save')}</span>
          </button>
          <button type="button" className="btn btn-ghost" onClick={handleReset} disabled={saving}>
            <span>{t('models.defaults.reset')}</span>
          </button>
          {saveSuccess && (
            <span className="text-subtle" role="status">{t('models.saveSuccess')}</span>
          )}
        </div>
        {saveError && (
          <div className="callout callout-error" role="alert">
            <HelmIcon name="alert-circle" size={13} />
            <span className="callout-text">{saveError}</span>
          </div>
        )}
      </div>
    </div>
  )
}
