/**
 * 插件默认停用注册 / 启停状态持久化 专项测试。
 *
 * 覆盖（builtin:herdr 默认停用场景的宿主机制）：
 * - register(definition, { enabled: false })：声明仍运行（获得 configSchema），
 *   但服务绝不启动、无 UI、manifest enabled:false、旧 ctx 即刻失效；
 * - 停用态可先 setConfig 再 enable（configSchema 保留不丢）；
 * - enable 成功后持久 true；disable 后持久 false；跨「重启」（新 PluginHost
 *   + 同一持久 store）开关保留：曾持久化过的插件不再回落到声明缺省；
 * - locked 插件恒启用（声明 enabled:false 也强行启用）；
 * - stop 失败 / 持久化失败的双失败显式 JSON-safe 诊断；
 * - 服务声明 liveTasks 的保活闸门：无 tracker 任务时仍阻止 disable/unregister，
 *   任务清空后可停用；liveTasks 异常/非法输出显式报错绝不当空。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigService,
  CredentialService,
} from '../src/services/index.js';
import { HelmPluginConfigStore } from '../src/runtime/plugin-config-store.js';
import { HelmError, type ConversationSummary, type PluginDefinition } from '@helm/protocol';
import {
  PluginHost,
  type PluginDocStore,
  type PluginConfigStore,
  type PluginHostBackend,
} from '../src/plugins/index.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

function makeConversation(id: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'default',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeHostApi(events: string[]): PluginHostBackend & { __payload: Array<{ type: string; payload: unknown }> } {
  const payload: Array<{ type: string; payload: unknown }> = [];
  const api = {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init: { title?: string }) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id: number) => makeConversation(id),
    updateConversation: async (id: number) => makeConversation(id),
    manageConversation: (id: number, pluginId: string) => {
      events.push(`manage:${pluginId}:${id}`);
      return () => events.push(`release:${pluginId}:${id}`);
    },
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered' as const, answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    abortConversation: async () => {},
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    cleanupWorktree: async () => ({ removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false }),
    invokeAction: async () => ({}),
    listActions: () => [],
    emitEvent: (type: string, p: unknown) => {
      events.push(`event:${type}`);
      payload.push({ type, payload: p });
    },
  };
  return Object.assign(api, { __payload: payload }) as PluginHostBackend & { __payload: typeof payload };
}

/** 事件载荷记录器（plugin.changed 断言用）。 */
function payloadRecorder(hostApi: PluginHostBackend): Array<{ type: string; payload: unknown }> {
  return (hostApi as PluginHostBackend & { __payload?: Array<{ type: string; payload: unknown }> }).__payload ?? [];
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>();
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial;
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value));
  }

  async flush(): Promise<void> {}
}

/**
 * 内存启停持久化 store：模拟 KernelRuntime 重启（同一 store 对象跨 host 复用
 * 等价于 config.json 落盘后重读；另有真实文件 store 测试覆盖落盘格式）。
 */
class MemoryToggleStore implements PluginConfigStore {
  enabled = new Map<string, boolean>();
  configs = new Map<string, Record<string, unknown>>();
  failSetEnabled: Error | undefined;
  get(pluginId: string): Record<string, unknown> {
    return { ...(this.configs.get(pluginId) ?? {}) };
  }
  set(pluginId: string, value: Record<string, unknown>): void {
    this.configs.set(pluginId, { ...value });
  }
  getEnabled(pluginId: string): boolean | undefined {
    return this.enabled.get(pluginId);
  }
  async setEnabled(pluginId: string, on: boolean): Promise<void> {
    if (this.failSetEnabled) throw this.failSetEnabled;
    this.enabled.set(pluginId, on);
  }
}

let dataDir: string;
let docs: MemoryDocStore;
let events: string[];
let recorder: Array<{ type: string; payload: unknown }>;

function makeHost(config?: PluginConfigStore): PluginHost {
  const api = makeHostApi(events);
  recorder = api.__payload;
  return new PluginHost({ dataDir, host: api, docs, config });
}

