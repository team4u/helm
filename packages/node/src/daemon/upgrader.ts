/**
 * helm-node self upgrade engine:npm double package (@helm/node + @helm/cli) version install transaction.
 *
 * design want point (and botd upgrade engine same source but more strictly):
 * - double package same version install: once release also fixed @helm/node and @helm/cli precise
 *   version, each validate registry metadata dist.integrity(sha512) after download tarball
 *   and validate hash, again with local tgz offline install to the same staging directory;
 * - choose directory immutable:`releases/<ver>/<uuid>/`, forever do not delete (contains is now run
 *   same version directory); version `.complete` points to complete choose and cache validate entry;
 * - JSON record (current.json / update-blocked.json / .complete) only ENOENT
 *   return null, corrupt and IO error explicit throw (honest error discipline); one rule 0600 atomic write;
 * - commit point semantics:`prepareReplacement` return"registered but inactive"choose,
 *   `replacement.commit()`(write pid, activate and etc. new daemon back report) only then is
 *   unique commit point; only start/register do not when act commit;commit failed away abort + rollback +
 *   write blocked + solve except new command gate, never static default fall back or fabricate PID.
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

/** input illegal/policy reject (caller can mapping 4xx). */
export class UpgradeRejectedError extends Error {}

/**
 * commit result not confirm:activate already out, choose may already to Hub on report commit, only local machine
 * confirm lose (such as ACK timeout). this is special branch - - do not abort, do not rollback current, do not write
 * blocked; keep new current and draining gate, notify onScheduleShutdown let old host
 * exit, to on throw"new version already choose, activate result not confirm"while non- rollback. choose receives
 * activate after keep activate and idempotent retry Hub commit;Hub only based on receives commit decide
 * succeeded, avoid Hub already succeeded yet because local ACK timeout by reverse rollback.
 */
export class UpgradeCommitUnconfirmedError extends Error {}

// - - fixed interface - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

/** ready choose release(cannot change directory + already validate entry). */
export interface StagedNodeRelease {
  version: string;
  /** cannot change choose directory (releases/<ver>/<uuid>). */
  releaseDir: string;
  /** @helm/node guard entry (dist/cli.js) absolute path. */
  entryPath: string;
  /** @helm/cli managed helm client bin directory (node_modules/.bin) absolute path. */
  cliBinDir: string;
}

/** completed Hub register, wait for activate replace daemon;commit() is unique commit point. */
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
  /** arrange empty opening path call back: return still must wait for converge in-flight operation count (exec + tunnel + once IPC call). */
  getActiveExecCount?: () => number;
  setDraining?: (value: boolean) => void;
  drainTimeoutMs?: number;
  onScheduleShutdown?: (pid: number) => void;
}

