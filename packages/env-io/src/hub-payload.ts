/**
 * Hub payload staging: how a published npm payload becomes a verified, immutable release
 * candidate — shared by the CLI launcher (`helmx update`) and the in-Hub background updater
 * (silent pre-staging) so both produce byte-identical candidates through one code path.
 *
 * Contents:
 * - `unpackPayloadTarball`: safe npm-pack archive unpacking (single `package/` prefix, regular
 *   files/dirs only, parser warnings fatal, post-extract re-walk proof);
 * - `resolveRegistryUrlForEnv` / `assertInstallIsolation`: registry resolution and the program/data
 *   separation guard shared by every consumer;
 * - `stageHubPayloadRelease`: the staging transaction — registry or local tarball copy inside the
 *   candidate, unpack, `npm install --omit=dev --ignore-scripts`, payload identity + manifest +
 *   `nodeEngines` verification, `node start.mjs check` self-test, and cache-reuse revalidation —
 *   behind the `HubUpdateCore` port so tests can fake the registry/npm seams.
 *
 * All generic machinery (immutable staging directories, `.complete` markers and cache reuse,
 * registry metadata, SRI-verified download, shell-free npm runner) comes from the update engine
 * in `update/`; this module only defines the Hub payload layout policy.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as tar from 'tar';
import {
  downloadVerifiedTarball,
  fetchLatestVersion,
  runNpm,
  stageRelease as engineStageRelease,
  type StageExtractor,
} from './update/index.js';
import { killProcessTree } from './node-shell-config-io.js';
import { isStrictSemver } from '@helmx/protocol';


/** Entry types allowed on disk: npm-pack archives contain nothing else. */
const ALLOWED_ENTRY_TYPES = new Set(['File', 'Directory']);

/** Path policy (shared by the validation pass and the extraction filter). */
function tarPathViolation(name: string): string | null {
  if (name.includes('\\')) return `entry "${name}" contains a backslash`;
  if (name !== 'package/' && !name.startsWith('package/')) {
    return `entry "${name}" is outside the package/ root`;
  }
  const segments = name.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment === '' && i === segments.length - 1) continue; // trailing slash on directories
    if (segment === '' || segment === '.' || segment === '..') {
      return `entry "${name}" contains a forbidden path segment`;
    }
  }
  return null;
}

/** Full policy: path shape plus entry type (links, devices, and FIFOs are rejected). */
function tarEntryViolation(name: string, type: string): string | null {
  if (!ALLOWED_ENTRY_TYPES.has(type)) {
    return `entry "${name}" has type ${type}; only regular files and directories are allowed`;
  }
  return tarPathViolation(name);
}

/** Walk a directory tree and return every member's kind; rejects anything but files/dirs. */
async function assertTreeIsPlainFiles(dir: string): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await assertTreeIsPlainFiles(full);
    } else if (!entry.isFile()) {
      throw new Error(`unpacked tree contains a non-regular member: ${full}`);
    }
  }
}

/**
 * Unpack `tarballPath` (an npm-pack archive) into `destDir`, stripping the `package/` prefix.
 * `destDir` must be empty or freshly created by the caller (the engine's staging root).
 */
