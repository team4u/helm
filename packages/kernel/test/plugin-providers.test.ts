/**
 * Lifecycle tests for `ctx.provider` declaration, mounting, and unmounting.
 * runner: tsx --test; every test uses explicit timeout: 60_000 to guard against deadlocks.
 *
 * Uses a real `PluginHost` + a fake provider registry (recording exact mount/unmount order
 * and ownership) without bringing up the model gateway, verifying host decoupling from the
 * runtime port implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmxError, type PluginDefinition } from '@helmx/protocol';
import type { Provider } from '@earendil-works/pi-ai';
import {
  PluginHost,
  type PluginHostBackend,
  type PluginProviderPort,
} from '../src/plugins/index.js';
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js';
import { createPluginBuildProvider } from '@helmx/plugin-build';
import { MemoryDocStore, cleanupDir, deferred, makeConversationSummary, makeTempDir } from './helpers.js';

// ---------------------------------------------------------------------------
// Fake test fixtures
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
    getConversationOwnership(): 'helmx' | 'bot' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmxError('unsupported', 'this fixture does not execute node commands', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('this fixture does not support file mutation queue') },
    emitEvent: () => {},
  };
}

/** Minimal valid provider (matches `pi-ai` `Provider` shape; streaming methods are stubs). */
function makeProvider(id: string): Provider {
  return {
    id,
    name: `Provider ${id}`,
    auth: { apiKey: { name: `${id} key`, resolve: async () => undefined } },
    getModels: () => [],
    stream: () => {
      throw new Error('fake provider does not implement stream');
    },
    streamSimple: () => {
      throw new Error('fake provider does not implement streamSimple');
    },
  } as unknown as Provider;
}

interface RegistryCall {
  op: 'register' | 'unregister' | 'assertIdle';
  providerId?: string;
  pluginId: string;
}

/**
 * Fake provider registry: records actual call order and allows injecting failures and busy states.
 * Ownership (`pluginId`) is supplied by the host and recorded faithfully for assertions.
 */
class FakeProviderRegistry implements PluginProviderPort {
  calls: RegistryCall[] = [];
  mounted = new Map<string, string>(); // providerId -> pluginId
  /** Throws on the next register call when `provider.id === failRegisterOn`. */
  failRegisterOn: string | null = null;
  /** Throws inside the unregister callback for the specified providerId. */
  failUnregisterOn: string | null = null;
  /** Plugin IDs whose `assertIdle` call should throw. */
  busyOwners = new Set<string>();

  async register(provider: Provider, pluginId: string): Promise<() => Promise<void>> {
    if (provider.id === this.failRegisterOn) {
      throw new HelmxError('provider_register_conflict', `provider ${provider.id} rejected on mount`, 409);
    }
    this.calls.push({ op: 'register', providerId: provider.id, pluginId });
    this.mounted.set(provider.id, pluginId);
    return async () => {
      if (provider.id === this.failUnregisterOn) {
        throw new HelmxError('provider_unregister_rejected', `provider ${provider.id} rejected on unmount (active stream)`, 409);
      }
      this.calls.push({ op: 'unregister', providerId: provider.id, pluginId });
      this.mounted.delete(provider.id);
    };
  }

  assertIdle(pluginId: string): void {
    this.calls.push({ op: 'assertIdle', pluginId });
    if (this.busyOwners.has(pluginId)) {
      throw new HelmxError('provider_stream_in_flight', `plugin ${pluginId} providers still have active streams/refreshes`, 409);
    }
  }
}

/** Helper factory for inline `definePlugin` test fixtures preserving execution order. */
function definePluginWith(id: string, fn: (ctx: import('@helmx/protocol').HelmxPluginContext) => void | Promise<void>): PluginDefinition {
  return { id, name: id, definePlugin: fn };
}

async function makeHost(plugins?: PluginProviderPort): Promise<{ host: PluginHost; dir: string }> {
  const dir = await makeTempDir('helmx-plugin-providers-');
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
// Declaration validation boundaries
// ---------------------------------------------------------------------------

test('provider declarations missing required shape are rejected explicitly', { timeout: 60_000 }, async () => {
  const { host, dir } = await makeHost(new FakeProviderRegistry());
  try {
    const bad = (over: Record<string, unknown>) =>
      definePluginWith('test:bad', (ctx) => {
        ctx.provider({ ...makeProvider('bad'), ...over } as unknown as Provider);
      });
    // Missing name
    await assert.rejects(() => host.register(bad({ name: undefined })), (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.code === 'invalid_provider_spec', `name validation failed: ${String(err)}`);
      return true;
    });
    // auth missing apiKey/oauth
    await assert.rejects(() => host.register(bad({ auth: {} })), (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.code === 'invalid_provider_spec', `auth validation failed: ${String(err)}`);
      return true;
    });
    // Missing streamSimple
    await assert.rejects(() => host.register(bad({ streamSimple: undefined })), (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.code === 'invalid_provider_spec', `streamSimple validation failed: ${String(err)}`);
      return true;
    });
    // Duplicate id
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
        assert.ok(err instanceof HelmxError && err.code === 'duplicate_provider', `duplicate validation failed: ${String(err)}`);
        return true;
      },
    );
  } finally {
    await dispose(host, dir);
  }
});