/** 声明服务启动/停止均记录的插件定义工厂。 */
function servicePlugin(
  id: string,
  opts: {
    onStart?: () => void;
    onStop?: () => void;
    liveTasks?: () => string[];
    locked?: boolean;
  } = {},
): PluginDefinition {
  return {
    id,
    ...(opts.locked ? { locked: true } : {}),
    definePlugin: (ctx) => {
      ctx.configSchema({ endpoint: { type: 'string', label: '端点' } });
      ctx.ui.sidebarItem({ id: 'nav', label: '导航' });
      ctx.hook.onTrigger(() => ({ action: 'continue' as const }));
      ctx.action({
        id: 'ping',
        description: '探活',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({ ok: true }),
      });
      void ctx.host.manageConversation(7);
      ctx.service({
        id: 'daemon',
        start: () => opts.onStart?.(),
        stop: () => opts.onStop?.(),
        ...(opts.liveTasks ? { liveTasks: opts.liveTasks } : {}),
      });
    },
  };
}

function pluginChangedPayloads(recorder: Array<{ type: string; payload: unknown }>) {
  return recorder
    .filter((e) => e.type === 'plugin.changed')
    .map((e) => e.payload as { plugin: { id: string; enabled: boolean }; ui: unknown[] });
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<HelmError> {
  let caught: HelmError | undefined;
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`);
    assert.equal(err.code, code);
    caught = err;
    return true;
  });
  assert.ok(caught instanceof HelmError);
  return caught;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-plugin-toggle-test-'));
  docs = new MemoryDocStore();
  events = [];
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 默认停用注册：不连外部服务、无 UI、schema 可用、ctx 即刻失效
// ---------------------------------------------------------------------------

test('enabled:false 注册：声明运行获得 schema，但服务不启动、无 UI、动作拒绝、旧 ctx 失效', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const started: string[] = [];
  let stolen: Parameters<NonNullable<PluginDefinition['definePlugin']>>[0] | undefined;

  await host.register(
    servicePlugin('builtin:herdr', { onStart: () => started.push('start') }),
    { enabled: false },
  );

  // 服务绝不启动（默认停用 = 不连外部 Herdr 服务）
  assert.deepEqual(started, []);
  // manifest：enabled:false 且 hooks/actions/tools 全空
  const summary = host.list().find((p) => p.id === 'builtin:herdr')!;
  assert.equal(summary.enabled, false);
  assert.deepEqual(summary.hooks, []);
  assert.deepEqual(summary.actions, []);
  assert.deepEqual(summary.tools, []);
  // UI 贡献为空（emitPluginChanged 的 ui:[] 与 listUi 一致）
  assert.deepEqual(host.listUi(), []);
  assert.deepEqual(host.listRoutes(), []);
  // 动作/工具在停用态拒绝
  await rejectsCode(host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
  // runHook 无参与者直通
  const r = await host.runHook('trigger', {
    id: 'e1',
    source: 'test',
    text: 'x',
    createdAt: 1,
  });
  assert.equal(r.action, 'continue');
  // 注册即发 plugin.changed（enabled:false / ui:[]）
  // （recorder 与 events 共享，见 makeHostApi 实现）
  // configSchema 保留（停用态可读）
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  // 宿主生命周期资源（manageConversation）在停用注册路径已释放
  assert.ok(events.includes('release:builtin:herdr:7'));
  // 旧 definePlugin 上下文已关闭（epoch 递增废黜）
  await host.register(
    {
      id: 'probe:ctx',
      definePlugin: (ctx) => {
        void ctx;
      },
    },
  );
  void stolen;
  // 直接断言 stolen ctx：重新注册一个真正偷 ctx 的插件
  await host.unregister('probe:ctx');
  await host.register(
    {
      id: 'probe:ctx',
      definePlugin: (ctx) => {
        stolen = ctx;
      },
    },
  );
  await host.disable('probe:ctx');
  assert.throws(
    () => stolen!.configSchema({ a: { type: 'string' } }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_closed',
  );
});

test('停用注册路径的 plugin.changed 事件：enabled:false 且 ui:[]', { timeout: 60_000 }, async () => {
  const host = makeHost(new MemoryToggleStore());
  const rec = recorder;
  await host.register(servicePlugin('builtin:herdr'), { enabled: false });
  const changed = pluginChangedPayloads(rec);
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.plugin.id, 'builtin:herdr');
  assert.equal(changed[0]!.plugin.enabled, false);
  assert.deepEqual(changed[0]!.ui, []);
});

// ---------------------------------------------------------------------------
// 先配置再启用（configSchema 不因 disable 丢失）
// ---------------------------------------------------------------------------

test('停用态先 setConfig 再 enable：配置生效、definePlugin getConfig 读到、服务启动', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const started: string[] = [];
  let configSeenInDefine: Record<string, unknown> | undefined;

  await host.register(
    {
      id: 'builtin:herdr',
      definePlugin: (ctx) => {
        ctx.configSchema({ endpoint: { type: 'string', required: true, label: '端点' } });
        configSeenInDefine = ctx.getConfig();
        ctx.service({
          id: 'daemon',
          start: () => {
            started.push('start');
          },
          stop: () => {
            started.push('stop');
          },
        });
      },
    },
    { enabled: false },
  );

  // 停用态即可配置（schema 保留是前提）
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  await host.setConfig('builtin:herdr', { endpoint: 'unix:///tmp/herdr.sock' });
  assert.equal(store.get('builtin:herdr')['endpoint'], 'unix:///tmp/herdr.sock');

  // enable：服务启动、definePlugin 读到已持久配置、持久 true
  await host.enable('builtin:herdr');
  assert.deepEqual(started, ['start']);
  assert.equal(configSeenInDefine!['endpoint'], 'unix:///tmp/herdr.sock');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);

  // disable 后 schema 仍保留，可再次改配置（供下次启用）
  await host.disable('builtin:herdr');
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  await host.setConfig('builtin:herdr', { endpoint: 'unix:///tmp/other.sock' });
  assert.equal(store.enabled.get('builtin:herdr'), false);
});

test('disable 清空运行期注册但保留 configSchema：与停用注册落位形态一致', { timeout: 60_000 }, async () => {
  const host = makeHost(new MemoryToggleStore());
  await host.register(servicePlugin('builtin:herdr'));
  assert.equal(host.listUi().length, 1);
  await host.disable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.deepEqual(host.listUi(), []);
  assert.deepEqual(host.listRoutes(), []);
  // schema 保留
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
});

// ---------------------------------------------------------------------------
// 跨重启开关保留（内存 store 模拟 + 真实文件 store 落盘）
// ---------------------------------------------------------------------------

test('跨重启开关保留（内存 store）：disable 后新 host register(缺省) 仍停用；enable 后重启仍启用', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const h1 = makeHost(store);
  await h1.register(servicePlugin('builtin:herdr'), { enabled: false });
  await h1.enable('builtin:herdr');
  assert.equal(store.enabled.get('builtin:herdr'), true);

  // 「重启」：新 PluginHost 共享同一持久 store；声明 enabled:false 也不再生效
  const h2 = makeHost(store);
  const started2: string[] = [];
  await h2.register(
    servicePlugin('builtin:herdr', { onStart: () => started2.push('start') }),
    { enabled: false },
  );
  assert.equal(h2.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.deepEqual(started2, ['start'], '持久 true 时重启必须启动服务');

  // disable 后重启：声明缺省（enabled 默认 true）也保持停用
  await h2.disable('builtin:herdr');
  const h3 = makeHost(store);
  const started3: string[] = [];
  await h3.register(
    servicePlugin('builtin:herdr', { onStart: () => started3.push('start') }),
  );
  assert.equal(h3.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.deepEqual(started3, [], '持久 false 时重启绝不启动服务');
});

test('从未持久化时不写默认值：register 后 store 无记录，纯内存 host 行为不变', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  await host.register(servicePlugin('p:fresh'));
  assert.equal(host.list().find((p) => p.id === 'p:fresh')!.enabled, true);
  assert.equal(store.enabled.has('p:fresh'), false, 'register 不写默认启停值');
  // 纯内存 host（无 store）：启停不持久化，语义保持既有
  const bare = makeHost();
  await bare.register(servicePlugin('p:bare'), { enabled: false });
  assert.equal(bare.list().find((p) => p.id === 'p:bare')!.enabled, false);
  await bare.enable('p:bare');
  await bare.disable('p:bare');
  assert.equal(bare.list().find((p) => p.id === 'p:bare')!.enabled, false);
});

test('HelmPluginConfigStore：pluginEnabled 独立落盘 config.json，与 plugins 配置/credentials 分离，跨实例重启保留', { timeout: 60_000 }, async () => {
  const credentialsDir = join(dataDir, 'cred');
  mkdirSync(credentialsDir, { recursive: true });
  const config = new ConfigService(dataDir);
  const credentials = new CredentialService(credentialsDir);
  const store = new HelmPluginConfigStore({ config, credentials });
  await store.load();

  assert.equal(store.getEnabled('builtin:herdr'), undefined, '从未持久化返回 undefined');

  // 与既有 plugins 配置、credentials 共存同一 config.json：互不干扰
  await store.setEnabled('builtin:herdr', false);
  await store.setEnabled('builtin:assistant', true);
  await store.set('builtin:herdr', { endpoint: 'unix:///x' }, { endpoint: { type: 'string' } });

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'builtin:herdr': false, 'builtin:assistant': true });
  assert.deepEqual(raw['plugins'], { 'builtin:herdr': { endpoint: 'unix:///x' } }, 'pluginEnabled 与 plugins 配置分离');

  // 新实例（模拟重启）：load 预热后 getEnabled 同步可读
  const store2 = new HelmPluginConfigStore({ config: new ConfigService(dataDir), credentials: new CredentialService(credentialsDir) });
  await store2.load();
  assert.equal(store2.getEnabled('builtin:herdr'), false);
  assert.equal(store2.getEnabled('builtin:assistant'), true);
  assert.equal(store2.getEnabled('p:unknown'), undefined);
  assert.equal(store2.get('builtin:herdr')['endpoint'], 'unix:///x');
});

test('HelmPluginConfigStore load：pluginEnabled 非法结构/非布尔值显式 config_corrupt，绝不静默忽略', { timeout: 60_000 }, async () => {
  const credentialsDir = join(dataDir, 'cred');
  mkdirSync(credentialsDir, { recursive: true });
  const write = (content: unknown) =>
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify(content), 'utf8');

  write({ pluginEnabled: ['nope'] });
  await assert.rejects(
    new HelmPluginConfigStore({ config: new ConfigService(dataDir), credentials: new CredentialService(credentialsDir) }).load(),
    (err: unknown) => err instanceof HelmError && err.code === 'config_corrupt',
  );

  write({ pluginEnabled: { 'builtin:herdr': 'yes' } });
  await assert.rejects(
    new HelmPluginConfigStore({ config: new ConfigService(dataDir), credentials: new CredentialService(credentialsDir) }).load(),
    (err: unknown) => err instanceof HelmError && err.code === 'config_corrupt',
  );
});

test('HelmPluginConfigStore setEnabled：非布尔入参 400 validation_error，不触盘', { timeout: 60_000 }, async () => {
  const credentialsDir = join(dataDir, 'cred');
  mkdirSync(credentialsDir, { recursive: true });
  const store = new HelmPluginConfigStore({ config: new ConfigService(dataDir), credentials: new CredentialService(credentialsDir) });
  await store.load();
  await assert.rejects(
    store.setEnabled('p:x', 'true' as unknown as boolean),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
  );
  assert.equal(existsSync(join(dataDir, 'config.json')), false);
});

// ---------------------------------------------------------------------------
// locked 保护
// ---------------------------------------------------------------------------

test('locked 插件恒启用：声明 enabled:false 也强行启用，disable 403', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const started: string[] = [];
  await host.register(
    servicePlugin('builtin:assistant', { onStart: () => started.push('start'), locked: true }),
    { enabled: false },
  );
  assert.equal(host.list().find((p) => p.id === 'builtin:assistant')!.enabled, true);
  assert.deepEqual(started, ['start']);
  await rejectsCode(host.disable('builtin:assistant'), 'plugin_locked');
  // locked 未持久化任何启停值（disable 被拒不产生写副作用）
  assert.equal(store.enabled.has('builtin:assistant'), false);
});

// ---------------------------------------------------------------------------
// 双失败诊断：stop 失败 / 持久化失败
// ---------------------------------------------------------------------------

test('disable 持久化失败：实际已停用仍发真实 plugin.changed(enabled:false, ui:[])，诊断显式上抛且可 JSON 序列化', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  store.failSetEnabled = new Error('磁盘只读');
  const host = makeHost(store);
  await host.register(servicePlugin('builtin:herdr'));
  assert.equal(host.listUi().length, 1);

  const rec = recorder;
  const before = pluginChangedPayloads(rec).length;
  const err = await rejectsCode(host.disable('builtin:herdr'), 'plugin_enabled_persist_failed');
  assert.equal(err.status, 500);
  assert.match(err.message, /磁盘只读/);
  assert.doesNotThrow(() => JSON.stringify(err.details));

  // 实际状态：已停用、UI 清空、事件已发（真实状态帧）
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.deepEqual(host.listUi(), []);
  const changed = pluginChangedPayloads(rec);
  assert.equal(changed.length, before + 1);
  assert.equal(changed.at(-1)!.plugin.enabled, false);
  assert.deepEqual(changed.at(-1)!.ui, []);
});

test('disable stop 与持久化双失败：stop 诊断为主链，persistError 聚合进 details', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  store.failSetEnabled = new Error('盘满了');
  const host = makeHost(store);
  await host.register(
    servicePlugin('builtin:herdr', {
      onStop: () => {
        throw new Error('svc 炸了');
      },
    }),
  );
  const rec = recorder;
  const before = pluginChangedPayloads(rec).length;
  const err = await rejectsCode(host.disable('builtin:herdr'), 'plugin_service_stop_failed');
  const details = err.details as {
    stopErrors: Array<{ serviceId: string; error: { message: string } }>;
    persistError: { message: string };
  };
  assert.deepEqual(
    details.stopErrors.map((e) => [e.serviceId, e.error.message]),
    [['daemon', 'svc 炸了']],
  );
  assert.doesNotThrow(() => JSON.stringify(err.details));
  // 持久化失败原始信息保留（包在 persistError 诊断里）
  assert.match(JSON.stringify(err.details), /盘满了/);
  // 状态已停用且事件已发（三重收尾不丢真实状态帧）
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.equal(pluginChangedPayloads(rec).length, before + 1);
});

test('enable 持久化失败：回滚为停用、不发布 enabled 事件、可再 enable，诊断显式', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  await host.register(servicePlugin('builtin:herdr'), { enabled: false });

  store.failSetEnabled = new Error('网络盘断开');
  const rec = recorder;
  const before = pluginChangedPayloads(rec).length;
  const err = await rejectsCode(host.enable('builtin:herdr'), 'plugin_enabled_persist_failed');
  assert.match(err.message, /网络盘断开/);
  assert.doesNotThrow(() => JSON.stringify(err.details));

  // 回滚：停用、服务已 stop、无 enabled:true 事件帧
  const summary = host.list().find((p) => p.id === 'builtin:herdr')!;
  assert.equal(summary.enabled, false);
  const changed = pluginChangedPayloads(rec);
  assert.equal(changed.length, before, 'enable 失败不发布任何 plugin.changed');

  // 恢复后可再次 enable 成功
  store.failSetEnabled = undefined;
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

// ---------------------------------------------------------------------------
// 服务声明 liveTasks 保活闸门
// ---------------------------------------------------------------------------

test('liveTasks 声明保活任务：无 tracker 在途任务时仍拒绝 disable/unregister，任务清空后可停用', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const panes = new Set<string>();
  await host.register(
    servicePlugin('builtin:herdr', { liveTasks: () => [...panes].map((p) => `pane:${p}`) }),
  );

  panes.add('win-1');
  const err = await rejectsCode(host.disable('builtin:herdr'), 'plugin_has_live_tasks');
  assert.equal(err.status, 409);
  assert.deepEqual((err.details as { activeTasks: string[] }).activeTasks, ['pane:win-1']);
  // 拒绝路径不产生任何副作用：未 stop、未持久化、状态未变
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.has('builtin:herdr'), false);
  const errU = await rejectsCode(host.unregister('builtin:herdr'), 'plugin_has_live_tasks');
  assert.deepEqual((errU.details as { activeTasks: string[] }).activeTasks, ['pane:win-1']);

  // 任务清空后可停用
  panes.clear();
  await host.disable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.equal(store.enabled.get('builtin:herdr'), false);
});

test('liveTasks 异常或非法输出：显式 plugin_live_tasks_check_failed，绝不当空放行', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    servicePlugin('builtin:herdr', {
      liveTasks: () => {
        throw new Error('对账器崩了');
      },
    }),
  );
  const err = await rejectsCode(host.disable('builtin:herdr'), 'plugin_live_tasks_check_failed');
  assert.equal(err.status, 500);
  const details = err.details as { serviceId: string; error: { message: string } };
  assert.equal(details.serviceId, 'daemon');
  assert.equal(details.error.message, '对账器崩了');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true, '检查失败不改变状态');

  // 非法返回类型（非字符串数组）：同样显式报错
  const host2 = makeHost();
  await host2.register(
    servicePlugin('builtin:herdr', {
      liveTasks: (() => ['ok', 42]) as unknown as () => string[],
    }),
  );
  await rejectsCode(host2.disable('builtin:herdr'), 'plugin_live_tasks_check_failed');
});

test('liveTasks 注册校验：非函数显式 invalid_service_spec；未声明/未启动服务不参与检查', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assert.rejects(
    host.register({
      id: 'p:bad',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'svc',
          start: () => {},
          stop: () => {},
          liveTasks: 'not-a-fn' as unknown as () => string[],
        });
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_service_spec',
  );
  assert.equal(host.list().find((p) => p.id === 'p:bad'), undefined, '非法声明注册整体失败');

  // 声明了 liveTasks 但服务未 started（停用注册路径）：不参与闸门，可正常停用态落位
  const host2 = makeHost();
  await host2.register(
    servicePlugin('builtin:herdr', { liveTasks: () => ['ghost'] }),
    { enabled: false },
  );
  assert.equal(host2.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
});

// ---------------------------------------------------------------------------
// epoch / 旧 ctx 失效（停用注册与 enable 重建新周期）
// ---------------------------------------------------------------------------

test('停用注册的旧 ctx 与 enable 后的旧 ctx 均失效：新周期重建', { timeout: 60_000 }, async () => {
  const host = makeHost(new MemoryToggleStore());
  let stolen: Parameters<NonNullable<PluginDefinition['definePlugin']>>[0] | undefined;
  await host.register(
    {
      id: 'builtin:herdr',
      definePlugin: (ctx) => {
        stolen = ctx;
        ctx.configSchema({ endpoint: { type: 'string' } });
      },
    },
    { enabled: false },
  );
  assert.throws(
    () => stolen!.configSchema({ a: { type: 'string' } }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_closed',
  );
  // enable 进入新周期成功；随后 disable 使新周期 ctx 也失效
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  await host.disable('builtin:herdr');
  assert.throws(
    () => stolen!.action({ id: 'x', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, handler: () => ({}) }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_closed',
  );
});

test('register 定义抛错：无论 options.enabled 与否，注册整体回滚移除', { timeout: 60_000 }, async () => {
  const host = makeHost(new MemoryToggleStore());
  const bad: PluginDefinition = {
    id: 'p:boom',
    definePlugin: () => {
      throw new Error('定义崩了');
    },
  };
  await rejectsCode(host.register(bad, { enabled: false }), 'plugin_registration_failed');
  await rejectsCode(host.register(bad), 'plugin_registration_failed');
  assert.equal(host.list().find((p) => p.id === 'p:boom'), undefined);
});
