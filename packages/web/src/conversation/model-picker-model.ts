/**
 * Pure display formatting for ModelPicker trigger buttons and popover rows
 * (no component exports, Fast Refresh compliant).
 *
 * Keeps the model name shown in dropdown rows consistent with the short name
 * shown in the trigger button and GlobalDefaultsPanel: nested route prefixes
 * (e.g. `magpie` + `auto/deepseek-v4.1-flash`) move into the secondary source
 * line (`magpie/auto`) so the model name itself (`deepseek-v4.1-flash`) stays
 * readable inside narrow rows and alongside inline thinking-level chips.
 */
export interface ModelRowDisplay {
  /** Short model name (last path segment, matching the trigger button). */
  name: string
  /** Provider plus optional route/namespace prefix (e.g. `magpie/auto`). */
  source: string
}

/** Extract the short model name from a canonical model id (e.g. `magpie/auto/glm-5.3` -> `glm-5.3`). */
export function formatModelShortName(modelId: string | undefined): string {
  if (modelId === undefined) return ''
  const trimmed = modelId.trim()
  if (trimmed === '') return ''
  const slashIdx = trimmed.lastIndexOf('/')
  if (slashIdx >= 0 && slashIdx < trimmed.length - 1) {
    return trimmed.slice(slashIdx + 1)
  }
  return trimmed
}

/** Split a model catalog entry into primary display name and secondary source/route label. */
export function formatModelRowDisplay(
  model: { provider: string; modelId: string },
): ModelRowDisplay {
  const provider = model.provider.trim()
  const rawModelId = model.modelId.trim()
  const slashIdx = rawModelId.lastIndexOf('/')
  if (slashIdx >= 0 && slashIdx < rawModelId.length - 1) {
    const prefix = rawModelId.slice(0, slashIdx)
    const name = rawModelId.slice(slashIdx + 1)
    const source = prefix !== '' ? (provider !== '' ? `${provider}/${prefix}` : prefix) : provider
    return { name, source }
  }
  return {
    name: rawModelId !== '' ? rawModelId : provider,
    source: provider,
  }
}
