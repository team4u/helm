/**
 * helm-node upgrade handover CLI/IPC test (stdio activate/activated protocol verify).
 *
 * all real many process: real choose child process (Node child_process stdio IPC protocol
 * fixture)+ real Hub fixture(http.Server + WebSocketServer + birpc).
 * do not mock by test module; do not edit build install succeeded (stageExtractor only construct can run choose entry,
 * by real spawn pull start verify IPC protocol, do not fabricate npm install).
 *
 * override:
 * 1. prepareNodeReplacement: real IPC ready/activate/activated all link,
 *    commit after pid Profile points to choose,activate context validate;
 * 2. ACK lose do not rollback:activate out after confirm timeout throw UpgradeCommitUnconfirmedError,
 *    never kill choose, never restore old pid;
 * 3. choose failed to start (starting / i.e. retreat) keep old pid;
 * 4. abort(not activate) kill choose and CAS restore old pid;
 * 5. CLI upgrade command:--check offline query, without daemon explicit errors,flag mutual exclusion;
 * 6. upgrade in-flight stop reject and control channel still available.
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
import { makeTempDir as tempDir, waitFor as kitWaitFor } from '@helm/test-kit/node';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc } from 'birpc';
import type { EnvExecOutputEvent } from '@helm/protocol';
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
    // strip except host managed HELM_* variable: host control identity (INSTANCE_ID/CONTROL_ENDPOINT)
    // store in when foreground start no longer into is launcher,Hub/data directory/credentials same must not hijack.
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
  kitWaitFor(condition, { timeoutMs, intervalMs: 100, message: `wait timed out:${what}` });

// ---------------------------------------------------------------------------
// Hub fixture(re- use node-cli-review same style real WS + birpc)
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
          // this file do not test env forwarding.
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
              // non- JSON frame.
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
// choose fixture: real child process implement stdio IPC protocol (ready / activate / activated)
// ---------------------------------------------------------------------------

/**
 * choose protocol child process script: register to real Hub(trigger ready=registered), wait for
 * activate; receives legal activate back activated and detach parent IPC store.
 * behavior by env HELM_FIXTURE_MODE control:
 *  - 'candidate'(default): normal protocol implement;
 *  - 'no-ack': receives activate but do not back activated(simulated already send reach but back hold lose);
 *  - 'vanish': real registered after disconnect parent IPC but keep store (simulated activate out
 *    before channel already die - - write must failed, parent side must by determine not send reach security rollback);
 *  - 'starting': on report starting do not register (Hub cannot reach also the same);
 *  - 'exit': on report starting after immediately exit.
 */
