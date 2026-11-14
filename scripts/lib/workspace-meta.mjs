/**
 * Workspace 包图与「变更文件 → 受影响测试包」保守映射。
 *
 * 原则：宁可多跑不可漏跑。包内非测试文件变更 → 该包 + 全部（传递）依赖它的包的测试
 * （基于各 packages/<pkg>/package.json 的 dependencies/devDependencies 里 @helm/* workspace
 * 边做反向闭包）；纯测试文件变更 → 仅该包（其他包代码未变）。锁文件、根 tsconfig、
 * 测试基础设施（run-tests / test-suites）变更影响全局 → 全档。
 *
 * PACKAGE_TIERS 只用于展示包属于哪一档，与 scripts/test-suites.mjs 的 SUITES 镜像同步
 * （由 packages/cli/test/check-changed.test.ts 锁定，改 SUITES 分档必须同步这里）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 根级「影响全局」触发文件（相对仓库根的精确路径）。 */
export const FULL_TIER_TRIGGERS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.check.json',
  'scripts/run-tests.mjs',
  'scripts/test-suites.mjs',
]);
/** 与 scripts/test-suites.mjs 的 SUITES 镜像：包目录 → 档位（仅用于报告展示）。 */
export const PACKAGE_TIERS = {
  protocol: 'unit',
  cli: 'unit',
  web: 'unit',
  kernel: 'integration',
  node: 'integration',
  payload: 'integration',
  desktop: 'integration',
};

export const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

/**
 * @typedef {{ name: string, dir: string, workspaceDeps: string[] }} WorkspacePackage
 */

/** 读取 packages/ 下全部包及其 @helm/* workspace 依赖边。 */
export function loadWorkspacePackages(repoRoot) {
  const packagesDir = path.join(repoRoot, 'packages');
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pkgs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(path.join(packagesDir, e.name, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const deps = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const workspaceDeps = [...deps].filter((d) => d.startsWith('@helm/'));
    pkgs.push({ name: pkg.name ?? e.name, dir: e.name, workspaceDeps });
  }
  pkgs.sort((a, b) => a.dir.localeCompare(b.dir));
  return pkgs;
}

/**
 * 反向闭包：seed 包自身 + 全部（传递）依赖 seed 的包。依赖边按包名解析到目录。
 * @param {string[]} seedDirs
 * @param {WorkspacePackage[]} pkgs
 * @returns {Set<string>} 包目录集合
 */
export function reverseClosure(seedDirs, pkgs) {
  const byName = new Map(pkgs.map((p) => [p.name, p.dir]));
  // dependents: dir -> 依赖它的 dir 列表（依赖方向 pkg -> dep，反向即 dep 被谁用）。
  const dependents = new Map(pkgs.map((p) => [p.dir, []]));
  for (const p of pkgs) {
    for (const depName of p.workspaceDeps) {
      const depDir = byName.get(depName);
      if (depDir && depDir !== p.dir) dependents.get(depDir)?.push(p.dir);
    }
  }
  const affected = new Set();
  const queue = [...seedDirs];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (affected.has(cur)) continue;
    affected.add(cur);
    for (const d of dependents.get(cur) ?? []) {
      if (!affected.has(d)) queue.push(d);
    }
  }
  return affected;
}

/**
 * 单个文件分类。
 * scripts/ 下可执行源码（.mjs，含 lib/）直接构成构建/测试/验证基础设施，
 * 变更即触发全档（单改快速门自身实现不能「无检查通过」）；纯文档（.md 等）不触发。
 * @param {string} file 相对仓库根路径（正斜杠）
 * @returns {{ pkg: string | null, kind: 'test' | 'source' | 'root-trigger' | 'outside' }}
 */
