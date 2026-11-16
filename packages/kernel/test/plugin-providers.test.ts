/**
 * ctx.provider declaration / mount / unload lifecycle test.
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 *
 * all use real PluginHost + fake provider registry(record mount/unload real order and
 * ownership), does not introduce real model gateway - - host mechanism and runtime port implement decouple verify.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmError, type PluginDefinition } from '@helm/protocol';
import type { Provider } from '@earendil-works/pi-ai';
import {
  PluginHost,
  type PluginHostBackend,
  type PluginProviderPort,
} from '../src/plugins/index.js';
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js';
import { createPluginBuildProvider } from '@helm/plugin-build';
import { MemoryDocStore, cleanupDir, makeConversationSummary, makeTempDir } from './helpers.js';

// ---------------------------------------------------------------------------
// fake base create
// ---------------------------------------------------------------------------

function makeHostApi(): PluginHostBackend {
  const noop = () => {};
  return {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => makeConversationSummary({ id: 1, title: init.title ?? 'new', profileId: 'default' }),
    listConversations: () => [],
    getConversation: (id) => makeConversationSummary({ id, profileId: 'default' }),
    updateConversation: async () => ({} as never),
    manageConversation: () => () => {},
    markConversationOwnership: noop,
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmError('unsupported', 'this fixture do not execute node command', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('this fixture do not bear load file mutual exclusion queue') },
    emitEvent: () => {},
  };
}

/** most small legal provider(shape satisfy pi-ai Provider contract, behavior no need to real). */
function makeProvider(id: string): Provider {
  return {
    id,
    name: `Provider ${id}`,
    auth: { apiKey: { name: `${id} key`, resolve: async () => undefined } },
    getModels: () => [],
    stream: () => {
      throw new Error('fake provider do not execute stream');
    },
    streamSimple: () => {
      throw new Error('fake provider do not execute streamSimple');
    },
  } as unknown as Provider;
}

interface RegistryCall {
  op: 'register' | 'unregister' | 'assertIdle';
  providerId?: string;
  pluginId: string;
}

/**
 * fake provider registry: record real invoke sequence, can inject failed and busy state.
 * ownership (pluginId) by host inject,registry faithful record supply assertion.
 */
class FakeProviderRegistry implements PluginProviderPort {
  calls: RegistryCall[] = [];
  mounted = new Map<string, string>(); // providerId -> pluginId
  /** under once register(provider.id === failOn) when throw. */
  failRegisterOn: string | null = null;
  /** designate providerId unload function throw. */
  failUnregisterOn: string | null = null;
  /** assertIdle throw providerId set. */
  busyOwners = new Set<string>();

  async register(provider: Provider, pluginId: string): Promise<() => Promise<void>> {
    if (provider.id === this.failRegisterOn) {
      throw new HelmError('provider_register_conflict', `provider ${provider.id} mount by reject`, 409);
    }
    this.calls.push({ op: 'register', providerId: provider.id, pluginId });
    this.mounted.set(provider.id, pluginId);
    return async () => {
      if (provider.id === this.failUnregisterOn) {
        throw new HelmError('provider_unregister_rejected', `provider ${provider.id} unload by reject (leap stream)`, 409);
      }
      this.calls.push({ op: 'unregister', providerId: provider.id, pluginId });
      this.mounted.delete(provider.id);
    };
  }

  assertIdle(pluginId: string): void {
    this.calls.push({ op: 'assertIdle', pluginId });
    if (this.busyOwners.has(pluginId)) {
      throw new HelmError('provider_stream_in_flight', `plugin ${pluginId}  provider still has leap stream/refresh`, 409);
    }
  }
}

/** direct use ctx define work vendor: keep definePlugin inside declaration real execute order. */
function definePluginWith(id: string, fn: (ctx: import('@helm/protocol').HelmPluginContext) => void | Promise<void>): PluginDefinition {
  return { id, name: id, definePlugin: fn };
}

async function makeHost(plugins?: PluginProviderPort): Promise<{ host: PluginHost; dir: string }> {
  const dir = await makeTempDir('helm-plugin-providers-');
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
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
    await cleanupDir(dir);
  }
}

// ---------------------------------------------------------------------------
// declaration boundary validate
// ---------------------------------------------------------------------------

