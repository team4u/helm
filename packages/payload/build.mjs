#!/usr/bin/env node
/**
 * Hub npm payload assembly script: produces a standalone package directory dist/ ready for direct
 * `npm pack` / `npm publish`.
 *
 * Output layout (dist/ is the publish package root; the release agent runs npm pack/publish inside dist):
 *   package.json     publish manifest (name defaults to @team4u/helm-hub, overridable via the build env
 *                    HELM_PAYLOAD_PACKAGE; manifest.name shares the same source). dependencies
 *                    = the root set of the hub/kernel/plugins/plugin-build/env-io/protocol production
 *                    dependency closure: external dependencies are pinned to the exact versions actually
 *                    installed by pnpm in the repository, @helm/* packages are materialized as
 *                    file:./<pkg>.tgz (each carrying its own dist/ and package.json). The consumer
 *                    unpacks the tgz files and runs `npm install --omit=dev --ignore-scripts` to complete
 *                    the dependencies (esbuild platform packages install automatically per target
 *                    platform via optionalDependencies).
 *   hub/{package.json, dist/}     @helm/hub composition-root output (helm-hub entry dist/main.js)
 *   kernel/{package.json, dist/}  kernel mechanism output (pure mechanism package, no built-in plugins)
 *   plugins/{package.json, dist/} @helm/plugins output + built-in plugin runtime assets
 *   plugin-build/{package.json, dist/} @helm/plugin-build build implementation (esbuild compilation /
 *                                 TS transform; hub injects it as the kernel build port; file: dependency)
 *   env-io/{package.json, dist/} @helm/env-io execution-side shared I/O implementation
 *   protocol/{package.json, dist/} protocol build output (file: dependency)
 *   cli/{package.json, dist/}      CLI output (package.json kept for locating/auditing; the runtime entry
 *                                  can be pointed at cli/dist/index.js via HELM_CLI_ENTRY)
 *   web/dist/                      Vite output (start.mjs points at it explicitly via HELM_WEB_DIST_DIR)
 *   start.mjs + manifest.json      zero-dependency launch entry and the version/entry/checksum contract
 *
 * The same build additionally assembles the stable launcher artifact when the hub-launcher package
 * exists (see src/assemble-launcher.mjs): dist-launcher/ is a second publish package — a
 * zero-dependency, single-file bundle of helm-hub-launcher + @helm/update that installs globally
 * via one `npm install -g`. The Hub payload contract above is unchanged by that artifact.
 *
 * Note: `@helm/plugin-client` is a browser-only SDK already bundled into `web/dist` and virtualized by
 * `@helm/plugin-build` via `globalThis.__helm_shared_plugin_client`, so neither `@helm/plugin-client`
 * nor its browser UI dependency tree (`react`, `lucide-react`, `@radix-ui/*`, markdown) enters the Hub
 * server payload.
 *
 * Honesty boundary: this script does not bundle node_modules (platform-native binaries make
 * self-containment require per-platform vendoring, see README); the dependency-completion contract is
 * consumer-side npm install, and `start.mjs check` runs the explicit verification.
 */
import { createHash } from 'node:crypto';
import { create as createTar } from 'tar';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPeerOverrides, resolveDepRealDir } from './src/dep-closure.mjs';
import { assembleLauncherArtifact, launcherSourcesPresent } from './src/assemble-launcher.mjs';

const payloadPkgRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(payloadPkgRoot, '../..');
const stagingDir = path.join(payloadPkgRoot, 'dist');

/** Publish payload package name (overridable via HELM_PAYLOAD_PACKAGE). */
const payloadPackageName = process.env.HELM_PAYLOAD_PACKAGE ?? '@team4u/helm-hub';

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

// --- Root dependency set: production dependencies of hub ∪ kernel ∪ plugins ∪ plugin-build ∪ env-io ∪ protocol; @helm/* installs from archives ------
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
  .filter((name) => !name.startsWith('@helm/'))
  .sort();
const rootDependencies = Object.fromEntries(
  externalDeps.map((name) => [name, resolveInstalledExactVersion(owningPkgDirOf(name), name)]),
);
// Peer dependencies of the runtime packages also join the root dependency set with exact pins:
// npm auto-installs peers for file: archives, and floating peer resolution would break the
// reproducible-install contract — pin everything to the repository's installed versions.
const externalPeers = [...new Set(RUNTIME_PKGS.flatMap((dir) => Object.keys(pkgJsonOf[dir].peerDependencies ?? {})))]
  .filter((name) => !name.startsWith('@helm/') && !(name in rootDependencies))
  .sort();
