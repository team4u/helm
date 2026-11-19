/**
 * Read-only node diagnostics (`helmx-node doctor`; zero disk writes, zero side effects).
 *
 * Checks:
 * 1. `identity`: `<dataDir>/node.json` exists, parses cleanly, and has `0600` permissions on POSIX;
 * 2. `privilege`: warns if running as root or with passwordless `sudo -n true` (Agent bash runs
 *    with the daemon's privileges);
 * 3. `hub`: performs a `/ws/node?nodeId=<id>` WebSocket handshake to measure RTT and closes
 *    immediately **without sending `register`** (which would evict a live daemon session);
 * 4. `herdr_ipc`: probes the local Herdr IPC socket (`info` when absent, since it is optional).
 */

import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { WebSocket } from 'ws';
import { resolveHerdrIpcEndpoint } from './env-rpc-server.js';
import { readNodeIdentity, resolveNodeDataDir } from './index.js';

export type NodeDoctorCheckStatus = 'ok' | 'warn' | 'error' | 'info';

export interface NodeDoctorCheck {
  id: 'identity' | 'privilege' | 'hub' | 'herdr_ipc';
  status: NodeDoctorCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface NodeDoctorReport {
  ok: boolean;
  dataDir: string;
  nodeId?: string;
  hubUrl?: string;
  checks: NodeDoctorCheck[];
}

export interface NodeDoctorOptions {
  dataDir?: string;
  hubUrl?: string;
  env?: NodeJS.ProcessEnv;
  /** Test-only override for privilege checks (defaults to `process.getuid?.() === 0` / `sudo -n true`). */
  checkPrivilege?: () => Promise<{ isRoot: boolean; passwordlessSudo: boolean }>;
  /** Hub WebSocket probe timeout in ms (defaults to 5000). */
  connectTimeoutMs?: number;
}

const SUDO_PROBE_TIMEOUT_MS = 1_500;
const HERDR_IPC_PROBE_TIMEOUT_MS = 1_000;

/** Run `sudo -n true` non-interactively; timeouts and failures report `false`. */
async function probePasswordlessSudo(env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('sudo', ['-n', 'true'], {
        stdio: 'ignore',
        env: { ...process.env, ...env },
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited.
      }
      finish(false);
    }, SUDO_PROBE_TIMEOUT_MS);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

/** Check `<dataDir>/node.json` existence, validity, and `0600` permissions on POSIX. */
async function checkIdentity(dataDir: string): Promise<NodeDoctorCheck & { identity: Awaited<ReturnType<typeof readNodeIdentity>> }> {
  const file = path.join(dataDir, 'node.json');
  let identity: Awaited<ReturnType<typeof readNodeIdentity>> = null;
  try {
    identity = await readNodeIdentity(dataDir);
  } catch (error) {
    return {
      id: 'identity',
      status: 'error',
      message: `node identity file is unreadable (${error instanceof Error ? error.message : String(error)}); inspect and remove ${file}, then re-bind with helmx-node connect <hubUrl> --token <token>`,
      identity,
    };
  }
  if (identity === null) {
    return {
      id: 'identity',
      status: 'error',
      message: `node identity file not found at ${file}; bind a JOIN token first with helmx-node connect <hubUrl> --token <token>`,
      identity,
    };
  }
  if (process.platform !== 'win32') {
    let mode: number;
    try {
      mode = (await fs.stat(file)).mode & 0o777;
    } catch (error) {
      return {
        id: 'identity',
        status: 'error',
        message: `failed to read identity file permissions (${file}): ${error instanceof Error ? error.message : String(error)}`,
        identity,
      };
    }
    if (mode !== 0o600) {
      return {
        id: 'identity',
        status: 'error',
        message: `node identity file permissions are ${mode.toString(8).padStart(3, '0')}, expected 0600 (contains secret token); fix with chmod 600 ${file}`,
        details: { nodeId: identity.nodeId, mode: mode.toString(8).padStart(3, '0') },
        identity,
      };
    }
    return {
      id: 'identity',
      status: 'ok',
      message: `node identity valid (nodeId=${identity.nodeId}, mode 0600)`,
      details: { nodeId: identity.nodeId, mode: '0600' },
      identity,
    };
  }
  return {
    id: 'identity',
    status: 'ok',
    message: `node identity valid (nodeId=${identity.nodeId})`,
    details: { nodeId: identity.nodeId },
    identity,
  };
}

/** Warn if the current user is root or has passwordless sudo. */
async function checkPrivilege(
  env: NodeJS.ProcessEnv,
  injected?: () => Promise<{ isRoot: boolean; passwordlessSudo: boolean }>,
): Promise<NodeDoctorCheck> {
  let probe: { isRoot: boolean; passwordlessSudo: boolean };
  if (injected !== undefined) {
    probe = await injected();
  } else {
    const isRoot = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
    const passwordlessSudo = !isRoot && process.platform !== 'win32' && (await probePasswordlessSudo(env));
    probe = { isRoot, passwordlessSudo };
  }
  if (probe.isRoot || probe.passwordlessSudo) {
    return {
      id: 'privilege',
      status: 'warn',
      message:
        'current account has root or passwordless sudo privileges, granting Agent bash tools full machine access; use an unprivileged account in production or edge environments',
      details: { isRoot: probe.isRoot, passwordlessSudo: probe.passwordlessSudo },
    };
  }
  return {
    id: 'privilege',
    status: 'ok',
    message: 'current account does not have root or passwordless sudo privileges (least-privilege execution)',
  };
}

/** Probe `/ws/node` handshake reachability and RTT without sending `register` (so live daemons are not evicted). */
async function checkHub(hubUrl: string, nodeId: string, connectTimeoutMs: number): Promise<NodeDoctorCheck> {
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    return { id: 'hub', status: 'error', message: `invalid Hub URL: ${hubUrl}` };
  }
  const wsUrl = `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}${parsed.pathname.replace(/\/+$/, '')}/ws/node?nodeId=${encodeURIComponent(nodeId)}`;
  return await new Promise<NodeDoctorCheck>((resolve) => {
    let settled = false;
    const started = Date.now();
    const socket = new WebSocket(wsUrl);
    const finish = (check: NodeDoctorCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        // Already closed.
      }
      resolve(check);
    };
    const timer = setTimeout(
      () => finish({ id: 'hub', status: 'error', message: `Hub reachability probe timed out (${connectTimeoutMs}ms): ${hubUrl}` }),
      connectTimeoutMs,
    );
    socket.once('open', () => {
      const rttMs = Date.now() - started;
      finish({
        id: 'hub',
        status: 'ok',
        message: `Hub reachable (${hubUrl}, handshake RTT ${rttMs}ms; read-only probe without register — token not validated)`,
        details: { hubUrl, rttMs },
      });
    });
    socket.once('unexpected-response', (_req, res) => {
      try {
        res.resume();
      } catch {
        // Ignore.
      }
      finish({ id: 'hub', status: 'error', message: `Hub rejected WebSocket handshake (HTTP ${res.statusCode}): ${hubUrl}`, details: { hubUrl } });
    });
    socket.once('error', (error) => {
      finish({
        id: 'hub',
        status: 'error',
        message: `failed to connect to Hub (${error instanceof Error ? error.message : String(error)}): ${hubUrl}`,
        details: { hubUrl },
      });
    });
    socket.once('close', () => {
      if (!settled) {
        finish({ id: 'hub', status: 'error', message: `Hub connection closed before handshake completed: ${hubUrl}`, details: { hubUrl } });
      }
    });
  });
}

