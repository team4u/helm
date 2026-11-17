/**
 * Deterministic regression tests for plugin lifecycle races (independent of sleep timing):
 *
 * 1. `enable` commit point occurs after toggle persistence succeeds: while pending, the service is
 *    already started, yet actions reject, hooks never run, and UI stays hidden; once persisted,
 *    everything becomes available. If persistence fails, there are zero in-flight tasks and rollback
 *    is clean (controlled via a deferred gate in store `setEnabled`).
 * 2. Registration parses the persisted enabled state before acquiring any assets: when `getEnabled`
 *    throws (preserving the original error) or returns a non-boolean value (explicitly rejected),
 *    registry, hooks, managed assets, and plugin data directory have zero leftover state.
 * 3. `HelmPluginConfigStore` read-modify-write runs entirely inside the `ConfigService.update`
 *    file-lock callback: it mutates only its own nested key without clobbering keys updated
 *    concurrently by other modules (verified deterministically by interposing writes at `updateBy`
 *    entry — waiting outside the lock and performing no second read inside, avoiding deadlock);
 *    writing while `pluginEnabled` or `plugins` is corrupt fails explicitly with `config_corrupt`
 *    and never rebuilds with `{}`.
 *
 * runner: tsx --test; explicit timeout: 60_000 per test to guard against deadlocks.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService, CredentialService } from '../src/services/index.js';
import { HelmPluginConfigStore } from '../src/runtime/plugin-config-store.js';
import { HelmError, type PluginDefinition } from '@helm/protocol';
import {
  PluginHost,
  type PluginConfigStore,
  type PluginHostBackend,
} from '../src/plugins/index.js';
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js';
import { pluginDataDirName } from '../src/plugins/plugin-dir-name.js';
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

function makeHostApi(events: string[]): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
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
    onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmError('unsupported', 'this fixture does not execute node commands', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('this fixture does not support file mutation queue') },
    emitEvent: (type) => {
      events.push(`event:${type}`);
    },
  };
}

/**
 * Gated toggle persistence store: invokes `onSetEnabled` before committing the toggle,
 * allowing tests to construct a deterministic persistence suspension window without sleeps.
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

/** Factory for a plugin declaring the full surface (UI / action / hook / service / managed asset). */
function fullPlugin(id: string, marks: string[]): PluginDefinition {
  return {
    id,
    definePlugin: (ctx) => {
      ctx.configSchema({ endpoint: { type: 'string', label: 'Endpoint' } });
      ctx.ui.sidebarItem({ id: 'nav', label: 'Navigation' });
      ctx.hook.onTrigger(() => {
        marks.push('hook-ran');
        return { action: 'continue' as const };
      });
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

function triggerPayload(id = 'e1') {
  return { id, source: 'test', text: 'x', createdAt: 1 };
}

let dataDir: string;
let docs: MemoryDocStore;
let events: string[];

function makeHost(config?: PluginConfigStore): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: makeHostApi(events), docs, config });
}

beforeEach(async () => {
  dataDir = await makeTempDir('helm-plugin-races-test-');
  docs = new MemoryDocStore();
  events = [];
});

afterEach(async () => {
  await cleanupDir(dataDir);
});

// ---------------------------------------------------------------------------
// 1. enable commit point occurs after toggle persistence succeeds
// ---------------------------------------------------------------------------

