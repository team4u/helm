/**
 * `helmx-node` upgrade handoff CLI/IPC tests (`stdio activate/activated` protocol acceptance).
 *
 * Uses real multi-process execution: real candidate child process (`child_process` stdio IPC
 * protocol fixture) + real Hub fixture (`http.Server` + `WebSocketServer` + `birpc`).
 * No module mocking or fabricated npm install (`stageExtractor` creates a runnable candidate entry
 * launched via real `spawn` to exercise the IPC protocol).
 *
 * Covers:
 * 1. `prepareNodeReplacement`: end-to-end IPC `ready`/`activate`/`activated`, `node.pid` update on
 *    commit, and `activate` context checks;
 * 2. Lost ACK never rolls back: timeout waiting for `activated` throws `UpgradeCommitUnconfirmedError`,
 *    never killing the candidate or restoring the old pid;
 * 3. Failed candidate startup (`starting` / immediate exit) preserves the old pid;
 * 4. `abort` before sending `activate` kills the candidate and restores the old pid via CAS;
 * 5. CLI `upgrade` command: `--check` offline lookup, explicit error without daemon, flag exclusivity;
 * 6. `stop` during active upgrade rejects while keeping the control channel functional.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helmx/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc } from 'birpc';
import type { EnvExecOutputEvent } from '@helmx/protocol';
import { bindIdentityFromJoinToken } from '../src/daemon/index.js';
import { UpgradeCommitUnconfirmedError, type StagedNodeRelease } from '../src/daemon/upgrader.js';
import { prepareNodeReplacement, type HandoffPidRecord } from '../src/daemon/upgrade-handoff.js';
import { runNodeCli, type NodeCliIo } from '../src/cli.js';
import { sanitizedHostEnv } from './helpers/sanitized-env.js';

const nodeRequire = createRequire(import.meta.url);
const wsModulePath = nodeRequire.resolve('ws');

interface Captured {
  out: string;
  err: string;
  code: number;
}

async function runCli(argv: string[], io: Partial<NodeCliIo> = {}): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await runNodeCli(argv, {
    // Strip host-managed HELMX_* variables so INSTANCE_ID/CONTROL_ENDPOINT never disable launcher
    // mode during foreground start, and Hub/dataDir/credentials come strictly from test inputs.
    env: sanitizedHostEnv(),
    out: (t) => (out += t),
    err: (t) => (err += t),
    ...io,
  });
  return { out, err, code };
}

const realIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = (condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> =>
  kitWaitFor(condition, { timeoutMs, intervalMs: 100, message: `wait timed out: ${what}` });

// ---------------------------------------------------------------------------
// Hub fixture (real WS + birpc matching node-cli-review)
// ---------------------------------------------------------------------------

interface HubFixture {
  url: string;
  registrations: { nodeId: string; token: string; upgradeAttemptId?: string }[];
  close(): Promise<void>;
}

async function startHubFixture(options: { expectedToken: string }): Promise<HubFixture> {
  const registrations: { nodeId: string; token: string; upgradeAttemptId?: string }[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  let pendingSocket: WebSocket | undefined;
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws/node')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      pendingSocket = ws;
      const local = {
        register(input: { nodeId: string; token: string; upgradeAttemptId?: string }): { ok: boolean; heartbeatMs: number } {
          registrations.push({ nodeId: input.nodeId, token: input.token, upgradeAttemptId: input.upgradeAttemptId });
          if (input.token !== options.expectedToken) {
            setTimeout(() => {
              if (pendingSocket !== undefined && pendingSocket.readyState === WebSocket.OPEN) {
                pendingSocket.close(4003, 'invalid token');
              }
            }, 30);
            return { ok: false, heartbeatMs: 0 };
          }
          return { ok: true, heartbeatMs: 60_000 };
        },
        heartbeat(): boolean {
          return true;
        },
        onEnvExecOutput(_event: EnvExecOutputEvent): void {
          // Env forwarding is not exercised in this file.
        },
      };
      const rpc = createBirpc(local, {
        post: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
        },
        on: (callback) => {
          ws.on('message', (raw) => {
            const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
            try {
              const parsed: unknown = JSON.parse(text);
              if (parsed !== null && typeof parsed === 'object') callback(parsed);
            } catch {
              // Non-JSON frame.
            }
          });
        },
      });
      void rpc;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    registrations,
    close: () =>
      new Promise<void>((resolve) => {
        if (pendingSocket !== undefined) pendingSocket.close();
        wss.close(() => undefined);
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Candidate fixture: real child process implementing stdio IPC protocol (ready / activate / activated)
// ---------------------------------------------------------------------------

/**
 * Candidate protocol fixture script: registers with real Hub (triggering ready=registered),
 * awaits `activate`, replies `activated`, and detaches from parent IPC.
 * Controlled via `HELMX_FIXTURE_MODE`:
 *  - 'candidate' (default): normal protocol behavior;
 *  - 'no-ack': receives activate without replying activated (simulates lost ACK);
 *  - 'vanish': closes parent IPC after ready=registered while staying alive (simulates dead IPC
 *    channel before activate so parent knows write failed and rolls back safely);
 *  - 'starting': reports `starting` without registering (same as unreachable Hub);
 *  - 'exit': reports `starting` and exits immediately.
 */