/** Probe local Herdr IPC socket reachability (`info` when absent, since Herdr is optional). */
async function checkHerdrIpc(env: NodeJS.ProcessEnv): Promise<NodeDoctorCheck> {
  let endpoint: string;
  try {
    endpoint = resolveHerdrIpcEndpoint({}, { getEnv: (k: string) => env[k] });
  } catch (error) {
    return {
      id: 'herdr_ipc',
      status: 'info',
      message: `unable to resolve Herdr IPC endpoint: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return await new Promise<NodeDoctorCheck>((resolve) => {
    let settled = false;
    const socket = net.connect(endpoint);
    const finish = (check: NodeDoctorCheck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(check);
    };
    const timer = setTimeout(
      () => finish({ id: 'herdr_ipc', status: 'info', message: 'running Herdr IPC not detected (optional capability; does not affect core node execution)', details: { endpoint } }),
      HERDR_IPC_PROBE_TIMEOUT_MS,
    );
    socket.once('connect', () => {
      finish({ id: 'herdr_ipc', status: 'ok', message: `Herdr IPC reachable (${endpoint})`, details: { endpoint } });
    });
    socket.once('error', () => {
      finish({ id: 'herdr_ipc', status: 'info', message: 'running Herdr IPC not detected (optional capability; does not affect core node execution)', details: { endpoint } });
    });
  });
}

/**
 * Run read-only diagnostics and return a report (`ok` is true iff no check has status `'error'`).
 * `hubUrl` precedence: explicit option -> `env.HELMX_HUB_URL` -> `identity.hubUrl`.
 */
export async function runNodeDoctor(options: NodeDoctorOptions = {}): Promise<NodeDoctorReport> {
  const env = options.env ?? process.env;
  const dataDir = resolveNodeDataDir(options.dataDir);
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const checks: NodeDoctorCheck[] = [];

  const identityCheck = await checkIdentity(dataDir);
  // Strip private identity snapshot (contains token) before adding check to report.
  const { identity: _identity, ...identityPublic } = identityCheck;
  void _identity;
  checks.push(identityPublic);
  const identity = identityCheck.identity;

  checks.push(await checkPrivilege(env, options.checkPrivilege));

  const explicitHub = options.hubUrl !== undefined && options.hubUrl !== '' ? options.hubUrl : undefined;
  const envHub = env['HELMX_HUB_URL'] !== undefined && env['HELMX_HUB_URL'] !== '' ? env['HELMX_HUB_URL'] : undefined;
  const hubUrl = explicitHub ?? envHub ?? identity?.hubUrl;
  if (identity === null || hubUrl === undefined || hubUrl === '') {
    checks.push({
      id: 'hub',
      status: 'error',
      message:
        identity === null
          ? 'identity invalid; skipping Hub reachability probe'
          : 'Hub URL not configured (pass --hub, set HELMX_HUB_URL, or bind via helmx-node connect)',
    });
  } else {
    checks.push(await checkHub(hubUrl, identity.nodeId, connectTimeoutMs));
  }

  checks.push(await checkHerdrIpc(env));

  return {
    ok: !checks.some((check) => check.status === 'error'),
    dataDir,
    ...(identity !== null ? { nodeId: identity.nodeId } : {}),
    ...(hubUrl !== undefined ? { hubUrl } : {}),
    checks,
  };
}
