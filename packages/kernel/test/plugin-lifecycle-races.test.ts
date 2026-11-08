/**
 * 插件生命周期竞态回归（确定性，不依赖 sleep 竞速）：
 *
 * 1. enable 的对外提交点在启停持久化成功之后：服务已启动、落盘挂起期间
 *    保持 defining——action 拒绝 / hook 不执行 / UI 不露出；成功后可用，
 *    持久化失败时无在途任务、干净回滚（经 store setEnabled 注入 deferred 门控）。
 * 2. register 的持久启停读取先于一切资源获取：getEnabled 抛错（原错误保留）
 *    或返回非布尔值（显式拒绝）时注册表/钩子/托管资源/数据目录零残留。
 * 3. HelmPluginConfigStore 读-改-写全程在 ConfigService.update 同一把文件锁内
 *    以回调完成：只更新所属嵌套键，不覆盖其他模块在间隙更新的键（经
 *    InterposingConfigService 在 update 入口确定性插入并发写，锁外无等待、
 *    锁内无第二个 getter，无死锁）；写时 pluginEnabled 损坏显式 config_corrupt，
 *    绝不用 {} 重建。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService, CredentialService } from '../src/services/index.js';
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

function makeHostApi(events: string[]): PluginHostBackend {
  return {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    updateConversation: async (id) => makeConversation(id),
    manageConversation: (id, pluginId) => {
      events.push(`manage:${pluginId}:${id}`);
      return () => events.push(`release:${pluginId}:${id}`);
    },
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered' as const, answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onWorkflowSettled: () => () => {},
    emitEvent: (type) => {
      events.push(`event:${type}`);
    },
  };
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>();
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial;
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value));
  }
}

/**
 * 可门控启停持久化的内存 store：onSetEnabled 在真正落定前被调用，
 * 测试用它构造「持久化挂起」窗口（确定性 deferred，无 sleep）。
 */
class GatedStore implements PluginConfigStore {
  enabled = new Map<string, boolean>();
  configs = new Map<string, Record<string, unknown>>();
  onSetEnabled: (pluginId: string, enabled: boolean) => Promise<void> | void = () => {};
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
    await this.onSetEnabled(pluginId, on);
    this.enabled.set(pluginId, on);
  }
}

/** 全量声明（UI/动作/钩子/服务/托管资源）的插件工厂。 */
function fullPlugin(id: string, marks: string[]): PluginDefinition {
  return {
    id,
    definePlugin: (ctx) => {
      ctx.configSchema({ endpoint: { type: 'string', label: '端点' } });
      ctx.ui.sidebarItem({ id: 'nav', label: '导航' });
      ctx.hook.onTrigger(() => {
        marks.push('hook-ran');
        return { action: 'continue' as const };
      });
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
        start: () => {
          marks.push('svc-start');
        },
        stop: () => {
          marks.push('svc-stop');
        },
      });
    },
  };
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

function triggerPayload(id = 'e1') {
  return { id, source: 'test', text: 'x', createdAt: 1 };
}

let dataDir: string;
let docs: MemoryDocStore;
let events: string[];

