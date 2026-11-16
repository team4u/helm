/**
 * json-schema.ts -- validate bare JSON Schemas provided by scripts.
 *
 * Ported from @tintinweb/pi-subagents v0.23.1 (MIT): typebox v1 (the standard JSON Schema
 * validator) is the only bare-JSON-Schema dependency; `@sinclair/typebox` 0.x relies on Kind-symbol
 * dispatch and throws Unknown type on bare online schemas, so it cannot be substituted in.
 *
 * Schemas are smoke-validated at compile time (call time) instead of failing at the first tool
 * call -- the author should learn the schema is unusable before paying for a model.
 */

import { Check, Errors } from 'typebox/value'

/** The maximum accepted serialized schema length. */
const MAX_SCHEMA_BYTES = 64 * 1024

/** Cap on validation errors reported back to the caller. */
const MAX_REPORTED_ERRORS = 5

export interface CompiledSchema {
  /** The schema kept as-is (for journal keys and pass-through to the host). */
  readonly schema: Record<string, unknown>
  /** Either `true`, or a human-readable problem description. */
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
    // Errors() may throw when the validator can walk but fails to enumerate; the vague message still points at the right problem.
  }
  return reported.length > 0 ? reported.join('; ') : 'the value does not match the required schema'
}
