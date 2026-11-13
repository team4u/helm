#!/usr/bin/env node
/**
 * 桌面安装包 Hub payload 组装：把仓库已构建产物组织到 packages/desktop/hub/
 * （electron-builder extraResources 的源目录，最终落在 <resources>/hub，asar 之外）。
 * 布局与 @helm/payload 一致：
 *
 *   hub/kernel/{package.json, dist/}   Hub 子进程入口 dist/main.js + 内置插件运行时资产
 *   hub/web/dist/                      Web 静态产物（与 kernel 同级，命中 hub.ts
 *                                      ../../../web/dist 默认探测，无需额外 env）
 *
 * 诚实边界（与 packages/payload/README「已知阻塞」一致，勿宣称自包含）：
 * - 不打包 node_modules：kernel dist 运行仍需 ws/esbuild/mermaid/@earendil-works/*
 *   等依赖可解析。安装包内 Hub 启动时若依赖缺失，supervisor 会如实报告子进程崩溃
 *   （ERR_MODULE_NOT_FOUND），绝不静默降级；vendored node_modules 是后续独立课题。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(pkgRoot, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const hubDir = path.join(desktopRoot, 'hub');

/** 内置插件运行时资产子目录（与 payload build.mjs 同一探测集合）。 */
const RUNTIME_ASSET_SUBDIRS = ['client', 'skill', 'assets'];

const inputs = [
  ['kernel dist 入口', path.join(repoRoot, 'packages/kernel/dist/main.js')],
  ['kernel dist HTTP 层', path.join(repoRoot, 'packages/kernel/dist/http/hub.js')],
  ['web dist 入口', path.join(repoRoot, 'packages/web/dist/index.html')],
  ['kernel package.json', path.join(repoRoot, 'packages/kernel/package.json')],
  ['kernel 内置插件资产源', path.join(repoRoot, 'packages/kernel/src/builtin-plugins')],
];

const missing = inputs.filter(([, p]) => !existsSync(p)).map(([label, p]) => `- ${label}: ${p}`);
if (missing.length > 0) {
  console.error(`[assemble-hub] 构建产物缺失，拒绝组装（请在仓库根执行 pnpm build 后重试）：\n${missing.join('\n')}`);
  process.exit(1);
}

// --- 组装（先清空重建，幂等） -------------------------------------------------------
rmSync(hubDir, { recursive: true, force: true });
mkdirSync(path.join(hubDir, 'kernel'), { recursive: true });

cpSync(path.join(repoRoot, 'packages/kernel/dist'), path.join(hubDir, 'kernel/dist'), { recursive: true });
cpSync(path.join(repoRoot, 'packages/kernel/package.json'), path.join(hubDir, 'kernel/package.json'));
cpSync(path.join(repoRoot, 'packages/web/dist'), path.join(hubDir, 'web/dist'), { recursive: true });

// 内置插件运行时资产：src/builtin-plugins/<name>/{client,skill,assets}
// → hub/kernel/dist/builtin-plugins/<name>/{...}（kernel build 已复制 client，
// skill/assets 在此补齐，保证 Hub 子进程脱离仓库 src 也可解析）。
const builtinSrc = path.join(repoRoot, 'packages/kernel/src/builtin-plugins');
const copiedAssets = [];
for (const ent of readdirSync(builtinSrc, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!ent.isDirectory()) continue;
  for (const sub of RUNTIME_ASSET_SUBDIRS) {
    const from = path.join(builtinSrc, ent.name, sub);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(hubDir, 'kernel/dist/builtin-plugins', ent.name, sub), { recursive: true });
    copiedAssets.push(`builtin-plugins/${ent.name}/${sub}`);
  }
}

console.log(`[assemble-hub] 组装完成: ${hubDir}`);
console.log(`[assemble-hub] 运行时资产目录 ${copiedAssets.length} 个: ${copiedAssets.join(', ')}`);
console.log('[assemble-hub] 注意: 未打包 node_modules（依赖自包含未解决）；安装包内 Hub 依赖缺失时将显式报错');
