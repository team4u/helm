/**
 * Hub control channel (real process): `dist/main.js` boots with a temp data directory, writes
 * `hub-control.json`, answers verified `status` / `stop` requests over the UDS endpoint, and
 * exits cleanly with the record removed. This is the cross-platform `helmx stop` contract.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir, waitFor } from '@helmx/test-kit/node';
import { controlRequest, CONTROL_TIMEOUT_MS } from '@helmx/env-io';
import { hubControlRecordPath, readHubControlRecord, type HubControlRecord } from '../src/control.js';

const repoFile = (rel: string): string => path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', rel);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });
}

/** Boot the real hub entry and wait for its control record to appear. */
async function bootHub(t: import('node:test').TestContext): Promise<{ child: ChildProcess; dataDir: string; record: HubControlRecord }> {
  const root = useTempDir(t, 'helmx-hub-control-');
  const dataDir = path.join(root, 'data');
  const port = await freePort();
  const child = spawn(process.execPath, [repoFile('hub/dist/main.js')], {
    env: {
      ...process.env,
      HELMX_DATA_DIR: dataDir,
      HELMX_PORT: String(port),
      HELMX_HOST: '127.0.0.1',
      HELMX_WEB_DIST_DIR: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  stderrText.set(child, stderr);
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let record: HubControlRecord | null = null;
  await waitFor(
    async () => {
      record = await readHubControlRecord(dataDir).catch(() => null);
      return record !== null && record.pid === child.pid;
    },
    { timeoutMs: 60_000, intervalMs: 250, message: `hub control record did not appear (stderr: ${stderr.slice(-400)})` },
  );
  return { child, dataDir, record: record! };
}

test('hub main writes hub-control.json and answers verified status/stop over the control channel', { timeout: 120_000 }, async (t) => {
  const { child, dataDir, record } = await bootHub(t);

  assert.equal(child.pid, record.pid, 'record describes the live hub process');
  assert.ok(record.version.match(/^\d+\.\d+\.\d+/), `version looks like SemVer (${record.version})`);

  const status = await controlRequest(record.endpoint, { type: 'status', instanceId: record.instanceId }, CONTROL_TIMEOUT_MS, {
    pid: record.pid,
    instanceId: record.instanceId,
  });
  assert.ok(status !== null && status.ok === true, 'verified status request succeeds');
  assert.equal(status.state, 'serving');
  assert.equal(status.version, record.version);

  const mismatch = await controlRequest(record.endpoint, { type: 'status', instanceId: '0'.repeat(32) });
  assert.ok(mismatch !== null && mismatch.ok === false);
  assert.equal(mismatch.error, 'instance_mismatch');

  const stop = await controlRequest(record.endpoint, { type: 'stop', instanceId: record.instanceId }, 30_000, {
    pid: record.pid,
    instanceId: record.instanceId,
  });
  assert.ok(stop !== null && stop.ok === true, 'verified stop request is accepted');
  assert.equal(stop.state, 'stopping');

  const code = await waitExit(child);
  assert.equal(code, 0, `graceful control-channel stop exits 0 (stderr tail: ${stderrOf(child).slice(-400)})`);
  const leftover = await readHubControlRecord(dataDir).catch(() => null);
  assert.equal(leftover, null, 'control record is removed on shutdown');
});

test('readHubControlRecord rejects corrupt records explicitly instead of guessing', { timeout: 60_000 }, async (t) => {
  const root = useTempDir(t, 'helmx-hub-control-corrupt-');
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(hubControlRecordPath(path.join(root, 'data')), '{not json', 'utf8');
  await assert.rejects(readHubControlRecord(path.join(root, 'data')), /corrupt/);
  const missing = await readHubControlRecord(path.join(root, 'nope'));
  assert.equal(missing, null);
  await rm(path.join(root, 'data'), { recursive: true, force: true });
});

function stderrOf(child: ChildProcess): string {
  return stderrText.get(child) ?? '';
}
const stderrText = new WeakMap<ChildProcess, string>();
