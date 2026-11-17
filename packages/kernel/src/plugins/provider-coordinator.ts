/**
 * Coordinates mounting, unmounting, and lifecycle guards for plugin model `Provider`s.
 */
import type { Provider } from '@earendil-works/pi-ai';
import { HelmError, isJsonObject, isPlainObject } from '@helm/protocol';
import {
  toJsonSafeError,
  type JsonSafeErrorInfo,
} from './shared.js'
import type {
  PluginProviderPort,
  PluginState,
  ProviderEntry,
} from './types.js';

/**
 * Validates `Provider` shape at registration time (minimum pi-ai `Provider` contract):
 * non-empty `id`/`name`, plain `auth` object declaring `apiKey` and/or `oauth`, and
 * `getModels`/`stream`/`streamSimple` functions. Invalid providers fail loudly at boundary.
 */
export function assertValidProviderShape(pluginId: string, provider: Provider): void {
  const fail = (detail: string): HelmError =>
    new HelmError('invalid_provider_spec', `Plugin ${pluginId} declared provider ${detail}`, 400, { pluginId });
  if (!isPlainObject(provider)) throw fail('must be a plain object');
  const { id, name, auth } = provider as { id?: unknown; name?: unknown; auth?: unknown };
  if (typeof id !== 'string' || id.length === 0) throw fail('missing non-empty string id');
  if (typeof name !== 'string' || name.length === 0) throw fail(`(${id}) missing non-empty string name`);
  if (!isPlainObject(auth)) throw fail(`(${id}) auth must be a plain object`);
  if (auth['apiKey'] === undefined && auth['oauth'] === undefined) {
    throw fail(`(${id}) auth must declare apiKey or oauth (pi-ai ProviderAuth contract)`);
  }
  for (const fn of ['getModels', 'stream', 'streamSimple'] as const) {
    if (typeof (provider as Record<string, unknown>)[fn] !== 'function') {
      throw fail(`(${id}) is missing ${fn} function`);
    }
  }
}

/**
 * Mounts all providers declared in this enable cycle before service startup:
 * - Throws 501 if `port` is missing while providers are declared (never silently drops);
 * - Rolls back mounted providers in reverse order on failure and aggregates unregister errors.
 */
export async function registerProviders(state: PluginState, port?: PluginProviderPort): Promise<void> {
  if (state.providers.length === 0) return;
  if (!port) {
    throw new HelmError(
      'provider_port_unavailable',
      `Plugin ${state.definition.id} declared providers, but PluginHost has no provider mount port wired (runtime missing)`,
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
      `Plugin ${pluginId} failed to register provider: ${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId, unregisterErrors: rollbackErrors },
    );
  }
}

/**
 * Unregisters mounted providers in reverse order (called after services stop). Nullifies handles before
 * unregistering to prevent duplicate unmounts and aggregates all failures explicitly.
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
      `Plugin ${state.definition.id} failed to unregister providers: ${errors.map((e) => e.providerId).join(', ')}`,
      500,
      { pluginId: state.definition.id, unregisterErrors: errors },
    );
  }
}

/** Pre-disable/unregister check: rejects if the provider port still has active streams/refreshes. */
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
      `Plugin ${pluginId} provider port reported active in-flight tasks: ${err instanceof Error ? err.message : String(err)}`,
      409,
      { pluginId, providerIdleCheckError: toJsonSafeError(err) },
    );
  }
}

/** Re-checks plugin lifecycle at model request/refresh start to close preflight teardown races. */
export function assertProviderAvailable(state: PluginState | undefined, pluginId: string): void {
  if (state && (state.phase === 'deactivating' || (!state.enabled && state.phase === 'idle'))) {
    throw new HelmError('plugin_disabled', `Plugin ${pluginId} is deactivating or disabled`, 409);
  }
}
