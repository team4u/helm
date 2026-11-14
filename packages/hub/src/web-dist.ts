/**
 * Hub 产品层的 Web 静态目录解析策略。
 *
 * Why 独立模块：内核 createHubHandler/startHub 只接受显式 webDistDir（缺省纯
 * API，不硬编码 Web 包位置）；「默认目录在哪」是 hub 产品策略，随 hub 入口
 * 自身位置而定，集中在此可测试。
 *
 * 布局约定（src 与 dist 下同构，均上溯两级到 payload/仓库的包并列层）：
 * - 仓库开发：packages/hub/{src,dist}/main.ts → packages/web/dist；
 * - npm payload：<payload>/hub/dist/main.js → <payload>/web/dist（web 与 hub 同级）。
 * 目录内必须有 index.html 才视为有效（未构建不伪装静态站点）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 探测 <entryDir>/../../web/dist；存在 index.html 时返回该目录，否则 undefined（纯 API 形态）。 */
export function resolveHubWebDistDir(entryDir: string): string | undefined {
  const distDir = join(entryDir, '..', '..', 'web', 'dist');
  return existsSync(join(distDir, 'index.html')) ? distDir : undefined;
}

/** 解析 HELM_WEB_DIST_DIR：显式目录优先；'false'/'0'/'' 显式禁用；未设置走 resolveHubWebDistDir。 */
export function resolveWebDistOption(
  env: string | undefined,
  entryDir: string,
): { webDistDir: string | false | undefined } {
  if (env === undefined) return { webDistDir: resolveHubWebDistDir(entryDir) };
  if (env === 'false' || env === '0' || env === '') return { webDistDir: false };
  return { webDistDir: env };
}
