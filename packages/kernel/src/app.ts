import { KernelRuntime } from './runtime/index.js';
import { WorkflowService } from './workflow/index.js';
import { createAssistantPlugin } from './builtin-plugins/assistant.js';
import { createHerdrPlugin } from './builtin-plugins/herdr.js';
import { createSuperAgentPlugin, SUPERAGENT_PLUGIN_ID } from './builtin-plugins/superagent.js';
import type { HerdrTransport } from './builtin-plugins/herdr/contracts.js';
import type { SuperAgentDependencies } from './builtin-plugins/superagent/contracts.js';
import { redactJsonValue } from './redact.js';

export type HelmOptions = Omit<NonNullable<Parameters<typeof KernelRuntime.open>[0]>, 'autoResume'> & {
  /** 可注入同契约传输层；缺省连接真实本机 Herdr 与 SSH 远端。 */
  herdrTransport?: HerdrTransport;
};

export async function createHelm(options: HelmOptions = {}) {
  const { herdrTransport, ...runtimeOptions } = options;
  const kernel = await KernelRuntime.open({ ...runtimeOptions, autoResume: false });
  let closeWorkflows: (() => Promise<void>) | undefined;
  try {
    await kernel.plugins.register(createAssistantPlugin(kernel));
    const workflows = new WorkflowService({
      dataDir: kernel.dataDir,
      state: kernel.documentStore,
      redact: (text) => kernel.stash.redact(text),
      host: {
        spawnAgent: (request) => kernel.spawnAgent(request),
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
      },
    });
    closeWorkflows = () => workflows.close();
    await workflows.init();
    kernel.setWorkflowRunProvider(() => workflows.listRuns());
    kernel.setWorkflowRunner(async (request, conversationId) => workflows.run({ ...request, conversationId }));
    await kernel.plugins.register(createHerdrPlugin({
      defaultCwd: runtimeOptions.cwd ?? process.cwd(),
      profiles: kernel.profiles,
      buildSpawnEnv: (id, cwd) => kernel.buildSpawnEnv(id, cwd),
      redact: (text) => kernel.stash.redact(text),
      runLocalGate: (command, context) => kernel.runGate(command, context),
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