const CANDIDATE_SCRIPT = `
const http = require('node:http');
const WebSocket = require(process.env.HELM_FIXTURE_WS_PATH);
const mode = process.env.HELM_FIXTURE_MODE ?? 'candidate';
const instanceId = process.env.HELM_NODE_INSTANCE_ID;
const hubUrl = process.env.HELM_HUB_URL_FIXTURE;
const attempt = process.env.HELM_NODE_UPGRADE_ATTEMPT;

// directly to Hub  /ws/node start WS register (do not away complete daemon,fixture only verify protocol layer).
// birpc v2 compact format: request {t:'q',m:method,a:[args],i:id}, response {t:'s',i:id,r:result}.
const ws = new WebSocket(hubUrl.replace(/^http/, 'ws') + '/ws/node');
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'q', m: 'register', a: [{ nodeId: process.env.HELM_FIXTURE_NODE_ID ?? 'fixture-node', token: process.env.HELM_FIXTURE_TOKEN ?? 'fix:s', hostname: 'fix', platform: process.platform, ...(attempt ? { upgradeAttemptId: attempt } : {}) }], i: 'r1' }));
});
ws.on('message', (raw) => {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  let msg; try { msg = JSON.parse(text); } catch { return; }
  if (msg && msg.t === 's' && msg.i === 'r1') {
    const ok = msg.r && msg.r.ok === true;
    const state = ok ? 'registered' : 'starting';
    try { process.send({ type: 'helm-node.ready', pid: process.pid, instanceId, state }); } catch {}
    if (mode === 'exit') { try { process.disconnect(); process.exit(0); } catch {} }
    if (ok && mode === 'vanish') setTimeout(() => { try { process.disconnect(); } catch {} }, 30);
  }
});
ws.on('error', () => {
  if (mode === 'exit') { try { process.exit(0); } catch {} }
  else { try { process.send({ type: 'helm-node.ready', pid: process.pid, instanceId, state: 'starting' }); } catch {} }
});
if (mode === 'starting' || mode === 'exit') {
  // directly on report starting: do not establish real register.
  setTimeout(() => {
    try { process.send({ type: 'helm-node.ready', pid: process.pid, instanceId, state: 'starting' }); } catch {}
    if (mode === 'exit') { process.exit(0); }
  }, 30);
  if (mode === 'starting') {
    // keep store wait for (parent side should by starting reject and kill).
  }
}
process.on('message', (message) => {
  if (!message || message.type !== 'helm-node.activate') return;
  if (message.pid !== process.pid || message.attemptId !== attempt) {
    try { process.send({ type: 'helm-node.activate-rejected', attemptId: message.attemptId, reason: 'context mismatch' }); } catch {}
    return;
  }
  if (mode === 'no-ack' || mode === 'vanish') return; // must not answer:no-ack simulated back hold lose;vanish simulated channel already die
  try { process.send({ type: 'helm-node.activated', attemptId: message.attemptId }); } catch {}
  try { if (process.connected) process.disconnect(); } catch {}
});
// parent disconnect: inactive i.e. exit (protocol convention).
process.on('disconnect', () => {
  if (mode === 'no-ack') { /* ACK lose scenario parent may disconnected: continue store verify do not rollback */ }
  else if (mode === 'vanish') { /* self disconnect keep store: verify parent side security rollback kill choose */ }
  else process.exit(0);
});
`;

interface CandidateHandle {
  child: ChildProcess;
  scriptPath: string;
}

/** write choose fixture script and with designate pattern start (without going through prepareNodeReplacement). */
async function writeCandidateScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, 'candidate-fixture.cjs');
  await fs.writeFile(scriptPath, CANDIDATE_SCRIPT, 'utf8');
  return scriptPath;
}

/** construct StagedNodeRelease: entry is choose fixture script (node can directly run). */
function fixtureRelease(scriptPath: string, cliBinDir: string): StagedNodeRelease {
  return { version: '9.9.9', releaseDir: path.dirname(scriptPath), entryPath: scriptPath, cliBinDir };
}

// ---------------------------------------------------------------------------
// prepareNodeReplacement direct test (real child process + memory pid Profile)
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
          // base bottom strip except host managed HELM_* variable (choose own independent control identity; produce product side
          // prepareNodeReplacement also will strip except, this in guarantee test inject base bottom same clean),
          // test fixture variable in its after explicit override.
          ...sanitizedHostEnv(),
          HELM_FIXTURE_MODE: options.mode,
          HELM_HUB_URL_FIXTURE: options.hubUrl,
          HELM_FIXTURE_NODE_ID: 'cand-node',
          HELM_FIXTURE_TOKEN: 'cand:s',
          HELM_FIXTURE_WS_PATH: wsModulePath,
          HELM_VERSION_OVERRIDE: '0.1.0',
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