export interface StageReleaseOptions {
  registryUrl?: string;
  fetchFn?: typeof fetch;
  /** only single test inject: return each other for staging entry and bin directory; validate without path escape. */
  stageExtractor?: (stagingDir: string, targetVersion: string) => Promise<{ entryPath: string; cliBinDir: string }>;
  /** force heavy install: skip .complete cache re- use, generate new cannot change choose (never delete since has choose, contains is now run same version directory). */
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

// - - version - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

/** strictly SemVer parse/compare unique implement at @helm/protocol/semver; this where only keep this engine error message seal (UpgradeRejectedError → RPC invalid). */
function requireStrictVersion(input: string, label: string): void {
  if (!isStrictSemver(input)) {
    throw new UpgradeRejectedError(
      `illegal SemVer version number (${label}):"${input}"(want seek strictly x.y.z[-pre][+build], disallows v prefix)`,
    );
  }
}

/** strictly SemVer compare (pre- publish priority: formal edition > pre- publish; number segment by count value, character parent segment by ASCII;build metadata by specification does not participate compare). invalid input throw UpgradeRejectedError. */
export function compareSemver(a: string, b: string): number {
  requireStrictVersion(a, 'a');
  requireStrictVersion(b, 'b');
  return compareStrictSemverShared(a, b);
}

/** Web/UI allows ` v1.0.0 ` form:trim and remove a v/V prefix, again strictly validate. */
export function normalizeTargetVersion(input: string): string {
  const trimmed = stripSemverVPrefix(input);
  requireStrictVersion(trimmed, 'targetVersion');
  return trimmed;
}

let cachedPackageVersion: string | undefined;

/** read itself @helm/node package package.json version (do not read current.json pretend run edition);HELM_VERSION_OVERRIDE used to development override. */
export function getNodeVersion(): string {
  const override = process.env.HELM_VERSION_OVERRIDE?.trim();
  if (override) return override;
  if (!cachedPackageVersion) {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    let version: string;
    try {
      const parsed = JSON.parse(rawFs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version !== 'string' || !isStrictSemver(parsed.version)) {
        throw new Error(`version field missing or illegal:${JSON.stringify(parsed.version)}`);
      }
      version = parsed.version;
    } catch (error) {
      // read fewer than itself version belongs to install corrupt, explicit errors while is not pretend a by default version.
      throw new Error(`cannot read @helm/node itself version (${pkgPath}):${error instanceof Error ? error.message : String(error)}`);
    }
    cachedPackageVersion = version;
  }
  return cachedPackageVersion;
}

/** offline CLI read when before activate entry version:current.json takes precedence, missing fall back itself package version. */
export async function resolveEffectiveNodeVersion(dataDir: string): Promise<string> {
  const current = await readCurrentRelease(dataDir);
  return current?.version ?? getNodeVersion();
}

// - - registry allows manifest - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

const normalizeRegistry = (url: string | undefined): string => (url ?? '').trim().replace(/\/+$/, '');

/**
 * RPC station registry allows manifest: only official registry or explicit config HELM_NPM_REGISTRY.
 * explicit pass other source when throw UpgradeRejectedError(not silently swap source); not pass return undefined
 * (caller self row away env/by default parse).
 */
export function filterRpcRegistryUrl(registryUrl?: string): string | undefined {
  const requested = normalizeRegistry(registryUrl);
  if (!requested) return undefined;
  if (requested === DEFAULT_REGISTRY) return requested;
  const envRegistry = normalizeRegistry(process.env.HELM_NPM_REGISTRY);
  if (envRegistry && requested === envRegistry) return requested;
  throw new UpgradeRejectedError(
    `reject non- subject to message npm registry:${requested}(only allows ${DEFAULT_REGISTRY} or HELM_NPM_REGISTRY config source)`,
  );
}

function resolveRegistryUrl(explicit?: string): string {
  return normalizeRegistry(explicit || process.env.HELM_NPM_REGISTRY || DEFAULT_REGISTRY);
}

// - - JSON record: only ENOENT return null, corrupt/IO error explicit throw;0600 atomic write - - - -

async function readJsonRecord<T>(filePath: string, validate: (raw: unknown) => T, label: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(`read ${label} failed (${filePath}):${code ?? (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    return validate(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${label} corrupt (${filePath}):${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 0600 atomic write: same directory temp file + rename(failed clean up temp file and such as throw). */
async function writeSecureJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw new Error(`write ${filePath} failed:${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`field ${key} missing or is not non-empty string`);
  }
  return value;
}

function validateCurrentRecord(raw: unknown): CurrentReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('is not object');
  const rec = raw as Record<string, unknown>;
  const record: CurrentReleaseRecord = {
    version: requireString(rec, 'version'),
    entryPath: requireString(rec, 'entryPath'),
    updatedAt: requireString(rec, 'updatedAt'),
  };
  if (rec.cliBinDir !== undefined && typeof rec.cliBinDir !== 'string') {
    throw new Error('field cliBinDir is not string');
  }
  return rec.cliBinDir === undefined ? record : { ...record, cliBinDir: rec.cliBinDir };
}

function validateBlockedRecord(raw: unknown): BlockedReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('is not object');
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

// - - upgrade check - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

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
      throw new Error(`response missing version field:${JSON.stringify(data).slice(0, 200)}`);
    }
    latestVersion = data.version;
  } catch (error) {
    throw new Error(`query ${url} most new version failed:${error instanceof Error ? error.message : String(error)}`);
  }
  // registry return illegal version is explicit broken data, directly reject while is not carries illness compare.
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

