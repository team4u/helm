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
 *
 * 并发模型：
 * - 同插件的 register/enable/disable/unregister 经 per-plugin 队列串行执行；
 * - 停用先把 phase 置为 deactivating 再进入 await，期间新 invokeAction /
 *   executeTool / runHook 一律拒绝，绝不让任务进入正在拆毁的注册表；
 * - 每个启用周期递增 epoch：旧 definePlugin 上下文（含 doc 句柄与宿主
 *   生命周期资源）在新周期或停用后立即失效，防止异步残留注册污染新周期。
 * - runHook 只执行快照时刻「已启用且空闲」的处理器；未启用/正停用插件的
 *   handler 绝不执行。
 *
 * 会话作用域（ConversationScope）：
 * - 工具/动作可声明 scope（conversationIds/tags/profileIds，字段间 AND、
 *   字段内 OR）；注册边界校验为纯对象，防止非法 scope 让 .includes 误判
 *   或静默变成「不受限」；
 * - listTools(conversation) 按会话筛可见性，executeTool / invokeAction 在
 *   执行时经 host.getConversation 二次校验（防绕过）；无 conversationId 的
 *   人工 HTTP/CLI 调用不受限（scope 是会话策略而非用户鉴权）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  HelmError,
  matchesConversationScope,
  type ActionManifest,
  type ConversationScope,
  type ConversationSummary,
  type HelmHostApi,
  type HelmPluginContext,
  type HookHandler,
  type HookName,
  type HookPayloadMap,
  type HookResult,
  type HookOptions,
  type JsonSchema,
  type MaybePromise,
  type PluginActionContext,
  type PluginActionSpec,
  type PluginConfigFieldSchema,
  type PluginDefinition,
  type PluginDocHandle,
  type PluginDocOptions,
  type PluginSessionDocHandle,
  type PublicPluginDoc,
  type PluginRouteSpec,
  type PluginServiceSpec,
  type PluginSummary,
  type PluginToolContext,
  type PluginToolSpec,
  type PluginUiContribution,
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
  type ConversationActionSpec,
  type PluginSlotContributionSpec,
  type ProfileRuntimeUiSpec,
  type TimelineEntryActionSpec,
} from '@helm/protocol';
import type { Provider } from '@earendil-works/pi-ai';
import { HOOK_ALLOWED_ACTIONS, HookPipeline } from './hooks.js';
import { PluginTaskTracker } from './tracking.js';
import { assertSchemaCompilable, validatePluginInput, validatePluginOutput } from './schema.js';
import { assertModuleRefShape, compilePluginClientModule, type ClientCompileResult } from './client-compiler.js';
import { redactJsonValue } from '../redact.js';

// 主代理集成接口 ---------------------------------------------------------------

export interface PluginDocStore {
  get<T>(key: string, initial: T): T;
  set<T>(key: string, value: T): void;
  /** 等待全部排队写真正落盘（同步镜像 ≠ 持久化完成；失败显式 reject）。 */
  flush(): Promise<void>;
}

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
  config?: PluginConfigStore;
  /**
   * 可选的插件 Provider 挂载端口（runtime 提供）：插件经 ctx.provider 声明的
   * 自带模型 Provider（如 Magpie）在启用时挂载、停用/卸载时卸载。
   * - register：挂载并返回卸载函数（owner=pluginId 由宿主注入，插件不可伪造）；
   *   卸载函数可能因活跃流/refresh 在途而拒绝（reject），宿主尊重拒绝并不拆半残留。
   * - assertIdle：停用/卸载前预检（与 assertNoLiveTasks 同层调用），在服务 stop
   *   之前拒绝，防止「先 stop 服务再卸载失败」的半残留状态。
   * 未提供本端口且插件声明了 provider 时，启用阶段显式 501（禁静默）；
   * 默认停用探测（enabled:false）只收集声明不受影响。
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
   * 先全局执行全部 prepare 再逐插件 start（防止服务 init 提交输入唤醒
   * SDK 调度器时其他插件/工具尚未注册）。默认 false：register 即时
   * prepare+start（宿主模式，单插件测试语义不变）。
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
 *
 * manageConversation 带 pluginId 第二参数——插件侧 ctx.host 只暴露单参形态，
 * 由 PluginHost 包装注入本插件身份，插件无法伪造他人 pluginId。
 * 其余端口即 HelmHostApi 契约本身（必选，宿主必须完整实现）。
 */
export type PluginHostBackend = Omit<HelmHostApi, 'manageConversation'> & {
  /** 声明 pluginId 对会话的管理权；返回释放函数（受管期间删除保护）。 */
  manageConversation(id: number, pluginId: string): () => void;
};

/**
 * 派生工具清单条目（listTools 产物）。
 * - ctx.tool 直投工具：name 即注册名（provider-safe）；
 * - exposeAsTool 动作：name 为 provider-safe 别名（OpenAI 函数名不允许
 *   ':'/'.'），qualifiedId 保留全限定 ID 供 run_action / 展示，executeTool
 *   两者皆可解析。run_action 元工具接入由 runtime 承担。
 */
export interface DerivedToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** 结构化输出 Schema（ctx.tool 声明时透传；run_action 派生工具无此字段）。 */
  structuredOutputSchema?: JsonSchema;
  sourcePluginId: string;
  sourceKind: 'action' | 'tool';
  /** 仅 sourceKind === 'action'：pluginId.actionId 全限定 ID。 */
  qualifiedId?: string;
}

export interface PluginRouteEntry extends PluginRouteSpec {
  pluginId: string;
}

/** 模型工具名的 provider 安全约束（OpenAI 函数名子集，全 provider 通用）。 */
export const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 为 exposeAsTool 动作生成稳定 provider-safe 别名：语义前缀 + 全限定 ID 短哈希。
 * 纯函数、跨重启确定：pi-ai convertTools 原样发送 tool.name，含 ':'/'.' 的
 * 全限定 ID 不被任何 provider 接受，且朴素清洗（替换非法字符）会碰撞，故附哈希。
 */
export function actionToolAlias(pluginId: string, actionId: string): string {
  const semantic = `${pluginId.replace(/^builtin:/, '')}.${actionId}`
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  const hash = createHash('sha1').update(`${pluginId}.${actionId}`).digest('hex').slice(0, 8);
  return `${semantic}_${hash}`;
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
  idempotent?: boolean;
  toolAlias: string;
  scope?: ConversationScope;
  handler: (input: never, context: PluginActionContext) => unknown;
}

interface ToolEntry {
  pluginId: string;
  spec: PluginToolSpec;
}

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

/** doc 注册项：句柄 + 可见性 + 归一化初值（公共快照未写过时也能读）。 */
interface DocRegistration {
  handle: PluginDocHandle<unknown>;
  isPublic: boolean;
  initial: unknown;
}

/**
 * 插件生命周期相位：
 * - defining：definePlugin 执行中（注册方法仅此相位可用）；
 * - deactivating：停用中（先于任何 await 设置，隔离新任务与旧 doc 写入）；
 * - idle：稳定态（enabled 决定是否对外可用）。
 */
type PluginPhase = 'idle' | 'defining' | 'deactivating';

interface PluginState {
  definition: PluginDefinition;
  enabled: boolean;
  phase: PluginPhase;
  /** 启用周期号：每次 enable 开始与 disable 完成时递增，使旧上下文/句柄失效。 */
  epoch: number;
  dataDir: string;
  hooks: Set<HookName>;
  actions: Map<string, ActionEntry>;
  tools: Map<string, ToolEntry>;
  routes: PluginRouteEntry[];
  services: ServiceEntry[];
  /** 本周期 ctx.provider 声明的模型 Provider（启用时挂载、停用/卸载时逆序卸载）。 */
  providers: ProviderEntry[];
  ui: PluginUiContribution[];
  docs: Map<string, DocRegistration>;
  configSchema: Record<string, PluginConfigFieldSchema> | null;
  /**
   * 本启用周期经 ctx.host 获取的宿主生命周期资源释放句柄
   * （manageConversation 管理权 / onEvent 监听 / askSeq 解析器）。
   * 停用/回滚/dispose 时统一释放；句柄幂等，插件提前释放也安全。
   */
  hostReleases: Set<() => void>;
  /**
   * 受控停止 doc 写入窗口：宿主正在 await 本插件服务 stop 链期间为 true。
   * 此窗口内本周期（epoch 一致）的 ctx.doc 句柄被允许完成最终持久化——
   * stop 时 phase 已是 deactivating，常规 guard 会拒绝一切写入，引擎/服务的
   * 终态落盘会被悄悄丢弃（诚实性违规）。窗口只覆盖 stop 本身：stop 返回
   * （成功/失败/回滚）即复位；epoch 更替（reenable）后旧句柄仍拒绝。
   * 窗口允许本周期已有异步回调完成写入，不区分其 Promise 创建位置；服务
   * 必须在 stop 返回前取消或等待这些回调。它不是插件内异步任务的隔离边界。
   */
  stopDocWrites: boolean;
}

