/**
 * JSON Schema boundary validator (AJV wrapper, the single implementation shared by kernel and plugins).
 *
 * Why centralized: validating inputs and outputs uniformly at the boundary is a kernel iron rule;
 * failures must surface explicitly (validation_error / invalid_plugin_output), never silently pass.
 * Plugins are trusted in-process code, but their products (action inputs, action outputs, transform
 * payloads) still need runtime boundary validation — TypeScript types do not cross runtime boundaries.
 */
import { Ajv, type ValidateFunction } from 'ajv'
import { HelmError } from './error.js'
import type { JsonSchema } from './plugin-dto.js'

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false })

const compiledCache = new WeakMap<JsonSchema, ValidateFunction>()

function compile(schema: JsonSchema): ValidateFunction {
  const cached = compiledCache.get(schema)
  if (cached) return cached
  // Core interfaces are all synchronous validation: an $async schema's validate function returns a
  // Promise, and a synchronous boolean check would treat that Promise as truthy, letting invalid
  // input through and producing an unhandled rejection — reject at the compile boundary explicitly;
  // never introduce an async path.
  if ((schema as { $async?: unknown }).$async !== undefined) {
    throw new HelmError(
      'invalid_plugin_schema',
      `Declared JSON Schema contains $async: the core synchronous validation boundary does not support async schemas`,
      500,
      { schema },
    )
  }
  let fn: ValidateFunction
  try {
    fn = ajv.compile(schema)
  } catch (error) {
    throw new HelmError(
      'invalid_plugin_schema',
      `JSON Schema compilation failed: ${error instanceof Error ? error.message : String(error)}`,
      500,
      { schema },
    )
  }
  compiledCache.set(schema, fn)
  return fn
}

export function validateOrThrow(
  schema: JsonSchema,
  value: unknown,
  message: string,
  code = 'validation_error',
  status = 400,
): void {
  const fn = compile(schema)
  if (!fn(value)) {
    throw new HelmError(code, `${message}: ${formatErrors(fn.errors)}`, status, { errors: fn.errors })
  }
}

function formatErrors(errors: ValidateFunction['errors'] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) return 'Unknown validation error'
  return errors
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim())
    .join('; ')
}
