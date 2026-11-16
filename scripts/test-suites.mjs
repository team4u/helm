#!/usr/bin/env node
/**
 * test layer entry:unit / integration / all three Profile set piece, supply package.json script invoke.
 *
 * is what store in:`pnpm test` is one shuttle all amount, local iterate need to one Profile more fast pure unit feedback;
 * while kernel / node package test large amount start real child process, open SQLite, create Git worktree, run WebSocket
 * and @helm/node daemon, is not pure unit. is avoid mistakenly classify, this script only do [keep guard package level cut]:
 *
 *   unit        = protocol + env-io + cli + web + plugin-client(env-io is process inside pure scan
 *                 orchestration inject test;web contains happy-dom/React interaction and SDK self test, all do not start real service);
 *   integration = plugin-build + kernel + plugins + hub + node + payload + desktop(contains real
 *                 esbuild compile/child process,SQLite/Git/daemon,payload group install and desktop shell Hub child process supervise);
 *   all         = unit ∪ integration = all test file, etc. price at old `pnpm test`.
 *
 * implement:Node fs by <root>/packages/<pkg>/test/ directory enumeration *.test.ts(x), combine test-sharding.mjs
 * static analyze strictly in-memory test split to K  `--test-isolation=none` shard parallel execute, the rest test keep
 * process isolated and via LPT(long time cost takes precedence) order hand over to scripts/run-tests.mjs concurrency scheduling.
 *
 * invariant (guard against defend assertion, failed i.e. script exit 2, never static default run wrong collection):
 *   - all file count must equals unit and integration file count of and (do not heavy do not leak);
 *   - unit ∪ integration relative path set must and all warehouse all package test directory under *.test.ts(x)
 *     actual file collection fully consistent (guard against new increase package/file after this in silently leak).
 *
 * note: do not want use HELM_TEST_SUITE_TIMEOUT_MS environment variable tune large total timeout - -packages/kernel/test/
 * env-registry-races.test.ts assertion host HELM_* variable by all strip except, inject the variable will let it mistakenly report failed.
 *
 * use method:node scripts/test-suites.mjs <unit|integration|all> [pass-through to node test runner extra parameter]
 */
import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { partitionFilesForSharding, shouldDisableSharding } from './lib/test-sharding.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');

// set piece → package name. cut principle see file head note release; adjust Profile when must sync update AGENTS.md test layer convention.
const SUITES = {
  unit: ['protocol', 'env-io', 'test-kit', 'cli', 'web', 'plugin-client'],
  integration: ['plugin-build', 'kernel', 'plugins', 'hub', 'node', 'payload', 'desktop'],
};
const ALL_PACKAGES = [...SUITES.unit, ...SUITES.integration];

const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };

function testFilesOf(pkg) {
  const dir = path.join(packagesDir, pkg, 'test');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`[test-suites] cannot read ${dir}: ${err.message}(package missing or not installed?)`);
    process.exit(2);
  }
  return entries
    .filter((e) => e.isFile() && TEST_SUFFIXES.some((s) => e.name.endsWith(s)))
    .map((e) => path.join('packages', pkg, 'test', e.name))
    .sort();
}

const suiteName = process.argv[2];
if (!SUITES[suiteName] && suiteName !== 'all') {
  console.error(`[test-suites] use method: node scripts/test-suites.mjs <unit|integration|all> [extra args...]`);
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
  console.error(`[test-suites] set piece ${suiteName} enumeration to 0 test file, reject execute (suspected directory structure change)`);
  process.exit(2);
}

// invariant 1:all = unit + integration(do not heavy do not leak).
if (suiteName === 'all') {
  const unitCount = SUITES.unit.reduce((n, p) => n + testFilesOf(p).length, 0);
  const integrationCount = SUITES.integration.reduce((n, p) => n + testFilesOf(p).length, 0);
  const uniqueCount = new Set(files).size;
  if (files.length !== unitCount + integrationCount || uniqueCount !== files.length) {
    console.error(
      `[test-suites] all(${files.length}) ≠ unit(${unitCount}) + integration(${integrationCount}) or store in duplicate file, cut invariant by break`,
    );
    process.exit(2);
  }
}

