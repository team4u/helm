/**
 * plugin lifecycle race regression (determinism, independent of sleep compete fast):
 *
 * 1. enable for hoist hand over point in start stop persist succeeded after: service already start, suspended during
 *    keep defining- -action reject / hook do not execute / UI do not expose out; after success available,
 *    persist on failure without in-flight task, clean rollback (via store setEnabled inject deferred gate control).
 * 2. register durable start stop read first at everything asset get:getEnabled throws (original error keep)
 *    or return non- boolean value (explicit reject) when register table/hook/hosting asset/data directory zero leftover.
 * 3. HelmPluginConfigStore read-change-write all process in ConfigService.update the same file lock inside
 *    with call back complete: only update which belong embed set key, does not override other module in between gap update key (via
 *    InterposingConfigService in update entry determinism insert concurrency write, lock outside without wait for,
 *    lock inside without second getter, without deadlock); write when pluginEnabled corrupt explicit config_corrupt,
 *    never use {} rebuild.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
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
// test base create
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
    execEnv: async () => { throw new HelmError('unsupported', 'this fixture do not execute node command', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('this fixture do not bear load file mutual exclusion queue') },
    emitEvent: (type) => {
      events.push(`event:${type}`);
    },
  };
}

/**
 * can gate control start stop persist memory store:onSetEnabled in truly set before by invoke,
 * test use it construct persist suspended window (determinism deferred, without sleep).
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

/** all amount declaration (UI/action/hook/service/hosting asset) plugin work vendor. */
function fullPlugin(id: string, marks: string[]): PluginDefinition {
  return {
    id,
    definePlugin: (ctx) => {
      ctx.configSchema({ endpoint: { type: 'string', label: 'end point' } });
      ctx.ui.sidebarItem({ id: 'nav', label: 'navigation' });
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
// 1. enable commit point in start stop persist succeeded after
// ---------------------------------------------------------------------------

test('enable persist suspended window: service already start but action reject/hook do not execute/UI do not expose out; after success available', { timeout: 60_000 }, async () => {
  const store = new GatedStore();
  const host = makeHost(store);
  const marks: string[] = [];
  await host.register(fullPlugin('builtin:herdr', marks), { enabled: false });

  // gate control:setEnabled enter after suspended, until test explicit let through (determinism window)
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
    // window inside: service indeed already start, but plugin for outside fully unavailable (uncommitted)
    assert.deepEqual(marks, ['svc-start'], 'service already start (persist not yet set)');
    await assertRejectsCode(() => host.invokeAction('builtin:herdr', 'ping', {}), 'plugin_disabled');
    marks.length = 0;
    const r = await host.runHook('trigger', triggerPayload());
    assert.equal(r.action, 'continue');
    assert.deepEqual(marks, [], 'window inside hook handle never execute');
    assert.deepEqual(host.listUi(), [], 'window inside UI do not expose out');
    assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  } finally {
    release();
    await enabling;
  }

  // after commit: action available, hook execute,UI expose out, durable true
  assert.deepEqual(await host.invokeAction('builtin:herdr', 'ping', {}), { ok: true });
  marks.length = 0;
  const r2 = await host.runHook('trigger', triggerPayload());
  assert.equal(r2.action, 'transform');
  assert.deepEqual(marks, ['hook-ran']);
  assert.equal(host.listUi().length, 1);
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

test('enable persist failed: window inside same unavailable, rollback is deactivate and without in-flight task by split,schema keep, can again enable', { timeout: 60_000 }, async () => {
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
  rejectPersist(new Error('network disconnect'));

  const err = (await assertRejectsCode(() => enabling, 'plugin_enabled_persist_failed')) as HelmError;
  assert.match(err.message, /network disconnect/);

  // rollback: deactivate, service already stop, hosting release,schema restore, without in-flight task
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false);
  assert.ok(marks.includes('svc-stop'), 'already start service by inverse to stop');
  assert.ok(events.includes('release:builtin:herdr:7'), 'hosting asset release');
  assert.equal(host.getConfigSchema('builtin:herdr').endpoint?.type, 'string');
  assert.deepEqual(host.listUi(), []);
  assert.equal(host.activeTaskCount('builtin:herdr'), 0, 'rollback when zero in-flight task');
  assert.equal(store.enabled.has('builtin:herdr'), false, 'persist failed do not write value');

  // restore after can again enable succeeded
  store.onSetEnabled = () => {};
  await host.enable('builtin:herdr');
  assert.equal(host.list().find((p) => p.id === 'builtin:herdr')!.enabled, true);
  assert.equal(store.enabled.get('builtin:herdr'), true);
});

// ---------------------------------------------------------------------------
// 2. register start stop parse first at everything asset get:getter failed zero leftover
// ---------------------------------------------------------------------------

test('getEnabled throws: register zero leftover (register table/data directory/hook/hosting), original error keep', { timeout: 60_000 }, async () => {
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

  assert.equal(host.list().length, 0, 'register table zero leftover');
  assert.equal(existsSync(join(dataDir, 'plugins', pluginDataDirName('p:boom'))), false, 'plugin data directory not create');
  assert.deepEqual(events.filter((e) => e.startsWith('manage:')), [], 'not get any host asset');
  const r = await host.runHook('trigger', triggerPayload());
  assert.equal(r.action, 'continue', 'hook pipeline zero leftover');

  // non- HelmError original exception: wrap is register failed but keep original message
  const host2 = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      throw new Error('underlying IO timeout');
    },
    setEnabled() {},
  });
  const wrapped = (await assertRejectsCode(() => host2.register(fullPlugin('p:boom2', [])), 'plugin_registration_failed')) as HelmError;
  assert.match(wrapped.message, /underlying IO timeout/);
  assert.equal(host2.list().length, 0);

  // host still health: after continue register normal
  const ok = makeHost();
  await ok.register(fullPlugin('p:healthy', []), { enabled: false });
  assert.equal(ok.list().find((p) => p.id === 'p:healthy')!.enabled, false);
});

