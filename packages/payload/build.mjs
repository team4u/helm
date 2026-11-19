#!/usr/bin/env node
/**
 * Hub npm payload assembly script: produces a standalone package directory dist/ ready for direct
 * `npm pack` / `npm publish`.
 *
 * Output layout (dist/ is the publish package root; the release agent runs npm pack/publish inside dist):
 *   package.json     publish manifest (name defaults to @helmx/hub, overridable via the build env
 *                    HELMX_PAYLOAD_PACKAGE; manifest.name shares the same source). dependencies
 *                    = the root set of the hub/kernel/plugins/plugin-build/env-io/protocol production
 *                    dependency closure: external dependencies are pinned to the exact versions actually
 *                    installed by pnpm in the repository, @helmx/* packages are materialized as
 *                    file:./<pkg>.tgz (each carrying its own dist/ and package.json). The consumer
 *                    runs `npm install --omit=dev --ignore-scripts` and npm unpacks the archives into
 *                    node_modules verbatim (file: tarballs install byte-for-byte; exercised end-to-end
 *                    by the PAYLOAD_NPM_SMOKE e2e), completing the dependencies (esbuild platform
 *                    packages install automatically per target platform via optionalDependencies).
 *   hub.tgz kernel.tgz plugins.tgz plugin-build.tgz env-io.tgz protocol.tgz
 *                    the six @helmx runtime packages as npm archives ONLY — the payload root never
 *                    carries their unpacked directories. Runtime Node resolution, built-in plugin asset
 *                    probing (node_modules/@helmx/plugins/dist/<name>) and the launch entry all operate
 *                    on the consumer-side node_modules layout, so a second unpacked copy would be pure
 *                    duplication (~6 MiB compressed); the unpacked staging directories below are
 *                    transient packing inputs, removed once the archives exist.
 *   cli/{package.json, dist/}      CLI output (package.json kept for locating/auditing; dist/index.js is
 *                                  the same zero-dependency single-file bundle as the dist-cli artifact,
 *                                  so the payload-side `helmx` and the globally installed `helmx` are one CLI;
 *                                  the bundle self-contains the CLI workspace closure, so it stays at the
 *                                  payload root instead of riding an archive)
 *   web/dist/                      Vite output (start.mjs points at it explicitly via HELMX_WEB_DIST_DIR)
 *   start.mjs + manifest.json      zero-dependency launch entry and the version/entry/checksum contract
 *
 * The same build also assembles two sibling publish packages: the stable CLI artifact
 * (see src/assemble-cli.mjs): dist-cli/ is a zero-dependency, single-file bundle of the complete
 * control CLI (packages/cli/dist/index.js incl. the bundled-in launcher update-path closure) that
 * installs globally via one `npm install -g` (bin helmx); and the node daemon artifact
 * (see src/assemble-node.mjs): dist-node/ bundles the node daemon CLI (packages/node/dist/cli.js)
 * with @helmx/node + @helmx/env-io + @helmx/protocol inlined and exactly four external exact-version
 * dependencies (bin helmx-node → dist/cli.js; the dual-package self-upgrade target). The Hub payload
 * contract above is unchanged by those artifacts except for the cli entry bytes; a missing CLI or
 * node dist input aborts the build.
 *
 * Note: `@helmx/plugin-client` is a browser-only SDK already bundled into `web/dist` and virtualized by
 * `@helmx/plugin-build` via `globalThis.__helmx_shared_plugin_client`, so neither `@helmx/plugin-client`
 * nor its browser UI dependency tree (`react`, `lucide-react`, `@radix-ui/*`, markdown) enters the Hub
 * server payload.
 *
 * Honesty boundary: this script does not bundle node_modules (platform-native binaries make
 * self-containment require per-platform vendoring, see README); the dependency-completion contract is
 * consumer-side npm install, and `start.mjs check` runs the explicit verification.
 */