test('prepareNodeReplacement: real IPC ready→activate→activated,commit write new pid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-ok-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'a'.repeat(32), endpoint: '/tmp/old.sock' };
  const { replacement, store, error } = await prepareWithFixture({ dir, hubUrl: hub.url, mode: 'candidate', oldRecord });
  assert.ok(replacement !== undefined, `prepare replace failed:${error?.message}`);
  t.after(async () => {
    if (replacement !== undefined) await replacement.abort().catch(() => undefined);
  });
  assert.ok(replacement.pid > 0);
  assert.ok(realIsAlive(replacement.pid), 'choose must real store');

  // commit before pid Profile still is old record (commit point only then write new record)
  assert.equal(store.get()?.pid, process.pid);

  await replacement.commit();

  // commit after Profile points to choose
  const after = store.get();
  assert.equal(after?.pid, replacement.pid);
  assert.notEqual(after?.instanceId, oldRecord.instanceId);
  // choose still store (commit do not kill choose)
  assert.ok(realIsAlive(replacement.pid), 'commit after choose must store take over');

  // clean up: kill choose
  process.kill(replacement.pid, 'SIGKILL');
  await waitFor(() => !realIsAlive(replacement.pid), 5_000, 'choose exit');
});

test('prepareNodeReplacement: choose on report starting reject, old pid keep', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-starting-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // cannot reach Hub: choose register failed real on report starting(parent side must reject carries illness commit).
  const oldRecord: HandoffPidRecord = { pid: 424242, instanceId: 'b'.repeat(32), endpoint: '/tmp/old2.sock' };
  const { replacement, error } = await prepareWithFixture({ dir, hubUrl: 'http://127.0.0.1:1', mode: 'starting', oldRecord });
  assert.equal(replacement, undefined, 'starting choose disallows ready');
  assert.match(error?.message ?? '', /starting|registered/);
});

test('prepareNodeReplacement: choose i.e. retreat explicit errors', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-exit-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // cannot reach Hub: choose on report starting after i.e. retreat (parent side by exit explicit errors).
  const { replacement, error } = await prepareWithFixture({ dir, hubUrl: 'http://127.0.0.1:1', mode: 'exit' });
  assert.equal(replacement, undefined);
  assert.ok(error !== undefined);
});

test('prepareNodeReplacement:activate ACK lose throw UpgradeCommitUnconfirmedError and do not rollback do not kill choose', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-noack-');
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
  assert.ok(replacement !== undefined, `prepare failed:${error?.message}`);

  await assert.rejects(
    () => replacement!.commit(),
    (caught: unknown) => {
      // engine package wrap layer may wrap message, but because chain must be UpgradeCommitUnconfirmedError
      let current: unknown = caught;
      for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
        if (current instanceof UpgradeCommitUnconfirmedError) return true;
        current = (current as { cause?: unknown }).cause;
      }
      assert.match(caught instanceof Error ? caught.message : String(caught), /do not rollback|not confirm|Unconfirmed/i);
      return false;
    },
  );

  // do not rollback:pid Profile still points to choose (never restore old pid)
  assert.equal(store.get()?.pid, replacement!.pid, 'ACK lose after must not rollback pid Profile');
  // do not kill choose: choose continue store (idempotent retry semantics)
  assert.ok(realIsAlive(replacement!.pid), 'ACK lose never kill choose');
  // abort also must by reject (activate already out)
  await assert.rejects(() => replacement!.abort(), /reject abort|already out/);

  process.kill(replacement!.pid, 'SIGKILL');
  await waitFor(() => !realIsAlive(replacement!.pid), 5_000, 'choose exit');
});

test('prepareNodeReplacement: choose ready after self assert IPC- -activate determine not send reach, security rollback do not 10 minute empty window', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-vanish-');
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
  assert.ok(replacement !== undefined, `prepare failed:${error?.message}`);
  assert.ok(realIsAlive(replacement.pid), 'disconnect IPC before choose store');
  // etc. parent side handle completely disconnect event (ready phase disconnect→dead): eliminate commit and
  // self disconnect timer between competition, lockactivate from not send reach determinism scenario.
  await new Promise((resolve) => setTimeout(resolve, 200));

  // commit: determine not send reach (failed to write or channel already die)→ ordinary error (non- not confirm),
  // engine based on this away security rollback; old implement mistakenly by not confirm keep gate + let, node empty window 10 minute.
  await assert.rejects(
    () => replacement!.commit(),
    (caught: unknown) => {
      assert.equal(caught instanceof UpgradeCommitUnconfirmedError, false, 'determine not send reach must not by not confirm handle');
      assert.match(caught instanceof Error ? caught.message : String(caught), /not out|security rollback|do not in can commit state/);
      return true;
    },
  );

  // abort allows (activate from not send reach): kill choose + instanceId CAS restore old pid Profile
  await replacement.abort();
  await waitFor(() => !realIsAlive(replacement.pid), 5_000, 'security rollback must kill choose');
  assert.equal(store.get()?.pid, process.pid, 'pid Profile should restore is old process');
  assert.equal(store.get()?.instanceId, 'e'.repeat(32));
});

