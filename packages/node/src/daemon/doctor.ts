/**
 * zero side effect only read self inspect (helm-node doctor).
 *
 * four items check all only read (zero disk write, zero break operation):
 * 1. identity:`<dataDir>/node.json` store in, structure legal (readNodeIdentity) and
 *    non- win32 platform permission is 0600; file missing/corrupt/permission wide all report error and to fix
 *    hint, never output token;
 * 2. privilege: when before account household is root or tool prepare exempt sudo when explicit warn(Agent bash 
 *    own whole machine most high permission, produce/edge environment create protocol subject to limit account household), otherwise ok;
 * 3. hub: to hubUrl start once real /ws/node?nodeId=<id> WebSocket grasp manually, measure
 *    RTT after immediately close connect. only probe to grasp manually layer,**never send register**:Hub register table
 *    by nodeId single connect, same nodeId register will top replace (evict) online guard connect and
 *    mistakenly kill its in-flight command - - diagnose must be pure only read; token valid do not by this check decide,
 *    with daemon itself register/heartbeat result is allow;
 * 4. herdr_ipc: parse local machine Herdr IPC end point and net.connect(1s timeout) probe can reach;
 *    socket missing/not run only mark info(optional capability, do not block assert basis node execute).
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
  /** test can inject permission probe (default check process.getuid?.() === 0 or `sudo -n true`). */
  checkPrivilege?: () => Promise<{ isRoot: boolean; passwordlessSudo: boolean }>;
  /** Hub connect through probe timeout (milli second, by default 5000). */
  connectTimeoutMs?: number;
}

/** exempt sudo probe timeout. */
const SUDO_PROBE_TIMEOUT_MS = 1_500;
/** Herdr IPC probe timeout. */
const HERDR_IPC_PROBE_TIMEOUT_MS = 1_000;

/** run `sudo -n true`(never interaction wait for password); timeout/failed all by do not tool prepare exempt sudo handle. */
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
        // already exit.
      }
      finish(false);
    }, SUDO_PROBE_TIMEOUT_MS);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

/** identity check: store in + structure legal (re- use readNodeIdentity)+ non- win32 permission 0600. */
async function checkIdentity(dataDir: string): Promise<NodeDoctorCheck & { identity: Awaited<ReturnType<typeof readNodeIdentity>> }> {
  const file = path.join(dataDir, 'node.json');
  let identity: Awaited<ReturnType<typeof readNodeIdentity>> = null;
  try {
    identity = await readNodeIdentity(dataDir);
  } catch (error) {
    return {
      id: 'identity',
      status: 'error',
      message: `node identity file cannot read (${error instanceof Error ? error.message : String(error)}); please human confirm after delete ${file} and re- helm-node connect <hubUrl> --token <token> bind set`,
      identity,
    };
  }
  if (identity === null) {
    return {
      id: 'identity',
      status: 'error',
      message: `not found node identity file ${file}; please first helm-node connect <hubUrl> --token <token> bind set JOIN token`,
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
        message: `cannot read identity file permission (${file}):${error instanceof Error ? error.message : String(error)}`,
        identity,
      };
    }
    if (mode !== 0o600) {
      return {
        id: 'identity',
        status: 'error',
        message: `node identity file permission is ${mode.toString(8).padStart(3, '0')}, want seek 0600(contains secret token must not for other user can read); please execute chmod 600 ${file} fix`,
        details: { nodeId: identity.nodeId, mode: mode.toString(8).padStart(3, '0') },
        identity,
      };
    }
    return {
      id: 'identity',
      status: 'ok',
      message: `node identity valid (nodeId=${identity.nodeId}, permission 0600)`,
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

/** privilege check:root / exempt sudo i.e. warn(honest notify Agent bash permission boundary). */
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
        'when before account household tool prepare root or exempt sudo permission,Agent execute bash tool own whole machine most high permission; produce/edge environment create protocol use subject to limit account household run',
      details: { isRoot: probe.isRoot, passwordlessSudo: probe.passwordlessSudo },
    };
  }
  return { id: 'privilege', status: 'ok', message: 'when before account household do not tool prepare root or exempt sudo permission (subject to limit permission run)' };
}

