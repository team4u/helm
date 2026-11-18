/**
 * Hub payload staging strategy: how a published npm payload becomes a verified, immutable release
 * candidate. All generic machinery (immutable staging directories, `.complete` markers and cache
 * reuse, staging cleanup, registry metadata, verified download, npm runner) flows through the
 * `UpdateCore` port (`update-core.ts` binds it to the shared `@helm/update` engine; tests inject a
 * port fake whose staging delegates to the real engine); this module only defines the Hub layout
 * policy inside the staged extractor:
 *
 * 1. obtain the payload tarball — registry (manifest fetch + tarball download + sha512 SRI
 *    verification, all engine primitives behind the port) or a local `--tarball` file (verified
 *    by the payload's own `start.mjs check` checksum contract);
 * 2. unpack the tarball into the candidate's `node_modules/<pkg>` slot, then run
 *    `npm install --omit=dev --ignore-scripts` inside the unpacked payload root (the payload
 *    ships its `@helm/*` dependencies as relative `file:./<pkg>.tgz` archives; npm resolves those
 *    against the outer tarball's cache extraction path when installing the tarball directly —
 *    before the outer package lands on disk, which fails with ENOENT on real artifacts — while
 *    the unpacked root is the layout npm resolves correctly; esbuild platform binaries arrive via
 *    optionalDependencies). Both entry points (registry and `--tarball`) share this exact path;
 * 3. verify the installed package identity (name/version) and the `start.mjs` + `manifest.json`
 *    contract files, including the manifest's `nodeEngines` floor against the launcher's own Node;
 * 4. run `node start.mjs check` — the payload's own zero-dependency self-verification (entry
 *    checksums, dependency resolution, runtime capability probes). Never starts the Hub.
 *
 * Cache reuse is the engine's marker contract: a valid `.complete` marker short-circuits with
 * structural revalidation (entry files exist inside the immutable candidate); the extractor above
 * is not re-run for cached candidates.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { killProcessTree } from '@helm/env-io';
import { isStrictSemver } from '@helm/protocol';
import { extract as tarExtract } from 'tar';
import { DEFAULTS, assertInstallIsolation, packageModulesDir, pathsOf, resolveRegistryUrl } from './layout.js';
import { resolveInsideRelease } from './records.js';
import type { LauncherIo } from './io.js';
import { defaultUpdateCore, type UpdateCore } from './update-core.js';

const CHECK_OUTPUT_LIMIT = 400_000;
const DIAG_LINES = 40;
/** Supported `nodeEngines` shape: a `>=x.y.z` floor (what the payload builder ships). */
const NODE_ENGINES_PATTERN = /^>=\s*(\d+)\.(\d+)\.(\d+)$/;

export interface StageHubOptions {
  io: LauncherIo;
  /** Port fake for tests; production uses the real `@helm/update` adapter. */
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
  /** Local tarball install source (skips the registry download; still npm-installed + self-checked). */
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
 * Unpack a packed payload tarball into `destDir` (the candidate's `node_modules/<pkg>` slot).
 *
 * Why unpack instead of `npm install <tarball>`: the payload manifest carries `@helm/*`
 * dependencies as relative `file:./<pkg>.tgz` archives, and npm resolves those against the outer
 * tarball's cache extraction path before the outer package lands on disk (ENOENT with real
 * artifacts); `npm install` inside the unpacked payload root is the layout npm resolves correctly.
 *
 * Security boundary: only regular files and directories under the `package/` prefix are
 * extracted — links, device nodes, absolute paths, and `..` segments are rejected outright.
 */
async function extractPayloadTarball(tarballPath: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  let accepted = 0;
  await tarExtract({
    f: tarballPath,
    cwd: destDir,
    strip: 1,
    filter: (entryPath: string, entry) => {
      const rel = entryPath.replace(/\\/g, '/');
      if (rel.split('/').includes('..')) return false;
      if (rel !== 'package' && !rel.startsWith('package/')) return false;
      const entryType = (entry as { type?: string }).type;
      if (entryType !== 'File' && entryType !== 'Directory') return false;
      accepted += 1;
      return true;
    },
  });
  if (accepted === 0) {
    throw new Error(`payload tarball ${tarballPath} contains no extractable package/ entries`);
  }
  try {
    await fsp.access(path.join(destDir, 'package.json'));
  } catch {
    throw new Error(
      `payload tarball ${tarballPath} did not contain a package/ root (package.json missing after unpack)`,
    );
  }
}

/** Verify the npm-installed payload package identity and contract files inside `rootDir`. */
async function verifyPayloadLayout(
  rootDir: string,
  pkgName: string,
  version: string,
  nodeVersion: string,
): Promise<string> {
  const payloadDir = packageModulesDir(path.join(rootDir, 'node_modules'), pkgName);
  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(await fsp.readFile(path.join(payloadDir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `installed payload package.json unreadable (${payloadDir}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (pkgJson.name !== pkgName || pkgJson.version !== version) {
    throw new Error(
      `installed payload package mismatch: expected ${pkgName}@${version}, got ${String(pkgJson.name)}@${String(pkgJson.version)} (${payloadDir})`,
    );
  }
  const entry = path.join(payloadDir, 'start.mjs');
  const manifest = path.join(payloadDir, 'manifest.json');
  for (const [label, file] of [
    ['start.mjs entry', entry],
    ['manifest.json contract', manifest],
  ] as const) {
    try {
      await fsp.access(file);
    } catch {
      throw new Error(`installed payload is missing its ${label}: ${file}`);
    }
  }
  let manifestJson: Record<string, unknown>;
  try {
    manifestJson = JSON.parse(await fsp.readFile(manifest, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `installed payload manifest.json unreadable (${manifest}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifestJson.name !== pkgName || manifestJson.version !== version) {
    throw new Error(
      `installed payload manifest mismatch: expected ${pkgName}@${version}, got ${String(manifestJson.name)}@${String(manifestJson.version)} (${manifest})`,
    );
  }
  assertNodeEngines(manifestJson.nodeEngines, manifest, nodeVersion);
  return path.relative(rootDir, entry);
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
    let tarballRef: string;
    if (options.tarballPath !== undefined) {
      const resolved = path.resolve(options.tarballPath);
      try {
        const stat = await fsp.stat(resolved);
        if (!stat.isFile()) throw new Error('not a regular file');
        tarballRef = resolved;
      } catch (error) {
        throw new Error(
          `invalid --tarball path ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      const dest = path.join(stagingDir, '.downloads', 'payload.tgz');
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await core.downloadVerifiedTarball(registryUrl, pkgName, version, dest, options.fetchFn);
      tarballRef = dest;
    }

    // Unpack into the candidate's node_modules/<pkg> slot, then install inside the unpacked
    // payload root (see extractPayloadTarball for why the direct `npm install <tarball>` form
    // fails on real payloads). The registry download must not ride into the immutable candidate.
    const payloadDir = packageModulesDir(path.join(stagingDir, 'node_modules'), pkgName);
    try {
      await extractPayloadTarball(tarballRef, payloadDir);
    } finally {
      if (options.tarballPath === undefined) {
        await fsp.rm(path.join(stagingDir, '.downloads'), { recursive: true, force: true }).catch(() => {});
      }
    }
    await core.runNpm(
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registryUrl],
      payloadDir,
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
  return {
    version: staged.version,
    releaseDir: staged.releaseDir,
    entryPath,
    reusedCached: candidatesBefore.includes(path.basename(staged.releaseDir)),
  };
}
