/** JSON 求值域只接收数据；控制器函数不跨入表达式求值环境。 */
export function sanitizeSlotPropsForSpec(slotProps: Record<string, unknown> | undefined): Record<string, unknown> {
  return sanitizeSpecValue(slotProps ?? {}, new WeakSet()) as Record<string, unknown>
}

function sanitizeSpecValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null) return null
  if (typeof value !== 'object') {
    if (typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    return undefined
  }
  if (value instanceof Date) return value.toISOString()
  if (ancestors.has(value)) throw new Error('插件插槽数据包含循环引用，无法渲染 JSON 视图')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeSpecValue(item, ancestors))
    const clean: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const data = sanitizeSpecValue(item, ancestors)
      if (data !== undefined) {
        Object.defineProperty(clean, key, { value: data, enumerable: true, configurable: true, writable: true })
      }
    }
    return clean
  } finally {
    ancestors.delete(value)
  }
}
