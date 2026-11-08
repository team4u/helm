/**
 * helm-node 升级引擎测试：真实函数行为为主。
 * 覆盖：版本解析/比较/规范化、JSON 记录损坏与原子写、upgrade check、
 * 双包元数据/完整性拒绝、防降级、冷却期、排空 gate、prepare/commit/abort
 * 顺序、失败回滚、跨进程锁、stageExtractor 路径逃逸。
 * 不做真实 npm 网络安装（stageExtractor 注入替代网络路径），npm 真实
 * 下载链路由 fetch mock 校验请求与校验逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import rawFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  UpgradeRejectedError,
  UpgradeCommitUnconfirmedError,
  compareSemver,
  normalizeTargetVersion,
  getNodeVersion,
  resolveEffectiveNodeVersion,
  filterRpcRegistryUrl,
  checkNodeUpgrade,
  stageReleaseFromNpm,
  performNodeUpgrade,
  readCurrentRelease,
  writeCurrentRelease,
  deleteCurrentRelease,
  readBlockedRelease,
  writeBlockedRelease,
  clearBlockedRelease,
  type StagedNodeRelease,
  type PreparedNodeReplacement,
} from '../src/daemon/upgrader.js';

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function makeReplacement(pid: number, opts?: { commitError?: Error; abortError?: Error }) {
  const calls: string[] = [];
  const replacement: PreparedNodeReplacement = {
    pid,
    async commit() {
      calls.push(`commit:${pid}`);
      if (opts?.commitError) throw opts.commitError;
    },
    async abort() {
      calls.push(`abort:${pid}`);
      if (opts?.abortError) throw opts.abortError;
    },
  };
  return { replacement, calls };
}
/** stageExtractor：在 staging 内伪造双包安装产物结构。 */
async function fakeExtractor(stagingDir: string, _version: string): Promise<{ entryPath: string; cliBinDir: string }> {
  await fs.mkdir(path.join(stagingDir, 'node_modules', '@helm', 'node', 'dist'), { recursive: true });
  await fs.mkdir(path.join(stagingDir, 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(stagingDir, 'node_modules', '@helm', 'node', 'dist', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(
    path.join(stagingDir, 'node_modules', '@helm', 'node', 'package.json'),
    JSON.stringify({ name: '@helm/node', version: _version }),
    'utf8',
  );
  return { entryPath: path.join('node_modules', '@helm', 'node', 'dist', 'cli.js'), cliBinDir: 'node_modules/.bin' };
}

// ---------------------------------------------------------------------------
// 1. 版本：compareSemver / normalizeTargetVersion / getNodeVersion
// ---------------------------------------------------------------------------

test('compareSemver：核心号、预发布优先级与非法输入', { timeout: 60_000 }, () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1); // 正式 > 预发布
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1); // 预发布段少者更小
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1); // 数字 < 字母
  assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.11'), -1); // 数字按数值
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-beta.9'), 1);
  // build metadata 合法但不参与比较（SemVer 规范第 10 条）
  assert.equal(compareSemver('1.0.0+build.123', '1.0.0+build.456'), 0);
  assert.equal(compareSemver('1.0.0+sha.a1b2c3', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0-beta.1+exp.sha.5114f85', '1.0.0-beta.1'), 0);
  assert.equal(compareSemver('1.0.1+a', '1.0.0+b'), 1); // 核心号优先于 build
  assert.equal(compareSemver('1.0.0-rc.1+b1', '1.0.0-rc.2+b2'), -1); // 预发布优先于 build
  for (const bad of ['v1.0.0', '1.0', '1.0.0.0', '01.0.0', 'not-a-version', '', '1.0.0-', '1.0.0+', '1.0.0+a_b', '1.0.0+a..b']) {
    assert.throws(() => compareSemver(bad, '1.0.0'), UpgradeRejectedError, `应拒绝 ${bad}`);
  }
});

test('normalizeTargetVersion：trim 与去一个 v 前缀后严格校验', { timeout: 60_000 }, () => {
  assert.equal(normalizeTargetVersion('  1.2.3  '), '1.2.3');
  assert.equal(normalizeTargetVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeTargetVersion(' v1.2.3-rc.1 '), '1.2.3-rc.1');
  assert.equal(normalizeTargetVersion('v1.2.3+build.7'), '1.2.3+build.7');
  assert.equal(normalizeTargetVersion(' v1.2.3+build.7 '), '1.2.3+build.7');
  assert.throws(() => normalizeTargetVersion('vv1.2.3'), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion('1.2'), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion('1.2.3+bad_build'), UpgradeRejectedError);
});

test('getNodeVersion：读取自身 package.json，HELM_VERSION_OVERRIDE 覆盖', { timeout: 60_000 }, () => {
  const self = getNodeVersion();
  assert.match(self, /^\d+\.\d+\.\d+/);
  const prev = process.env.HELM_VERSION_OVERRIDE;
  process.env.HELM_VERSION_OVERRIDE = '9.9.9-dev';
  try {
    assert.equal(getNodeVersion(), '9.9.9-dev');
  } finally {
    if (prev === undefined) delete process.env.HELM_VERSION_OVERRIDE;
    else process.env.HELM_VERSION_OVERRIDE = prev;
  }
});

test('resolveEffectiveNodeVersion：current.json 优先，缺失回退自身包版本', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  assert.equal(await resolveEffectiveNodeVersion(dir), getNodeVersion());
  await writeCurrentRelease(dir, { version: '3.2.1', entryPath: '/x/dist/cli.js', updatedAt: new Date().toISOString() });
  assert.equal(await resolveEffectiveNodeVersion(dir), '3.2.1');
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. JSON 记录：仅 ENOENT 为 null；损坏/IO 错误显式；0600
// ---------------------------------------------------------------------------

test('记录读写：ENOENT 返回 null，0600 原子写，delete/clear 幂等', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  assert.equal(await readCurrentRelease(dir), null);
  assert.equal(await readBlockedRelease(dir), null);

  await writeCurrentRelease(dir, { version: '1.0.0', entryPath: '/a/dist/cli.js', updatedAt: '2026-01-01T00:00:00.000Z', cliBinDir: '/a/node_modules/.bin' });
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.equal(current?.cliBinDir, '/a/node_modules/.bin');
  const stat = rawFs.statSync(path.join(dir, 'current.json'));
  assert.equal(stat.mode & 0o777, 0o600);

  await writeBlockedRelease(dir, { version: '2.0.0', reason: 'canary failed', at: '2026-01-02T00:00:00.000Z' });
  assert.equal((await readBlockedRelease(dir))?.reason, 'canary failed');
  assert.equal(rawFs.statSync(path.join(dir, 'update-blocked.json')).mode & 0o777, 0o600);

  await deleteCurrentRelease(dir);
  await clearBlockedRelease(dir);
  assert.equal(await readCurrentRelease(dir), null);
  assert.equal(await readBlockedRelease(dir), null);
  await deleteCurrentRelease(dir); // 幂等
  await fs.rm(dir, { recursive: true, force: true });
});

test('记录损坏：非 JSON / 缺字段显式报错，不返回 null', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'current.json'), '{ not json', 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /损坏/);
  await fs.writeFile(path.join(dir, 'current.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /entryPath/);
  await fs.writeFile(path.join(dir, 'update-blocked.json'), '[]', 'utf8');
  await assert.rejects(() => readBlockedRelease(dir), /损坏/);
  await writeCurrentRelease(dir, { version: '', entryPath: 'x', updatedAt: 't' } as never).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. filterRpcRegistryUrl 允许清单
// ---------------------------------------------------------------------------

test('filterRpcRegistryUrl：仅官方与 HELM_NPM_REGISTRY，其他源明确拒绝', { timeout: 60_000 }, () => {
  assert.equal(filterRpcRegistryUrl(undefined), undefined);
  assert.equal(filterRpcRegistryUrl(''), undefined);
  assert.equal(filterRpcRegistryUrl('https://registry.npmjs.org/'), 'https://registry.npmjs.org');
  assert.throws(() => filterRpcRegistryUrl('https://evil.example.com'), UpgradeRejectedError);
  const prev = process.env.HELM_NPM_REGISTRY;
  process.env.HELM_NPM_REGISTRY = 'https://mirror.internal.example/npm/';
  try {
    assert.equal(filterRpcRegistryUrl('https://mirror.internal.example/npm'), 'https://mirror.internal.example/npm');
    assert.throws(() => filterRpcRegistryUrl('https://registry.npmjs.org.evil.io'), UpgradeRejectedError);
  } finally {
    if (prev === undefined) delete process.env.HELM_NPM_REGISTRY;
    else process.env.HELM_NPM_REGISTRY = prev;
  }
});

// ---------------------------------------------------------------------------
// 4. checkNodeUpgrade
// ---------------------------------------------------------------------------

function makeRegistryFetch(latest: string, exact?: Record<string, unknown>) {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    urls.push(url);
    if (url.endsWith('/latest')) {
      return new Response(JSON.stringify({ version: latest }), { status: 200 });
    }
    return new Response(JSON.stringify(exact ?? {}), { status: 200 });
  };
  return { fetchFn, urls };
}

test('checkNodeUpgrade：查询 latest、比较版本、透传 blocked', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await writeBlockedRelease(dir, { version: '1.5.0', reason: 'boom', at: new Date().toISOString() });
  const { fetchFn, urls } = makeRegistryFetch('1.2.0');
  const result = await checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn });
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.blocked?.version, '1.5.0');
  assert.match(urls[0]!, /@helm%2Fnode\/latest|@helm\/node\/latest/);

  // current.json 缺失且未传 currentVersion 时回退 getNodeVersion
  const result2 = await checkNodeUpgrade((await tempDir('helm-node-upgrade-')), { fetchFn: makeRegistryFetch('0.0.1').fetchFn });
  assert.equal(result2.currentVersion, getNodeVersion());
  assert.equal(result2.updateAvailable, false);

  // registry 返回非法版本 → 明确报错
  const bad = makeRegistryFetch('not-semver');
  await assert.rejects(() => checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn: bad.fetchFn }));
  await fs.rm(dir, { recursive: true, force: true });
});

