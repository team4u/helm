import { KernelRuntime } from './runtime/index.js';
import { WorkflowService } from './workflow/index.js';
import { createAssistantPlugin } from './builtin-plugins/assistant.js';
import { createHerdrPlugin } from './builtin-plugins/herdr.js';
import { createSuperAgentPlugin, SUPERAGENT_PLUGIN_ID } from './builtin-plugins/superagent.js';
import { createTriggersPlugin } from './builtin-plugins/triggers.js';
import { createMagpiePlugin } from './builtin-plugins/magpie.js';
import { MAGPIE_PROVIDER_ID } from './builtin-plugins/magpie/contracts.js';
import { loadExternalPlugins } from './plugins/external-loader.js';
import type { HerdrNodeChannel, HerdrTransport } from './builtin-plugins/herdr/contracts.js';
import type { EnvFabric } from './env/index.js';
import type { SuperAgentDependencies } from './builtin-plugins/superagent/contracts.js';
import { redactJsonValue } from './redact.js';

export type HelmOptions = Omit<NonNullable<Parameters<typeof KernelRuntime.open>[0]>, 'autoResume'> & {
  /** 可注入同契约传输层；缺省复用内核 EnvFabric 连接目标节点的 Herdr IPC。 */
  herdrTransport?: HerdrTransport;
};

/** 插件使用 SDK Context；EnvFabric 的 IPC 端口仅消费其中的取消信号。 */
export function createHerdrNodeChannel(fabric: EnvFabric): HerdrNodeChannel {
  return {
    isOnline: (id) => fabric.isOnline(id),
    getNodeHubUrl: (id) => fabric.getNodeHubUrl(id),
    envFor: (id, cwd) => fabric.envFor(id, cwd),
    ipcCall: (id, input, context) => fabric.ipcCall(id, input, context.abortSignal),
    ipcSubscribe: (id, input, onLine, onClosed, context) => fabric.ipcSubscribe(id, input, onLine, onClosed, context.abortSignal),
  };
}

