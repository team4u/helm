/**
 * PluginHost 类型与接口定义。
 */
import type {
  BackendPluginsLifecyclePort,
  ConversationScope,
  GuardedMutationExpectation,
  HelmHostApi,
  HelmHostNodeIpcPort,
  HelmHostNodeFetchPort,
  HelmHostOpenTunnelPort,
  HookName,
  PluginConfigFieldSchema,
  PluginDefinition,
  PluginDiagnosticError,
  PluginServiceSpec,
  PluginSkillAsset,
} from '@helm/protocol';
import type { Provider } from '@earendil-works/pi-ai';
import type { PluginDocStore, PluginSessionDocStore } from './doc-registry.js';

export type { PluginDocStore, PluginSessionDocStore } from './doc-registry.js';

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
export type PluginHostBackend = Omit<HelmHostApi, 'manageConversation' | 'skills' | 'secrets' | 'setConfig' | 'isClosing' | 'listPlugins' | 'listUi' | 'nodeIpc' | 'plugins' | 'nodeFetch' | 'openTunnel' | 'abortConversationGuarded' | 'submitInputGuarded'> & {
  /** 声明 pluginId 对会话的管理权；返回释放函数（受管期间删除保护）。 */
  manageConversation(id: number, pluginId: string): () => void;
  /**
   * 自动化 guarded 中止（内核原子守卫端口）：未接线时 ctx.host 调用显式
   * 501，绝不静默回退普通 abortConversation（那会绕过 human 红线复核）。
   */
  abortConversationGuarded?(id: number, guard: GuardedMutationExpectation): Promise<void>;
  /**
   * 自动化 guarded 提交（内核原子守卫端口）：未接线时 ctx.host 调用显式
   * 501，绝不静默回退普通 submitInput（那会绕过 human 红线复核）。
   */
  submitInputGuarded?(
    conversationId: number,
    text: string,
    opts?: Parameters<HelmHostApi['submitInputGuarded']>[2],
    guard?: GuardedMutationExpectation,
  ): Promise<void>;
  skills: Omit<HelmHostApi['skills'], 'ensureSkill'> & {
    ensureSkill(asset: PluginSkillAsset, pluginId: string): Promise<void>;
  };
  /** 节点 IPC 机制端口（EnvFabric 通道；测试宿主未提供时调用显式报 501，不静默降级）。 */
  nodeIpc?: HelmHostNodeIpcPort;
  /** 节点本机 HTTP fetch 端口（EnvFabric.nodeFetch；未接线时调用显式报 501，不回退 local）。 */
  nodeFetch?: HelmHostNodeFetchPort;
  /** 任意 TCP 透传隧道端口（EnvFabric.openTunnel；未接线时调用显式报 501，不回退 local）。 */
  openTunnel?: HelmHostOpenTunnelPort;
  /**
   * 宿主插件治理后端（ctx.host.plugins 写面：doctor/install/update/remove/
   * enable/disable；未接线时修改操作显式 501，不静默降级）。真实实现由
   * runtime 直接委托 PluginHost 与 PluginPackageManager 既有公共方法。
   */
  plugins?: BackendPluginsLifecyclePort;
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
  assertConversationExists?(conversationId: number): void;
};

export interface PluginHostOptions {
  dataDir: string;
  host: PluginHostBackend;
  docs: PluginDocStore;
  /** 会话分片持久层；缺失时声明 sessionDoc 显式失败，不使用内存或全局文档降级。 */
  sessionDocs?: PluginSessionDocStore;
  config?: PluginConfigStore;
  /**
   * 可选的插件 Provider 挂载端口（runtime 提供）：插件经 ctx.provider 声明的
   * 自带模型 Provider 在启用时挂载、停用/卸载时卸载。
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

export interface ServiceEntry extends PluginServiceSpec {
  pluginId: string;
  started: boolean;
  /** prepare 已执行标记（避免重复执行；幂等由服务自身保证）。 */
  prepared: boolean;
}

/** provider 声明项：definePlugin 阶段收集，启用时挂载（记录挂载顺序供逆序卸载）。 */
export interface ProviderEntry {
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
export type PluginPhase = 'idle' | 'defining' | 'deactivating';

/**
 * 受控停止窗口内仍可用的 ctx.host 调用（按 wrapHostApi 的 what 标签）：
 * 停止链必需的只读（listConversations/getConversation/redact/nodeIpc.isOnline）、
 * 取消（abortConversation/cancelAsk）、跨节点清理 IPC（nodeIpc.call）与最终
 * 事件（emitEvent）。集合来自真实 stop 消费者（workflow close 的 runs 投影与
 * 子会话中止、herdr 的销单/pane 清理/通知、superagent 的 Ask 取消）并按能力
 * 通用表达，不按插件 ID 特判。其余调用——含 spawnAgent/submitInput/
 * createConversation/dispatchTrigger/createAsk/execEnv/executionEnv/
 * completeText 等一切新工作入口——在窗口内同样拒绝：停用语义是拆毁收尾，
 * 不是继续干活的宽限期。guarded 中止随普通中止一并放行（收尾取消链）；
 * guarded 提交属于新工作入口，窗口内照拒。
 */
export const STOP_WINDOW_HOST_CALLS: ReadonlySet<string> = new Set([
  'host.listConversations',
  'host.getConversation',
  'host.abortConversation',
  'host.abortConversationGuarded',
  'host.cancelAsk',
  'host.emitEvent',
  'host.redact',
  'host.nodeIpc.isOnline',
  'host.nodeIpc.call',
]);

/** 持久资源占用项（停用预检聚合用；与 protocol PluginInUseItem 同形）。 */
export interface PluginInUseItem {
  kind: string;
  id: string;
  label: string;
}

export interface PluginState {
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
   * 受控停止窗口：宿主正在 await 本插件服务 stop 链期间为 true。
   * 此窗口内 STOP_WINDOW_HOST_CALLS 与 doc 写入放行，其余宿主调用与新任务照拒。
   */
  stopWindow: boolean;
  /**
   * 最近一次加载或启用失败的诊断（status: 'failed' 的判定源）。
   * enable / disable 成功时清空；scan/load 阶段占位条目（loadFailed）恒保留
   * 直到修复后 reload / 重启重新注册。
   */
  lastError?: PluginDiagnosticError;
  /**
   * scan / load 阶段失败的占位条目标记：definition 为空壳（definePlugin 为
   * no-op），无有效能力注册；enable 直接 409 plugin_load_failed。
   */
  loadFailed?: boolean;
  /**
   * 注册时声明的故障隔离意愿（外部插件加载器传 isolateFailure:true）：
   * define / enable / 启动屏障阶段失败降级为 failed 条目而不是阻断宿主。
   */
  isolateFailure?: boolean;
}
