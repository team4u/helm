/**
 * Dedicated tests for default-disabled plugin registration and enable/disable state persistence.
 *
 * Covers the host mechanisms behind default-disabled plugins such as `builtin:herdr`:
 * - `register(definition, { enabled: false })`: declaration phase still runs (preserving `configSchema`),
 *   but services never start, no UI is exposed, manifest reports `enabled: false`, and old `ctx` expires immediately;
 * - while disabled, `setConfig` works before `enable` (retaining `configSchema`);
 * - `enable` persists `true` and `disable` persists `false`; across "restarts" (new `PluginHost`
 *   with the same persistent store), persisted toggles override the declaration default;
 * - `locked` plugins remain enabled even if declared with `enabled: false`;
 * - explicit JSON-safe diagnostics when `stop` and/or persistence fail together;
 * - service `liveTasks` keep-alive gate: blocks `disable`/`unregister` even without tracker tasks,
 *   unblocks once empty, and fails explicitly on thrown errors or invalid return values.
 *
 * runner: tsx --test; explicit timeout: 60_000 per test to guard against deadlocks.
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
// Test infrastructure
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
    execEnv: async () => { throw new HelmError('unsupported', 'this fixture does not execute node commands', 501) },
    emitEvent: (type: string, p: unknown) => {
      events.push(`event:${type}`);
      payload.push({ type, payload: p });
    },
  };
  return Object.assign(api, { __payload: payload });
}

/** Event payload recorder (used for `plugin.changed` assertions). */
function payloadRecorder(hostApi: PluginHostBackend): Array<{ type: string; payload: unknown }> {
  return (hostApi as PluginHostBackend & { __payload?: Array<{ type: string; payload: unknown }> }).__payload ?? [];
}

/**
 * In-memory toggle persistence store: simulates `KernelRuntime` restart (reusing the same store
 * object across hosts is equivalent to persisting `config.json` and reloading; separate real
 * file store tests below cover the on-disk format).
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

/** Factory for a plugin definition whose service records start and stop calls. */
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
      ctx.configSchema({ endpoint: { type: 'string', label: 'Endpoint' } });
      ctx.ui.sidebarItem({ id: 'nav', label: 'Navigation' });
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
// Default-disabled registration: no external connection, no UI, schema kept, ctx expires immediately
// ---------------------------------------------------------------------------

