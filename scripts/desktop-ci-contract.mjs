#!/usr/bin/env node
/**
 * packages/desktop（未来 Electron 桌面版）CI 契约检查，供 .github/workflows/desktop-ci.yml
 * 调用，也可本地直接执行。
 *
 * 为什么存在：desktop 包尚未落地，Desktop CI 需要在它缺失时按设计跳过、在它落地后立即
 * 参与全平台验证。两件事都依赖对 packages/desktop 的真实探测，且不能静默降级：
 *   - 根 `pnpm build`（pnpm -r build）会静默跳过没有 build 脚本的包——desktop 缺 build
 *     时 workspace 构建看起来全绿但 Electron 产物缺位，必须在此显式拦截并给出诊断；
 *   - desktop 自有 test 脚本是否存在，决定 Linux 上是否需要 xvfb-run 包裹执行（Electron
 *     冒烟需要虚拟显示），workflow 据此条件编排，不虚构脚本。
 *
 * 用法：
 *   node scripts/desktop-ci-contract.mjs --detect
 *     仅探测：stdout 只输出 true/false（供 workflow 捕获），人读说明走 stderr，恒退出 0。
 *   node scripts/desktop-ci-contract.mjs [--github-output <file>]
 *     全量契约检查：违规打印诊断并退出 2；指定 <file>（即 $GITHUB_OUTPUT）时追加
 *     desktop_name / desktop_has_test 机器可读输出，供后续步骤做条件执行。
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'packages', 'desktop');
const pkgPath = path.join(desktopDir, 'package.json');
const TEST_SUFFIXES = ['.test.ts', '.test.tsx'];

const args = process.argv.slice(2);
const detectOnly = args.includes('--detect');
const outputFlagIdx = args.indexOf('--github-output');
const outputPath = outputFlagIdx !== -1 ? args[outputFlagIdx + 1] : undefined;

function fail(message) {
  console.error(`[desktop-ci] 契约违规：${message}`);
  process.exit(2);
}

function note(message) {
  console.error(`[desktop-ci] 提示：${message}`);
}

// 以 package.json 为准判定包是否存在：空目录或残缺目录不算包，避免误启用矩阵。
const desktopExists = existsSync(pkgPath);

if (detectOnly) {
  if (desktopExists) {
    console.error('[desktop-ci] 检测到 packages/desktop，Desktop CI 全平台矩阵将启用。');
  } else {
    console.error('[desktop-ci] 未检测到 packages/desktop/package.json，desktop 矩阵任务将按设计跳过（不阻塞合并）。');
  }
  console.log(desktopExists ? 'true' : 'false');
  process.exit(0);
}

if (!desktopExists) {
  // 走到这里说明 workflow 门控（--detect）与本步结果不一致，属于编排错误而非可降级场景。
  fail(`packages/desktop/package.json 不存在，但全量契约检查被要求执行——desktop-ci.yml 的条件编排不一致，请检查 gate 与矩阵任务的 if 条件。探测路径：${pkgPath}`);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (err) {
  fail(`packages/desktop/package.json 读取/解析失败：${err.message}`);
}

const problems = [];
if (typeof pkg.name !== 'string' || pkg.name.length === 0) {
  problems.push('package.json 缺少 name 字段（pnpm workspace 的过滤与递归调度都依赖包名）。');
}

const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
if (typeof scripts.build !== 'string' || scripts.build.length === 0) {
  problems.push(
    'package.json 未声明 scripts.build：根 pnpm build（pnpm -r build）会静默跳过无 build 脚本的包，' +
      'Electron 产物缺位不会在 workspace 构建中报错；请为 desktop 包补齐 build 脚本。',
  );
}
const hasTest = typeof scripts.test === 'string' && scripts.test.length > 0;
if (!hasTest) {
  note('package.json 未声明 scripts.test：desktop 自有测试不单独执行（workspace 套件仍覆盖已登记的包）。');
}

// 警告级：test 文件已存在但未登记 SUITES 时，scripts/test-suites.mjs 的不变量会让
// test:unit / test:all 显式失败，这里提前点明原因，避免到测试步骤才发现。
const testDir = path.join(desktopDir, 'test');
if (existsSync(testDir)) {
  const hasTestFiles = readdirSync(testDir).some((f) => TEST_SUFFIXES.some((s) => f.endsWith(s)));
  if (hasTestFiles) {
    const suitesSrc = readFileSync(path.join(repoRoot, 'scripts', 'test-suites.mjs'), 'utf8');
    if (!/['"]desktop['"]/.test(suitesSrc)) {
      note(
        'packages/desktop/test 已有测试文件，但 scripts/test-suites.mjs 的 SUITES 尚未登记 desktop 分档；' +
          'test:unit / test:all 将因套件不变量显式失败（设计内行为），请先登记 SUITES。',
      );
    }
  }
}

// 警告级：根 typecheck 只覆盖 tsconfig.check.json 的 include，desktop 源码未纳入时
// 本工作流的 typecheck 步骤对 desktop 不生效，避免“全绿”假象。
const checkTsconfig = readFileSync(path.join(repoRoot, 'tsconfig.check.json'), 'utf8');
if (!checkTsconfig.includes('packages/desktop')) {
  note('tsconfig.check.json 尚未纳入 packages/desktop：根 pnpm typecheck 不会检查 desktop 源码，请在落地时补齐 include。');
}

for (const p of problems) fail(p);

if (outputPath) {
  appendFileSync(outputPath, `desktop_name=${pkg.name}\n`);
  appendFileSync(outputPath, `desktop_has_test=${hasTest}\n`);
}
console.error(`[desktop-ci] packages/desktop（${pkg.name}）契约检查通过。`);
process.exit(0);