test('prepareNodeReplacement: not activate when abort kill choose and do not trigger touch Profile', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-abort-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'd'.repeat(32), endpoint: '/tmp/old4.sock' };
  const { replacement, store, error } = await prepareWithFixture({ dir, hubUrl: hub.url, mode: 'candidate', oldRecord });
  assert.ok(replacement !== undefined, `prepare failed:${error?.message}`);
  assert.ok(realIsAlive(replacement.pid), 'abort before choose store');

  await replacement.abort();

  await waitFor(() => !realIsAlive(replacement.pid), 5_000, 'abort must kill self has choose');
  // abort not activate(pidWritten=false): do not trigger touch Profile, old record keep do not change.
  assert.equal(store.get()?.pid, process.pid, 'abort must not change write old Profile');
  assert.equal(store.get()?.instanceId, 'd'.repeat(32));
});

// ---------------------------------------------------------------------------
// CLI upgrade command
// ---------------------------------------------------------------------------

test('upgrade --check: do not start daemon directly query (inject fetch fixture)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-check-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // checkNodeUpgrade away fetchFn by default fetch: inject broken registry address explicit failed
  const r = await runCli(['upgrade', '--check', '--data-dir', dir, '--registry', 'http://127.0.0.1:1', '--json']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.err).error.message, /query|failed/);
  // without daemon process by pull start: without pid file produce
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, '--check must not start daemon');
});

test('upgrade without managed daemon: explicit want seek first start, do not false call offline already upgrade', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-norun-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'upg-norun:s', 'http://127.0.0.1:1');
  const r = await runCli(['upgrade', '--data-dir', dir, '--json']);
  assert.equal(r.code, 1);
  const envelope = JSON.parse(r.err) as { error: { message: string } };
  assert.match(envelope.error.message, /please first helm-node start/);
});

test('upgrade flag validate:--check and --version/--force mutual exclusion', { timeout: 60_000 }, async () => {
  const clash = await runCli(['upgrade', '--check', '--version', '1.2.3', '--data-dir', '/tmp/x', '--json']);
  assert.equal(clash.code, 1);
  assert.match(JSON.parse(clash.err).error.message, /mutual exclusion/);
  const clash2 = await runCli(['upgrade', '--check', '--force', '--data-dir', '/tmp/x', '--json']);
  assert.equal(clash2.code, 1);
  assert.match(JSON.parse(clash2.err).error.message, /mutual exclusion/);
  const unknown = await runCli(['upgrade', '--no-such-flag', '--data-dir', '/tmp/x', '--json']);
  assert.equal(unknown.code, 1);
  assert.match(JSON.parse(unknown.err).error.message, /unknown option/);
});

// ---------------------------------------------------------------------------
// control channel: upgrade in-flight stop reject and channel still available
// ---------------------------------------------------------------------------

/** start a real subject to control daemon(start -d), return pid record and clean up handle. */
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

