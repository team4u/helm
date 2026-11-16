#!/usr/bin/env node
/**
 * pnpm check:changed - - change drive fast feedback gate (patch fill while non- alternative AGENTS §5 Profile must run and merge test:all).
 *
 * mechanism (keep guard can rely, without cache, without smart related guess):
 *   1. changeset = merge-base(base, HEAD)..HEAD commit difference ∪ work zone(staged+unstaged) ∪ untracked file,
 *      git -z parse (space path / rename new old double side / delete all such as accept);
 *      baseline priority --base <ref> > branch upstream > origin/HEAD, all no then explicit errors want seek --base,
 *      never static default retreat to HEAD~1(will leak many commit).
 *   2. subject to affect package = change file by packages/<dir> mapping; package inside non- test file change → the package + all pass
 *      dependency it package (workspace dependency graph reverse closed package); pure test file change → only the package;
 *      lock file / config / test basis set apply (contains scripts directory under all .mjs source code) change → all Profile.
 *   3. command plan see lib/workspace-meta.mjs planCheckCommands:pnpm typecheck(contains
 *      protocol/node build)→(choose in desktop test when)desktop dist build → subject to affect package test
 *      (explicit file list hand over to scripts/run-tests.mjs, re- use its timeout and process tree clean up).
 *
 * use method (pnpm argument passing must -- isolate symbol, script accept open head literal --,pnpm will original pass-through):
 *   pnpm check:changed --                      # automatically baseline (upstream / origin/HEAD)
 *   pnpm check:changed -- --base main          # explicit baseline (recommend in without upstream  worktree branch use)
 *   pnpm check:changed -- --list               # only print accept file/subject to affect package/execute command, do not run (--dry-run same meaning)
 *
 * exit code:0 via (or without can run items); command failed original pass-through; use method/baseline error 2.
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
  console.error(`use method: pnpm check:changed -- [--base <ref>] [--list|--dry-run]
  --base <ref>    explicit baseline (commit/branch/tag), take its and HEAD  merge-base
  --list          only print choose collection (accept file / subject to affect package / execute command), do not execute
  --dry-run       --list same meaning alias
note: via pnpm invoke when must use -- isolate parameter (such as pnpm check:changed -- --base main --list),
      open head literal -- will by this script ignore; directly node scripts/check-changed.mjs invoke then no need to --.`);
}

function parseArgs(argv) {
  const opts = { base: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // pnpm pass-through open head -- isolate symbol: only skip first reference location, the rest location -- by unknown parameter errors.
    if (a === '--' && i === 0) continue;
    if (a === '--base' && argv[i + 1]) {
      opts.base = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--base=')) {
      opts.base = a.slice('--base='.length);
    } else if (a === '--list' || a === '--dry-run') {
      opts.list = true;
    } else {
      console.error(`[check-changed] unknown parameter: ${a}`);
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

// ---- report (--list and real execute shared use the same choose collection note, supply re-check)----
const kindLabel = { explicit: 'explicit --base', upstream: 'branch upstream', 'origin-head': 'origin/HEAD' };
const ahead = commitsAhead(repoRoot, changes.baseline.mergeBase);
console.error(
  `[check-changed] baseline: ${kindLabel[changes.baseline.kind]} ${changes.baseline.ref}` +
    `(merge-base ${shortRev(repoRoot, changes.baseline.mergeBase)},HEAD lead first ${ahead} commit)`,
);
console.error(
  `[check-changed] change file ${changes.files.length} ` +
    `(committed ${changes.files.filter((f) => f.origin.includes('committed')).length}` +
    ` / work zone ${changes.files.filter((f) => f.origin.includes('worktree')).length}` +
    ` / untracked ${changes.files.filter((f) => f.origin === 'untracked').length}):`,
);
for (const f of changes.files.slice(0, 60)) {
  console.error(`  ${f.status.padEnd(5)} ${f.path}  (${f.origin})`);
}
if (changes.files.length > 60) console.error(`  ... (the rest ${changes.files.length - 60} omit)`);
if (outside.length > 0) {
  console.error(`[check-changed] non- package inside change ${outside.length} (docs etc., does not trigger test choose collection)`);
}

const tierOf = (dir) => PACKAGE_TIERS[dir] ?? 'not Profile';
console.error(
  `[check-changed] subject to affect package${fullTier ? '(level trigger → all Profile)' : ''}: ` +
    (affectedDirs.length > 0
      ? affectedDirs.map((d) => `${d}(${tierOf(d)})`).join(', ')
      : 'without') +
    (fullTier ? '' : `; test file ${testFiles.length} `),
);

const commands = planCheckCommands({
  affectedDirs,
  testFiles,
  pm: resolvePackageManagerInvoke(),
  execPath: process.execPath,
  repoRoot,
});

console.error('[check-changed] execute:');
if (commands.length === 0) {
  console.error('  (without - - change does not involve any package inside file,typecheck and test all skip)');
} else {
  for (const c of commands) console.error(`  ${c.cmd} ${c.args.join(' ')}`);
}

if (args.list) {
  console.error('[check-changed] --list pattern: only print choose collection, not execute any command');
  process.exit(0);
}
if (commands.length === 0) {
  console.error('[check-changed] without can execute check, via (note: this only is fast gate,AGENTS §5 Profile must run rule do not subject to affect)');
  process.exit(0);
}

const code = await runSequentially(commands, { cwd: repoRoot });
console.error(
  code === 0
    ? '[check-changed] fast gate via (patch fill feedback: merge before still must by AGENTS §5 run for should Profile and test:all)'
    : `[check-changed] fast gate failed, exit code ${code}`,
);
process.exit(code);
