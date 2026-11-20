/**
 * @helmx/payload integration tests: really executes the assembly script, npm pack, an isolated npm
 * install, and the launch entry.
 *
 * Coverage:
 * 1. assembly: missing build artifacts are rebuilt on demand (with explicit timeouts); after assemble
 *    the directory/manifest/checksum contract holds;
 * 2. publish package contract: the dist root package.json (@helmx/hub default name, overridable
 *    via HELMX_PAYLOAD_PACKAGE) is a standalone package fit for npm pack/publish: an explicit files
 *    whitelist (six @helmx archives + cli bundle + web dist + contract files, NO unpacked component
 *    directories) + exact external dependency versions + the six @helmx/* file:./<pkg>.tgz entries;
 *    manifest.name shares its source;
 * 3. layout: the six @helmx runtime packages exist as tgz-only archives whose members mirror the
 *    repository dist trees (plus the built-in plugin runtime assets packed inside plugins.tgz), the
 *    cli bundle and web dist mirror directly at the payload root, no unpacked component directories,
 *    no node_modules carried; manifest node_modules/ entries are checksummed against the exact bytes
 *    packed inside the archives;
 * 4. negative paths: an uninstalled payload exits with code 3 before checksum verification (with the
 *    npm install completion instruction); a tampered checksum exits with 1 once the archives are
 *    materialized under node_modules; a manifest path escape exits with 1; start refuses to launch
 *    the hub when dependencies are missing;
 * 5. positive path (real end-to-end, in an isolated directory outside the repository): npm pack dist →
 *    safe unpack (verify every member sits under the package/ prefix and the manifest is at the package
 *    root, not a dist/ subdirectory) → npm install --omit=dev --ignore-scripts (materializes the six
 *    archives under node_modules verbatim) → start.mjs check (dependency resolution + node:sqlite + a
 *    real esbuild exercise) → start.mjs start really launches the Hub and HTTP-probes
 *    /api/auth/status → clean SIGTERM exit. Never fixture-only.
 *
 * The same assembly also produces the stable CLI artifact (dist-cli/, a zero-dependency
 * single-file bundle of the complete control CLI: packages/cli/dist/index.js with the
 * bundled-in launcher update-path closure inlined):
 * 6. cli assembly contract: shebang single-file bundle, bin/name/version/engines (name
 *    overridable via HELMX_CLI_PACKAGE, bin single-sourced from packages/cli/package.json), an
 *    empty dependency set (no unpublished private workspace packages), exact files whitelist;
 *    the Hub payload's cli/dist/index.js is the exact same bundle bytes;
 * 7. cli bundle runs for real (`helmx --help` on an isolated data dir; `status --json` against a
 *    guaranteed-dead endpoint reports an honest error envelope) and installs from a real tarball
 *    via `npm install -g` into an isolated prefix (the one-shot install story);
 * 8. golden sequence (PAYLOAD_NPM_SMOKE=1): the globally installed `helmx` installs a real Hub
 *    payload tarball (`update --tarball --version`: unpack → candidate-root npm install → check →
 *    commit → launch → health gate), `update --status` reports the running hub, and `update --stop`
 *    shuts it down cleanly — the only place the CLI artifact and the real payload artifact meet
 *    before a release ships.
 *
 * The same assembly also produces the node daemon artifact (dist-node/, the remote-machine install
 * target: bin helmx-node → dist/cli.js; @helmx/node + @helmx/env-io + @helmx/protocol inlined, exactly
 * four external exact-version dependencies):
 * 9. node assembly contract: shebang single-file bundle, bin/name/version/engines (name overridable
 *    via HELMX_NODE_PACKAGE, bin single-sourced from packages/node/package.json), dependencies
 *    exactly the four external packages pinned to the repository's installed versions (never
 *    floating ranges), peers satisfied by those pins (no inert overrides field), exact files whitelist;
 * 10. node bundle runs for real (`helmx-node --help` on an isolated data dir; `restart --json`
 *    without a bound identity reports an honest error envelope) and installs from a real tarball
 *    via `npm install -g` into an isolated prefix (network-gated like the payload e2e: the four
 *    external dependencies download from the registry — PAYLOAD_NPM_SMOKE=1).
 *
 * These live in this single file on purpose: the runner executes test files as separate concurrent
 * processes, and both artifact suites share the one build.mjs run (which wipes and rebuilds
 * packages/payload/dist and dist-cli) performed by the first test below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '@helmx/kernel';
import type { createMermaidPlugin } from '@helmx/plugins/mermaid';
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js';

const payloadPkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(payloadPkgRoot, '../..');
const stagingDir = path.join(payloadPkgRoot, 'dist');
const cliStagingDir = path.join(payloadPkgRoot, 'dist-cli');
const nodeStagingDir = path.join(payloadPkgRoot, 'dist-node');
const cliPackageName = process.env.HELMX_CLI_PACKAGE ?? '@helmx/cli';
const nodePackageName = process.env.HELMX_NODE_PACKAGE ?? '@helmx/node';

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
const sha256OfBuffer = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Member list of a tar archive (POSIX paths, directories included). */
function tgzMembers(tgz: string): string[] {
  return runCommand('tar', ['-tzf', tgz], path.dirname(tgz), 30_000).stdout.split('\n').filter(Boolean);
}