import { createHash } from 'node:crypto';
import { create as createTar } from 'tar';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPeerOverrides, resolveDepRealDir } from './src/dep-closure.mjs';
import { assembleCliArtifact } from './src/assemble-cli.mjs';
import { assembleNodeArtifact } from './src/assemble-node.mjs';

const payloadPkgRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(payloadPkgRoot, '../..');
const stagingDir = path.join(payloadPkgRoot, 'dist');

/** Publish payload package name (overridable via HELMX_PAYLOAD_PACKAGE). */
const payloadPackageName = process.env.HELMX_PAYLOAD_PACKAGE ?? '@helmx/hub';

/** Built-in plugin runtime asset subdirectories: every plugin resolver probes the same-named dist-side directory first. */
const RUNTIME_ASSET_SUBDIRS = ['client', 'skill', 'assets'];

const inputs = [
  ['hub dist entry', path.join(repoRoot, 'packages/hub/dist/main.js')],
  ['hub package.json', path.join(repoRoot, 'packages/hub/package.json')],
  ['kernel dist entry', path.join(repoRoot, 'packages/kernel/dist/index.js')],
  ['kernel dist HTTP layer', path.join(repoRoot, 'packages/kernel/dist/http/hub.js')],
  ['kernel package.json', path.join(repoRoot, 'packages/kernel/package.json')],
  ['plugins dist entry', path.join(repoRoot, 'packages/plugins/dist/index.js')],
  ['plugins package.json', path.join(repoRoot, 'packages/plugins/package.json')],
  ['plugin-build dist entry', path.join(repoRoot, 'packages/plugin-build/dist/index.js')],
  ['plugin-build package.json', path.join(repoRoot, 'packages/plugin-build/package.json')],
  ['env-io dist entry', path.join(repoRoot, 'packages/env-io/dist/index.js')],
  ['env-io package.json', path.join(repoRoot, 'packages/env-io/package.json')],
  ['protocol dist entry', path.join(repoRoot, 'packages/protocol/dist/index.js')],
  ['protocol package.json', path.join(repoRoot, 'packages/protocol/package.json')],
  ['web dist entry', path.join(repoRoot, 'packages/web/dist/index.html')],
  ['cli dist entry', path.join(repoRoot, 'packages/cli/dist/index.js')],
  ['built-in plugin asset source', path.join(repoRoot, 'packages/plugins/src')],
];

// Entry validation: list every missing item at once and never skip silently (when artifacts are missing,
// run `pnpm build` at the repository root first).
const missing = inputs.filter(([, p]) => !existsSync(p)).map(([label, p]) => `- ${label}: ${p}`);
if (missing.length > 0) {
  console.error(`[payload] build artifacts missing, refusing to assemble (run pnpm build at the repository root first, then retry):\n${missing.join('\n')}`);
  process.exit(1);
}

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Counts files and total bytes inside a directory (for the assembly summary). */
function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  const visit = (cur) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) visit(p);
      else {
        files += 1;
        bytes += readFileSync(p).length;
      }
    }
  };
  visit(dir);
  return { files, bytes };
}

// --- Root dependency set: production dependencies of hub ∪ kernel ∪ plugins ∪ plugin-build ∪ env-io ∪ protocol; @helmx/* installs from archives ------
// External dependency versions come from the exact package.json version of the repository's installed
// pnpm resolution (the real package the node_modules symlink points at) — never carry ^/~ floating
// ranges into the publish contract (reproducible installs).
const RUNTIME_PKGS = ['kernel', 'plugins', 'hub', 'plugin-build', 'env-io', 'protocol'];
const pkgJsonOf = Object.fromEntries(
  RUNTIME_PKGS.map((dir) => [dir, JSON.parse(readFileSync(path.join(repoRoot, 'packages', dir, 'package.json'), 'utf-8'))]),
);
/** Dependency name → the first runtime package directory that declares it (the lockfile keeps versions
 * consistent repo-wide, so any declaring root resolves the same version). field is 'dependencies' or
 * 'peerDependencies' (peer exact versions likewise resolve from the declaring package directory). */
