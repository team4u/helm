/**
 * 外部插件 DX 闭环（doctor / reload / rescan）与受管包宿主持久适配层。
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
 * 宿主清单必达断言：生命周期操作完成后 list() 仍找不到插件即内部状态不一致。
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
      throw new HelmError('validation_error', 'doctor 目标 id 与 dir/path 互斥（择一提供）', 400);
    }
    if (target.id.trim().length === 0) {
      throw new HelmError('validation_error', 'doctor 目标 id 需为非空字符串', 400);
    }
    const source = await findSourceDirByPluginId(options.dataDir, target.id, {
      transform: options.buildProvider?.transformBackendTs,
    });
    if (source === undefined) {
      throw new HelmError(
        'plugin_source_missing',
        `在 ${join(options.dataDir, 'plugins')} 下未找到 id 为 ${target.id} 的外部插件源目录`,
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
    throw new HelmError('validation_error', 'doctor 需提供目标：dir/path（目录绝对路径）或 id（已注册插件）', 400);
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
  // 在途任务预检先于 doctor：正在运行的实例受保护，不进入任何重载路径
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
              `插件 ${pluginId} 重载预检失败（${first ? `${first.label}：${first.error!.message}` : '未知检查失败'}），旧实例保持不变`,
              422,
              { pluginId, dir, report },
            );
          }
        },
  });
  const summary = requireSummary(deps.host, pluginId, {
    code: 'plugin_reload_failed',
    message: `重载后未在宿主清单中发现插件 ${pluginId}（内部状态不一致）`,
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

/** PackageManagerHost 端口适配：per-plugin 队列串行由宿主 register/enable/unregister 保证。 */
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
            `受管安装目录不含插件入口（无 plugin.json 且无约定入口）：${dir}`,
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
          message: `受管安装注册后未在宿主清单中发现插件 ${definition.id}`,
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
        message: `启用后未在宿主清单中发现插件 ${pluginId}`,
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
        message: `更新重载后未在宿主清单中发现插件 ${pluginId}`,
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
      // 等待 DELETE 真实落盘后才 resolve；失败时 remove 保留目录与安装记录以便重试
      await deps.docRegistry.purgePlugin(pluginId);
    },
    listSummaries: () => deps.host.list(),
  };
}
