/**
 * PluginClientCompiler：client.tsx 轨道的宿主侧编译器。
 *
 * 职责（只做机制）：
 * - 把插件 clientRoot 内的相对 .ts/.tsx 入口编译为浏览器 ESM（esbuild bundle + metafile）；
 * - 依赖闭包与 hash 以 esbuild metafile 实际输入为准（export-from / 动态 import /
 *   .js / .json / .css 全部如实纳入；绝不靠源码正则猜测 import），缓存复查逐依赖
 *   sha256 比对，源未变直接复用磁盘产物，绝不重复编译；
 * - 宿主共享依赖（react / react-dom / lucide-react / @helm/plugin-client）经 esbuild
 *   虚拟模块 shim 处理：shim 体内 `module.exports = globalThis.__helm_shared_*`，
 *   named / namespace / default / as-别名 / export-from 全部由 esbuild 生成合法
 *   ESM 绑定（对比正则改写 import 会产出 `const {useState as s}` 这类非法 JS），
 *   运行时与宿主共享同一实例，绝不打包第二份 React；
 * - CSS（v3 起）：交给 esbuild 原生 CSS bundling（虚拟 outfile + write:false，不落
 *   真实产物文件），本地 @import 按依赖顺序原生合并；合并结果以具名导出
 *   `__helmClientCss`（@helm/protocol PLUGIN_CLIENT_CSS_EXPORT）附在 JS 产物尾部，
 *   产物本身不注入 DOM——加载器在 import 成功且缓存仍有效后才注入样式；无 CSS
 *   时不产出该导出（加载器按空处理）；
 *   - CSS 资源 URL 只允许 data: 与 http(s)/协议相对的显式绝对地址（不依赖插件
 *     路径基址）；本地相对 / 根相对 / 片段 URL 显式编译错误并建议内联 data:；
 *   - 远程 @import 显式拒绝（不受本地依赖校验与缓存管控）；本地 @import 进
 *     依赖 hash；判定一律使用 esbuild resolver 的 kind（import-rule / url-token），
 *     绝不用源码正则猜测语法（注释里的 @import/url() 不是 import）；
 * - containment：入口与每个被加载的本地文件 realpath 都必须位于 clientRoot realpath
 *   之内（符号链接逃逸逐文件拦截）；非共享裸依赖（npm 包）显式拒绝——当前不支持
 *     npm 安装，绝不把 node_modules 或根外文件悄悄打进 bundle；
 * - 产物落盘：randomUUID 临时文件 + rename 原子改名；同 (pluginId, module, root)
 *   并发编译合并同一 in-flight Promise，失败清除可重试。
 *
 * 失败显式抛 HelmError（含 esbuild 诊断），绝不静默降级或返回空产物。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, dirname, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HelmError, PLUGIN_CLIENT_CSS_EXPORT } from '@helm/protocol';
import { build, type Plugin as EsbuildPlugin } from 'esbuild';
import { isCrossPlatformAbsolutePath } from './shared.js';

/**
 * 宿主与插件共享的浏览器端运行时依赖：编译期拦截为虚拟 shim 模块（绝不解析
 * node_modules），运行时经 globalThis.__helm_shared_* 命名空间取宿主同一实例。
 * 具体渲染技术（如图表库）不入此清单——插件自有 npm 依赖走受控解析 bundle
 *（见 allowedNpmSpecifiers / containmentPlugin 的 npm 分支）。
 */
export const CLIENT_SHARED_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'lucide-react',
  '@helm/plugin-client',
] as const;

/** 共享说明符 -> 宿主全局命名空间名（宿主页面/测试进程挂载；缺一即运行时显式报错）。 */
export const CLIENT_SHARED_GLOBALS: Readonly<Record<string, string>> = Object.freeze({
  react: '__helm_shared_react',
  'react-dom': '__helm_shared_react_dom',
  'react-dom/client': '__helm_shared_react_dom_client',
  'react/jsx-runtime': '__helm_shared_react_jsx_runtime',
  'lucide-react': '__helm_shared_lucide_react',
  '@helm/plugin-client': '__helm_shared_plugin_client',
});

/** ClientComponentRef.module 允许的字符集（相对路径段：字母数字 . _ -，禁止空段与 ..）。 */
const MODULE_REF_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.(ts|tsx)$/;

/** 依赖清单（deps.json）结构版本；v2 为 CSS-as-JS 旧格式，v3 起原生 CSS bundling，v4 起含受控 npm 依赖，v5 起启用 esbuild minify 与预压缩，v6 起支持代码分割与异步 chunk 桥。 */
const DEPS_LIST_VERSION = 6;

export interface ClientCompileResult {
  /** 产物 JS 文本（自包含 ESM；共享依赖经 globalThis 命名空间运行时解析）。 */
  code: string
  /** 内容 hash（入口 + 全部本地依赖内容 sha256 + 编译参数）。 */
  contentHash: string
  /** 产物 gzip 预压缩字节（供 HTTP 快速响应）。 */
  gzipped?: Uint8Array
  /** 产物入口模块的具名导出清单（含 CSS 保留导出；doctor 消费做悬空 export 校验）。 */
  exports: string[]
  /** 异步分包产物（code-splitting 路径生成；key 为 chunk 文件名）。 */
  chunks?: Record<string, { code: string; gzipped?: Uint8Array }>
}

/** 校验 ClientComponentRef.module 形状（相对 .ts/.tsx，无绝对/越根/编码逃逸）。 */
export function assertModuleRefShape(pluginId: string, moduleRef: string): void {
  if (
    typeof moduleRef !== 'string' ||
    isAbsolute(moduleRef) ||
    /^[a-zA-Z]:[\\/]/.test(moduleRef) ||
    /^\\\\[^\\]+\\[^\\]+/.test(moduleRef) ||
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

// ---------------------------------------------------------------------------
// 并发合并：同 key 在途编译共享同一 Promise；失败即清除可重试
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<ClientCompileResult>>();

interface MemoryCompiledEntry {
  result: ClientCompileResult;
  localMtimes: Map<string, number>;
  root: string;
}

const memoryCompiledCache = new Map<string, MemoryCompiledEntry>();

export function clearClientCompilerMemoryCache(): void {
  memoryCompiledCache.clear();
}

/** 从 Pass 1 生成的代码中解析具名与默认导出映射（exportedName -> localIdentifier）。 */
export function parseExportMappings(code: string): Map<string, string> {
  const mappings = new Map<string, string>();
  const re = /export\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const body = m[1]!;
    const parts = body.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(trimmed);
      if (asMatch) {
        mappings.set(asMatch[2]!, asMatch[1]!);
      } else if (/^[A-Za-z0-9_$]+$/.test(trimmed)) {
        mappings.set(trimmed, trimmed);
      }
    }
  }
  const defMatch = /export\s+default\s+([A-Za-z0-9_$]+)\s*;/.exec(code);
  if (defMatch) {
    mappings.set('default', defMatch[1]!);
  }
  return mappings;
}

