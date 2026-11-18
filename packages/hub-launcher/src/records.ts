/**
 * Launcher-owned state records: `hub.pid` (detached process identity) and `launch.json` (sticky
 * launch configuration). Release pointers (`current.json`) and cooldown markers
 * (`update-blocked.json`) are owned by `@helm/update` and used from there — the launcher keeps no
 * second copy of engine state. JSON reads are strict (explicit errors on corruption, `null` only
 * on ENOENT via `@helm/update`'s `readStateJson`); writes are atomic (`0600`).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '@helm/env-io';
import { readStateJson } from '@helm/update';
import { isStrictSemver } from '@helm/protocol';
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
  version: string;
  entryPath: string;
  port: number;
  host?: string;
  dataDir?: string;
  startedAt: string;
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
  if (rec['host'] !== undefined) record.host = requireString(rec, 'host');
  if (rec['dataDir'] !== undefined) record.dataDir = requireString(rec, 'dataDir');
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
 * (`HELM_PORT`, `HELM_HOST`, `HELM_DATA_DIR`, `HELM_MODEL`, `HELM_WEB_DIST_DIR`) > persisted
 * `launch.json` > product defaults (port 3202, loopback host). `HELM_WEB_DIST_DIR=false` disables
 * static hosting (matches `@helm/hub` semantics).
 */
export function resolveEffectiveLaunchConfig(input: {
  flags?: LaunchConfig;
  env: NodeJS.ProcessEnv;
  saved?: LaunchConfig | null;
}): EffectiveLaunchConfig {
  const flags = input.flags ?? {};
  const saved = input.saved ?? {};
  const port = flags.port ?? parsePortEnv(input.env.HELM_PORT, 'HELM_PORT') ?? saved.port ?? 3202;
  const host = flags.host ?? nonEmpty(input.env.HELM_HOST) ?? saved.host ?? '127.0.0.1';
  const dataDir = flags.dataDir ?? nonEmpty(input.env.HELM_DATA_DIR) ?? saved.dataDir;
  const model = flags.model ?? nonEmpty(input.env.HELM_MODEL) ?? saved.model;
  const webDistEnv = nonEmpty(input.env.HELM_WEB_DIST_DIR);
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
