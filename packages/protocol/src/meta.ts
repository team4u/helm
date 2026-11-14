/**
 * 通用命名空间 meta 扩展（JSON-safe 边界契约）。
 *
 * AgentSpawnRequest / AgentExecutionInfo 的 `meta` 是内核 envelope 唯一的
 * 业务扩展面：内核只认识「命名空间 → JSON-safe 对象」这一层结构，不解释
 * 任何命名空间内部字段（worktree 结构、workflow runId、派生深度等业务形状
 * 由对应插件在自身边界用其 schema 校验）。本模块提供 envelope 形状校验：
 * 拒绝函数、Symbol、循环（深度上限）、非有限数、类实例与非普通对象，
 * 并施加深度/数量/长度界限（不接受无界 unknown 任意对象）。
 *
 * 本文件零运行时依赖（仅 HelmError）；内核与内外插件平权使用。
 */
import { HelmError } from './error.js'

/**
 * JSON-safe 纯值：可经 JSON.stringify 稳定往返的闭包（不含 undefined /
 * 函数 / Symbol / 循环 / NaN / Infinity / 类实例）。
 */
export type JsonSafeValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonSafeValue[]
  | { readonly [key: string]: JsonSafeValue | undefined }

/**
 * JSON-safe 对象（属性值可为 undefined：与 JSON.stringify 语义一致，显式
 * undefined 的键在序列化/校验克隆时按缺省处理）。
 */
export type JsonSafeObject = { readonly [key: string]: JsonSafeValue | undefined }

/**
 * 命名空间 meta：键为命名空间标识（约定为定义该业务 schema 的插件 ID，
 * 如 'builtin:workflow'），值为该命名空间私有的 JSON-safe 对象。两个键的
 * 结构保证命名空间间互不越界；值内业务字段由命名空间所有方校验。
 */
export type AgentNamespacedMeta = Readonly<Record<string, JsonSafeObject>>

/** envelope 界限：拒绝深层嵌套（同时封死循环引用）与键/元素数量炸弹。 */
const MAX_META_DEPTH = 8
const MAX_META_KEYS_PER_LEVEL = 64
const MAX_META_ARRAY_LENGTH = 1024
const MAX_META_STRING_LENGTH = 65_536
const MAX_META_TOTAL_NODES = 4096

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 递归校验单个 JSON-safe 值（返回克隆，切断调用方后续突变；任何非法形状
 * 显式抛错，错误信息携带定位路径与原因）。depth 为命名空间槽内的嵌套
 * 层级（槽直属值为 1）：仅对容器（对象/数组）计数并设上限，超限即拒绝
 * （同时封死循环引用）；原语值是叶子，不占深度。
 */
function sanitizeJsonSafeValue(
  value: unknown,
  path: string,
  budget: { remaining: number },
  depth: number,
  agentId: string,
  field: string,
): JsonSafeValue {
  if (budget.remaining <= 0) {
    throw metaError(agentId, field, `${path} 超出 meta 总节点上限 ${MAX_META_TOTAL_NODES}`)
  }
  budget.remaining -= 1
  if (value === null) return null
  const type = typeof value
  if (type === 'string') {
    if ((value as string).length > MAX_META_STRING_LENGTH) {
      throw metaError(agentId, field, `${path} 字符串长度超过 ${MAX_META_STRING_LENGTH}`)
    }
    return value as string
  }
  if (type === 'boolean') return value as boolean
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw metaError(agentId, field, `${path} 数值必须有限（拒绝 NaN/Infinity）`)
    }
    return value as number
  }
  if (type === 'object') {
    if (depth > MAX_META_DEPTH) {
      throw metaError(agentId, field, `${path} 嵌套深度超过 ${MAX_META_DEPTH}`)
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_META_ARRAY_LENGTH) {
        throw metaError(agentId, field, `${path} 数组长度超过 ${MAX_META_ARRAY_LENGTH}`)
      }
      const out: JsonSafeValue[] = []
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i]
        // 稀疏数组洞与显式 undefined 元素同为病态形状（JSON 无对应表示）。
        if (item === undefined) {
          throw metaError(agentId, field, `${path}[${i}] 数组元素不能是 undefined（拒绝稀疏洞）`)
        }
        out.push(sanitizeJsonSafeValue(item, `${path}[${i}]`, budget, depth + 1, agentId, field))
      }
      return out
    }
    if (!isPlainObject(value)) {
      throw metaError(agentId, field, `${path} 必须是普通对象（拒绝类实例/Date/Map 等结构化值）`)
    }
    const keys = Object.keys(value)
    if (keys.length > MAX_META_KEYS_PER_LEVEL) {
      throw metaError(agentId, field, `${path} 对象键数超过 ${MAX_META_KEYS_PER_LEVEL}`)
    }
    const out: Record<string, JsonSafeValue> = {}
    for (const key of keys) {
      if (key.length > MAX_META_STRING_LENGTH) {
        throw metaError(agentId, field, `${path} 键名过长`)
      }
      // 显式 undefined 的键按 JSON.stringify 语义视为缺省（克隆时丢弃），
      // 其余值递归校验；数组元素中的 undefined 仍显式拒绝（病态形状）。
      if (value[key] === undefined) continue
      out[key] = sanitizeJsonSafeValue(value[key], `${path}.${key}`, budget, depth + 1, agentId, field)
    }
    return out
  }
  throw metaError(agentId, field, `${path} 含非 JSON-safe 值（${type}；拒绝函数/Symbol/undefined）`)
}

function metaError(agentId: string, field: string, reason: string): HelmError {
  return new HelmError('meta_invalid', `agent '${agentId}' 的 ${field} 非法：${reason}`, 400, {
    agentId,
    field,
    reason,
  })
}

/**
 * 校验并克隆命名空间 meta（envelope 层）：必须是普通对象；键为非空字符串
 * 命名空间；每个命名空间的值为普通对象（JSON-safe 递归校验）。命名空间
 * 内部业务字段不在本层校验（由命名空间所有方插件用自身 schema 验证）。
 */
export function sanitizeAgentNamespacedMeta(
  value: unknown,
  context: { agentId: string; field: string },
): AgentNamespacedMeta {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    throw metaError(context.agentId, context.field, '必须是命名空间到普通对象 的映射')
  }
  const budget = { remaining: MAX_META_TOTAL_NODES }
  const out: Record<string, JsonSafeObject> = {}
  for (const namespace of Object.keys(value)) {
    if (namespace.trim() === '') {
      throw metaError(context.agentId, context.field, '命名空间键必须是非空非纯空白字符串')
    }
    const slot = (value as Record<string, unknown>)[namespace]
    if (!isPlainObject(slot)) {
      throw metaError(
        context.agentId,
        context.field,
        `命名空间 '${namespace}' 的值必须是普通对象（业务字段由命名空间所有方插件校验）`,
      )
    }
    out[namespace] = sanitizeJsonSafeValue(
      slot,
      `meta.${namespace}`,
      budget,
      0,
      context.agentId,
      context.field,
    ) as JsonSafeObject
  }
  return out
}
