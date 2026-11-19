/**
 * Launcher-owned state records: `hub.pid` (detached process identity) and `launch.json` (sticky
 * launch configuration). Release pointers (`current.json`) and cooldown markers
 * (`update-blocked.json`) are owned by the shared update engine (`@helmx/env-io`) and used from there — the launcher keeps no
 * second copy of engine state. JSON reads are strict (explicit errors on corruption, `null` only
 * on ENOENT via the engine's `readStateJson`); writes are atomic (`0600`).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { atomicWriteJson } from '@helmx/env-io';
import { readStateJson } from '@helmx/env-io';
import { isStrictSemver } from '@helmx/protocol';
import { pathsOf } from './layout.js';

function requireString(rec: Record<string, unknown>, key: string): string {
  const value = rec[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`expected field "${key}" to be a non-empty string`);
  }
  return value;
}

function requirePort(rec: Record<string, unknown>, key: string): number {
  const value = rec[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`expected field "${key}" to be an integer port between 1 and 65535`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// hub.pid — identity of the detached Hub process owned by this launcher
// ---------------------------------------------------------------------------

export interface HubPidRecord {
  pid: number;
  launchId?: string;
  version: string;
  entryPath: string;
  port: number;
  host?: string;
  dataDir?: string;
  startedAt: string;
  /**
   * Linux `/proc/<pid>/stat` start time (field 22, clock ticks since boot), captured at spawn.
   * Immutable for a pid's lifetime: a mismatch on stop proves pid reuse and blocks signalling.
   * Absent on platforms without `/proc`, where cross-process stop is unavailable.
   */
  startTime?: number;
}

function validatePidRecord(raw: unknown): HubPidRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const pid = rec['pid'];
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error('expected field "pid" to be a positive integer');
  }
  const record: HubPidRecord = {
    pid,
    version: requireString(rec, 'version'),
    entryPath: requireString(rec, 'entryPath'),
    port: requirePort(rec, 'port'),
    startedAt: requireString(rec, 'startedAt'),
  };
  if (!isStrictSemver(record.version)) throw new Error(`invalid SemVer version: "${record.version}"`);
  if (rec['launchId'] !== undefined) record.launchId = requireString(rec, 'launchId');
  if (rec['host'] !== undefined) record.host = requireString(rec, 'host');
  if (rec['dataDir'] !== undefined) record.dataDir = requireString(rec, 'dataDir');
  if (rec['startTime'] !== undefined) {
    const startTime = rec['startTime'];
    if (typeof startTime !== 'number' || !Number.isInteger(startTime) || startTime < 0) {
      throw new Error('expected field "startTime" to be a non-negative integer');
    }
    record.startTime = startTime;
  }
  return record;
}

export function readPidRecord(root: string): Promise<HubPidRecord | null> {
  return readStateJson(pathsOf(root).pidPath, validatePidRecord, 'hub.pid');
}

export async function writePidRecord(root: string, record: HubPidRecord): Promise<void> {
  validatePidRecord(record);
  await atomicWriteJson(pathsOf(root).pidPath, record, { mode: 0o600 });
}

/** Canonical JSON with recursively sorted keys (order-insensitive record comparison). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Remove the pid file only if it still describes `record` (compare-and-swap against replacements). */
export async function removePidFileIfMatch(root: string, record: HubPidRecord): Promise<boolean> {
  const current = await readPidRecord(root);
  if (current === null || stableStringify(current) !== stableStringify(record)) return false;
  await fsp.rm(pathsOf(root).pidPath, { force: true });
  return true;
}

/** True while `blocked` still suppresses attempts at `blocked.version` (cooldown from `at`). */
export function isBlockedActive(blocked: { version: string; reason: string; at: string }, now: Date, cooldownMs: number): boolean {
  const at = Date.parse(blocked.at);
  if (!Number.isFinite(at)) return true; // Unparseable timestamp: keep blocking rather than guessing.
  return now.getTime() - at < cooldownMs;
}

// ---------------------------------------------------------------------------
// launch.json — sticky launch configuration (explicit values only, never secrets)
// ---------------------------------------------------------------------------

export interface LaunchConfig {
  port?: number;
  host?: string;
  dataDir?: string;
  model?: string;
  webDistDir?: string;
}

export interface EffectiveLaunchConfig {
  port: number;
  host: string;
  dataDir?: string;
  model?: string;
  webDistDir?: string;
}

function validateLaunchConfig(raw: unknown): LaunchConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const config: LaunchConfig = {};
  if (rec['port'] !== undefined) config.port = requirePort(rec, 'port');
  for (const key of ['host', 'dataDir', 'model', 'webDistDir'] as const) {
    if (rec[key] !== undefined) config[key] = requireString(rec, key);
  }
  return config;
}

