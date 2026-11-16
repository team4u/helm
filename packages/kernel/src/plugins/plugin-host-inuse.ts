/**
 * deactivate before durable asset occupy probe: service self declaration + dependency occupy + Profile/conversation reference.
 */
import { HelmError } from '@helm/protocol';
import { collectServiceInUse } from './service-coordinator.js';
import { collectDependents } from './plugin-host-deps.js';
import type { UiRegistry } from './ui-registry.js';
import type { PluginHostBackend, PluginInUseItem, PluginState } from './types.js';

export interface CollectInUseDeps {
  plugins: ReadonlyMap<string, PluginState>;
  uiRegistry: UiRegistry;
  host: PluginHostBackend;
}

function appendDependentUsages(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
  usages: PluginInUseItem[],
): void {
  const known = new Set(
    usages.filter((u) => u.kind === 'plugin_dependency').map((u) => u.id),
  );
  const additions: PluginInUseItem[] = [];
  for (const dependent of collectDependents(plugins, pluginId)) {
    if (known.has(dependent.definition.id)) continue;
    additions.push({
      kind: 'plugin_dependency',
      id: dependent.definition.id,
      label: `plugin ${dependent.definition.id} dependency ${pluginId}(${dependent.enabled ? 'when before enabled' : 'is now enable'})`,
    });
  }
  if (additions.length > 0) usages.unshift(...additions);
}

/**
 * aggregate all durable asset occupy; light amount test host not implemented profiles.list / listConversations
 * when (501 unsupported) skip for should host asset probe, real error per common on throw.
 */
export async function collectPluginInUse(
  pluginId: string,
  state: PluginState,
  deps: CollectInUseDeps,
): Promise<PluginInUseItem[]> {
  const usages: PluginInUseItem[] = await collectServiceInUse(pluginId, state);
  appendDependentUsages(deps.plugins, pluginId, usages);

  const runtimeKinds = new Set(deps.uiRegistry.getProfileRuntimeKinds(pluginId));
  const providerIds = state.providers.map((p) => p.provider.id);
  if (runtimeKinds.size === 0 && providerIds.length === 0) return usages;

  let profiles: Array<{
    id: string;
    name?: string;
    model?: string;
    runtime?: { kind: string };
  }> = [];
  if ((runtimeKinds.size > 0 || providerIds.length > 0) && deps.host.profiles?.list) {
    try {
      profiles = (await deps.host.profiles.list()) as typeof profiles;
    } catch (err) {
      if (!(err instanceof HelmError && err.code === 'unsupported')) throw err;
    }
  }
  for (const profile of profiles) {
    if (runtimeKinds.size > 0 && profile.runtime && runtimeKinds.has(profile.runtime.kind)) {
      usages.push({
        kind: 'profile_runtime',
        id: profile.id,
        label: `role "${profile.name || profile.id}" bind set external runtime ${profile.runtime.kind}`,
      });
    }
    if (
      providerIds.length > 0 &&
      typeof profile.model === 'string' &&
      providerIds.some((pid) => profile.model!.startsWith(`${pid}/`))
    ) {
      usages.push({
        kind: 'profile_model',
        id: profile.id,
        label: `role "${profile.name || profile.id}" by default model use ${profile.model}`,
      });
    }
  }

  if (providerIds.length > 0) {
    let conversations: Array<{ id: number; model?: string }> = [];
    try {
      conversations = deps.host.listConversations() as typeof conversations;
    } catch (err) {
      if (!(err instanceof HelmError && err.code === 'unsupported')) throw err;
    }
    for (const conv of conversations) {
      if (
        typeof conv.model === 'string' &&
        conv.model.length > 0 &&
        providerIds.some((pid) => conv.model!.startsWith(`${pid}/`))
      ) {
        usages.push({
          kind: 'conversation_model',
          id: String(conv.id),
          label: `conversation #${conv.id} is now use model ${conv.model}`,
        });
      }
    }
  }
  // async reference probe during may has concurrency enable commit, end before consolidate re- inspect dependency guard against TOCTOU
  appendDependentUsages(deps.plugins, pluginId, usages);
  return usages;
}
