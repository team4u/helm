import { KernelRuntime, loadExternalPlugins } from '@helmx/kernel';
import { createPluginBuildProvider } from '@helmx/plugin-build';
import { createProfilePlugin } from '@helmx/plugins/profile';
import { createWorkflowPlugin } from '@helmx/plugins/workflow';
import { createSwarmPlugin } from '@helmx/plugins/swarm';
import { createMemoryPlugin } from '@helmx/plugins/memory';
import { createJsonRenderPlugin } from '@helmx/plugins/json-render';
import { createMermaidPlugin } from '@helmx/plugins/mermaid';
import { createHerdrPlugin } from '@helmx/plugins/herdr';
import { createSuperAgentPlugin } from '@helmx/plugins/superagent';
import { createTriggersPlugin } from '@helmx/plugins/triggers';
import { createMagpiePlugin } from '@helmx/plugins/magpie';
import { createAppsPlugin } from '@helmx/plugins/apps';
import { createTokenSpeedPlugin } from '@helmx/plugins/token-speed';

export type HelmxOptions = Omit<NonNullable<Parameters<typeof KernelRuntime.open>[0]>, 'autoResume'>;

/** Composition root only selects plugins and their default enabled states, providing no plugin-specific runtime dependencies. */
export async function createHelmx(options: HelmxOptions = {}) {
  // Default product composition injects the plugin build provider (`client.tsx` compilation + external TS transpilation);
  // callers may override via `options.buildProvider`. The kernel itself does not bundle esbuild (separating mechanism from
  // tooling) and explicitly rejects client UI / TS plugins when unwired (`unsupported_client_build`, etc.).
  const kernel = await KernelRuntime.open({
    ...options,
    buildProvider: options.buildProvider ?? createPluginBuildProvider(),
    autoResume: false,
  });
  try {
    // Default-enabled (10): profile (locked), workflow, swarm, memory, json-render, mermaid, apps, triggers, magpie, token-speed.
    await kernel.plugins.register(createProfilePlugin());
    await kernel.plugins.register(createWorkflowPlugin());
    await kernel.plugins.register(createSwarmPlugin());
    await kernel.plugins.register(createMemoryPlugin());
    await kernel.plugins.register(createJsonRenderPlugin());
    await kernel.plugins.register(createMermaidPlugin());
    await kernel.plugins.register(createAppsPlugin({ hubCwd: options.cwd ?? process.cwd() }));
    await kernel.plugins.register(createTriggersPlugin());
    await kernel.plugins.register(createMagpiePlugin());
    await kernel.plugins.register(createTokenSpeedPlugin());
    // Default-disabled (2, opt-in): herdr, superagent.
    await kernel.plugins.register(createHerdrPlugin(), { enabled: false });
    await kernel.plugins.register(createSuperAgentPlugin(), { enabled: false });
    await loadExternalPlugins(kernel.dataDir, kernel.plugins);
    // Run `prepare -> start` across all registered plugins before resuming the SDK scheduler.
    await kernel.start();
    return { kernel, close: () => kernel.close() };
  } catch (error) {
    await kernel.close();
    throw error;
  }
}
