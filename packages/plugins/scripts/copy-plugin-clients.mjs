#!/usr/bin/env node
/**
 * 构建资产补齐：把 src/<name>/client 目录复制到 dist 同位置。
 *
 * Why：tsc 只编译 TS 且排除 client 目录（纯资产：client.tsx 入口 + 随附文件），
 * 运行期各插件的 resolveClientRoot 只认 <plugin>/client 与包内 src 回退两处；
 * dist 单独部署（helm-hub bin / payload / 桌面壳子进程）时缺该目录会在
 * createHelm 即刻抛 <plugin>_client_missing。幂等，重复执行无副作用。
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcPlugins = join(pkgRoot, 'src');
const distPlugins = join(pkgRoot, 'dist');

if (!existsSync(distPlugins)) {
  console.error(`[plugins] 缺少 ${distPlugins}，请先执行 tsc 编译`);
  process.exit(1);
}

let copied = 0;
for (const entry of readdirSync(srcPlugins, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const clientSrc = join(srcPlugins, entry.name, 'client');
  if (!existsSync(clientSrc)) continue;
  cpSync(clientSrc, join(distPlugins, entry.name, 'client'), { recursive: true });
  copied += 1;
}
console.log(`[plugins] 已复制 ${copied} 个插件 client 目录到 dist`);
