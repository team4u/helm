/**
 * Node-side regressions for the `@helm/node` self-upgrade adapter over the shared
 * update engine re-exported from `@helm/env-io`.
 *
 * Everything here locks Node external behavior only: own version resolution
 * (`getNodeVersion` / `resolveEffectiveNodeVersion`), the launcher-compatible flat
 * `current.json` disk contract, dual-package name wiring (`HELM_NPM_PACKAGE` /
 * `HELM_NPM_CLI_PACKAGE`), staged-entry adaptation (`StagedNodeRelease`), delegation
 * of engine hooks through `performNodeUpgrade`, verbatim rollback of the flat record
 * on commit failure, and error-class identity with the shared engine module.
 *
 * The generic engine mechanics (semver wrappers, registry allowlist, staging and
 * `.complete` cache revalidation, drain gate, cooldown, rollback ordering,
 * cross-process lock, npm process-group kill) are covered by
 * `packages/env-io/test/update/update-engine.test.ts` and deliberately not duplicated here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { makeTempDir as tempDir } from '@helm/test-kit/node';
import { UpgradeRejectedError } from '@helm/env-io';
import {
  getNodeVersion,
  resolveEffectiveNodeVersion,
  checkNodeUpgrade,
  stageReleaseFromNpm,
  performNodeUpgrade,
  readCurrentRelease,
  writeCurrentRelease,
  deleteCurrentRelease,
  readBlockedRelease,
  type StagedNodeRelease,
  type PreparedNodeReplacement,
} from '../src/daemon/upgrader.js';

const NODE_PACKAGE_NAME = '@helm/node';
const CLI_PACKAGE_NAME = '@helm/cli';

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
    JSON.stringify({ name: NODE_PACKAGE_NAME, version: _version }),
    'utf8',
  );
  return { entryPath: path.join('node_modules', '@helm', 'node', 'dist', 'cli.js'), cliBinDir: 'node_modules/.bin' };
}

function makeRegistryFetch(latest: string) {
  const urls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    urls.push(url);
    return new Response(JSON.stringify({ version: latest }), { status: 200 });
  };
  return { fetchFn, urls };
}

const offlineFetch: typeof fetch = async () => {
  throw new Error('network must not be touched by this code path');
};

/** Hand-build an npm-origin `.complete` cache (no network, no npm) for revalidation through the Node layout. */
async function makeNpmReleaseCache(dir: string, version: string, nodePkg = NODE_PACKAGE_NAME, cliPkg = CLI_PACKAGE_NAME) {
  const versionRoot = path.join(dir, 'releases', version);
  const candidateDir = path.join(versionRoot, '11111111-2222-3333-4444-555555555555');
  const nodePkgDir = path.join(candidateDir, 'node_modules', ...nodePkg.split('/'));
  const cliPkgDir = path.join(candidateDir, 'node_modules', ...cliPkg.split('/'));
  await fs.mkdir(path.join(nodePkgDir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(cliPkgDir, 'dist'), { recursive: true });
  await fs.mkdir(path.join(candidateDir, 'node_modules', '.bin'), { recursive: true });
  await fs.writeFile(path.join(nodePkgDir, 'dist', 'cli.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(path.join(nodePkgDir, 'package.json'), JSON.stringify({ name: nodePkg, version }), 'utf8');
  await fs.writeFile(path.join(cliPkgDir, 'dist', 'index.js'), '#!/usr/bin/env node\n', 'utf8');
  await fs.writeFile(
    path.join(cliPkgDir, 'package.json'),
    JSON.stringify({ name: cliPkg, version, bin: { helm: './dist/index.js' } }),
    'utf8',
  );
  await fs.writeFile(
    path.join(versionRoot, '.complete'),
    JSON.stringify({
      version,
      candidateDir,
      entries: { entryPath: path.join(nodePkgDir, 'dist', 'cli.js'), cliBinDir: path.join(candidateDir, 'node_modules', '.bin') },
      completedAt: new Date().toISOString(),
      origin: 'npm',
    }),
    'utf8',
  );
  return { candidateDir, nodePkgDir, cliPkgDir };
}

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

// ---------------------------------------------------------------------------
// 1. Node version resolution
// ---------------------------------------------------------------------------

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
// 2. Flat current.json disk contract (launcher compatibility)
// ---------------------------------------------------------------------------

test('flat current.json: ENOENT returns null, atomic 0600 writes round-trip, optional cliBinDir stays absent, idempotent delete', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  assert.equal(await readCurrentRelease(dir), null);

  await writeCurrentRelease(dir, {
    version: '1.0.0',
    entryPath: '/a/dist/cli.js',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cliBinDir: '/a/node_modules/.bin',
  });
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.0.0');
  assert.equal(current?.entryPath, '/a/dist/cli.js');
  assert.equal(current?.cliBinDir, '/a/node_modules/.bin');
  // Windows lacks POSIX mode bits (NTFS uses ACLs), skip 0600 mode assertion.
  if (process.platform !== 'win32') assert.equal(rawFs.statSync(path.join(dir, 'current.json')).mode & 0o777, 0o600);

  // An already-installed launcher treats cliBinDir as optional; absent must stay absent on disk
  await writeCurrentRelease(dir, { version: '1.1.0', entryPath: '/b/dist/cli.js', updatedAt: '2026-01-02T00:00:00.000Z' });
  const bare = await readCurrentRelease(dir);
  assert.equal(bare?.cliBinDir, undefined);
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'current.json'), 'utf8')) as Record<string, unknown>;
  assert.ok(!('cliBinDir' in raw), 'absent cliBinDir must not be serialized as an explicit field');

  await deleteCurrentRelease(dir);
  assert.equal(await readCurrentRelease(dir), null);
  await deleteCurrentRelease(dir); // idempotent
  await fs.rm(dir, { recursive: true, force: true });
});

