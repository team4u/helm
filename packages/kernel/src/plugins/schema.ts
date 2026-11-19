/**
 * Plugin boundary JSON Schema validation: thin kernel wrapper delegating compilation, caching,
 * and validation to `@helmx/protocol` (single TypeBox-backed implementation across the monorepo).
 */
import { assertSchemaCompilable, validateOrThrow, type JsonSchema } from '@helmx/protocol';

export { assertSchemaCompilable, validateOrThrow };

/** Validate action input (HTTP body / CLI flags / Agent Tool / Workflow action() five-end shared). Fails with 400 validation_error. */
export function validatePluginInput(pluginId: string, actionId: string, schema: JsonSchema, input: unknown): void {
  validateOrThrow(
    schema,
    input,
    `action ${pluginId}.${actionId} reference validation failed`,
    'validation_error',
    400,
    { pluginId, actionId },
  );
}

/** Validate plugin action output. Fails with 500 invalid_plugin_output (plugin artifact contract violation, not caller error). */
export function validatePluginOutput(pluginId: string, actionId: string, schema: JsonSchema, output: unknown): void {
  validateOrThrow(
    schema,
    output,
    `action ${pluginId}.${actionId} output do not conforms to declaration outputSchema`,
    'invalid_plugin_output',
    500,
    { pluginId, actionId },
  );
}
