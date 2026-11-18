/**
 * CLI-layer tests: argument parsing discipline (unknown commands/options, per-command option
 * allowlists, duplicates, missing values), usage output, `--json` envelopes, and end-to-end
 * command dispatch (install via tarball → start → status → stop) against real processes with the
 * fake update core.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, sanitizedHostEnv } from '@helm/test-kit/node';
import { parseLauncherArgs, runLauncherCli, USAGE } from '../src/cli.js';
import { readPidRecord } from '../src/records.js';
import {
  captureIo,
  cleanupPid,
  createFakeCore,
  freePort,
  getJson,
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
});

test('usage prints for --help and missing commands carry the usage text', { timeout: 60_000 }, async () => {
  const help = ioWith('/nonexistent-root');
  assert.equal(await runLauncherCli(['--help'], help.io), 0);
  assert.ok(help.outText().includes('helm-hub-launcher'));
  assert.ok(USAGE.includes('--health-timeout'));

  const missing = ioWith('/nonexistent-root');
  assert.equal(await runLauncherCli([], missing.io), 1);
  assert.match(missing.errText(), /missing command/);
  assert.match(missing.errText(), /Usage: helm-hub-launcher/);
});

test('check without a bound update core fails with an explicit envelope', { timeout: 60_000 }, async () => {
  const root = useTempDir({ after: () => {} }, 'helm-launcher-clicore-');
  const captured = ioWith(root);
  const code = await runLauncherCli(['check', '--json'], captured.io, null);
  assert.equal(code, 1);
  const envelope = JSON.parse(captured.errText()) as { ok: boolean; error: { code: string; message: string } };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'update_core_unavailable');
  assert.match(envelope.error.message, /@helm\/update/);
});

test('check with a fake core reports current/latest as JSON and text', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-clicheck-');
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest: '2.0.0', payloads });
  const json = ioWith(root);
  assert.equal(await runLauncherCli(['check', '--json'], json.io, core), 0);
  const payload = JSON.parse(json.outText()) as { currentVersion: string | null; latestVersion: string; updateAvailable: boolean };
  assert.equal(payload.currentVersion, null);
  assert.equal(payload.latestVersion, '2.0.0');
  assert.equal(payload.updateAvailable, true);

  const text = ioWith(root);
  assert.equal(await runLauncherCli(['check'], text.io, core), 0);
  assert.match(text.outText(), /latest:\s+2\.0\.0/);
  assert.match(text.outText(), /update:\s+available/);
});

test('start without an installed release produces a JSON error envelope', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-clistart-');
  const captured = ioWith(root);
  const code = await runLauncherCli(['start', '--json'], captured.io, null);
  assert.equal(code, 1);
  const envelope = JSON.parse(captured.errText()) as { error: { code: string } };
  assert.equal(envelope.error.code, 'no_release_installed');
});

test('end-to-end CLI: tarball install, start, status, update, stop', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helm-launcher-clie2e-');
  const payloads = new Map<string, string>();
  const core = createFakeCore({ pkgName: PKG, latest: '1.1.0', payloads });
  const port = await freePort();

  const payloadDir = await writeFakePayload({ dir: path.join(root, 'payload-1.0.0'), pkgName: PKG, version: '1.0.0' });
  const tarballPath = path.join(root, 'payload.tgz');
  writeFileSync(tarballPath, 'fake tarball\n');
  core.registerLocalTarball(tarballPath, payloadDir);
  await writeFakePayload({ dir: path.join(root, 'payload-1.1.0'), pkgName: PKG, version: '1.1.0' });
  payloads.set('1.1.0', path.join(root, 'payload-1.1.0'));

  const install = ioWith(root);
  assert.equal(await runLauncherCli(['update', '--tarball', tarballPath, '--version', '1.0.0'], install.io, core), 0);
  assert.match(install.outText(), /updated: \(none\) -> 1\.0\.0/);

  const start = ioWith(root);
  assert.equal(await runLauncherCli(['start', '--port', String(port)], start.io, core), 0);
  assert.match(start.outText(), /hub 1\.0\.0 running: pid \d+/);
  const pidRecord = await readPidRecord(root);
  assert.ok(pidRecord !== null);
  t.after(() => cleanupPid(pidRecord.pid));
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.0.0' });

  const status = ioWith(root);
  assert.equal(await runLauncherCli(['status', '--json'], status.io, core), 0);
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
  assert.equal(await runLauncherCli(['update'], update.io, core), 0);
  assert.match(update.outText(), /1\.0\.0 -> 1\.1\.0/);
  assert.match(update.outText(), /hub restarted/);
  const updatedPid = await readPidRecord(root);
  assert.ok(updatedPid !== null);
  t.after(() => cleanupPid(updatedPid.pid));
  await waitUntilDead(pidRecord.pid);
  assert.deepEqual(await getJson(port, '/__version'), { version: '1.1.0' });

  const stop = ioWith(root);
  assert.equal(await runLauncherCli(['stop', '--json'], stop.io, core), 0);
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
