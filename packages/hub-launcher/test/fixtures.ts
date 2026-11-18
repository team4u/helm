/**
 * Test fixtures for the Hub launcher:
 *
 * - fake npm payloads: a self-contained `start.mjs` mirroring the real payload contract
 *   (`check` self-verification, `start` verifying then serving `/api/auth/status`) with injectable
 *   failure modes. On a successful listen it prints the real Hub startup banner —
 *   `Helm Hub: http://<host>:<port>` — which the launcher's readiness gate scans for;
 * - a port-shaped fake `UpdateCore`: the registry (`fetchLatestVersion`) and npm (`runNpm`)
 *   seams are stubbed (no network, no npm), while immutable staging delegates to the REAL
 *   `@helm/update` engine so launcher tests cannot drift from the generic semantics;
 * - a fake registry `fetch` serving real `npm pack` tarballs with correct sha512 SRI metadata,
 *   where every fixture payload carries one inner `file:./fixture-inner-dep.tgz` dependency (the
 *   real payload ships @helm/* exactly this way; golden paths must prove the extractor's
 *   unpack-then-install ordering resolves them — a direct `npm install <outer.tgz>` fails with
 *   ENOENT on real artifacts,
 *   for golden-path staging through the full production extractor (real download verification +
 *   real npm install + real self-check).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { killProcessTree } from '@helm/env-io';
import { create as tarCreate, extract as tarExtract } from 'tar';
import { defaultUpdateCore, type UpdateCore } from '../src/update-core.js';
import type { LauncherIo } from '../src/io.js';

export type FakePayloadMode =
  | 'ok' // normal startup: log lines, listen, banner
  | 'crash' // start exits immediately with code 3
  | 'never-ready' // start stays alive but never prints the banner
  | 'ignore-signal' // healthy server that ignores SIGTERM (escalation path)
  | 'wrong-port-banner' // prints a banner naming a different port (port-filter path)
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
  // The inner file: dependency must resolve — proves the candidate's npm install completed
  // inside the unpacked payload root (the real payload ships @helm/* the same way).
  try {
    const dep = await import('fixture-inner-dep');
    if (dep.marker !== 'inner-dep') throw new Error('bad marker');
  } catch (error) {
    console.error('[fake-payload] inner file: dependency did not resolve:', error);
    process.exit(3);
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
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const bannerPort = mode === 'wrong-port-banner' ? (port === 1 ? 2 : 1) : port;
  // Preceding log lines on purpose: the readiness scan must find the banner mid-chunk (#72).
  console.log('[fake-payload] layout validated');
  console.log('[fake-payload] dependencies resolved');
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
  server.listen(port, host, () => console.log(\`Helm Hub: http://\${displayHost}:\${bannerPort}\`));
}
`;

export interface FakePayloadOptions {
  dir: string;
  pkgName: string;
  version: string;
  mode?: FakePayloadMode;
  /** Written into manifest.json; the staging nodeEngines gate compares it against the launcher's Node. */
  nodeEngines?: string;
}

/** Materialize a fake payload package directory (package.json + manifest.json + start.mjs + mode). */
export async function writeFakePayload(options: FakePayloadOptions): Promise<string> {
  const { dir, pkgName, version } = options;
  const mode = options.mode ?? 'ok';
  await fsp.mkdir(dir, { recursive: true });
  // Inner file: dependency archive (built with the repo-pinned tar): mirrors the real payload's
  // `@helm/*: file:./<pkg>.tgz` layout so golden paths regress the unpack→install ordering.
  const innerSrc = path.join(dir, '.fixture-inner-src');
  await fsp.mkdir(innerSrc, { recursive: true });
  await fsp.writeFile(
    path.join(innerSrc, 'package.json'),
    `${JSON.stringify({ name: 'fixture-inner-dep', version: '1.0.0', type: 'module', main: 'index.js' }, null, 2)}\n`,
  );
  await fsp.writeFile(path.join(innerSrc, 'index.js'), 'export const marker = "inner-dep";\n');
  await tarCreate(
    { cwd: innerSrc, file: path.join(dir, 'fixture-inner-dep.tgz'), gzip: true, portable: true, prefix: 'package' },
    ['package.json', 'index.js'],
  );
  await fsp.rm(innerSrc, { recursive: true, force: true });
  await fsp.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: pkgName,
        version,
        private: true,
        dependencies: { 'fixture-inner-dep': 'file:./fixture-inner-dep.tgz' },
        files: ['start.mjs', 'manifest.json', 'payload-mode.txt', 'fixture-inner-dep.tgz'],
      },
      null,
      2,
    )}\n`,
  );
  await fsp.writeFile(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(
      {
        formatVersion: 1,
        name: pkgName,
        version,
        builtAt: new Date().toISOString(),
        nodeEngines: options.nodeEngines ?? '>=18.0.0',
        entries: { launcher: 'start.mjs' },
        entryChecksums: { launcher: '0'.repeat(64) },
      },
      null,
      2,
    )}\n`,
  );
  await fsp.writeFile(path.join(dir, 'payload-mode.txt'), mode, 'utf8');
  await fsp.writeFile(path.join(dir, 'start.mjs'), START_MJS, 'utf8');
  return dir;
}