/** Raw bytes of a single archive member (checksum-grade: never text-decoded). */
function tarMemberBytes(tgz: string, member: string): Buffer {
  const res = spawnSync('tar', ['-xOf', tgz, member], { cwd: path.dirname(tgz), timeout: 30_000 });
  assert.equal(
    res.status,
    0,
    `tar -xOf failed for ${tgz}#${member}: ${res.stderr ? Buffer.from(res.stderr).toString('utf8') : 'no stderr'}`,
  );
  return Buffer.from(res.stdout);
}

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
    runCommand('pnpm', ['--filter', '@helmx/protocol', 'run', 'build'], repoRoot, 180_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/env-io/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helmx/env-io', 'run', 'build'], repoRoot, 180_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/node/dist/cli.js'))) {
    runCommand('pnpm', ['--filter', '@helmx/node', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/plugin-build/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helmx/plugin-build', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/kernel/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helmx/kernel', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/plugins/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helmx/plugins', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/hub/dist/main.js'))) {
    runCommand('pnpm', ['--filter', '@helmx/hub', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/web/dist/index.html'))) {
    runCommand('pnpm', ['--filter', '@helmx/web', 'run', 'build'], repoRoot, 300_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/cli/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helmx/cli', 'run', 'build'], repoRoot, 120_000);
  }

  runCommand(process.execPath, [path.join(payloadPkgRoot, 'build.mjs')], repoRoot, 120_000);
  assert.ok(existsSync(path.join(stagingDir, 'manifest.json')), 'manifest.json was not generated');
});

test('payload publish package contract: the dist root package.json is a standalone npm pack/publish package', { timeout: 60_000 }, () => {
  const distPkg = JSON.parse(readFileSync(path.join(stagingDir, 'package.json'), 'utf-8'));
  assert.equal(distPkg.name, '@helmx/hub', 'the default publish package name must be @helmx/hub');
  assert.equal(distPkg.type, 'module');
  assert.equal(distPkg.private, undefined, 'the publish package must not be marked private');
  assert.equal(distPkg.repository.url, 'git+https://github.com/team4u/helmx.git');
  assert.equal(distPkg.license, 'MIT');
  // files explicit whitelist: the root gitignore dist/ rule must not let npm pack strip the archives
  // or the cli/web trees; the six @helmx runtime packages ride as archives only — no unpacked
  // component directories ship.
  assert.deepEqual(
    (distPkg.files as string[]).slice().sort(),
    ['CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'cli', 'env-io.tgz', 'hub.tgz', 'kernel.tgz', 'manifest.json', 'plugin-build.tgz', 'plugins.tgz', 'protocol.tgz', 'start.mjs', 'update-handoff.mjs', 'web'].sort(),
  );
  // @helmx runtime packages install from archives (all six, hub included); direct external
  // dependencies use exact versions (no ^/~/>= floating).
  assert.equal(distPkg.dependencies['@helmx/protocol'], 'file:./protocol.tgz');
  assert.equal(distPkg.dependencies['@helmx/kernel'], 'file:./kernel.tgz');
  assert.equal(distPkg.dependencies['@helmx/plugins'], 'file:./plugins.tgz');
  assert.equal(distPkg.dependencies['@helmx/plugin-build'], 'file:./plugin-build.tgz');
  assert.equal(distPkg.dependencies['@helmx/env-io'], 'file:./env-io.tgz');
  assert.equal(distPkg.dependencies['@helmx/hub'], 'file:./hub.tgz');
  // Browser-only SDK and UI/AJV/mermaid trees must never leak into the server payload production closure.
  for (const excluded of ['@helmx/plugin-client', 'lucide-react', 'react', 'react-dom', 'react-markdown', 'remark-gfm', 'ajv', 'mermaid']) {
    assert.equal(distPkg.dependencies[excluded], undefined, `server payload must not pull ${excluded} into production dependencies`);
  }
  // The staged (archive-internal) plugins package.json must not declare browser-tree runtime deps.
  const pluginsStagedPkg = JSON.parse(tarMemberBytes(path.join(stagingDir, 'plugins.tgz'), 'package/package.json').toString('utf-8'));
  assert.equal(pluginsStagedPkg.dependencies?.['mermaid'], undefined, 'staged plugins/package.json must not declare mermaid runtime dependency');
  assert.equal(pluginsStagedPkg.dependencies?.['@helmx/plugin-client'], undefined, 'staged plugins/package.json must not declare @helmx/plugin-client runtime dependency');
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
    if (name.startsWith('@helmx/')) continue;
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
    if (rel.startsWith('node_modules/@helmx/')) {
      // The six runtime entries point at the consumer-side npm install layout; their checksums pin
      // the exact bytes packed inside the corresponding archive (npm materializes file: tarballs
      // verbatim, so post-install checkLayout verifies the installed tree against these bytes).
      const rest = rel.replace(/^node_modules\/@helmx\//, '');
      const slash = rest.indexOf('/');
      const dir = rest.slice(0, slash);
      const member = `package/${rest.slice(slash + 1)}`;
      const bytes = tarMemberBytes(path.join(stagingDir, `${dir}.tgz`), member);
      assert.equal(sha256OfBuffer(bytes), manifest.entryChecksums[key], `entries.${key} must checksum the bytes packed in ${dir}.tgz#${member}`);
    } else {
      const abs = path.join(stagingDir, rel);
      assert.ok(existsSync(abs), `the file pointed to by entries.${key} does not exist: ${rel}`);
      assert.equal(sha256Of(abs), manifest.entryChecksums[key], `entries.${key} checksum mismatch`);
    }
  }
  assert.deepEqual(
    keys,
    [
      'cli', 'cliPackageJson', 'envIo', 'envIoArchive', 'envIoPackageJson', 'hub', 'hubArchive', 'hubPackageJson',
      'kernel', 'kernelArchive', 'kernelPackageJson', 'launcher',
      'pluginBuild', 'pluginBuildArchive', 'pluginBuildPackageJson',
      'plugins', 'pluginsArchive', 'pluginsPackageJson', 'protocol',
      'changelog', 'protocolArchive', 'protocolPackageJson', 'rootPackageJson', 'updateHandoff', 'webIndex',
    ].sort(),
  );
});

test('payload layout: six tgz-only archives mirror the repo dist trees, assets packed, cli/web at root, no node_modules', { timeout: 60_000 }, () => {
  // tgz-only contract: the payload root carries each @helmx runtime package exactly once, as an
  // archive; the pre-change unpacked duplicate directories must not exist.
  const ARCHIVED_PKGS = ['hub', 'kernel', 'plugins', 'plugin-build', 'env-io', 'protocol'];
  for (const dir of ARCHIVED_PKGS) {
    assert.ok(existsSync(path.join(stagingDir, `${dir}.tgz`)), `the payload root must ship ${dir}.tgz`);
    assert.ok(!existsSync(path.join(stagingDir, dir)), `the payload root must NOT carry the unpacked ${dir}/ directory (tgz-only layout)`);
  }
  assert.equal(existsSync(path.join(stagingDir, 'plugin-client')), false, 'plugin-client source must not be shipped in server payload');
  assert.equal(existsSync(path.join(stagingDir, 'plugin-client.tgz')), false, 'plugin-client.tgz must not be shipped in server payload');

  // Every archive is a complete package: manifest at the package root plus every repository dist
  // file mirrored as a package/dist member (subset check, no byte-count coincidence assertions).
  for (const dir of ARCHIVED_PKGS) {
    const members = new Set(tgzMembers(path.join(stagingDir, `${dir}.tgz`)));
    assert.ok(members.has('package/package.json'), `${dir}.tgz must carry package/package.json`);
    for (const rel of walkFiles(path.join(repoRoot, 'packages', dir, 'dist'))) {
      assert.ok(members.has(`package/dist/${rel}`), `${dir}.tgz is missing dist file: ${rel}`);
    }
  }
  assert.ok(
    tgzMembers(path.join(stagingDir, 'hub.tgz')).includes('package/dist/main.js'),
    'hub.tgz must carry the hub composition-root entry dist/main.js',
  );
  assert.ok(
    tgzMembers(path.join(stagingDir, 'kernel.tgz')).includes('package/dist/http/hub.js'),
    'kernel.tgz must carry the kernel dist HTTP layer dist/http/hub.js',
  );

  // Built-in plugin runtime assets live inside plugins.tgz (the first probe location of every
  // plugin resolver after npm materializes the archive under node_modules).
  const pluginsMembers = new Set(tgzMembers(path.join(stagingDir, 'plugins.tgz')));
  for (const rel of expectedAssetDirs()) {
    assert.ok(
      existsSync(path.join(repoRoot, 'packages/plugins/src', rel)),
      `unexpected asset source missing: ${rel}`,
    );
    // Member presence of the directory prefix: walk the actual src files and require each one packed.
    for (const file of walkFiles(path.join(repoRoot, 'packages/plugins/src', rel))) {
      assert.ok(pluginsMembers.has(`package/dist/${rel}/${file}`), `plugins.tgz must pack built-in plugin asset: ${rel}/${file}`);
    }
  }
  const clients = expectedAssetDirs().filter((rel) => rel.endsWith('/client'));
  assert.ok(clients.length >= 9, `unexpected built-in plugin client directory count: ${clients.length}`);
  for (const rel of clients) {
    const pluginName = rel.split('/')[0]!;
    assert.ok(
      pluginsMembers.has(`package/dist/${pluginName}/dist-client/manifest.json`),
      `plugins.tgz must pack the prebuilt dist-client manifest for ${pluginName}`,
    );
  }

  // cli (self-contained bundle + tsc audit outputs) and web dist mirror directly at the payload root.
  assertMirrored(path.join(repoRoot, 'packages/cli/dist'), path.join(stagingDir, 'cli/dist'));
  assertMirrored(path.join(repoRoot, 'packages/web/dist'), path.join(stagingDir, 'web/dist'));
  assert.ok(existsSync(path.join(stagingDir, 'web/dist/index.html')), 'web dist is missing index.html');

  // stale-layout guard (mirrors build.mjs): after the package split, the kernel archive must never
  // carry product composition-root or built-in-plugin remnants.
  for (const stale of ['package/dist/main.js', 'package/dist/app.js', 'package/dist/builtin-plugins']) {
    assert.ok(!tgzMembers(path.join(stagingDir, 'kernel.tgz')).includes(stale), `stale artifact detected in kernel.tgz: ${stale} (kernel build was not cleaned)`);
  }

  // honesty: the assembly directory never carries node_modules (the dependency-completion contract is
  // consumer-side npm install).
  const stagedFiles = walkFiles(stagingDir);
  assert.ok(
    stagedFiles.every((rel) => !rel.split('/').includes('node_modules')),
    'the payload assembly directory must not contain node_modules',
  );
});

test('start.mjs check: uninstalled payload exits with code 3 before checksum verification, listing the completion step', { timeout: 60_000 }, () => {
  // beside the payload dist inside the repository workspace node_modules/@helmx/* does not exist
  // (the archives install only consumer-side), so check must honestly exit 3 from the install-state
  // gate — BEFORE any checksum verification (an uninstalled payload is not a corrupt payload);
  // strip NODE_PATH so the verdict is immune to the host environment.
  const env = { ...process.env };
  delete env.NODE_PATH;
  const res = spawnSync(process.execPath, [path.join(stagingDir, 'start.mjs'), 'check'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 50_000,
  });
  assert.equal(res.status, 3, `expected exit code 3 (dependencies not installed), got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /runtime packages not installed yet/, 'must explicitly report the uninstalled state');
  assert.match(res.stderr, /npm install/, 'must point to npm install to complete dependencies');
  assert.doesNotMatch(res.stdout, /layout validated/, 'checksum verification must not run before the install-state gate');
});

test('start.mjs check: tampered checksum or manifest path escape exits explicitly with code 1', { timeout: 60_000 }, () => {
  const broken = mkdtempSync(path.join(path.dirname(repoRoot), 'helmx-payload-broken-'));
  cpSync(stagingDir, broken, { recursive: true });
  try {
    // Materialize the archives under node_modules exactly like a consumer-side npm install (the
    // checksum verification only runs past the install-state gate).
    for (const dir of ['hub', 'kernel', 'plugins', 'plugin-build', 'env-io', 'protocol']) {
      const dest = path.join(broken, 'node_modules', '@helmx', dir);
      mkdirSync(dest, { recursive: true });
      runCommand('tar', ['-xzf', path.join(broken, `${dir}.tgz`), '-C', dest, '--strip-components=1'], broken, 30_000);
    }
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

test('start.mjs start: refuses to launch the hub when dependencies are missing (no Helmx Hub output)', { timeout: 60_000 }, () => {
  const env = { ...process.env };
  delete env.NODE_PATH;
  const res = spawnSync(process.execPath, [path.join(stagingDir, 'start.mjs'), 'start'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 50_000,
  });
  assert.equal(res.status, 3, `expected exit code 3 (refusing to start), got ${res.status}\nstderr: ${res.stderr}`);
  assert.doesNotMatch(res.stdout, /Helmx Hub:/, 'kernel startup output must not appear while dependencies are missing');
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
// Stable CLI artifact (dist-cli): the zero-dependency single-file bundle of the complete helmx CLI.
// ---------------------------------------------------------------------------

test('cli artifact assembly contract: dist-cli is a zero-dependency publish package with a shebang single-file bundle', { timeout: 60_000 }, () => {
  const pkg = JSON.parse(readFileSync(path.join(cliStagingDir, 'package.json'), 'utf-8'));
  assert.equal(pkg.name, cliPackageName);
  const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf-8'));
  assert.equal(pkg.version, payloadPkg.version, 'cli artifact version shares the payload single source');
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'the cli artifact must declare zero dependencies (one-step npm install -g)');
  assert.equal(pkg.type, 'module');
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
  assert.equal(pkg.engines.node, rootPkg.engines?.node ?? '>=24.12.0');
  // the bin name is single-sourced from the CLI workspace package (exactly one entry: helmx)
  const cliPkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages/cli/package.json'), 'utf-8'));
  assert.deepEqual(Object.keys(cliPkg.bin ?? {}), ['helmx'], 'the workspace CLI package must declare exactly one bin entry: helmx');
  const bin = pkg.bin;
  assert.deepEqual(Object.keys(bin), ['helmx'], 'the bin name is single-sourced from the CLI package');
  const bundle = readFileSync(path.join(cliStagingDir, bin['helmx']), 'utf-8');
  assert.ok(bundle.startsWith('#!/usr/bin/env node'), 'the bundle must keep the shebang to work as a bin target');
  // The authoritative zero-dependency gate runs build-side on esbuild's metafile (external @helmx/*
  // imports fail the assembly): text-scanning the bundle would false-positive on scaffold-template
  // sample code that legitimately embeds `from '@helmx/...'` inside string literals. Text-level here:
  // no workspace: specifiers and no literal dynamic imports of workspace packages may remain (a
  // non-inlined lazy import would crash at global-install time where no @helmx/* package exists).
  assert.ok(!/workspace:/.test(bundle), 'the bundle must not carry workspace: specifiers');
  for (const match of bundle.matchAll(/import\(\s*['"](@helmx\/[^'"]+)['"]/g)) {
    assert.fail(`the bundle must not carry a literal dynamic import of an unpackaged workspace package: ${match[1]}`);
  }
  assert.deepEqual(pkg.files.slice().sort(), ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'index.js']);
  for (const file of pkg.files) {
    assert.ok(existsSync(path.join(cliStagingDir, file)), `files whitelist entry missing on disk: ${file}`);
  }
  // one esbuild output, two consumers: the Hub payload's cli entry must be the exact same bundle
  // bytes as the publish artifact (both artifacts run one identical helmx CLI).
  const payloadCliEntry = path.join(stagingDir, 'cli', 'dist', 'index.js');
  assert.ok(existsSync(payloadCliEntry), 'the payload must ship cli/dist/index.js');
  assert.equal(sha256Of(payloadCliEntry), sha256Of(path.join(cliStagingDir, 'index.js')), 'payload cli/dist/index.js must be the same bundle as dist-cli/index.js');
});

test('cli bundle: help and honest error paths run for real from the single file', { timeout: 60_000 }, () => {
  const dataDir = mkdtempSync(path.join(path.dirname(repoRoot), 'helmx-cli-bundle-'));
  try {
    // isolated data dir + dead endpoint: help must never fail on Hub/credential issues (core help
    // prints with a separate diagnostic line), and exit 0.
    const help = spawnSync(process.execPath, [path.join(cliStagingDir, 'index.js'), '--help'], {
      cwd: dataDir,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, HELMX_DATA_DIR: dataDir, HELMX_HUB_URL: 'http://127.0.0.1:1' },
    });
    assert.equal(help.status, 0, `helmx --help expected exit 0, got ${help.status}\nstdout: ${help.stdout}\nstderr: ${help.stderr}`);
    assert.match(help.stdout, /Usage: helmx <command>/, 'core help must print the usage header');

    // a guaranteed-dead endpoint (port 1 on loopback never listens) must surface an explicit error
    // envelope, never a fabricated response: --json puts the envelope on stderr with a non-zero exit.
    const status = spawnSync(process.execPath, [path.join(cliStagingDir, 'index.js'), 'status', '--json'], {
      cwd: dataDir,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, HELMX_DATA_DIR: dataDir, HELMX_HUB_URL: 'http://127.0.0.1:1' },
    });
    assert.notEqual(status.status, 0, 'status against a dead endpoint must not exit 0');
    assert.match(status.stderr, /"error"/, 'the --json failure envelope must land on stderr');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('cli tarball acceptance: npm pack → npm install -g into an isolated prefix → installed bin runs', {
  timeout: 240_000,
  skip: process.platform === 'win32' ? 'bin link execution via shebang is verified on POSIX lanes' : false,
}, () => {
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helmx-cli-tgz-'));
  try {
    const packDir = path.join(outsideRoot, 'pack');
    mkdirSync(packDir, { recursive: true });
    const packRes = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], cliStagingDir, 120_000);
    const packInfo = JSON.parse(packRes.stdout);
    assert.equal(packInfo.length, 1, `expected a single tarball: ${packRes.stdout}`);
    const tgz = path.join(packDir, packInfo[0].filename);

    // Tarball shape: package-root manifest (not a dist-cli/ prefix), no node_modules payload.
    const members = runCommand('tar', ['-tzf', tgz], outsideRoot, 30_000).stdout.split('\n').filter(Boolean);
    for (const member of members) {
      assert.ok(member.startsWith('package/'), `tarball member escapes the package/ prefix: ${member}`);
    }
    for (const must of ['package/package.json', 'package/index.js', 'package/LICENSE', 'package/THIRD_PARTY_NOTICES.md']) {
      assert.ok(members.includes(must), `cli tarball is missing ${must}`);
    }
    assert.ok(!members.some((m) => m.includes('node_modules')), 'the cli tarball must not carry node_modules');

    // The one-shot story itself: install -g from the real tarball into an isolated prefix.
    const prefix = path.join(outsideRoot, 'global-prefix');
    runCommand('npm', ['install', '-g', tgz, '--prefix', prefix, '--no-audit', '--no-fund'], outsideRoot, 120_000);
    const binPath = path.join(prefix, 'bin', 'helmx');
    assert.ok(existsSync(binPath), `npm install -g must create the helmx bin link under ${prefix}/bin`);

    // Zero-dependency proof at the installed location: no node_modules was created beside the package.
    const installedPkgDir = path.join(prefix, 'lib', 'node_modules', ...cliPackageName.split('/'));
    assert.ok(existsSync(path.join(installedPkgDir, 'index.js')), 'the installed package must carry the bundled entry');
    assert.ok(!existsSync(path.join(installedPkgDir, 'node_modules')), 'a zero-dependency package must not grow node_modules on install');

    const dataDir = path.join(outsideRoot, 'data');
    const res = spawnSync(binPath, ['--help'], {
      cwd: outsideRoot,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, HELMX_DATA_DIR: dataDir, HELMX_HUB_URL: 'http://127.0.0.1:1' },
    });
    assert.equal(res.status, 0, `installed helmx --help expected exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /Usage: helmx <command>/, 'the installed bin must run the bundled CLI');
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Node daemon artifact (dist-node): the remote-machine install target with exactly four external
// exact-version dependencies.
// ---------------------------------------------------------------------------

test('node artifact assembly contract: dist-node is a four-external-dependency publish package with a shebang single-file bundle', { timeout: 60_000 }, () => {
  const pkg = JSON.parse(readFileSync(path.join(nodeStagingDir, 'package.json'), 'utf-8'));
  assert.equal(pkg.name, nodePackageName);
  const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf-8'));
  assert.equal(pkg.version, payloadPkg.version, 'node artifact version shares the payload single source');
  assert.equal(pkg.type, 'module');
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
  assert.equal(pkg.engines.node, rootPkg.engines?.node ?? '>=24.12.0');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.repository.url, 'git+https://github.com/team4u/helmx.git');
  assert.equal(pkg.repository.directory, 'packages/payload');
  assert.deepEqual(pkg.publishConfig, { access: 'public' }, 'the node artifact publishes public like the payload and cli artifacts');
  assert.equal(pkg.private, undefined, 'the publish package must not be marked private');

  // the bin name and target are single-sourced from the node workspace package (exactly one entry)
  const nodePkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages/node/package.json'), 'utf-8'));
  assert.deepEqual(nodePkg.bin, { 'helmx-node': './dist/cli.js' }, 'the workspace node package must declare exactly one bin entry: helmx-node → ./dist/cli.js');
  assert.deepEqual(pkg.bin, { 'helmx-node': './dist/cli.js' }, 'the bin shape is single-sourced from the node workspace package');

  // the dual-package self-upgrade contract: dependencies are exactly the four external packages at
  // the repository's installed versions — no fifth dependency, no floating ranges.
  const EXTERNAL_DEPS = ['@earendil-works/chord', '@earendil-works/pi-durable', 'birpc', 'ws'];
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), [...EXTERNAL_DEPS].sort(), 'the node artifact must declare exactly the four external dependencies');
  for (const name of EXTERNAL_DEPS) {
    const spec = pkg.dependencies[name];
    assert.match(spec, /^\d/, `node external dependency ${name} must be an exact version, got ${spec}`);
    const realPkgJson = JSON.parse(
      readFileSync(path.join(realpathSync(path.join(repoRoot, 'packages/node/node_modules', name)), 'package.json'), 'utf-8'),
    );
    assert.equal(realPkgJson.version, spec, `${name} repository-installed version disagrees with the dist-node contract`);
  }
  // Peer alignment is a build-time hard gate, not a shipped field: npm only honors `overrides` in
  // the install root's manifest, never in a package being installed (0.1.1 shipped inert overrides
  // and still warned ERESOLVE on `npm i -g`). The four exact pins must satisfy every peer in the
  // closure and no overrides may be declared.
  assert.equal(pkg.overrides, undefined, 'node artifact must fix peer conflicts at pin time (realign with chord peerOptional pins), not ship inert overrides');

  const bundle = readFileSync(path.join(nodeStagingDir, 'dist/cli.js'), 'utf-8');
  assert.ok(bundle.startsWith('#!/usr/bin/env node'), 'the bundle must keep the shebang to work as a bin target');
  // Text-level gates mirroring the cli artifact: no workspace: specifiers and no literal dynamic
  // imports of workspace packages may remain (the authoritative external-closure gate runs
  // build-side on esbuild's metafile).
  assert.ok(!/workspace:/.test(bundle), 'the bundle must not carry workspace: specifiers');
  for (const match of bundle.matchAll(/import\(\s*['"](@helmx\/[^'"]+)['"]/g)) {
    assert.fail(`the bundle must not carry a literal dynamic import of an unpackaged workspace package: ${match[1]}`);
  }
  assert.deepEqual(pkg.files.slice().sort(), ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'dist/cli.js']);
  for (const file of pkg.files) {
    assert.ok(existsSync(path.join(nodeStagingDir, file)), `files whitelist entry missing on disk: ${file}`);
  }
});

test('node bundle: help and honest error paths run for real from the single file', { timeout: 60_000 }, () => {
  const dataDir = mkdtempSync(path.join(path.dirname(repoRoot), 'helmx-node-bundle-'));
  try {
    // isolated data dir: help must never touch the network or the Hub and exit 0.
    const help = spawnSync(process.execPath, [path.join(nodeStagingDir, 'dist/cli.js'), '--help'], {
      cwd: dataDir,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, HELMX_DATA_DIR: dataDir },
    });
    assert.equal(help.status, 0, `helmx-node --help expected exit 0, got ${help.status}\nstdout: ${help.stdout}\nstderr: ${help.stderr}`);
    assert.match(help.stdout, /Usage: helmx-node <command>/, 'core help must print the usage header');

    // an unbound data dir must surface an explicit error envelope, never a fabricated result:
    // --json puts the envelope on stderr with a non-zero exit.
    const restart = spawnSync(process.execPath, [path.join(nodeStagingDir, 'dist/cli.js'), 'restart', '--json'], {
      cwd: dataDir,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, HELMX_DATA_DIR: dataDir },
    });
    assert.notEqual(restart.status, 0, 'restart without a bound identity must not exit 0');
    assert.match(restart.stderr, /"error"/, 'the --json failure envelope must land on stderr');
    assert.match(restart.stderr, /missing_identity/, 'the honest failure code must identify the missing identity binding');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('node tarball acceptance: npm pack → npm install -g into an isolated prefix → installed bin runs with its four dependencies', {
  timeout: 240_000,
  skip: process.env.PAYLOAD_NPM_SMOKE !== '1'
    ? 'the real npm network acceptance runs as a dedicated CI step with PAYLOAD_NPM_SMOKE=1 (the four external dependencies download from the registry)'
    : process.platform === 'win32'
      ? 'bin link execution via shebang is verified on POSIX lanes'
      : false,
}, () => {
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helmx-node-tgz-'));
  try {
    const packDir = path.join(outsideRoot, 'pack');
    mkdirSync(packDir, { recursive: true });
    const packRes = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], nodeStagingDir, 120_000);
    const packInfo = JSON.parse(packRes.stdout);
    assert.equal(packInfo.length, 1, `expected a single tarball: ${packRes.stdout}`);
    const tgz = path.join(packDir, packInfo[0].filename);

    // Tarball shape: package-root manifest (not a dist-node/ prefix), no node_modules payload.
    const members = runCommand('tar', ['-tzf', tgz], outsideRoot, 30_000).stdout.split('\n').filter(Boolean);
    for (const member of members) {
      assert.ok(member.startsWith('package/'), `tarball member escapes the package/ prefix: ${member}`);
    }
    for (const must of ['package/package.json', 'package/dist/cli.js', 'package/LICENSE', 'package/THIRD_PARTY_NOTICES.md']) {
      assert.ok(members.includes(must), `node tarball is missing ${must}`);
    }
    assert.ok(!members.some((m) => m.includes('node_modules')), 'the node tarball must not carry node_modules');

    // The one-shot story itself: install -g from the real tarball into an isolated prefix (the four
    // external dependencies resolve and download from the registry).
    const prefix = path.join(outsideRoot, 'global-prefix');
    runCommand('npm', ['install', '-g', tgz, '--prefix', prefix, '--no-audit', '--no-fund'], outsideRoot, 180_000);
    const binPath = path.join(prefix, 'bin', 'helmx-node');
    assert.ok(existsSync(binPath), `npm install -g must create the helmx-node bin link under ${prefix}/bin`);

    // Dependency resolution proof at the installed location: the four external packages landed
    // beside the bundle and resolved to the exact pinned versions (transitive dependencies of
    // those packages are npm's business, not this artifact's contract).
    const installedPkgDir = path.join(prefix, 'lib', 'node_modules', ...nodePackageName.split('/'));
    assert.ok(existsSync(path.join(installedPkgDir, 'dist/cli.js')), 'the installed package must carry the bundled entry');
    const distPkg = JSON.parse(readFileSync(path.join(nodeStagingDir, 'package.json'), 'utf-8'));
    for (const [name, spec] of Object.entries<string>(distPkg.dependencies)) {
      const installedJson = JSON.parse(readFileSync(path.join(installedPkgDir, 'node_modules', name, 'package.json'), 'utf-8'));
      assert.equal(installedJson.version, spec, `installed ${name} must match the exact pin ${spec}`);
    }

    const dataDir = path.join(outsideRoot, 'data');
    const res = spawnSync(binPath, ['--help'], {
      cwd: outsideRoot,
      encoding: 'utf8',
      timeout: 50_000,
      env: { ...process.env, HELMX_DATA_DIR: dataDir },
    });
    assert.equal(res.status, 0, `installed helmx-node --help expected exit 0, got ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    assert.match(res.stdout, /Usage: helmx-node <command>/, 'the installed bin must run the bundled daemon CLI');
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
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helmx-payload-e2e-'));
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
    for (const must of ['package/manifest.json', 'package/start.mjs', 'package/package.json', 'package/hub.tgz', 'package/kernel.tgz', 'package/plugins.tgz', 'package/plugin-build.tgz', 'package/env-io.tgz', 'package/protocol.tgz', 'package/cli/dist/index.js', 'package/web/dist/index.html']) {
      assert.ok(list.includes(must), `tarball is missing ${must} (manifest/start must sit at the package root, not a dist/ subdirectory)`);
    }
    runCommand('tar', ['-xzf', tgz, '-C', extractDir, '--strip-components=1'], outsideRoot, 60_000);

    // 3. local file: dependencies are copy-installed; after the promotion rename it must still launch.
    runCommand('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], extractDir, 300_000);
    for (const helmxPkg of ['protocol', 'kernel', 'plugins', 'plugin-build', 'env-io', 'hub']) {
      assert.equal(lstatSync(path.join(extractDir, 'node_modules', '@helmx', helmxPkg)).isSymbolicLink(), false, `@helmx/${helmxPkg} must be a real archive-installed directory`);
    }
    const promoted = path.join(outsideRoot, 'release');
    renameSync(extractDir, promoted);
    extractDir = promoted;
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helmx', 'protocol', 'dist', 'index.js')), 'protocol dependency broke after promotion');
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helmx', 'kernel', 'dist', 'index.js')), 'kernel dependency broke after promotion');
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helmx', 'plugins', 'dist', 'index.js')), 'plugins dependency broke after promotion');
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helmx', 'plugin-build', 'dist', 'index.js')), 'plugin-build dependency broke after promotion');
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helmx', 'env-io', 'dist', 'index.js')), 'env-io dependency broke after promotion');
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helmx', 'hub', 'dist', 'main.js')), 'hub dependency broke after promotion');

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
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(extractDir, 'start.mjs'), 'start'], {
      cwd: extractDir,
      env: { ...env, HELMX_PORT: String(port), HELMX_HOST: '127.0.0.1', HELMX_DATA_DIR: dataDir, HELMX_CWD: dataDir },
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
      // runtime assets landed with the plugins archive, @helmx/plugin-build installed via the file: tgz
      // with a correct npm resolution root, and the host shared shim works (the token never lands in
      // logs).
      const setupPassword = `helmx-smoke-${process.pid}-${Date.now()}`;
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
          const moduleHash = moduleRes.headers.get('x-helmx-client-hash');
          assert.ok(moduleHash !== null && moduleHash.length > 0, `${detail} is missing x-helmx-client-hash`);
          assert.ok(moduleBody.length > 0, `${detail} must not be an empty body`);
        }
      } finally {
        // the token lives only in this test's local variables; never written to logs or assertion messages.
      }

      // real acceptance of the payload-bundled CLI (the exact same single-file bundle as the
      // dist-cli artifact): the Hub-managed CLI shim runs status --json against the live Hub over real
      // HTTP — exercising the bundled command dispatch, credential env, and JSON output path.
      const cliStatus = spawnSync(
        process.platform === 'win32' ? process.execPath : path.join(dataDir, 'bin', 'helmx'),
        process.platform === 'win32'
          ? [path.join(extractDir, 'cli', 'dist', 'index.js'), 'status', '--json']
          : ['status', '--json'],
        {
          cwd: extractDir,
          encoding: 'utf8',
          timeout: 50_000,
          env: { ...env, HELMX_HUB_URL: `http://127.0.0.1:${port}`, HELMX_TOKEN: token },
        },
      );
      assert.equal(
        cliStatus.status,
        0,
        `bundled helmx status --json expected exit 0, got ${cliStatus.status}\nstdout: ${cliStatus.stdout}\nstderr: ${cliStatus.stderr}`,
      );
      const cliStatusBody = JSON.parse(cliStatus.stdout) as Record<string, unknown>;
      assert.equal(cliStatusBody['configured'], true, 'the bundled CLI must see a configured Hub');
      assert.equal(cliStatusBody['authenticated'], true, 'the bundled CLI must authenticate with the setup token');
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
    assert.match(stdout, /Helmx Hub:/, 'Hub startup banner missing');
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

function mkdirSyncRecursive(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

test('payload prebuilt mermaid: unpacked plugins.tgz serves mermaid & chunks without node_modules/mermaid or buildProvider', { timeout: 60_000 }, async () => {
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helmx-payload-mermaid-'));
  try {
    const isoPlugins = path.join(outsideRoot, 'plugins');
    const isoProtocol = path.join(outsideRoot, 'plugins/node_modules/@helmx/protocol');
    const isoTypebox = path.join(outsideRoot, 'plugins/node_modules/typebox');
    const dataDir = path.join(outsideRoot, 'data');
    mkdirSyncRecursive(isoPlugins);
    mkdirSyncRecursive(isoProtocol);
    mkdirSyncRecursive(dataDir);

    // Unpack packed plugins.tgz & protocol.tgz outside repoRoot (so repo node_modules/mermaid is unreachable).
    runCommand('tar', ['-xzf', path.join(stagingDir, 'plugins.tgz'), '-C', isoPlugins, '--strip-components=1'], outsideRoot, 30_000);
    runCommand('tar', ['-xzf', path.join(stagingDir, 'protocol.tgz'), '-C', isoProtocol, '--strip-components=1'], outsideRoot, 30_000);
    assert.ok(existsSync(path.join(isoPlugins, 'dist/mermaid/dist-client/manifest.json')), 'plugins.tgz must carry mermaid dist-client');
    // Supply protocol's lightweight runtime dep `typebox` only if imported; note mermaid imports only @helmx/protocol (`HelmxError`).
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
 * CLI golden sequence (real npm network acceptance, gated like the payload e2e above): the
 * globally installed `helmx` installs a real Hub payload tarball into its own release root
 * (`update --tarball --version`: unpack → candidate-root npm install → check → commit → launch →
 * health gate — the first `helmx update` defaults to install and start), `update --status`
 * reflects the running release, and `update --stop` shuts it down cleanly. This is the only
 * place the CLI artifact and the real payload artifact meet before a release ships.
 *
 * Note: the user-facing update surface (`helmx update --check/--watch/--status/--stop/--channel/
 * --interval-ms/--tarball+--version`, no --start) is implemented CLI-side on the bundled-in launcher's
 * typed API; this sequence pins the distribution contract against it.
 */
test('cli golden sequence: installed helmx updates from a real payload tarball, health-gates, and stops', {
  timeout: 600_000,
  skip: process.env.PAYLOAD_NPM_SMOKE !== '1'
    ? 'the real npm network acceptance runs as a dedicated CI step with PAYLOAD_NPM_SMOKE=1'
    : process.platform === 'win32'
      ? 'bin link execution via shebang is verified on POSIX lanes'
      : false,
}, async () => {
  const payloadPkg = JSON.parse(readFileSync(path.join(stagingDir, 'package.json'), 'utf-8'));
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helmx-cli-golden-'));
  try {
    // 1. Real tarballs: cli (published form) + Hub payload (the update target).
    const packDir = path.join(outsideRoot, 'pack');
    mkdirSync(packDir, { recursive: true });
    const cliPack = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], cliStagingDir, 120_000);
    const cliTgz = path.join(packDir, JSON.parse(cliPack.stdout)[0].filename);
    const payloadPack = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], stagingDir, 120_000);
    const payloadTgz = path.join(packDir, JSON.parse(payloadPack.stdout)[0].filename);

    // 2. One-shot install of the CLI, exactly as a member machine would do it.
    const prefix = path.join(outsideRoot, 'global-prefix');
    runCommand('npm', ['install', '-g', cliTgz, '--prefix', prefix, '--no-audit', '--no-fund'], outsideRoot, 120_000);
    const binPath = path.join(prefix, 'bin', 'helmx');
    assert.ok(existsSync(binPath), 'npm install -g must create the helmx bin link');

    // 3. update --tarball --version: the first update installs and starts (default action; there is
    //    no --start flag on the new surface). The install root and the hub data dir stay separate
    //    trees by contract; the port is an ephemeral claim, not a guess.
    const installRoot = path.join(outsideRoot, 'install-root');
    const dataDir = path.join(outsideRoot, 'hub-data');
    const port = await freePort();
    const updateEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HELMX_HUB_INSTALL_ROOT: installRoot,
      HELMX_PORT: String(port),
      HELMX_HOST: '127.0.0.1',
      HELMX_DATA_DIR: dataDir,
    };
    delete updateEnv.NODE_PATH;
    const update = spawnSync(binPath, ['update', '--tarball', payloadTgz, '--version', payloadPkg.version], {
      cwd: outsideRoot, encoding: 'utf8', timeout: 420_000, env: updateEnv,
    });
    assert.equal(
      update.status,
      0,
      `helmx update --tarball failed (exit ${update.status})\nstdout: ${update.stdout}\nstderr: ${update.stderr}`,
    );

    // 4. update --status: the committed release is current and the hub is running and healthy.
    const status = spawnSync(binPath, ['update', '--status', '--json'], { cwd: outsideRoot, encoding: 'utf8', timeout: 50_000, env: updateEnv });
    assert.equal(status.status, 0, `helmx update --status --json failed\nstdout: ${status.stdout}\nstderr: ${status.stderr}`);
    const snapshot = JSON.parse(status.stdout);
    assert.equal(snapshot.current?.version, payloadPkg.version);
    assert.ok(snapshot.running !== null, 'the hub must be running after the default install-and-start update');
    assert.equal(snapshot.running.port, port);
    assert.equal(snapshot.running.alive, true);
    assert.equal(snapshot.running.healthy, true, 'the health gate must have passed before update reported success');
    assert.ok(existsSync(path.join(installRoot, 'releases', payloadPkg.version)), 'the immutable release directory must exist');
    assert.ok(existsSync(path.join(installRoot, 'logs', 'hub.log')), 'the detached hub log must exist for diagnostics');

    const pluginDir = path.join(outsideRoot, 'client-fixture');
    mkdirSync(pluginDir);
    writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'client-fixture', clientRoot: '.' }));
    writeFileSync(path.join(pluginDir, 'client.tsx'), 'export function Panel() { return null }\n');
    const compiled = spawnSync(binPath, ['plugins', 'build', pluginDir, '--module', 'client.tsx', '--json'], {
      cwd: outsideRoot, encoding: 'utf8', timeout: 50_000, env: updateEnv,
    });
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.deepEqual(JSON.parse(compiled.stdout).manifest.modules['client.tsx'].exports, ['Panel']);

    // 5. update --stop: identity-verified shutdown, leaving no pid file behind.
    const stop = spawnSync(binPath, ['update', '--stop'], { cwd: outsideRoot, encoding: 'utf8', timeout: 120_000, env: updateEnv });
    assert.equal(stop.status, 0, `helmx update --stop failed\nstdout: ${stop.stdout}\nstderr: ${stop.stderr}`);
    const after = spawnSync(binPath, ['update', '--status', '--json'], { cwd: outsideRoot, encoding: 'utf8', timeout: 50_000, env: updateEnv });
    const afterSnapshot = JSON.parse(after.stdout);
    assert.equal(afterSnapshot.running, null, 'no hub may keep running after update --stop');
    assert.equal(afterSnapshot.current?.version, payloadPkg.version, 'the committed release survives the stop');
    assert.ok(readdirSync(path.join(installRoot, 'releases')).length >= 1, 'release directories are retained for rollback');
  } finally {
    // Best-effort cleanup: stop anything the sequence may have left running before dropping the tree.
    spawnSync(path.join(outsideRoot, 'global-prefix', 'bin', 'helmx'), ['update', '--stop'], {
      cwd: outsideRoot, timeout: 60_000, env: { ...process.env, HELMX_HUB_INSTALL_ROOT: path.join(outsideRoot, 'install-root') },
    });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});
