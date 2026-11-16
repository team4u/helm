/**
 * plugin by default deactivate register / start stop state persist dedicated items test.
 *
 * override (builtin:herdr by default deactivate scenario host mechanism):
 * - register(definition, { enabled: false }): declaration still run (obtain configSchema),
 *   but service never start, without UI,manifest enabled:false, old ctx i.e. moment expires;
 * - deactivate state can first setConfig again enable(configSchema keep do not lose);
 * - enable after success durable true;disable after durable false; across restart (new PluginHost
 *   + the same durable store) switch keep: once persist plugin no longer back to declaration default;
 * - locked plugin constant enable (declaration enabled:false also strong row enable);
 * - stop failed / persist failed double failed explicit JSON-safe diagnose;
 * - service declaration liveTasks keep-alive gate: without tracker task when still block stop disable/unregister,
 *   task empty after can deactivate;liveTasks exception/illegal output explicit errors never when empty.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigService,
  CredentialService,
} from '../src/services/index.js';
import { HelmPluginConfigStore } from '../src/runtime/plugin-config-store.js';
import { HelmError, type PluginDefinition } from '@helm/protocol';
import {
  PluginHost,
  type PluginConfigStore,
  type PluginHostBackend,
} from '../src/plugins/index.js';
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js';
import { createPluginBuildProvider } from '@helm/plugin-build';
import {
  MemoryDocStore,
  assertRejectsCode,
  cleanupDir,
  makeConversationSummary,
  makeTempDir,
} from './helpers.js';

// ---------------------------------------------------------------------------
// test base create
// ---------------------------------------------------------------------------

function makeConversation(id: number) {
  return makeConversationSummary({ id, profileId: 'default' });
}

function makeHostApi(events: string[]): PluginHostBackend & { __payload: Array<{ type: string; payload: unknown }> } {
  const payload: Array<{ type: string; payload: unknown }> = [];
  const api: PluginHostBackend & { __payload: Array<{ type: string; payload: unknown }> } = {
    ...createPluginHostBackendFixture(),
    __payload: payload,
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
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmError('unsupported', 'this fixture do not execute node command', 501) },
    emitEvent: (type: string, p: unknown) => {
      events.push(`event:${type}`);
      payload.push({ type, payload: p });
    },
  };
  return Object.assign(api, { __payload: payload });
}

/** event payload record (plugin.changed assertion use). */
function payloadRecorder(hostApi: PluginHostBackend): Array<{ type: string; payload: unknown }> {
  return (hostApi as PluginHostBackend & { __payload?: Array<{ type: string; payload: unknown }> }).__payload ?? [];
}