function owningPkgDirOf(name, field = 'dependencies') {
  for (const dir of RUNTIME_PKGS) {
    if (Object.keys(pkgJsonOf[dir][field] ?? {}).includes(name)) return path.join(repoRoot, 'packages', dir);
  }
  if (field === 'dependencies') return owningPkgDirOf(name, 'peerDependencies');
  return null;
}
function resolveInstalledExactVersion(pkgDir, name) {
  const resolved = resolveDepRealDir(pkgDir, name, false);
  if (resolved.error) {
    console.error(`[payload] dependency ${name} not installed or unresolvable (${path.relative(repoRoot, pkgDir)}/node_modules/${name}): ${resolved.error}. Run pnpm install at the repository root first.`);
    process.exit(1);
  }
  const version = resolved.pkgJson.version;
  if (typeof version !== 'string' || version.length === 0) {
    console.error(`[payload] package.json of dependency ${name} is missing a version`);
    process.exit(1);
  }
  return version;
}

const externalDeps = [...new Set(RUNTIME_PKGS.flatMap((dir) => Object.keys(pkgJsonOf[dir].dependencies ?? {})))]
  .filter((name) => !name.startsWith('@helmx/'))
  .sort();
const rootDependencies = Object.fromEntries(
  externalDeps.map((name) => [name, resolveInstalledExactVersion(owningPkgDirOf(name), name)]),
);
// Peer dependencies of the runtime packages also join the root dependency set with exact pins:
// npm auto-installs peers for file: archives, and floating peer resolution would break the
// reproducible-install contract — pin everything to the repository's installed versions.
const externalPeers = [...new Set(RUNTIME_PKGS.flatMap((dir) => Object.keys(pkgJsonOf[dir].peerDependencies ?? {})))]
  .filter((name) => !name.startsWith('@helmx/') && !(name in rootDependencies))
  .sort();
for (const name of externalPeers) {
  rootDependencies[name] = resolveInstalledExactVersion(owningPkgDirOf(name, 'peerDependencies'), name);
}
rootDependencies['@helmx/protocol'] = 'file:./protocol.tgz';
rootDependencies['@helmx/kernel'] = 'file:./kernel.tgz';
rootDependencies['@helmx/plugins'] = 'file:./plugins.tgz';
rootDependencies['@helmx/plugin-build'] = 'file:./plugin-build.tgz';
rootDependencies['@helmx/env-io'] = 'file:./env-io.tgz';
rootDependencies['@helmx/hub'] = 'file:./hub.tgz';

// npm resolves peers strictly by default (ERESOLVE), while the repository's pnpm install allows peer
// versions wider than declared (e.g. chord pins peer ws@8.21.0 while the repository locks 8.22.1). Scan
// the installed closure to generate overrides that unify conflicting names held at the root to the root
// exact versions — so a bare consumer-side `npm install --omit=dev --ignore-scripts` works out of the
// box without extra flags (.npmrc cannot ship inside a tarball; npm permanently excludes it).
const peerOverrides = scanPeerOverrides(
  [...externalDeps, ...externalPeers].map((name) => ({
    name,
    version: rootDependencies[name],
    fromPkgDir: owningPkgDirOf(name),
  })),
);