function makeHost(config?: PluginConfigStore): PluginHost {
  return new PluginHost({ dataDir, host: makeHostApi(events), docs, config });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-plugin-races-test-'));
  docs = new MemoryDocStore();
  events = [];
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. enable 提交点在启停持久化成功之后
// ---------------------------------------------------------------------------

test('enable 持久化挂起窗口：服务已启动但 action 拒绝/hook 不执行/UI 不露出；成功后可用', { timeout: 60_000 }, async () => {
  const store = new GatedStore();
  const host = makeHost(store);
  const marks: string[] = [];
  await host.register(fullPlugin('builtin:herdr', marks), { enabled: false });

  // 门控：setEnabled 进入后挂起，直到测试显式放行（确定性窗口）
  let signalEntered!: () => void;
  const entered = new Promise<void>((res) => (signalEntered = res));
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  store.onSetEnabled = () => {
    signalEntered();
    return gate;
  };

  const enabling = host.enable('builtin:herdr');
  await entered;
  try {
    // 窗口内：服务确已启动，但插件对外完全不可用（未提交）
    assert.deepEqual(marks, ['svc-start'], '服务已启动（持久化尚未落定）');
    await rejectsCode(host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
    marks.length = 0;
    const r = await host.runHook('trigger', triggerPayload());
    assert.equal(r.action, 'continue');
    assert.deepEqual(marks, [], '窗口内钩子处理器绝不执行');
    assert.deepEqual(host.listUi(), [], '窗口内 UI 不露出');
    assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  } finally {
    release();
    await enabling;
  }

  // 提交后：动作可用、钩子执行、UI 露出、持久 true
  assert.deepEqual(await host.invokeAction('builtin:herdr', 'ping', {}), { ok: true });
  marks.length = 0;
  const r2 = await host.runHook('trigger', triggerPayload());
  assert.equal(r2.action, 'transform');
  assert.deepEqual(marks, ['hook-ran']);
  assert.equal(host.listUi().length, 1);
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

test('enable 持久化失败：窗口内同样不可用，回滚为停用且无在途任务被拆、schema 保留、可再启用', { timeout: 60_000 }, async () => {
  const store = new GatedStore();
  const host = makeHost(store);
  const marks: string[] = [];
  await host.register(fullPlugin('builtin:herdr', marks), { enabled: false });

  let signalEntered!: () => void;
  const entered = new Promise<void>((res) => (signalEntered = res));
  let rejectPersist!: (err: Error) => void;
  const gate = new Promise<void>((_, rej) => (rejectPersist = rej));
  store.onSetEnabled = () => {
    signalEntered();
    return gate;
  };

  const enabling = host.enable('builtin:herdr');
  await entered;
  let windowHeld = true;
  try {
    await rejectsCode(host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
    assert.deepEqual(host.listUi(), []);
  } catch (err) {
    windowHeld = false;
    rejectPersist(new Error('cleanup'));
    await enabling.catch(() => {});
    throw err;
  }
  assert.ok(windowHeld);
  rejectPersist(new Error('网络盘断开'));

  const err = await rejectsCode(enabling, 'plugin_enabled_persist_failed');
  assert.match(err.message, /网络盘断开/);

  // 回滚落位：停用、服务已 stop、托管释放、schema 还原、无在途任务
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.ok(marks.includes('svc-stop'), '已启动服务被逆向 stop');
  assert.ok(events.includes('release:builtin:herdr:7'), '托管资源释放');
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  assert.deepEqual(host.listUi(), []);
  assert.equal(host.activeTaskCount('builtin:herdr'), 0, '回滚时零在途任务');
  assert.equal(store.enabled.has('builtin:herdr'), false, '持久化失败不写值');

  // 恢复后可再次启用成功
  store.onSetEnabled = () => {};
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

// ---------------------------------------------------------------------------
// 2. register 启停解析先于一切资源获取：getter 失败零残留
// ---------------------------------------------------------------------------

test('getEnabled 抛错：注册零残留（注册表/数据目录/钩子/托管），原错误保留', { timeout: 60_000 }, async () => {
  const host = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      throw new HelmError('io_broken', '存储读崩了', 500);
    },
    setEnabled() {},
  });
  await rejectsCode(host.register(fullPlugin('p:boom', [])), 'io_broken');

  assert.equal(host.list().length, 0, '注册表零残留');
  assert.equal(existsSync(join(dataDir, 'plugins', 'p:boom')), false, '插件数据目录未创建');
  assert.deepEqual(events.filter((e) => e.startsWith('manage:')), [], '未获取任何宿主资源');
  const r = await host.runHook('trigger', triggerPayload());
  assert.equal(r.action, 'continue', '钩子管道零残留');

  // 非 HelmError 原始异常：包装为注册失败但保留原 message
  const host2 = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      throw new Error('底层 IO 超时');
    },
    setEnabled() {},
  });
  const wrapped = await rejectsCode(host2.register(fullPlugin('p:boom2', [])), 'plugin_registration_failed');
  assert.match(wrapped.message, /底层 IO 超时/);
  assert.equal(host2.list().length, 0);

  // 宿主仍健康：后续注册正常
  const ok = makeHost();
  await ok.register(fullPlugin('p:healthy', []), { enabled: false });
  assert.equal(ok.list().find((p) => p.id === 'p:healthy')!.enabled, false);
});

test('getEnabled 返回非布尔值：显式拒绝（绝不 truthy 猜测），注册零残留', { timeout: 60_000 }, async () => {
  const host = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      return 'false' as unknown as boolean; // 字符串 'false' 是 truthy，绝不能被当成启用
    },
    setEnabled() {},
  });
  const err = await rejectsCode(host.register(fullPlugin('p:lie', [])), 'plugin_enabled_state_invalid');
  assert.equal(err.status, 500);
  assert.equal(host.list().length, 0);
  assert.equal(existsSync(join(dataDir, 'plugins', 'p:lie')), false);
  assert.deepEqual(events.filter((e) => e.startsWith('manage:')), []);
});

// ---------------------------------------------------------------------------
// 3. ConfigService 回调形态 + HelmPluginConfigStore 锁内读改写
// ---------------------------------------------------------------------------

/**
 * 在 updateBy 入口确定性插入一次并发写（消费掉后自动卸下）。
 * 插入点在真正取锁之前：锁外等待、锁内无第二个 getter，无死锁。
 * 新旧实现都必经此入口（update 对象/函数形态均委托 updateBy）：旧实现的
 * 锁外旧快照会覆盖间隙写入；新实现回调内基于锁内最新状态只改所属键。
 */