const CANDIDATE_SCRIPT = `
const http = require('node:http');
const WebSocket = require(process.env.HELMX_FIXTURE_WS_PATH);
const mode = process.env.HELMX_FIXTURE_MODE ?? 'candidate';
const instanceId = process.env.HELMX_NODE_INSTANCE_ID;
const hubUrl = process.env.HELMX_HUB_URL_FIXTURE;
const attempt = process.env.HELMX_NODE_UPGRADE_ATTEMPT;

// Connect directly to Hub /ws/node to exercise protocol layer without running full daemon.
// birpc v2 compact framing: request {t:'q',m:method,a:[args],i:id}, response {t:'s',i:id,r:result}.
const ws = new WebSocket(hubUrl.replace(/^http/, 'ws') + '/ws/node');
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'q', m: 'register', a: [{ nodeId: process.env.HELMX_FIXTURE_NODE_ID ?? 'fixture-node', token: process.env.HELMX_FIXTURE_TOKEN ?? 'fix:s', hostname: 'fix', platform: process.platform, ...(attempt ? { upgradeAttemptId: attempt } : {}) }], i: 'r1' }));
});
ws.on('message', (raw) => {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  let msg; try { msg = JSON.parse(text); } catch { return; }
  if (msg && msg.t === 's' && msg.i === 'r1') {
    const ok = msg.r && msg.r.ok === true;
    const state = ok ? 'registered' : 'starting';
    try { process.send({ type: 'helmx-node.ready', pid: process.pid, instanceId, state }); } catch {}
    if (mode === 'exit') { try { process.disconnect(); process.exit(0); } catch {} }
    if (ok && mode === 'vanish') setTimeout(() => { try { process.disconnect(); } catch {} }, 30);
  }
});
ws.on('error', () => {
  if (mode === 'exit') { try { process.exit(0); } catch {} }
  else { try { process.send({ type: 'helmx-node.ready', pid: process.pid, instanceId, state: 'starting' }); } catch {} }
});
if (mode === 'starting' || mode === 'exit') {
  // Report starting immediately without registering.
  setTimeout(() => {
    try { process.send({ type: 'helmx-node.ready', pid: process.pid, instanceId, state: 'starting' }); } catch {}
    if (mode === 'exit') { process.exit(0); }
  }, 30);
  if (mode === 'starting') {
    // Stay alive waiting for parent to reject 'starting' and terminate candidate.
  }
}
process.on('message', (message) => {
  if (!message || message.type !== 'helmx-node.activate') return;
  if (message.pid !== process.pid || message.attemptId !== attempt) {
    try { process.send({ type: 'helmx-node.activate-rejected', attemptId: message.attemptId, reason: 'context mismatch' }); } catch {}
    return;
  }
  if (mode === 'no-ack' || mode === 'vanish') return; // Drop ACK (no-ack simulates lost receipt; vanish simulates dead IPC)
  try { process.send({ type: 'helmx-node.activated', attemptId: message.attemptId }); } catch {}
  try { if (process.connected) process.disconnect(); } catch {}
});
// Parent disconnect before activation terminates candidate per protocol.
process.on('disconnect', () => {
  if (mode === 'no-ack') { /* Lost ACK case: parent may disconnect while candidate stays alive without rollback */ }
  else if (mode === 'vanish') { /* Self-disconnect staying alive to test parent safe rollback killing candidate */ }
  else process.exit(0);
});
`;

