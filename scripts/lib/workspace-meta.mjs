/**
 * Workspace package diagram and change file → subject to affect test package keep guard mapping.
 *
 * principle: rather can many run cannot leak run. package inside non- test file change → the package + all (pass) dependency it package test
 * (based on each packages/<pkg>/package.json  dependencies/devDependencies in @helm/* workspace
 * edge do reverse closed package); pure test file change → only the package (other package code not change). lock file, tsconfig,
 * test basis set apply (run-tests / test-suites) change affect global → all Profile.
 *
 * PACKAGE_TIERS only used to render package belongs to which one Profile, and scripts/test-suites.mjs  SUITES mirror sync
 * (by packages/cli/test/check-changed.test.ts lock, change SUITES Profile must sync this in).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** level affect global trigger file (each other for repository precise path). */
export const FULL_TIER_TRIGGERS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.check.json',
  'scripts/run-tests.mjs',
  'scripts/test-suites.mjs',
]);
/** and scripts/test-suites.mjs  SUITES mirror: package directory → Profile (only used to report render). */
export const PACKAGE_TIERS = {
  protocol: 'unit',
  'env-io': 'unit',
  'test-kit': 'unit',
  cli: 'unit',
  web: 'unit',
  'plugin-client': 'unit',
  'plugin-build': 'integration',
  kernel: 'integration',
  plugins: 'integration',
  hub: 'integration',
  node: 'integration',
  payload: 'integration',
  desktop: 'integration',
};

export const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

/**
 * @typedef {{ name: string, dir: string, workspaceDeps: string[] }} WorkspacePackage
 */

/** read packages/ under all package and its @helm/* workspace dependency edge. */
export function loadWorkspacePackages(repoRoot) {
  const packagesDir = path.join(repoRoot, 'packages');
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pkgs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(path.join(packagesDir, e.name, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const deps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const workspaceDeps = [...deps].filter((d) => d.startsWith('@helm/'));
    pkgs.push({ name: pkg.name ?? e.name, dir: e.name, workspaceDeps });
  }
  pkgs.sort((a, b) => a.dir.localeCompare(b.dir));
  return pkgs;
}

/**
 * reverse closed package:seed package itself + all (pass) dependency seed package. dependency edge by package name parse to directory.
 * @param {string[]} seedDirs
 * @param {WorkspacePackage[]} pkgs
 * @returns {Set<string>} package directory set
 */
export function reverseClosure(seedDirs, pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p.dir]));
  // dependents: dir -> dependency it dir list (dependency direction pkg -> dep, reverse i.e. dep by who use).
  const dependents = new Map(pkgs.map((p) => [p.dir, []]));
  for (const p of pkgs) {
    for (const depName of p.workspaceDeps) {
      const depDir = byName.get(depName);
      if (depDir && depDir !== p.dir) dependents.get(depDir)?.push(p.dir);
    }
  }
  const affected = new Set();
  const queue = [...seedDirs];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (affected.has(cur)) continue;
    affected.add(cur);
    for (const d of dependents.get(cur) ?? []) {
      if (!affected.has(d)) queue.push(d);
    }
  }
  return affected;
}

/**
 * single file classify.
 * scripts/ under can execute source code (.mjs, contains lib/) directly construct into build/test/verify basis set apply,
 * change i.e. trigger all Profile (single change fast gate itself implement cannot without check via); pure document (.md etc.) does not trigger.
 * @param {string} file each other for repository path (correct slash)
 * @returns {{ pkg: string | null, kind: 'test' | 'source' | 'root-trigger' | 'outside' }}
 */
export function classifyChange(file) {
  if (FULL_TIER_TRIGGERS.has(file)) return { pkg: null, kind: 'root-trigger' };
  if (file.startsWith('scripts/') && file.endsWith('.mjs')) {
    return { pkg: null, kind: 'root-trigger' };
  }
  const m = /^packages\/([^/]+)\/(.*)$/.exec(file);
  if (!m) return { pkg: null, kind: 'outside' };
  const rest = m[2];
  const isTest = rest.startsWith('test/') && TEST_SUFFIXES.some((s) => rest.endsWith(s));
  return { pkg: m[1], kind: isTest ? 'test' : 'source' };
}