// - - staging:npm double package download + validate + local tgz install - - - - - - - - - - - - - - - - - - - -

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
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`request timeout (${timeoutMs}ms)`);
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
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`download timeout (${timeoutMs}ms)`);
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
    throw new Error(`get ${pkgName}@${version} metadata failed (${url}):${error instanceof Error ? error.message : String(error)}`);
  }
  if (data.name !== pkgName) {
    throw new Error(`registry metadata package name do not symbol: expectation ${pkgName}, actual ${JSON.stringify(data.name)}`);
  }
  if (data.version !== version) {
    throw new Error(`registry metadata version do not symbol: expectation ${version}, actual ${JSON.stringify(data.version)}`);
  }
  const integrity = data.dist?.integrity;
  const tarball = data.dist?.tarball;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`${pkgName}@${version} metadata missing legal sha512 dist.integrity`);
  }
  if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) {
    throw new Error(`${pkgName}@${version} metadata missing legal dist.tarball`);
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
 * parse npm entry:Windows on now proxy Node disallows spawn(.cmd, shell:false), therefore
 * do not guess npm.cmd, but rather locate node can execute file beside node_modules/npm/bin/npm-cli.js
 * (official Windows install layout), with [process.execPath, npmCliJs] execute - - without shell,
 * without string concatenate inject. locate fewer than when explicit errors, does not do not security fallback.
 */
function resolveNpmCommand(): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(execDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // zip layout:node.exe in bin/ under
  ];
  for (const cliJs of candidates) {
    if (rawFs.existsSync(cliJs)) return { command: process.execPath, args: [cliJs] };
  }
  throw new Error(
    `cannot locate npm entry npm-cli.js(already attempt:${candidates.join(' ; ')}). when before Node forbidden directly spawn npm.cmd, please fix Node install or in PATH in provide official npm layout after retry`,
  );
}

