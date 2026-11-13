/**
 * npm payload 更新器：假 registry / sha512 完整性 / stage-activate-reject 生命周期 /
 * pending与previous状态 / 失败回滚 / 损坏 manifest（含 registry meta 不一致）/ 安装器注入 /
 * fail-closed 并发锁 / 不可变 uuid release / containment / Windows 路径形态拒绝 /
 * SemVer 回退不误报 / 状态文件契约 全覆盖。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopError } from '../src/errors.js';
import { resolveDesktopConfig } from '../src/config.js';
import { createPayloadUpdater, NpmPayloadUpdater, type NpmPayloadUpdaterOptions, type PayloadInfo } from '../src/updater.js';
import type { NpmInstaller } from '../src/npm-installer.js';
import { HostNpmInstaller } from '../src/npm-installer.js';
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
    npmInstaller: new FakeNpmInstaller(),
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

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---- 安装主链路：stage → pending → activate → current / previous ----

test('安装主链路：stage 只写 pending；activate 写 current（首次无 previous）；重复 stage 幂等', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const installer = new FakeNpmInstaller();
    const updater = makeUpdater(ctx, { npmInstaller: installer });
    const payloadRoot = path.join(ctx.dataDir, 'payload');

    const status = await updater.check();
    assert.equal(status.updateAvailable, true);
    assert.equal(status.current, null);
    assert.equal(status.latest?.version, '1.0.0');
    assert.equal(status.latest?.entryPath, undefined);

    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
    assert.equal(info.name, FIXTURE_PACKAGE);
    assert.deepEqual(info.entryArgs, []);
    assert.ok(info.releaseDir !== undefined && existsSync(info.releaseDir));
    assert.ok(info.entryPath !== undefined && existsSync(info.entryPath));
    assert.ok(info.entryPath!.endsWith(path.join('kernel', 'dist', 'main.js')), '入口必须是 manifest.entries.kernel 而非 start.mjs');
    assert.ok(existsSync(path.join(info.releaseDir!, 'node_modules', FIXTURE_DEP)), '依赖须安装在晋升后的 release 目录内');
    assert.equal(installer.calls.length, 1);
    // release 目录是不可变 uuid 目录：releases/<name>/<version>/<uuid>
    assert.match(info.releaseDir!, new RegExp(`releases/${FIXTURE_PACKAGE}/1\\.0\\.0/[0-9a-f]{16}$`));

    // stage 只写 pending，不写 current。
    assert.ok(existsSync(path.join(payloadRoot, 'pending.json')));
    assert.ok(!existsSync(path.join(payloadRoot, 'current.json')));
    const pending = updater.resolvePending();
    assert.deepEqual(
      { name: pending?.name, version: pending?.version, releaseDir: pending?.releaseDir, entryPath: pending?.entryPath },
      { name: info.name, version: info.version, releaseDir: info.releaseDir, entryPath: info.entryPath },
    );
    assert.equal(updater.resolveCurrent(), null, 'stage 后 current 仍为空');
    assert.equal(updater.resolvePrevious(), null);

    await updater.activate(info);
    const current = updater.resolveCurrent();
    assert.deepEqual(
      { name: current?.name, version: current?.version, entryPath: current?.entryPath },
      { name: info.name, version: info.version, entryPath: info.entryPath },
    );
    assert.ok(existsSync(path.join(payloadRoot, 'current.json')));
    assert.equal(updater.resolvePending(), null, 'activate 后同一 pending 清除');
    assert.equal(updater.resolvePrevious(), null, '首次激活无 previous');

    // check 幂等：up_to_date。
    const again = await updater.check();
    assert.equal(again.updateAvailable, false);
    assert.equal(again.reason, 'up_to_date');

    // 同版本重复 stage：命中 current 快路径，不重复下载/安装，不毁 current。
    const restage = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.0.0' });
    assert.equal(restage.version, '1.0.0');
    assert.equal(installer.calls.length, 1);
    assert.equal(restage.releaseDir, current!.releaseDir, 'current 快路径复用既有 release 目录');
    assert.ok(updater.resolvePending() !== null, '重复 stage 重新登记 pending 供决议');
    await updater.activate(restage);
    assert.equal(updater.resolvePrevious(), null, '同 releaseDir 再次激活不产生 previous');
    assert.equal(updater.resolveCurrent()!.version, '1.0.0');
  });
});

// ---- sha512 完整性 ----

test('sha512 完整性：篡改 tarball → tarball_integrity_mismatch，不落 release、不写 current/pending、记入 blocked', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const tarball = buildFixtureTarball({ version: '1.0.0' });
    ctx.registry.publish('1.0.0', tarball, { integrity: sha512Integrity(Buffer.from('tampered')) });
    const updater = makeUpdater(ctx);

    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'tarball_integrity_mismatch');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'releases')), '不得产出 release 目录');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'current.json')), '不得写 current.json');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'pending.json')), '不得写 pending.json');
    const status = await updater.check();
    assert.equal(status.updateAvailable, false);
    assert.equal(status.reason, 'latest_blocked');
    assert.equal(status.blocked?.code, 'tarball_integrity_mismatch');
  });
});

// ---- 失败回滚：当前版本不被破坏 ----

test('失败回滚：新版本 stage 验收失败 → current/入口保持旧版本，blocked 记录，staging 清空', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const good = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(good);
    assert.equal(updater.resolveCurrent()?.version, '1.0.0');
    const goodRelease = updater.resolveCurrent()!.releaseDir!;

    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0', corrupt: 'checksums' }));
    const status = await updater.check();
    assert.equal(status.updateAvailable, true);

    const error = await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'payload_check_failed', (e) => {
      const tail = (e.details as { stderrTail?: string[] }).stderrTail?.join('\n') ?? '';
      assert.ok(tail.includes('checksum 不一致'), `诊断须含 fixture stderr 尾部，实际: ${tail}`);
    });
    assert.equal((error.details as { releaseDir?: string }).releaseDir?.includes('staging'), true, '失败发生在 staging 区');

    const current = updater.resolveCurrent();
    assert.equal(current?.version, '1.0.0', 'current 必须仍是 1.0.0');
    assert.ok(existsSync(current!.entryPath!), '旧入口文件必须完好');
    assert.equal(current!.releaseDir, goodRelease, '旧 release 目录不被移动/删除');
    const versionDir = path.join(ctx.dataDir, 'payload', 'releases', FIXTURE_PACKAGE, '2.0.0');
    assert.ok(!existsSync(versionDir), '失败版本不得晋升');
    const staging = path.join(ctx.dataDir, 'payload', 'staging');
    assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, 'staging 必须清理');
    assert.equal(updater.resolvePending(), null, '失败后无 pending');

    const blockedStatus = await updater.check();
    assert.equal(blockedStatus.updateAvailable, false);
    assert.equal(blockedStatus.reason, 'latest_blocked');

    // 后续健康版本仍可安装；激活后 previous 保存 1.0.0 baseline；旧 blocked 记录保留。
    ctx.registry.publish('2.0.1', buildFixtureTarball({ version: '2.0.1' }));
    const repaired = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(repaired.version, '2.0.1');
    await updater.activate(repaired);
    assert.equal(updater.resolveCurrent()?.version, '2.0.1');
    const previous = updater.resolvePrevious();
    assert.equal(previous?.version, '1.0.0', 'activate 须保存旧 baseline');
    assert.equal(previous?.releaseDir, goodRelease);
    const blocked = readJson(path.join(ctx.dataDir, 'payload', 'blocked.json')) as { entries: Record<string, unknown> };
    assert.ok(`${FIXTURE_PACKAGE}@2.0.0` in blocked.entries, '2.0.0 的 blocked 记录保留');
    assert.ok(!(`${FIXTURE_PACKAGE}@2.0.1` in blocked.entries), '安装成功须解除该版本 blocked');
  });
});

// ---- 损坏 manifest（含 registry meta 与 manifest name/version 不一致） ----

test('损坏 manifest：非法 JSON / formatVersion / kernel 缺失 / kernel 指向 launcher / manifest 与 registry meta 的 name/version 不一致 全部显式拒绝', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const cases: Array<{ version: string; corrupt: NonNullable<Parameters<typeof buildFixtureTarball>[0]['corrupt']>; expectCode: string }> = [
      { version: '1.1.0', corrupt: 'manifest-json', expectCode: 'payload_manifest_invalid' },
      { version: '1.2.0', corrupt: 'format-version', expectCode: 'payload_manifest_invalid' },
      { version: '1.3.0', corrupt: 'entry-missing', expectCode: 'payload_manifest_invalid' },
      { version: '1.4.0', corrupt: 'kernel-is-launcher', expectCode: 'payload_manifest_invalid' },
      { version: '1.5.0', corrupt: 'manifest-name', expectCode: 'payload_manifest_invalid' },
      { version: '1.6.0', corrupt: 'manifest-version', expectCode: 'payload_manifest_invalid' },
    ];
    for (const [index, item] of cases.entries()) {
      ctx.registry.publish(item.version, buildFixtureTarball({ version: item.version, corrupt: item.corrupt }), {
        asLatest: index === cases.length - 1,
      });
    }
    const updater = makeUpdater(ctx);
    for (const item of cases) {
      const error = await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: item.version }), item.expectCode);
      if (item.corrupt === 'manifest-name' || item.corrupt === 'manifest-version') {
        const problems = (error.details as { problems?: string[] }).problems ?? [];
        assert.ok(
          problems.some((p) => p.includes('registry 元数据不一致')),
          `meta 一致性问题须显式列出，实际: ${problems.join('; ')}`,
        );
      }
    }
    // meta 不一致属制品缺陷：重装同版本必须被阻断且指向原始错误码。
    const mismatchCase = await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '1.5.0' }), 'updater_version_blocked');
    assert.equal((mismatchCase.details as { blocked?: { code?: string } }).blocked?.code, 'payload_manifest_invalid');
  });
});

// ---- 依赖与安装器注入 ----

test('依赖缺失且无安装器 → payload_deps_missing（不记 blocked）；注入安装器后成功', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const noInstaller = new NpmPayloadUpdater({
      packageName: FIXTURE_PACKAGE,
      registry: ctx.registry.url,
      payloadRoot: path.join(ctx.dataDir, 'payload'),
    });
    await rejectsWith(noInstaller.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'payload_deps_missing', (e) => {
      const tail = (e.details as { stderrTail?: string[] }).stderrTail?.join('\n') ?? '';
      assert.ok(tail.includes(FIXTURE_DEP), `诊断须列出缺失依赖，实际: ${tail}`);
    });
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'current.json')));
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'pending.json')));
    const status = await noInstaller.check();
    assert.equal(status.updateAvailable, true, '依赖缺失属环境配置，不应阻断版本');

    const withInstaller = makeUpdater(ctx);
    const info = await withInstaller.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
  });
});

test('vendored payload（tarball 自带 node_modules）→ 不调用安装器直接通过', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0', vendoredDeps: [FIXTURE_DEP] }));
    const installer = new FakeNpmInstaller();
    const updater = makeUpdater(ctx, { npmInstaller: installer });
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
    assert.equal(installer.calls.length, 0, 'vendored 场景不得调用安装器');
  });
});

test('注入的安装器失败 → npm_install_failed 原样上抛，current/pending 不落盘', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const failing: NpmInstaller = {
      id: 'failing',
      async install() {
        throw new DesktopError('npm_install_failed', 'boom', { stderrTail: ['ECONNREFUSED registry'] });
      },
    };
    const updater = makeUpdater(ctx, { npmInstaller: failing });
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'npm_install_failed');
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'current.json')));
    assert.ok(!existsSync(path.join(ctx.dataDir, 'payload', 'pending.json')));
  });
});

// ---- stage / activate / reject 生命周期 ----

test('reject：记 blocked、保持 current、清除同一 pending、不修改任何 release 目录', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0' }));
    const updater = makeUpdater(ctx);
    const payloadRoot = path.join(ctx.dataDir, 'payload');

    const baseline = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.0.0' });
    await updater.activate(baseline);

    const staged = await updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' });
    assert.equal(updater.resolveCurrent()?.version, '1.0.0', 'stage 新版本不动 current');

    await updater.reject(staged, new DesktopError('payload_check_failed', '启动健康检查失败', { stderrTail: ['ECONNREFUSED 127.0.0.1:3202'] }));
    assert.equal(updater.resolvePending(), null, 'reject 后 pending 清除');
    assert.equal(updater.resolveCurrent()?.version, '1.0.0', 'reject 保持 current');
    assert.ok(existsSync(staged.releaseDir!), 'reject 不删除被拒版本的 release 目录');
    assert.ok(existsSync(baseline.releaseDir!), 'reject 不动 baseline release 目录');
    const blocked = readJson(path.join(payloadRoot, 'blocked.json')) as { entries: Record<string, { code: string; stderrTail?: string[] }> };
    assert.equal(blocked.entries[`${FIXTURE_PACKAGE}@2.0.0`]?.code, 'payload_check_failed');
    assert.deepEqual(blocked.entries[`${FIXTURE_PACKAGE}@2.0.0`]?.stderrTail, ['ECONNREFUSED 127.0.0.1:3202']);

    // 非 DesktopError 也如实记录（code 统一 payload_rejected）。
    ctx.registry.publish('2.1.0', buildFixtureTarball({ version: '2.1.0' }));
    const staged2 = await updater.stage({ name: FIXTURE_PACKAGE, version: '2.1.0' });
    await updater.reject(staged2, new Error('窗口启动即崩溃'));
    const blocked2 = readJson(path.join(payloadRoot, 'blocked.json')) as { entries: Record<string, { code: string }> };
    assert.equal(blocked2.entries[`${FIXTURE_PACKAGE}@2.1.0`]?.code, 'payload_rejected');

    // 被拒版本再次 stage 必须被阻断。
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' }), 'updater_version_blocked');
    // reject 入参非法显式拒绝。
    await rejectsWith(updater.reject({ name: 'other', version: '1.0.0' }, new Error('x')), 'payload_reject_invalid');
    await rejectsWith(updater.reject({ name: FIXTURE_PACKAGE, version: 'not-semver' }, new Error('x')), 'payload_reject_invalid');
  });
});

test('activate：入参被篡改（逃逸/跨包/入口不一致）→ payload_activate_invalid，current 不变', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });

    const outside: PayloadInfo = { ...info, releaseDir: path.join(ctx.dataDir, 'elsewhere') };
    await rejectsWith(updater.activate(outside), 'payload_activate_invalid');
    const winPath: PayloadInfo = { ...info, releaseDir: 'C:\\evil\\payload' };
    await rejectsWith(updater.activate(winPath), 'payload_activate_invalid');
    const wrongPkg: PayloadInfo = { ...info, name: 'other-payload' };
    await rejectsWith(updater.activate(wrongPkg), 'payload_activate_invalid');
    const wrongEntry: PayloadInfo = { ...info, entryPath: path.join(info.releaseDir!, 'start.mjs') };
    await rejectsWith(updater.activate(wrongEntry), 'payload_activate_invalid', (e) => {
      const problems = (e.details as { problems?: string[] }).problems ?? [];
      assert.ok(problems.some((p) => p.includes('entries.kernel 不一致')), `入口不一致须显式列出，实际: ${problems.join('; ')}`);
    });
    assert.equal(updater.resolveCurrent(), null, '激活失败不写 current');
    assert.ok(updater.resolvePending() !== null, '激活失败保留 pending 待正确决议');

    await updater.activate(info);
    assert.equal(updater.resolveCurrent()?.version, '1.0.0');
  });
});

// ---- 原子晋升失败：旧 current 与版本目录保持 ----

test('原子晋升失败：版本目录被占位文件阻挡 → payload_promote_failed，current/既有版本目录保持', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const baseline = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.0.0' });
    await updater.activate(baseline);

    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0' }));
    // 用占位文件阻挡 2.0.0 版本目录创建（mkdirSync EEXIST）。
    const versionDir = path.join(ctx.dataDir, 'payload', 'releases', FIXTURE_PACKAGE, '2.0.0');
    mkdirSync(path.dirname(versionDir), { recursive: true });
    writeFileSync(versionDir, 'blocked-by-placeholder');

    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' }), 'payload_promote_failed');
    const current = updater.resolveCurrent();
    assert.equal(current?.version, '1.0.0', 'current 保持旧版本');
    assert.ok(existsSync(current!.entryPath!), '旧入口完好');
    assert.ok(existsSync(baseline.releaseDir!), '旧 release 目录不被破坏');
    assert.equal(updater.resolvePending(), null, '晋升失败无 pending');
    const staging = path.join(ctx.dataDir, 'payload', 'staging');
    assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, 'staging 必须清理');
  });
});

// ---- 并发锁（fail-closed：绝不接管） ----

test('并发锁：同进程并发 stage 串行化，快路径收敛为单次下载/安装', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const installer = new FakeNpmInstaller();
    const updater = makeUpdater(ctx, { npmInstaller: installer });
    const [a, b] = await Promise.all([
      updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }),
      updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }),
    ]);
    assert.equal(a.releaseDir, b.releaseDir);
    assert.equal(installer.calls.length, 1, '第二个并发请求必须命中快路径而非重复安装');
  });
});

test('锁 fail-closed：活锁（真实存活进程持锁）有界等待后显式诊断，绝不偷锁', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const payloadRoot = path.join(ctx.dataDir, 'payload');
    mkdirSync(payloadRoot, { recursive: true });
    const lockPath = path.join(payloadRoot, '.lock');

    // 真实存活进程持有锁 8 秒（等待其真实落盘后再发起安装，避免测试竞态）。
    const holder = spawn(process.execPath, [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(lockPath)}, JSON.stringify({ pid: process.pid, at: Date.now() })); setTimeout(() => {}, 8000);`,
    ]);
    try {
      const holderReady = Date.now() + 5_000;
      while (!existsSync(lockPath)) {
        if (Date.now() > holderReady) throw new Error('活锁持有者未能落盘锁文件');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const updater = makeUpdater(ctx, { lockTimeoutMs: 500 });
      const error = await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'updater_lock_timeout', (e) => {
        assert.match(e.message, /fail-closed 不自动接管/);
        assert.match(e.message, /手动删除/);
      });
      assert.equal((error.details as { holder?: { pid?: number } }).holder?.pid, holder.pid, '诊断须含真实持有者 pid');
      assert.ok(existsSync(lockPath), '绝不删除他人持有的锁');
    } finally {
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.once('close', resolve));
    }

    // 持有者退出但未清理（崩溃遗留）:同样不接管,人工移除后恢复。
    writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, at: Date.now() }));
    const deadLockUpdater = makeUpdater(ctx, { lockTimeoutMs: 300 });
    await rejectsWith(deadLockUpdater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'updater_lock_timeout', (e) => {
      assert.match(e.message, /fail-closed/);
    });
    assert.ok(existsSync(lockPath), '死 pid 崩溃遗留锁也不自动删除');

    rmSync(lockPath, { force: true });
    const info = await deadLockUpdater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
  });
});

test('锁 fail-closed：内容非法的锁文件同样只诊断不删除', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const payloadRoot = path.join(ctx.dataDir, 'payload');
    mkdirSync(payloadRoot, { recursive: true });
    const lockPath = path.join(payloadRoot, '.lock');
    writeFileSync(lockPath, 'not-json-at-all');
    const updater = makeUpdater(ctx, { lockTimeoutMs: 300 });
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' }), 'updater_lock_timeout');
    assert.equal(readFileSync(lockPath, 'utf8'), 'not-json-at-all', '非法内容锁文件保持原样待人工处置');
    rmSync(lockPath, { force: true });
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    assert.equal(info.version, '1.0.0');
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
    const updater = makeUpdater(ctx);
    for (const attack of attacks) {
      await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: attack.version }), attack.code);
    }
    // 攻击条目绝无可能写到 dataDir 之外（同批合法条目仅在 staging 内，且已清理）。
    assert.ok(!existsSync(path.join(ctx.dataDir, 'escape.txt')));
    assert.ok(!existsSync(path.join(ctx.dataDir, '..', 'outside.txt')));
    assert.ok(!existsSync('/abs'));
  });
});

// ---- registry 元数据边界 ----

test('registry 元数据：sha1 integrity / 非 SemVer 版本 / 未知版本 / 元数据超时 显式拒绝', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const tarball = buildFixtureTarball({ version: '1.0.0' });
    ctx.registry.publish('1.0.0', tarball, { integrity: 'sha1-abcdef' });
    const updater = makeUpdater(ctx);
    await rejectsWith(updater.check(), 'registry_metadata_invalid', (e) => {
      assert.ok(((e.details as { problems?: string[] }).problems ?? []).some((p) => p.includes('sha512')));
    });
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '9.9.9' }), 'registry_metadata_invalid');
    // 非 SemVer 版本号（缺 patch 段）显式拒绝。
    ctx.registry.publish('1.0', buildFixtureTarball({ version: '1.0' }));
    await rejectsWith(updater.check(), 'registry_metadata_invalid', (e) => {
      assert.ok(((e.details as { problems?: string[] }).problems ?? []).some((p) => p.includes('SemVer')));
    });

    ctx.registry.setMetadataDelayMs(2_000);
    const slow = makeUpdater(ctx, { metadataTimeoutMs: 300 });
    await rejectsWith(slow.check(), 'registry_metadata_failed');
    ctx.registry.setMetadataDelayMs(0);
  });
});

// ---- check 更新判定（SemVer：latest 回退不误报；锁定版本按用户意图） ----

test('check 更新判定：跟踪 latest 时 registry 回退不误报 up_to_date 之外的状态；prerelease 优先级正确', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(info);

    // latest 回退到更低版本：不是更新。
    ctx.registry.publish('0.9.0', buildFixtureTarball({ version: '0.9.0' }));
    let status = await updater.check();
    assert.equal(status.updateAvailable, false);
    assert.equal(status.reason, 'up_to_date');
    assert.equal(status.latest?.version, '0.9.0');

    // 同版本：不是更新。
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, false);

    // 更高版本 prerelease < 同号 release：1.1.0 大于 1.1.0-rc.1。
    ctx.registry.publish('1.1.0-rc.1', buildFixtureTarball({ version: '1.1.0-rc.1' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, true, 'prerelease 高于 current 视为更新');
    const rcInfo = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.1.0-rc.1' });
    await updater.activate(rcInfo);
    ctx.registry.publish('1.1.0-rc.2', buildFixtureTarball({ version: '1.1.0-rc.2' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, true, 'rc.2 > rc.1');
    ctx.registry.publish('1.1.0', buildFixtureTarball({ version: '1.1.0' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, true, 'release > prerelease');
    const release = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(release);
    ctx.registry.publish('1.1.0-beta.9', buildFixtureTarball({ version: '1.1.0-beta.9' }));
    status = await updater.check();
    assert.equal(status.updateAvailable, false, 'beta < release 不误报');
  });
});

test('check 更新判定：显式锁定版本（pinnedVersion）允许按用户意图降级换装', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0' }));
    const updater = makeUpdater(ctx);
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(info);
    assert.equal(updater.resolveCurrent()?.version, '2.0.0');

    // registry latest 移回低版本后，锁定到更低版本：用户明确意图，判为可更新。
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const pinned = makeUpdater(ctx, { pinnedVersion: '1.0.0' });
    const status = await pinned.check();
    assert.equal(status.updateAvailable, true);
    assert.equal(status.latest?.version, '1.0.0');
    const downgrade = await pinned.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await pinned.activate(downgrade);
    assert.equal(pinned.resolveCurrent()?.version, '1.0.0');
    const again = await pinned.check();
    assert.equal(again.updateAvailable, false);
    assert.equal(again.reason, 'up_to_date');
  });
});

// ---- 状态文件契约（严格复验：manifest 一致 + Windows 路径形态拒绝） ----

test('resolveCurrent：current.json 损坏 / 制品缺失 / manifest 或路径不一致 显式报错，不静默当空态', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    const updater = makeUpdater(ctx);
    const info = await updater.stage({ name: FIXTURE_PACKAGE, version: 'latest' });
    await updater.activate(info);

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
    // 恢复入口，继续路径形态攻击。
    mkdirSync(path.dirname(current!.entryPath!), { recursive: true });
    writeFileSync(current!.entryPath!, '// restored\n');

    const base = readJson(currentFile);
    const win32Paths = ['C:\\evil\\payload', 'C:evil-relative', '\\\\server\\share', '/tmp/with\\backslash'];
    for (const evil of win32Paths) {
      writeJson(currentFile, { ...base, releaseDir: evil });
      await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid', (e) => {
        const problems = (e.details as { problems?: string[] }).problems ?? [];
        assert.ok(problems.length > 0, `Windows 形态路径必须被拒: ${evil}`);
      });
    }

    // entryPath 逃逸 releaseDir。
    writeJson(currentFile, { ...base, entryPath: path.join(payloadRoot, 'current.json') });
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid');

    // 状态 version 与 release manifest version 不一致。
    writeJson(currentFile, { ...base, version: '9.9.9' });
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid', (e) => {
      const problems = (e.details as { problems?: string[] }).problems ?? [];
      assert.ok(problems.some((p) => p.includes('manifest version')), `manifest version 不一致须显式列出，实际: ${problems.join('; ')}`);
    });

    // release 目录内 manifest 篡改（version 改动）同样在复验时暴露。
    writeJson(currentFile, base);
    const manifestFile = path.join(base['releaseDir'] as string, 'manifest.json');
    const manifest = readJson(manifestFile);
    writeJson(manifestFile, { ...manifest, version: '7.7.7' });
    await rejectsWith(Promise.resolve().then(() => updater.resolveCurrent()), 'current_payload_invalid');
    writeJson(manifestFile, manifest);
    assert.equal(updater.resolveCurrent()?.version, '1.0.0');
  });
});

test('resolvePending / resolvePrevious：缺失 → null；损坏 → updater_state_corrupt；activate 前后语义正确', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    ctx.registry.publish('1.0.0', buildFixtureTarball({ version: '1.0.0' }));
    ctx.registry.publish('2.0.0', buildFixtureTarball({ version: '2.0.0' }));
    const updater = makeUpdater(ctx);
    const payloadRoot = path.join(ctx.dataDir, 'payload');

    assert.equal(updater.resolvePending(), null);
    assert.equal(updater.resolvePrevious(), null);

    const baseline = await updater.stage({ name: FIXTURE_PACKAGE, version: '1.0.0' });
    await updater.activate(baseline);
    const staged = await updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' });
    assert.equal(updater.resolvePending()?.version, '2.0.0');

    const pendingFile = path.join(payloadRoot, 'pending.json');
    writeFileSync(pendingFile, '{ broken');
    await rejectsWith(Promise.resolve().then(() => updater.resolvePending()), 'updater_state_corrupt');
    rmSync(pendingFile, { force: true });

    const stagedAgain = await updater.stage({ name: FIXTURE_PACKAGE, version: '2.0.0' });
    assert.equal(stagedAgain.version, '2.0.0');
    await updater.activate(stagedAgain);
    assert.equal(updater.resolvePrevious()?.version, '1.0.0');

    const previousFile = path.join(payloadRoot, 'previous.json');
    writeFileSync(previousFile, '{ broken');
    await rejectsWith(Promise.resolve().then(() => updater.resolvePrevious()), 'updater_state_corrupt');
    rmSync(previousFile, { force: true });
  });
});

test('目标包名不一致 / 版本说明符非法 → 显式拒绝', { timeout: 60_000 }, async () => {
  await withContext(async (ctx) => {
    const updater = makeUpdater(ctx);
    await rejectsWith(updater.stage({ name: 'other-package', version: '1.0.0' }), 'updater_target_mismatch');
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '../evil' }), 'registry_metadata_invalid');
    await rejectsWith(updater.stage({ name: FIXTURE_PACKAGE, version: '1.0' }), 'registry_metadata_invalid');
  });
});

// ---- 工厂（未配置） ----

test('createPayloadUpdater：未配置包名 → 诚实 unconfigured 全套', { timeout: 60_000 }, async () => {
  const updater = createPayloadUpdater(resolveDesktopConfig(BASE_ENV));
  assert.equal(updater.id, 'unconfigured');
  const status = await updater.check();
  assert.equal(status.updateAvailable, false);
  assert.equal(status.reason, 'updater_not_configured');
  assert.equal(updater.resolveCurrent(), null);
  assert.equal(updater.resolvePending(), null);
  assert.equal(updater.resolvePrevious(), null);
  await rejectsWith(updater.stage({ name: 'any', version: 'latest' }), 'updater_not_configured');
  await rejectsWith(updater.activate({ name: 'any', version: '1.0.0' }), 'updater_not_configured');
  await rejectsWith(updater.reject({ name: 'any', version: '1.0.0' }, new Error('x')), 'updater_not_configured');
});

// ---- HostNpmInstaller：npm-cli.js 解析 / --ignore-scripts / 超时等待 close ----

test('HostNpmInstaller：默认命令经 node 直跑 execPath 旁 npm-cli.js，附 --ignore-scripts', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-npm-'));
  try {
    // 伪造 Node 安装布局：<dir>/node（真实 node 符号链接）+ node_modules/npm/bin/npm-cli.js。
    symlinkSync(process.execPath, path.join(dir, 'node'));
    const npmCli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(path.dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, 'process.exit(7);\n');
    const payloadRoot = path.join(dir, 'payload-root');
    mkdirSync(payloadRoot, { recursive: true });
    const installer = new HostNpmInstaller({ execPath: path.join(dir, 'node') });
    assert.match(installer.id, /npm-cli\.js/);
    const error = await rejectsWith(
      installer.install(payloadRoot),
      'npm_install_failed',
      (e) => {
        const argv = (e.details as { argv?: string[] }).argv ?? [];
        assert.ok(argv.includes('--ignore-scripts'), `必须携带 --ignore-scripts，实际: ${argv.join(' ')}`);
        assert.ok(argv[0] === path.join(dir, 'node') && argv[1] === npmCli, '必须经 node 直接执行 npm-cli.js');
      },
    );
    assert.match(error.message, /exit 7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HostNpmInstaller：execPath 旁无 npm 布局 → npm_installer_unavailable 显式报错（附指引）', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-npm-'));
  try {
    symlinkSync(process.execPath, path.join(dir, 'node'));
    const installer = new HostNpmInstaller({ execPath: path.join(dir, 'node') });
    assert.match(installer.id, /npm-cli\.js 未找到/);
    const payloadRoot = path.join(dir, 'payload-root');
    mkdirSync(payloadRoot, { recursive: true });
    await rejectsWith(installer.install(payloadRoot), 'npm_installer_unavailable', (e) => {
      assert.match(e.message, /npm-cli\.js/);
      assert.match(e.message, /显式注入|宿主 Node/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HostNpmInstaller：超时 SIGKILL 后等待 close 才结束（不提前释放安装锁）', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-npm-'));
  try {
    const payloadRoot = path.join(dir, 'payload-root');
    mkdirSync(payloadRoot, { recursive: true });
    const installer = new HostNpmInstaller({
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 400,
      killGraceMs: 5_000,
    });
    const startedAt = Date.now();
    await rejectsWith(installer.install(payloadRoot), 'npm_install_failed', (e) => {
      assert.match(e.message, /超时/);
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 400, `超时判定不得早于 timeoutMs，实际 ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HostNpmInstaller：显式 command 原样使用，失败附 stderr 尾部诊断', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'helm-desktop-npm-'));
  try {
    const payloadRoot = path.join(dir, 'payload-root');
    mkdirSync(payloadRoot, { recursive: true });
    const installer = new HostNpmInstaller({
      command: [process.execPath, '-e', 'console.error("boom-line"); process.exit(3);'],
    });
    await rejectsWith(installer.install(payloadRoot), 'npm_install_failed', (e) => {
      const tail = (e.details as { stderrTail?: string[] }).stderrTail ?? [];
      assert.ok(tail.includes('boom-line'), `stderr 尾部须随错误附出，实际: ${tail.join('\\n')}`);
    });
    // 显式注入的自定义命令成功时正常 resolve。
    const ok = new HostNpmInstaller({ command: [process.execPath, '-e', 'process.exit(0);'] });
    await ok.install(payloadRoot);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
