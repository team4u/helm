/**
 * plugin model Provider mount, unload and lifecycle coordinate tune.
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
 * provider declaration boundary shape validate (pi-ai Provider most small contract):
 * id/name non-empty string,auth pure object and at least declaration apiKey/oauth of one,
 * getModels/stream/streamSimple is function (refreshModels etc. optional capability do not validate).
 * illegal shape in this explicit reject - - to run phase only then blast will let enable succeeded but model unavailable
 * into is static default fall back (honest discipline).
 */
export function assertValidProviderShape(pluginId: string, provider: Provider): void {
  const fail = (detail: string): HelmError =>
    new HelmError('invalid_provider_spec', `plugin ${pluginId} declaration provider ${detail}`, 400, { pluginId });
  if (!isPlainObject(provider)) throw fail('must be pure object');
  const { id, name, auth } = provider as { id?: unknown; name?: unknown; auth?: unknown };
  if (typeof id !== 'string' || id.length === 0) throw fail('missing non-empty string id');
  if (typeof name !== 'string' || name.length === 0) throw fail(`(${id}) missing non-empty string name`);
  if (!isPlainObject(auth)) throw fail(`(${id}) auth must be pure object`);
  if (auth['apiKey'] === undefined && auth['oauth'] === undefined) {
    throw fail(`(${id}) auth must at least declaration apiKey / oauth of one (pi-ai ProviderAuth contract)`);
  }
  for (const fn of ['getModels', 'stream', 'streamSimple'] as const) {
    if (typeof (provider as Record<string, unknown>)[fn] !== 'function') {
      throw fail(`(${id}) missing ${fn} function`);
    }
  }
}

/**
 * mount this cycle declaration all provider(in service start before):
 * - port not provide and store in declaration → explicit 501(forbid static default; by default deactivate probe will not reach this in);
 * - one by one mount and register unload function; any one failed for already mount inverse order unload (failed to uninstall aggregate);
 * - unload function placement null guard against teardown duplicate unload (idempotent layer:clearRegistrations directly clean table).
 */
export async function registerProviders(state: PluginState, port?: PluginProviderPort): Promise<void> {
  if (state.providers.length === 0) return;
  if (!port) {
    throw new HelmError(
      'provider_port_unavailable',
      `plugin ${state.definition.id} declaration provider, but PluginHost not provide providers mount port (runtime missing), reject static default discard`,
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
      `plugin ${pluginId} provider mount failed:${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId, unregisterErrors: rollbackErrors },
    );
  }
}

/**
 * inverse order unload already mount provider(in service stop after invoke). failed to uninstall aggregate explicit throw,
 * never static default swallow; regardless of into failed all placement null and by caller clearRegistrations wrap-up,
 * disallows the same provider by unload two time.
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
      `plugin ${state.definition.id} provider failed to uninstall:${errors.map((e) => e.providerId).join(', ')}`,
      500,
      { pluginId: state.definition.id, unregisterErrors: errors },
    );
  }
}

/** deactivate/unload before preflight:providers port in-flight stream/refresh busy when reject (and assertNoLiveTasks same layer). */
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
      `plugin ${pluginId}  provider port report in-flight task:${err instanceof Error ? err.message : String(err)}`,
      409,
      { pluginId, providerIdleCheckError: toJsonSafeError(err) },
    );
  }
}

/** model request and refresh in at startup re-check lifecycle, seal teardown preflight after new request. */
export function assertProviderAvailable(state: PluginState | undefined, pluginId: string): void {
  if (state && (state.phase === 'deactivating' || (!state.enabled && state.phase === 'idle'))) {
    throw new HelmError('plugin_disabled', `plugin ${pluginId} is now deactivate or deactivated`, 409);
  }
}