/** run npm(has boundary timeout); failed error contains exit code and output finally 40 row diagnose.
 * POSIX independent process group:npm lifecycle script descendant process and npm same group, timeout whole group SIGKILL
 * (re- use killProcessTree), do not orphan child continue write correct by clean up staging directory. */
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
      reject(new Error(`cannot start ${displayCmd}(${npm.command}):${error instanceof Error ? error.message : String(error)}`));
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
      // kill the whole process group (npm + sh + lifecycle script descendant process); single kill npm will orphan child.
      if (child.pid !== undefined) killProcessTree(child.pid);
      reject(new Error(`${displayCmd} timeout (${timeoutMs}ms) by terminate. output finally ${NPM_OUTPUT_DIAG_LINES} row:\n${lastLines(`${stdout}\n${stderr}`, NPM_OUTPUT_DIAG_LINES)}`));
    }, timeoutMs);
    child.on('error', (error) => finish(new Error(`${displayCmd} failed to start:${error.message}`)));
    // use close(while non- exit) ensure stream already arrange empty, diagnose output complete.
    child.on('close', (code) => {
      if (code === 0) finish(null);
      else {
        finish(
          new Error(
            `${displayCmd} with exit code ${code} failed. output finally ${NPM_OUTPUT_DIAG_LINES} row:\n${lastLines(`${stdout}\n${stderr}`, NPM_OUTPUT_DIAG_LINES)}`,
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
  /** choose source:npm normal install ('npm') or test inject stageExtractor('extractor', re- use when only verify structure). */
  origin?: 'npm' | 'extractor';
}

function validateCompleteMarker(raw: unknown): CompleteMarker {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('is not object');
  const rec = raw as Record<string, unknown>;
  const marker: CompleteMarker = {
    version: requireString(rec, 'version'),
    candidateDir: requireString(rec, 'candidateDir'),
    entryPath: requireString(rec, 'entryPath'),
    cliBinDir: requireString(rec, 'cliBinDir'),
    completedAt: requireString(rec, 'completedAt'),
  };
  if (rec.origin !== undefined && rec.origin !== 'npm' && rec.origin !== 'extractor') {
    throw new Error(`field origin illegal:${JSON.stringify(rec.origin)}`);
  }
  return rec.origin === undefined ? marker : { ...marker, origin: rec.origin };
}

/** stageExtractor return relative path must in stagingDir inside (reject absolute path and escape). */
function resolveInside(stagingDir: string, relative: string, label: string): string {
  if (typeof relative !== 'string' || relative === '') {
    throw new Error(`stageExtractor return ${label} is not non-empty string`);
  }
  if (path.isAbsolute(relative)) {
    throw new Error(`stageExtractor return ${label} must be relative path, receives absolute path:${relative}`);
  }
  const resolved = path.resolve(stagingDir, relative);
  if (resolved !== stagingDir && !resolved.startsWith(stagingDir + path.sep)) {
    throw new Error(`stageExtractor return ${label} path escape:${relative}(parse is ${resolved})`);
  }
  return resolved;
}

async function readInstalledPackageJson(pkgDir: string, pkgName: string, version: string): Promise<Record<string, unknown>> {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`install artifact ${pkgName}  package.json cannot read (${pkgJsonPath}):${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.name !== pkgName || parsed.version !== version) {
    throw new Error(
      `install artifact package name/version do not symbol: expectation ${pkgName}@${version}, actual ${String(parsed.name)}@${String(parsed.version)}(${pkgJsonPath})`,
    );
  }
  return parsed;
}

/**
 * cache re- use before strictly re-check:candidate/entry/bin must at this version cannot change directory inside,
 * and double package package.json name/version and entry/bin target still valid (stageExtractor artifact
 * by test path only verify structure and store in). any does not match explicit reject, do not delete old choose.
 */
async function revalidateCachedRelease(
  dataDir: string,
  targetVersion: string,
  marker: CompleteMarker,
): Promise<StagedNodeRelease | null> {
  const versionRoot = path.resolve(dataDir, 'releases', targetVersion);
  const inside = (candidate: string, base: string, label: string): string => {
    const resolved = path.resolve(candidate);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`.complete cache ${label} do not in this version cannot change directory inside:${candidate}(expectation at ${base} under)`);
    }
    return resolved;
  };

  const candidateDir = inside(marker.candidateDir, versionRoot, 'candidateDir');
  const entryPath = inside(marker.entryPath, candidateDir, 'entryPath');
  const cliBinDir = inside(marker.cliBinDir, candidateDir, 'cliBinDir');
  if (!(await fileExists(entryPath))) {
    throw new Error(`.complete cache re- use failed: entry file missing:${entryPath}`);
  }
  if (!(await fileExists(cliBinDir))) {
    throw new Error(`.complete cache re- use failed:bin directory missing:${cliBinDir}`);
  }

  // stageExtractor(test inject) artifact only verify structure;npm artifact re- core for double package meta information and entry/bin.
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
    throw new Error(`.complete cache entry is not ${nodePkg}  dist/cli.js:${entryPath}`);
  }
  if (!(await fileExists(path.join(cliPkgDir, 'dist', 'index.js')))) {
    throw new Error(`.complete cache re- use failed:${cliPkg} entry dist/index.js missing (${cliPkgDir})`);
  }
  const bin = cliPkgJson.bin;
  const binTarget =
    typeof bin === 'string' ? bin : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>).helm === 'string'
      ? (bin as Record<string, string>).helm
      : undefined;
  if (binTarget === undefined) {
    throw new Error(`.complete cache re- use failed:${cliPkg} package.json missing helm bin declaration`);
  }
  if (!(await fileExists(path.resolve(cliPkgDir, binTarget)))) {
    throw new Error(`.complete cache re- use failed:${cliPkg} bin target missing:${binTarget}`);
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

  // already has complete choose and non- force: strictly re-check cache mark record and artifact after re- use, never delete old choose.
  // force skip cache re- download install, generate new cannot change choose.
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
        throw new Error(`stageExtractor return entry file missing:${entryPath}`);
      }
      if (!(await fileExists(cliBinDir))) {
        throw new Error(`stageExtractor return bin directory missing:${cliBinDir}`);
      }
      entryRelative = path.relative(stagingDir, entryPath);
      binRelative = path.relative(stagingDir, cliBinDir);
    } else {
      const registryUrl = resolveRegistryUrl(options?.registryUrl);
      const nodePkg = process.env.HELM_NPM_PACKAGE || '@helm/node';
      const cliPkg = process.env.HELM_NPM_CLI_PACKAGE || '@helm/cli';
      const fetchImpl = options?.fetchFn ?? fetch;

      // double package each take precise version metadata → download tarball → sha512 validate.
      const downloads = path.join(stagingDir, '.downloads');
      await fs.mkdir(downloads, { recursive: true });
      const tarballPaths: string[] = [];
      for (const pkgName of [nodePkg, cliPkg]) {
        const manifest = await fetchExactManifest(registryUrl, pkgName, targetVersion, fetchImpl);
        const tarballPath = path.join(downloads, `${pkgName.replace('/', '+')}-${targetVersion}.tgz`);
        try {
          await fetchTarballWithTimeout(manifest.tarball, fetchImpl, TARBALL_TIMEOUT_MS, tarballPath);
        } catch (error) {
          throw new Error(`download ${pkgName}@${targetVersion} tarball failed (${manifest.tarball}):${error instanceof Error ? error.message : String(error)}`);
        }
        const actual = await computeSri(tarballPath);
        if (actual !== manifest.integrity) {
          throw new Error(
            `${pkgName}@${targetVersion} tarball sha512 complete validation failed: expectation ${manifest.integrity}, actual ${actual}`,
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

      // install artifact three heavy validate:package.json name/version + node dist/cli.js + cli dist/index.js and bin target.
      const nodePkgDir = path.join(stagingDir, 'node_modules', ...nodePkg.split('/'));
      const cliPkgDir = path.join(stagingDir, 'node_modules', ...cliPkg.split('/'));
      await readInstalledPackageJson(nodePkgDir, nodePkg, targetVersion);
      const cliPkgJson = await readInstalledPackageJson(cliPkgDir, cliPkg, targetVersion);

      const nodeEntry = path.join(nodePkgDir, 'dist', 'cli.js');
      if (!(await fileExists(nodeEntry))) {
        throw new Error(`install artifact missing @helm/node guard entry dist/cli.js:${nodeEntry}`);
      }
      const cliEntry = path.join(cliPkgDir, 'dist', 'index.js');
      if (!(await fileExists(cliEntry))) {
        throw new Error(`install artifact missing @helm/cli entry dist/index.js:${cliEntry}`);
      }
      const bin = cliPkgJson.bin;
      const binTarget =
        typeof bin === 'string' ? bin : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>).helm === 'string'
          ? (bin as Record<string, string>).helm
          : undefined;
      if (binTarget === undefined) {
        throw new Error(`@helm/cli install artifact package.json missing helm bin declaration (${path.join(cliPkgDir, 'package.json')})`);
      }
      const binFile = path.resolve(cliPkgDir, binTarget);
      if (!(await fileExists(binFile))) {
        throw new Error(`@helm/cli bin target file missing:${binFile}`);
      }

      entryRelative = path.relative(stagingDir, nodeEntry);
      binRelative = 'node_modules/.bin';
    }

    // choose directory immutable:staging atomic change name is releases/<ver>/<uuid>, forever do not re- use/delete.
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
    // only clean up this time staging(not change name half into product); history choose one rule keep. clean up failed
    // do not swallow: leftover directory attach note to error message (keep original error class do not by wrap, upgrade transaction
    // dependency instanceof decide rollback semantics).
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (rmError) {
      if (error instanceof Error) {
        error.message += `;staging clean up failed (${rmError instanceof Error ? rmError.message : String(rmError)}), leftover directory await human handle:${stagingDir}`;
      }
    }
    throw error;
  }
}

// - - upgrade transaction - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

const UPGRADE_BLOCK_COOLDOWN_MS = (): number => {
  const raw = Number(process.env.HELM_UPGRADE_BLOCK_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60 * 1000;
};

const DRAIN_POLL_INTERVAL_MS = 50;

/** across process upgrade lock:upgrade.lock(O_CREAT|O_EXCL). does not stale lock arbitration, occupy i.e. explicit reject. */
async function withUpgradeLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(dataDir, 'upgrade.lock');
  await fs.mkdir(dataDir, { recursive: true });
  let handle: FileHandle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new UpgradeRejectedError(`upgrade already in in progress (lock file already exists:${lockPath})`);
    }
    throw new Error(`create upgrade lock failed (${lockPath}):${code ?? (error instanceof Error ? error.message : String(error))}`);
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
      // no managed daemon commit point then no real PID, explicit reject while is not fabricate.
      throw new UpgradeRejectedError(
        'reject upgrade: not provide prepareReplacement(helm-node upgrade need to managed daemon complete register and activate commit, do not fabricate PID)',
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
        `reject from ${previousVersion} fall back to ${targetVersion}(guard against fall back protect; such as indeed must fall back use force)`,
      );
    }

    const blocked = await readBlockedRelease(dataDir);
    if (blocked && blocked.version === targetVersion && !options?.force) {
      const blockedAtMs = Date.parse(blocked.at);
      const withinCooldown = Number.isFinite(blockedAtMs) && Date.now() - blockedAtMs < UPGRADE_BLOCK_COOLDOWN_MS();
      if (withinCooldown) {
        throw new UpgradeRejectedError(`version ${targetVersion} where at failed cool down phase, reject retry:${blocked.reason}(blocked at ${blocked.at})`);
      }
    }

    // old current snapshot in enter drain before read:drain after everything failed all away unify rollback path.
    const existingCurrent = await readCurrentRelease(dataDir);

    const attemptId = options?.attemptId ?? randomUUID();
    let committed = false;
    // commit not confirm branch (UpgradeCommitUnconfirmedError) also do not release gate: new version may already activate.
    let keepGate = false;
    let gateReleased = false;
    const releaseGate = async () => {
      if (gateReleased) return;
      gateReleased = true;
      options?.setDraining?.(false);
    };
    /** write blocked failed do not swallow: attach in error in such as on report. */
    const writeBlockedOrFail = async (reason: string): Promise<string> => {
      try {
        await writeBlockedRelease(dataDir, { version: targetVersion, reason, at: new Date().toISOString() });
        return `already write version ${targetVersion}  blocked record`;
      } catch (blockedError) {
        return `write blocked record failed (must human handle):${blockedError instanceof Error ? blockedError.message : String(blockedError)}`;
      }
    };

    try {
      const staged = await stageReleaseFromNpm(dataDir, targetVersion, {
        registryUrl: options?.registryUrl,
        fetchFn: options?.fetchFn,
        stageExtractor: options?.stageExtractor,
        force: options?.force,
      });

      // enter arrange empty: stop subject to new command (envExec/tunnel/IPC call/IPC subscribe),
      // wait for already subject to exec and IPC invoke all end (do not strong kill; long resident subscribe without waiting).
      options?.setDraining?.(true);

      const getActiveExecCount = options?.getActiveExecCount ?? (() => 0);
      const drainTimeoutMs = options?.drainTimeoutMs ?? 30_000;
      const drainStart = Date.now();
      while (getActiveExecCount() > 0) {
        if (Date.now() - drainStart > drainTimeoutMs) {
          throw new Error(`wait for in-flight command arrange empty timeout (${drainTimeoutMs}ms, remaining ${getActiveExecCount()} ), this time upgrade already abandon and not do any change`);
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
          `prepare replace daemon failed (upgrade to ${targetVersion} abort,current not change, host keep take over state):${reason};${blockedNote}`,
        );
      }

      // commit point: everything may affect into failed file operation (contains clean up blocked) all in commit before complete;
      // commit is finally fallible commit step, after only remain non- key notify, must not because clean up failed
      // mistakenly report failed to upgrade (otherwise new process already to Hub back report commit while old process forever long draining).
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
          // special branch:activate already out, choose may already to Hub on report commit, only local machine confirm
          // lose. reverse rollback will let Hub already succeeded upgrade by local ACK timeout undo - - therefore do not
          // abort, do not rollback current, do not write blocked; keep new current and gate, old host
          // let, by choose idempotent retry Hub commit.
          options?.onScheduleShutdown?.(replacement.pid);
          keepGate = true;
          throw new Error(
            `upgrade to ${targetVersion}: new version already choose, activate result not confirm (${error.message}). do not rollback:current.json already points to ${targetVersion}, choose idempotent retry to Hub commit, old host already arrange exit`,
            { cause: error },
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        const rollbackNotes: string[] = [];
        try {
          await replacement.abort();
          rollbackNotes.push('replacement already abort');
        } catch (abortError) {
          rollbackNotes.push(`replacement abort failed:${abortError instanceof Error ? abortError.message : String(abortError)}`);
        }
        try {
          if (existingCurrent) {
            await writeCurrentRelease(dataDir, existingCurrent);
            rollbackNotes.push(`current.json already restore to ${existingCurrent.version}`);
          } else {
            await deleteCurrentRelease(dataDir);
            rollbackNotes.push('current.json deleted (this before missing)');
          }
        } catch (restoreError) {
          rollbackNotes.push(`current.json restore failed:${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
        rollbackNotes.push(await writeBlockedOrFail(reason));
        throw new Error(
          `upgrade to ${targetVersion} commit failed, already rollback to ${previousVersion}:${reason}; rollback detail situation:${rollbackNotes.join(';')}`,
        );
      }

      // commit already into: old host let (gate keep draining, wait for exit); clean up failed no longer affect result.
      committed = true;
      options?.onScheduleShutdown?.(replacement.pid);

      return { ok: true, previousVersion, targetVersion, upgraded: true, pid: replacement.pid };
    } finally {
      // any failed (contains call back throws, read corrupt, write blocked failed) all solve except gate; succeeded and
      // commit not confirm path do not solve except (old host i.e. exit, new host already take over or may already take over).
      if (!committed && !keepGate) await releaseGate();
    }
  });
}
