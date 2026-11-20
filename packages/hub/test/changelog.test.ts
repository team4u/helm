/**
 * Installed-version changelog coverage: strict section parsing, `from` slicing (matched,
 * unmatched-older boundary, newest-first order), the `/api/hub-update/changelog` route contract
 * (absent payload, invalid from, full and sliced responses, status surface fields), and the
 * last-run version tracking behind the Web upgrade notice (first boot, same version, upgrade,
 * corrupt record).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { useTempDir } from '@helmx/test-kit/node';
import { loadHubChangelog, parseChangelog, sliceChangelog } from '../src/changelog.js';
import { readLastRunVersion, recordRunVersion } from '../src/run-version.js';
import { createHubUpdateRoutes } from '../src/updater-routes.js';
import { emptyCounts, makeApply } from './updater-helpers.js';

const SAMPLE = `# Changelog

## v0.2.0 (2026-11-22)

- feat(web): changelog 界面
- fix(hub): 通道停止

## v0.1.2 (2026-11-21)

- feat(hub): 静默备包

## v0.1.1 (2026-11-19)

- ci(release): Trusted Publishing
`;

test('parseChangelog extracts sections newest-first with strict headings', { timeout: 60_000 }, () => {
  const sections = parseChangelog(SAMPLE);
  assert.deepEqual(
    sections.map((section) => section.version),
    ['0.2.0', '0.1.2', '0.1.1'],
  );
  assert.equal(sections[0]!.date, '2026-11-22');
  assert.match(sections[0]!.markdown, /changelog 界面/);
  assert.equal(sections[2]!.markdown, '- ci(release): Trusted Publishing');
  assert.equal(parseChangelog('# Changelog\n\nnothing here\n').length, 0, 'unparsable file yields zero sections');
});

test('sliceChangelog keeps versions strictly newer than from, flagging unmatched origins', { timeout: 60_000 }, () => {
  const sections = parseChangelog(SAMPLE);
  const matched = sliceChangelog(sections, '0.1.1');
  assert.deepEqual(matched.sections.map((s) => s.version), ['0.2.0', '0.1.2']);
  assert.equal(matched.fromMatched, true);

  const boundary = sliceChangelog(sections, '0.1.2');
  assert.deepEqual(boundary.sections.map((s) => s.version), ['0.2.0']);

  const older = sliceChangelog(sections, '0.1.0');
  assert.deepEqual(older.sections.map((s) => s.version), ['0.2.0', '0.1.2', '0.1.1']);
  assert.equal(older.fromMatched, false, 'origin predating the changelog is flagged, not guessed');

  const full = sliceChangelog(sections);
  assert.equal(full.sections.length, 3);
  assert.equal(full.fromMatched, true);
});

test('loadHubChangelog: env path, disable values, and honest unavailable states', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-changelog-load-');
  const file = join(root, 'CHANGELOG.md');
  await writeFile(file, SAMPLE, 'utf8');
  const loaded = await loadHubChangelog({ HELMX_HUB_CHANGELOG: file }, '/nowhere');
  assert.equal(loaded.available, true);
  assert.equal(loaded.sections.length, 3);
  assert.equal(loaded.sourcePath, file);

  assert.equal((await loadHubChangelog({ HELMX_HUB_CHANGELOG: 'false' }, '/nowhere')).available, false);
  assert.equal((await loadHubChangelog({ HELMX_HUB_CHANGELOG: '' }, '/nowhere')).available, false);
  assert.equal((await loadHubChangelog({ HELMX_HUB_CHANGELOG: join(root, 'missing.md') }, '/nowhere')).available, false);

  const unparsable = join(root, 'bad.md');
  await writeFile(unparsable, '# Changelog\n\nno sections\n', 'utf8');
  assert.equal((await loadHubChangelog({ HELMX_HUB_CHANGELOG: unparsable }, '/nowhere')).available, false);
});

function makeRoutes(options?: { changelog?: Parameters<typeof createHubUpdateRoutes>[0]['changelog']; upgradeFrom?: string | null }) {
  return createHubUpdateRoutes({
    updater: null,
    kernel: { activitySnapshot: emptyCounts, dataDir: '/tmp/unused' },
    root: null,
    changelog: options?.changelog ?? { available: true, sourcePath: '/tmp/x', sections: parseChangelog(SAMPLE), version: '0.2.0' },
    upgrade: { upgradedFrom: options?.upgradeFrom ?? null },
  });
}

test('changelog route: full, sliced, invalid-from, and absent shapes', { timeout: 60_000 }, async () => {
  const routes = makeRoutes();
  const full = await routes(new Request('http://x/api/hub-update/changelog'));
  assert.ok(full !== undefined && full.status === 200);
  const fullBody = (await full.json()) as { available: boolean; version: string; sections: { version: string }[] };
  assert.equal(fullBody.available, true);
  assert.equal(fullBody.version, '0.2.0');
  assert.equal(fullBody.sections.length, 3);

  const sliced = await routes(new Request('http://x/api/hub-update/changelog?from=0.1.1'));
  assert.ok(sliced !== undefined);
  const slicedBody = (await sliced.json()) as { from: string; fromMatched: boolean; sections: { version: string }[] };
  assert.equal(slicedBody.from, '0.1.1');
  assert.equal(slicedBody.fromMatched, true);
  assert.deepEqual(slicedBody.sections.map((s) => s.version), ['0.2.0', '0.1.2']);

  const invalid = await routes(new Request('http://x/api/hub-update/changelog?from=v1.0.0'));
  assert.ok(invalid !== undefined && invalid.status === 400);
  assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, 'invalid_from');

  const absent = makeRoutes({ changelog: { available: false, sourcePath: null, sections: [], version: '0.2.0' } });
  const absentResponse = await absent(new Request('http://x/api/hub-update/changelog'));
  assert.ok(absentResponse !== undefined);
  const absentBody = (await absentResponse.json()) as { available: boolean; version: string };
  assert.equal(absentBody.available, false);
  assert.equal(absentBody.version, '0.2.0');

  const wrongMethod = await routes(new Request('http://x/api/hub-update/changelog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.ok(wrongMethod !== undefined && wrongMethod.status === 405);
  const untouched = await routes(new Request('http://x/api/other'));
  assert.equal(untouched, undefined, 'other paths fall through');
});

test('status surface carries upgradedFrom and changelogAvailable for the Web notice', { timeout: 60_000 }, async () => {
  const upgraded = makeRoutes({ upgradeFrom: '0.1.1' });
  const status = await upgraded(new Request('http://x/api/hub-update/status'));
  assert.ok(status !== undefined);
  const body = (await status.json()) as { upgradedFrom: string | null; changelogAvailable: boolean; currentVersion: string | null };
  assert.equal(body.upgradedFrom, '0.1.1');
  assert.equal(body.changelogAvailable, true);
  assert.equal(body.currentVersion, '0.2.0', 'current version falls back to the hub package version when the updater is inactive');
});

test('recordRunVersion reports upgrades once and rewrites honestly', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-run-version-');
  const dataDir = join(root, 'data');

  const first = await recordRunVersion(dataDir, '0.1.1');
  assert.equal(first.upgradedFrom, null, 'first boot has no previous version to claim');
  const same = await recordRunVersion(dataDir, '0.1.1');
  assert.equal(same.upgradedFrom, null);
  const upgraded = await recordRunVersion(dataDir, '0.1.2');
  assert.equal(upgraded.upgradedFrom, '0.1.1');
  assert.equal(await readLastRunVersion(dataDir), '0.1.2');

  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'hub-version.json'), '{corrupt', 'utf8');
  assert.equal(await readLastRunVersion(dataDir), null, 'corrupt record proves nothing');
  const afterCorrupt = await recordRunVersion(dataDir, '0.1.3');
  assert.equal(afterCorrupt.upgradedFrom, null, 'corrupt previous record claims no upgrade, just rewrites');
});