export function classifyChange(file) {
  if (FULL_TIER_TRIGGERS.has(file)) return { pkg: null, kind: 'root-trigger' };
  if (file.startsWith('scripts/') && file.endsWith('.mjs')) {
    return { pkg: null, kind: 'root-trigger' };
  }
  const m = /^packages\/([^/]+)\/(.*)$/.exec(file);
  if (!m) return { pkg: null, kind: 'outside' };
  const rest = m[2];
  const isTest = rest.startsWith('test/') && TEST_SUFFIXES.some((s) => rest.endsWith(s));
  return { pkg: m[1], kind: isTest ? 'test' : 'source' };
}

/**
 * 计算受影响测试包。
 * @param {string[]} files 相对仓库根的变更文件列表
 * @param {WorkspacePackage[]} pkgs
 * @returns {{ affected: Set<string>, fullTier: boolean, outside: string[] }}
 */
export function computeAffectedPackages(files, pkgs) {
  const allDirs = new Set(pkgs.map((p) => p.dir));
  let fullTier = false;
  const testOnly = new Set();
  const source = new Set();
  const outside = [];
  for (const f of files) {
    const c = classifyChange(f);
    if (c.kind === 'root-trigger') {
      fullTier = true;
    } else if (c.kind === 'outside') {
      outside.push(f);
    } else if (c.pkg && allDirs.has(c.pkg)) {
      if (c.kind === 'test') testOnly.add(c.pkg);
      else source.add(c.pkg);
    } else if (c.pkg) {
      // packages/ 下未登记的目录：保守并入 source 会在闭包里被 allDirs 过滤掉，
      // 这里按未知包直接升级为全档，绝不静默丢弃。
      fullTier = true;
    }
  }
  if (fullTier) return { affected: new Set(allDirs), fullTier: true, outside: outside.sort() };
  const affected = reverseClosure([...source], pkgs);
  for (const p of testOnly) affected.add(p);
  return { affected, fullTier: false, outside: outside.sort() };
}

/** 枚举某包 test/ 目录下全部测试文件（与 test-suites.mjs 相同的枚举规则）。 */
export function testFilesOfPackage(repoRoot, pkgDir) {
  const dir = path.join(repoRoot, 'packages', pkgDir, 'test');
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && TEST_SUFFIXES.some((s) => e.name.endsWith(s)))
    .map((e) => `packages/${pkgDir}/test/${e.name}`)
    .sort();
}

/**
 * 快速门命令计划（纯函数，供 CLI 执行与 --list 复核共用）：
 *   1. 任一受影响包 → pnpm typecheck（会先 build protocol+node，是测试的类型/运行前置）；
 *   2. 选中 desktop 测试 → 先 pnpm --filter @helm/desktop run build（typecheck 不产
 *      packages/desktop/dist/hub-child.js，冷工作树不补建则 desktop 测试必败，且改
 *      hub-child 源码可能测到旧 dist）；
 *   3. 有测试文件 → node scripts/run-tests.mjs <files...>（复用跨平台超时与进程树清理）。
 * @param {{ affectedDirs: string[], testFiles: string[], pm: { cmd: string, args: string[] }, execPath: string, repoRoot: string }} input
 * @returns {Array<{ cmd: string, args: string[], label: string }>}
 */
export function planCheckCommands({ affectedDirs, testFiles, pm, execPath, repoRoot }) {
  const commands = [];
  if (affectedDirs.length > 0) {
    commands.push({
      cmd: pm.cmd,
      args: [...pm.args, 'typecheck'],
      label: 'pnpm typecheck（含 protocol/node build）',
    });
  }
  if (testFiles.some((f) => f.startsWith('packages/desktop/test/'))) {
    commands.push({
      cmd: pm.cmd,
      args: [...pm.args, '--filter', '@helm/desktop', 'run', 'build'],
      label: 'pnpm --filter @helm/desktop run build（desktop 测试前置：typecheck 不产 dist）',
    });
  }
  if (testFiles.length > 0) {
    commands.push({
      cmd: execPath,
      args: [path.join(repoRoot, 'scripts', 'run-tests.mjs'), ...testFiles],
      label: `run-tests（${testFiles.length} 个测试文件）`,
    });
  }
  return commands;
}
