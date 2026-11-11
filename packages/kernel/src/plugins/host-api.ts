/**
 * host-api: 构造插件视角的 ctx.host 门面。
 * 全部方法显式转发到后端端口，并按功能分组封装：
 * profiles / skills / nodeIpc / secrets / env / conversations / agents / asks / events / triggers / actions / artifacts / models
 */
import {
  HelmError,
  type ActionManifest,
  type HelmHostApi,
  type PluginActionContext,
  type PluginUiContribution,
  type PluginSummary,
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
 * executionEnv 受控代理：每个方法调用时重新校验周期（停用/re-enable 后旧
 * env 代理立即失效），异步操作入任务跟踪；绝不裸返回 backend 原始 env 实例。
 * 代理保留 SDK ExecutionEnv 完整形状（方法级包装，含可选方法）。
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
 * 构造插件视角的 ctx.host：全部方法显式转发到后端端口。
 * 生命周期资源（manageConversation / onEvent / registerAskSeqResolver）
 * 经 acquire 包装：epoch 守卫 + 幂等释放 + 停用统一解除；
 * onEvent 的每次事件回调计入在途任务保护（事件类型进任务标签）。
 */
export function wrapHostApi(
  state: PluginState,
  epoch: number,
  deps: HostApiDependencies,
): HelmHostApi {
  const pluginId = state.definition.id;
  const backend = deps.backend;

  /**
   * 每次调用的周期守卫；what 入诊断。
   * 受控停止窗口例外：本周期、宿主正在 await 本插件服务 stop 链期间，仅
   * STOP_WINDOW_HOST_CALLS（读取/取消/跨节点清理/最终事件）放行——含
   * dispose 已置 disposed 的拆毁路径（assertNotDisposed 一并越过）；其余
   * 调用（一切新工作入口）照拒，窗口不因 deactivating 全开。
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

  /** 异步操作统一：先守卫再入任务（停用预检可见，不留盲区）。 */
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

    // 3. nodeIpc
    nodeIpc: backend.nodeIpc === undefined
      ? {
          isOnline: () => {
            guard('host.nodeIpc.isOnline');
            throw new HelmError('node_ipc_unavailable', '宿主未提供节点 IPC 通道（EnvFabric 未接线）', 501);
          },
          call: () => {
            guard('host.nodeIpc.call');
            throw new HelmError('node_ipc_unavailable', '宿主未提供节点 IPC 通道（EnvFabric 未接线）', 501);
          },
          subscribe: () => {
            guard('host.nodeIpc.subscribe');
            throw new HelmError('node_ipc_unavailable', '宿主未提供节点 IPC 通道（EnvFabric 未接线）', 501);
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
      const current = deps.getConfig(pluginId);
      await backend.setPluginConfig(pluginId, { ...current, ...patch });
    },
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
    probeNodeFs: (input) => tracked('host.probeNodeFs', () => backend.probeNodeFs(input)),

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

    // 8. conversations
    createConversation: (init) => tracked('host.createConversation', () => backend.createConversation(init)),
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
    getConversationOwnership: (id) => {
      guard('host.getConversationOwnership');
      return backend.getConversationOwnership(id);
    },
    getConversationActivity: (id) => {
      guard('host.getConversationActivity');
      return backend.getConversationActivity(id);
    },
    manageConversation: (id) =>
      acquire('host.manageConversation')(() => backend.manageConversation(id, pluginId)),
    markConversationOwnership: (id, owner) => {
      guard('host.markConversationOwnership');
      backend.markConversationOwnership(id, owner);
    },

    // 9. agents & spawn
    buildSpawnEnv: (conversationId, cwd, nodeId) => {
      guard('host.buildSpawnEnv');
      return backend.buildSpawnEnv(conversationId, cwd, nodeId);
    },
    spawnAgent: (request) => {
      guard('host.spawnAgent');
      return deps.tracker.withTask(pluginId, 'host.spawnAgent', () =>
        Promise.resolve(backend.spawnAgent(request)),
      );
    },
    runGate: (command, options) => tracked('host.runGate', () => backend.runGate(command, options)),
    prepareInterruptedConversations: (ids) =>
      tracked('host.prepareInterruptedConversations', () => backend.prepareInterruptedConversations(ids)),
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
    redactText: (text) => {
      guard('host.redactText');
      return backend.redactText(text);
    },

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