test('flat current.json: corrupt or incomplete records throw explicitly rather than returning null', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'current.json'), '{ not json', 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /corrupt/);
  await fs.writeFile(path.join(dir, 'current.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');
  await assert.rejects(() => readCurrentRelease(dir), /entryPath/);
  // Writes validate the same contract before anything reaches the launcher
  await assert.rejects(
    () => writeCurrentRelease(dir, { version: '', entryPath: 'x', updatedAt: 't' } as never),
    /version/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. Node adapter wiring over the shared update engine
// ---------------------------------------------------------------------------

test('checkNodeUpgrade: queries the @helm/node package latest and falls back to getNodeVersion', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const { fetchFn, urls } = makeRegistryFetch('1.2.0');
  const result = await checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn });
  assert.equal(result.latestVersion, '1.2.0');
  assert.equal(result.updateAvailable, true);
  assert.match(urls[0]!, /@helm%2Fnode\/latest|@helm\/node\/latest/);

  // Fall back to getNodeVersion when current.json is absent and currentVersion is omitted
  const dir2 = await tempDir('helm-node-upgrade-');
  const result2 = await checkNodeUpgrade(dir2, { fetchFn: makeRegistryFetch('0.0.1').fetchFn });
  assert.equal(result2.currentVersion, getNodeVersion());
  assert.equal(result2.updateAvailable, false);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(dir2, { recursive: true, force: true });
});

test('dual package names: HELM_NPM_PACKAGE / HELM_NPM_CLI_PACKAGE drive registry URL and staged layout', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const prevNodePkg = process.env.HELM_NPM_PACKAGE;
  const prevCliPkg = process.env.HELM_NPM_CLI_PACKAGE;
  process.env.HELM_NPM_PACKAGE = '@custom/node';
  process.env.HELM_NPM_CLI_PACKAGE = '@custom/cli';
  try {
    // Latest check queries the overridden node package
    const { fetchFn, urls } = makeRegistryFetch('2.0.0');
    const check = await checkNodeUpgrade(dir, { currentVersion: '1.0.0', fetchFn });
    assert.equal(check.latestVersion, '2.0.0');
    assert.match(urls[0]!, /@custom%2Fnode\/latest|@custom\/node\/latest/);

    // npm-origin cache revalidation validates both overridden packages through the staged layout
    // (default names would fail name/version revalidation against the overridden layout)
    await makeNpmReleaseCache(dir, '2.0.0', '@custom/node', '@custom/cli');
    const staged = await stageReleaseFromNpm(dir, '2.0.0', { fetchFn: offlineFetch });
    assert.ok(staged.entryPath.endsWith(path.join('node_modules', '@custom', 'node', 'dist', 'cli.js')), staged.entryPath);
    assert.ok(staged.cliBinDir.endsWith('node_modules/.bin'));
  } finally {
    if (prevNodePkg === undefined) delete process.env.HELM_NPM_PACKAGE;
    else process.env.HELM_NPM_PACKAGE = prevNodePkg;
    if (prevCliPkg === undefined) delete process.env.HELM_NPM_CLI_PACKAGE;
    else process.env.HELM_NPM_CLI_PACKAGE = prevCliPkg;
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: success path delegates engine hooks and adapts staged entries into the flat current.json', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
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
  // The Node adapter hands prepareReplacement a StagedNodeRelease with adapted entry fields
  assert.equal(releases[0]?.version, '1.2.3');
  assert.ok(await fs.access(releases[0]!.entryPath).then(() => true, () => false), 'adapted entryPath must exist on disk');
  assert.ok(releases[0]?.cliBinDir.endsWith('node_modules/.bin'));
  assert.ok(contexts[0]?.attemptId);
  assert.equal(contexts[0]?.previousVersion, '1.0.0');
  assert.equal(contexts[0]?.targetVersion, '1.2.3');
  // Delegated hooks fire through the shared engine
  assert.deepEqual(log.shutdownPids, [4242]);
  assert.deepEqual(log.draining, [true]); // keep draining after success (old host is exiting)
  // current.json stays in the flat launcher contract with adapted entry fields
  const current = await readCurrentRelease(dir);
  assert.equal(current?.version, '1.2.3');
  assert.equal(current?.entryPath, releases[0]?.entryPath);
  assert.equal(current?.cliBinDir, releases[0]?.cliBinDir);
  assert.equal(await readBlockedRelease(dir), null);
  await fs.rm(dir, { recursive: true, force: true });
});

test('performNodeUpgrade: commit failure restores the previous flat current.json record verbatim', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  const originalCurrent = {
    version: '1.0.0',
    entryPath: '/old/dist/cli.js',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cliBinDir: '/old/node_modules/.bin',
  };
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
  // The rollback crosses the Node codec: the launcher keeps reading the exact previous flat record
  assert.deepEqual(await readCurrentRelease(dir), originalCurrent, 'flat current.json must be restored verbatim');
  assert.equal((await readBlockedRelease(dir))?.version, '1.4.0');
  assert.deepEqual(log.draining, [true, false], 'drain gate must be released on failure');
  await fs.rm(dir, { recursive: true, force: true });
});

test('adapter rejects with the shared update-engine error classes (instanceof identity)', { timeout: 60_000 }, async () => {
  const dir = await tempDir('helm-node-upgrade-');
  // Downgrade guard through the Node wrapper throws the shared UpgradeRejectedError
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
  // Invalid target version through staging rejects with the same shared class
  await assert.rejects(() => stageReleaseFromNpm(dir, 'not-semver', { stageExtractor: fakeExtractor }), UpgradeRejectedError);
  await fs.rm(dir, { recursive: true, force: true });
});
