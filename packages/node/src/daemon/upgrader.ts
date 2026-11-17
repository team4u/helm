/**
 * `helm-node` self-upgrade engine: atomic dual-package (`@helm/node` + `@helm/cli`) release staging
 * and replacement handoff.
 *
 * - Stages immutable release directories under `releases/<ver>/<uuid>/` verified against registry
 *   SHA-512 SRI integrity before offline npm installation, marked with `.complete`.
 * - Persists `current.json` / `update-blocked.json` atomically (`0600`), throwing explicitly on
 *   corruption or I/O errors (`null` only on `ENOENT`).
 * - Commits strictly at `replacement.commit()`, rolling back and writing cooldown blocks on failure,
 *   while refusing rollback on `UpgradeCommitUnconfirmedError`.
 */
import fs, { type FileHandle } from 'node:fs/promises';
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  compareStrictSemver as compareStrictSemverShared,
  isStrictSemver,
  stripSemverVPrefix,
  type NodeUpgradeCheckResult,
  type NodeUpgradeResult,
} from '@helm/protocol';
import { killProcessTree } from './local-env.js';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Policy/input rejection (callers map to 4xx / RPC `invalid`). */
export class UpgradeRejectedError extends Error {}

/**
 * Thrown when `activate` was written to the candidate IPC channel, so the candidate may have already
 * committed to the Hub while local confirmation was lost. Callers must NOT abort or roll back.
 */
export class UpgradeCommitUnconfirmedError extends Error {}

export interface StagedNodeRelease {
  version: string;
  /** Immutable release directory (`releases/<ver>/<uuid>`). */
  releaseDir: string;
  /** Absolute path to `@helm/node`'s `dist/cli.js` entrypoint. */
  entryPath: string;
  /** Absolute path to `node_modules/.bin` containing the staged `helm` CLI binary. */
  cliBinDir: string;
}