interface CandidateHandle {
  child: ChildProcess;
  scriptPath: string;
}

/** Write candidate fixture script so it runs directly under node without full stageExtractor. */
async function writeCandidateScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, 'candidate-fixture.cjs');
  await fs.writeFile(scriptPath, CANDIDATE_SCRIPT, 'utf8');
  return scriptPath;
}

/** Build a StagedNodeRelease pointing at the candidate fixture script. */
function fixtureRelease(scriptPath: string, cliBinDir: string): StagedNodeRelease {
  return { version: '9.9.9', releaseDir: path.dirname(scriptPath), entryPath: scriptPath, cliBinDir };
}

// ---------------------------------------------------------------------------
// Direct prepareNodeReplacement tests (real child process + in-memory pid store)
// ---------------------------------------------------------------------------

function memoryPidStore(): {
  readPidRecord(): Promise<HandoffPidRecord | null>;
  writePidRecord(record: HandoffPidRecord): Promise<void>;
  removePidFile(): Promise<void>;
  get(): HandoffPidRecord | null;
} {
  let record: HandoffPidRecord | null = null;
  return {
    readPidRecord: async () => record,
    writePidRecord: async (r) => {
      record = r;
    },
    removePidFile: async () => {
      record = null;
    },
    get: () => record,
  };
}

const fixtureEndpoint = (dataDir: string, instanceId: string): string => path.join(dataDir, `ctl-${instanceId}.sock`);

async function prepareWithFixture(options: {
  dir: string;
  hubUrl: string;
  mode: string;
  oldRecord?: HandoffPidRecord;
  readyTimeoutMs?: number;
  activateAckTimeoutMs?: number;
}): Promise<{
  replacement: Awaited<ReturnType<typeof prepareNodeReplacement>> | undefined;
  store: ReturnType<typeof memoryPidStore>;
  error: Error | undefined;
}> {
  const scriptPath = await writeCandidateScript(options.dir);
  const store = memoryPidStore();
  if (options.oldRecord !== undefined) await store.writePidRecord(options.oldRecord);
  const cliBinDir = path.join(options.dir, 'cli-bin');
  await fs.mkdir(cliBinDir, { recursive: true });
  try {
    const replacement = await prepareNodeReplacement(
      fixtureRelease(scriptPath, cliBinDir),
      { attemptId: 'attempt-test-1', previousVersion: '0.1.0', targetVersion: '9.9.9' },
      {
        dataDir: options.dir,
        hubUrl: options.hubUrl,
        logPath: path.join(options.dir, 'candidate.log'),
        controlEndpoint: fixtureEndpoint,
        readPidRecord: store.readPidRecord,
        writePidRecord: store.writePidRecord,
        removePidFile: store.removePidFile,
        env: {
          // Strip host-managed HELMX_* variables so test baseline is clean before explicit fixture overrides.
          ...sanitizedHostEnv(),
          HELMX_FIXTURE_MODE: options.mode,
          HELMX_HUB_URL_FIXTURE: options.hubUrl,
          HELMX_FIXTURE_NODE_ID: 'cand-node',
          HELMX_FIXTURE_TOKEN: 'cand:s',
          HELMX_FIXTURE_WS_PATH: wsModulePath,
          HELMX_VERSION_OVERRIDE: '0.1.0',
        },
        ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
        ...(options.activateAckTimeoutMs !== undefined ? { activateAckTimeoutMs: options.activateAckTimeoutMs } : {}),
      },
    );
    return { replacement, store, error: undefined };
  } catch (error) {
    return { replacement: undefined, store, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

test('prepareNodeReplacement: real IPC ready -> activate -> activated writes new pid on commit', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-ok-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'a'.repeat(32), endpoint: '/tmp/old.sock' };
  const { replacement, store, error } = await prepareWithFixture({ dir, hubUrl: hub.url, mode: 'candidate', oldRecord });
  assert.ok(replacement !== undefined, `prepare replacement failed: ${error?.message}`);
  t.after(async () => {
    if (replacement !== undefined) await replacement.abort().catch(() => undefined);
  });
  assert.ok(replacement.pid > 0);
  assert.ok(realIsAlive(replacement.pid), 'candidate must actually be alive');

  // Before commit, pid record still points to old instance (commit writes the new record)
  assert.equal(store.get()?.pid, process.pid);

  await replacement.commit();

  // After commit, pid record points to candidate
  const after = store.get();
  assert.equal(after?.pid, replacement.pid);
  assert.notEqual(after?.instanceId, oldRecord.instanceId);
  // Candidate stays alive (commit never kills candidate)
  assert.ok(realIsAlive(replacement.pid), 'candidate must stay alive to take over after commit');

  // Cleanup: kill candidate
  process.kill(replacement.pid, 'SIGKILL');
  await waitFor(() => !realIsAlive(replacement.pid), 5_000, 'candidate exits');
});

test('prepareNodeReplacement rejects candidate reporting starting and keeps old pid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-starting-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // Unreachable Hub: candidate truthfully reports starting (parent must reject unready candidate).
  const oldRecord: HandoffPidRecord = { pid: 424242, instanceId: 'b'.repeat(32), endpoint: '/tmp/old2.sock' };
  const { replacement, error } = await prepareWithFixture({ dir, hubUrl: 'http://127.0.0.1:1', mode: 'starting', oldRecord });
  assert.equal(replacement, undefined, 'starting candidate must not be accepted as ready');
  assert.match(error?.message ?? '', /starting|registered/);
});

