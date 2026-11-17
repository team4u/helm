/**
 * PluginHost UI registration validation and action binding checks.
 */
import { HelmError } from '@helm/protocol';
import type { UiRegistry } from './ui-registry.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { PluginState } from './types.js';
import { isPlainObject } from './shared.js';

export function assertUiDocsRegistered(
  pluginId: string,
  uiRegistry: UiRegistry,
  hasPublicDoc: (name: string) => boolean,
  hasPublicSessionDoc: (name: string) => boolean,
): void {
  uiRegistry.assertUiDocsRegistered(
    pluginId,
    hasPublicDoc,
    hasPublicSessionDoc,
  );
}

/**
 * Validates `composer.completer` action source bindings at definition end and enable commit:
 * - Same-plugin references: the action must be declared with `idempotent: true` (completer queries
 *   fire frequently and must not trigger side-effecting actions); verified at end of definition;
 * - Cross-plugin references: checked at enable commit (`crossPlugin=true`) when the target plugin is
 *   currently enabled; unregistered/disabled targets are allowed to register later and verified at runtime.
 * `idempotent` is a declarative contract (safe to replay on disconnect), not an execution sandbox.
 */
export function assertUiCompleterActionBindings(
  pluginId: string,
  uiRegistry: UiRegistry,
  capabilityRegistry: CapabilityRegistry,
  plugins: Map<string, PluginState>,
  crossPlugin: boolean,
): void {
  for (const u of uiRegistry.getUiByPlugin(pluginId)) {
    if (u.surface !== 'composer.completer') continue;
    const source = (u.spec as { source?: unknown }).source;
    if (!isPlainObject(source) || source['kind'] !== 'action') continue;
    const actionId = source['actionId'];
    if (typeof actionId !== 'string') continue; // invalid shape already rejected at registration
    const actionPluginId = source['actionPluginId'];
    const targetPluginId =
      typeof actionPluginId === 'string' && actionPluginId.length > 0 ? actionPluginId : pluginId;
    if (targetPluginId !== pluginId && !crossPlugin) continue;
    if (targetPluginId !== pluginId) {
      const target = plugins.get(targetPluginId);
      if (!target || !target.enabled) continue; // target not yet registered/enabled: allow deferred registration
      const binding = capabilityRegistry.getActionBinding(targetPluginId, actionId);
      if (binding === undefined) {
        throw new HelmError(
          'invalid_ui_spec',
          `Plugin ${pluginId} completion source references undeclared action ${actionId} from plugin ${targetPluginId}`,
          400,
          { pluginId, id: String((u.spec as { id?: unknown }).id), targetPluginId, actionId },
        );
      }
      if (!binding.idempotent) {
        throw new HelmError(
          'invalid_ui_spec',
          `Plugin ${pluginId} completion source action ${targetPluginId}.${actionId} must declare idempotent: true`,
          400,
          { pluginId, id: String((u.spec as { id?: unknown }).id), targetPluginId, actionId },
        );
      }
      continue;
    }
    const binding = capabilityRegistry.getActionBinding(pluginId, actionId);
    if (binding === undefined) {
      throw new HelmError(
        'invalid_ui_spec',
        `Plugin ${pluginId} completion source references undeclared action ${actionId}`,
        400,
        { pluginId, id: String((u.spec as { id?: unknown }).id), actionId },
      );
    }
    if (!binding.idempotent) {
      throw new HelmError(
        'invalid_ui_spec',
        `Plugin ${pluginId} completion source action ${actionId} must declare idempotent: true (completion queries must not trigger non-idempotent side effects)`,
        400,
        { pluginId, id: String((u.spec as { id?: unknown }).id), actionId },
      );
    }
  }
}
