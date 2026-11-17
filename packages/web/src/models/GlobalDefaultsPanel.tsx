import React, { useEffect, useMemo, useRef, useState } from 'react'
import { assetsApi } from '../lib/api.js'
import { HelmIcon, Select } from '@helm/plugin-client'
import { useOptionalModels, useOptionalStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { buildDefaultModelOptions, UNSET_MODEL_VALUE } from './model-center-model.js'

export interface GlobalDefaultsPanelProps {
  /** Currently effective global default model info (fetched by ModelCenter). */
  defaultModelInfo: { defaultModel: string; defaultThinkingLevel: string } | null
  /** Reports a successful save back to the ModelCenter state. */
  onSaved: (info: { defaultModel: string; defaultThinkingLevel: string }) => void
}

/**
 * Inline configuration form inside the "Global default" tab:
 * - default model and thinking level selects plus save / reset actions;
 * - the "not set" option rides on the non-empty sentinel (UNSET_MODEL_VALUE):
 *   Radix Select treats an empty-string value as placeholder semantics, so
 *   selecting it never fires onValueChange and the default could never be
 *   cleared;
 * - loading carries a generation guard (loadGeneration): stale responses
 *   never overwrite newer state while the model catalog refreshes;
 * - saving goes through assetsApi.setDefaultModel (an empty string clears the
 *   model); strictly zero Emoji and built on design primitives.
 */
export function GlobalDefaultsPanel({
  defaultModelInfo,
  onSaved,
}: GlobalDefaultsPanelProps): React.JSX.Element {
  const storeModels = useOptionalModels()
  const actions = useOptionalStoreActions()
  const { t } = useWebLocale()
  const catalogModels = storeModels ?? []

  const [formModel, setFormModel] = useState(() =>
    defaultModelInfo?.defaultModel || defaultModelInfo?.defaultModel === ''
      ? defaultModelInfo.defaultModel || UNSET_MODEL_VALUE
      : UNSET_MODEL_VALUE,
  )
  const [formLevel, setFormLevel] = useState(() => defaultModelInfo?.defaultThinkingLevel ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const loadGeneration = useRef(0)

  // Sync the local form when external state changes (deep-link navigation /
  // catalog refresh); only for passive property synchronization.
  useEffect(() => {
    if (defaultModelInfo) {
      const gen = ++loadGeneration.current
      setFormModel(defaultModelInfo.defaultModel || UNSET_MODEL_VALUE)
      setFormLevel(defaultModelInfo.defaultThinkingLevel ?? '')
      return () => {
        loadGeneration.current = Math.max(loadGeneration.current, gen)
      }
    }
  }, [defaultModelInfo])

  const modelOptions = useMemo(
    () =>
      buildDefaultModelOptions(
        catalogModels,
        formModel === UNSET_MODEL_VALUE ? '' : formModel,
        t,
      ),
    [catalogModels, formModel, t],
  )

  const availableThinkingLevels = useMemo(() => {
    const current = formModel === UNSET_MODEL_VALUE ? '' : formModel
    if (current === '') return []
    const found = catalogModels.find((m) => m.id === current)
    return found?.thinkingLevels ?? []
  }, [formModel, catalogModels])

  const levelOptions = useMemo(() => {
    const list: Array<{ value: string; label: string }> = [
      { value: UNSET_MODEL_VALUE, label: t('models.defaults.levelFollowSdk') },
    ]
    for (const lvl of availableThinkingLevels) {
      list.push({ value: lvl, label: lvl })
    }
    if (
      formLevel !== '' &&
      formLevel !== UNSET_MODEL_VALUE &&
      !availableThinkingLevels.includes(formLevel)
    ) {
      list.push({ value: formLevel, label: t('models.defaults.levelCurrent', { level: formLevel }) })
    }
    return list
  }, [availableThinkingLevels, formLevel, t])

  const handleModelChange = (next: string) => {
    setFormModel(next)
    // When the switched-to model no longer supports the current thinking
    // level, fall back to the default.
    const levels =
      next === UNSET_MODEL_VALUE
        ? []
        : catalogModels.find((m) => m.id === next)?.thinkingLevels ?? []
    if (formLevel !== '' && formLevel !== UNSET_MODEL_VALUE && !levels.includes(formLevel)) {
      setFormLevel(UNSET_MODEL_VALUE)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    const gen = ++loadGeneration.current
    try {
      const model = formModel === UNSET_MODEL_VALUE ? '' : formModel
      const level = formLevel === UNSET_MODEL_VALUE ? '' : formLevel
      const res = await assetsApi.setDefaultModel(model, level)
      if (gen !== loadGeneration.current) return
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      onSaved({ defaultModel: res.defaultModel, defaultThinkingLevel: res.defaultThinkingLevel })
      actions?.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: t('models.defaults.noticeUpdated'),
        body: res.defaultModel
          ? t('models.defaults.noticeSetTo', { model: res.defaultModel })
          : t('models.defaults.noticeCleared'),
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
    if (defaultModelInfo) {
      setFormModel(defaultModelInfo.defaultModel || UNSET_MODEL_VALUE)
      setFormLevel(defaultModelInfo.defaultThinkingLevel || UNSET_MODEL_VALUE)
    } else {
      setFormModel(UNSET_MODEL_VALUE)
      setFormLevel(UNSET_MODEL_VALUE)
    }
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
            <Select
              id="model-defaults-model"
              value={formModel}
              disabled={saving}
              popoverClassName="helm-select-popover-wide"
              className="w-full mono"
              aria-label={t('models.defaults.modelAria')}
              options={modelOptions}
              onChange={(e) => handleModelChange(e.target.value)}
            />
            <span className="text-subtle">{t('models.defaults.modelHint')}</span>
          </div>

          <label htmlFor="model-defaults-thinking-level" className="form-grid-label">
            {t('models.defaults.levelLabel')}
          </label>
          <div className="flex-col-xs">
            <Select
              id="model-defaults-thinking-level"
              value={formLevel === '' ? UNSET_MODEL_VALUE : formLevel}
              disabled={saving || formModel === UNSET_MODEL_VALUE}
              aria-label={t('models.defaults.levelAria')}
              options={levelOptions}
              onChange={(e) => setFormLevel(e.target.value)}
            />
            {formModel !== UNSET_MODEL_VALUE && availableThinkingLevels.length === 0 && (
              <span className="text-subtle">{t('models.defaults.levelUnsupported')}</span>
            )}
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