test('enabled:false registration runs declarations for schema without starting services, exposing UI, or keeping old ctx', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const started: string[] = [];
  let stolen: Parameters<NonNullable<PluginDefinition['definePlugin']>>[0] | undefined;

  await host.register(
    servicePlugin('builtin:herdr', { onStart: () => started.push('start') }),
    { enabled: false },
  );

  // Service never starts (default-disabled does not connect to external Herdr service)
  assert.deepEqual(started, []);
  // Manifest reports enabled:false with empty hooks/actions/tools
  const summary = host.list().find((p) => p.id === 'builtin:herdr')!;
  assert.equal(summary.enabled, false);
  assert.deepEqual(summary.hooks, []);
  assert.deepEqual(summary.actions, []);
  assert.deepEqual(summary.tools, []);
  // UI contributions are empty (aligned between emitPluginChanged ui:[] and listUi)
  assert.deepEqual(host.listUi(), []);
  assert.deepEqual(host.listRoutes(), []);
  // Action/tool invocation rejects while disabled
  await assertRejectsCode(() => host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
  // runHook passes through unaffected
  const r = await host.runHook('trigger', {
    id: 'e1',
    source: 'test',
    text: 'x',
    createdAt: 1,
  });
  assert.equal(r.action, 'continue');
  // Registration emits plugin.changed(enabled:false / ui:[])
  // (recorder shares storage with events; see makeHostApi)
  // configSchema stays readable while disabled
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  // Host lifecycle assets (manageConversation) are released on disabled-registration path
  assert.ok(events.includes('release:builtin:herdr:7'));
  // Previous definePlugin context is closed (epoch bumped and retired)
  await host.register(
    {
      id: 'probe:ctx',
      definePlugin: (ctx) => {
        void ctx;
      },
    },
  );
  void stolen;
  // Direct assertion with captured ctx: register another plugin that saves ctx
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

test('disabled registration emits plugin.changed with enabled:false and ui:[]', { timeout: 60_000 }, async () => {
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
// Configure before enabling (configSchema preserved across disable)
// ---------------------------------------------------------------------------

test('setConfig while disabled then enable: config takes effect, definePlugin reads it, and service starts', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  const started: string[] = [];
  let configSeenInDefine: Record<string, unknown> | undefined;

  await host.register(
    {
      id: 'builtin:herdr',
      definePlugin: (ctx) => {
        ctx.configSchema({ endpoint: { type: 'string', required: true, label: 'Endpoint' } });
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

  // Configurable immediately while disabled (schema retained during declaration probe)
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  await host.setConfig('builtin:herdr', { endpoint: 'unix:///tmp/herdr.sock' });
  assert.equal(store.get('builtin:herdr')['endpoint'], 'unix:///tmp/herdr.sock');

  // Enable: service starts, definePlugin observes persisted config, enabled=true persisted
  await host.enable('builtin:herdr');
  assert.deepEqual(started, ['start']);
  assert.equal(configSeenInDefine!['endpoint'], 'unix:///tmp/herdr.sock');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);

  // Schema stays available after disable so config can be updated before next enable
  await host.disable('builtin:herdr');
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  await host.setConfig('builtin:herdr', { endpoint: 'unix:///tmp/other.sock' });
  assert.equal(store.enabled.get('builtin:herdr'), false);
});

test('disable clears active capabilities while retaining configSchema consistently with disabled registration', { timeout: 60_000 }, async () => {
  const host = makeHost(new MemoryToggleStore());
  await host.register(servicePlugin('builtin:herdr'));
  assert.equal(host.listUi().length, 1);
  await host.disable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.deepEqual(host.listUi(), []);
  assert.deepEqual(host.listRoutes(), []);
  // Schema retained
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
});

// ---------------------------------------------------------------------------
// Toggle state survives across restarts (in-memory store mock + real file store)
// ---------------------------------------------------------------------------

test('toggle state persists across restarts (in-memory store): enabled overrides disabled default; disabled overrides enabled default', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const h1 = makeHost(store);
  await h1.register(servicePlugin('builtin:herdr'), { enabled: false });
  await h1.enable('builtin:herdr');
  assert.equal(store.enabled.get('builtin:herdr'), true);

  // Restart: new PluginHost sharing the persistent store ignores declared enabled:false
  const h2 = makeHost(store);
  const started2: string[] = [];
  await h2.register(
    servicePlugin('builtin:herdr', { onStart: () => started2.push('start') }),
    { enabled: false },
  );
  assert.equal(h2.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.deepEqual(started2, ['start'], 'service must start on restart when persisted true');

  // After disable and restart, remains disabled despite enabled-by-default declaration
  await h2.disable('builtin:herdr');
  const h3 = makeHost(store);
  const started3: string[] = [];
  await h3.register(
    servicePlugin('builtin:herdr', { onStart: () => started3.push('start') }),
  );
  assert.equal(h3.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.deepEqual(started3, [], 'service must never start on restart when persisted false');
});

test('unpersisted plugins do not write defaults on register; in-memory host behavior unchanged', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  await host.register(servicePlugin('p:fresh'));
  assert.equal(host.list().find((p) => p.id === 'p:fresh')!.enabled, true);
  assert.equal(store.enabled.has('p:fresh'), false, 'register does not persist default toggle state');
  // Host without persistent store preserves existing in-memory enable/disable semantics
  const bare = makeHost();
  await bare.register(servicePlugin('p:bare'), { enabled: false });
  assert.equal(bare.list().find((p) => p.id === 'p:bare')!.enabled, false);
  await bare.enable('p:bare');
  await bare.disable('p:bare');
  assert.equal(bare.list().find((p) => p.id === 'p:bare')!.enabled, false);
});

test('HelmPluginConfigStore: pluginEnabled persists to config.json independently of plugins config/credentials across restarts', { timeout: 60_000 }, async () => {
  const credentialsDir = join(dataDir, 'cred');
  mkdirSync(credentialsDir, { recursive: true });
  const config = new ConfigService(dataDir);
  const credentials = new CredentialService(credentialsDir);
  const store = new HelmPluginConfigStore({ config, credentials });
  await store.load();

  assert.equal(store.getEnabled('builtin:herdr'), undefined, 'unpersisted plugin returns undefined');

  // Shares config.json with existing plugins config without interfering with each other
  await store.setEnabled('builtin:herdr', false);
  await store.setEnabled('builtin:profile', true);
  await store.set('builtin:herdr', { endpoint: 'unix:///x' }, { endpoint: { type: 'string' } });

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'builtin:herdr': false, 'builtin:profile': true });
  assert.deepEqual(raw['plugins'], { 'builtin:herdr': { endpoint: 'unix:///x' } }, 'pluginEnabled and plugins config are separate');

  // New instance (simulated restart): getEnabled can read synchronously after load warmup
  const store2 = new HelmPluginConfigStore({ config: new ConfigService(dataDir), credentials: new CredentialService(credentialsDir) });
  await store2.load();
  assert.equal(store2.getEnabled('builtin:herdr'), false);
  assert.equal(store2.getEnabled('builtin:profile'), true);
  assert.equal(store2.getEnabled('p:unknown'), undefined);
  assert.equal(store2.get('builtin:herdr')['endpoint'], 'unix:///x');
});

test('HelmPluginConfigStore load: invalid structure or non-boolean pluginEnabled fails explicitly with config_corrupt', { timeout: 60_000 }, async () => {
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

test('HelmPluginConfigStore setEnabled: non-boolean argument fails 400 validation_error without disk write', { timeout: 60_000 }, async () => {
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
// locked protection
// ---------------------------------------------------------------------------

test('locked plugin stays enabled even when registered with enabled:false, and disable rejects 403', { timeout: 60_000 }, async () => {
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
  // locked does not persist any toggle state (rejected disable produces no write side effects)
  assert.equal(store.enabled.has('builtin:profile'), false);
});

// ---------------------------------------------------------------------------
// Dual failure diagnostics: stop failure / persistence failure
// ---------------------------------------------------------------------------

test('disable persistence failure: plugin is still deactivated, emits plugin.changed(enabled:false, ui:[]), and throws JSON-safe error', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  store.failSetEnabled = new Error('read-only disk');
  const host = makeHost(store);
  await host.register(servicePlugin('builtin:herdr'));
  assert.equal(host.listUi().length, 1);

  const rec = recorder;
  const before = pluginChangedPayloads(rec).length;
  const err = (await assertRejectsCode(() => host.disable('builtin:herdr'), 'plugin_enabled_persist_failed')) as HelmError;
  assert.equal(err.status, 500);
  assert.match(err.message, /read-only disk/);
  assert.doesNotThrow(() => JSON.stringify(err.details));

  // Actual state: disabled, UI cleared, real state frame emitted
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.deepEqual(host.listUi(), []);
  const changed = pluginChangedPayloads(rec);
  assert.equal(changed.length, before + 1);
  assert.equal(changed.at(-1)!.plugin.enabled, false);
  assert.deepEqual(changed.at(-1)!.ui, []);
});

test('disable dual failure (stop + persist): stop error is primary and persistError is aggregated in details', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  store.failSetEnabled = new Error('disk full');
  const host = makeHost(store);
  await host.register(
    servicePlugin('builtin:herdr', {
      onStop: () => {
        throw new Error('svc crashed');
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
    [['daemon', 'svc crashed']],
  );
  assert.doesNotThrow(() => JSON.stringify(err.details));
  // Original persistence failure message is preserved inside details.persistError
  assert.match(JSON.stringify(err.details), /disk full/);
  // State is disabled and real state frame is still emitted despite dual failures
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.equal(pluginChangedPayloads(rec).length, before + 1);
});

test('enable persistence failure: rolls back to disabled, emits no enabled event, and recovers cleanly on retry', { timeout: 60_000 }, async () => {
  const store = new MemoryToggleStore();
  const host = makeHost(store);
  await host.register(servicePlugin('builtin:herdr'), { enabled: false });

  store.failSetEnabled = new Error('network disconnected');
  const rec = recorder;
  const before = pluginChangedPayloads(rec).length;
  const err = (await assertRejectsCode(() => host.enable('builtin:herdr'), 'plugin_enabled_persist_failed')) as HelmError;
  assert.match(err.message, /network disconnected/);
  assert.doesNotThrow(() => JSON.stringify(err.details));

  // Rolled back: disabled, service stopped, no enabled:true event emitted
  const summary = host.list().find((p) => p.id === 'builtin:herdr')!;
  assert.equal(summary.enabled, false);
  const changed = pluginChangedPayloads(rec);
  assert.equal(changed.length, before, 'failed enable must not publish any plugin.changed');

  // Can re-enable cleanly after store recovers
  store.failSetEnabled = undefined;
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

// ---------------------------------------------------------------------------
// Service liveTasks keep-alive gate
// ---------------------------------------------------------------------------

test('liveTasks keep-alive gate blocks disable/unregister even without tracker tasks and allows disable once drained', { timeout: 60_000 }, async () => {
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
  // Rejected disable has no side effects: service stays running and toggle is not persisted
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.has('builtin:herdr'), false);
  const errU = (await assertRejectsCode(() => host.unregister('builtin:herdr'), 'plugin_has_live_tasks')) as HelmError;
  assert.deepEqual((errU.details as { activeTasks: string[] }).activeTasks, ['pane:win-1']);

  // Can disable once active tasks drain
  panes.clear();
  await host.disable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.equal(store.enabled.get('builtin:herdr'), false);
});

test('liveTasks exception or invalid output fails explicitly with plugin_live_tasks_check_failed rather than passing empty', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    servicePlugin('builtin:herdr', {
      liveTasks: () => {
        throw new Error('tracker callback crashed');
      },
    }),
  );
  const err = (await assertRejectsCode(() => host.disable('builtin:herdr'), 'plugin_live_tasks_check_failed')) as HelmError;
  assert.equal(err.status, 500);
  const details = err.details as { serviceId: string; error: { message: string } };
  assert.equal(details.serviceId, 'daemon');
  assert.equal(details.error.message, 'tracker callback crashed');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true, 'check failure does not mutate enabled state');

  // Invalid return type (non-string array): fails explicitly as well
  const host2 = makeHost();
  await host2.register(
    servicePlugin('builtin:herdr', {
      liveTasks: (() => ['ok', 42]) as unknown as () => string[],
    }),
  );
  await assertRejectsCode(() => host2.disable('builtin:herdr'), 'plugin_live_tasks_check_failed');
});

test('liveTasks registration validation rejects non-function with invalid_service_spec; unstarted services skip check', { timeout: 60_000 }, async () => {
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
  assert.equal(host.list().find((p) => p.id === 'p:bad'), undefined, 'invalid declaration fails entire registration');

  // Declaring liveTasks on a non-started service (disabled registration) skips the gate
  const host2 = makeHost();
  await host2.register(
    servicePlugin('builtin:herdr', { liveTasks: () => ['ghost'] }),
    { enabled: false },
  );
  assert.equal(host2.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
});

// ---------------------------------------------------------------------------
// Epoch / old ctx expiration (disabled registration and enable rebuild new cycle)
// ---------------------------------------------------------------------------

test('disabled registration and re-enable each retire old ctx and rebuild a new epoch cycle', { timeout: 60_000 }, async () => {
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
  // Enable enters a fresh cycle; subsequent disable expires that cycle's ctx as well
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  await host.disable('builtin:herdr');
  assert.throws(
    () => stolen!.action({ id: 'x', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, handler: () => ({}) }),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_closed',
  );
});

test('register rolls back cleanly regardless of options.enabled when definePlugin throws', { timeout: 60_000 }, async () => {
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