test('getEnabled return non- boolean value: explicit reject (never truthy guess), register zero leftover', { timeout: 60_000 }, async () => {
  const host = makeHost({
    get() {
      return {};
    },
    set() {},
    getEnabled() {
      return 'false' as unknown as boolean; // string 'false' is truthy, never can by when into enable
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
// 3. ConfigService call back form + HelmPluginConfigStore lock inside read change write
// ---------------------------------------------------------------------------

/**
 * in updateBy entry determinism insert once concurrency write (consume after automatically unload under).
 * insert point in truly take lock before: lock outside wait for, lock inside without second getter, without deadlock.
 * new old implement all must via this entry (update object/function form all delegate updateBy): old implement
 * lock outside old snapshot will override between gap write; new implement call back inside based on lock inside most new state only change which belong key.
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

test('ConfigService call back form: read to lock inside most new value, object patch semantics keep', { timeout: 60_000 }, async () => {
  const a = new ConfigService(dataDir);
  const b = new ConfigService(dataDir);
  await Promise.all([a.update({ k1: 'v1' }), b.update({ k2: 'v2' })]);
  const out = await a.update((current) => ({ ...current, k1Upper: String(current['k1']).toUpperCase() }));
  assert.equal(out['k1Upper'], 'V1', 'call back see to lock inside most new k1(non-empty file start read)');
  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw, { k1: 'v1', k2: 'v2', k1Upper: 'V1' });
});

test('setEnabled during other module concurrency update auth etc. key do not by old value override (determinism insert)', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfg = new InterposingConfigService(dataDir);
  const other = new ConfigService(dataDir);
  await other.update({ auth: { passwordHash: 'h0' }, model: 'faux/1' });

  const store = makeRealStore(cfg, new CredentialService(credDir));
  await store.load();

  // in store  update entry insert another module write: old implement will it override back remove
  cfg.interpose = async () => {
    await other.update({ auth: { passwordHash: 'h1' }, model: 'faux/2' });
  };
  await store.setEnabled('builtin:herdr', false);

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'builtin:herdr': false });
  assert.deepEqual(raw['auth'], { passwordHash: 'h1' }, 'between gap write auth do not by old snapshot override');
  assert.equal(raw['model'], 'faux/2', 'between gap write model do not by old snapshot override');
  assert.equal(store.getEnabled('builtin:herdr'), false);
});

test('two store concurrency update different pluginEnabled key all keep (determinism insert)', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const cfgA = new InterposingConfigService(dataDir);
  const cfgB = new ConfigService(dataDir);
  const storeA = makeRealStore(cfgA, new CredentialService(credDir));
  const storeB = makeRealStore(cfgB, new CredentialService(credDir));
  await storeA.load();
  await storeB.load();

  // storeB complete write insert in storeA  update entry: two all must under
  cfgA.interpose = async () => {
    await storeB.setEnabled('p:b', false);
  };
  await storeA.setEnabled('p:a', true);

  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { 'p:a': true, 'p:b': false }, 'two plugin start stop key all keep');
  assert.equal(storeA.getEnabled('p:a'), true);
  assert.equal(storeB.getEnabled('p:b'), false);
});

test('plugin config write path same keep between gap external update, and only motion this plugin embed set key', { timeout: 60_000 }, async () => {
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
  assert.equal(raw['theme'], 'light', 'between gap write theme do not by old snapshot override');
  assert.deepEqual(raw['plugins'], { 'p:other': { keep: 1 }, 'p:mine': { retries: 2 } }, 'other plugin config keep, this plugin key update');
  assert.deepEqual(store.get('p:mine'), { retries: 2 });
  assert.deepEqual(store.get('p:other'), { keep: 1 });
});

test('write when pluginEnabled corrupt: explicit config_corrupt, never use {} rebuild, mirror do not change', { timeout: 60_000 }, async () => {
  const credDir = join(dataDir, 'cred');
  mkdirSync(credDir, { recursive: true });
  const configPath = join(dataDir, 'config.json');
  const store = makeRealStore(new ConfigService(dataDir), new CredentialService(credDir));
  await store.load();

  // load after success external pluginEnabled break into non- boolean value mapping
  writeFileSync(configPath, JSON.stringify({ pluginEnabled: { ghost: 'yes' } }), 'utf8');
  await assertRejectsCode(() => store.setEnabled('p:x', true), 'config_corrupt');
  let raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw['pluginEnabled'], { ghost: 'yes' }, 'corrupt content original keep (not rebuild)');
  assert.equal(store.getEnabled('p:x'), undefined, 'write failed mirror do not change');

  // whole non- object same explicit reject
  writeFileSync(configPath, JSON.stringify({ pluginEnabled: 'nope' }), 'utf8');
  await assertRejectsCode(() => store.setEnabled('p:x', true), 'config_corrupt');
  raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['pluginEnabled'], 'nope');
});

test('write when plugins field corrupt: explicit config_corrupt, not silently rebuild', { timeout: 60_000 }, async () => {
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
  assert.equal(raw['plugins'], 'corrupt', 'corrupt content original keep');
});