for (const name of externalPeers) {
  rootDependencies[name] = resolveInstalledExactVersion(owningPkgDirOf(name, 'peerDependencies'), name);
}
rootDependencies['@helm/protocol'] = 'file:./protocol.tgz';
rootDependencies['@helm/kernel'] = 'file:./kernel.tgz';
rootDependencies['@helm/plugins'] = 'file:./plugins.tgz';
rootDependencies['@helm/plugin-build'] = 'file:./plugin-build.tgz';
rootDependencies['@helm/env-io'] = 'file:./env-io.tgz';

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
  description: 'helm Hub runtime payload (hub + kernel + plugins + plugin-build + env-io + protocol + cli + web dist and a zero-dependency launch entry)',
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/team4u/helm.git', directory: 'packages/payload' },
  publishConfig: { access: 'public' },
  engines: { node: rootPkg.engines?.node ?? '>=24.12.0' },
  files: ['hub', 'kernel', 'kernel.tgz', 'plugins', 'plugins.tgz', 'plugin-build', 'plugin-build.tgz', 'env-io', 'env-io.tgz', 'protocol', 'protocol.tgz', 'cli', 'web', 'start.mjs', 'manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  dependencies: Object.fromEntries(Object.keys(rootDependencies).sort().map((k) => [k, rootDependencies[k]])),
  ...(peerOverrides.size > 0
    ? { overrides: Object.fromEntries([...peerOverrides.entries()].sort(([a], [b]) => a.localeCompare(b))) }
    : {}),
};

// --- Assembly (wipe and rebuild first; the output is re-entrant) --------------------------------------------------
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

for (const dir of ['hub', 'kernel', 'plugins', 'plugin-build', 'env-io', 'protocol', 'cli']) {
  cpSync(path.join(repoRoot, 'packages', dir, 'dist'), path.join(stagingDir, dir, 'dist'), { recursive: true });
  cpSync(path.join(repoRoot, 'packages', dir, 'package.json'), path.join(stagingDir, dir, 'package.json'));
}
cpSync(path.join(repoRoot, 'packages/web/dist'), path.join(stagingDir, 'web/dist'), { recursive: true });
cpSync(path.join(payloadPkgRoot, 'src/start.mjs'), path.join(stagingDir, 'start.mjs'));
cpSync(path.join(repoRoot, 'LICENSE'), path.join(stagingDir, 'LICENSE'));
cpSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), path.join(stagingDir, 'THIRD_PARTY_NOTICES.md'));
// Report the payload publish version at runtime so Hub / CLI don't keep reporting the old workspace
// version; also strip @helm/* workspace dependencies: the root package.json installs every @helm/*
// archive uniformly, and leftover workspace:* protocols inside sub-packages would make consumer-side
// npm install fail outright (npm doesn't support the workspace: protocol); at runtime Node's
// level-by-level upward resolution hits the same instances in the root node_modules.
for (const component of ['hub', 'kernel', 'plugins', 'plugin-build', 'env-io', 'protocol', 'cli']) {
  const manifestPath = path.join(stagingDir, component, 'package.json');
  const componentPackage = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deps = Object.fromEntries(
    Object.entries(componentPackage.dependencies ?? {}).filter(([name]) => !name.startsWith('@helm/')),
  );
  writeFileSync(manifestPath, `${JSON.stringify({ ...componentPackage, version: payloadPkg.version, ...(Object.keys(deps).length > 0 ? { dependencies: deps } : { dependencies: {} }) }, null, 2)}\n`);
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
  console.error(`[payload] built-in plugin prebuilt dist-client missing (rebuild @helm/plugins first):\n${missingPrebuilt.map((m) => `- ${m}`).join('\n')}`);
  process.exit(1);
}

