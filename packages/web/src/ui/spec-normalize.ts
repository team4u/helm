/**
 * 双形态 JSON Spec 归一化（纯逻辑，供单测直接验证）。
 *
 * 形态 A（内置插件树状简写，superagent.ts / triggers.ts 的真实写法）：
 *   { component: 'Card', children: [ { component: 'Text', text: '...' } ], ...props }
 * 形态 B（扁平 @json-render 形态）：
 *   { root: 'rootId', elements: { rootId: { type: 'Card', props: {...}, children: ['child1'] } } }
 *
 * 两种形态统一归一化为内部树 NormalizedSpecNode；非法输入产出带诊断的
 * fallback 节点（诚实性：绝不静默吞掉渲染错误）。
 */

export interface NormalizedSpecNode {
  component: string
  props: Record<string, unknown>
  children: NormalizedSpecNode[]
}

/** 归一化结果：树 + 是否发生降级（降级时 root 为错误提示节点）。 */
export interface NormalizedSpec {
  root: NormalizedSpecNode | null
  degraded: boolean
  /** 降级原因（供宿主日志；不降级时为 undefined）。 */
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
 * 归一化形态 A 的单个节点（递归）：
 * - component/type 为组件名；
 * - children 为数组（每个元素递归归一化）或字符串字面量（转 Text body）；
 * - 其余属性全部进 props（children 除外）。
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

/** 形态判别：扁平形态必须同时含 root: string 与 elements: object。 */
export function isFlatSpec(spec: unknown): boolean {
  const record = asRecord(spec)
  if (record === null) return false
  const root = record['root']
  const elements = record['elements']
  return typeof root === 'string' && root !== '' && asRecord(elements) !== null
}

/** 主入口：任意插件 JSON Spec 归一化为 NormalizedSpec。 */
export function normalizeSpec(spec: unknown): NormalizedSpec {
  const record = asRecord(spec)
  if (record === null) {
    return degradedNode('Spec 为空或不是对象，无法渲染')
  }

  // 形态 B：扁平 elements 表（含环检测，防恶意/损坏 spec 死循环）
  if (isFlatSpec(record)) {
    const rootId = record['root'] as string
    const elements = record['elements'] as Record<string, unknown>
    const visiting = new Set<string>()
    const visited = new Set<string>()

    const build = (id: string): NormalizedSpecNode | null => {
      if (visited.has(id)) {
        return { component: DEGRADED_COMPONENT, props: { reason: `元素 ${id} 被重复引用（DAG 之外不允许）` }, children: [] }
      }
      if (visiting.has(id)) {
        return { component: DEGRADED_COMPONENT, props: { reason: `元素 ${id} 存在循环引用` }, children: [] }
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
      return degradedNode(`扁平 Spec 的根元素 '${rootId}' 缺失或非法`)
    }
    return { root, degraded: false }
  }

  // 形态 A：树状简写
  if (readComponentName(record) === '') {
    return degradedNode('Spec 缺少 component/type 字段（既非树状简写也非扁平形态）')
  }
  const root = normalizeTreeNode(record)
  if (root === null) {
    return degradedNode('Spec 根节点归一化失败')
  }
  return { root, degraded: false }
}

/** 求值后的 KeyValueList 条目（label 为键名，value 已格式化为展示文本）。 */
export interface ResolvedKeyValueItem {
  label: string
  value: string
}

/**
 * KeyValueList 条目解析（纯逻辑）：
 * - `{ label, value }` 写法：value 为已求值结果（evaluateSpecValue 产物），格式化为展示文本；
 * - `{ key: '/$docs/...', label }` 写法：value 未提供且 key 以 '/$' 或 '{' 开头时，
 *   由调用方求值 key 后作为展示值（本函数只接收已求值的 resolvedValue）；
 * - key 为普通字符串且无 value：key 既当键名又当展示值。
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
      out.push({ label, value: formatSpecText(valueRaw) })
      continue
    }

    if (keyStr !== undefined && (keyStr.startsWith('/$') || keyStr.startsWith('{'))) {
      const label = typeof labelRaw === 'string' && labelRaw !== '' ? labelRaw : keyStr
      out.push({ label, value: formatSpecText(evaluate(keyStr)) })
      continue
    }

    const label = typeof labelRaw === 'string' && labelRaw !== '' ? labelRaw : (keyStr ?? '')
    out.push({ label, value: keyStr ?? formatSpecText(valueRaw) })
  }
  return out
}

/** 任意求值结果格式化为展示文本（数组/对象 JSON 化；undefined 显示占位符）。 */
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

/** 归一化结果是否为降级节点（渲染层据此展示显式错误，不静默）。 */
export function isDegradedNode(node: NormalizedSpecNode): boolean {
  return node.component === DEGRADED_COMPONENT
}
