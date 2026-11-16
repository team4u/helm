/**
 * host-api: construct plugin perspective ctx.host gate side.
 * all method explicit forwarding to backend port, and by feature can group wrap:
 * profiles / skills / nodeIpc / secrets / plugins / env / conversations / agents / asks / events / triggers / actions / artifacts / models
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
 * nodeFetch abandon placement Response determinism asset ownership (without GC security network):
 *
 * plugin gets wrap Response after to body asset unique converge path:
 * - consume: read system body until EOF(stream self however close)→ counter end;
 * - cancel:response.body.cancel() / reader.cancel()(contains Response construct after abandon placement before
 *   explicit cancel)→ counter end;
 * - transfer failed: underlying stream error → wrap stream error → counter end;
 * - host close/dispose: underlying tunnel split destroy make body stream with error final → counter end,
 *   never pending;
 * - abandon placement (since do not consume also do not cancel): counter keep - - plugin therefore 409
 *   plugin_has_live_tasks cannot deactivate/reload, this is abandon placement not close asset real proxy price,
 *   never use FinalizationRegistry of class non- determinism GC fall back leak leak mask decorate into available.
 * header reach do not end counter (SSE long stream all process in-flight), deactivate/reload hard block assert cannot force,
 * also do not with disable automatically abort bypass 409.
 */

/**
 * setConfig read-together-write serial chain (per-plugin):backend.setPluginConfig is whole value
 * write (without atomic read-modify-write port), concurrency patch must in this wrap layer serial,
 * otherwise after write override before write lose update.
 */
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
 * executionEnv subject to control proxy: each method invoke when re- validate cycle (deactivate/re-enable after old
 * env proxy immediately expires), async operation task trace; never bare return backend original env instance.
 * proxy keep SDK ExecutionEnv complete shape (method level wrap, contains optional method).
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
 * construct plugin perspective ctx.host: all method explicit forwarding to backend port.
 * lifecycle asset (manageConversation / onEvent / registerAskSeqResolver)
 * via acquire wrap:epoch guard + idempotent release + deactivate unify solve except;
 * onEvent each time event call back count in-flight task protect (event type enter task tag).
 */
export function wrapHostApi(
  state: PluginState,
  epoch: number,
  deps: HostApiDependencies,
): HelmHostApi {
  const pluginId = state.definition.id;
  const backend = deps.backend;

  /**
   * each time invoke cycle guard;what diagnose.
   * subject to control stop window exception: this cycle, host is now await this plugin service stop chain during, only
   * STOP_WINDOW_HOST_CALLS(read/cancel/across node clean up/eventually event) let through - - contains
   * dispose already placement disposed split destroy path (assertNotDisposed one and exceeds); the rest
   * invoke (everything new work entry) per refuse, window do not because deactivating all open.
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

  /** async operation unify: first guard again task (deactivate preflight visible, do not blind spot). */
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
   * construct ctx.host.plugins(host plugin governance port): read side and PluginHost manifest same source;
   * write side along use existing lifecycle, task trace and package manage port. self refer update/remove/disable
   * in enter target plugin queue before reject;doctor/install/update/remove result unify redaction.
   */
  const assertPluginsPort = (what: string): BackendPluginsLifecyclePort => {
    guard(`host.plugins.${what}`);
    if (backend.plugins === undefined) {
      throw new HelmError(
        'not_supported',
        `when before host not connect line plugin governance port (host.plugins.${what} unavailable)`,
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
      `plugin ${pluginId} must not in itself run task in${op === 'update' ? 'update' : op === 'remove' ? 'unload' : 'deactivate'}itself (will trigger host lifecycle queue self wait for), please change by human HTTP/CLI or other plugin execute`,
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

    // 3. nodeIpc(nodePlatform is kernel optional capability:NodeRegistry can message platform on report,
    // missing seat when plugin side remote platform unknown, do not guess do not change write).
    nodeIpc: backend.nodeIpc === undefined
      ? {
          isOnline: () => {
            guard('host.nodeIpc.isOnline');
            throw new HelmError('node_ipc_unavailable', 'host not provide node IPC channel (EnvFabric not connect line)', 501);
          },
          call: () => {
            guard('host.nodeIpc.call');
            throw new HelmError('node_ipc_unavailable', 'host not provide node IPC channel (EnvFabric not connect line)', 501);
          },
          subscribe: () => {
            guard('host.nodeIpc.subscribe');
            throw new HelmError('node_ipc_unavailable', 'host not provide node IPC channel (EnvFabric not connect line)', 501);
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

    // 3.6 openTunnel: any TCP pass-through tunnel - - lifecycle trace and Duplex store phase align:
    // begin in create connect before (deactivate preflight visible in-flight establish); after success counter keep to Duplex
    // close/error/destroy(exactly once end) - - plugin hold has activity tunnel during disable
    // will by 409 plugin_has_live_tasks reject; establish failed/already destroyed immediately end,
    // never leak leak counter. deactivate/host dispose when duplex itself by registry/node
    // swap proxy clean up chain destroy, this in only guarantee counter do not pending.
    openTunnel: backend.openTunnel === undefined
      ? ((nodeId: string): Promise<never> => {
          guard(`host.openTunnel:${nodeId}`);
          throw new HelmError(
            'node_tunnel_not_supported',
            `when before host not connect line node tunnel port (host.openTunnel(${nodeId}) unavailable)`,
            501,
            { nodeId },
          );
        })
      : (async (nodeId: string, target: { host?: string; port: number }, signal?: AbortSignal) => {
          guard(`host.openTunnel:${nodeId}`);
          const what = `host.openTunnel:${nodeId}`;
          // begin first at create connect: cannot use withTask package establish Promise(that will in resolve after
          // immediately end,Duplex store phase counter reset to zero, deactivate gate shape same virtual set).
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

    // 3.5 nodeFetch: subject to control fetch- - each time invoke guard + in-flight task trace override to body
    // EOF/cancel/error(header reach do not end task); host close determinism ownership via
    // hostReleases  owned cleanup(only dispose/close trigger;disable because in-flight
    // task 409 cannot force, never borrow disable abort). cancel signal by standard fetch
    // semantics together into (init.signal override Request.signal, explicit null clear inherit).
    nodeFetch: backend.nodeFetch === undefined
      ? ((nodeId: string): typeof fetch => {
          guard(`host.nodeFetch:${nodeId}`);
          throw new HelmError(
            'node_tunnel_not_supported',
            `when before host not connect line node fetch port (host.nodeFetch(${nodeId}) unavailable)`,
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
    // 7.5 guarded change port (automatically hard rule kernel execute layer): not connect line when explicit 501,
    // never static default fall back ordinary submitInput/abortConversation(that will bypass kernel atomic re-check).
    submitInputGuarded: (id, text, opts, mutationGuard) => {
      guard('host.submitInputGuarded');
      const port = backend.submitInputGuarded;
      if (port === undefined) {
        throw new HelmError(
          'not_supported',
          'when before host not connect line automatically guarded commit port (host.submitInputGuarded)',
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
          'when before host not connect line automatically guarded abort port (host.abortConversationGuarded)',
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
