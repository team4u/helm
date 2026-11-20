#!/usr/bin/env node
/**
 * Test tier entry point: unit / integration / all suites, invoked by package.json scripts.
 *
 * Why it exists: `pnpm test` runs everything in one go, while local iteration needs a
 * faster pure-unit tier; tests in kernel / node heavily spawn real subprocesses, open
 * SQLite, create Git worktrees, and run WebSocket plus the @helmx/node daemon — not pure
 * units. To avoid misclassification, this script only does a [conservative package-level
 * split]:
 *
 *   unit        = protocol + env-io + test-kit + cli + web + plugin-client (env-io is in-process
 *                 pure scan orchestrator injection tests; web covers happy-dom/React interaction
 *                 and SDK self-tests — none start real services);
 *   integration = plugin-build + kernel + plugins + hub + node + payload plus two path entries —
 *                 'cli/test/launcher' (Hub launcher process lifecycle) and 'env-io/test/update'
 *                 (the shared update engine: real subprocesses, staging directories,
 *                 cross-process locks) — tier overrides for process-level suites living inside
 *                 unit-tier packages;
 *   all         = unit ∪ integration = every test file, equivalent to the old `pnpm test`.
 *
 * SUITES entries are either a package name (that package's top-level test/ files) or a
 * packages/-relative path such as 'cli/test/launcher' — a tier override for a test
 * subdirectory living inside an otherwise unit-tier package (process-level suites like the
 * Hub launcher lifecycle). A package entry never descends into subdirectories, so a
 * subdirectory's files enter exactly one suite via its path entry.
 *
 * Implementation: Node fs enumerates *.test.ts(x) under <root>/packages/<pkg>/test/ (or the
 * entry subdirectory itself), and the test-sharding.mjs static analysis splits strictly pure
 * in-memory tests into a bounded `--test-isolation=none` shard; the rest keep process
 * isolation and are handed to scripts/run-tests.mjs under a per-worktree worker budget
 * (default 16, capped by available CPUs) in LPT order. Set TEST_CONCURRENCY to override that budget for a deliberate
 * single-worktree run.
 *
 * Invariants (defensive assertions; any failure exits 2 rather than silently running the
 * wrong set):
 *   - all's file count must equal unit + integration file counts (no overlap, no gap);
 *   - the unit ∪ integration relative-path set must exactly match the actual *.test.ts(x)
 *     file set across every package's test directory, subdirectories included (so new
 *     packages, files, or nested test directories cannot be silently missed here).
 *
 * Note: do not raise the total timeout via the HELMX_TEST_SUITE_TIMEOUT_MS env var —
 * packages/kernel/test/env-registry-races.test.ts asserts every host HELMX_* variable is
 * stripped, and injecting it would make that test fail spuriously.
 *
 * Usage: node scripts/test-suites.mjs <unit|integration|all> [extra args passed through to the node test runner]
 */
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { partitionFilesForSharding, shouldDisableSharding } from './lib/test-sharding.mjs';
import { explicitTestConcurrency, resolveTestConcurrency, withDefaultTestConcurrency } from './lib/test-concurrency.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');

// Suite -> package names or packages/-relative paths. Split principles live in the header comment;
// tier changes must be mirrored in AGENTS.md's test tiering conventions and PACKAGE_TIERS in
// scripts/lib/workspace-meta.mjs.
const SUITES = {
  unit: ['protocol', 'env-io', 'test-kit', 'cli', 'web', 'plugin-client'],
  integration: ['plugin-build', 'kernel', 'plugins', 'hub', 'node', 'payload', 'cli/test/launcher', 'env-io/test/update'],
};
const ALL_PACKAGES = [...SUITES.unit, ...SUITES.integration];

const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };

