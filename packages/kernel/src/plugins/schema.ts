/**
 * plugin boundary JSON Schema validate (AJV wrap, kernel plugin host dedicated use).
 *
 * through use compile cache and validateOrThrow already consolidate @helm/protocol(kernel and plugin
 * sharing unique implement, contains $async reject and compile error diagnose); this file keep kernel plugin
 * host dedicated use semantics: register phase pre- compile check and action/out reference set system errors text proposal.
 */
import { Ajv, type ValidateFunction } from 'ajv';
import { HelmError, type JsonSchema } from '@helm/protocol';

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: false });

const compiledCache = new WeakMap<JsonSchema, ValidateFunction>();

function compile(schema: JsonSchema): ValidateFunction {
  const cached = compiledCache.get(schema);
  if (cached) return cached;
  // core interface all is sync validate:$async Schema validate function return Promise,
  // sync boolean decide will Promise when truthy let through invalid input and produce unhandled
  // rejection- - in compile boundary explicit reject, never introduce async path.
  if ((schema as { $async?: unknown }).$async !== undefined) {
    throw new HelmError(
      'invalid_plugin_schema',
      `plugin declaration JSON Schema contains $async: core sync validate boundary unsupported async Schema`,
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
      `plugin declaration JSON Schema itself cannot compile:${err instanceof Error ? err.message : String(err)}`,
      500,
      { schema },
    );
  }
  compiledCache.set(schema, fn);
  return fn;
}

/** register phase pre- compile check:$async / illegal Schema in declaration boundary i.e. report invalid_plugin_schema(trigger whole rollback), other etc. first time invoke. */
export function assertSchemaCompilable(schema: JsonSchema): void {
  compile(schema);
}

function formatErrors(errors: Array<{ instancePath?: string; message?: string }> | null | undefined): string {
  if (!errors || errors.length === 0) return 'unknown';
  return errors.map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim()).join('; ');
}

/** validate action reference (HTTP body / CLI flags / Agent Tool / Workflow action() five end shared use). failed 400 validation_error. */
export function validatePluginInput(pluginId: string, actionId: string, schema: JsonSchema, input: unknown): void {
  const fn = compile(schema);
  if (!fn(input)) {
    throw new HelmError(
      'validation_error',
      `action ${pluginId}.${actionId} reference validation failed:${formatErrors(fn.errors)}`,
      400,
      { pluginId, actionId, errors: fn.errors },
    );
  }
}

/** validate plugin action output. failed 500 invalid_plugin_output(plugin artifact violate about, non- caller error). */
export function validatePluginOutput(pluginId: string, actionId: string, schema: JsonSchema, output: unknown): void {
  const fn = compile(schema);
  if (!fn(output)) {
    throw new HelmError(
      'invalid_plugin_output',
      `action ${pluginId}.${actionId} output do not conforms to declaration outputSchema:${formatErrors(fn.errors)}`,
      500,
      { pluginId, actionId, errors: fn.errors },
    );
  }
}

/** through use boundary validate (handover file, routing parameter etc.) already consolidate protocol, this where again export supply kernel since has reference. */
export { validateOrThrow } from '@helm/protocol';
