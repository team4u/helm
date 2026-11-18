/**
 * @helm/payload integration tests: really executes the assembly script, npm pack, an isolated npm
 * install, and the launch entry.
 *
 * Coverage:
 * 1. assembly: missing build artifacts are rebuilt on demand (with explicit timeouts); after assemble
 *    the directory/manifest/checksum contract holds;
 * 2. publish package contract: the dist root package.json (@team4u/helm-hub default name, overridable
 *    via HELM_PAYLOAD_PACKAGE) is a standalone package fit for npm pack/publish: an explicit files
 *    whitelist + exact external dependency versions + @helm/protocol file:./protocol.tgz;
 *    manifest.name shares its source;
 * 3. layout: kernel/protocol/cli/web dist mirrors, built-in plugin assets in place, the web sibling
 *    probe hits, no node_modules carried;
 * 4. negative paths: missing dependencies exit with code 3; a tampered checksum exits with 1; a
 *    manifest path escape exits with 1; start refuses to launch the hub when dependencies are missing;
 * 5. positive path (real end-to-end, in an isolated directory outside the repository): npm pack dist →
 *    safe unpack (verify every member sits under the package/ prefix and the manifest is at the package
 *    root, not a dist/ subdirectory) → npm install --omit=dev --ignore-scripts → start.mjs check
 *    (dependency resolution + node:sqlite + a real esbuild exercise) → start.mjs start really launches
 *    the Hub and HTTP-probes /api/auth/status → clean SIGTERM exit. Never fixture-only.
 *
 * The same assembly also produces the stable launcher artifact (dist-launcher/, a zero-dependency
 * single-file bundle of helm-hub-launcher + @helm/update):
 * 6. launcher assembly contract: shebang single-file bundle, bin/name/version/engines, an empty
 *    dependency set (no unpublished private workspace packages), exact files whitelist;
 * 7. launcher bundle runs for real (`status --json` on an empty install root) and installs from a
 *    real tarball via `npm install -g` into an isolated prefix (the one-shot install story);
 * 8. golden sequence (PAYLOAD_NPM_SMOKE=1): the globally installed launcher installs a real Hub
 *    payload tarball (`update --tarball --start`), the health gate passes, `status` reports the
 *    running hub, and `stop` shuts it down cleanly — the only place the launcher and the real
 *    payload artifact meet before a release ships.
 *
 * These live in this single file on purpose: the runner executes test files as separate concurrent
 * processes, and both artifact suites share the one build.mjs run (which wipes and rebuilds
 * packages/payload/dist and dist-launcher) performed by the first test below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '@helm/kernel';
import type { createMermaidPlugin } from '@helm/plugins/mermaid';
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js';

const payloadPkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(payloadPkgRoot, '../..');
const stagingDir = path.join(payloadPkgRoot, 'dist');
const launcherStagingDir = path.join(payloadPkgRoot, 'dist-launcher');
const launcherPackageName = process.env.HELM_LAUNCHER_PACKAGE ?? '@team4u/helm-hub-launcher';

/** Minimal type shape of the manifest contract (validated isomorphically on the start.mjs side). */
interface PayloadManifest {
  formatVersion: number
  name: string
  version: string
  builtAt: string
  nodeEngines: string
  entries: Record<string, string>
  entryChecksums: Record<string, string>
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number, extraEnv: Record<string, string> = {}) {
  const res = spawnSync(command, args, { cwd, timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  assert.equal(
    res.status,
    0,
    `command failed: ${command} ${args.join(' ')} (cwd=${cwd})\nstdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`,
  );
  return res;
}

const sha256Of = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Claims an ephemeral free port (brief inherent race acceptable in local tests). */
async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** Recursively collects the relative paths of every file in a directory (POSIX separators). */
function walkFiles(rootDir: string): string[] {
  const out: string[] = [];
  const visit = (cur: string, prefix: string) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const rel = prefix === '' ? ent.name : `${prefix}/${ent.name}`;
      if (ent.isDirectory()) visit(path.join(cur, ent.name), rel);
      else out.push(rel);
    }
  };
  visit(rootDir, '');
  return out.sort();
}

/** Every file in the source dist must appear verbatim in the assembly directory (subset check, no byte-count coincidence assertions). */
function assertMirrored(srcDir: string, stagedDir: string) {
  for (const rel of walkFiles(srcDir)) {
    assert.ok(existsSync(path.join(stagedDir, rel)), `assembly directory is missing file: ${rel}`);
  }
}

