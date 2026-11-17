/**
 * Dual-form JSON spec normalization (pure logic, directly unit-testable).
 *
 * Form A (tree shorthand used by built-in plugins; the real-world shape in
 * superagent.ts / triggers.ts):
 *   { component: 'Card', children: [ { component: 'Text', text: '...' } ], ...props }
 * Form B (flat @json-render form):
 *   { root: 'rootId', elements: { rootId: { type: 'Card', props: {...}, children: ['child1'] } } }
 *
 * Both forms normalize into the internal NormalizedSpecNode tree; invalid
 * input produces a fallback node carrying a diagnosis (honesty: rendering
 * errors are never silently swallowed). Degraded reasons are display copy and
 * resolve against the active host locale.
 */
import type { HelmLocale } from '@helm/plugin-client'
import { DEFAULT_HELM_LOCALE } from '@helm/plugin-client'
import {
  jsonRenderElementCycle,
  jsonRenderElementReused,
  jsonRenderFlatRootMissing,
  jsonRenderMissingComponentField,
  jsonRenderRootNormalizeFailed,
  jsonRenderSpecNotObject,
} from './copy.ts'

export interface NormalizedSpecNode {
  component: string
  props: Record<string, unknown>
  children: NormalizedSpecNode[]
}

/** Normalization result: the tree + whether it degraded (degraded root is an error-notice node). */
interface NormalizedSpec {
  root: NormalizedSpecNode | null
  degraded: boolean
  /** Degradation reason (for host logs; undefined when not degraded). */
  reason?: string
}

const DEGRADED_COMPONENT = '__degraded__'

function degradedNode(reason: string): NormalizedSpec {
  return {
    root: { component: DEGRADED_COMPONENT, props: { reason }, children: [] },
    degraded: true,
    reason,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readComponentName(node: Record<string, unknown>): string {
  const raw = node['component'] ?? node['type']
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : ''
}

/**
 * Normalize one Form-A node (recursive):
 * - component/type is the component name;
 * - children is either an array (each entry normalized recursively) or a string literal (becomes a Text body);
 * - every other property goes into props (except children).
 */
function normalizeTreeNode(raw: unknown): NormalizedSpecNode | null {
  const node = asRecord(raw)
  if (node === null) return null
  const component = readComponentName(node)
  if (component === '') return null

  const props: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'component' || k === 'type' || k === 'children') continue
    props[k] = v
  }

  const children: NormalizedSpecNode[] = []
  const rawChildren = node['children']
  if (Array.isArray(rawChildren)) {
    for (const child of rawChildren) {
      if (typeof child === 'string') {
        children.push({ component: 'Text', props: { variant: 'body', text: child }, children: [] })
        continue
      }
      const normalized = normalizeTreeNode(child)
      if (normalized !== null) children.push(normalized)
    }
  }

  return { component, props, children }
}

/** Form discrimination: the flat form must carry both root: string and elements: object. */
export function isFlatSpec(spec: unknown): boolean {
  const record = asRecord(spec)
  if (record === null) return false
  const root = record['root']
  const elements = record['elements']
  return typeof root === 'string' && root !== '' && asRecord(elements) !== null
}

