/**
 * CLI 自身入口路径解析：后台 spawn 与升级候选的「固定 launcher」入口定位，
 * 以及 service install 必须使用的编译产物（dist/cli.js）入口解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { UsageError } from './cli-context.js';

/**
 * CLI 自身入口（源码模式为 src/cli.ts；编译后按包结构回退 dist/cli.js）。
 * 注意：不能引用本模块的 import.meta.url（那是 service-entry.ts 自身）——
 * 直接按「本模块位于 src/ 下、与 cli.ts 同目录」的包结构定位。
 */
export function cliSelfEntry(): string {
  const self = path.resolve(fileURLToPath(import.meta.url));
  const cli = path.resolve(path.dirname(self), 'cli.ts');
  if (fs.existsSync(cli)) return cli;
  return path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
}

/**
 * service install 入口：开机服务无 tsx loader，必须使用编译产物 dist/cli.js。
 * - 以编译产物运行：返回自身；
 * - 以源码入口运行：返回同包 dist/cli.js（须已存在）；
 * - 源码运行且无编译产物：显式报错（不生成无法启动的服务）。
 */
export function resolveServiceEntry(selfPath: string = fileURLToPath(import.meta.url)): string {
  const self = path.resolve(selfPath);
  if (self.endsWith(path.join('dist', 'cli.js'))) return self;
  const distEntry = path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
  try {
    return realpathSync(distEntry);
  } catch {
    throw new UsageError(
      `服务入口必须使用编译产物（期望 ${distEntry}）：当前以源码入口运行且未找到编译产物；请先在仓库根执行 pnpm build 再安装服务`,
      'missing_build',
    );
  }
}