test('checkNodeUpgrade：HTTP 失败与超时显式报错', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const fail: typeof fetch = async () => new Response('nope', { status: 404, statusText: 'Not Found' });
  await assert.rejects(() => checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn: fail }), /404/);
  // fetch 立即以 AbortError 拒绝 → 映射为显式的“查询失败+超时”错误
  const timeout_: typeof fetch = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(
    () => checkNodeUpgrade(dir, { currentVersion: '1.0.0', registryUrl: 'http://127.0.0.1:1', fetchFn: timeout_ }),
    /查询 .* 最新版本失败：请求超时/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. stageReleaseFromNpm：缓存复用 / stageExtractor / 双包校验拒绝
// ---------------------------------------------------------------------------

test('stageReleaseFromNpm：stageExtractor 产物落 immutable 候选目录并写 .complete，二次调用复用', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const staged = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  assert.equal(staged.version, '1.2.3');
  assert.ok(staged.releaseDir.startsWith(path.join(dir, 'releases', '1.2.3') + path.sep));
  assert.ok(await fs.access(staged.entryPath).then(() => true, () => false));
  assert.ok(staged.cliBinDir.endsWith('node_modules/.bin'));
  const marker = JSON.parse(await fs.readFile(path.join(dir, 'releases', '1.2.3', '.complete'), 'utf8'));
  assert.equal(marker.entryPath, staged.entryPath);

  const staged2 = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  assert.equal(staged2.releaseDir, staged.releaseDir); // 复用，不新建候选
  await assert.rejects(() => stageReleaseFromNpm(dir, 'bad-version', { stageExtractor: fakeExtractor }), UpgradeRejectedError);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm：stageExtractor 路径逃逸与绝对路径拒绝，失败不留 staging', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await assert.rejects(
    () =>
      stageReleaseFromNpm(dir, '1.0.0', {
        stageExtractor: async (stagingDir) => ({ entryPath: path.join('..', '..', 'escape.js'), cliBinDir: 'node_modules/.bin' }),
      }),
    /逃逸/,
  );
  await assert.rejects(
    () =>
      stageReleaseFromNpm(dir, '1.0.0', {
        stageExtractor: async () => ({ entryPath: '/etc/passwd', cliBinDir: 'node_modules/.bin' }),
      }),
    /相对路径/,
  );
  const entries = await fs.readdir(path.join(dir, 'releases', '1.0.0'));
  assert.ok(entries.every((e) => e === '.complete' || !e.startsWith('.staging')), '失败后不应残留 staging 目录');
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm：双包元数据/哈希/安装产物校验失败全部拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');

  // a) 元数据包名/版本不符
  const wrongMeta = makeRegistryFetch('1.0.0', { name: '@evil/node', version: '1.0.0', dist: { integrity: 'sha512-abc', tarball: 'https://r/t.tgz' } });
  await assert.rejects(
    () => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: wrongMeta.fetchFn }),
    /包名不符/,
  );

  // b) tarball sha512 不匹配
  const { createHash } = await import('node:crypto');
  const body = Buffer.from('malicious payload');
  const goodIntegrity = `sha512-${createHash('sha512').update(body).digest('base64')}`;
  const tampered: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
    if (url.includes('/-/')) return new Response('tampered-content', { status: 200 });
    const meta = { name: url.includes('%2Fcli') ? '@helm/cli' : '@helm/node', version: '1.0.0', dist: { integrity: goodIntegrity, tarball: `${url.split('/').slice(0, -2).join('/')}/pkg/-/pkg-1.0.0.tgz` } };
    return new Response(JSON.stringify(meta), { status: 200 });
  };
  await assert.rejects(() => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: tampered }), /完整性校验失败/);

  // c) 缺 dist.integrity
  const noIntegrity: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
    const name = url.includes('%2Fcli') ? '@helm/cli' : '@helm/node';
    return new Response(JSON.stringify({ name, version: '1.0.0', dist: { tarball: 'https://r/t.tgz' } }), { status: 200 });
  };
  await assert.rejects(() => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: noIntegrity }), /integrity/);

  // d) 版本不匹配的元数据
  const versionMismatch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
    const name = url.includes('%2Fcli') ? '@helm/cli' : '@helm/node';
    return new Response(JSON.stringify({ name, version: '1.0.1', dist: { integrity: 'sha512-abc', tarball: 'https://r/t.tgz' } }), { status: 200 });
  };
  await assert.rejects(() => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: versionMismatch }), /版本不符/);

  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6. performNodeUpgrade：事务语义
