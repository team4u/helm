/**
 * Test fixtures for the Hub launcher: fake npm payloads (a self-contained `start.mjs` that mirrors
 * the real payload contract — `check` self-verification, `start` serving `/api/auth/status` — with
 * injectable failure modes) and a fake `UpdateCore` that stands in for the generic `@helm/update`
 * engine (registry download → npm layout materialization → immutable staging → update lock).
 *
 * These are test doubles, not product code: the production generic mechanism ships in
 * `@helm/update` and is bound via `src/update-core.ts`.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { killProcessTree } from '@helm/env-io';
import type { LauncherIo } from '../src/io.js';
import type { UpdateCore, StageHubReleaseSpec } from '../src/update-core.js';

export type FakePayloadMode =
  | 'ok'
  | 'crash' // start exits immediately with code 3
  | 'never-ready' // start stays alive but never listens (health gate fails)
  | 'ignore-signal' // healthy server that ignores SIGTERM (escalation path)
  | 'check-fail' // `start.mjs check` exits 1
  | 'check-hang'; // `start.mjs check` never exits (staging timeout path)

const START_MJS = `#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const mode = readFileSync(new URL('./payload-mode.txt', import.meta.url), 'utf8').trim();
const command = process.argv[2];
if (command === 'check') {
  if (mode === 'check-fail') { console.error('[fake-payload] self-check failed (mode)'); process.exit(1); }
  if (mode === 'check-hang') {
    console.log('[fake-payload] self-check hanging');
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {}); // park forever (top-level await; never falls through)
  }
  console.log('[fake-payload] check ok');
  process.exit(0);
}
if (command !== 'start') { console.error('usage: start.mjs <check|start>'); process.exit(1); }
if (mode === 'crash') { console.error('[fake-payload] crashing on start'); process.exit(3); }
if (mode === 'never-ready') { console.log('[fake-payload] never becoming ready'); setInterval(() => {}, 1 << 30); }
else {
  if (mode === 'ignore-signal') { process.on('SIGTERM', () => console.log('[fake-payload] ignoring SIGTERM')); process.on('SIGINT', () => {}); }
  const port = Number(process.env.HELM_PORT ?? '3202');
  const host = process.env.HELM_HOST ?? '127.0.0.1';
  const server = createServer((req, res) => {
    if (req.url === '/api/auth/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ configured: true, authenticated: false }));
      return;
    }
    if (req.url === '/__version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, host, () => console.log('[fake-payload] listening'));
}
`;

export interface FakePayloadOptions {
  dir: string;
  pkgName: string;
  version: string;
  mode?: FakePayloadMode;
}

/** Materialize a fake payload package directory (package.json + manifest.json + start.mjs + mode). */
export async function writeFakePayload(options: FakePayloadOptions): Promise<string> {
  const { dir, pkgName, version } = options;
  const mode = options.mode ?? 'ok';
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: pkgName, version, private: true }, null, 2)}\n`,
  );
  await fsp.writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(
      { formatVersion: 1, name: pkgName, version, entries: { hub: 'hub/dist/main.js' }, entryChecksums: { hub: '0'.repeat(64) } },
      null,
      2,
    )}\n`,
  );
  await fsp.writeFile(path.join(dir, 'payload-mode.txt'), mode, 'utf8');
  await fsp.writeFile(path.join(dir, 'start.mjs'), START_MJS, 'utf8');
  return dir;
}

/** Grab a free TCP port (bind :0, read the port, release). */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : undefined;
      server.close(() => {
        if (port === undefined) reject(new Error('failed to reserve a free port'));
        else resolve(port);
      });
    });
  });
}

export function captureIo(env: NodeJS.ProcessEnv = {}) {
  let out = '';
  let err = '';
  const io: LauncherIo = {
    env,
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  };
  return { io, outText: () => out, errText: () => err };
}

