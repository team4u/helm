/**
 * CLI-layer tests: argument parsing discipline (unknown commands/options, per-command option
 * allowlists, duplicates, missing values), usage output, `--json` envelopes, and end-to-end
 * command dispatch (install via tarball → start → status → update → stop) against real processes
 * with the port-shaped fake update core (real engine staging, fixture registry/npm).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helm/test-kit/node';
import { readCurrentRelease } from '@helm/update';
import { parseLauncherArgs, runLauncherCli, USAGE } from '../src/cli.js';
import { defaultUpdateCore } from '../src/update-core.js';
import { readPidRecord } from '../src/records.js';
import {
  captureIo,
  cleanupPid,
  createFakeCore,
  createFakeRegistry,
  fixtureTarballPacker,
  freePort,
  getJson,
  packPayloadTarball,
  waitUntilDead,
  writeFakePayload,
} from './fixtures.js';

const PKG = '@fake/hub-payload';

function ioWith(root: string) {
  const captured = captureIo(sanitizedHostEnv({ HELM_HUB_INSTALL_ROOT: root, HELM_PAYLOAD_PACKAGE: PKG }));
  return captured;
}

test('argument parsing accepts valid commands and rejects malformed input', { timeout: 60_000 }, () => {
  const parsed = parseLauncherArgs(['update', '--version', '1.2.3', '--tarball', '/tmp/x.tgz', '--force', '--json']);
  assert.equal(parsed.command, 'update');
  assert.equal(parsed.flags.version, '1.2.3');
  assert.equal(parsed.flags.tarball, '/tmp/x.tgz');
  assert.equal(parsed.flags.force, true);
  assert.equal(parsed.flags.json, true);

  assert.equal(parseLauncherArgs(['status', '--json']).flags.json, true);
  assert.equal(parseLauncherArgs(['--help']).flags.help, true);
  assert.equal(parseLauncherArgs(['start', '--port=4567']).flags.port, 4567);

  assert.throws(() => parseLauncherArgs([]), /missing command/);
  assert.throws(() => parseLauncherArgs(['bogus']), /unknown command/);
  assert.throws(() => parseLauncherArgs(['status', '--wat']), /unknown option/);
  assert.throws(() => parseLauncherArgs(['status', '--force']), /not valid for command/);
  assert.throws(() => parseLauncherArgs(['start', '--start']), /not valid for command/);
  assert.throws(() => parseLauncherArgs(['start', '--port']), /expects a value/);
  assert.throws(() => parseLauncherArgs(['start', '--port', 'abc']), /expects a positive integer/);
  assert.throws(() => parseLauncherArgs(['start', '--port', '1', '--port', '2']), /duplicate option/);
  assert.throws(() => parseLauncherArgs(['status', 'extra']), /unexpected extra arguments/);
  assert.throws(() => parseLauncherArgs(['status', '--json=1']), /does not take a value/);

  // run: the supervised lifecycle takes its own option set.
  const runParsed = parseLauncherArgs(['run', '--interval-ms', '5000', '--tag', 'beta', '--port', '3299']);
  assert.equal(runParsed.command, 'run');
  assert.equal(runParsed.flags.intervalMs, 5000);
  assert.equal(runParsed.flags.tag, 'beta');
  assert.equal(runParsed.flags.port, 3299);
  assert.throws(() => parseLauncherArgs(['run', '--force']), /not valid for command/);
  assert.throws(() => parseLauncherArgs(['run', '--version', '1.2.3']), /not valid for command/);
  assert.throws(() => parseLauncherArgs(['run', '--interval-ms', 'abc']), /expects a positive integer/);
  assert.throws(() => parseLauncherArgs(['check', '--interval-ms', '100']), /not valid for command/);
  assert.equal(parseLauncherArgs(['update', '--tag', 'beta']).flags.tag, 'beta');
});

test('usage prints for --help and missing commands carry the usage text', { timeout: 60_000 }, async () => {
  const help = ioWith('/nonexistent-root');
  assert.equal(await runLauncherCli(['--help'], help.io), 0);
  assert.ok(help.outText().includes('helm-hub-launcher'));
  assert.ok(USAGE.includes('--health-timeout'));
  assert.ok(USAGE.includes('Helm Hub: '));
  assert.ok(USAGE.includes('lifecycle.lock'));

  const missing = ioWith('/nonexistent-root');
  assert.equal(await runLauncherCli([], missing.io), 1);
  assert.match(missing.errText(), /missing command/);
  assert.match(missing.errText(), /Usage: helm-hub-launcher/);
});

test('the production update core is really bound to the shared engine', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-realcore-');
  const core = defaultUpdateCore();
  // Real engine staging semantics behind the port: immutable `<uuid>` candidate, engine-format
  // `.complete` marker, entries resolved inside the release.
  const staged = await core.stageRelease(root, '1.0.0', async (stagingDir) => {
    writeFileSync(path.join(stagingDir, 'start.mjs'), '#!/usr/bin/env node\n');
    return { entryPath: 'start.mjs' };
  });
  assert.ok(existsSync(staged.entries['entryPath']!));
  assert.match(path.relative(root, staged.releaseDir), /^releases[/\\]1\.0\.0[/\\][0-9a-f-]{36}$/);
  const marker = JSON.parse(readFileSync(path.join(root, 'releases', '1.0.0', '.complete'), 'utf8')) as {
    origin: string;
    candidateDir: string;
  };
  assert.equal(marker.origin, 'extractor');
  assert.equal(marker.candidateDir, staged.releaseDir);
});

test('check with a fake core reports current/latest as JSON and text', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-clicheck-');
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest: '2.0.0', payloads });
  const json = ioWith(root);
  assert.equal(await runLauncherCli(['check', '--json'], json.io, { core }), 0);
  const payload = JSON.parse(json.outText()) as { currentVersion: string | null; latestVersion: string; updateAvailable: boolean };
  assert.equal(payload.currentVersion, null);
  assert.equal(payload.latestVersion, '2.0.0');
  assert.equal(payload.updateAvailable, true);

  const text = ioWith(root);
  assert.equal(await runLauncherCli(['check'], text.io, { core }), 0);
  assert.match(text.outText(), /latest:\s+2\.0\.0/);
  assert.match(text.outText(), /update:\s+available/);
});

test('run rejects --json with an explicit usage error (progress lines are human-readable)', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-runjson-');
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest: '1.0.0', payloads });
  const captured = ioWith(root);
  assert.equal(await runLauncherCli(['run', '--json'], captured.io, { core }), 1);
  const envelope = JSON.parse(captured.errText()) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'json_not_supported_for_run');
});

test('start without an installed release produces a JSON error envelope', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-clistart-');
  const captured = ioWith(root);
  const code = await runLauncherCli(['start', '--json'], captured.io);
  assert.equal(code, 1);
  const envelope = JSON.parse(captured.errText()) as { error: { code: string } };
  assert.equal(envelope.error.code, 'no_release_installed');
});

test('end-to-end CLI: tarball install, start, status, update, stop', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-clie2e-');
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest: '1.1.0', payloads });
  const port = await freePort();

  await writeFakePayload({ dir: path.join(root, 'payload-1.0.0'), pkgName: PKG, version: '1.0.0' });
  const tarballPath = await fixtureTarballPacker()(path.join(root, 'payload-1.0.0'));
  await writeFakePayload({ dir: path.join(root, 'payload-1.1.0'), pkgName: PKG, version: '1.1.0' });
  payloads.set('1.1.0', path.join(root, 'payload-1.1.0'));
  // An isolated data dir keeps the fixture heartbeat (activity gate evidence) inside the test tree.
  const dataDir = path.join(path.dirname(root), `${path.basename(root)}-user-data`);

  const install = ioWith(root);
  assert.equal(await runLauncherCli(['update', '--tarball', tarballPath, '--version', '1.0.0'], install.io, { core }), 0);
  assert.match(install.outText(), /updated: \(none\) -> 1\.0\.0/);

  const start = ioWith(root);
  assert.equal(await runLauncherCli(['start', '--port', String(port), '--data-dir', dataDir], start.io, { core }), 0);
  assert.match(start.outText(), /hub 1\.0\.0 running: pid \d+/);
  const pidRecord = await readPidRecord(root);
  assert.ok(pidRecord !== null);
  t.after(() => cleanupPid(pidRecord.pid));
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.0.0' });

  const status = ioWith(root);
  assert.equal(await runLauncherCli(['status', '--json'], status.io, { core }), 0);
  const statusPayload = JSON.parse(status.outText()) as {
    current: { version: string };
    running: { pid: number; version: string; alive: boolean; healthy: boolean };
    launch: { port: number };
  };
  assert.equal(statusPayload.current.version, '1.0.0');
  assert.equal(statusPayload.running.alive, true);
  assert.equal(statusPayload.running.healthy, true);
  assert.equal(statusPayload.launch.port, port);

  const update = ioWith(root);
  assert.equal(await runLauncherCli(['update'], update.io, { core }), 0);
  assert.match(update.outText(), /1\.0\.0 -> 1\.1\.0/);
  assert.match(update.outText(), /hub restarted/);
  const updatedPid = await readPidRecord(root);
  assert.ok(updatedPid !== null);
  t.after(() => cleanupPid(updatedPid.pid));
  await waitUntilDead(pidRecord.pid);
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.1.0' });

  const stop = ioWith(root);
  assert.equal(await runLauncherCli(['stop', '--json'], stop.io, { core }), 0);
  const stopPayload = JSON.parse(stop.outText()) as {
    ok: boolean;
    wasRunning: boolean;
    pid?: number;
    escalated: boolean;
    cleanedStalePid: boolean;
  };
  assert.equal(stopPayload.ok, true);
  assert.equal(stopPayload.wasRunning, true);
  assert.equal(stopPayload.escalated, false);
  assert.equal(stopPayload.cleanedStalePid, false);
  assert.equal(typeof stopPayload.pid, 'number');
  await waitUntilDead(updatedPid.pid);
  assert.equal(await readPidRecord(root), null);
});

test('CLI check routes the registry through the fetchFn seam against the real engine core', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-clireal-');
  const registry = await createFakeRegistry(PKG, '9.9.9');
  const captured = ioWith(root);
  assert.equal(await runLauncherCli(['check', '--json', '--registry', registry.registryUrl], captured.io, { fetchFn: registry.fetchImpl }), 0);
  const payload = JSON.parse(captured.outText()) as { currentVersion: string | null; latestVersion: string };
  assert.equal(payload.currentVersion, null);
  assert.equal(payload.latestVersion, '9.9.9');
  assert.equal(await readCurrentRelease(root), null); // no state touched
});