export interface PreparedNodeReplacement {
  pid: number;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface PerformNodeUpgradeOptions {
  targetVersion?: string;
  registryUrl?: string;
  force?: boolean;
  attemptId?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
  stageExtractor?: (stagingDir: string, targetVersion: string) => Promise<{ entryPath: string; cliBinDir: string }>;
  prepareReplacement?: (
    release: StagedNodeRelease,
    context: { attemptId: string; previousVersion: string; targetVersion: string },
  ) => Promise<PreparedNodeReplacement>;
  /** Returns count of in-flight operations to drain before spawning replacement. */
  getActiveExecCount?: () => number;
  setDraining?: (value: boolean) => void;
  drainTimeoutMs?: number;
  onScheduleShutdown?: (pid: number) => void;
}

export interface StageReleaseOptions {
  registryUrl?: string;
  fetchFn?: typeof fetch;
  /** Test-only extractor returning relative paths inside `stagingDir` (validated against traversal). */
  stageExtractor?: (stagingDir: string, targetVersion: string) => Promise<{ entryPath: string; cliBinDir: string }>;
  /** Bypass `.complete` cache and build a new immutable release directory without deleting older ones. */
  force?: boolean;
}

export interface CheckNodeUpgradeOptions {
  registryUrl?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
}

export interface CurrentReleaseRecord {
  version: string;
  entryPath: string;
  updatedAt: string;
  cliBinDir?: string;
}

export interface BlockedReleaseRecord {
  version: string;
  reason: string;
  at: string;
}

function requireStrictVersion(input: string, label: string): void {
  if (!isStrictSemver(input)) {
    throw new UpgradeRejectedError(
      `invalid SemVer version (${label}): "${input}" (expected strict x.y.z[-pre][+build] without v prefix)`,
    );
  }
}

/** Strict SemVer comparison; throws `UpgradeRejectedError` on invalid input. */
export function compareSemver(a: string, b: string): number {
  requireStrictVersion(a, 'a');
  requireStrictVersion(b, 'b');
  return compareStrictSemverShared(a, b);
}

/** Trim whitespace, strip an optional leading `v`/`V`, and validate strict SemVer. */
export function normalizeTargetVersion(input: string): string {
  const trimmed = stripSemverVPrefix(input);
  requireStrictVersion(trimmed, 'targetVersion');
  return trimmed;
}

let cachedPackageVersion: string | undefined;

/** Read `@helm/node`'s own `package.json` version (`HELM_VERSION_OVERRIDE` overrides for dev). */
export function getNodeVersion(): string {
  const override = process.env.HELM_VERSION_OVERRIDE?.trim();
  if (override) return override;
  if (!cachedPackageVersion) {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    let version: string;
    try {
      const parsed = JSON.parse(rawFs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version !== 'string' || !isStrictSemver(parsed.version)) {
        throw new Error(`version field missing or invalid: ${JSON.stringify(parsed.version)}`);
      }
      version = parsed.version;
    } catch (error) {
      throw new Error(`failed to read @helm/node version (${pkgPath}): ${error instanceof Error ? error.message : String(error)}`);
    }
    cachedPackageVersion = version;
  }
  return cachedPackageVersion;
}

/** Resolve effective node version for offline CLI status: `current.json` takes precedence over own package version. */
export async function resolveEffectiveNodeVersion(dataDir: string): Promise<string> {
  const current = await readCurrentRelease(dataDir);
  return current?.version ?? getNodeVersion();
}

const normalizeRegistry = (url: string | undefined): string => (url ?? '').trim().replace(/\/+$/, '');

/**
 * RPC registry allowlist: permits only the official npm registry or `HELM_NPM_REGISTRY`.
 * Rejects any other explicit URL with `UpgradeRejectedError`.
 */
export function filterRpcRegistryUrl(registryUrl?: string): string | undefined {
  const requested = normalizeRegistry(registryUrl);
  if (!requested) return undefined;
  if (requested === DEFAULT_REGISTRY) return requested;
  const envRegistry = normalizeRegistry(process.env.HELM_NPM_REGISTRY);
  if (envRegistry && requested === envRegistry) return requested;
  throw new UpgradeRejectedError(
    `untrusted npm registry rejected: ${requested} (only ${DEFAULT_REGISTRY} or HELM_NPM_REGISTRY is permitted)`,
  );
}

function resolveRegistryUrl(explicit?: string): string {
  return normalizeRegistry(explicit || process.env.HELM_NPM_REGISTRY || DEFAULT_REGISTRY);
}

async function readJsonRecord<T>(filePath: string, validate: (raw: unknown) => T, label: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(`failed to read ${label} (${filePath}): ${code ?? (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    return validate(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${label} is corrupt (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Atomic `0600` JSON write via sibling temporary file + rename. */
async function writeSecureJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw new Error(`failed to write ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`field ${key} is missing or not a non-empty string`);
  }
  return value;
}

function validateCurrentRecord(raw: unknown): CurrentReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const record: CurrentReleaseRecord = {
    version: requireString(rec, 'version'),
    entryPath: requireString(rec, 'entryPath'),
    updatedAt: requireString(rec, 'updatedAt'),
  };
  if (rec.cliBinDir !== undefined && typeof rec.cliBinDir !== 'string') {
    throw new Error('field cliBinDir must be a string');
  }
  return rec.cliBinDir === undefined ? record : { ...record, cliBinDir: rec.cliBinDir };
}

function validateBlockedRecord(raw: unknown): BlockedReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  return {
    version: requireString(rec, 'version'),
    reason: requireString(rec, 'reason'),
    at: requireString(rec, 'at'),
  };
}

const currentReleasePath = (dataDir: string) => path.join(dataDir, 'current.json');
const blockedReleasePath = (dataDir: string) => path.join(dataDir, 'update-blocked.json');

