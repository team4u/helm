/**
 * PluginHost UI register specification and action bind set validate.
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
 * composer.completer action source bind set validate (define phase end / enable commit point):
 * - this plugin reference: action must already declaration and idempotent: true(completion query high frequency trigger,
 *   must not bind set non- idempotent side effect action); action declaration can later than UI declaration, reason in define phase end validate;
 * - across plugin reference: only in enable commit point (crossPlugin=true, and enabled publish the same sync chunk)
 *   and target plugin when before enabled when validate store in and idempotent; target not yet register/enable when do not reject
 *   (legal later register, run phase frontend via action manifest honor bottom validate availability).
 * idempotent only is declaration mark record (allows assert chain heavy run), does not mean code security sandbox.
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
    if (typeof actionId !== 'string') continue; // register boundary already reject illegal shape
    const actionPluginId = source['actionPluginId'];
    const targetPluginId =
      typeof actionPluginId === 'string' && actionPluginId.length > 0 ? actionPluginId : pluginId;
    if (targetPluginId !== pluginId && !crossPlugin) continue;
    if (targetPluginId !== pluginId) {
      const target = plugins.get(targetPluginId);
      if (!target || !target.enabled) continue; // target not registered/not enabled: allows later register
      const binding = capabilityRegistry.getActionBinding(targetPluginId, actionId);
      if (binding === undefined) {
        throw new HelmError(
          'invalid_ui_spec',
          `plugin ${pluginId} completion source reference plugin ${targetPluginId} not declaration action ${actionId}`,
          400,
          { pluginId, id: String((u.spec as { id?: unknown }).id), targetPluginId, actionId },
        );
      }
      if (!binding.idempotent) {
        throw new HelmError(
          'invalid_ui_spec',
          `plugin ${pluginId} completion source bind set action ${targetPluginId}.${actionId} must idempotent: true`,
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
        `plugin ${pluginId} completion source reference this plugin not declaration action ${actionId}`,
        400,
        { pluginId, id: String((u.spec as { id?: unknown }).id), actionId },
      );
    }
    if (!binding.idempotent) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} completion source bind set action ${actionId} must idempotent: true(completion query must not trigger non- idempotent side effect)`,
        400,
        { pluginId, id: String((u.spec as { id?: unknown }).id), actionId },
      );
    }
  }
}
