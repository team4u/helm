/**
 * Launcher state records: `current.json`, `update-blocked.json`, `hub.pid`, `launch.json`.
 *
 * Semantics mirror the node daemon upgrader's state discipline: JSON is read strictly (explicit
 * errors on corruption, `null` only on ENOENT) and written atomically with mode `0600`. Shapes are
 * launcher-owned; generic update-engine state (if any) stays inside `@helm/update`.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '@helm/env-io';
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

/** Read a JSON record file; `null` only when missing, explicit errors on corruption or bad shape. */
export async function readJsonRecord<T>(file: string, validate: (raw: unknown) => T, label: string): Promise<T | null> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`failed to read ${label} (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is corrupt (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return validate(parsed);
  } catch (error) {
    throw new Error(`${label} failed validation (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJsonRecord(file: string, value: unknown): Promise<void> {
  await atomicWriteJson(file, value, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// current.json — the committed release pointer
// ---------------------------------------------------------------------------

export interface CurrentReleaseRecord {
  version: string;
  /** Immutable release directory (`releases/<ver>/<uuid>`). */
  releaseDir: string;
  /** Absolute path to the payload's `start.mjs` entry. */
  entryPath: string;
  updatedAt: string;
}

function validateCurrent(raw: unknown): CurrentReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const record: CurrentReleaseRecord = {
    version: requireString(rec, 'version'),
    releaseDir: requireString(rec, 'releaseDir'),
    entryPath: requireString(rec, 'entryPath'),
    updatedAt: requireString(rec, 'updatedAt'),
  };
  if (!isStrictSemver(record.version)) throw new Error(`invalid SemVer version: "${record.version}"`);
  return record;
}

export function readCurrentRelease(root: string): Promise<CurrentReleaseRecord | null> {
  return readJsonRecord(pathsOf(root).currentPath, validateCurrent, 'current.json');
}

export async function writeCurrentRelease(root: string, record: CurrentReleaseRecord): Promise<void> {
  validateCurrent(record);
  await writeJsonRecord(pathsOf(root).currentPath, record);
}

export async function deleteCurrentRelease(root: string): Promise<void> {
  await fsp.rm(pathsOf(root).currentPath, { force: true });
}

// ---------------------------------------------------------------------------
// update-blocked.json — cooldown marker for a version that failed its candidate health check
// ---------------------------------------------------------------------------

export interface BlockedReleaseRecord {
  version: string;
  reason: string;
  at: string;
}

function validateBlocked(raw: unknown): BlockedReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  return {
    version: requireString(rec, 'version'),
    reason: requireString(rec, 'reason'),
    at: requireString(rec, 'at'),
  };
}

export function readBlockedRelease(root: string): Promise<BlockedReleaseRecord | null> {
  return readJsonRecord(pathsOf(root).blockedPath, validateBlocked, 'update-blocked.json');
}

export async function writeBlockedRelease(root: string, record: BlockedReleaseRecord): Promise<void> {
  validateBlocked(record);
  await writeJsonRecord(pathsOf(root).blockedPath, record);
}

export async function clearBlockedRelease(root: string): Promise<void> {
  await fsp.rm(pathsOf(root).blockedPath, { force: true });
}

/** True while `blocked` still suppresses attempts at `blocked.version` (cooldown from `at`). */
export function isBlockedActive(blocked: BlockedReleaseRecord, now: Date, cooldownMs: number): boolean {
  const at = Date.parse(blocked.at);
  if (!Number.isFinite(at)) return true; // Unparseable timestamp: keep blocking rather than guessing.
  return now.getTime() - at < cooldownMs;
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
  if (rec['host'] !== undefined) record.host = requireString(rec, 'host');
  if (rec['dataDir'] !== undefined) record.dataDir = requireString(rec, 'dataDir');
  return record;
}

export function readPidRecord(root: string): Promise<HubPidRecord | null> {
  return readJsonRecord(pathsOf(root).pidPath, validatePidRecord, 'hub.pid');
}

export async function writePidRecord(root: string, record: HubPidRecord): Promise<void> {
  validatePidRecord(record);
  await writeJsonRecord(pathsOf(root).pidPath, record);
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
  return readJsonRecord(pathsOf(root).launchConfigPath, validateLaunchConfig, 'launch.json');
}

export async function writeLaunchConfig(root: string, config: LaunchConfig): Promise<void> {
  validateLaunchConfig(config);
  await writeJsonRecord(pathsOf(root).launchConfigPath, config);
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
