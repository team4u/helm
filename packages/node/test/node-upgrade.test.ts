/**
 * helm-node upgrade engine test: real function behavior is main.
 * override: version parse/compare/specification,JSON record corrupt and atomic write,upgrade check,
 * double package metadata/complete reject, guard against fall back, cool down phase, arrange empty gate,prepare/commit/abort
 * order, failed rollback, across process lock,stageExtractor path escape.
 * does not real npm network install (stageExtractor inject alternative network path),npm real
 * download link by fetch mock validate request and validate logic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { sleep as delay } from '@helm/test-kit';
import { makeTempDir as tempDir } from '@helm/test-kit/node';
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
/** stageExtractor: in staging inside fabricate double package install artifact structure. */
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
// 1. version:compareSemver / normalizeTargetVersion / getNodeVersion
// ---------------------------------------------------------------------------

test('compareSemver: core number, pre- publish priority and invalid input', { timeout: 60_000 }, () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1); // formal > pre- publish
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1); // pre- publish segment few more small
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1); // number < character parent
  assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.11'), -1); // number by count value
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-beta.9'), 1);
  // build metadata legal but does not participate compare (SemVer specification 10 )
  assert.equal(compareSemver('1.0.0+build.123', '1.0.0+build.456'), 0);
  assert.equal(compareSemver('1.0.0+sha.a1b2c3', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0-beta.1+exp.sha.5114f85', '1.0.0-beta.1'), 0);
  assert.equal(compareSemver('1.0.1+a', '1.0.0+b'), 1); // core number takes precedence at build
  assert.equal(compareSemver('1.0.0-rc.1+b1', '1.0.0-rc.2+b2'), -1); // pre- publish takes precedence at build
  for (const bad of ['v1.0.0', '1.0', '1.0.0.0', '01.0.0', 'not-a-version', '', '1.0.0-', '1.0.0+', '1.0.0+a_b', '1.0.0+a..b']) {
    assert.throws(() => compareSemver(bad, '1.0.0'), UpgradeRejectedError, `should reject ${bad}`);
  }
});

test('normalizeTargetVersion:trim and remove a v prefix after strictly validate', { timeout: 60_000 }, () => {
  assert.equal(normalizeTargetVersion('  1.2.3  '), '1.2.3');
  assert.equal(normalizeTargetVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeTargetVersion(' v1.2.3-rc.1 '), '1.2.3-rc.1');
  assert.equal(normalizeTargetVersion('v1.2.3+build.7'), '1.2.3+build.7');
  assert.equal(normalizeTargetVersion(' v1.2.3+build.7 '), '1.2.3+build.7');
  assert.throws(() => normalizeTargetVersion('vv1.2.3'), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion('1.2'), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion('1.2.3+bad_build'), UpgradeRejectedError);
});

