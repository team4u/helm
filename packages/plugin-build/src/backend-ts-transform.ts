/**
 * Backend TypeScript transpilation implementation (`PluginBuildProvider.transformBackendTs`).
 *
 * Semantics match esbuild `transformSync` directly:
 * `.ts`/`.mts`/`.cts` -> loader `'ts'`, `.tsx` -> loader `'tsx'`, automatic JSX runtime,
 * ESM output, target `node20`, and `sourcefile` pointing to the real source file for diagnostics.
 *
 * Syntax errors propagate verbatim (preserving esbuild's `errors[].location`), and the kernel
 * loader hook wraps them into `HelmxError('plugin_load_failed')` without discarding diagnostics.
 */
import { transformSync } from 'esbuild';
import type { PluginBackendTsTransform } from '@helmx/protocol';

export function transformBackendTs(input: PluginBackendTsTransform): string {
  return transformSync(input.source, {
    loader: input.kind,
    jsx: 'automatic',
    format: 'esm',
    sourcefile: input.file,
    target: 'node20',
  }).code;
}