test('enable persistence window: service already started while actions reject, hooks stay inactive, and UI stays hidden until commit', { timeout: 60_000 }, async () => {
  const store = new GatedStore();
  const host = makeHost(store);
  const marks: string[] = [];
  await host.register(fullPlugin('builtin:herdr', marks), { enabled: false });

  // Gate control: suspend inside setEnabled until test releases it (deterministic window)
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
    // Inside window: service has started, but plugin remains completely unavailable externally (uncommitted)
    assert.deepEqual(marks, ['svc-start'], 'service has started before persistence completes');
    await assertRejectsCode(() => host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
    marks.length = 0;
    const r = await host.runHook('trigger', triggerPayload());
    assert.equal(r.action, 'continue');
    assert.deepEqual(marks, [], 'hook handlers never run inside the suspension window');
    assert.deepEqual(host.listUi(), [], 'UI is not exposed inside the suspension window');
    assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  } finally {
    release();
    await enabling;
  }

  // After commit: actions work, hooks run, UI is exposed, and state is persisted true
  assert.deepEqual(await host.invokeAction('builtin:herdr', 'ping', {}), { ok: true });
  marks.length = 0;
  const r2 = await host.runHook('trigger', triggerPayload());
  assert.equal(r2.action, 'transform');
  assert.deepEqual(marks, ['hook-ran']);
  assert.equal(host.listUi().length, 1);
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

test('enable persistence failure: stays unavailable in window, rolls back cleanly with zero active tasks, preserves schema, and retries cleanly', { timeout: 60_000 }, async () => {
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
    await assertRejectsCode(() => host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
    assert.deepEqual(host.listUi(), []);
  } catch (err) {
    windowHeld = false;
    rejectPersist(new Error('cleanup'));
    await enabling.catch(() => {});
    throw err;
  }
  assert.ok(windowHeld);
  rejectPersist(new Error('network disconnected'));

  const err = (await assertRejectsCode(() => enabling, 'plugin_enabled_persist_failed')) as HelmError;
  assert.match(err.message, /network disconnected/);

  // Rollback: disabled, service stopped, managed asset released, schema retained, zero active tasks
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.ok(marks.includes('svc-stop'), 'started service stopped in reverse order');
  assert.ok(events.includes('release:builtin:herdr:7'), 'managed asset released');
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  assert.deepEqual(host.listUi(), []);
  assert.equal(host.activeTaskCount('builtin:herdr'), 0, 'zero active tasks after rollback');
  assert.equal(store.enabled.has('builtin:herdr'), false, 'failed persistence writes no toggle value');

  // Re-enables cleanly once store recovers
  store.onSetEnabled = () => {};
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

// ---------------------------------------------------------------------------
// 2. register resolves persisted toggle before acquiring any assets: zero leftovers if getter fails
// ---------------------------------------------------------------------------

test('getEnabled throws: register leaves zero leftovers (registry / dataDir / hooks / managed assets) and preserves original error', { timeout: 60_000 }, async () => {
  const host = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      throw new HelmError('io_broken', 'store read crash', 500);
    },
    setEnabled() {},
  });
  await assertRejectsCode(() => host.register(fullPlugin('p:boom', [])), 'io_broken');

  assert.equal(host.list().length, 0, 'zero leftovers in plugin registry');
  assert.equal(existsSync(join(dataDir, 'plugins', pluginDataDirName('p:boom'))), false, 'plugin data directory not created');
  assert.deepEqual(events.filter((e) => e.startsWith('manage:')), [], 'no host assets acquired');
  const r = await host.runHook('trigger', triggerPayload());
  assert.equal(r.action, 'continue', 'zero leftovers in hook pipeline');

  // Non-HelmError exceptions: wrapped as plugin_registration_failed while preserving original message
  const host2 = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      throw new Error('underlying I/O timeout');
    },
    setEnabled() {},
  });
  const wrapped = (await assertRejectsCode(() => host2.register(fullPlugin('p:boom2', [])), 'plugin_registration_failed')) as HelmError;
  assert.match(wrapped.message, /underlying I\/O timeout/);
  assert.equal(host2.list().length, 0);

  // Host stays healthy: subsequent registrations succeed normally
  const ok = makeHost();
  await ok.register(fullPlugin('p:healthy', []), { enabled: false });
  assert.equal(ok.list().find((p) => p.id === 'p:healthy')!.enabled, false);
});

test('getEnabled returns non-boolean value: rejected explicitly (no truthy coercion) with zero leftovers', { timeout: 60_000 }, async () => {
  const host = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      return 'false' as unknown as boolean; // String 'false' is truthy and must never coerce to enabled
    },
    setEnabled() {},
  });
  const err = (await assertRejectsCode(() => host.register(fullPlugin('p:lie', [])), 'plugin_enabled_state_invalid')) as HelmError;
  assert.equal(err.status, 500);
  assert.equal(host.list().length, 0);
  assert.equal(existsSync(join(dataDir, 'plugins', pluginDataDirName('p:lie'))), false);
  assert.deepEqual(events.filter((e) => e.startsWith('manage:')), []);
});

// ---------------------------------------------------------------------------
// 3. ConfigService callback form + HelmPluginConfigStore in-lock read-modify-write
// ---------------------------------------------------------------------------

