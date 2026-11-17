/**
 * Pure logic for the builtin:workflow client: workflow library (strict
 * parsing of list/get/save action results, strict args parsing for library
 * runs and the "let the AI edit" request copy; zero React/DOM dependencies).
 */
import { DEFAULT_HELM_LOCALE, type HelmLocale } from '@helm/plugin-client'
import type { ConversationSummary } from '@helm/protocol'
import type { WorkflowRunSummary } from '../../contracts.js'
import { firstLineOf, inspectString } from './model-format.ts'
import { libArgsInvalidJson, workflowEditDescriptionLine, workflowEditRequestLines } from './copy.ts'

// ---------------------------------------------------------------------------
// Workflow library (strict parsing of list/get/save action results and args parsing)
// ---------------------------------------------------------------------------

/** Saved workflow entry view (same shape as SavedWorkflowSummary; strictly parsed). */
export interface SavedWorkflowView {
  name: string
  path?: string
  /** Last modification time of the definition file (epoch ms). */
  updatedAt: number
  /** Definition file size in bytes. */
  size: number
  metadataError?: string
  description?: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

/** Full definition view returned by the get action (including the read-only source). */
export interface SavedWorkflowDetailView extends SavedWorkflowView {
  script: string
}

/** Non-negative safe integer guard (type boundary for file fact fields). */
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Entry parsing: non-object entry, missing name, non-safe-integer updatedAt/size, or invalid phases → undefined. */
function parseSavedWorkflowEntry(item: unknown): SavedWorkflowView | undefined {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
  const record = item as Record<string, unknown>
  const name = inspectString(record, 'name')
  if (name === undefined) return undefined
  if (!nonNegativeInteger(record['updatedAt'])) return undefined
  if (!nonNegativeInteger(record['size'])) return undefined
  let phases: Array<{ title: string; detail?: string; model?: string }> | undefined
  const phasesRaw = record['phases']
  if (phasesRaw !== undefined) {
    if (!Array.isArray(phasesRaw)) return undefined
    const parsedPhases: Array<{ title: string; detail?: string; model?: string }> = []
    for (const p of phasesRaw) {
      if (p === null || typeof p !== 'object' || Array.isArray(p)) return undefined
      const phase = p as Record<string, unknown>
      const title = inspectString(phase, 'title')
      if (title === undefined) return undefined
      const detail = inspectString(phase, 'detail')
      const model = inspectString(phase, 'model')
      parsedPhases.push({
        title,
        ...(detail !== undefined ? { detail } : {}),
        ...(model !== undefined ? { model } : {}),
      })
    }
    phases = parsedPhases.length > 0 ? parsedPhases : undefined
  }
  return {
    name,
    updatedAt: record['updatedAt'],
    size: record['size'],
    ...(inspectString(record, 'path') !== undefined ? { path: inspectString(record, 'path') } : {}),
    ...(inspectString(record, 'metadataError') !== undefined ? { metadataError: inspectString(record, 'metadataError') } : {}),
    ...(inspectString(record, 'description') !== undefined ? { description: inspectString(record, 'description') } : {}),
    ...(inspectString(record, 'whenToUse') !== undefined ? { whenToUse: inspectString(record, 'whenToUse') } : {}),
    ...(phases !== undefined ? { phases } : {}),
  }
}

/**
 * Strictly parse the list action result (invalid shapes return undefined, no
 * fabricated lists).
 *
 * Tightened boundaries: a non-object entry, a missing name, missing or
 * non-safe-integer updatedAt/size, or a phases array with invalid phase items
 * rejects the whole payload — invalid entries are never silently dropped into
 * a seemingly complete list (a partial list would mislead users into thinking
 * the catalog only contains these workflows).
 */
export function parseSavedWorkflowList(raw: unknown): SavedWorkflowView[] | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const workflows = (raw as Record<string, unknown>)['workflows']
  if (!Array.isArray(workflows)) return undefined
  const out: SavedWorkflowView[] = []
  for (const item of workflows) {
    const entry = parseSavedWorkflowEntry(item)
    if (entry === undefined) return undefined
    out.push(entry)
  }
  return out
}

/**
 * Strictly parse the get action result (structurally invalid returns
 * undefined, never guessed): workflow is required and must contain a
 * non-empty script (read-only source); other fields follow the list-entry
 * standard.
 */
export function parseWorkflowDetail(raw: unknown): SavedWorkflowDetailView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const workflow = (raw as Record<string, unknown>)['workflow']
  const entry = parseSavedWorkflowEntry(workflow)
  if (entry === undefined) return undefined
  const script = (workflow as Record<string, unknown>)['script']
  if (typeof script !== 'string' || script === '') return undefined
  return { ...entry, script }
}

/** Strictly parse the save action result: created requires a boolean, workflow a valid summary. */
export function parseWorkflowSaveResult(raw: unknown): { created: boolean; workflow: SavedWorkflowView } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record['created'] !== 'boolean') return undefined
  const workflow = parseSavedWorkflowEntry(record['workflow'])
  if (workflow === undefined) return undefined
  return { created: record['created'], workflow }
}

/** One-click save availability for an inline run: non-subagent and not started from a saved definition. */
export function canSaveRunAsWorkflow(run: Pick<WorkflowRunSummary, 'kind' | 'savedName'>): boolean {
  return run.kind !== 'subagent' && run.savedName === undefined
}

/**
 * "Let the AI edit" request copy: describes the target and capability entry
 * points only — no fake editing inside the Web UI.
 */
export function buildWorkflowEditRequest(
  name: string,
  detail?: { description?: string },
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): string {
  const descriptionLine =
    detail?.description !== undefined
      ? workflowEditDescriptionLine(firstLineOf(detail.description, 120), locale)
      : undefined
  return workflowEditRequestLines(name, descriptionLine, locale).join('\n')
}

/** Strict args parsing for library runs: blank means no args; non-blank must be valid JSON (never silently passed through as a string). */
export function parseWorkflowArgsInput(
  text: string,
  locale: HelmLocale = DEFAULT_HELM_LOCALE,
): { ok: true; args?: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true }
  try {
    return { ok: true, args: JSON.parse(trimmed) as unknown }
  } catch (error) {
    return { ok: false, error: libArgsInvalidJson(error instanceof Error ? error.message : String(error), locale) }
  }
}

/** Library fullscreen view search: lowercase contains match over name / description / when-to-use (query is a normalized lowercase term). */
export function filterSavedWorkflows(items: SavedWorkflowView[], query: string): SavedWorkflowView[] {
  if (query === '') return items
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(query) ||
      (item.description ?? '').toLowerCase().includes(query) ||
      (item.whenToUse ?? '').toLowerCase().includes(query),
  )
}

/** Run target conversation options: top-level conversations first (subagent conversations never appear in the picker), 50 most recently updated. */
export function buildWorkflowRunTargetOptions(
  conversations: ReadonlyArray<Pick<ConversationSummary, 'id' | 'parentConversationId' | 'updatedAt' | 'title' | 'profileId'>>,
): Array<{ value: string; label: string }> {
  const topLevel = conversations.filter((c) => c.parentConversationId === undefined)
  return [...topLevel]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50)
    .map((c) => ({
      value: String(c.id),
      label: `#${c.id} ${c.title !== '' && c.title !== undefined ? c.title : c.profileId}`.slice(0, 40),
    }))
}
