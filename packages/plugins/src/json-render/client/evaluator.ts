/**
 * @json-render expression evaluator (supports raw JS type preservation).
 *
 * Accepts three path syntaxes uniformly:
 * 1. Brace dot paths: `{$docs.index.workers}`, `{$data.entry.data.meta.summary}`, `{$row.conversationId}`, `{$value}`
 * 2. Brace paths with bracketed string keys: `{$docs["recall-graph"].nodes}`, `{$docs['recall-graph'].nodes[0]}`
 * 3. Slash-style JSON Pointer paths: `/$docs/index/routerConversationId`
 *
 * Type-preservation rule:
 * - When the whole string is exactly one `{...}` expression or one `/$...`
 *   JSON Pointer, return the underlying JS value (Array / boolean / number /
 *   object / null / string) as-is — never coerce it to a string;
 * - Only when `{...}` is embedded inside a longer text (e.g. `"active workers: {$docs.index.workers.length}"`
 *   or `"conversation:{$row.conversationId}"`) do we interpolate into a string.
 */

export interface EvalScope {
  $docs?: Record<string, unknown>
  $data?: Record<string, unknown>
  $row?: Record<string, unknown>
  $value?: unknown
  [key: string]: unknown
}

/**
 * Parse a path expression (without the surrounding `{}`) into path segments.
 * Examples:
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

// Read own properties only: non-own keys resolve to undefined, which blocks
// prototype-chain paths like __proto__ / constructor / prototype (none of them
// is an own property of a plain object) and cannot trigger getter escapes.
function readOwnSegment(target: Record<string, unknown>, seg: string): unknown {
  return Object.prototype.hasOwnProperty.call(target, seg) ? target[seg] : undefined
}

function resolvePathInScope(rawExpr: string, scope: EvalScope): unknown {
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
      current = readOwnSegment(current as Record<string, unknown>, seg)
    } else {
      return undefined
    }
  }
  return current
}

const SINGLE_BRACE_EXPR_RE = /^\{([^{}]+)\}$/
const MULTI_BRACE_EXPR_RE = /\{([^{}]+)\}/g

/** Whether the content inside braces is a bindable expression: a `$`-prefixed path ($docs/$data/$row/$value, including a bare $value). */
function isBindableExpression(expr: string): boolean {
  return /^\$[\w$]*(\.|\[|$)/.test(expr)
}

function interpolate(template: string, scope: EvalScope): string {
  return template.replace(MULTI_BRACE_EXPR_RE, (full, expr: string) => {
    if (!isBindableExpression(expr)) return full
    const val = resolvePathInScope(expr, scope)
    if (val === undefined || val === null) return ''
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      return String(val)
    }
    return JSON.stringify(val)
  })
}

/**
 * Evaluate a single string or an arbitrarily nested JSON value:
 * - If the whole string is `"{$docs.index.workers}"` or `"/$docs/index/routerConversationId"`, return the raw JS value;
 * - If the string contains multiple or embedded `{...}` fragments, return the interpolated string;
 * - Brace content not starting with a `$` path (e.g. a JSON sample like `{"enabled":true}`) is treated as plain text and kept verbatim;
 * - Arrays and plain objects are evaluated recursively, element by element / property by property.
 */
export function evaluateSpecValue<T = unknown>(template: unknown, scope: EvalScope): T {
  if (typeof template === 'string') {
    const trimmed = template.trim()
    if (trimmed.startsWith('/$')) {
      return resolvePathInScope(trimmed, scope) as T
    }
    const singleMatch = SINGLE_BRACE_EXPR_RE.exec(trimmed)
    if (singleMatch && singleMatch[1] !== undefined && isBindableExpression(singleMatch[1])) {
      return resolvePathInScope(singleMatch[1], scope) as T
    }
    if (template.includes('{') && template.includes('}')) {
      return interpolate(template, scope) as unknown as T
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
