/**
 * host-api: 构造插件视角的 ctx.host 门面。
 * 全部方法显式转发到后端端口，并按功能分组封装：
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
 * 弃置 nodeFetch 响应的计数兜底：调用方拿到 Response 后既不消费也不
 * cancel body（也不持引用）时，包装流的 end 永不触发，插件将永久 409
 * plugin_has_live_tasks 不可停用。FinalizationRegistry 在 Response 被 GC 后
 * 补 end——时机非确定（依赖 GC），是泄漏安全网而非契约替代；调用方仍应
 * 消费或 cancel body（诚实声明：紧随弃置的 disable 可能仍短暂 409）。
 */
const abandonedNodeFetchResponses = new FinalizationRegistry<() => void>((end) => {
  end();
});

/**
 * setConfig 读-合-写串行链（per-plugin）：backend.setPluginConfig 是整值
 * 写入（无原子 read-modify-write 端口），并发 patch 需在本包装层串行化，
 * 否则后写覆盖前写丢更新。
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

  /**
   * 构造 ctx.host.plugins（宿主插件治理端口）：读面与 PluginHost 清单同源；
   * 写面沿用现有生命周期、任务跟踪和包管理端口。自指 update/remove/disable
   * 在进入目标插件队列前拒绝；doctor/install/update/remove 结果统一脱敏。
   */
  const assertPluginsPort = (what: string): BackendPluginsLifecyclePort => {
    guard(`host.plugins.${what}`);
    if (backend.plugins === undefined) {
      throw new HelmError(
        'not_supported',
        `当前宿主未接线插件治理端口（host.plugins.${what} 不可用）`,
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
      `插件 ${pluginId} 不得在自身运行任务中${op === 'update' ? '更新' : op === 'remove' ? '卸载' : '停用'}自身（会触发宿主生命周期队列自等待），请改由人工 HTTP/CLI 或其他插件执行`,
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

    ...(pluginsPort !== undefined ? { plugins: pluginsPort } : {}),

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

    // 3. nodeIpc（nodePlatform 为内核可选能力：NodeRegistry 可信平台上报，
    // 缺席时插件侧远端平台未知，不猜不改写）。
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

    // 3.6 openTunnel：任意 TCP 透传隧道 —— 生命周期跟踪与 Duplex 存活期对齐：
    // begin 在建连前（停用预检可见在途建立）；成功后计数保持到 Duplex
    // close/error/destroy（恰好一次 end）——插件持有活动隧道期间 disable
    // 会被 409 plugin_has_live_tasks 拒绝；建立失败/已 destroyed 立即 end，
    // 绝不泄漏计数。停用/宿主 dispose 时 duplex 本身由 registry/节点的
    // 换代清理链销毁，这里只保证计数不悬挂。
    openTunnel: backend.openTunnel === undefined
      ? ((nodeId: string): Promise<never> => {
          guard(`host.openTunnel:${nodeId}`);
          throw new HelmError(
            'node_tunnel_not_supported',
            `当前宿主未接线节点隧道端口（host.openTunnel(${nodeId}) 不可用）`,
            501,
            { nodeId },
          );
        })
      : (async (nodeId: string, target: { host?: string; port: number }, signal?: AbortSignal) => {
          guard(`host.openTunnel:${nodeId}`);
          const what = `host.openTunnel:${nodeId}`;
          // begin 先于建连：不能用 withTask 包住建立 Promise（那会在 resolve 后
          // 立即 end，Duplex 存活期计数归零，停用门禁形同虚设）。
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

    // 3.5 nodeFetch：受控 fetch —— 每次调用先过周期守卫；返回的 fetch 每次
    // 调用（新流）入任务跟踪并再次守卫（停用/停止窗口拒绝新流）；在途跟踪
    // 覆盖到 Response body EOF/cancel/error（响应头到达不结束任务，SSE
    // 长流不脱离监控）。
    nodeFetch: backend.nodeFetch === undefined
      ? ((nodeId: string): typeof fetch => {
          guard(`host.nodeFetch:${nodeId}`);
          throw new HelmError(
            'node_tunnel_not_supported',
            `当前宿主未接线节点 fetch 端口（host.nodeFetch(${nodeId}) 不可用）`,
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
            const end = (): void => {
              if (ended) return;
              ended = true;
              deps.tracker.end(pluginId, what);
            };
            return Promise.resolve().then(() => raw(input, init)).then((response) => {
              if (response.body === null) {
                end();
                return response;
              }
              try {
                const reader = response.body.getReader();
                const trackedBody = new ReadableStream<Uint8Array>({
                  async pull(controller) {
                    try {
                      const { done, value } = await reader.read();
                      if (done) { end(); controller.close(); return; }
                      if (value !== undefined) controller.enqueue(value);
                    } catch (error) {
                      end();
                      controller.error(error);
                    }
                  },
                  async cancel(reason) {
                    try {
                      await reader.cancel(reason);
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
                // 弃置兜底：Response 不可达后被 GC 时补结束计数（见注册处声明）
                abandonedNodeFetchResponses.register(wrapped, end);
                return wrapped;
              } catch (error) {
                // 包装失败（body 已锁定等）：尽力取消底层流并结束计数，绝不悬挂泄漏
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
    probeNodeFs: (input) => tracked('host.probeNodeFs', () => backend.probeNodeFs(input)),
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
    // 7.5 guarded 变更端口（自动化红线内核执行层）：未接线时显式 501，
    // 绝不静默回退普通 submitInput/abortConversation（那会绕过内核原子复核）。
    submitInputGuarded: (id, text, opts, mutationGuard) => {
      guard('host.submitInputGuarded');
      const port = backend.submitInputGuarded;
      if (port === undefined) {
        throw new HelmError(
          'not_supported',
          '当前宿主未接线自动化 guarded 提交端口（host.submitInputGuarded）',
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
          '当前宿主未接线自动化 guarded 中止端口（host.abortConversationGuarded）',
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