/**
 * 根据 (stagingDir, baseName, contentHash, chunkName) 读取单个 chunk 内容与 gzip 字节。
 */
export function readCachedChunk(
  stagingDir: string,
  baseName: string,
  contentHash: string,
  chunkName: string,
): { code: string; gzipped?: Uint8Array } | undefined {
  const chunkPath = join(stagingDir, `${baseName}.${contentHash}.chunk.${chunkName}`);
  if (!existsSync(chunkPath)) return undefined;
  try {
    const code = readFileSync(chunkPath, 'utf8');
    let gzipped: Uint8Array | undefined;
    const gzPath = join(stagingDir, `${baseName}.${contentHash}.chunk.${chunkName}.gz`);
    if (existsSync(gzPath)) {
      try {
        gzipped = readFileSync(gzPath);
      } catch {
        /* ignore */
      }
    }
    return { code, gzipped };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Node 测试环境支持：本地 stagingDir 的 chunk 定位与 import_chunk 兜底
// ---------------------------------------------------------------------------

const nodeChunkLocations = new Map<string, { stagingDir: string; baseName: string }>();

export function registerNodeChunkLocation(
  pluginId: string,
  moduleRef: string,
  contentHash: string,
  stagingDir: string,
  baseName: string,
): void {
  nodeChunkLocations.set(`${pluginId}\0${moduleRef}\0${contentHash}`, { stagingDir, baseName });
  ensureNodeGlobalImportChunk();
}

export function getNodeChunkText(
  pluginId: string,
  moduleRef: string,
  contentHash: string,
  chunkName: string,
): string | undefined {
  const loc = nodeChunkLocations.get(`${pluginId}\0${moduleRef}\0${contentHash}`);
  if (!loc) return undefined;
  const res = readCachedChunk(loc.stagingDir, loc.baseName, contentHash, chunkName);
  return res?.code;
}

export function ensureNodeGlobalImportChunk(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.__helm_node_chunk_lookup !== 'function') {
    g.__helm_node_chunk_lookup = getNodeChunkText;
  }
  if (typeof g.__helm_import_chunk !== 'function') {
    const nodeChunkCache = new Map<string, Promise<Record<string, unknown>>>();
    g.__helm_import_chunk = async (
      pluginId: string,
      moduleRef: string,
      contentHash: string,
      chunkName: string,
      preloads: string[] = [],
    ): Promise<Record<string, unknown>> => {
      for (const p of preloads) {
        await loadSingleNodeChunk(pluginId, moduleRef, contentHash, p, nodeChunkCache);
      }
      return await loadSingleNodeChunk(pluginId, moduleRef, contentHash, chunkName, nodeChunkCache);
    };
  }
}

async function loadSingleNodeChunk(
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
    const code = getNodeChunkText(pluginId, moduleRef, contentHash, chunkName);
    if (code === undefined) {
      throw new HelmError('client_chunk_not_found', `Node 环境下未找到 chunk ${chunkName}（插件 ${pluginId}）`, 404);
    }
    const dataUrl = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;
    return (await import(/* @vite-ignore */ dataUrl)) as Record<string, unknown>;
  })();
  cache.set(key, run);
  return run;
}

/**
 * 编译插件客户端模块（并发安全：同 key 在途编译合并；缓存命中时零编译）。
 * @param pluginId 插件 ID（缓存目录隔离单位）
 * @param clientRoot 插件声明并已校验的绝对源根目录
 * @param moduleRef 相对入口（assertModuleRefShape 已通过）
 * @param cacheDir 宿主 dataDir（产物与依赖清单落盘 <cacheDir>/cache/plugin-staging/<pluginId>/）
 */
