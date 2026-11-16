#!/usr/bin/env node
/**
 * Assembles the production Hub baseline for desktop installers: reuses the @helm/payload dist,
 * materializes the complete production dependency closure, copies the npm CLI, and really launches it
 * for acceptance in an isolated directory outside the repository.
 *
 * Output layout (packages/desktop/hub/, electron-builder extraResources → <resources>/hub):
 *   hub/{package.json, manifest.json, start.mjs}   reused payload dist (same-source contract)
 *   hub/hub/ hub/kernel/ hub/plugins/ hub/plugin-build/ hub/plugin-client/ hub/protocol/ hub/cli/ hub/web/
 *                                                  the hub/kernel/plugins/plugin-build/plugin-client/
 *                                                  protocol/cli/web artifacts
 *   hub/node_modules/...                            the production dependency closure (see below)
 *   hub/tools/npm/                                  the npm CLI's complete file closure (bin/npm-cli.js,
 *                                                   run by the main agent via Electron run-as-node)
 *
 * Dependency materialization mechanism (honesty boundary: only this runner's architecture is materialized —
 * published business payloads are npm-installed per platform by the client; the baseline installer embeds
 * the current packaging architecture):
 * - source: the repository's installed pnpm resolution. Every package is copied from its real directory
 *   (.pnpm virtual store or workspace package directory) as real files; symlink entries inside a
 *   package's node_modules are always excluded (no out-of-repository / dangling symlinks), while real
 *   directory entries (e.g. npm's bundled dependencies) are kept as-is;
 * - rebuild: replayed from the real dependency graph (dependencies + peerDependencies + installed
 *   optionalDependencies) in npm's nested layout — hoisted to the hub/node_modules root when possible,
 *   nested under the dependent's node_modules on version conflicts (never just one flat layer, never
 *   sharing a wrong version);
 * - acceptance: by default the Hub is really launched in an isolated directory outside the repository
 *   (HTTP probe against /api/auth/status) — not verified inside the repository, to rule out node
 *   resolution sneaking into the repository node_modules and faking a pass. --no-verify skips it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageCopyFilter, prodDepEntries, resolveDepRealDir } from '../../payload/src/dep-closure.mjs';

const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(pkgRoot, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const hubDir = path.join(desktopRoot, 'hub');
const payloadDist = path.join(repoRoot, 'packages/payload/dist');
const runArg = process.argv.slice(2);
const verify = !runArg.includes('--no-verify');

const fail = (msg) => {
  console.error(`[assemble-hub] ${msg}`);
  process.exit(1);
};

// --- Precondition: the payload dist must be ready (assembled once automatically when missing) -------------------------
if (!existsSync(path.join(payloadDist, 'manifest.json'))) {
  console.log('[assemble-hub] payload dist missing, running @helm/payload build first ...');
  const res = spawnSync('pnpm', ['--filter', '@helm/payload', 'run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  if (res.status !== 0) fail('payload dist assembly failed (see the output above)');
}
if (!existsSync(path.join(payloadDist, 'hub/dist/main.js'))) fail(`payload dist layout unexpected: ${payloadDist}`);

// --- Reuse the payload dist (same-source contract, no duplicate implementation) --------------------------------------
rmSync(hubDir, { recursive: true, force: true });
mkdirSync(hubDir, { recursive: true });
for (const ent of readdirSync(payloadDist)) {
  cpSync(path.join(payloadDist, ent), path.join(hubDir, ent), { recursive: true, dereference: true });
}
const hubPkg = JSON.parse(readFileSync(path.join(hubDir, 'package.json'), 'utf-8'));

// --- Production dependency closure materialization -------------------------------------------------------------------
/** Copies a package directory: excludes symlink entries inside its node_modules (pnpm-injected) while keeping real directories (e.g. npm's bundled dependencies). */
function copyPackageRealDir(srcDir, destDir) {
  cpSync(srcDir, destDir, { recursive: true, dereference: true, filter: packageCopyFilter(srcDir) });
}

/** The upward resolution chain of a consumer directory inside hub (skipping node_modules containers and @scope container directories). */
function resolutionChain(consumerDir) {
  const chain = [];
  let cur = consumerDir;
  while (true) {
    const base = path.basename(cur);
    const parent = path.dirname(cur);
    const isScopeContainer = base.startsWith('@') && path.basename(parent) === 'node_modules';
    if (base !== 'node_modules' && !isScopeContainer) chain.push(cur);
    if (cur === hubDir) break;
    const next = parent;
    if (next === cur || cur.length < hubDir.length) break;
    cur = next;
  }
  // chain[0] = the consumer itself (nearest) → last = hub root: matching Node's nearest-wins resolution semantics.
  return chain;
}

const placed = new Map(); // dest package dir -> { name, version }
const copyQueue = [];
const problems = [];