/** hub check: real /ws/node grasp manually (zero parasitic store, zero top replace), measure RTT after immediately close. */
async function checkHub(hubUrl: string, nodeId: string, connectTimeoutMs: number): Promise<NodeDoctorCheck> {
  let parsed: URL;
  try {
    parsed = new URL(hubUrl);
  } catch {
    return { id: 'hub', status: 'error', message: `Hub address cannot parse:${hubUrl}` };
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
        // already close.
      }
      resolve(check);
    };
    const timer = setTimeout(
      () => finish({ id: 'hub', status: 'error', message: `Hub connect through probe timeout (${connectTimeoutMs}ms):${hubUrl}` }),
      connectTimeoutMs,
    );
    socket.once('open', () => {
      const rttMs = Date.now() - started;
      finish({
        id: 'hub',
        status: 'ok',
        // such as declaration probe boundary: only read grasp manually do not validate token (register will top replace online guard connect).
        message: `Hub connect through normal (${hubUrl}, grasp manually to return ${rttMs}ms; only read probe not sent register, do not validate token)`,
        details: { hubUrl, rttMs },
      });
    });
    socket.once('unexpected-response', (_req, res) => {
      try {
        res.resume();
      } catch {
        // ignore.
      }
      finish({ id: 'hub', status: 'error', message: `Hub reject WebSocket grasp manually (HTTP ${res.statusCode}):${hubUrl}`, details: { hubUrl } });
    });
    socket.once('error', (error) => {
      finish({
        id: 'hub',
        status: 'error',
        message: `Hub failed to connect (${error instanceof Error ? error.message : String(error)}):${hubUrl}`,
        details: { hubUrl },
      });
    });
    socket.once('close', () => {
      if (!settled) {
        finish({ id: 'hub', status: 'error', message: `Hub connect in grasp manually complete before close:${hubUrl}`, details: { hubUrl } });
      }
    });
  });
}

/** herdr_ipc check: parse end point and probe can reach (socket missing only info, optional capability). */
async function checkHerdrIpc(env: NodeJS.ProcessEnv): Promise<NodeDoctorCheck> {
  let endpoint: string;
  try {
    endpoint = resolveHerdrIpcEndpoint({}, { getEnv: (k: string) => env[k] });
  } catch (error) {
    return {
      id: 'herdr_ipc',
      status: 'info',
      message: `cannot parse Herdr IPC end point:${error instanceof Error ? error.message : String(error)}`,
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
      () => finish({ id: 'herdr_ipc', status: 'info', message: 'not detect to run in Herdr IPC(optional capability, does not affect basis node execute)', details: { endpoint } }),
      HERDR_IPC_PROBE_TIMEOUT_MS,
    );
    socket.once('connect', () => {
      finish({ id: 'herdr_ipc', status: 'ok', message: `Herdr IPC can reach (${endpoint})`, details: { endpoint } });
    });
    socket.once('error', () => {
      finish({ id: 'herdr_ipc', status: 'info', message: 'not detect to run in Herdr IPC(optional capability, does not affect basis node execute)', details: { endpoint } });
    });
  });
}

/**
 * execute only read self inspect and return report:ok when and only when no any check.status === 'error'
 * (warn and info do not placement false).hubUrl parse priority: explicit parameter > env.HELM_HUB_URL
 * > identity.hubUrl.
 */
export async function runNodeDoctor(options: NodeDoctorOptions = {}): Promise<NodeDoctorReport> {
  const env = options.env ?? process.env;
  const dataDir = resolveNodeDataDir(options.dataDir);
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const checks: NodeDoctorCheck[] = [];

  const identityCheck = await checkIdentity(dataDir);
  // internal identity snapshot (contains token) only used to after continue check, never enter for outside report.
  const { identity: _identity, ...identityPublic } = identityCheck;
  void _identity;
  checks.push(identityPublic);
  const identity = identityCheck.identity;

  checks.push(await checkPrivilege(env, options.checkPrivilege));

  const explicitHub = options.hubUrl !== undefined && options.hubUrl !== '' ? options.hubUrl : undefined;
  const envHub = env['HELM_HUB_URL'] !== undefined && env['HELM_HUB_URL'] !== '' ? env['HELM_HUB_URL'] : undefined;
  const hubUrl = explicitHub ?? envHub ?? identity?.hubUrl;
  if (identity === null || hubUrl === undefined || hubUrl === '') {
    checks.push({
      id: 'hub',
      status: 'error',
      message:
        identity === null
          ? 'identity invalid, cannot enter row Hub connect through probe'
          : 'not config Hub address (--hub, environment variable HELM_HUB_URL or since bind set identity hubUrl)',
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