const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf-8'));
const distPackageJson = {
  name: payloadPackageName,
  version: payloadPkg.version,
  type: 'module',
  description: 'helmx Hub runtime payload (six @helmx runtime archives + cli bundle + web dist and a zero-dependency launch entry)',
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/team4u/helmx.git', directory: 'packages/payload' },
  publishConfig: { access: 'public' },
  engines: { node: rootPkg.engines?.node ?? '>=24.12.0' },
  files: ['hub.tgz', 'kernel.tgz', 'plugins.tgz', 'plugin-build.tgz', 'env-io.tgz', 'protocol.tgz', 'cli', 'web', 'start.mjs', 'manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  dependencies: Object.fromEntries(Object.keys(rootDependencies).sort().map((k) => [k, rootDependencies[k]])),
  ...(peerOverrides.size > 0
    ? { overrides: Object.fromEntries([...peerOverrides.entries()].sort(([a], [b]) => a.localeCompare(b))) }
    : {}),
};

// --- Assembly (wipe and rebuild first; the output is re-entrant) --------------------------------------------------
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

// --- Stable CLI artifact (second publish entry) + the payload CLI entry: one esbuild bundle, two consumers.
// assembleCliArtifact bundles packages/cli/dist/index.js (the full control CLI incl. the
// bundled-in launcher typed-API update path) into dist-cli/index.js — a hard release input; a broken
// bundle contract aborts the build inside assemble-cli.mjs. The same bytes are shipped inside the
// Hub payload as cli/dist/index.js below, so both artifacts run one identical CLI.
const cliArtifact = await assembleCliArtifact({
  repoRoot,
  version: payloadPkg.version,
  enginesNode: distPackageJson.engines.node,
});

// --- Node daemon artifact (third publish entry): the remote-machine install target. assembleNodeArtifact
// bundles packages/node/dist/cli.js with the workspace closure inlined and the four external packages
// (chord / pi-durable / birpc / ws) pinned at their exact installed versions; a broken bundle contract
// aborts the build inside assemble-node.mjs. Publish order stays payload → cli → node.
await assembleNodeArtifact({
  repoRoot,
  version: payloadPkg.version,
  enginesNode: distPackageJson.engines.node,
});

for (const dir of ['hub', 'kernel', 'plugins', 'plugin-build', 'env-io', 'protocol', 'cli']) {
  cpSync(path.join(repoRoot, 'packages', dir, 'dist'), path.join(stagingDir, dir, 'dist'), { recursive: true });
  cpSync(path.join(repoRoot, 'packages', dir, 'package.json'), path.join(stagingDir, dir, 'package.json'));
}
// The payload's CLI entry is the same single-file bundle as the dist-cli artifact: the bundle
// self-contains the CLI's workspace closure (the bundled-in launcher / the env-io update engine / tar ride along via
// the update path), so the payload root dependency set needs no additions for the CLI to run and
// start.mjs check keeps resolving from the cli entry point. The remaining cli/dist tsc outputs stay
// as layout/auditing helper assets; `helmx plugins build`'s computed dynamic import of
// @helmx/plugin-build resolves at runtime from the payload root node_modules (plugin-build.tgz).
copyFileSync(cliArtifact.bundleFile, path.join(stagingDir, 'cli', 'dist', 'index.js'));
cpSync(path.join(repoRoot, 'packages/web/dist'), path.join(stagingDir, 'web/dist'), { recursive: true });
cpSync(path.join(payloadPkgRoot, 'src/start.mjs'), path.join(stagingDir, 'start.mjs'));
cpSync(path.join(repoRoot, 'LICENSE'), path.join(stagingDir, 'LICENSE'));
cpSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), path.join(stagingDir, 'THIRD_PARTY_NOTICES.md'));
// Report the payload publish version at runtime so Hub / CLI don't keep reporting the old workspace
// version; also strip @helmx/* workspace dependencies: the root package.json installs every @helmx/*
// archive uniformly, and leftover workspace:* protocols inside sub-packages would make consumer-side
// npm install fail outright (npm doesn't support the workspace: protocol); at runtime Node's
// level-by-level upward resolution hits the same instances in the root node_modules.
for (const component of ['hub', 'kernel', 'plugins', 'plugin-build', 'env-io', 'protocol', 'cli']) {
  const manifestPath = path.join(stagingDir, component, 'package.json');
  const componentPackage = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deps = Object.fromEntries(
    Object.entries(componentPackage.dependencies ?? {}).filter(([name]) => !name.startsWith('@helmx/')),
  );
  const staged = { ...componentPackage, version: payloadPkg.version, dependencies: deps };
  // Hub only: drop the workspace `helmx-hub` bin. Inside the payload the archive is a file:
  // dependency launched through start.mjs (which owns the env contract); an installed bin link
  // would advertise a second entry point that bypasses it.
  if (component === 'hub') delete staged.bin;
  writeFileSync(manifestPath, `${JSON.stringify(staged, null, 2)}\n`);
}
// Built-in plugin runtime assets: packages/plugins/src/<name>/{client,skill,assets}
// → dist/plugins/dist/<name>/{...} (the first probe location of every plugin resolver).
// Must happen before packing plugins.tgz: archive installs (npm file:./plugins.tgz) only see the tgz
// contents on the consumer side; if directory assets landed after packing, skill/assets/client would be
// silently lost.
const builtinSrc = path.join(repoRoot, 'packages/plugins/src');
const builtinDist = path.join(repoRoot, 'packages/plugins/dist');
const copiedAssets = [];
const missingPrebuilt = [];
for (const ent of readdirSync(builtinSrc, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!ent.isDirectory()) continue;
  for (const sub of RUNTIME_ASSET_SUBDIRS) {
    const from = path.join(builtinSrc, ent.name, sub);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(stagingDir, 'plugins/dist', ent.name, sub), { recursive: true });
    copiedAssets.push(`${ent.name}/${sub}`);
  }
  if (existsSync(path.join(builtinSrc, ent.name, 'client'))) {
    const distClientFrom = path.join(builtinDist, ent.name, 'dist-client');
    const distClientManifest = path.join(distClientFrom, 'manifest.json');
    if (!existsSync(distClientManifest)) {
      missingPrebuilt.push(`${ent.name}/dist-client/manifest.json`);
    } else {
      cpSync(distClientFrom, path.join(stagingDir, 'plugins/dist', ent.name, 'dist-client'), { recursive: true });
      copiedAssets.push(`${ent.name}/dist-client`);
    }
  }
}
if (missingPrebuilt.length > 0) {
  console.error(`[payload] built-in plugin prebuilt dist-client missing (rebuild @helmx/plugins first):\n${missingPrebuilt.map((m) => `- ${m}`).join('\n')}`);
  process.exit(1);
}

