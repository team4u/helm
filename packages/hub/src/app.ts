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
  createTokenSpeedPlugin,
} from '@helm/plugins';

export type HelmOptions = Omit<NonNullable<Parameters<typeof KernelRuntime.open>[0]>, 'autoResume'>;

/** composition root only choose plugin and default enable state, do not provide built-in plugin dedicated belong runtime dependency. */
export async function createHelm(options: HelmOptions = {}) {
  // by default produce product combine inject plugin build implement (client.tsx compile + external TS transpile); caller explicit
  //pass options.buildProvider can whole replace. kernel itself does not carry esbuild(mechanism and tool separate),
  // not inject when kernel for client UI and TS plugin explicit reject (unsupported_client_build etc.).
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
    await kernel.plugins.register(createTokenSpeedPlugin(), { enabled: false });
    await loadExternalPlugins(kernel.dataDir, kernel.plugins);
    // all tool register after unify prepare -> start, finally restore SDK scheduler.
    await kernel.start();
    return { kernel, close: () => kernel.close() };
  } catch (error) {
    await kernel.close();
    throw error;
  }
}