// ---------------------------------------------------------------------------
// enable / disable / re-enable
// ---------------------------------------------------------------------------

test('enable mounts, disable unmounts, and re-enable remounts with exact ownership and order', { timeout: 60_000 }, async () => {
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
    // enable: providers mount before service starts
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
    // disable: service stops first, then providers unmount in reverse order
    assert.deepEqual(events, ['service-start', 'service-stop']);
    assert.equal(registry.mounted.size, 0, 'all providers must unmount after disable');
    const disableCalls = registry.calls.filter((c) => c.op === 'assertIdle');
    // disable gate double-check: once before and once after collectPluginInUse (TOCTOU guard)
    assert.equal(disableCalls.length, 2, 'disable must preflight provider idle state');

    await host.enable('test:magpie');
    assert.deepEqual(events, ['service-start', 'service-stop', 'service-start']);
    assert.deepEqual(
      registry.calls.filter((c) => c.op === 'register').map((c) => c.providerId),
      ['magpie-a', 'magpie-b', 'magpie-a', 'magpie-b'],
      're-enable must remount all providers',
    );
    assert.deepEqual([...registry.mounted.entries()], [
      ['magpie-a', 'test:magpie'],
      ['magpie-b', 'test:magpie'],
    ]);
  } finally {
    await dispose(host, dir);
  }
});

test('default-disabled registration collects declarations without mounting providers while keeping configSchema', { timeout: 60_000 }, async () => {
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
    assert.equal(registry.calls.length, 0, 'disabled probe must never mount providers');
    assert.equal(registry.mounted.size, 0);
    const summary = host.list().find((p) => p.id === 'test:off');
    assert.ok(summary);
    assert.equal(summary.enabled, false);
    assert.deepEqual(host.getConfigSchema('test:off'), { token: { type: 'string', secret: true } });
  } finally {
    await dispose(host, dir);
  }
});

