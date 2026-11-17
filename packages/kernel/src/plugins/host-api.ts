/**
 * host-api: constructs the plugin-facing `ctx.host` facade forwarding explicitly to backend ports:
 * profiles / skills / nodeIpc / secrets / plugins / env / conversations / agents / asks / events / triggers / actions / artifacts / models.
 */
import {
  HelmError,
  type ActionManifest,
  type BackendPluginsLifecyclePort,
  type HelmHostApi,
  type HelmHostOpenTunnelPort,
  type PluginActionContext,
  type PluginSummary,
  type PluginUiContribution,
} from '@helm/protocol';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { redactJsonValue } from '../redact.js';
import { idempotentRelease } from './shared.js';
import type { PluginTaskTracker } from './tracking.js';
import {
  STOP_WINDOW_HOST_CALLS,
  type PluginHostBackend,
  type PluginHostOptions,
  type PluginState,
} from './types.js';

export interface HostApiDependencies {
  backend: PluginHostBackend;
  tracker: PluginTaskTracker;
  options: PluginHostOptions;
  plugins: Map<string, PluginState>;
  getConfig(pluginId: string): Record<string, unknown>;
  setConfig(pluginId: string, value: Record<string, unknown>): Promise<void>;
  onConfigChanged?: (pluginId: string) => void;
  list(): PluginSummary[];
  listUi(): PluginUiContribution[];
  listActions(): ActionManifest[];
  invokeAction(
    targetPluginId: string,
    actionId: string,
    input: unknown,
    context?: PluginActionContext,
  ): Promise<unknown>;
  prepareAction(
    targetPluginId: string,
    actionId: string,
    input: unknown,
    context?: PluginActionContext,
  ): { idempotent: boolean };
  assertContextUsable(state: PluginState, epoch: number, what: string): void;
}

/**
 * Deterministic resource accounting for `nodeFetch` Response bodies (no GC-based fallback):
 * - Consumed to EOF, canceled via `body.cancel()`/`reader.cancel()`, failed on stream error, or aborted
 *   on host `dispose()`/`close` -> decrements active task counter;
 * - Abandoned without consuming or canceling -> keeps counter alive, blocking `disable`/`reload` with
 *   `409 plugin_has_live_tasks`. Headers alone do not settle the task (SSE streams stay tracked throughout).
 */

/** Per-plugin read-modify-write chain for `setConfig` (serializes concurrent patches over whole-value `setPluginConfig`). */
const pluginConfigWriteChains = new Map<string, Promise<unknown>>();

function enqueuePluginConfigWrite(pluginId: string, op: () => Promise<void>): Promise<void> {
  const prev = pluginConfigWriteChains.get(pluginId) ?? Promise.resolve();
  const run = prev.then(op, op);
  const tail = run.then(
    () => {},
    () => {},
  );
  pluginConfigWriteChains.set(pluginId, tail);
  void tail.then(() => {
    if (pluginConfigWriteChains.get(pluginId) === tail) pluginConfigWriteChains.delete(pluginId);
  });
  return run;
}

/**
 * Controlled `ExecutionEnv` proxy: validates epoch on every method call (invalidated on disable/re-enable)
 * and tracks async calls via `PluginTaskTracker`, preserving full `ExecutionEnv` method signatures.
 */
export function createControlledExecutionEnv(
  state: PluginState,
  epoch: number,
  env: ExecutionEnv,
  deps: Pick<HostApiDependencies, 'assertContextUsable' | 'tracker'>,
): ExecutionEnv {
  const pluginId = state.definition.id;
  return new Proxy(env, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const name = String(prop);
      const fn = value as (...args: unknown[]) => unknown;
      const wrapped = (...args: unknown[]): unknown => {
        deps.assertContextUsable(state, epoch, `host.executionEnv.${name}`);
        const result = fn.apply(target, args);
        if (result instanceof Promise) {
          return deps.tracker.withTask(pluginId, `host.executionEnv.${name}`, () => result);
        }
        return result;
      };
      Object.defineProperty(wrapped, 'name', { value: name, configurable: true });
      return wrapped;
    },
  });
}

/**
 * Constructs `ctx.host`: forwards every method to backend ports, wraps lifecycle resources
 * (`manageConversation` / `onEvent` / `registerAskSeqResolver`) with epoch guards and idempotent release,
 * and tracks in-flight event callbacks in `PluginTaskTracker`.
 */