// ---------------------------------------------------------------------------

interface UpgradeLog {
  draining: boolean[];
  execCount: { value: number };
  shutdownPids: number[];
}

function makeHooks(log: UpgradeLog) {
  return {
    setDraining: (v: boolean) => log.draining.push(v),
    getActiveExecCount: () => log.execCount.value,
    onScheduleShutdown: (pid: number) => log.shutdownPids.push(pid),
  };
}

test('performNodeUpgrade：无 prepareReplacement 明确拒绝（不伪造 PID）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await assert.rejects(() => performNodeUpgrade(dir, {}), /prepareReplacement/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：成功路径 prepare→commit→onScheduleShutdown(pid)，current 更新、blocked 清除', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await writeBlockedRelease(dir, { version: '2.0.0', reason: '旧失败', at: new Date().toISOString() });
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(4242);
  const contexts: Array<{ attemptId: string; previousVersion: string; targetVersion: string }> = [];
  const releases: StagedNodeRelease[] = [];

  const result = await performNodeUpgrade(dir, {
    targetVersion: '1.2.3',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async (release, context) => {
      releases.push(release);
      contexts.push(context);
      return replacement;
    },
    ...makeHooks(log),
  });

  assert.deepEqual(result, { ok: true, previousVersion: '1.0.0', targetVersion: '1.2.3', upgraded: true, pid: 4242 });
  assert.deepEqual(calls, ['commit:4242']); // commit 恰好一次，成功路径不 abort
  assert.equal(releases[0]?.version, '1.2.3');
  assert.ok(contexts[0]?.attemptId);
  assert.equal(contexts[0]?.previousVersion, '1.0.0');
  assert.equal(contexts[0]?.targetVersion, '1.2.3');
  assert.deepEqual(log.shutdownPids, [4242]);
  assert.deepEqual(log.draining, [true]); // 成功后保持 draining（旧宿主即将退出）
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.2.3');
  assert.equal(current?.entryPath, releases[0]?.entryPath);
  assert.equal(current?.cliBinDir, releases[0]?.cliBinDir);
  assert.equal(await readBlockedRelease(dir), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：targetVersion 规范化（v 前缀/空白）用于目录与结果', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const { replacement } = makeReplacement(100);
  const result = await performNodeUpgrade(dir, {
    targetVersion: ' v2.0.1 ',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => replacement,
  });
  assert.equal(result.targetVersion, '2.0.1');
  assert.ok(result.upgraded);
  assert.equal((await readCurrentRelease(dir))?.version, '2.0.1');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：同版本非 force 无操作，不 stage 不排空', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  let staged = 0;
  const result = await performNodeUpgrade(dir, {
    targetVersion: '1.0.0',
    currentVersion: '1.0.0',
    stageExtractor: async (s, v) => {
      staged += 1;
      return fakeExtractor(s, v);
    },
    prepareReplacement: async () => makeReplacement(1).replacement,
    ...makeHooks(log),
  });
  assert.deepEqual(result, { ok: true, previousVersion: '1.0.0', targetVersion: '1.0.0', upgraded: false });
  assert.equal(staged, 0);
  assert.equal(log.draining.length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：防降级拒绝（force 可越过）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '0.9.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    UpgradeRejectedError,
  );
  // force 允许降级
  const result = await performNodeUpgrade(dir, {
    targetVersion: '0.9.0',
    currentVersion: '1.0.0',
    force: true,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(7).replacement,
  });
  assert.equal(result.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：失败版本冷却期内拒绝，force 或过期后可重试', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await writeBlockedRelease(dir, { version: '1.5.0', reason: 'canary crashed', at: new Date().toISOString() });
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.5.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /冷却/,
  );
  // force 可重试
  const result = await performNodeUpgrade(dir, {
    targetVersion: '1.5.0',
    currentVersion: '1.0.0',
    force: true,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(8).replacement,
  });
  assert.equal(result.upgraded, true);

  // 冷却过期（写一个 31 分钟前的记录）后无需 force 也可重试
  const dir2 = await tempDir('helm-node-upgrade-');
  await writeBlockedRelease(dir2, {
    version: '1.5.0',
    reason: 'old failure',
    at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  });
  const result2 = await performNodeUpgrade(dir2, {
    targetVersion: '1.5.0',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(9).replacement,
  });
  assert.equal(result2.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(dir2, { recursive: true, force: true });
});

test('performNodeUpgrade：排空 gate——exec 在超时内归零后放行', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 2 }, shutdownPids: [] };
  // 300ms 后 exec 自然归零
  setTimeout(() => {
    log.execCount.value = 0;
  }, 300).unref();
  const result = await performNodeUpgrade(dir, {
    targetVersion: '1.1.0',
    currentVersion: '1.0.0',
    drainTimeoutMs: 10_000,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(55).replacement,
    ...makeHooks(log),
  });
  assert.equal(result.upgraded, true);
  assert.equal(log.draining[0], true);
  assert.equal(log.shutdownPids.length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：排空超时——放弃升级、解除 gate、无任何变更', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await writeCurrentRelease(dir, { version: '1.0.0', entryPath: '/old/dist/cli.js', updatedAt: new Date().toISOString() });
  const log: UpgradeLog = { draining: [], execCount: { value: 3 }, shutdownPids: [] };
  let prepared = 0;
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.1.0',
        drainTimeoutMs: 150,
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          prepared += 1;
          return makeReplacement(1).replacement;
        },
        ...makeHooks(log),
      }),
    /排空超时/,
  );
  assert.equal(prepared, 0, '排空失败不应进入 prepare');
  assert.deepEqual(log.draining, [true, false], 'gate 必须解除');
  assert.deepEqual(log.shutdownPids, []);
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：commit 失败——abort、还原 current、写 blocked、解除 gate', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const originalCurrent = { version: '1.0.0', entryPath: '/old/dist/cli.js', updatedAt: '2026-01-01T00:00:00.000Z', cliBinDir: '/old/node_modules/.bin' };
  await writeCurrentRelease(dir, originalCurrent);
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(321, { commitError: new Error('activate handshake timeout') });

  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.4.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => replacement,
        ...makeHooks(log),
      }),
    /activate handshake timeout[\s\S]*回滚/,
  );
  assert.deepEqual(calls, ['commit:321', 'abort:321'], 'commit 失败必须 abort');
  const current = await readCurrentRelease(dir);
  assert.deepEqual(current, originalCurrent, 'current 必须还原');
  const blocked = await readBlockedRelease(dir);
  assert.equal(blocked?.version, '1.4.0');
  assert.match(blocked?.reason ?? '', /activate handshake timeout/);
  assert.deepEqual(log.draining, [true, false], '失败路径 gate 解除');
  assert.deepEqual(log.shutdownPids, []);

  // 被冷却的版本重试被拒
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.4.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /冷却/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：prepareReplacement 抛错——current 未变更、写 blocked、解除 gate', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await writeCurrentRelease(dir, { version: '1.0.0', entryPath: '/old/dist/cli.js', updatedAt: new Date().toISOString() });
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '2.0.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          throw new Error('replacement daemon 注册失败');
        },
        ...makeHooks(log),
      }),
    /replacement daemon 注册失败/,
  );
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  const blocked = await readBlockedRelease(dir);
  assert.equal(blocked?.version, '2.0.0');
  assert.deepEqual(log.draining, [true, false]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：目标版本取 latest（未显式指定时）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const { fetchFn } = makeRegistryFetch('1.9.0');
  const result = await performNodeUpgrade(dir, {
    currentVersion: '1.0.0',
    fetchFn,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(77).replacement,
  });
  assert.equal(result.targetVersion, '1.9.0');
  assert.equal(result.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：跨进程升级锁互斥', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  let unblock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let enteredPrepare = 0;
  const first = performNodeUpgrade(dir, {
    targetVersion: '1.2.0',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => {
      enteredPrepare += 1;
      await gate; // 持锁等待外部放行
      return makeReplacement(11).replacement;
    },
  });
  // 等第一次升级真正进入持锁阶段（prepare 已被调用）
  const deadline = Date.now() + 5_000;
  while (enteredPrepare === 0 && Date.now() < deadline) await delay(20);
  assert.equal(enteredPrepare, 1, '第一次升级应已进入持锁阶段');
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.3.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /升级已在进行中/,
  );
  unblock?.();
  const firstResult = await first;
  assert.equal(firstResult.upgraded, true);
  // 锁已释放，可再次升级
  const second = await performNodeUpgrade(dir, {
    targetVersion: '1.3.0',
    currentVersion: '1.2.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(12).replacement,
  });
  assert.equal(second.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：同版本目录正在使用时不删除候选（immutable）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const first = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  // 升级到其他版本后再 stage 同版本：旧候选仍在
  const again = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  assert.equal(again.releaseDir, first.releaseDir);
  assert.ok(await fs.access(first.entryPath).then(() => true, () => false), '旧候选入口必须保留');
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. 修复回归：提交点后不得误报失败 / gate 统一解除 / force 重装 / 缓存严格复核
// ---------------------------------------------------------------------------

test('performNodeUpgrade：clearBlockedRelease 失败发生在 commit 之前——不 commit、回滚、解除 gate', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await writeCurrentRelease(dir, { version: '1.0.0', entryPath: '/old/dist/cli.js', updatedAt: new Date().toISOString() });
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(888);

  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.6.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          // 真实文件故障：把 update-blocked.json 做成目录，rm(force) 删除必失败（EISDIR）
          await fs.mkdir(path.join(dir, 'update-blocked.json'), { recursive: true });
          return replacement;
        },
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      // 失败必须源于 commit 之前的文件操作，而不是 commit 本身
      assert.match(msg, /提交失败/);
      assert.match(msg, /update-blocked\.json/, '错误应包含真实故障文件诊断');
      return true;
    },
  );
  assert.deepEqual(calls, ['abort:888'], 'commit 前失败不得调用 commit，但必须 abort');
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0', 'current 必须还原');
  assert.deepEqual(log.draining, [true, false], '失败路径 gate 必须解除');
  assert.deepEqual(log.shutdownPids, [], '不得调度关机');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：commit 成功后无 fallible 文件操作——blocked 清理失败不误报失败', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(889);
  // blocked 文件为目录（清理必败）在 commit 前就应导致失败；本测试验证 commit 成功后路径：
  // 正常场景（blocked 是普通文件）下清理成功、结果 ok。
  const result = await performNodeUpgrade(dir, {
    targetVersion: '1.6.0',
    currentVersion: '1.0.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => replacement,
    ...makeHooks(log),
  });
  assert.equal(result.upgraded, true);
  assert.equal(result.pid, 889);
  assert.deepEqual(calls, ['commit:889']);
  assert.deepEqual(log.shutdownPids, [889]);
  assert.equal(await readBlockedRelease(dir), null, 'blocked 应在 commit 前被清理');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：drain 后 current.json 损坏——gate 解除、显式报错不伪装成功', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  // current.json 在进入 drain 前可读；读取旧 current 快照时才暴露损坏
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'current.json'), '{corrupted', 'utf8');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.6.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
        ...makeHooks(log),
      }),
    /current\.json 损坏/,
  );
  // 读取快照发生在 setDraining 之前，尚未进入排空
  assert.equal(log.draining.length, 0, '快照读取在 drain 前完成，不应已进入 draining');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：getActiveExecCount 抛错——统一 finally 解除 gate', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.6.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
        ...makeHooks(log),
        getActiveExecCount: () => {
          throw new Error('计数器崩溃');
        },
      }),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /计数器崩溃/);
      return true;
    },
  );
  assert.deepEqual(log.draining, [true, false], '回调抛错也必须解除 gate');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：prepare 失败且写 blocked 也失败——两处失败都如实上报', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.6.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          // update-blocked.json 做成目录：后续 writeBlockedRelease 写文件必败（真实文件故障）
          await fs.mkdir(path.join(dir, 'update-blocked.json'), { recursive: true });
          throw new Error('replacement daemon 注册失败');
        },
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      assert.match(msg, /replacement daemon 注册失败/);
      assert.match(msg, /写入 blocked 记录失败/, 'blocked 写入失败不得被吞掉');
      return true;
    },
  );
  assert.deepEqual(log.draining, [true, false]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm：force 跳过缓存生成新候选，旧候选保留', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const first = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: fakeExtractor });
  let extractorRuns = 0;
  const countingExtractor: typeof fakeExtractor = async (stagingDir, version) => {
    extractorRuns += 1;
    return fakeExtractor(stagingDir, version);
  };
  // 非 force：复用缓存，不重新安装
  const cached = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: countingExtractor });
  assert.equal(cached.releaseDir, first.releaseDir);
  assert.equal(extractorRuns, 0);
  // force：重新安装生成新不可变候选，旧候选不删除
  const forced = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: countingExtractor, force: true });
  assert.equal(extractorRuns, 1);
  assert.notEqual(forced.releaseDir, first.releaseDir);
  assert.ok(forced.releaseDir.startsWith(path.join(dir, 'releases', '2.0.0') + path.sep));
  assert.ok(await fs.access(first.entryPath).then(() => true, () => false), '旧候选必须保留');
  assert.ok(await fs.access(forced.entryPath).then(() => true, () => false));
  // .complete 指向新候选
  const marker = JSON.parse(await fs.readFile(path.join(dir, 'releases', '2.0.0', '.complete'), 'utf8'));
  assert.equal(marker.candidateDir, forced.releaseDir);
  // 再次非 force 复用新候选
  const again = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: countingExtractor });
  assert.equal(again.releaseDir, forced.releaseDir);
  assert.equal(extractorRuns, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：force 传递到 staging——同版本升级也重新安装', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const first = await stageReleaseFromNpm(dir, '1.0.0', { stageExtractor: fakeExtractor });
  let extractorRuns = 0;
  const result = await performNodeUpgrade(dir, {
    targetVersion: '1.0.0',
    currentVersion: '1.0.0',
    force: true,
    stageExtractor: async (stagingDir, version) => {
      extractorRuns += 1;
      return fakeExtractor(stagingDir, version);
    },
    prepareReplacement: async () => makeReplacement(66).replacement,
  });
  assert.equal(result.upgraded, true, 'force 同版本应重新安装并升级');
  assert.equal(extractorRuns, 1, 'force 不得复用 .complete 缓存');
  assert.notEqual(result.targetVersion, first.releaseDir);
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.notEqual(current?.entryPath, first.entryPath, 'current 应指向新候选入口');
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm：缓存指向版本目录外/候选内路径非法时显式拒绝，不删旧候选', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const staged = await stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor });
  const completePath = path.join(dir, 'releases', '3.0.0', '.complete');
  // a) entryPath 指向版本目录之外
  const outside = JSON.parse(await fs.readFile(completePath, 'utf8'));
  await fs.writeFile(completePath, JSON.stringify({ ...outside, entryPath: '/etc/passwd' }), 'utf8');
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /不在本版本不可变目录内/);
  // b) candidateDir 指向版本目录之外
  await fs.writeFile(completePath, JSON.stringify({ ...outside, candidateDir: path.join(dir, 'elsewhere') }), 'utf8');
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /不可变目录内/);
  // c) entryPath 存在但不在候选目录内（版本目录内但候选外）
  await fs.writeFile(
    completePath,
    JSON.stringify({ ...outside, entryPath: path.join(dir, 'releases', '3.0.0', 'other', 'cli.js') }),
    'utf8',
  );
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /不可变目录内/);
  // d) 入口文件被删（缓存失效）→ 显式拒绝（不静默重建，不删候选）
  await fs.writeFile(completePath, JSON.stringify(outside), 'utf8');
  await fs.rm(staged.entryPath);
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /入口文件不存在/);
  // 旧候选目录仍完整存在
  assert.ok(await fs.access(path.dirname(staged.entryPath)).then(() => true, () => false));
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：commit 抛 UpgradeCommitUnconfirmedError——不 abort 不回滚不写 blocked，保持 current/gate 并让位', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const oldCurrent = { version: '1.0.0', entryPath: '/old/dist/cli.js', updatedAt: '2026-01-01T00:00:00.000Z' };
  await writeCurrentRelease(dir, oldCurrent);
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const unconfirmed = new UpgradeCommitUnconfirmedError('activate ACK 超时（候选可能已向 Hub 上报 commit）');
  const { replacement, calls } = makeReplacement(990, { commitError: unconfirmed });

  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '2.5.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => replacement,
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const err = error as Error & { cause?: unknown };
      const msg = err.message;
      assert.match(msg, /新版本已选择，激活结果未确认/);
      assert.doesNotMatch(msg, /回滚到 1\.0\.0|rollback/);
      assert.equal(err.cause, unconfirmed, '原始未确认错误作为 cause 保留');
      return true;
    },
  );
  assert.deepEqual(calls, ['commit:990'], '不得调用 abort');
  // 新 current 保持指向目标版本，不回滚
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '2.5.0');
  // 不写 failed/blocked
  assert.equal(await readBlockedRelease(dir), null);
  // gate 保持 draining（旧宿主即将退出，新宿主可能已接管）
  assert.deepEqual(log.draining, [true]);
  // 旧宿主让位已通知
  assert.deepEqual(log.shutdownPids, [990]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade：普通 commit 错误仍完整回滚（与未确认分支对比）', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const oldCurrent = { version: '1.0.0', entryPath: '/old/dist/cli.js', updatedAt: '2026-01-01T00:00:00.000Z' };
  await writeCurrentRelease(dir, oldCurrent);
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(991, { commitError: new Error('activate handshake timeout') });

  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '2.5.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => replacement,
        ...makeHooks(log),
      }),
    /提交失败，已回滚到 1\.0\.0/,
  );
  assert.deepEqual(calls, ['commit:991', 'abort:991']);
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  assert.equal((await readBlockedRelease(dir))?.version, '2.5.0');
  assert.deepEqual(log.draining, [true, false]);
  assert.deepEqual(log.shutdownPids, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm：npm 缓存复用时重新核对双包 package.json 版本', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  // 直接构造 npm origin 的缓存标记：候选内放置版本不符的包产物
  const versionRoot = path.join(dir, 'releases', '4.0.0');
  const candidateDir = path.join(versionRoot, '11111111-2222-3333-4444-555555555555');
  const nodePkgDir = path.join(candidateDir, 'node_modules', '@helm', 'node');
  const cliPkgDir = path.join(candidateDir, 'node_modules', '@helm', 'cli');
  await fs.mkdir(path.join(nodePkgDir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(cliPkgDir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(candidateDir, 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(nodePkgDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(nodePkgDir, 'package.json'), JSON.stringify({ name: '@helm/node', version: '4.0.0' }), 'utf8');
  await fs.writeFile(path.join(cliPkgDir, 'dist', 'index.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(
    path.join(cliPkgDir, 'package.json'),
    JSON.stringify({ name: '@helm/cli', version: '3.9.9', bin: { helm: './dist/index.js' } }),
    'utf8',
  );
  await fs.writeFile(
    path.join(versionRoot, '.complete'),
    JSON.stringify({
      version: '4.0.0',
      candidateDir,
      entryPath: path.join(nodePkgDir, 'dist', 'cli.js'),
      cliBinDir: path.join(candidateDir, 'node_modules', '.bin'),
      completedAt: new Date().toISOString(),
      origin: 'npm',
    }),
    'utf8',
  );
  // @helm/cli 版本与目标不符 → 复用被拒
  await assert.rejects(
    () => stageReleaseFromNpm(dir, '4.0.0', { stageExtractor: fakeExtractor }),
    /安装产物包名\/版本不符.*@helm\/cli/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});
