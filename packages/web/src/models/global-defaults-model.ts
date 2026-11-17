/**
 * Pure helpers for the "Global default" panel's per-model thinking defaults
 * (`config.json.modelThinkingLevels`, edited as rows in the settings form).
 *
 * Rows are the editable form state; the saved state is a plain
 * `'provider/modelId' -> level` map. Saving converts row edits into one
 * complete map update, so the defaults form is persisted atomically with the
 * other global model defaults.
 */

/** One editable per-model default row (empty model = row not filled in yet). */
export interface ModelThinkingRow {
  model: string
  level: string
}

/** Convert the saved map into sorted form rows (stable order across reloads). */
export function rowsFromModelThinkingLevels(map: Record<string, string> | undefined): ModelThinkingRow[] {
  if (map === undefined) return []
  return Object.keys(map)
    .sort()
    .map((model) => ({ model, level: map[model] ?? '' }))
}

/** Reviewable row problems the save action must surface (fully empty rows are simply skipped). */
export type ModelThinkingRowIssue =
  | { kind: 'missingLevel'; model: string }
  | { kind: 'duplicate'; model: string }

/**
 * Validate filled rows: every entry needs both a model reference and a thinking
 * level, and each model may appear only once. Returns the first issue, or null
 * when the rows are saveable.
 */
export function reviewModelThinkingRows(rows: ReadonlyArray<ModelThinkingRow>): ModelThinkingRowIssue | null {
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.model === '') continue
    if (row.level === '') return { kind: 'missingLevel', model: row.model }
    if (seen.has(row.model)) return { kind: 'duplicate', model: row.model }
    seen.add(row.model)
  }
  return null
}

/** Convert the edited rows into the complete saved model-to-level map. */
export function modelThinkingLevelsFromRows(rows: ReadonlyArray<ModelThinkingRow>): Record<string, string> {
  const levels: Record<string, string> = {}
  for (const row of rows) {
    if (row.model !== '') levels[row.model] = row.level
  }
  return levels
}