/** Pack a fixture payload directory into a real npm tarball (`npm pack`); returns its path. */
export async function packPayloadTarball(payloadDir: string): Promise<string> {
  const result = await new Promise<{ code: number | null; error?: Error; stdout: string; stderr: string }>(
    (resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn('npm', ['pack', '--json', '--silent'], { cwd: payloadDir, shell: false });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const finish = (code: number | null, error?: Error): void => {
        if (settled) return;
        settled = true;
        resolve({ code, error, stdout, stderr });
      };
      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
    },
  );
  if (result.error !== undefined || result.code !== 0) {
    throw new Error(
      `npm pack failed (${payloadDir}): ${result.error?.message ?? `exit ${result.code}`}\n${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Array<{ filename: string }>;
  const filename = parsed[0]?.filename;
  if (filename === undefined) throw new Error(`npm pack returned no filename: ${result.stdout}`);
  return path.join(payloadDir, filename);
}

/** sha512 SRI string of a file (`sha512-<base64>`, matching npm dist.integrity). */
export function sriOf(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fsp
      .readFile(file)
      .then((bytes) => resolve(`sha512-${createHash('sha512').update(bytes).digest('base64')}`))
      .catch(reject);
  });
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
  failLatest?: Error;
  failDownload?: Error;
  failNpm?: Error;
}

export interface FakeUpdateCore extends UpdateCore {
  npmCalls: string[][];
  /** Register a local tarball ref (path) as installing the given fixture payload directory. */
}

/**
 * Port-shaped fake: `fetchLatestVersion`/`downloadVerifiedTarball`/`runNpm` are stubbed against
 * fixture payloads; `stageRelease` delegates to the REAL engine adapter so staging semantics
 * (`.complete` markers, cache reuse, staging cleanup) are the production ones.
 */
export function createFakeCore(options: FakeCoreOptions): FakeUpdateCore {
  const real = defaultUpdateCore();
  const core: FakeUpdateCore = {
    npmCalls: [],
    async fetchLatestVersion() {
      if (options.failLatest !== undefined) throw options.failLatest;
      return options.latest;
    },
    async downloadVerifiedTarball(_registryUrl, _pkgName, version, destPath) {
      if (options.failDownload !== undefined) throw options.failDownload;
      const source = options.payloads.get(version);
      if (source === undefined) throw new Error(`fake registry: no payload fixture for ${version}`);
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      // Pack a real npm-shaped tarball: the production extractor unpacks it with tar, so a marker
      // file would fail extraction before the orchestration under test ever runs.
      const entries = (await fsp.readdir(source)).filter((name) => !name.startsWith('.'));
      await tarCreate({ cwd: source, file: destPath, gzip: true, portable: true, prefix: 'package' }, entries);
    },
    async runNpm(args, cwd) {
      core.npmCalls.push([...args]);
      if (options.failNpm !== undefined) throw options.failNpm;
      if (args[0] !== 'install') throw new Error(`fake npm: unsupported command ${args[0]}`);
      if (args[1] !== undefined && !args[1]!.startsWith('--')) {
        throw new Error(`fake npm: unexpected positional argument ${args[1]}`);
      }
      // Ref-less install (the production extractor already unpacked the payload at cwd):
      // complete the inner file: dependencies by unpacking every payload-root *.tgz into
      // node_modules/<basename> — what `npm install` does for `file:./<name>.tgz` deps.
      const target = path.join(cwd, 'node_modules');
      await fsp.mkdir(target, { recursive: true });
      for (const ent of await fsp.readdir(cwd)) {
        if (!ent.endsWith('.tgz')) continue;
        const depDir = path.join(target, ent.slice(0, -4));
        await fsp.mkdir(depDir, { recursive: true });
        await tarExtract({ f: path.join(cwd, ent), cwd: depDir, strip: 1 });
      }
    },
    stageRelease(root, version, extractor, stageOptions) {
      return real.stageRelease(root, version, extractor, stageOptions);
    },
  };
  return core;
}

export interface FakeRegistry {
  registryUrl: string;
  /** Map an explicit version to a packed tarball (call before staging that version). */
  serve(version: string, tarballPath: string, options?: { integrity?: string }): Promise<void>;
  fetchImpl: typeof fetch;
}

/**
 * Fake npm registry over the `fetchFn` seam: serves `<registry>/<pkg>/latest`,
 * `<registry>/<pkg>/<version>` (with a sha512 `dist.integrity`), and the tarball bytes. The
 * optional `integrity` override feeds tampering tests through the real verification chain.
 * Used with the REAL update core for golden-path staging through the production extractor.
 */
export async function createFakeRegistry(pkgName: string, latest: string): Promise<FakeRegistry> {
  const registryUrl = 'https://registry.fake.local';
  const tarballs = new Map<string, { file: string; integrity?: string }>();
  const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const tarballMatch = /\/tarball\/([^/]+)$/.exec(url);
    if (tarballMatch !== null) {
      const served = tarballs.get(decodeURIComponent(tarballMatch[1]!));
      if (served === undefined) return new Response('no such tarball', { status: 404 });
      const bytes = await fsp.readFile(served.file);
      return new Response(new Uint8Array(bytes), { status: 200 });
    }
    if (/\/latest$/.test(url)) {
      return Response.json({ name: pkgName, version: latest });
    }
    const exactMatch = new RegExp(`/([^/]+)/([0-9][^/]*)$`).exec(url.replace(registryUrl, ''));
    if (exactMatch !== null) {
      const version = exactMatch[2]!;
      const served = tarballs.get(version);
      if (served === undefined) return new Response('version not found', { status: 404 });
      return Response.json({
        name: pkgName,
        version,
        dist: {
          integrity: served.integrity ?? (await sriOf(served.file)),
          tarball: `${registryUrl}/tarball/${encodeURIComponent(version)}`,
        },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    registryUrl,
    async serve(version, tarballPath, options) {
      tarballs.set(version, { file: tarballPath, ...(options?.integrity !== undefined ? { integrity: options.integrity } : {}) });
    },
    fetchImpl,
  };
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
