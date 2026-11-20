/**
 * In-Hub updater unit coverage: config resolution (managed/unmanaged/disabled/invalid), the
 * check→stage→ready cycle with a fake core, blocked-cooldown suppression, honest `lastError`
 * recording, and the `/api/hub-update` route gates (unmanaged, nothing staged, busy, force,
 * accepted switch via the spawn seam).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { useTempDir } from '@helmx/test-kit/node';
import { writeCurrentRelease } from '@helmx/env-io';
import { readUpdateReady, writeUpdateReady, clearUpdateReady, type HubUpdateCore } from '@helmx/env-io/hub-payload';
import { isBlockedVersionActive, resolveUpdaterConfig, startHubUpdater } from '../src/updater.js';
import { createHubUpdateRoutes } from '../src/updater-routes.js';

function fakeCore(spec: { latest: string; fail?: Error }): HubUpdateCore {
  return {
    async fetchLatestVersion() {
      if (spec.fail !== undefined) throw spec.fail;
      return spec.latest;
    },
    async downloadVerifiedTarball() {
      throw new Error('download not expected in fake core');
    },
    async runNpm() {},
    async stageRelease(_root: string, version: string, extractor: (dir: string) => Promise<Record<string, string>>) {
      const entries = await extractor('/fake/staging');
      return { version, releaseDir: `/fake/releases/${version}/uuid`, entries };
    },
  };
}

test('resolveUpdaterConfig: unmanaged without root, disabled at interval 0, invalid tag rejected', { timeout: 60_000 }, () => {
  assert.equal(resolveUpdaterConfig({ root: undefined, env: {} }), null, 'no install root -> inactive');
  assert.equal(resolveUpdaterConfig({ root: '/r', env: { HELMX_HUB_UPDATE_INTERVAL_MS: '0' } }), null, 'interval 0 -> disabled');
  const active = resolveUpdaterConfig({ root: '/r', env: { HELMX_NPM_REGISTRY: 'https://registry.example.com/' } });
  assert.ok(active !== null);
  assert.equal(active.channel, 'latest');
  assert.equal(active.intervalMs, 15 * 60_000);
  assert.equal(active.registryUrl, 'https://registry.example.com');
  const beta = resolveUpdaterConfig({ root: '/r', env: { HELMX_HUB_UPDATE_TAG: 'beta' } });
  assert.equal(beta?.channel, 'beta');
  assert.throws(() => resolveUpdaterConfig({ root: '/r', env: { HELMX_HUB_UPDATE_TAG: '1.2.3' } }), /dist-tag/);
  assert.throws(() => resolveUpdaterConfig({ root: '/r', env: { HELMX_HUB_UPDATE_INTERVAL_MS: '-5' } }), /INTERVAL/);
});

test('isBlockedVersionActive: cooldown applies to the blocked version only', { timeout: 60_000 }, () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const blocked = { version: '1.2.0', reason: 'r', at: '2026-11-20T11:50:00Z' };
  assert.equal(isBlockedVersionActive(blocked, '1.2.0', now), true, '10 minutes old, 30 minutes cooldown');
  assert.equal(isBlockedVersionActive(blocked, '1.3.0', now), false, 'other versions are unaffected');
  assert.equal(isBlockedVersionActive({ ...blocked, at: '2026-11-20T11:00:00Z' }, '1.2.0', now), false, 'cooldown elapsed');
  assert.equal(isBlockedVersionActive({ ...blocked, at: 'garbage' }, '1.2.0', now), true, 'unparseable timestamp keeps blocking');
  assert.equal(isBlockedVersionActive(null, '1.2.0', now), false);
});

test('updater cycle: stages a newer release and writes the ready record; same version is a no-op', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-hub-updater-');
  await writeCurrentRelease(root, { version: '1.0.0', updatedAt: new Date().toISOString(), entries: { entryPath: 'start.mjs' } });
  const core = fakeCore({ latest: '1.1.0' });
  const logs: string[] = [];
  const updater = startHubUpdater({
    root,
    pkgName: '@fake/hub',
    env: {},
    dataDir: join(root, 'data'),
    core,
    stage: async ({ version }) => ({ version, entryPath: 'start.mjs', releaseDir: `/fake/releases/${version}/uuid` }),
    intervalMs: 3_600_000, // far away: tests drive triggerCheck explicitly
    log: (line) => logs.push(line),
  });
  assert.ok(updater !== null);
  t.after(() => updater.stop());

  await updater.triggerCheck();
  const ready = await readUpdateReady(root);
  assert.ok(ready !== null, 'newer version was staged');
  assert.equal(ready.version, '1.1.0');
  assert.equal(ready.releaseDir, '/fake/releases/1.1.0/uuid');
  assert.equal(updater.status().readyVersion, '1.1.0');
  assert.equal(updater.status().lastError, null);

  // Same latest again: nothing restages, no error.
  await updater.triggerCheck();
  const still = await readUpdateReady(root);
  assert.equal(still?.version, '1.1.0');
  assert.match(logs.join('\n'), /staged 1\.1\.0/);
});

test('updater cycle: registry failures are recorded honestly and never throw out of the cycle', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-hub-updater-err-');
  await writeCurrentRelease(root, { version: '1.0.0', updatedAt: new Date().toISOString(), entries: { entryPath: 'start.mjs' } });
  const updater = startHubUpdater({
    root,
    pkgName: '@fake/hub',
    env: {},
    dataDir: join(root, 'data'),
    core: fakeCore({ latest: '9.9.9', fail: new Error('registry unreachable') }),
    intervalMs: 3_600_000,
  });
  assert.ok(updater !== null);
  t.after(() => updater.stop());
  await updater.triggerCheck(); // must not reject
  assert.match(updater.status().lastError ?? '', /registry unreachable/);
  assert.equal(updater.status().readyVersion, null);
  assert.equal(await readUpdateReady(root), null);
});

test('hub-update routes: unmanaged hubs and missing candidates refuse honestly', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-hub-routes-');
  const kernel = { activitySnapshot: () => emptyCounts(), dataDir: join(root, 'data') };

  const unmanaged = createHubUpdateRoutes({ updater: null, kernel, root: null, changelog: { available: false, sourcePath: null, sections: [], version: '1.0.0' }, upgrade: { upgradedFrom: null } });
  const status = await unmanaged(new Request('http://x/api/hub-update/status'));
  assert.ok(status !== undefined && status.status === 200);
  assert.equal((await status.json()).active, false);
  const applyUnmanaged = await unmanaged(makeApply());
  assert.ok(applyUnmanaged !== undefined && applyUnmanaged.status === 409);
  assert.equal((await applyUnmanaged.json()).error.code, 'hub_update_unmanaged');

  // Managed but nothing staged.
  const updater = startHubUpdater({ root, pkgName: '@fake/hub', env: {}, dataDir: kernel.dataDir, core: fakeCore({ latest: '1.0.0' }), intervalMs: 3_600_000 });
  assert.ok(updater !== null);
  t.after(() => updater.stop());
  const managed = createHubUpdateRoutes({ updater, kernel, root, changelog: { available: false, sourcePath: null, sections: [], version: '1.0.0' }, upgrade: { upgradedFrom: null } });
  const noCandidate = await managed(makeApply());
  assert.ok(noCandidate !== undefined && noCandidate.status === 409);
  assert.equal((await noCandidate.json()).error.code, 'no_staged_update');
});

test('hub-update apply: busy gate defers, force bypasses, accepted switch answers 202', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-hub-routes-apply-');
  await writeCurrentRelease(root, { version: '1.0.0', updatedAt: new Date().toISOString(), entries: { entryPath: 'start.mjs' } });
  await writeUpdateReady(root, { version: '1.1.0', entryPath: 'start.mjs', releaseDir: '/fake/releases/1.1.0/uuid', tag: 'latest', stagedAt: new Date().toISOString() });
  let counts = emptyCounts();
  const kernel = { activitySnapshot: () => counts, dataDir: join(root, 'data') };
  const updater = startHubUpdater({ root, pkgName: '@fake/hub', env: {}, dataDir: kernel.dataDir, core: fakeCore({ latest: '1.1.0' }), intervalMs: 3_600_000 });
  assert.ok(updater !== null);
  t.after(() => updater.stop());
  const spawned: unknown[] = [];
  const routes = createHubUpdateRoutes({
    updater,
    kernel,
    root,
    changelog: { available: false, sourcePath: null, sections: [], version: '1.0.0' },
    upgrade: { upgradedFrom: null },
    spawnHandoff: async (ready) => {
      spawned.push(ready.version);
      return { pid: 4242 };
    },
  });

  counts = { ...emptyCounts(), activeConversations: 2 };
  const busy = await routes(makeApply());
  assert.ok(busy !== undefined && busy.status === 409);
  const busyBody = (await busy.json()) as { error: { code: string; details: { counts: { activeConversations: number } } } };
  assert.equal(busyBody.error.code, 'hub_busy');
  assert.equal(busyBody.error.details.counts.activeConversations, 2);

  const forced = await routes(makeApply({ force: true }));
  assert.ok(forced !== undefined && forced.status === 202);
  const forcedBody = (await forced.json()) as { ok: boolean; switching: boolean; targetVersion: string; handoffPid: number };
  assert.equal(forcedBody.ok, true);
  assert.equal(forcedBody.switching, true);
  assert.equal(forcedBody.targetVersion, '1.1.0');
  assert.equal(forcedBody.handoffPid, 4242);
  assert.deepEqual(spawned, ['1.1.0']);

  counts = emptyCounts();
  const idle = await routes(makeApply());
  assert.ok(idle !== undefined && idle.status === 202, 'idle apply is accepted');
  assert.deepEqual(spawned, ['1.1.0', '1.1.0']);

  // Invalid bodies are boundary-rejected.
  const badForce = await routes(makeApply({ force: 'yes' }));
  assert.ok(badForce !== undefined && badForce.status === 400, 'invalid force value is boundary-rejected');
  const wrongPath = await routes(new Request('http://x/api/hub-update/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(wrongPath, undefined, 'unknown paths fall through to the core router');
  await clearUpdateReady(root);
});

import { emptyCounts, makeApply } from './updater-helpers.js';