// Directory-shaped file: dependencies produce junctions pointing into staging on Windows; archive installs are safe to move.
for (const dir of ['protocol', 'kernel', 'plugins', 'plugin-build', 'env-io']) {
  await createTar({ cwd: path.join(stagingDir, dir), file: path.join(stagingDir, `${dir}.tgz`), gzip: true, portable: true, prefix: 'package' }, ['package.json', 'dist']);
}
writeFileSync(path.join(stagingDir, 'package.json'), `${JSON.stringify(distPackageJson, null, 2)}\n`);

// --- Stale-layout guard: after the package split, kernel dist must never again carry product/plugin remnants -------------
// Why: tsc doesn't clean old output; if the kernel package was incrementally built over the old layout,
// copying the whole directory here would quietly ship stale product. Fail on detection — never publish
// with suspicious artifacts.
const staleArtifacts = [
  ['kernel/dist/main.js', 'kernel composition-root entry (moved to @helm/hub)'],
  ['kernel/dist/app.js', 'kernel composition root (moved to @helm/hub)'],
  ['kernel/dist/builtin-plugins', 'kernel built-in plugins (moved to @helm/plugins)'],
];
const stale = staleArtifacts.filter(([rel]) => existsSync(path.join(stagingDir, rel)));
if (stale.length > 0) {
  console.error(`[payload] stale artifacts detected in kernel dist (rebuild packages/kernel after a clean):\n${stale.map(([rel, why]) => `- ${rel}: ${why}`).join('\n')}`);
  process.exit(1);
}

// --- manifest (version / entry / checksum contract; paths relative to the payload root, POSIX separators) ----
const entries = {
  launcher: 'start.mjs',
  rootPackageJson: 'package.json',
  hub: 'hub/dist/main.js',
  hubPackageJson: 'hub/package.json',
  kernel: 'kernel/dist/index.js',
  kernelPackageJson: 'kernel/package.json',
  kernelArchive: 'kernel.tgz',
  plugins: 'plugins/dist/index.js',
  pluginsPackageJson: 'plugins/package.json',
  pluginsArchive: 'plugins.tgz',
  pluginBuild: 'plugin-build/dist/index.js',
  pluginBuildPackageJson: 'plugin-build/package.json',
  pluginBuildArchive: 'plugin-build.tgz',
  envIo: 'env-io/dist/index.js',
  envIoPackageJson: 'env-io/package.json',
  envIoArchive: 'env-io.tgz',
  protocol: 'protocol/dist/index.js',
  protocolArchive: 'protocol.tgz',
  protocolPackageJson: 'protocol/package.json',
  cli: 'cli/dist/index.js',
  cliPackageJson: 'cli/package.json',
  webIndex: 'web/dist/index.html',
};
const manifest = {
  formatVersion: 1,
  name: distPackageJson.name,
  version: distPackageJson.version,
  builtAt: new Date().toISOString(),
  nodeEngines: distPackageJson.engines.node,
  entries,
  entryChecksums: Object.fromEntries(
    Object.entries(entries).map(([key, rel]) => [key, sha256Of(path.join(stagingDir, rel))]),
  ),
};
writeFileSync(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const stats = walkStats(stagingDir);
console.log(`[payload] assembly complete: ${stagingDir}`);
console.log(`[payload] publish package name: ${distPackageJson.name}@${distPackageJson.version} (overridable via HELM_PAYLOAD_PACKAGE)`);
console.log(`[payload] root dependencies: ${Object.keys(rootDependencies).length} entries (${externalDeps.length} exact external pins + ${externalPeers.length} peers + @helm/* file:./<pkg>.tgz ×5)`);
console.log(`[payload] ${stats.files} files, ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB total`);
console.log(`[payload] runtime asset directories: ${copiedAssets.length}: ${copiedAssets.join(', ')}`);
console.log('[payload] note: node_modules is not bundled; consumers unpack the tgz files and run npm install --omit=dev --ignore-scripts to complete dependencies (verified by start.mjs check)');

// --- Stable launcher artifact (second publish entry): skipped with an explicit notice when the
// hub-launcher package is absent from the checkout; contract failures inside abort the build. ---
if (launcherSourcesPresent(repoRoot)) {
  await assembleLauncherArtifact({
    repoRoot,
    version: payloadPkg.version,
    enginesNode: distPackageJson.engines.node,
  });
} else {
  console.log('[payload] launcher package packages/hub-launcher not present: skipped assembling dist-launcher (no launcher npm publish will run in the release pipeline).');
}
