/**
 * PluginHost：helm 唯一强类型插件宿主（definePlugin(ctx)）。
 *
 * 职责边界：
 * - 插件注册（register）、启用（enable）、停用（disable）、取消注册（unregister）生命周期状态机；
 * - 插件服务启动屏障（prepare -> start）与受控停止（controlled stop）；
 * - 模型 Provider 挂载与卸载（PluginProviderPort）；
 * - 协调配置（config）与启停状态（persisted enabled）持久化；
 * - 协调 HookPipeline 调度；
 * - 协调子注册表（DocRegistry、CapabilityRegistry、UiRegistry）与任务跟踪（PluginTaskTracker）。
 *
 * 并发模型：
 * - 同插件的 register/enable/disable/unregister 经 per-plugin 队列串行执行；
 * - 停用先把 phase 置为 deactivating 再进入 await，期间新 invokeAction /
 *   executeTool / runHook 一律拒绝，绝不让任务进入正在拆毁的注册表；
 *   服务 stop 链例外——受控停止窗口（PluginState.stopWindow）内放行
 *   doc 最终落盘与 STOP_WINDOW_HOST_CALLS 清理子集（含 dispose 已置
 *   disposed 的拆毁路径），新工作入口照拒；
 * - 每个启用周期递增 epoch：旧 definePlugin 上下文（含 doc 句柄与宿主
 *   生命周期资源）在新周期或停用后立即失效，防止异步残留注册污染新周期。
 * - runHook 只执行快照时刻「已启用且空闲」的处理器；未启用/正停用插件的
 *   handler 绝不执行。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  HelmError,
  type ActionManifest,
  type ConversationSummary,
  type HookName,
  type HookPayloadMap,
  type HookResult,
  type PluginActionContext,
  type PluginConfigFieldSchema,
  type PluginConfigFieldSource,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginDoctorReport,
  type PluginInstallResult,
  type PluginReloadResult,
  type PluginRemoveResult,
  type PluginRescanResult,
  type PluginUpdateResult,
  type PublicPluginDoc,
  type PublicPluginSessionDoc,
  type PluginSummary,
  type PluginToolContext,
  type PluginUiContribution,
} from '@helm/protocol';
import { HOOK_ALLOWED_ACTIONS, HookPipeline, type IsolatedHookError } from './hooks.js';
import { PluginTaskTracker } from './tracking.js';
import { type ClientCompileResult } from './client-compiler.js';
import {
  findSourceDirByPluginId,
  importPluginDefinition,
  loadExternalPlugins,
  normalizeDefinition,
  reloadExternalPlugin,
  rescanExternalPlugins,
  resolvePluginEntry,
} from './external-loader.js';
import { doctorPluginDir } from './plugin-doctor.js';
import { pluginDataDirName } from './plugin-dir-name.js';
import { registerPluginTsRoot } from './backend-ts-loader.js';
import {
  PluginPackageManager,
  type PackageManagerHost,
} from './package-manager.js';
import { PluginPackageManagerStore } from './package-store.js';
import {
  PluginDocRegistry,
  type PluginDocStore,
  type PluginSessionDocStore,
} from './doc-registry.js';
import {
  CapabilityRegistry,
  type DerivedToolSpec,
  type PluginRouteEntry,
  PROVIDER_SAFE_TOOL_NAME,
  actionToolAlias,
  parseQualifiedActionId,
} from './capability-registry.js';
import { UiRegistry } from './ui-registry.js';
import { isCrossPlatformAbsolutePath, jsonClone, toJsonSafeError, type JsonSafeErrorInfo } from './shared.js';
import type {
  PluginConfigStore,
  PluginHostBackend,
  PluginHostOptions,
  PluginInUseItem,
  PluginPhase,
  PluginProviderPort,
  PluginState,
} from './types.js';
import { assertUiCompleterActionBindings, assertUiDocsRegistered } from './ui-validation.js';
import { createPluginContext } from './plugin-context.js';
import {
  assertProviderAvailable,
  assertProvidersIdle,
  registerProviders,
} from './provider-coordinator.js';
import {
  assertNoLiveTasks,
  collectServiceInUse,
  listLiveWorktrees,
  prepareServices,
  startServiceBarrier,
  startServices,
  stopServicesQuietly,
} from './service-coordinator.js';
import {
  assertActive,
  assertContextUsable,
  assertDefinition,
  assertNotLocked,
  disposePlugins,
  getActiveEnabledPluginIds,
  getIdleActivePluginIds,
  persistEnabled,
  pluginSummaryOf,
  resolveInitialEnabled,
  settleLifecycleChanged,
  teardownPlugin,
  toDiagnosticError,
  wrapEnableError,
  wrapRegistrationError,
} from './lifecycle-helpers.js';

export type { PluginDocStore, PluginSessionDocStore } from './doc-registry.js';
export {
  type DerivedToolSpec,
  type PluginRouteEntry,
  PROVIDER_SAFE_TOOL_NAME,
  actionToolAlias,
} from './capability-registry.js';
export type {
  PluginConfigStore,
  PluginHostBackend,
  PluginHostOptions,
  PluginPhase,
  PluginProviderPort,
  PluginState,
} from './types.js';

export class PluginHost {
  private plugins = new Map<string, PluginState>();
  private pipelines = new Map<HookName, HookPipeline<HookName>>();
  private tracker = new PluginTaskTracker();
  private docRegistry: PluginDocRegistry;
  private capabilityRegistry = new CapabilityRegistry();
  private uiRegistry = new UiRegistry();
  private configStore?: PluginConfigStore;
  private disposed = false;
  private registerSeq = 0;
  private servicesStarted: boolean;
  private startPromise?: Promise<void>;
  private lifecycle = new Map<string, Promise<unknown>>();
  /** 受管包安装器（install/update/remove；可选接线，未接线时 501）。 */
  private packageManager?: PluginPackageManager;
  /** 受管包记录镜像（PluginSummary.managed 映射用）。 */
  private packageStore?: PluginPackageManagerStore;

  constructor(private readonly options: PluginHostOptions) {
    this.configStore = options.config;
    this.servicesStarted = options.deferServices !== true;
    for (const name of Object.keys(HOOK_ALLOWED_ACTIONS) as HookName[]) {
      this.pipelines.set(name, new HookPipeline(name));
    }
    this.docRegistry = new PluginDocRegistry(
      options.docs,
      (pluginId, name, val) => {
        this.emitDocUpdated(pluginId, name, val);
      },
      {
        sessionStore: options.sessionDocs,
        assertConversationExists: (conversationId) => {
          options.host.getConversation(conversationId);
        },
        emitSessionDocUpdated: (doc) => {
          options.host.emitEvent('plugin.session_doc.updated', {
            type: 'plugin.session_doc.updated',
            doc,
          });
        },
      },
    );
  }

  // --- 注册与生命周期 -------------------------------------------------------

  async register(
    definition: PluginDefinition,
    options: { enabled?: boolean; isolateFailure?: boolean } = {},
  ): Promise<void> {
    this.assertNotDisposed();
    assertDefinition(definition);
    const seq = ++this.registerSeq;
    const pluginId = definition.id;
    // 外部插件故障隔离：仅非 builtin 插件且调用方显式声明 isolateFailure 时
    // 生效（内置插件失败一律阻断，代码缺陷不容降级）。
    const isolate =
      options.isolateFailure === true && !definition.id.startsWith('builtin:');

    await this.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      if (this.plugins.has(pluginId)) {
        throw new HelmError('plugin_already_registered', `插件已注册：${pluginId}`, 409, { pluginId });
      }

      const wantsEnabled = resolveInitialEnabled(definition, this.configStore, options);
      const dataDir = join(this.options.dataDir, 'plugins', pluginDataDirName(pluginId));
      mkdirSync(dataDir, { recursive: true });

      const state: PluginState = {
        definition,
        enabled: false,
        phase: 'defining',
        epoch: 1,
        dataDir,
        hooks: new Set(),
        services: [],
        providers: [],
        configSchema: null,
        hostReleases: new Set(),
        stopWindow: false,
        ...(isolate ? { isolateFailure: true } : {}),
      };

      this.plugins.set(pluginId, state);

      try {
        await definition.definePlugin(this.createContext(state, state.epoch));
        this.validateUiDeclarations(definition.id, false);
      } catch (err) {
        if (isolate) {
          // 外部插件 define 阶段故障：清理残余注册但保留占位条目为 failed
          await this.rollbackIsolated(state, err, 'define');
          return;
        }
        await this.rollbackAndRemove(state, seq, err, false);
      }

      if (wantsEnabled) {
        try {
          this.uiRegistry.assertCrossPluginUnique(definition.id, this.getActiveEnabledPluginIds());
          this.validateUiDeclarations(definition.id, true);
          state.enabled = true;
          await registerProviders(state, this.options.providers);
          await this.activateServices(state);
        } catch (err) {
          if (isolate) {
            // 外部插件启用阶段故障：回滚挂载资源但保留条目为 failed；
            // 磁盘 pluginEnabled 原值不动（不覆写用户意图）。
            await this.rollbackIsolated(state, err, 'enable');
            return;
          }
          await this.rollbackAndRemove(state, seq, err, true);
        }
        state.phase = 'idle';
      } else {
        try {
          await this.teardownPlugin(state, { stopServices: false });
        } catch (err) {
          if (isolate) {
            await this.rollbackIsolated(state, err, 'define');
            return;
          }
          await this.rollbackAndRemove(state, seq, err, false);
        }
        state.epoch += 1;
        state.phase = 'idle';
      }
      this.emitPluginChanged(state);
    });
  }

  /**
   * 外部插件故障占位登记（scan / load 阶段失败，无有效 definition）：
   * 在 this.plugins 中登记（或更新）一个 enabled:false、loadFailed:true、
   * 携带 lastError 诊断的占位条目；不覆盖已注册的同名真实插件。
   */
  registerFailed(spec: {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    error: PluginDiagnosticError;
  }): void {
    this.assertNotDisposed();
    const existing = this.plugins.get(spec.id);
    if (existing !== undefined && !existing.loadFailed) {
      // 已存在真实插件（同名冲突）：不覆盖，由调用方登记为冲突错误或跳过。
      throw new HelmError(
        'plugin_already_registered',
        `插件 ${spec.id} 已注册（与故障占位冲突），拒绝覆盖`,
        409,
        { pluginId: spec.id },
      );
    }
    const definition: PluginDefinition = {
      id: spec.id,
      name: spec.name ?? spec.id,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.version !== undefined ? { version: spec.version } : {}),
      definePlugin() {},
    };
    const state: PluginState =
      existing ??
      ({
        definition,
        enabled: false,
        phase: 'idle',
        epoch: 1,
        dataDir: join(this.options.dataDir, 'plugins', pluginDataDirName(spec.id)),
        hooks: new Set(),
        services: [],
        providers: [],
        configSchema: null,
        hostReleases: new Set(),
        stopWindow: false,
      } satisfies PluginState);
    state.definition = definition;
    state.enabled = false;
    state.phase = 'idle';
    state.epoch += 1;
    state.loadFailed = true;
    state.lastError = spec.error;
    this.clearRegistrations(state);
    this.plugins.set(spec.id, state);
    this.emitPluginChanged(state);
  }

  /**
   * 外部插件隔离回滚：清理已登记能力与挂载资源，但保留 state 在注册表中
   * 并标记 failed（enabled:false / lastError 附诊断），不向上抛错。
   */
  private async rollbackIsolated(
    state: PluginState,
    err: unknown,
    stage: PluginDiagnosticError['stage'],
  ): Promise<void> {
    try {
      await this.teardownPlugin(state, { stopServices: stage === 'enable' });
    } catch {
      // 清理失败的叠加错误不掩盖原始诊断；残余注册已尽力清理。
    }
    this.clearRegistrations(state);
    state.enabled = false;
    state.epoch += 1;
    state.phase = 'idle';
    state.lastError = toDiagnosticError(err, stage);
    this.emitPluginChanged(state);
  }

  async unregister(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      const state = this.requirePlugin(pluginId);
      assertNotLocked(state);
      if (!state.enabled) {
        await this.teardownPlugin(state, { stopServices: false });
        this.plugins.delete(pluginId);
        this.tracker.removePlugin(pluginId);
        this.removeRegistries(pluginId);
        this.emitPluginChanged(state);
        return;
      }
      assertNoLiveTasks(pluginId, state, this.tracker);
      assertProvidersIdle(pluginId, state, this.options.providers);
      state.phase = 'deactivating';
      let stopError: { err: unknown } | undefined;
      try {
        await this.teardownPlugin(state, { stopServices: true });
      } catch (err) {
        stopError = { err };
      }
      state.enabled = false;
      this.plugins.delete(pluginId);
      this.tracker.removePlugin(pluginId);
      this.removeRegistries(pluginId);
      this.settlePluginChanged(state, stopError);
    });
  }

  async enable(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      const state = this.requirePlugin(pluginId);
      if (state.enabled) return;
      if (state.loadFailed === true) {
        // scan / load 阶段占位条目：无有效 definition，重 enable 无法自愈
        throw new HelmError(
          'plugin_load_failed',
          `插件 ${pluginId} 加载失败（${state.lastError?.message ?? '未知错误'}），请修复插件源码后使用 reload 或重启 Hub`,
          409,
          { pluginId, error: state.lastError },
        );
      }
      const prevConfigSchema = state.configSchema;
      state.epoch += 1;
      this.clearRegistrations(state);
      state.configSchema = null;
      state.phase = 'defining';
      let persistedEnabled = false;
      try {
        await state.definition.definePlugin(this.createContext(state, state.epoch));
        this.validateUiDeclarations(pluginId, false);
        this.uiRegistry.assertCrossPluginUnique(pluginId, this.getActiveEnabledPluginIds());
        await registerProviders(state, this.options.providers);
        await this.activateServices(state);
        await persistEnabled(this.configStore, state, true);
        persistedEnabled = true;
        this.uiRegistry.assertCrossPluginUnique(pluginId, this.getActiveEnabledPluginIds());
        this.validateUiDeclarations(pluginId, true);
        state.enabled = true;
        state.phase = 'idle';
        state.lastError = undefined;
      } catch (err) {
        await this.rollbackEnable(state, prevConfigSchema, err, persistedEnabled);
      }
      this.emitPluginChanged(state);
    });
  }

  async disable(pluginId: string, options: { force?: boolean } = {}): Promise<void> {
    this.assertNotDisposed();
    await this.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      const state = this.requirePlugin(pluginId);
      assertNotLocked(state);
      if (!state.enabled) return;
      // 运行中任务与 Provider 在途流：硬阻断，force 也绝不跳过（状态一致性优先）。
      assertNoLiveTasks(pluginId, state, this.tracker);
      assertProvidersIdle(pluginId, state, this.options.providers);
      // 持久资源占用：非 force 时收集并 409 拦截（知情后可 force 停用）。
      if (options.force !== true) {
        const usages = await this.collectPluginInUse(pluginId, state);
        if (usages.length > 0) {
          throw new HelmError(
            'plugin_in_use',
            `插件 ${pluginId} 存在 ${usages.length} 处关联资源占用，停用后相关功能将不可用（确认后可传 force 强制停用）`,
            409,
            { pluginId, usages },
          );
        }
      }
      state.phase = 'deactivating';
      let stopError: { err: unknown } | undefined;
      try {
        await this.teardownPlugin(state, { stopServices: true });
      } catch (err) {
        stopError = { err };
      }
      state.enabled = false;
      state.epoch += 1;
      state.phase = 'idle';
      state.lastError = undefined;
      let persistError: { err: unknown } | undefined;
      try {
        await persistEnabled(this.configStore, state, false);
      } catch (err) {
        persistError = { err };
      }
      this.settleLifecycleChanged(state, stopError, persistError);
    });
  }

  private async enqueue<T>(pluginId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.lifecycle.get(pluginId) ?? Promise.resolve();
    const run = prev.then(op, op);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.lifecycle.set(pluginId, tail);
    void tail.then(() => {
      if (this.lifecycle.get(pluginId) === tail) this.lifecycle.delete(pluginId);
    });
    return run;
  }

  private async rollbackAndRemove(
    state: PluginState,
    seq: number,
    err: unknown,
    stopServices: boolean,
  ): Promise<never> {
    let rollbackError: JsonSafeErrorInfo | undefined;
    try {
      await this.teardownPlugin(state, { stopServices });
    } catch (rollbackErr) {
      rollbackError = toJsonSafeError(rollbackErr);
    }
    state.enabled = false;
    this.plugins.delete(state.definition.id);
    this.tracker.removePlugin(state.definition.id);
    this.removeRegistries(state.definition.id);
    throw wrapRegistrationError(state.definition.id, seq, err, rollbackError);
  }

  private async rollbackEnable(
    state: PluginState,
    prevConfigSchema: Record<string, PluginConfigFieldSchema> | null,
    err: unknown,
    persistedEnabled: boolean,
  ): Promise<never> {
    let rollbackError: JsonSafeErrorInfo | undefined;
    try {
      await this.teardownPlugin(state, { stopServices: true });
    } catch (teardownErr) {
      rollbackError = toJsonSafeError(teardownErr);
    }
    this.clearRegistrations(state);
    state.configSchema = prevConfigSchema;
    state.enabled = false;
    state.epoch += 1;
    state.phase = 'idle';
    if (persistedEnabled && this.configStore?.setEnabled) {
      try {
        await persistEnabled(this.configStore, state, false);
      } catch (persistErr) {
        rollbackError = rollbackError ?? toJsonSafeError(persistErr);
      }
    }
    // 外部插件：记录 lastError 并广播 failed 状态（HTTP/CLI 依然收到原始错误）。
    const pluginId = state.definition.id;
    if (!pluginId.startsWith('builtin:')) {
      state.lastError = toDiagnosticError(err, 'enable');
      this.emitPluginChanged(state);
    }
    throw wrapEnableError(pluginId, err, rollbackError);
  }

  private clearRegistrations(state: PluginState): void {
    const pluginId = state.definition.id;
    for (const pipeline of this.pipelines.values()) {
      pipeline.removeByPlugin(pluginId);
    }
    state.hooks.clear();
    state.services.length = 0;
    state.providers.length = 0;
    state.hostReleases.clear();
    this.removeRegistries(pluginId);
  }

  private removeRegistries(pluginId: string): void {
    this.capabilityRegistry.removePlugin(pluginId);
    this.uiRegistry.removePlugin(pluginId);
    this.docRegistry.removePlugin(pluginId);
  }

  private async teardownPlugin(state: PluginState, opts: { stopServices: boolean }): Promise<void> {
    await teardownPlugin(state, opts, (s) => this.clearRegistrations(s));
  }

  /**
   * 持久资源占用聚合：服务自声明（svc.inUse）+ 宿主通用引用探测
   * （Profile.runtime kind / Profile.model / 会话 model 指向本插件 Provider）。
   * 轻量测试宿主未实现 profiles.list / listConversations 时（501 unsupported）
   * 仅跳过宿主资产探测，真实错误照常上抛。
   */
  private async collectPluginInUse(pluginId: string, state: PluginState): Promise<PluginInUseItem[]> {
    const usages: PluginInUseItem[] = await collectServiceInUse(pluginId, state);

    const runtimeKinds = new Set(this.uiRegistry.getProfileRuntimeKinds(pluginId));
    const providerIds = state.providers.map((p) => p.provider.id);
    if (runtimeKinds.size === 0 && providerIds.length === 0) return usages;

    let profiles: Array<{
      id: string;
      name?: string;
      model?: string;
      runtime?: { kind: string };
    }> = [];
    if ((runtimeKinds.size > 0 || providerIds.length > 0) && this.options.host.profiles?.list) {
      try {
        profiles = (await this.options.host.profiles.list()) as typeof profiles;
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
        conversations = this.options.host.listConversations() as typeof conversations;
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
    return usages;
  }

  private async activateServices(state: PluginState): Promise<void> {
    if (this.servicesStarted) {
      await prepareServices(state);
      await startServices(state);
    }
  }

  async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.servicesStarted) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const enabled = [...this.plugins.values()].filter((s) => s.enabled);
      // 无隔离型插件：沿用原子启动屏障（任一失败回滚全部并显式抛错）。
      if (!enabled.some((s) => s.isolateFailure === true)) {
        await startServiceBarrier(enabled);
        this.servicesStarted = true;
        return;
      }
      // 含外部隔离型插件：阶段化启动——全局 prepare 先行，外部插件失败降级
      // 为 failed 不阻断屏障；内置插件失败仍原子回滚全部已启动并阻断。
      const prepared: PluginState[] = [];
      for (const state of enabled) {
        try {
          await prepareServices(state);
          prepared.push(state);
        } catch (err) {
          if (state.isolateFailure !== true) {
            await this.rollbackStartBarrier(prepared);
            throw err;
          }
          await this.rollbackIsolated(state, err, 'enable');
        }
      }
      let startedIdx = 0;
      for (const state of prepared) {
        try {
          await startServices(state);
          startedIdx += 1;
        } catch (err) {
          if (state.isolateFailure !== true) {
            await this.rollbackStartBarrier(prepared.slice(0, startedIdx));
            throw err;
          }
          await this.rollbackIsolated(state, err, 'enable');
        }
      }
      this.servicesStarted = true;
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  /** 非隔离插件屏障失败时的原子回滚：stop 失败静默聚合（不掩盖原始诊断）。 */
  private async rollbackStartBarrier(started: PluginState[]): Promise<void> {
    for (const prev of started.reverse()) {
      try {
        await stopServicesQuietly(prev);
      } catch {
        // 回滚失败不掩盖原始启动诊断
      }
    }
  }

  async stop(): Promise<void> {
    this.assertNotDisposed();
    if (!this.servicesStarted) return;
    const errors: Array<{ pluginId: string; error: JsonSafeErrorInfo }> = [];
    for (const state of [...this.plugins.values()].reverse()) {
      if (!state.enabled) continue;
      try {
        await stopServicesQuietly(state);
      } catch (err) {
        errors.push({ pluginId: state.definition.id, error: toJsonSafeError(err) });
      }
    }
    this.servicesStarted = false;
    if (errors.length > 0) {
      throw new HelmError(
        'plugin_service_stop_failed',
        `部分插件服务停止失败：${errors.map((e) => e.pluginId).join(', ')}`,
        500,
        { errors },
      );
    }
  }

  // --- 查询与元数据 ---------------------------------------------------------

  list(): PluginSummary[] {
    this.assertNotDisposed();
    return [...this.plugins.values()].map((s) => this.summaryWithManaged(s));
  }

  get(pluginId: string): PluginSummary | undefined {
    this.assertNotDisposed();
    const s = this.plugins.get(pluginId);
    return s ? this.summaryWithManaged(s) : undefined;
  }

  /** summary + 受管包元数据（包记录镜像存在时映射 managed；内置插件永无）。 */
  private summaryWithManaged(state: PluginState): PluginSummary {
    const base = pluginSummaryOf(state, this.capabilityRegistry);
    const record = this.packageStore?.getRecord(base.id);
    if (record === undefined || base.id.startsWith('builtin:')) return base;
    return {
      ...base,
      managed: {
        source: record.source,
        installId: record.id,
        installedVersion: record.version,
        installedAt: record.updatedAt,
      },
    };
  }

  private getActiveEnabledPluginIds(): string[] {
    return getActiveEnabledPluginIds(this.plugins);
  }

  private getIdleActivePluginIds(): string[] {
    return getIdleActivePluginIds(this.plugins);
  }

  private validateUiDeclarations(pluginId: string, crossPlugin: boolean): void {
    assertUiDocsRegistered(
      pluginId,
      this.uiRegistry,
      (name) => this.docRegistry.hasPublicDoc(pluginId, name),
      (name) => this.docRegistry.hasPublicSessionDoc(pluginId, name),
    );
    assertUiCompleterActionBindings(
      pluginId,
      this.uiRegistry,
      this.capabilityRegistry,
      this.plugins,
      crossPlugin,
    );
  }

  assertProviderAvailable(pluginId: string): void {
    assertProviderAvailable(this.plugins.get(pluginId), pluginId);
  }

  // --- UI 贡献 -------------------------------------------------------------

  listTools(conversation?: ConversationSummary): DerivedToolSpec[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listTools(this.getActiveEnabledPluginIds(), conversation);
  }

  listRoutes(): PluginRouteEntry[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listRoutes(this.getActiveEnabledPluginIds());
  }

  listActions(): ActionManifest[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listActions(this.getActiveEnabledPluginIds());
  }

  listUi(): PluginUiContribution[] {
    this.assertNotDisposed();
    return this.uiRegistry.listUi(this.getActiveEnabledPluginIds());
  }

  // --- 外部插件 DX 闭环：doctor / reload / rescan --------------------------------

  /**
   * 外部插件源码静态自检（真实加载 + 真实注册 + 真实 client 编译）。
   * 目标择一：dir/path（目录绝对路径）或 id（已注册插件，解析其源目录）。
   * 委托 plugin-doctor 模块；临时宿主与代际导入细节见该模块文件头。
   * id 无法解析到源目录时 404（请求目标错误，非插件缺陷）。
   */
  async doctorExternalPlugin(target: { dir?: string; id?: string }): Promise<PluginDoctorReport> {
    this.assertNotDisposed();
    let dir: string;
    let requestedId: string | undefined;
    if (target.id !== undefined) {
      if (target.dir !== undefined) {
        throw new HelmError('validation_error', 'doctor 目标 id 与 dir/path 互斥（择一提供）', 400);
      }
      if (target.id.trim().length === 0) {
        throw new HelmError('validation_error', 'doctor 目标 id 需为非空字符串', 400);
      }
      const source = await findSourceDirByPluginId(this.options.dataDir, target.id);
      if (source === undefined) {
        throw new HelmError(
          'plugin_source_missing',
          `在 ${join(this.options.dataDir, 'plugins')} 下未找到 id 为 ${target.id} 的外部插件源目录`,
          404,
          { pluginId: target.id, pluginsDir: join(this.options.dataDir, 'plugins') },
        );
      }
      dir = source;
      requestedId = target.id;
    } else if (target.dir !== undefined && target.dir.length > 0) {
      // dir 模式为目录绝对路径（与 HTTP parseDoctorTarget 同一约束；host.plugins
      // 端口与 HTTP 同权，边界校验也同权）：拒绝相对路径与穿越段。
      if (
        !isCrossPlatformAbsolutePath(target.dir) ||
        target.dir.split(/[\\/]/).includes('..')
      ) {
        throw new HelmError(
          'validation_error',
          `doctor 目标 dir 需为不含 .. 段的跨平台绝对目录路径（以 / 或盘符开头）：${target.dir}`,
          400,
          { dir: target.dir },
        );
      }
      dir = target.dir;
    } else {
      throw new HelmError('validation_error', 'doctor 需提供目标：dir/path（目录绝对路径）或 id（已注册插件）', 400);
    }
    const report = await doctorPluginDir(dir);
    return requestedId === undefined ? report : { ...report, requestedId };
  }

  /**
   * 外部插件受控热重载：先 doctor 全链预检（失败时旧实例保持不动），
   * 再 unregister（在途任务 409 拒绝）+ 新代际导入重注册；启用状态保持重载前。
   * 内置插件（builtin:*）一律 403 拒绝。委托 external-loader.reloadExternalPlugin。
   */
  async reloadExternalPlugin(pluginId: string, options: { doctor?: boolean } = {}): Promise<PluginReloadResult> {
    this.assertNotDisposed();
    // 在途任务预检先于 doctor：正在运行的实例受保护，不进入任何重载路径
    //（doctor 与 unregister 各自还有兑底检查，这里是第一道门）。
    const state = this.requirePlugin(pluginId);
    assertNoLiveTasks(pluginId, state, this.tracker);
    assertProvidersIdle(pluginId, state, this.options.providers);
    const skipDoctor = options.doctor === false;
    const result = await reloadExternalPlugin(this.options.dataDir, pluginId, this, {
      doctor: skipDoctor
        ? undefined
        : async (dir) => {
            const report = await doctorPluginDir(dir);
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
    const summary = this.list().find((s) => s.id === pluginId);
    if (!summary) {
      throw new HelmError(
        'plugin_reload_failed',
        `重载后未在宿主清单中发现插件 ${pluginId}（内部状态不一致）`,
        500,
        { pluginId },
      );
    }
    return {
      pluginId,
      wasEnabled: result.wasEnabled,
      generation: result.generation,
      summary,
    };
  }

  /**
   * 增量重扫描插件目录：只注册新外部插件（默认 disabled），已注册插件不重载不干扰。
   */
  async rescanExternalPlugins(): Promise<PluginRescanResult> {
    this.assertNotDisposed();
    const result = await rescanExternalPlugins(this.options.dataDir, this);
    return { registered: result.registered, skipped: result.skipped, plugins: this.list() };
  }

  // --- 外部插件包管理：install / update / remove ------------------------------

  /**
   * 接线受管包安装器（runtime 启动链调用；未接线时三端点 501）。
   * store 同时用于 PluginSummary.managed 镜像映射。
   */
  attachPackageManager(manager: PluginPackageManager, store: PluginPackageManagerStore): void {
    this.packageManager = manager;
    this.packageStore = store;
  }

  /** PackageManagerHost 端口的真实实现（per-plugin 队列串行由本类 enqueue 保证）。 */
  asPackageManagerHost(): PackageManagerHost {
    return {
      registerManagedPlugin: async (dir, options) => {
        const entryPath = await resolvePluginEntry(dir);
        if (entryPath === undefined) {
          throw new HelmError(
            'plugin_entry_missing',
            `受管安装目录不含插件入口（无 plugin.json 且无约定入口）：${dir}`,
            500,
            { dir },
          );
        }
        const definition = normalizeDefinition(
          await importPluginDefinition(dir, entryPath),
          dir,
        );
        const releaseTsRoot = registerPluginTsRoot(dir);
        try {
          await this.register(definition, { enabled: false });
          if (options.enabled) {
            await this.enable(definition.id);
          }
          const summary = this.list().find((s) => s.id === definition.id);
          if (!summary) {
            throw new HelmError(
              'plugin_package_install_failed',
              `受管安装注册后未在宿主清单中发现插件 ${definition.id}`,
              500,
              { pluginId: definition.id, dir },
            );
          }
          return { summary, pluginId: definition.id };
        } catch (err) {
          releaseTsRoot();
          throw err;
        }
      },
      enableManagedPlugin: async (pluginId) => {
        await this.enable(pluginId);
        const summary = this.list().find((s) => s.id === pluginId);
        if (!summary) {
          throw new HelmError(
            'plugin_enable_failed',
            `启用后未在宿主清单中发现插件 ${pluginId}`,
            500,
            { pluginId },
          );
        }
        return summary;
      },
      assertManagedPluginUpdateSafe: (pluginId) => {
        // 更新切换前安全预检：在途任务 409 / provider 忙拒绝，旧实例不动
        //（与 reloadExternalPlugin / disable 同一检查集）。
        const state = this.requirePlugin(pluginId);
        assertNoLiveTasks(pluginId, state, this.tracker);
        assertProvidersIdle(pluginId, state, this.options.providers);
      },
      updateManagedPlugin: async (pluginId, dir, options) => {
        const result = await this.reloadExternalPlugin(pluginId, { doctor: false });
        void dir;
        void options;
        const summary = this.list().find((s) => s.id === pluginId);
        if (!summary) {
          throw new HelmError(
            'plugin_package_update_failed',
            `更新重载后未在宿主清单中发现插件 ${pluginId}`,
            500,
            { pluginId },
          );
        }
        return { summary };
      },
      removeManagedPlugin: async (pluginId) => {
        const current = this.list().find((s) => s.id === pluginId);
        const wasEnabled = current?.enabled === true;
        if (current !== undefined) {
          await this.unregister(pluginId);
        }
        return { wasEnabled };
      },
      purgePluginPersistentData: (pluginId) => {
        this.docRegistry.purgePlugin(pluginId);
      },
      listSummaries: () => this.list(),
    };
  }

  private requirePackageManager(): PluginPackageManager {
    if (this.packageManager === undefined) {
      throw new HelmError(
        'not_supported',
        '当前内核未接线插件包安装器（受管 install/update/remove 不可用）',
        501,
      );
    }
    return this.packageManager;
  }

  /** 安装插件包（默认 disabled；enable: true 安装后启用，失败诊断随结果返回）。 */
  installPluginPackage(source: string, options: { enable?: boolean } = {}): Promise<PluginInstallResult> {
    this.assertNotDisposed();
    return this.requirePackageManager().install(source, options);
  }

  /** 更新受管插件包（重取 source + doctor + 原子替换 + 复用 reload 重注册）。 */
  updatePluginPackage(pluginId: string): Promise<PluginUpdateResult> {
    this.assertNotDisposed();
    return this.requirePackageManager().update(pluginId);
  }

  /** 移除受管插件包（保护 builtin / 在途任务 / providers；local 只删受管副本）。 */
  removePluginPackage(pluginId: string): Promise<PluginRemoveResult> {
    this.assertNotDisposed();
    return this.requirePackageManager().remove(pluginId);
  }

  // --- client.tsx 编译产物 --------------------------------------------------

  async getClientModule(
    pluginId: string,
    moduleRef: string,
    options?: { chunk?: string; hash?: string },
  ): Promise<ClientCompileResult> {
    this.assertNotDisposed();
    return this.uiRegistry.getClientModule(pluginId, moduleRef, {
      chunk: options?.chunk,
      hash: options?.hash,
      getPluginLifecycle: (id) => {
        const s = this.plugins.get(id);
        if (!s) return undefined;
        return {
          identity: s,
          enabled: s.enabled,
          phase: s.phase,
          epoch: s.epoch,
          clientRoot: s.definition.clientRoot,
          npmDependencies: s.definition.npmDependencies,
        };
      },
      dataDir: this.options.dataDir,
      isDisposed: () => this.disposed,
    });
  }

  // --- 公共文档 -----------------------------------------------------------

  getPublicDoc(pluginId: string, name: string): PublicPluginDoc {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    return this.docRegistry.getPublicDoc(pluginId, name, !!state && state.enabled && state.phase === 'idle');
  }

  getPublicSessionDoc(pluginId: string, name: string, conversationId: number): PublicPluginSessionDoc {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    return this.docRegistry.getPublicSessionDoc(pluginId, name, conversationId, !!state && state.enabled && state.phase === 'idle');
  }

  listPublicDocs(): PublicPluginDoc[] {
    this.assertNotDisposed();
    return this.docRegistry.listPublicDocs(this.getIdleActivePluginIds());
  }

  listLiveWorktrees(): Array<{ nodeId: string; path: string }> {
    this.assertNotDisposed();
    return listLiveWorktrees(this.plugins.values());
  }

  // --- Hook 管道 -----------------------------------------------------------

  async runHook<K extends HookName>(name: K, payload: HookPayloadMap[K]): Promise<HookResult<HookPayloadMap[K]>> {
    this.assertNotDisposed();
    const pipeline = this.pipelines.get(name);
    if (!pipeline) {
      throw new HelmError('unknown_hook', `未知的钩子挂载点：${name}`, 400, { hook: name });
    }
    const participants = pipeline.entries().filter((h) => this.isHookActive(h.pluginId));
    if (participants.length === 0) return { action: 'continue' };

    const snapshot = new Set(participants);
    const label = `hook:${name}`;
    for (const h of participants) this.tracker.begin(h.pluginId, label);
    let outcome: HookResult<HookPayloadMap[K]>;
    try {
      const r = await pipeline.run(payload, (h) => snapshot.has(h));
      // turn_settled 单插件异常隔离：逐插件发 warning 告警，不阻断结算链。
      if (r.isolatedErrors !== undefined && r.isolatedErrors.length > 0) {
        this.notifyIsolatedHookErrors(r.isolatedErrors);
      }
      if (r.shortCircuit) {
        outcome =
          r.shortCircuit.action === 'handled'
            ? { action: 'handled', result: r.shortCircuit.result }
            : { action: 'block', reason: r.shortCircuit.reason };
      } else {
        outcome = { action: 'transform', value: r.finalPayload } as HookResult<HookPayloadMap[K]>;
      }
    } finally {
      for (const h of participants) this.tracker.end(h.pluginId, label);
    }
    return outcome;
  }

  async runHookAround(
    name: 'agent_spawn',
    payload: HookPayloadMap['agent_spawn'],
    defaultRun: (finalPayload: HookPayloadMap['agent_spawn']) => Promise<unknown>,
  ): Promise<unknown> {
    this.assertNotDisposed();
    const pipeline = this.pipelines.get(name);
    if (!pipeline) {
      throw new HelmError('unknown_hook', `未知的钩子挂载点：${name}`, 400, { hook: name });
    }
    const participants = pipeline.entries().filter((h) => this.isHookActive(h.pluginId));
    const label = `hook:${name}`;
    const snapshot = new Set(participants);
    for (const h of participants) this.tracker.begin(h.pluginId, label);
    try {
      const spawnPipeline = pipeline as unknown as HookPipeline<'agent_spawn'>;
      return await spawnPipeline.runAround(
        payload,
        defaultRun,
        (h: { pluginId: string }) => snapshot.has(h as never),
      );
    } finally {
      for (const h of participants) this.tracker.end(h.pluginId, label);
    }
  }

  private isHookActive(pluginId: string): boolean {
    const s = this.plugins.get(pluginId);
    return !!s && s.enabled && s.phase === 'idle';
  }

  // --- 动作与工具执行 -------------------------------------------------------

  static parseQualifiedActionId(qualified: string): { pluginId: string; actionId: string } {
    return parseQualifiedActionId(qualified);
  }

  private getCapabilityExecutionOptions() {
    return {
      assertActive: (pluginId: string) => {
        this.assertNotDisposed();
        assertActive(this.requirePlugin(pluginId));
      },
      getConversation: (id: number) => this.options.host.getConversation(id),
      tracker: this.tracker,
      isPluginRegistered: (pluginId: string) => this.plugins.has(pluginId),
    };
  }

  prepareAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext = {},
  ): { idempotent: boolean } {
    this.assertNotDisposed();
    return this.capabilityRegistry.prepareAction(
      pluginId,
      actionId,
      input,
      context,
      this.getCapabilityExecutionOptions(),
    );
  }

  async invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    return this.capabilityRegistry.invokeAction(
      pluginId,
      actionId,
      input,
      context,
      this.getCapabilityExecutionOptions(),
    );
  }

  async executeTool(name: string, input: unknown, context: PluginToolContext): Promise<unknown> {
    this.assertNotDisposed();
    return this.capabilityRegistry.executeTool(
      name,
      input,
      context,
      this.getCapabilityExecutionOptions(),
    );
  }

  // --- 配置 ----------------------------------------------------------------

  getConfig(pluginId: string): Record<string, unknown> {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    // 合成有效配置：schema.default 先填底，磁盘显式值覆盖（未存或已 null
    // 重置的字段动态反映最新 schema.default，不固化在磁盘上）。
    const stored = this.configStore ? this.configStore.get(pluginId) : {};
    const schema = state?.configSchema ?? {};
    const merged: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
      if (field.default !== undefined) {
        merged[key] = field.secret === true ? String(field.default) : field.default;
      }
    }
    return { ...merged, ...stored };
  }

  getConfigSchema(pluginId: string): Record<string, PluginConfigFieldSchema> {
    this.assertNotDisposed();
    return this.requirePlugin(pluginId).configSchema ? { ...this.requirePlugin(pluginId).configSchema } : {};
  }

  /** 配置字段来源映射：configured（磁盘显式）/ default（schema 回退）/ unset。 */
  getConfigSources(pluginId: string): Record<string, PluginConfigFieldSource> {
    this.assertNotDisposed();
    const schema = this.requirePlugin(pluginId).configSchema ?? {};
    const stored = this.configStore ? this.configStore.get(pluginId) : {};
    const sources: Record<string, PluginConfigFieldSource> = {};
    for (const [key, field] of Object.entries(schema)) {
      const has = Object.hasOwn(stored, key) && stored[key] !== undefined;
      const configured = field.secret === true ? has && typeof stored[key] === 'string' && (stored[key] as string).length > 0 : has;
      if (configured) sources[key] = 'configured';
      else if (field.default !== undefined) sources[key] = 'default';
      else sources[key] = 'unset';
    }
    return sources;
  }

  async setConfig(pluginId: string, value: Record<string, unknown>): Promise<void> {
    this.assertNotDisposed();
    const state = this.requirePlugin(pluginId);
    const schema = state.configSchema ?? {};
    if (!this.configStore) {
      throw new HelmError(
        'config_store_unavailable',
        'PluginHost 未提供持久化 PluginConfigStore，修改插件配置不被支持',
        501,
        { pluginId },
      );
    }
    await this.configStore.set(pluginId, value, schema);
  }

  // --- 生命周期 ------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.lifecycle.values()]);
    this.lifecycle.clear();
    await disposePlugins(
      this.plugins,
      (state) => this.teardownPlugin(state, { stopServices: true }),
      this.tracker,
      (id) => this.removeRegistries(id),
    );
  }

  // --- 在途任务跟踪 ---------------------------------------------------------

  beginSpawnTask(pluginId: string, spawnId: string): void { this.tracker.begin(pluginId, `spawn:${spawnId}`); }
  endSpawnTask(pluginId: string, spawnId: string): void { this.tracker.end(pluginId, `spawn:${spawnId}`); }
  withTask<T>(pluginId: string, label: string, fn: () => Promise<T>): Promise<T> { return this.tracker.withTask(pluginId, label, fn); }
  activeTaskCount(pluginId: string): number { this.assertNotDisposed(); return this.tracker.activeCount(pluginId); }

  // --- 内部：definePlugin 上下文构造 -----------------------------------------

  private createContext(state: PluginState, epoch: number) {
    return createPluginContext({
      state,
      epoch,
      pipelines: this.pipelines,
      capabilityRegistry: this.capabilityRegistry,
      uiRegistry: this.uiRegistry,
      docRegistry: this.docRegistry,
      configStore: this.configStore,
      hostDeps: {
        backend: this.options.host,
        tracker: this.tracker,
        options: this.options,
        plugins: this.plugins,
        getConfig: (id) => this.getConfig(id),
        setConfig: (id, val) => this.setConfig(id, val),
        list: () => this.list(),
        listUi: () => this.listUi(),
        listActions: () => this.listActions(),
        invokeAction: (target, action, input, ctx) => this.invokeAction(target, action, input, ctx),
        prepareAction: (target, action, input, ctx) => this.prepareAction(target, action, input, ctx),
        assertContextUsable: (s, ep, what) => this.assertContextUsable(s, ep, what),
      },
      assertNotDisposed: () => this.assertNotDisposed(),
      assertContextUsable: (s, ep, what) => this.assertContextUsable(s, ep, what),
      isRegisteredState: (s) => this.plugins.get(s.definition.id) === s,
    });
  }

  /** 周期内可用性守卫：周期更替/停用中/已停用一律失效（doc 句柄与宿主资源共用）。 */
  private assertContextUsable(state: PluginState, epoch: number, what: string): void {
    assertContextUsable(
      state,
      epoch,
      what,
      this.plugins.get(state.definition.id),
      this.disposed,
    );
  }

  /** 公共 doc 变更事件：value 已 JSON-safe 归一化，脱敏由宿主事件管道统一承担。 */
  private emitDocUpdated(pluginId: string, name: string, value: unknown): void {
    const doc: PublicPluginDoc = { pluginId, name, value: jsonClone(value) };
    this.options.host.emitEvent('plugin.doc.updated', { type: 'plugin.doc.updated', doc });
  }

  /** turn_settled 隔离错误统一告警：逐插件发 warning notification（正文脱敏）。 */
  private notifyIsolatedHookErrors(errors: IsolatedHookError[]): void {
    const redact = this.options.redactText ?? ((t: string) => t);
    for (const { pluginId, error } of errors) {
      this.options.host.emitEvent('notification', {
        type: 'notification',
        level: 'warning',
        title: `插件 ${pluginId} 回合结算钩子异常`,
        body: redact(error.message),
      });
    }
  }

  /** 插件实际状态转换完成后向宿主发 plugin.changed 事件。 */
  private emitPluginChanged(state: PluginState): void {
    this.options.host.emitEvent('plugin.changed', {
      type: 'plugin.changed',
      plugin: this.summaryWithManaged(state),
      ui: state.enabled && state.phase === 'idle' ? this.uiRegistry.getUiByPlugin(state.definition.id) : [],
    });
  }

  private settlePluginChanged(state: PluginState, stopError: { err: unknown } | undefined): void {
    this.settleLifecycleChanged(state, stopError, undefined);
  }

  private settleLifecycleChanged(
    state: PluginState,
    stopError: { err: unknown } | undefined,
    persistError: { err: unknown } | undefined,
  ): void {
    settleLifecycleChanged(state, stopError, persistError, () => this.emitPluginChanged(state));
  }

  private requirePlugin(pluginId: string): PluginState {
    const state = this.plugins.get(pluginId);
    if (!state) throw new HelmError('unknown_plugin', `未注册的插件：${pluginId}`, 404, { pluginId });
    return state;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new HelmError('plugin_host_disposed', 'PluginHost 已 dispose', 409);
    }
  }
}
