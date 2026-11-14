/**
 * 后端 TS 转译实现（PluginBuildProvider.transformBackendTs）。
 *
 * 语义与原内核 backend-ts-loader 内联的 esbuild transformSync 完全一致：
 * .ts/.mts/.cts -> loader 'ts'，.tsx -> loader 'tsx'，jsx automatic、
 * format esm、target node20、sourcefile 指向真实源文件（诊断定位）。
 *
 * 转译错误原样上抛（esbuild 错误对象带 errors[].location），由内核加载钩子
 * 包装为 HelmError('plugin_load_failed')——本层不做二次包装，保持诊断完整。
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