// invariant 2:unit ∪ integration relative path set == all warehouse test directory actual file collection.
// directly scan packages under all contains test subdirectory package (do not scoped limit at known five package), catch not come new increase package.
{
  const managed = new Set(ALL_PACKAGES.flatMap(testFilesOf));
  const actual = new Set();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const testDir = path.join(packagesDir, entry.name, 'test');
    try {
      for (const f of readdirSync(testDir, { withFileTypes: true })) {
        if (f.isFile() && TEST_SUFFIXES.some((s) => f.name.endsWith(s))) {
          actual.add(path.join('packages', entry.name, 'test', f.name));
        }
      }
    } catch {
      // without test directory package skip.
    }
  }
  const missing = [...actual].filter((f) => !managed.has(f));
  if (missing.length > 0) {
    console.error(`[test-suites] discover not accept any set piece test file (please update SUITES Profile): ${missing.join(', ')}`);
    process.exit(2);
  }
}

const label = suiteName === 'all' ? 'all(unit+integration)' : suiteName;
const breakdown = ALL_PACKAGES.map((p) => `${p}=${testFilesOf(p).length}`).join(' ');
console.error(`[test-suites] set piece ${label}: ${files.length} file (${breakdown})`);

// determinism LPT(long time cost takes precedence) sort: extreme slow test most takes precedence (20M), second known slow test (10M),
// again by file byte large small drop order, same right by path dictionary order fall back, eliminate many core concurrency tail part empty etc..
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
  'helm-store',
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
const cpus = Math.max(1, os.availableParallelism());

const sortedAllFiles = [...files].sort((a, b) => lptWeight(b) - lptWeight(a) || a.localeCompare(b));
const shardingDisabled = shouldDisableSharding(extraArgs);

/** @type {Array<{ label: string, args: string[], permits: number }>} */
const plans = [];

if (!shardingDisabled) {
  const { pureFiles, isolatedFiles, shards } = partitionFilesForSharding({
    ts,
    repoRoot,
    files,
    cpus,
    // merge in-memory test is single process shard (measured unit 43 file only 1.3s,integration 38 file contains 5s timer shared 6.9s),
    // and isolated process pool by 1 + (cpus - 1) concurrency start run: zero phase fence, zero double pool over contend grab, zero hundred remaining coordinate tune cold start tax.
    filesPerShard: Math.max(8, files.length),
    weightFn: lptWeight,
  });
  const usePureShards = pureFiles.length >= 4 && shards.length > 0;
  if (usePureShards) {
    const pureShardCount = shards.length;
    const isoConc = Math.max(1, cpus - pureShardCount);
    console.error(
      `[test-suites] scheduling: pure=${pureFiles.length}(${pureShardCount} shard,--test-isolation=none)‖ ` +
        `isolated=${isolatedFiles.length}(--test-concurrency=${isoConc}, total cap ${cpus})`,
    );
    shards.forEach((shard, idx) => {
      plans.push({
        label: `pure-shard-${idx + 1}/${pureShardCount}`,
        args: ['--test-isolation=none', ...extraArgs, ...shard],
        permits: 1,
      });
    });
    if (isolatedFiles.length > 0) {
      plans.push({
        label: 'isolated',
        args: [`--test-concurrency=${isoConc}`, ...extraArgs, ...isolatedFiles],
        permits: isoConc,
      });
    }
  } else {
    plans.push({
      label: 'isolated',
      args: [...extraArgs, ...sortedAllFiles],
      permits: cpus,
    });
  }
} else {
  plans.push({
    label: 'single',
    args: [...extraArgs, ...sortedAllFiles],
    permits: cpus,
  });
}

// re- use run-tests.mjs: across platform tsx spawn, single test/total timeout and process tree clean up all in that edge, never duplicate implement.
// based on permit can cap cpus single work pool unify scheduling pure-shards, heavy type single file and concurrency batch, avoid double pool over contend grab, phase fence and tail part chained.
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
 * by concurrency permit can cap scheduling queue in test plan, guarantee any moment leap test process count ≤ maxPermits.
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
          console.error(`[test-suites] start ${item.plan.label} failed: ${err.message}`);
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

const exitCodes = await runPlanPool(plans, cpus);

const elapsed = ((Date.now() - suiteStartMs) / 1000).toFixed(1);
let finalCode = 0;
if (receivedSignal) {
  finalCode = SIGNAL_EXIT_CODES[receivedSignal] ?? 1;
} else {
  const firstFailure = exitCodes.find((c) => c !== 0);
  if (firstFailure !== undefined) finalCode = firstFailure;
}
console.error(`[test-suites] set piece ${label} ${elapsed}s end, exit code ${finalCode}`);
process.exitCode = finalCode;