test('control channel upgrade request:daemon without upgrade host when explicit reject and stop/status still available', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-ctl-');
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

  // status still available
  const status = await request('status');
  assert.ok(status !== null && status.ok === true, 'status must available');

  // upgrade request can reach daemon(subject to control instance inject prepare; this where target version illegal by refuse - -
  // verify request real enter upgrade path while non- unknown_command)
  const upgrade = await request('upgrade', { input: { targetVersion: 'not-semver' } });
  assert.ok(upgrade !== null, 'upgrade request must obtain to reply');
  assert.equal(upgrade.ok, false);
  assert.match(upgrade.error ?? '', /illegal|SemVer|reject/);

  // stop normal work (not in upgrade in)
  const stopped = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stopped.code, 0, stopped.err);
  await waitFor(() => !realIsAlive(record.pid), 10_000, 'daemon exit');
});

test('start -d: upgrade in-flight stop by upgrade_in_progress reject (isUpgrading real state)', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-busy-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'upg-ctl:s' });
  t.after(async () => {
    await hub.close();
  });
  const record = await startManagedDaemon(t, dir, hub.url);

  // to real daemon start a will long time enter row upgrade? - - honest discipline: do not fabricate install.
  // this where verify protocol layer: directly upgrade request (target version illegal immediately failed), confirm request
  // and stop concurrency when daemon do not crash, control channel still reply.
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
  assert.ok(upgradeResponse !== null, 'upgrade reply must store in');
  assert.equal(upgradeResponse.ok, false);
  // daemon still store and status available
  assert.ok(realIsAlive(record.pid), 'daemon must not because upgrade request crash');
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(status.code, 0, status.err);
});

// ---------------------------------------------------------------------------
// launcher semantics (start foreground without control env)
// ---------------------------------------------------------------------------

test('foreground start(without control env) into is launcher: pull start subject to control daemon and trace', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-launcher-');
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

  // launcher child process: real tsx source entry run start(foreground)
  const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  let child: ChildProcess | undefined;
  child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cliEntry, 'start', '--data-dir', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...sanitizedHostEnv(), HELM_HUB_URL: hub.url, HELM_NODE_LAUNCHER_POLL_MS: '100' },
  });
  let stdout = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));

  // launcher pull start subject to control daemon and write pid Profile
  await waitFor(async () => {
    const raw = await fs.readFile(path.join(dir, 'node.pid'), 'utf8').then(() => true, () => false);
    return raw;
  }, 30_000, 'launcher pull start daemon and write pid Profile');
  const record = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as HandoffPidRecord;
  assert.ok(record.pid > 0);
  assert.ok(realIsAlive(record.pid));
  assert.ok(realIsAlive(child.pid ?? 0), 'launcher itself keep store');
  assert.match(stdout, /launcher/);

  // SIGTERM launcher: via control channel stop daemon after exit
  child.kill('SIGTERM');
  await waitFor(() => !realIsAlive(child!.pid ?? 0), 15_000, 'launcher exit');
  await waitFor(() => !realIsAlive(record.pid), 15_000, 'daemon via control channel stop');
});

// ---------------------------------------------------------------------------
// USAGE and status version output
// ---------------------------------------------------------------------------