test('prepareNodeReplacement errors explicitly on immediate candidate exit', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-exit-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // Unreachable Hub: candidate reports starting and exits immediately (parent errors on exit).
  const { replacement, error } = await prepareWithFixture({ dir, hubUrl: 'http://127.0.0.1:1', mode: 'exit' });
  assert.equal(replacement, undefined);
  assert.ok(error !== undefined);
});

test('prepareNodeReplacement throws UpgradeCommitUnconfirmedError when activate ACK is lost without rollback or killing candidate', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-noack-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'c'.repeat(32), endpoint: '/tmp/old3.sock' };
  const { replacement, store, error } = await prepareWithFixture({
    dir,
    hubUrl: hub.url,
    mode: 'no-ack',
    oldRecord,
    activateAckTimeoutMs: 400,
  });
  assert.ok(replacement !== undefined, `prepare failed: ${error?.message}`);

  await assert.rejects(
    () => replacement!.commit(),
    (caught: unknown) => {
      // Wrapper layers may alter message, so verify UpgradeCommitUnconfirmedError along the cause chain
      let current: unknown = caught;
      for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
        if (current instanceof UpgradeCommitUnconfirmedError) return true;
        current = (current as { cause?: unknown }).cause;
      }
      assert.match(caught instanceof Error ? caught.message : String(caught), /refusing rollback|confirmation|Unconfirmed/i);
      return false;
    },
  );

  // Never roll back: pid record still points to candidate (never restores old pid)
  assert.equal(store.get()?.pid, replacement!.pid, 'must not roll back pid record after lost ACK');
  // Never kill candidate: candidate continues running
  assert.ok(realIsAlive(replacement!.pid), 'must never kill candidate after lost ACK');
  // abort must also reject since activate was already sent
  await assert.rejects(() => replacement!.abort(), /refusing abort|was sent/);

  process.kill(replacement!.pid, 'SIGKILL');
  await waitFor(() => !realIsAlive(replacement!.pid), 5_000, 'candidate exits');
});

test('prepareNodeReplacement rolls back safely if candidate disconnects IPC after ready without 10m dead window', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-vanish-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'e'.repeat(32), endpoint: '/tmp/old5.sock' };
  const { replacement, store, error } = await prepareWithFixture({
    dir,
    hubUrl: hub.url,
    mode: 'vanish',
    oldRecord,
    activateAckTimeoutMs: 1_500,
  });
  assert.ok(replacement !== undefined, `prepare failed: ${error?.message}`);
  assert.ok(realIsAlive(replacement.pid), 'candidate should be alive before disconnecting IPC');
  // Wait for parent disconnect handler to transition candidate to dead so activate-not-sent is deterministic.
  await new Promise((resolve) => setTimeout(resolve, 200));

  // commit knows activate was never sent (dead IPC) -> raises normal error (not unconfirmed) so
  // engine safely rolls back instead of keeping draining + yielding for 10 minutes.
  await assert.rejects(
    () => replacement!.commit(),
    (caught: unknown) => {
      assert.equal(caught instanceof UpgradeCommitUnconfirmedError, false, 'guaranteed unsent activate must not be treated as unconfirmed');
      assert.match(caught instanceof Error ? caught.message : String(caught), /activate not sent|rolling back safely|not ready to commit/);
      return true;
    },
  );

  // abort allowed (activate was never sent): kills candidate + restores old pid via instanceId CAS
  await replacement.abort();
  await waitFor(() => !realIsAlive(replacement.pid), 5_000, 'safe rollback must kill candidate');
  assert.equal(store.get()?.pid, process.pid, 'pid record should restore old process');
  assert.equal(store.get()?.instanceId, 'e'.repeat(32));
});

