/**
 * @helm/plugin-build —— 插件构建端口（PluginBuildProvider）的默认实现。
 *
 * 由产品组合根（hub）显式注入内核 PluginHost（PluginHostOptions.buildProvider）；
 * 本包只依赖 @helm/protocol 契约与 esbuild，不反向依赖 kernel / hub / web。
 *
 * 能力：
 * - compileClientModule：client.tsx -> 浏览器 ESM 产物（共享依赖 shim、CSS、
 *   受控 npm 依赖、代码分割、内容 hash 缓存、gzip 预压缩；实现见 client-compiler.ts）；
 * - transformBackendTs：外部插件后端 TS 源 -> ESM（module hooks 底座的转译函数）。
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
// 测试专用入口：Node 进程内执行编译产物时显式安装 chunk 桥（生产编译路径不改写 globalThis）
export { installNodeChunkBridge } from './node-chunk-bridge.js';

/** 构造默认插件构建端口（client 编译 + 后端 TS 转译；同一 esbuild 实例）。 */
export function createPluginBuildProvider(): PluginBuildProvider {
  return {
    compileClientModule: (request) =>
      compilePluginClientModule(request.pluginId, request.clientRoot, request.moduleRef, request.cacheDir, {
        ...(request.npmRoots.length > 0 ? { npmRoots: request.npmRoots } : {}),
      }),
    transformBackendTs,
  };
}
