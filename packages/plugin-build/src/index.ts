/**
 * @helm/plugin-build — default implementation of the plugin build port (`PluginBuildProvider`).
 *
 * Injected explicitly into the kernel `PluginHost` (`PluginHostOptions.buildProvider`) by the product
 * composition root (`@helm/hub`). Depends only on `@helm/protocol`, `@helm/env-io` (shared atomic
 * writes), and `esbuild`, with zero reverse dependency on `kernel`, `hub`, or `web`.
 *
 * Capabilities:
 * - `compileClientModule`: compiles `client.tsx` into browser ESM (shared dependency shims, CSS
 *   bundling, controlled npm dependencies, code splitting, content-hash disk/memory cache, pre-gzip);
 * - `buildPluginClientBundleDir`: compiles client entry modules into a static `dist-client/` directory
 *   with `manifest.json`, `.mjs`/`.js` bundles, and `.gz` artifacts;
 * - `transformBackendTs`: synchronously transpiles external plugin backend TypeScript to ESM.
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
export { buildPluginClientBundleDir } from './prebuilt-client.js';
// Test-only utility: installs the Node chunk bridge on `globalThis` when executing split bundles in Node.
export { installNodeChunkBridge } from './node-chunk-bridge.js';

/** Creates the default plugin build port (client compiler + backend TS transpiler). */
export function createPluginBuildProvider(): PluginBuildProvider {
  return {
    compileClientModule: (request) =>
      compilePluginClientModule(request.pluginId, request.clientRoot, request.moduleRef, request.cacheDir, {
        ...(request.npmRoots.length > 0 ? { npmRoots: request.npmRoots } : {}),
      }),
    transformBackendTs,
  };
}
