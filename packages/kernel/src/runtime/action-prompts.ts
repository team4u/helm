/**
 * Action catalog prompt fragment (`prompt.actions` host-managed section).
 *
 * Responsibilities: render plugin actions truly reachable in the current conversation (`run_action` not
 * stripped + scope matched + not directly exposed via `exposeAsTool`) into a compact `<available_actions>`
 * catalog and project it into system sections.
 * Pure functional module: reachability (tool intersection / scope) is handled by `hook-bridge`; this module
 * only formats and manages the section. Full schemas stay out of the persistent prompt — the catalog carries
 * only required/optional and top-level types, guiding the model to inspect nested/complex schemas on demand
 * via `run_action describe`.
 */
import type { ActionManifest, JsonSchema } from '@helm/protocol'
import { escapeXml } from './runtime-helpers.js'

/** Host-managed section ID (set-or-clear; removed immediately when catalog is empty, leaving no phantom text). */
export const ACTIONS_PROMPT_SECTION_ID = 'prompt.actions'

/** Catalog item: manifest + resolved equivalent CLI command (`undefined` = omit CLI line). */
export interface ActionDirectoryEntry {
  readonly manifest: ActionManifest
  readonly cliCommand?: string
}

/**
 * Equivalent CLI command (real registered mount path): `cli.command` override takes precedence, otherwise
 * `[pluginId without 'builtin:', actionId]`; `cli.hidden` suppresses CLI rendering so nonexistent top-level
 * commands are never advertised.
 */
export function actionCliCommand(manifest: ActionManifest): string | undefined {
  if (manifest.cli?.hidden === true) return undefined
  const command = manifest.cli?.command ?? [manifest.pluginId.replace(/^builtin:/, ''), manifest.id]
  return `helm ${command.join(' ')}`
}

/** Collapse multi-line / excess whitespace descriptions onto a single line (one line per catalog action). */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

/** Property-level type signature complexity classification. */
type PropComplexity = 'plain' | 'nested-object' | 'complex'

function propSignature(prop: unknown): { signature: string; complexity: PropComplexity } {
  if (prop === null || typeof prop !== 'object' || Array.isArray(prop)) {
    return { signature: 'unknown', complexity: 'complex' }
  }
  const spec = prop as Record<string, unknown>
  if (spec['$ref'] !== undefined || spec['oneOf'] !== undefined || spec['anyOf'] !== undefined || spec['allOf'] !== undefined || spec['not'] !== undefined) {
    return { signature: 'complex', complexity: 'complex' }
  }
  const type = spec['type']
  if (type === 'array') {
    const items = spec['items']
    const itemType =
      items !== null && typeof items === 'object' && !Array.isArray(items)
        ? String((items as Record<string, unknown>)['type'] ?? 'unknown')
        : 'unknown'
    const nested = itemType === 'object' || (items as Record<string, unknown> | undefined)?.['properties'] !== undefined
    return { signature: `${itemType}[]`, complexity: nested ? 'complex' : 'plain' }
  }
  if (type === 'object') {
    const hasProperties = spec['properties'] !== undefined
    return { signature: hasProperties ? 'object(embed set)' : 'object', complexity: hasProperties ? 'nested-object' : 'plain' }
  }
  if (typeof type === 'string') return { signature: type, complexity: 'plain' }
  if (typeof type === 'boolean') return { signature: 'unknown', complexity: 'plain' }
  return { signature: 'unknown', complexity: 'complex' }
}

/**
 * Compact parameter signature for top-level `inputSchema`:
 * - Plain object schema: lists all properties (`name: type(required|optional)`) without silent truncation;
 * - Nested object / array-of-objects / combinators: annotated for on-demand `describe query` without expanding;
 * - Non-plain-object schema (combinators / `$ref` / non-object type): annotated at top level for `describe query`.
 * Note: `'object(embed set)'` and `'(describe query)'` markers are preserved for downstream test contracts.
 */