test('provider declaration missing must want shape by explicit reject', { timeout: 60_000 }, async () => {
  const { host, dir } = await makeHost(new FakeProviderRegistry());
  try {
    const bad = (over: Record<string, unknown>) =>
      definePluginWith('test:bad', (ctx) => {
        ctx.provider({ ...makeProvider('bad'), ...over } as unknown as Provider);
      });
    // missing name
    await assert.rejects(() => host.register(bad({ name: undefined })), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'invalid_provider_spec', `name validation failed:${String(err)}`);
      return true;
    });
    // auth missing apiKey/oauth
    await assert.rejects(() => host.register(bad({ auth: {} })), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'invalid_provider_spec', `auth validation failed:${String(err)}`);
      return true;
    });
    // missing streamSimple
    await assert.rejects(() => host.register(bad({ streamSimple: undefined })), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'invalid_provider_spec', `streamSimple validation failed:${String(err)}`);
      return true;
    });
    // duplicate id
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
        assert.ok(err instanceof HelmError && err.code === 'duplicate_provider', `duplicate validation failed:${String(err)}`);
        return true;
      },
    );
  } finally {
    await dispose(host, dir);
  }
});

// ---------------------------------------------------------------------------
// enable / deactivate / again enable
// ---------------------------------------------------------------------------

test('enable mount, deactivate unload, again enable heavy mount (real ownership and order)', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = await makeHost(registry);
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
    // enable:provider first at service start mount
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
    // deactivate: service stop after inverse order unload provider
    assert.deepEqual(events, ['service-start', 'service-stop']);
    assert.equal(registry.mounted.size, 0, 'deactivate after provider must all unload');
    const disableCalls = registry.calls.filter((c) => c.op === 'assertIdle');
    // deactivate gate double inspect:collectPluginInUse before after each once (TOCTOU consolidate, see disable implement)
    assert.equal(disableCalls.length, 2, 'deactivate before must preflight provider in-flight state');

    await host.enable('test:magpie');
    assert.deepEqual(events, ['service-start', 'service-stop', 'service-start']);
    assert.deepEqual(
      registry.calls.filter((c) => c.op === 'register').map((c) => c.providerId),
      ['magpie-a', 'magpie-b', 'magpie-a', 'magpie-b'],
      'again enable must re- mount all provider',
    );
    assert.deepEqual([...registry.mounted.entries()], [
      ['magpie-a', 'test:magpie'],
      ['magpie-b', 'test:magpie'],
    ]);
  } finally {
    await dispose(host, dir);
  }
});

test('by default deactivate register only collect declaration do not mount (configSchema per common available)', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = await makeHost(registry);
  try {
    await host.register(
      definePluginWith('test:off', (ctx) => {
        ctx.configSchema({ token: { type: 'string', secret: true } });
        ctx.provider(makeProvider('off-a'));
      }),
      { enabled: false },
    );
    assert.equal(registry.calls.length, 0, 'by default deactivate probe never can mount provider');
    assert.equal(registry.mounted.size, 0);
    const summary = host.list().find((p) => p.id === 'test:off');
    assert.ok(summary);
    assert.equal(summary.enabled, false);
    assert.deepEqual(host.getConfigSchema('test:off'), { token: { type: 'string', secret: true } });
  } finally {
    await dispose(host, dir);
  }
});

test('by default deactivate and host not provide providers port when register succeeded, enable explicit 501', { timeout: 60_000 }, async () => {
  const { host, dir } = await makeHost();
  try {
    // port missing: deactivate probe must succeeded (declaration do not mount), do not subject to port affect
    await host.register(
      definePluginWith('test:noport', (ctx) => {
        ctx.provider(makeProvider('nop-a'));
      }),
      { enabled: false },
    );
    // enable (mount phase): explicit 501, forbid static default
    await assert.rejects(() => host.enable('test:noport'), (err: unknown) => {
      assert.ok(err instanceof HelmError, `expectation HelmError, actual:${String(err)}`);
      assert.equal(err.code, 'provider_port_unavailable');
      assert.equal(err.status, 501);
      return true;
    });
    // failed after back deactivate state, without leak leak
    const summary = host.list().find((p) => p.id === 'test:noport');
    assert.ok(summary);
    assert.equal(summary.enabled, false);
  } finally {
    await dispose(host, dir);
  }
});

test('service start before completed provider mount (service can dependency itself provider)', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = await makeHost(registry);
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
    assert.deepEqual(seen, ['first'], 'service start when itself provider must already mount');
  } finally {
    await dispose(host, dir);
  }
});

test('service start on failure release all already mount provider', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = await makeHost(registry);
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
                throw new Error('start explode');
              },
              stop: () => {},
            });
          }),
        ),
      (err: unknown) => {
        assert.ok(err instanceof HelmError, String(err));
        // service failed to start path since has error code (provider already in rollback in inverse order release)
        assert.equal(err.code, 'plugin_service_start_failed');
        return true;
      },
    );
    assert.equal(registry.mounted.size, 0, 'service failed to start must release all already mount provider');
    assert.deepEqual(
      registry.calls.map((c) => `${c.op}:${c.providerId}`),
      ['register:p1', 'register:p2', 'unregister:p2', 'unregister:p1'],
      'release must inverse order',
    );
    assert.equal(host.list().length, 0, 'register failed plugin must whole remove');
  } finally {
    await dispose(host, dir);
  }
});

