/**
 * npm payload 更新器：假 registry / sha512 完整性 / 失败回滚 / 损坏 manifest /
 * 安装器注入 / 并发锁 / containment / 状态文件契约 全覆盖。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopError } from '../src/errors.js';
import { resolveDesktopConfig } from '../src/config.js';
import { createPayloadUpdater, NpmPayloadUpdater, type NpmPayloadUpdaterOptions } from '../src/updater.js';
import type { NpmInstaller } from '../src/npm-installer.js';
import {
  buildFixtureTarball,
  FakeNpmInstaller,
  FakeNpmRegistry,
  FIXTURE_DEP,
  FIXTURE_PACKAGE,
  sha512Integrity,
  type TarEntry,
} from './helpers-payload.js';

const BASE_ENV: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };

interface TestContext {
  dataDir: string;
  registry: FakeNpmRegistry;
}

async function withContext(fn: (ctx: TestContext) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-updater-'));
  const registry = await FakeNpmRegistry.start();
  try {
    await fn({ dataDir, registry });
  } finally {
    await registry.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function makeUpdater(ctx: TestContext, overrides: Partial<NpmPayloadUpdaterOptions> = {}): NpmPayloadUpdater {
  return new NpmPayloadUpdater({
    packageName: FIXTURE_PACKAGE,
    registry: ctx.registry.url,
    payloadRoot: path.join(ctx.dataDir, 'payload'),
    ...overrides,
  });
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  check?: (error: DesktopError) => void,
): Promise<DesktopError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof DesktopError, `期望 DesktopError（${code}），实际: ${String(caught)}`);
  assert.equal(caught.code, code);
  check?.(caught);
  return caught;
}

// ---- 安装主链路 ----

test('安装主链路：check → 下载 → sha512 → 解包 → 安装依赖 → start.mjs check → current.json', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const installer = new FakeNpmInstaller();
    const updater = makeUpdater(ctx, { npmInstaller: installer });

    const status = await updater.check();
    assert.equal(status.updateAvailable, true);
    assert.equal(status.current, null);
    assert.equal(status.latest?.version, '1.0.0');
    assert.equal(status.latest?.entryPath, undefined);

    const info = await updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
    assert.equal(info.name, FIXTURE_PACKAGE);
    assert.deepEqual(info.entryArgs, []);
    assert.ok(info.releaseDir !== undefined && existsSync(info.releaseDir));
    assert.ok(info.entryPath !== undefined && existsSync(info.entryPath));
    assert.ok(info.entryPath!.endsWith(path.join('kernel', 'dist', 'main.js')), '入口必须是 manifest.entries.kernel 而非 start.mjs');
    assert.ok(existsSync(path.join(info.releaseDir!, 'node_modules', FIXTURE_DEP)), '依赖须安装在晋升后的 release 目录内');
    assert.equal(installer.calls.length, 1);

    const current = updater.resolveCurrent();
    assert.deepEqual(
      { name: current?.name, version: current?.version, entryPath: current?.entryPath },
      { name: info.name, version: info.version, entryPath: info.entryPath },
    );
    assert.ok(existsSync(path.join(ctx.dataDir, 'payload', 'current.json')));

    // check 幂等：up_to_date；同版本重装走快路径（不再下载/安装）。
    const again = await updater.check();
    assert.equal(again.updateAvailable, false);
    assert.equal(again.reason, 'up_to_date');
    const reinstall = await updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: '1.0.0' });
    assert.equal(reinstall.version, '1.0.0');
    assert.equal(installer.calls.length, 1);
  });
});

// ---- sha512 完整性 ----

test('sha512 完整性：篡改 tarball → tarball_integrity_mismatch，不落 release、不写 current、记入 blocked', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const tarball = buildFixtureTarball({ version: '1.0.0' });
    ctx.registry.publish('1.0.0', tarball, { integrity: sha512Integrity(Buffer.from('tampered')) });
    const updater = makeUpdater(ctx, { npmInstaller: new FakeNpmInstaller() });

    await rejectsWith(updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' }), 'tarball_integrity_mismatch');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'releases')), '不得产出 release 目录');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'current.json')), '不得写 current.json');
    const status = await updater.check();
    assert.equal(status.updateAvailable, false);
    assert.equal(status.reason, 'latest_blocked');
    assert.equal(status.blocked?.code, 'tarball_integrity_mismatch');
  });
});

// ---- 失败回滚：当前版本不被破坏 ----

test('失败回滚：新版本 check 验收失败 → current/入口保持旧版本，blocked 记录，staging 清空', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx, { npmInstaller: new FakeNpmInstaller() });
    const good = await updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(good.version, '1.0.0');

    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0', corrupt: 'checksums' }));
    const status = await updater.check();
    assert.equal(status.updateAvailable, true);

    const error = await rejectsWith(
      updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' }),
      'payload_check_failed',
      (e) => {
        const tail = (e.details as { stderrTail?: string[] }).stderrTail?.join('\n') ?? '';
        assert.ok(tail.includes('checksum 不一致'), `诊断须含 fixture stderr 尾部，实际: ${tail}`);
      },
    );
    assert.equal((error.details as { releaseDir?: string }).releaseDir?.includes('staging'), true, '失败发生在 staging 区');

    const current = updater.resolveCurrent();
    assert.equal(current?.version, '1.0.0', 'current 必须仍是 1.0.0');
    assert.ok(existsSync(current!.entryPath!), '旧入口文件必须完好');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'releases', FIXTURE_PACKAGE, '2.0.0')), '失败版本不得晋升');
    const staging = path.join(ctx.dataDir, 'payload', 'staging');
    assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, 'staging 必须清理');

    const blockedStatus = await updater.check();
    assert.equal(blockedStatus.updateAvailable, false);
    assert.equal(blockedStatus.reason, 'latest_blocked');

    // 后续健康版本仍可安装；旧 blocked 记录保留。
    ctx.registry.publish('2.0.1', buildFixtureTarball({ version: '2.0.1' }));
    const repaired = await updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(repaired.version, '2.0.1');
    const blocked = JSON.parse(readFileSync(path.join(ctx.dataDir, 'payload', 'blocked.json'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    assert.ok(`${FIXTURE_PACKAGE}@2.0.0` in blocked.entries, '2.0.0 的 blocked 记录保留');
    assert.ok(!(`${FIXTURE_PACKAGE}@2.0.1` in blocked.entries), '安装成功须解除该版本 blocked');
  });
});

// ---- 损坏 manifest ----

test('损坏 manifest：非法 JSON / formatVersion / kernel 缺失 / kernel 指向 launcher 全部显式拒绝', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const cases: Array<{ version: string; corrupt: NonNullable<Parameters<typeof buildFixtureTarball>[0]['corrupt']>; expectCode: string }> = [
      { version: '1.1.0', corrupt: 'manifest-json', expectCode: 'payload_manifest_invalid' },
      { version: '1.2.0', corrupt: 'format-version', expectCode: 'payload_manifest_invalid' },
      { version: '1.3.0', corrupt: 'entry-missing', expectCode: 'payload_manifest_invalid' },
      { version: '1.4.0', corrupt: 'kernel-is-launcher', expectCode: 'payload_manifest_invalid' },
    ];
    for (const [index, item] of cases.entries()) {
      ctx.registry.publish(item.version, buildFixtureTarball({ version: item.version, corrupt: item.corrupt }), {
        asLatest: index === cases.length - 1,
      });
    }
    const updater = makeUpdater(ctx, { npmInstaller: new FakeNpmInstaller() });
    for (const item of cases) {
      await rejectsWith(updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: item.version }), item.expectCode);
    }
    // kernel 指向 launcher 的拒绝会记入 blocked；重装同名版本必须被阻断且指向原始错误码。
    const launcherCase = await rejectsWith(
      updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: '1.4.0' }),
      'updater_version_blocked',
    );
    assert.equal(
      (launcherCase.details as { blocked?: { code?: string } }).blocked?.code,
      'payload_manifest_invalid',
    );
  });
});

// ---- 依赖与安装器注入 ----

test('依赖缺失且无安装器 → payload_deps_missing（不记 blocked）；注入安装器后成功', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const noInstaller = makeUpdater(ctx);
    await rejectsWith(noInstaller.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' }), 'payload_deps_missing', (e) => {
      const tail = (e.details as { stderrTail?: string[] }).stderrTail?.join('\n') ?? '';
      assert.ok(tail.includes(FIXTURE_DEP), `诊断须列出缺失依赖，实际: ${tail}`);
    });
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'current.json')));
    const status = await noInstaller.check();
    assert.equal(status.updateAvailable, true, '依赖缺失属环境配置，不应阻断版本');

    const withInstaller = makeUpdater(ctx, { npmInstaller: new FakeNpmInstaller() });
    const info = await withInstaller.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
  });
});

test('vendored payload（tarball 自带 node_modules）→ 不调用安装器直接通过', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0', vendoredDeps: [FIXTURE_DEP] }));
    const installer = new FakeNpmInstaller();
    const updater = makeUpdater(ctx, { npmInstaller: installer });
    const info = await updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
    assert.equal(installer.calls.length, 0, 'vendored 场景不得调用安装器');
  });
});

test('注入的安装器失败 → npm_install_failed 原样上抛，current 不落盘', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const failing: NpmInstaller = {
      id: 'failing',
      async install() {
        throw new DesktopError('npm_install_failed', 'boom', { stderrTail: ['ECONNREFUSED registry'] });
      },
    };
    const updater = makeUpdater(ctx, { npmInstaller: failing });
    await rejectsWith(updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' }), 'npm_install_failed');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'current.json')));
  });
});

// ---- 并发锁 ----

test('并发锁：同进程并发安装串行化，快路径收敛为单次下载/安装', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const installer = new FakeNpmInstaller();
    const updater = makeUpdater(ctx, { npmInstaller: installer });
    const [a, b] = await Promise.all([
      updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' }),
      updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' }),
    ]);
    assert.equal(a.releaseDir, b.releaseDir);
    assert.equal(installer.calls.length, 1, '第二个并发请求必须命中快路径而非重复安装');
  });
});

test('陈旧锁自愈：死 pid / 超时持有 两种接管路径均可继续安装', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const installer = new FakeNpmInstaller();

    // 路径 1：死 pid（已退出的子进程）。
    const exited = spawnSync(process.execPath, ['-e', '0']);
    assert.equal(exited.status, 0);
    const deadPid = exited.pid!;
    assert.ok(deadPid !== undefined && deadPid > 0);
    const payloadRoot1 = path.join(ctx.dataDir, 'p1', 'payload');
    mkdirSync(payloadRoot1, { recursive: true });
    writeFileSync(path.join(payloadRoot1, '.lock'), JSON.stringify({ pid: deadPid, at: Date.now() }));
    const updater1 = new NpmPayloadUpdater({
      packageName: FIXTURE_PACKAGE,
      registry: ctx.registry.url,
      payloadRoot: payloadRoot1,
      npmInstaller: installer,
    });
    const info1 = await updater1.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info1.version, '1.0.0');

    // 路径 2：活 pid 但持有超过 staleMs。
    const payloadRoot2 = path.join(ctx.dataDir, 'p2', 'payload');
    mkdirSync(payloadRoot2, { recursive: true });
    writeFileSync(
      path.join(payloadRoot2, '.lock'),
      JSON.stringify({ pid: process.pid, at: Date.now() - 10_000 }),
    );
    const updater2 = new NpmPayloadUpdater({
      packageName: FIXTURE_PACKAGE,
      registry: ctx.registry.url,
      payloadRoot: payloadRoot2,
      npmInstaller: installer,
      lockStaleMs: 5_000,
    });
    const info2 = await updater2.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info2.version, '1.0.0');
  });
});

test('锁等待超时：他人持锁且未陈旧 → updater_lock_timeout 显式报错', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const payloadRoot = path.join(ctx.dataDir, 'payload');
    mkdirSync(payloadRoot, { recursive: true });
    writeFileSync(path.join(payloadRoot, '.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const updater = new NpmPayloadUpdater({
      packageName: FIXTURE_PACKAGE,
      registry: ctx.registry.url,
      payloadRoot,
      lockTimeoutMs: 300,
      lockStaleMs: 60_000,
    });
    await rejectsWith(updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' }), 'updater_lock_timeout');
  });
});

// ---- tar containment ----

test('tar containment：绝对路径 / .. 穿越 / 非 package 前缀条目全部显式拒绝', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const attacks: Array<{ version: string; entry: TarEntry; code: string }> = [
      { version: '1.1.0', entry: { name: 'package/../../escape.txt', content: 'x' }, code: 'tar_entry_escape' },
      { version: '1.2.0', entry: { name: '../outside.txt', content: 'x' }, code: 'tar_entry_escape' },
      { version: '1.3.0', entry: { name: '/abs/escape.txt', content: 'x' }, code: 'tar_entry_escape' },
      { version: '1.4.0', entry: { name: 'no-prefix.txt', content: 'x' }, code: 'tar_entry_prefix' },
      { version: '1.5.0', entry: { name: 'package\\win-escape.txt', content: 'x' }, code: 'tar_entry_invalid' },
    ];
    for (const [index, attack] of attacks.entries()) {
      ctx.registry.publish(
        attack.version,
        buildFixtureTarball({ version: attack.version, extraEntries: [attack.entry] }),
        { asLatest: index === attacks.length - 1 },
      );
    }
    const updater = makeUpdater(ctx, { npmInstaller: new FakeNpmInstaller() });
    for (const attack of attacks) {
      await rejectsWith(updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: attack.version }), attack.code);
    }
    // 攻击条目绝无可能写到 dataDir 之外（同批合法条目仅在 staging 内，且已清理）。
    assert.ok(!existsSync(path.join(ctx.dataDir, 'escape.txt')));
    assert.ok(!existsSync(path.join(ctx.dataDir, '..', 'outside.txt')));
    assert.ok(!existsSync('/abs'));
  });
});

// ---- registry 元数据边界 ----

test('registry 元数据：sha1 integrity / 未知版本 / 元数据超时 显式拒绝', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const tarball = buildFixtureTarball({ version: '1.0.0' });
    ctx.registry.publish('1.0.0', tarball, { integrity: 'sha1-abcdef' });
    const updater = makeUpdater(ctx, { npmInstaller: new FakeNpmInstaller() });
    await rejectsWith(updater.check(), 'registry_metadata_invalid', (e) => {
      assert.ok(((e.details as { problems?: string[] }).problems ?? []).some((p) => p.includes('sha512')));
    });
    await rejectsWith(updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: '9.9.9' }), 'registry_metadata_invalid');

    ctx.registry.setMetadataDelayMs(2_000);
    const slow = makeUpdater(ctx, { metadataTimeoutMs: 300 });
    await rejectsWith(slow.check(), 'registry_metadata_failed');
    ctx.registry.setMetadataDelayMs(0);
  });
});

// ---- 状态文件契约 ----

test('resolveCurrent：current.json 损坏 / 制品缺失 显式报错，不静默当空态', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx, { npmInstaller: new FakeNpmInstaller() });
    await updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: 'latest' });

    const payloadRoot = path.join(ctx.dataDir, 'payload');
    const currentFile = path.join(payloadRoot, 'current.json');
    const original = readFileSync(currentFile, 'utf8');
    writeFileSync(currentFile, '{ broken');
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'updater_state_corrupt');
    await rejectsWith(updater.check(), 'updater_state_corrupt');
    writeFileSync(currentFile, original);

    // 入口被外部删除 → current_payload_invalid（而非返回 null）。
    const current = updater.resolveCurrent();
    rmSync(current!.entryPath!);
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid');
  });
});

test('目标包名不一致 / 版本说明符非法 → 显式拒绝', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const updater = makeUpdater(ctx);
    await rejectsWith(updater.downloadAndInstall({ name: 'other-package', version: '1.0.0' }), 'updater_target_mismatch');
    await rejectsWith(updater.downloadAndInstall({ name: FIXTURE_PACKAGE, version: '../evil' }), 'registry_metadata_invalid');
  });
});

// ---- 工厂（未配置） ----

test('createPayloadUpdater：未配置包名 → 诚实 unconfigured 三件套', { timeout: 60_000 }, async () => {
  const updater = createPayloadUpdater(resolveDesktopConfig(BASE_ENV));
  assert.equal(updater.id, 'unconfigured');
  const status = await updater.check();
  assert.equal(status.updateAvailable, false);
  assert.equal(status.reason, 'updater_not_configured');
  assert.equal(updater.resolveCurrent(), null);
  await rejectsWith(
    updater.downloadAndInstall({ name: 'any', version: 'latest' }),
    'updater_not_configured',
  );
});
