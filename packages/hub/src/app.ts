import { KernelRuntime, loadExternalPlugins } from '@helm/kernel';
import {
  createProfilePlugin,
  createWorkflowPlugin,
  createMemoryPlugin,
  createJsonRenderPlugin,
  createMermaidPlugin,
  createHerdrPlugin,
  createSuperAgentPlugin,
  createTriggersPlugin,
  createMagpiePlugin,
  createAppsPlugin,
} from '@helm/plugins';

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
