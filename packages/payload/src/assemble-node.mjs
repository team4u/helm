/**
 * Node daemon artifact assembly: produces `packages/payload/dist-node/` — the npm package a remote
 * machine installs with one `npm install -g @helmx/node` (bin `helmx-node`, single-sourced from
 * packages/node/package.json).
 *
 * Why a single-file bundle with four external dependencies (unlike the CLI artifact's zero-dependency
 * bundle): the node daemon's runtime closure spans @helmx/node + @helmx/env-io (update engine included)
 * + @helmx/protocol — all private workspace packages, inlined by esbuild — plus four packages that
 * cannot be inlined honestly: @earendil-works/chord, @earendil-works/pi-durable (process-wide SDKs
 * whose instances must be shared with any host embedding them) and birpc / ws (plain runtime
 * libraries kept external by the same closure contract the Hub payload pins). Those four land in
 * `dependencies` as the exact versions pnpm actually installed in this repository — never ^/~
 * floating ranges — because the daemon's dual-package self-upgrade binds @helmx/node +
 * @helmx/cli in lockstep against exact versions.
 *
 * Bundle input: packages/node/dist/cli.js (the full daemon CLI: connect / start / stop / restart /
 * status / upgrade / doctor / service). esbuild's metafile is the authority for two hard gates:
 * no external @helmx/* import may survive (the workspace packages are private and unpublished — a
 * leaked import would crash at global-install time), and every non-builtin external reference must
 * normalize to exactly the four-package whitelist (a fifth dependency means the closure drifted).
 *
 * Output layout (dist-node/ is the publish package root; release runs npm pack/publish inside):
 *   dist/cli.js            bundled daemon entry (shebang + single-file ESM; the bin target)
 *   package.json           publish manifest (name defaults to @helmx/node, overridable via
 *                          HELMX_NODE_PACKAGE; bin helmx-node → ./dist/cli.js; dependencies = the four
 *                          external exact-version pins)
 *   LICENSE, THIRD_PARTY_NOTICES.md
 */
import { build as esbuildBundle } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveDepRealDir, scanPeerOverrides } from './dep-closure.mjs';

const SHEBANG = '#!/usr/bin/env node';

/** Exactly the packages that stay external in the node daemon bundle (everything else is inlined). */
const EXTERNAL_DEPS = ['@earendil-works/chord', '@earendil-works/pi-durable', 'birpc', 'ws'];

/** Publish node package name (overridable via HELMX_NODE_PACKAGE, mirroring HELMX_CLI_PACKAGE). */
export const nodePackageName = process.env.HELMX_NODE_PACKAGE ?? '@helmx/node';

/** Normalizes an import specifier to its package name ('@scope/pkg/sub' → '@scope/pkg', 'ws/x' → 'ws'). */
function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * Assembles the node daemon publish package. Exits the process with a diagnostics list when any
 * artifact-side contract is broken (missing build inputs, a wrong bin shape in the workspace package,
 * dependency resolution failure, or a bundle that leaks external imports outside the four-package
 * whitelist). Invoked by build.mjs after the CLI artifact assembly; publish order stays
 * payload → cli → node (see docs/releasing.md).
 */
