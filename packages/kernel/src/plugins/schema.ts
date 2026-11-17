/**
 * Plugin boundary JSON Schema validator (AJV wrapper for the kernel plugin host).
 *
 * Generic compilation caching and `validateOrThrow` live in `@helm/protocol` (shared across kernel and plugins,
 * including `$async` rejection and compile diagnostics); this module preserves host-specific registration checks
 * and tailored action input/output error messages.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import { HelmError, type JsonSchema } from '@helm/protocol';

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });

const compiledCache = new WeakMap<JsonSchema, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) return cached;
  // Kernel validation is strictly synchronous: `$async` validators return a Promise, which a synchronous
  // boolean check would treat as truthy while leaking an unhandled rejection. Reject them at compile time.
  if ((schema as { $async?: unknown }).$async !== undefined) {
    throw new HelmError(
      'invalid_plugin_schema',
      `Plugin declared a JSON Schema containing $async: async schemas are not supported on the synchronous validation boundary`,
      500,
      { schema },
    );
  }
  let fn: ValidateFunction;
  try {
    fn = ajv.compile(schema);
  } catch (err) {
    throw new HelmError(
      'invalid_plugin_schema',
      `Plugin declared an invalid JSON Schema that failed to compile: ${err instanceof Error ? err.message : String(err)}`,
      500,
      { schema },
    );
  }
  compiledCache.set(schema, fn);
  return fn;
}

/** Registration-time pre-compilation check so `$async` or invalid schemas fail immediately with `invalid_plugin_schema`. */
export function assertSchemaCompilable(schema: JsonSchema): void {
  compile(schema);
}

function formatErrors(errors: Array<{ instancePath?: string; message?: string }> | null | undefined): string {
  if (!errors || errors.length === 0) return 'unknown';
  return errors.map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim()).join('; ');
}

/** Validates action input across HTTP, CLI, Agent Tool, and Workflow `action()` (`400 validation_error` on failure). */
export function validatePluginInput(pluginId: string, actionId: string, schema: JsonSchema, input: unknown): void {
  const fn = compile(schema);
  if (!fn(input)) {
    throw new HelmError(
      'validation_error',
      `Action ${pluginId}.${actionId} input validation failed: ${formatErrors(fn.errors)}`,
      400,
      { pluginId, actionId, errors: fn.errors },
    );
  }
}

/** Validates plugin action output (`500 invalid_plugin_output` — plugin contract violation, not caller fault). */
export function validatePluginOutput(pluginId: string, actionId: string, schema: JsonSchema, output: unknown): void {
  const fn = compile(schema);
  if (!fn(output)) {
    throw new HelmError(
      'invalid_plugin_output',
      `Action ${pluginId}.${actionId} output does not conform to outputSchema: ${formatErrors(fn.errors)}`,
      500,
      { pluginId, actionId, errors: fn.errors },
    );
  }
}

/** Generic boundary validator (handover files, route params, etc.) re-exported from `@helm/protocol`. */
export { validateOrThrow } from '@helm/protocol';
