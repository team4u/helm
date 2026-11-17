/**
 * Unit tests for PluginHostGate read/write barrier and plugin-host-deps dependency topology.
 *
 * runner: tsx --test; every test requires explicit timeout: 60_000 to guard against deadlocks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmError } from '@helm/protocol';
import { PluginHostGate } from '../src/plugins/plugin-host-gate.js';
import {
  assertDependenciesSatisfied,
  assertNoDependencyCycle,
  assertNoEnabledDependents,
  collectDependents,
  enabledStatesInDependencyOrder,
  markDependentsBroken,
} from '../src/plugins/plugin-host-deps.js';
import { deferred } from './helpers.js';
import type { PluginPhase, PluginState } from '../src/plugins/types.js';

function makeState(
  id: string,
  opts: {
    dependencies?: string[];
    enabled?: boolean;
    phase?: PluginPhase;
  } = {},
): PluginState {
  return {
    definition: { id, definePlugin() {} },
    dependencies: opts.dependencies ?? [],
    enabled: opts.enabled ?? false,
    phase: opts.phase ?? 'idle',
    epoch: 1,
    dataDir: `/tmp/${id}`,
    hooks: new Set(),
    services: [],
    providers: [],
    configSchema: null,
    hostReleases: new Set(),
    stopWindow: false,
  };
}

// ---------------------------------------------------------------------------
// PluginHostGate: per-plugin serialization + writer-preferred rw barrier
// ---------------------------------------------------------------------------

test('enqueue is strictly serialized per plugin while running concurrently across plugins', { timeout: 60_000 }, async () => {
  const gate = new PluginHostGate();
  const events: string[] = [];
  const a1Gate = deferred<void>();
  const b1Gate = deferred<void>();

  const a1 = gate.enqueue('p:a', async () => {
    events.push('a1:start');
    await a1Gate.promise;
    events.push('a1:end');
    return 'a1';
  });
  const a2 = gate.enqueue('p:a', async () => {
    events.push('a2:start');
    events.push('a2:end');
    return 'a2';
  });
  const b1 = gate.enqueue('p:b', async () => {
    events.push('b1:start');
    await b1Gate.promise;
    events.push('b1:end');
    return 'b1';
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gate.readerCount, 2, 'read gates across distinct plugins run concurrently');
  assert.deepEqual(events, ['a1:start', 'b1:start'], 'a2 on same plugin must wait for a1');

  b1Gate.resolve();
  assert.equal(await b1, 'b1');
  a1Gate.resolve();
  assert.deepEqual(await Promise.all([a1, a2]), ['a1', 'a2']);
  assert.deepEqual(events, ['a1:start', 'b1:start', 'b1:end', 'a1:end', 'a2:start', 'a2:end']);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gate.readerCount, 0);
  assert.equal(gate.queuedPluginCount, 0, 'queue map entry cleans up automatically upon settling');
});

test('writer preference prevents starvation: new readers yield to waiting writers (including queued writers)', { timeout: 60_000 }, async () => {
  const gate = new PluginHostGate();
  const order: string[] = [];
  const r1Hold = deferred<void>();
  const w1Hold = deferred<void>();

  await gate.acquireGateRead();
  order.push('r1:acquired');

  const w1Promise = gate.withWriteLock(async () => {
    order.push('w1:acquired');
    assert.equal(gate.readerCount, 0);
    assert.equal(gate.isWriterActive, true);
    await w1Hold.promise;
    order.push('w1:releasing');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gate.waitingWriterCount, 1);

  // Reader r2 queued while w1 waits is blocked by writer-preferred gate; second writer w2 queues too
  const r2Promise = gate.enqueue('p:r2', async () => {
    order.push('r2:acquired');
  });
  const w2Promise = gate.withWriteLock(async () => {
    order.push('w2:acquired');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['r1:acquired'], 'w1/w2/r2 all wait before r1 releases');

  // Release r1, waking waiters: w1 acquires lock first
  gate.releaseGateRead();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['r1:acquired', 'w1:acquired'], 'w1 must acquire lock ahead of r2');

  // Release w1: w2 is still waiting, so r2 continues yielding to w2
  w1Hold.resolve();
  await w1Promise;
  await Promise.all([w2Promise, r2Promise]);
  assert.deepEqual(
    order,
    ['r1:acquired', 'w1:acquired', 'w1:releasing', 'w2:acquired', 'r2:acquired'],
    'queued writers take precedence over subsequent readers to prevent writer starvation',
  );
  assert.equal(gate.readerCount, 0);
  assert.equal(gate.isWriterActive, false);
  assert.equal(gate.waitingWriterCount, 0);

  void r1Hold;
});

test('exception release never deadlocks: gate locks recover cleanly after enqueue or withWriteLock throws', { timeout: 60_000 }, async () => {
  const gate = new PluginHostGate();

  await assert.rejects(
    gate.enqueue('p:err', async () => {
      throw new Error('reader-boom');
    }),
    /reader-boom/,
  );
  assert.equal(gate.readerCount, 0, 'reader count resets to zero after read task failure');

  await assert.rejects(
    gate.withWriteLock(async () => {
      assert.equal(gate.isWriterActive, true);
      throw new Error('writer-boom');
    }),
    /writer-boom/,
  );
  assert.equal(gate.isWriterActive, false, 'writer flag resets after write task failure');

  // Queue and rw gate continue operating normally after exceptions
  const value = await gate.enqueue('p:err', async () => 'recovered');
  assert.equal(value, 'recovered');
  const writeVal = await gate.withWriteLock(async () => 42);
  assert.equal(writeVal, 42);

  assert.throws(() => gate.releaseGateRead(), /with no active readers/);
  assert.throws(() => gate.releaseGateWrite(), /without active writer/);
});

test('drain waits for all queued tasks to settle and clears queue map', { timeout: 60_000 }, async () => {
  const gate = new PluginHostGate();
  const hold = deferred<void>();
  let settledCount = 0;

  const p1 = gate.enqueue('p:1', async () => {
    await hold.promise;
    settledCount += 1;
  });
  const p2 = gate
    .enqueue('p:2', async () => {
      await hold.promise;
      settledCount += 1;
      throw new Error('fail-on-drain');
    })
    .catch(() => {});

  const draining = gate.drain();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settledCount, 0);

  hold.resolve();
  await draining;
  await Promise.all([p1, p2]);
  assert.equal(settledCount, 2);
  assert.equal(gate.queuedPluginCount, 0);
});

// ---------------------------------------------------------------------------
// plugin-host-deps: cycle detection, satisfaction checks, reverse dependents protection, topological order
// ---------------------------------------------------------------------------

test('assertNoDependencyCycle allows acyclic graphs and explicitly rejects multi-hop cycles', { timeout: 60_000 }, () => {
  const plugins = new Map<string, PluginState>([
    ['a', makeState('a', { dependencies: ['b'] })],
    ['b', makeState('b', { dependencies: ['c'] })],
    ['c', makeState('c', { dependencies: ['unregistered'] })],
  ]);

  assertNoDependencyCycle(plugins, 'd', ['a']);

  assert.throws(
    () => assertNoDependencyCycle(plugins, 'c', ['a']),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'plugin_dependency_cycle');
      assert.equal(err.status, 409);
      assert.deepEqual((err.details as { cycle: string[] }).cycle, ['c', 'a', 'b', 'c']);
      return true;
    },
  );
});

test('assertDependenciesSatisfied distinguishes missing, disabled, and transitioning states', { timeout: 60_000 }, () => {
  const plugins = new Map<string, PluginState>([
    ['ok', makeState('ok', { enabled: true, phase: 'idle' })],
    ['off', makeState('off', { enabled: false, phase: 'idle' })],
    ['defining', makeState('defining', { enabled: false, phase: 'defining' })],
    ['deactivating', makeState('deactivating', { enabled: true, phase: 'deactivating' })],
  ]);

  assertDependenciesSatisfied(plugins, 'consumer', ['ok']);

  assert.throws(
    () => assertDependenciesSatisfied(plugins, 'consumer', ['missing']),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_dependency_missing' && err.status === 409,
  );
  for (const dep of ['off', 'defining', 'deactivating']) {
    assert.throws(
      () => assertDependenciesSatisfied(plugins, 'consumer', [dep]),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'plugin_dependency_not_enabled' &&
        err.status === 409,
    );
  }
});

test('collectDependents / assertNoEnabledDependents / markDependentsBroken handle transitive dependents', { timeout: 60_000 }, () => {
  const base = makeState('base', { enabled: true, phase: 'idle' });
  const mid = makeState('mid', { dependencies: ['base'], enabled: true, phase: 'idle' });
  const top = makeState('top', { dependencies: ['mid'], enabled: true, phase: 'idle' });
  const starting = makeState('starting', { dependencies: ['base'], enabled: false, phase: 'defining' });
  const disabled = makeState('disabled', { dependencies: ['base'], enabled: false, phase: 'idle' });

  const plugins = new Map<string, PluginState>([
    ['base', base],
    ['mid', mid],
    ['top', top],
    ['starting', starting],
    ['disabled', disabled],
  ]);

  const dependents = collectDependents(plugins, 'base');
  assert.deepEqual(
    dependents.map((s) => s.definition.id),
    ['mid', 'starting', 'top'],
    'BFS collects enabled and defining dependents while ignoring disabled ones',
  );

  assert.throws(
    () => assertNoEnabledDependents(plugins, 'base'),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_in_use' && err.status === 409,
  );

  const changedIds: string[] = [];
  markDependentsBroken(plugins, 'base', (dep) => changedIds.push(dep.definition.id));
  assert.deepEqual(changedIds, ['mid', 'top'], 'only marks and emits changes for enabled dependents');
  assert.equal(mid.lastError?.code, 'plugin_dependency_not_enabled');
  assert.equal(top.lastError?.code, 'plugin_dependency_not_enabled');
  assert.equal(starting.lastError, undefined);
  assert.equal(disabled.lastError, undefined);
});

test('enabledStatesInDependencyOrder filters disabled plugins and preserves topological + same-tier registration order', { timeout: 60_000 }, () => {
  const plugins = new Map<string, PluginState>([
    ['top', makeState('top', { dependencies: ['mid'], enabled: true })],
    ['peer-1', makeState('peer-1', { enabled: true })],
    ['off', makeState('off', { dependencies: ['base'], enabled: false })],
    ['mid', makeState('mid', { dependencies: ['base'], enabled: true })],
    ['peer-2', makeState('peer-2', { enabled: true })],
    ['base', makeState('base', { enabled: true })],
  ]);

  const ordered = enabledStatesInDependencyOrder(plugins).map((s) => s.definition.id);
  assert.equal(ordered.includes('off'), false);
  assert.ok(ordered.indexOf('base') < ordered.indexOf('mid'));
  assert.ok(ordered.indexOf('mid') < ordered.indexOf('top'));
  assert.ok(ordered.indexOf('peer-1') < ordered.indexOf('peer-2'));
});
