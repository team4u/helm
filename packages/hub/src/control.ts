/**
 * Hub-side control channel: every real Hub process listens on a per-boot UDS / Windows named
 * pipe endpoint and answers verified `status` / `stop` requests (`@helmx/env-io` transport).
 *
 * This is what makes `helmx stop` / `restart` / browser-triggered restarts work identically on
 * Linux, macOS, and Windows: instead of guessing at PIDs, the CLI (or the update handoff
 * helper) reads `<dataDir>/hub-control.json` and speaks to the live process, which proves its
 * identity (`instanceId`) before any shutdown path runs. The record is written `0600` and
 * removed on every shutdown path; a stale record is simply unreachable (connect fails) and
 * callers fall back to honest pid-record identity checks.
 *
 * Deadlock note: the channel's own `stop` handling (`runStopAndClose` in env-io) closes the
 * server socket itself after `onStop` resolves, so the shutdown callback passed in here must
 * NOT call this wrapper's `close()` (which awaits the in-flight stop chain). The entrypoint
 * calls `close()` only on the signal path.
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from '@helmx/env-io';
import { controlEndpoint, createControlServer, type ControlServer } from '@helmx/env-io';

/** Endpoint prefix namespacing Hub control sockets (distinct from `helmx-node`). */
export const HUB_CONTROL_PRODUCT = 'helmx-hub';

/** Serving state reported over the control channel (`stopping` is appended by the transport). */
export type HubControlState = 'serving';

export interface HubControlRecord {
  instanceId: string;
  endpoint: string;
  pid: number;
  version: string;
  port: number;
  startedAt: string;
}

export interface HubControlHandle {
  endpoint: string;
  instanceId: string;
  server: ControlServer;
  /** Signal-path shutdown: closes the listener and removes the record. Never call from `requestStop`. */
  close(): Promise<void>;
}

function validateRecord(raw: unknown): HubControlRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = rec[key];
    if (typeof value !== 'string' || value === '') throw new Error(`expected field "${key}" to be a non-empty string`);
    return value;
  };
  const port = rec['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('expected field "port" to be an integer between 1 and 65535');
  }
  const pid = rec['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) throw new Error('expected field "pid" to be a positive integer');
  return { instanceId: str('instanceId'), endpoint: str('endpoint'), pid, version: str('version'), port, startedAt: str('startedAt') };
}

/** Record path inside the Hub data directory (`<dataDir>/hub-control.json`). */
export function hubControlRecordPath(dataDir: string): string {
  return path.join(dataDir, 'hub-control.json');
}

/** Strict reader for CLI / handoff consumers; `null` only on ENOENT. */
export async function readHubControlRecord(dataDir: string): Promise<HubControlRecord | null> {
  const fsp = await import('node:fs/promises');
  let raw: string;
  try {
    raw = await fsp.readFile(hubControlRecordPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`hub control record is corrupt (${hubControlRecordPath(dataDir)}); remove it and retry`);
  }
  return validateRecord(parsed);
}

/** The Hub's own package version (payload builds keep this in lockstep with `current.json`). */
export function hubPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const version: unknown = require(pkgPath)?.version;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`cannot resolve @helmx/hub package version (${pkgPath})`);
  }
  return version;
}

/**
 * Start the control listener and persist the discovery record. `requestStop` performs the full
 * graceful shutdown (heartbeat -> HTTP -> kernel) but must not call the returned `close()`.
 */
export async function startHubControlServer(options: {
  dataDir: string;
  version: string;
  port: number;
  requestStop: () => Promise<void>;
}): Promise<HubControlHandle> {
  const instanceId = randomBytes(16).toString('hex');
  const endpoint = controlEndpoint(options.dataDir, instanceId, HUB_CONTROL_PRODUCT);
  const recordPath = hubControlRecordPath(options.dataDir);
  let channelInitiated = false;
  const removeRecord = async (): Promise<void> => {
    const fsp = await import('node:fs/promises');
    await fsp.rm(recordPath, { force: true }).catch(() => undefined);
  };
  const server = createControlServer({
    endpoint,
    instanceId,
    onStatus: () => ({ pid: process.pid, state: 'serving' satisfies HubControlState, version: options.version }),
    onStop: async (): Promise<void> => {
      // The channel flow (`runStopAndClose`) closes the listener itself after this resolves; mark
      // the origin so the wrapper's `close()` (called from the entrypoint's signal path) turns into
      // a no-op instead of awaiting its own in-flight stop chain.
      channelInitiated = true;
      await options.requestStop();
      await removeRecord();
    },
  });
  try {
    await server.listening;
  } catch (error) {
    await removeRecord();
    throw new Error(
      `cannot listen on the Hub control endpoint ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record: HubControlRecord = {
    instanceId,
    endpoint,
    pid: process.pid,
    version: options.version,
    port: options.port,
    startedAt: new Date().toISOString(),
  };
  await atomicWriteJson(recordPath, record, { mode: 0o600 });
  return {
    endpoint,
    instanceId,
    server,
    close: async (): Promise<void> => {
      if (channelInitiated) return; // channel flow closes the listener and removed the record itself
      await server.close();
      await removeRecord();
    },
  };
}