export async function assembleNodeArtifact({ repoRoot, version, enginesNode }) {
  const nodePkgDir = path.join(repoRoot, 'packages/node');
  const stagingDir = path.join(repoRoot, 'packages/payload/dist-node');

  const inputs = [
    ['node dist entry', path.join(nodePkgDir, 'dist/cli.js')],
    ['node package.json', path.join(nodePkgDir, 'package.json')],
  ];
  const missing = inputs.filter(([, p]) => !existsSync(p)).map(([label, p]) => `- ${label}: ${p}`);
  if (missing.length > 0) {
    console.error(`[payload] node build artifacts missing, refusing to assemble (run pnpm build at the repository root first, then retry):\n${missing.join('\n')}`);
    process.exit(1);
  }

  // The bin name and target stay single-sourced from the node workspace package (exactly one bin
  // entry: helmx-node → ./dist/cli.js — the release gate re-checks this on the assembled manifest).
  const nodePkg = JSON.parse(readFileSync(path.join(nodePkgDir, 'package.json'), 'utf-8'));
  const binEntries = Object.entries(nodePkg.bin ?? {});
  if (binEntries.length !== 1 || binEntries[0][0] !== 'helmx-node' || binEntries[0][1] !== './dist/cli.js') {
    console.error(`[payload] expected exactly one bin entry { "helmx-node": "./dist/cli.js" } in @helmx/node package.json, found: ${JSON.stringify(nodePkg.bin)}`);
    process.exit(1);
  }

  // External exact-version pins resolve from the repository's actual pnpm install (the real package
  // the node_modules symlink points at) — never carry ^/~ floating ranges into the publish contract.
  const dependencies = {};
  for (const name of EXTERNAL_DEPS) {
    const resolved = resolveDepRealDir(nodePkgDir, name, false);
    if (resolved.error) {
      console.error(`[payload] node external dependency ${name} not installed or unresolvable (${path.relative(repoRoot, nodePkgDir)}/node_modules/${name}): ${resolved.error}. Run pnpm install at the repository root first.`);
      process.exit(1);
    }
    if (typeof resolved.pkgJson.version !== 'string' || resolved.pkgJson.version.length === 0) {
      console.error(`[payload] package.json of node external dependency ${name} is missing a version`);
      process.exit(1);
    }
    dependencies[name] = resolved.pkgJson.version;
  }

  // npm resolves peers strictly (ERESOLVE) while the repository's pnpm install allows wider peer
  // ranges. Overrides cannot help here: npm only honors `overrides` in the install root's manifest,
  // never in a package being installed (`npm i -g @helmx/node` ships overrides that do nothing —
  // proven by 0.1.1 warning despite carrying them). The only real fix is exact-version alignment
  // with the peers of the four externals (repo pins ws at chord's peerOptional version), so make
  // any residual conflict a hard build failure instead of shipping an inert field.
  const peerOverrides = scanPeerOverrides(EXTERNAL_DEPS.map((name) => ({ name, version: dependencies[name], fromPkgDir: nodePkgDir })));
  if (peerOverrides.size > 0) {
    const conflicts = [...peerOverrides.entries()].map(([name, version]) => `${name}@${version}`).sort().join(', ');
    console.error(
      `[payload] node external dependency peers conflict with the exact pins (${conflicts}): npm ignores overrides of a globally installed package,` +
        ' so realign the repository pins with the peers of the four externals (e.g. ws must equal chord peerOptional pin) before publishing',
    );
    process.exit(1);
  }

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(path.join(stagingDir, 'dist'), { recursive: true });

  // Node builtins stay external automatically for platform=node; the four whitelist packages stay
  // external in root and subpath form (chord/context, pi-durable/env/...); everything else
  // (node + env-io incl. the update engine + protocol + typebox) is inlined with legal comments
  // preserved.
  const bundleResult = await esbuildBundle({
    entryPoints: [path.join(nodePkgDir, 'dist/cli.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile: path.join(stagingDir, 'dist/cli.js'),
    external: EXTERNAL_DEPS.flatMap((name) => [name, `${name}/*`]),
    legalComments: 'inline',
    logLevel: 'warning',
    metafile: true,
  });

  // esbuild drops the entry shebang when bundling: restore it so the file works as a bin target.
  const bundleFile = path.join(stagingDir, 'dist/cli.js');
  let bundle = readFileSync(bundleFile, 'utf-8');
  if (!bundle.startsWith(SHEBANG)) bundle = `${SHEBANG}\n${bundle}`;

  // Metafile hard gates (the authority — same rationale as the CLI artifact: regex-scanning bundle
  // text would false-positive on string-literal sample code): ① no external @helmx/* import survives
  // (workspace packages are private; a leaked one breaks every global install); ② every non-builtin
  // external import normalizes into the four-package whitelist — a fifth external means the closure
  // drifted and the manifest would under-declare runtime dependencies; ③ none of the four whitelist
  // packages may appear as a bundled input (an external misconfiguration would silently inline them
  // and the exact-version dependency pins would stop describing reality).
  const unresolvedHelmx = new Set();
  const externalSeen = new Set();
  for (const output of Object.values(bundleResult.metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.external !== true) continue;
      const pkgName = packageNameOf(imported.path);
      if (pkgName.startsWith('@helmx/')) unresolvedHelmx.add(imported.path);
      else if (!imported.path.startsWith('node:')) externalSeen.add(pkgName);
    }
  }
  const outsideWhitelist = [...externalSeen].filter((name) => !EXTERNAL_DEPS.includes(name));
  if (unresolvedHelmx.size > 0 || outsideWhitelist.length > 0) {
    const lines = [];
    if (unresolvedHelmx.size > 0) lines.push(`- external @helmx/* imports still referenced: ${[...unresolvedHelmx].sort().join(', ')}`);
    if (outsideWhitelist.length > 0) lines.push(`- external imports outside the four-package whitelist: ${outsideWhitelist.sort().join(', ')}`);
    console.error(`[payload] node bundle violates the external-dependency contract:\n${lines.join('\n')}`);
    process.exit(1);
  }
  const inlinedExternal = new Set();
  for (const input of Object.keys(bundleResult.metafile.inputs)) {
    const rel = path.relative(repoRoot, path.resolve(process.cwd(), input)).replace(/\\/g, '/');
    const idx = rel.lastIndexOf('node_modules/');
    if (idx === -1) continue;
    const rest = rel.slice(idx + 'node_modules/'.length).split('/');
    const pkgName = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    if (EXTERNAL_DEPS.includes(pkgName)) inlinedExternal.add(pkgName);
  }
  if (inlinedExternal.size > 0) {
    console.error(`[payload] node bundle inlined packages that must stay external: ${[...inlinedExternal].sort().join(', ')} (check the esbuild external configuration)`);
    process.exit(1);
  }
  writeFileSync(bundleFile, bundle);
  chmodSync(bundleFile, 0o755);

  const distPackageJson = {
    name: nodePackageName,
    version,
    type: 'module',
    description: 'helmx node daemon: remote node runtime for the Helmx Hub (bash/read/write/edit/gate/env exec over the reverse control gateway)',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/team4u/helmx.git', directory: 'packages/payload' },
    publishConfig: { access: 'public' },
    engines: { node: enginesNode },
    bin: { 'helmx-node': './dist/cli.js' },
    files: ['dist/cli.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
    dependencies,
  };
  writeFileSync(path.join(stagingDir, 'package.json'), `${JSON.stringify(distPackageJson, null, 2)}\n`);
  cpSync(path.join(repoRoot, 'LICENSE'), path.join(stagingDir, 'LICENSE'));
  cpSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), path.join(stagingDir, 'THIRD_PARTY_NOTICES.md'));

  // Bundled input summary from the metafile at package-root granularity (same normalization as the
  // CLI artifact log): states exactly what the daemon bundle inlined.
  const bundledPkgs = new Set();
  for (const input of Object.keys(bundleResult.metafile.inputs)) {
    const rel = path.relative(repoRoot, path.resolve(process.cwd(), input)).replace(/\\/g, '/');
    if (rel.startsWith('../')) continue;
    if (/^packages\/[^/]+\//.test(rel)) {
      bundledPkgs.add(`@helmx/${/^packages\/([^/]+)\//.exec(rel)[1]}`);
      continue;
    }
    const idx = rel.lastIndexOf('node_modules/');
    if (idx !== -1) {
      const rest = rel.slice(idx + 'node_modules/'.length).split('/');
      if (rest[0].startsWith('@')) bundledPkgs.add(`${rest[0]}/${rest[1]}`);
      else bundledPkgs.add(rest[0]);
    }
  }
  const bundleBytes = Object.values(bundleResult.metafile.outputs).reduce((sum, out) => sum + out.bytes, 0);
  console.log(`[payload] node artifact assembled: ${stagingDir}`);
  console.log(`[payload] node publish package: ${nodePackageName}@${version} (bin: helmx-node; overridable via HELMX_NODE_PACKAGE)`);
  console.log(`[payload] node bundle: 1 file, ${(bundleBytes / 1024).toFixed(1)} KiB; bundled inputs: ${[...bundledPkgs].sort().join(', ')}`);
  console.log(`[payload] node contract: external dependencies = ${EXTERNAL_DEPS.join(', ')} at exact installed versions; publish from dist-node via npm pack / npm publish (after cli)`);

  return { bundleFile };
}
