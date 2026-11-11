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
  type HelmHostApi,
  type HelmHostNodeIpcPort,
  type HelmPluginContext,
  type HookHandler,
  type HookName,
  type HookPayloadMap,
  type HookResult,
  type HookOptions,
  type MaybePromise,
  type PluginActionContext,
  type PluginSkillAsset,
  type PluginConfigFieldSchema,
  type PluginDefinition,
  type PublicPluginDoc,
  type PublicPluginSessionDoc,
  type PluginServiceSpec,
  type PluginSummary,
  type PluginToolContext,
  type PluginUiContribution,
  type SidebarItemSpec,
  type SidebarSectionSpec,
  type ScreenSpec,
  type TimelineRendererSpec,
  type ToolViewSpec,
  type ComposerPillSpec,
  type ComposerWidgetSpec,
  type ComposerCompleterSpec,
  type ArtifactPreviewerSpec,
  type WorkbenchPanelSpec,
  type CommandSpec,
  type SettingsPanelSpec,
  type UiActionSpec,
  type MarkdownCodeBlockSpec,
  type PluginSlotContributionSpec,
  type ProfileRuntimeUiSpec,
} from '@helm/protocol';
import type { Provider } from '@earendil-works/pi-ai';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { HOOK_ALLOWED_ACTIONS, HookPipeline } from './hooks.js';
import { PluginTaskTracker } from './tracking.js';
import { type ClientCompileResult } from './client-compiler.js';
import { redactJsonValue } from '../redact.js';
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
import { UiRegistry, UI_ACTION_SURFACES } from './ui-registry.js';
import {
  assertValidId,
  idempotentRelease,
  isCrossPlatformAbsolutePath,
  isPlainObject,
  jsonClone,
  toJsonSafeError,
  type JsonSafeErrorInfo,
} from './shared.js';

export {
  type PluginDocStore,
  type PluginSessionDocStore,
} from './doc-registry.js';

export {
  type DerivedToolSpec,
  type PluginRouteEntry,
  PROVIDER_SAFE_TOOL_NAME,
  actionToolAlias,
} from './capability-registry.js';

// 主代理集成接口 ---------------------------------------------------------------

export interface PluginConfigStore {
  get(pluginId: string): Record<string, unknown>;
  set(
    pluginId: string,
    value: Record<string, unknown>,
    schema: Record<string, PluginConfigFieldSchema>,
  ): Promise<void> | void;
  /**
   * 可选：插件启停状态持久化读取（同步，返回缓存态；undefined 表示未持久化过）。
   * 未实现时 PluginHost 为纯内存启停机制，重启回到 register 时的初始声明。
   */
  getEnabled?(pluginId: string): boolean | undefined;
  /** 可选：持久化插件启停状态；失败必须显式 reject（由宿主包装 JSON-safe 诊断）。 */
  setEnabled?(pluginId: string, enabled: boolean): Promise<void> | void;
}

export interface PluginHostOptions {
  dataDir: string;
  host: PluginHostBackend;
  docs: PluginDocStore;
  /** 会话分片持久层；缺失时声明 sessionDoc 显式失败，不使用内存或全局文档降级。 */
  sessionDocs?: PluginSessionDocStore;
  config?: PluginConfigStore;
  /**
   * 可选的插件 Provider 挂载端口（runtime 提供）：插件经 ctx.provider 声明的
   * 自带模型 Provider（如 Magpie）在启用时挂载、停用/卸载时卸载。
   */
  providers?: PluginProviderPort;
  /**
   * 宿主统一文本脱敏器（SecretStash 明文 -> marker）：ctx.host.invokeAction
   * 返回的动作输出经此值级脱敏（兑现 protocol 契约"宿主统一脱敏"，
   * 不依赖调用方插件自带 redactor）。未提供时原样返回（宿主模式/测试）。
   */
  redactText?: (text: string) => string;
  /**
   * 延迟服务启动屏障（runtime 自建 host 时使用）：true 时 register/enable 的
   * 启用插件只完成定义收集、provider 挂载与服务 prepare 登记，不执行服务
   * start()；由组合层在全部插件注册完成后统一调用 PluginHost.start()，
   * 先全局执行全部 prepare 再逐插件 start。默认 false：register 即时 prepare+start。
   */
  deferServices?: boolean;
}

/** 插件 Provider 挂载端口：机制由 runtime 实现，宿主只负责声明收集与生命周期时序。 */
export interface PluginProviderPort {
  /** 挂载 provider；返回卸载函数（幂等性由端口实现保证，拒绝时 reject 不残留）。 */
  register(provider: Provider, pluginId: string): Promise<() => Promise<void>>;
  /** 可选：停用/卸载前预检在途流/刷新，忙时抛错（如 plugin_has_live_tasks）。 */
  assertIdle?(pluginId: string): void;
}

/**
 * 宿主后端端口：ctx.host 的实现来源（Runtime 提供）。
 * secrets / setConfig 由 PluginHost 在此之上包装 pluginId 命名空间；isClosing
 * 归一为 getter；listPlugins 转发 PluginHost 自身 list()。
 */
export type PluginHostBackend = Omit<HelmHostApi, 'manageConversation' | 'skills' | 'secrets' | 'setConfig' | 'isClosing' | 'listPlugins' | 'listUi' | 'nodeIpc'> & {
  /** 声明 pluginId 对会话的管理权；返回释放函数（受管期间删除保护）。 */
  manageConversation(id: number, pluginId: string): () => void;
  skills: Omit<HelmHostApi['skills'], 'ensureSkill'> & {
    ensureSkill(asset: PluginSkillAsset, pluginId: string): Promise<void>;
  };
  /** 节点 IPC 机制端口（EnvFabric 通道；测试宿主未提供时调用显式报 501，不静默降级）。 */
  nodeIpc?: HelmHostNodeIpcPort;
  /** 插件私有 secrets 后端（PluginHost 在此之上包装 pluginId 命名空间）。 */
  secrets: {
    get(pluginId: string, key: string): Promise<string | undefined>;
    set(pluginId: string, key: string, value: string): Promise<void>;
    delete(pluginId: string, key: string): Promise<void>;
    addRedaction(value: string): () => void;
  };
  /** 插件配置写入后端（PluginHost 校验目标 pluginId 后转发；值已按 schema 校验）。 */
  setPluginConfig(pluginId: string, value: Record<string, unknown>): Promise<void>;
  /** 宿主关闭状态。 */
  isClosing(): boolean;
};

// 内部注册态 -------------------------------------------------------------------

interface ServiceEntry extends PluginServiceSpec {
  pluginId: string;
  started: boolean;
  /** prepare 已执行标记（避免重复执行；幂等由服务自身保证）。 */
  prepared: boolean;
}

/** provider 声明项：definePlugin 阶段收集，启用时挂载（记录挂载顺序供逆序卸载）。 */
interface ProviderEntry {
  provider: Provider;
  /** 挂载成功后的卸载函数；null = 尚未挂载（声明态/已卸载）。 */
  unregister: (() => Promise<void>) | null;
}

/**
 * 插件生命周期相位：
 * - defining：definePlugin 执行中（注册方法仅此相位可用）；
 * - deactivating：停用中（先于任何 await 设置，隔离新任务与旧 doc 写入）；
 * - idle：稳定态（enabled 决定是否对外可用）。
 */
type PluginPhase = 'idle' | 'defining' | 'deactivating';

/**
 * 受控停止窗口内仍可用的 ctx.host 调用（按 wrapHostApi 的 what 标签）：
 * 停止链必需的只读（listConversations/getConversation/redact/nodeIpc.isOnline）、
 * 取消（abortConversation/cancelAsk）、跨节点清理 IPC（nodeIpc.call）与最终
 * 事件（emitEvent）。集合来自真实 stop 消费者（workflow close 的 runs 投影与
 * 子会话中止、herdr 的销单/pane 清理/通知、superagent 的 Ask 取消）并按能力
 * 通用表达，不按插件 ID 特判。其余调用——含 spawnAgent/submitInput/
 * createConversation/dispatchTrigger/createAsk/execEnv/executionEnv/
 * completeText 等一切新工作入口——在窗口内同样拒绝：停用语义是拆毁收尾，
 * 不是继续干活的宽限期。
 */
const STOP_WINDOW_HOST_CALLS: ReadonlySet<string> = new Set([
  'host.listConversations',
  'host.getConversation',
  'host.abortConversation',
  'host.cancelAsk',
  'host.emitEvent',
  'host.redact',
  'host.nodeIpc.isOnline',
  'host.nodeIpc.call',
]);