/** GET a JSON endpoint from a running fake hub (retries until responsive or budget expires). */
export async function getJson(port: number, pathname: string, timeoutMs = 10_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (res.ok) return await res.json();
    } catch {
      // not listening yet
    }
    if (Date.now() >= deadline) throw new Error(`GET :${port}${pathname} did not answer within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Wait until a pid exits (or fail after the budget); used to assert launcher cleanup. */
export async function waitUntilDead(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Spawn a bare long-lived node process (an "alien" pid for identity-refusal tests). */
export function spawnAlienProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  if (child.pid === undefined) throw new Error('failed to spawn alien process');
  return child.pid;
}

export interface FakeCoreOptions {
  pkgName: string;
  latest: string;
  /** version → fixture payload directory served by the fake registry. */
  payloads: Map<string, string>;
  /** local tarball path → fixture payload directory (--tarball installs). */
  localTarballs?: Map<string, string>;
  failLatest?: Error;
  failDownload?: Error;
  failNpm?: Error;
}

export interface FakeUpdateCore extends UpdateCore {
  npmCalls: string[][];
  installCalls: number;
  revalidateCalls: number;
  /** Register a local tarball ref (path) as installing the given fixture payload directory. */
  registerLocalTarball(ref: string, payloadDir: string): void;
}

/**
 * Fake `UpdateCore`: `downloadVerifiedTarball` materializes a marker tgz and remembers its source;
 * `runNpm install <ref>` copies the source payload into `<cwd>/node_modules/<pkg>` (the npm
 * layout); `stageImmutableRelease` and `withUpdateLock` are real-filesystem implementations of the
 * intended generic semantics (staging dir → uuid rename → `.complete` marker + cached revalidation;
 * `O_EXCL` lock).
 */
export function createFakeCore(options: FakeCoreOptions): FakeUpdateCore {
  const downloadedByDest = new Map<string, string>();
  const localTarballs = options.localTarballs ?? new Map<string, string>();
  const core: FakeUpdateCore = {
    npmCalls: [],
    installCalls: 0,
    revalidateCalls: 0,
    registerLocalTarball(ref, payloadDir) {
      localTarballs.set(ref, payloadDir);
    },
    async fetchLatestVersion() {
      if (options.failLatest !== undefined) throw options.failLatest;
      return options.latest;
    },
    async downloadVerifiedTarball(_pkgName, version, destPath) {
      if (options.failDownload !== undefined) throw options.failDownload;
      const source = options.payloads.get(version);
      if (source === undefined) throw new Error(`fake registry: no payload fixture for ${version}`);
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.writeFile(destPath, `fake-tarball:${version}\n`, { mode: 0o600 });
      downloadedByDest.set(destPath, source);
    },
    async runNpm(args, cwd) {
      core.npmCalls.push([...args]);
      if (options.failNpm !== undefined) throw options.failNpm;
      if (args[0] !== 'install') throw new Error(`fake npm: unsupported command ${args[0]}`);
      const ref = args[1] ?? '';
      const source = downloadedByDest.get(ref) ?? localTarballs.get(ref);
      if (source === undefined) throw new Error(`fake npm: unknown tarball ref ${ref}`);
      const target = path.join(cwd, 'node_modules', ...options.pkgName.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.cp(source, target, { recursive: true });
    },
    async stageImmutableRelease(releasesDir, spec: StageHubReleaseSpec) {
      const versionRoot = path.join(releasesDir, spec.version);
      const completePath = path.join(versionRoot, '.complete');
      if (spec.force !== true) {
        const cached = await readMarker(completePath);
        if (cached !== null && cached.version === spec.version) {
          core.revalidateCalls += 1;
          try {
            await spec.revalidate(cached.candidateDir, cached.entryRelative);
            const entryPath = path.resolve(cached.candidateDir, cached.entryRelative);
            if (entryPath !== cached.candidateDir && !entryPath.startsWith(cached.candidateDir + path.sep)) {
              throw new Error('cached entry escapes candidate dir');
            }
            return { version: spec.version, releaseDir: cached.candidateDir, entryPath, reusedCached: true };
          } catch {
            // Cached candidate failed revalidation: fall through and stage a fresh one.
          }
        }
      }
      await fsp.mkdir(versionRoot, { recursive: true });
      const stagingDir = path.join(versionRoot, `.staging-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);
      try {
        await fsp.mkdir(stagingDir, { recursive: true });
        core.installCalls += 1;
        const entryRelative = await spec.install(stagingDir);
        if (path.isAbsolute(entryRelative)) throw new Error(`install returned absolute entry path: ${entryRelative}`);
        const entryPath = path.resolve(stagingDir, entryRelative);
        if (entryPath !== stagingDir && !entryPath.startsWith(stagingDir + path.sep)) {
          throw new Error(`install entry escapes stagingDir: ${entryRelative}`);
        }
        await fsp.access(entryPath);
        const candidateDir = path.join(versionRoot, randomUUID());
        await fsp.rename(stagingDir, candidateDir);
        const finalEntry = path.join(candidateDir, entryRelative);
        await fsp.writeFile(
          completePath,
          `${JSON.stringify(
            { version: spec.version, candidateDir, entryRelative, completedAt: new Date().toISOString() },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
        return { version: spec.version, releaseDir: candidateDir, entryPath: finalEntry, reusedCached: false };
      } catch (error) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },
    async withUpdateLock(rootDir, fn) {
      await fsp.mkdir(rootDir, { recursive: true });
      const lockPath = path.join(rootDir, 'update.lock');
      let handle: fsp.FileHandle;
      try {
        handle = await fsp.open(lockPath, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`update already in progress: ${lockPath} exists (another update is running)`);
        }
        throw error;
      }
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => undefined);
        await fsp.unlink(lockPath).catch(() => undefined);
      }
    },
  };
  return core;
}

interface CompleteMarker {
  version: string;
  candidateDir: string;
  entryRelative: string;
  completedAt: string;
}

async function readMarker(file: string): Promise<CompleteMarker | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as Record<string, unknown>;
    if (
      typeof raw['version'] === 'string' &&
      typeof raw['candidateDir'] === 'string' &&
      typeof raw['entryRelative'] === 'string' &&
      typeof raw['completedAt'] === 'string'
    ) {
      return {
        version: raw['version'],
        candidateDir: raw['candidateDir'],
        entryRelative: raw['entryRelative'],
        completedAt: raw['completedAt'],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort cleanup helper for test-scoped hub processes (never throws). */
export function cleanupPid(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    killProcessTree(pid);
  } catch {
    // already gone
  }
}
