/**
 * external plugin DX closed ring (doctor / reload / rescan) and managed package host durable adapt layer.
 */
import { join } from 'node:path';
import {
  HelmError,
  type PluginBuildProvider,
  type PluginDoctorReport,
  type PluginReloadResult,
  type PluginRescanResult,
  type PluginSummary,
} from '@helm/protocol';
import { registerPluginTsRoot } from './backend-ts-loader.js';
import type { PluginDocRegistry } from './doc-registry.js';
import { assertDoctorTargetDir } from './doctor-target.js';
import {
  findSourceDirByPluginId,
  importPluginDefinition,
  normalizeDefinition,
  reloadExternalPlugin,
  resolvePluginEntry,
  type ReloadablePluginHost,
} from './external-loader.js';
import type { PackageManagerHost } from './package-manager.js';
import { doctorPluginDir } from './plugin-doctor.js';
import { requirePlugin } from './plugin-host-transitions.js';
import { assertProvidersIdle } from './provider-coordinator.js';
import { rescanExternalPlugins } from './scan-visitor.js';
import { assertNoLiveTasks } from './service-coordinator.js';
import type { PluginTaskTracker } from './tracking.js';
import type { PluginProviderPort, PluginState } from './types.js';

export interface DxReloadHostPort extends ReloadablePluginHost {
  list(): PluginSummary[];
  enable(pluginId: string): Promise<void>;
  reloadExternalPlugin(pluginId: string, options?: { doctor?: boolean }): Promise<PluginReloadResult>;
}

export interface DxCoordinatorDeps {
  dataDir: string;
  buildProvider?: PluginBuildProvider;
  plugins: ReadonlyMap<string, PluginState>;
  tracker: PluginTaskTracker;
  providers?: PluginProviderPort;
  docRegistry: PluginDocRegistry;
  host: DxReloadHostPort;
}

/**
 * host manifest must reach assertion: lifecycle operation after completion list() still find fewer than plugin i.e. internal state inconsistent.
 */
function requireSummary(
  host: Pick<DxReloadHostPort, 'list'>,
  pluginId: string,
  error: { code: string; message: string; details?: Record<string, unknown> },
): PluginSummary {
  const summary = host.list().find((s) => s.id === pluginId);
  if (!summary) throw new HelmError(error.code, error.message, 500, error.details);
  return summary;
}

export async function doctorExternalPluginDir(
  options: { dataDir: string; buildProvider?: PluginBuildProvider },
  target: { dir?: string; id?: string },
): Promise<PluginDoctorReport> {
  let dir: string;
  let requestedId: string | undefined;
  if (target.id !== undefined) {
    if (target.dir !== undefined) {
      throw new HelmError('validation_error', 'doctor target id and dir/path mutual exclusion (choose one provide)', 400);
    }
    if (target.id.trim().length === 0) {
      throw new HelmError('validation_error', 'doctor target id must be a non-empty string', 400);
    }
    const source = await findSourceDirByPluginId(options.dataDir, target.id, {
      transform: options.buildProvider?.transformBackendTs,
    });
    if (source === undefined) {
      throw new HelmError(
        'plugin_source_missing',
        `in ${join(options.dataDir, 'plugins')} under not found id is ${target.id} external plugin source directory`,
        404,
        { pluginId: target.id, pluginsDir: join(options.dataDir, 'plugins') },
      );
    }
    dir = source;
    requestedId = target.id;
  } else if (target.dir !== undefined && target.dir.length > 0) {
    assertDoctorTargetDir(target.dir, 'dir');
    dir = target.dir;
  } else {
    throw new HelmError('validation_error', 'doctor must provide target:dir/path(directory absolute path) or id(registered plugin)', 400);
  }
  const report = await doctorPluginDir(dir, { buildProvider: options.buildProvider });
  return requestedId === undefined ? report : { ...report, requestedId };
}

function assertManagedUpdateIdle(deps: DxCoordinatorDeps, pluginId: string): void {
  const state = requirePlugin(deps.plugins, pluginId);
  assertNoLiveTasks(pluginId, state, deps.tracker);
  assertProvidersIdle(pluginId, state, deps.providers);
}