/**
 * compute subject to affect test package.
 * @param {string[]} files each other for repository change file list
 * @param {WorkspacePackage[]} pkgs
 * @returns {{ affected: Set<string>, fullTier: boolean, outside: string[] }}
 */
export function computeAffectedPackages(files, pkgs) {
  const allDirs = new Set(pkgs.map((p) => p.dir));
  let fullTier = false;
  const testOnly = new Set();
  const source = new Set();
  const outside = [];
  for (const f of files) {
    const c = classifyChange(f);
    if (c.kind === 'root-trigger') {
      fullTier = true;
    } else if (c.kind === 'outside') {
      outside.push(f);
    } else if (c.pkg && allDirs.has(c.pkg)) {
      if (c.kind === 'test') testOnly.add(c.pkg);
      else source.add(c.pkg);
    } else if (c.pkg) {
      // packages/ under not register directory: keep guard and source will in closed package in by allDirs filter,
      // this in by unknown package directly upgrade is all Profile, never static default discard.
      fullTier = true;
    }
  }
  if (fullTier) return { affected: new Set(allDirs), fullTier: true, outside: outside.sort() };
  const affected = reverseClosure([...source], pkgs);
  for (const p of testOnly) affected.add(p);
  return { affected, fullTier: false, outside: outside.sort() };
}

/** enumeration a certain package test/ directory under all test file (and test-suites.mjs identical enumeration rule). */
export function testFilesOfPackage(repoRoot, pkgDir) {
  const dir = path.join(repoRoot, 'packages', pkgDir, 'test');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && TEST_SUFFIXES.some((s) => e.name.endsWith(s)))
    .map((e) => `packages/${pkgDir}/test/${e.name}`)
    .sort();
}

/**
 * fast gate command plan (pure function, supply CLI execute and --list re-check shared use):
 *   0. has test file → node scripts/check-test-hygiene.mjs --files <files...>(static guard generate check, early at typecheck);
 *   1. any one subject to affect package → pnpm typecheck(will first build protocol/node/kernel/plugins/hub, is test type/run pre-);
 *   2. choose in desktop test → first pnpm --filter @helm/desktop run build(typecheck do not produce
 *      packages/desktop/dist/hub-child.js, cold worktree do not patch create then desktop test must failed, and change
 *      hub-child source code may test to old dist);
 *   3. has test file → node scripts/run-tests.mjs <files...>(re- use across platform timeout and process tree clean up).
 * @param {{ affectedDirs: string[], testFiles: string[], pm: { cmd: string, args: string[] }, execPath: string, repoRoot: string }} input
 * @returns {Array<{ cmd: string, args: string[], label: string }>}
 */
export function planCheckCommands({ affectedDirs, testFiles, pm, execPath, repoRoot }) {
  const commands = [];
  if (testFiles.length > 0) {
    commands.push({
      cmd: execPath,
      args: [path.join(repoRoot, 'scripts', 'check-test-hygiene.mjs'), '--files', ...testFiles],
      label: `check-hygiene(${testFiles.length} subject to affect test file)`,
    });
  }
  if (affectedDirs.length > 0) {
    commands.push({
      cmd: pm.cmd,
      args: [...pm.args, 'typecheck'],
      label: 'pnpm typecheck(contains protocol/node/kernel/plugins/hub build)',
    });
  }
  if (testFiles.some((f) => f.startsWith('packages/desktop/test/'))) {
    commands.push({
      cmd: pm.cmd,
      args: [...pm.args, '--filter', '@helm/desktop', 'run', 'build'],
      label: 'pnpm --filter @helm/desktop run build(desktop test pre-:typecheck do not produce dist)',
    });
  }
  if (testFiles.length > 0) {
    commands.push({
      cmd: execPath,
      args: [path.join(repoRoot, 'scripts', 'run-tests.mjs'), ...testFiles],
      label: `run-tests(${testFiles.length} test file)`,
    });
  }
  return commands;
}