export function readLaunchConfig(root: string): Promise<LaunchConfig | null> {
  return readStateJson(pathsOf(root).launchConfigPath, validateLaunchConfig, 'launch.json');
}

export async function writeLaunchConfig(root: string, config: LaunchConfig): Promise<void> {
  validateLaunchConfig(config);
  await atomicWriteJson(pathsOf(root).launchConfigPath, config, { mode: 0o600 });
}

function parsePortEnv(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535 (got "${value}")`);
  }
  return parsed;
}

/**
 * Resolve the effective launch configuration. Precedence: explicit flags > environment variables
 * (`HELMX_PORT`, `HELMX_HOST`, `HELMX_DATA_DIR`, `HELMX_MODEL`, `HELMX_WEB_DIST_DIR`) > persisted
 * `launch.json` > product defaults (port 3202, loopback host). `HELMX_WEB_DIST_DIR=false` disables
 * static hosting (matches `@helmx/hub` semantics).
 */
export function resolveEffectiveLaunchConfig(input: {
  flags?: LaunchConfig;
  env: NodeJS.ProcessEnv;
  saved?: LaunchConfig | null;
}): EffectiveLaunchConfig {
  const flags = input.flags ?? {};
  const saved = input.saved ?? {};
  const port = flags.port ?? parsePortEnv(input.env.HELMX_PORT, 'HELMX_PORT') ?? saved.port ?? 3202;
  const host = flags.host ?? nonEmpty(input.env.HELMX_HOST) ?? saved.host ?? '127.0.0.1';
  const dataDir = flags.dataDir ?? nonEmpty(input.env.HELMX_DATA_DIR) ?? saved.dataDir;
  const model = flags.model ?? nonEmpty(input.env.HELMX_MODEL) ?? saved.model;
  const webDistEnv = nonEmpty(input.env.HELMX_WEB_DIST_DIR);
  const webDistDir = flags.webDistDir ?? webDistEnv ?? saved.webDistDir;
  const resolved: EffectiveLaunchConfig = { port, host };
  if (dataDir !== undefined) resolved.dataDir = dataDir;
  if (model !== undefined) resolved.model = model;
  // `false`/`0`/'' explicitly disables static hosting; a real path is passed through as-is.
  if (webDistDir !== undefined && webDistDir !== 'false' && webDistDir !== '0') resolved.webDistDir = webDistDir;
  else if (webDistDir !== undefined) resolved.webDistDir = 'false';
  return resolved;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

/** Extract the explicitly-configured subset to persist in `launch.json` after a successful start. */
export function persistableLaunchConfig(config: EffectiveLaunchConfig): LaunchConfig {
  const persisted: LaunchConfig = { port: config.port, host: config.host };
  if (config.dataDir !== undefined) persisted.dataDir = config.dataDir;
  if (config.model !== undefined) persisted.model = config.model;
  if (config.webDistDir !== undefined) persisted.webDistDir = config.webDistDir;
  return persisted;
}

// ---------------------------------------------------------------------------
// pid identity proof — Linux /proc start time
// ---------------------------------------------------------------------------

/**
 * Parse the start-time field (22) out of a `/proc/<pid>/stat` line. The `comm` field may contain
 * spaces and parentheses, so fields are counted after the final `)`. `null` when the content does
 * not look like a stat line (explicit, never guessed).
 */
export function parseLinuxStartTime(statContent: string): number | null {
  const close = statContent.lastIndexOf(')');
  if (close === -1) return null;
  const fields = statContent.slice(close + 2).trim().split(/\s+/);
  // fields[0] is `state` (field 3 overall); start time is field 22 → index 19.
  const raw = fields[19];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Current start time of `pid` on Linux, or `null` on platforms without `/proc` and when the pid
 * cannot be read. A recorded start time plus a matching current value proves the pid was not
 * reused; a mismatch proves it was.
 */
export async function readProcessStartTime(pid: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    return parseLinuxStartTime(await fsp.readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

/** Resolve a release entry path relative to its release directory (traversal-checked). */
export function resolveInsideRelease(releaseDir: string, relative: string, label: string): string {
  if (typeof relative !== 'string' || relative === '') {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const resolved = path.resolve(releaseDir, relative);
  if (resolved !== releaseDir && !resolved.startsWith(releaseDir + path.sep)) {
    throw new Error(`${label} escapes the release directory: ${relative} (resolved to ${resolved})`);
  }
  return resolved;
}

/** Entry existence check helper (explicit corruption errors instead of silent fallbacks). */
export async function assertEntryExists(entryPath: string, context: string): Promise<void> {
  try {
    await fsp.access(entryPath);
  } catch {
    throw new Error(
      `${context} points to a missing entry (${entryPath}): staged release may be corrupted; fix current.json or re-run the update instead of guessing another entry`,
    );
  }
}
