/**
 * json-schema.ts — 校验脚本提供的裸 JSON Schema。
 *
 * 自 @tintinweb/pi-subagents v0.23.1 (MIT) 移植：typebox v1（标准 JSON Schema
 * 校验器）作为唯一裸 JSON Schema 依赖；`@sinclair/typebox` 0.x 依赖 Kind 符号分发，
 * 对线上裸 Schema 抛 Unknown type，不可替换使用。
 *
 * Schema 在编译期（调用时）即冒烟校验，而不是等到第一次工具调用才失败——
 * 作者应在为模型付费之前知道 schema 不可用。
 */

import { Check, Errors } from 'typebox/value'

/** 可接受的最大 schema 序列化长度。 */
const MAX_SCHEMA_BYTES = 64 * 1024

/** 回报给调用方的校验错误条数上限。 */
const MAX_REPORTED_ERRORS = 5

export interface CompiledSchema {
  /** 原样保留的 schema（用于 journal key 与透传给宿主）。 */
  readonly schema: Record<string, unknown>
  /** `true`，或人类可读的问题描述。 */
  check(value: unknown): true | string
}

export type SchemaCompilation =
  | { ok: true; compiled: CompiledSchema }
  | { ok: false; message: string }

export function compileJsonSchema(schema: unknown): SchemaCompilation {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return { ok: false, message: 'agent() opts.schema must be a JSON Schema object.' }
  }
  const root = schema as Record<string, unknown>
  if (root['type'] !== 'object') {
    return {
      ok: false,
      message:
        'agent() opts.schema must have `type: "object"` at its root — it becomes the structured-output contract, ' +
        'and a non-object root is not something a model can be asked to fill.',
    }
  }

  let serialized: string
  try {
    serialized = JSON.stringify(root)
  } catch {
    return { ok: false, message: 'agent() opts.schema must be JSON-serializable.' }
  }
  if (serialized.length > MAX_SCHEMA_BYTES) {
    return {
      ok: false,
      message: `agent() opts.schema is too large (${serialized.length} bytes; the limit is ${MAX_SCHEMA_BYTES}).`,
    }
  }

  try {
    Check(root, {})
  } catch (error) {
    return {
      ok: false,
      message: `agent() opts.schema is not a schema this runtime can validate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  return { ok: true, compiled: { schema: root, check: (value) => checkAgainst(root, value) } }
}

function checkAgainst(schema: Record<string, unknown>, value: unknown): true | string {
  let valid: boolean
  try {
    valid = Check(schema, value)
  } catch (error) {
    return `the value could not be validated: ${error instanceof Error ? error.message : String(error)}`
  }
  if (valid) return true

  const reported: string[] = []
  try {
    for (const error of Errors(schema, value)) {
      const path = String(error.instancePath ?? '')
      const where = path === '' ? '$' : `$${path.replaceAll('/', '.')}`
      reported.push(`${where}: ${error.message}`)
      if (reported.length >= MAX_REPORTED_ERRORS) break
    }
  } catch {
    // Errors() 可能在校验器可 walk 但枚举失败时抛错；模糊信息仍指向正确问题。
  }
  return reported.length > 0 ? reported.join('; ') : 'the value does not match the required schema'
}