export async function reloadExternalPluginFlow(
  deps: DxCoordinatorDeps,
  pluginId: string,
  options: { doctor?: boolean } = {},
): Promise<PluginReloadResult> {
  // in-flight task preflight first at doctor: is now run instance subject to protect, does not enter any reload path
  assertManagedUpdateIdle(deps, pluginId);
  const skipDoctor = options.doctor === false;
  const result = await reloadExternalPlugin(deps.dataDir, pluginId, deps.host, {
    doctor: skipDoctor
      ? undefined
      : async (dir) => {
          const report = await doctorPluginDir(dir, { buildProvider: deps.buildProvider });
          if (!report.ok) {
            const first = report.checks.find((c) => c.error !== undefined);
            throw new HelmError(
              'plugin_reload_preflight_failed',
              `plugin ${pluginId} reload preflight failed (${first ? `${first.label}:${first.error!.message}` : 'unknown check failed'}), old instance keep do not change`,
              422,
              { pluginId, dir, report },
            );
          }
        },
  });
  const summary = requireSummary(deps.host, pluginId, {
    code: 'plugin_reload_failed',
    message: `reload after not in host manifest in discover plugin ${pluginId}(internal state inconsistent)`,
    details: { pluginId },
  });
  return {
    pluginId,
    wasEnabled: result.wasEnabled,
    generation: result.generation,
    summary,
  };
}

export async function rescanExternalPluginDirs(
  dataDir: string,
  host: Pick<DxReloadHostPort, 'register' | 'list' | 'registerFailed' | 'getBuildProvider'>,
): Promise<PluginRescanResult> {
  const result = await rescanExternalPlugins(dataDir, host);
  return { registered: result.registered, skipped: result.skipped, plugins: host.list() };
}

/** PackageManagerHost port adapt:per-plugin queue serial by host register/enable/unregister guarantee. */
export function createPackageManagerHost(deps: DxCoordinatorDeps): PackageManagerHost {
  return {
    registerManagedPlugin: async (dir, options) => {
      const releaseTsRoot = registerPluginTsRoot(dir, {
        transform: deps.buildProvider?.transformBackendTs,
      });
      try {
        const entryPath = await resolvePluginEntry(dir);
        if (entryPath === undefined) {
          throw new HelmError(
            'plugin_entry_missing',
            `managed install directory excludes plugin entry (without plugin.json and without convention entry):${dir}`,
            500,
            { dir },
          );
        }
        const definition = normalizeDefinition(await importPluginDefinition(dir, entryPath), dir);
        await deps.host.register(definition, { enabled: false });
        if (options.enabled) {
          await deps.host.enable(definition.id);
        }
        const summary = requireSummary(deps.host, definition.id, {
          code: 'plugin_package_install_failed',
          message: `managed install register after not in host manifest in discover plugin ${definition.id}`,
          details: { pluginId: definition.id, dir },
        });
        return { summary, pluginId: definition.id };
      } catch (err) {
        releaseTsRoot();
        throw err;
      }
    },
    enableManagedPlugin: async (pluginId) => {
      await deps.host.enable(pluginId);
      return requireSummary(deps.host, pluginId, {
        code: 'plugin_enable_failed',
        message: `enable after not in host manifest in discover plugin ${pluginId}`,
        details: { pluginId },
      });
    },
    assertManagedPluginUpdateSafe: (pluginId) => {
      assertManagedUpdateIdle(deps, pluginId);
    },
    updateManagedPlugin: async (pluginId, dir, options) => {
      await deps.host.reloadExternalPlugin(pluginId, { doctor: false });
      void dir;
      void options;
      const summary = requireSummary(deps.host, pluginId, {
        code: 'plugin_package_update_failed',
        message: `update reload after not in host manifest in discover plugin ${pluginId}`,
        details: { pluginId },
      });
      return { summary };
    },
    removeManagedPlugin: async (pluginId) => {
      const current = deps.host.list().find((s) => s.id === pluginId);
      const wasEnabled = current?.enabled === true;
      if (current !== undefined) {
        await deps.host.unregister(pluginId);
      }
      return { wasEnabled };
    },
    purgePluginPersistentData: async (pluginId) => {
      // wait for DELETE real after only then resolve; on failure remove keep directory and install record with convenient retry
      await deps.docRegistry.purgePlugin(pluginId);
    },
    listSummaries: () => deps.host.list(),
  };
}
