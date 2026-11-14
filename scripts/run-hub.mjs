#!/usr/bin/env node
/**
 * 开发期 Hub 启动器：tsx 直跑 packages/hub/src/main.ts 源码。
 *
 * Why 存在：hub 源码以包名导入 @helm/kernel / @helm/plugins；tsx 运行期必须经
 * tsconfig.dev.json 的 paths 把两者解析到源码，与仓库「dev/test 一律跑源码」的
 * 单模块身份约定一致（dist 与 source 双身份会让 instanceof 错误映射成 500 等
 * 静默错乱）。npm scripts 内联环境变量不跨平台，故由本脚本统一注入并 spawn。
 * 构建产物（hub dist）不受影响：tsc 不应用 dev paths，包名导入照常落 dist。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const require = createRequire(path.join(repoRoot, 'package.json'));
const pkgPath = require.resolve('tsx/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsx;
const tsxCli = path.resolve(path.dirname(pkgPath), bin ?? 'dist/cli.mjs');
if (!existsSync(tsxCli)) {
  console.error(`[run-hub] 未找到本地 tsx CLI: ${tsxCli}（请先 pnpm install）`);
  process.exit(1);
}

const childEnv = { ...process.env };
if (childEnv.TSX_TSCONFIG_PATH === undefined) {
  childEnv.TSX_TSCONFIG_PATH = path.join(repoRoot, 'tsconfig.dev.json');
}

const child = spawn(process.execPath, [tsxCli, path.join(repoRoot, 'packages/hub/src/main.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: childEnv,
  cwd: process.cwd(),
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
child.on('error', (err) => {
  console.error(`[run-hub] 启动失败: ${err.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