export async function readCurrentRelease(dataDir: string): Promise<CurrentReleaseRecord | null> {
  return readJsonRecord(currentReleasePath(dataDir), validateCurrentRecord, 'current.json');
}

export async function writeCurrentRelease(dataDir: string, record: CurrentReleaseRecord): Promise<void> {
  validateCurrentRecord(record as unknown);
  await writeSecureJson(currentReleasePath(dataDir), record);
}

export async function deleteCurrentRelease(dataDir: string): Promise<void> {
  await fs.rm(currentReleasePath(dataDir), { force: true });
}

export async function readBlockedRelease(dataDir: string): Promise<BlockedReleaseRecord | null> {
  return readJsonRecord(blockedReleasePath(dataDir), validateBlockedRecord, 'update-blocked.json');
}

export async function writeBlockedRelease(dataDir: string, record: BlockedReleaseRecord): Promise<void> {
  validateBlockedRecord(record);
  await writeSecureJson(blockedReleasePath(dataDir), record);
}

export async function clearBlockedRelease(dataDir: string): Promise<void> {
  await fs.rm(blockedReleasePath(dataDir), { force: true });
}

export async function checkNodeUpgrade(
  dataDir: string,
  options?: CheckNodeUpgradeOptions,
): Promise<NodeUpgradeCheckResult> {
  const registryUrl = resolveRegistryUrl(options?.registryUrl);
  const pkgName = process.env.HELM_NPM_PACKAGE || '@helm/node';
  const fetchImpl = options?.fetchFn ?? fetch;
  const url = `${registryUrl}/${pkgName}/latest`;

  let latestVersion: string;
  try {
    const data = (await fetchJsonWithTimeout(url, fetchImpl, METADATA_TIMEOUT_MS)) as { version?: unknown };
    if (typeof data.version !== 'string') {
      throw new Error(`response missing version field: ${JSON.stringify(data).slice(0, 200)}`);
    }
    latestVersion = data.version;
  } catch (error) {
    throw new Error(`failed to query latest version at ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  requireStrictVersion(latestVersion, 'latest');

  const currentVersion =
    options?.currentVersion ?? (await readCurrentRelease(dataDir))?.version ?? getNodeVersion();
  const blocked = (await readBlockedRelease(dataDir)) || undefined;

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    ...(blocked ? { blocked } : {}),
  };
}

const METADATA_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 180_000;
const NPM_INSTALL_TIMEOUT_MS = 300_000;
const NPM_OUTPUT_DIAG_LINES = 40;

async function fetchJsonWithTimeout(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`request timed out (${timeoutMs}ms)`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTarballWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  destPath: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const body = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(destPath, body, { mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`download timed out (${timeoutMs}ms)`);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

interface RegistryManifest {
  integrity: string;
  tarball: string;
}

async function fetchExactManifest(
  registryUrl: string,
  pkgName: string,
  version: string,
  fetchImpl: typeof fetch,
): Promise<RegistryManifest> {
  const url = `${registryUrl}/${pkgName}/${version}`;
  let data: { name?: unknown; version?: unknown; dist?: { integrity?: unknown; tarball?: unknown } };
  try {
    data = (await fetchJsonWithTimeout(url, fetchImpl, METADATA_TIMEOUT_MS)) as typeof data;
  } catch (error) {
    throw new Error(`failed to fetch ${pkgName}@${version} metadata (${url}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (data.name !== pkgName) {
    throw new Error(`registry metadata package name mismatch: expected ${pkgName}, got ${JSON.stringify(data.name)}`);
  }
  if (data.version !== version) {
    throw new Error(`registry metadata version mismatch: expected ${version}, got ${JSON.stringify(data.version)}`);
  }
  const integrity = data.dist?.integrity;
  const tarball = data.dist?.tarball;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`${pkgName}@${version} metadata missing valid sha512 dist.integrity`);
  }
  if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) {
    throw new Error(`${pkgName}@${version} metadata missing valid dist.tarball`);
  }
  return { integrity, tarball };
}

