/**
 * Tests for helm-node upgrade engine behavior:
 * semver parsing/comparison/normalization, corrupt JSON handling and atomic writes,
 * upgrade checks, dual-package metadata/.complete validation rejections, downgrade guard,
 * failure cooldown, drain gate, prepare/commit/abort ordering, rollback on failure,
 * cross-process upgrade lock, and stageExtractor path traversal checks.
 * Uses injected stageExtractor and mocked fetch rather than live npm downloads.
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
/** stageExtractor: create a fake dual-package layout inside stagingDir. */
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
// 1. Version parsing: compareSemver / normalizeTargetVersion / getNodeVersion
// ---------------------------------------------------------------------------

test('compareSemver: core numbers, pre-release precedence, and invalid inputs', { timeout: 60_000 }, () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1);
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta.1'), 1); // stable > pre-release
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1); // fewer pre-release fields < more
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1); // numeric < alphanumeric
  assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.11'), -1); // numeric comparison
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-beta.9'), 1);
  // build metadata is valid but ignored in precedence (SemVer §10)
  assert.equal(compareSemver('1.0.0+build.123', '1.0.0+build.456'), 0);
  assert.equal(compareSemver('1.0.0+sha.a1b2c3', '1.0.0'), 0);
  assert.equal(compareSemver('1.0.0-beta.1+exp.sha.5114f85', '1.0.0-beta.1'), 0);
  assert.equal(compareSemver('1.0.1+a', '1.0.0+b'), 1); // core version takes precedence over build metadata
  assert.equal(compareSemver('1.0.0-rc.1+b1', '1.0.0-rc.2+b2'), -1); // pre-release takes precedence over build metadata
  for (const bad of ['v1.0.0', '1.0', '1.0.0.0', '01.0.0', 'not-a-version', '', '1.0.0-', '1.0.0+', '1.0.0+a_b', '1.0.0+a..b']) {
    assert.throws(() => compareSemver(bad, '1.0.0'), UpgradeRejectedError, `should reject ${bad}`);
  }
});

test('normalizeTargetVersion: trims whitespace, strips single v prefix, and validates strictly', { timeout: 60_000 }, () => {
  assert.equal(normalizeTargetVersion('  1.2.3  '), '1.2.3');
  assert.equal(normalizeTargetVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeTargetVersion(' v1.2.3-rc.1 '), '1.2.3-rc.1');
  assert.equal(normalizeTargetVersion('v1.2.3+build.7'), '1.2.3+build.7');
  assert.equal(normalizeTargetVersion(' v1.2.3+build.7 '), '1.2.3+build.7');
  assert.throws(() => normalizeTargetVersion('vv1.2.3'), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion('1.2'), UpgradeRejectedError);
  assert.throws(() => normalizeTargetVersion('1.2.3+bad_build'), UpgradeRejectedError);
});