interface PluginState {
  definition: PluginDefinition;
  enabled: boolean;
  phase: PluginPhase;
  /** 启用周期号：每次 enable 开始与 disable 完成时递增，使旧上下文/句柄失效。 */
  epoch: number;
  dataDir: string;
  hooks: Set<HookName>;
  services: ServiceEntry[];
  /** 本周期 ctx.provider 声明的模型 Provider（启用时挂载、停用/卸载时逆序卸载）。 */
  providers: ProviderEntry[];
  configSchema: Record<string, PluginConfigFieldSchema> | null;
  /**
   * 本启用周期经 ctx.host 获取的宿主生命周期资源释放句柄
   * （manageConversation 管理权 / onEvent 监听 / askSeq 解析器）。
   */
  hostReleases: Set<() => void>;
  /**
   * 受控停止窗口：宿主正在 await 本插件服务 stop 链期间为 true。窗口内放行
   * 本周期 doc 句柄的最终落盘与 ctx.host 清理子集（STOP_WINDOW_HOST_CALLS，
   * 含 dispose 已置 disposed 的路径）；窗口关闭后一切旧句柄调用恢复拒绝。
   * 按状态标记而非异步上下文传播：stop 等待的 settle 链 promise 在窗口
   * 打开前创建，AsyncLocalStorage 无法跨越已存在的 promise 边界。
   */
  stopWindow: boolean;
}

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
  /** 服务启动屏障状态：deferServices 模式下 false（等待显式 start()），否则恒 true。 */
  private servicesStarted: boolean;
  /** 显式 start() 幂等：已启动/启动中直接复用。 */
  private startPromise?: Promise<void>;
  /** per-plugin 生命周期操作串行链（register/enable/disable/unregister）。 */
  private lifecycle = new Map<string, Promise<unknown>>();

  constructor(private readonly options: PluginHostOptions) {
    this.configStore = options.config;
    this.servicesStarted = options.deferServices !== true;
    this.docRegistry = new PluginDocRegistry(options.docs, (pluginId, name, val) => {
      this.emitDocUpdated(pluginId, name, val);
    }, {
      sessionStore: options.sessionDocs,
      assertConversationExists: (conversationId) => { options.host.getConversation(conversationId); },
      emitSessionDocUpdated: (doc) => {
        options.host.emitEvent('plugin.session_doc.updated', { type: 'plugin.session_doc.updated', doc });
      },
    });
    for (const name of Object.keys(HOOK_ALLOWED_ACTIONS) as HookName[]) {
      this.pipelines.set(name, new HookPipeline(name));
    }
  }

  // --- 注册与启停 ---------------------------------------------------------

  /**
   * 注册插件；options.enabled 缺省 true（保持既有单参调用语义）。
   * 实际初始状态优先级：locked 插件恒启用 > 持久启停状态（configStore.getEnabled）
   * > options.enabled。
   */
  async register(
    definition: PluginDefinition,
    options: { enabled?: boolean } = {},
  ): Promise<void> {
    this.assertNotDisposed();
    this.assertDefinition(definition);
    if (this.plugins.has(definition.id)) {
      throw new HelmError('plugin_already_registered', `插件 ${definition.id} 已注册`, 409);
    }
    await this.enqueue(definition.id, async () => {
      if (this.plugins.has(definition.id)) {
        throw new HelmError('plugin_already_registered', `插件 ${definition.id} 已注册`, 409);
      }
      this.assertNotDisposed();
      const seq = ++this.registerSeq;
      const wantsEnabled = this.resolveInitialEnabled(definition, options);
      const dataDir = join(this.options.dataDir, 'plugins', definition.id);
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
      };
      this.plugins.set(definition.id, state);

      try {
        mkdirSync(dataDir, { recursive: true });
        await definition.definePlugin(this.createContext(state, state.epoch));
        this.assertUiDocsRegistered(state);
        this.assertUiCompleterActionBindings(state, false);
      } catch (err) {
        let rollbackError: JsonSafeErrorInfo | undefined;
        try {
          await this.teardownPlugin(state, { stopServices: false });
        } catch (rollbackErr) {
          rollbackError = toJsonSafeError(rollbackErr);
        }
        this.plugins.delete(definition.id);
        this.tracker.removePlugin(definition.id);
        this.removeRegistries(definition.id);
        if (err instanceof HelmError) {
          if (rollbackError) {
            throw new HelmError(err.code, err.message, err.status, { ...(err.details as object), rollbackError });
          }
          throw err;
        }
        throw new HelmError(
          'plugin_registration_failed',
          `插件 ${definition.id} 注册失败：${err instanceof Error ? err.message : String(err)}`,
          500,
          { pluginId: definition.id, registerSeq: seq, rollbackError },
        );
      }

      if (wantsEnabled) {
        try {
          this.uiRegistry.assertCrossPluginUnique(definition.id, this.getActiveEnabledPluginIds());
          this.assertUiCompleterActionBindings(state, true);
          state.enabled = true;
          await this.registerProviders(state);
          await this.activateServices(state);
        } catch (err) {
          let rollbackError: JsonSafeErrorInfo | undefined;
          try {
            await this.teardownPlugin(state, { stopServices: true });
          } catch (rollbackErr) {
            rollbackError = toJsonSafeError(rollbackErr);
          }
          state.enabled = false;
          this.plugins.delete(definition.id);
          this.tracker.removePlugin(definition.id);
          this.removeRegistries(definition.id);
          const base =
            err instanceof HelmError
              ? err
              : new HelmError(
                  'plugin_registration_failed',
                  `插件 ${definition.id} 注册失败：${err instanceof Error ? err.message : String(err)}`,
                  500,
                  { pluginId: definition.id, registerSeq: seq },
                );
          throw rollbackError
            ? new HelmError(base.code, base.message, base.status, { ...((base.details as object) ?? {}), rollbackError })
            : base;
        }
        state.phase = 'idle';
      } else {
        try {
          await this.teardownPlugin(state, { stopServices: false });
        } catch (err) {
          let rollbackError: JsonSafeErrorInfo | undefined;
          try {
            await this.teardownPlugin(state, { stopServices: false });
          } catch (rollbackErr) {
            rollbackError = toJsonSafeError(rollbackErr);
          }
          this.plugins.delete(definition.id);
          this.tracker.removePlugin(definition.id);
          this.removeRegistries(definition.id);
          const wrapped =
            err instanceof HelmError
              ? err
              : new HelmError(
                  'plugin_registration_failed',
                  `插件 ${definition.id} 注册失败：${err instanceof Error ? err.message : String(err)}`,
                  500,
                  { pluginId: definition.id, registerSeq: seq },
                );
          throw rollbackError
            ? new HelmError(wrapped.code, wrapped.message, wrapped.status, { ...((wrapped.details as object) ?? {}), rollbackError })
            : wrapped;
        }
        state.epoch += 1;
        state.phase = 'idle';
      }
      this.emitPluginChanged(state);
    });
  }

  private resolveInitialEnabled(
    definition: PluginDefinition,
    options: { enabled?: boolean },
  ): boolean {
    if (definition.locked === true) return true;
    let persisted: boolean | undefined;
    try {
      persisted = this.configStore?.getEnabled?.(definition.id);
    } catch (err) {
      if (err instanceof HelmError) throw err;
      throw new HelmError(
        'plugin_registration_failed',
        `插件 ${definition.id} 注册失败：读取持久启停状态时出错：${err instanceof Error ? err.message : String(err)}`,
        500,
        { pluginId: definition.id },
      );
    }
    if (persisted !== undefined && typeof persisted !== 'boolean') {
      throw new HelmError(
        'plugin_enabled_state_invalid',
        `插件 ${definition.id} 的持久启停状态非法（期望布尔值，实际：${typeof persisted}），拒绝注册`,
        500,
        { pluginId: definition.id, persisted: String(persisted) },
      );
    }
    if (persisted !== undefined) return persisted;
    return options.enabled !== false;
  }

  /** 取消注册（locked 拒绝；有在途任务拒绝 409，绝不等待任务结束）。 */
  async unregister(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      const state = this.requirePlugin(pluginId);
      this.assertNotLocked(state);
      if (!state.enabled) {
        await this.teardownPlugin(state, { stopServices: false });
        this.plugins.delete(pluginId);
        this.tracker.removePlugin(pluginId);
        this.removeRegistries(pluginId);
        this.emitPluginChanged(state);
        return;
      }
      this.assertNoLiveTasks(pluginId);
      this.assertProvidersIdle(pluginId);
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
      const prevConfigSchema = state.configSchema;
      state.epoch += 1;
      this.clearRegistrations(state);
      state.configSchema = null;
      state.phase = 'defining';
      let persistedEnabled = false;
      try {
        await state.definition.definePlugin(this.createContext(state, state.epoch));
        this.assertUiDocsRegistered(state);
        this.assertUiCompleterActionBindings(state, false);
        this.uiRegistry.assertCrossPluginUnique(pluginId, this.getActiveEnabledPluginIds());
        await this.registerProviders(state);
        await this.activateServices(state);
        await this.persistEnabled(state, true);
        persistedEnabled = true;
        // 最终裁决与 enabled 发布之间无 await，封住不同插件并发启用的冲突窗口。
        this.uiRegistry.assertCrossPluginUnique(pluginId, this.getActiveEnabledPluginIds());
        this.assertUiCompleterActionBindings(state, true);
        state.enabled = true;
        state.phase = 'idle';
      } catch (err) {
        let rollbackError: JsonSafeErrorInfo | undefined;
        try {
          await this.teardownPlugin(state, { stopServices: true });
        } catch (rollbackErr) {
          rollbackError = toJsonSafeError(rollbackErr);
        }
        state.enabled = false;
        state.phase = 'idle';
        state.configSchema = prevConfigSchema;
        if (persistedEnabled) {
          try {
            await this.persistEnabled(state, false);
          } catch (persistError) {
            rollbackError = { ...toJsonSafeError(persistError), ...(rollbackError ? { message: `${rollbackError.message}; ${String(persistError)}` } : {}) };
          }
        }
        if (err instanceof HelmError) {
          if (rollbackError) {
            throw new HelmError(err.code, err.message, err.status, { ...(err.details as object), rollbackError });
          }
          throw err;
        }
        throw new HelmError(
          'plugin_enable_failed',
          `插件 ${pluginId} 启用失败：${err instanceof Error ? err.message : String(err)}`,
          500,
          { pluginId, rollbackError },
        );
      }
      this.emitPluginChanged(state);
    });
  }

  async disable(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      const state = this.requirePlugin(pluginId);
      this.assertNotLocked(state);
      if (!state.enabled) return;
      this.assertNoLiveTasks(pluginId);
      this.assertProvidersIdle(pluginId);
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
      let persistError: { err: unknown } | undefined;
      try {
        await this.persistEnabled(state, false);
      } catch (err) {
        persistError = { err };
      }
      this.settleLifecycleChanged(state, stopError, persistError);
    });
  }

  /** 同插件生命周期操作串行化：后到者等待前者完成（无论成败）后再执行。 */
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

  /**
   * 清空本启用周期的全部注册句柄（含 docs 与残留宿主释放句柄）。
   * 不清 configSchema：停用态必须保留 schema 供「先 setConfig 再 enable」；
   * enable 开始时显式清空（definePlugin 将重新声明，否则 duplicate）。也不动
   * 持久 store 数据——doc 值与 config 值跨周期保留。provider 声明同样清空
   * （含未挂载的残留 unregister 句柄，见 unregisterProviders）。
   */
  private clearRegistrations(state: PluginState): void {
    this.capabilityRegistry.clear(state.definition.id);
    this.uiRegistry.clear(state.definition.id);
    this.docRegistry.clear(state.definition.id);
    state.services.length = 0;
    state.providers.length = 0;
    state.hostReleases.clear();
    for (const pipeline of this.pipelines.values()) pipeline.removeByPlugin(state.definition.id);
    state.hooks.clear();
  }

  private removeRegistries(pluginId: string): void {
    this.capabilityRegistry.removePlugin(pluginId);
    this.uiRegistry.removePlugin(pluginId);
    this.docRegistry.removePlugin(pluginId);
  }

  /**
   * 在受控停止窗口内执行服务 stop：stop 期间（含引擎 close 内部由 abort 唤醒
   * 的异步 settle 链）本插件本周期 ctx.doc 句柄的最终持久化写入与
   * STOP_WINDOW_HOST_CALLS 清理子集被放行（phase 为 deactivating、乃至
   * dispose 已置 disposed 时不再拒绝）；stop 返回（成功/失败）即复位窗口，
   * 之后一切调用恢复常规拒绝。窗口按 PluginState 标记而非异步上下文传播：
   * 引擎 settle 链的 promise 在 stop 之前创建，AsyncLocalStorage 无法跨越
   * 已存在的 promise 边界。
   */
  private async runControlledStop(state: PluginState, stop: () => MaybePromise<void>): Promise<void> {
    state.stopWindow = true;
    try {
      await stop();
    } finally {
      state.stopWindow = false;
    }
  }

  /**
   * 清理插件注册：逆向 stop 已启动服务、逆序卸载已挂载 provider、释放宿主生命
   * 周期资源（幂等）、清空全部能力注册表。stop / 卸载 / 释放失败聚合显式抛出，
   * 绝不静默吞掉；未挂载的 provider 声明跳过（enabled:false 探测路径零副作用）。
   */
  private async teardownPlugin(state: PluginState, opts: { stopServices: boolean }): Promise<void> {
    const stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }> = [];
    if (opts.stopServices) {
      for (const svc of [...state.services].reverse()) {
        if (!svc.started) continue;
        try {
          await this.runControlledStop(state, () => svc.stop());
        } catch (err) {
          stopErrors.push({ serviceId: svc.id, error: toJsonSafeError(err) });
        } finally {
          svc.started = false;
        }
      }
    }
    let providerErrors: Array<{ providerId: string; error: JsonSafeErrorInfo }> = [];
    try {
      await this.unregisterProviders(state);
    } catch (err) {
      providerErrors =
        err instanceof HelmError && Array.isArray((err.details as { unregisterErrors?: unknown } | undefined)?.unregisterErrors)
          ? ((err.details as { unregisterErrors: Array<{ providerId: string; error: JsonSafeErrorInfo }> }).unregisterErrors)
          : [{ providerId: '<unknown>', error: toJsonSafeError(err) }];
    }
    const releaseErrors: Array<{ error: JsonSafeErrorInfo }> = [];
    for (const release of [...state.hostReleases]) {
      state.hostReleases.delete(release);
      try {
        release();
      } catch (err) {
        releaseErrors.push({ error: toJsonSafeError(err) });
      }
    }
    this.clearRegistrations(state);
    if (stopErrors.length > 0) {
      throw new HelmError(
        'plugin_service_stop_failed',
        `插件 ${state.definition.id} 清理时服务 stop 失败：${stopErrors.map((e) => e.serviceId).join(', ')}`,
        500,
        { pluginId: state.definition.id, stopErrors, ...(releaseErrors.length > 0 ? { releaseErrors } : {}), ...(providerErrors.length > 0 ? { providerErrors } : {}) },
      );
    }
    if (providerErrors.length > 0) {
      throw new HelmError(
        'plugin_provider_unregister_failed',
        `插件 ${state.definition.id} 清理时 provider 卸载失败：${providerErrors.map((e) => e.providerId).join(', ')}`,
        500,
        { pluginId: state.definition.id, providerErrors },
      );
    }
    if (releaseErrors.length > 0) {
      throw new HelmError(
        'plugin_resource_release_failed',
        `插件 ${state.definition.id} 清理时宿主资源释放失败（管理保护/监听可能残留，需人工核查）`,
        500,
        { pluginId: state.definition.id, releaseErrors },
      );
    }
  }

  /**
   * 挂载本周期声明的全部 provider（在服务 start 之前）：
   * - 端口未提供且存在声明 → 显式 501（禁静默；默认停用探测不会到达这里）；
   * - 逐个挂载并登记卸载函数；任一失败对已挂载者逆序卸载（卸载失败聚合）；
   * - 卸载函数置 null 防止 teardown 重复卸载（幂等层：clearRegistrations 直接清表）。
   */
  private async registerProviders(state: PluginState): Promise<void> {
    if (state.providers.length === 0) return;
    const port = this.options.providers;
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
          ? new HelmError(err.code, err.message, err.status, { ...((err.details as object) ?? {}), unregisterErrors: rollbackErrors })
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
  private async unregisterProviders(state: PluginState): Promise<void> {
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
  private assertProvidersIdle(pluginId: string): void {
    const state = this.plugins.get(pluginId);
    if (!state || state.providers.length === 0) return;
    try {
      this.options.providers?.assertIdle?.(pluginId);
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

  /**
   * 启用路径的服务激活：
   * - servicesStarted（全局屏障已放行，含默认非 defer 模式）：单插件内先全部
   *   prepare 再 start（插件内顺序），与全局屏障语义一致；
   * - deferServices 启动期：只登记（不 prepare 不 start），等待 PluginHost.start()
   *   的全局屏障（先全部已启用插件 prepare，再逐插件 start）。
   */
  private async activateServices(state: PluginState): Promise<void> {
    if (!this.servicesStarted) return;
    await this.prepareServices(state);
    await this.startServices(state);
  }

  /**
   * 显式启动屏障（deferServices 模式）：全部插件注册完成后、调度器 resume 前
   * 调用。先对所有已启用插件逐个执行服务 prepare（任一失败：全部回滚为未启动，
   * 原始错误上抛），再逐插件按声明顺序 start（失败者逆向 stop 已启动者）。
   * 幂等；非 defer 模式调用为无害 no-op（已在各启用点即时启动）。
   */
  async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.servicesStarted) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const participants = [...this.plugins.values()].filter((s) => s.enabled);
      try {
        for (const state of participants) await this.prepareServices(state);
      } catch (err) {
        this.startPromise = undefined;
        throw err instanceof HelmError ? err : new HelmError(
          'plugin_service_prepare_failed',
          `插件服务 prepare 失败：${err instanceof Error ? err.message : String(err)}`,
          500,
          {},
        );
      }
      const started: PluginState[] = [];
      try {
        for (const state of participants) {
          await this.startServices(state);
          started.push(state);
        }
        this.servicesStarted = true;
      } catch (err) {
        const rollbackStopErrors: Array<{ pluginId: string; stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }> }> = [];
        for (const state of started.reverse()) {
          try {
            await this.stopServicesQuietly(state);
          } catch (rollbackErr) {
            rollbackStopErrors.push({
              pluginId: state.definition.id,
              stopErrors:
                rollbackErr instanceof HelmError && Array.isArray((rollbackErr.details as { stopErrors?: unknown })?.stopErrors)
                  ? ((rollbackErr.details as { stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }> }).stopErrors)
                  : [{ serviceId: '<unknown>', error: toJsonSafeError(rollbackErr) }],
            });
          }
        }
        this.startPromise = undefined;
        if (rollbackStopErrors.length > 0) {
          if (err instanceof HelmError) {
            throw new HelmError(err.code, err.message, err.status, {
              ...((err.details as object) ?? {}),
              rollbackStopErrors,
            });
          }
          throw new HelmError(
            'plugin_service_start_failed',
            `插件服务启动失败：${err instanceof Error ? err.message : String(err)}`,
            500,
            { rollbackStopErrors },
          );
        }
        throw err;
      }
    })();
    return this.startPromise;
  }

  /** 插件内全部服务 prepare（按声明顺序；无 prepare 的服务跳过；每服务仅执行一次）。 */
  private async prepareServices(state: PluginState): Promise<void> {
    for (const svc of state.services) {
      if (svc.prepare === undefined || svc.prepared) continue;
      try {
        await svc.prepare();
        svc.prepared = true;
      } catch (err) {
        throw err instanceof HelmError ? err : new HelmError(
          'plugin_service_prepare_failed',
          `插件 ${state.definition.id} 服务 ${svc.id} prepare 失败：${err instanceof Error ? err.message : String(err)}`,
          500,
          { pluginId: state.definition.id, serviceId: svc.id },
        );
      }
    }
  }

  /**
   * 启动后失败的逆向 stop：聚合各服务 stop 错误（teardown 同款聚合），
   * 已停用条目跳过；用于 start 屏障阶段 2 的回滚。
   */
  private async stopServicesQuietly(state: PluginState): Promise<void> {
    const errors: Array<{ serviceId: string; error: JsonSafeErrorInfo }> = [];
    for (const svc of [...state.services].reverse()) {
      if (!svc.started) continue;
      try {
        await this.runControlledStop(state, () => svc.stop());
        svc.started = false;
      } catch (err) {
        svc.started = false;
        errors.push({ serviceId: svc.id, error: toJsonSafeError(err) });
      }
    }
    if (errors.length > 0) {
      throw new HelmError(
        'plugin_service_stop_failed',
        `回滚停止插件 ${state.definition.id} 服务时失败：${errors.map((e) => e.serviceId).join(', ')}`,
        500,
        { pluginId: state.definition.id, stopErrors: errors },
      );
    }
  }

  /** 按声明顺序 start 服务；任一失败对已启动者逆向 stop（stop 失败聚合进诊断）。 */
  private async startServices(state: PluginState): Promise<void> {
    const started: ServiceEntry[] = [];
    try {
      for (const svc of state.services) {
        await svc.start();
        svc.started = true;
        started.push(svc);
      }
    } catch (err) {
      const stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }> = [];
      for (const svc of started.reverse()) {
        try {
          await this.runControlledStop(state, () => svc.stop());
        } catch (stopErr) {
          stopErrors.push({ serviceId: svc.id, error: toJsonSafeError(stopErr) });
        } finally {
          svc.started = false;
        }
      }
      if (err instanceof HelmError) {
        if (stopErrors.length > 0) {
          throw new HelmError(err.code, err.message, err.status, { ...(err.details as object), stopErrors });
        }
        throw err;
      }
      throw new HelmError(
        'plugin_service_start_failed',
        `插件 ${state.definition.id} 服务启动失败：${err instanceof Error ? err.message : String(err)}`,
        500,
        { pluginId: state.definition.id, stopErrors },
      );
    }
  }

  // --- 查询清单 -----------------------------------------------------------

  /** 模型请求与刷新在启动时复核生命周期，封住 teardown 预检后的新请求。 */
  assertProviderAvailable(pluginId: string): void {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    if (state && (state.phase === 'deactivating' || (!state.enabled && state.phase === 'idle'))) {
      throw new HelmError('plugin_disabled', `插件 ${pluginId} 正在停用或已停用`, 409);
    }
  }

  list(): PluginSummary[] {
    this.assertNotDisposed();
    return [...this.plugins.values()].map((s) => this.summaryOf(s));
  }

  private summaryOf(s: PluginState): PluginSummary {
    return {
      id: s.definition.id,
      name: s.definition.name ?? s.definition.id,
      version: s.definition.version,
      locked: s.definition.locked === true,
      enabled: s.enabled,
      hooks: s.enabled ? [...s.hooks] : [],
      actions: s.enabled ? this.capabilityRegistry.getActionIds(s.definition.id) : [],
      tools: s.enabled ? this.capabilityRegistry.getToolNames(s.definition.id) : [],
    };
  }

  private getActiveEnabledPluginIds(): string[] {
    const ids: string[] = [];
    for (const [id, s] of this.plugins) {
      if (s.enabled) ids.push(id);
    }
    return ids;
  }

  private getIdleActivePluginIds(): string[] {
    const ids: string[] = [];
    for (const [id, s] of this.plugins) {
      if (s.enabled && s.phase === 'idle') ids.push(id);
    }
    return ids;
  }

  listActions(): ActionManifest[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listActions(this.getActiveEnabledPluginIds());
  }

  listTools(conversation?: ConversationSummary): DerivedToolSpec[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listTools(this.getActiveEnabledPluginIds(), conversation);
  }

  listRoutes(): PluginRouteEntry[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listRoutes(this.getActiveEnabledPluginIds());
  }

  listUi(): PluginUiContribution[] {
    this.assertNotDisposed();
    return this.uiRegistry.listUi(this.getActiveEnabledPluginIds());
  }

  private assertUiDocsRegistered(state: PluginState): void {
    const pluginId = state.definition.id;
    this.uiRegistry.assertUiDocsRegistered(
      pluginId,
      (name) => this.docRegistry.hasPublicDoc(pluginId, name),
      (name) => this.docRegistry.hasPublicSessionDoc(pluginId, name),
    );
  }

  /**
   * composer.completer 动作源绑定校验（定义期末 / 启用提交点）：
   * - 本插件引用：动作必须已声明且 idempotent: true（补全查询高频触发，
   *   不得绑定非幂等副作用动作）；动作声明可晚于 UI 声明，故在定义期末校验；
   * - 跨插件引用：仅在启用提交点（crossPlugin=true，与 enabled 发布同一同步块）
   *   且目标插件当前已启用时校验存在与 idempotent；目标尚未注册/启用时不拒绝
   *   （合法的稍后注册，运行期前端经 action manifest 兑底校验可用性）。
   * idempotent 只是声明性标记（允许断链重跑），不代表代码安全沙箱。
   */
  private assertUiCompleterActionBindings(state: PluginState, crossPlugin: boolean): void {
    const pluginId = state.definition.id;
    for (const u of this.uiRegistry.getUiByPlugin(pluginId)) {
      if (u.surface !== 'composer.completer') continue;
      const source = (u.spec as { source?: unknown }).source;
      if (!isPlainObject(source) || source['kind'] !== 'action') continue;
      const actionId = source['actionId'];
      if (typeof actionId !== 'string') continue; // 注册边界已拒绝非法形状
      const actionPluginId = source['actionPluginId'];
      const targetPluginId =
        typeof actionPluginId === 'string' && actionPluginId.length > 0 ? actionPluginId : pluginId;
      if (targetPluginId !== pluginId && !crossPlugin) continue;
      if (targetPluginId !== pluginId) {
        const target = this.plugins.get(targetPluginId);
        if (!target || !target.enabled) continue; // 目标未注册/未启用：允许稍后注册
        const binding = this.capabilityRegistry.getActionBinding(targetPluginId, actionId);
        if (binding === undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} 的补全源引用了插件 ${targetPluginId} 未声明的动作 ${actionId}`,
            400,
            { pluginId, id: String((u.spec as { id?: unknown }).id), targetPluginId, actionId },
          );
        }
        if (!binding.idempotent) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} 的补全源绑定的动作 ${targetPluginId}.${actionId} 必须 idempotent: true`,
            400,
            { pluginId, id: String((u.spec as { id?: unknown }).id), targetPluginId, actionId },
          );
        }
        continue;
      }
      const binding = this.capabilityRegistry.getActionBinding(pluginId, actionId);
      if (binding === undefined) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} 的补全源引用了本插件未声明的动作 ${actionId}`,
          400,
          { pluginId, id: String((u.spec as { id?: unknown }).id), actionId },
        );
      }
      if (!binding.idempotent) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} 的补全源绑定的动作 ${actionId} 必须 idempotent: true（补全查询不得触发非幂等副作用）`,
          400,
          { pluginId, id: String((u.spec as { id?: unknown }).id), actionId },
        );
      }
    }
  }

  // --- client.tsx 编译产物 --------------------------------------------------

  /**
   * 获取已启用插件的 client 模块编译产物（缓存命中时零编译）。
   * 停用/未注册/未声明 clientRoot/模块越根/编译失败一律显式抛 HelmError；
   * 供 HTTP GET /api/plugins/:id/client.mjs 消费（鉴权在 HTTP 层）。
   */
  async getClientModule(pluginId: string, moduleRef: string): Promise<ClientCompileResult> {
    this.assertNotDisposed();
    return this.uiRegistry.getClientModule(pluginId, moduleRef, {
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

  /**
   * 读取插件公共 doc 快照。私有 doc、未声明 doc、插件停用/不存在一律统一
   * 404（外部无从探测私有 doc 是否存在）；未写过时返回归一化初值。
   */
  getPublicDoc(pluginId: string, name: string): PublicPluginDoc {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    const isActive = !!state && state.enabled && state.phase === 'idle';
    return this.docRegistry.getPublicDoc(pluginId, name, isActive);
  }

  /** 专用会话文档 HTTP/SSE 的统一读取入口；存储与边界校验由文档注册表负责。 */
  getPublicSessionDoc(pluginId: string, name: string, conversationId: number): PublicPluginSessionDoc {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    const isActive = !!state && state.enabled && state.phase === 'idle';
    return this.docRegistry.getPublicSessionDoc(pluginId, name, conversationId, isActive);
  }

  /**
   * 全部已启用插件公共文档快照（SSE HelmSnapshot.pluginDocs 首帧直投用）：
   * 合并每个 idle 插件中 isPublic === true 的文档；快照读取失败属单一插件
   * 故障，聚合诊断后如实上抛（绝不静默丢一份公共快照让前端误判状态）。
   */
  listPublicDocs(): PublicPluginDoc[] {
    this.assertNotDisposed();
    return this.docRegistry.listPublicDocs(this.getIdleActivePluginIds());
  }

  /**
   * 全部已启用且已启动服务声明的工作树占用清单（通用机制面）：合并各
   * 服务 liveWorktrees() 返回值（如执行隔离的插件声明在途占用，供其他
   * 能力查询）。服务声明函数抛错或返回非法形状时如实显式报错，绝不静默
   * 当空——占用检查坏了就必须修，不能靠猜放行。
   */
  listLiveWorktrees(): Array<{ nodeId: string; path: string }> {
    this.assertNotDisposed();
    const out: Array<{ nodeId: string; path: string }> = [];
    for (const state of this.plugins.values()) {
      if (!state.enabled) continue;
      for (const svc of state.services) {
        if (!svc.started || svc.liveWorktrees === undefined) continue;
        let declared: Array<{ nodeId: string; path: string }>;
        try {
          declared = svc.liveWorktrees();
        } catch (err) {
          throw new HelmError(
            'plugin_live_worktrees_check_failed',
            `插件 ${state.definition.id} 服务 ${svc.id} 的 liveWorktrees 检查抛出异常`,
            500,
            { pluginId: state.definition.id, serviceId: svc.id, error: toJsonSafeError(err) },
          );
        }
        if (
          !Array.isArray(declared) ||
          declared.some(
            (item) =>
              typeof item !== 'object' ||
              item === null ||
              Array.isArray(item) ||
              typeof (item as { nodeId?: unknown }).nodeId !== 'string' ||
              typeof (item as { path?: unknown }).path !== 'string',
          )
        ) {
          throw new HelmError(
            'plugin_live_worktrees_check_failed',
            `插件 ${state.definition.id} 服务 ${svc.id} 的 liveWorktrees 必须返回 { nodeId, path } 数组`,
            500,
            { pluginId: state.definition.id, serviceId: svc.id },
          );
        }
        out.push(...declared);
      }
    }
    return out;
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

  /**
   * around（continuation）钩子执行：仅 agent_spawn。与 runHook 同一参与者
   * 快照与任务跟踪，但允许插件经受控 next 包裹完整执行（含后续管道与
   * 默认原生执行行）。返回值即最终执行产物（handled 接管产物或 defaultRun
   * 结果）；block 语义升维为 hook_blocked 异常（agent_spawn 默认不允许）。
   */
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
      const spawnPipeline = pipeline as unknown as HookPipeline<'agent_spawn'>
      return await spawnPipeline.runAround(
        payload,
        defaultRun,
        (h: { pluginId: string }) => snapshot.has(h as never),
      )
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
        const state = this.requirePlugin(pluginId);
        this.assertActive(state);
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

  /** 用户侧读取（secret 脱敏出 HTTP 由 runtime 承担）。 */
  getConfig(pluginId: string): Record<string, unknown> {
    this.assertNotDisposed();
    return this.configStore ? { ...this.configStore.get(pluginId) } : {};
  }

  /** 声明式配置 Schema（供 settings 面板自动表单）。 */
  getConfigSchema(pluginId: string): Record<string, PluginConfigFieldSchema> {
    this.assertNotDisposed();
    const state = this.requirePlugin(pluginId);
    return state.configSchema ? { ...state.configSchema } : {};
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
    const errors: Array<{ pluginId: string; error: JsonSafeErrorInfo }> = [];
    for (const state of [...this.plugins.values()].reverse()) {
      state.phase = 'deactivating';
      try {
        await this.teardownPlugin(state, { stopServices: true });
        state.enabled = false;
      } catch (err) {
        errors.push({ pluginId: state.definition.id, error: toJsonSafeError(err) });
      } finally {
        state.phase = 'idle';
        this.tracker.removePlugin(state.definition.id);
        this.removeRegistries(state.definition.id);
      }
    }
    this.plugins.clear();
    if (errors.length > 0) {
      throw new HelmError(
        'plugin_dispose_failed',
        `dispose 时部分插件清理失败：${errors.map((e) => e.pluginId).join(', ')}`,
        500,
        { errors },
      );
    }
  }

  // --- 在途任务跟踪 ---------------------------------------------------------

  /** 挂起 agent_spawn 跟踪：钩子 handled 等待外部 Agent 完成期间登记在途。 */
  beginSpawnTask(pluginId: string, spawnId: string): void {
    this.tracker.begin(pluginId, `spawn:${spawnId}`);
  }

  /** 结束 agent_spawn 跟踪。 */
  endSpawnTask(pluginId: string, spawnId: string): void {
    this.tracker.end(pluginId, `spawn:${spawnId}`);
  }

  /** 通用受跟踪自定义任务包装（暴露给 runtime / 测试）。 */
  withTask<T>(pluginId: string, label: string, fn: () => Promise<T>): Promise<T> {
    return this.tracker.withTask(pluginId, label, fn);
  }

  /** 活跃任务数。 */
  activeTaskCount(pluginId: string): number {
    this.assertNotDisposed();
    return this.tracker.activeCount(pluginId);
  }

  // --- 内部：definePlugin 上下文构造 -----------------------------------------

  private createContext(state: PluginState, epoch: number): HelmPluginContext {
    const pluginId = state.definition.id;
    const self = this;

    /** 注册方法仅在本启用周期的 definePlugin 执行期间可用。 */
    const assertOpen = (what: string) => {
      self.assertNotDisposed();
      if (epoch !== state.epoch || state.phase !== 'defining') {
        throw new HelmError(
          'plugin_context_closed',
          `插件 ${pluginId} 的 definePlugin 上下文已关闭（停用或进入新启用周期），不允许 ${what}`,
          409,
        );
      }
    };

    /**
     * doc 句柄在本周期内（含运行期）可写；停用中或周期更替后失效。
     * 例外：受控停止窗口（宿主正在 await 的本插件服务 stop 链，epoch 由句柄
     * 闭包保证一致）允许最终持久化写入，见 PluginState.stopWindow。
     */
    const assertDocUsable = (name: string) => {
      if (state.stopWindow && self.plugins.get(pluginId) === state && state.epoch === epoch) {
        // 受控停止窗口：仅要求插件注册态与本周期仍在（dispose 后期 plugins.clear /
        // reenable 周期更替后的残留调用依然拒绝）。
        return;
      }
      self.assertContextUsable(state, epoch, `doc ${name} 句柄`);
    };

    const addHook = <N extends HookName>(name: N, fn: HookHandler<N>, opts?: HookOptions) => {
      assertOpen(`追加 ${name} 钩子`);
      (self.pipelines.get(name) as unknown as HookPipeline<N>).add(pluginId, fn, opts?.priority ?? 0);
      state.hooks.add(name);
    };

    const ctx: HelmPluginContext = {
      pluginId,
      dataDir: state.dataDir,
      getConfig: () => (self.configStore ? self.configStore.get(pluginId) : {}) as never,
      configSchema: (schema) => {
        assertOpen('声明 configSchema');
        if (state.configSchema) {
          throw new HelmError('duplicate_config_schema', `插件 ${pluginId} 重复声明 configSchema`, 409);
        }
        state.configSchema = schema;
      },

      hook: {
        onTrigger: (fn, o) => addHook('trigger', fn, o),
        onInput: (fn, o) => addHook('input', fn, o),
        onBeforeTurn: (fn, o) => addHook('before_turn', fn, o),
        onToolCall: (fn, o) => addHook('tool_call', fn, o),
        onToolResult: (fn, o) => addHook('tool_result', fn, o),
        onAgentSpawn: (fn, o) => addHook('agent_spawn', fn, o),
        onTurnSettled: (fn, o) => addHook('turn_settled', fn, o),
      },

      action: (spec) => {
        assertOpen(`声明动作 ${spec.id}`);
        self.capabilityRegistry.registerAction(pluginId, spec);
      },

      tool: (spec) => {
        assertOpen(`声明工具 ${spec.name}`);
        self.capabilityRegistry.registerTool(pluginId, spec);
      },

      route: (spec) => {
        assertOpen(`声明路由 ${spec.path}`);
        self.capabilityRegistry.registerRoute(pluginId, spec);
      },

      doc: (name, initial, opts) => {
        assertOpen(`声明 doc ${name}`);
        return self.docRegistry.registerDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
      },

      sessionDoc: (name, initial, opts) => {
        assertOpen(`声明 sessionDoc ${name}`);
        return self.docRegistry.registerSessionDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
      },

      service: (spec: PluginServiceSpec) => {
        assertOpen(`声明服务 ${spec.id}`);
        assertValidId('服务', spec.id);
        if (spec.liveTasks !== undefined && typeof spec.liveTasks !== 'function') {
          throw new HelmError(
            'invalid_service_spec',
            `插件 ${pluginId} 服务 ${spec.id} 的 liveTasks 必须是返回字符串数组的函数`,
            400,
            { pluginId, serviceId: spec.id },
          );
        }
        if (spec.liveWorktrees !== undefined && typeof spec.liveWorktrees !== 'function') {
          throw new HelmError(
            'invalid_service_spec',
            `插件 ${pluginId} 服务 ${spec.id} 的 liveWorktrees 必须是返回 { nodeId, path } 数组的函数`,
            400,
            { pluginId, serviceId: spec.id },
          );
        }
        if (spec.prepare !== undefined && typeof spec.prepare !== 'function') {
          throw new HelmError(
            'invalid_service_spec',
            `插件 ${pluginId} 服务 ${spec.id} 的 prepare 必须是函数`,
            400,
            { pluginId, serviceId: spec.id },
          );
        }
        if (state.services.some((s) => s.id === spec.id)) {
          throw new HelmError('duplicate_service', `插件 ${pluginId} 重复声明服务 ${spec.id}`, 409);
        }
        state.services.push({ ...spec, pluginId, started: false, prepared: false });
      },

      provider: (provider: Provider) => {
        assertOpen(`声明 provider ${(provider as { id?: unknown })?.id ?? '<unknown>'}`);
        self.assertValidProviderShape(pluginId, provider);
        if (state.providers.some((p) => p.provider.id === provider.id)) {
          throw new HelmError('duplicate_provider', `插件 ${pluginId} 重复声明 provider ${provider.id}`, 409);
        }
        state.providers.push({ provider, unregister: null });
      },

      ui: {
        sidebarItem: (spec: SidebarItemSpec) => {
          assertOpen('声明 ui.sidebarItem');
          self.uiRegistry.registerUi(pluginId, 'sidebar.item', spec, 'sidebarItem', state.definition.clientRoot);
        },
        sidebarSection: (spec: SidebarSectionSpec) => {
          assertOpen('声明 ui.sidebarSection');
          self.uiRegistry.registerUi(pluginId, 'sidebar.section', spec, 'sidebarSection', state.definition.clientRoot);
        },
        screen: (spec: ScreenSpec) => {
          assertOpen('声明 ui.screen');
          self.uiRegistry.registerUi(pluginId, 'screen', spec, 'screen', state.definition.clientRoot);
        },
        timelineRenderer: (spec: TimelineRendererSpec) => {
          assertOpen('声明 ui.timelineRenderer');
          self.uiRegistry.registerUi(pluginId, 'timeline.renderer', spec, 'timelineRenderer', state.definition.clientRoot);
        },
        markdownCodeBlock: (spec: MarkdownCodeBlockSpec) => {
          assertOpen('声明 ui.markdownCodeBlock');
          self.uiRegistry.registerUi(pluginId, 'markdown.codeBlock', spec, 'markdownCodeBlock', state.definition.clientRoot);
        },
        toolView: (spec: ToolViewSpec) => {
          assertOpen('声明 ui.toolView');
          self.uiRegistry.registerUi(pluginId, 'tool.view', spec, 'toolView', state.definition.clientRoot);
        },
        composerPill: (spec: ComposerPillSpec) => {
          assertOpen('声明 ui.composerPill');
          self.uiRegistry.registerUi(pluginId, 'composer.pill', spec, 'composerPill', state.definition.clientRoot);
        },
        composerWidget: (spec: ComposerWidgetSpec) => {
          assertOpen('声明 ui.composerWidget');
          self.uiRegistry.registerUi(pluginId, 'composer.widget', spec, 'composerWidget', state.definition.clientRoot);
        },
        composerCompleter: (spec: ComposerCompleterSpec) => {
          assertOpen('声明 ui.composerCompleter');
          self.uiRegistry.registerUi(pluginId, 'composer.completer', spec, 'composerCompleter', state.definition.clientRoot);
        },
        artifactPreviewer: (spec: ArtifactPreviewerSpec) => {
          assertOpen('声明 ui.artifactPreviewer');
          self.uiRegistry.registerUi(pluginId, 'artifact.previewer', spec, 'artifactPreviewer', state.definition.clientRoot);
        },
        workbenchPanel: (spec: WorkbenchPanelSpec) => {
          assertOpen('声明 ui.workbenchPanel');
          self.uiRegistry.registerUi(pluginId, 'workbench.panel', spec, 'workbenchPanel', state.definition.clientRoot);
        },
        command: (spec: CommandSpec) => {
          assertOpen('声明 ui.command');
          self.uiRegistry.registerUi(pluginId, 'commandPalette', spec, 'command', state.definition.clientRoot);
        },
        settingsPanel: (spec: SettingsPanelSpec) => {
          assertOpen('声明 ui.settingsPanel');
          self.uiRegistry.registerUi(pluginId, 'settings.panel', spec, 'settingsPanel', state.definition.clientRoot);
        },
        profileRuntime: (spec: ProfileRuntimeUiSpec) => {
          assertOpen('声明 ui.profileRuntime');
          self.uiRegistry.registerUi(pluginId, 'profile.runtime', spec, 'profileRuntime', state.definition.clientRoot);
        },
        action: (spec: UiActionSpec) => {
          assertOpen(`声明 ui.action（${spec.target}）`);
          const surface = UI_ACTION_SURFACES[spec.target];
          if (surface === undefined) {
            throw new HelmError(
              'invalid_ui_spec',
              `插件 ${pluginId} ui.action 的 target 非法（${String(spec.target)}；允许 conversation:header | conversation:row | timeline:entry）`,
              400,
              { pluginId, target: String(spec.target) },
            );
          }
          self.uiRegistry.registerUi(pluginId, surface, spec, 'action', state.definition.clientRoot);
        },
        slot: (spec: PluginSlotContributionSpec) => {
          assertOpen('声明 ui.slot');
          self.uiRegistry.registerUi(pluginId, 'plugin.slot', spec, 'slot', state.definition.clientRoot);
        },
      },

      host: self.wrapHostApi(state, epoch),
    };

    return ctx;
  }

  /**
   * 构造插件视角的 ctx.host：全部方法显式转发到后端端口。
   * 生命周期红线（每个周期统一遵守）：
   * - 每次调用前 assertContextUsable（epoch 守卫：停用/重启用后旧句柄立即失效）；
   * - 所有异步操作包 tracker.withTask（停用预检可见在途任务，不留盲区）；
   * - 生命周期资源（manageConversation / onEvent / registerAskSeqResolver /
   *   secrets.addRedaction / nodeIpc 资源型订阅）经 acquire 包装：幂等释放 +
   *   停用统一解除；
   * - 子端口（profiles / skills / secrets / nodeIpc / executionEnv 代理）逐方法
   *   同一守卫，绝不裸泄漏 backend 引用（旧周期句柄不可在 disable 后继续读写）。
   */
  private wrapHostApi(state: PluginState, epoch: number): HelmHostApi {
    const pluginId = state.definition.id;
    const backend = this.options.host;
    /**
     * 每次调用的周期守卫；what 入诊断。
     * 受控停止窗口例外：本周期、宿主正在 await 本插件服务 stop 链期间，仅
     * STOP_WINDOW_HOST_CALLS（读取/取消/跨节点清理/最终事件）放行——含
     * dispose 已置 disposed 的拆毁路径（assertNotDisposed 一并越过）；其余
     * 调用（一切新工作入口）照拒，窗口不因 deactivating 全开。
     */
    const guard = (what: string): void => {
      if (
        state.stopWindow &&
        STOP_WINDOW_HOST_CALLS.has(what) &&
        this.plugins.get(pluginId) === state &&
        state.epoch === epoch
      ) {
        return;
      }
      this.assertContextUsable(state, epoch, what);
    };
    /** 异步操作统一：先守卫再入任务（停用预检可见，不留盲区）。 */
    const tracked = <T>(what: string, op: () => Promise<T>): Promise<T> => {
      guard(what);
      return this.tracker.withTask(pluginId, what, op);
    };
    const acquire =
      (what: string) =>
      (acquireFn: () => () => void): (() => void) => {
        guard(what);
        const release = idempotentRelease(acquireFn());
        state.hostReleases.add(release);
        return () => {
          state.hostReleases.delete(release);
          release();
        };
      };
    return {
      get isClosing() {
        return backend.isClosing();
      },
      profiles: {
        list: () => tracked('host.profiles.list', () => backend.profiles.list()),
        get: (id) => tracked('host.profiles.get', () => backend.profiles.get(id)),
        getSystem: (id) => tracked('host.profiles.getSystem', () => backend.profiles.getSystem(id)),
        save: (profile) => tracked('host.profiles.save', () => backend.profiles.save(profile)),
        directory: (id) => tracked('host.profiles.directory', () => backend.profiles.directory(id)),
      },
      skills: {
        list: () => tracked('host.skills.list', () => backend.skills.list()),
        readFile: (skillId, path) => tracked('host.skills.readFile', () => backend.skills.readFile(skillId, path)),
        directory: (id) => tracked('host.skills.directory', () => backend.skills.directory(id)),
        ensureSkill: (asset) => tracked('host.skills.ensureSkill', () => backend.skills.ensureSkill(asset, pluginId)),
      },
      nodeIpc: backend.nodeIpc === undefined
        ? {
            isOnline: () => {
              guard('host.nodeIpc.isOnline');
              throw new HelmError('node_ipc_unavailable', '宿主未提供节点 IPC 通道（EnvFabric 未接线）', 501);
            },
            call: () => {
              guard('host.nodeIpc.call');
              throw new HelmError('node_ipc_unavailable', '宿主未提供节点 IPC 通道（EnvFabric 未接线）', 501);
            },
            subscribe: () => {
              guard('host.nodeIpc.subscribe');
              throw new HelmError('node_ipc_unavailable', '宿主未提供节点 IPC 通道（EnvFabric 未接线）', 501);
            },
          }
        : {
            isOnline: (nodeId) => {
              guard('host.nodeIpc.isOnline');
              return backend.nodeIpc!.isOnline(nodeId);
            },
            ...(backend.nodeIpc.getNodeHubUrl !== undefined
              ? {
                  getNodeHubUrl: (nodeId: string) => {
                    guard('host.nodeIpc.getNodeHubUrl');
                    return backend.nodeIpc!.getNodeHubUrl?.(nodeId);
                  },
                }
              : {}),
            call: (nodeId, input, signal) =>
              tracked(`host.nodeIpc.call`, () => backend.nodeIpc!.call(nodeId, input, signal)),
            subscribe: (nodeId, input, onLine, onClosed, signal) => {
              guard('host.nodeIpc.subscribe');
              // 竞态安全：acquire 时刻即建立 AbortController；调用方 stop /
              // 宿主停用释放 / 外部 signal abort 汇入同一幂等收割点——后端退订
              // 至多调用一次、外部 abort listener 必被摘除（不泄漏在调用方
              // signal 上）、释放先于建立完成时晚到订阅立即收割。返回给调用方
              // 的 stop 即 acquire 封装（同步解除 hostReleases 登记），调用方
              // 直接 stop 与停用释放绝不叠加成两次退订；建立错误留在返回的
              // Promise（调用方可 await），绝不 void 吐成 unhandled rejection。
              const controller = new AbortController();
              let backendStop: (() => void) | undefined;
              let reaped = false;
              /** 外部 abort 监听：终结订阅，转发进唯一收割路径（release 幂等）。 */
              const onExternalAbort = () => release();
              /** 唯一收割点（幂等）：摘外部 abort listener；后端退订至多一次。 */
              const reap = (): void => {
                if (reaped) return;
                reaped = true;
                signal?.removeEventListener('abort', onExternalAbort);
                const stop = backendStop;
                backendStop = undefined;
                stop?.();
              };
              const release = acquire('host.nodeIpc.subscribe')(() => () => {
                controller.abort(signal?.aborted ? signal.reason : undefined);
                reap();
              });
              if (signal?.aborted) onExternalAbort();
              else signal?.addEventListener('abort', onExternalAbort, { once: true });
              const establish = this.tracker.withTask(pluginId, 'host.nodeIpc.subscribe', async () => {
                const unsubscribe = await backend.nodeIpc!.subscribe(
                  nodeId,
                  input,
                  onLine,
                  onClosed,
                  controller.signal,
                );
                if (reaped) {
                  unsubscribe(); // 收割先于建立完成：晚到订阅立即退订（仍只此一次）
                  return release;
                }
                backendStop = unsubscribe;
                return release;
              });
              return establish;
            },
          },
      secrets: {
        get: (key) => tracked('host.secrets.get', () => backend.secrets.get(pluginId, key)),
        set: (key, value) => tracked('host.secrets.set', () => backend.secrets.set(pluginId, key, value)),
        delete: (key) => tracked('host.secrets.delete', () => backend.secrets.delete(pluginId, key)),
        addRedaction: (value) =>
          acquire('host.secrets.addRedaction')(() => backend.secrets.addRedaction(value)),
      },
      setConfig: async (patch) => {
        guard('host.setConfig');
        // 增量合并：未提供字段保留现值（插件自更新常见场景是改单个开关，
        // 不要求携带全部字段）；校验与持久化走 PluginHost 同一 setConfig 链。
        const current = this.getConfig(pluginId);
        await this.setConfig(pluginId, { ...current, ...patch });
      },
      listPlugins: () => {
        guard('host.listPlugins');
        return this.list();
      },
      listUi: () => {
        guard('host.listUi');
        return this.listUi();
      },
      refreshModels: (options) => tracked('host.refreshModels', () => backend.refreshModels(options)),
      withFileLock: <T,>(path: string, fn: () => Promise<T>, opts?: { signal?: AbortSignal }) => {
        guard('host.withFileLock');
        // 队列内二次守卫：获得锁真正调用 fn 前再验周期（等待锁跨停用时旧
        // 周期闭包不得落写，与 fileMutationQueue 修正同语义）。
        return this.tracker.withTask(pluginId, 'host.withFileLock', () =>
          backend.withFileLock(path, async () => {
            guard('host.withFileLock.fn')
            return fn()
          }, opts),
        )
      },
      atomicWriteFile: (path, content) => tracked('host.atomicWriteFile', () => backend.atomicWriteFile(path, content)),
      redact: (text) => {
        guard('host.redact');
        return backend.redact(text);
      },
      dispatchTrigger: (event) => {
        guard('host.dispatchTrigger');
        return this.tracker.withTask(pluginId, 'host.dispatchTrigger', () =>
          Promise.resolve(backend.dispatchTrigger(event)),
        );
      },
      submitInput: (id, text, opts) => {
        guard('host.submitInput');
        return this.tracker.withTask(pluginId, 'host.submitInput', () =>
          Promise.resolve(backend.submitInput(id, text, opts)),
        );
      },
      createConversation: (init) => tracked('host.createConversation', () => backend.createConversation(init)),
      listConversations: (filter) => {
        guard('host.listConversations');
        return backend.listConversations(filter);
      },
      getConversation: (id) => {
        guard('host.getConversation');
        return backend.getConversation(id);
      },
      getConversationDetail: (id, options) =>
        tracked('host.getConversationDetail', () => backend.getConversationDetail(id, options)),
      updateConversation: (id, patch) => tracked('host.updateConversation', () => backend.updateConversation(id, patch)),
      abortConversation: (id) => tracked('host.abortConversation', () => backend.abortConversation(id)),
      getConversationOwnership: (id) => {
        guard('host.getConversationOwnership');
        return backend.getConversationOwnership(id);
      },
      getConversationActivity: (id) => {
        guard('host.getConversationActivity');
        return backend.getConversationActivity(id);
      },
      listArtifacts: (conversationId) => tracked('host.listArtifacts', () => backend.listArtifacts(conversationId)),
      getArtifact: (artifactId, conversationId) =>
        tracked('host.getArtifact', () => backend.getArtifact(artifactId, conversationId)),
      completeText: (input) => tracked('host.completeText', () => backend.completeText(input)),
      executionEnv: (nodeId, cwd) => {
        guard('host.executionEnv');
        return this.controlledExecutionEnv(state, epoch, backend.executionEnv(nodeId, cwd));
      },
      buildSpawnEnv: (conversationId, cwd, nodeId) => {
        guard('host.buildSpawnEnv');
        return backend.buildSpawnEnv(conversationId, cwd, nodeId);
      },
      spawnAgent: (request) => {
        guard('host.spawnAgent');
        return this.tracker.withTask(pluginId, 'host.spawnAgent', () =>
          Promise.resolve(backend.spawnAgent(request)),
        );
      },
      runGate: (command, options) => tracked('host.runGate', () => backend.runGate(command, options)),
      prepareInterruptedConversations: (ids) =>
        tracked('host.prepareInterruptedConversations', () => backend.prepareInterruptedConversations(ids)),
      resolveSpawnTarget: (input) => tracked('host.resolveSpawnTarget', () => backend.resolveSpawnTarget(input)),
      listActiveSpawnExecutions: () => {
        guard('host.listActiveSpawnExecutions');
        return backend.listActiveSpawnExecutions();
      },
      probeNodeFs: (input) => tracked('host.probeNodeFs', () => backend.probeNodeFs(input)),
      redactText: (text) => {
        guard('host.redactText');
        return backend.redactText(text);
      },
      invokeAction: async (targetPluginId, actionId, input, context) => {
        guard('host.invokeAction');
        const raw = await this.tracker.withTask(pluginId, `host.invokeAction:${targetPluginId}.${actionId}`, () =>
          Promise.resolve(this.invokeAction(targetPluginId, actionId, input, context)),
        );
        const redactText = this.options.redactText;
        return redactText ? redactJsonValue(raw, redactText) : raw;
      },
      listActions: () => {
        guard('host.listActions');
        return this.listActions();
      },
      markConversationOwnership: (id, owner) => {
        guard('host.markConversationOwnership');
        backend.markConversationOwnership(id, owner);
      },
      createAsk: (spec) => tracked('host.createAsk', () => backend.createAsk(spec)),
      cancelAsk: (askId, reason) => tracked('host.cancelAsk', () => backend.cancelAsk(askId, reason)),
      execEnv: async (req, opts) => {
        guard('host.execEnv');
        return this.tracker.withTask(pluginId, 'host.execEnv', () =>
          Promise.resolve(backend.execEnv(req, opts)),
        );
      },
      // 必选能力（protocol 契约）：tracker 覆盖排队到执行全程；插件停用与
      // epoch 失效由 backend 的 EnvFabric 路径自然传播，而真正拿到锁、即将
      // 执行插件 fn 前再复查一次上下文——排队等待期间插件被停用的残留回调
      // 不得进入执行窗口。
      withFileMutationQueue: async <T>(
        target: { nodeId: string; cwd: string; path: string },
        fn: () => Promise<T>,
        opts?: { signal?: AbortSignal },
      ): Promise<T> =>
        this.tracker.withTask(pluginId, `host.fileQueue:${target.nodeId}`, async () =>
          backend.withFileMutationQueue<T>(target, async () => {
            this.assertContextUsable(state, epoch, 'host.withFileMutationQueue(locked)');
            return fn();
          }, opts),
        ),
      prepareAction: (targetPluginId, actionId, input, context) => {
        guard('host.prepareAction');
        return this.prepareAction(targetPluginId, actionId, input, context);
      },
      onEvent: (type, listener) =>
        acquire(`host.onEvent:${type}`)(() =>
          backend.onEvent(type, (payload: unknown) =>
            this.tracker.withTask(pluginId, `event:${type}`, async () => {
              await listener(payload);
            }),
          ),
        ),
      emitEvent: (type, payload, options) => {
        guard('host.emitEvent');
        return backend.emitEvent(type, payload, options);
      },
      manageConversation: (id) =>
        acquire('host.manageConversation')(() => backend.manageConversation(id, pluginId)),
      registerAskSeqResolver: (resolver) =>
        acquire('host.registerAskSeqResolver')(() => backend.registerAskSeqResolver(resolver)),
    };
  }

  /**
   * executionEnv 受控代理：每个方法调用时重新校验周期（停用/re-enable 后旧
   * env 代理立即失效），异步操作入任务跟踪；绝不裸返回 backend 原始 env 实例。
   * 代理保留 SDK ExecutionEnv 完整形状（方法级包装，含可选方法）。
   */
  private controlledExecutionEnv(state: PluginState, epoch: number, env: ExecutionEnv): ExecutionEnv {
    const pluginId = state.definition.id;
    const self = this;
    return new Proxy(env, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        const name = String(prop);
        const fn = value as (...args: unknown[]) => unknown;
        const wrapped = (...args: unknown[]): unknown => {
          self.assertContextUsable(state, epoch, `host.executionEnv.${name}`);
          const result = fn.apply(target, args);
          if (result instanceof Promise) {
            return self.tracker.withTask(pluginId, `host.executionEnv.${name}`, () => result);
          }
          return result;
        };
        Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
        return wrapped;
      },
    });
  }

  /** 周期内可用性守卫：周期更替/停用中/已停用一律失效（doc 句柄与宿主资源共用）。 */
  private assertContextUsable(state: PluginState, epoch: number, what: string): void {
    this.assertNotDisposed();
    const cur = this.plugins.get(state.definition.id);
    if (
      cur !== state ||
      epoch !== state.epoch ||
      state.phase === 'deactivating' ||
      !(state.phase === 'defining' || state.enabled)
    ) {
      throw new HelmError(
        'plugin_context_expired',
        `插件 ${state.definition.id} 的 ${what} 已失效（插件已停用或进入新启用周期）`,
        409,
      );
    }
  }

  /** 公共 doc 变更事件：value 已 JSON-safe 归一化，脱敏由宿主事件管道统一承担。 */
  private emitDocUpdated(pluginId: string, name: string, value: unknown): void {
    const doc: PublicPluginDoc = { pluginId, name, value: jsonClone(value) };
    this.options.host.emitEvent('plugin.doc.updated', { type: 'plugin.doc.updated', doc });
  }

  /** 插件实际状态转换完成后向宿主发 plugin.changed 事件（转换失败但状态已落位时同样
   * 发布真实状态，绝不伪报成功——见 settlePluginChanged）。
   * payload 携带该插件当前全部 UI 贡献（停用/卸载后为空数组）——前端凭单帧
   * 即可言时增删该插件的 UI，不依赖重连/轮询。 */
  private emitPluginChanged(state: PluginState): void {
    this.options.host.emitEvent('plugin.changed', {
      type: 'plugin.changed',
      plugin: this.summaryOf(state),
      ui: this.uiRegistry.getUiByPlugin(state.definition.id),
    });
  }

  private settlePluginChanged(state: PluginState, stopError: { err: unknown } | undefined): void {
    this.settleLifecycleChanged(state, stopError, undefined);
  }

  /**
   * settlePluginChanged 的完整形态：启停持久化失败（persistError）与 stop 错误
   * 同层聚合。三重失败（stop + 持久化 + 事件发布）时以 stop 诊断为主链，其余
   * JSON-safe 归一后附入 details，绝不静默变成功，也绝不让后发错误掩盖先发诊断。
   */
  private settleLifecycleChanged(
    state: PluginState,
    stopError: { err: unknown } | undefined,
    persistError: { err: unknown } | undefined,
  ): void {
    if (!stopError && !persistError) {
      this.emitPluginChanged(state);
      return;
    }
    let eventError: JsonSafeErrorInfo | undefined;
    try {
      this.emitPluginChanged(state);
    } catch (err) {
      eventError = toJsonSafeError(err);
    }
    const primary = stopError ?? persistError;
    const extras: Record<string, unknown> = {};
    if (stopError && persistError) extras.persistError = toJsonSafeError(persistError.err);
    if (eventError) extras.eventError = eventError;
    if (primary!.err instanceof HelmError) {
      throw new HelmError(primary!.err.code, primary!.err.message, primary!.err.status, {
        ...((primary!.err.details as Record<string, unknown>) ?? {}),
        ...extras,
      });
    }
    if (persistError && !stopError) {
      throw new HelmError(
        'plugin_enabled_persist_failed',
        `插件 ${state.definition.id} 已停用，但启停状态持久化失败：${persistError.err instanceof Error ? persistError.err.message : String(persistError.err)}`,
        500,
        {
          pluginId: state.definition.id,
          persistError: toJsonSafeError(persistError.err),
          ...(extras.eventError ? { eventError: extras.eventError } : {}),
        },
      );
    }
    if (eventError) {
      throw new HelmError(
        'plugin_changed_emit_failed',
        `插件 ${state.definition.id} 已完成实际停用/移除，但服务 stop 与 plugin.changed 事件发布双双失败`,
        500,
        { pluginId: state.definition.id, stopError: toJsonSafeError(stopError!.err), ...extras },
      );
    }
    throw primary!.err;
  }

  /**
   * 持久化启停状态（store 未实现 setEnabled 时为无副作用的内存机制）。
   * 失败显式 reject，由调用方决定回滚（enable）或聚合诊断（disable）。
   */
  private async persistEnabled(state: PluginState, enabled: boolean): Promise<void> {
    const store = this.configStore;
    if (!store?.setEnabled) return;
    try {
      await store.setEnabled(state.definition.id, enabled);
    } catch (err) {
      throw new HelmError(
        'plugin_enabled_persist_failed',
        `插件 ${state.definition.id} 启停状态持久化失败：${err instanceof Error ? err.message : String(err)}`,
        500,
        { pluginId: state.definition.id, enabled, persistError: toJsonSafeError(err) },
      );
    }
  }

  private requirePlugin(pluginId: string): PluginState {
    const state = this.plugins.get(pluginId);
    if (!state) throw new HelmError('unknown_plugin', `未注册的插件：${pluginId}`, 404, { pluginId });
    return state;
  }

  /** 对外可用 = 已启用且不在 definePlugin / 停用过渡态。 */
  private assertActive(state: PluginState): void {
    if (!state.enabled || state.phase !== 'idle') {
      throw new HelmError('plugin_disabled', `插件 ${state.definition.id} 未启用或正在切换启用状态`, 409, {
        pluginId: state.definition.id,
        phase: state.phase,
      });
    }
  }

  private assertNotLocked(state: PluginState): void {
    if (state.definition.locked === true) {
      throw new HelmError('plugin_locked', `插件 ${state.definition.id} 已锁定，禁止停用/卸载`, 403, {
        pluginId: state.definition.id,
      });
    }
  }

  /**
   * 停用/卸载前的在途任务闸门：tracker 任务 + 已启动服务声明的 liveTasks 标签
   * 取并集，有任一即 409 拒绝（不进入 stop、不改持久开关）。liveTasks 异常或
   * 返回非字符串数组时把异常/非法输出如实显式报错，绝不静默当空——插件声明
   * 的保活检查坏了就必须修，不能靠猜放行。
   */
  private assertNoLiveTasks(pluginId: string): void {
    const labels = this.tracker.activeLabels(pluginId);
    const state = this.plugins.get(pluginId);
    if (state) {
      for (const svc of state.services) {
        if (!svc.started || svc.liveTasks === undefined) continue;
        let declared: string[];
        try {
          declared = svc.liveTasks();
        } catch (err) {
          throw new HelmError(
            'plugin_live_tasks_check_failed',
            `插件 ${pluginId} 服务 ${svc.id} 的 liveTasks 检查抛出异常，拒绝停用/卸载`,
            500,
            { pluginId, serviceId: svc.id, error: toJsonSafeError(err) },
          );
        }
        if (
          !Array.isArray(declared) ||
          declared.some((item) => typeof item !== 'string')
        ) {
          throw new HelmError(
            'plugin_live_tasks_check_failed',
            `插件 ${pluginId} 服务 ${svc.id} 的 liveTasks 必须返回字符串数组，实际：${Object.prototype.toString.call(declared)}`,
            500,
            { pluginId, serviceId: svc.id, returned: String(declared) },
          );
        }
        labels.push(...declared);
      }
    }
    if (labels.length > 0) {
      throw new HelmError(
        'plugin_has_live_tasks',
        `插件 ${pluginId} 仍有 ${labels.length} 个在途任务（${labels.join(', ')}），拒绝停用/卸载`,
        409,
        { pluginId, activeTasks: labels },
      );
    }
  }

  private assertDefinition(definition: PluginDefinition): void {
    if (!definition || typeof definition.id !== 'string' || definition.id.length === 0) {
      throw new HelmError('invalid_plugin_definition', '插件定义缺少 id', 400);
    }
    if (!/^[A-Za-z0-9:_-]+$/.test(definition.id)) {
      throw new HelmError('invalid_plugin_definition', `插件 id 仅允许字母数字 : _ -：${definition.id}`, 400);
    }
    if (typeof definition.definePlugin !== 'function') {
      throw new HelmError('invalid_plugin_definition', `插件 ${definition.id} 缺少 definePlugin 函数`, 400);
    }
    if (
      definition.clientRoot !== undefined &&
      (typeof definition.clientRoot !== 'string' ||
        !isCrossPlatformAbsolutePath(definition.clientRoot) ||
        definition.clientRoot.split(/[\\/]/).includes('..'))
    ) {
      throw new HelmError(
        'invalid_plugin_definition',
        `插件 ${definition.id} 的 clientRoot 必须是不含 .. 段的跨平台绝对目录路径（POSIX /、Windows 盘符或 UNC）`,
        400,
        { pluginId: definition.id },
      );
    }
  }

  /**
   * provider 声明边界形状校验（pi-ai Provider 最小契约）：
   * id/name 非空字符串、auth 纯对象且至少声明 apiKey/oauth 之一、
   * getModels/stream/streamSimple 为函数（refreshModels 等可选能力不校验）。
   * 非法形状在此显式拒绝——留到运行期才炸会让「启用成功但模型不可用」
   * 成为静默降级（诚实性纪律）。
   */
  private assertValidProviderShape(pluginId: string, provider: Provider): void {
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

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new HelmError('plugin_host_disposed', 'PluginHost 已 dispose', 409);
    }
  }
}