/**
 * JSON-safe 深拷贝：复用 redact.ts 的结构检查（拒循环/undefined/非纯对象/
 * NaN/稀疏数组），identity 直通。边界显式拒绝，绝不留给 JSON.stringify 悄悄丢数据。
 */
function jsonClone<T>(value: T): T {
  return redactJsonValue(value, (s) => s) as T;
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 严格纯对象判定（原型须为 Object.prototype 或 null）：Map/类实例一律拒绝。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!isJsonObject(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * 注册边界校验 ConversationScope：只允许纯对象，字段只允许
 * conversationIds / tags / profileIds；数组元素为正整数会话 ID 或非空字符串。
 * 非法 scope（Map、未知字段、元素类型不符等）在此显式拒绝——否则
 * matchesConversationScope 会把读不到的字段当「不限」，静默变成全放行。
 */
function assertConversationScope(pluginId: string, what: string, scope: unknown): void {
  if (scope === undefined) return;
  if (!isPlainObject(scope)) {
    throw new HelmError('invalid_plugin_scope', `${what} 的 scope 必须是纯对象（拒绝 null/数组/Map 等）`, 400, {
      pluginId,
    });
  }
  for (const key of Object.keys(scope)) {
    if (key !== 'conversationIds' && key !== 'tags' && key !== 'profileIds' && key !== 'modelProviders') {
      throw new HelmError('invalid_plugin_scope', `${what} 的 scope 仅允许 conversationIds/tags/profileIds/modelProviders，收到未知字段 ${key}`, 400, {
        pluginId,
        field: key,
      });
    }
  }
  const checkList = (key: string, kind: 'id' | 'text'): void => {
    const value = scope[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      throw new HelmError('invalid_plugin_scope', `${what} 的 scope.${key} 必须是数组`, 400, {
        pluginId,
        field: key,
      });
    }
    for (const item of value) {
      if (kind === 'id') {
        if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) {
          throw new HelmError('invalid_plugin_scope', `${what} 的 scope.${key} 元素必须是正整数会话 ID`, 400, {
            pluginId,
            field: key,
            item,
          });
        }
      } else if (typeof item !== 'string' || item.length === 0) {
        throw new HelmError('invalid_plugin_scope', `${what} 的 scope.${key} 元素必须是非空字符串`, 400, {
          pluginId,
          field: key,
          item,
        });
      }
    }
  };
  checkList('conversationIds', 'id');
  checkList('tags', 'text');
  checkList('profileIds', 'text');
  checkList('modelProviders', 'text');
}

/** 幂等化一个释放句柄：重复调用只生效一次（插件提前释放 + 停用清理双保险）。 */
function idempotentRelease(release: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}

/**
 * 错误诊断的 JSON-safe 归一形态：出站错误信封（HTTP errorToResponse →
 * redactJsonValue）严格拒绝 Error/类实例，原始异常必须在产生处规范化，
 * 不允许留到序列化边界才炸（那会让 stop 失败根本无法返回错误信封）。
 * 保留 name/message 与 HelmError code/status（不吞诊断）；stack 含绝对路径
 * 与内部帧，一律丢弃（与 errorToResponse 对非 HelmError 不回堆栈的边界一致）。
 */
interface JsonSafeErrorInfo {
  name: string;
  message: string;
  code?: string;
  status?: number;
}

function toJsonSafeError(err: unknown): JsonSafeErrorInfo {
  if (err instanceof HelmError) {
    return { name: err.name, message: err.message, code: err.code, status: err.status };
  }
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { name: 'NonError', message: String(err) };
}

export class PluginHost {
  private plugins = new Map<string, PluginState>();
  private pipelines = new Map<HookName, HookPipeline<HookName>>();
  private tracker = new PluginTaskTracker();
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
    for (const name of Object.keys(HOOK_ALLOWED_ACTIONS) as HookName[]) {
      this.pipelines.set(name, new HookPipeline(name));
    }
  }

  // --- 注册与启停 ---------------------------------------------------------

  /**
   * 注册插件；options.enabled 缺省 true（保持既有单参调用语义）。
   * 实际初始状态优先级：locked 插件恒启用 > 持久启停状态（configStore.getEnabled）
   * > options.enabled。即：一旦持久化过启停，重启后以持久化为准，声明缺省不再
   * 重新生效；从未持久化时按调用方声明（如 builtin:herdr 声明 enabled:false）。
   *
   * 以停用态注册时：仍完整执行 definePlugin（获得 configSchema 供先配置后启用），
   * 但绝不启动服务，随即释放全部运行期资源并清空 hook/action/UI/doc/service
   * 注册（configSchema 保留）；manifest enabled:false 且无 UI 贡献。
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
      // 队列等待期间可能被并发注册占位
      if (this.plugins.has(definition.id)) {
        throw new HelmError('plugin_already_registered', `插件 ${definition.id} 已注册`, 409);
      }
      this.assertNotDisposed();
      const seq = ++this.registerSeq;
      // 启停解析先于一切资源获取（数据目录/definePlugin/宿主资源）：持久层
      // 读取失败或返回非法值时零残留拒绝，绝不让半注册状态泄漏给后续回滚。
      const wantsEnabled = this.resolveInitialEnabled(definition, options);
      const dataDir = join(this.options.dataDir, 'plugins', definition.id);
      const state: PluginState = {
        definition,
        enabled: false,
        phase: 'defining',
        epoch: 1,
        dataDir,
        hooks: new Set(),
        actions: new Map(),
        tools: new Map(),
        routes: [],
        services: [],
        providers: [],
        ui: [],
        docs: new Map(),
        configSchema: null,
        hostReleases: new Set(),
        stopDocWrites: false,
      };
      this.plugins.set(definition.id, state);

      try {
        // 插件专属数据目录（~/.helm/plugins/<id>/），按 protocol 注释创建
        mkdirSync(dataDir, { recursive: true });
        await definition.definePlugin(this.createContext(state, state.epoch));
        this.assertUiDocsRegistered(state);
      } catch (err) {
        // rollback：清除本插件一切注册痕迹（含宿主生命周期资源释放）；rollback
        // 失败不掩盖原始错误，聚合进 details（双方均已 JSON-safe 归一）
        let rollbackError: JsonSafeErrorInfo | undefined;
        try {
          await this.teardownPlugin(state, { stopServices: false });
        } catch (rollbackErr) {
          rollbackError = toJsonSafeError(rollbackErr);
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

      if (wantsEnabled) {
        state.enabled = true;
        try {
          // provider 先于服务挂载：服务 start 可依赖本插件 provider 已可用；
          // 半途失败时已挂载 provider 在 catch 回滚中统一卸载（禁 enabled:false 泄漏）。
          // deferServices：只挂载 provider 并登记服务（含 prepare 能力），不 start；
          // 由显式 PluginHost.start() 统一执行全局 prepare 屏障 + 逐插件 start。
          await this.registerProviders(state);
          await this.activateServices(state);
        } catch (err) {
          // 启动失败：回滚到停用形态（已挂载 provider 与已启动服务均由
          // teardownPlugin 逆向清理），注册痕迹移除，原始错误包
          // plugin_registration_failed 后如实上抛（provider 卸载 / stop 失败均聚合）
          let rollbackError: JsonSafeErrorInfo | undefined;
          try {
            await this.teardownPlugin(state, { stopServices: true });
          } catch (rollbackErr) {
            rollbackError = toJsonSafeError(rollbackErr);
          }
          state.enabled = false;
          this.plugins.delete(definition.id);
          this.tracker.removePlugin(definition.id);
          const base = err instanceof HelmError ? err : new HelmError(
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
        // 停用态注册：声明已运行完毕（configSchema 已获得），释放全部运行期
        // 资源与注册（configSchema 保留），绝不启动服务。epoch 递增废黜本次
        // definePlugin 产生的所有句柄（doc/宿主生命周期资源），与 disable 落位后
        // 的注册表形态完全一致。释放失败属注册失败（痕迹不完整必须回滚移除）。
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
          const wrapped = err instanceof HelmError ? err : new HelmError(
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

  /**
   * 初始启停状态解析：locked 恒启用 > 持久启停（getEnabled）> 调用方声明。
   * register 不写默认值：从未持久化过的插件不产生 config.json 副作用。
   * 持久层抛错原样上抛（注册零残留）；返回非布尔值属持久层违约，显式
   * 拒绝（'false' 字符串是 truthy，绝不能被当成停用/启用语义揣测）。
   */
  private resolveInitialEnabled(
    definition: PluginDefinition,
    options: { enabled?: boolean },
  ): boolean {
    if (definition.locked === true) return true;
    let persisted: boolean | undefined;
    try {
      persisted = this.configStore?.getEnabled?.(definition.id);
    } catch (err) {
      // 原错误保留：HelmError 原样，非 HelmError 包装为注册失败但保留 message
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
        // 已停用插件的卸载同样是真实注册表移除：照发一次 ui:[] 事件，
        // 客户端凭它清掉残留条目，不依赖重连 snapshot
        this.emitPluginChanged(state);
        return;
      }
      this.assertNoLiveTasks(pluginId);
      // provider 在途流/刷新预检：在服务 stop 与 provider 卸载之前拒绝，防止
      // 「先 stop 服务再卸载失败」的半残留（与 assertNoLiveTasks 同层门控）
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
      // 状态已一致（插件已移除）；无论 stop 成败都发布实际移除事件，再如实上抛
      this.settlePluginChanged(state, stopError);
    });
  }

  async enable(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      const state = this.requirePlugin(pluginId);
      if (state.enabled) return;
      // 新启用周期：epoch 先行递增使一切旧上下文/doc 句柄/宿主句柄即刻失效，
      // 再清空注册，保证重建周期从零开始；configSchema 显式清空（definePlugin
      // 将重新声明），失败回滚时还原停用前保留的 schema（保住「先配置再启用」）。
      // 持久 store 数据不受影响（clearRegistrations 只动注册句柄）。
      const prevConfigSchema = state.configSchema;
      state.epoch += 1;
      this.clearRegistrations(state);
      state.configSchema = null;
      state.phase = 'defining';
      try {
        await state.definition.definePlugin(this.createContext(state, state.epoch));
        this.assertUiDocsRegistered(state);
        // provider 先于服务挂载（服务 start 可依赖自身 provider）；失败时回滚
        // 卸载已挂载 provider 并 stop 已启动服务，绝不留下 enabled:false 但 provider 泄漏。
        // 热启用（host.start 已完成后）：正常 prepare+start；未完成（首启注册期）：
        // 只登记，待全局屏障。
        await this.registerProviders(state);
        await this.activateServices(state);
        // 对外提交点在启停持久化成功之后：服务已启动但落盘挂起期间保持
        // defining 且 enabled=false——action 拒绝 / hook 不执行 / UI 不露出，
        // 绝不给在途任务进入「即将被回滚拆掉」的注册表的机会；持久化失败时
        // 零在途任务。enabled 只在提交点置 true。
        await this.persistEnabled(state, true);
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
      // provider 在途流/刷新预检：在服务 stop 与 provider 卸载之前拒绝，防止
      // 「先 stop 服务再卸载失败」的半残留（与 assertNoLiveTasks 同层门控）
      this.assertProvidersIdle(pluginId);
      // 先置 deactivating 再进入 await：新 invokeAction/executeTool/runHook
      // 与旧 doc 写入在 stop 期间即被隔离
      state.phase = 'deactivating';
      let stopError: { err: unknown } | undefined;
      try {
        await this.teardownPlugin(state, { stopServices: true });
      } catch (err) {
        stopError = { err };
      }
      // stop 失败也不允许维持「enabled=true 但注册已清空」的虚假状态：
      // 统一落位为已停用（epoch 递增废黜旧句柄），错误如实上抛
      state.enabled = false;
      state.epoch += 1;
      state.phase = 'idle';
      // 已实际停用即发布真实状态事件（enabled:false / ui:[]），与 stop 成败无关；
      // 持久化停用状态即使 stop 失败也尝试写入（实际已停用是事实），任何持久化
      // 失败与 stop 错误一并聚合显式上抛（settleLifecycleChanged）
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
    state.actions.clear();
    state.tools.clear();
    state.routes.length = 0;
    state.services.length = 0;
    state.providers.length = 0;
    state.ui.length = 0;
    state.docs.clear();
    state.hostReleases.clear();
    for (const pipeline of this.pipelines.values()) pipeline.removeByPlugin(state.definition.id);
    state.hooks.clear();
  }

  /**
   * 在受控停止 doc 写入窗口内执行服务 stop：stop 期间（含引擎 close 内部
   * 由 abort 唤醒的异步 settle 链）本插件本周期 ctx.doc 句柄的最终持久化写入
   * 被放行（phase 为 deactivating 时不再拒绝）；stop 返回（成功/失败）即
   * 复位窗口，之后一切写入恢复常规拒绝。窗口按 PluginState 标记而非异步上下
   * 文传播：引擎 settle 链的 promise 在 stop 之前创建，AsyncLocalStorage 无法
   * 覆盖它们，但句柄本身是插件私有、epoch 一致性已由句柄闭包保证。
   */
  private async runControlledStop(state: PluginState, stop: () => MaybePromise<void>): Promise<void> {
    state.stopDocWrites = true;
    try {
      await stop();
    } finally {
      state.stopDocWrites = false;
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
          // 不中断其余清理，但绝不静默吞掉：聚合后显式抛出（JSON-safe 形态）
          stopErrors.push({ serviceId: svc.id, error: toJsonSafeError(err) });
        } finally {
          svc.started = false;
        }
      }
    }
    // 服务 stop 之后再卸载 provider（插件服务可在生命周期内依赖自身 provider）；
    // 已挂载句柄逆序卸载，未挂载（声明态/已卸载）跳过，绝不重复卸载。
    let providerErrors: Array<{ providerId: string; error: JsonSafeErrorInfo }> = [];
    try {
      await this.unregisterProviders(state);
    } catch (err) {
      providerErrors =
        err instanceof HelmError && Array.isArray((err.details as { unregisterErrors?: unknown } | undefined)?.unregisterErrors)
          ? ((err.details as { unregisterErrors: Array<{ providerId: string; error: JsonSafeErrorInfo }> }).unregisterErrors)
          : [{ providerId: '<unknown>', error: toJsonSafeError(err) }];
    }
    // 释放本周期获取的宿主生命周期资源（会话管理保护/工作流监听/ask 解析器）。
    // 句柄已幂等化：插件提前释放过的再调一次是空操作。
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
      // 预检拒绝属生命周期门控：保留端口原始诊断（如活跃流/refresh 列表）
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
   * definePlugin 完成后的末尾统一校验：UI 声明（含 badge.doc）引用的 docs
   * 必须是本插件已注册的 public doc（doc 声明可晚于 UI 声明，故在定义期末校验；
   * 非法引用会让 $docs 挂载/角标静默失效，必须显式拒绝）。
   */
  private assertUiDocsRegistered(state: PluginState): void {
    const pluginId = state.definition.id;
    const required = new Map<string, Array<{ surface: string; id: string }>>();
    const collect = (doc: string, from: { surface: string; id: string }): void => {
      const list = required.get(doc) ?? [];
      list.push(from);
      required.set(doc, list);
    };
    for (const u of state.ui) {
      const spec = u.spec as { docs?: unknown; badge?: { doc?: unknown } };
      const docs = spec.docs;
      if (Array.isArray(docs)) {
        for (const name of docs) {
          if (typeof name === 'string') collect(name, { surface: u.surface, id: String((spec as { id?: unknown }).id) });
        }
      }
      const badgeDoc = spec.badge?.doc;
      if (typeof badgeDoc === 'string') {
        collect(badgeDoc, { surface: u.surface, id: String((spec as { id?: unknown }).id) });
      }
    }
    for (const [name, usages] of required) {
      const reg = state.docs.get(name);
      if (reg === undefined || !reg.isPublic) {
        const where = usages.map((u) => `${u.surface}#${u.id}`).join(', ');
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} 的 UI 声明（${where}）引用了未注册为 public doc 的文档 ${name}`,
          400,
          { pluginId, doc: name, usages },
        );
      }
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
      // 快照参与屏障的插件（后续 register/enable 的插件走 activateServices 即时路径）
      const participants = [...this.plugins.values()].filter((s) => s.enabled);
      // 阶段 1：全部 prepare 成功才允许任何 start（prepare 只做恢复标记，不产副作用）
      try {
        for (const state of participants) await this.prepareServices(state);
      } catch (err) {
        // prepare 失败零副作用零残留：直接上抛，屏障未放行（可修复后重试 start）
        this.startPromise = undefined;
        throw err instanceof HelmError ? err : new HelmError(
          'plugin_service_prepare_failed',
          `插件服务 prepare 失败：${err instanceof Error ? err.message : String(err)}`,
          500,
          {},
        );
      }
      // 阶段 2：逐插件 start；某插件失败时逆向 stop 本插件与之前已启动插件，
      // 错误如实上抛，屏障标记不放行（半启动状态不允许被后续 enable 绕过）。
      // 回滚 stop 失败不丢弃：与原始 start 错误同层聚合（保留原 code/message，
      // 附 rollbackStop 诊断，含 pluginId 与 JSON-safe stop 错误清单）。
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
            // stopServicesQuietly 抛 plugin_service_stop_failed（details.stopErrors 已聚合）
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
      actions: s.enabled ? [...s.actions.keys()] : [],
      tools: s.enabled ? [...s.tools.keys()] : [],
    };
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

  /**
   * 模型工具清单：显式 ctx.tool + exposeAsTool 动作派生（run_action 接入由 runtime 承担）。
   * - 无参：全量（runtime 热注册用）；
   * - 传入 conversation：按声明 scope 筛选该会话可见的工具（会话级可见性，
   *   与执行期二次校验互为双保险）。
   * 动作派生名使用 provider-safe 别名；出现重名（别名遮蔽或与 ctx.tool 冲突）时
   * 显式抛错，绝不静默让某个工具不可达。
   */
  listTools(conversation?: ConversationSummary): DerivedToolSpec[] {
    this.assertNotDisposed();
    const out: DerivedToolSpec[] = [];
    for (const state of this.plugins.values()) {
      if (!state.enabled) continue;
      for (const tool of state.tools.values()) {
        if (conversation !== undefined && !matchesConversationScope(tool.spec.scope, conversation)) continue;
        out.push({
          name: tool.spec.name,
          description: tool.spec.description,
          inputSchema: tool.spec.inputSchema,
          ...(tool.spec.structuredOutputSchema !== undefined
            ? { structuredOutputSchema: tool.spec.structuredOutputSchema }
            : {}),
          sourcePluginId: state.definition.id,
          sourceKind: 'tool',
        });
      }
      for (const action of state.actions.values()) {
        if (!action.exposeAsTool) continue;
        if (conversation !== undefined && !matchesConversationScope(action.scope, conversation)) continue;
        out.push({
          name: action.toolAlias,
          description: action.description,
          inputSchema: action.inputSchema,
          sourcePluginId: state.definition.id,
          sourceKind: 'action',
          qualifiedId: `${state.definition.id}.${action.id}`,
        });
      }
    }
    const dups = out.filter((t, i) => out.findIndex((x) => x.name === t.name) !== i);
    if (dups.length > 0) {
      throw new HelmError(
        'duplicate_tool_name',
        `插件工具名冲突（provider-safe 名必须唯一）：${[...new Set(dups.map((d) => d.name))].join(', ')}`,
        500,
        { duplicates: [...new Set(dups.map((d) => d.name))] },
      );
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

  listUi(): PluginUiContribution[] {
    this.assertNotDisposed();
    const out: PluginUiContribution[] = [];
    for (const state of this.plugins.values()) {
      if (!state.enabled) continue;
      for (const u of state.ui) out.push({ ...u, spec: structuredClone(u.spec) });
    }
    return out;
  }

  // --- client.tsx 编译产物 --------------------------------------------------

  /**
   * 获取已启用插件的 client 模块编译产物（缓存命中时零编译）。
   * 停用/未注册/未声明 clientRoot/模块越根/编译失败一律显式抛 HelmError；
   * 供 HTTP GET /api/plugins/:id/client.mjs 消费（鉴权在 HTTP 层）。
   */
  async getClientModule(pluginId: string, moduleRef: string): Promise<ClientCompileResult> {
    this.assertNotDisposed();
    assertModuleRefShape(pluginId, moduleRef);
    const state = this.plugins.get(pluginId);
    if (!state || !state.enabled || state.phase !== 'idle') {
      throw new HelmError('plugin_client_unavailable', `插件 ${pluginId} 未启用，不提供 client 模块`, 409, {
        pluginId,
        module: moduleRef,
      });
    }
    const clientRoot = state.definition.clientRoot;
    if (clientRoot === undefined) {
      throw new HelmError('plugin_client_unavailable', `插件 ${pluginId} 未声明 clientRoot`, 404, { pluginId });
    }
    // 捕获启用周期：编译 await 期间插件可能被停用/重启（epoch 递增）。迟到的产物
    // 绝不返回成功——旧周期源可能已失效，返回它会伪造「插件仍可用」。
    const epoch = state.epoch;
    const result = await compilePluginClientModule(pluginId, clientRoot, moduleRef, this.options.dataDir);
    const current = this.plugins.get(pluginId);
    if (
      this.disposed ||
      current !== state ||
      state.epoch !== epoch ||
      !state.enabled ||
      state.phase !== 'idle'
    ) {
      throw new HelmError(
        'plugin_client_unavailable',
        `插件 ${pluginId} 在 client 模块编译完成前已停用或进入新启用周期，产物作废`,
        409,
        { pluginId, module: moduleRef },
      );
    }
    return result;
  }

  // --- 公共文档 -----------------------------------------------------------

  /**
   * 读取插件公共 doc 快照。私有 doc、未声明 doc、插件停用/不存在一律统一
   * 404（外部无从探测私有 doc 是否存在）；未写过时返回归一化初值。
   */
  getPublicDoc(pluginId: string, name: string): PublicPluginDoc {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    if (!state || !state.enabled || state.phase !== 'idle') {
      throw new HelmError('plugin_doc_not_found', `插件 ${pluginId} 无公共文档 ${name}`, 404, { pluginId, name });
    }
    const reg = state.docs.get(name);
    if (!reg || !reg.isPublic) {
      throw new HelmError('plugin_doc_not_found', `插件 ${pluginId} 无公共文档 ${name}`, 404, { pluginId, name });
    }
    return {
      pluginId,
      name,
      value: jsonClone(this.options.docs.get(`${pluginId}:${name}`, reg.initial as never)),
    };
  }

  /**
   * 全部已启用插件公共文档快照（SSE HelmSnapshot.pluginDocs 首帧直投用）：
   * 合并每个 idle 插件中 isPublic === true 的文档；快照读取失败属单一插件
   * 故障，聚合诊断后如实上抛（绝不静默丢一份公共快照让前端误判状态）。
   */
  listPublicDocs(): PublicPluginDoc[] {
    this.assertNotDisposed();
    const out: PublicPluginDoc[] = [];
    for (const state of this.plugins.values()) {
      if (!state.enabled || state.phase !== 'idle') continue;
      for (const [name, reg] of state.docs) {
        if (!reg.isPublic) continue;
        out.push({
          pluginId: state.definition.id,
          name,
          value: jsonClone(this.options.docs.get(`${state.definition.id}:${name}`, reg.initial as never)),
        });
      }
    }
    return out;
  }

  /**
   * 全部已启用且已启动服务声明的工作树占用清单（WorktreeAllocator 的
   * isPathInUse 探测源）：合并各服务 liveWorktrees() 返回值。
   * 服务声明函数抛错或返回非法形状时如实显式报错，绝不静默当空——
   * 占用检查坏了就必须修，不能靠猜放行清理在途工作树。
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
              !isJsonObject(item) ||
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

  /**
   * 执行某挂载点的整条管道。
   * 返回值即调用方（runtime）消费的最终决定：
   * - continue：无插件改写，走内核默认直通行为；
   * - transform：finalPayload 交默认行为消费；
   * - handled / block：短路默认行为。
   *
   * 只执行进入时快照中「已启用且空闲」的处理器；未启用（注册中）或正停用
   * 插件的 handler 绝不执行，任务跟踪也只计实际参与者。
   */
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
        // 无短路：载荷可能经 transform 链改写，统一以 transform 交回调用方执行默认直通行为
        outcome = { action: 'transform', value: r.finalPayload } as HookResult<HookPayloadMap[K]>;
      }
    } finally {
      for (const h of participants) this.tracker.end(h.pluginId, label);
    }
    return outcome;
  }

  private isHookActive(pluginId: string): boolean {
    const s = this.plugins.get(pluginId);
    return !!s && s.enabled && s.phase === 'idle';
  }

  // --- 动作总线 ------------------------------------------------------------

  /**
   * 解析全限定 actionId（pluginId.actionId）。pluginId 允许含 ':'（builtin:assistant），
   * 因此不能简单 split 最后一个 '.' —— 以第一个 '.' 分割。
   * 动作 id 本身禁止点号（注册边界校验），全限定形态无歧义。
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

  prepareAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext = {},
  ): { idempotent: boolean } {
    this.assertNotDisposed();
    const state = this.requirePlugin(pluginId);
    this.assertActive(state);
    const entry = state.actions.get(actionId);
    if (!entry) {
      throw new HelmError('unknown_action', `插件 ${pluginId} 未声明动作 ${actionId}`, 404, { pluginId, actionId });
    }
    this.assertScopeAllows(pluginId, `动作 ${pluginId}.${actionId}`, entry.scope, context.conversationId);
    validatePluginInput(pluginId, actionId, entry.inputSchema, input);
    return { idempotent: entry.idempotent === true };
  }

  async invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext = {},
  ): Promise<unknown> {
    this.prepareAction(pluginId, actionId, input, context);
    const state = this.requirePlugin(pluginId);
    const entry = state.actions.get(actionId)!;
    const raw = await this.tracker.withTask(pluginId, `action:${pluginId}.${actionId}`, () =>
      Promise.resolve(entry.handler(input as never, context)),
    );
    validatePluginOutput(pluginId, actionId, entry.outputSchema, raw);
    // 动作输出直接进 HTTP/CLI/SSE 的 JSON 序列化：边界显式拒绝非 JSON 值，
    // 绝不留给 JSON.stringify 悄悄丢数据（undefined 字段消失、Map 变 {}）
    return jsonClone(raw);
  }

  // --- 工具执行 ------------------------------------------------------------

  /** name 可为 ctx.tool 短名、pluginId.actionId 全限定名或 provider-safe 别名。 */
  async executeTool(name: string, input: unknown, context: PluginToolContext): Promise<unknown> {
    this.assertNotDisposed();
    const found = this.findToolByName(name);
    if (!found) throw new HelmError('unknown_tool', `未注册的工具：${name}`, 404, { name });

    const { state, spec } = found;
    this.assertActive(state);
    // 执行期二次校验：不信任调用方自述，会话摘要一律经 host.getConversation
    // 现取（与 listTools 的可见性筛选互为双保险，防绕过）。
    this.assertScopeAllows(state.definition.id, `工具 ${name}`, spec.scope, context.conversationId);
    validatePluginInput(state.definition.id, spec.name, spec.inputSchema, input);
    // ctx.tool 输出经 runtime 格式化为模型文本，此处不强制 JSON-safe
    return this.tracker.withTask(state.definition.id, `tool:${name}`, () =>
      Promise.resolve(spec.execute(input as never, context)),
    );
  }

  /**
   * scope 执行期校验：scope 未声明（旧行为）或调用无会话上下文（人工调用）
   * 直接放行；否则经 host.getConversation 解析会话后按 matchesConversationScope
   * 判定。会话不存在由 getConversation 如实抛错。
   */
  private assertScopeAllows(
    pluginId: string,
    what: string,
    scope: ConversationScope | undefined,
    conversationId: number | undefined,
  ): void {
    if (scope === undefined || conversationId === undefined) return;
    const conversation = this.options.host.getConversation(conversationId);
    if (!matchesConversationScope(scope, conversation)) {
      throw new HelmError('conversation_scope_violation', `${what} 不允许在会话 ${conversationId} 上执行（scope 未命中）`, 403, {
        pluginId,
        conversationId,
      });
    }
  }

  private findToolByName(name: string): { state: PluginState; spec: PluginToolSpec } | undefined {
    // 1. ctx.tool 直投名（provider-safe，无 '.'）
    for (const state of this.plugins.values()) {
      const direct = state.tools.get(name);
      if (direct) return { state, spec: direct.spec };
    }
    // 2. 全限定动作名 pluginId.actionId（pluginId 可含 ':'，取首个 '.' 分割）
    const dot = name.indexOf('.');
    if (dot > 0) {
      const pluginId = name.slice(0, dot);
      const actionId = name.slice(dot + 1);
      const spec = this.derivedToolSpec(this.plugins.get(pluginId), actionId, name);
      if (spec) return spec;
    }
    // 3. provider-safe 别名（不含 '.'，需扫描 exposeAsTool 动作）
    for (const state of this.plugins.values()) {
      const spec = this.derivedToolSpec(state, name, name);
      if (spec) return spec;
    }
    return undefined;
  }

  private derivedToolSpec(
    state: PluginState | undefined,
    key: string,
    displayName: string,
  ): { state: PluginState; spec: PluginToolSpec } | undefined {
    if (!state) return undefined;
    for (const action of state.actions.values()) {
      const match = action.exposeAsTool && (action.id === key || action.toolAlias === key);
      if (!match) continue;
      const pluginId = state.definition.id;
      const actionId = action.id;
      return {
        state,
        spec: {
          name: displayName,
          description: action.description,
          inputSchema: action.inputSchema,
          ...(action.scope !== undefined ? { scope: action.scope } : {}),
          execute: (input: unknown, ctx: PluginToolContext) =>
            this.invokeAction(pluginId, actionId, input, {
              conversationId: ctx.conversationId,
              signal: ctx.signal,
            }),
        },
      };
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
    return state.configSchema ? { ...state.configSchema } : {};
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
    // 先让在途生命周期操作（enable/disable 等）自然结束，避免与拆毁并发
    await Promise.allSettled([...this.lifecycle.values()]);
    this.lifecycle.clear();
    // 逆向停用全部插件（最近注册先停）；单个清理失败不阻止其余，聚合显式抛出
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
     * 例外：受控停止 doc 写入窗口（宿主正在 await 的本插件服务 stop 链，
     * epoch 由句柄闭包保证一致）允许最终持久化写入，见 PluginState.stopDocWrites。
     */
    const assertDocUsable = (name: string) => {
      if (state.stopDocWrites && self.plugins.get(pluginId) === state && state.epoch === epoch) {
        // 受控停止窗口：仅要求插件注册态与本周期仍在（dispose 后期 plugins.clear /
        // reenable 周期更替后的残留调用依然拒绝）。
        return;
      }
      self.assertContextUsable(state, epoch, `doc ${name} 句柄`);
    };

    /**
     * 宿主生命周期资源（管理保护/监听/解析器）仅在本周期内可获取；
     * 停用后或旧周期的残留调用即刻失效，防止向新周期泄漏注册。
     */
    const assertHostLifecycleUsable = (what: string) => {
      self.assertContextUsable(state, epoch, what);
    };

    /** 获取宿主生命周期资源：幂等化释放句柄并登记到本周期，停用/回滚统一释放。 */
    const acquireHostResource = (what: string, acquire: () => () => void): (() => void) => {
      assertHostLifecycleUsable(what);
      const release = idempotentRelease(acquire());
      state.hostReleases.add(release);
      return () => {
        state.hostReleases.delete(release);
        release();
      };
    };

    const addHook = <N extends HookName>(name: N, fn: HookHandler<N>, opts?: HookOptions) => {
      assertOpen(`追加 ${name} 钩子`);
      (self.pipelines.get(name) as unknown as HookPipeline<N>).add(pluginId, fn, opts?.priority ?? 0);
      state.hooks.add(name);
    };

    const addUi = (surface: string, spec: unknown, fnName: string) => {
      assertOpen(`声明 ui.${fnName}`);
      const id = (spec as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 声明缺少 id`, 400);
      }
      if (state.ui.some((u) => u.surface === surface && (u.spec as { id?: string }).id === id)) {
        throw new HelmError('duplicate_ui', `插件 ${pluginId} 在 ${surface} 重复声明 id ${id}`, 409);
      }
      // docs：声明式轨道订阅的本插件公开文档名列表；边界即校验
      //（非法 doc 名/非数组会让 $docs 挂载静默失效，必须显式拒绝）。
      const docs = (spec as { docs?: unknown }).docs;
      if (docs !== undefined) {
        if (!Array.isArray(docs) || docs.length === 0 || docs.some((d) => typeof d !== 'string' || d.length === 0)) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 的 docs 必须是非空字符串数组的文档名列表`,
            400,
          );
        }
        const unique = new Set(docs as string[]);
        if (unique.size !== docs.length) {
          throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 的 docs 含重复文档名`, 400);
        }
        for (const name of unique) {
          if (!/^[A-Za-z0-9._-]+$/.test(name)) {
            throw new HelmError(
              'invalid_ui_spec',
              `插件 ${pluginId} ui.${fnName} 的 docs 含非法文档名 ${JSON.stringify(name)}（允许字符 A-Za-z0-9._-）`,
              400,
            );
          }
        }
      }
      // scope 在注册边界即校验（非法 scope 会让渲染可见性静默失控）
      assertConversationScope(pluginId, `插件 ${pluginId} ui.${fnName} 声明`, (spec as { scope?: unknown }).scope);
      // client 引用：需插件定义提供 clientRoot，且 module 形状合法（相对 .ts/.tsx）；
      // 悬空引用（无法编译）在注册边界拒绝，绝不留给渲染期于静默空白。
      const client = (spec as { client?: unknown }).client;
      if (client !== undefined) {
        const def = state.definition;
        if (def.clientRoot === undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 声明 client 引用但插件定义未提供 clientRoot`,
            400,
            { pluginId },
          );
        }
        if (!isPlainObject(client) || Object.keys(client).some((k) => k !== 'module' && k !== 'export')) {
          throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 的 client 仅允许 { module, export }`, 400);
        }
        assertModuleRefShape(pluginId, String(client.module ?? ''));
        if (typeof client.export !== 'string' || client.export.length === 0 || !/^[A-Za-z0-9_$]+$/.test(client.export)) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 的 client.export 必须是非空合法导出名`,
            400,
          );
        }
      }
      // timeline.renderer 的 matchMeta 仅允许 { renderer: 非空字符串 }
      if (surface === 'timeline.renderer') {
        const matchMeta = (spec as { matchMeta?: unknown }).matchMeta;
        if (matchMeta !== undefined) {
          if (
            !isPlainObject(matchMeta) ||
            Object.keys(matchMeta).some((k) => k !== 'renderer') ||
            typeof matchMeta.renderer !== 'string' ||
            matchMeta.renderer.length === 0
          ) {
            throw new HelmError(
              'invalid_ui_spec',
              `插件 ${pluginId} ui.timelineRenderer 的 matchMeta 仅允许 { renderer: 非空字符串 }`,
              400,
            );
          }
        }
      }
      // tool.view 的 replaceRow 必须是布尔（非法值会让前端行接管判定静默失效）
      if (surface === 'tool.view') {
        const replaceRow = (spec as { replaceRow?: unknown }).replaceRow;
        if (replaceRow !== undefined && typeof replaceRow !== 'boolean') {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.toolView 的 replaceRow 必须是布尔值（实际：${typeof replaceRow}）`,
            400,
            { pluginId, id },
          );
        }
        const toolNames = (spec as { toolNames?: unknown }).toolNames;
        if (
          !Array.isArray(toolNames) ||
          toolNames.length === 0 ||
          toolNames.some((t) => typeof t !== 'string' || t.length === 0)
        ) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.toolView 的 toolNames 必须是非空字符串数组`,
            400,
            { pluginId, id },
          );
        }
      }
      // workbench.panel 的 badge 仅允许 { doc, countField?, toneField?, byConversationField? }
      if (surface === 'workbench.panel') {
        const badge = (spec as { badge?: unknown }).badge;
        if (badge !== undefined) {
          if (
            !isPlainObject(badge) ||
            Object.keys(badge).some(
              (k) => k !== 'doc' && k !== 'countField' && k !== 'toneField' && k !== 'byConversationField',
            )
          ) {
            throw new HelmError(
              'invalid_ui_spec',
              `插件 ${pluginId} ui.workbenchPanel 的 badge 仅允许 { doc, countField?, toneField?, byConversationField? }`,
              400,
              { pluginId, id },
            );
          }
          if (typeof badge.doc !== 'string' || badge.doc.length === 0) {
            throw new HelmError(
              'invalid_ui_spec',
              `插件 ${pluginId} ui.workbenchPanel 的 badge.doc 必须是非空字符串（订阅的本插件 public doc 名）`,
              400,
              { pluginId, id },
            );
          }
          for (const field of ['countField', 'toneField', 'byConversationField'] as const) {
            const value = badge[field];
            if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
              throw new HelmError(
                'invalid_ui_spec',
                `插件 ${pluginId} ui.workbenchPanel 的 badge.${field} 必须是非空字符串字段名`,
                400,
                { pluginId, id, field },
              );
            }
          }
        }
      }
      // 声明性轨道只接受可 JSON 序列化 spec（HTTP/SSE 直接 JSON 输出）；
      // structuredClone 接受 Map/Set/Date 但 JSON.stringify 会改形丢数据，必须显式拒绝。
      // client.tsx 轨道由 web 编译器负责（本模块不编译）。
      let normalized: unknown;
      try {
        normalized = jsonClone(spec);
      } catch (err) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 声明的 spec 必须可 JSON 序列化（client.tsx 引用请用 client 字段）` +
            `：${err instanceof Error ? err.message : String(err)}`,
          400,
        );
      }
      state.ui.push({ pluginId, surface, spec: normalized });
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
        onWatchdogTick: (fn, o) => addHook('watchdog_tick', fn, o),
      },

      action: <TIn, TOut>(spec: PluginActionSpec<TIn, TOut>) => {
        assertOpen(`声明动作 ${spec.id}`);
        self.assertValidId('动作', spec.id);
        // 动作 id 禁止点号：全限定 ID 以首个 '.' 分割，含点动作会产生歧义解析
        if (spec.id.includes('.')) {
          throw new HelmError(
            'invalid_action_spec',
            `插件 ${pluginId} 动作 id 不允许点号（全限定解析以首个 '.' 分割）：${spec.id}`,
            400,
          );
        }
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
        // cli.positional：按序消费 CLI 位置参数的映射表；与 CLI 动作层同契约
        // （未知键拒绝、field/readFileInto 必须是 inputSchema 自有属性、
        // readFileInto 目标真 type:string、写入目标不重复、required 连续、
        // 原型污染键拒绝、timeoutMs 有限 >= 0）——避免宿主接受但 CLI 清单拒绝。
        if (spec.cli?.positional !== undefined) {
          if (!Array.isArray(spec.cli.positional)) {
            throw new HelmError(
              'invalid_action_spec',
              `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 必须是数组`,
              400,
            );
          }
          const properties =
            spec.inputSchema.type === 'object' && isJsonObject(spec.inputSchema.properties)
              ? (spec.inputSchema.properties as Record<string, unknown>)
              : undefined
          if (properties === undefined) {
            throw new HelmError(
              'invalid_action_spec',
              `插件 ${pluginId} 动作 ${spec.id} 声明 cli.positional 但 inputSchema 不是带 properties 的 object`,
              400,
            );
          }
          const writeTargets = new Set<string>()
          let seenOptional = false
          for (const pos of spec.cli.positional) {
            if (!isPlainObject(pos) || Object.keys(pos).some((k) => k !== 'field' && k !== 'required' && k !== 'readFileInto')) {
              throw new HelmError(
                'invalid_action_spec',
                `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 项仅允许 { field, required?, readFileInto? }`,
                400,
              );
            }
            if (typeof pos.field !== 'string' || pos.field.length === 0) {
              throw new HelmError(
                'invalid_action_spec',
                `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional[].field 必须是非空字符串`,
                400,
              );
            }
            if (pos.required !== undefined && typeof pos.required !== 'boolean') {
              throw new HelmError(
                'invalid_action_spec',
                `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional[${pos.field}].required 必须是 boolean`,
                400,
              );
            }
            if (pos.readFileInto !== undefined && (typeof pos.readFileInto !== 'string' || pos.readFileInto.length === 0)) {
              throw new HelmError(
                'invalid_action_spec',
                `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional[${pos.field}].readFileInto 必须是非空字符串字段名`,
                400,
              );
            }
            for (const name of [pos.field, pos.readFileInto] as const) {
              if (name === undefined) continue
              if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
                throw new HelmError(
                  'invalid_action_spec',
                  `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 字段名 "${name}" 不可用（原型污染键）`,
                  400,
                );
              }
              if (writeTargets.has(name)) {
                throw new HelmError(
                  'invalid_action_spec',
                  `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 重复写入字段 "${name}"（field/readFileInto 目标不得重叠）`,
                  400,
                );
              }
              writeTargets.add(name)
              if (!Object.hasOwn(properties, name)) {
                throw new HelmError(
                  'invalid_action_spec',
                  `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 字段 "${name}" 不在 inputSchema.properties 中`,
                  400,
                );
              }
            }
            if (pos.readFileInto !== undefined) {
              const target = properties[pos.readFileInto] as { type?: unknown } | undefined
              if (target === null || typeof target !== 'object' || target.type !== 'string') {
                throw new HelmError(
                  'invalid_action_spec',
                  `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional "${pos.field}" 的 readFileInto 目标 "${pos.readFileInto}" 需为 type: string 属性`,
                  400,
                );
              }
            }
            if (pos.required === true) {
              if (seenOptional) {
                throw new HelmError(
                  'invalid_action_spec',
                  `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional required 字段 "${pos.field}" 出现在 optional 之后（required 必须连续）`,
                  400,
                );
              }
            } else {
              seenOptional = true
            }
          }
        }
        // cli.timeoutMs：请求超时覆盖；0 表示无超时（长耗时动作如 workflow run --wait）。
        if (
          spec.cli?.timeoutMs !== undefined &&
          (typeof spec.cli.timeoutMs !== 'number' || !Number.isFinite(spec.cli.timeoutMs) || spec.cli.timeoutMs < 0)
        ) {
          throw new HelmError(
            'invalid_action_spec',
            `插件 ${pluginId} 动作 ${spec.id} 的 cli.timeoutMs 必须是 >= 0 的有限数字（0 表示无超时）`,
            400,
          );
        }
        assertConversationScope(pluginId, `插件 ${pluginId} 动作 ${spec.id}`, spec.scope);
        if (spec.idempotent !== undefined && typeof spec.idempotent !== 'boolean') {
          throw new HelmError('validation_error', `插件 ${pluginId} 动作 ${spec.id} 的 idempotent 必须为 boolean`, 400);
        }
        if (state.actions.has(spec.id)) {
          throw new HelmError('duplicate_action', `插件 ${pluginId} 重复声明动作 ${spec.id}`, 409);
        }
        // Schema 预编译：注册期即暴露 $async/非法 Schema（invalid_plugin_schema），
        // 绝不留到首次调用才发现（异步校验函数返回 Promise 会被当 truthy 放行）
        assertSchemaCompilable(spec.inputSchema);
        assertSchemaCompilable(spec.outputSchema);
        state.actions.set(spec.id, {
          pluginId,
          id: spec.id,
          description: spec.description,
          inputSchema: spec.inputSchema,
          outputSchema: spec.outputSchema,
          cli: spec.cli,
          exposeAsTool: spec.exposeAsTool === true,
          ...(spec.idempotent !== undefined ? { idempotent: spec.idempotent } : {}),
          toolAlias: actionToolAlias(pluginId, spec.id),
          ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
          handler: spec.handler as (input: never, context: PluginActionContext) => unknown,
        });
      },

      tool: <TIn>(spec: PluginToolSpec<TIn>) => {
        assertOpen(`声明工具 ${spec.name}`);
        self.assertValidId('工具', spec.name);
        // 工具名直发模型 provider（pi-ai 原样透传），必须 provider-safe
        if (!PROVIDER_SAFE_TOOL_NAME.test(spec.name)) {
          throw new HelmError(
            'invalid_tool_spec',
            `插件 ${pluginId} 工具名 ${spec.name} 必须匹配 ${PROVIDER_SAFE_TOOL_NAME.source}（provider 函数名约束）`,
            400,
          );
        }
        if (typeof spec.description !== 'string' || spec.description.length === 0) {
          throw new HelmError('invalid_tool_spec', `插件 ${pluginId} 工具 ${spec.name} 缺少 description`, 400);
        }
        if (!isJsonObject(spec.inputSchema)) {
          throw new HelmError('invalid_tool_spec', `插件 ${pluginId} 工具 ${spec.name} 缺少 inputSchema`, 400);
        }
        // 结构化输出 Schema：声明即预编译检查（$async/非法 Schema 在注册边界拒绝）
        if (spec.structuredOutputSchema !== undefined) {
          if (!isJsonObject(spec.structuredOutputSchema)) {
            throw new HelmError(
              'invalid_tool_spec',
              `插件 ${pluginId} 工具 ${spec.name} 的 structuredOutputSchema 必须是 JSON Schema 对象`,
              400,
            );
          }
          assertSchemaCompilable(spec.structuredOutputSchema);
        }
        if (typeof spec.execute !== 'function') {
          throw new HelmError('invalid_tool_spec', `插件 ${pluginId} 工具 ${spec.name} 缺少 execute`, 400);
        }
        assertConversationScope(pluginId, `插件 ${pluginId} 工具 ${spec.name}`, spec.scope);
        if (state.tools.has(spec.name)) {
          throw new HelmError('duplicate_tool', `插件 ${pluginId} 重复声明工具 ${spec.name}`, 409);
        }
        assertSchemaCompilable(spec.inputSchema);
        state.tools.set(spec.name, { pluginId, spec: spec as PluginToolSpec });
      },

      route: (spec: PluginRouteSpec) => {
        assertOpen(`声明路由 ${spec.path}`);
        // 相对命名空间契约：插件只声明 /webhook/:id 形态的相对路径，宿主统一
        // 拼接到 /api/plugins/<enc id>/routes 之下；完整 /api 前缀一律拒绝
        if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) {
          throw new HelmError(
            'invalid_route_path',
            `插件 ${pluginId} 路由 path 必须是以 / 开头的相对路径（宿主自动挂载到插件命名空间）：${String(spec.path)}`,
            400,
          );
        }
        if (spec.path === '/api' || spec.path.startsWith('/api/')) {
          throw new HelmError(
            'invalid_route_path',
            `插件 ${pluginId} 路由 ${spec.method} ${spec.path} 不允许携带 /api 前缀（请声明相对路径，宿主负责命名空间拼接）`,
            400,
          );
        }
        if (spec.path === '/') {
          throw new HelmError('invalid_route_path', `插件 ${pluginId} 路由相对路径至少需要一段（不允许仅 /）`, 400);
        }
        if (spec.path.includes('?') || spec.path.includes('#')) {
          throw new HelmError(
            'invalid_route_path',
            `插件 ${pluginId} 路由 ${spec.method} ${spec.path} 不允许携带查询串或片段`,
            400,
          );
        }
        // 拒绝空段、点段（含百分号编码形态）与非法编码：每段严格解码后校验
        for (const seg of spec.path.slice(1).split('/')) {
          if (seg.length === 0) {
            throw new HelmError(
              'invalid_route_path',
              `插件 ${pluginId} 路由 ${spec.method} ${spec.path} 不允许空路径段（// 或尾斜杠）`,
              400,
            );
          }
          const decoded = decodeSegmentStrict(seg);
          if (decoded === '.' || decoded === '..' || decoded.includes('/')) {
            throw new HelmError(
              'invalid_route_path',
              `插件 ${pluginId} 路由 ${spec.method} ${spec.path} 不允许点段（. / ..）或编码斜杠`,
              400,
            );
          }
        }
        if (typeof spec.handler !== 'function') {
          throw new HelmError('invalid_route_handler', `插件 ${pluginId} 路由 ${spec.path} 缺少 handler`, 400);
        }
        // 宿主拼接完整挂载路径：限定插件专属前缀
        // /api/plugins/<encodeURIComponent(pluginId)>/routes/... 之下
        // （与 HTTP 代理命名空间一致），handler 收到的仍是原始 Request。
        state.routes.push({ ...spec, path: `${pluginRoutePrefix(pluginId)}${spec.path}`, pluginId });
      },

      doc: <TState>(name: string, initial: TState, opts?: { public?: boolean }) => {
        assertOpen(`声明 doc ${name}`);
        self.assertValidId('doc', name);
        if (opts !== undefined && (!isPlainObject(opts) || Object.keys(opts).some((k) => k !== 'public'))) {
          throw new HelmError('invalid_doc_spec', `插件 ${pluginId} doc ${name} 的选项仅允许 { public?: boolean }`, 400);
        }
        if (opts?.public !== undefined && typeof opts.public !== 'boolean') {
          throw new HelmError('invalid_doc_spec', `插件 ${pluginId} doc ${name} 的 public 选项必须是布尔值`, 400);
        }
        if (state.docs.has(name)) {
          throw new HelmError('duplicate_doc', `插件 ${pluginId} 重复声明 doc ${name}`, 409);
        }
        const isPublic = opts?.public === true;
        const key = `${pluginId}:${name}`;
        const store = self.options.docs;
        // 持久层为 JSON 语义（state.sqlite / 文件）：初始值边界即校验 JSON-safe
        const normalizedInitial = jsonClone(initial);
        const handle: PluginDocHandle<TState> = {
          // get 返回 JSON-safe 校验后的深拷贝：防止未 set 的原地突变污染持久层；
          // 初值在未写过时即可读（store 回落 initial）
          get: () => {
            assertDocUsable(name);
            return jsonClone(store.get<TState>(key, normalizedInitial));
          },
          set: (next) => {
            assertDocUsable(name);
            const safe = jsonClone(next);
            store.set(key, safe);
            if (isPublic) self.emitDocUpdated(pluginId, name, safe);
          },
          update: (fn) => {
            assertDocUsable(name);
            const safe = jsonClone(fn(jsonClone(store.get<TState>(key, normalizedInitial))));
            store.set(key, safe);
            if (isPublic) self.emitDocUpdated(pluginId, name, safe);
          },
          // 真实持久化端口：透传 store 的排队写冲刷（同一持久化链，无按文档粒度
          // 队列）；失败原样上抛，不以镜像已写冒充持久化完成。
          flush: async () => {
            assertDocUsable(name);
            return store.flush();
          },
        };
        state.docs.set(name, { handle: handle as PluginDocHandle<unknown>, isPublic, initial: normalizedInitial });
        return handle;
      },

      sessionDoc: <TState>(name: string, initial: TState, opts?: PluginDocOptions): PluginSessionDocHandle<TState> => {
        assertOpen(`声明 sessionDoc ${name}`);
        self.assertValidId('sessionDoc', name);
        const store = self.options.docs;
        const normalizedInitial = jsonClone(initial);
        const sessionKeys = new Map<number, string>();
        const getSessionKey = (convId: number) => {
          let k = sessionKeys.get(convId);
          if (!k) {
            k = `${pluginId}:session:${convId}:${name}`;
            sessionKeys.set(convId, k);
          }
          return k;
        };
        const handle: PluginSessionDocHandle<TState> = {
          get: (convId: number) => jsonClone(store.get<TState>(getSessionKey(convId), normalizedInitial)),
          set: (convId: number, next: TState) => {
            const safe = jsonClone(next);
            store.set(getSessionKey(convId), safe);
          },
          update: (convId: number, fn: (current: TState) => TState) => {
            const safe = jsonClone(fn(jsonClone(store.get<TState>(getSessionKey(convId), normalizedInitial))));
            store.set(getSessionKey(convId), safe);
          },
          delete: (convId: number) => {
            store.set(getSessionKey(convId), normalizedInitial);
            sessionKeys.delete(convId);
          },
          listConversationIds: () => Array.from(sessionKeys.keys()),
          flush: async () => store.flush(),
        };
        return handle;
      },

      service: (spec: PluginServiceSpec) => {
        assertOpen(`声明服务 ${spec.id}`);
        self.assertValidId('服务', spec.id);
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
        // 仅收集声明：默认停用探测（enabled:false）零挂载零副作用；宿主未提供
        // providers 端口时的 501 由启用阶段 registerProviders 显式抛出（禁静默）
        state.providers.push({ provider, unregister: null });
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
        profileRuntime: (spec: ProfileRuntimeUiSpec) => addUi('profile.runtime', spec, 'profileRuntime'),
        conversationHeaderAction: (spec: ConversationActionSpec) => addUi('conversation.header.action', spec, 'conversationHeaderAction'),
        conversationRowAction: (spec: ConversationActionSpec) => addUi('conversation.row.action', spec, 'conversationRowAction'),
        timelineEntryAction: (spec: TimelineEntryActionSpec) => addUi('timeline.entry.action', spec, 'timelineEntryAction'),
        slot: (spec: PluginSlotContributionSpec) => addUi('plugin.slot', spec, 'slot'),
      },

      /**
       * 宿主运行时能力：逐方法显式包装（绝不整体透传 backend）——
       * manageConversation 强制注入本插件 pluginId，插件无法伪造他人身份；
       * 三个生命周期获取方法（管理保护/工作流监听/ask 解析器）做 epoch 守卫
       * 并登记释放句柄，停用/回滚时统一解除。
       */
      host: self.wrapHostApi(state, epoch),
    };

    return ctx;
  }

  /**
   * 构造插件视角的 ctx.host：全部方法显式转发到后端端口。
   * 生命周期资源（manageConversation / onEvent / registerAskSeqResolver）
   * 经 acquire 包装：epoch 守卫 + 幂等释放 + 停用统一解除；
   * onEvent 的每次事件回调计入在途任务保护（事件类型进任务标签）。
   */
  private wrapHostApi(state: PluginState, epoch: number): HelmHostApi {
    const pluginId = state.definition.id;
    const backend = this.options.host;
    const acquire =
      (what: string) =>
      (acquireFn: () => () => void): (() => void) => {
        this.assertContextUsable(state, epoch, what);
        const release = idempotentRelease(acquireFn());
        state.hostReleases.add(release);
        return () => {
          state.hostReleases.delete(release);
          release();
        };
      };
    return {
      dispatchTrigger: (event) => backend.dispatchTrigger(event),
      submitInput: (id, text, opts) => backend.submitInput(id, text, opts),
      createConversation: (init) => backend.createConversation(init),
      listConversations: (filter) => backend.listConversations(filter),
      getConversation: (id) => backend.getConversation(id),
      updateConversation: (id, patch) => backend.updateConversation(id, patch),
      abortConversation: (id) => backend.abortConversation(id),
      spawnAgent: (request) => backend.spawnAgent(request),
      runGate: (command, options) => backend.runGate(command, options),
      prepareInterruptedConversations: (ids) => backend.prepareInterruptedConversations(ids),
      cleanupWorktree: (request, signal) => backend.cleanupWorktree(request, signal),
      invokeAction: async (pluginId, actionId, input, context) => {
        // 契约承诺插件动作输出经宿主统一脱敏（不再依赖调用方插件自带 redactor）。
        const raw = await this.invokeAction(pluginId, actionId, input, context);
        const redactText = this.options.redactText;
        return redactText ? redactJsonValue(raw, redactText) : raw;
      },
      listActions: () => this.listActions(),
      markConversationOwnership: (id, owner) => backend.markConversationOwnership(id, owner),
      createAsk: (spec) => backend.createAsk(spec),
      cancelAsk: (askId, reason) => backend.cancelAsk(askId, reason),
      execEnv: async (req, opts) => {
        this.assertContextUsable(state, epoch, 'host.execEnv');
        return this.tracker.withTask(pluginId, 'host.execEnv', () =>
          Promise.resolve(backend.execEnv(req, opts)),
        );
      },
      prepareAction: (targetPluginId, actionId, input, context) => {
        this.assertContextUsable(state, epoch, 'host.prepareAction');
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
      // 可等待：同步分发内部监听器（含异步监听器的 await），发布方（如引擎结算）
      // 拿到完成/失败结果，错误不再被 fire-and-forget 吞成后台 notification。
      emitEvent: (type, payload) => backend.emitEvent(type, payload),
      manageConversation: (id) =>
        acquire('host.manageConversation')(() => backend.manageConversation(id, pluginId)),
      registerAskSeqResolver: (resolver) =>
        acquire('host.registerAskSeqResolver')(() => backend.registerAskSeqResolver(resolver)),
    };
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
      ui: this.listUi().filter((u) => u.pluginId === state.definition.id),
    });
  }

  /**
   * 生命周期操作的实际状态转换（disable 落位已停用 / unregister 移除）完成后收尾：
   * 无论 stop 是否失败都发布一次 plugin.changed（enabled:false / ui:[]），再如实
   * 上抛 stop 错误——状态已真实变化，客户端必须凭这一帧同步，不能只在成功路径发。
   * stop 已失败且事件发布再失败时，按 register 回滚的既有聚合方式把事件错误并入
   * stop 错误 details，绝不让事件异常掩盖 stop 诊断。
   */
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
      // stop 成功但持久化失败：进程内已停用，重启后将回到旧持久化值——显式
      // 诊断（诚实性纪律），不伪造成功。
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
    // 非 HelmError 的 stop 失败：保持既有语义——事件发布成功时原样上抛原始
    // stop 错误（不吞不包）；双失败（事件也炸）时包成显式 500。persistError
    // 尽力保留在 details，绝不静默变成功
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

  private toManifest(entry: ActionEntry): ActionManifest {
    const manifest: ActionManifest = {
      pluginId: entry.pluginId,
      id: entry.id,
      description: entry.description,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      exposeAsTool: entry.exposeAsTool,
      ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
      ...(entry.idempotent !== undefined ? { idempotent: entry.idempotent } : {}),
    };
    if (entry.cli) manifest.cli = entry.cli;
    return manifest;
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
    // clientRoot：可选但一旦存在必须是跨平台绝对路径（POSIX /、Windows 盘符 C:\ 或
    // UNC \\server\share——与 http/validate.ts 的 isCrossPlatformAbsolutePath 同一语义，
    // 修复旧实现只认 startsWith('/') 误拒 Windows 绝对路径）；段级 .. 检查（目录名
    // 含字面 ".." 如 foo..bar 是合法目录，只有整段 ".." 才是越根）。目录存在性与
    // containment（realpath 双检）在首次编译时二次校验。
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

  private assertValidId(kind: string, id: string): void {
    // 通用 id 字符集；动作 id 的点号禁令在 ctx.action 内单独收紧
    // （doc id / 服务 id 等仍允许 '.'，插件 id 走 assertDefinition）
    if (typeof id !== 'string' || id.length === 0 || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new HelmError('invalid_identifier', `插件声明 ${kind} id 非法：${String(id)}`, 400);
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

function pluginRoutePrefix(pluginId: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/routes`;
}

/** 跨平台绝对路径：POSIX `/`、Windows 盘符 `^[a-zA-Z]:[\\/]` 与 UNC `^\\\\[^\\]+\\[^\\]+`。
 * 与 http/validate.ts 的 isCrossPlatformAbsolutePath 同一语义（复判 plugin 定义层的
 * clientRoot，避免旧实现 startsWith('/') 误拒 Windows 绝对路径）。 */
function isCrossPlatformAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
}

/**
 * 严格解码单个路径段：非法百分号序列直接抛错（注册边界显式拒绝，
 * 不留到路由匹配期才炸——声明非法就是插件契约违约）。
 */
function decodeSegmentStrict(seg: string): string {
  if (!seg.includes('%')) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HelmError(
      'invalid_route_path',
      `路由路径段包含非法百分号编码：${seg}（如需字面 % 请编码为 %25）`,
      400,
      { segment: seg },
    );
  }
}