export async function unpackPayloadTarball(tarballPath: string, destDir: string): Promise<void> {
  // Pass 1: validate every header node-tar is willing to emit, and treat parser warnings as
  // fatal (node-tar drops invalid members with a warning instead of failing the stream).
  const warnings: string[] = [];
  const members: { name: string; type: string }[] = [];
  try {
    await tar.list({
      file: tarballPath,
      onentry: (entry) => {
        members.push({ name: entry.path, type: entry.type });
      },
      onwarn: (code, message) => {
        warnings.push(`${code}: ${message}`);
      },
    });
  } catch (error) {
    throw new Error(
      `payload tarball is unreadable (${tarballPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (warnings.length > 0) {
    throw new Error(`payload tarball raised parser warnings and is refused: ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}`);
  }
  if (members.length === 0) throw new Error('payload tarball contains no entries');
  if (!members.some((member) => member.type === 'File')) {
    throw new Error('payload tarball contains no regular files');
  }
  let sawPackageJson = false;
  for (const member of members) {
    const violation = tarEntryViolation(member.name, member.type);
    if (violation !== null) throw new Error(`payload tarball security check failed: ${violation}`);
    if (member.name === 'package/package.json') sawPackageJson = true;
  }
  if (!sawPackageJson) throw new Error('payload tarball has no package/package.json member');

  // Pass 2: extract with the same policy as a belt-and-braces filter (a filtered member is
  // skipped, never written; the on-disk walk below is the final authority).
  const extractWarnings: string[] = [];
  try {
    await tar.extract({
      file: tarballPath,
      cwd: destDir,
      strip: 1,
      filter: (name) => tarPathViolation(name) === null,
      onwarn: (code, message) => {
        extractWarnings.push(`${code}: ${message}`);
      },
    });
  } catch (error) {
    throw new Error(
      `payload tarball failed to extract into ${destDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (extractWarnings.length > 0) {
    throw new Error(`payload extraction raised parser warnings and is refused: ${extractWarnings[0]}`);
  }

  // Pass 3: on-disk proof — nothing but regular files and directories landed under destDir.
  await assertTreeIsPlainFiles(destDir);
}

const CHECK_OUTPUT_LIMIT = 400_000;
const DIAG_LINES = 40;
/** npm install inside a staged candidate (run through the engine's npm runner). */
export const NPM_INSTALL_TIMEOUT_MS = 300_000;
/** `node start.mjs check` self-verification budget inside staging. */
export const PAYLOAD_CHECK_TIMEOUT_MS = 120_000;
/** Supported `nodeEngines` shape: a `>=x.y.z` floor (what the payload builder ships). */
const NODE_ENGINES_PATTERN = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;

/** npm registry URL (explicit value > `HELMX_NPM_REGISTRY` from the passed env > official); env-injectable variant for tests and embedded hosts. */
export function resolveRegistryUrlForEnv(env: NodeJS.ProcessEnv, explicit?: string): string {
  const value = explicit ?? env.HELMX_NPM_REGISTRY ?? 'https://registry.npmjs.org';
  if (!/^https?:\/\//.test(value)) {
    throw new Error(`invalid npm registry URL: "${value}" (expected http(s)://…)`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * Program/data separation guard: the install root (releases, records, logs — written and replaced
 * by updates) must never overlap the Hub's data directory (conversations, plugins, credentials —
 * user data). Nesting in either direction is rejected explicitly.
 */
export function assertInstallIsolation(installRoot: string, dataDir: string | undefined, env: NodeJS.ProcessEnv): void {
  const explicit = dataDir ?? (env.HELMX_DATA_DIR !== undefined && env.HELMX_DATA_DIR !== '' ? env.HELMX_DATA_DIR : undefined);
  const data = path.resolve(explicit ?? path.join(os.homedir(), '.helmx'));
  const program = path.resolve(installRoot);
  const nested = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep);
  if (nested(program, data) || nested(data, program)) {
    throw new Error(
      `install root (${program}) and Hub data directory (${data}) must not overlap: program releases/state and user data are strictly separate trees (check HELMX_HUB_INSTALL_ROOT vs HELMX_DATA_DIR/--data-dir)`,
    );
  }
}

/** Resolve an entry path inside its release root; absolute inputs must still resolve into the release (containment enforced). */
export function resolveInsideRelease(releaseRoot: string, relative: string, label: string): string {
  if (typeof relative !== 'string' || relative === '') {
    throw new Error(`${label} must be a non-empty path`);
  }
  const resolved = path.resolve(releaseRoot, relative);
  if (resolved !== releaseRoot && !resolved.startsWith(releaseRoot + path.sep)) {
    throw new Error(`${label} escapes the release directory: ${relative} (resolved to ${resolved})`);
  }
  return resolved;
}

export interface StageHubOptions {
  /** Environment used for registry/isolation resolution (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Port fake for tests; production uses the real update-engine adapter. */
  core?: HubUpdateCore;
  /** Launcher install root (staging happens under `<root>/releases/<version>/`). */
  root: string;
  /** Strict-semver target version. */
  version: string;
  /** Published payload package name. */
  pkgName: string;
  /** Effective Hub data directory for the program/data separation guard. */
  dataDir: string;
  registryUrl?: string;
  /** Local tarball install source (skips the registry download; still unpacked + npm-installed + self-checked). */
  tarballPath?: string;
  force?: boolean;
  fetchFn?: typeof fetch;
  npmInstallTimeoutMs?: number;
  payloadCheckTimeoutMs?: number;
  /** Test seam overriding the Node version checked against the manifest floor. */
  nodeVersion?: string;
}

export interface StagedHubRelease {
  version: string;
  releaseDir: string;
  entryPath: string;
  reusedCached: boolean;
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  return lines.slice(-count).join('\n');
}

/** Run `node <entry> check` with a hard timeout; surfaces bounded output tail on failure. */
async function runPayloadSelfCheck(entry: string, timeoutMs: number): Promise<void> {
  const result = await new Promise<{ code: number | null; error?: Error; stdout: string; stderr: string }>(
    (resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(process.execPath, [entry, 'check'], {
        cwd: path.dirname(entry),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < CHECK_OUTPUT_LIMIT) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < CHECK_OUTPUT_LIMIT) stderr += chunk.toString('utf8');
      });
      const finish = (code: number | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, error, stdout, stderr });
      };
      const timer = setTimeout(() => {
        if (child.pid !== undefined) killProcessTree(child.pid);
        finish(null, new Error(`payload self-check timed out (${timeoutMs}ms) and was terminated`));
      }, timeoutMs);
      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
    },
  );
  if (result.error !== undefined) {
    throw new Error(`payload self-check failed to run (${entry}): ${result.error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `payload self-check failed with exit code ${result.code}; last ${DIAG_LINES} lines:\n${lastLines(`${result.stdout}\n${result.stderr}`, DIAG_LINES)}`,
    );
  }
}

/** Parse a `x.y.z` release triple, ignoring any prerelease/build suffix. */
function parseNodeTriple(version: string, label: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new Error(`cannot parse the ${label} version: "${version}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Enforce the manifest's `nodeEngines` floor against the launcher's own Node runtime. The payload
 * ships `>=x.y.z` ranges (from the workspace `engines.node`); anything the launcher cannot
 * interpret is rejected explicitly rather than guessed at.
 */
function assertNodeEngines(nodeEngines: unknown, manifestPath: string, nodeVersion: string): void {
  if (typeof nodeEngines !== 'string') {
    throw new Error(`manifest.json nodeEngines must be a string (${manifestPath}): got ${JSON.stringify(nodeEngines)}`);
  }
  const match = NODE_ENGINES_PATTERN.exec(nodeEngines.trim());
  if (match === null) {
    throw new Error(
      `manifest.json nodeEngines is not a supported ">=x.y.z" floor (${manifestPath}): "${nodeEngines}"`,
    );
  }
  const floor = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const current = parseNodeTriple(nodeVersion, 'running Node');
  for (let i = 0; i < 3; i += 1) {
    if (current[i]! < floor[i]!) {
      throw new Error(
        `payload requires Node >= ${floor.join('.')} but this launcher runs Node ${nodeVersion}; update the launcher's Node runtime before installing this release`,
      );
    }
    if (current[i]! > floor[i]!) break;
  }
}

/**
 * Verify the unpacked payload package identity and contract files at the candidate root (the
 * layout `npm install` runs in; `start.mjs`/`manifest.json` sit at the root, dependencies under
 * `node_modules/`). Returns the release-relative entry path.
 */
async function verifyPayloadLayout(
  releaseRoot: string,
  pkgName: string,
  version: string,
  nodeVersion: string,
): Promise<string> {
  const pkgJsonPath = path.join(releaseRoot, 'package.json');
  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(await fsp.readFile(pkgJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `unpacked payload package.json unreadable (${pkgJsonPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (pkgJson.name !== pkgName || pkgJson.version !== version) {
    throw new Error(
      `unpacked payload package mismatch: expected ${pkgName}@${version}, got ${String(pkgJson.name)}@${String(pkgJson.version)} (${pkgJsonPath})`,
    );
  }
  const entry = path.join(releaseRoot, 'start.mjs');
  const manifest = path.join(releaseRoot, 'manifest.json');
  for (const [label, file] of [
    ['start.mjs entry', entry],
    ['manifest.json contract', manifest],
  ] as const) {
    try {
      await fsp.access(file);
    } catch {
      throw new Error(`unpacked payload is missing its ${label}: ${file}`);
    }
  }
  let manifestJson: Record<string, unknown>;
  try {
    manifestJson = JSON.parse(await fsp.readFile(manifest, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `unpacked payload manifest.json unreadable (${manifest}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifestJson.name !== pkgName || manifestJson.version !== version) {
    throw new Error(
      `unpacked payload manifest mismatch: expected ${pkgName}@${version}, got ${String(manifestJson.name)}@${String(manifestJson.version)} (${manifest})`,
    );
  }
  assertNodeEngines(manifestJson.nodeEngines, manifest, nodeVersion);
  return 'start.mjs';
}

/**
 * Materialize the launcher-owned tarball copy inside the candidate: the registry channel
 * downloads (already verified by the port), the `--tarball` channel copies the local file in so
 * validation and extraction always observe identical bytes.
 */
async function prepareTarballCopy(
  stagingDir: string,
  core: HubUpdateCore,
  options: StageHubOptions,
  registryUrl: string,
  version: string,
  pkgName: string,
): Promise<string> {
  const dest = path.join(stagingDir, '.downloads', 'payload.tgz');
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (options.tarballPath !== undefined) {
    const resolved = path.resolve(options.tarballPath);
    try {
      const stat = await fsp.stat(resolved);
      if (!stat.isFile()) throw new Error('not a regular file');
      await fsp.copyFile(resolved, dest);
    } catch (error) {
      throw new Error(
        `invalid --tarball path ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return dest;
  }
  await core.downloadVerifiedTarball(registryUrl, pkgName, version, dest, options.fetchFn);
  return dest;
}

/** Stage (or reuse) the Hub payload release for `version` through the update-core port. */
export async function stageHubRelease(options: StageHubOptions): Promise<StagedHubRelease> {
  const { version, pkgName } = options;
  const core = options.core ?? defaultHubUpdateCore();
  if (!isStrictSemver(version)) {
    throw new Error(`invalid target version: "${version}" (expected strict x.y.z[-pre][+build] without v prefix)`);
  }
  assertInstallIsolation(options.root, options.dataDir, options.env ?? process.env);
  const registryUrl = resolveRegistryUrlForEnv(options.env ?? process.env, options.registryUrl);
  const npmInstallTimeoutMs = options.npmInstallTimeoutMs ?? NPM_INSTALL_TIMEOUT_MS;
  const payloadCheckTimeoutMs = options.payloadCheckTimeoutMs ?? PAYLOAD_CHECK_TIMEOUT_MS;
  const nodeVersion = options.nodeVersion ?? process.versions.node;

  const extractor = async (stagingDir: string): Promise<Record<string, string>> => {
    const tarballCopy = await prepareTarballCopy(stagingDir, core, options, registryUrl, version, pkgName);
    // The unpacked payload package becomes the candidate root; its bundled file: dependencies
    // resolve relative to it and land in `<stagingDir>/node_modules`.
    await unpackPayloadTarball(tarballCopy, stagingDir);
    await fsp.rm(path.join(stagingDir, '.downloads'), { recursive: true, force: true });
    await core.runNpm(
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registryUrl],
      stagingDir,
      npmInstallTimeoutMs,
    );

    const entryRelative = await verifyPayloadLayout(stagingDir, pkgName, version, nodeVersion);
    const entry = resolveInsideRelease(stagingDir, entryRelative, 'payload entry path');
    await runPayloadSelfCheck(entry, payloadCheckTimeoutMs);
    return { entryPath: entryRelative };
  };

  // Cache-reuse detection: the engine's StagedRelease carries no reuse flag, so snapshot the
  // immutable candidate names under `releases/<version>/` before staging; an engine cache hit
  // returns a pre-existing `<uuid>` candidate, a fresh stage mints a new one.
  const versionRoot = path.join(options.root, 'releases', version);
  const candidatesBefore = await fsp.readdir(versionRoot).catch(() => [] as string[]);

  const staged = await core.stageRelease(options.root, version, extractor, {
    ...(options.force ? { force: true } : {}),
  });
  const entryPath = staged.entries['entryPath'];
  if (entryPath === undefined) {
    throw new Error(`staged release has no "entryPath" entry (got: ${Object.keys(staged.entries).join(', ') || 'none'})`);
  }
  const reusedCached = candidatesBefore.includes(path.basename(staged.releaseDir));
  if (reusedCached) {
    // Cache revalidation (#92/#131): the engine's marker contract proves the candidate was
    // produced by a successful stage, but its reuse check only verifies entry existence — the
    // payload files could have changed on disk since. Re-run the offline verification (package
    // identity, manifest contract, nodeEngines floor, `start.mjs check` dependency closure)
    // before anything may commit a cached candidate. No new state, no parallel install path.
    const verifiedEntry = await verifyPayloadLayout(staged.releaseDir, pkgName, version, nodeVersion);
    const resolvedEntry = resolveInsideRelease(staged.releaseDir, entryPath, 'payload entry path');
    if (resolvedEntry !== path.join(staged.releaseDir, verifiedEntry)) {
      throw new Error(
        `cached candidate shape drifted: marker entry is "${entryPath}" but the payload layout verifies as "${verifiedEntry}" (${staged.releaseDir})`,
      );
    }
    await runPayloadSelfCheck(resolvedEntry, payloadCheckTimeoutMs);
  }
  return {
    version: staged.version,
    releaseDir: staged.releaseDir,
    entryPath,
    reusedCached,
  };
}

/** Narrow update port consumed by staging; `defaultHubUpdateCore()` is the only production implementation. */
export interface HubUpdateCore {
  fetchLatestVersion(pkgName: string, options?: { registryUrl?: string; fetchFn?: typeof fetch; tag?: string }): Promise<string>;
  /** Download `<registry>/<pkg>/<version>`'s tarball after verifying its `dist.integrity` sha512 SRI. */
  downloadVerifiedTarball(registryUrl: string, pkgName: string, version: string, destPath: string, fetchImpl?: typeof fetch): Promise<void>;
  runNpm(args: readonly string[], cwd: string, timeoutMs: number): Promise<void>;
  /** Immutable staging under `<root>/releases/<version>/` with `.complete` cache semantics. */
  stageRelease(
    root: string,
    version: string,
    extractor: (stagingDir: string) => Promise<Record<string, string>>,
    options?: { force?: boolean },
  ): Promise<{ version: string; releaseDir: string; entries: Record<string, string> }>;
}

/** Default port binding to the shared update engine in this package. */
export function defaultHubUpdateCore(): HubUpdateCore {
  return {
    async fetchLatestVersion(pkgName, options) {
      return await fetchLatestVersion(
        resolveRegistryUrlForEnv(process.env, options?.registryUrl),
        pkgName,
        options?.fetchFn ?? fetch,
        options?.tag ?? 'latest',
      );
    },
    async downloadVerifiedTarball(registryUrl, pkgName, version, destPath, fetchImpl) {
      await downloadVerifiedTarball(registryUrl, pkgName, version, destPath, fetchImpl ?? fetch);
    },
    runNpm(args, cwd, timeoutMs) {
      return runNpm([...args], cwd, timeoutMs);
    },
    async stageRelease(root, version, extractor, options) {
      const adapted: StageExtractor = async (stagingDir) => await extractor(stagingDir);
      return await engineStageRelease(root, version, undefined, {
        stageExtractor: adapted,
        ...(options?.force ? { force: true } : {}),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// update-ready record — a staged candidate awaiting explicit apply
// ---------------------------------------------------------------------------

/** A staged-and-verified candidate ready for a manual switch (`<root>/update-ready.json`). */
export interface UpdateReadyRecord {
  version: string;
  /** Entry path as returned by staging (relative to the release dir, or absolute inside it). */
  entryPath: string;
  /** Absolute staged release directory (immutable, `.complete`-marked). */
  releaseDir: string;
  /** npm dist-tag the candidate came from. */
  tag: string;
  stagedAt: string;
}

function validateUpdateReady(raw: unknown): UpdateReadyRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = rec[key];
    if (typeof value !== 'string' || value === '') throw new Error(`expected field "${key}" to be a non-empty string`);
    return value;
  };
  const version = str('version');
  if (!isStrictSemver(version)) throw new Error(`invalid SemVer version: "${version}"`);
  return { version, entryPath: str('entryPath'), releaseDir: str('releaseDir'), tag: str('tag'), stagedAt: str('stagedAt') };
}

export function updateReadyPath(root: string): string {
  return path.join(root, 'update-ready.json');
}

/** Strict reader; `null` only on ENOENT, corrupt records throw. */
export async function readUpdateReady(root: string): Promise<UpdateReadyRecord | null> {
  const { readStateJson } = await import('./update/state.js');
  return await readStateJson(updateReadyPath(root), validateUpdateReady, 'update-ready.json');
}

export async function writeUpdateReady(root: string, record: UpdateReadyRecord): Promise<void> {
  const { atomicWriteJson } = await import('./atomic-write.js');
  validateUpdateReady(record);
  await atomicWriteJson(updateReadyPath(root), record, { mode: 0o600 });
}

export async function clearUpdateReady(root: string): Promise<boolean> {
  try {
    await fsp.rm(updateReadyPath(root), { force: true });
    return true;
  } catch {
    return false;
  }
}
