#!/usr/bin/env node
/**
 * 测试分层入口：unit / integration / all 三档套件，供 package.json 脚本调用。
 *
 * 为什么存在：`pnpm test` 是一把梭全量（约 1 分钟），本地迭代需要一档更快的纯单元反馈；
 * 而 kernel / node 包的测试大量起真实子进程、开 SQLite、建 Git worktree、跑 WebSocket
 * 与 @helm/node daemon，不是纯单元。为避免误分类，本脚本只做【保守包级切分】：
 *
 *   unit        = protocol + cli + web（含 web 的 happy-dom/React 交互测试，
 *                 属进程内 DOM 模拟，不起真实服务）；
 *   integration = kernel + node（全部文件，整体视为集成，含真实进程/SQLite/Git/daemon）；
 *   all         = unit ∪ integration = 全部测试文件，等价于旧 `pnpm test`。
 *
 * 实现：Node fs 按 <root>/packages/<pkg>/test/ 目录枚举 *.test.ts(x)，显式传文件列表给
 * scripts/run-tests.mjs（复用其跨平台 tsx spawn、20s 单测超时、10min 总超时与进程树清理），
 * 不用 shell glob（Windows cmd 不展开 glob），不重复造进程管理。
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
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');

// 套件 → 包名。切分原则见文件头注释；调整分档时必须同步更新 AGENTS.md 的测试分层约定。
const SUITES = {
  unit: ['protocol', 'cli', 'web'],
  integration: ['kernel', 'node'],
};
const ALL_PACKAGES = [...SUITES.unit, ...SUITES.integration];

const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

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
const extraArgs = process.argv.slice(3);

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

// 复用 run-tests.mjs：跨平台 tsx spawn、单测/总超时与进程树清理都在那边，绝不重复实现。
const child = spawn(
  process.execPath,
  [path.join(repoRoot, 'scripts', 'run-tests.mjs'), ...files, ...extraArgs],
  { stdio: 'inherit', env: process.env, cwd: repoRoot },
);

// 异步等待子进程，保留 Ctrl+C / SIGTERM 的及时转发能力。
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
child.on('error', (err) => {
  console.error(`[test-suites] 启动 run-tests.mjs 失败: ${err.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
