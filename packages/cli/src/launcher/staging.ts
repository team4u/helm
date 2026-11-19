/**
 * Hub payload staging strategy: how a published npm payload becomes a verified, immutable release
 * candidate. All generic machinery (immutable staging directories, `.complete` markers and cache
 * reuse, staging cleanup, registry metadata, verified download, npm runner) flows through the
 * `UpdateCore` port (`update-core.ts` binds it to the shared update engine in `@helmx/env-io`; tests inject a
 * port fake whose staging delegates to the real engine); this module only defines the Hub layout
 * policy inside the staged extractor:
 *
 * 1. obtain the payload tarball as a launcher-owned copy inside the candidate — registry
 *    (manifest fetch + tarball download + sha512 SRI verification, all engine primitives behind
 *    the port) or an explicit copy of a local `--tarball` file;
 * 2. safely unpack the archive into the candidate root, stripping the npm-pack `package/`
 *    prefix (`tarball.ts` rejects links, escapes, and partial parses) — the payload ships its
 *    `@helmx/*` dependency closure as bundled `file:./<pkg>.tgz` members, which only resolve after
 *    the outer archive is unpacked (`npm install <outer.tgz>` fails with ENOENT);
 * 3. `npm install --omit=dev --ignore-scripts` in the unpacked root (one install completes the
 *    whole dependency closure; esbuild platform binaries arrive via optionalDependencies);
 * 4. verify the payload identity (name/version) and the `start.mjs` + `manifest.json` contract
 *    files, including the manifest's `nodeEngines` floor against the launcher's own Node;
 * 5. run `node start.mjs check` — the payload's own zero-dependency self-verification (entry
 *    checksums, dependency resolution, runtime capability probes). Never starts the Hub.
 *
 * Cache reuse is the engine's marker contract: a valid `.complete` marker short-circuits with
 * structural revalidation (entry files exist inside the immutable candidate); the extractor above
 * is not re-run for cached candidates. On a cache hit the launcher re-runs its own offline
 * verification (`verifyPayloadLayout` + `start.mjs check`) before returning the candidate, so a
 * post-staging mutation cannot ride an offline update into `current.json`.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { killProcessTree } from '@helmx/env-io';
import { isStrictSemver } from '@helmx/protocol';
import { DEFAULTS, assertInstallIsolation, pathsOf, resolveRegistryUrl } from './layout.js';
import { resolveInsideRelease } from './records.js';
import type { LauncherIo } from './io.js';
import { unpackPayloadTarball } from './tarball.js';
import { defaultUpdateCore, type UpdateCore } from './update-core.js';

const CHECK_OUTPUT_LIMIT = 400_000;
const DIAG_LINES = 40;
/** Supported `nodeEngines` shape: a `>=x.y.z` floor (what the payload builder ships). */
const NODE_ENGINES_PATTERN = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;

export interface StageHubOptions {
  io: LauncherIo;
  /** Port fake for tests; production uses the real update-engine adapter. */
  core?: UpdateCore;
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
  core: UpdateCore,
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
  const { io, version, pkgName } = options;
  const core = options.core ?? defaultUpdateCore();
  if (!isStrictSemver(version)) {
    throw new Error(`invalid target version: "${version}" (expected strict x.y.z[-pre][+build] without v prefix)`);
  }
  assertInstallIsolation(options.root, options.dataDir, io.env);
  const registryUrl = resolveRegistryUrl(io.env, options.registryUrl);
  const npmInstallTimeoutMs = options.npmInstallTimeoutMs ?? DEFAULTS.npmInstallTimeoutMs;
  const payloadCheckTimeoutMs = options.payloadCheckTimeoutMs ?? DEFAULTS.payloadCheckTimeoutMs;
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
  const versionRoot = path.join(pathsOf(options.root).releasesDir, version);
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
