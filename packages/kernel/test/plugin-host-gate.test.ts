/**
 * PluginHostGate 读写屏障与 plugin-host-deps 依赖拓扑单元测试。
 *
 * runner: tsx --test；每条测试显式 timeout: 60_000 防死锁。
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
// PluginHostGate：per-plugin 队列 + 写者优先读写屏障
// ---------------------------------------------------------------------------

test('enqueue 同插件严格串行、跨插件可并发读', { timeout: 60_000 }, async () => {
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
  assert.equal(gate.readerCount, 2, '跨插件读门并发持有');
  assert.deepEqual(events, ['a1:start', 'b1:start'], '同插件 a2 必须等待 a1');

  b1Gate.resolve();
  assert.equal(await b1, 'b1');
  a1Gate.resolve();
  assert.deepEqual(await Promise.all([a1, a2]), ['a1', 'a2']);
  assert.deepEqual(events, ['a1:start', 'b1:start', 'b1:end', 'a1:end', 'a2:start', 'a2:end']);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gate.readerCount, 0);
  assert.equal(gate.queuedPluginCount, 0, '完成后自动清理队列索引');
});

test('写者优先防饿死：等待写门期间新读者必须让位于写者（含多写者排队）', { timeout: 60_000 }, async () => {
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

  // w1 等待期间入队的读者 r2 必须被写者优先门挡住；同时第二个写者 w2 也入队
  const r2Promise = gate.enqueue('p:r2', async () => {
    order.push('r2:acquired');
  });
  const w2Promise = gate.withWriteLock(async () => {
    order.push('w2:acquired');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['r1:acquired'], 'r1 未释放前，w1/w2/r2 均等待');

  // 释放 r1，唤醒全部等待者：w1 优先获锁
  gate.releaseGateRead();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['r1:acquired', 'w1:acquired'], 'w1 必须先于 r2 获得锁');

  // 释放 w1：仍有 w2 在排队，r2 继续让位于 w2
  w1Hold.resolve();
  await w1Promise;
  await Promise.all([w2Promise, r2Promise]);
  assert.deepEqual(
    order,
    ['r1:acquired', 'w1:acquired', 'w1:releasing', 'w2:acquired', 'r2:acquired'],
    '多写者排队期间写者始终优先于后续读者，防止写者饿死',
  );
  assert.equal(gate.readerCount, 0);
  assert.equal(gate.isWriterActive, false);
  assert.equal(gate.waitingWriterCount, 0);

  void r1Hold;
});

test('异常释放不死锁：enqueue 与 withWriteLock 抛错后门锁干净归还', { timeout: 60_000 }, async () => {
  const gate = new PluginHostGate();

  await assert.rejects(
    gate.enqueue('p:err', async () => {
      throw new Error('reader-boom');
    }),
    /reader-boom/,
  );
  assert.equal(gate.readerCount, 0, '读任务失败后读计数必须归零');

  await assert.rejects(
    gate.withWriteLock(async () => {
      assert.equal(gate.isWriterActive, true);
      throw new Error('writer-boom');
    }),
    /writer-boom/,
  );
  assert.equal(gate.isWriterActive, false, '写任务失败后写标志必须复位');

  // 异常之后队列与读写门均可正常续用
  const value = await gate.enqueue('p:err', async () => 'recovered');
  assert.equal(value, 'recovered');
  const writeVal = await gate.withWriteLock(async () => 42);
  assert.equal(writeVal, 42);

  assert.throws(() => gate.releaseGateRead(), /with no active readers/);
  assert.throws(() => gate.releaseGateWrite(), /without active writer/);
});

test('drain 等待全部排队任务收敛并清空队列索引', { timeout: 60_000 }, async () => {
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
// plugin-host-deps：依赖环路、满足性、依赖者保护、拓扑序
// ---------------------------------------------------------------------------

test('assertNoDependencyCycle：无环通过、多跳成环显式拒绝', { timeout: 60_000 }, () => {
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

test('assertDependenciesSatisfied：区分缺失、未启用与过渡态', { timeout: 60_000 }, () => {
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

test('collectDependents / assertNoEnabledDependents / markDependentsBroken 传递依赖行为', { timeout: 60_000 }, () => {
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
    '按 BFS 收集已启用与 defining 期依赖者，忽略已停用者',
  );

  assert.throws(
    () => assertNoEnabledDependents(plugins, 'base'),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_in_use' && err.status === 409,
  );

  const changedIds: string[] = [];
  markDependentsBroken(plugins, 'base', (dep) => changedIds.push(dep.definition.id));
  assert.deepEqual(changedIds, ['mid', 'top'], '仅标记并广播已启用依赖者');
  assert.equal(mid.lastError?.code, 'plugin_dependency_not_enabled');
  assert.equal(top.lastError?.code, 'plugin_dependency_not_enabled');
  assert.equal(starting.lastError, undefined);
  assert.equal(disabled.lastError, undefined);
});

test('enabledStatesInDependencyOrder：过滤未启用插件并保持拓扑序与同层注册序', { timeout: 60_000 }, () => {
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