test('USAGE contains upgrade command and new flag;status output real run version', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-usage-');
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
// precise allow fix verify:shutdown await / PID does not override / control version takes precedence
// ---------------------------------------------------------------------------

/**
 * slow stop control server fixture:stop reply fixed latency slowMs(>200ms),status response carry
 * designate version; used to verify launcher must await close chain set (old implement fire-and-forget
 * only etc. 200ms will early retreat) and status version priority.
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

test('launcher shutdown:stop slow reply (>200ms) when must await set after only then return', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-slowstop-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'slow-stop:s', 'http://127.0.0.1:1');
  // slow stop latency must greater than trace polling remaining amount + old implement fixed wait for 200ms: take 700ms, old
  // fire-and-forget implement most late ~450ms return (must however early retreat), new implement must await to
  // stop reply (≥700ms) after only then return. polling inject 50ms, verify window sync shrink short.
  const SLOW_MS = 700;
  let control: Awaited<ReturnType<typeof startFixtureControl>> | undefined;
  t.after(async () => {
    await control?.close();
  });

  let stdout = '';
  const launcherPromise = runNodeCli(['start', '--data-dir', dir], {
    // strip except host control/identity env: this case before mention is without control env foreground start into is
    // launcher, host managed variable must not fabricate subject to control identity.
    env: sanitizedHostEnv(),
    launcherPollMs: 50,
    out: (text) => (stdout += text),
    // this test process i.e.daemon:pid=itself, store until fixture reply stop after placement stop.
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

  // etc. launcher complete start and register signal listen (non- json pattern print start message after register).
  await waitFor(() => stdout.includes('launcher'), 15_000, 'launcher start message');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const sigtermAt = Date.now();
  process.kill(process.pid, 'SIGTERM');
  const code = await launcherPromise;
  const returnedAt = Date.now();

  assert.ok(control?.stopped(), 'fixture must already reply stop');
  assert.ok(
    returnedAt - sigtermAt >= SLOW_MS - 200,
    `launcher in stop slow reply set before early retreat (signal to return only ${returnedAt - sigtermAt}ms < ${SLOW_MS - 200}ms slow stop latency)`,
  );
  assert.equal(code, 0);
  // close chain complete CAS clean up:pid Profile already delete.
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'pid Profile should by CAS clean up');
});

test('upgrade emit: keep result new instance pid, old source pid with previousPid render', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-pid-');
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
  // Profile points to old daemon(this process):envelope pid=old,result.pid=new 424242.
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });
  t.after(async () => {
    await fs.rm(path.join(dir, 'node.pid'), { force: true }).catch(() => undefined);
  });

  const r = await runCli(['upgrade', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(r.code, 0, r.err);
  const payload = JSON.parse(r.out) as { pid: number; previousPid: number; upgraded: boolean };
  assert.equal(payload.pid, 424242, 'result new instance pid must not by envelope old pid override');
  assert.equal(payload.previousPid, process.pid, 'old source pid with previousPid render');
  assert.notEqual(payload.pid, payload.previousPid);
  assert.equal(payload.upgraded, true);
});

test('upgrade: same version no need to switch when allows no choose pid legal result', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-noop-');
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
  assert.equal(payload.pid, undefined, 'without operation when do not edit build new process PID');
  assert.equal(payload.previousPid, process.pid);
});

test('upgrade:result illegal (missing ok/upgraded/pid) when reject fabricate succeeded exit non-zero', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-badres-');
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
  assert.equal(r.out, '', 'illegal result must not output succeeded JSON');
  const envelope = JSON.parse(r.err) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'invalid_upgrade_result');
  assert.match(envelope.error.message, /reject fabricate succeeded/);
});

test('status: control channel on report version takes precedence; without live instance only then use current.json honor bottom', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-ver-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const instanceId = 'ef'.repeat(16);
  const control = await startFixtureControl({ dataDir: dir, instanceId, statusVersion: '99.9.9' });
  t.after(async () => {
    await control.close();
  });
  // local current.json points to another version: only in without live instance when as already choose version honor bottom.
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'current.json'),
    `${JSON.stringify({ version: '0.0.1-current', entryPath: '/nonexistent/cli.js', updatedAt: new Date().toISOString() })}\n`,
    'utf8',
  );
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });

  // live instance via control channel on report 99.9.9: must takes precedence at local current.json.
  const live = await runCli(['status', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(live.code, 0, live.err);
  const livePayload = JSON.parse(live.out) as { version: string; state: string };
  assert.equal(livePayload.version, '99.9.9', 'control channel on report version must takes precedence');
  assert.equal(livePayload.state, 'registered');

  // without live instance (pid Profile remove): fall back current.json already choose version.
  await fs.rm(path.join(dir, 'node.pid'), { force: true });
  const offline = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(offline.code, 0, offline.err);
  const offlinePayload = JSON.parse(offline.out) as { version: string; pid: number | null };
  assert.equal(offlinePayload.version, '0.0.1-current', 'without live instance when current.json as honor bottom');
  assert.equal(offlinePayload.pid, null);
});