/**
 * Deterministically injects one concurrent write at `updateBy` entry (self-disarming after firing).
 * Injection runs right before acquiring the lock: waits outside the lock and skips second reads inside,
 * preventing deadlock. Both old and new implementations pass through here (object/function updates both
 * delegate to `updateBy`): an out-of-lock stale snapshot would overwrite intervening writes, whereas the
 * callback sees the latest in-lock state and updates only its owned keys.
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

test('ConfigService callback form reads latest in-lock value while preserving object-patch semantics', { timeout: 60_000 }, async () => {
  const a = new ConfigService(dataDir);
  const b = new ConfigService(dataDir);
  await Promise.all([a.update({ k1: 'v1' }), b.update({ k2: 'v2' })]);
  const out = await a.update((current) => ({ ...current, k1Upper: String(current['k1']).toUpperCase() }));
  assert.equal(out['k1Upper'], 'V1', 'callback observes latest k1 inside lock (even from non-empty initial file)');
  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw, { k1: 'v1', k2: 'v2', k1Upper: 'V1' });
});

test('setEnabled during concurrent updates to auth/other keys never overwrites them with stale snapshots (deterministic injection)', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfg = new InterposingConfigService(dataDir);
  const other = new ConfigService(dataDir);
  await other.update({ auth: { passwordHash: 'h0' }, model: 'faux/1' });

  const store = makeRealStore(cfg, new CredentialService(credDir));
  await store.load();

  // Inject another module's write right at store.update entry: old snapshot logic would clobber it
  cfg.interpose = async () => {
    await other.update({ auth: { passwordHash: 'h1' }, model: 'faux/2' });
  };
  await store.setEnabled('builtin:herdr', false);

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'builtin:herdr': false });
  assert.deepEqual(raw['auth'], { passwordHash: 'h1' }, 'intervening auth write must not be overwritten by stale snapshot');
  assert.equal(raw['model'], 'faux/2', 'intervening model write must not be overwritten by stale snapshot');
  assert.equal(store.getEnabled('builtin:herdr'), false);
});

test('two stores concurrently updating different pluginEnabled keys preserve both writes (deterministic injection)', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfgA = new InterposingConfigService(dataDir);
  const cfgB = new ConfigService(dataDir);
  const storeA = makeRealStore(cfgA, new CredentialService(credDir));
  const storeB = makeRealStore(cfgB, new CredentialService(credDir));
  await storeA.load();
  await storeB.load();

  // Interpose storeB's write right at storeA's update entry: both updates must persist
  cfgA.interpose = async () => {
    await storeB.setEnabled('p:b', false);
  };
  await storeA.setEnabled('p:a', true);

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'p:a': true, 'p:b': false }, 'toggle keys for both plugins preserved');
  assert.equal(storeA.getEnabled('p:a'), true);
  assert.equal(storeB.getEnabled('p:b'), false);
});

test('plugin config write preserves intervening external updates and updates only this plugin nested key', { timeout: 60_000 }, async () => {
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
  assert.equal(raw['theme'], 'light', 'intervening theme write must not be overwritten by stale snapshot');
  assert.deepEqual(raw['plugins'], { 'p:other': { keep: 1 }, 'p:mine': { retries: 2 } }, 'other plugin config preserved while updating target key');
  assert.deepEqual(store.get('p:mine'), { retries: 2 });
  assert.deepEqual(store.get('p:other'), { keep: 1 });
});

test('writing when pluginEnabled is corrupt throws config_corrupt explicitly, never rebuilds with {}, and keeps cache unchanged', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const store = makeRealStore(new ConfigService(dataDir), new CredentialService(credDir));
  await store.load();

  // After loading cleanly, corrupt pluginEnabled on disk with non-boolean mapping
  writeFileSync(configPath, JSON.stringify({ pluginEnabled: { ghost: 'yes' } }), 'utf8');
  await assertRejectsCode(() => store.setEnabled('p:x', true), 'config_corrupt');
  let raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { ghost: 'yes' }, 'corrupt content preserved as-is without rebuilding');
  assert.equal(store.getEnabled('p:x'), undefined, 'in-memory cache unchanged after failed write');

  // Top-level non-object also fails explicitly
  writeFileSync(configPath, JSON.stringify({ pluginEnabled: 'nope' }), 'utf8');
  await assertRejectsCode(() => store.setEnabled('p:x', true), 'config_corrupt');
  raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['pluginEnabled'], 'nope');
});

test('writing when plugins field is corrupt throws config_corrupt explicitly without silent rebuild', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const store = makeRealStore(new ConfigService(dataDir), new CredentialService(credDir));
  await store.load();

  writeFileSync(configPath, JSON.stringify({ plugins: 'corrupt' }), 'utf8');
  await assertRejectsCode(
    () => store.set('p:x', { retries: 1 }, { retries: { type: 'number' } }),
    'config_corrupt',
  );
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['plugins'], 'corrupt', 'corrupt content preserved as-is');
});
