import { KernelRuntime, loadExternalPlugins } from '@helmx/kernel';
import { createPluginBuildProvider } from '@helmx/plugin-build';
import { createProfilePlugin } from '@helmx/plugins/profile';
import { createWorkflowPlugin } from '@helmx/plugins/workflow';
import { createWorktreePlugin } from '@helmx/plugins/worktree';
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

export type HelmxOptions = Omit<NonNullable<Parameters<typeof KernelRuntime.open>[0]>, 'autoResume'> & {
  /**
   * Two-phase boot switch (default `true` = createHelmx runs `kernel.start()` itself, unchanged for
   * all existing callers). When `false`, the returned kernel is assembled and recovered but NOT
   * started: the composition root should first open the HTTP listener (`startHub`, so `/ws/node`
   * accepts remote-node reconnections) and only then call `kernel.start()` — its bounded node-join
   * grace then waits for recovery-dependent registered nodes before driving plugin recovery and the
   * scheduler (fixes restart recovery racing node reconnection; see kernel `node-join-grace.ts`).
   */
  autoStart?: boolean;
};

/** Composition root only selects plugins and their default enabled states, providing no plugin-specific runtime dependencies. */
export async function createHelmx(options: HelmxOptions = {}) {
  // Default product composition injects the plugin build provider (`client.tsx` compilation + external TS transpilation);
  // callers may override via `options.buildProvider`. The kernel itself does not bundle esbuild (separating mechanism from
  // tooling) and explicitly rejects client UI / TS plugins when unwired (`unsupported_client_build`, etc.).
  const { autoStart = true, ...kernelOptions } = options;
  const kernel = await KernelRuntime.open({
    ...kernelOptions,
    buildProvider: options.buildProvider ?? createPluginBuildProvider(),
    autoResume: false,
  });
  try {
    // Default-enabled (11): profile (locked), workflow, worktree, swarm, memory, json-render, mermaid, apps, triggers, magpie, token-speed.
    await kernel.plugins.register(createProfilePlugin());
    // Registration-order invariant: workflow MUST be registered before worktree. KernelRuntime.start() awaits
    // runtime.started listeners in registration order: workflow first converges leftover child conversations to
    // idle (awaitPreparedChildrenSettled), only then worktree reconciles crashed native leases (otherwise
    // still-settling children would be misjudged as stopped and their leases wrongly reclaimed).
    await kernel.plugins.register(createWorkflowPlugin());
    await kernel.plugins.register(createWorktreePlugin());
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
    // Two-phase boot (autoStart: false) defers this to the entrypoint after the HTTP listener opens.
    if (autoStart) await kernel.start();
    return { kernel, close: () => kernel.close() };
  } catch (error) {
    await kernel.close();
    throw error;
  }
}