test('getNodeVersion: read itself package.json,HELM_VERSION_OVERRIDE override', { timeout: 60_000 }, () => {
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

test('resolveEffectiveNodeVersion:current.json takes precedence, missing fall back itself package version', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  assert.equal(await resolveEffectiveNodeVersion(dir), getNodeVersion());
  await writeCurrentRelease(dir, { version: '3.2.1', entryPath: '/x/dist/cli.js', updatedAt: new Date().toISOString() });
  assert.equal(await resolveEffectiveNodeVersion(dir), '3.2.1');
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. JSON record: only ENOENT is null; corrupt/IO error explicit;0600
// ---------------------------------------------------------------------------

test('record read write:ENOENT return null,0600 atomic write,delete/clear idempotent', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  assert.equal(await readCurrentRelease(dir), null);
  assert.equal(await readBlockedRelease(dir), null);

  await writeCurrentRelease(dir, { version: '1.0.0', entryPath: '/a/dist/cli.js', updatedAt: '2026-01-01T00:00:00.000Z', cliBinDir: '/a/node_modules/.bin' });
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.equal(current?.cliBinDir, '/a/node_modules/.bin');
  const stat = rawFs.statSync(path.join(dir, 'current.json'));
  // Windows without POSIX mode(NTFS away ACL), skip 0600 pattern assertion.
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);

  await writeBlockedRelease(dir, { version: '2.0.0', reason: 'canary failed', at: '2026-01-02T00:00:00.000Z' });
  assert.equal((await readBlockedRelease(dir))?.reason, 'canary failed');
  if (process.platform !== 'win32') {
    assert.equal(rawFs.statSync(path.join(dir, 'update-blocked.json')).mode & 0o777, 0o600);
  }

  await deleteCurrentRelease(dir);
  await clearBlockedRelease(dir);
  assert.equal(await readCurrentRelease(dir), null);
  assert.equal(await readBlockedRelease(dir), null);
  await deleteCurrentRelease(dir); // idempotent
  await fs.rm(dir, { recursive: true, force: true });
});

test('record corrupt: non- JSON / missing field explicit errors, do not return null', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'current.json'), '{ not json', 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /corrupt/);
  await fs.writeFile(path.join(dir, 'current.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /entryPath/);
  await fs.writeFile(path.join(dir, 'update-blocked.json'), '[]', 'utf8');
  await assert.rejects(() => readBlockedRelease(dir), /corrupt/);
  await writeCurrentRelease(dir, { version: '', entryPath: 'x', updatedAt: 't' } as never).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. filterRpcRegistryUrl allows manifest
// ---------------------------------------------------------------------------

test('filterRpcRegistryUrl: only official and HELM_NPM_REGISTRY, other source explicit reject', { timeout: 60_000 }, () => {
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

test('checkNodeUpgrade: query latest, compare version, pass-through blocked', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await writeBlockedRelease(dir, { version: '1.5.0', reason: 'boom', at: new Date().toISOString() });
  const { fetchFn, urls } = makeRegistryFetch('1.2.0');
  const result = await checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn });
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.blocked?.version, '1.5.0');
  assert.match(urls[0]!, /@helm%2Fnode\/latest|@helm\/node\/latest/);

  // current.json missing and not pass currentVersion when fall back getNodeVersion
  const result2 = await checkNodeUpgrade((await tempDir('helm-node-upgrade-')), { fetchFn: makeRegistryFetch('0.0.1').fetchFn });
  assert.equal(result2.currentVersion, getNodeVersion());
  assert.equal(result2.updateAvailable, false);

  // registry return illegal version → explicit errors
  const bad = makeRegistryFetch('not-semver');
  await assert.rejects(() => checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn: bad.fetchFn }));
  await fs.rm(dir, { recursive: true, force: true });
});

test('checkNodeUpgrade:HTTP failed and timeout explicit errors', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const fail: typeof fetch = async () => new Response('nope', { status: 404, statusText: 'Not Found' });
  await assert.rejects(() => checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn: fail }), /404/);
  // fetch immediately with AbortError reject → mapping is explicit"query failed+timeout"error
  const timeout_: typeof fetch = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(
    () => checkNodeUpgrade(dir, { currentVersion: '1.0.0', registryUrl: 'http://127.0.0.1:1', fetchFn: timeout_ }),
    /query .* most new version failed:request timeout/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. stageReleaseFromNpm: cache re- use / stageExtractor / double package validate reject
// ---------------------------------------------------------------------------

test('stageReleaseFromNpm:stageExtractor artifact immutable choose directory and write .complete, second invoke re- use', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const staged = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  assert.equal(staged.version, '1.2.3');
  assert.ok(staged.releaseDir.startsWith(path.join(dir, 'releases', '1.2.3') + path.sep));
  assert.ok(await fs.access(staged.entryPath).then(() => true, () => false));
  assert.ok(staged.cliBinDir.endsWith('node_modules/.bin'));
  const marker = JSON.parse(await fs.readFile(path.join(dir, 'releases', '1.2.3', '.complete'), 'utf8'));
  assert.equal(marker.entryPath, staged.entryPath);

  const staged2 = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  assert.equal(staged2.releaseDir, staged.releaseDir); // re- use, do not creates new choose
  await assert.rejects(() => stageReleaseFromNpm(dir, 'bad-version', { stageExtractor: fakeExtractor }), UpgradeRejectedError);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm:stageExtractor path escape and absolute path reject, failed do not staging', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await assert.rejects(
    () =>
      stageReleaseFromNpm(dir, '1.0.0', {
        stageExtractor: async (stagingDir) => ({ entryPath: path.join('..', '..', 'escape.js'), cliBinDir: 'node_modules/.bin' }),
      }),
    /escape/,
  );
  await assert.rejects(
    () =>
      stageReleaseFromNpm(dir, '1.0.0', {
        stageExtractor: async () => ({ entryPath: '/etc/passwd', cliBinDir: 'node_modules/.bin' }),
      }),
    /relative path/,
  );
  const entries = await fs.readdir(path.join(dir, 'releases', '1.0.0'));
  assert.ok(entries.every((e) => e === '.complete' || !e.startsWith('.staging')), 'failed after must not leftover staging directory');
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm: double package metadata/hash/install artifact validation failed all reject', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');

  // a) metadata package name/version do not symbol
  const wrongMeta = makeRegistryFetch('1.0.0', { name: '@evil/node', version: '1.0.0', dist: { integrity: 'sha512-abc', tarball: 'https://r/t.tgz' } });
  await assert.rejects(
    () => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: wrongMeta.fetchFn }),
    /package name do not symbol/,
  );

  // b) tarball sha512 does not match
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
  await assert.rejects(() => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: tampered }), /complete validation failed/);

  // c) missing dist.integrity
  const noIntegrity: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
    const name = url.includes('%2Fcli') ? '@helm/cli' : '@helm/node';
    return new Response(JSON.stringify({ name, version: '1.0.0', dist: { tarball: 'https://r/t.tgz' } }), { status: 200 });
  };
  await assert.rejects(() => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: noIntegrity }), /integrity/);

  // d) version does not match metadata
  const versionMismatch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
    const name = url.includes('%2Fcli') ? '@helm/cli' : '@helm/node';
    return new Response(JSON.stringify({ name, version: '1.0.1', dist: { integrity: 'sha512-abc', tarball: 'https://r/t.tgz' } }), { status: 200 });
  };
  await assert.rejects(() => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: versionMismatch }), /version do not symbol/);

  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6. performNodeUpgrade: transaction semantics
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

