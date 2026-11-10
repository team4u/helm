import React, { useEffect, useMemo, useRef, useState } from 'react'
import { assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { HelmStoreContext } from '../lib/store-context.js'
import { Select } from '../ui/Select.js'
import { buildDefaultModelOptions, UNSET_MODEL_VALUE } from './model-center-model.js'

export interface GlobalDefaultsPanelProps {
  /** 当前已生效的全局默认模型信息（由 ModelCenter 统一拉取）。 */
  defaultModelInfo: { defaultModel: string; defaultThinkingLevel: string } | null
  /** 保存成功后回写 ModelCenter 侧状态。 */
  onSaved: (info: { defaultModel: string; defaultThinkingLevel: string }) => void
}

/**
 * 「全局默认」Tab 内联配置表单：
 * - 默认模型与思考档位下拉 + 保存 / 重置动作；
 * - 「未设置」选项采用非空哨兵值（UNSET_MODEL_VALUE）：Radix Select 把空字符串
 *   value 当作 placeholder 语义，选中后 onValueChange 不触发，导致无法清除默认；
 * - 表单加载带代数竞争保护（loadGeneration）：模型目录刷新期间旧响应不覆盖新状态；
 * - 保存走 assetsApi.setDefaultModel（空串清除模型），严格遵守零 Emoji 与设计原语。
 */
export function GlobalDefaultsPanel({
  defaultModelInfo,
  onSaved,
}: GlobalDefaultsPanelProps): React.JSX.Element {
  const store = React.useContext(HelmStoreContext)
  const catalogModels = store?.models ?? []

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

  // 外部状态（深链直达 / 目录刷新）变化时同步本地表单；仅在被动的属性同步时生效。
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
    () => buildDefaultModelOptions(catalogModels, formModel === UNSET_MODEL_VALUE ? '' : formModel),
    [catalogModels, formModel],
  )

  const availableThinkingLevels = useMemo(() => {
    const current = formModel === UNSET_MODEL_VALUE ? '' : formModel
    if (current === '') return []
    const found = catalogModels.find((m) => m.id === current)
    return found?.thinkingLevels ?? []
  }, [formModel, catalogModels])

  const levelOptions = useMemo(() => {
    const list: Array<{ value: string; label: string }> = [
      { value: UNSET_MODEL_VALUE, label: '跟随 SDK 缺省' },
    ]
    for (const lvl of availableThinkingLevels) {
      list.push({ value: lvl, label: lvl })
    }
    if (
      formLevel !== '' &&
      formLevel !== UNSET_MODEL_VALUE &&
      !availableThinkingLevels.includes(formLevel)
    ) {
      list.push({ value: formLevel, label: `${formLevel}（当前值）` })
    }
    return list
  }, [availableThinkingLevels, formLevel])

  const handleModelChange = (next: string) => {
    setFormModel(next)
    // 模型切换后思考档位不在新模型支持列表时回落到缺省
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
      if (store?.refreshAssets) {
        await store.refreshAssets()
      }
      onSaved({ defaultModel: res.defaultModel, defaultThinkingLevel: res.defaultThinkingLevel })
      store?.pushNotice?.({
        type: 'notification',
        level: 'info',
        title: '全局默认模型已更新',
        body: res.defaultModel ? `已设置为 ${res.defaultModel}` : '已清除全局默认模型',
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
          <span className="section-flat-title">全局模型规则</span>
        </div>
        <p className="text-muted" style={{ margin: 0 }}>
          新会话的继承链：会话临时覆盖 &gt; Profile 模型 &gt; 此处全局默认。切换后对所有未显式覆盖模型的会话即时生效。
        </p>

        <div className="form-grid form-grid-align-start">
          <label htmlFor="model-defaults-model" className="form-grid-label">
            默认模型
          </label>
          <div className="flex-col-xs">
            <Select
              id="model-defaults-model"
              value={formModel}
              disabled={saving}
              popoverClassName="helm-select-popover-wide"
              className="w-full mono"
              aria-label="全局默认模型"
              options={modelOptions}
              onChange={(e) => handleModelChange(e.target.value)}
            />
            <span className="text-subtle">可供选择的模型来自所有已配置且可用的供应商目录。</span>
          </div>

          <label htmlFor="model-defaults-thinking-level" className="form-grid-label">
            默认思考档位
          </label>
          <div className="flex-col-xs">
            <Select
              id="model-defaults-thinking-level"
              value={formLevel === '' ? UNSET_MODEL_VALUE : formLevel}
              disabled={saving || formModel === UNSET_MODEL_VALUE}
              aria-label="全局默认思考档位"
              options={levelOptions}
              onChange={(e) => setFormLevel(e.target.value)}
            />
            {formModel !== UNSET_MODEL_VALUE && availableThinkingLevels.length === 0 && (
              <span className="text-subtle">所选模型不支持思考档位。</span>
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
            <span>{saving ? '保存中...' : '保存全局默认'}</span>
          </button>
          <button type="button" className="btn btn-ghost" onClick={handleReset} disabled={saving}>
            <span>重置</span>
          </button>
          {saveSuccess && <span className="text-subtle">配置已成功保存</span>}
          {saveError && <span className="text-err">{saveError}</span>}
        </div>
      </div>
    </div>
  )
}