test('getNodeVersion: reads package.json and honors HELM_VERSION_OVERRIDE', { timeout: 60_000 }, () => {
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

test('resolveEffectiveNodeVersion: prefers current.json and falls back to own package version', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  assert.equal(await resolveEffectiveNodeVersion(dir), getNodeVersion());
  await writeCurrentRelease(dir, { version: '3.2.1', entryPath: '/x/dist/cli.js', updatedAt: new Date().toISOString() });
  assert.equal(await resolveEffectiveNodeVersion(dir), '3.2.1');
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. JSON records: only ENOENT returns null; corrupt/IO errors throw explicitly; mode 0600
// ---------------------------------------------------------------------------

test('record read/write: ENOENT returns null, atomic 0600 writes, idempotent delete/clear', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  assert.equal(await readCurrentRelease(dir), null);
  assert.equal(await readBlockedRelease(dir), null);

  await writeCurrentRelease(dir, { version: '1.0.0', entryPath: '/a/dist/cli.js', updatedAt: '2026-01-01T00:00:00.000Z', cliBinDir: '/a/node_modules/.bin' });
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.equal(current?.cliBinDir, '/a/node_modules/.bin');
  const stat = rawFs.statSync(path.join(dir, 'current.json'));
  // Windows lacks POSIX mode bits (NTFS uses ACLs), skip 0600 mode assertion.
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

test('record corruption: non-JSON and missing fields throw explicitly rather than returning null', { timeout: 60_000 }, async () => {
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
// 3. filterRpcRegistryUrl allowlist
// ---------------------------------------------------------------------------

test('filterRpcRegistryUrl: allows only official npm and HELM_NPM_REGISTRY, rejecting other origins', { timeout: 60_000 }, () => {
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

test('checkNodeUpgrade: queries latest version, compares semver, and passes through blocked record', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await writeBlockedRelease(dir, { version: '1.5.0', reason: 'boom', at: new Date().toISOString() });
  const { fetchFn, urls } = makeRegistryFetch('1.2.0');
  const result = await checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn });
  assert.equal(result.currentVersion, '1.0.0');
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.blocked?.version, '1.5.0');
  assert.match(urls[0]!, /@helm%2Fnode\/latest|@helm\/node\/latest/);

  // Fall back to getNodeVersion when current.json is absent and currentVersion is omitted
  const result2 = await checkNodeUpgrade((await tempDir('helm-node-upgrade-')), { fetchFn: makeRegistryFetch('0.0.1').fetchFn });
  assert.equal(result2.currentVersion, getNodeVersion());
  assert.equal(result2.updateAvailable, false);

  // Invalid version returned by registry must fail explicitly
  const bad = makeRegistryFetch('not-semver');
  await assert.rejects(() => checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn: bad.fetchFn }));
  await fs.rm(dir, { recursive: true, force: true });
});

test('checkNodeUpgrade: HTTP errors and timeouts throw explicitly', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const fail: typeof fetch = async () => new Response('nope', { status: 404, statusText: 'Not Found' });
  await assert.rejects(() => checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn: fail }), /404/);
  // Fetch rejecting with AbortError must map to explicit query + timeout error
  const timeout_: typeof fetch = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(
    () => checkNodeUpgrade(dir, { currentVersion: '1.0.0', registryUrl: 'http://127.0.0.1:1', fetchFn: timeout_ }),
    /failed to query latest version.*request timed out/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5. stageReleaseFromNpm: cache reuse / stageExtractor / dual-package validation
// ---------------------------------------------------------------------------

test('stageReleaseFromNpm: stageExtractor builds immutable candidate dir and writes .complete; subsequent call reuses cache', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const staged = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  assert.equal(staged.version, '1.2.3');
  assert.ok(staged.releaseDir.startsWith(path.join(dir, 'releases', '1.2.3') + path.sep));
  assert.ok(await fs.access(staged.entryPath).then(() => true, () => false));
  assert.ok(staged.cliBinDir.endsWith('node_modules/.bin'));
  const marker = JSON.parse(await fs.readFile(path.join(dir, 'releases', '1.2.3', '.complete'), 'utf8'));
  assert.equal(marker.entryPath, staged.entryPath);

  const staged2 = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  assert.equal(staged2.releaseDir, staged.releaseDir); // reuses cached candidate without creating a new one
  await assert.rejects(() => stageReleaseFromNpm(dir, 'bad-version', { stageExtractor: fakeExtractor }), UpgradeRejectedError);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm: rejects escaping or absolute stageExtractor paths without leaving staging dirs behind', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await assert.rejects(
    () =>
      stageReleaseFromNpm(dir, '1.0.0', {
        stageExtractor: async (stagingDir) => ({ entryPath: path.join('..', '..', 'escape.js'), cliBinDir: 'node_modules/.bin' }),
      }),
    /escapes/,
  );
  await assert.rejects(
    () =>
      stageReleaseFromNpm(dir, '1.0.0', {
        stageExtractor: async () => ({ entryPath: '/etc/passwd', cliBinDir: 'node_modules/.bin' }),
      }),
    /expected relative/,
  );
  const entries = await fs.readdir(path.join(dir, 'releases', '1.0.0'));
  assert.ok(entries.every((e) => e === '.complete' || !e.startsWith('.staging')), 'must not leave .staging directories behind on failure');
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm: rejects dual-package metadata, integrity, and artifact validation failures', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');

  // a) Metadata package name mismatch
  const wrongMeta = makeRegistryFetch('1.0.0', { name: '@evil/node', version: '1.0.0', dist: { integrity: 'sha512-abc', tarball: 'https://r/t.tgz' } });
  await assert.rejects(
    () => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: wrongMeta.fetchFn }),
    /package name mismatch/,
  );

  // b) Tarball sha512 mismatch
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
  await assert.rejects(() => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: tampered }), /integrity check failed/);

  // c) Missing dist.integrity
  const noIntegrity: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
    const name = url.includes('%2Fcli') ? '@helm/cli' : '@helm/node';
    return new Response(JSON.stringify({ name, version: '1.0.0', dist: { tarball: 'https://r/t.tgz' } }), { status: 200 });
  };
  await assert.rejects(() => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: noIntegrity }), /integrity/);

  // d) Metadata version mismatch
  const versionMismatch: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.endsWith('/latest')) return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
    const name = url.includes('%2Fcli') ? '@helm/cli' : '@helm/node';
    return new Response(JSON.stringify({ name, version: '1.0.1', dist: { integrity: 'sha512-abc', tarball: 'https://r/t.tgz' } }), { status: 200 });
  };
  await assert.rejects(() => stageReleaseFromNpm(dir, '1.0.0', { fetchFn: versionMismatch }), /version mismatch/);

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