/** Main entry: normalize any plugin JSON spec into a NormalizedSpec (degraded reasons follow the host locale). */
export function normalizeSpec(spec: unknown, locale: HelmLocale = DEFAULT_HELM_LOCALE): NormalizedSpec {
  const record = asRecord(spec)
  if (record === null) {
    return degradedNode(jsonRenderSpecNotObject(locale))
  }

  // Form B: flat elements table (with cycle detection so a hostile/corrupt spec cannot loop forever)
  if (isFlatSpec(record)) {
    const rootId = record['root'] as string
    const elements = record['elements'] as Record<string, unknown>
    const visiting = new Set<string>()
    const visited = new Set<string>()

    const build = (id: string): NormalizedSpecNode | null => {
      if (visited.has(id)) {
        return { component: DEGRADED_COMPONENT, props: { reason: jsonRenderElementReused(id, locale) }, children: [] }
      }
      if (visiting.has(id)) {
        return { component: DEGRADED_COMPONENT, props: { reason: jsonRenderElementCycle(id, locale) }, children: [] }
      }
      const elem = asRecord(elements[id])
      if (elem === null) return null
      const component = readComponentName(elem)
      if (component === '') return null

      visiting.add(id)
      const props: Record<string, unknown> = { ...(asRecord(elem['props']) ?? {}) }
      const children: NormalizedSpecNode[] = []
      const rawChildren = elem['children']
      const childIds = Array.isArray(rawChildren)
        ? rawChildren
        : rawChildren !== undefined
          ? [rawChildren]
          : []
      for (const childId of childIds) {
        if (typeof childId === 'string') {
          const built = build(childId)
          if (built !== null) children.push(built)
        }
      }
      visiting.delete(id)
      visited.add(id)
      return { component, props, children }
    }

    const root = build(rootId)
    if (root === null) {
      return degradedNode(jsonRenderFlatRootMissing(rootId, locale))
    }
    return { root, degraded: false }
  }

  // Form A: tree shorthand
  if (readComponentName(record) === '') {
    return degradedNode(jsonRenderMissingComponentField(locale))
  }
  const root = normalizeTreeNode(record)
  if (root === null) {
    return degradedNode(jsonRenderRootNormalizeFailed(locale))
  }
  return { root, degraded: false }
}

/** A resolved KeyValueList entry (label is the key name, value already formatted for display). */
interface ResolvedKeyValueItem {
  label: string
  value: string
}

/** Whether a string is a binding expression awaiting evaluation (raw unevaluated key/value spelling). */
function isBindingExpression(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.startsWith('/$') || trimmed.startsWith('{$')
}

/**
 * KeyValueList item resolution (pure logic, called during rendering):
 * - `{ label, value }` spelling: value is evaluated here if it is a binding
 *   expression (type preserved), otherwise displayed as-is;
 * - `{ key: '/$docs/...', label }` spelling: key is the unevaluated binding
 *   expression (the raw template); it is evaluated here and used as the
 *   display value (the upper layer no longer needs to evalIn items first);
 * - plain string key without value: the key serves as both the key name and
 *   the display value.
 *
 * The upper layer no longer pre-evaluates items: pre-evaluation would turn a
 * pointer key into a concrete value (e.g. a number) before this function
 * could recognize the key spelling, showing a dash; evaluation now happens
 * here on the raw template, so all three spellings (plain key, label+value,
 * pointer key) coexist.
 */
export function resolveKeyValueItems(
  items: unknown,
  evaluate: (expr: string) => unknown,
): ResolvedKeyValueItem[] {
  if (!Array.isArray(items)) return []
  const out: ResolvedKeyValueItem[] = []
  for (const raw of items) {
    const item = asRecord(raw)
    if (item === null) continue
    const labelRaw = item['label']
    const keyRaw = item['key']
    const valueRaw = item['value']

    const hasValue = 'value' in item && valueRaw !== undefined
    const keyStr = typeof keyRaw === 'string' ? keyRaw : undefined

    if (hasValue) {
      const label = typeof labelRaw === 'string' && labelRaw !== '' ? labelRaw : (keyStr ?? '')
      const resolvedValue = isBindingExpression(valueRaw) ? evaluate(valueRaw) : valueRaw
      out.push({ label, value: formatSpecText(resolvedValue) })
      continue
    }

    if (isBindingExpression(keyRaw)) {
      const label = typeof labelRaw === 'string' && labelRaw !== '' ? labelRaw : keyRaw.trim()
      out.push({ label, value: formatSpecText(evaluate(keyRaw.trim())) })
      continue
    }

    const label = typeof labelRaw === 'string' && labelRaw !== '' ? labelRaw : (keyStr ?? '')
    // key is already a concrete value (a plain string or an upper-layer
    // pre-evaluated product such as a number): use it directly, no re-evaluation
    out.push({ label, value: keyRaw === undefined ? formatSpecText(valueRaw) : formatSpecText(keyRaw) })
  }
  return out
}

/** Format any evaluation result for display (arrays/objects become JSON; undefined shows a placeholder). */
export function formatSpecText(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? '—'
  } catch {
    return String(value)
  }
}

/** Whether a normalized node is a degraded node (the render layer shows an explicit error, never silent). */
export function isDegradedNode(node: NormalizedSpecNode): boolean {
  return node.component === DEGRADED_COMPONENT
}
