/**
 * Hub 监督器（纯 Node，零 GUI 依赖）：attach / spawn / 崩溃自愈 / 预算耗尽 /
 * 优雅与强制停止 / 就绪超时 / 端口冲突诚实报错。全部走真实子进程（mini-hub 夹具）。
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

test('spawn 路径：mini-hub 子进程就绪 → owned，身份探测通过', { timeout: 60_000 }, async () => {
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

test('attach 路径：外部 Hub 已就绪 → attached，stop 不动外部进程', { timeout: 60_000 }, async () => {
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
  assert.equal(external.child.exitCode, null, '外部 Hub 不应被 stop 终止');
  assert.equal(await hubReady(port), true);
  await external.stop();
});

test('崩溃自愈：owned 子进程被 SIGKILL → 退避重启并重新就绪', { timeout: 60_000 }, async () => {
  const { supervisor, port, restarts } = await makeHarness();
  await supervisor.start();
  const pidBefore = supervisor.childPid!;
  assert.ok(pidBefore !== undefined);
  process.kill(pidBefore, 'SIGKILL');
  const recovered = await waitFor('崩溃后重新就绪', async () => {
    if (supervisor.state !== 'owned' || supervisor.childPid === pidBefore) return false;
    return await hubReady(port);
  }, 15_000);
  assert.equal(recovered, true);
  assert.ok(restarts.length >= 1, '应至少调度一次重启');
  await supervisor.stop();
});

test('重启预算耗尽：crash-loop → failed + hub_restart_exhausted 诊断', { timeout: 60_000 }, async () => {
  const { supervisor, problems } = await makeHarness(
    { restartMaxRetries: 1, restartBackoffMs: 50 },
    { MINI_HUB_MODE: 'crash-loop' },
  );
  await supervisor.start();
  const failed = await waitFor('预算耗尽进入 failed', () => supervisor.state === 'failed', 20_000);
  assert.equal(failed, true);
  const exhausted = problems.find(
    (error): error is DesktopError => error instanceof DesktopError && error.code === 'hub_restart_exhausted',
  );
  assert.ok(exhausted !== undefined, '应产生 hub_restart_exhausted 诊断');
  await supervisor.stop();
});

test('优雅停止：SIGTERM 生效，端口释放，子进程退出', { timeout: 60_000 }, async () => {
  const { supervisor, port } = await makeHarness();
  await supervisor.start();
  const pid = supervisor.childPid!;
  await supervisor.stop();
  assert.equal(await waitFor('端口释放', async () => !(await hubReady(port)), 5_000), true);
  assert.equal(await pidAlive(pid), false, '子进程应已退出');
});

test('强制停止：忽略 SIGTERM 的子进程在优雅期后被 SIGKILL', { timeout: 60_000 }, async () => {
  const { supervisor, port } = await makeHarness(
    { stopGraceMs: 400 },
    { MINI_HUB_MODE: 'ignore-sigterm' },
  );
  await supervisor.start();
  const pid = supervisor.childPid!;
  await supervisor.stop();
  assert.equal(await pidAlive(pid), false, 'SIGKILL 兜底应终止无响应子进程');
  assert.equal(await waitFor('端口释放(强杀)', async () => !(await hubReady(port)), 5_000), true);
});

test('就绪超时：no-listen → hub_ready_timeout 且诊断含命令行', { timeout: 60_000 }, async () => {
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

test('端口冲突：非 Hub 服务占端口 → probe 不认 → 子进程 EADDRINUSE → hub_port_conflict', { timeout: 60_000 }, async () => {
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
      assert.ok(details.stderrTail?.some((line) => line.includes('EADDRINUSE')), '诊断尾部应含 EADDRINUSE');
      return true;
    },
  );
  assert.equal(supervisor.state, 'failed');
  await supervisor.stop();
});

test('入口缺失：hubEntry 不存在 → hub_entry_missing 显式报错', { timeout: 60_000 }, async () => {
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

test('状态机守卫：start 进行中禁止并发 stop，重复 start 显式拒绝', { timeout: 60_000 }, async () => {
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