test('performNodeUpgrade: without prepareReplacement explicit reject (do not fabricate PID)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await assert.rejects(() => performNodeUpgrade(dir, {}), /prepareReplacement/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: succeeded path prepare→commit→onScheduleShutdown(pid),current update,blocked clear', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await writeBlockedRelease(dir, { version: '2.0.0', reason: 'old failed', at: new Date().toISOString() });
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
  assert.deepEqual(calls, ['commit:4242']); // commit exactly once, succeeded path do not abort
  assert.equal(releases[0]?.version, '1.2.3');
  assert.ok(contexts[0]?.attemptId);
  assert.equal(contexts[0]?.previousVersion, '1.0.0');
  assert.equal(contexts[0]?.targetVersion, '1.2.3');
  assert.deepEqual(log.shutdownPids, [4242]);
  assert.deepEqual(log.draining, [true]); // after success keep draining(old host i.e. exit)
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.2.3');
  assert.equal(current?.entryPath, releases[0]?.entryPath);
  assert.equal(current?.cliBinDir, releases[0]?.cliBinDir);
  assert.equal(await readBlockedRelease(dir), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade:targetVersion specification (v prefix/whitespace) used to directory and result', { timeout: 60_000 }, async () => {
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

test('performNodeUpgrade: same version non- force without operation, do not stage do not arrange empty', { timeout: 60_000 }, async () => {
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

test('performNodeUpgrade: guard against fall back reject (force can exceeds)', { timeout: 60_000 }, async () => {
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
  // force allows fall back
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

test('performNodeUpgrade: failed version cool down phase inside reject,force or expired after can retry', { timeout: 60_000 }, async () => {
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
    /cool down/,
  );
  // force can retry
  const result = await performNodeUpgrade(dir, {
    targetVersion: '1.5.0',
    currentVersion: '1.0.0',
    force: true,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(8).replacement,
  });
  assert.equal(result.upgraded, true);

  // cool down expired (write a 31 minute before record) after no need to force also can retry
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

test('performNodeUpgrade: arrange empty gate- -exec in timeout inside reset to zero after let through', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 2 }, shutdownPids: [] };
  // 100ms after exec self however reset to zero
  setTimeout(() => {
    log.execCount.value = 0;
  }, 100).unref();
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

test('performNodeUpgrade: arrange empty timeout - - abandon upgrade, solve except gate, without any change', { timeout: 60_000 }, async () => {
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
    /arrange empty timeout/,
  );
  assert.equal(prepared, 0, 'arrange empty failed must not enter prepare');
  assert.deepEqual(log.draining, [true, false], 'gate must solve except');
  assert.deepEqual(log.shutdownPids, []);
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade:commit failed - -abort, restore current, write blocked, solve except gate', { timeout: 60_000 }, async () => {
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
    /activate handshake timeout[\s\S]*rollback/,
  );
  assert.deepEqual(calls, ['commit:321', 'abort:321'], 'commit failed must abort');
  const current = await readCurrentRelease(dir);
  assert.deepEqual(current, originalCurrent, 'current must restore');
  const blocked = await readBlockedRelease(dir);
  assert.equal(blocked?.version, '1.4.0');
  assert.match(blocked?.reason ?? '', /activate handshake timeout/);
  assert.deepEqual(log.draining, [true, false], 'failed path gate solve except');
  assert.deepEqual(log.shutdownPids, []);

  // by cool down version retry by refuse
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.4.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /cool down/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade:prepareReplacement throws - -current not change, write blocked, solve except gate', { timeout: 60_000 }, async () => {
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
          throw new Error('replacement daemon register failed');
        },
        ...makeHooks(log),
      }),
    /replacement daemon register failed/,
  );
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  const blocked = await readBlockedRelease(dir);
  assert.equal(blocked?.version, '2.0.0');
  assert.deepEqual(log.draining, [true, false]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: target version take latest(not explicit designate when)', { timeout: 60_000 }, async () => {
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

test('performNodeUpgrade: across process upgrade lock mutual exclusion', { timeout: 60_000 }, async () => {
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
      await gate; // hold lock wait for external let through
      return makeReplacement(11).replacement;
    },
  });
  // etc. first time upgrade truly enter hold lock phase (prepare already by invoke)
  const deadline = Date.now() + 5_000;
  while (enteredPrepare === 0 && Date.now() < deadline) await delay(20);
  assert.equal(enteredPrepare, 1, 'first time upgrade should already enter hold lock phase');
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.3.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /upgrade already in in progress/,
  );
  unblock?.();
  const firstResult = await first;
  assert.equal(firstResult.upgraded, true);
  // lock already release, can again upgrade
  const second = await performNodeUpgrade(dir, {
    targetVersion: '1.3.0',
    currentVersion: '1.2.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(12).replacement,
  });
  assert.equal(second.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: same version directory is now use when do not delete choose (immutable)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const first = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  // upgrade to other version after again stage same version: old choose still in
  const again = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  assert.equal(again.releaseDir, first.releaseDir);
  assert.ok(await fs.access(first.entryPath).then(() => true, () => false), 'old choose entry must keep');
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. fix regression: commit point after must not mistakenly report failed / gate unify solve except / force heavy install / cache strictly re-check
// ---------------------------------------------------------------------------

test('performNodeUpgrade:clearBlockedRelease failed occur in commit before - - do not commit, rollback, solve except gate', { timeout: 60_000 }, async () => {
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
          // real file fault: update-blocked.json do into directory,rm(force) delete must failed (EISDIR)
          await fs.mkdir(path.join(dir, 'update-blocked.json'), { recursive: true });
          return replacement;
        },
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      // failed must source at commit before file operation, while is not commit itself
      assert.match(msg, /commit failed/);
      assert.match(msg, /update-blocked\.json/, 'error should contain real fault file diagnose');
      return true;
    },
  );
  assert.deepEqual(calls, ['abort:888'], 'commit before failed must not invoke commit, but must abort');
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0', 'current must restore');
  assert.deepEqual(log.draining, [true, false], 'failed path gate must solve except');
  assert.deepEqual(log.shutdownPids, [], 'must not scheduling closure machine');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade:commit after success without fallible file operation - -blocked clean up failed do not mistakenly report failed', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(889);
  // blocked file is directory (clean up must failed) in commit before then should leads to failed; this test verify commit after success path:
  // normal scenario (blocked is ordinary file) under clean up succeeded, result ok.
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
  assert.equal(await readBlockedRelease(dir), null, 'blocked should in commit before by clean up');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade:drain after current.json corrupt - -gate solve except, explicit errors does not pretend to be succeeded', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  // current.json in enter drain before can read; read old current snapshot when only then expose corrupt
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
    /current\.json corrupt/,
  );
  // read snapshot occur in setDraining before, not yet enter arrange empty
  assert.equal(log.draining.length, 0, 'snapshot read in drain before complete, must not already enter draining');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade:getActiveExecCount throws - - unify finally solve except gate', { timeout: 60_000 }, async () => {
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
          throw new Error('counter crash');
        },
      }),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /counter crash/);
      return true;
    },
  );
  assert.deepEqual(log.draining, [true, false], 'call back throws also must solve except gate');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade:prepare failed and write blocked also failed - - two where failed all such as on report', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.6.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          // update-blocked.json do into directory: after continue writeBlockedRelease write file must failed (real file fault)
          await fs.mkdir(path.join(dir, 'update-blocked.json'), { recursive: true });
          throw new Error('replacement daemon register failed');
        },
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      assert.match(msg, /replacement daemon register failed/);
      assert.match(msg, /write blocked record failed/, 'blocked failed to write must not by swallow');
      return true;
    },
  );
  assert.deepEqual(log.draining, [true, false]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm:force skip cache generate new choose, old choose keep', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const first = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: fakeExtractor });
  let extractorRuns = 0;
  const countingExtractor: typeof fakeExtractor = async (stagingDir, version) => {
    extractorRuns += 1;
    return fakeExtractor(stagingDir, version);
  };
  // non- force: re- use cache, do not re- install
  const cached = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: countingExtractor });
  assert.equal(cached.releaseDir, first.releaseDir);
  assert.equal(extractorRuns, 0);
  // force: re- install generate new cannot change choose, old choose do not delete
  const forced = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: countingExtractor, force: true });
  assert.equal(extractorRuns, 1);
  assert.notEqual(forced.releaseDir, first.releaseDir);
  assert.ok(forced.releaseDir.startsWith(path.join(dir, 'releases', '2.0.0') + path.sep));
  assert.ok(await fs.access(first.entryPath).then(() => true, () => false), 'old choose must keep');
  assert.ok(await fs.access(forced.entryPath).then(() => true, () => false));
  // .complete points to new choose
  const marker = JSON.parse(await fs.readFile(path.join(dir, 'releases', '2.0.0', '.complete'), 'utf8'));
  assert.equal(marker.candidateDir, forced.releaseDir);
  // again non- force re- use new choose
  const again = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: countingExtractor });
  assert.equal(again.releaseDir, forced.releaseDir);
  assert.equal(extractorRuns, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade:force pass to staging- - same version upgrade also re- install', { timeout: 60_000 }, async () => {
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
  assert.equal(result.upgraded, true, 'force same version should re- install and upgrade');
  assert.equal(extractorRuns, 1, 'force must not re- use .complete cache');
  assert.notEqual(result.targetVersion, first.releaseDir);
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.notEqual(current?.entryPath, first.entryPath, 'current should points to new choose entry');
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm: cache points to version directory outside/choose inside path illegal when explicit reject, do not delete old choose', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const staged = await stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor });
  const completePath = path.join(dir, 'releases', '3.0.0', '.complete');
  // a) entryPath points to version directory of outside
  const outside = JSON.parse(await fs.readFile(completePath, 'utf8'));
  await fs.writeFile(completePath, JSON.stringify({ ...outside, entryPath: '/etc/passwd' }), 'utf8');
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /do not in this version cannot change directory inside/);
  // b) candidateDir points to version directory of outside
  await fs.writeFile(completePath, JSON.stringify({ ...outside, candidateDir: path.join(dir, 'elsewhere') }), 'utf8');
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /cannot change directory inside/);
  // c) entryPath store in but do not in choose directory inside (version directory inside but choose outside)
  await fs.writeFile(
    completePath,
    JSON.stringify({ ...outside, entryPath: path.join(dir, 'releases', '3.0.0', 'other', 'cli.js') }),
    'utf8',
  );
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /cannot change directory inside/);
  // d) entry file by delete (cache expires)→ explicit reject (not silently rebuild, do not delete choose)
  await fs.writeFile(completePath, JSON.stringify(outside), 'utf8');
  await fs.rm(staged.entryPath);
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /entry file missing/);
  // old choose directory still complete store in
  assert.ok(await fs.access(path.dirname(staged.entryPath)).then(() => true, () => false));
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade:commit throw UpgradeCommitUnconfirmedError- - do not abort do not rollback do not write blocked, keep current/gate and let', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const oldCurrent = { version: '1.0.0', entryPath: '/old/dist/cli.js', updatedAt: '2026-01-01T00:00:00.000Z' };
  await writeCurrentRelease(dir, oldCurrent);
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const unconfirmed = new UpgradeCommitUnconfirmedError('activate ACK timeout (choose may already to Hub on report commit)');
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
      assert.match(msg, /new version already choose, activate result not confirm/);
      assert.doesNotMatch(msg, /rollback to 1\.0\.0|rolled back/);
      assert.equal(err.cause, unconfirmed, 'original not confirm error as cause keep');
      return true;
    },
  );
  assert.deepEqual(calls, ['commit:990'], 'must not invoke abort');
  // new current keep points to target version, do not rollback
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '2.5.0');
  // do not write failed/blocked
  assert.equal(await readBlockedRelease(dir), null);
  // gate keep draining(old host i.e. exit, new host may already take over)
  assert.deepEqual(log.draining, [true]);
  // old host let already notify
  assert.deepEqual(log.shutdownPids, [990]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: ordinary commit error still complete rollback (and not confirm branch compare)', { timeout: 60_000 }, async () => {
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
    /commit failed, already rollback to 1\.0\.0/,
  );
  assert.deepEqual(calls, ['commit:991', 'abort:991']);
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  assert.equal((await readBlockedRelease(dir))?.version, '2.5.0');
  assert.deepEqual(log.draining, [true, false]);
  assert.deepEqual(log.shutdownPids, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm:npm cache re- use when re- core for double package package.json version', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  // directly construct npm origin cache mark record: choose inside put placement version do not symbol package artifact
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
  // @helm/cli version and target do not symbol → re- use by refuse
  await assert.rejects(
    () => stageReleaseFromNpm(dir, '4.0.0', { stageExtractor: fakeExtractor }),
    /install artifact package name\/version do not symbol.*@helm\/cli/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runNpm timeout process group semantics:npm lifecycle script descendant process do not orphan child
// ---------------------------------------------------------------------------

test('runNpm timeout kill process group:npm run descendant process sync by kill (do not orphan child continue write staging)', { timeout: 60_000 }, async (t) => {
  if (process.platform === 'win32') return; // POSIX process group semantics;win32 away taskkill /T etc. effect path
  const dir = await tempDir('npm-group-kill-');
  const heartbeat = path.join(dir, 'beat.txt');
  const grandPidFile = path.join(dir, 'grand.pid');
  const runnerScript = path.join(dir, 'runner.cjs');
  // runner(npm run directly child process) again derive descendant process: descendant process continuous write heartbeat file,
  // simulated install-script in timeout after continue write correct by clean up staging directory.
  await fs.writeFile(
    runnerScript,
    [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const g = spawn(process.execPath, ['-e', " +
        JSON.stringify(
          "const fs=require('node:fs');" +
          "setInterval(()=>fs.appendFile(process.argv[1],'.',()=>{}),50);" +
          "setInterval(()=>{},1000);",
        ) +
        ", process.argv[2]], { stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[3], String(g.pid));",
      "setInterval(() => {}, 1000);",
    ].join('\n'),
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'npm-group-hold', private: true, scripts: { hold: `node ${runnerScript} ${JSON.stringify(heartbeat)} ${JSON.stringify(grandPidFile)}` } }),
    'utf8',
  );
  const cleanup = async (): Promise<void> => {
    const raw = await fs.readFile(grandPidFile, 'utf8').catch(() => '');
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already die.
      }
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  t.after(async () => {
    await cleanup();
  });

  const { runNpm } = await import('../src/daemon/upgrader.js');
  const npmPromise = runNpm(['run', 'hold'], dir, 3_000);
  // etc. npm pull start runner and descendant process (pid file persisted) again let timeout trigger, ensure by test object store in
  const deadline = Date.now() + 2_500;
  for (;;) {
    const exists = await fs.readFile(grandPidFile, 'utf8').then(
      () => true,
      () => false,
    );
    if (exists) break;
    if (Date.now() > deadline) throw new Error('npm run not can in pre- compute inside pull start descendant process (fixture failed)');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await assert.rejects(() => npmPromise, /timeout/);

  const rawPid = await fs.readFile(grandPidFile, 'utf8');
  const grandPid = Number(rawPid.trim());
  assert.ok(Number.isInteger(grandPid) && grandPid > 0, `descendant process pid illegal:${rawPid}`);
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // process group kill sync takes effect; small window retry absorb scheduling lag
  let alive = isAlive(grandPid);
  for (let i = 0; i < 20 && alive; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = isAlive(grandPid);
  }
  assert.equal(alive, false, 'timeout after descendant process must follow process group by kill, do not orphan child');
});
