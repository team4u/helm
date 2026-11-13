import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DesktopBoot } from '../src/bootstrap.js';
import { resolveDesktopConfig } from '../src/config.js';
import type { PayloadInfo, PayloadUpdater } from '../src/updater.js';
import { MINI_HUB_FIXTURE, pickFreePort, startMiniHubExternal } from './helpers.js';

function updaterFixture(pending: PayloadInfo | null = null) {
  let active: PayloadInfo | null = null;
  const calls: string[] = [];
  const updater: PayloadUpdater = {
    id: 'test',
    resolveCurrent: () => active,
    resolvePending: () => pending,
    resolvePrevious: () => null,
    check: async () => { calls.push('check'); return { updateAvailable: false, current: active, latest: null, reason: 'up_to_date' }; },
    stage: async () => { throw new Error('此测试不下载网络载荷'); },
    activate: async (info) => { calls.push('activate'); active = info; pending = null; },
    reject: async () => { calls.push('reject'); pending = null; },
  };
  return { updater, calls };
}

async function config() {
  return resolveDesktopConfig({}, {
    port: await pickFreePort(), hubEntry: MINI_HUB_FIXTURE,
    readyTimeoutMs: 3000, probeIntervalMs: 50, stopGraceMs: 1000,
  });
}

test('候选 Hub 启动后须等界面确认才激活', { timeout: 60_000 }, async () => {
  const state = updaterFixture({ name: 'test-payload', version: '1.0.0', releaseDir: tmpdir(), entryPath: MINI_HUB_FIXTURE });
  const boot = new DesktopBoot({ config: await config(), updater: state.updater });
  try {
    assert.equal((await boot.start()).mode, 'owned');
    assert.deepEqual(state.calls, []);
    await boot.confirmReady();
    assert.deepEqual(state.calls, ['activate']);
  } finally { await boot.supervisor.stop(); }
});

test('候选启动失败保留上一版本，恢复 baseline 后不激活坏包', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-boot-'));
  await mkdir(join(dir, 'kernel'), { recursive: true });
  const bad = join(dir, 'kernel', 'main.mjs');
  await writeFile(bad, 'throw new Error("candidate failed");');
  const state = updaterFixture({ name: 'test-payload', version: '2.0.0', releaseDir: dir, entryPath: bad });
  const logs: string[] = [];
  const boot = new DesktopBoot({ config: await config(), updater: state.updater, log: (line) => logs.push(line) });
  try {
    assert.equal((await boot.start()).mode, 'owned');
    await boot.confirmReady();
    assert.deepEqual(state.calls, ['reject']);
    assert.match(logs.join('\n'), /启动失败/);
  } finally { await boot.supervisor.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('npm latest 不高于内置基线时不重复安装或降级', { timeout: 60_000 }, async () => {
  const state = updaterFixture();
  state.updater.check = async () => ({ updateAvailable: true, current: null, latest: { name: 'test-payload', version: '1.0.0' } });
  const boot = new DesktopBoot({ config: await config(), updater: state.updater, baselineVersion: '2.0.0' });
  try {
    await boot.start();
    const result = await boot.checkForUpdate();
    assert.equal(result.updateAvailable, false);
    assert.equal(result.reason, 'up_to_date');
  } finally { await boot.supervisor.stop(); }
});

test('外部 Hub 已运行时附着，不激活候选、不安装更新、不停止外部 Hub', { timeout: 60_000 }, async () => {
  const cfg = await config();
  const external = await startMiniHubExternal(cfg.port);
  const state = updaterFixture({ name: 'test-payload', version: '2.0.0', entryPath: '/absent' });
  const boot = new DesktopBoot({ config: cfg, updater: state.updater });
  try {
    assert.equal((await boot.start()).mode, 'attached');
    await boot.confirmReady();
    await assert.rejects(boot.checkForUpdate(), /外部进程管理/);
    await boot.supervisor.stop();
    assert.deepEqual(state.calls, []);
    assert.equal((await fetch(`${cfg.hubUrl}/api/auth/status`)).status, 200);
  } finally { await external.stop(); }
});
