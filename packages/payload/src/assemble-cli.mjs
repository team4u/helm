/**
 * Stable CLI artifact assembly: produces `packages/payload/dist-cli/` — a standalone,
 * zero-dependency npm package that installs the complete `helmx` CLI globally via one
 * `npm install -g` (bin `helmx`, single-sourced from packages/cli/package.json).
 *
 * Why a single-file bundle instead of the Hub payload's `file:./<pkg>.tgz` dependency pattern:
 * a globally installed CLI must work in one step, with no consumer-side dependency completion and
 * no dependency on unpublished private workspace packages. The bundle input is
 * packages/cli/dist/index.js — the full control CLI: the core static command table, dynamic
 * plugin-action commands over the Hub HTTP API, and the local Hub lifecycle surface
 * (`helmx update ...`) implemented on the bundled-in launcher's typed API (packages/cli/src/
 * launcher, same-package relative imports; it publishes no bin of its own). esbuild inlines
 * the whole closure (@helmx/cli → its launcher subtree → @helmx/env-io (update engine included) /
 * @helmx/protocol → typebox, plus tar for payload staging), all pure JavaScript — so the Hub
 * payload's root dependency set needs no additions for this CLI to run.
 *
 * One deliberate runtime-resolved capability: `helmx plugins build` loads the plugin client
 * compiler (@helmx/plugin-build) through a computed dynamic import (a specifier esbuild cannot
 * statically follow — and must not: inlining it would fake availability while its platform-native
 * esbuild binary only exists where an npm install actually ran). Node resolves it from the
 * running location: inside the Hub payload the sibling node_modules carries @helmx/plugin-build
 * (installed from the payload root dependency set); the global artifact relies on a Helmx-managed
 * local payload release providing the compiler in its release directory and reports
 * `plugin_build_unavailable` honestly otherwise.
 *
 * Output layout (dist-cli/ is the publish package root; release runs npm pack/publish inside):
 *   package.json           publish manifest (name defaults to @helmx/cli, overridable via
 *                          HELMX_CLI_PACKAGE; dependencies are empty by contract; bin helmx)
 *   index.js               bundled CLI entry (shebang + single-file ESM; the bin target and the
 *                          exact file the Hub payload ships as cli/dist/index.js)
 *   LICENSE, THIRD_PARTY_NOTICES.md
 */
import { build as esbuildBundle } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SHEBANG = '#!/usr/bin/env node';

/** Publish CLI package name (overridable via HELMX_CLI_PACKAGE, mirroring HELMX_PAYLOAD_PACKAGE). */
export const cliPackageName = process.env.HELMX_CLI_PACKAGE ?? '@helmx/cli';

/**
 * Assembles the CLI publish package. Exits the process with a diagnostics list when any
 * artifact-side contract is broken (missing build inputs, multiple bin entries, or a bundle that
 * still references unpackaged @helmx/* imports). Returns the bundle file path so the Hub payload
 * assembly can ship the exact same bytes as cli/dist/index.js.
 */