test('performNodeUpgrade: rejects explicitly when prepareReplacement is omitted (never fabricates a PID)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await assert.rejects(() => performNodeUpgrade(dir, {}), /prepareReplacement/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: success path runs prepare -> commit -> onScheduleShutdown(pid), updates current, clears blocked', { timeout: 60_000 }, async () => {
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
  assert.deepEqual(calls, ['commit:4242']); // commit exactly once; never abort on success path
  assert.equal(releases[0]?.version, '1.2.3');
  assert.ok(contexts[0]?.attemptId);
  assert.equal(contexts[0]?.previousVersion, '1.0.0');
  assert.equal(contexts[0]?.targetVersion, '1.2.3');
  assert.deepEqual(log.shutdownPids, [4242]);
  assert.deepEqual(log.draining, [true]); // keep draining after success (old host is exiting)
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.2.3');
  assert.equal(current?.entryPath, releases[0]?.entryPath);
  assert.equal(current?.cliBinDir, releases[0]?.cliBinDir);
  assert.equal(await readBlockedRelease(dir), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: normalizes targetVersion (v prefix/whitespace) for directory names and results', { timeout: 60_000 }, async () => {
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

test('performNodeUpgrade: no-op on same version unless force is set (no staging or draining)', { timeout: 60_000 }, async () => {
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

test('performNodeUpgrade: rejects downgrades unless force=true', { timeout: 60_000 }, async () => {
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
  // force=true permits downgrade
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

test('performNodeUpgrade: rejects failed version during cooldown unless force=true or cooldown expired', { timeout: 60_000 }, async () => {
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
    /cooldown/,
  );
  // Retry permitted with force=true
  const result = await performNodeUpgrade(dir, {
    targetVersion: '1.5.0',
    currentVersion: '1.0.0',
    force: true,
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(8).replacement,
  });
  assert.equal(result.upgraded, true);

  // Once cooldown expires (record older than 31 minutes), retry succeeds without force
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

test('performNodeUpgrade: drain gate allows upgrade once in-flight exec count drops to zero before timeout', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 2 }, shutdownPids: [] };
  // Exec count drops to zero after 100ms
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

test('performNodeUpgrade: drain timeout aborts upgrade, releases drain gate, and leaves state untouched', { timeout: 60_000 }, async () => {
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
    /timed out draining/,
  );
  assert.equal(prepared, 0, 'drain failure must not enter prepare');
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released');
  assert.deepEqual(log.shutdownPids, []);
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: commit failure aborts replacement, restores current, writes blocked, and releases drain gate', { timeout: 60_000 }, async () => {
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
    /rolled back[\s\S]*activate handshake timeout/,
  );
  assert.deepEqual(calls, ['commit:321', 'abort:321'], 'commit failure must abort replacement');
  const current = await readCurrentRelease(dir);
  assert.deepEqual(current, originalCurrent, 'current.json must be restored');
  const blocked = await readBlockedRelease(dir);
  assert.equal(blocked?.version, '1.4.0');
  assert.match(blocked?.reason ?? '', /activate handshake timeout/);
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released on failure');
  assert.deepEqual(log.shutdownPids, []);

  // Immediate retry of blocked version is rejected by cooldown
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.4.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /cooldown/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: when prepareReplacement throws, current remains unchanged, blocked is written, and drain gate is released', { timeout: 60_000 }, async () => {
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

test('performNodeUpgrade: defaults target version to latest when omitted', { timeout: 60_000 }, async () => {
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

test('performNodeUpgrade: enforces cross-process upgrade lock exclusion', { timeout: 60_000 }, async () => {
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
      await gate; // hold lock until released externally
      return makeReplacement(11).replacement;
    },
  });
  // Wait until first upgrade enters lock-protected prepare phase
  const deadline = Date.now() + 5_000;
  while (enteredPrepare === 0 && Date.now() < deadline) await delay(20);
  assert.equal(enteredPrepare, 1, 'first upgrade should have entered lock-protected prepare phase');
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.3.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => makeReplacement(1).replacement,
      }),
    /upgrade already in progress/,
  );
  unblock?.();
  const firstResult = await first;
  assert.equal(firstResult.upgraded, true);
  // Lock released; second upgrade can proceed
  const second = await performNodeUpgrade(dir, {
    targetVersion: '1.3.0',
    currentVersion: '1.2.0',
    stageExtractor: fakeExtractor,
    prepareReplacement: async () => makeReplacement(12).replacement,
  });
  assert.equal(second.upgraded, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: leaves existing in-use version directories intact (immutable)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const first = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  // Re-staging the same version leaves existing candidate intact
  const again = await stageReleaseFromNpm(dir, '1.2.3', { stageExtractor: fakeExtractor });
  assert.equal(again.releaseDir, first.releaseDir);
  assert.ok(await fs.access(first.entryPath).then(() => true, () => false), 'existing candidate entry must remain intact');
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. Regression guards: no false commit failures, unified gate release, forced reinstall, strict cache checks
// ---------------------------------------------------------------------------

test('performNodeUpgrade: failure in clearBlockedRelease before commit aborts without calling commit and releases drain gate', { timeout: 60_000 }, async () => {
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
          // Real filesystem fault: make update-blocked.json a directory so rm(force) fails with EISDIR
          await fs.mkdir(path.join(dir, 'update-blocked.json'), { recursive: true });
          return replacement;
        },
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      // Failure comes from pre-commit file cleanup rather than commit itself
      assert.match(msg, /commit failed/);
      assert.match(msg, /update-blocked\.json/, 'error should report the failing path');
      return true;
    },
  );
  assert.deepEqual(calls, ['abort:888'], 'pre-commit failure must abort without calling commit');
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0', 'current.json must be restored');
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released on failure');
  assert.deepEqual(log.shutdownPids, [], 'must not schedule shutdown');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: no fallible fs operations after commit succeed so blocked cleanup never causes false failures', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const { replacement, calls } = makeReplacement(889);
  // Making blocked file a directory fails before commit; here a normal file cleanup completes before commit.
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
  assert.equal(await readBlockedRelease(dir), null, 'blocked record should be cleared before commit');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: corrupt current.json throws explicitly and never triggers draining or fakes success', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  // Reading current.json before setDraining exposes corruption upfront
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
    /current\.json is corrupt/,
  );
  // Snapshot read occurs before setDraining, so draining must never start
  assert.equal(log.draining.length, 0, 'snapshot read precedes draining; must not enter draining state');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: always releases drain gate in finally even if getActiveExecCount throws', { timeout: 60_000 }, async () => {
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
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released even when callback throws');
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: surfaces both prepare failure and blocked-write failure together', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  await assert.rejects(
    () =>
      performNodeUpgrade(dir, {
        targetVersion: '1.6.0',
        currentVersion: '1.0.0',
        stageExtractor: fakeExtractor,
        prepareReplacement: async () => {
          // Make update-blocked.json a directory so writeBlockedRelease fails with a real EISDIR fault
          await fs.mkdir(path.join(dir, 'update-blocked.json'), { recursive: true });
          throw new Error('replacement daemon register failed');
        },
        ...makeHooks(log),
      }),
    (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      assert.match(msg, /replacement daemon register failed/);
      assert.match(msg, /write blocked record failed/, 'writeBlockedRelease failure must not be swallowed');
      return true;
    },
  );
  assert.deepEqual(log.draining, [true, false]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm: force bypasses cache and creates a new candidate while preserving the previous one', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const first = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: fakeExtractor });
  let extractorRuns = 0;
  const countingExtractor: typeof fakeExtractor = async (stagingDir, version) => {
    extractorRuns += 1;
    return fakeExtractor(stagingDir, version);
  };
  // Without force: reuses cache without reinstalling
  const cached = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: countingExtractor });
  assert.equal(cached.releaseDir, first.releaseDir);
  assert.equal(extractorRuns, 0);
  // With force: installs into a new candidate dir without deleting the old one
  const forced = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: countingExtractor, force: true });
  assert.equal(extractorRuns, 1);
  assert.notEqual(forced.releaseDir, first.releaseDir);
  assert.ok(forced.releaseDir.startsWith(path.join(dir, 'releases', '2.0.0') + path.sep));
  assert.ok(await fs.access(first.entryPath).then(() => true, () => false), 'previous candidate must remain intact');
  assert.ok(await fs.access(forced.entryPath).then(() => true, () => false));
  // .complete now points to the new candidate
  const marker = JSON.parse(await fs.readFile(path.join(dir, 'releases', '2.0.0', '.complete'), 'utf8'));
  assert.equal(marker.candidateDir, forced.releaseDir);
  // Subsequent non-forced call reuses the new candidate
  const again = await stageReleaseFromNpm(dir, '2.0.0', { stageExtractor: countingExtractor });
  assert.equal(again.releaseDir, forced.releaseDir);
  assert.equal(extractorRuns, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: propagates force to staging so same-version upgrade reinstalls', { timeout: 60_000 }, async () => {
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
  assert.equal(result.upgraded, true, 'forced same-version upgrade should reinstall and upgrade');
  assert.equal(extractorRuns, 1, 'force must bypass .complete cache');
  assert.notEqual(result.targetVersion, first.releaseDir);
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.notEqual(current?.entryPath, first.entryPath, 'current.json should point to new candidate entry');
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm: rejects .complete paths escaping version or candidate dir without deleting old candidate', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const staged = await stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor });
  const completePath = path.join(dir, 'releases', '3.0.0', '.complete');
  // a) entryPath points outside the version directory
  const outside = JSON.parse(await fs.readFile(completePath, 'utf8'));
  await fs.writeFile(completePath, JSON.stringify({ ...outside, entryPath: '/etc/passwd' }), 'utf8');
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /entryPath lies outside immutable release dir/);
  // b) candidateDir points outside the version directory
  await fs.writeFile(completePath, JSON.stringify({ ...outside, candidateDir: path.join(dir, 'elsewhere') }), 'utf8');
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /candidateDir lies outside immutable release dir/);
  // c) entryPath is inside the version directory but outside candidateDir
  await fs.writeFile(
    completePath,
    JSON.stringify({ ...outside, entryPath: path.join(dir, 'releases', '3.0.0', 'other', 'cli.js') }),
    'utf8',
  );
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /entryPath lies outside immutable release dir/);
  // d) Missing entry file (stale cache) -> reject explicitly without rebuilding or deleting candidate
  await fs.writeFile(completePath, JSON.stringify(outside), 'utf8');
  await fs.rm(staged.entryPath);
  await assert.rejects(() => stageReleaseFromNpm(dir, '3.0.0', { stageExtractor: fakeExtractor }), /missing entry file/);
  // Old candidate directory remains intact
  assert.ok(await fs.access(path.dirname(staged.entryPath)).then(() => true, () => false));
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: UpgradeCommitUnconfirmedError skips abort/rollback/blocked and leaves current and drain gate active', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const oldCurrent = { version: '1.0.0', entryPath: '/old/dist/cli.js', updatedAt: '2026-01-01T00:00:00.000Z' };
  await writeCurrentRelease(dir, oldCurrent);
  const log: UpgradeLog = { draining: [], execCount: { value: 0 }, shutdownPids: [] };
  const unconfirmed = new UpgradeCommitUnconfirmedError('activate ACK timeout (candidate may already be committed on Hub)');
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
      assert.match(msg, /replacement was activated, but confirmation was unconfirmed/);
      assert.doesNotMatch(msg, /rollback to 1\.0\.0|rolled back/);
      assert.equal(err.cause, unconfirmed, 'original unconfirmed error should be preserved as cause');
      return true;
    },
  );
  assert.deepEqual(calls, ['commit:990'], 'must not invoke abort');
  // New current.json keeps pointing to target version without rollback
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '2.5.0');
  // Must not record failure in update-blocked.json
  assert.equal(await readBlockedRelease(dir), null);
  // Drain gate stays active while old host exits and candidate may take over
  assert.deepEqual(log.draining, [true]);
  // Old host shutdown already scheduled
  assert.deepEqual(log.shutdownPids, [990]);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: ordinary commit error still performs full rollback (contrast with unconfirmed branch)', { timeout: 60_000 }, async () => {
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
    /commit failed and rolled back to 1\.0\.0/,
  );
  assert.deepEqual(calls, ['commit:991', 'abort:991']);
  assert.equal((await readCurrentRelease(dir))?.version, '1.0.0');
  assert.equal((await readBlockedRelease(dir))?.version, '2.5.0');
  assert.deepEqual(log.draining, [true, false]);
  assert.deepEqual(log.shutdownPids, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('stageReleaseFromNpm: npm cache revalidation checks package.json versions of both @helm/node and @helm/cli', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  // Construct an npm-origin .complete cache where @helm/cli package.json has a mismatched version
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
  // @helm/cli version mismatch with target -> reuse rejected
  await assert.rejects(
    () => stageReleaseFromNpm(dir, '4.0.0', { stageExtractor: fakeExtractor }),
    /installed package name\/version mismatch.*@helm\/cli/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runNpm timeout process-group kill: npm lifecycle descendants must not remain orphaned
// ---------------------------------------------------------------------------

test('runNpm timeout kills entire process group so descendant processes cannot keep writing to staging', { timeout: 60_000 }, async (t) => {
  if (process.platform === 'win32') return; // POSIX process group semantics; win32 relies on taskkill /T
  const dir = await tempDir('npm-group-kill-');
  const heartbeat = path.join(dir, 'beat.txt');
  const grandPidFile = path.join(dir, 'grand.pid');
  const runnerScript = path.join(dir, 'runner.cjs');
  // runner (direct child of npm run) spawns a descendant writing a heartbeat file,
  // simulating an install script attempting to write to a cleaned staging dir after timeout.
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
        // already dead
      }
    }
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  t.after(async () => {
    await cleanup();
  });

  const { runNpm } = await import('../src/daemon/upgrader.js');
  const npmPromise = runNpm(['run', 'hold'], dir, 3_000);
  // Wait until npm spawns runner and descendant writes its PID file before timing out
  const deadline = Date.now() + 2_500;
  for (;;) {
    const exists = await fs.readFile(grandPidFile, 'utf8').then(
      () => true,
      () => false,
    );
    if (exists) break;
    if (Date.now() > deadline) throw new Error('npm run did not spawn descendant process before deadline (fixture failed)');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await assert.rejects(() => npmPromise, /timed out/);

  const rawPid = await fs.readFile(grandPidFile, 'utf8');
  const grandPid = Number(rawPid.trim());
  assert.ok(Number.isInteger(grandPid) && grandPid > 0, `invalid descendant pid: ${rawPid}`);
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Process-group kill is synchronous, though short polling absorbs scheduling lag
  let alive = isAlive(grandPid);
  for (let i = 0; i < 20 && alive; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    alive = isAlive(grandPid);
  }
  assert.equal(alive, false, 'descendant process must be killed with its process group on timeout without leaving orphans');
});