export function wrapHostApi(
  state: PluginState,
  epoch: number,
  deps: HostApiDependencies,
): HelmHostApi {
  const pluginId = state.definition.id;
  const backend = deps.backend;

  /**
   * Epoch/lifecycle guard per host call.
   * During `stopWindow`, only `STOP_WINDOW_HOST_CALLS` (reads, cancellations, cleanup IPC, final events)
   * are allowed through — including during host `dispose`; all new-work entry points are rejected.
   */
  const guard = (what: string): void => {
    if (
      state.stopWindow &&
      STOP_WINDOW_HOST_CALLS.has(what) &&
      deps.plugins.get(pluginId) === state &&
      state.epoch === epoch
    ) {
      return;
    }
    deps.assertContextUsable(state, epoch, what);
  };

  /** Wraps async host calls with lifecycle guard + `PluginTaskTracker` tracking. */
  const tracked = <T>(what: string, op: () => Promise<T>): Promise<T> => {
    guard(what);
    return deps.tracker.withTask(pluginId, what, op);
  };

  const acquire =
    (what: string) =>
    (acquireFn: () => () => void): (() => void) => {
      guard(what);
      const release = idempotentRelease(acquireFn());
      state.hostReleases.add(release);
      return () => {
        state.hostReleases.delete(release);
        release();
      };
    };

  /**
   * Constructs `ctx.host.plugins`: reads share `PluginHost` state, writes share lifecycle/task/package ports,
   * self-targeted `update`/`remove`/`disable` fail before entering the plugin queue, and results are redacted.
   */
  const assertPluginsPort = (what: string): BackendPluginsLifecyclePort => {
    guard(`host.plugins.${what}`);
    if (backend.plugins === undefined) {
      throw new HelmError(
        'not_supported',
        `Current host has not wired the plugin governance port (host.plugins.${what} unavailable)`,
        501,
        { what },
      );
    }
    return backend.plugins;
  };

  const assertNotSelfTarget = (op: 'update' | 'remove' | 'disable', targetPluginId: string): void => {
    if (targetPluginId !== pluginId) return;
    throw new HelmError(
      'plugin_self_lifecycle_forbidden',
      `Plugin ${pluginId} cannot ${op} itself from its own task (would deadlock the lifecycle queue); trigger from HTTP/CLI or another plugin`,
      409,
      { pluginId, op },
    );
  };

  const redactPluginOpResult = <T,>(value: T): T => {
    const redactText = deps.options.redactText;
    return redactText ? (redactJsonValue(value, redactText) as T) : value;
  };

  const backendPlugins = backend.plugins as
    | (BackendPluginsLifecyclePort & {
        /** Test/alternate backends may expose their own read snapshots; runtime falls back to PluginHost. */
        list?: () => PluginSummary[]
        listUi?: () => PluginUiContribution[]
      })
    | undefined

  const pluginsPort: HelmHostApi['plugins'] = {
    list: () => {
      guard('host.plugins.list');
      return backendPlugins?.list?.() ?? deps.list();
    },
    listUi: () => {
      guard('host.plugins.listUi');
      return backendPlugins?.listUi?.() ?? deps.listUi();
    },
    doctor: (target) =>
      tracked('host.plugins.doctor', async () =>
        redactPluginOpResult(await assertPluginsPort('doctor').doctorPlugin(target))),
    install: (source, options) =>
      tracked('host.plugins.install', async () =>
        redactPluginOpResult(await assertPluginsPort('install').installPlugin(source, options))),
    update: (targetPluginId) => {
      assertNotSelfTarget('update', targetPluginId);
      return tracked('host.plugins.update', async () =>
        redactPluginOpResult(await assertPluginsPort('update').updatePlugin(targetPluginId)));
    },
    remove: (targetPluginId) => {
      assertNotSelfTarget('remove', targetPluginId);
      return tracked('host.plugins.remove', async () =>
        redactPluginOpResult(await assertPluginsPort('remove').removePlugin(targetPluginId)));
    },
    enable: (targetPluginId) =>
      tracked('host.plugins.enable', async () =>
        assertPluginsPort('enable').enablePlugin(targetPluginId)),
    disable: (targetPluginId, options) => {
      assertNotSelfTarget('disable', targetPluginId);
      return tracked('host.plugins.disable', async () =>
        assertPluginsPort('disable').disablePlugin(targetPluginId, options));
    },
  };

  return {
    get isClosing() {
      return backend.isClosing();
    },

    // 1. profiles
    profiles: {
      list: () => tracked('host.profiles.list', () => backend.profiles.list()),
      get: (id) => tracked('host.profiles.get', () => backend.profiles.get(id)),
      getSystem: (id) => tracked('host.profiles.getSystem', () => backend.profiles.getSystem(id)),
      save: (profile) => tracked('host.profiles.save', () => backend.profiles.save(profile)),
      directory: (id) => tracked('host.profiles.directory', () => backend.profiles.directory(id)),
    },

    // 2. skills
    skills: {
      list: () => tracked('host.skills.list', () => backend.skills.list()),
      readFile: (skillId, path) => tracked('host.skills.readFile', () => backend.skills.readFile(skillId, path)),
      directory: (id) => tracked('host.skills.directory', () => backend.skills.directory(id)),
      ensureSkill: (asset) => tracked('host.skills.ensureSkill', () => backend.skills.ensureSkill(asset, pluginId)),
    },

    // 3. nodeIpc (`nodePlatform` is optional: NodeRegistry reports known platforms, undefined when offline/unreported).
    nodeIpc: backend.nodeIpc === undefined
      ? {
          isOnline: () => {
            guard('host.nodeIpc.isOnline');
            throw new HelmError('node_ipc_unavailable', 'Host does not provide a node IPC channel (EnvFabric not wired)', 501);
          },
          call: () => {
            guard('host.nodeIpc.call');
            throw new HelmError('node_ipc_unavailable', 'Host does not provide a node IPC channel (EnvFabric not wired)', 501);
          },
          subscribe: () => {
            guard('host.nodeIpc.subscribe');
            throw new HelmError('node_ipc_unavailable', 'Host does not provide a node IPC channel (EnvFabric not wired)', 501);
          },
        }
      : {
          isOnline: (nodeId) => {
            guard('host.nodeIpc.isOnline');
            return backend.nodeIpc!.isOnline(nodeId);
          },
          ...(backend.nodeIpc.getNodeHubUrl !== undefined
            ? {
                getNodeHubUrl: (nodeId: string) => {
                  guard('host.nodeIpc.getNodeHubUrl');
                  return backend.nodeIpc!.getNodeHubUrl?.(nodeId);
                },
              }
            : {}),
          ...(backend.nodeIpc.nodePlatform !== undefined
            ? {
                nodePlatform: (nodeId: string): string | undefined => {
                  guard('host.nodeIpc.nodePlatform');
                  return backend.nodeIpc!.nodePlatform?.(nodeId);
                },
              }
            : {}),
          call: (nodeId, input, signal) =>
            tracked(`host.nodeIpc.call`, () => backend.nodeIpc!.call(nodeId, input, signal)),
          subscribe: (nodeId, input, onLine, onClosed, signal) => {
            guard('host.nodeIpc.subscribe');
            const controller = new AbortController();
            let backendStop: (() => void) | undefined;
            let reaped = false;
            const onExternalAbort = () => release();
            const reap = (): void => {
              if (reaped) return;
              reaped = true;
              signal?.removeEventListener('abort', onExternalAbort);
              const stop = backendStop;
              backendStop = undefined;
              stop?.();
            };
            const release = acquire('host.nodeIpc.subscribe')(() => () => {
              controller.abort(signal?.aborted ? signal.reason : undefined);
              reap();
            });
            if (signal?.aborted) onExternalAbort();
            else signal?.addEventListener('abort', onExternalAbort, { once: true });
            const establish = deps.tracker.withTask(pluginId, 'host.nodeIpc.subscribe', async () => {
              const unsubscribe = await backend.nodeIpc!.subscribe(
                nodeId,
                input,
                onLine,
                onClosed,
                controller.signal,
              );
              if (reaped) {
                unsubscribe();
                return release;
              }
              backendStop = unsubscribe;
              return release;
            });
            return establish;
          },
        },

    // 3.6 openTunnel: tracks active Duplex tunnels until close/error/destroy (`disable` rejects with 409).
    openTunnel: backend.openTunnel === undefined
      ? ((nodeId: string): Promise<never> => {
          guard(`host.openTunnel:${nodeId}`);
          throw new HelmError(
            'node_tunnel_not_supported',
            `Current host has not wired the node tunnel port (host.openTunnel(${nodeId}) unavailable)`,
            501,
            { nodeId },
          );
        })
      : (async (nodeId: string, target: { host?: string; port: number }, signal?: AbortSignal) => {
          guard(`host.openTunnel:${nodeId}`);
          const what = `host.openTunnel:${nodeId}`;
          // Begin tracking before dialing rather than around the connect promise so liveTasks covers the Duplex lifetime.
          deps.tracker.begin(pluginId, what);
          let ended = false;
          const end = (): void => {
            if (ended) return;
            ended = true;
            deps.tracker.end(pluginId, what);
          };
          try {
            const duplex = await backend.openTunnel!(nodeId, target, signal);
            const release = (): void => { duplex.destroy(); };
            const onClosed = (): void => {
              duplex.removeListener('close', onClosed);
              duplex.removeListener('error', onClosed);
              state.hostReleases.delete(release);
              end();
            };
            duplex.once('close', onClosed);
            duplex.once('error', onClosed);
            try {
              guard(what);
            } catch (error) {
              duplex.destroy();
              throw error;
            }
            state.hostReleases.add(release);
            if (duplex.destroyed) onClosed();
            return duplex;
          } catch (error) {
            end();
            throw error;
          }
        }) as HelmHostOpenTunnelPort,

    // 3.5 nodeFetch: epoch-guarded fetch tracking response body streams until EOF/cancel/error/dispose.
    nodeFetch: backend.nodeFetch === undefined
      ? ((nodeId: string): typeof fetch => {
          guard(`host.nodeFetch:${nodeId}`);
          throw new HelmError(
            'node_tunnel_not_supported',
            `Current host has not wired the node fetch port (host.nodeFetch(${nodeId}) unavailable)`,
            501,
            { nodeId },
          );
        })
      : ((nodeId: string): typeof fetch => {
          guard(`host.nodeFetch:${nodeId}`);
          const raw = backend.nodeFetch!(nodeId);
          const what = `host.nodeFetch.call:${nodeId}`;
          const controlled = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            guard(what);
            deps.tracker.begin(pluginId, what);
            let ended = false;
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            const hostClose = new AbortController();
            const end = (): void => {
              if (ended) return;
              ended = true;
              deps.tracker.end(pluginId, what);
              state.hostReleases.delete(release);
            };
            let released = false;
            const release = (): void => {
              if (released) return;
              released = true;
              hostClose.abort(
                new HelmError(
                  'plugin_host_disposed',
                  'host already destroy:nodeFetch in-flight request determinism cancel (owned cleanup)',
                  503,
                ),
              );
              // abandon placement body fall back compute: directly end task counter and exhaust force cancel underlying reader.
              if (reader !== undefined) reader.cancel(hostClose.signal.reason).catch(() => {});
              end();
            };
            // a await before register (host dispose arrange empty hostReleases when trigger).
            state.hostReleases.add(release);
            // standard fetch override semantics:init.signal override Request.signal; explicit null
            // clear inherit signal (by override old Request signal abort must not cancel this time invoke).
            const callerSignal: AbortSignal | null | undefined =
              init?.signal !== undefined
                ? init.signal
                : input instanceof Request
                  ? input.signal
                  : undefined;
            const callSignal =
              callerSignal != null
                ? AbortSignal.any([callerSignal, hostClose.signal])
                : hostClose.signal;
            const callInit: RequestInit = { ...init, signal: callSignal };
            return Promise.resolve().then(() => raw(input, callInit)).then((response) => {
              if (response.body === null) {
                end();
                return response;
              }
              try {
                reader = response.body.getReader();
                const trackedBody = new ReadableStream<Uint8Array>({
                  async pull(controller) {
                    try {
                      const { done, value } = await reader!.read();
                      if (done) { end(); controller.close(); return; }
                      if (value !== undefined) controller.enqueue(value);
                    } catch (error) {
                      end();
                      controller.error(error);
                    }
                  },
                  async cancel(reason) {
                    try {
                      await reader!.cancel(reason);
                    } finally {
                      end();
                    }
                  },
                });
                const wrapped = new Response(trackedBody, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
                return wrapped;
              } catch (error) {
                // wrap failed (body already lock etc.): exhaust force cancel underlying stream and end counter, never pending leak leak
                response.body.cancel().catch(() => {});
                end();
                throw error;
              }
            }, (error) => {
              end();
              throw error;
            }) as ReturnType<typeof fetch>;
          }) as typeof fetch;
          return controlled;
        }),

    // 4. secrets
    secrets: {
      get: (key) => tracked('host.secrets.get', () => backend.secrets.get(pluginId, key)),
      set: (key, value) => tracked('host.secrets.set', () => backend.secrets.set(pluginId, key, value)),
      delete: (key) => tracked('host.secrets.delete', () => backend.secrets.delete(pluginId, key)),
      addRedaction: (value) =>
        acquire('host.secrets.addRedaction')(() => backend.secrets.addRedaction(value)),
    },

    // 5. configuration & plugins
    setConfig: async (patch) => {
      guard('host.setConfig');
      return enqueuePluginConfigWrite(pluginId, async () => {
        const current = deps.getConfig(pluginId);
        await backend.setPluginConfig(pluginId, { ...current, ...patch });
        deps.onConfigChanged?.(pluginId);
      });
    },
    plugins: pluginsPort,
    listPlugins: () => {
      guard('host.listPlugins');
      return deps.list();
    },
    listUi: () => {
      guard('host.listUi');
      return deps.listUi();
    },
    refreshModels: (options) => tracked('host.refreshModels', () => backend.refreshModels(options)),

    // 6. environment & file mutations
    withFileLock: <T,>(path: string, fn: () => Promise<T>, opts?: { signal?: AbortSignal }) => {
      guard('host.withFileLock');
      return deps.tracker.withTask(pluginId, 'host.withFileLock', () =>
        backend.withFileLock(path, async () => {
          guard('host.withFileLock.fn');
          return fn();
        }, opts),
      );
    },
    atomicWriteFile: (path, content) => tracked('host.atomicWriteFile', () => backend.atomicWriteFile(path, content)),
    redact: (text) => {
      guard('host.redact');
      return backend.redact(text);
    },
    executionEnv: (nodeId, cwd) => {
      guard('host.executionEnv');
      return createControlledExecutionEnv(state, epoch, backend.executionEnv(nodeId, cwd), deps);
    },
    execEnv: async (req, opts) => {
      guard('host.execEnv');
      return deps.tracker.withTask(pluginId, 'host.execEnv', () =>
        Promise.resolve(backend.execEnv(req, opts)),
      );
    },
    withFileMutationQueue: async <T>(
      target: { nodeId: string; cwd: string; path: string },
      fn: () => Promise<T>,
      opts?: { signal?: AbortSignal },
    ): Promise<T> =>
      deps.tracker.withTask(pluginId, `host.fileQueue:${target.nodeId}`, async () =>
        backend.withFileMutationQueue<T>(target, async () => {
          deps.assertContextUsable(state, epoch, 'host.withFileMutationQueue(locked)');
          return fn();
        }, opts),
      ),
    inspectNodePathUsage: (input) => tracked('host.inspectNodePathUsage', () => backend.inspectNodePathUsage(input)),

    // 7. triggers & inputs
    dispatchTrigger: (event) => {
      guard('host.dispatchTrigger');
      return deps.tracker.withTask(pluginId, 'host.dispatchTrigger', () =>
        Promise.resolve(backend.dispatchTrigger(event)),
      );
    },
    submitInput: (id, text, opts) => {
      guard('host.submitInput');
      return deps.tracker.withTask(pluginId, 'host.submitInput', () =>
        Promise.resolve(backend.submitInput(id, text, opts)),
      );
    },
    // 7.5 Guarded mutation ports (enforced by kernel): return explicit 501 when unwired; never fall back to unguarded variants.
    submitInputGuarded: (id, text, opts, mutationGuard) => {
      guard('host.submitInputGuarded');
      const port = backend.submitInputGuarded;
      if (port === undefined) {
        throw new HelmError(
          'not_supported',
          'Current host has not wired guarded input submission (host.submitInputGuarded)',
          501,
          { conversationId: id },
        );
      }
      return deps.tracker.withTask(pluginId, 'host.submitInputGuarded', () =>
        Promise.resolve(port(id, text, opts, mutationGuard)),
      );
    },

    // 8. conversations
    createConversation: (init) => tracked('host.createConversation', () => backend.createConversation(init)),
    forkConversation: (id, opts) => tracked('host.forkConversation', () => backend.forkConversation(id, opts)),
    listConversations: (filter) => {
      guard('host.listConversations');
      return backend.listConversations(filter);
    },
    getConversation: (id) => {
      guard('host.getConversation');
      return backend.getConversation(id);
    },
    getConversationDetail: (id, options) =>
      tracked('host.getConversationDetail', () => backend.getConversationDetail(id, options)),
    updateConversation: (id, patch) => tracked('host.updateConversation', () => backend.updateConversation(id, patch)),
    abortConversation: (id) => tracked('host.abortConversation', () => backend.abortConversation(id)),
    abortConversationGuarded: (id, mutationGuard) => {
      guard('host.abortConversationGuarded');
      const port = backend.abortConversationGuarded;
      if (port === undefined) {
        throw new HelmError(
          'not_supported',
          'Current host has not wired guarded abort (host.abortConversationGuarded)',
          501,
          { conversationId: id },
        );
      }
      return deps.tracker.withTask(pluginId, 'host.abortConversationGuarded', () =>
        Promise.resolve(port(id, mutationGuard)),
      );
    },
    getConversationOwnership: (id) => {
      guard('host.getConversationOwnership');
      return backend.getConversationOwnership(id);
    },
    manageConversation: (id) =>
      acquire('host.manageConversation')(() => backend.manageConversation(id, pluginId)),
    markConversationOwnership: (id, owner) => {
      guard('host.markConversationOwnership');
      backend.markConversationOwnership(id, owner);
    },

    // 9. agents & spawn
    buildSpawnEnv: (conversationId, cwd, nodeId, options) => {
      guard('host.buildSpawnEnv');
      return backend.buildSpawnEnv(conversationId, cwd, nodeId, options);
    },
    spawnAgent: (request) => {
      guard('host.spawnAgent');
      return deps.tracker.withTask(pluginId, 'host.spawnAgent', () =>
        Promise.resolve(backend.spawnAgent(request)),
      );
    },
    runGate: (command, options) => tracked('host.runGate', () => backend.runGate(command, options)),
    resolveSpawnTarget: (input) => tracked('host.resolveSpawnTarget', () => backend.resolveSpawnTarget(input)),
    listActiveSpawnExecutions: () => {
      guard('host.listActiveSpawnExecutions');
      return backend.listActiveSpawnExecutions();
    },

    // 10. artifacts & text completion
    listArtifacts: (conversationId) => tracked('host.listArtifacts', () => backend.listArtifacts(conversationId)),
    getArtifact: (artifactId, conversationId) =>
      tracked('host.getArtifact', () => backend.getArtifact(artifactId, conversationId)),
    completeText: (input) => tracked('host.completeText', () => backend.completeText(input)),

    // 11. actions
    invokeAction: async (targetPluginId, actionId, input, context) => {
      guard('host.invokeAction');
      const raw = await deps.tracker.withTask(pluginId, `host.invokeAction:${targetPluginId}.${actionId}`, () =>
        Promise.resolve(deps.invokeAction(targetPluginId, actionId, input, context)),
      );
      const redactText = deps.options.redactText;
      return redactText ? redactJsonValue(raw, redactText) : raw;
    },
    listActions: () => {
      guard('host.listActions');
      return deps.listActions();
    },
    prepareAction: (targetPluginId, actionId, input, context) => {
      guard('host.prepareAction');
      return deps.prepareAction(targetPluginId, actionId, input, context);
    },

    // 12. asks
    createAsk: (spec) => tracked('host.createAsk', () => backend.createAsk(spec)),
    cancelAsk: (askId, reason) => tracked('host.cancelAsk', () => backend.cancelAsk(askId, reason)),
    registerAskSeqResolver: (resolver) =>
      acquire('host.registerAskSeqResolver')(() => backend.registerAskSeqResolver(resolver)),

    // 13. events
    onEvent: (type, listener) =>
      acquire(`host.onEvent:${type}`)(() =>
        backend.onEvent(type, (payload: unknown) =>
          deps.tracker.withTask(pluginId, `event:${type}`, async () => {
            await listener(payload);
          }),
        ),
      ),
    emitEvent: (type, payload, options) => {
      guard('host.emitEvent');
      return backend.emitEvent(type, payload, options);
    },
  };
}
