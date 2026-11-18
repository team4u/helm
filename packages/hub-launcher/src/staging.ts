/**
 * Hub payload staging strategy: how a published npm payload becomes a verified, immutable release
 * candidate. All generic machinery (immutable staging directories, `.complete` markers and cache
 * reuse, staging cleanup, registry metadata, verified download, npm runner) flows through the
 * `UpdateCore` port (`update-core.ts` binds it to the shared `@helm/update` engine; tests inject a
 * port fake whose staging delegates to the real engine); this module only defines the Hub layout
 * policy inside the staged extractor:
 *
 * 1. obtain the payload tarball — registry (engine `downloadVerifiedTarball`: exact-version
 *    manifest fetch, tarball download, sha512 SRI verification) or a local `--tarball` file;
 * 2. unpack the archive into the staging root first (npm resolves a payload's inner
 *    `file:./<pkg>.tgz` dependencies relative to the package directory, which only exists after
 *    extraction — installing the outer tarball directly makes npm fail with ENOENT). Extraction
 *    accepts only regular files/directories under the npm `package/` root — no links, no escapes;
 * 3. `npm install <unpacked-package-dir> --omit=dev --ignore-scripts` inside the staging
 *    directory (one install completes the whole `file:` dependency closure — esbuild platform
 *    binaries arrive via optionalDependencies);
 * 4. verify the installed package identity (name/version) and the `start.mjs` + `manifest.json`
 *    contract files, including the manifest's `nodeEngines` floor against the launcher's own Node;
 * 5. run `node start.mjs check` — the payload's own zero-dependency self-verification (entry
 *    checksums, dependency resolution, runtime capability probes). Never starts the Hub.
 *
 * Cache reuse: the engine's `.complete` marker short-circuits staging with a structural check
 * only (entry files exist), so the launcher revalidates reused candidates itself — package
 * identity, manifest contract, and the payload self-check — and restages (`force`) when a cached
 * candidate no longer passes (#92); a genuinely broken restage then fails explicitly.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { killProcessTree } from '@helm/env-io';
import { isStrictSemver } from '@helm/protocol';
import * as tar from 'tar';
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
  /** Local tarball install source (unpacked and installed like the registry channel). */
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

/**
 * Unpack an npm tarball into `<destDir>/package/` and return that directory. Strict filter:
 * regular files and directories under the npm `package/` root only — symbolic/hard links,
 * devices, and any path escaping the archive root are rejected (never extracted).
 */
async function extractPayloadTarball(tarballPath: string, destDir: string): Promise<string> {
  await fsp.mkdir(destDir, { recursive: true });
  let entries = 0;
  await tar.extract({
    file: tarballPath,
    cwd: destDir,
    strict: true,
    filter: (entryPath, stat) => {
      // ReadEntry.type is authoritative for archive members; only regular files and
      // directories are ever accepted (no links, devices, or anything else npm can pack).
      const kind = (stat as { type?: string }).type;
      if (kind !== 'File' && kind !== 'Directory') return false;
      const normalized = entryPath.replace(/\\/g, '/');
      const rest = normalized === 'package' || normalized === 'package/' ? '' : normalized.startsWith('package/') ? normalized.slice('package/'.length) : null;
      if (rest === null) return false;
      return rest === '' || (!rest.split('/').includes('..') && !rest.split('/').includes(''));
    },
    onReadEntry: () => {
      entries += 1;
    },
  });
  const packageDir = path.join(destDir, 'package');
  try {
    await fsp.access(path.join(packageDir, 'package.json'));
  } catch {
    throw new Error(
      `payload tarball did not contain a package/package.json root (${tarballPath}; ${entries} entries extracted)`,
    );
  }
  return packageDir;
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
    // 1. Obtain the outer payload tarball (registry download is SRI-verified by the engine port).
    let outerTarball: string;
    if (options.tarballPath !== undefined) {
      const resolved = path.resolve(options.tarballPath);
      try {
        const stat = await fsp.stat(resolved);
        if (!stat.isFile()) throw new Error('not a regular file');
        outerTarball = resolved;
      } catch (error) {
        throw new Error(
          `invalid --tarball path ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      const dest = path.join(stagingDir, '.downloads', 'payload.tgz');
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await core.downloadVerifiedTarball(registryUrl, pkgName, version, dest, options.fetchFn);
      outerTarball = dest;
    }

    // 2. Unpack before install: npm resolves inner `file:./<pkg>.tgz` dependencies relative to
    //    the extracted package directory (installing the outer tarball directly fails ENOENT).
    const packageDir = await extractPayloadTarball(outerTarball, path.join(stagingDir, 'payload-src'));

    // 3. Offline install of the unpacked payload package into the staging root's node_modules.
    await fsp.writeFile(
      path.join(stagingDir, 'package.json'),
      JSON.stringify({ name: 'helm-hub-release', private: true }, null, 2) + '\n',
      'utf8',
    );
    await core.runNpm(
      ['install', packageDir, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registryUrl],
      stagingDir,
      npmInstallTimeoutMs,
    );

    // 4-5. Contract verification + payload self-check.
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

  let staged = await core.stageRelease(options.root, version, extractor, {
    ...(options.force ? { force: true } : {}),
  });
  let entryPath = staged.entries['entryPath'];
  if (entryPath === undefined) {
    throw new Error(`staged release has no "entryPath" entry (got: ${Object.keys(staged.entries).join(', ') || 'none'})`);
  }

  // The engine's cache path only checks entry existence (#92): revalidate the reused candidate
  // with the full contract (package identity, manifest, nodeEngines, payload self-check). A
  // stale or tampered candidate is discarded by restaging fresh (prior candidates are never
  // deleted — the engine's immutability contract); a restage that still fails throws explicitly.
  if (candidatesBefore.includes(path.basename(staged.releaseDir))) {
    const revalidate = async (): Promise<void> => {
      await verifyPayloadLayout(staged.releaseDir, pkgName, version, nodeVersion);
      await runPayloadSelfCheck(entryPath!, payloadCheckTimeoutMs);
    };
    try {
      await revalidate();
    } catch {
      staged = await core.stageRelease(options.root, version, extractor, { force: true });
      entryPath = staged.entries['entryPath'];
      if (entryPath === undefined) {
        throw new Error(`restaged release has no "entryPath" entry (got: ${Object.keys(staged.entries).join(', ') || 'none'})`);
      }
      await revalidate();
    }
  }

  return {
    version: staged.version,
    releaseDir: staged.releaseDir,
    entryPath,
    reusedCached: candidatesBefore.includes(path.basename(staged.releaseDir)),
  };
}
