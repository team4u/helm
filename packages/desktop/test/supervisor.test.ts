/**
 * Hub supervise (pure Node, zero GUI dependency):attach / spawn / crash self-heal / pre- compute exhausted /
 * graceful and force stop / ready timeout / port conflict honest errors. all away real child process (mini-hub fixture).
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { resolveDesktopConfig } from '../src/config.js';
import { HubSupervisor } from '../src/supervisor.js';
import { DesktopError } from '../src/errors.js';
import { MINI_HUB_FIXTURE, pickFreePort, startMiniHubExternal, startPlainServer, waitFor } from './helpers.js';

const BASE_ENV: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };
const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
});

type ConfigOverrides = Parameters<typeof resolveDesktopConfig>[1];

interface Harness {
  supervisor: HubSupervisor;
  port: number;
  restarts: Array<{ attempt: number; delayMs: number; reason: string }>;
  problems: unknown[];
}

async function makeHarness(overrides: ConfigOverrides = {}, envExtra: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const port = await pickFreePort();
  const config = resolveDesktopConfig(BASE_ENV, {
    port,
    hubCommand: [process.execPath, MINI_HUB_FIXTURE],
    readyTimeoutMs: 8_000,
    probeIntervalMs: 100,
    restartBackoffMs: 100,
    restartBackoffMaxMs: 400,
    stableMs: 60_000,
    stopGraceMs: 4_000,
    ...overrides,
  });
  const restarts: Harness['restarts'] = [];
  const problems: unknown[] = [];
  const supervisor = new HubSupervisor({
    config,
    env: { ...BASE_ENV, ...envExtra },
    events: {
      restartScheduled: (attempt, delayMs, reason) => restarts.push({ attempt, delayMs, reason }),
      problem: (error) => problems.push(error),
    },
  });
  cleanups.push(async () => {
    await supervisor.stop().catch(() => undefined);
  });
  return { supervisor, port, restarts, problems };
}

async function hubReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const body = (await response.json()) as { configured?: unknown };
    return typeof body.configured === 'boolean';
  } catch {
    return false;
  }
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('spawn path:mini-hub child process ready → owned, identity probe via', { timeout: 60_000 }, async () => {
  const { supervisor, port } = await makeHarness();
  const result = await supervisor.start();
  assert.equal(result.mode, 'owned');
  assert.equal(result.runner?.kind, 'custom');
  assert.equal(supervisor.state, 'owned');
  assert.ok(supervisor.childPid !== undefined);
  assert.equal(await hubReady(port), true);
  await supervisor.stop();
  assert.equal(supervisor.state, 'stopped');
});

test('attach path: external Hub ready → attached,stop do not motion external process', { timeout: 60_000 }, async () => {
  const port = await pickFreePort();
  const external = await startMiniHubExternal(port);
  cleanups.push(async () => {
    await external.stop();
  });
  const { supervisor } = await makeHarness({ port });
  const result = await supervisor.start();
  assert.equal(result.mode, 'attached');
  assert.equal(supervisor.owned, false);
  await supervisor.stop();
  assert.equal(external.child.exitCode, null, 'external Hub must not by stop terminate');
  assert.equal(await hubReady(port), true);
  await external.stop();
});

test('crash self-heal:owned child process by SIGKILL → backoff restart and re- ready', { timeout: 60_000 }, async () => {
  const { supervisor, port, restarts } = await makeHarness();
  await supervisor.start();
  const pidBefore = supervisor.childPid!;
  assert.ok(pidBefore !== undefined);
  process.kill(pidBefore, 'SIGKILL');
  const recovered = await waitFor('crash after re- ready', async () => {
    if (supervisor.state !== 'owned' || supervisor.childPid === pidBefore) return false;
    return await hubReady(port);
  }, 15_000);
  assert.equal(recovered, true);
  assert.ok(restarts.length >= 1, 'should at least scheduling once restart');
  await supervisor.stop();
});

test('restart pre- compute exhausted:crash-loop → failed + hub_restart_exhausted diagnose', { timeout: 60_000 }, async () => {
  const { supervisor, problems } = await makeHarness(
    { restartMaxRetries: 1, restartBackoffMs: 50 },
    { MINI_HUB_MODE: 'crash-loop' },
  );
  await supervisor.start();
  const failed = await waitFor('pre- compute exhausted enter failed', () => supervisor.state === 'failed', 20_000);
  assert.equal(failed, true);
  const exhausted = problems.find(
    (error): error is DesktopError => error instanceof DesktopError && error.code === 'hub_restart_exhausted',
  );
  assert.ok(exhausted !== undefined, 'should produce hub_restart_exhausted diagnose');
  await supervisor.stop();
});

test('graceful stop:SIGTERM takes effect, port release, child process exit', { timeout: 60_000 }, async () => {
  const { supervisor, port } = await makeHarness();
  await supervisor.start();
  const pid = supervisor.childPid!;
  await supervisor.stop();
  assert.equal(await waitFor('port release', async () => !(await hubReady(port)), 5_000), true);
  assert.equal(await pidAlive(pid), false, 'child process should already exit');
});

test('force stop: ignore SIGTERM child process in graceful phase after by SIGKILL', { timeout: 60_000, skip: process.platform === 'win32' ? 'Windows original generate process kill cannot by ignore,IPC close by independent test verify' : false }, async () => {
  const { supervisor, port } = await makeHarness(
    { stopGraceMs: 400 },
    { MINI_HUB_MODE: 'ignore-sigterm' },
  );
  await supervisor.start();
  const pid = supervisor.childPid!;
  await supervisor.stop();
  assert.equal(await pidAlive(pid), false, 'SIGKILL fall back should terminate without response child process');
  assert.equal(await waitFor('port release(strong kill)', async () => !(await hubReady(port)), 5_000), true);
});

test('managed Node entry via IPC close, across platform release Hub port', { timeout: 60_000 }, async () => {
  const { supervisor, port } = await makeHarness({ hubCommand: undefined, hubEntry: MINI_HUB_FIXTURE });
  const result = await supervisor.start();
  assert.equal(result.runner?.kind, 'host-node');
  const pid = supervisor.childPid!;
  await supervisor.stop();
  assert.equal(await pidAlive(pid), false);
  assert.equal(await hubReady(port), false);
});

test('ready timeout:no-listen → hub_ready_timeout and diagnose contains command line', { timeout: 60_000 }, async () => {
  const { supervisor } = await makeHarness(
    { readyTimeoutMs: 800, probeIntervalMs: 100 },
    { MINI_HUB_MODE: 'no-listen' },
  );
  await assert.rejects(
    supervisor.start(),
    (error: unknown) => {
      assert.ok(error instanceof DesktopError);
      assert.equal(error.code, 'hub_ready_timeout');
      const details = error.details as { command?: string[] };
      assert.ok(details.command?.includes(MINI_HUB_FIXTURE));
      return true;
    },
  );
  assert.equal(supervisor.state, 'failed');
});

test('port conflict: non- Hub service occupy port → probe do not recognize → child process EADDRINUSE → hub_port_conflict', { timeout: 60_000 }, async () => {
  const port = await pickFreePort();
  const plain = await startPlainServer(port);
  cleanups.push(async () => {
    await new Promise<void>((resolve) => plain.close(() => resolve()));
  });
  const { supervisor } = await makeHarness({ port });
  await assert.rejects(
    supervisor.start(),
    (error: unknown) => {
      assert.ok(error instanceof DesktopError);
      assert.equal(error.code, 'hub_port_conflict');
      const details = error.details as { stderrTail?: string[] };
      assert.ok(details.stderrTail?.some((line) => line.includes('EADDRINUSE')), 'diagnose tail part should contains EADDRINUSE');
      return true;
    },
  );
  assert.equal(supervisor.state, 'failed');
  await supervisor.stop();
});

test('entry missing:hubEntry missing → hub_entry_missing explicit errors', { timeout: 60_000 }, async () => {
  const port = await pickFreePort();
  const config = resolveDesktopConfig(BASE_ENV, { port, hubEntry: '/nonexistent/hub-main.js' });
  const supervisor = new HubSupervisor({ config, env: BASE_ENV });
  cleanups.push(async () => {
    await supervisor.stop().catch(() => undefined);
  });
  await assert.rejects(
    supervisor.start(),
    (error: unknown) => error instanceof DesktopError && error.code === 'hub_entry_missing',
  );
});

test('state machine guard:start in progress forbidden concurrency stop, duplicate start explicit reject', { timeout: 60_000 }, async () => {
  const { supervisor } = await makeHarness(
    { readyTimeoutMs: 4_000 },
    { MINI_HUB_MODE: 'no-listen' },
  );
  const starting = supervisor.start();
  await assert.rejects(
    supervisor.stop(),
    (error: unknown) => error instanceof DesktopError && error.code === 'supervisor_invalid_state',
  );
  await assert.rejects(
    supervisor.start(),
    (error: unknown) => error instanceof DesktopError && error.code === 'supervisor_invalid_state',
  );
  await starting.catch(() => undefined);
  await supervisor.stop();
});
