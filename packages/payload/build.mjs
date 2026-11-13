#!/usr/bin/env node
/**
 * Hub npm payload 组装脚本（最小骨架）。
 *
 * 为什么存在：Electron 桌面薄壳要从公开 npm 拉取最新 Hub 内容并直接运行（不执行
 * npm install）。本脚本把仓库内已构建产物组织为一个自描述的可发布目录（dist/）：
 * kernel dist + 内置插件运行时资产（client/skill/assets，kernel 从 dist 侧同名目录探测）
 * + web dist（与 kernel 同级布局，命中 hub.ts 的 `../../../web/dist` 默认探测）
 * + cli dist + 零依赖启动入口 start.mjs + manifest.json（version/entry/checksum 契约）。
 *
 * 诚实边界（未解决，勿宣称自包含）：
 * - 本脚本不打包 node_modules。kernel dist 运行仍需 ws/esbuild/mermaid/@earendil-works/*
 *   等依赖可解析（start.mjs check 会显式报告缺失清单并退出码 3）；
 * - npm pack 不会把 node_modules 打进 tarball（bundleDependencies 路线受 pnpm workspace
 *   符号链接与 esbuild 平台原生二进制限制，见 README）。
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const payloadPkgRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(payloadPkgRoot, '../..');
const stagingDir = path.join(payloadPkgRoot, 'dist');

/** 内置插件运行时资产子目录：kernel 各插件解析器统一先探测 dist 侧同名目录。 */
const RUNTIME_ASSET_SUBDIRS = ['client', 'skill', 'assets'];

const inputs = [
  ['kernel dist 入口', path.join(repoRoot, 'packages/kernel/dist/main.js')],
  ['kernel dist HTTP 层', path.join(repoRoot, 'packages/kernel/dist/http/hub.js')],
  ['web dist 入口', path.join(repoRoot, 'packages/web/dist/index.html')],
  ['cli dist 入口', path.join(repoRoot, 'packages/cli/dist/index.js')],
  ['kernel package.json', path.join(repoRoot, 'packages/kernel/package.json')],
  ['kernel 内置插件资产源', path.join(repoRoot, 'packages/kernel/src/builtin-plugins')],
];

// 入口校验：一次性列全缺失项，绝不静默跳过（缺产物先跑仓库根 `pnpm build`）。
const missing = inputs.filter(([, p]) => !existsSync(p)).map(([label, p]) => `- ${label}: ${p}`);
if (missing.length > 0) {
  console.error(`[payload] 构建产物缺失，拒绝组装（请在仓库根执行 pnpm build 后重试）：\n${missing.join('\n')}`);
  process.exit(1);
}

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 统计目录内文件数与总字节数（组装摘要用）。 */
function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  const visit = (cur) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) visit(p);
      else {
        files += 1;
        bytes += readFileSync(p).length;
      }
    }
  };
  visit(dir);
  return { files, bytes };
}

// --- 组装（先清空重建，产物可重入） --------------------------------------------------
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

cpSync(path.join(repoRoot, 'packages/kernel/dist'), path.join(stagingDir, 'kernel/dist'), { recursive: true });
cpSync(path.join(repoRoot, 'packages/web/dist'), path.join(stagingDir, 'web/dist'), { recursive: true });
cpSync(path.join(repoRoot, 'packages/cli/dist'), path.join(stagingDir, 'cli/dist'), { recursive: true });
cpSync(path.join(repoRoot, 'packages/kernel/package.json'), path.join(stagingDir, 'kernel/package.json'));
cpSync(path.join(payloadPkgRoot, 'src/start.mjs'), path.join(stagingDir, 'start.mjs'));

// 内置插件运行时资产：src/builtin-plugins/<name>/{client,skill,assets}
// → dist/kernel/dist/builtin-plugins/<name>/{...}（各插件解析器的首选探测位）。
const builtinSrc = path.join(repoRoot, 'packages/kernel/src/builtin-plugins');
const copiedAssets = [];
for (const ent of readdirSync(builtinSrc, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!ent.isDirectory()) continue;
  for (const sub of RUNTIME_ASSET_SUBDIRS) {
    const from = path.join(builtinSrc, ent.name, sub);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(stagingDir, 'kernel/dist/builtin-plugins', ent.name, sub), { recursive: true });
    copiedAssets.push(`builtin-plugins/${ent.name}/${sub}`);
  }
}

// --- manifest（version / entry / checksum 契约；路径相对 payload 根，POSIX 分隔） ----
const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf-8'));
const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
const entries = {
  launcher: 'start.mjs',
  kernel: 'kernel/dist/main.js',
  kernelPackageJson: 'kernel/package.json',
  cli: 'cli/dist/index.js',
  webIndex: 'web/dist/index.html',
};
const manifest = {
  formatVersion: 1,
  name: payloadPkg.name,
  version: payloadPkg.version,
  builtAt: new Date().toISOString(),
  nodeEngines: rootPkg.engines?.node ?? 'unknown',
  entries,
  entryChecksums: Object.fromEntries(
    Object.entries(entries).map(([key, rel]) => [key, sha256Of(path.join(stagingDir, rel))]),
  ),
};
writeFileSync(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const stats = walkStats(stagingDir);
console.log(`[payload] 组装完成: ${stagingDir}`);
console.log(`[payload] 文件 ${stats.files} 个，共 ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB`);
console.log(`[payload] 运行时资产目录 ${copiedAssets.length} 个: ${copiedAssets.join(', ')}`);
console.log('[payload] 注意: 未打包 node_modules（自包含未解决）；start.mjs check 会显式报告缺失依赖');