export async function assembleCliArtifact({ repoRoot, version, enginesNode }) {
  const cliPkgDir = path.join(repoRoot, 'packages/cli');
  const stagingDir = path.join(repoRoot, 'packages/payload/dist-cli');

  const inputs = [
    ['cli dist entry', path.join(cliPkgDir, 'dist/index.js')],
    ['cli package.json', path.join(cliPkgDir, 'package.json')],
    ['env-io dist', path.join(repoRoot, 'packages/env-io/dist/index.js')],
    ['protocol dist', path.join(repoRoot, 'packages/protocol/dist/index.js')],
  ];
  const missing = inputs.filter(([, p]) => !existsSync(p)).map(([label, p]) => `- ${label}: ${p}`);
  if (missing.length > 0) {
    console.error(`[payload] cli build artifacts missing, refusing to assemble (run pnpm build at the repository root first, then retry):\n${missing.join('\n')}`);
    process.exit(1);
  }

  // The bin name stays single-sourced from the CLI package (exactly one bin entry: `helmx`).
  const cliPkg = JSON.parse(readFileSync(path.join(cliPkgDir, 'package.json'), 'utf-8'));
  const binNames = Object.keys(cliPkg.bin ?? {});
  if (binNames.length !== 1) {
    console.error(`[payload] expected exactly one bin entry in @helmx/cli package.json, found: ${JSON.stringify(binNames)}`);
    process.exit(1);
  }
  const binName = binNames[0];

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // Node builtins stay external automatically for platform=node; everything else (cli + its
  // launcher subtree + env-io incl. the update engine + protocol + typebox + tar) is inlined with legal comments preserved. The
  // plugins-build compiler is intentionally NOT part of this graph (computed dynamic import, see
  // header) — it resolves at runtime from the Hub payload's / local release's node_modules.
  const bundleResult = await esbuildBundle({
    entryPoints: [path.join(cliPkgDir, 'dist/index.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile: path.join(stagingDir, 'index.js'),
    legalComments: 'inline',
    logLevel: 'warning',
    metafile: true,
  });

  // esbuild drops the entry shebang when bundling: restore it so the file works as a bin target.
  const bundleFile = path.join(stagingDir, 'index.js');
  let bundle = readFileSync(bundleFile, 'utf-8');
  if (!bundle.startsWith(SHEBANG)) bundle = `${SHEBANG}\n${bundle}`;

  // Zero-dependency contract, checked mechanically on esbuild's own metafile: every external
  // module reference the bundle declares is listed there (node builtins included). An external
  // @helmx/* import means the closure did not resolve and `npm install -g` would break for every
  // consumer (no @helmx/* workspace package is published from this repository; workspace:/file:
  // specifiers would fail outright). The metafile is the authority — regex-scanning the bundle
  // text would false-positive on scaffold-template sample code embedded in string literals, and
  // would miss nothing the metafile catches: the plugins-build computed dynamic import is
  // intentionally outside esbuild's static reach (see header) and resolves at runtime.
  const unresolved = new Set();
  for (const output of Object.values(bundleResult.metafile.outputs)) {
    for (const imported of output.imports ?? []) {
      if (imported.external === true && imported.path.startsWith('@helmx/')) unresolved.add(imported.path);
    }
  }
  if (unresolved.size > 0) {
    console.error(`[payload] cli bundle still references unpackaged workspace imports: ${[...unresolved].sort().join(', ')}`);
    process.exit(1);
  }
  writeFileSync(bundleFile, bundle);
  chmodSync(bundleFile, 0o755);

  const distPackageJson = {
    name: cliPackageName,
    version,
    type: 'module',
    description: 'helmx control CLI: full command surface over the Hub HTTP API plus local Hub payload lifecycle management (update / watch / status / stop)',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/team4u/helm.git', directory: 'packages/payload' },
    publishConfig: { access: 'public' },
    engines: { node: enginesNode },
    bin: { [binName]: './index.js' },
    files: ['index.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  };
  writeFileSync(path.join(stagingDir, 'package.json'), `${JSON.stringify(distPackageJson, null, 2)}\n`);
  cpSync(path.join(repoRoot, 'LICENSE'), path.join(stagingDir, 'LICENSE'));
  cpSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), path.join(stagingDir, 'THIRD_PARTY_NOTICES.md'));

  // Bundled input summary from the metafile: package-root granularity (workspace packages and
  // node_modules packages), so the assembly log states exactly what the bundle inlined. Input paths
  // are relative to the build's cwd: normalize against the repository root first (pnpm --filter and
  // direct invocation produce different prefixes), then take the last node_modules segment for pnpm's
  // nested node_modules/.pnpm/.../node_modules/<pkg> layout.
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
  console.log(`[payload] cli artifact assembled: ${stagingDir}`);
  console.log(`[payload] cli publish package: ${cliPackageName}@${version} (bin: ${binName}; overridable via HELMX_CLI_PACKAGE)`);
  console.log(`[payload] cli bundle: 1 file, ${(bundleBytes / 1024).toFixed(1)} KiB; bundled inputs: ${[...bundledPkgs].sort().join(', ')}`);
  console.log('[payload] cli contract: zero runtime dependencies (single-file bundle); publish from dist-cli via npm pack / npm publish');

  return { bundleFile };
}
