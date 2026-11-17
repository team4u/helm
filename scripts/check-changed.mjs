#!/usr/bin/env node
/**
 * pnpm check:changed — change-driven fast feedback gate (a supplement to, never a replacement
 * for, the AGENTS §5 tiered mandatory runs and the pre-merge test:all).
 *
 * Mechanism (conservative and reliable — no cache, no smart-association guessing):
 *   1. Change set = merge-base(base, HEAD)..HEAD commit diff ∪ working tree (staged +
 *      unstaged) ∪ untracked files, parsed via git -z (space-containing paths, both sides
 *      of renames, and deletions are all included faithfully);
 *      baseline priority is --base <ref> > branch upstream > origin/HEAD; when none exists,
 *      error out demanding --base — never silently degrade to HEAD~1 (it misses commits).
 *   2. Affected packages = changed files mapped through packages/<dir>; a non-test change
 *      inside a package -> that package + every package transitively depending on it
 *      (reverse closure of the workspace dependency graph); test-only changes -> that
 *      package alone; lockfile / root config / test infrastructure (including every .mjs
 *      source under scripts/) changes -> all tiers.
 *   3. Command planning lives in lib/workspace-meta.mjs planCheckCommands: pnpm typecheck
 *      (including protocol/node build) -> affected package tests (explicit file list
 *      handed to scripts/run-tests.mjs to reuse its timeouts and process-tree cleanup).
 *
 * Usage (pnpm needs the -- separator; this script accepts a leading literal -- that pnpm
 * passes through verbatim):
 *   pnpm check:changed --                      # auto baseline (upstream / origin/HEAD)
 *   pnpm check:changed -- --base main          # explicit baseline (recommended on worktree branches without upstream)
 *   pnpm check:changed -- --list               # only print included files / affected packages / commands to run, execute nothing (--dry-run is a synonym)
 *
 * Exit codes: 0 pass (or nothing to run); command failures pass through as-is;
 * usage/baseline errors 2.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChangedFiles, GitChangeError, commitsAhead, shortRev } from './lib/git-changes.mjs';
import {
  computeAffectedPackages,
  loadWorkspacePackages,
  PACKAGE_TIERS,
  planCheckCommands,
  testFilesOfPackage,
} from './lib/workspace-meta.mjs';
import { resolvePackageManagerInvoke, runSequentially } from './lib/spawn-checked.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(`Usage: pnpm check:changed -- [--base <ref>] [--list|--dry-run]
  --base <ref>    explicit baseline (commit/branch/tag); its merge-base with HEAD is used
  --list          only print the selection (included files / affected packages / commands to run); execute nothing
  --dry-run       synonym for --list
Note: when invoked through pnpm, arguments must be separated with -- (e.g. pnpm check:changed -- --base main --list);
      a leading literal -- is ignored by this script; a direct node scripts/check-changed.mjs call needs no --.`);
}

function parseArgs(argv) {
  const opts = { base: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // The leading -- separator passed through by pnpm: only skipped in the first position;
    // a -- anywhere else is reported as an unknown argument.
    if (a === '--' && i === 0) continue;
    if (a === '--base' && argv[i + 1]) {
      opts.base = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--base=')) {
      opts.base = a.slice('--base='.length);
    } else if (a === '--list' || a === '--dry-run') {
      opts.list = true;
    } else {
      console.error(`[check-changed] unknown argument: ${a}`);
      usage();
      process.exit(2);
    }
  }
  return opts;
}

const args = parseArgs(process.argv.slice(2));

let changes;
try {
  changes = collectChangedFiles({ base: args.base, cwd: repoRoot });
} catch (err) {
  if (err instanceof GitChangeError) {
    console.error(`[check-changed] ${err.message}`);
    process.exit(2);
  }
  throw err;
}

const pkgs = loadWorkspacePackages(repoRoot);
const { affected, fullTier, outside } = computeAffectedPackages(
  changes.files.map((f) => f.path),
  pkgs,
);
const affectedDirs = [...affected].sort();
const testFiles = affectedDirs.flatMap((p) => testFilesOfPackage(repoRoot, p));

// ---- Reporting (--list and real runs share the same selection description for review) ----
const kindLabel = { explicit: 'explicit --base', upstream: 'branch upstream', 'origin-head': 'origin/HEAD' };
const ahead = commitsAhead(repoRoot, changes.baseline.mergeBase);
console.error(
  // Keep the baseline label stable for CLI diagnostics.
  `[check-changed] baseline: ${kindLabel[changes.baseline.kind]} ${changes.baseline.ref}` +
    ` (merge-base ${shortRev(repoRoot, changes.baseline.mergeBase)}, HEAD is ${ahead} commits ahead)`,
);
console.error(
  `[check-changed] changed files: ${changes.files.length}` +
    ` (committed ${changes.files.filter((f) => f.origin.includes('committed')).length}` +
    ` / worktree ${changes.files.filter((f) => f.origin.includes('worktree')).length}` +
    ` / untracked ${changes.files.filter((f) => f.origin === 'untracked').length}):`,
);
for (const f of changes.files.slice(0, 60)) {
  console.error(`  ${f.status.padEnd(5)} ${f.path}  (${f.origin})`);
}
if (changes.files.length > 60) console.error(`  ... (${changes.files.length - 60} more omitted)`);
if (outside.length > 0) {
  console.error(`[check-changed] non-package changes: ${outside.length} (docs etc.; no test selection triggered)`);
}

const tierOf = (dir) => PACKAGE_TIERS[dir] ?? 'un-tiered';
console.error(
  `[check-changed] affected packages${fullTier ? ' (root-level trigger -> all tiers)' : ''}: ` +
    (affectedDirs.length > 0
      ? affectedDirs.map((d) => `${d}(${tierOf(d)})`).join(', ')
      : 'none') +
    (fullTier ? '' : `; test files: ${testFiles.length}`),
);

const commands = planCheckCommands({
  affectedDirs,
  testFiles,
  pm: resolvePackageManagerInvoke(),
  execPath: process.execPath,
  repoRoot,
});

console.error('[check-changed] Commands to run:');
if (commands.length === 0) {
  console.error('  (nothing — no package files changed; typecheck and tests both skipped)');
} else {
  for (const c of commands) console.error(`  ${c.cmd} ${c.args.join(' ')}`);
}

if (args.list) {
  console.error('[check-changed] --list mode: printed the selection only; no commands executed');
  process.exit(0);
}
if (commands.length === 0) {
  console.error('[check-changed] no checks to run, passing (note: this is only the fast gate; the AGENTS §5 tiered mandatory runs are unaffected)');
  process.exit(0);
}

const code = await runSequentially(commands, { cwd: repoRoot });
console.error(
  code === 0
    ? '[check-changed] fast gate passed (supplementary feedback: before merging you must still run the AGENTS §5 tiers and test:all)'
    : `[check-changed] fast gate failed, exit code ${code}`,
);
process.exit(code);
