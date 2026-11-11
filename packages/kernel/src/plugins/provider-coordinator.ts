/**
 * 插件模型 Provider 挂载、卸载与生命周期协调。
 */
import type { Provider } from '@earendil-works/pi-ai';
import { HelmError } from '@helm/protocol';
import {
  isPlainObject,
  toJsonSafeError,
  type JsonSafeErrorInfo,
} from './shared.js';
import type {
  PluginProviderPort,
  PluginState,
  ProviderEntry,
} from './types.js';

/**
 * provider 声明边界形状校验（pi-ai Provider 最小契约）：
 * id/name 非空字符串、auth 纯对象且至少声明 apiKey/oauth 之一、
 * getModels/stream/streamSimple 为函数（refreshModels 等可选能力不校验）。
 * 非法形状在此显式拒绝——留到运行期才炸会让「启用成功但模型不可用」
 * 成为静默降级（诚实性纪律）。
 */
export function assertValidProviderShape(pluginId: string, provider: Provider): void {
  const fail = (detail: string): HelmError =>
    new HelmError('invalid_provider_spec', `插件 ${pluginId} 声明的 provider ${detail}`, 400, { pluginId });
  if (!isPlainObject(provider)) throw fail('必须是纯对象');
  const { id, name, auth } = provider as { id?: unknown; name?: unknown; auth?: unknown };
  if (typeof id !== 'string' || id.length === 0) throw fail('缺少非空字符串 id');
  if (typeof name !== 'string' || name.length === 0) throw fail(`(${id}) 缺少非空字符串 name`);
  if (!isPlainObject(auth)) throw fail(`(${id}) auth 必须是纯对象`);
  if (auth['apiKey'] === undefined && auth['oauth'] === undefined) {
    throw fail(`(${id}) auth 必须至少声明 apiKey / oauth 之一（pi-ai ProviderAuth 契约）`);
  }
  for (const fn of ['getModels', 'stream', 'streamSimple'] as const) {
    if (typeof (provider as Record<string, unknown>)[fn] !== 'function') {
      throw fail(`(${id}) 缺少 ${fn} 函数`);
    }
  }
}

/**
 * 挂载本周期声明的全部 provider（在服务 start 之前）：
 * - 端口未提供且存在声明 → 显式 501（禁静默；默认停用探测不会到达这里）；
 * - 逐个挂载并登记卸载函数；任一失败对已挂载者逆序卸载（卸载失败聚合）；
 * - 卸载函数置 null 防止 teardown 重复卸载（幂等层：clearRegistrations 直接清表）。
 */
export async function registerProviders(state: PluginState, port?: PluginProviderPort): Promise<void> {
  if (state.providers.length === 0) return;
  if (!port) {
    throw new HelmError(
      'provider_port_unavailable',
      `插件 ${state.definition.id} 声明了 provider，但 PluginHost 未提供 providers 挂载端口（runtime 缺失），拒绝静默丢弃`,
      501,
      { pluginId: state.definition.id, providers: state.providers.map((p) => p.provider.id) },
    );
  }
  const pluginId = state.definition.id;
  const mounted: ProviderEntry[] = [];
  try {
    for (const entry of state.providers) {
      entry.unregister = await port.register(entry.provider, pluginId);
      mounted.push(entry);
    }
  } catch (err) {
    const rollbackErrors: Array<{ providerId: string; error: JsonSafeErrorInfo }> = [];
    for (const entry of mounted.reverse()) {
      const providerId = entry.provider.id;
      const unregister = entry.unregister;
      entry.unregister = null;
      if (!unregister) continue;
      try {
        await unregister();
      } catch (unregisterErr) {
        rollbackErrors.push({ providerId, error: toJsonSafeError(unregisterErr) });
      }
    }
    if (err instanceof HelmError) {
      throw rollbackErrors.length > 0
        ? new HelmError(err.code, err.message, err.status, {
            ...((err.details as object) ?? {}),
            unregisterErrors: rollbackErrors,
          })
        : err;
    }
    throw new HelmError(
      'plugin_provider_register_failed',
      `插件 ${pluginId} provider 挂载失败：${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId, unregisterErrors: rollbackErrors },
    );
  }
}

/**
 * 逆序卸载已挂载的 provider（在服务 stop 之后调用）。卸载失败聚合显式抛出，
 * 绝不静默吞掉；无论成败都置 null 并由调用方 clearRegistrations 收尾，
 * 不允许同一 provider 被卸载两次。
 */
export async function unregisterProviders(state: PluginState): Promise<void> {
  const errors: Array<{ providerId: string; error: JsonSafeErrorInfo }> = [];
  for (const entry of [...state.providers].reverse()) {
    const providerId = entry.provider.id;
    const unregister = entry.unregister;
    entry.unregister = null;
    if (!unregister) continue;
    try {
      await unregister();
    } catch (err) {
      errors.push({ providerId, error: toJsonSafeError(err) });
    }
  }
  if (errors.length > 0) {
    throw new HelmError(
      'plugin_provider_unregister_failed',
      `插件 ${state.definition.id} provider 卸载失败：${errors.map((e) => e.providerId).join(', ')}`,
      500,
      { pluginId: state.definition.id, unregisterErrors: errors },
    );
  }
}

/** 停用/卸载前预检：providers 端口在途流/刷新忙时拒绝（与 assertNoLiveTasks 同层）。 */
export function assertProvidersIdle(
  pluginId: string,
  state: PluginState | undefined,
  port?: PluginProviderPort,
): void {
  if (!state || state.providers.length === 0) return;
  try {
    port?.assertIdle?.(pluginId);
  } catch (err) {
    if (err instanceof HelmError) throw err;
    throw new HelmError(
      'plugin_has_live_tasks',
      `插件 ${pluginId} 的 provider 端口报在途任务：${err instanceof Error ? err.message : String(err)}`,
      409,
      { pluginId, providerIdleCheckError: toJsonSafeError(err) },
    );
  }
}

/** 模型请求与刷新在启动时复核生命周期，封住 teardown 预检后的新请求。 */
export function assertProviderAvailable(state: PluginState | undefined, pluginId: string): void {
  if (state && (state.phase === 'deactivating' || (!state.enabled && state.phase === 'idle'))) {
    throw new HelmError('plugin_disabled', `插件 ${pluginId} 正在停用或已停用`, 409);
  }
}
