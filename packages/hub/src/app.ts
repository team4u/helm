import { KernelRuntime, loadExternalPlugins } from '@helm/kernel';
import { createPluginBuildProvider } from '@helm/plugin-build';
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
  // 默认产品组合注入插件构建实现（client.tsx 编译 + 外部 TS 转译）；调用方显式
  //传 options.buildProvider 可整体替换。内核自身不携带 esbuild（机制与工具分离），
  // 未注入时内核对 client UI 与 TS 插件显式拒绝（unsupported_client_build 等）。
  const kernel = await KernelRuntime.open({
    ...options,
    buildProvider: options.buildProvider ?? createPluginBuildProvider(),
    autoResume: false,
  });
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
