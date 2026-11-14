#!/usr/bin/env node
/**
 * pnpm check:changed —— 变更驱动的快速反馈门（补充而非替代 AGENTS §5 分档必跑与合并 test:all）。
 *
 * 机制（保守可靠，无缓存、无智能关联猜测）：
 *   1. 变更集 = merge-base(base, HEAD)..HEAD 提交差异 ∪ 工作区(暂存+未暂存) ∪ 未跟踪文件，
 *      git -z 解析（空格路径 / rename 新旧双侧 / 删除均如实纳入）；
 *      基线优先级 --base <ref> > 分支 upstream > origin/HEAD，都没有则显式报错要求 --base，
 *      绝不静默退化到 HEAD~1（会漏多 commit）。
 *   2. 受影响包 = 变更文件按 packages/<dir> 映射；包内非测试文件变更 → 该包 + 全部传递
 *      依赖它的包（workspace 依赖图反向闭包）；纯测试文件变更 → 仅该包；
 *      锁文件 / 根配置 / 测试基础设施（含 scripts 目录下全部 .mjs 源码）变更 → 全档。
 *   3. 命令计划见 lib/workspace-meta.mjs planCheckCommands：pnpm typecheck（含
 *      protocol/node build）→（选中 desktop 测试时）desktop dist build → 受影响包测试
 *      （显式文件列表交给 scripts/run-tests.mjs，复用其超时与进程树清理）。
 *
 * 用法（pnpm 传参需 -- 分隔符，脚本接受开头的字面 --，pnpm 会原样透传）：
 *   pnpm check:changed --                      # 自动基线（upstream / origin/HEAD）
 *   pnpm check:changed -- --base main          # 显式基线（推荐在无 upstream 的 worktree 分支使用）
 *   pnpm check:changed -- --list               # 只打印纳入文件/受影响包/将执行命令，不运行（--dry-run 同义）
 *
 * 退出码：0 通过（或无可跑项）；命令失败原样透传；用法/基线错误 2。
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
  console.error(`用法: pnpm check:changed -- [--base <ref>] [--list|--dry-run]
  --base <ref>    显式基线（commit/分支/tag），取其与 HEAD 的 merge-base
  --list          只打印选集（纳入文件 / 受影响包 / 将执行的命令），不执行
  --dry-run       --list 的同义别名
注意: 通过 pnpm 调用时必须用 -- 分隔参数（如 pnpm check:changed -- --base main --list），
      开头的字面 -- 会被本脚本忽略；直接 node scripts/check-changed.mjs 调用则无需 --。`);
}

function parseArgs(argv) {
  const opts = { base: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    // pnpm 透传的开头 -- 分隔符：仅跳过首参位置，其余位置 -- 按未知参数报错。
    if (a === '--' && i === 0) continue;
    if (a === '--base' && argv[i + 1]) {
      opts.base = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--base=')) {
      opts.base = a.slice('--base='.length);
    } else if (a === '--list' || a === '--dry-run') {
      opts.list = true;
    } else {
      console.error(`[check-changed] 未知参数: ${a}`);
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

// ---- 报告（--list 与真实执行共用同一份选集说明，供复核）----
const kindLabel = { explicit: '显式 --base', upstream: '分支 upstream', 'origin-head': 'origin/HEAD' };
const ahead = commitsAhead(repoRoot, changes.baseline.mergeBase);
console.error(
  `[check-changed] 基线: ${kindLabel[changes.baseline.kind]} ${changes.baseline.ref}` +
    `（merge-base ${shortRev(repoRoot, changes.baseline.mergeBase)}，HEAD 领先 ${ahead} 个提交）`,
);
console.error(
  `[check-changed] 变更文件 ${changes.files.length} 个` +
    `（已提交 ${changes.files.filter((f) => f.origin.includes('committed')).length}` +
    ` / 工作区 ${changes.files.filter((f) => f.origin.includes('worktree')).length}` +
    ` / 未跟踪 ${changes.files.filter((f) => f.origin === 'untracked').length}）:`,
);
for (const f of changes.files.slice(0, 60)) {
  console.error(`  ${f.status.padEnd(5)} ${f.path}  (${f.origin})`);
}
if (changes.files.length > 60) console.error(`  …（其余 ${changes.files.length - 60} 个略）`);
if (outside.length > 0) {
  console.error(`[check-changed] 非包内变更 ${outside.length} 个（docs 等，不触发测试选集）`);
}

const tierOf = (dir) => PACKAGE_TIERS[dir] ?? '未分档';
console.error(
  `[check-changed] 受影响包${fullTier ? '（根级触发 → 全档）' : ''}: ` +
    (affectedDirs.length > 0
      ? affectedDirs.map((d) => `${d}(${tierOf(d)})`).join(', ')
      : '无') +
    (fullTier ? '' : `；测试文件 ${testFiles.length} 个`),
);

const commands = planCheckCommands({
  affectedDirs,
  testFiles,
  pm: resolvePackageManagerInvoke(),
  execPath: process.execPath,
  repoRoot,
});

console.error('[check-changed] 将执行:');
if (commands.length === 0) {
  console.error('  （无——变更不涉及任何包内文件，typecheck 与测试均跳过）');
} else {
  for (const c of commands) console.error(`  ${c.cmd} ${c.args.join(' ')}`);
}

if (args.list) {
  console.error('[check-changed] --list 模式：只打印选集，未执行任何命令');
  process.exit(0);
}
if (commands.length === 0) {
  console.error('[check-changed] 无可执行检查，通过（注意：这只是快速门，AGENTS §5 分档必跑规则不受影响）');
  process.exit(0);
}

const code = await runSequentially(commands, { cwd: repoRoot });
console.error(
  code === 0
    ? '[check-changed] 快速门通过（补充性反馈：合并前仍须按 AGENTS §5 跑对应档位与 test:all）'
    : `[check-changed] 快速门失败，退出码 ${code}`,
);
process.exit(code);
