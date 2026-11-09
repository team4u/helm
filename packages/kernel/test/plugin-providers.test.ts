/**
 * ctx.provider 声明 / 挂载 / 卸载生命周期测试。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 *
 * 全部使用真实 PluginHost + fake provider registry（记录挂载/卸载真实顺序与
 * 所有权），不引入真实模型网关——宿主机制与 runtime 端口实现解耦验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HelmError, type PluginDefinition } from '@helm/protocol';
import type { Provider } from '@earendil-works/pi-ai';
import {
  PluginHost,
  type PluginDocStore,
  type PluginHostBackend,
  type PluginProviderPort,
} from '../src/plugins/index.js';

// ---------------------------------------------------------------------------
// fake 基建
// ---------------------------------------------------------------------------

function makeHostApi(): PluginHostBackend {
  const noop = () => {};
  return {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({
      id: 1,
      title: init.title ?? 'new',
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
    }),
    listConversations: () => [],
    getConversation: (id) => ({
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
    }),
    updateConversation: async (id) => ({} as never),
    manageConversation: () => () => {},
    markConversationOwnership: noop,
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    abortConversation: async () => {},
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    cleanupWorktree: async () => ({ removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false }),
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    listActions: () => [],
    emitEvent: () => {},
  };
}

class MemoryDocStore implements PluginDocStore {
  private store = new Map<string, unknown>();
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial;
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value));
  }
  async flush(): Promise<void> {}
}

/** 最小合法 provider（形状满足 pi-ai Provider 契约，行为无需真实）。 */
function makeProvider(id: string): Provider {
  return {
    id,
    name: `Provider ${id}`,
    auth: { apiKey: { name: `${id} key`, resolve: async () => undefined } },
    getModels: () => [],
    stream: () => {
      throw new Error('fake provider 不执行 stream');
    },
    streamSimple: () => {
      throw new Error('fake provider 不执行 streamSimple');
    },
  } as unknown as Provider;
}

interface RegistryCall {
  op: 'register' | 'unregister' | 'assertIdle';
  providerId?: string;
  pluginId: string;
}

/**
 * fake provider registry：记录真实调用序列，可注入失败与忙碌状态。
 * 所有权（pluginId）由宿主注入，registry 忠实记录供断言。
 */
class FakeProviderRegistry implements PluginProviderPort {
  calls: RegistryCall[] = [];
  mounted = new Map<string, string>(); // providerId -> pluginId
  /** 下一次 register(provider.id === failOn) 时抛出。 */
  failRegisterOn: string | null = null;
  /** 指定 providerId 的卸载函数抛出。 */
  failUnregisterOn: string | null = null;
  /** assertIdle 抛出的 providerId 集合。 */
  busyOwners = new Set<string>();

  async register(provider: Provider, pluginId: string): Promise<() => Promise<void>> {
    if (provider.id === this.failRegisterOn) {
      throw new HelmError('provider_register_conflict', `provider ${provider.id} 挂载被拒绝`, 409);
    }
    this.calls.push({ op: 'register', providerId: provider.id, pluginId });
    this.mounted.set(provider.id, pluginId);
    return async () => {
      if (provider.id === this.failUnregisterOn) {
        throw new HelmError('provider_unregister_rejected', `provider ${provider.id} 卸载被拒绝（活跃流）`, 409);
      }
      this.calls.push({ op: 'unregister', providerId: provider.id, pluginId });
      this.mounted.delete(provider.id);
    };
  }

  assertIdle(pluginId: string): void {
    this.calls.push({ op: 'assertIdle', pluginId });
    if (this.busyOwners.has(pluginId)) {
      throw new HelmError('provider_stream_in_flight', `插件 ${pluginId} 的 provider 仍有活跃流/刷新`, 409);
    }
  }
}

/** 直用 ctx 的定义工厂：保持 definePlugin 内声明的真实执行顺序。 */
function definePluginWith(id: string, fn: (ctx: import('@helm/protocol').HelmPluginContext) => void | Promise<void>): PluginDefinition {
  return { id, name: id, definePlugin: fn };
}

function makeHost(plugins?: PluginProviderPort): { host: PluginHost; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'helm-plugin-providers-'));
  const host = new PluginHost({
    dataDir: dir,
    host: makeHostApi(),
    docs: new MemoryDocStore(),
    ...(plugins ? { providers: plugins } : {}),
  });
  return { host, dir };
}