class InterposingConfigService extends ConfigService {
  interpose: (() => Promise<void>) | undefined;
  override updateBy(mutate: (current: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
    const fn = this.interpose;
    if (fn) {
      this.interpose = undefined;
      return fn().then(() => super.updateBy(mutate));
    }
    return super.updateBy(mutate);
  }
}

function makeRealStore(config: ConfigService, credentials: CredentialService): HelmPluginConfigStore {
  return new HelmPluginConfigStore({ config, credentials });
}

test('ConfigService 回调形态：读到锁内最新值，对象 patch 语义保留', { timeout: 60_000 }, async () => {
  const a = new ConfigService(dataDir);
  const b = new ConfigService(dataDir);
  await Promise.all([a.update({ k1: 'v1' }), b.update({ k2: 'v2' })]);
  const out = await a.update((current) => ({ ...current, k1Upper: String(current['k1']).toUpperCase() }));
  assert.equal(out['k1Upper'], 'V1', '回调看到锁内最新 k1（非空文件起读）');
  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw, { k1: 'v1', k2: 'v2', k1Upper: 'V1' });
});

test('setEnabled 期间其他模块并发更新 auth 等键不被旧值覆盖（确定性插入）', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfg = new InterposingConfigService(dataDir);
  const other = new ConfigService(dataDir);
  await other.update({ auth: { passwordHash: 'h0' }, model: 'faux/1' });

  const store = makeRealStore(cfg, new CredentialService(credDir));
  await store.load();

  // 在 store 的 update 入口插入另一模块的写：旧实现会把它覆盖回去
  cfg.interpose = async () => {
    await other.update({ auth: { passwordHash: 'h1' }, model: 'faux/2' });
  };
  await store.setEnabled('builtin:herdr', false);

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'builtin:herdr': false });
  assert.deepEqual(raw['auth'], { passwordHash: 'h1' }, '间隙写入的 auth 不被旧快照覆盖');
  assert.equal(raw['model'], 'faux/2', '间隙写入的 model 不被旧快照覆盖');
  assert.equal(store.getEnabled('builtin:herdr'), false);
});

test('两个 store 并发更新不同 pluginEnabled 键都保留（确定性插入）', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfgA = new InterposingConfigService(dataDir);
  const cfgB = new ConfigService(dataDir);
  const storeA = makeRealStore(cfgA, new CredentialService(credDir));
  const storeB = makeRealStore(cfgB, new CredentialService(credDir));
  await storeA.load();
  await storeB.load();

  // storeB 的完整写插入在 storeA 的 update 入口：两者都必须留下
  cfgA.interpose = async () => {
    await storeB.setEnabled('p:b', false);
  };
  await storeA.setEnabled('p:a', true);

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'p:a': true, 'p:b': false }, '两个插件的启停键都保留');
  assert.equal(storeA.getEnabled('p:a'), true);
  assert.equal(storeB.getEnabled('p:b'), false);
});

test('插件 config 写路径同样保住间隙的外部更新，且只动本插件嵌套键', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfg = new InterposingConfigService(dataDir);
  const other = new ConfigService(dataDir);
  await other.update({ plugins: { 'p:other': { keep: 1 } }, theme: 'dark' });

  const store = makeRealStore(cfg, new CredentialService(credDir));
  await store.load();

  cfg.interpose = async () => {
    await other.update({ theme: 'light' });
  };
  await store.set('p:mine', { retries: 2 }, { retries: { type: 'number' } });

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(raw['theme'], 'light', '间隙写入的 theme 不被旧快照覆盖');
  assert.deepEqual(raw['plugins'], { 'p:other': { keep: 1 }, 'p:mine': { retries: 2 } }, '其他插件配置保留，本插件键更新');
  assert.deepEqual(store.get('p:mine'), { retries: 2 });
  assert.deepEqual(store.get('p:other'), { keep: 1 });
});

test('写时 pluginEnabled 损坏：显式 config_corrupt，绝不用 {} 重建，镜像不变', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const store = makeRealStore(new ConfigService(dataDir), new CredentialService(credDir));
  await store.load();

  // load 成功后外部把 pluginEnabled 破坏成非布尔值映射
  writeFileSync(configPath, JSON.stringify({ pluginEnabled: { ghost: 'yes' } }), 'utf8');
  await rejectsCode(store.setEnabled('p:x', true), 'config_corrupt');
  let raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { ghost: 'yes' }, '损坏内容原样保留（未重建）');
  assert.equal(store.getEnabled('p:x'), undefined, '写失败镜像不变');

  // 整体非对象同样显式拒绝
  writeFileSync(configPath, JSON.stringify({ pluginEnabled: 'nope' }), 'utf8');
  await rejectsCode(store.setEnabled('p:x', true), 'config_corrupt');
  raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['pluginEnabled'], 'nope');
});

test('写时 plugins 字段损坏：显式 config_corrupt，不静默重建', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const store = makeRealStore(new ConfigService(dataDir), new CredentialService(credDir));
  await store.load();

  writeFileSync(configPath, JSON.stringify({ plugins: 'corrupt' }), 'utf8');
  await rejectsCode(
    store.set('p:x', { retries: 1 }, { retries: { type: 'number' } }),
    'config_corrupt',
  );
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['plugins'], 'corrupt', '损坏内容原样保留');
});
