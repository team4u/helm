import { KernelRuntime } from './runtime/index.js';
import { createProfilePlugin } from './builtin-plugins/profile.js';
import { createMemoryPlugin } from './builtin-plugins/memory.js';
import { createWorkflowPlugin } from './builtin-plugins/workflow.js';
import { createJsonRenderPlugin } from './builtin-plugins/json-render.js';
import { createMermaidPlugin } from './builtin-plugins/mermaid.js';
import { createHerdrPlugin } from './builtin-plugins/herdr.js';
import { createSuperAgentPlugin } from './builtin-plugins/superagent.js';
import { createTriggersPlugin } from './builtin-plugins/triggers.js';
import { createMagpiePlugin } from './builtin-plugins/magpie.js';
import { createAppsPlugin } from './builtin-plugins/apps.js';
import { loadExternalPlugins } from './plugins/external-loader.js';

export type HelmOptions = Omit<NonNullable<Parameters<typeof KernelRuntime.open>[0]>, 'autoResume'>;

/** 组合根只选择插件与缺省启用状态，不提供内置插件专属运行时依赖。 */
export async function createHelm(options: HelmOptions = {}) {
  const kernel = await KernelRuntime.open({ ...options, autoResume: false });
  try {
    await kernel.plugins.register(createProfilePlugin());
    await kernel.plugins.register(createWorkflowPlugin());
    await kernel.plugins.register(createMemoryPlugin());
    await kernel.plugins.register(createJsonRenderPlugin());
    await kernel.plugins.register(createMermaidPlugin());
    await kernel.plugins.register(createAppsPlugin({ hubCwd: options.cwd ?? process.cwd() }));
    await kernel.plugins.register(createTriggersPlugin());
    await kernel.plugins.register(createHerdrPlugin(), { enabled: false });
    await kernel.plugins.register(createSuperAgentPlugin(), { enabled: false });
    await kernel.plugins.register(createMagpiePlugin(), { enabled: false });
    await loadExternalPlugins(kernel.dataDir, kernel.plugins);
    // 全部工具注册后统一 prepare -> start，最后恢复 SDK 调度器。
    await kernel.start();
    return { kernel, close: () => kernel.close() };
  } catch (error) {
    await kernel.close();
    throw error;
  }
}
