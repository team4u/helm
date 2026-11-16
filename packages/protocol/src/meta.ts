/**
 * Generic namespaced meta extension (JSON-safe boundary contract).
 *
 * The `meta` of AgentSpawnRequest / AgentExecutionInfo is the kernel envelope's only
 * business extension surface: the kernel understands only the "namespace -> JSON-safe
 * object" layer and does not interpret any fields inside a namespace (business shapes
 * such as worktree structures, workflow runId, spawn depth are validated by the
 * owning plugin at its own boundary with its schema). This module provides the envelope
 * shape validation: rejecting functions, Symbols, cycles (via a depth cap), non-finite
 * numbers, class instances and non-plain objects, and enforcing depth/count/length
 * limits (no unbounded arbitrary unknown objects accepted).
 *
 * This file has zero runtime dependencies (only HelmError); the kernel and internal/external plugins use it on equal footing.
 */
import { HelmError } from './error.js'

/**
 * JSON-safe pure value: a closure that round-trips stably through JSON.stringify
 * (no undefined / functions / Symbols / cycles / NaN / Infinity / class instances).
 */
export type JsonSafeValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonSafeValue[]
  | { readonly [key: string]: JsonSafeValue | undefined }

/**
 * JSON-safe object (property values may be undefined: consistent with JSON.stringify
 * semantics, keys with an explicit undefined are treated as absent during
 * serialization / validation cloning).
 */
export type JsonSafeObject = { readonly [key: string]: JsonSafeValue | undefined }

/**
 * Namespaced meta: keys are namespace identifiers (by convention the plugin ID that
 * defines the business schema, e.g. 'builtin:workflow'), values are JSON-safe objects
 * private to that namespace. The two-key structure guarantees namespaces never
 * trespass on each other; business fields inside a value are validated by the
 * namespace owner.
 */
export type AgentNamespacedMeta = Readonly<Record<string, JsonSafeObject>>

/** Envelope limits: reject deep nesting (which also forecloses circular references) and key/element count bombs. */
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
 * Recursively validate a single JSON-safe value (returns a clone, severing later
 * mutations by the caller; any invalid shape throws explicitly with a locating path
 * and reason in the error). `depth` is the nesting level inside a namespace slot
 * (the slot's direct value is 1): only containers (objects/arrays) are counted and
 * capped, and exceeding the cap is rejected (which also forecloses circular
 * references); primitive values are leaves and do not consume depth.
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
    throw metaError(agentId, field, `${path} exceeds the total meta node limit of ${MAX_META_TOTAL_NODES}`)
  }
  budget.remaining -= 1
  if (value === null) return null
  const type = typeof value
  if (type === 'string') {
    if ((value as string).length > MAX_META_STRING_LENGTH) {
      throw metaError(agentId, field, `${path} string length exceeds ${MAX_META_STRING_LENGTH}`)
    }
    return value as string
  }
  if (type === 'boolean') return value as boolean
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw metaError(agentId, field, `${path} numeric value must be finite (NaN/Infinity rejected)`)
    }
    return value as number
  }
  if (type === 'object') {
    if (depth > MAX_META_DEPTH) {
      throw metaError(agentId, field, `${path} nesting depth exceeds ${MAX_META_DEPTH}`)
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_META_ARRAY_LENGTH) {
        throw metaError(agentId, field, `${path} array length exceeds ${MAX_META_ARRAY_LENGTH}`)
      }
      const out: JsonSafeValue[] = []
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i]
        // Sparse array holes and explicit undefined elements are equally pathological shapes (JSON has no representation for them).
        if (item === undefined) {
          throw metaError(agentId, field, `${path}[${i}] array element must not be undefined (sparse holes rejected)`)
        }
        out.push(sanitizeJsonSafeValue(item, `${path}[${i}]`, budget, depth + 1, agentId, field))
      }
      return out
    }
    if (!isPlainObject(value)) {
      throw metaError(agentId, field, `${path} must be a plain object (class instances/Date/Map and other structured values rejected)`)
    }
    const keys = Object.keys(value)
    if (keys.length > MAX_META_KEYS_PER_LEVEL) {
      throw metaError(agentId, field, `${path} object key count exceeds ${MAX_META_KEYS_PER_LEVEL}`)
    }
    const out: Record<string, JsonSafeValue> = {}
    for (const key of keys) {
      if (key.length > MAX_META_STRING_LENGTH) {
        throw metaError(agentId, field, `${path} key name too long`)
      }
      // Keys with an explicit undefined are treated as absent per JSON.stringify
      // semantics (dropped during cloning); all other values are validated
      // recursively; undefined inside array elements is still explicitly rejected
      // (pathological shape).
      if (value[key] === undefined) continue
      out[key] = sanitizeJsonSafeValue(value[key], `${path}.${key}`, budget, depth + 1, agentId, field)
    }
    return out
  }
  throw metaError(agentId, field, `${path} contains a non-JSON-safe value (${type}; functions/Symbols/undefined rejected)`)
}

function metaError(agentId: string, field: string, reason: string): HelmError {
  return new HelmError('meta_invalid', `${field} from agent '${agentId}' is invalid: ${reason}`, 400, {
    agentId,
    field,
    reason,
  })
}

/**
 * Validate and clone namespaced meta (envelope layer): must be a plain object; keys
 * are non-empty string namespaces; each namespace's value is a plain object
 * (recursively validated as JSON-safe). Business fields inside a namespace are not
 * validated at this layer (the namespace-owner plugin validates them with its own schema).
 */
export function sanitizeAgentNamespacedMeta(
  value: unknown,
  context: { agentId: string; field: string },
): AgentNamespacedMeta {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    throw metaError(context.agentId, context.field, 'must be a map from namespaces to plain objects')
  }
  const budget = { remaining: MAX_META_TOTAL_NODES }
  const out: Record<string, JsonSafeObject> = {}
  for (const namespace of Object.keys(value)) {
    if (namespace.trim() === '') {
      throw metaError(context.agentId, context.field, 'namespace keys must be non-empty, non-whitespace-only strings')
    }
    const slot = (value as Record<string, unknown>)[namespace]
    if (!isPlainObject(slot)) {
      throw metaError(
        context.agentId,
        context.field,
        `the value of namespace '${namespace}' must be a plain object (business fields are validated by the namespace-owner plugin)`,
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
