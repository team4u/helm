/**
 * 停用前的持久资源占用探测：服务自声明 + 依赖者占用 + Profile/会话引用。
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
      label: `插件 ${dependent.definition.id} 依赖 ${pluginId}（${dependent.enabled ? '当前已启用' : '正在启用'}）`,
    });
  }
  if (additions.length > 0) usages.unshift(...additions);
}

/**
 * 聚合全部持久资源占用；轻量测试宿主未实现 profiles.list / listConversations
 * 时（501 unsupported）跳过对应宿主资产探测，真实错误照常上抛。
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
        label: `角色 "${profile.name || profile.id}" 绑定了外部运行时 ${profile.runtime.kind}`,
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
        label: `角色 "${profile.name || profile.id}" 默认模型使用了 ${profile.model}`,
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
          label: `会话 #${conv.id} 正在使用模型 ${conv.model}`,
        });
      }
    }
  }
  // 异步引用探测期间可能有并发 enable 提交，结束前收口复查依赖者防止 TOCTOU
  appendDependentUsages(deps.plugins, pluginId, usages);
  return usages;
}
