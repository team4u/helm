#!/usr/bin/env node
/**
 * pnpm check:hygiene —— 测试卫生静态检查（TypeScript Compiler API，零新依赖）。
 *
 * 规则见 scripts/lib/test-hygiene.mjs 头注释：
 *   timeout-missing / skip-without-reason / suite-timeout-env（AGENTS §5）。
 * 存量违规不做基线豁免——如实逐条报告并以退出码 1 失败；修一个少一个。
 *
 * 用法（pnpm 传参需 -- 分隔符，脚本接受并跳过开头的字面 --，pnpm 会原样透传）：
 *   pnpm check:hygiene                       # 全仓所有包 test 目录下的 *.test.ts / *.test.tsx
 *   pnpm check:hygiene -- --changed          # 仅检查变更集内的测试文件（基线同 check-changed）
 *   pnpm check:hygiene -- --changed --base main
 *   pnpm check:hygiene -- --files <path...>  # 显式指定文件（必须位于本仓库内，拒绝仓库外路径）
 *
 * 退出码：0 干净；1 存在违规；2 用法/基线错误。不注入任何 HELM_* 环境变量。
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectChangedFiles, GitChangeError } from './lib/git-changes.mjs';
import { analyzeTestSource, collectAllTestFiles, isTestFilePath } from './lib/test-hygiene.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(`用法: node scripts/check-test-hygiene.mjs [--changed [--base <ref>]] [--files <path...>]
  （缺省）        检查全仓测试文件
  --changed      只检查变更集（提交 ∪ 工作区 ∪ 未跟踪）内的测试文件
  --base <ref>   仅配合 --changed 指定基线，语义同 check-changed
  --files p...   显式指定要检查的文件（必须位于本仓库内，相对或绝对路径均可；拒绝仓库外路径）
注意: 通过 pnpm 调用时必须用 -- 分隔参数（如 pnpm check:hygiene -- --files x.test.ts），
      开头的字面 -- 会被本脚本忽略；直接 node scripts/check-test-hygiene.mjs 调用则无需 --。`);
}

const argv = process.argv.slice(2);
const opts = { changed: false, base: null, files: [] };
let filesRequested = false;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  // pnpm 透传的开头 -- 分隔符：仅跳过首参位置，其余位置 -- 按未知参数报错。
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
  console.error('[check-hygiene] --base 仅可与 --changed 搭配使用');
  usage();
  process.exit(2);
}

// 范围解析：全仓 / 变更集 / 显式文件列表（拒绝仓库外路径，绝不静默检查其他仓库）。
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
  scopeLabel = `显式 ${files.length} 个文件`;
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
  scopeLabel = `变更集 ${files.length} 个测试文件（基线 ${changes.baseline.ref}）`;
} else {
  files = collectAllTestFiles(repoRoot);
  scopeLabel = `全仓 ${files.length} 个测试文件`;
}

console.error(`[check-hygiene] 范围: ${scopeLabel}`);

// typescript 由仓库根 devDependency 提供，createRequire 锚定仓库根解析。
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
    console.error(`[check-hygiene] 无法读取 ${rel}: ${err.message}`);
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
  `[check-hygiene] 统计: test/it ${totals.testCalls}（skip ${totals.skipCalls}、todo ${totals.todoCalls}）；` +
    `t.test 子测试 ${totals.subtestCalls} 处不在本规则覆盖内（继承 runner 20s 默认超时，需人工评估是否收紧）`,
);
if (allViolations.length > 0) {
  console.error(`[check-hygiene] 违规 ${allViolations.length} 处（${ruleSummary}），退出 1`);
  process.exit(1);
}
console.error('[check-hygiene] 干净，退出 0');
process.exit(0);