export async function createHelm(options: HelmOptions = {}) {
  const { herdrTransport, ...runtimeOptions } = options;
  const kernel = await KernelRuntime.open({ ...runtimeOptions, autoResume: false });
  let closeWorkflows: (() => Promise<void>) | undefined;
  try {
    const workflows = new WorkflowService({
      dataDir: kernel.dataDir,
      state: kernel.documentStore,
      redact: (text) => kernel.stash.redact(text),
      host: {
        spawnAgent: (request) => kernel.spawnAgent(request),
        prepareInterruptedConversations: (ids) => kernel.prepareInterruptedConversations(ids),
        runGate: (command, context) => kernel.runGate(command, context),
        async invokeAction(pluginId, actionId, input, context) {
          const result = await kernel.plugins.invokeAction(pluginId, actionId, input, context);
          return redactJsonValue(result, (text) => kernel.stash.redact(text));
        },
        listActions: () => kernel.plugins.listActions(),
        getConversation: (id) => kernel.getConversation(id),
        abortConversation: (id) => kernel.abortConversation(id),
        emitEvent: (type, payload) => kernel.events.publish(type, payload),
        onRunSettled: (summary) => kernel.notifyWorkflowSettled(summary),
        onBackgroundAgentSettled: (summary, info) => kernel.reportBackgroundAgent(summary, info),
      },
    });
    closeWorkflows = () => workflows.close();
    kernel.setWorkflowRunProvider(() => workflows.listRuns());
    kernel.setBackgroundAgentRunner((request) => workflows.startBackgroundAgent(request, {
      parentToolCallId: request.parentToolCallId,
      notifyParentOnSettle: true,
    }));
    kernel.setWorkflowRunner(async (request, conversationId, signal, context) => {
      const started = await workflows.run({ ...request, conversationId }, context);
      const onAbort = () => {
        void workflows.abort(started.id).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await workflows.wait(started.id).catch(() => {});
        return workflows.getRun(started.id);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    });
    // 任何插件 start 都可能提交输入而唤醒全局调度；先将遗留子任务持久标记取消。
    await workflows.prepareRecovery();
    await kernel.plugins.register(createAssistantPlugin(kernel));
    await kernel.plugins.register(createHerdrPlugin({
      defaultCwd: runtimeOptions.cwd ?? process.cwd(),
      profiles: kernel.profiles,
      buildSpawnEnv: (id, cwd, nodeId) => kernel.buildSpawnEnv(id, cwd, nodeId),
      nodeChannel: createHerdrNodeChannel(kernel.envFabric),
      redact: (text) => kernel.stash.redact(text),
      runLocalGate: (command, context) => kernel.runGate(command, { ...context, nodeId: 'local' }),
      getArtifact: (id, conversationId) => kernel.resolveAuthorizedAttachment(conversationId, id),
      ...(herdrTransport ? { transport: herdrTransport } : {}),
    }), { enabled: false });
    // builtin:superagent：默认停用注册；启用时 service.start 幂等自举
    // Profile 资产、两个常驻会话与 Watchdog 挂载。业务依赖显式注入，
    // 不向通用 ctx.host 扩张（组合层职责）。
    const superagentDeps: SuperAgentDependencies = {
      dataDir: kernel.dataDir,
      profiles: kernel.profiles,
      skills: kernel.skills,
      getConversationDetail: (id, options) => kernel.getConversationDetail(id, options),
      // 组合层订阅端口：内核 EventHub conversation.entry 事件过滤后转交插件
      // （不扩张通用 ctx.host / 7 hooks，内核零插件转判）。
      subscribeConversationEntries: (listener) =>
        kernel.events.subscribe((frame) => {
          const event = frame.event
          if (event.type !== 'conversation.entry' || !('entry' in event)) return
          listener(event.conversationId, event.entry)
        }),
      listArtifacts: (conversationId) => kernel.artifacts.list(conversationId),
      abortConversation: (conversationId) => kernel.abortConversation(conversationId),
      getConversationOwnership: (conversationId) => kernel.getConversationOwnership(conversationId),
      isClosing: () => kernel.isClosing,
      redact: (text) => kernel.stash.redact(text),
      setRouterMode: async (enabled) => {
        await kernel.plugins.setConfig(SUPERAGENT_PLUGIN_ID, {
          ...kernel.plugins.getConfig(SUPERAGENT_PLUGIN_ID),
          routerMode: enabled,
        });
      },
    };
    await kernel.plugins.register(createSuperAgentPlugin(superagentDeps), { enabled: false });
    // builtin:triggers：cron + webhook 入站连接器，默认停用注册；启用后经
    // trigger 管道投递（dispatchTrigger 统一 defang）。组合层依赖显式注入。
    await kernel.plugins.register(createTriggersPlugin({
      credentials: kernel.credentials,
      stash: kernel.stash,
      profiles: kernel.profiles,
      isClosing: () => kernel.isClosing,
      flushDocs: () => kernel.documentStore.flush(),
    }), { enabled: false });
    await kernel.plugins.register(createMagpiePlugin({
      refreshProviderModels: async (options) => {
        const result = await kernel.refreshModels({ ...options, providers: [MAGPIE_PROVIDER_ID] });
        return {
          errors: result.errors,
          modelCount: result.providerCatalog.find((provider) => provider.id === MAGPIE_PROVIDER_ID)?.modelCount ?? 0,
        };
      },
    }), { enabled: false });
    // 外部插件目录 <dataDir>/plugins/<dir>/ 自动发现（内置插件数据目录静默跳过）；
    // 默认停用注册，config.json.pluginEnabled 持久化 true 的自动恢复启用
    await loadExternalPlugins(kernel.dataDir, kernel.plugins);
    // 恢复补发会提交父会话输入并启动 SDK，必须等全部工具与插件已注册。
    await workflows.init();
    await kernel.start();
    return {
      kernel,
      workflows,
      async close() {
        try {
          await workflows.close();
        } finally {
          await kernel.close();
        }
      },
    };
  } catch (error) {
    try {
      await closeWorkflows?.();
    } finally {
      await kernel.close();
    }
    throw error;
  }
}