async function dispose(host: PluginHost, dir: string): Promise<void> {
  try {
    await host.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 声明边界校验
// ---------------------------------------------------------------------------

test('provider 声明缺少必要形状被显式拒绝', { timeout: 60_000 }, async () => {
  const { host, dir } = makeHost(new FakeProviderRegistry());
  try {
    const bad = (over: Record<string, unknown>) =>
      definePluginWith('test:bad', (ctx) => {
        ctx.provider({ ...makeProvider('bad'), ...over } as unknown as Provider);
      });
    // 缺 name
    await assert.rejects(() => host.register(bad({ name: undefined })), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'invalid_provider_spec', `name 校验失败：${String(err)}`);
      return true;
    });
    // auth 缺 apiKey/oauth
    await assert.rejects(() => host.register(bad({ auth: {} })), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'invalid_provider_spec', `auth 校验失败：${String(err)}`);
      return true;
    });
    // 缺 streamSimple
    await assert.rejects(() => host.register(bad({ streamSimple: undefined })), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'invalid_provider_spec', `streamSimple 校验失败：${String(err)}`);
      return true;
    });
    // 重复 id
    const p = makeProvider('dup');
    await assert.rejects(
      () =>
        host.register(
          definePluginWith('test:dup', (ctx) => {
            ctx.provider(p);
            ctx.provider({ ...p, name: 'again' });
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof HelmError && err.code === 'duplicate_provider', `重复校验失败：${String(err)}`);
        return true;
      },
    );
  } finally {
    await dispose(host, dir);
  }
});

// ---------------------------------------------------------------------------
// 启用 / 停用 / 再启用
// ---------------------------------------------------------------------------

test('启用挂载、停用卸载、再启用重挂载（真实所有权与顺序）', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = makeHost(registry);
  try {
    const events: string[] = [];
    await host.register(
      definePluginWith('test:magpie', (ctx) => {
        ctx.provider(makeProvider('magpie-a'));
        ctx.provider(makeProvider('magpie-b'));
        ctx.service({
          id: 'svc',
          start: () => {
            events.push('service-start');
          },
          stop: () => {
            events.push('service-stop');
          },
        });
      }),
    );
    // 启用：provider 先于服务 start 挂载
    assert.deepEqual(events, ['service-start']);
    assert.deepEqual(
      registry.calls.map((c) => `${c.op}:${c.providerId ?? ''}`),
      ['register:magpie-a', 'register:magpie-b'],
    );
    assert.deepEqual([...registry.mounted.entries()], [
      ['magpie-a', 'test:magpie'],
      ['magpie-b', 'test:magpie'],
    ]);

    await host.disable('test:magpie');
    // 停用：服务 stop 后逆序卸载 provider
    assert.deepEqual(events, ['service-start', 'service-stop']);
    assert.equal(registry.mounted.size, 0, '停用后 provider 必须全部卸载');
    const disableCalls = registry.calls.filter((c) => c.op === 'assertIdle');
    assert.equal(disableCalls.length, 1, '停用前必须预检 provider 在途状态');

    await host.enable('test:magpie');
    assert.deepEqual(events, ['service-start', 'service-stop', 'service-start']);
    assert.deepEqual(
      registry.calls.filter((c) => c.op === 'register').map((c) => c.providerId),
      ['magpie-a', 'magpie-b', 'magpie-a', 'magpie-b'],
      '再启用必须重新挂载全部 provider',
    );
    assert.deepEqual([...registry.mounted.entries()], [
      ['magpie-a', 'test:magpie'],
      ['magpie-b', 'test:magpie'],
    ]);
  } finally {
    await dispose(host, dir);
  }
});

test('默认停用注册只收集声明不挂载（configSchema 照常可用）', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = makeHost(registry);
  try {
    await host.register(
      definePluginWith('test:off', (ctx) => {
        ctx.configSchema({ token: { type: 'string', secret: true } });
        ctx.provider(makeProvider('off-a'));
      }),
      { enabled: false },
    );
    assert.equal(registry.calls.length, 0, '默认停用探测绝不能挂载 provider');
    assert.equal(registry.mounted.size, 0);
    const summary = host.list().find((p) => p.id === 'test:off');
    assert.ok(summary);
    assert.equal(summary.enabled, false);
    assert.deepEqual(host.getConfigSchema('test:off'), { token: { type: 'string', secret: true } });
  } finally {
    await dispose(host, dir);
  }
});

