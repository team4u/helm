/**
 * Launcher artifact integration tests: assemble `packages/payload/dist-launcher` (the stable
 * helm-hub-launcher npm package) and prove real one-shot installability.
 *
 * Coverage:
 * 1. assembly contract: single-file bundle with shebang; package.json bin/name/version/engines,
 *    an empty dependency set (no unpublished private workspace packages), an exact files whitelist,
 *    LICENSE and third-party notices in place;
 * 2. the unpacked bundle runs for real: `status --json` against an empty install root exits 0 with
 *    honest JSON (no current release, no running hub);
 * 3. real tarball acceptance: npm pack dist-launcher → `npm install -g` into an isolated prefix →
 *    the installed bin link answers `status --json` without any repository checkout involved;
 * 4. golden sequence (PAYLOAD_NPM_SMOKE=1): the globally installed launcher installs a real Hub
 *    payload tarball (`update --tarball --start`), the health gate passes, `status` reports the
 *    running hub, and `stop` shuts it down cleanly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const payloadPkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(payloadPkgRoot, '../..');
const launcherStagingDir = path.join(payloadPkgRoot, 'dist-launcher');
const payloadStagingDir = path.join(payloadPkgRoot, 'dist');
const launcherPkgDir = path.join(repoRoot, 'packages/hub-launcher');

const launcherPackageName = process.env.HELM_LAUNCHER_PACKAGE ?? '@team4u/helm-hub-launcher';
const payloadPackageName = process.env.HELM_PAYLOAD_PACKAGE ?? '@team4u/helm-hub';
/** Launcher package presence (an absent package skips the whole file explicitly, never silently). */
const launcherPresent = () => existsSync(path.join(launcherPkgDir, 'package.json'));

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number, extraEnv: Record<string, string> = {}) {
  const res = spawnSync(command, args, { cwd, timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  assert.equal(
    res.status,
    0,
    `command failed: ${command} ${args.join(' ')} (cwd=${cwd})\nstdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`,
  );
  return res;
}

/** Workspace build inputs the assembly consumes, in topological order; rebuilt on demand only. */
const BUILD_INPUTS: Array<[filter: string, marker: string]> = [
  ['@helm/protocol', 'packages/protocol/dist/index.js'],
  ['@helm/env-io', 'packages/env-io/dist/index.js'],
  ['@helm/update', 'packages/update/dist/index.js'],
  ['@helm/plugin-build', 'packages/plugin-build/dist/index.js'],
  ['@helm/kernel', 'packages/kernel/dist/index.js'],
  ['@helm/plugins', 'packages/plugins/dist/index.js'],
  ['@helm/hub', 'packages/hub/dist/main.js'],
  ['@helm/web', 'packages/web/dist/index.html'],
  ['@helm/cli', 'packages/cli/dist/index.js'],
  ['@helm/hub-launcher', 'packages/hub-launcher/dist/main.js'],
];

function rebuildMissingBuildInputs() {
  for (const [filter, marker] of BUILD_INPUTS) {
    if (!existsSync(path.join(repoRoot, marker))) {
      runCommand('pnpm', ['--filter', filter, 'run', 'build'], repoRoot, 300_000);
    }
  }
}

/** Reads the launcher artifact manifest, asserting the file exists first with a pointed message. */
function readLauncherPackageJson(): Record<string, unknown> {
  const manifestPath = path.join(launcherStagingDir, 'package.json');
  assert.ok(existsSync(manifestPath), `${manifestPath} is missing: run the launcher assembly test first (node build.mjs in packages/payload)`);
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

test('launcher assembly: build.mjs produces a zero-dependency dist-launcher publish package', { timeout: 600_000, skip: !launcherPresent()
    ? 'packages/hub-launcher does not exist in this checkout; the launcher artifact is assembled only after the launcher package lands'
    : false }, () => {
  rebuildMissingBuildInputs();
  runCommand('node', ['build.mjs'], payloadPkgRoot, 420_000);

  const pkg = readLauncherPackageJson();
  assert.equal(pkg.name, launcherPackageName);
  const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf8')) as { version: string };
  assert.equal(pkg.version, payloadPkg.version, 'launcher artifact version shares the payload single source');
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'the launcher artifact must declare zero dependencies (one-step npm install -g)');
  assert.equal(pkg.type, 'module');
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { engines?: { node?: string } };
  assert.equal((pkg.engines as { node: string }).node, rootPkg.engines?.node ?? '>=24.12.0');

  const bin = pkg.bin as Record<string, string>;
  assert.deepEqual(Object.keys(bin), ['helm-hub-launcher'], 'the bin name is single-sourced from the launcher package');
  const bundlePath = path.join(launcherStagingDir, bin['helm-hub-launcher']!);
  const bundle = readFileSync(bundlePath, 'utf8');
  assert.ok(bundle.startsWith('#!/usr/bin/env node'), 'the bundle must keep the shebang to work as a bin target');
  assert.ok(!/from\s+['"]@helm\//.test(bundle), 'the bundle must not carry unresolved @helm/* imports');
  assert.ok(!/workspace:/.test(bundle), 'the bundle must not carry workspace: specifiers');

  assert.deepEqual((pkg.files as string[]).slice().sort(), ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'main.js']);
  for (const file of pkg.files as string[]) {
    assert.ok(existsSync(path.join(launcherStagingDir, file)), `files whitelist entry missing on disk: ${file}`);
  }
});

test('launcher bundle: status --json answers honestly on an empty install root', { timeout: 60_000, skip: !launcherPresent()
    ? 'packages/hub-launcher does not exist in this checkout; the launcher artifact is assembled only after the launcher package lands'
    : false }, () => {
  const installRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-launcher-empty-'));
  try {
    readLauncherPackageJson();
    const res = spawnSync(process.execPath, [path.join(launcherStagingDir, 'main.js'), 'status', '--json'], {
      cwd: installRoot,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, HELM_HUB_INSTALL_ROOT: installRoot },
    });
    assert.equal(res.status, 0, `status --json expected exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const payload = JSON.parse(res.stdout) as { installRoot: string, current: unknown, running: unknown };
    assert.equal(payload.installRoot, installRoot);
    assert.equal(payload.current, null, 'an empty install root must report no current release');
    assert.equal(payload.running, null, 'an empty install root must report no running hub');
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test('launcher tarball acceptance: npm pack → npm install -g into an isolated prefix → installed bin runs', {
  timeout: 240_000,
  skip: !launcherPresent()
    ? 'packages/hub-launcher does not exist in this checkout; the launcher artifact is assembled only after the launcher package lands'
    : process.platform === 'win32'
      ? 'bin link execution via shebang is verified on POSIX lanes'
      : false,
}, () => {
  readLauncherPackageJson();
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-launcher-tgz-'));
  try {
    const packDir = path.join(outsideRoot, 'pack');
    mkdirSync(packDir, { recursive: true });
    const packRes = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], launcherStagingDir, 120_000);
    const packInfo = JSON.parse(packRes.stdout) as Array<{ filename: string }>;
    assert.equal(packInfo.length, 1, `expected a single tarball: ${packRes.stdout}`);
    const tgz = path.join(packDir, packInfo[0]!.filename);

    // Tarball shape: package-root manifest (not a dist-launcher/ prefix), no node_modules payload.
    const members = runCommand('tar', ['-tzf', tgz], outsideRoot, 30_000).stdout.split('\n').filter(Boolean);
    for (const member of members) {
      assert.ok(member.startsWith('package/'), `tarball member escapes the package/ prefix: ${member}`);
    }
    for (const must of ['package/package.json', 'package/main.js', 'package/LICENSE', 'package/THIRD_PARTY_NOTICES.md']) {
      assert.ok(members.includes(must), `launcher tarball is missing ${must}`);
    }
    assert.ok(!members.some((m) => m.includes('node_modules')), 'the launcher tarball must not carry node_modules');

    // The one-step story itself: install -g from the real tarball into an isolated prefix.
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
    const payload = JSON.parse(res.stdout) as { installRoot: string, current: unknown };
    assert.equal(payload.installRoot, installRoot);
    assert.equal(payload.current, null);
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

/**
 * Golden sequence (real npm network acceptance, gated like the payload e2e): the globally installed
 * launcher installs a real Hub payload tarball into its own release root, starts the hub with a
 * health gate, `status` reflects the running release, and `stop` shuts it down cleanly. This is the
 * only place the launcher and the real payload artifact meet before a release ships.
 */
test('golden sequence: installed launcher updates from a real payload tarball, health-gates, and stops', {
  timeout: 600_000,
  skip: process.env.PAYLOAD_NPM_SMOKE !== '1'
    ? 'the real npm network acceptance runs as a dedicated CI step with PAYLOAD_NPM_SMOKE=1'
    : !launcherPresent()
      ? 'packages/hub-launcher does not exist in this checkout; the launcher artifact is assembled only after the launcher package lands'
      : process.platform === 'win32'
        ? 'bin link execution via shebang is verified on POSIX lanes'
        : false,
}, () => {
  readLauncherPackageJson();
  const payloadPkg = JSON.parse(readFileSync(path.join(payloadStagingDir, 'package.json'), 'utf8')) as { name: string, version: string };
  assert.equal(payloadPkg.name, payloadPackageName, 'the payload artifact must be assembled before the golden sequence');

  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-launcher-golden-'));
  try {
    // 1. Real tarballs: launcher (published form) + Hub payload (the update target).
    const packDir = path.join(outsideRoot, 'pack');
    mkdirSync(packDir, { recursive: true });
    const launcherPack = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], launcherStagingDir, 120_000);
    const launcherTgz = path.join(packDir, (JSON.parse(launcherPack.stdout) as Array<{ filename: string }>)[0]!.filename);
    const payloadPack = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], payloadStagingDir, 120_000);
    const payloadTgz = path.join(packDir, (JSON.parse(payloadPack.stdout) as Array<{ filename: string }>)[0]!.filename);

    // 2. One-shot install of the launcher, exactly as a member machine would do it.
    const prefix = path.join(outsideRoot, 'global-prefix');
    runCommand('npm', ['install', '-g', launcherTgz, '--prefix', prefix, '--no-audit', '--no-fund'], outsideRoot, 120_000);
    const binPath = path.join(prefix, 'bin', 'helm-hub-launcher');
    assert.ok(existsSync(binPath), 'npm install -g must create the helm-hub-launcher bin link');

    // 3. update --tarball --start: staging npm install → start.mjs check → commit → launch → health
    //    gate. The install root and the hub data dir stay separate trees by contract.
    const installRoot = path.join(outsideRoot, 'install-root');
    const dataDir = path.join(outsideRoot, 'hub-data');
    const port = 35000 + (process.pid % 1000);
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
    const snapshot = JSON.parse(status.stdout) as {
      current: { version: string, entryPath: string } | null,
      running: { pid: number, version: string, port: number, alive: boolean, healthy: boolean } | null,
    };
    assert.equal(snapshot.current?.version, payloadPkg.version);
    assert.ok(snapshot.running !== null, 'the hub must be running after update --start');
    assert.equal(snapshot.running!.port, port);
    assert.equal(snapshot.running!.alive, true);
    assert.equal(snapshot.running!.healthy, true, 'the health gate must have passed before update reported success');
    assert.ok(existsSync(path.join(installRoot, 'releases', payloadPkg.version)), 'the immutable release directory must exist');
    assert.ok(existsSync(path.join(installRoot, 'logs', 'hub.log')), 'the detached hub log must exist for diagnostics');

    // 5. stop: identity-verified shutdown, leaving no pid file behind.
    const stop = spawnSync(binPath, ['stop'], { cwd: outsideRoot, encoding: 'utf8', timeout: 120_000, env: updateEnv });
    assert.equal(stop.status, 0, `launcher stop failed\nstdout: ${stop.stdout}\nstderr: ${stop.stderr}`);
    const after = spawnSync(binPath, ['status', '--json'], { cwd: outsideRoot, encoding: 'utf8', timeout: 50_000, env: updateEnv });
    const afterSnapshot = JSON.parse(after.stdout) as { running: unknown, current: { version: string } | null };
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
