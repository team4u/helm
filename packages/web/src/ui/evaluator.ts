/**
 * @json-render 表达式求值器（支持原始 JS 类型保持 Type Preservation）。
 *
 * 统一兼容三种路径语法：
 * 1. 花括号点路径：`{$docs.index.workers}`、`{$data.entry.data.meta.summary}`、`{$row.conversationId}`、`{$value}`
 * 2. 花括号带方括号字符串键：`{$docs["recall-graph"].nodes}`、`{$docs['recall-graph'].nodes[0]}`
 * 3. 斜杠 JSON Pointer 路径：`/$docs/index/routerConversationId`
 *
 * 类型保持铁律（Type Preservation）：
 * - 当整个字符串恰好为单个 `{...}` 表达式或单个 `/$...` JSON Pointer 时，
 *   原样返回底层 JS 值（Array / boolean / number / object / null / string），绝不强转为 string；
 * - 仅当 `{...}` 嵌于长文本中（如 `"活跃 Worker {$docs.index.workers.length} 个"` 或 `"conversation:{$row.conversationId}"`）时，
 *   才执行字符串插值拼接。
 */

export interface EvalScope {
  $docs?: Record<string, unknown>
  $data?: Record<string, unknown>
  $row?: Record<string, unknown>
  $value?: unknown
  [key: string]: unknown
}

/**
 * 将路径表达式（不含外层 `{}`）解析为路径段数组。
 * 例如：
 * - `$docs.index.workers.length` -> `['$docs', 'index', 'workers', 'length']`
 * - `$docs["recall-graph"].nodes[0]` -> `['$docs', 'recall-graph', 'nodes', '0']`
 * - `/$docs/index/routerConversationId` -> `['$docs', 'index', 'routerConversationId']`
 */
export function parseExpressionSegments(rawExpr: string): string[] {
  const expr = rawExpr.trim()
  if (expr === '') return []

  if (expr.startsWith('/$')) {
    return expr
      .slice(1)
      .split('/')
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
  }

  const segments: string[] = []
  let i = 0
  const len = expr.length

  while (i < len) {
    if (expr[i] === '.') {
      i++
      continue
    }
    if (expr[i] === '[') {
      i++
      while (i < len && /\s/.test(expr[i]!)) i++
      const quote = expr[i]
      if (quote === '"' || quote === "'") {
        i++
        let key = ''
        while (i < len && expr[i] !== quote) {
          if (expr[i] === '\\' && i + 1 < len) {
            i++
          }
          key += expr[i]
          i++
        }
        if (expr[i] === quote) i++
        while (i < len && expr[i] !== ']') i++
        if (expr[i] === ']') i++
        segments.push(key)
      } else {
        let key = ''
        while (i < len && expr[i] !== ']') {
          key += expr[i]
          i++
        }
        if (expr[i] === ']') i++
        segments.push(key.trim())
      }
    } else {
      let token = ''
      while (i < len && expr[i] !== '.' && expr[i] !== '[') {
        token += expr[i]
        i++
      }
      const trimmed = token.trim()
      if (trimmed !== '') segments.push(trimmed)
    }
  }

  return segments
}

export function resolvePathInScope(rawExpr: string, scope: EvalScope): unknown {
  const segments = parseExpressionSegments(rawExpr)
  if (segments.length === 0) return undefined

  let current: unknown = scope
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      if (seg === 'length') return current.length
      const idx = Number(seg)
      if (Number.isInteger(idx) && idx >= 0 && idx < current.length) {
        current = current[idx]
      } else {
        return undefined
      }
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return current
}

const SINGLE_BRACE_EXPR_RE = /^\{([^{}]+)\}$/
const MULTI_BRACE_EXPR_RE = /\{([^{}]+)\}/g

/**
 * 求值单个字符串或任意嵌套 JSON 值：
 * - 若整串是 `"{$docs.index.workers}"` 或 `"/$docs/index/routerConversationId"`，返回原始 JS 值；
 * - 若字符串内含多个或内嵌 `{...}`，返回插值后的字符串；
 * - 若输入为数组或纯对象，递归求值其每个元素/属性。
 */
export function evaluateSpecValue<T = unknown>(template: unknown, scope: EvalScope): T {
  if (typeof template === 'string') {
    const trimmed = template.trim()
    if (trimmed.startsWith('/$')) {
      return resolvePathInScope(trimmed, scope) as T
    }
    const singleMatch = SINGLE_BRACE_EXPR_RE.exec(trimmed)
    if (singleMatch && singleMatch[1] !== undefined) {
      return resolvePathInScope(singleMatch[1], scope) as T
    }
    if (template.includes('{') && template.includes('}')) {
      const interpolated = template.replace(MULTI_BRACE_EXPR_RE, (_full, expr: string) => {
        const val = resolvePathInScope(expr, scope)
        if (val === undefined || val === null) return ''
        if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
          return String(val)
        }
        return JSON.stringify(val)
      })
      return interpolated as unknown as T
    }
    return template as unknown as T
  }

  if (Array.isArray(template)) {
    return template.map((item) => evaluateSpecValue(item, scope)) as unknown as T
  }

  if (template !== null && typeof template === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = evaluateSpecValue(v, scope)
    }
    return out as T
  }

  return template as T
}