/**
 * Places a dependency: skipped when the same version already resolves from consumerDir; otherwise hoisted
 * to the hub/node_modules root (when no conflict) or nested under consumerDir/node_modules (on conflict).
 */
function placeDep(name, realDir, pkgJson, consumerDir) {
  for (const level of resolutionChain(consumerDir)) {
    const existing = placed.get(path.join(level, 'node_modules', name));
    if (existing) {
      if (existing.version === pkgJson.version) return; // already resolvable correctly
      break; // conflict: fall through to nested placement below
    }
  }
  const hoisted = path.join(hubDir, 'node_modules', name);
  const hoistedExisting = placed.get(hoisted);
  const dest = !hoistedExisting ? hoisted : path.join(consumerDir, 'node_modules', name);
  if (placed.has(dest)) {
    problems.push(`${name}@${pkgJson.version}: nested slot ${dest} is already occupied by ${placed.get(dest).version} (deeper nesting needed; the current baseline doesn't cover this shape)`);
    return;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyQueue.push([realDir, dest]);
  placed.set(dest, { name, version: pkgJson.version });
  // Recursively materialize the package's production dependencies (resolved from the real directory side —
  // inside .pnpm its dependencies are already in place per the peer closure).
  for (const { name: depName, optional } of prodDepEntries(pkgJson)) {
    const resolved = resolveDepRealDir(realDir, depName, optional);
    if (resolved === null) continue; // an optional dependency not matching the platform/capabilities: skip it honestly
    if (resolved.error) {
      problems.push(`${name} → ${resolved.error}`);
      continue;
    }
    placeDep(depName, resolved.realDir, resolved.pkgJson, dest);
  }
}

// Root dependencies: external dependencies resolve from the runtime package directory that declares them;
// @helm/protocol / @helm/kernel / @helm/plugins / @helm/plugin-build are materialized into node_modules
// using the same-named directories carried by the payload (their external dependencies resolve from the
// repository's corresponding package directories, guaranteeing a closure consistent with the published
// file: semantics).
const RUNTIME_PKG_DIRS = {
  '@helm/protocol': 'protocol',
  '@helm/kernel': 'kernel',
  '@helm/plugins': 'plugins',
  '@helm/plugin-build': 'plugin-build',
  '@helm/plugin-client': 'plugin-client',
  '@helm/env-io': 'env-io',
};
for (const [name, spec] of Object.entries(rootDeps)) {
  const runtimeDir = RUNTIME_PKG_DIRS[name];
  if (runtimeDir !== undefined) {
    const pkgDir = path.join(hubDir, runtimeDir);
    const pkgJson = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
    placed.set(path.join(hubDir, 'node_modules', name), { name, version: pkgJson.version });
    mkdirSync(path.join(hubDir, 'node_modules', '@helm'), { recursive: true });
    copyQueue.push([pkgDir, path.join(hubDir, 'node_modules', '@helm', runtimeDir)]);
    for (const depName of Object.keys(pkgJson.dependencies ?? {})) {
      const resolved = resolveDepRealDir(path.join(repoRoot, 'packages', runtimeDir), depName, false);
      if (resolved.error) problems.push(resolved.error);
      else placeDep(depName, resolved.realDir, resolved.pkgJson, pkgDir);
    }
    continue;
  }
  // Ownership lookup checks dependencies before peerDependencies (e.g. react is only an SDK peer);
  // when neither hits, fall back to kernel (resolveDepRealDir then reports the missing dependency honestly).
  const pkgOf = (dir) => JSON.parse(readFileSync(path.join(repoRoot, 'packages', dir, 'package.json'), 'utf-8'));
  const RUNTIME_OWNER_DIRS = ['kernel', 'plugins', 'plugin-build', 'plugin-client', 'env-io', 'hub'];
  const ownerDir =
    RUNTIME_OWNER_DIRS.find((dir) => Object.keys(pkgOf(dir).dependencies ?? {}).includes(name)) ??
    RUNTIME_OWNER_DIRS.find((dir) => Object.keys(pkgOf(dir).peerDependencies ?? {}).includes(name)) ??
    'kernel';
  const resolved = resolveDepRealDir(path.join(repoRoot, 'packages', ownerDir), name, false);
  if (resolved.error) {
    problems.push(resolved.error);
    continue;
  }
  if (!spec.includes(resolved.pkgJson.version)) {
    problems.push(`${name}: payload contract version ${spec} disagrees with the repository install ${resolved.pkgJson.version}`);
  }
  placeDep(name, resolved.realDir, resolved.pkgJson, hubDir);
}
if (problems.length > 0) fail(`dependency closure resolution failed:\n${problems.map((p) => `- ${p}`).join('\n')}`);
for (const [src, dest] of copyQueue) copyPackageRealDir(src, dest);

// --- npm CLI complete file closure (outside asar; run by the main agent via Electron run-as-node) --------------------
const npmRealDir = resolveDepRealDir(desktopRoot, 'npm', false).realDir;
const npmPkg = JSON.parse(readFileSync(path.join(npmRealDir, 'package.json'), 'utf-8'));
if (!existsSync(path.join(npmRealDir, 'bin', 'npm-cli.js'))) fail(`npm CLI entry missing: ${npmRealDir}/bin/npm-cli.js`);
copyPackageRealDir(npmRealDir, path.join(hubDir, 'tools', 'npm'));

// --- Honesty check: no symlinks pointing inside or outside the repository may remain in hub (everything must be real files) -----------
function findSymlinks(dir) {
  const out = [];
  const visit = (cur) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      if (ent.name === '.pnpm') continue;
      const p = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) out.push(p);
      else if (ent.isDirectory()) visit(p);
    }
  };
  visit(dir);
  return out;
}
const symlinks = findSymlinks(hubDir);
if (symlinks.length > 0) fail(`symlinks left inside hub (materialization must be real files):\n${symlinks.slice(0, 10).join('\n')}`);