// Directory-shaped file: dependencies produce junctions pointing into staging on Windows; archive installs are safe to move.
for (const dir of ['hub', 'protocol', 'kernel', 'plugins', 'plugin-build', 'env-io']) {
  await createTar({ cwd: path.join(stagingDir, dir), file: path.join(stagingDir, `${dir}.tgz`), gzip: true, portable: true, prefix: 'package' }, ['package.json', 'dist']);
}
writeFileSync(path.join(stagingDir, 'package.json'), `${JSON.stringify(distPackageJson, null, 2)}\n`);

// --- Stale-layout guard: after the package split, kernel dist must never again carry product/plugin remnants -------------
// Why: tsc doesn't clean old output; if the kernel package was incrementally built over the old layout,
// copying the whole directory here would quietly ship stale product. Fail on detection — never publish
// with suspicious artifacts.
const staleArtifacts = [
  ['kernel/dist/main.js', 'kernel composition-root entry (moved to @helmx/hub)'],
  ['kernel/dist/app.js', 'kernel composition root (moved to @helmx/hub)'],
  ['kernel/dist/builtin-plugins', 'kernel built-in plugins (moved to @helmx/plugins)'],
];
const stale = staleArtifacts.filter(([rel]) => existsSync(path.join(stagingDir, rel)));
if (stale.length > 0) {
  console.error(`[payload] stale artifacts detected in kernel dist (rebuild packages/kernel after a clean):\n${stale.map(([rel, why]) => `- ${rel}: ${why}`).join('\n')}`);
  process.exit(1);
}