/**
 * memory start stop persist store: simulated KernelRuntime restart (the same store object across host re- use
 * etc. price at config.json after heavy read; another has real file store test override format).
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
  return new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: api, docs, config });
}

/** declaration service start/stop all record plugin define work vendor. */
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
      ctx.configSchema({ endpoint: { type: 'string', label: 'end point' } });
      ctx.ui.sidebarItem({ id: 'nav', label: 'navigation' });
      ctx.hook.onTrigger(() => ({ action: 'continue' as const }));
      ctx.action({
        id: 'ping',
        description: 'probe',
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

beforeEach(async () => {
  dataDir = await makeTempDir('helm-plugin-toggle-test-');
  docs = new MemoryDocStore();
  events = [];
});

afterEach(async () => {
  await cleanupDir(dataDir);
});

// ---------------------------------------------------------------------------
// by default deactivate register: do not connect external service, without UI,schema available,ctx i.e. moment expires
// ---------------------------------------------------------------------------

test('enabled:false register: declaration run obtain schema, but service do not start, without UI, action reject, old ctx expires', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const started: string[] = [];
  let stolen: Parameters<NonNullable<PluginDefinition['definePlugin']>>[0] | undefined;

  await host.register(
    servicePlugin('builtin:herdr', { onStart: () => started.push('start') }),
    { enabled: false },
  );

  // service never start (by default deactivate = do not connect external Herdr service)
  assert.deepEqual(started, []);
  // manifest:enabled:false and hooks/actions/tools all empty
  const summary = host.list().find((p) => p.id === 'builtin:herdr')!;
  assert.equal(summary.enabled, false);
  assert.deepEqual(summary.hooks, []);
  assert.deepEqual(summary.actions, []);
  assert.deepEqual(summary.tools, []);
  // UI contribution is empty (emitPluginChanged  ui:[] and listUi consistent)
  assert.deepEqual(host.listUi(), []);
  assert.deepEqual(host.listRoutes(), []);
  // action/tool in deactivate state reject
  await assertRejectsCode(() => host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
  // runHook without reference and direct through
  const r = await host.runHook('trigger', {
    id: 'e1',
    source: 'test',
    text: 'x',
    createdAt: 1,
  });
  assert.equal(r.action, 'continue');
  // register i.e. plugin.changed(enabled:false / ui:[])
  // (recorder and events sharing, see makeHostApi implement)
  // configSchema keep (deactivate state can read)
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  // host lifecycle asset (manageConversation) in deactivate register path already release
  assert.ok(events.includes('release:builtin:herdr:7'));
  // old definePlugin context already close (epoch pass increase abandon dismiss)
  await host.register(
    {
      id: 'probe:ctx',
      definePlugin: (ctx) => {
        void ctx;
      },
    },
  );
  void stolen;
  // directly assertion stolen ctx: re- register a truly stealthily ctx plugin
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

test('deactivate register path plugin.changed event:enabled:false and ui:[]', { timeout: 60_000 }, async () => {
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
// first config again enable (configSchema do not because disable lose)
// ---------------------------------------------------------------------------

test('deactivate state first setConfig again enable: config takes effect,definePlugin getConfig read to, service start', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const started: string[] = [];
  let configSeenInDefine: Record<string, unknown> | undefined;

  await host.register(
    {
      id: 'builtin:herdr',
      definePlugin: (ctx) => {
        ctx.configSchema({ endpoint: { type: 'string', required: true, label: 'end point' } });
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

  // deactivate state i.e. can config (schema keep is before mention)
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  await host.setConfig('builtin:herdr', { endpoint: 'unix:///tmp/herdr.sock' });
  assert.equal(store.get('builtin:herdr')['endpoint'], 'unix:///tmp/herdr.sock');

  // enable: service start,definePlugin read to already durable config, durable true
  await host.enable('builtin:herdr');
  assert.deepEqual(started, ['start']);
  assert.equal(configSeenInDefine!['endpoint'], 'unix:///tmp/herdr.sock');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);

  // disable after schema still keep, can again change config (supply under time enable)
  await host.disable('builtin:herdr');
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  await host.setConfig('builtin:herdr', { endpoint: 'unix:///tmp/other.sock' });
  assert.equal(store.enabled.get('builtin:herdr'), false);
});

test('disable empty run phase register but keep configSchema: and deactivate register form consistent', { timeout: 60_000 }, async () => {
  const host = makeHost(new MemoryToggleStore());
  await host.register(servicePlugin('builtin:herdr'));
  assert.equal(host.listUi().length, 1);
  await host.disable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.deepEqual(host.listUi(), []);
  assert.deepEqual(host.listRoutes(), []);
  // schema keep
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
});

// ---------------------------------------------------------------------------
// across restarts switch keep (memory store simulated + real file store )
// ---------------------------------------------------------------------------

test('across restarts switch keep (memory store):disable after new host register(default) still deactivate;enable after restart still enable', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const h1 = makeHost(store);
  await h1.register(servicePlugin('builtin:herdr'), { enabled: false });
  await h1.enable('builtin:herdr');
  assert.equal(store.enabled.get('builtin:herdr'), true);

  // restart: new PluginHost sharing the same durable store; declaration enabled:false also no longer takes effect
  const h2 = makeHost(store);
  const started2: string[] = [];
  await h2.register(
    servicePlugin('builtin:herdr', { onStart: () => started2.push('start') }),
    { enabled: false },
  );
  assert.equal(h2.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.deepEqual(started2, ['start'], 'durable true when restart must start service');

  // disable after restart: declaration default (enabled by default true) also keep deactivate
  await h2.disable('builtin:herdr');
  const h3 = makeHost(store);
  const started3: string[] = [];
  await h3.register(
    servicePlugin('builtin:herdr', { onStart: () => started3.push('start') }),
  );
  assert.equal(h3.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.deepEqual(started3, [], 'durable false when restart never start service');
});

test('from not persisted when do not write default value:register after store without record, in-memory host behavior do not change', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  await host.register(servicePlugin('p:fresh'));
  assert.equal(host.list().find((p) => p.id === 'p:fresh')!.enabled, true);
  assert.equal(store.enabled.has('p:fresh'), false, 'register do not write by default start stop value');
  // in-memory host(without store): start stop do not persist, semantics keep since has
  const bare = makeHost();
  await bare.register(servicePlugin('p:bare'), { enabled: false });
  assert.equal(bare.list().find((p) => p.id === 'p:bare')!.enabled, false);
  await bare.enable('p:bare');
  await bare.disable('p:bare');
  assert.equal(bare.list().find((p) => p.id === 'p:bare')!.enabled, false);
});

test('HelmPluginConfigStore:pluginEnabled independent config.json, and plugins config/credentials separate, across instance restart keep', { timeout: 60_000 }, async () => {
  const credentialsDir = join(dataDir, 'cred');
  mkdirSync(credentialsDir, { recursive: true });
  const config = new ConfigService(dataDir);
  const credentials = new CredentialService(credentialsDir);
  const store = new HelmPluginConfigStore({ config, credentials });
  await store.load();

  assert.equal(store.getEnabled('builtin:herdr'), undefined, 'from not persisted return undefined');

  // and since has plugins config,credentials shared store the same config.json: mutual do not interference
  await store.setEnabled('builtin:herdr', false);
  await store.setEnabled('builtin:profile', true);
  await store.set('builtin:herdr', { endpoint: 'unix:///x' }, { endpoint: { type: 'string' } });

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'builtin:herdr': false, 'builtin:profile': true });
  assert.deepEqual(raw['plugins'], { 'builtin:herdr': { endpoint: 'unix:///x' } }, 'pluginEnabled and plugins config separate');

  // new instance (simulated restart):load warm up after getEnabled sync can read
  const store2 = new HelmPluginConfigStore({ config: new ConfigService(dataDir), credentials: new CredentialService(credentialsDir) });
  await store2.load();
  assert.equal(store2.getEnabled('builtin:herdr'), false);
  assert.equal(store2.getEnabled('builtin:profile'), true);
  assert.equal(store2.getEnabled('p:unknown'), undefined);
  assert.equal(store2.get('builtin:herdr')['endpoint'], 'unix:///x');
});

test('HelmPluginConfigStore load:pluginEnabled illegal structure/non- boolean value explicit config_corrupt, never static default ignore', { timeout: 60_000 }, async () => {
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

test('HelmPluginConfigStore setEnabled: non- boolean reference 400 validation_error, do not trigger', { timeout: 60_000 }, async () => {
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
// locked protect
// ---------------------------------------------------------------------------

test('locked plugin constant enable: declaration enabled:false also strong row enable,disable 403', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const started: string[] = [];
  await host.register(
    servicePlugin('builtin:profile', { onStart: () => started.push('start'), locked: true }),
    { enabled: false },
  );
  assert.equal(host.list().find((p) => p.id === 'builtin:profile')!.enabled, true);
  assert.deepEqual(started, ['start']);
  await assertRejectsCode(() => host.disable('builtin:profile'), 'plugin_locked');
  // locked not persisted any start stop value (disable by refuse produces no write side effect)
  assert.equal(store.enabled.has('builtin:profile'), false);
});

// ---------------------------------------------------------------------------
// double failed diagnose:stop failed / persist failed
// ---------------------------------------------------------------------------

test('disable persist failed: actual deactivated still real plugin.changed(enabled:false, ui:[]), diagnose explicit on throw and can JSON serialization', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  store.failSetEnabled = new Error('disk only read');
  const host = makeHost(store);
  await host.register(servicePlugin('builtin:herdr'));
  assert.equal(host.listUi().length, 1);

  const rec = recorder;
  const before = pluginChangedPayloads(rec).length;
  const err = (await assertRejectsCode(() => host.disable('builtin:herdr'), 'plugin_enabled_persist_failed')) as HelmError;
  assert.equal(err.status, 500);
  assert.match(err.message, /disk only read/);
  assert.doesNotThrow(() => JSON.stringify(err.details));

  // actual state: deactivated,UI empty, event already (real state frame)
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.deepEqual(host.listUi(), []);
  const changed = pluginChangedPayloads(rec);
  assert.equal(changed.length, before + 1);
  assert.equal(changed.at(-1)!.plugin.enabled, false);
  assert.deepEqual(changed.at(-1)!.ui, []);
});

test('disable stop and persist double failed:stop diagnose is main chain,persistError aggregate enter details', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  store.failSetEnabled = new Error('full');
  const host = makeHost(store);
  await host.register(
    servicePlugin('builtin:herdr', {
      onStop: () => {
        throw new Error('svc blast');
      },
    }),
  );
  const rec = recorder;
  const before = pluginChangedPayloads(rec).length;
  const err = (await assertRejectsCode(() => host.disable('builtin:herdr'), 'plugin_service_stop_failed')) as HelmError;
  const details = err.details as {
    stopErrors: Array<{ serviceId: string; error: { message: string } }>;
    persistError: { message: string };
  };
  assert.deepEqual(
    details.stopErrors.map((e) => [e.serviceId, e.error.message]),
    [['daemon', 'svc blast']],
  );
  assert.doesNotThrow(() => JSON.stringify(err.details));
  // persist failed original information keep (package in persistError diagnose in)
  assert.match(JSON.stringify(err.details), /full/);
  // state deactivated and event already (three heavy wrap-up do not lose real state frame)
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.equal(pluginChangedPayloads(rec).length, before + 1);
});

test('enable persist failed: rollback is deactivate, do not publish enabled event, can again enable, diagnose explicit', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  await host.register(servicePlugin('builtin:herdr'), { enabled: false });

  store.failSetEnabled = new Error('network disconnect');
  const rec = recorder;
  const before = pluginChangedPayloads(rec).length;
  const err = (await assertRejectsCode(() => host.enable('builtin:herdr'), 'plugin_enabled_persist_failed')) as HelmError;
  assert.match(err.message, /network disconnect/);
  assert.doesNotThrow(() => JSON.stringify(err.details));

  // rollback: deactivate, service already stop, without enabled:true event frame
  const summary = host.list().find((p) => p.id === 'builtin:herdr')!;
  assert.equal(summary.enabled, false);
  const changed = pluginChangedPayloads(rec);
  assert.equal(changed.length, before, 'enable failed do not publish any plugin.changed');

  // restore after can again enable succeeded
  store.failSetEnabled = undefined;
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

// ---------------------------------------------------------------------------
// service declaration liveTasks keep-alive gate
// ---------------------------------------------------------------------------

test('liveTasks declaration keep-alive task: without tracker in-flight task when still reject disable/unregister, task empty after can deactivate', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const panes = new Set<string>();
  await host.register(
    servicePlugin('builtin:herdr', { liveTasks: () => [...panes].map((p) => `pane:${p}`) }),
  );

  panes.add('win-1');
  const err = (await assertRejectsCode(() => host.disable('builtin:herdr'), 'plugin_has_live_tasks')) as HelmError;
  assert.equal(err.status, 409);
  assert.deepEqual((err.details as { activeTasks: string[] }).activeTasks, ['pane:win-1']);
  // reject path produces no side effect: not stop, not persisted, state not change
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.has('builtin:herdr'), false);
  const errU = (await assertRejectsCode(() => host.unregister('builtin:herdr'), 'plugin_has_live_tasks')) as HelmError;
  assert.deepEqual((errU.details as { activeTasks: string[] }).activeTasks, ['pane:win-1']);

  // task empty after can deactivate
  panes.clear();
  await host.disable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.equal(store.enabled.get('builtin:herdr'), false);
});

test('liveTasks exception or illegal output: explicit plugin_live_tasks_check_failed, never when empty let through', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    servicePlugin('builtin:herdr', {
      liveTasks: () => {
        throw new Error('for account crash');
      },
    }),
  );
  const err = (await assertRejectsCode(() => host.disable('builtin:herdr'), 'plugin_live_tasks_check_failed')) as HelmError;
  assert.equal(err.status, 500);
  const details = err.details as { serviceId: string; error: { message: string } };
  assert.equal(details.serviceId, 'daemon');
  assert.equal(details.error.message, 'for account crash');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true, 'check failed does not change state');

  // illegal return type (non- string array): same explicit errors
  const host2 = makeHost();
  await host2.register(
    servicePlugin('builtin:herdr', {
      liveTasks: (() => ['ok', 42]) as unknown as () => string[],
    }),
  );
  await assertRejectsCode(() => host2.disable('builtin:herdr'), 'plugin_live_tasks_check_failed');
});

test('liveTasks register validate: non- function explicit invalid_service_spec; not declaration/not start service does not participate check', { timeout: 60_000 }, async () => {
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
  assert.equal(host.list().find((p) => p.id === 'p:bad'), undefined, 'illegal declaration register whole failed');

  // declaration liveTasks but service not started(deactivate register path): does not participate gate, can normal deactivate state
  const host2 = makeHost();
  await host2.register(
    servicePlugin('builtin:herdr', { liveTasks: () => ['ghost'] }),
    { enabled: false },
  );
  assert.equal(host2.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
});

// ---------------------------------------------------------------------------
// epoch / old ctx expires (deactivate register and enable rebuild new cycle)
// ---------------------------------------------------------------------------

test('deactivate register old ctx and enable after old ctx all expires: new cycle rebuild', { timeout: 60_000 }, async () => {
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
  // enable enter new cycle succeeded; then disable make new cycle ctx also expires
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  await host.disable('builtin:herdr');
  assert.throws(
    () => stolen!.action({ id: 'x', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, handler: () => ({}) }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_closed',
  );
});

test('register define throws: regardless of options.enabled and otherwise, register whole rollback remove', { timeout: 60_000 }, async () => {
  const host = makeHost(new MemoryToggleStore());
  const bad: PluginDefinition = {
    id: 'p:boom',
    definePlugin: () => {
      throw new Error('define crash');
    },
  };
  await assertRejectsCode(() => host.register(bad, { enabled: false }), 'plugin_registration_failed');
  await assertRejectsCode(() => host.register(bad), 'plugin_registration_failed');
  assert.equal(host.list().find((p) => p.id === 'p:boom'), undefined);
});
