/**
 * action directory hint (host manage segment prompt.actions).
 *
 * responsibility: when before conversation truly can reach (run_action not by strip + scope hit + non- exposeAsTool
 * direct throw) plugin action render into <available_actions> compact directory, and throw shoot enter system sections.
 * pure function module: can reach decide (tool hand over collection / scope) by hook-bridge negative duty, this in only do
 * render and segment manage. complete Schema do not common resident prompt - - directory only carries required/optional and top-level type,
 * embed set and complex structure explicit quote lead via run_action describe on demand query.
 */
import type { ActionManifest, JsonSchema } from '@helm/protocol'
import { escapeXml } from './runtime-helpers.js'

/** host manage segment ID(set-or-clear; without directory when must remove old segment, do not phantom text). */
export const ACTIONS_PROMPT_SECTION_ID = 'prompt.actions'

/** directory item:manifest + pre- parse etc. effect CLI command (undefined = do not render CLI). */
export interface ActionDirectoryEntry {
  readonly manifest: ActionManifest
  readonly cliCommand?: string
}

/**
 * etc. effect CLI command (real store in mount path):cli.command override takes precedence, default
 * [strip builtin:  pluginId, actionId];cli.hidden do not render (do not declare pass missing
 * top-level command).
 */
export function actionCliCommand(manifest: ActionManifest): string | undefined {
  if (manifest.cli?.hidden === true) return undefined
  const command = manifest.cli?.command ?? [manifest.pluginId.replace(/^builtin:/, ''), manifest.id]
  return `helm ${command.join(' ')}`
}

/** many row/many whitespace description press into single row (directory each action one row description). */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

/** property level type signature complex decide. */
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
 * top-level inputSchema compact parameter signature:
 * - ordinary object schema: all amount column out property (name: type(required|optional)), without static default truncate;
 * - embed set object / array element is object / combine: mark note is on demand describe query, do not expand;
 * - non- ordinary object schema(combine / $ref / non- object type): whole mark note describe query.
 */
export function compactActionSignature(schema: JsonSchema): string {
  if (schema === null || typeof schema !== 'object') return 'Schema illegal,run_action describe query'
  const combinators = ['$ref', 'oneOf', 'anyOf', 'allOf']
  if (combinators.some((key) => schema[key] !== undefined)) return 'Schema complex,run_action describe query'
  if (schema['type'] !== undefined && schema['type'] !== 'object') {
    return `top-level type ${String(schema['type'])},run_action describe query`
  }
  const required = Array.isArray(schema['required']) ? new Set(schema['required'].map((name) => String(name))) : new Set<string>()
  const properties = schema['properties']
  if (properties === undefined || properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return schema['additionalProperties'] === false && required.size === 0
      ? '(without parameter)'
      : 'object structure not expand,run_action describe query'
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
      ? '(without parameter)'
      : 'object structure not expand,run_action describe query'
  }
  return parts.join(',')
}

/** render <available_actions> directory segment; without item return undefined(caller clear old segment). */
export function renderAvailableActionsSection(entries: readonly ActionDirectoryEntry[]): string | undefined {
  if (entries.length === 0) return undefined
  const header = [
    '<available_actions>',
    'or fewer action in when before conversation via run_action({ actionId: "pluginId.actionId", input }) invoke; directly expose action already in model tool list render.',
    'parameter is compact signature (required/optional and top-level type), embed set and complex structure do not expand: first run_action({ actionId, describe: true }) get the action complete input/outputSchema(only description, do not execute action); also can via bash execute helm actions list --json view.CLI is etc. effect human channel (this conversation without bash when still can via run_action invoke).',
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
 * throw shoot host manage segment prompt.actions:text non-empty override / is empty remove; the rest segment (contains plugin
 * self define segment) original keep, not change when return original reference. deactivate,scope does not match,run_action
 * strip or without available action when caller pass undefined i.e. complete old segment clear.
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
