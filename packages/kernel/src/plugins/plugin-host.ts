/**
 * PluginHost：helm 唯一强类型插件宿主（definePlugin(ctx)）。
 *
 * 职责边界：
 * - 只做机制（注册/启停/Hook 管道/动作/工具/路由/doc/service/UI 收集），
 *   零业务角色硬编码；
 * - HTTP 挂载与 CLI 映射由 runtime / @helm/node 承担，这里只产出可串行化清单；
 * - docs 持久化经 PluginDocStore（runtime 用 SDK 持久 doc 实现），命名空间 pluginId:name；
 * - config 持久化经 PluginConfigStore；未提供 store 且发生配置修改时显式报
 *   不支持（501），绝不假装持久化（诚实性纪律）。
 */
import {
  HelmError,
  type ActionManifest,
  type HelmHostApi,
  type HelmPluginContext,
  type HookHandler,
  type HookName,
  type HookPayloadMap,
  type HookResult,
  type HookOptions,
  type JsonSchema,
  type PluginActionContext,
  type PluginActionSpec,
  type PluginConfigFieldSchema,
  type PluginDefinition,
  type PluginDocHandle,
  type PluginRouteSpec,
  type PluginServiceSpec,
  type PluginSummary,
  type PluginToolContext,
  type PluginToolSpec,
  type SidebarItemSpec,
  type SidebarSectionSpec,
  type ScreenSpec,
  type TimelineRendererSpec,
  type ToolViewSpec,
  type ComposerPillSpec,
  type ComposerWidgetSpec,
  type WorkbenchPanelSpec,
  type CommandSpec,
  type SettingsPanelSpec,
} from '@helm/protocol';
import { HOOK_ALLOWED_ACTIONS, HookPipeline } from './hooks.js';
import { PluginTaskTracker } from './tracking.js';
import { validatePluginInput, validatePluginOutput } from './schema.js';

// 主代理集成接口 ---------------------------------------------------------------

export interface PluginDocStore {
  get<T>(key: string, initial: T): T;
  set<T>(key: string, value: T): void;
}

export interface PluginConfigStore {
  get(pluginId: string): Record<string, unknown>;
  set(
    pluginId: string,
    value: Record<string, unknown>,
    schema: Record<string, PluginConfigFieldSchema>,
  ): Promise<void> | void;
}

export interface PluginHostOptions {
  dataDir: string;
  host: HelmHostApi;
  docs: PluginDocStore;
  config?: PluginConfigStore;
}

/** UI 扩展点清单条目（listUi 产物；spec 已是可序列化快照）。 */
export interface PluginUiEntry {
  pluginId: string;
  surface: string;
  spec: unknown;
}

/** 派生工具清单条目（listTools 产物；run_action 元工具接入由 runtime 承担）。 */
export interface DerivedToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  sourcePluginId: string;
  sourceKind: 'action' | 'tool';
}

export interface PluginRouteEntry extends PluginRouteSpec {
  pluginId: string;
}

// 内部注册态 -------------------------------------------------------------------

interface ActionEntry {
  pluginId: string;
  id: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  cli?: PluginActionSpec<unknown, unknown>['cli'];
  exposeAsTool: boolean;
  handler: (input: never, context: PluginActionContext) => unknown;
}

interface ToolEntry {
  pluginId: string;
  spec: PluginToolSpec;
}

interface ServiceEntry extends PluginServiceSpec {
  pluginId: string;
  started: boolean;
}

interface PluginState {
  definition: PluginDefinition;
  enabled: boolean;
  hooks: Set<HookName>;
  actions: Map<string, ActionEntry>;
  tools: Map<string, ToolEntry>;
  routes: PluginRouteEntry[];
  services: ServiceEntry[];
  ui: PluginUiEntry[];
  docs: Map<string, PluginDocHandle<unknown>>;
  configSchema: Record<string, PluginConfigFieldSchema> | null;
}

