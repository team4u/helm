/**
 * Stable launcher artifact assembly: produces `packages/payload/dist-launcher/` — a standalone,
 * zero-dependency npm package that installs the `helm-hub-launcher` CLI globally via one
 * `npm install -g`.
 *
 * Why a single-file bundle instead of the Hub payload's `file:./<pkg>.tgz` dependency pattern:
 * a globally installed CLI must work in one step, with no consumer-side dependency completion and
 * no dependency on unpublished private workspace packages. The launcher's closure
 * (@helm/update → @helm/env-io / @helm/protocol → typebox) is pure JavaScript without
 * platform-native code or dynamic imports, so an esbuild bundle is exact and reproducible per tag.
 * The Hub payload artifact (`dist/`) keeps its manifest/file:tgz contract untouched; this artifact
 * only shares the version source (packages/payload/package.json, lockstep with the release tag).
 *
 * Output layout (dist-launcher/ is the publish package root; release runs npm pack/publish inside):
 *   package.json           publish manifest (name defaults to @team4u/helm-hub-launcher, overridable
 *                          via HELM_LAUNCHER_PACKAGE; dependencies are empty by contract)
 *   main.js                bundled CLI entry (shebang + single-file ESM; the bin target)
 *   LICENSE, THIRD_PARTY_NOTICES.md
 */
import { build as esbuildBundle } from 'esbuild';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SHEBANG = '#!/usr/bin/env node';

/** Publish launcher package name (overridable via HELM_LAUNCHER_PACKAGE, mirroring HELM_PAYLOAD_PACKAGE). */
export const launcherPackageName = process.env.HELM_LAUNCHER_PACKAGE ?? '@team4u/helm-hub-launcher';

/** Whether the launcher workspace package exists in this checkout (absence → explicit skip, never a failure). */
export function launcherSourcesPresent(repoRoot) {
  return existsSync(path.join(repoRoot, 'packages/hub-launcher/package.json'));
}

/**
 * Assembles the launcher publish package. Exits the process with a diagnostics list when any
 * launcher-side contract is broken (missing build inputs, multiple bin entries, or a bundle that
 * still references unpackaged @helm/* imports).
 */
export async function assembleLauncherArtifact({ repoRoot, version, enginesNode }) {
  const launcherPkgDir = path.join(repoRoot, 'packages/hub-launcher');
  const stagingDir = path.join(repoRoot, 'packages/payload/dist-launcher');

  const inputs = [
    ['launcher dist entry', path.join(launcherPkgDir, 'dist/main.js')],
    ['launcher package.json', path.join(launcherPkgDir, 'package.json')],
    ['update engine dist', path.join(repoRoot, 'packages/update/dist/index.js')],
    ['env-io dist', path.join(repoRoot, 'packages/env-io/dist/index.js')],
    ['protocol dist', path.join(repoRoot, 'packages/protocol/dist/index.js')],
  ];
  const missing = inputs.filter(([, p]) => !existsSync(p)).map(([label, p]) => `- ${label}: ${p}`);
  if (missing.length > 0) {
    console.error(`[payload] launcher build artifacts missing, refusing to assemble (run pnpm build at the repository root first, then retry):\n${missing.join('\n')}`);
    process.exit(1);
  }

  // The bin name stays single-sourced from the launcher package (exactly one bin entry).
  const launcherPkg = JSON.parse(readFileSync(path.join(launcherPkgDir, 'package.json'), 'utf-8'));
  const binNames = Object.keys(launcherPkg.bin ?? {});
  if (binNames.length !== 1) {
    console.error(`[payload] expected exactly one bin entry in @helm/hub-launcher package.json, found: ${JSON.stringify(binNames)}`);
    process.exit(1);
  }
  const binName = binNames[0];

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  // Node builtins stay external automatically for platform=node; everything else (launcher + update
  // + env-io + protocol + typebox) is inlined with legal comments preserved.
  const bundleResult = await esbuildBundle({
    entryPoints: [path.join(launcherPkgDir, 'dist/main.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    outfile: path.join(stagingDir, 'main.js'),
    legalComments: 'inline',
    logLevel: 'warning',
    metafile: true,
  });

  // esbuild drops the entry shebang when bundling: restore it so the file works as a bin target.
  let bundle = readFileSync(path.join(stagingDir, 'main.js'), 'utf-8');
  if (!bundle.startsWith(SHEBANG)) bundle = `${SHEBANG}\n${bundle}`;

  // Zero-dependency contract, checked mechanically: an unresolved @helm/* import would break
  // `npm install -g` for every consumer (no @helm/* workspace package is published from this
  // repository; workspace:/file: specifiers would fail outright).
  const unresolved = new Set();
  for (const match of bundle.matchAll(/from\s+['"](@helm\/[^'"]+)['"]/g)) unresolved.add(match[1]);
  for (const match of bundle.matchAll(/import\(\s*['"](@helm\/[^'"]+)['"]\s*\)/g)) unresolved.add(match[1]);
  for (const match of bundle.matchAll(/require\(\s*['"](@helm\/[^'"]+)['"]\s*\)/g)) unresolved.add(match[1]);
  if (unresolved.size > 0) {
    console.error(`[payload] launcher bundle still references unpackaged workspace imports: ${[...unresolved].sort().join(', ')}`);
    process.exit(1);
  }
  writeFileSync(path.join(stagingDir, 'main.js'), bundle);
  chmodSync(path.join(stagingDir, 'main.js'), 0o755);

  const distPackageJson = {
    name: launcherPackageName,
    version,
    type: 'module',
    description: 'helm local Hub launcher/updater: stable external install managing helm Hub payload releases (check / update / start / stop / status)',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/team4u/helm.git', directory: 'packages/payload' },
    publishConfig: { access: 'public' },
    engines: { node: enginesNode },
    bin: { [binName]: './main.js' },
    files: ['main.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
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
      bundledPkgs.add(`@helm/${/^packages\/([^/]+)\//.exec(rel)[1]}`);
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
  console.log(`[payload] launcher artifact assembled: ${stagingDir}`);
  console.log(`[payload] launcher publish package: ${launcherPackageName}@${version} (bin: ${binName}; overridable via HELM_LAUNCHER_PACKAGE)`);
  console.log(`[payload] launcher bundle: 1 file, ${(bundleBytes / 1024).toFixed(1)} KiB; bundled inputs: ${[...bundledPkgs].sort().join(', ')}`);
  console.log('[payload] launcher contract: zero runtime dependencies (single-file bundle); publish from dist-launcher via npm pack / npm publish');
}
