import React, { useEffect, useRef, useState } from 'react'
import { assetsApi } from '../lib/api.js'
import { HelmxIcon } from '@helmx/plugin-client'
import { useOptionalStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { ModelPickerControl } from '../conversation/ModelPicker.js'
import {
  modelThinkingLevelsFromRows,
  reviewModelThinkingRows,
  rowsFromModelThinkingLevels,
  type ModelThinkingRow,
} from './global-defaults-model.js'

export interface DefaultModelInfo {
  defaultModel: string
  defaultThinkingLevel: string
  modelThinkingLevels?: Record<string, string>
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
 *   the conversation composer) for the global default model, the global
 *   compaction model, and each per-model thinking default row;
 * - saving goes through `assetsApi.setDefaultModel` (empty strings clear keys;
 *   per-model rows are submitted as one complete map together with the other
 *   global defaults);
 * - loading carries a generation guard (`loadGeneration`) so stale responses
 *   never overwrite newer state while the model catalog refreshes;
 * - strictly zero Emoji and built on design primitives.
 */
export function GlobalDefaultsPanel({
  defaultModelInfo,
  onSaved,
}: GlobalDefaultsPanelProps): React.JSX.Element {
  const actions = useOptionalStoreActions()
  const { t } = useWebLocale()

  const [formModel, setFormModel] = useState(() => defaultModelInfo?.defaultModel ?? '')
  const [formLevel, setFormLevel] = useState(() => defaultModelInfo?.defaultThinkingLevel ?? '')
  const [formCompactionModel, setFormCompactionModel] = useState(
    () => defaultModelInfo?.defaultCompactionModel ?? '',
  )
  const [formCompactionLevel, setFormCompactionLevel] = useState(
    () => defaultModelInfo?.defaultCompactionThinkingLevel ?? '',
  )
  const [perModelRows, setPerModelRows] = useState<ModelThinkingRow[]>(() =>
    rowsFromModelThinkingLevels(defaultModelInfo?.modelThinkingLevels),
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
      setPerModelRows(rowsFromModelThinkingLevels(defaultModelInfo.modelThinkingLevels))
      return () => {
        loadGeneration.current = Math.max(loadGeneration.current, gen)
      }
    }
  }, [defaultModelInfo])

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    const gen = ++loadGeneration.current
    try {
      const issue = reviewModelThinkingRows(perModelRows)
      if (issue !== null) {
        setSaveError(
          issue.kind === 'duplicate'
            ? t('models.defaults.perModelDuplicate', { model: issue.model })
            : t('models.defaults.perModelMissingLevel', { model: issue.model }),
        )
        return
      }
      const res = await assetsApi.setDefaultModel(
        formModel,
        formLevel,
        formCompactionModel,
        formCompactionLevel,
        undefined,
        modelThinkingLevelsFromRows(perModelRows),
      )
      if (gen !== loadGeneration.current) return
      if (actions?.refreshAssets) {
        await actions.refreshAssets()
      }
      onSaved({
        defaultModel: res.defaultModel,
        defaultThinkingLevel: res.defaultThinkingLevel,
        modelThinkingLevels: res.modelThinkingLevels,
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
    setPerModelRows(rowsFromModelThinkingLevels(defaultModelInfo?.modelThinkingLevels))
    setSaveError(null)
  }

  return (
    <div className="model-defaults-panel">
      <div className="section-flat">
        <div className="section-flat-header">
          <HelmxIcon name="sliders" size={14} />
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
              activeThinkingLevel={formLevel}
              resetLabel={t('models.defaults.optionUnset')}
              resetTitle={t('models.defaults.optionUnset')}
              popoverSide="bottom"
              enableShortcut={false}
              disabled={saving}
              onApply={(id, lvl) => {
                setFormModel(id)
                setFormLevel(lvl ?? '')
              }}
              onResetDefault={() => {
                setFormModel('')
                setFormLevel('')
              }}
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
              activeThinkingLevel={formCompactionLevel}
              resetLabel={t('models.defaults.compactionOptionUnset')}
              resetTitle={t('models.defaults.compactionOptionUnset')}
              popoverSide="bottom"
              enableShortcut={false}
              disabled={saving}
              onApply={(id, lvl) => {
                setFormCompactionModel(id)
                setFormCompactionLevel(lvl ?? '')
              }}
              onResetDefault={() => {
                setFormCompactionModel('')
                setFormCompactionLevel('')
              }}
            />
            <span className="text-subtle">{t('models.defaults.compactionHint')}</span>
          </div>
        </div>

        <div className="model-defaults-permodel">
          <div className="model-defaults-permodel-head">
            <span className="model-defaults-permodel-title">{t('models.defaults.perModelTitle')}</span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setPerModelRows((rows) => [...rows, { model: '', level: '' }])}
              disabled={saving}
            >
              <HelmxIcon name="plus" size={14} />
              <span>{t('models.defaults.perModelAdd')}</span>
            </button>
          </div>
          <p className="text-muted">{t('models.defaults.perModelHelp')}</p>
          {perModelRows.length === 0 && (
            <p className="text-subtle">{t('models.defaults.perModelEmpty')}</p>
          )}
          {perModelRows.map((row, index) => (
            <div className="model-defaults-row" key={index}>
              <ModelPickerControl
                buttonId={`model-defaults-permodel-${index}`}
                buttonAriaLabel={t('models.defaults.perModelAria')}
                buttonTitle={row.model || t('models.defaults.perModelPick')}
                placeholderLabel={t('models.defaults.perModelPick')}
                effectiveModel={row.model}
                activeThinkingLevel={row.level}
                resetLabel={t('models.defaults.perModelClear')}
                resetTitle={t('models.defaults.perModelClear')}
                popoverSide="bottom"
                enableShortcut={false}
                disabled={saving}
                onApply={(id, lvl) =>
                  setPerModelRows((rows) =>
                    rows.map((existing, i) => (i === index ? { model: id, level: lvl ?? '' } : existing)),
                  )
                }
                onResetDefault={() =>
                  setPerModelRows((rows) =>
                    rows.map((existing, i) => (i === index ? { model: '', level: '' } : existing)),
                  )
                }
              />
              <button
                type="button"
                className="model-defaults-row-remove"
                onClick={() => setPerModelRows((rows) => rows.filter((_, i) => i !== index))}
                disabled={saving}
                title={t('models.defaults.perModelRemove')}
                aria-label={t('models.defaults.perModelRemove')}
              >
                <HelmxIcon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className="model-defaults-form-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            <HelmxIcon name="check" size={14} />
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
            <HelmxIcon name="alert-circle" size={13} />
            <span className="callout-text">{saveError}</span>
          </div>
        )}
      </div>
    </div>
  )
}