test('default-disabled plugin succeeds register even without providers port, and enable fails explicitly with 501', { timeout: 60_000 }, async () => {
  const { host, dir } = await makeHost();
  try {
    // Missing port: disabled probe must succeed (declaration does not mount), unaffected by missing port
    await host.register(
      definePluginWith('test:noport', (ctx) => {
        ctx.provider(makeProvider('nop-a'));
      }),
      { enabled: false },
    );
    // enable (mount phase): explicit 501, never silently skipped
    await assert.rejects(() => host.enable('test:noport'), (err: unknown) => {
      assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`);
      assert.equal(err.code, 'provider_port_unavailable');
      assert.equal(err.status, 501);
      return true;
    });
    // Returns cleanly to disabled state after failure with no leaks
    const summary = host.list().find((p) => p.id === 'test:noport');
    assert.ok(summary);
    assert.equal(summary.enabled, false);
  } finally {
    await dispose(host, dir);
  }
});

test('service.start runs after provider mounting finishes so services can depend on own providers', { timeout: 60_000 }, async () => {
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
    assert.deepEqual(seen, ['first'], 'own providers must already be mounted when service starts');
  } finally {
    await dispose(host, dir);
  }
});

test('register: capabilities stay hidden from listings until provider mount finishes (enabled+idle atomic commit)', { timeout: 60_000 }, async () => {
  const mountGate = deferred<void>();
  const port: PluginProviderPort = {
    register: async () => {
      await mountGate.promise;
      return async () => {};
    },
  };
  const { host, dir } = await makeHost(port);
  try {
    const registering = host.register({
      id: 'p:late-mount',
      definePlugin: (ctx) => {
        ctx.provider(makeProvider('late-provider'));
        ctx.action({
          id: 'ping',
          description: 'probe action',
          inputSchema: { type: 'object', additionalProperties: false },
          outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
          handler: () => ({ pong: true }),
        });
      },
    }, { enabled: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Before mount finishes: capabilities must not be exposed yet
    assert.deepEqual(host.listActions().filter((a) => a.pluginId === 'p:late-mount'), []);
    assert.equal(host.get('p:late-mount')?.enabled, false);
    mountGate.resolve();
    await registering;
    assert.equal(host.listActions().filter((a) => a.pluginId === 'p:late-mount').length, 1);
    const out = await host.invokeAction('p:late-mount', 'ping', {});
    assert.deepEqual(out, { pong: true });
  } finally {
    await dispose(host, dir);
  }
});

test('service.start failure releases all already-mounted providers in reverse order', { timeout: 60_000 }, async () => {
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
        assert.ok(err instanceof HelmxError, String(err));
        // Preserves existing service-start failure error code after reverse rollback of providers
        assert.equal(err.code, 'plugin_service_start_failed');
        return true;
      },
    );
    assert.equal(registry.mounted.size, 0, 'service start failure must release all mounted providers');
    assert.deepEqual(
      registry.calls.map((c) => `${c.op}:${c.providerId}`),
      ['register:p1', 'register:p2', 'unregister:p2', 'unregister:p1'],
      'rollback release must run in reverse order',
    );
    assert.equal(host.list().length, 0, 'failed registration must remove plugin completely');
  } finally {
    await dispose(host, dir);
  }
});

test('second provider mount failure releases the first provider', { timeout: 60_000 }, async () => {
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
        assert.ok(err instanceof HelmxError, String(err));
        // Port rejection (provider_register_conflict) diagnostic must be preserved
        assert.equal(err.code, 'provider_register_conflict');
        return true;
      },
    );
    assert.equal(registry.mounted.size, 0, 'partial mount failure must not leak first provider');
    assert.deepEqual(
      registry.calls.map((c) => `${c.op}:${c.providerId}`),
      ['register:first', 'unregister:first'],
    );
    assert.equal(host.list().length, 0);
  } finally {
    await dispose(host, dir);
  }
});

test('expired ctx (old epoch) can no longer declare providers', { timeout: 60_000 }, async () => {
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
    // Invoking provider on stale ctx after disable throws synchronously (assertOpen)
    assert.throws(() => stolen!(makeProvider('ghost')), (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.code === 'plugin_context_closed', String(err));
      return true;
    });
    assert.equal(registry.mounted.size, 0);
    await host.enable('test:stale');
    // Disabling again expires the stale handle once more (new epoch)
    await host.disable('test:stale');
    assert.throws(() => stolen!(makeProvider('ghost2')), (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.code === 'plugin_context_closed', String(err));
      return true;
    });
    assert.equal(registry.mounted.size, 0);
    assert.ok(!registry.calls.some((c) => c.providerId === 'ghost' || c.providerId === 'ghost2'), 'expired declarations must never mount');
  } finally {
    await dispose(host, dir);
  }
});

test('in-flight provider stream preflight rejects disable cleanly without leaving services partially stopped', { timeout: 60_000 }, async () => {
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
    // Simulate active stream so assertIdle rejects
    registry.busyOwners.add('test:busy');
    await assert.rejects(() => host.disable('test:busy'), (err: unknown) => {
      assert.ok(err instanceof HelmxError, String(err));
      assert.equal(err.code, 'provider_stream_in_flight', 'original port diagnostic must pass through');
      return true;
    });
    // Preflight rejected: service stays started, provider stays mounted, plugin stays enabled
    assert.deepEqual(events, ['started'], 'service must never stop when preflight rejects');
    assert.equal(registry.mounted.size, 1, 'provider must stay mounted when preflight rejects');
    const summary = host.list().find((p) => p.id === 'test:busy');
    assert.ok(summary && summary.enabled === true);
    // Clearing busy state allows disable to succeed
    registry.busyOwners.delete('test:busy');
    await host.disable('test:busy');
    assert.deepEqual(events, ['started', 'stopped']);
    assert.equal(registry.mounted.size, 0);
  } finally {
    await dispose(host, dir);
  }
});

test('unregister also preflights idle state before unmounting providers in reverse order', { timeout: 60_000 }, async () => {
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
    ], 'unregister must preflight first and unmount in reverse order');
    assert.equal(registry.mounted.size, 0);
    assert.equal(host.list().length, 0);
  } finally {
    await dispose(host, dir);
  }
});

test('provider unmount failure aggregates diagnostics explicitly instead of swallowing errors', { timeout: 60_000 }, async () => {
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
      assert.ok(err instanceof HelmxError, String(err));
      assert.equal(err.code, 'plugin_provider_unregister_failed');
      // Teardown aggregates under providerErrors; failing provider must be present in diagnostics
      const details = err.details as { providerErrors?: Array<{ providerId: string }>; unregisterErrors?: Array<{ providerId: string }> };
      const list = details.providerErrors ?? details.unregisterErrors;
      assert.ok(list?.some((e) => e.providerId === 'sticky'), `failed provider must appear in diagnostics: ${JSON.stringify(details)}`);
      return true;
    });
    // State: disabled (honest reporting), registry cleanup responsibility rests with port implementation
    const summary = host.list().find((p) => p.id === 'test:unreg-fail');
    assert.ok(summary && summary.enabled === false);
  } finally {
    await dispose(host, dir);
  }
});

test('plugins declaring no providers are unaffected when optional providers port is omitted', { timeout: 60_000 }, async () => {
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

test('disable works normally when providers port omits optional assertIdle preflight', { timeout: 60_000 }, async () => {
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
