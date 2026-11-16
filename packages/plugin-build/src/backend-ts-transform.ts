/**
 * backend TS transpile implement (PluginBuildProvider.transformBackendTs).
 *
 * semantics and original kernel backend-ts-loader inline esbuild transformSync fully consistent:
 * .ts/.mts/.cts -> loader 'ts',.tsx -> loader 'tsx',jsx automatic,
 * format esm,target node20,sourcefile points to real source file (diagnose locate).
 *
 * transpile error original on throw (esbuild error object carries errors[].location), by kernel load hook
 * wrap is HelmError('plugin_load_failed')- - this layer does not second wrap, keep diagnose complete.
 */
import { transformSync } from 'esbuild';
import type { PluginBackendTsTransform } from '@helm/protocol';

export function transformBackendTs(input: PluginBackendTsTransform): string {
  return transformSync(input.source, {
    loader: input.kind,
    jsx: 'automatic',
    format: 'esm',
    sourcefile: input.file,
    target: 'node20',
  }).code;
}
