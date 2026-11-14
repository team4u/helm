/**
 * 插件构建端口契约（内核 PluginHost 与构建实现包之间的唯一接口）。
 *
 * 机制与策略分离：内核持有注册表 / 生命周期 / module hooks 等机制，编译与
 * 转译工具（esbuild）由外部 provider 实现并显式注入（产品组合在 hub 注入
 * 默认实现）。内核绝不静态或动态 import 构建实现包；本模块只含类型与
 * 纯函数，保持 protocol 零运行时重依赖与浏览器安全。
 */
import { HelmError } from './error.js';

/**
 * 受控 npm 依赖声明：specifiers 为允许的精确裸说明符（含子路径需逐项声明，
 * 不做前缀通配），packageRoot 是提供这些包的解析根（通常为插件宿主包根，
 * 包从其 node_modules 内解析；pnpm 符号链接布局以包目录 realpath 为界）。
 */
export interface PluginClientNpmRoot {
  specifiers: ReadonlyArray<string>;
  packageRoot: string;
}

/** client.tsx 编译产物（单入口）。 */
export interface PluginClientBundle {
  /** 产物 JS 文本（自包含浏览器 ESM；共享依赖经 globalThis.__helm_shared_* 运行时解析）。 */
  code: string;
  /** 内容 hash（入口 + 全部本地/受控 npm 依赖内容 sha256 + 编译参数）。 */
  contentHash: string;
  /** 产物 gzip 预压缩字节（供 HTTP 快速响应）。 */
  gzipped?: Uint8Array;
  /** 产物入口模块的具名导出清单（含 CSS 保留导出；悬空 export 校验消费）。 */
  exports: string[];
  /** 异步分包产物（code-splitting 路径生成；key 为 chunk 文件名）。 */
  chunks?: Record<string, { code: string; gzipped?: Uint8Array }>;
}

/** client 模块编译请求：内核收集事实，provider 执行编译。 */
export interface PluginClientCompileRequest {
  /** 插件 ID（缓存目录隔离单位）。 */
  pluginId: string;
  /** 插件声明并已校验的绝对源根目录。 */
  clientRoot: string;
  /** 相对入口（形状已过 assertModuleRefShape）。 */
  moduleRef: string;
  /** 宿主 dataDir；产物与依赖清单落盘 <cacheDir>/plugin-staging/<pluginId>/。 */
  cacheDir: string;
  /** 受控 npm 依赖解析根（无声明时为空数组）。 */
  npmRoots: ReadonlyArray<PluginClientNpmRoot>;
}

/** 后端 TS 源转译请求（外部插件 Node module hooks 底座；同步调用）。 */
export interface PluginBackendTsTransform {
  /** 源文件全文。 */
  source: string;
  /** 源文件绝对路径（诊断与 sourcefile 定位）。 */
  file: string;
  /** 源形态：.ts/.mts/.cts 用 'ts'，.tsx 用 'tsx'。 */
  kind: 'ts' | 'tsx';
}

/**
 * 插件构建端口：内核 PluginHost 的唯一编译/转译依赖。
 *
 * 未注入（buildProvider 缺失）时内核显式拒绝相关能力，绝不静默降级：
 * - 带 client 引用的 UI 贡献注册 -> 501 unsupported_client_build；
 * - 外部插件 TS 源转译 -> 501 unsupported_backend_ts_build。
 */
export interface PluginBuildProvider {
  /** 编译插件 client.tsx 模块为浏览器 ESM 产物（含磁盘/内存缓存、并发合并、hash 失效与 gzip）。 */
  compileClientModule(request: PluginClientCompileRequest): Promise<PluginClientBundle>;
  /** 同步转译后端 TS 源文本为 ESM（jsx: automatic，target: node20；语义同 esbuild transformSync）。 */
  transformBackendTs(transform: PluginBackendTsTransform): string;
}

/** ClientComponentRef.module 允许的字符集（相对路径段：字母数字 . _ -，禁止空段与 ..）。 */
const MODULE_REF_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.(ts|tsx)$/;

/**
 * 校验 ClientComponentRef.module 形状（相对 .ts/.tsx，无绝对/越根/编码逃逸）。
 * 内核注册边界与构建实现共用同一校验（按路径自身形式判定，跨平台）。
 */
export function assertModuleRefShape(pluginId: string, moduleRef: string): void {
  if (
    typeof moduleRef !== 'string' ||
    moduleRef.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(moduleRef) ||
    moduleRef.startsWith('\\') ||
    moduleRef.includes('\\') ||
    moduleRef.split('/').includes('..') ||
    !MODULE_REF_PATTERN.test(moduleRef)
  ) {
    throw new HelmError(
      'invalid_client_module',
      `插件 ${pluginId} 的 client 模块引用非法（须为 clientRoot 内相对 .ts/.tsx 路径，禁止绝对路径/..越根/反斜杠）：${String(moduleRef)}`,
      400,
      { pluginId, module: String(moduleRef) },
    );
  }
}

/**
 * 把插件定义声明的 npmDependencies（说明符 -> 解析根）聚合为编译器可校验的 roots。
 * 内核运行链（ui-registry）与 doctor 静态自检链共用，保证同一映射口径。
 */
export function clientNpmRootsOf(
  npmDependencies: Readonly<Record<string, string>> | undefined,
): PluginClientNpmRoot[] {
  const npmByRoot = new Map<string, string[]>();
  for (const [spec, packageRoot] of Object.entries(npmDependencies ?? {})) {
    const list = npmByRoot.get(packageRoot) ?? [];
    list.push(spec);
    npmByRoot.set(packageRoot, list);
  }
  return [...npmByRoot.entries()].map(([packageRoot, specifiers]) => ({ packageRoot, specifiers }));
}
