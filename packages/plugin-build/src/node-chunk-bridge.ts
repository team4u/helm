/**
 * Test-only Node chunk bridge (never loaded or mutated on production compilation paths).
 *
 * In the browser, `@helm/web`'s loader installs `globalThis.__helm_import_chunk` to fetch chunks
 * over HTTP; Hub only compiles artifacts and never executes them. Tests that compile and evaluate
 * split artifacts in the same Node process call `installNodeChunkBridge(dirs)` to install a Node
 * bridge that resolves chunks from either `plugin-staging` cache directories or prebuilt `dist-client`
 * directories (`manifest.json`), evaluating them via `data:` dynamic imports. When omitted, calling
 * `__helm_import_chunk` fails loudly with `ReferenceError` rather than silently falling back.
 *
 * Repeated calls replace the lookup roots and in-memory chunk cache wholesale.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HelmError,
  PREBUILT_CLIENT_MANIFEST_FILE,
  assertPrebuiltClientManifest,
  prebuiltChunkFileName,
} from '@helm/protocol';
import { readCachedChunk, safeDirName, safeFileName } from './client-compiler.js';

function readPrebuiltChunkFromDir(
  prebuiltDir: string,
  moduleRef: string,
  contentHash: string,
  chunkName: string,
): string | undefined {
  const manifestPath = join(prebuiltDir, PREBUILT_CLIENT_MANIFEST_FILE);
  if (!existsSync(manifestPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    const manifest = assertPrebuiltClientManifest(raw, prebuiltDir);
    const entry = Object.hasOwn(manifest.modules, moduleRef) ? manifest.modules[moduleRef] : undefined;
    if (!entry || entry.contentHash !== contentHash || !(entry.chunks ?? []).includes(chunkName)) {
      return undefined;
    }
    const chunkPath = join(prebuiltDir, prebuiltChunkFileName(entry.entryFile, chunkName));
    if (!existsSync(chunkPath)) return undefined;
    return readFileSync(chunkPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Installs the Node chunk bridge on `globalThis`:
 * - `__helm_node_chunk_lookup`: resolves chunk JS code across `dirs` in order (supports both
 *   `plugin-staging` cache dirs and prebuilt `dist-client` dirs);
 * - `__helm_import_chunk`: evaluates prerequisite chunks in topological order before importing
 *   the requested chunk, deduplicating concurrent/repeated loads.
 */
export function installNodeChunkBridge(dirs: readonly string[]): void {
  const roots = [...dirs];
  const g = globalThis as Record<string, unknown>;
  const lookup = (
    pluginId: string,
    moduleRef: string,
    contentHash: string,
    chunkName: string,
  ): string | undefined => {
    for (const dir of roots) {
      const staged = readCachedChunk(
        join(dir, 'plugin-staging', safeDirName(pluginId)),
        safeFileName(moduleRef),
        contentHash,
        chunkName,
      );
      if (staged !== undefined) return staged.code;
      const prebuilt = readPrebuiltChunkFromDir(dir, moduleRef, contentHash, chunkName);
      if (prebuilt !== undefined) return prebuilt;
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
      throw new HelmError(
        'client_chunk_not_found',
        `Chunk ${chunkName} for plugin ${pluginId} was not found in Node lookup directories`,
        404,
      );
    }
    const dataUrl = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
    return (await import(/* @vite-ignore */ dataUrl)) as Record<string, unknown>;
  })();
  cache.set(key, run);
  return run;
}