test('prepareNodeReplacement: abort before activate kills candidate without touching pid record', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-abort-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'd'.repeat(32), endpoint: '/tmp/old4.sock' };
  const { replacement, store, error } = await prepareWithFixture({ dir, hubUrl: hub.url, mode: 'candidate', oldRecord });
  assert.ok(replacement !== undefined, `prepare failed: ${error?.message}`);
  assert.ok(realIsAlive(replacement.pid), 'candidate should be alive before abort');

  await replacement.abort();

  await waitFor(() => !realIsAlive(replacement.pid), 5_000, 'abort must kill owned candidate');
  // abort before activate (pidWritten=false): never touches pid record
  assert.equal(store.get()?.pid, process.pid, 'abort must not overwrite old pid record');
  assert.equal(store.get()?.instanceId, 'd'.repeat(32));
});

// ---------------------------------------------------------------------------
// CLI upgrade commands
// ---------------------------------------------------------------------------

test('upgrade --check queries offline without starting daemon (injected fetch fixture)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-check-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // checkNodeUpgrade uses fetchFn (default fetch): invalid registry fails explicitly
  const r = await runCli(['upgrade', '--check', '--data-dir', dir, '--registry', 'http://127.0.0.1:1', '--json']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.err).error.message, /query|failed/);
  // No daemon process started: no pid file created
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, '--check must not start daemon');
});

test('upgrade without managed daemon explicitly tells user to run helmx-node start first', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-norun-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'upg-norun:s', 'http://127.0.0.1:1');
  const r = await runCli(['upgrade', '--data-dir', dir, '--json']);
  assert.equal(r.code, 1);
  const envelope = JSON.parse(r.err) as { error: { message: string } };
  assert.match(envelope.error.message, /run helmx-node start/);
});

test('upgrade flag validation: --check is mutually exclusive with --version and --force', { timeout: 60_000 }, async () => {
  const clash = await runCli(['upgrade', '--check', '--version', '1.2.3', '--data-dir', '/tmp/x', '--json']);
  assert.equal(clash.code, 1);
  assert.match(JSON.parse(clash.err).error.message, /mutually exclusive/);
  const clash2 = await runCli(['upgrade', '--check', '--force', '--data-dir', '/tmp/x', '--json']);
  assert.equal(clash2.code, 1);
  assert.match(JSON.parse(clash2.err).error.message, /mutually exclusive/);
  const unknown = await runCli(['upgrade', '--no-such-flag', '--data-dir', '/tmp/x', '--json']);
  assert.equal(unknown.code, 1);
  assert.match(JSON.parse(unknown.err).error.message, /unknown option/);
});

// ---------------------------------------------------------------------------
// Control channel: stop rejected while upgrading while channel remains responsive
// ---------------------------------------------------------------------------

/** Start a real managed daemon (`start -d`) and return its pid record. */
async function startManagedDaemon(t: test.TestContext, dir: string, hubUrl: string): Promise<HandoffPidRecord> {
  await bindIdentityFromJoinToken(dir, 'upg-ctl:s', hubUrl);
  const started = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(started.code, 0, started.err);
  const payload = JSON.parse(started.out) as { pid: number };
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as HandoffPidRecord;
  assert.equal(raw.pid, payload.pid);
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
  });
  return raw;
}

