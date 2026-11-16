/**
 * desktop shell smoke entry (pure Node, without GUI dependency): real kernel dist Hub end-to-end verify.
 *
 * verify chain: config parse → run capability probe → attach-or-spawn(expectation owned)→ Hub identity probe →
 * SIGKILL crash → supervise automatically restart → graceful stop → port release.
 * pre-: repository execute pnpm build(packages/hub/dist/main.js store in).
 * data isolated:dataDir use temp directory, port use temporary allocate port, never trigger touch 3202 and ~/.helm.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveDesktopConfig, defaultHubEntryPath } from './config.js';
import { probeRunner, KERNEL_NODE_FLOOR, probeMeetsFloor } from './runners.js';
import { HubSupervisor } from './supervisor.js';
import { DesktopError } from './errors.js';

function log(line: string): void {
  process.stdout.write(`[desktop-smoke] ${line}\n`);
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('cannot allocate temporary port'))));
    });
    server.once('error', reject);
  });
}

async function waitFor(description: string, check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(200);
  }
  log(`wait timed out: ${description}`);
  return false;
}

async function main(): Promise<number> {
  const hubEntry = defaultHubEntryPath();
  const probe = await probeRunner(process.execPath);
  log(`host Node ${probe.node}(sqlite=${probe.sqlite},floor=${KERNEL_NODE_FLOOR}, reach mark=${probeMeetsFloor(probe)})`);
  if (!probeMeetsFloor(probe)) {
    log(`host Node do not satisfy kernel need to (>= ${KERNEL_NODE_FLOOR} and node:sqlite), abort`);
    return 1;
  }

  const port = await pickFreePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-desktop-smoke-'));
  const cleanEnv: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: dataDir, // isolated any HOME each other for fall back
    LANG: process.env['LANG'],
  };
  const config = resolveDesktopConfig(cleanEnv, {
    port,
    dataDir,
    readyTimeoutMs: 30_000,
    probeIntervalMs: 150,
    restartBackoffMs: 200,
    restartBackoffMaxMs: 800,
    stableMs: 60_000,
    stopGraceMs: 4_000,
  });
  log(`port ${port}, temporary data directory ${dataDir}`);

  const events: string[] = [];
  const supervisor = new HubSupervisor({
    config,
    env: cleanEnv,
    events: {
      stateChange: (next, prev) => events.push(`${prev}->${next}`),
      runnerSelected: (info) => log(`run: ${info.kind} ${info.command.join(' ')}`),
      restartScheduled: (attempt) => log(`crash restart #${attempt}`),
    },
  });

  let failures = 0;
  try {
    try {
      const result = await supervisor.start();
      log(`start: mode=${result.mode} hub=${result.hubUrl}`);
      if (result.mode === 'attached') {
        log('unexpected attach to external Hub(temporary port must not has service), treated as failed');
        return 1;
      }
    } catch (error) {
      if (error instanceof DesktopError && (error.code === 'hub_entry_missing' || error.code === 'payload_entry_missing')) {
        log(`Hub entry missing: ${hubEntry}; first in repository execute pnpm build`);
        return 2;
      }
      throw error;
    }

    const identity = await fetch(`${config.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(2_000) });
    const body = (await identity.json()) as { configured?: unknown };
    if (identity.status === 200 && typeof body.configured === 'boolean') {
      log(`Hub identity probe via: /api/auth/status -> ${JSON.stringify(body)}`);
    } else {
      log(`Hub identity probe exception: ${identity.status} ${JSON.stringify(body)}`);
      failures += 1;
    }

    // crash self-heal:SIGKILL owned child process, wait for supervise restart and re- ready.
    const pidBefore = supervisor.childPid;
    if (pidBefore === undefined) {
      log('without child process pid, skip crash test');
      failures += 1;
    } else {
      process.kill(pidBefore, 'SIGKILL');
      const recovered = await waitFor('crash after restart ready', async () => {
        if (supervisor.state !== 'owned') return false;
        if (supervisor.childPid === pidBefore) return false;
        try {
          const response = await fetch(`${config.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(1_000) });
          return response.ok;
        } catch {
          return false;
        }
      }, 30_000);
      log(recovered ? 'crash self-heal via: new child process ready' : 'crash self-heal failed');
      if (!recovered) failures += 1;
    }

    await supervisor.stop();
    const hubGone = await waitFor('stop backend opening release', async () => {
      try {
        await fetch(`${config.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(500) });
        return false;
      } catch {
        return true;
      }
    }, 10_000);
    log(hubGone ? 'graceful stop via: port already release' : 'stop failed: port still can access');
    if (!hubGone) failures += 1;

    log(`state trace: ${events.join(' ')}`);
    log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL(${failures} items not via)`);
    return failures === 0 ? 0 : 1;
  } finally {
    await supervisor.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

void main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`[desktop-smoke] failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