test('second provider mount on failure release a', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  registry.failRegisterOn = 'second';
  const { host, dir } = await makeHost(registry);
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
        // port reject (provider_register_conflict) original diagnose must keep
        assert.equal(err.code, 'provider_register_conflict');
        return true;
      },
    );
    assert.equal(registry.mounted.size, 0, 'half route failed must not leak leak a provider');
    assert.deepEqual(
      registry.calls.map((c) => `${c.op}:${c.providerId}`),
      ['register:first', 'unregister:first'],
    );
    assert.equal(host.list().length, 0);
  } finally {
    await dispose(host, dir);
  }
});

test('expired ctx(old epoch) can no longer register provider', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = await makeHost(registry);
  try {
    let stolen: ((p: Provider) => void) | null = null;
    await host.register(
      definePluginWith('test:stale', (ctx) => {
        stolen = (p) => ctx.provider(p);
        ctx.provider(makeProvider('live'));
      }),
    );
    await host.disable('test:stale');
    // old ctx in deactivate after invoke provider: sync throw(assertOpen), use try/catch catch
    assert.throws(() => stolen!(makeProvider('ghost')), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'plugin_context_closed', String(err));
      return true;
    });
    assert.equal(registry.mounted.size, 0);
    await host.enable('test:stale');
    // again deactivate after old handle again expires (new epoch)
    await host.disable('test:stale');
    assert.throws(() => stolen!(makeProvider('ghost2')), (err: unknown) => {
      assert.ok(err instanceof HelmError && err.code === 'plugin_context_closed', String(err));
      return true;
    });
    assert.equal(registry.mounted.size, 0);
    assert.ok(!registry.calls.some((c) => c.providerId === 'ghost' || c.providerId === 'ghost2'), 'expired declaration never can mount');
  } finally {
    await dispose(host, dir);
  }
});

test('provider in-flight stream preflight reject deactivate (does not enter service stop half split state)', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = await makeHost(registry);
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
    // build busy:assertIdle reject
    registry.busyOwners.add('test:busy');
    await assert.rejects(() => host.disable('test:busy'), (err: unknown) => {
      assert.ok(err instanceof HelmError, String(err));
      assert.equal(err.code, 'provider_stream_in_flight', 'port original diagnose must original pass-through');
      return true;
    });
    // preflight reject: service not stop,provider not unload, plugin keep enable
    assert.deepEqual(events, ['started'], 'preflight reject when never can stop service');
    assert.equal(registry.mounted.size, 1, 'preflight reject when provider must keep mount');
    const summary = host.list().find((p) => p.id === 'test:busy');
    assert.ok(summary && summary.enabled === true);
    // solve busy after deactivate succeeded
    registry.busyOwners.delete('test:busy');
    await host.disable('test:busy');
    assert.deepEqual(events, ['started', 'stopped']);
    assert.equal(registry.mounted.size, 0);
  } finally {
    await dispose(host, dir);
  }
});

test('unload (unregister) same first preflight again inverse order unload provider', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = await makeHost(registry);
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
    ], 'unload before must preflight, unload must inverse order');
    assert.equal(registry.mounted.size, 0);
    assert.equal(host.list().length, 0);
  } finally {
    await dispose(host, dir);
  }
});

test('provider failed to uninstall when diagnose aggregate explicit on throw (not silently)', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const { host, dir } = await makeHost(registry);
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
      // teardown path aggregate key is providerErrors; failed provider must appear in diagnose
      const details = err.details as { providerErrors?: Array<{ providerId: string }>; unregisterErrors?: Array<{ providerId: string }> };
      const list = details.providerErrors ?? details.unregisterErrors;
      assert.ok(list?.some((e) => e.providerId === 'sticky'), `failed provider must appear in diagnose:${JSON.stringify(details)}`);
      return true;
    });
    // state: deactivated (honest on report),registry side handle by port implement negative duty
    const summary = host.list().find((p) => p.id === 'test:unreg-fail');
    assert.ok(summary && summary.enabled === false);
  } finally {
    await dispose(host, dir);
  }
});

test('do not declaration provider plugin do not subject to optional port missing affect (since has interface do not relax)', { timeout: 60_000 }, async () => {
  const { host, dir } = await makeHost(); // without providers port
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

test('port store in but not implemented assertIdle when deactivate per common (optional preflight)', { timeout: 60_000 }, async () => {
  const registry = new FakeProviderRegistry();
  const port: PluginProviderPort = { register: registry.register.bind(registry) };
  const { host, dir } = await makeHost(port);
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
