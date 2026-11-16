#!/usr/bin/env node
/**
 * 测试分层入口：unit / integration / all 三档套件，供 package.json 脚本调用。
 *
 * 为什么存在：`pnpm test` 是一把梭全量，本地迭代需要一档更快的纯单元反馈；
 * 而 kernel / node 包的测试大量起真实子进程、开 SQLite、建 Git worktree、跑 WebSocket
 * 与 @helm/node daemon，不是纯单元。为避免误分类，本脚本只做【保守包级切分】：
 *
 *   unit        = protocol + env-io + cli + web + plugin-client（env-io 为进程内纯扫描
 *                 编排器注入测试；web 含 happy-dom/React 交互与 SDK 自测，均不起真实服务）；
 *   integration = plugin-build + kernel + plugins + hub + node + payload + desktop（包含真实
 *                 esbuild 编译/子进程、SQLite/Git/daemon、payload 组装与桌面壳 Hub 子进程监督）；
 *   all         = unit ∪ integration = 全部测试文件，等价于旧 `pnpm test`。
 *
 * 实现：Node fs 按 <root>/packages/<pkg>/test/ 目录枚举 *.test.ts(x)，结合 test-sharding.mjs
 * 静态分析将严格纯内存测试拆分到 K 个 `--test-isolation=none` 分片并行执行，其余测试保留
 * 进程隔离并通过 LPT（长耗时优先）顺序交给 scripts/run-tests.mjs 并发调度。
 *
 * 不变量（防御性断言，失败即脚本退出 2，绝不静默跑错集）：
 *   - all 的文件数必须等于 unit 与 integration 文件数之和（不重不漏）；
 *   - unit ∪ integration 的相对路径集合必须与全仓所有包 test 目录下的 *.test.ts(x)
 *     实际文件集完全一致（防止新增包/文件后这里悄悄漏掉）。
 *
 * 注意：不要用 HELM_TEST_SUITE_TIMEOUT_MS 环境变量调大总超时——packages/kernel/test/
 * env-registry-races.test.ts 断言宿主 HELM_* 变量被全部剥除，注入该变量会让它误报失败。
 *
 * 用法：node scripts/test-suites.mjs <unit|integration|all> [透传给 node test runner 的额外参数]
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

// 套件 → 包名。切分原则见文件头注释；调整分档时必须同步更新 AGENTS.md 的测试分层约定。
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
    console.error(`[test-suites] 无法读取 ${dir}: ${err.message}（包不存在或未安装？）`);
    process.exit(2);
  }
  return entries
    .filter((e) => e.isFile() && TEST_SUFFIXES.some((s) => e.name.endsWith(s)))
    .map((e) => path.join('packages', pkg, 'test', e.name))
    .sort();
}

const suiteName = process.argv[2];
if (!SUITES[suiteName] && suiteName !== 'all') {
  console.error(`[test-suites] 用法: node scripts/test-suites.mjs <unit|integration|all> [extra args...]`);
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
  console.error(`[test-suites] 套件 ${suiteName} 枚举到 0 个测试文件，拒绝执行（疑似目录结构变更）`);
  process.exit(2);
}

// 不变量 1：all = unit + integration（不重不漏）。
if (suiteName === 'all') {
  const unitCount = SUITES.unit.reduce((n, p) => n + testFilesOf(p).length, 0);
  const integrationCount = SUITES.integration.reduce((n, p) => n + testFilesOf(p).length, 0);
  const uniqueCount = new Set(files).size;
  if (files.length !== unitCount + integrationCount || uniqueCount !== files.length) {
    console.error(
      `[test-suites] all(${files.length}) ≠ unit(${unitCount}) + integration(${integrationCount}) 或存在重复文件，切分不变量被破坏`,
    );
    process.exit(2);
  }
}

// 不变量 2：unit ∪ integration 的相对路径集合 == 全仓 test 目录实际文件集。
// 直接扫描 packages 下所有含 test 子目录的包（不局限于已知五包），捕获未来新增包。
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
      // 无 test 目录的包跳过。
    }
  }
  const missing = [...actual].filter((f) => !managed.has(f));
  if (missing.length > 0) {
    console.error(`[test-suites] 发现未纳入任何套件的测试文件（请更新 SUITES 分档）: ${missing.join(', ')}`);
    process.exit(2);
  }
}

const label = suiteName === 'all' ? 'all(unit+integration)' : suiteName;
const breakdown = ALL_PACKAGES.map((p) => `${p}=${testFilesOf(p).length}`).join(' ');
console.error(`[test-suites] 套件 ${label}: ${files.length} 个文件（${breakdown}）`);

// 确定性 LPT（长耗时优先）排序：极慢测试最优先（20M），其次已知慢测试（10M），
// 再次按文件字节大小降序，同权按路径字典序兜底，消除多核并发尾部空等。
const ULTRA_SLOW_TEST_PREFIXES = [
  'payload',
  'node-path-usage-rpc',
  'workflow-goal',
  'core.integration',
  'worktree-runtime',
  'herdr',
  'superagent',
  'background-restart',
  'native-worktree',
  'node-upgrade',
  'agent-standby',
  'check-changed',
  'quiet-notifier',
  'use-version-watcher',
];

const SLOW_TEST_PREFIXES = [
  'cli.test.ts',
  'cli-nodes-env',
  'node-rpc-review',
  'plugin-client.test.ts',
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
  'markdown-codeblock-plugins',
  'node-tunnel',
  'tools.test.ts',
  'worktree-process-usage',
  'node-fetch-body-cleanup',
  'restart-graceful-recovery',
  'plugin-dx-loop',
  'token-speed.integration',
  'profile-collaboration',
];

function matchesPrefix(base, list) {
  return list.some((p) => base.startsWith(p) || base === p);
}

function lptWeight(relPath) {
  const base = path.basename(relPath);
  let tier = 0;
  if (matchesPrefix(base, ULTRA_SLOW_TEST_PREFIXES)) tier = 20_000_000;
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

/** @type {Array<{ label: string, args: string[] }>} */
const runPlans = [];