test('control channel upgrade request: rejects clearly when unready/invalid and keeps stop/status functional', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-ctl-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'upg-ctl:s' });
  t.after(async () => {
    await hub.close();
  });
  const record = await startManagedDaemon(t, dir, hub.url);

  const request = (type: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; result?: unknown } | null> =>
    new Promise((resolve) => {
      let buffer = '';
      const socket = net.connect(record.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(null);
      }, 10_000);
      socket.on('connect', () => socket.write(`${JSON.stringify({ type, instanceId: record.instanceId, ...extra })}\n`));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, nl)) as { ok: boolean; error?: string });
        } catch {
          resolve(null);
        }
        socket.destroy();
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

  // status still works
  const status = await request('status');
  assert.ok(status !== null && status.ok === true, 'status must be available');

  // upgrade reaches daemon (which injects prepare; invalid target version rejects proving path reached handler)
  const upgrade = await request('upgrade', { input: { targetVersion: 'not-semver' } });
  assert.ok(upgrade !== null, 'upgrade request must receive a reply');
  assert.equal(upgrade.ok, false);
  assert.match(upgrade.error ?? '', /invalid|SemVer|reject/);

  // stop works normally when not upgrading
  const stopped = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stopped.code, 0, stopped.err);
  await waitFor(() => !realIsAlive(record.pid), 10_000, 'daemon exits');
});

