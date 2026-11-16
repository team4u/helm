#!/usr/bin/env node
/**
 * pnpm check:hygiene — static test hygiene checks (TypeScript Compiler API, zero new deps).
 *
 * Rules are documented in the scripts/lib/test-hygiene.mjs header comment:
 *   timeout-missing / skip-without-reason / suite-timeout-env（AGENTS §5）。
 * Existing violations get no baseline exemption — every one is reported faithfully and the
 * run fails with exit code 1; each fixed is one fewer.
 *
 * Usage (pnpm needs the -- separator; this script accepts and skips a leading literal --
 * that pnpm passes through verbatim):
 *   pnpm check:hygiene                       # every *.test.ts / *.test.tsx under all packages' test dirs
 *   pnpm check:hygiene -- --changed          # only test files inside the change set (baseline rules as check-changed)
 *   pnpm check:hygiene -- --changed --base main
 *   pnpm check:hygiene -- --files <path...>  # explicit file list (must live inside this repo; outside paths rejected)
 *
 * Exit codes: 0 clean; 1 violations found; 2 usage/baseline error. No HELM_* env vars are
 * injected.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChangedFiles, GitChangeError } from './lib/git-changes.mjs';
import { analyzeTestSource, collectAllTestFiles, isTestFilePath } from './lib/test-hygiene.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(`Usage: node scripts/check-test-hygiene.mjs [--changed [--base <ref>]] [--files <path...>]
  (default)      check every test file in the repo
  --changed      check only test files inside the change set (committed ∪ worktree ∪ untracked)
  --base <ref>   only with --changed; baseline semantics identical to check-changed
  --files p...   explicit file list to check (must live inside this repo, relative or absolute; outside paths rejected)
Note: when invoked through pnpm, arguments must be separated with -- (e.g. pnpm check:hygiene -- --files x.test.ts);
      a leading literal -- is ignored by this script; a direct node scripts/check-test-hygiene.mjs call needs no --.`);
}

const argv = process.argv.slice(2);
const opts = { changed: false, base: null, files: [] };
let filesRequested = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  // The leading -- separator passed through by pnpm: only skipped in the first position;
  // a -- anywhere else is reported as an unknown argument.
  if (a === '--' && i === 0) continue;
  if (a === '--changed') opts.changed = true;
  else if (a === '--base' && argv[i + 1]) {
    opts.base = argv[i + 1];
    i += 1;
  } else if (a.startsWith('--base=')) opts.base = a.slice('--base='.length);
  else if (a === '--files') {
    filesRequested = true;
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j += 1) {
      opts.files.push(argv[j]);
      i = j;
    }
  } else {
    console.error(`[check-hygiene] 未知参数: ${a}`);
    usage();
    process.exit(2);
  }
}
if (filesRequested && opts.files.length === 0) {
  console.error('[check-hygiene] --files 需要至少一个仓库内测试文件路径（不会退回全仓扫描）');
  usage();
  process.exit(2);
}
if (opts.base && !opts.changed) {
  console.error('[check-hygiene] --base may only be combined with --changed');
  usage();
  process.exit(2);
}

// Scope resolution: whole repo / change set / explicit file list (out-of-repo paths are
// rejected; never silently check some other repository).
let scopeLabel;
let files;
if (opts.files.length > 0) {
  files = opts.files.map((f) => {
    const abs = path.resolve(process.cwd(), f);
    const rel = path.relative(repoRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.error(
        `[check-hygiene] 拒绝仓库外路径: ${f}（本工具只检查本仓库测试文件，解析为 ${abs}）`,
      );
      process.exit(2);
    }
    return rel;
  });
  scopeLabel = `explicit ${files.length} file(s)`;
} else if (opts.changed) {
  let changes;
  try {
    changes = collectChangedFiles({ base: opts.base, cwd: repoRoot });
  } catch (err) {
    if (err instanceof GitChangeError) {
      console.error(`[check-hygiene] ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
  files = changes.files.map((f) => f.path).filter((p) => isTestFilePath(p) && existsSync(path.join(repoRoot, p)));
  scopeLabel = `change set, ${files.length} test file(s) (baseline ${changes.baseline.ref})`;
} else {
  files = collectAllTestFiles(repoRoot);
  scopeLabel = `whole repo, ${files.length} test file(s)`;
}

console.error(`[check-hygiene] scope: ${scopeLabel}`);

// typescript comes from the repo root devDependency; createRequire anchors resolution there.
const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));
const ts = requireFromRoot('typescript');

const allViolations = [];
const totals = { testCalls: 0, skipCalls: 0, todoCalls: 0, subtestCalls: 0 };
for (const rel of files) {
  const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
  let source;
  try {
    source = readFileSync(abs, 'utf8');
  } catch (err) {
    console.error(`[check-hygiene] cannot read ${rel}: ${err.message}`);
    process.exit(2);
  }
  const report = analyzeTestSource(ts, rel, source);
  allViolations.push(...report.violations);
  totals.testCalls += report.stats.testCalls;
  totals.skipCalls += report.stats.skipCalls;
  totals.todoCalls += report.stats.todoCalls;
  totals.subtestCalls += report.stats.subtestCalls;
}

allViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const v of allViolations) {
  console.error(`[check-hygiene] ${v.file}:${v.line} [${v.rule}] ${v.message}`);
}

const byRule = {};
for (const v of allViolations) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
const ruleSummary = Object.entries(byRule)
  .map(([r, n]) => `${r} ${n}`)
  .join(' / ');
console.error(
  `[check-hygiene] stats: test/it ${totals.testCalls} (skip ${totals.skipCalls}, todo ${totals.todoCalls});` +
    ` t.test subtests: ${totals.subtestCalls} not covered by these rules (they inherit the runner's 20s default timeout; tighten manually as needed)`,
);
if (allViolations.length > 0) {
  console.error(`[check-hygiene] ${allViolations.length} violation(s) (${ruleSummary}), exiting 1`);
  process.exit(1);
}
console.error('[check-hygiene] clean, exiting 0');
process.exit(0);