if (!shardingDisabled) {
  const { pureFiles, isolatedFiles, shards } = partitionFilesForSharding({
    ts,
    repoRoot,
    files,
    cpus,
    filesPerShard: 8,
    weightFn: lptWeight,
  });
  if (pureFiles.length >= 4 && shards.length > 0) {
    console.error(
      `[test-suites] 调度: pure=${pureFiles.length}（${shards.length} 个 --test-isolation=none 分片） isolated=${isolatedFiles.length}`,
    );
    shards.forEach((shard, idx) => {
      runPlans.push({
        label: `pure-shard-${idx + 1}/${shards.length}`,
        args: ['--test-isolation=none', ...extraArgs, ...shard],
      });
    });
    if (isolatedFiles.length > 0) {
      runPlans.push({
        label: 'isolated',
        args: [...extraArgs, ...isolatedFiles],
      });
    }
  }
}

if (runPlans.length === 0) {
  runPlans.push({
    label: 'isolated',
    args: [...extraArgs, ...sortedAllFiles],
  });
}

// 复用 run-tests.mjs：跨平台 tsx spawn、单测/总超时与进程树清理都在那边，绝不重复实现。
const runTestsPath = path.join(repoRoot, 'scripts', 'run-tests.mjs');
const suiteStartMs = Date.now();
const children = runPlans.map((plan) =>
  spawn(process.execPath, [runTestsPath, ...plan.args], {
    stdio: 'inherit',
    env: process.env,
    cwd: repoRoot,
  }),
);

// 及时将信号广播转发到所有分片与隔离测试组。
let receivedSignal = null;
for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!receivedSignal) receivedSignal = signal;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
  });
}

const exitCodes = await Promise.all(
  children.map(
    (child, idx) =>
      new Promise((resolve) => {
        child.on('error', (err) => {
          console.error(`[test-suites] 启动 ${runPlans[idx].label} 失败: ${err.message}`);
          resolve(1);
        });
        child.on('exit', (code, signal) => {
          if (code !== null) resolve(code);
          else resolve(SIGNAL_EXIT_CODES[signal] ?? 1);
        });
      }),
  ),
);

const elapsed = ((Date.now() - suiteStartMs) / 1000).toFixed(1);
let finalCode = 0;
if (receivedSignal) {
  finalCode = SIGNAL_EXIT_CODES[receivedSignal] ?? 1;
} else {
  const firstFailure = exitCodes.find((c) => c !== 0);
  if (firstFailure !== undefined) finalCode = firstFailure;
}
console.error(`[test-suites] 套件 ${label} ${elapsed}s 结束，退出码 ${finalCode}`);
process.exitCode = finalCode;