function computeSri(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = rawFs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(`sha512-${hash.digest('base64')}`));
  });
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  return lines.slice(-count).join('\n');
}

/**
 * Resolve npm invocation without shell interpolation: on Windows, Node prohibits direct `spawn`
 * of `.cmd` with `shell: false`, so locate `node_modules/npm/bin/npm-cli.js` beside `process.execPath`.
 */
function resolveNpmCommand(): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(execDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cliJs of candidates) {
    if (rawFs.existsSync(cliJs)) return { command: process.execPath, args: [cliJs] };
  }
  throw new Error(
    `unable to locate npm entrypoint npm-cli.js (tried: ${candidates.join(' ; ')}); cannot spawn npm.cmd directly without a shell`,
  );
}

/** Run npm with a hard timeout, killing the entire process group via `killProcessTree` on expiry. */
export function runNpm(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  let npm: { command: string; args: string[] };
  try {
    npm = resolveNpmCommand();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const fullArgs = [...npm.args, ...args];
  const displayCmd = `npm ${args[0]}`;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(npm.command, fullArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      reject(new Error(`failed to spawn ${displayCmd} (${npm.command}): ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 400_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 400_000) stderr += chunk.toString('utf8');
    });
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
      reject(new Error(`${displayCmd} timed out (${timeoutMs}ms) and was terminated; last ${NPM_OUTPUT_DIAG_LINES} lines:\n${lastLines(`${stdout}\n${stderr}`, NPM_OUTPUT_DIAG_LINES)}`));
    }, timeoutMs);
    child.on('error', (error) => finish(new Error(`${displayCmd} failed to start: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish(null);
      else {
        finish(
          new Error(
            `${displayCmd} failed with exit code ${code}; last ${NPM_OUTPUT_DIAG_LINES} lines:\n${lastLines(`${stdout}\n${stderr}`, NPM_OUTPUT_DIAG_LINES)}`,
          ),
        );
      }
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface CompleteMarker {
  version: string;
  candidateDir: string;
  entryPath: string;
  cliBinDir: string;
  completedAt: string;
  origin?: 'npm' | 'extractor';
}

function validateCompleteMarker(raw: unknown): CompleteMarker {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const marker: CompleteMarker = {
    version: requireString(rec, 'version'),
    candidateDir: requireString(rec, 'candidateDir'),
    entryPath: requireString(rec, 'entryPath'),
    cliBinDir: requireString(rec, 'cliBinDir'),
    completedAt: requireString(rec, 'completedAt'),
  };
  if (rec.origin !== undefined && rec.origin !== 'npm' && rec.origin !== 'extractor') {
    throw new Error(`invalid field origin: ${JSON.stringify(rec.origin)}`);
  }
  return rec.origin === undefined ? marker : { ...marker, origin: rec.origin };
}

/** Validate that `stageExtractor`-returned relative paths remain inside `stagingDir`. */
function resolveInside(stagingDir: string, relative: string, label: string): string {
  if (typeof relative !== 'string' || relative === '') {
    throw new Error(`stageExtractor returned ${label} that is not a non-empty string`);
  }
  if (path.isAbsolute(relative)) {
    throw new Error(`stageExtractor returned absolute path for ${label}, expected relative: ${relative}`);
  }
  const resolved = path.resolve(stagingDir, relative);
  if (resolved !== stagingDir && !resolved.startsWith(stagingDir + path.sep)) {
    throw new Error(`stageExtractor ${label} escapes stagingDir: ${relative} (resolved to ${resolved})`);
  }
  return resolved;
}

async function readInstalledPackageJson(pkgDir: string, pkgName: string, version: string): Promise<Record<string, unknown>> {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`installed package ${pkgName} package.json unreadable (${pkgJsonPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.name !== pkgName || parsed.version !== version) {
    throw new Error(
      `installed package name/version mismatch: expected ${pkgName}@${version}, got ${String(parsed.name)}@${String(parsed.version)} (${pkgJsonPath})`,
    );
  }
  return parsed;
}

/** Revalidate a `.complete` cached release directory before reusing it (never deletes prior releases). */
async function revalidateCachedRelease(
  dataDir: string,
  targetVersion: string,
  marker: CompleteMarker,
): Promise<StagedNodeRelease | null> {
  const versionRoot = path.resolve(dataDir, 'releases', targetVersion);
  const inside = (candidate: string, base: string, label: string): string => {
    const resolved = path.resolve(candidate);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`.complete cache ${label} lies outside immutable release dir: ${candidate} (expected under ${base})`);
    }
    return resolved;
  };

  const candidateDir = inside(marker.candidateDir, versionRoot, 'candidateDir');
  const entryPath = inside(marker.entryPath, candidateDir, 'entryPath');
  const cliBinDir = inside(marker.cliBinDir, candidateDir, 'cliBinDir');
  if (!(await fileExists(entryPath))) {
    throw new Error(`.complete cache reuse failed: missing entry file ${entryPath}`);
  }
  if (!(await fileExists(cliBinDir))) {
    throw new Error(`.complete cache reuse failed: missing bin directory ${cliBinDir}`);
  }

  if (marker.origin !== 'npm') {
    return { version: targetVersion, releaseDir: candidateDir, entryPath, cliBinDir };
  }

  const nodePkg = process.env.HELM_NPM_PACKAGE || '@helm/node';
  const cliPkg = process.env.HELM_NPM_CLI_PACKAGE || '@helm/cli';
  const nodePkgDir = path.join(candidateDir, 'node_modules', ...nodePkg.split('/'));
  const cliPkgDir = path.join(candidateDir, 'node_modules', ...cliPkg.split('/'));
  await readInstalledPackageJson(nodePkgDir, nodePkg, targetVersion);
  const cliPkgJson = await readInstalledPackageJson(cliPkgDir, cliPkg, targetVersion);
  if (path.relative(candidateDir, entryPath) !== path.join('node_modules', ...nodePkg.split('/'), 'dist', 'cli.js')) {
    throw new Error(`.complete cache entry is not ${nodePkg}'s dist/cli.js: ${entryPath}`);
  }
  if (!(await fileExists(path.join(cliPkgDir, 'dist', 'index.js')))) {
    throw new Error(`.complete cache reuse failed: ${cliPkg} missing dist/index.js (${cliPkgDir})`);
  }
  const bin = cliPkgJson.bin;
  const binTarget =
    typeof bin === 'string' ? bin : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>).helm === 'string'
      ? (bin as Record<string, string>).helm
      : undefined;
  if (binTarget === undefined) {
    throw new Error(`.complete cache reuse failed: ${cliPkg} package.json missing helm bin declaration`);
  }
  if (!(await fileExists(path.resolve(cliPkgDir, binTarget)))) {
    throw new Error(`.complete cache reuse failed: ${cliPkg} bin target missing: ${binTarget}`);
  }

  return { version: targetVersion, releaseDir: candidateDir, entryPath, cliBinDir };
}

export async function stageReleaseFromNpm(
  dataDir: string,
  targetVersion: string,
  options?: StageReleaseOptions,
): Promise<StagedNodeRelease> {
  requireStrictVersion(targetVersion, 'targetVersion');

  const versionRoot = path.join(dataDir, 'releases', targetVersion);
  const completePath = path.join(versionRoot, '.complete');

  if (!options?.force) {
    const cached = await readJsonRecord(completePath, validateCompleteMarker, '.complete');
    if (cached && cached.version === targetVersion) {
      const revalidated = await revalidateCachedRelease(dataDir, targetVersion, cached);
      if (revalidated) return revalidated;
    }
  }

  await fs.mkdir(versionRoot, { recursive: true });
  const stagingDir = path.join(versionRoot, `.staging-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);

  try {
    await fs.mkdir(stagingDir, { recursive: true });
    let entryRelative: string;
    let binRelative: string;

    if (options?.stageExtractor) {
      const extracted = await options.stageExtractor(stagingDir, targetVersion);
      const entryPath = resolveInside(stagingDir, extracted.entryPath, 'entryPath');
      const cliBinDir = resolveInside(stagingDir, extracted.cliBinDir, 'cliBinDir');
      if (!(await fileExists(entryPath))) {
        throw new Error(`stageExtractor entry file missing: ${entryPath}`);
      }
      if (!(await fileExists(cliBinDir))) {
        throw new Error(`stageExtractor bin directory missing: ${cliBinDir}`);
      }
      entryRelative = path.relative(stagingDir, entryPath);
      binRelative = path.relative(stagingDir, cliBinDir);
    } else {
      const registryUrl = resolveRegistryUrl(options?.registryUrl);
      const nodePkg = process.env.HELM_NPM_PACKAGE || '@helm/node';
      const cliPkg = process.env.HELM_NPM_CLI_PACKAGE || '@helm/cli';
      const fetchImpl = options?.fetchFn ?? fetch;

      const downloads = path.join(stagingDir, '.downloads');
      await fs.mkdir(downloads, { recursive: true });
      const tarballPaths: string[] = [];
      for (const pkgName of [nodePkg, cliPkg]) {
        const manifest = await fetchExactManifest(registryUrl, pkgName, targetVersion, fetchImpl);
        const tarballPath = path.join(downloads, `${pkgName.replace('/', '+')}-${targetVersion}.tgz`);
        try {
          await fetchTarballWithTimeout(manifest.tarball, fetchImpl, TARBALL_TIMEOUT_MS, tarballPath);
        } catch (error) {
          throw new Error(`failed to download ${pkgName}@${targetVersion} tarball (${manifest.tarball}): ${error instanceof Error ? error.message : String(error)}`);
        }
        const actual = await computeSri(tarballPath);
        if (actual !== manifest.integrity) {
          throw new Error(
            `${pkgName}@${targetVersion} tarball sha512 integrity check failed: expected ${manifest.integrity}, got ${actual}`,
          );
        }
        tarballPaths.push(tarballPath);
      }

      await fs.writeFile(
        path.join(stagingDir, 'package.json'),
        JSON.stringify({ name: 'helm-node-release', private: true }, null, 2) + '\n',
        'utf8',
      );
      await runNpm(
        [
          'install',
          ...tarballPaths,
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--registry',
          registryUrl,
        ],
        stagingDir,
        NPM_INSTALL_TIMEOUT_MS,
      );

      const nodePkgDir = path.join(stagingDir, 'node_modules', ...nodePkg.split('/'));
      const cliPkgDir = path.join(stagingDir, 'node_modules', ...cliPkg.split('/'));
      await readInstalledPackageJson(nodePkgDir, nodePkg, targetVersion);
      const cliPkgJson = await readInstalledPackageJson(cliPkgDir, cliPkg, targetVersion);

      const nodeEntry = path.join(nodePkgDir, 'dist', 'cli.js');
      if (!(await fileExists(nodeEntry))) {
        throw new Error(`installed artifact missing @helm/node main entry dist/cli.js: ${nodeEntry}`);
      }
      const cliEntry = path.join(cliPkgDir, 'dist', 'index.js');
      if (!(await fileExists(cliEntry))) {
        throw new Error(`installed artifact missing @helm/cli entry dist/index.js: ${cliEntry}`);
      }
      const bin = cliPkgJson.bin;
      const binTarget =
        typeof bin === 'string' ? bin : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>).helm === 'string'
          ? (bin as Record<string, string>).helm
          : undefined;
      if (binTarget === undefined) {
        throw new Error(`@helm/cli package.json missing helm bin declaration (${path.join(cliPkgDir, 'package.json')})`);
      }
      const binFile = path.resolve(cliPkgDir, binTarget);
      if (!(await fileExists(binFile))) {
        throw new Error(`@helm/cli bin target file missing: ${binFile}`);
      }

      entryRelative = path.relative(stagingDir, nodeEntry);
      binRelative = 'node_modules/.bin';
    }

    const candidateDir = path.join(versionRoot, randomUUID());
    await fs.rename(stagingDir, candidateDir);
    const finalEntry = path.join(candidateDir, entryRelative);
    const finalBin = path.join(candidateDir, binRelative);

    const marker: CompleteMarker = {
      version: targetVersion,
      candidateDir,
      entryPath: finalEntry,
      cliBinDir: finalBin,
      completedAt: new Date().toISOString(),
      origin: options?.stageExtractor ? 'extractor' : 'npm',
    };
    await writeSecureJson(completePath, marker);

    return { version: targetVersion, releaseDir: candidateDir, entryPath: finalEntry, cliBinDir: finalBin };
  } catch (error) {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (rmError) {
      if (error instanceof Error) {
        error.message += `; staging cleanup failed (${rmError instanceof Error ? rmError.message : String(rmError)}), leftover directory requires manual removal: ${stagingDir}`;
      }
    }
    throw error;
  }
}

const UPGRADE_BLOCK_COOLDOWN_MS = (): number => {
  const raw = Number(process.env.HELM_UPGRADE_BLOCK_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60 * 1000;
};

const DRAIN_POLL_INTERVAL_MS = 50;

/** Cross-process exclusive upgrade lock (`upgrade.lock`, `O_CREAT|O_EXCL`). */
async function withUpgradeLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(dataDir, 'upgrade.lock');
  await fs.mkdir(dataDir, { recursive: true });
  let handle: FileHandle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new UpgradeRejectedError(`upgrade already in progress (lock file exists: ${lockPath})`);
    }
    throw new Error(`failed to create upgrade lock (${lockPath}): ${code ?? (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    await handle.write(`${process.pid} ${new Date().toISOString()}\n`);
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function performNodeUpgrade(
  dataDir: string,
  options?: PerformNodeUpgradeOptions,
): Promise<NodeUpgradeResult> {
  return withUpgradeLock(dataDir, async () => {
    if (!options?.prepareReplacement) {
      throw new UpgradeRejectedError(
        'upgrade rejected: prepareReplacement was not provided (requires a managed daemon to register and commit activation; refusing to fabricate a PID)',
      );
    }

    const previousVersion =
      options?.currentVersion ?? (await readCurrentRelease(dataDir))?.version ?? getNodeVersion();

    let targetVersion: string;
    if (options?.targetVersion !== undefined && options.targetVersion !== '') {
      targetVersion = normalizeTargetVersion(options.targetVersion);
    } else {
      const check = await checkNodeUpgrade(dataDir, {
        registryUrl: options?.registryUrl,
        currentVersion: previousVersion,
        fetchFn: options?.fetchFn,
      });
      targetVersion = check.latestVersion;
    }

    if (!options?.force && targetVersion === previousVersion) {
      return { ok: true, previousVersion, targetVersion, upgraded: false };
    }

    if (!options?.force && compareSemver(targetVersion, previousVersion) < 0) {
      throw new UpgradeRejectedError(
        `refusing downgrade from ${previousVersion} to ${targetVersion} (pass force=true to downgrade)`,
      );
    }

    const blocked = await readBlockedRelease(dataDir);
    if (blocked && blocked.version === targetVersion && !options?.force) {
      const blockedAtMs = Date.parse(blocked.at);
      const withinCooldown = Number.isFinite(blockedAtMs) && Date.now() - blockedAtMs < UPGRADE_BLOCK_COOLDOWN_MS();
      if (withinCooldown) {
        throw new UpgradeRejectedError(`version ${targetVersion} is in failure cooldown, rejecting retry: ${blocked.reason} (blocked at ${blocked.at})`);
      }
    }

    const existingCurrent = await readCurrentRelease(dataDir);

    const attemptId = options?.attemptId ?? randomUUID();
    let committed = false;
    let keepGate = false;
    let gateReleased = false;
    const releaseGate = async () => {
      if (gateReleased) return;
      gateReleased = true;
      options?.setDraining?.(false);
    };
    const writeBlockedOrFail = async (reason: string): Promise<string> => {
      try {
        await writeBlockedRelease(dataDir, { version: targetVersion, reason, at: new Date().toISOString() });
        return `recorded blocked release for ${targetVersion}`;
      } catch (blockedError) {
        return `write blocked record failed (manual cleanup required): ${blockedError instanceof Error ? blockedError.message : String(blockedError)}`;
      }
    };

    try {
      const staged = await stageReleaseFromNpm(dataDir, targetVersion, {
        registryUrl: options?.registryUrl,
        fetchFn: options?.fetchFn,
        stageExtractor: options?.stageExtractor,
        force: options?.force,
      });

      options?.setDraining?.(true);

      const getActiveExecCount = options?.getActiveExecCount ?? (() => 0);
      const drainTimeoutMs = options?.drainTimeoutMs ?? 30_000;
      const drainStart = Date.now();
      while (getActiveExecCount() > 0) {
        if (Date.now() - drainStart > drainTimeoutMs) {
          throw new Error(`timed out draining in-flight operations (${drainTimeoutMs}ms, ${getActiveExecCount()} remaining); upgrade aborted with no changes`);
        }
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
      }

      let replacement: PreparedNodeReplacement;
      try {
        replacement = await options.prepareReplacement(staged, { attemptId, previousVersion, targetVersion });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const blockedNote = await writeBlockedOrFail(reason);
        throw new Error(
          `failed to prepare replacement daemon (upgrade to ${targetVersion} aborted; current unchanged, old host remains active): ${reason}; ${blockedNote}`,
        );
      }

      try {
        await writeCurrentRelease(dataDir, {
          version: targetVersion,
          entryPath: staged.entryPath,
          cliBinDir: staged.cliBinDir,
          updatedAt: new Date().toISOString(),
        });
        await clearBlockedRelease(dataDir);
        await replacement.commit();
      } catch (error) {
        if (error instanceof UpgradeCommitUnconfirmedError) {
          options?.onScheduleShutdown?.(replacement.pid);
          keepGate = true;
          throw new Error(
            `upgrade to ${targetVersion}: replacement was activated, but confirmation was unconfirmed (${error.message}); not rolling back (current.json points to ${targetVersion}, candidate will retry Hub commit idempotently, old host scheduled to exit)`,
            { cause: error },
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        const rollbackNotes: string[] = [];
        try {
          await replacement.abort();
          rollbackNotes.push('replacement aborted');
        } catch (abortError) {
          rollbackNotes.push(`replacement abort failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`);
        }
        try {
          if (existingCurrent) {
            await writeCurrentRelease(dataDir, existingCurrent);
            rollbackNotes.push(`current.json restored to ${existingCurrent.version}`);
          } else {
            await deleteCurrentRelease(dataDir);
            rollbackNotes.push('current.json deleted (was absent)');
          }
        } catch (restoreError) {
          rollbackNotes.push(`current.json restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
        rollbackNotes.push(await writeBlockedOrFail(reason));
        throw new Error(
          `upgrade to ${targetVersion} commit failed and rolled back to ${previousVersion}: ${reason}; rollback details: ${rollbackNotes.join('; ')}`,
        );
      }

      committed = true;
      options?.onScheduleShutdown?.(replacement.pid);

      return { ok: true, previousVersion, targetVersion, upgraded: true, pid: replacement.pid };
    } finally {
      if (!committed && !keepGate) await releaseGate();
    }
  });
}
