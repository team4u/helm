/**
 * Node 测试环境专用 chunk 桥（测试专用入口，生产编译路径绝不改写 globalThis）。
 *
 * 为什么存在：生产浏览器由 Web 加载器（web/src/lib/plugin-client.ts）在页面侧安装
 * globalThis.__helm_import_chunk（HTTP 拉取 chunk）；Hub 生产进程只编译、从不执行
 * 产物。需要在同一 Node 进程内「编译并执行」产物的测试（如 plugins/test 的分包
 * 与 mermaid 端到端用例）显式调用 installNodeChunkBridge(cacheDirs) 安装 Node 版
 * 桥：按 (pluginId, moduleRef, contentHash) 从给定 cacheDir 集合推导 staging 落盘
 * 路径（与编译器同一命名契约），经 data: URL 动态 import 求值。不安装时产物中的
 * __helm_import_chunk 调用会显式 ReferenceError，绝不静默降级。
 *
 * 语义：重复调用整体替换（含查找路径与已求值缓存），测试按需切换 cacheDir 集合。
 */
import { join } from 'node:path';
import { HelmError } from '@helm/protocol';
import { readCachedChunk, safeDirName, safeFileName } from './client-compiler.js';

/**
 * 安装 Node 版 chunk 桥：
 * - __helm_node_chunk_lookup：按 cacheDirs 顺序查找首个命中的 chunk 文本（Web
 *   加载器在 Node 环境的兜底通道同此契约）；
 * - __helm_import_chunk：编译产物动态 import 的运行时入口（preload 按序先求值，
 *   同一 chunk 求值去重）。
 */
export function installNodeChunkBridge(cacheDirs: readonly string[]): void {
  const dirs = [...cacheDirs];
  const g = globalThis as Record<string, unknown>;
  const lookup = (
    pluginId: string,
    moduleRef: string,
    contentHash: string,
    chunkName: string,
  ): string | undefined => {
    for (const dir of dirs) {
      const res = readCachedChunk(
        join(dir, 'plugin-staging', safeDirName(pluginId)),
        safeFileName(moduleRef),
        contentHash,
        chunkName,
      );
      if (res !== undefined) return res.code;
    }
    return undefined;
  };
  g.__helm_node_chunk_lookup = lookup;
  const nodeChunkCache = new Map<string, Promise<Record<string, unknown>>>();
  g.__helm_import_chunk = async (
    pluginId: string,
    moduleRef: string,
    contentHash: string,
    chunkName: string,
    preloads: string[] = [],
  ): Promise<Record<string, unknown>> => {
    for (const p of preloads) {
      await loadSingleNodeChunk(lookup, pluginId, moduleRef, contentHash, p, nodeChunkCache);
    }
    return await loadSingleNodeChunk(lookup, pluginId, moduleRef, contentHash, chunkName, nodeChunkCache);
  };
}

async function loadSingleNodeChunk(
  lookup: (pluginId: string, moduleRef: string, contentHash: string, chunkName: string) => string | undefined,
  pluginId: string,
  moduleRef: string,
  contentHash: string,
  chunkName: string,
  cache: Map<string, Promise<Record<string, unknown>>>,
): Promise<Record<string, unknown>> {
  const key = `${pluginId}\0${moduleRef}\0${contentHash}\0${chunkName}`;
  const pending = cache.get(key);
  if (pending !== undefined) return pending;
  const run = (async () => {
    const code = lookup(pluginId, moduleRef, contentHash, chunkName);
    if (code === undefined) {
      throw new HelmError('client_chunk_not_found', `Node 环境下未找到 chunk ${chunkName}（插件 ${pluginId}）`, 404);
    }
    const dataUrl = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
    return (await import(/* @vite-ignore */ dataUrl)) as Record<string, unknown>;
  })();
  cache.set(key, run);
  return run;
}
