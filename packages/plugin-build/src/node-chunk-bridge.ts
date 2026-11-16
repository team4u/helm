/**
 * Node test environment dedicated use chunk bridge (test dedicated use entry, produce compile path never change write globalThis).
 *
 * is what store in: produce browser by Web load (web/src/lib/plugin-client.ts) in page side install
 * globalThis.__helm_import_chunk(HTTP pull chunk);Hub produce process only compile, never execute
 * artifact. need to in the same Node process inside compile and execute artifact test (such as plugins/test package
 * and mermaid end-to-end case) explicit invoke installNodeChunkBridge(cacheDirs) install Node edition
 * bridge: by (pluginId, moduleRef, contentHash) from to set cacheDir set push lead staging 
 * path (and compiler the same naming contract), via data: URL motion state import seek value. do not install when artifact in
 * __helm_import_chunk invoke will explicit ReferenceError, never static default fall back.
 *
 * semantics: duplicate invoke whole replace (contains find path and already seek value cache), test on demand switch cacheDir set.
 */
import { join } from 'node:path';
import { HelmError } from '@helm/protocol';
import { readCachedChunk, safeDirName, safeFileName } from './client-compiler.js';

/**
 * install Node edition chunk bridge:
 * - __helm_node_chunk_lookup: by cacheDirs order find first hit chunk text (Web
 *   load in Node environment fall back channel same this contract);
 * - __helm_import_chunk: compile artifact motion state import runtime entry (preload by order first seek value,
 *   the same chunk seek value dedupe).
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
      throw new HelmError('client_chunk_not_found', `Node environment under not found chunk ${chunkName}(plugin ${pluginId})`, 404);
    }
    const dataUrl = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
    return (await import(/* @vite-ignore */ dataUrl)) as Record<string, unknown>;
  })();
  cache.set(key, run);
  return run;
}