/** Expected built-in plugin runtime asset placement: every client/skill/assets subdirectory present on the src side also appears on the dist side. */
function expectedAssetDirs() {
  const builtinSrc = path.join(repoRoot, 'packages/plugins/src');
  const expected = [];
  for (const ent of readdirSync(builtinSrc, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    for (const sub of ['client', 'skill', 'assets']) {
      if (existsSync(path.join(builtinSrc, ent.name, sub))) expected.push(`${ent.name}/${sub}`);
    }
  }
  return expected.sort();
}

test('payload assembly: missing build artifacts are rebuilt on demand, then build.mjs succeeds', { timeout: 600_000 }, () => {
  // rebuild only what is missing (zero extra cost on an already-built CI flow); build commands carry
  // explicit timeouts and terminate with output on failure.
  if (!existsSync(path.join(repoRoot, 'packages/protocol/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helm/protocol', 'run', 'build'], repoRoot, 180_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/env-io/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helm/env-io', 'run', 'build'], repoRoot, 180_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/update/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helm/update', 'run', 'build'], repoRoot, 180_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/hub-launcher/dist/main.js'))) {
    runCommand('pnpm', ['--filter', '@helm/hub-launcher', 'run', 'build'], repoRoot, 180_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/plugin-build/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helm/plugin-build', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/kernel/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helm/kernel', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/plugins/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helm/plugins', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/hub/dist/main.js'))) {
    runCommand('pnpm', ['--filter', '@helm/hub', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/web/dist/index.html'))) {
    runCommand('pnpm', ['--filter', '@helm/web', 'run', 'build'], repoRoot, 300_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/cli/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helm/cli', 'run', 'build'], repoRoot, 120_000);
  }

  runCommand(process.execPath, [path.join(payloadPkgRoot, 'build.mjs')], repoRoot, 120_000);
  assert.ok(existsSync(path.join(stagingDir, 'manifest.json')), 'manifest.json was not generated');
});

test('payload publish package contract: the dist root package.json is a standalone npm pack/publish package', { timeout: 60_000 }, () => {
  const distPkg = JSON.parse(readFileSync(path.join(stagingDir, 'package.json'), 'utf-8'));
  assert.equal(distPkg.name, '@team4u/helm-hub', 'the default publish package name must be @team4u/helm-hub');
  assert.equal(distPkg.type, 'module');
  assert.equal(distPkg.private, undefined, 'the publish package must not be marked private');
  assert.equal(distPkg.repository.url, 'git+https://github.com/team4u/helm.git');
  assert.equal(distPkg.license, 'MIT');
  // files explicit whitelist: the root gitignore dist/ rule must not let npm pack strip kernel/dist etc.
  assert.deepEqual(
    (distPkg.files as string[]).slice().sort(),
    ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'cli', 'env-io', 'env-io.tgz', 'hub', 'kernel', 'kernel.tgz', 'manifest.json', 'plugin-build', 'plugin-build.tgz', 'plugins', 'plugins.tgz', 'protocol', 'protocol.tgz', 'start.mjs', 'web'].sort(),
  );
  // @helm runtime packages install from archives; direct external dependencies use exact versions
  // (no ^/~/>= floating).
  assert.equal(distPkg.dependencies['@helm/protocol'], 'file:./protocol.tgz');
  assert.equal(distPkg.dependencies['@helm/kernel'], 'file:./kernel.tgz');
  assert.equal(distPkg.dependencies['@helm/plugins'], 'file:./plugins.tgz');
  assert.equal(distPkg.dependencies['@helm/plugin-build'], 'file:./plugin-build.tgz');
  assert.equal(distPkg.dependencies['@helm/env-io'], 'file:./env-io.tgz');
  // Browser-only SDK and UI/AJV/mermaid trees must never leak into the server payload production closure.
  for (const excluded of ['@helm/plugin-client', 'lucide-react', 'react', 'react-dom', 'react-markdown', 'remark-gfm', 'ajv', 'mermaid']) {
    assert.equal(distPkg.dependencies[excluded], undefined, `server payload must not pull ${excluded} into production dependencies`);
  }
  const pluginsStagedPkg = JSON.parse(readFileSync(path.join(stagingDir, 'plugins/package.json'), 'utf-8'));
  assert.equal(pluginsStagedPkg.dependencies?.['mermaid'], undefined, 'staged plugins/package.json must not declare mermaid runtime dependency');
  assert.equal(pluginsStagedPkg.dependencies?.['@helm/plugin-client'], undefined, 'staged plugins/package.json must not declare @helm/plugin-client runtime dependency');
  assert.ok(
    Object.keys(distPkg.dependencies).every((name) => !name.startsWith('@radix-ui/')),
    'server payload must not pull @radix-ui/* packages into production dependencies',
  );
  const RUNTIME_DIRS = ['kernel', 'plugins', 'hub', 'plugin-build', 'env-io', 'protocol'];
  const runtimeDeps = Object.fromEntries(
    RUNTIME_DIRS.map((dir) => {
      const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages', dir, 'package.json'), 'utf-8'));
      return [dir, { ...pkg.dependencies, ...pkg.peerDependencies }];
    }),
  );
  for (const [name, spec] of Object.entries<string>(distPkg.dependencies)) {
    if (name.startsWith('@helm/')) continue;
    const owner = Object.keys(runtimeDeps).find((dir) => runtimeDeps[dir]![name] !== undefined);
    assert.ok(owner !== undefined, `root dependency ${name} is not inside the runtime packages' production/peer dependency closure`);
    assert.match(spec, /^\d/, `external dependency ${name} must be an exact version, got ${spec}`);
    // must match the repository's installed version (reproducible installs; resolved through the pnpm
    // symlink to the real package, tolerant of peer-suffixed directories).
    const fromDir = path.join(repoRoot, 'packages', owner);
    const realPkgJson = JSON.parse(
      readFileSync(path.join(realpathSync(path.join(fromDir, 'node_modules', name)), 'package.json'), 'utf-8'),
    );
    assert.equal(realPkgJson.version, spec, `${name} repository-installed version disagrees with the dist contract`);
  }
  // the workspace builder stays private; the publish name only takes effect in dist.
  const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf-8'));
  assert.equal(payloadPkg.private, true);
});

test('payload manifest contract: formatVersion/version/entries/checksums all hold', { timeout: 60_000 }, () => {
  const manifest: PayloadManifest = JSON.parse(readFileSync(path.join(stagingDir, 'manifest.json'), 'utf-8'));
  assert.equal(manifest.formatVersion, 1);
  const distPkg = JSON.parse(readFileSync(path.join(stagingDir, 'package.json'), 'utf-8'));
  assert.equal(manifest.version, distPkg.version, 'manifest.version must match the dist root package.json');
  assert.equal(manifest.name, distPkg.name, 'manifest.name must share the source of the dist root package.json');
  assert.match(manifest.nodeEngines, /^>=/, 'nodeEngines must declare an engines floor');

  const keys = Object.keys(manifest.entries).sort();
  assert.deepEqual(Object.keys(manifest.entryChecksums).sort(), keys, 'entryChecksums keys must match entries keys');
  for (const [key, rel] of Object.entries(manifest.entries)) {
    const abs = path.join(stagingDir, rel);
    assert.ok(existsSync(abs), `the file pointed to by entries.${key} does not exist: ${rel}`);
    assert.equal(sha256Of(abs), manifest.entryChecksums[key], `entries.${key} checksum mismatch`);
  }
  assert.deepEqual(
    keys,
    [
      'cli', 'cliPackageJson', 'envIo', 'envIoArchive', 'envIoPackageJson', 'hub', 'hubPackageJson', 'kernel', 'kernelArchive', 'kernelPackageJson',
      'launcher', 'pluginBuild', 'pluginBuildArchive', 'pluginBuildPackageJson',
      'plugins', 'pluginsArchive', 'pluginsPackageJson', 'protocol',
      'protocolArchive', 'protocolPackageJson', 'rootPackageJson', 'webIndex',
    ].sort(),
  );
});

test('payload layout: hub/kernel/plugins/protocol/cli/web dist mirrors, assets in place, no stale artifacts, no node_modules', { timeout: 60_000 }, () => {
  assertMirrored(path.join(repoRoot, 'packages/hub/dist'), path.join(stagingDir, 'hub/dist'));
  assertMirrored(path.join(repoRoot, 'packages/kernel/dist'), path.join(stagingDir, 'kernel/dist'));
  assertMirrored(path.join(repoRoot, 'packages/plugins/dist'), path.join(stagingDir, 'plugins/dist'));
  assertMirrored(path.join(repoRoot, 'packages/protocol/dist'), path.join(stagingDir, 'protocol/dist'));
  assertMirrored(path.join(repoRoot, 'packages/cli/dist'), path.join(stagingDir, 'cli/dist'));
  assertMirrored(path.join(repoRoot, 'packages/web/dist'), path.join(stagingDir, 'web/dist'));
  assertMirrored(path.join(repoRoot, 'packages/plugin-build/dist'), path.join(stagingDir, 'plugin-build/dist'));
  assertMirrored(path.join(repoRoot, 'packages/env-io/dist'), path.join(stagingDir, 'env-io/dist'));
  assert.equal(existsSync(path.join(stagingDir, 'plugin-client')), false, 'plugin-client source must not be shipped in server payload');
  assert.equal(existsSync(path.join(stagingDir, 'plugin-client.tgz')), false, 'plugin-client.tgz must not be shipped in server payload');

  for (const rel of expectedAssetDirs()) {
    assert.ok(
      existsSync(path.join(stagingDir, 'plugins/dist', rel)),
      `built-in plugin assets not in place: ${rel}`,
    );
  }
  const clients = expectedAssetDirs().filter((rel) => rel.endsWith('/client'));
  assert.ok(clients.length >= 9, `unexpected built-in plugin client directory count: ${clients.length}`);
  for (const rel of clients) {
    const pluginName = rel.split('/')[0]!;
    assert.ok(
      existsSync(path.join(stagingDir, 'plugins/dist', pluginName, 'dist-client/manifest.json')),
      `built-in plugin prebuilt dist-client manifest missing for ${pluginName}`,
    );
  }

  assert.ok(existsSync(path.join(stagingDir, 'hub/dist/main.js')), 'hub dist is missing the main.js entry');
  assert.ok(existsSync(path.join(stagingDir, 'kernel/dist/http/hub.js')), 'kernel dist is missing http/hub.js');
  assert.ok(existsSync(path.join(stagingDir, 'web/dist/index.html')), 'web dist is missing index.html');
  // stale-layout guard: after the package split, kernel dist must never again carry product
  // composition-root or built-in-plugin remnants.
  for (const stale of ['kernel/dist/main.js', 'kernel/dist/app.js', 'kernel/dist/builtin-plugins']) {
    assert.ok(!existsSync(path.join(stagingDir, stale)), `stale artifact detected: ${stale} (kernel build was not cleaned)`);
  }

  // honesty: the assembly directory never carries node_modules (the dependency-completion contract is
  // consumer-side npm install).
  const stagedFiles = walkFiles(stagingDir);
  assert.ok(
    stagedFiles.every((rel) => !rel.split('/').includes('node_modules')),
    'the payload assembly directory must not contain node_modules',
  );
});

test('start.mjs check: missing dependencies exit explicitly with code 3 and list what is missing', { timeout: 60_000 }, () => {
  // beside the payload dist inside the repository workspace there are no kernel dependencies (pnpm
  // doesn't hoist into the root node_modules), so check must honestly exit 3; strip NODE_PATH so the
  // verdict is immune to the host environment.
  const env = { ...process.env };
  delete env.NODE_PATH;
  const res = spawnSync(process.execPath, [path.join(stagingDir, 'start.mjs'), 'check'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 50_000,
  });
  assert.equal(res.status, 3, `expected exit code 3 (missing dependencies), got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /missing runtime dependencies/, 'must explicitly report missing dependencies');
  assert.match(res.stderr, /npm install/, 'must point to npm install to complete dependencies');
  assert.match(res.stdout, /layout validated/, 'the layout check itself should pass first');
});

test('start.mjs check: tampered checksum or manifest path escape exits explicitly with code 1', { timeout: 60_000 }, () => {
  const broken = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-payload-broken-'));
  cpSync(stagingDir, broken, { recursive: true });
  try {
    const env = { ...process.env };
    delete env.NODE_PATH;
    const manifestPath = path.join(broken, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.entryChecksums.kernel = '0'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const res = spawnSync(process.execPath, [path.join(broken, 'start.mjs'), 'check'], {
      cwd: broken, env, encoding: 'utf8', timeout: 50_000,
    });
    assert.equal(res.status, 1, `expected exit code 1 (broken layout), got ${res.status}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /checksum mismatch/);

    // path contract: absolute paths / .. escapes must be rejected (strict validation includes paths,
    // guarding against manifest injection).
    const evil = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    evil.entryChecksums.kernel = manifest.entryChecksums.kernel;
    evil.entries.kernel = '../../../etc/passwd';
    writeFileSync(manifestPath, `${JSON.stringify(evil, null, 2)}\n`);
    const res2 = spawnSync(process.execPath, [path.join(broken, 'start.mjs'), 'check'], {
      cwd: broken, env, encoding: 'utf8', timeout: 50_000,
    });
    assert.equal(res2.status, 1, `expected exit code 1 (path escape), got ${res2.status}\nstderr: ${res2.stderr}`);
    assert.match(res2.stderr, /path check failed/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});

test('start.mjs start: refuses to launch the hub when dependencies are missing (no Helm Hub output)', { timeout: 60_000 }, () => {
  const env = { ...process.env };
  delete env.NODE_PATH;
  const res = spawnSync(process.execPath, [path.join(stagingDir, 'start.mjs'), 'start'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 50_000,
  });
  assert.equal(res.status, 3, `expected exit code 3 (refusing to start), got ${res.status}\nstderr: ${res.stderr}`);
  assert.doesNotMatch(res.stdout, /Helm Hub:/, 'kernel startup output must not appear while dependencies are missing');
});

test('start.mjs without arguments: usage error exits with code 1', { timeout: 60_000 }, () => {
  const res = spawnSync(process.execPath, [path.join(stagingDir, 'start.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: node start\.mjs/);
});

// ---------------------------------------------------------------------------
// Stable launcher artifact (dist-launcher): the zero-dependency helm-hub-launcher bundle.
// ---------------------------------------------------------------------------

test('launcher assembly contract: dist-launcher is a zero-dependency publish package with a shebang single-file bundle', { timeout: 60_000 }, () => {
  const pkg = JSON.parse(readFileSync(path.join(launcherStagingDir, 'package.json'), 'utf-8'));
  assert.equal(pkg.name, launcherPackageName);
  const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf-8'));
  assert.equal(pkg.version, payloadPkg.version, 'launcher artifact version shares the payload single source');
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'the launcher artifact must declare zero dependencies (one-step npm install -g)');
  assert.equal(pkg.type, 'module');
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
  assert.equal(pkg.engines.node, rootPkg.engines?.node ?? '>=24.12.0');
  const bin = pkg.bin;
  assert.deepEqual(Object.keys(bin), ['helm-hub-launcher'], 'the bin name is single-sourced from the launcher package');
  const bundle = readFileSync(path.join(launcherStagingDir, bin['helm-hub-launcher']), 'utf-8');
  assert.ok(bundle.startsWith('#!/usr/bin/env node'), 'the bundle must keep the shebang to work as a bin target');
  assert.ok(!/from\s+['"]@helm\//.test(bundle), 'the bundle must not carry unresolved @helm/* imports');
  assert.ok(!/workspace:/.test(bundle), 'the bundle must not carry workspace: specifiers');
  assert.deepEqual(pkg.files.slice().sort(), ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'main.js']);
  for (const file of pkg.files) {
    assert.ok(existsSync(path.join(launcherStagingDir, file)), `files whitelist entry missing on disk: ${file}`);
  }
});

test('launcher bundle: status --json answers honestly on an empty install root', { timeout: 60_000 }, () => {
  const installRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-launcher-empty-'));
  try {
    const res = spawnSync(process.execPath, [path.join(launcherStagingDir, 'main.js'), 'status', '--json'], {
      cwd: installRoot,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, HELM_HUB_INSTALL_ROOT: installRoot },
    });
    assert.equal(res.status, 0, `status --json expected exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.installRoot, installRoot);
    assert.equal(payload.current, null, 'an empty install root must report no current release');
    assert.equal(payload.running, null, 'an empty install root must report no running hub');
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test('launcher tarball acceptance: npm pack → npm install -g into an isolated prefix → installed bin runs', {
  timeout: 240_000,
  skip: process.platform === 'win32' ? 'bin link execution via shebang is verified on POSIX lanes' : false,
}, () => {
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-launcher-tgz-'));
  try {
    const packDir = path.join(outsideRoot, 'pack');
    mkdirSync(packDir, { recursive: true });
    const packRes = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], launcherStagingDir, 120_000);
    const packInfo = JSON.parse(packRes.stdout);
    assert.equal(packInfo.length, 1, `expected a single tarball: ${packRes.stdout}`);
    const tgz = path.join(packDir, packInfo[0].filename);

    // Tarball shape: package-root manifest (not a dist-launcher/ prefix), no node_modules payload.
    const members = runCommand('tar', ['-tzf', tgz], outsideRoot, 30_000).stdout.split('\n').filter(Boolean);
    for (const member of members) {
      assert.ok(member.startsWith('package/'), `tarball member escapes the package/ prefix: ${member}`);
    }
    for (const must of ['package/package.json', 'package/main.js', 'package/LICENSE', 'package/THIRD_PARTY_NOTICES.md']) {
      assert.ok(members.includes(must), `launcher tarball is missing ${must}`);
    }
    assert.ok(!members.some((m) => m.includes('node_modules')), 'the launcher tarball must not carry node_modules');

    // The one-shot story itself: install -g from the real tarball into an isolated prefix.
    const prefix = path.join(outsideRoot, 'global-prefix');
    runCommand('npm', ['install', '-g', tgz, '--prefix', prefix, '--no-audit', '--no-fund'], outsideRoot, 120_000);
    const binPath = path.join(prefix, 'bin', 'helm-hub-launcher');
    assert.ok(existsSync(binPath), `npm install -g must create the helm-hub-launcher bin link under ${prefix}/bin`);

    // Zero-dependency proof at the installed location: no node_modules was created beside the package.
    const installedPkgDir = path.join(prefix, 'lib', 'node_modules', ...launcherPackageName.split('/'));
    assert.ok(existsSync(path.join(installedPkgDir, 'main.js')), 'the installed package must carry the bundled entry');
    assert.ok(!existsSync(path.join(installedPkgDir, 'node_modules')), 'a zero-dependency package must not grow node_modules on install');

    const installRoot = path.join(outsideRoot, 'install-root');
    const res = spawnSync(binPath, ['status', '--json'], {
      cwd: outsideRoot,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, HELM_HUB_INSTALL_ROOT: installRoot },
    });
    assert.equal(res.status, 0, `installed bin status --json expected exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.installRoot, installRoot);
    assert.equal(payload.current, null);
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

/**
 * Positive-path end-to-end (real install and launch, no fixture-grade substitutes):
 * npm pack dist → safe unpack outside the repository → npm install --omit=dev --ignore-scripts →
 * check passes (dependency resolution + node:sqlite + a real esbuild transform) → start really launches
 * the Hub, HTTP-probes /api/auth/status, and exits cleanly on SIGTERM.
 */
test('end-to-end: npm pack → isolated npm install → check → start really launches the Hub (outside the repository)', {
  timeout: 240_000,
  skip: process.env.PAYLOAD_NPM_SMOKE !== '1' ? 'the real npm network acceptance runs as a dedicated CI step with PAYLOAD_NPM_SMOKE=1' : false,
}, async () => {
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-payload-e2e-'));
  const packDir = path.join(outsideRoot, 'pack');
  let extractDir = path.join(outsideRoot, 'extracted');
  try {
    mkdirSyncRecursive(packDir);
    mkdirSyncRecursive(extractDir);

    // 1. npm pack (executed inside dist; --pack-destination keeps the dist directory clean).
    const packRes = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], stagingDir, 120_000);
    const packInfo = JSON.parse(packRes.stdout) as Array<{ filename: string }>;
    assert.equal(packInfo.length, 1, `expected a single tarball: ${packRes.stdout}`);
    const tgz = path.join(packDir, packInfo[0]!.filename);
    assert.ok(existsSync(tgz));

    // 2. safe unpack: every member must sit under the package/ prefix with no .. segments, and the
    // manifest at the package root.
    const list = runCommand('tar', ['-tzf', tgz], outsideRoot, 30_000).stdout.split('\n').filter(Boolean);
    assert.ok(list.length > 10, `too few tarball members: ${list.length}`);
    for (const member of list) {
      assert.ok(member.startsWith('package/'), `tarball member escapes the package/ prefix: ${member}`);
      assert.ok(!member.split('/').includes('..'), `tarball member contains ..: ${member}`);
    }
    for (const must of ['package/manifest.json', 'package/start.mjs', 'package/package.json', 'package/hub/dist/main.js', 'package/kernel/dist/index.js', 'package/plugins/dist/index.js', 'package/plugin-build/dist/index.js', 'package/env-io/dist/index.js', 'package/protocol/dist/index.js', 'package/cli/dist/index.js', 'package/web/dist/index.html']) {
      assert.ok(list.includes(must), `tarball is missing ${must} (manifest/start must sit at the package root, not a dist/ subdirectory)`);
    }
    runCommand('tar', ['-xzf', tgz, '-C', extractDir, '--strip-components=1'], outsideRoot, 60_000);

    // 3. local file: dependencies are copy-installed; after the promotion rename it must still launch.
    runCommand('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], extractDir, 300_000);
    for (const helmPkg of ['protocol', 'kernel', 'plugins', 'plugin-build', 'env-io']) {
      assert.equal(lstatSync(path.join(extractDir, 'node_modules', '@helm', helmPkg)).isSymbolicLink(), false, `@helm/${helmPkg} must be a real archive-installed directory`);
    }
    const promoted = path.join(outsideRoot, 'release');
    renameSync(extractDir, promoted);
    extractDir = promoted;
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helm', 'protocol', 'dist', 'index.js')), 'protocol dependency broke after promotion');
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helm', 'kernel', 'dist', 'index.js')), 'kernel dependency broke after promotion');
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helm', 'plugins', 'dist', 'index.js')), 'plugins dependency broke after promotion');
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helm', 'plugin-build', 'dist', 'index.js')), 'plugin-build dependency broke after promotion');
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helm', 'env-io', 'dist', 'index.js')), 'env-io dependency broke after promotion');

    // 4. check: the seven entry-point dependencies resolve + node:sqlite + a real esbuild exercise,
    // exit code 0.
    const env = { ...process.env };
    delete env.NODE_PATH;
    const check = spawnSync(process.execPath, [path.join(extractDir, 'start.mjs'), 'check'], {
      cwd: extractDir, env, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(check.status, 0, `check expected 0, got ${check.status}\nstdout: ${check.stdout}\nstderr: ${check.stderr}`);
    assert.match(check.stdout, /7 entry points/);
    assert.match(check.stdout, /node:sqlite \+ esbuild transform/);

    // 5. start: really launches the Hub, probes the public /api/auth/status endpoint, and exits cleanly
    // on SIGTERM.
    const dataDir = path.join(outsideRoot, 'data');
    mkdirSyncRecursive(dataDir);
    const port = 33500 + (process.pid % 1500);
    const child = spawn(process.execPath, [path.join(extractDir, 'start.mjs'), 'start'], {
      cwd: extractDir,
      env: { ...env, HELM_PORT: String(port), HELM_HOST: '127.0.0.1', HELM_DATA_DIR: dataDir, HELM_CWD: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // close also guarantees stdout/stderr are fully drained; exit fires before the pipes flush, so logs
    // can't be asserted from it.
    const exitPromise = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const waitForExit = async (timeoutMs: number) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          exitPromise,
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    let exitInfo: Awaited<typeof exitPromise> | null = null;
    try {
      let probed = false;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(1_000) });
          const body: unknown = await response.json();
          if (response.ok && typeof body === 'object' && body !== null) {
            probed = true;
            break;
          }
        } catch { /* the Hub is still starting up; retry the probe. */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(probed, `Hub did not pass the probe within 20s\nstdout: ${stdout}\nstderr: ${stderr}`);
      // real acceptance of static hosting: GET / must return 200 HTML (under the npm install layout the
      // kernel's default probe points at node_modules/web/dist, relying on start.mjs / the hub product
      // layer to inject it explicitly; probing only the API would miss the "API alive but blank desktop"
      // regression), and fetch a real /assets/* resource from index.html.
      const indexRes = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3_000) });
      assert.equal(indexRes.status, 200, `GET / expected 200, got ${indexRes.status} (static hosting not in effect)`);
      const indexHtml = await indexRes.text();
      assert.match(indexRes.headers.get('content-type') ?? '', /text\/html/, 'GET / must return HTML');
      assert.match(indexHtml, /<div[^>]*id="root"/, 'index.html must contain the frontend mount point');
      const assetMatch = /(?:src|href)="(\/?assets\/[^"]+\.(?:js|css))"/.exec(indexHtml);
      assert.ok(assetMatch !== null, `index.html references no real static asset: ${indexHtml.slice(0, 300)}`);
      const assetPath = assetMatch[1]!.startsWith('/') ? assetMatch[1]! : `/${assetMatch[1]!}`;
      const assetRes = await fetch(`http://127.0.0.1:${port}${assetPath}`, { signal: AbortSignal.timeout(3_000) });
      assert.equal(assetRes.status, 200, `static asset ${assetPath} expected 200, got ${assetRes.status}`);
      const assetBody = await assetRes.text();
      assert.ok(assetBody.length > 0, `static asset ${assetPath} must not be an empty body`);

      // real acceptance of the dynamic plugin build chain (a publish-package closure the home
      // page/probe alone can't cover): after a temporary setup auth (the smoke test owns a brand-new
      // dataDir and touches no real users/credentials), fetch the compiled client module artifacts of
      // two real built-in plugins. A 200 JavaScript response simultaneously proves: the clientRoot
      // runtime assets landed with the plugins archive, @helm/plugin-build installed via the file: tgz
      // with a correct npm resolution root, and the host shared shim works (the token never lands in
      // logs).
      const setupPassword = `helm-smoke-${process.pid}-${Date.now()}`;
      const setupRes = await fetch(`http://127.0.0.1:${port}/api/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: setupPassword }),
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(setupRes.status, 200, `auth/setup expected 200, got ${setupRes.status}`);
      const { token } = (await setupRes.json()) as { token: string };
      assert.ok(typeof token === 'string' && token.length > 0, 'auth/setup must issue a token');
      try {
        for (const pluginId of ['builtin%3Amermaid', 'builtin%3Aworkflow']) {
          const moduleRes = await fetch(`http://127.0.0.1:${port}/api/plugins/${pluginId}/client.mjs?module=index.tsx`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(30_000),
          });
          const detail = `plugin ${decodeURIComponent(pluginId)} client.mjs`;
          const moduleBody = await moduleRes.text();
          assert.equal(moduleRes.status, 200, `${detail} expected 200, got ${moduleRes.status} (body head 200 chars: ${moduleBody.slice(0, 200)})`);
          assert.match(moduleRes.headers.get('content-type') ?? '', /text\/javascript/, `${detail} must return JavaScript`);
          const moduleHash = moduleRes.headers.get('x-helm-client-hash');
          assert.ok(moduleHash !== null && moduleHash.length > 0, `${detail} is missing x-helm-client-hash`);
          assert.ok(moduleBody.length > 0, `${detail} must not be an empty body`);
        }
      } finally {
        // the token lives only in this test's local variables; never written to logs or assertion messages.
      }
    } finally {
      child.kill('SIGTERM');
      exitInfo = await waitForExit(5_000);
      if (exitInfo === null && child.pid !== undefined) {
        // start.mjs spawns the hub; the whole process tree must be cleaned up even on assertion failure.
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000 });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
        await waitForExit(5_000);
      }
    }
    assert.ok(exitInfo, `Hub SIGTERM shutdown timed out\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.equal(exitInfo.code, 0, `Hub expected a clean exit 0 after SIGTERM, got ${exitInfo.code} ${exitInfo.signal ?? ''}\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.match(stdout, /Helm Hub:/, 'Hub startup banner missing');
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

function mkdirSyncRecursive(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

test('payload prebuilt mermaid: unpacked plugins.tgz serves mermaid & chunks without node_modules/mermaid or buildProvider', { timeout: 60_000 }, async () => {
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-payload-mermaid-'));
  try {
    const isoPlugins = path.join(outsideRoot, 'plugins');
    const isoProtocol = path.join(outsideRoot, 'plugins/node_modules/@helm/protocol');
    const isoTypebox = path.join(outsideRoot, 'plugins/node_modules/typebox');
    const dataDir = path.join(outsideRoot, 'data');
    mkdirSyncRecursive(isoPlugins);
    mkdirSyncRecursive(isoProtocol);
    mkdirSyncRecursive(dataDir);

    // Unpack packed plugins.tgz & protocol.tgz outside repoRoot (so repo node_modules/mermaid is unreachable).
    runCommand('tar', ['-xzf', path.join(stagingDir, 'plugins.tgz'), '-C', isoPlugins, '--strip-components=1'], outsideRoot, 30_000);
    runCommand('tar', ['-xzf', path.join(stagingDir, 'protocol.tgz'), '-C', isoProtocol, '--strip-components=1'], outsideRoot, 30_000);
    assert.ok(existsSync(path.join(isoPlugins, 'dist/mermaid/dist-client/manifest.json')), 'plugins.tgz must carry mermaid dist-client');
    // Supply protocol's lightweight runtime dep `typebox` only if imported; note mermaid imports only @helm/protocol (`HelmError`).
    const typeboxReal = realpathSync(path.join(repoRoot, 'packages/protocol/node_modules/typebox'));
    cpSync(typeboxReal, isoTypebox, { recursive: true });

    const mod = (await import(pathToFileURL(path.join(isoPlugins, 'dist/mermaid.js')).href)) as {
      createMermaidPlugin: typeof createMermaidPlugin;
    };
    const def = mod.createMermaidPlugin();
    assert.equal(def.npmDependencies, undefined, 'prebuilt payload mermaid must not declare runtime npmDependencies');
    assert.ok(def.prebuiltClientDir?.endsWith('dist-client'));

    const docMap = new Map<string, unknown>();
    const docs: PluginDocStore = {
      get: <T>(key: string, initial: T): T => (docMap.has(key) ? (docMap.get(key) as T) : initial),
      set: <T>(key: string, value: T): void => {
        docMap.set(key, value);
      },
      deletePlugin: (p: string): void => {
        for (const k of [...docMap.keys()]) {
          if (k.startsWith(`${p}:`)) docMap.delete(k);
        }
      },
      flush: async (): Promise<void> => {},
    };
    const backend: PluginHostBackend = {
      ...createPluginHostBackendFixture(),
      emitEvent: () => {},
    };
    const host = new PluginHost({ dataDir, docs, host: backend }); // Intentionally NO buildProvider!
    try {
      await host.register(def, { enabled: true });
      const bundle = await host.getClientModule('builtin:mermaid', 'index.tsx');
      assert.match(bundle.code, /MermaidCodeBlock/);
      const flowChunkName = Object.keys(bundle.chunks ?? {}).find((k) => k.includes('flowDiagram'));
      assert.ok(flowChunkName, 'expected flowDiagram chunk in prebuilt mermaid bundle');
      const chunk = await host.getClientModule('builtin:mermaid', 'index.tsx', {
        chunk: flowChunkName,
        hash: bundle.contentHash,
      });
      assert.ok(chunk.code.length > 0);
    } finally {
      await host.dispose();
    }
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

/**
 * Launcher golden sequence (real npm network acceptance, gated like the payload e2e above): the
 * globally installed launcher installs a real Hub payload tarball into its own release root
 * (`update --tarball --start`: unpack → candidate-root npm install → check → commit → launch →
 * health gate), `status` reflects the running release, and `stop` shuts it down cleanly. This is
 * the only place the launcher and the real payload artifact meet before a release ships.
 */
test('launcher golden sequence: installed launcher updates from a real payload tarball, health-gates, and stops', {
  timeout: 600_000,
  skip: process.env.PAYLOAD_NPM_SMOKE !== '1'
    ? 'the real npm network acceptance runs as a dedicated CI step with PAYLOAD_NPM_SMOKE=1'
    : process.platform === 'win32'
      ? 'bin link execution via shebang is verified on POSIX lanes'
      : false,
}, async () => {
  const payloadPkg = JSON.parse(readFileSync(path.join(stagingDir, 'package.json'), 'utf-8'));
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-launcher-golden-'));
  try {
    // 1. Real tarballs: launcher (published form) + Hub payload (the update target).
    const packDir = path.join(outsideRoot, 'pack');
    mkdirSync(packDir, { recursive: true });
    const launcherPack = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], launcherStagingDir, 120_000);
    const launcherTgz = path.join(packDir, JSON.parse(launcherPack.stdout)[0].filename);
    const payloadPack = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], stagingDir, 120_000);
    const payloadTgz = path.join(packDir, JSON.parse(payloadPack.stdout)[0].filename);

    // 2. One-shot install of the launcher, exactly as a member machine would do it.
    const prefix = path.join(outsideRoot, 'global-prefix');
    runCommand('npm', ['install', '-g', launcherTgz, '--prefix', prefix, '--no-audit', '--no-fund'], outsideRoot, 120_000);
    const binPath = path.join(prefix, 'bin', 'helm-hub-launcher');
    assert.ok(existsSync(binPath), 'npm install -g must create the helm-hub-launcher bin link');

    // 3. update --tarball --start: the install root and the hub data dir stay separate trees by
    //    contract; the port is an ephemeral claim, not a guess.
    const installRoot = path.join(outsideRoot, 'install-root');
    const dataDir = path.join(outsideRoot, 'hub-data');
    const port = await freePort();
    const updateEnv: NodeJS.ProcessEnv = { ...process.env, HELM_HUB_INSTALL_ROOT: installRoot };
    delete updateEnv.NODE_PATH;
    const update = spawnSync(binPath, [
      'update', '--tarball', payloadTgz, '--version', payloadPkg.version, '--start',
      '--port', String(port), '--host', '127.0.0.1', '--data-dir', dataDir, '--health-timeout', '120000',
    ], { cwd: outsideRoot, encoding: 'utf8', timeout: 420_000, env: updateEnv });
    assert.equal(
      update.status,
      0,
      `launcher update --tarball failed (exit ${update.status})\nstdout: ${update.stdout}\nstderr: ${update.stderr}`,
    );

    // 4. status: the committed release is current and the hub is running and healthy.
    const status = spawnSync(binPath, ['status', '--json'], { cwd: outsideRoot, encoding: 'utf8', timeout: 50_000, env: updateEnv });
    assert.equal(status.status, 0, `status --json failed\nstdout: ${status.stdout}\nstderr: ${status.stderr}`);
    const snapshot = JSON.parse(status.stdout);
    assert.equal(snapshot.current?.version, payloadPkg.version);
    assert.ok(snapshot.running !== null, 'the hub must be running after update --start');
    assert.equal(snapshot.running.port, port);
    assert.equal(snapshot.running.alive, true);
    assert.equal(snapshot.running.healthy, true, 'the health gate must have passed before update reported success');
    assert.ok(existsSync(path.join(installRoot, 'releases', payloadPkg.version)), 'the immutable release directory must exist');
    assert.ok(existsSync(path.join(installRoot, 'logs', 'hub.log')), 'the detached hub log must exist for diagnostics');

    // 5. stop: identity-verified shutdown, leaving no pid file behind.
    const stop = spawnSync(binPath, ['stop'], { cwd: outsideRoot, encoding: 'utf8', timeout: 120_000, env: updateEnv });
    assert.equal(stop.status, 0, `launcher stop failed\nstdout: ${stop.stdout}\nstderr: ${stop.stderr}`);
    const after = spawnSync(binPath, ['status', '--json'], { cwd: outsideRoot, encoding: 'utf8', timeout: 50_000, env: updateEnv });
    const afterSnapshot = JSON.parse(after.stdout);
    assert.equal(afterSnapshot.running, null, 'no hub may keep running after stop');
    assert.equal(afterSnapshot.current?.version, payloadPkg.version, 'the committed release survives the stop');
    assert.ok(readdirSync(path.join(installRoot, 'releases')).length >= 1, 'release directories are retained for rollback');
  } finally {
    // Best-effort cleanup: stop anything the sequence may have left running before dropping the tree.
    spawnSync(path.join(outsideRoot, 'global-prefix', 'bin', 'helm-hub-launcher'), ['stop'], {
      cwd: outsideRoot, timeout: 60_000, env: { ...process.env, HELM_HUB_INSTALL_ROOT: path.join(outsideRoot, 'install-root') },
    });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});