export function compactActionSignature(schema: JsonSchema): string {
  if (schema === null || typeof schema !== 'object') return 'invalid schema; use run_action describe query'
  const combinators = ['$ref', 'oneOf', 'anyOf', 'allOf']
  if (combinators.some((key) => schema[key] !== undefined)) return 'complex schema; use run_action describe query'
  if (schema['type'] !== undefined && schema['type'] !== 'object') {
    return `top-level type ${String(schema['type'])}; use run_action describe query`
  }
  const required = Array.isArray(schema['required']) ? new Set(schema['required'].map((name) => String(name))) : new Set<string>()
  const properties = schema['properties']
  if (properties === undefined || properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return schema['additionalProperties'] === false && required.size === 0
      ? '(no parameters)'
      : 'object structure unexpanded; use run_action describe query'
  }
  const parts: string[] = []
  for (const [name, prop] of Object.entries(properties)) {
    const { signature, complexity } = propSignature(prop)
    const optional = required.has(name) ? 'required' : 'optional'
    const hint = complexity === 'plain' ? '' : '(describe query)'
    parts.push(`${name}: ${signature}${hint}(${optional})`)
  }
  if (parts.length === 0) {
    return schema['additionalProperties'] === false && required.size === 0
      ? '(no parameters)'
      : 'object structure unexpanded; use run_action describe query'
  }
  return parts.join(', ')
}

/** Render `<available_actions>` catalog section; returns `undefined` when empty (signal to clear stale section). */
export function renderAvailableActionsSection(entries: readonly ActionDirectoryEntry[]): string | undefined {
  if (entries.length === 0) return undefined
  const header = [
    '<available_actions>',
    'Actions below can be invoked in this conversation via run_action({ actionId: "pluginId.actionId", input }); directly exposed actions are already listed in the model tools.',
    'Parameters show a compact signature (required/optional and top-level types), leaving nested and complex structures collapsed: call run_action({ actionId, describe: true }) first to retrieve full input/outputSchema (read-only description; does not execute), or inspect via bash with helm actions list --json. CLI shows the equivalent human command (even without bash in this conversation, run_action remains available).',
  ]
  const groups = new Map<string, ActionDirectoryEntry[]>()
  for (const entry of entries) {
    const list = groups.get(entry.manifest.pluginId)
    if (list !== undefined) list.push(entry)
    else groups.set(entry.manifest.pluginId, [entry])
  }
  const body: string[] = []
  for (const [pluginId, pluginEntries] of groups) {
    body.push(`plugin ${escapeXml(pluginId)}:`)
    for (const { manifest, cliCommand } of pluginEntries) {
      const qualified = `${manifest.pluginId}.${manifest.id}`
      body.push(`- ${escapeXml(qualified)}: ${escapeXml(oneLine(manifest.description))}`)
      body.push(`  parameter: ${escapeXml(compactActionSignature(manifest.inputSchema))}`)
      if (cliCommand !== undefined) body.push(`  CLI: ${escapeXml(cliCommand)}`)
      if (manifest.promptGuidelines !== undefined && manifest.promptGuidelines.length > 0) {
        body.push(`  refer quote (${escapeXml(qualified)}):`)
        for (const item of manifest.promptGuidelines) body.push(`  - ${escapeXml(item)}`)
      }
      if (manifest.promptSnippet !== undefined) {
        body.push(`  note (${escapeXml(qualified)}):`)
        for (const line of manifest.promptSnippet.split('\n')) body.push(`  ${escapeXml(line)}`)
      }
    }
  }
  return `${header.join('\n')}\n${body.join('\n')}\n</available_actions>`
}

/**
 * Project the host-managed `prompt.actions` section: replaces when non-empty and removes when empty;
 * preserves all other sections (including plugin custom sections) and returns the original reference if unchanged.
 * Callers pass `undefined` when disabled, scope-mismatched, `run_action` stripped, or empty to clear stale fragments completely.
 */
export function projectActionPromptSection(
  sections: ReadonlyArray<{ id: string; text: string }>,
  text: string | undefined,
): Array<{ id: string; text: string }> {
  const current = sections.find((section) => section.id === ACTIONS_PROMPT_SECTION_ID)
  if (text === undefined) {
    if (current === undefined) return sections as Array<{ id: string; text: string }>
    return sections.filter((section) => section.id !== ACTIONS_PROMPT_SECTION_ID)
  }
  if (current !== undefined && current.text === text) return sections as Array<{ id: string; text: string }>
  const rest = sections.filter((section) => section.id !== ACTIONS_PROMPT_SECTION_ID)
  const insertAt = rest.findIndex((section) => section.id.startsWith('prompt.'))
  if (insertAt === -1) return [...rest, { id: ACTIONS_PROMPT_SECTION_ID, text }]
  return [...rest.slice(0, insertAt), { id: ACTIONS_PROMPT_SECTION_ID, text }, ...rest.slice(insertAt)]
}