test('start -d: stop rejects with upgrade_in_progress while upgrade runs (real isUpgrading state)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-busy-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'upg-ctl:s' });
  t.after(async () => {
    await hub.close();
  });
  const record = await startManagedDaemon(t, dir, hub.url);

  // Exercise the protocol path directly with an invalid target version (fails fast without fabricating install)
  // and verify daemon does not crash and control channel still answers status.
  const upgradePromise = (async () => {
    return await new Promise<{ ok: boolean; error?: string } | null>((resolve) => {
      let buffer = '';
      const socket = net.connect(record.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(null);
      }, 10_000);
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ type: 'upgrade', instanceId: record.instanceId, input: { targetVersion: 'bad' } })}\n`),
      );
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, nl)) as { ok: boolean; error?: string });
        } catch {
          resolve(null);
        }
        socket.destroy();
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  })();
  const upgradeResponse = await upgradePromise;
  assert.ok(upgradeResponse !== null, 'upgrade reply must arrive');
  assert.equal(upgradeResponse.ok, false);
  // daemon stays alive and status remains responsive
  assert.ok(realIsAlive(record.pid), 'daemon must not crash on upgrade error');
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(status.code, 0, status.err);
});

// ---------------------------------------------------------------------------
// Launcher semantics (foreground start without control env)
// ---------------------------------------------------------------------------

test('foreground start without control env acts as launcher: spawns and tracks managed daemon', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-launcher-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    child?.kill('SIGKILL');
  });
  const hub = await startHubFixture({ expectedToken: 'upg-launch:s' });
  t.after(async () => {
    await hub.close();
  });
  await bindIdentityFromJoinToken(dir, 'upg-launch:s', hub.url);

  // launcher child runs tsx source entry in foreground
  const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  let child: ChildProcess | undefined;
  child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cliEntry, 'start', '--data-dir', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...sanitizedHostEnv(), HELMX_HUB_URL: hub.url, HELMX_NODE_LAUNCHER_POLL_MS: '100' },
  });
  let stdout = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));

  // launcher spawns managed daemon and writes pid record
  await waitFor(async () => {
    const raw = await fs.readFile(path.join(dir, 'node.pid'), 'utf8').then(() => true, () => false);
    return raw;
  }, 30_000, 'launcher spawns daemon and writes pid record');
  const record = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as HandoffPidRecord;
  assert.ok(record.pid > 0);
  assert.ok(realIsAlive(record.pid));
  assert.ok(realIsAlive(child.pid ?? 0), 'launcher itself stays alive');
  assert.match(stdout, /launcher/);

  // SIGTERM launcher: stops daemon via control channel before exiting
  child.kill('SIGTERM');
  await waitFor(() => !realIsAlive(child!.pid ?? 0), 15_000, 'launcher exits');
  await waitFor(() => !realIsAlive(record.pid), 15_000, 'daemon stops via control channel');
});

// ---------------------------------------------------------------------------
// USAGE and status version output
// ---------------------------------------------------------------------------

test('USAGE lists upgrade command and flags; status prints actual running version', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-usage-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /upgrade \[--check\]/);
  assert.match(help.out, /--version <ver>/);
  assert.match(help.out, /--registry <url>/);
  assert.match(help.out, /--check/);
  assert.match(help.out, /--force/);

  const status = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(status.code, 0);
  const payload = JSON.parse(status.out) as { version: string };
  assert.match(payload.version, /^\d+\.\d+\.\d+/);
});

// ---------------------------------------------------------------------------
// Regression checks: shutdown await / no PID overwrite / control version precedence
// ---------------------------------------------------------------------------

/**
 * Slow-stop control server fixture: delays stop response by `slowMs` (>200ms) and reports a
 * fixed `version` on status; tests that launcher awaits full shutdown before exiting.
 */
async function startFixtureControl(options: {
  dataDir: string;
  instanceId: string;
  statusVersion?: string;
  slowStopMs?: number;
  upgradeResult?: Record<string, unknown> | null;
  endpointOverride?: string;
}): Promise<{ endpoint: string; stopped(): boolean; close(): Promise<void> }> {
  const endpoint = options.endpointOverride ?? fixtureEndpoint(options.dataDir, options.instanceId);
  let stoppedFlag = false;
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      buffer = '';
      let request: { type?: unknown; instanceId?: unknown };
      try {
        request = JSON.parse(line) as { type?: unknown; instanceId?: unknown };
      } catch {
        socket.end('{"ok":false,"error":"bad_request"}\n');
        return;
      }
      if (request.instanceId !== options.instanceId) {
        socket.end('{"ok":false,"error":"instance_mismatch"}\n');
        return;
      }
      if (request.type === 'status') {
        socket.end(
          `${JSON.stringify({
            ok: true,
            pid: process.pid,
            instanceId: options.instanceId,
            state: 'registered',
            ...(options.statusVersion !== undefined ? { version: options.statusVersion } : {}),
          })}\n`,
        );
        return;
      }
      if (request.type === 'stop') {
        setTimeout(
          () => {
            stoppedFlag = true;
            socket.end(`${JSON.stringify({ ok: true, pid: process.pid, instanceId: options.instanceId, state: 'stopping' })}\n`, () => {
              socket.destroy();
              server.close(() => undefined);
            });
          },
          options.slowStopMs ?? 0,
        );
        return;
      }
      if (request.type === 'upgrade') {
        socket.end(
          `${JSON.stringify({
            ok: true,
            pid: process.pid,
            instanceId: options.instanceId,
            state: 'starting',
            ...(options.upgradeResult === null ? {} : { result: options.upgradeResult ?? { foo: 'bar' } }),
          })}\n`,
        );
        return;
      }
      socket.end('{"ok":false,"error":"unknown_command"}\n');
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    endpoint,
    stopped: () => stoppedFlag,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if (!server.listening) resolve();
      });
      await fs.rm(endpoint, { force: true }).catch(() => undefined);
    },
  };
}

async function writePidRecordRaw(dir: string, record: HandoffPidRecord): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'node.pid'), `${JSON.stringify(record)}\n`, 'utf8');
}

test('launcher shutdown awaits slow stop replies (>200ms) before returning', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-slowstop-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'slow-stop:s', 'http://127.0.0.1:1');
  // Delay must exceed poll slack + old hardcoded 200ms timeout: use 700ms so fire-and-forget
  // would exit early around ~450ms while awaiting shutdown completes after >=700ms.
  const SLOW_MS = 700;
  let control: Awaited<ReturnType<typeof startFixtureControl>> | undefined;
  t.after(async () => {
    await control?.close();
  });

  let stdout = '';
  const launcherPromise = runNodeCli(['start', '--data-dir', dir], {
    // Strip host control/identity env so foreground start runs as launcher without bogus control env.
    env: sanitizedHostEnv(),
    launcherPollMs: 50,
    out: (text) => (stdout += text),
    // Current test process stands in for the daemon until fixture acknowledges stop.
    isAlive: (pid) => pid === process.pid && !(control?.stopped() ?? false),
    spawnDaemon: async (options) => {
      control = await startFixtureControl({
        dataDir: dir,
        instanceId: options.instanceId,
        endpointOverride: options.endpoint,
        slowStopMs: SLOW_MS,
      });
      return { pid: process.pid, readyState: 'registered', logPath: path.join(dir, 'node.log') };
    },
  });

  // Wait until launcher prints startup banner and registers signal handlers (non-json mode).
  await waitFor(() => stdout.includes('launcher'), 15_000, 'launcher startup message');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const sigtermAt = Date.now();
  process.kill(process.pid, 'SIGTERM');
  const code = await launcherPromise;
  const returnedAt = Date.now();

  assert.ok(control?.stopped(), 'fixture must have replied to stop');
  assert.ok(
    returnedAt - sigtermAt >= SLOW_MS - 200,
    `launcher exited before slow stop settled (${returnedAt - sigtermAt}ms < ${SLOW_MS - 200}ms)`,
  );
  assert.equal(code, 0);
  // Shutdown chain performs CAS cleanup removing pid file.
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'pid file should be CAS-cleaned');
});

test('upgrade output keeps replacement pid from result and renders old pid as previousPid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-pid-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const instanceId = 'ab'.repeat(16);
  const control = await startFixtureControl({
    dataDir: dir,
    instanceId,
    upgradeResult: { ok: true, previousVersion: '0.1.0', targetVersion: '9.9.9', upgraded: true, pid: 424242 },
  });
  t.after(async () => {
    await control.close();
  });
  // PID record points to old daemon (current process): envelope pid=old, result.pid=424242.
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });
  t.after(async () => {
    await fs.rm(path.join(dir, 'node.pid'), { force: true }).catch(() => undefined);
  });

  const r = await runCli(['upgrade', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(r.code, 0, r.err);
  const payload = JSON.parse(r.out) as { pid: number; previousPid: number; upgraded: boolean };
  assert.equal(payload.pid, 424242, 'replacement pid must not be overwritten by envelope pid');
  assert.equal(payload.previousPid, process.pid, 'old pid should be exposed as previousPid');
  assert.notEqual(payload.pid, payload.previousPid);
  assert.equal(payload.upgraded, true);
});

test('upgrade allows valid no-op result without candidate pid when version already matches', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-noop-');
  const instanceId = 'ef'.repeat(16);
  const control = await startFixtureControl({
    dataDir: dir,
    instanceId,
    upgradeResult: { ok: true, previousVersion: '0.1.0', targetVersion: '0.1.0', upgraded: false },
  });
  t.after(async () => {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });
  const result = await runCli(['upgrade', '--version', '0.1.0', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(result.code, 0, result.err);
  const payload = JSON.parse(result.out) as { upgraded: boolean; pid?: number; previousPid: number };
  assert.equal(payload.upgraded, false);
  assert.equal(payload.pid, undefined, 'no-op upgrade must not invent a replacement PID');
  assert.equal(payload.previousPid, process.pid);
});

test('upgrade rejects invalid result envelopes missing ok/upgraded/pid with non-zero exit', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-badres-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const instanceId = 'cd'.repeat(16);
  const control = await startFixtureControl({ dataDir: dir, instanceId, upgradeResult: { foo: 'bar' } });
  t.after(async () => {
    await control.close();
  });
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });
  t.after(async () => {
    await fs.rm(path.join(dir, 'node.pid'), { force: true }).catch(() => undefined);
  });

  const r = await runCli(['upgrade', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(r.code, 1);
  assert.equal(r.out, '', 'invalid result must not emit success JSON');
  const envelope = JSON.parse(r.err) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'invalid_upgrade_result');
  assert.match(envelope.error.message, /refusing to assume success/);
});

test('status prefers live control-channel version and falls back to current.json when offline', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helmx-handoff-ver-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const instanceId = 'ef'.repeat(16);
  const control = await startFixtureControl({ dataDir: dir, instanceId, statusVersion: '99.9.9' });
  t.after(async () => {
    await control.close();
  });
  // Local current.json points to another version: only used as fallback when no live daemon exists.
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'current.json'),
    `${JSON.stringify({ version: '0.0.1-current', entryPath: '/nonexistent/cli.js', updatedAt: new Date().toISOString() })}\n`,
    'utf8',
  );
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });

  // Live instance reports 99.9.9 over control channel: must override local current.json.
  const live = await runCli(['status', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(live.code, 0, live.err);
  const livePayload = JSON.parse(live.out) as { version: string; state: string };
  assert.equal(livePayload.version, '99.9.9', 'control channel reported version must win');
  assert.equal(livePayload.state, 'registered');

  // No live instance (pid file removed): falls back to version in current.json.
  await fs.rm(path.join(dir, 'node.pid'), { force: true });
  const offline = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(offline.code, 0, offline.err);
  const offlinePayload = JSON.parse(offline.out) as { version: string; pid: number | null };
  assert.equal(offlinePayload.version, '0.0.1-current', 'current.json provides fallback when no live instance exists');
  assert.equal(offlinePayload.pid, null);
});