export async function compilePluginClientModule(
  pluginId: string,
  clientRoot: string,
  moduleRef: string,
  cacheDir: string,
  options?: { npmRoots?: ReadonlyArray<ClientNpmRoot> },
): Promise<ClientCompileResult> {
  assertModuleRefShape(pluginId, moduleRef);
  const npmKey = (options?.npmRoots ?? []).map((r) => `${r.packageRoot}:${r.specifiers.join(',')}`).sort().join(';');
  const key = `${pluginId}\0${moduleRef}\0${realPathOrThrow(clientRoot, `插件 ${pluginId} 的 clientRoot 不可访问：${clientRoot}`)}\0${npmKey}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = compileUncached(pluginId, clientRoot, moduleRef, cacheDir, options?.npmRoots ?? []).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

/** 依赖清单（deps.json）结构：跨重启可复查的缓存凭据。 */
interface DepsListFile {
  version: typeof DEPS_LIST_VERSION
  module: string
  /** clientRoot realpath（根变更/移动后旧缓存直接失效，不误用）。 */
  root: string
  contentHash: string
  /** 全部本地依赖：相对 root 的路径 + 内容 sha256（含入口自身）。 */
  dependencies: Array<{ path: string; sha256: string }>
  /** 受控 npm 依赖：解析根标识 + 绝对路径 + 内容 sha256（v4 新增）。 */
  npmDependencies?: Array<{ root: string; path: string; sha256: string }>
  /** 入口具名导出（旧清单缺省时缓存命中方拿不到 exports，需 exports 的调用方应重新编译或容错）。 */
  exports?: string[]
  /** 异步 chunk 文件名清单（v6 新增）。 */
  chunks?: string[]
}

/**
 * 受控 npm 依赖声明：specifiers 为允许的精确裸说明符（含子路径需逐项声明），
 * packageRoot 是提供这些包的解析根（通常为内置插件宿主包根，node_modules 内）。
 * 解析产物按文件 realpath containment 校验后随本地依赖一并进 deps hash 与缓存复查。
 */
export interface ClientNpmRoot {
  specifiers: ReadonlyArray<string>;
  packageRoot: string;
}

async function compileUncached(
  pluginId: string,
  clientRoot: string,
  moduleRef: string,
  cacheDir: string,
  npmRoots: ReadonlyArray<ClientNpmRoot> = [],
): Promise<ClientCompileResult> {
  const rootReal = realPathOrThrow(
    clientRoot,
    `插件 ${pluginId} 的 clientRoot 不存在或不可访问：${clientRoot}`,
  );
  const entryReal = assertEntryInsideRoot(pluginId, rootReal, moduleRef);

  // 1. 进程内内存缓存快路径（按本地文件 mtime 极速判定，跳过逐个 npm 依赖 sha256 磁盘遍历）
  const npmKey = npmRoots.map((r) => `${r.packageRoot}:${r.specifiers.join(',')}`).sort().join(';');
  const memKey = `${pluginId}\0${moduleRef}\0${rootReal}\0${npmKey}`;
  const memEntry = memoryCompiledCache.get(memKey);
  if (memEntry && memEntry.root === rootReal) {
    let fresh = true;
    for (const [abs, mtime] of memEntry.localMtimes) {
      try {
        if (statSync(abs).mtimeMs !== mtime) {
          fresh = false;
          break;
        }
      } catch {
        fresh = false;
        break;
      }
    }
    if (fresh) {
      return memEntry.result;
    }
    memoryCompiledCache.delete(memKey);
  }

  const stagingDir = join(cacheDir, 'plugin-staging', safeDirName(pluginId));
  const baseName = safeFileName(moduleRef);
  const depsListPath = join(stagingDir, `${baseName}.deps.json`);

  // 缓存复查：清单合法且每个依赖 sha256 与磁盘一致时复用产物，零编译
  const cached = readCachedResult(stagingDir, depsListPath, rootReal, moduleRef, pluginId);
  if (cached) {
    recordMemoryCache(memKey, rootReal, depsListPath, cached);
    return cached;
  }

  // Pass 1：开启 splitting: true 的内存构建
  let pass1Result: Awaited<ReturnType<typeof build>>;
  try {
    pass1Result = await build({
      entryPoints: [entryReal],
      bundle: true,
      splitting: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      jsx: 'automatic',
      write: false,
      sourcemap: false,
      metafile: true,
      absWorkingDir: rootReal,
      outdir: join(stagingDir, '__virtual_out__'),
      logLevel: 'silent',
      plugins: [
        sharedShimPlugin(),
        containmentPlugin(pluginId, rootReal, npmRoots),
        cssPolicyPlugin(pluginId),
      ],
    });
  } catch (err) {
    if (err instanceof HelmError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `插件 ${pluginId} 编译 ${moduleRef} 失败：${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  const pass1Metafile = pass1Result.metafile;
  const pass1OutputFiles = pass1Result.outputFiles;
  if (!pass1Metafile || !pass1OutputFiles) {
    throw new HelmError('client_compile_failed', `插件 ${pluginId} Pass 1 内存构建未产出 metafile 或 outputFiles`, 500);
  }

  // 校验保留导出
  if (Object.values(pass1Metafile.outputs).some((file) => file.exports?.includes(PLUGIN_CLIENT_CSS_EXPORT))) {
    throw new HelmError(
      'client_compile_failed',
      `插件 ${pluginId} 模块 ${moduleRef} 占用了编译器保留导出名 "${PLUGIN_CLIENT_CSS_EXPORT}"，请改名该导出`,
      422,
      { pluginId, module: moduleRef, reservedExport: PLUGIN_CLIENT_CSS_EXPORT },
    );
  }

  const virtualFiles = new Map<string, string>();
  const metaByBase = new Map<string, (typeof pass1Metafile.outputs)[string]>();
  const cssFiles: string[] = [];

  for (const f of pass1OutputFiles) {
    const b = basename(f.path);
    if (b.endsWith('.css')) {
      cssFiles.push(f.text);
    } else if (b.endsWith('.js')) {
      virtualFiles.set(b, f.text);
    }
  }
  for (const [outPath, meta] of Object.entries(pass1Metafile.outputs)) {
    if (outPath.endsWith('.js')) {
      metaByBase.set(basename(outPath), meta);
    }
  }

  const css = cssFiles.join('\n');

  // 寻找 entryBaseName
  const relEntry = relative(rootReal, entryReal);
  let entryBaseName = '';
  for (const [b, meta] of metaByBase) {
    if (meta.entryPoint && (meta.entryPoint === relEntry || meta.entryPoint === entryReal || meta.entryPoint.endsWith(moduleRef))) {
      entryBaseName = b;
      break;
    }
  }
  if (!entryBaseName) {
    if (virtualFiles.size === 1) {
      entryBaseName = virtualFiles.keys().next().value!;
    } else {
      throw new HelmError(
        'client_compile_failed',
        `插件 ${pluginId} 编译 ${moduleRef} 无法唯一定位入口 JS 产物`,
        500,
        { pluginId, module: moduleRef },
      );
    }
  }

  const dependencies = collectLocalDependencies(pass1Metafile, rootReal);
  const npmDeps = collectNpmDependencies(pass1Metafile, rootReal, npmRoots);

  // 收集 baseClosure
  const baseClosure = new Set<string>([entryBaseName]);
  function visitBase(file: string): void {
    const meta = metaByBase.get(file);
    if (!meta || !meta.imports) return;
    for (const imp of meta.imports) {
      if (imp.kind === 'import-statement') {
        const b = basename(imp.path);
        if (metaByBase.has(b) && !baseClosure.has(b)) {
          baseClosure.add(b);
          visitBase(b);
        }
      }
    }
  }
  visitBase(entryBaseName);

  // 收集所有 dynamicTargets（从 baseClosure 及递归动态依赖可达）
  const dynamicTargets = new Set<string>();
  const dynQueue: string[] = [];
  function checkDynImports(file: string): void {
    const meta = metaByBase.get(file);
    if (!meta || !meta.imports) return;
    for (const imp of meta.imports) {
      if (imp.kind === 'dynamic-import' && !imp.external) {
        const b = basename(imp.path);
        if (metaByBase.has(b) && !dynamicTargets.has(b)) {
          dynamicTargets.add(b);
          dynQueue.push(b);
        }
      }
    }
  }
  for (const f of baseClosure) checkDynImports(f);
  while (dynQueue.length > 0) {
    const d = dynQueue.shift()!;
    const visited = new Set<string>([d]);
    const qStatic = [d];
    while (qStatic.length > 0) {
      const cur = qStatic.shift()!;
      checkDynImports(cur);
      const meta = metaByBase.get(cur);
      if (meta && meta.imports) {
        for (const imp of meta.imports) {
          if (imp.kind === 'import-statement') {
            const b = basename(imp.path);
            if (metaByBase.has(b) && !visited.has(b)) {
              visited.add(b);
              qStatic.push(b);
            }
          }
        }
      }
    }
  }

  const jsMeta = metaByBase.get(entryBaseName);
  const entryExports = [...(jsMeta?.exports ?? []), ...(css.length > 0 ? [PLUGIN_CLIENT_CSS_EXPORT] : [])];

  // 快路径（无代码分割的普通插件）
  if (dynamicTargets.size === 0) {
    let mainOutput = '';
    try {
      const pass2 = await build({
        stdin: {
          contents: virtualFiles.get(entryBaseName)!,
          loader: 'js',
          sourcefile: entryBaseName,
        },
        bundle: true,
        format: 'esm',
        target: 'es2022',
        platform: 'browser',
        write: false,
        sourcemap: false,
        minifyWhitespace: true,
        minifyIdentifiers: true,
        logLevel: 'silent',
        plugins: [
          {
            name: 'vfs-resolver',
            setup(b) {
              b.onResolve({ filter: /.*/ }, (args) => {
                const target = basename(args.path);
                return { path: target, namespace: 'vfs' };
              });
              b.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
                const c = virtualFiles.get(args.path);
                if (c === undefined) return { errors: [{ text: `Missing virtual file: ${args.path}` }] };
                return { contents: c, loader: 'js' };
              });
            },
          },
        ],
      });
      mainOutput = appendCssExport(pass2.outputFiles[0]!.text, css);
    } catch (err) {
      if (err instanceof HelmError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new HelmError('client_compile_failed', `插件 ${pluginId} 编译 ${moduleRef} 收敛失败：${message}`, 422, {
        pluginId,
        module: moduleRef,
      });
    }

    const list = buildDepsList(rootReal, moduleRef, dependencies, npmDeps, entryExports);
    mkdirSync(stagingDir, { recursive: true });
    atomicWrite(join(stagingDir, `${baseName}.${list.contentHash}.mjs`), mainOutput);
    let gzipped: Uint8Array | undefined;
    try {
      const gz = gzipSync(Buffer.from(mainOutput, 'utf8'));
      atomicWriteBuffer(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`), gz);
      gzipped = gz;
    } catch {}
    atomicWrite(depsListPath, `${JSON.stringify(list)}\n`);
    const finalResult: ClientCompileResult = {
      code: mainOutput,
      contentHash: list.contentHash,
      gzipped,
      exports: entryExports,
      chunks: {},
    };
    recordMemoryCache(memKey, rootReal, depsListPath, finalResult);
    return finalResult;
  }

  // 分包路径（dynamicTargets.size > 0）
  // 步骤 A：划分三类模块集合
  const dynStaticClosures = new Map<string, Set<string>>();
  for (const d of dynamicTargets) {
    const closure = new Set<string>();
    function visitDyn(f: string): void {
      const meta = metaByBase.get(f);
      if (!meta || !meta.imports) return;
      for (const imp of meta.imports) {
        if (imp.kind === 'import-statement') {
          const b = basename(imp.path);
          if (metaByBase.has(b) && !baseClosure.has(b) && !closure.has(b)) {
            closure.add(b);
            visitDyn(b);
          }
        }
      }
    }
    visitDyn(d);
    dynStaticClosures.set(d, closure);
  }

  const refCount = new Map<string, number>();
  for (const [, closure] of dynStaticClosures) {
    for (const chunk of closure) {
      refCount.set(chunk, (refCount.get(chunk) ?? 0) + 1);
    }
  }

  const sharedAsyncChunks = new Set<string>();
  for (const [chunk, count] of refCount) {
    if (count >= 2) sharedAsyncChunks.add(chunk);
  }
  function addSharedDeps(chunk: string): void {
    const meta = metaByBase.get(chunk);
    if (!meta || !meta.imports) return;
    for (const imp of meta.imports) {
      if (imp.kind === 'import-statement') {
        const b = basename(imp.path);
        if (metaByBase.has(b) && !baseClosure.has(b) && !sharedAsyncChunks.has(b)) {
          sharedAsyncChunks.add(b);
          addSharedDeps(b);
        }
      }
    }
  }
  for (const chunk of Array.from(sharedAsyncChunks)) addSharedDeps(chunk);

  // 步骤 B：防 Tree-shaking 丢失导出 & 注册 __helm_chunk_share
  const filesToRegister = new Set<string>([...baseClosure, ...sharedAsyncChunks]);
  filesToRegister.delete(entryBaseName);

  for (const F of filesToRegister) {
    const code = virtualFiles.get(F);
    if (!code) continue;
    const mappings = parseExportMappings(code);
    if (mappings.size > 0) {
      const entries = Array.from(mappings.entries()).map(
        ([exp, loc]) => `${JSON.stringify(exp)}: ${loc}`,
      ).join(',\n  ');
      const regStmt = `\n;(globalThis.__helm_chunk_share ??= {})["__HELM_HASH__/" + ${JSON.stringify(F)}] = {\n  ${entries}\n};\n`;
      virtualFiles.set(F, code + regStmt);
    }
  }

  // 步骤 C：生成异步单元的前置共享依赖表 chunkDeps
  const chunkDeps: Record<string, string[]> = {};
  for (const d of dynamicTargets) {
    const staticClosure = dynStaticClosures.get(d) ?? new Set<string>();
    const neededShared = new Set<string>();
    for (const c of staticClosure) {
      if (sharedAsyncChunks.has(c)) neededShared.add(c);
    }
    function collectMoreShared(c: string): void {
      const meta = metaByBase.get(c);
      if (!meta || !meta.imports) return;
      for (const imp of meta.imports) {
        if (imp.kind === 'import-statement') {
          const b = basename(imp.path);
          if (sharedAsyncChunks.has(b) && !neededShared.has(b)) {
            neededShared.add(b);
            collectMoreShared(b);
          }
        }
      }
    }
    for (const c of Array.from(neededShared)) collectMoreShared(c);

    const sorted: string[] = [];
    const visited = new Set<string>();
    function topoVisit(c: string): void {
      if (visited.has(c)) return;
      visited.add(c);
      const meta = metaByBase.get(c);
      if (meta && meta.imports) {
        for (const imp of meta.imports) {
          if (imp.kind === 'import-statement') {
            const b = basename(imp.path);
            if (neededShared.has(b)) topoVisit(b);
          }
        }
      }
      sorted.push(c);
    }
    for (const c of neededShared) topoVisit(c);
    chunkDeps[d] = sorted;
  }

  const allUnits = new Set<string>([...sharedAsyncChunks, ...dynamicTargets]);
  const list = buildDepsList(rootReal, moduleRef, dependencies, npmDeps, entryExports, Array.from(allUnits));

  // 步骤 D：Pass 2 收敛构建（主包 + sharedAsyncChunks + dynamicTargets）
  async function bundleUnit(unitName: string, isMain: boolean): Promise<string> {
    const unitCode = virtualFiles.get(unitName);
    if (unitCode === undefined) {
      throw new HelmError('client_compile_failed', `找不到虚拟文件 ${unitName}`, 500);
    }
    const res = await build({
      stdin: {
        contents: unitCode,
        loader: 'js',
        sourcefile: unitName,
      },
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      write: false,
      sourcemap: false,
      minifyWhitespace: true,
      minifyIdentifiers: true,
      minifySyntax: true,
      logLevel: 'silent',
      plugins: [
        {
          name: 'pass2-resolver',
          setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === 'dynamic-import') {
                const target = basename(args.path);
                return { path: '__HELM_DYN_IMPORT__:' + target, external: true };
              }
              if (args.kind === 'import-statement') {
                const target = basename(args.path);
                if (isMain) {
                  return { path: target, namespace: 'vfs' };
                } else {
                  if ((baseClosure.has(target) || sharedAsyncChunks.has(target)) && target !== unitName) {
                    return { path: target, namespace: 'proxy' };
                  }
                  return { path: target, namespace: 'vfs' };
                }
              }
              return null;
            });
            b.onLoad({ filter: /.*/, namespace: 'proxy' }, (args) => {
              const T = args.path;
              const meta = metaByBase.get(T);
              const exports = meta?.exports || [];
              const proxyLines = [
                `const __s = (globalThis.__helm_chunk_share ?? {})["__HELM_HASH__/" + ${JSON.stringify(T)}] || {};`,
              ];
              for (const exp of exports) {
                if (exp === 'default') {
                  proxyLines.push('export default __s["default"];');
                } else {
                  proxyLines.push(`export const ${exp} = __s[${JSON.stringify(exp)}];`);
                }
              }
              if (exports.length === 0) {
                proxyLines.push('export {};');
              }
              return { contents: proxyLines.join('\n'), loader: 'js' };
            });
            b.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
              const content = virtualFiles.get(args.path);
              if (content === undefined) {
                return { errors: [{ text: `Missing virtual file: ${args.path}` }] };
              }
              return { contents: content, loader: 'js' };
            });
          },
        },
      ],
    });
    let out = res.outputFiles[0]!.text;
    out = out.replace(/import\s*\(\s*["'`]__HELM_DYN_IMPORT__:([^"'`]+)["'`]\s*\)/g, (_match, target) => {
      const deps = chunkDeps[target] ?? [];
      return `globalThis.__helm_import_chunk(${JSON.stringify(pluginId)}, ${JSON.stringify(moduleRef)}, ${JSON.stringify(list.contentHash)}, ${JSON.stringify(target)}, ${JSON.stringify(deps)})`;
    });
    out = out.replaceAll('__HELM_HASH__', list.contentHash);
    return out;
  }

  let mainJs: string;
  try {
    mainJs = await bundleUnit(entryBaseName, true);
    mainJs = appendCssExport(mainJs, css);
  } catch (err) {
    if (err instanceof HelmError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `插件 ${pluginId} 主包收敛编译失败：${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  const chunkOutputs: Record<string, { code: string; gzipped?: Uint8Array }> = {};
  try {
    await Promise.all(
      Array.from(allUnits).map(async (unitName) => {
        const code = await bundleUnit(unitName, false);
        let gzipped: Uint8Array | undefined;
        try {
          gzipped = gzipSync(Buffer.from(code, 'utf8'));
        } catch {}
        chunkOutputs[unitName] = { code, gzipped };
      }),
    );
  } catch (err) {
    if (err instanceof HelmError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `插件 ${pluginId} 分包收敛编译失败：${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  // 步骤 E：原子落盘与内存缓存
  mkdirSync(stagingDir, { recursive: true });
  atomicWrite(join(stagingDir, `${baseName}.${list.contentHash}.mjs`), mainJs);
  let gzipped: Uint8Array | undefined;
  try {
    const gz = gzipSync(Buffer.from(mainJs, 'utf8'));
    atomicWriteBuffer(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`), gz);
    gzipped = gz;
  } catch {}

  for (const [chunkName, chunkData] of Object.entries(chunkOutputs)) {
    atomicWrite(join(stagingDir, `${baseName}.${list.contentHash}.chunk.${chunkName}`), chunkData.code);
    if (chunkData.gzipped) {
      atomicWriteBuffer(join(stagingDir, `${baseName}.${list.contentHash}.chunk.${chunkName}.gz`), chunkData.gzipped);
    }
  }

  atomicWrite(depsListPath, `${JSON.stringify(list)}\n`);
  registerNodeChunkLocation(pluginId, moduleRef, list.contentHash, stagingDir, baseName);

  const finalResult: ClientCompileResult = {
    code: mainJs,
    contentHash: list.contentHash,
    gzipped,
    exports: entryExports,
    chunks: chunkOutputs,
  };
  recordMemoryCache(memKey, rootReal, depsListPath, finalResult);
  return finalResult;
}

function recordMemoryCache(
  memKey: string,
  rootReal: string,
  depsListPath: string,
  result: ClientCompileResult,
): void {
  try {
    const list = JSON.parse(readFileSync(depsListPath, 'utf8')) as DepsListFile;
    const localMtimes = new Map<string, number>();
    for (const dep of list.dependencies) {
      const abs = join(rootReal, dep.path);
      try {
        localMtimes.set(abs, statSync(abs).mtimeMs);
      } catch {
        /* ignore */
      }
    }
    memoryCompiledCache.set(memKey, {
      result,
      localMtimes,
      root: rootReal,
    });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// CSS：序列化为具名导出附在 JS 产物尾部（产物不注入 DOM，加载器负责注入）
// ---------------------------------------------------------------------------

/** 元数据绑定必须避让产物中的局部变量，而非只避让其公开导出名。 */
function appendCssExport(js: string, css: string): string {
  if (css.length === 0) return js;
  let binding = '__helmCssText';
  while (js.includes(binding)) binding += '_';
  return `${js}\nconst ${binding} = ${JSON.stringify(css)};\nexport { ${binding} as ${PLUGIN_CLIENT_CSS_EXPORT} };\n`;
}

// ---------------------------------------------------------------------------
// 共享依赖虚拟 shim：合法 ESM/CJS 绑定，运行时从宿主全局命名空间取同一实例
// ---------------------------------------------------------------------------

/**
 * esbuild 插件：把共享依赖说明符解析到 'helm-shared' 虚拟命名空间；shim 模块体
 * 只有 `module.exports = globalThis.__helm_shared_*`。esbuild 的 CJS-interop 层
 * （__toESM/__copyProps 活getter）为 named（含 as 别名）/ namespace / default /
 * export * from 全部生成合法绑定——这是「不用源码正则重写 import」的关键：
 * 正则改写会产生 `const { useState as s } = ...`（非法 JS）且漏 default+named 混合等形态。
 */
function sharedShimPlugin(): EsbuildPlugin {
  return {
    name: 'helm-shared-shim',
    setup(b) {
      for (const spec of CLIENT_SHARED_EXTERNALS) {
        const globalName = CLIENT_SHARED_GLOBALS[spec];
        b.onResolve({ filter: exactLiteralFilter(spec) }, () => ({
          path: spec,
          namespace: 'helm-shared',
        }));
      }
      b.onLoad({ filter: /.*/, namespace: 'helm-shared' }, (args) => {
        const globalName = CLIENT_SHARED_GLOBALS[args.path];
        if (globalName === undefined) {
          return { errors: [{ text: `未知共享依赖说明符：${args.path}` }] };
        }
        return {
          contents: `module.exports = (globalThis.${globalName});`,
          loader: 'js',
        };
      });
    },
  };
}

/** 精确匹配说明符字面量（不吞 react-dom / 子路径；共享子路径不在清单内会被显式拒绝）。 */
function exactLiteralFilter(spec: string): RegExp {
  return new RegExp(`^${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

// ---------------------------------------------------------------------------
// containment：本地文件逐个 realpath 校验；裸依赖显式拒绝
// ---------------------------------------------------------------------------

/**
 * 受控 npm 说明符解析：命中声明的 specifiers 时把模块解析到对应 packageRoot 的
 * node_modules 内（不依赖 cwd，不受进程 chdir 影响）；返回 null 表示未声明。
 * 子路径说明符（如 'pkg/lib/x.js'）要求逐项显式声明，不做前缀通配。
 */
function resolveNpmSpecifier(
  spec: string,
  npmRoots: ReadonlyArray<ClientNpmRoot>,
): { path: string; pkgDir: string } | null {
  for (const root of npmRoots) {
    if (!root.specifiers.includes(spec)) continue;
    const nmReal = realpathOrNull(join(root.packageRoot, 'node_modules'));
    if (nmReal === null) continue;
    // packageRoot/node_modules 内的包可能是 pnpm 符号链接（指向 workspace store）：
    // 授权与解析都以包目录 realpath 为界（splitNpmSpecifier 剥离子路径）。
    const { pkg, sub } = splitNpmSpecifier(spec);
    const pkgReal = realpathOrNull(join(nmReal, pkg));
    if (pkgReal === null) continue;
    const entry = resolveNpmPackageEntry(pkgReal, sub === '' ? pkg : `${pkg}/${sub}`);
    if (entry === null) continue;
    return { path: entry, pkgDir: pkgReal };
  }
  return null;
}

/**
 * 解析 npm 包目录的 ESM 入口（package.json exports[condition] / module / main）。
 * 只读字段并校验目标存在；任何字段非法都返回 null（交回上层按未声明依赖拒绝），
 * 绝不让 esbuild 对自定义路径做目录猜测。
 */
/** spec 拆为「包名 + 子路径」：@scope/name 与 name 两种形态，其余为子路径段。 */
function splitNpmSpecifier(spec: string): { pkg: string; sub: string } {
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return { pkg: parts.slice(0, 2).join('/'), sub: parts.slice(2).join('/') };
  }
  return { pkg: parts[0] ?? spec, sub: parts.slice(1).join('/') };
}

/**
 * 解析 npm 包（或其子路径）入口：package.json exports 子路径映射（import/default）→
 * module/main（仅根）；无 exports 时子路径按包内相对路径直取。任何字段非法都返回
 * null（按未声明依赖拒绝），绝不让 esbuild 对自定义路径做目录猜测。
 */
function resolveNpmPackageEntry(pkgDir: string, spec: string): string | null {
  const pkgJsonPath = join(pkgDir, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { sub } = splitNpmSpecifier(spec);
  const exportKey = sub === '' ? '.' : `./${sub}`;
  const candidates: string[] = [];
  const exp = pkg['exports'];
  if (exp !== null && typeof exp === 'object' && !Array.isArray(exp)) {
    const entry = (exp as Record<string, unknown>)[exportKey];
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      // 条件值可能是字符串（"import": "./x.mjs"）或嵌套对象（{ import: { default } }）。
      const readCond = (value: unknown): string | null => {
        if (typeof value === 'string') return value;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const inner = (value as Record<string, unknown>)['default'];
          return typeof inner === 'string' ? inner : null;
        }
        return null;
      };
      const fromImport = readCond((entry as Record<string, unknown>)['import']);
      const fromDefault = readCond((entry as Record<string, unknown>)['default']);
      if (fromImport !== null) candidates.push(fromImport);
      if (fromDefault !== null) candidates.push(fromDefault);
    } else if (typeof entry === 'string') {
      candidates.push(entry);
    }
  }
  if (sub === '') {
    if (typeof pkg['module'] === 'string') candidates.push(pkg['module']);
    if (typeof pkg['main'] === 'string') candidates.push(pkg['main']);
  } else {
    candidates.push(`./${sub}`);
  }
  for (const rel of candidates) {
    if (typeof rel !== 'string' || rel === '') continue;
    const abs = rel.startsWith('./') ? join(pkgDir, rel.slice(2)) : join(pkgDir, rel);
    const real = realpathOrNull(abs);
    if (real !== null && existsSync(real)) return real;
  }
  return null;
}

/**
 * esbuild 插件：
 * - 裸说明符：共享依赖由 sharedShimPlugin（先注册）处理；受控 npm 说明符（调用方
 *   显式声明 specifiers + packageRoot）解析进 bundle 并逐文件 containment；其余
 *   裸说明符显式编译错误（绝不静默解析任意 node_modules）；CSS url()/@import 引用
 *   交由 cssPolicyPlugin 处理；
 * - 本地文件 onLoad 阶段 realpath containment：越出 clientRoot realpath（含符号链接
 *   逃逸和 CSS @import 越根）即拒绝——旧实现只检查入口，依赖文件可把根外代码带进 bundle。
 */
function containmentPlugin(
  pluginId: string,
  rootReal: string,
  npmRoots: ReadonlyArray<ClientNpmRoot> = [],
): EsbuildPlugin {
  // npm 闭包授权表：经受控解析（声明说明符，或已授权包内文件的传递裸说明符）
  // 解析出的「包目录 realpath」集合。授权以包目录为单位——相对导入与包内
  // node_modules 传递解析天然落在授权目录内；解析即授权，符号链接布局
  //（pnpm .pnpm store）不影响边界判定。
  const authorizedNpmDirs = new Set<string>();
  const authorizeNpmPackageDir = (pkgDir: string): string | null => {
    const real = realpathOrNull(pkgDir);
    if (real === null) return null;
    authorizedNpmDirs.add(real);
    return real;
  };
  const isNpmAuthorized = (realPath: string): boolean => {
    for (const dir of authorizedNpmDirs) {
      if (isInside(dir, realPath)) return true;
    }
    return false;
  };
  return {
    name: 'helm-containment',
    setup(b) {
      // 相对导入：无需单独授权——包目录授权模型下相对目标天然位于已授权目录内
      //（如 mermaid.core.mjs -> ./chunks/*.mjs）；交回 esbuild 默认解析。
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        // 盘符 / UNC 绝对路径不是裸说明符：filter 只排除 `.` 与 `/` 开头，
        // `D:\...`、`\\server\share\...` 会落进来（Windows 上入口与本地依赖
        // 全为此形态）。交回 esbuild 默认解析。
        if (isCrossPlatformAbsolutePath(args.path)) return null;
        // CSS 语法引用（url() 资源 / @import）不是 npm 说明符：交由 cssPolicyPlugin
        // 按资源策略处理（data:/https: 放行，本地相对显式拒绝），绝不误报裸依赖
        if (args.kind === 'url-token' || args.kind === 'import-rule') return null;
        // 共享说明符由 sharedShimPlugin（先注册）处理
        if ((CLIENT_SHARED_EXTERNALS as readonly string[]).includes(args.path)) return null;
        // 受控 npm 说明符：解析进声明的 packageRoot 并授权所在包目录（解析即授权）。
        const npm = resolveNpmSpecifier(args.path, npmRoots);
        if (npm !== null) {
          authorizeNpmPackageDir(npm.pkgDir);
          return { path: npm.path };
        }
        // 传递依赖：导入方位于已授权包目录内时，从该包 node_modules 解析裸说明符
        //（pnpm 符号链接布局天然支持）；解析成功即授权新包目录，逃逸路径无从
        // 发生——一切裸说明符都必须经此解析器，未授权文件不可能进入 bundle。
        if (args.importer !== '') {
          const importerReal = realpathOrNull(args.importer);
          if (importerReal !== null && isNpmAuthorized(importerReal)) {
            return null;
          }
        }
        const importer = args.importer || '入口';
        return {
          errors: [{
            text:
              `插件 ${pluginId} 编译拒绝裸依赖 "${args.path}"（被 ${importer} 引入）：` +
              `未声明为受控 npm 依赖；clientRoot 内只允许相对导入、共享依赖（${CLIENT_SHARED_EXTERNALS.join(', ')}）与声明的 npm 说明符`,
          }],
        };
      });
      b.onLoad({ filter: /.*/ }, (args) => {
        if (args.namespace !== 'file') return null;
        if (!/\.[cm]?[jt]sx?$|\.json$|\.css$/.test(args.path)) return null;
        const real = realpathOrNull(args.path);
        if (real === null) return null;
        const inClientRoot = isInside(rootReal, real);
        const inNpmRoot = isNpmAuthorized(real);
        if (!inClientRoot && !inNpmRoot) {
          // 仅对位于 node_modules 内的文件放行受控授权（绝不放行根外随意的本地/临时源码）
          if (real.includes(sep + 'node_modules' + sep)) {
            const pkgDir = findPackageDirOf(real);
            if (pkgDir !== null) {
              authorizeNpmPackageDir(pkgDir);
              return null;
            }
          }
          return {
            errors: [{
              text: `插件 ${pluginId} 编译拒绝越界的文件（可能为 ../ 越根、符号链接逃逸或未声明的 npm 解析）：${real}`,
            }],
          };
        }
        return null;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CSS 资源策略：esbuild resolver kind 判定（绝不用源码正则猜语法）
// ---------------------------------------------------------------------------

/**
 * 允许的 CSS 资源 URL：不依赖插件路径基址的显式绝对地址（data: 内联与
 * http(s)/协议相对外链）。空串（url() 无参）原样保留（合法 CSS，由浏览器处理）。
 */
function isAllowedCssAssetUrl(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (url.length === 0) return true;
  if (/^data:/i.test(url)) return true;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith('//')) return true;
  return false;
}

/** 文件所属包目录：向上查找最近的 package.json 所在目录（npm 布局内必达）。 */
function findPackageDirOf(fileReal: string): string {
  let dir = dirname(fileReal);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return fileReal;
    dir = parent;
  }
}

/**
 * 从受控包闭包内的导入文件解析传递裸说明符：向上查找最近 node_modules 的包目录，
 * 读 package.json 入口（与直接声明同一入口语义）。找不到返回 null（按未声明拒绝）。
 */
function resolveTransitiveNpmSpecifier(spec: string, importerReal: string): string | null {
  const segs = importerReal.split(sep);
  const { pkg, sub } = splitNpmSpecifier(spec);
  // 从导入文件向上找最近 node_modules（限定路径中出现 node_modules 的层级）
  for (let i = segs.length - 1; i > 0; i--) {
    if (segs[i] !== 'node_modules') continue;
    const nm = segs.slice(0, i + 1).join(sep);
    const pkgReal = realpathOrNull(join(nm, pkg));
    if (pkgReal === null) continue;
    return resolveNpmPackageEntry(pkgReal, sub === '' ? pkg : `${pkg}/${sub}`);
  }
  return null;
}

/**
 * esbuild 插件：按 resolver kind 管 CSS 语法引用——
 * - url-token（url() 资源）：data: / http(s) / 协议相对放行（交回默认解析，esbuild
 *   原样保留）；本地相对 / 根相对 / 片段等其余形态显式拒绝并建议内联 data:；
 * - import-rule（CSS @import）：本地相对由默认解析器解析（经 onLoad containment
 *   校验 realpath 越根，本地 @import 进依赖闭包与 hash）；远程（http(s)/协议相对）
 *   显式拒绝——外链样式不受本地依赖校验与缓存管控。
 */
function cssPolicyPlugin(pluginId: string): EsbuildPlugin {
  return {
    name: 'helm-css-policy',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'url-token') {
          if (isAllowedCssAssetUrl(args.path)) return null; // 交回默认解析（esbuild 原样保留）
          return {
            errors: [{
              text:
                `插件 ${pluginId} 的样式 ${args.importer} 引用资源 "${args.path}" 被拒绝：` +
                '本地相对/根相对/片段 URL 会相对宿主页面错误基址解析（插件无静态资源端点）；' +
                '请改用内联 data: URL 或显式 https:// 绝对地址',
            }],
          };
        }
        if (args.kind === 'import-rule') {
          if (/^(https?:)?\/\//i.test(args.path)) {
            return {
              errors: [{
                text:
                  `插件 ${pluginId} 的样式 ${args.importer} 远程 @import "${args.path}" 被拒绝：` +
                  '远程样式不受本地依赖校验与缓存管控；请将样式复制进 clientRoot 后相对引用',
              }],
            };
          }
          return null; // 本地 @import：默认解析 + onLoad containment（越根拒绝）
        }
        return null;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 缓存复查与依赖清单
// ---------------------------------------------------------------------------

/** 读取缓存产物：清单合法 + 每依赖 sha256 与磁盘一致才复用；否则 undefined（重编译）。 */
function readCachedResult(
  stagingDir: string,
  depsListPath: string,
  rootReal: string,
  moduleRef: string,
  pluginId: string,
): ClientCompileResult | undefined {
  if (!existsSync(depsListPath)) return undefined;
  let list: DepsListFile;
  try {
    list = JSON.parse(readFileSync(depsListPath, 'utf8')) as DepsListFile;
  } catch {
    return undefined; // 清单损坏：视为未缓存，重新编译
  }
  if (
    list.version !== DEPS_LIST_VERSION ||
    list.module !== moduleRef ||
    list.root !== rootReal ||
    typeof list.contentHash !== 'string' ||
    !Array.isArray(list.dependencies)
  ) {
    return undefined;
  }
  for (const dep of list.dependencies) {
    const abs = join(rootReal, dep.path);
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      return undefined; // 依赖被删除：失效重编译
    }
    if (sha256(source) !== dep.sha256) return undefined;
  }
  for (const dep of list.npmDependencies ?? []) {
    // npm 解析根（node_modules realpath）消失或文件内容变化：失效重编译（不静默复用旧产物）
    if (!existsSync(dep.root)) return undefined;
    let source: string;
    try {
      source = readFileSync(dep.path, 'utf8');
    } catch {
      return undefined;
    }
    if (sha256(source) !== dep.sha256) return undefined;
  }
  const baseName = safeFileName(moduleRef);
  const codePath = join(stagingDir, `${baseName}.${list.contentHash}.mjs`);
  const gzPath = join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`);
  if (!existsSync(codePath)) return undefined;
  try {
    const code = readFileSync(codePath, 'utf8');
    let gzipped: Uint8Array | undefined;
    if (existsSync(gzPath)) {
      try {
        gzipped = readFileSync(gzPath);
      } catch {
        /* 读取预压缩文件失败则留空，由调用方按需生成 */
      }
    }
    const chunks: Record<string, { code: string; gzipped?: Uint8Array }> = {};
    if (Array.isArray(list.chunks) && list.chunks.length > 0) {
      for (const chunkName of list.chunks) {
        const c = readCachedChunk(stagingDir, baseName, list.contentHash, chunkName);
        if (!c) return undefined; // chunk 缺失视为缓存失效，触发重编译
        chunks[chunkName] = c;
      }
      registerNodeChunkLocation(pluginId, moduleRef, list.contentHash, stagingDir, baseName);
    }
    return { code, contentHash: list.contentHash, gzipped, exports: list.exports ?? [], chunks };
  } catch {
    return undefined;
  }
}

/** 从 metafile inputs 收集 rootReal 内的全部本地依赖（含入口；排序保证确定性）。 */
function collectLocalDependencies(
  metafile: { inputs: Record<string, unknown> } | undefined,
  rootReal: string,
): string[] {
  if (!metafile) return [];
  const out = new Set<string>();
  for (const inputKey of Object.keys(metafile.inputs)) {
    // metafile key 相对 absWorkingDir（或绝对路径）；虚拟命名空间输入不含 '/' 路径形态
    const abs = isAbsolute(inputKey) ? inputKey : join(rootReal, inputKey);
    const real = realpathOrNull(abs);
    if (real !== null && isInside(rootReal, real)) out.add(real);
  }
  return [...out].sort();
}

/**
 * 从 metafile inputs 收集受控 npm 依赖文件（clientRoot 之外的输入）。
 * 编译已成功意味着全部越根输入都经解析期授权（裸说明符均受控解析），
 * 因此此处只需按「clientRoot 之外」归组；文件集变化随 hash 反映到缓存凭据。
 */
function collectNpmDependencies(
  metafile: { inputs: Record<string, unknown> } | undefined,
  rootReal: string,
  npmRoots: ReadonlyArray<ClientNpmRoot>,
): Array<{ root: string; files: string[] }> {
  if (!metafile || npmRoots.length === 0) return [];
  const files = new Set<string>();
  for (const inputKey of Object.keys(metafile.inputs)) {
    const abs = isAbsolute(inputKey) ? inputKey : join(rootReal, inputKey);
    const real = realpathOrNull(abs);
    if (real !== null && !isInside(rootReal, real)) files.add(real);
  }
  return files.size === 0 ? [] : [{ root: 'authorized-npm-closure', files: [...files].sort() }];
}

/** 组装依赖清单：逐依赖 sha256（内容寻址，跨重启稳定；不依赖 mtime）。
 * npm 依赖按（解析根 realpath, 绝对路径）参与 hash——路径或内容任一变化即失效。 */
function buildDepsList(
  rootReal: string,
  moduleRef: string,
  dependencies: string[],
  npmDeps: Array<{ root: string; files: string[] }> = [],
  entryExports: string[] = [],
  chunks?: string[],
): DepsListFile {
  const hash = createHash('sha256');
  hash.update(`helm-plugin-client-v${DEPS_LIST_VERSION}\n`);
  hash.update(`module:${moduleRef}\n`);
  const entries = dependencies.map((abs) => {
    const rel = relative(rootReal, abs);
    const sha = sha256(readFileSync(abs, 'utf8'));
    hash.update(`--file:${rel}\n${sha}\n`);
    return { path: rel, sha256: sha };
  });
  const npmEntries = npmDeps.flatMap(({ root, files }) =>
    files.map((abs) => {
      const sha = sha256(readFileSync(abs, 'utf8'));
      hash.update(`--npm:${root}::${abs}\n${sha}\n`);
      return { root, path: abs, sha256: sha };
    }),
  );
  if (chunks && chunks.length > 0) {
    for (const c of [...chunks].sort()) {
      hash.update(`--chunk:${c}\n`);
    }
  }
  return {
    version: DEPS_LIST_VERSION,
    module: moduleRef,
    root: rootReal,
    contentHash: hash.digest('hex').slice(0, 24),
    dependencies: entries,
    ...(npmEntries.length > 0 ? { npmDependencies: npmEntries } : {}),
    ...(entryExports.length > 0 ? { exports: entryExports } : {}),
    ...(chunks && chunks.length > 0 ? { chunks: [...chunks].sort() } : {}),
  };
}

// ---------------------------------------------------------------------------
// 落盘与路径工具
// ---------------------------------------------------------------------------

/** 临时文件（randomUUID）+ rename 原子落盘；失败清理临时文件（可重试）。 */
function atomicWrite(targetPath: string, content: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, targetPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
}

function atomicWriteBuffer(targetPath: string, content: Buffer | Uint8Array): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, targetPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function realPathOrThrow(p: string, message: string): string {
  try {
    const st = statSync(p);
    if (!st.isFile() && !st.isDirectory()) throw new Error('not file/dir');
    return realpathSync(p);
  } catch {
    throw new HelmError('client_root_invalid', message, 400, { path: p });
  }
}

/** 入口文件 containment：不存在 / 非文件 / realpath 越根（符号链接逃逸）显式拒绝。 */
function assertEntryInsideRoot(pluginId: string, rootReal: string, moduleRef: string): string {
  const absPath = join(rootReal, moduleRef);
  let real: string;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) throw new Error('not file');
    real = realpathSync(absPath);
  } catch {
    throw new HelmError('client_root_invalid', `插件 ${pluginId} 的 client 模块不存在：${moduleRef}`, 400, {
      pluginId,
      module: moduleRef,
    });
  }
  if (!isInside(rootReal, real)) {
    throw new HelmError(
      'client_module_out_of_root',
      `插件 ${pluginId} 的 client 模块越出 clientRoot（可能为符号链接逃逸）：${moduleRef}`,
      400,
      { pluginId, module: moduleRef },
    );
  }
  return real;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 目标真实路径是否位于根真实路径内（同根或根之子目录；符号链接已被 realpath 消解）。 */
function isInside(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** 插件 ID 到安全目录名（: 等字符映射为 _，hash 后缀保证不同 ID 不碰撞）。 */
function safeDirName(pluginId: string): string {
  const safe = pluginId.replace(/[^A-Za-z0-9_-]/g, '_');
  const suffix = createHash('sha1').update(pluginId).digest('hex').slice(0, 6);
  return `${safe}-${suffix}`;
}

/** moduleRef 到安全文件名（/ 与特殊字符映射，hash 后缀保证唯一）。 */
function safeFileName(moduleRef: string): string {
  const safe = moduleRef.replace(/[^A-Za-z0-9._-]+/g, '_');
  const suffix = createHash('sha1').update(moduleRef).digest('hex').slice(0, 6);
  return `${safe}-${suffix}`;
}