// A package entry ('cli') reads that package's top-level test/ files; a path entry
// ('cli/test/launcher', packages/-relative) reads the subdirectory it names. Both return
// repo-root-relative file paths.
function testFilesOf(entry) {
  const relDir = entry.includes('/') ? entry : path.join(entry, 'test');
  const dir = path.join(packagesDir, relDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[test-suites] cannot read ${dir}: ${err.message} (package missing or not installed?)`);
    process.exit(2);
  }
  return entries
    .filter((e) => e.isFile() && TEST_SUFFIXES.some((s) => e.name.endsWith(s)))
    .map((e) => path.join('packages', relDir, e.name))
    .sort();
}

const suiteName = process.argv[2];
if (!SUITES[suiteName] && suiteName !== 'all') {
  console.error(`[test-suites] usage: node scripts/test-suites.mjs <unit|integration|all> [extra args...]`);
  process.exit(2);
}
const rawExtraArgs = process.argv.slice(3);
const extraArgs = rawExtraArgs[0] === '--' ? rawExtraArgs.slice(1) : rawExtraArgs;

let files;
if (suiteName === 'all') {
  files = ALL_PACKAGES.flatMap(testFilesOf);
} else {
  files = SUITES[suiteName].flatMap(testFilesOf);
}

if (files.length === 0) {
  console.error(`[test-suites] suite ${suiteName} enumerated 0 test files; refusing to run (directory layout change suspected)`);
  process.exit(2);
}

// Invariant 1: all = unit + integration (no overlap, no gap).
if (suiteName === 'all') {
  const unitCount = SUITES.unit.reduce((n, p) => n + testFilesOf(p).length, 0);
  const integrationCount = SUITES.integration.reduce((n, p) => n + testFilesOf(p).length, 0);
  const uniqueCount = new Set(files).size;
  if (files.length !== unitCount + integrationCount || uniqueCount !== files.length) {
    console.error(
      `[test-suites] all(${files.length}) != unit(${unitCount}) + integration(${integrationCount}) or duplicate files exist; the split invariant is broken`,
    );
    process.exit(2);
  }
}

// Invariant 2: the unit ∪ integration relative-path set == the actual file set across all
// repo test directories. Scan every package under packages/ with a test subdirectory (not
// just the known ones), subdirectories included, to catch future additions.
{
  const managed = new Set(ALL_PACKAGES.flatMap(testFilesOf));
  const actual = new Set();
  const walkTestDir = (dir, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // not a directory (e.g. packages/<pkg>/test missing)
    }
    for (const f of entries) {
      if (f.isFile() && TEST_SUFFIXES.some((s) => f.name.endsWith(s))) {
        actual.add(path.join(prefix, f.name));
      } else if (f.isDirectory()) {
        walkTestDir(path.join(dir, f.name), path.join(prefix, f.name));
      }
    }
  };
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    walkTestDir(path.join(packagesDir, entry.name, 'test'), path.join('packages', entry.name, 'test'));
  }
  const missing = [...actual].filter((f) => !managed.has(f));
  if (missing.length > 0) {
    console.error(`[test-suites] found test files not covered by any suite (update the SUITES tiers; path entries like 'pkg/test/subdir' cover subdirectories): ${missing.join(', ')}`);
    process.exit(2);
  }
}

const label = suiteName === 'all' ? 'all(unit+integration)' : suiteName;
const breakdown = ALL_PACKAGES.map((p) => `${p}=${testFilesOf(p).length}`).join(' ');
console.error(`[test-suites] suite ${label}: ${files.length} file(s) (${breakdown})`);

// Deterministic LPT (longest first) ordering: extremely slow tests first (20M), then known
// slow tests (10M), then descending file size, with lexicographic path order as the final
// tiebreaker — eliminating multicore tail idle time.
const ULTRA_SLOW_TEST_PREFIXES = [
  'payload',
  'node-path-usage-rpc',
  'workflow.test',
  'workflow-goal',
  'workflow-metadata',
  'core.integration',
  'worktree-runtime',
  'runtime.test.ts',
  'plugins-contract.test.ts',
  'herdr',
  'superagent',
  'background-restart',
  'native-worktree',
  'node-upgrade',
  'agent-standby',
  'check-changed',
  'quiet-notifier',
  'use-version-watcher',
  'cli.test.ts',
  'build-runner',
  'conversation-outline',
  'skill-center',
];

const SLOW_TEST_PREFIXES = [
  'cli-nodes-env',
  'cli-credentials',
  'cli-dynamic-actions',
  'cli-plugin-dx',
  'node-cli-review',
  'node-rpc-review',
  'node-forward-http',
  'node-daemon.test.ts',
  'ownership-events.test.ts',
  'plugin-client.test.ts',
  'plugin-client-runtime',
  'icons.test.ts',
  'sidebar-spaces',
  'composer-thinking-badge',
  'conversation-archive-menu',
  'helmx-store',
  'tool-activity',
  'ask-dock',
  'select.test.ts',
  'thinking-',
  'workflow',
  'updater',
  'supervisor',
  'env-app',
  'app-workflow',
  'external-plugin',
  'subagent-depth',
  'tracker-cleanup',
  'secret-lifecycle',
  'sse-',
  'unread-visibility',
  'timeline-outline-calibration',
  'markdown-codeblock-plugins',
  'node-tunnel',
  'tools.test.ts',
  'worktree-process-usage',
  'node-fetch-body-cleanup',
  'restart-graceful-recovery',
  'plugin-dx-loop',
  'token-speed.integration',
  'profile-collaboration',
  'test-kit.test.ts',
];

function matchesPrefix(base, list) {
  return list.some((p) => base.startsWith(p) || base === p);
}

const ULTRA_SLOW_TIER_WEIGHT = 20_000_000;

function lptWeight(relPath) {
  const base = path.basename(relPath);
  let tier = 0;
  if (matchesPrefix(base, ULTRA_SLOW_TEST_PREFIXES)) tier = ULTRA_SLOW_TIER_WEIGHT;
  else if (matchesPrefix(base, SLOW_TEST_PREFIXES)) tier = 10_000_000;
  let size = 0;
  try {
    size = statSync(path.join(repoRoot, relPath)).size;
  } catch {
    size = 0;
  }
  return tier + size;
}

const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));
const ts = requireFromRoot('typescript');
let workerBudget;
try {
  workerBudget = resolveTestConcurrency(process.env.TEST_CONCURRENCY, os.availableParallelism());
} catch (error) {
  console.error(`[test-suites] ${error.message}`);
  process.exit(2);
}

const sortedAllFiles = [...files].sort((a, b) => lptWeight(b) - lptWeight(a) || a.localeCompare(b));
let workerBudgetOverride;
try {
  workerBudgetOverride = explicitTestConcurrency(extraArgs);
} catch (error) {
  console.error(`[test-suites] ${error.message}`);
  process.exit(2);
}
if (workerBudgetOverride !== undefined) workerBudget = workerBudgetOverride;
const shardingDisabled = shouldDisableSharding(extraArgs) || workerBudgetOverride !== undefined;

/** @type {Array<{ label: string, args: string[], permits: number }>} */
const plans = [];

if (!shardingDisabled) {
  const { pureFiles, isolatedFiles, shards } = partitionFilesForSharding({
    ts,
    repoRoot,
    files,
    cpus: workerBudget,
    // Share module initialization by running the pure files in one process.
    filesPerShard: Math.max(8, files.length),
    weightFn: lptWeight,
  });
  const usePureShards = pureFiles.length >= 4 && shards.length > 0;
  if (usePureShards) {
    const pureShardCount = shards.length;
    // Node fixes file concurrency when its runner starts. Run the pure shard first so
    // the isolated pool can use every permit throughout the much longer phase.
    console.error(
      `[test-suites] schedule: pure=${pureFiles.length} (${pureShardCount} shard, --test-isolation=none), then ` +
        `isolated=${isolatedFiles.length} (--test-concurrency=${workerBudget}, worktree cap ${workerBudget})`,
    );
    shards.forEach((shard, idx) => {
      plans.push({
        label: `pure-shard-${idx + 1}/${pureShardCount}`,
        args: ['--test-isolation=none', '--test-concurrency=1', ...extraArgs, ...shard],
        permits: 1,
      });
    });
    if (isolatedFiles.length > 0) {
      plans.push({
        label: 'isolated',
        args: withDefaultTestConcurrency(extraArgs, workerBudget).concat(isolatedFiles),
        permits: workerBudget,
      });
    }
  } else {
    plans.push({
      label: 'isolated',
      args: withDefaultTestConcurrency(extraArgs, workerBudget).concat(sortedAllFiles),
      permits: workerBudget,
    });
  }
} else {
  plans.push({
    label: 'single',
    args: withDefaultTestConcurrency(extraArgs, workerBudget).concat(sortedAllFiles),
    permits: workerBudget,
  });
}

// Reuse run-tests.mjs: cross-platform tsx spawn, per-test/total timeouts, and process-tree
// cleanup all live there. The permit pool starts the isolated phase once the pure shard releases its permit.
const runTestsPath = path.join(repoRoot, 'scripts', 'run-tests.mjs');
const suiteStartMs = Date.now();
/** @type {Set<import('node:child_process').ChildProcess>} */
const activeChildren = new Set();
let receivedSignal = null;

for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!receivedSignal) receivedSignal = signal;
    for (const child of activeChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
  });
}

/**
 * Schedule queued test plans under the concurrency permit cap, keeping active test
 * processes <= maxPermits at any moment.
 * @param {Array<{ label: string, args: string[], permits: number }>} queue
 * @param {number} maxPermits
 * @returns {Promise<number[]>}
 */
function runPlanPool(queue, maxPermits) {
  if (queue.length === 0) return Promise.resolve([]);
  const cap = Math.max(1, maxPermits);
  const results = new Array(queue.length).fill(0);
  const pending = queue.map((plan, index) => ({
    plan,
    index,
    cost: Math.max(1, Math.min(cap, plan.permits)),
  }));
  let available = cap;
  let running = 0;

  return new Promise((resolve) => {
    const spawnOne = (item) =>
      new Promise((done) => {
        const child = spawn(process.execPath, [runTestsPath, ...item.plan.args], {
          stdio: 'inherit',
          env: process.env,
          cwd: repoRoot,
        });
        activeChildren.add(child);
        child.on('error', (err) => {
          activeChildren.delete(child);
          console.error(`[test-suites] failed to start ${item.plan.label}: ${err.message}`);
          done(1);
        });
        child.on('exit', (code, signal) => {
          activeChildren.delete(child);
          if (code !== null) done(code);
          else done(SIGNAL_EXIT_CODES[signal] ?? 1);
        });
      });

    const pump = () => {
      if (!receivedSignal) {
        for (let i = 0; i < pending.length; ) {
          if (pending[i].cost <= available) {
            const [item] = pending.splice(i, 1);
            available -= item.cost;
            running += 1;
            void spawnOne(item).then((code) => {
              results[item.index] = code;
              available += item.cost;
              running -= 1;
              pump();
            });
          } else {
            i += 1;
          }
        }
      }
      if (running === 0 && (receivedSignal || pending.length === 0)) {
        resolve(results);
      }
    };

    pump();
  });
}

const exitCodes = await runPlanPool(plans, workerBudget);

const elapsed = ((Date.now() - suiteStartMs) / 1000).toFixed(1);
let finalCode = 0;
if (receivedSignal) {
  finalCode = SIGNAL_EXIT_CODES[receivedSignal] ?? 1;
} else {
  const firstFailure = exitCodes.find((c) => c !== 0);
  if (firstFailure !== undefined) finalCode = firstFailure;
}
console.error(`[test-suites] suite ${label} finished in ${elapsed}s, exit code ${finalCode}`);
process.exitCode = finalCode;
