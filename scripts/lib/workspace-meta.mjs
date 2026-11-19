/**
 * Workspace package graph and the conservative "changed file -> affected test packages"
 * mapping.
 *
 * Principle: better to over-run than to miss. A non-test change inside a package -> that
 * package + the tests of every (transitively) depending package (reverse closure over the
 * @helm/* workspace edges in each packages/<pkg>/package.json's
 * dependencies/devDependencies); a test-only change -> that package alone (no other
 * package's code changed). Lockfile, root tsconfig, or test infrastructure (run-tests /
 * test-suites) changes affect everything -> all tiers.
 *
 * PACKAGE_TIERS is display-only (which tier a package belongs to) and mirrors the SUITES in
 * scripts/test-suites.mjs (locked by packages/cli/test/check-changed.test.ts; changing
 * SUITES tiers must update this too).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Root-level "affects everything" trigger files (exact paths relative to the repo root). */
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
/**
 * Mirror of scripts/test-suites.mjs SUITES: package dir (or packages/-relative tier-override
 * path such as 'cli/test/launcher') -> tier (display-only; locked by
 * packages/cli/test/check-changed.test.ts; changing SUITES tiers must update this too).
 */
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
  'hub-launcher': 'integration',
  node: 'integration',
  update: 'integration',
  payload: 'integration',
};

export const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

/**
 * @typedef {{ name: string, dir: string, workspaceDeps: string[] }} WorkspacePackage
 */

/** Read every package under packages/ and its @helm/* workspace dependency edges. */
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
 * Reverse closure: the seed package itself + every package that (transitively) depends on
 * the seed. Dependency edges resolve package names to directories.
 * @param {string[]} seedDirs
 * @param {WorkspacePackage[]} pkgs
 * @returns {Set<string>} set of package directories
 */
export function reverseClosure(seedDirs, pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p.dir]));
  // dependents: dir -> list of dirs depending on it (edges point pkg -> dep, so reversing
  // answers who uses dep).
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
 * Classify a single file.
 * Executable sources under scripts/ (.mjs, lib/ included) are build/test/verification
 * infrastructure themselves: any change triggers all tiers (a change to the fast gate's own
 * implementation must not "pass with no checks"); pure docs (.md etc.) trigger nothing.
 * @param {string} file repo-root-relative path (forward slashes)
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
 * Compute the affected test packages.
 * @param {string[]} files repo-root-relative changed file list
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
      // An unregistered directory under packages/: conservatively folding it into source
      // would get filtered out by allDirs in the closure; escalate straight to all tiers as
      // an unknown package — never silently drop it.
      fullTier = true;
    }
  }
  if (fullTier) return { affected: new Set(allDirs), fullTier: true, outside: outside.sort() };
  const affected = reverseClosure([...source], pkgs);
  for (const p of testOnly) affected.add(p);
  return { affected, fullTier: false, outside: outside.sort() };
}

/**
 * Enumerate every test file under a package's test/ directory, subdirectories included (same
 * enumeration scope as test-suites.mjs's recursive coverage invariant): subdirectory suites
 * such as cli/test/launcher belong to that package for change-driven selection even though
 * their tier differs from the package's top-level tests.
 */
export function testFilesOfPackage(repoRoot, pkgDir) {
  const files = [];
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile() && TEST_SUFFIXES.some((s) => e.name.endsWith(s))) {
        files.push(`${prefix}/${e.name}`);
      } else if (e.isDirectory()) {
        walk(path.join(dir, e.name), `${prefix}/${e.name}`);
      }
    }
  };
  walk(path.join(repoRoot, 'packages', pkgDir, 'test'), `packages/${pkgDir}/test`);
  return files.sort();
}

/**
 * Fast-gate command plan (a pure function shared by CLI execution and --list review):
 *   0. any test files -> node scripts/check-test-hygiene.mjs --files <files...> (static
 *      hygiene check, before typecheck);
 *   1. any affected package -> pnpm typecheck (builds protocol/node/kernel/plugins/hub
 *      first; a type/runtime prerequisite of the tests);
 *   2. any test files -> node scripts/run-tests.mjs <files...> (reusing the cross-platform
 *      timeouts and process-tree cleanup).
 * @param {{ affectedDirs: string[], testFiles: string[], pm: { cmd: string, args: string[] }, execPath: string, repoRoot: string }} input
 * @returns {Array<{ cmd: string, args: string[], label: string }>}
 */
export function planCheckCommands({ affectedDirs, testFiles, pm, execPath, repoRoot }) {
  const commands = [];
  if (testFiles.length > 0) {
    commands.push({
      cmd: execPath,
      args: [path.join(repoRoot, 'scripts', 'check-test-hygiene.mjs'), '--files', ...testFiles],
      label: `check-hygiene (${testFiles.length} affected test file(s))`,
    });
  }
  if (affectedDirs.length > 0) {
    commands.push({
      cmd: pm.cmd,
      args: [...pm.args, 'typecheck'],
      label: 'pnpm typecheck (includes protocol/node/kernel/plugins/hub build)',
    });
  }
  if (testFiles.length > 0) {
    commands.push({
      cmd: execPath,
      args: [path.join(repoRoot, 'scripts', 'run-tests.mjs'), ...testFiles],
      label: `run-tests (${testFiles.length} test file(s))`,
    });
  }
  return commands;
}