function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  const visit = (cur) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) visit(p);
      else {
        files += 1;
        bytes += statSync(p).size;
      }
    }
  };
  visit(dir);
  return { files, bytes };
}
const stats = walkStats(hubDir);
console.log(`[assemble-hub] assembly complete: ${hubDir}`);
console.log(`[assemble-hub] package ${hubPkg.name}@${hubPkg.version}, dependency closure ${placed.size} packages, npm CLI ${npmPkg.version} (tools/npm/bin/npm-cli.js)`);
console.log(`[assemble-hub] ${stats.files} files, ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB total (this runner architecture's baseline)`);

// --- Real launch acceptance in an isolated external directory -------------------------------------------------------
if (!verify) {
  console.log('[assemble-hub] --no-verify: skipping launch acceptance (debug only; acceptance is mandatory before release)');
  process.exit(0);
}

// Outside the repository (and not on any ancestor chain containing node_modules), ruling out resolution
// sneak-through faking a pass.
const verifyRoot = mkdtempSync(path.join(path.dirname(repoRoot) === '/root/code' ? '/root' : path.dirname(repoRoot), 'helm-hub-verify-'));
const verifyHub = path.join(verifyRoot, 'hub');
try {
  cpSync(hubDir, verifyHub, { recursive: true, dereference: true });
  const dataDir = mkdtempSync(path.join(verifyRoot, 'data-'));
  const check = spawnSync(process.execPath, [path.join(verifyHub, 'start.mjs'), 'check'], {
    cwd: verifyHub, encoding: 'utf8', timeout: 30_000, env: { ...process.env, NODE_PATH: '' },
  });
  if (check.status !== 0) throw new Error(`isolated dependency acceptance failed: ${check.stdout}\n${check.stderr}`);
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
  console.log(`[assemble-hub] isolated acceptance (${verifyRoot}): launching Hub @ ${port}`);
  const wrapper = path.join(verifyRoot, 'hub-child.mjs');
  cpSync(path.join(desktopRoot, 'dist', 'hub-child.js'), wrapper);
  const child = spawn(process.execPath, [wrapper, path.join(verifyHub, 'hub', 'dist', 'main.js')], {
    cwd: verifyHub,
    env: { ...process.env, NODE_PATH: '', HELM_PORT: String(port), HELM_HOST: '127.0.0.1', HELM_DATA_DIR: dataDir, HELM_CWD: dataDir },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-8000); });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
  let spawnError;
  const closed = new Promise((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const deadline = Date.now() + 30_000;
  let ok = false;
  while (Date.now() < deadline && child.exitCode === null && spawnError === undefined) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      if (response.ok && typeof body?.configured === 'boolean') { ok = true; break; }
    } catch { /* service not ready yet, keep waiting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let timeout;
  const stopped = new Promise((resolve) => { timeout = setTimeout(() => resolve({ timeout: true }), 10_000); });
  if (child.connected) child.send({ type: 'shutdown' }, () => {});
  else if (child.exitCode === null) child.kill('SIGTERM');
  const exitInfo = await Promise.race([closed, stopped]);
  clearTimeout(timeout);
  if (exitInfo.timeout) { child.kill('SIGKILL'); await closed; }
  if (!ok || spawnError !== undefined || exitInfo.timeout || exitInfo.code !== 0) {
    throw new Error(`isolated acceptance failed (ready=${ok}, exit=${exitInfo.code}, timeout=${Boolean(exitInfo.timeout)}): ${spawnError ?? ''}\n${stdout}\n${stderr}`);
  }
  console.log('[assemble-hub] isolated dependency check, Hub HTTP, and cross-platform IPC graceful shutdown all passed');
} finally {
  rmSync(verifyRoot, { recursive: true, force: true });
}
