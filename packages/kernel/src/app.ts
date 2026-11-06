import { KernelRuntime } from './runtime/index.js';
import { WorkflowService } from './workflow/index.js';
import { createAssistantPlugin } from './builtin-plugins/assistant.js';
import { redactJsonValue } from './redact.js';

export type HelmOptions = Omit<NonNullable<Parameters<typeof KernelRuntime.open>[0]>, 'autoResume'>;

export async function createHelm(options: HelmOptions = {}) {
  const kernel = await KernelRuntime.open({ ...options, autoResume: false });
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
      },
    });
    await workflows.init();
    kernel.setWorkflowRunner(async (request, conversationId) => workflows.run({ ...request, conversationId }));
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
    await kernel.close();
    throw error;
  }
}
