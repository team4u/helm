/**
 * Pure helpers for the "Global default" panel's per-model thinking defaults
 * (`config.json.modelThinkingLevels`, edited as rows in the settings form).
 *
 * Rows are the editable form state; the saved state is a plain
 * `'provider/modelId' -> level` map. Saving converts row edits into strict
 * incremental pair updates (`{ modelThinking, modelThinkingLevel }`; empty
 * level clears the entry), so no read-modify-write of the whole map happens
 * client-side.
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

/**
 * Incremental pair updates that transform the saved map into the edited rows:
 * changed or new entries carry their level; entries removed from the rows carry
 * an empty level (server clears the single entry and drops the field once the
 * map empties).
 */
export function diffModelThinkingEntries(
  saved: Record<string, string> | undefined,
  rows: ReadonlyArray<ModelThinkingRow>,
): Array<{ model: string; level: string }> {
  const savedMap = saved ?? {}
  const next = new Map<string, string>()
  for (const row of rows) {
    if (row.model === '') continue
    next.set(row.model, row.level)
  }
  const updates: Array<{ model: string; level: string }> = []
  for (const [model, level] of next) {
    if (savedMap[model] !== level) updates.push({ model, level })
  }
  for (const model of Object.keys(savedMap)) {
    if (!next.has(model)) updates.push({ model, level: '' })
  }
  return updates
}
