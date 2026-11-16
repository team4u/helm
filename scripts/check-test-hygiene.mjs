#!/usr/bin/env node
/**
 * pnpm check:hygiene - - test guard generate static check (TypeScript Compiler API, zero new dependency).
 *
 * rule see scripts/lib/test-hygiene.mjs head note release:
 *   timeout-missing / skip-without-reason / suite-timeout-env(AGENTS §5).
 * store amount violate rule does not baseline exemption - - such as one by one report and with exit code 1 failed; fix a few a.
 *
 * use method (pnpm argument passing must -- isolate symbol, script accept and skip open head literal --,pnpm will original pass-through):
 *   pnpm check:hygiene                       # all warehouse all package test directory under *.test.ts / *.test.tsx
 *   pnpm check:hygiene -- --changed          # only check changeset inside test file (baseline same check-changed)
 *   pnpm check:hygiene -- --changed --base main
 *   pnpm check:hygiene -- --files <path...>  # explicit designate file (must at this repository inside, reject repository outside path)
 *
 * exit code:0 clean;1 store in violate rule;2 use method/baseline error. do not inject any HELM_* environment variable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChangedFiles, GitChangeError } from './lib/git-changes.mjs';
import { analyzeTestSource, collectAllTestFiles, isTestFilePath } from './lib/test-hygiene.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(`use method: node scripts/check-test-hygiene.mjs [--changed [--base <ref>]] [--files <path...>]
  (default)        check all warehouse test file
  --changed      only check changeset (commit ∪ work zone ∪ untracked) inside test file
  --base <ref>   only match together --changed designate baseline, semantics same check-changed
  --files p...   explicit designate want check file (must at this repository inside, each other for or absolute path all can; reject repository outside path)
note: via pnpm invoke when must use -- isolate parameter (such as pnpm check:hygiene -- --files x.test.ts),
      open head literal -- will by this script ignore; directly node scripts/check-test-hygiene.mjs invoke then no need to --.`);
}

const argv = process.argv.slice(2);
const opts = { changed: false, base: null, files: [] };
let filesRequested = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  // pnpm pass-through open head -- isolate symbol: only skip first reference location, the rest location -- by unknown parameter errors.
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
    console.error(`[check-hygiene] unknown parameter: ${a}`);
    usage();
    process.exit(2);
  }
}
if (filesRequested && opts.files.length === 0) {
  console.error('[check-hygiene] --files need to at least a repository inside test file path (will not retreat back all warehouse scan)');
  usage();
  process.exit(2);
}
if (opts.base && !opts.changed) {
  console.error('[check-hygiene] --base only can and --changed pair use');
  usage();
  process.exit(2);
}

// scope parse: all warehouse / changeset / explicit file list (reject repository outside path, never static default check other repository).
let scopeLabel;
let files;
if (opts.files.length > 0) {
  files = opts.files.map((f) => {
    const abs = path.resolve(process.cwd(), f);
    const rel = path.relative(repoRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.error(
        `[check-hygiene] reject repository outside path: ${f}(this tool only check this repository test file, parse is ${abs})`,
      );
      process.exit(2);
    }
    return rel;
  });
  scopeLabel = `explicit ${files.length} file`;
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
  scopeLabel = `changeset ${files.length} test file (baseline ${changes.baseline.ref})`;
} else {
  files = collectAllTestFiles(repoRoot);
  scopeLabel = `all warehouse ${files.length} test file`;
}

console.error(`[check-hygiene] scope: ${scopeLabel}`);

// typescript by repository devDependency provide,createRequire anchor set repository parse.
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
  `[check-hygiene] count: test/it ${totals.testCalls}(skip ${totals.skipCalls},todo ${totals.todoCalls});` +
    `t.test sub- test ${totals.subtestCalls} where do not in this rule override inside (inherit runner 20s by default timeout, must human evaluate is otherwise tight)`,
);
if (allViolations.length > 0) {
  console.error(`[check-hygiene] violate rule ${allViolations.length} where (${ruleSummary}), exit 1`);
  process.exit(1);
}
console.error('[check-hygiene] clean, exit 0');
process.exit(0);