function pluginRoutePrefix(pluginId: string): string {
  return `/api/plugins/${pluginId}`;
}

export class PluginHost {
  private plugins = new Map<string, PluginState>();
  private pipelines = new Map<HookName, HookPipeline<HookName>>();
  private tracker = new PluginTaskTracker();
  private configStore?: PluginConfigStore;
  private disposed = false;
  private registerSeq = 0;

  constructor(private readonly options: PluginHostOptions) {
    this.configStore = options.config;
    for (const name of Object.keys(HOOK_ALLOWED_ACTIONS) as HookName[]) {
      this.pipelines.set(name, new HookPipeline(name));
    }
  }

  // --- 注册与启停 ---------------------------------------------------------

  /** 注册并启用插件；definePlugin 或服务启动失败时回滚全部注册痕迹。 */
  async register(definition: PluginDefinition): Promise<void> {
    this.assertNotDisposed();
    this.assertDefinition(definition);
    if (this.plugins.has(definition.id)) {
      throw new HelmError('plugin_already_registered', `插件 ${definition.id} 已注册`, 409);
    }

    const seq = ++this.registerSeq;
    const state: PluginState = {
      definition,
      enabled: false,
      hooks: new Set(),
      actions: new Map(),
      tools: new Map(),
      routes: [],
      services: [],
      ui: [],
      docs: new Map(),
      configSchema: null,
    };
    this.plugins.set(definition.id, state);

    try {
      await definition.definePlugin(this.createContext(state));
      state.enabled = true;
      await this.startServices(state);
    } catch (err) {
      // rollback：清除本插件一切注册痕迹；rollback 失败不掩盖原始错误，聚合进 details
      let rollbackError: unknown;
      try {
        await this.teardownPlugin(state, { stopServices: state.enabled });
      } catch (rollbackErr) {
        rollbackError = rollbackErr;
      }
      this.plugins.delete(definition.id);
      this.tracker.removePlugin(definition.id);
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
  }

  /** 取消注册（locked 拒绝；有在途任务拒绝）。 */
  async unregister(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    const state = this.requirePlugin(pluginId);
    this.assertNotLocked(state);
    this.assertNoLiveTasks(pluginId);
    await this.teardownPlugin(state, { stopServices: true });
    this.plugins.delete(pluginId);
    this.tracker.removePlugin(pluginId);
  }

  async enable(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    const state = this.requirePlugin(pluginId);
    if (state.enabled) return;
    // 启用语义 = 重新执行 definePlugin 重建全部能力注册
    this.clearRegistrations(state);
    try {
      await state.definition.definePlugin(this.createContext(state));
      state.enabled = true;
      await this.startServices(state);
    } catch (err) {
      let rollbackError: unknown;
      try {
        await this.teardownPlugin(state, { stopServices: true });
      } catch (rollbackErr) {
        rollbackError = rollbackErr;
      }
      state.enabled = false;
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
  }

  async disable(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    const state = this.requirePlugin(pluginId);
    this.assertNotLocked(state);
    if (!state.enabled) return;
    this.assertNoLiveTasks(pluginId);
    await this.teardownPlugin(state, { stopServices: true });
    state.enabled = false;
  }

  private clearRegistrations(state: PluginState): void {
    state.actions.clear();
    state.tools.clear();
    state.routes.length = 0;
    state.services.length = 0;
    state.ui.length = 0;
    for (const pipeline of this.pipelines.values()) pipeline.removeByPlugin(state.definition.id);
    state.hooks.clear();
  }

  /** 清理插件注册：逆向 stop 已启动服务 + 清空全部能力注册表。stop 失败聚合显式抛出。 */
  private async teardownPlugin(state: PluginState, opts: { stopServices: boolean }): Promise<void> {
    const stopErrors: Array<{ serviceId: string; error: unknown }> = [];
    if (opts.stopServices) {
      for (const svc of [...state.services].reverse()) {
        if (!svc.started) continue;
        try {
          await svc.stop();
        } catch (err) {
          // 不中断其余清理，但绝不静默吞掉：聚合后显式抛出
          stopErrors.push({ serviceId: svc.id, error: err });
        } finally {
          svc.started = false;
        }
      }
    }
    this.clearRegistrations(state);
    if (stopErrors.length > 0) {
      throw new HelmError(
        'plugin_service_stop_failed',
        `插件 ${state.definition.id} 清理时服务 stop 失败：${stopErrors.map((e) => e.serviceId).join(', ')}`,
        500,
        { pluginId: state.definition.id, stopErrors },
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
      const stopErrors: Array<{ serviceId: string; error: unknown }> = [];
      for (const svc of started.reverse()) {
        try {
          await svc.stop();
        } catch (stopErr) {
          stopErrors.push({ serviceId: svc.id, error: stopErr });
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

  list(): PluginSummary[] {
    this.assertNotDisposed();
    return [...this.plugins.values()].map((s) => ({
      id: s.definition.id,
      name: s.definition.name ?? s.definition.id,
      version: s.definition.version,
      locked: s.definition.locked === true,
      enabled: s.enabled,
      hooks: s.enabled ? [...s.hooks] : [],
      actions: s.enabled ? [...s.actions.keys()] : [],
      tools: s.enabled ? [...s.tools.keys()] : [],
    }));
  }

  listActions(): ActionManifest[] {
    this.assertNotDisposed();
    const out: ActionManifest[] = [];
    for (const state of this.plugins.values()) {
      if (!state.enabled) continue;
      for (const entry of state.actions.values()) out.push(this.toManifest(entry));
    }
    return out;
  }

  /** 模型工具清单：显式 ctx.tool + exposeAsTool 动作派生（run_action 接入由 runtime 承担）。 */
  listTools(): DerivedToolSpec[] {
    this.assertNotDisposed();
    const out: DerivedToolSpec[] = [];
    for (const state of this.plugins.values()) {
      if (!state.enabled) continue;
      for (const tool of state.tools.values()) {
        out.push({
          name: tool.spec.name,
          description: tool.spec.description,
          inputSchema: tool.spec.inputSchema,
          sourcePluginId: state.definition.id,
          sourceKind: 'tool',
        });
      }
      for (const action of state.actions.values()) {
        if (!action.exposeAsTool) continue;
        out.push({
          name: `${state.definition.id}.${action.id}`,
          description: action.description,
          inputSchema: action.inputSchema,
          sourcePluginId: state.definition.id,
          sourceKind: 'action',
        });
      }
    }
    return out;
  }

  listRoutes(): PluginRouteEntry[] {
    this.assertNotDisposed();
    const out: PluginRouteEntry[] = [];
    for (const state of this.plugins.values()) {
      if (!state.enabled) continue;
      for (const r of state.routes) out.push({ ...r });
    }
    return out;
  }

  listUi(): PluginUiEntry[] {
    this.assertNotDisposed();
    const out: PluginUiEntry[] = [];
    for (const state of this.plugins.values()) {
      if (!state.enabled) continue;
      for (const u of state.ui) out.push({ ...u, spec: structuredClone(u.spec) });
    }
    return out;
  }

  // --- Hook 管道 -----------------------------------------------------------

  /**
   * 执行某挂载点的整条管道。
   * 返回值即调用方（runtime）消费的最终决定：
   * - continue：无插件改写，走内核默认直通行为；
   * - transform：finalPayload 交默认行为消费；
   * - handled / block：短路默认行为。
   */
  async runHook<K extends HookName>(name: K, payload: HookPayloadMap[K]): Promise<HookResult<HookPayloadMap[K]>> {
    this.assertNotDisposed();
    const pipeline = this.pipelines.get(name);
    if (!pipeline) {
      throw new HelmError('unknown_hook', `未知的钩子挂载点：${name}`, 400, { hook: name });
    }
    const participants = pipeline.entries().filter((h) => this.plugins.get(h.pluginId)?.enabled);
    if (participants.length === 0) return { action: 'continue' };

    const label = `hook:${name}`;
    for (const h of participants) this.tracker.begin(h.pluginId, label);
    let outcome: HookResult<HookPayloadMap[K]>;
    try {
      const r = await pipeline.run(payload);
      if (r.shortCircuit) {
        outcome =
          r.shortCircuit.action === 'handled'
            ? { action: 'handled', result: r.shortCircuit.result }
            : { action: 'block', reason: r.shortCircuit.reason };
      } else {
        // 无短路：载荷可能轻 transform 链改写，统一以 transform 交回调用方执行默认直通行为
        outcome = { action: 'transform', value: r.finalPayload } as HookResult<HookPayloadMap[K]>;
      }
    } finally {
      for (const h of participants) this.tracker.end(h.pluginId, label);
    }
    return outcome;
  }

  // --- 动作总线 ------------------------------------------------------------

  /**
   * 解析全限定 actionId（pluginId.actionId）。pluginId 允许含 ':'（builtin:assistant），
   * 因此不能简单 split 最后一个 '.' —— 以第一个 '.' 分割。
   */
  static parseQualifiedActionId(qualified: string): { pluginId: string; actionId: string } {
    const dot = qualified.indexOf('.');
    if (dot <= 0 || dot >= qualified.length - 1) {
      throw new HelmError('invalid_action_id', `非法动作全限定 id：${qualified}（期望 pluginId.actionId）`, 400, {
        qualified,
      });
    }
    return { pluginId: qualified.slice(0, dot), actionId: qualified.slice(dot + 1) };
  }

  async invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    const state = this.requirePlugin(pluginId);
    this.assertEnabled(state);
    const entry = state.actions.get(actionId);
    if (!entry) {
      throw new HelmError('unknown_action', `插件 ${pluginId} 未声明动作 ${actionId}`, 404, { pluginId, actionId });
    }
    validatePluginInput(pluginId, actionId, entry.inputSchema, input);
    const raw = await this.tracker.withTask(pluginId, `action:${pluginId}.${actionId}`, () =>
      Promise.resolve(entry.handler(input as never, context)),
    );
    validatePluginOutput(pluginId, actionId, entry.outputSchema, raw);
    return raw;
  }

  // --- 工具执行 ------------------------------------------------------------

  /** name 可为 ctx.tool 短名或 pluginId.actionId 动作派生名。 */
  async executeTool(name: string, input: unknown, context: PluginToolContext): Promise<unknown> {
    this.assertNotDisposed();
    const found = this.findToolByName(name);
    if (!found) throw new HelmError('unknown_tool', `未注册的工具：${name}`, 404, { name });

    const { state, spec } = found;
    this.assertEnabled(state);
    validatePluginInput(state.definition.id, spec.name, spec.inputSchema, input);
    return this.tracker.withTask(state.definition.id, `tool:${name}`, () =>
      Promise.resolve(spec.execute(input as never, context)),
    );
  }

  private findToolByName(name: string): { state: PluginState; spec: PluginToolSpec } | undefined {
    for (const state of this.plugins.values()) {
      const direct = state.tools.get(name);
      if (direct) return { state, spec: direct.spec };
    }
    // 动作派生工具（pluginId 可含 ':'，取首个 '.' 分割）
    const dot = name.indexOf('.');
    if (dot > 0) {
      const pluginId = name.slice(0, dot);
      const actionId = name.slice(dot + 1);
      const state = this.plugins.get(pluginId);
      const action = state?.actions.get(actionId);
      if (state && action) {
        return {
          state,
          spec: {
            name,
            description: action.description,
            inputSchema: action.inputSchema,
            execute: (input: unknown, ctx: PluginToolContext) =>
              this.invokeAction(pluginId, actionId, input, {
                conversationId: ctx.conversationId,
                signal: ctx.signal,
              }),
          },
        };
      }
    }
    return undefined;
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
    return state.configSchema ?? {};
  }

  async setConfig(pluginId: string, value: Record<string, unknown>): Promise<void> {
    this.assertNotDisposed();
    const state = this.requirePlugin(pluginId);
    const schema = state.configSchema ?? {};
    if (!this.configStore) {
      // 诚实性：未提供持久化 store 时显式不支持，绝不假装写入成功
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
    // 逆向停用全部插件（最近注册先停）；单个清理失败不阻止其余，聚合显式抛出
    const errors: Array<{ pluginId: string; error: unknown }> = [];
    for (const state of [...this.plugins.values()].reverse()) {
      try {
        await this.teardownPlugin(state, { stopServices: true });
        state.enabled = false;
      } catch (err) {
        errors.push({ pluginId: state.definition.id, error: err });
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

  // --- 在途任务跟踪（runtime / 编排宿主使用） ---------------------------------

  /** 挂起 agent_spawn 跟踪：钩子 handled 等待外部 Agent 完成期间登记在途。 */
  beginSpawnTask(pluginId: string, spawnId: string): void {
    this.tracker.begin(pluginId, `spawn:${spawnId}`);
  }

  endSpawnTask(pluginId: string, spawnId: string): void {
    this.tracker.end(pluginId, `spawn:${spawnId}`);
  }

  /** 通用受跟踪自定义任务包装（暴露给 runtime / 测试）。 */
  withTask<T>(pluginId: string, label: string, fn: () => Promise<T>): Promise<T> {
    return this.tracker.withTask(pluginId, label, fn);
  }

  activeTaskCount(pluginId: string): number {
    this.assertNotDisposed();
    return this.tracker.activeCount(pluginId);
  }

  // --- 内部：definePlugin 上下文构造 -----------------------------------------

  private createContext(state: PluginState): HelmPluginContext {
    const pluginId = state.definition.id;
    const self = this;

    const addHook = <N extends HookName>(name: N, fn: HookHandler<N>, opts?: HookOptions) => {
      self.assertNotDisposed();
      if (state.enabled) {
        throw new HelmError(
          'plugin_context_closed',
          `插件 ${pluginId} 已启用，不允许在 definePlugin 之外追加 ${name} 钩子`,
          409,
        );
      }
      (self.pipelines.get(name) as unknown as HookPipeline<N>).add(pluginId, fn, opts?.priority ?? 0);
      state.hooks.add(name);
    };

    const addUi = (surface: string, spec: unknown, fnName: string) => {
      const id = (spec as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 声明缺少 id`, 400);
      }
      if (state.ui.some((u) => u.surface === surface && (u.spec as { id?: string }).id === id)) {
        throw new HelmError('duplicate_ui', `插件 ${pluginId} 在 ${surface} 重复声明 id ${id}`, 409);
      }
      // 声明式轨道只接受可序列化 spec；client.tsx 轨道由 web 编译器负责（本模块不编译）
      try {
        structuredClone(spec);
      } catch {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 声明的 spec 必须可 JSON 序列化（client.tsx 引用请用 client 字段）`,
          400,
        );
      }
      state.ui.push({ pluginId, surface, spec: structuredClone(spec) });
    };

    const ctx: HelmPluginContext = {
      pluginId,
      dataDir: this.options.dataDir,
      getConfig: () => (self.configStore ? self.configStore.get(pluginId) : {}) as never,
      configSchema: (schema) => {
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
        onWatchdogTick: (fn, o) => addHook('watchdog_tick', fn, o),
      },

      action: <TIn, TOut>(spec: PluginActionSpec<TIn, TOut>) => {
        self.assertValidId('动作', spec.id);
        if (typeof spec.description !== 'string' || spec.description.length === 0) {
          throw new HelmError('invalid_action_spec', `插件 ${pluginId} 动作 ${spec.id} 缺少 description`, 400);
        }
        if (!isJsonObject(spec.inputSchema) || !isJsonObject(spec.outputSchema)) {
          throw new HelmError(
            'invalid_action_spec',
            `插件 ${pluginId} 动作 ${spec.id} 必须同时声明 inputSchema 与 outputSchema（单点 Schema 契约）`,
            400,
          );
        }
        if (typeof spec.handler !== 'function') {
          throw new HelmError('invalid_action_spec', `插件 ${pluginId} 动作 ${spec.id} 缺少 handler`, 400);
        }
        if (
          spec.cli?.command !== undefined &&
          (!Array.isArray(spec.cli.command) ||
            spec.cli.command.length === 0 ||
            !spec.cli.command.every((seg) => typeof seg === 'string' && seg.length > 0))
        ) {
          throw new HelmError(
            'invalid_action_spec',
            `插件 ${pluginId} 动作 ${spec.id} 的 cli.command 必须是非空字符串数组（语义化顶层命令路径）`,
            400,
          );
        }
        if (state.actions.has(spec.id)) {
          throw new HelmError('duplicate_action', `插件 ${pluginId} 重复声明动作 ${spec.id}`, 409);
        }
        state.actions.set(spec.id, {
          pluginId,
          id: spec.id,
          description: spec.description,
          inputSchema: spec.inputSchema,
          outputSchema: spec.outputSchema,
          cli: spec.cli,
          exposeAsTool: spec.exposeAsTool === true,
          handler: spec.handler as (input: never, context: PluginActionContext) => unknown,
        });
      },

      tool: <TIn>(spec: PluginToolSpec<TIn>) => {
        self.assertValidId('工具', spec.name);
        if (typeof spec.description !== 'string' || spec.description.length === 0) {
          throw new HelmError('invalid_tool_spec', `插件 ${pluginId} 工具 ${spec.name} 缺少 description`, 400);
        }
        if (!isJsonObject(spec.inputSchema)) {
          throw new HelmError('invalid_tool_spec', `插件 ${pluginId} 工具 ${spec.name} 缺少 inputSchema`, 400);
        }
        if (typeof spec.execute !== 'function') {
          throw new HelmError('invalid_tool_spec', `插件 ${pluginId} 工具 ${spec.name} 缺少 execute`, 400);
        }
        if (state.tools.has(spec.name)) {
          throw new HelmError('duplicate_tool', `插件 ${pluginId} 重复声明工具 ${spec.name}`, 409);
        }
        state.tools.set(spec.name, { pluginId, spec: spec as PluginToolSpec });
      },

      route: (spec: PluginRouteSpec) => {
        if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) {
          throw new HelmError(
            'invalid_route_path',
            `插件 ${pluginId} 路由 path 必须以 / 开头：${String(spec.path)}`,
            400,
          );
        }
        // 限定插件专属前缀之下，禁止挂到内核或其他插件命名空间
        const prefix = pluginRoutePrefix(pluginId);
        if (spec.path !== prefix && !spec.path.startsWith(prefix + '/')) {
          throw new HelmError(
            'route_prefix_violation',
            `插件 ${pluginId} 路由 ${spec.method} ${spec.path} 超出插件专属前缀 ${prefix}`,
            403,
          );
        }
        if (typeof spec.handler !== 'function') {
          throw new HelmError('invalid_route_handler', `插件 ${pluginId} 路由 ${spec.path} 缺少 handler`, 400);
        }
        state.routes.push({ ...spec, pluginId });
      },

      doc: <TState>(name: string, initial: TState): PluginDocHandle<TState> => {
        self.assertValidId('doc', name);
        if (state.docs.has(name)) {
          throw new HelmError('duplicate_doc', `插件 ${pluginId} 重复声明 doc ${name}`, 409);
        }
        const key = `${pluginId}:${name}`;
        const store = self.options.docs;
        const handle: PluginDocHandle<TState> = {
          // get 返回 clone：防止未 set 的原地突变污染持久层
          get: () => structuredClone(store.get<TState>(key, initial)),
          set: (next) => store.set(key, structuredClone(next)),
          update: (fn) => {
            const current = store.get<TState>(key, initial);
            store.set(key, structuredClone(fn(structuredClone(current))));
          },
        };
        state.docs.set(name, handle as PluginDocHandle<unknown>);
        return handle;
      },

      service: (spec: PluginServiceSpec) => {
        self.assertValidId('服务', spec.id);
        if (state.services.some((s) => s.id === spec.id)) {
          throw new HelmError('duplicate_service', `插件 ${pluginId} 重复声明服务 ${spec.id}`, 409);
        }
        state.services.push({ ...spec, pluginId, started: false });
      },

      ui: {
        sidebarItem: (spec: SidebarItemSpec) => addUi('sidebar.item', spec, 'sidebarItem'),
        sidebarSection: (spec: SidebarSectionSpec) => addUi('sidebar.section', spec, 'sidebarSection'),
        screen: (spec: ScreenSpec) => addUi('screen', spec, 'screen'),
        timelineRenderer: (spec: TimelineRendererSpec) => addUi('timeline.renderer', spec, 'timelineRenderer'),
        toolView: (spec: ToolViewSpec) => addUi('tool.view', spec, 'toolView'),
        composerPill: (spec: ComposerPillSpec) => addUi('composer.pill', spec, 'composerPill'),
        composerWidget: (spec: ComposerWidgetSpec) => addUi('composer.widget', spec, 'composerWidget'),
        workbenchPanel: (spec: WorkbenchPanelSpec) => addUi('workbench.panel', spec, 'workbenchPanel'),
        command: (spec: CommandSpec) => addUi('commandPalette', spec, 'command'),
        settingsPanel: (spec: SettingsPanelSpec) => addUi('settings.panel', spec, 'settingsPanel'),
      },

      host: this.options.host,
    };

    return ctx;
  }

  private toManifest(entry: ActionEntry): ActionManifest {
    const manifest: ActionManifest = {
      pluginId: entry.pluginId,
      id: entry.id,
      description: entry.description,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      exposeAsTool: entry.exposeAsTool,
    };
    if (entry.cli) manifest.cli = entry.cli;
    return manifest;
  }

  private requirePlugin(pluginId: string): PluginState {
    const state = this.plugins.get(pluginId);
    if (!state) throw new HelmError('unknown_plugin', `未注册的插件：${pluginId}`, 404, { pluginId });
    return state;
  }

  private assertEnabled(state: PluginState): void {
    if (!state.enabled) {
      throw new HelmError('plugin_disabled', `插件 ${state.definition.id} 未启用`, 409, {
        pluginId: state.definition.id,
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

  private assertNoLiveTasks(pluginId: string): void {
    const n = this.tracker.activeCount(pluginId);
    if (n > 0) {
      throw new HelmError(
        'plugin_has_live_tasks',
        `插件 ${pluginId} 仍有 ${n} 个在途任务（${this.tracker.activeLabels(pluginId).join(', ')}），拒绝停用/卸载`,
        409,
        { pluginId, activeTasks: this.tracker.activeLabels(pluginId) },
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
  }

  private assertValidId(kind: string, id: string): void {
    // 允许 '.'：动作可声明语义化 id（如 'cron.create'），全限定解析以首个 '.' 分割
    if (typeof id !== 'string' || id.length === 0 || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new HelmError('invalid_identifier', `插件声明 ${kind} id 非法：${String(id)}`, 400);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new HelmError('plugin_host_disposed', 'PluginHost 已 dispose', 409);
    }
  }
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
