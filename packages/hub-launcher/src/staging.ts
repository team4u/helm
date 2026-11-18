/**
 * Hub payload staging strategy: how a published npm payload becomes a verified, immutable release
 * candidate. All generic machinery (verified download, npm runner, immutable staging, markers,
 * locking) is delegated to the injected `UpdateCore`; this module only defines the Hub layout:
 *
 * 1. obtain the payload tarball — registry (core downloads + sha512-verifies it) or a local
 *    `--tarball` file (verified by the payload's own `start.mjs check` checksum contract);
 * 2. `npm install <tarball> --omit=dev --ignore-scripts` inside the staging directory (the payload
 *    ships its `@helm/*` dependencies as bundled `file:./<pkg>.tgz` archives, so one install
 *    completes the whole dependency closure — esbuild platform binaries arrive via
 *    optionalDependencies);
 * 3. verify the installed package identity (name/version) and the `start.mjs` + `manifest.json`
 *    contract files;
 * 4. run `node start.mjs check` — the payload's own zero-dependency self-verification (entry
 *    checksums, dependency resolution, runtime capability probes). Never starts the Hub.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { killProcessTree } from '@helm/env-io';
import { isStrictSemver } from '@helm/protocol';
import { DEFAULTS, packageModulesDir, pathsOf, resolveRegistryUrl } from './layout.js';
import { resolveInsideRelease } from './records.js';
import type { LauncherIo } from './io.js';
import type { UpdateCore } from './update-core.js';

const CHECK_OUTPUT_LIMIT = 400_000;
const DIAG_LINES = 40;

export interface StageHubOptions {
  io: LauncherIo;
  core: UpdateCore;
  /** Launcher install root (staging happens under `<root>/releases/<version>/`). */
  root: string;
  /** Strict-semver target version. */
  version: string;
  /** Published payload package name. */
  pkgName: string;
  registryUrl?: string;
  /** Local tarball install source (skips the registry download; still npm-installed + self-checked). */
  tarballPath?: string;
  force?: boolean;
  fetchFn?: typeof fetch;
  npmInstallTimeoutMs?: number;
  payloadCheckTimeoutMs?: number;
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

interface InstalledPayloadLayout {
  entryRelative: string;
}

/** Verify the npm-installed payload package identity and contract files inside `rootDir`. */
async function verifyPayloadLayout(rootDir: string, pkgName: string, version: string): Promise<InstalledPayloadLayout> {
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
  return { entryRelative: path.relative(rootDir, entry) };
}

/** Stage (or reuse) the Hub payload release for `version`. */
export async function stageHubRelease(options: StageHubOptions): Promise<StagedHubRelease> {
  const { io, core, version, pkgName } = options;
  if (!isStrictSemver(version)) {
    throw new Error(`invalid target version: "${version}" (expected strict x.y.z[-pre][+build] without v prefix)`);
  }
  const registryUrl = resolveRegistryUrl(io.env, options.registryUrl);
  const npmInstallTimeoutMs = options.npmInstallTimeoutMs ?? DEFAULTS.npmInstallTimeoutMs;
  const payloadCheckTimeoutMs = options.payloadCheckTimeoutMs ?? DEFAULTS.payloadCheckTimeoutMs;

  const install = async (stagingDir: string): Promise<string> => {
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
      await core.downloadVerifiedTarball(pkgName, version, dest, {
        registryUrl,
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      });
      tarballRef = dest;
    }

    await fsp.writeFile(
      path.join(stagingDir, 'package.json'),
      JSON.stringify({ name: 'helm-hub-release', private: true }, null, 2) + '\n',
      'utf8',
    );
    await core.runNpm(
      ['install', tarballRef, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registryUrl],
      stagingDir,
      npmInstallTimeoutMs,
    );

    const layout = await verifyPayloadLayout(stagingDir, pkgName, version);
    const entry = resolveInsideRelease(stagingDir, layout.entryRelative, 'payload entry path');
    await runPayloadSelfCheck(entry, payloadCheckTimeoutMs);
    return layout.entryRelative;
  };

  const revalidate = async (candidateDir: string, entryRelative: string): Promise<void> => {
    await verifyPayloadLayout(candidateDir, pkgName, version);
    const entry = resolveInsideRelease(candidateDir, entryRelative, 'cached payload entry path');
    await runPayloadSelfCheck(entry, payloadCheckTimeoutMs);
  };

  const staged = await core.stageImmutableRelease(pathsOf(options.root).releasesDir, {
    version,
    install,
    revalidate,
    ...(options.force ? { force: true } : {}),
  });
  return {
    version: staged.version,
    releaseDir: staged.releaseDir,
    entryPath: staged.entryPath,
    reusedCached: staged.reusedCached,
  };
}
