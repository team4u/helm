/**
 * @helm/plugin-build - - plugin build port (PluginBuildProvider) by default implement.
 *
 * by produce product composition root (hub) explicit inject kernel PluginHost(PluginHostOptions.buildProvider);
 * this package only dependency @helm/protocol contract and esbuild, do not reverse dependency kernel / hub / web.
 *
 * capability:
 * - compileClientModule:client.tsx -> browser ESM artifact (sharing dependency shim,CSS,
 *   subject to control npm dependency, code split, content hash cache,gzip pre- compress; implement see client-compiler.ts);
 * - transformBackendTs: external plugin backend TS source -> ESM(module hooks bottom seat transpile function).
 */
import type { PluginBuildProvider } from '@helm/protocol';
import { transformBackendTs } from './backend-ts-transform.js';
import { compilePluginClientModule } from './client-compiler.js';

export { transformBackendTs } from './backend-ts-transform.js';
export {
  compilePluginClientModule,
  clearClientCompilerMemoryCache,
  readCachedChunk,
  safeDirName,
  safeFileName,
  CLIENT_SHARED_EXTERNALS,
  CLIENT_SHARED_GLOBALS,
  type ClientCompileResult,
  type ClientNpmRoot,
} from './client-compiler.js';
// test dedicated use entry:Node process inside execute compile artifact when explicit install chunk bridge (produce compile path do not change write globalThis)
export { installNodeChunkBridge } from './node-chunk-bridge.js';

/** construct by default plugin build port (client compile + backend TS transpile; the same esbuild instance). */
export function createPluginBuildProvider(): PluginBuildProvider {
  return {
    compileClientModule: (request) =>
      compilePluginClientModule(request.pluginId, request.clientRoot, request.moduleRef, request.cacheDir, {
        ...(request.npmRoots.length > 0 ? { npmRoots: request.npmRoots } : {}),
      }),
    transformBackendTs,
  };
}