test('默认停用且宿主未提供 providers 端口时注册成功，启用显式 501', { timeout: 60_000 }, async () => {
  const { host, dir } = makeHost();
  try {
    // 端口缺失：停用探测必须成功（声明不挂载），不受端口影响
    await host.register(
      definePluginWith('test:noport', (ctx) => {
        ctx.provider(makeProvider('nop-a'));
      }),
      { enabled: false },
    );
    // 启用（挂载阶段）：显式 501，禁静默
    await assert.rejects(() => host.enable('test:noport'), (err: unknown) => {
      assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`);
      assert.equal(err.code, 'provider_port_unavailable');
      assert.equal(err.status, 501);
      return true;
    });
    // 失败后落回停用态，无泄漏
    const summary = host.list().find((p) => p.id === 'test:noport');
    assert.ok(summary);
    assert.equal(summary.enabled, false);
  } finally {
    await dispose(host, dir);
  }
});

test('服务 start 前已完成 provider 挂载（服务可依赖自身 provider）', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = makeHost(registry);
  try {
    const seen: string[] = [];
    await host.register(
      definePluginWith('test:order', (ctx) => {
        ctx.provider(makeProvider('first'));
        ctx.service({
          id: 'boot',
          start: () => {
            seen.push(...registry.mounted.keys());
          },
          stop: () => {},
        });
      }),
    );
    assert.deepEqual(seen, ['first'], '服务 start 时自身 provider 必须已挂载');
  } finally {
    await dispose(host, dir);
  }
});

test('服务 start 失败时释放全部已挂载 provider', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = makeHost(registry);
  try {
    await assert.rejects(
      () =>
        host.register(
          definePluginWith('test:svc-fail', (ctx) => {
            ctx.provider(makeProvider('p1'));
            ctx.provider(makeProvider('p2'));
            ctx.service({
              id: 'boom',
              start: () => {
                throw new Error('启动爆炸');
              },
              stop: () => {},
            });
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof HelmError, String(err));
        // 服务启动失败路径的既有错误码（provider 已在 rollback 中逆序释放）
        assert.equal(err.code, 'plugin_service_start_failed');
        return true;
      },
    );
    assert.equal(registry.mounted.size, 0, '服务启动失败必须释放全部已挂载 provider');
    assert.deepEqual(
      registry.calls.map((c) => `${c.op}:${c.providerId}`),
      ['register:p1', 'register:p2', 'unregister:p2', 'unregister:p1'],
      '释放必须逆序',
    );
    assert.equal(host.list().length, 0, '注册失败的插件必须整体移除');
  } finally {
    await dispose(host, dir);
  }
});

test('第二个 provider 挂载失败时释放第一个', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  registry.failRegisterOn = 'second';
  const { host, dir } = makeHost(registry);
  try {
    await assert.rejects(
      () =>
        host.register(
          definePluginWith('test:second-fail', (ctx) => {
            ctx.provider(makeProvider('first'));
            ctx.provider(makeProvider('second'));
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof HelmError, String(err));
        // 端口拒绝（provider_register_conflict）原始诊断必须保留
        assert.equal(err.code, 'provider_register_conflict');
        return true;
      },
    );
    assert.equal(registry.mounted.size, 0, '半途失败不得泄漏第一个 provider');
    assert.deepEqual(
      registry.calls.map((c) => `${c.op}:${c.providerId}`),
      ['register:first', 'unregister:first'],
    );
    assert.equal(host.list().length, 0);
  } finally {
    await dispose(host, dir);
  }
});

test('过期 ctx（旧 epoch）不能再注册 provider', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = makeHost(registry);
  try {
    let stolen: ((p: Provider) => void) | null = null;
    await host.register(
      definePluginWith('test:stale', (ctx) => {
        stolen = (p) => ctx.provider(p);
        ctx.provider(makeProvider('live'));
      }),
    );
    await host.disable('test:stale');
    // 旧 ctx 在停用后调用 provider：同步 throw（assertOpen），用 try/catch 捕获
    assert.throws(() => stolen!(makeProvider('ghost')), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'plugin_context_closed', String(err));
      return true;
    });
    assert.equal(registry.mounted.size, 0);
    await host.enable('test:stale');
    // 再停用后旧句柄再次失效（新 epoch）
    await host.disable('test:stale');
    assert.throws(() => stolen!(makeProvider('ghost2')), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'plugin_context_closed', String(err));
      return true;
    });
    assert.equal(registry.mounted.size, 0);
    assert.ok(!registry.calls.some((c) => c.providerId === 'ghost' || c.providerId === 'ghost2'), '过期声明绝不能挂载');
  } finally {
    await dispose(host, dir);
  }
});

test('provider 在途流预检拒绝停用（不进入服务 stop 半拆状态）', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = makeHost(registry);
  try {
    const events: string[] = [];
    await host.register(
      definePluginWith('test:busy', (ctx) => {
        ctx.provider(makeProvider('busy-p'));
        ctx.service({
          id: 'svc',
          start: () => {
            events.push('started');
          },
          stop: () => {
            events.push('stopped');
          },
        });
      }),
    );
    assert.deepEqual(events, ['started']);
    // 造忙：assertIdle 拒绝
    registry.busyOwners.add('test:busy');
    await assert.rejects(() => host.disable('test:busy'), (err: unknown) => {
      assert.ok(err instanceof HelmError, String(err));
      assert.equal(err.code, 'provider_stream_in_flight', '端口原始诊断必须原样透传');
      return true;
    });
    // 预检拒绝：服务未 stop、provider 未卸载、插件保持启用
    assert.deepEqual(events, ['started'], '预检拒绝时绝不能 stop 服务');
    assert.equal(registry.mounted.size, 1, '预检拒绝时 provider 必须保持挂载');
    const summary = host.list().find((p) => p.id === 'test:busy');
    assert.ok(summary && summary.enabled === true);
    // 解忙后停用成功
    registry.busyOwners.delete('test:busy');
    await host.disable('test:busy');
    assert.deepEqual(events, ['started', 'stopped']);
    assert.equal(registry.mounted.size, 0);
  } finally {
    await dispose(host, dir);
  }
});

test('卸载（unregister）同样先预检再逆序卸载 provider', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = makeHost(registry);
  try {
    await host.register(
      definePluginWith('test:unreg', (ctx) => {
        ctx.provider(makeProvider('u1'));
        ctx.provider(makeProvider('u2'));
      }),
    );
    await host.unregister('test:unreg');
    const ops = registry.calls.map((c) => `${c.op}:${c.providerId ?? ''}`);
    assert.deepEqual(ops, [
      'register:u1',
      'register:u2',
      'assertIdle:',
      'unregister:u2',
      'unregister:u1',
    ], '卸载前必须预检，卸载必须逆序');
    assert.equal(registry.mounted.size, 0);
    assert.equal(host.list().length, 0);
  } finally {
    await dispose(host, dir);
  }
});

test('provider 卸载失败时诊断聚合显式上抛（不静默）', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = makeHost(registry);
  try {
    await host.register(
      definePluginWith('test:unreg-fail', (ctx) => {
        ctx.provider(makeProvider('sticky'));
      }),
    );
    registry.failUnregisterOn = 'sticky';
    await assert.rejects(() => host.disable('test:unreg-fail'), (err: unknown) => {
      assert.ok(err instanceof HelmError, String(err));
      assert.equal(err.code, 'plugin_provider_unregister_failed');
      // teardown 路径聚合键为 providerErrors；失败 provider 必须出现在诊断
      const details = err.details as { providerErrors?: Array<{ providerId: string }>; unregisterErrors?: Array<{ providerId: string }> };
      const list = details.providerErrors ?? details.unregisterErrors;
      assert.ok(list?.some((e) => e.providerId === 'sticky'), `失败 provider 必须出现在诊断：${JSON.stringify(details)}`);
      return true;
    });
    // 状态落位：已停用（诚实上报），registry 侧句柄由端口实现负责
    const summary = host.list().find((p) => p.id === 'test:unreg-fail');
    assert.ok(summary && summary.enabled === false);
  } finally {
    await dispose(host, dir);
  }
});

test('不声明 provider 的插件不受可选端口缺失影响（既有接口不放松）', { timeout: 60_000 }, async () => {
  const { host, dir } = makeHost(); // 无 providers 端口
  try {
    await host.register(
      definePluginWith('test:plain', (ctx) => {
        ctx.service({ id: 'svc', start: () => {}, stop: () => {} });
        ctx.doc('state', { n: 0 });
      }),
    );
    const summary = host.list().find((p) => p.id === 'test:plain');
    assert.ok(summary && summary.enabled === true);
    await host.disable('test:plain');
    await host.enable('test:plain');
    const again = host.list().find((p) => p.id === 'test:plain');
    assert.ok(again && again.enabled === true);
  } finally {
    await dispose(host, dir);
  }
});

test('端口存在但未实现 assertIdle 时停用照常（可选预检）', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const port: PluginProviderPort = { register: registry.register.bind(registry) };
  const { host, dir } = makeHost(port);
  try {
    await host.register(
      definePluginWith('test:no-idle-check', (ctx) => {
        ctx.provider(makeProvider('ni'));
      }),
    );
    await host.disable('test:no-idle-check');
    assert.equal(registry.mounted.size, 0);
  } finally {
    await dispose(host, dir);
  }
});