// --- manifest (version / entry / checksum contract; paths relative to the payload root, POSIX separators) ----
// The six @helmx runtime entries point at the consumer-side npm install layout
// (node_modules/@helmx/<pkg>/...): that is where Node resolution, plugin asset probing and the launch
// entry actually operate. Their checksums pin the exact bytes packed into the archives — npm
// materializes file: tarballs verbatim (verified end-to-end by the PAYLOAD_NPM_SMOKE e2e), so
// post-install checkLayout proves the installed tree matches what was shipped. The *Archive entries
// checksum the archive bytes themselves (assembly-stable transport integrity: a truncated or mutated
// themselves (assembly-stable transport integrity: a truncated or mutated .tgz is detectable at any
// time, independent of installation state).
const entries = {
  launcher: 'start.mjs',
  rootPackageJson: 'package.json',
  hub: 'node_modules/@helmx/hub/dist/main.js',
  hubPackageJson: 'node_modules/@helmx/hub/package.json',
  hubArchive: 'hub.tgz',
  kernel: 'node_modules/@helmx/kernel/dist/index.js',
  kernelPackageJson: 'node_modules/@helmx/kernel/package.json',
  kernelArchive: 'kernel.tgz',
  plugins: 'node_modules/@helmx/plugins/dist/index.js',
  pluginsPackageJson: 'node_modules/@helmx/plugins/package.json',
  pluginsArchive: 'plugins.tgz',
  pluginBuild: 'node_modules/@helmx/plugin-build/dist/index.js',
  pluginBuildPackageJson: 'node_modules/@helmx/plugin-build/package.json',
  pluginBuildArchive: 'plugin-build.tgz',
  envIo: 'node_modules/@helmx/env-io/dist/index.js',
  envIoPackageJson: 'node_modules/@helmx/env-io/package.json',
  envIoArchive: 'env-io.tgz',
  protocol: 'node_modules/@helmx/protocol/dist/index.js',
  protocolPackageJson: 'node_modules/@helmx/protocol/package.json',
  protocolArchive: 'protocol.tgz',
  cli: 'cli/dist/index.js',
  cliPackageJson: 'cli/package.json',
  webIndex: 'web/dist/index.html',
};
const entryChecksums = Object.fromEntries(
  Object.entries(entries).map(([key, rel]) => {
    // node_modules entries hash their packing input (the staged bytes inside the archive): strip the
    // consumer-side install prefix down to the staged component path; every other entry hashes the
    // shipped file directly.
    const stagedRel = rel.startsWith('node_modules/@helmx/') ? rel.replace(/^node_modules\/@helmx\//, '') : rel;
    return [key, sha256Of(path.join(stagingDir, stagedRel))];
  }),
);
const manifest = {
  formatVersion: 1,
  name: distPackageJson.name,
  version: distPackageJson.version,
  builtAt: new Date().toISOString(),
  nodeEngines: distPackageJson.engines.node,
  entries,
  entryChecksums,
};
writeFileSync(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// --- tgz-only layout: drop the transient unpacked staging directories of the six archived packages ----
// They were packing inputs only (runtime operates on node_modules); keeping them would duplicate
// every package as ~6 MiB of compressed dead weight inside the publish artifact.
for (const dir of ['hub', 'kernel', 'plugins', 'plugin-build', 'env-io', 'protocol']) {
  rmSync(path.join(stagingDir, dir), { recursive: true, force: true });
}

const stats = walkStats(stagingDir);
console.log(`[payload] assembly complete: ${stagingDir}`);
console.log(`[payload] publish package name: ${distPackageJson.name}@${distPackageJson.version} (overridable via HELMX_PAYLOAD_PACKAGE)`);
console.log(`[payload] root dependencies: ${Object.keys(rootDependencies).length} entries (${externalDeps.length} exact external pins + ${externalPeers.length} peers + @helmx/* file:./<pkg>.tgz ×6)`);
console.log(`[payload] ${stats.files} files, ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB total`);
console.log(`[payload] runtime asset directories packed into plugins.tgz: ${copiedAssets.length}: ${copiedAssets.join(', ')}`);
console.log('[payload] note: node_modules is not bundled; consumers run npm install --omit=dev --ignore-scripts to unpack the six @helmx archives and complete dependencies (verified by start.mjs check)');
console.log(`[payload] cli entry: cli/dist/index.js is the same zero-dependency bundle as the dist-cli artifact (${path.basename(cliArtifact.bundleFile)})`);
