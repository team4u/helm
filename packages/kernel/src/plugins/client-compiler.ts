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
import { isAbsolute, join, dirname, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HelmError, PLUGIN_CLIENT_CSS_EXPORT } from '@helm/protocol';
import { build, type Plugin as EsbuildPlugin } from 'esbuild';

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

/** 依赖清单（deps.json）结构版本；v2 为 CSS-as-JS 旧格式，v3 起原生 CSS bundling，v4 起含受控 npm 依赖，v5 起启用 esbuild minify 与预压缩。 */
const DEPS_LIST_VERSION = 5;

export interface ClientCompileResult {
  /** 产物 JS 文本（自包含 ESM；共享依赖经 globalThis 命名空间运行时解析）。 */
  code: string
  /** 内容 hash（入口 + 全部本地依赖内容 sha256 + 编译参数）。 */
  contentHash: string
  /** 产物 gzip 预压缩字节（供 HTTP 快速响应）。 */
  gzipped?: Uint8Array
  /** 产物入口模块的具名导出清单（含 CSS 保留导出；doctor 消费做悬空 export 校验）。 */
  exports: string[]
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
  const cached = readCachedResult(stagingDir, depsListPath, rootReal, moduleRef);
  if (cached) {
    recordMemoryCache(memKey, rootReal, depsListPath, cached);
    return cached;
  }

  // 真实编译：metafile 收集实际依赖闭包；onLoad 逐文件 containment；裸依赖显式拒绝。
  // 虚拟 outfile：esbuild 原生 CSS bundling 要求 JS→CSS import 有输出路径（write:false
  // 不落盘，仅用于命名 outputFiles；JS 与 CSS 分别取自 outputFiles）。
  let output = '';
  let entryExports: string[] = [];
  let dependencies: string[];
  let npmDeps: Array<{ root: string; files: string[] }> = [];
  try {
    const result = await build({
      entryPoints: [entryReal],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      jsx: 'automatic',
      write: false,
      minifyWhitespace: true,
      minifyIdentifiers: true,
      sourcemap: false,
      metafile: true,
      absWorkingDir: rootReal,
      outfile: join(stagingDir, `${baseName}.virtual.mjs`),
      logLevel: 'silent',
      plugins: [
        sharedShimPlugin(),
        containmentPlugin(pluginId, rootReal, npmRoots),
        cssPolicyPlugin(pluginId),
      ],
    });
    const jsFiles = result.outputFiles.filter((f) => !f.path.endsWith('.css'));
    const cssFiles = result.outputFiles.filter((f) => f.path.endsWith('.css'));
    if (jsFiles.length !== 1 || cssFiles.length > 1) {
      throw new HelmError(
        'client_compile_failed',
        `插件 ${pluginId} 编译 ${moduleRef} 未产出唯一 JS 文件（JS=${jsFiles.length}，CSS=${cssFiles.length}）`,
        500,
        { pluginId, module: moduleRef },
      );
    }
    if (Object.values(result.metafile.outputs).some((file) => file.exports?.includes(PLUGIN_CLIENT_CSS_EXPORT))) {
      throw new HelmError(
        'client_compile_failed',
        `插件 ${pluginId} 模块 ${moduleRef} 占用了编译器保留导出名 "${PLUGIN_CLIENT_CSS_EXPORT}"，请改名该导出`,
        422,
        { pluginId, module: moduleRef, reservedExport: PLUGIN_CLIENT_CSS_EXPORT },
      );
    }
    const js = jsFiles[0]!.text;
    const css = cssFiles[0]?.text ?? '';
    output = appendCssExport(js, css);
    // 入口具名导出（metafile 权威；键为相对 absWorkingDir 的虚拟 outfile 名，
    // 与 outputFiles 绝对路径一一对应——上面已断言 JS 产物唯一，按后缀匹配安全）。
    const jsMeta = Object.entries(result.metafile.outputs).find(
      ([path]) => !path.endsWith('.css'),
    )?.[1];
    entryExports = [...(jsMeta?.exports ?? []), ...(css.length > 0 ? [PLUGIN_CLIENT_CSS_EXPORT] : [])];
    dependencies = collectLocalDependencies(result.metafile, rootReal);
    npmDeps = collectNpmDependencies(result.metafile, rootReal, npmRoots);
  } catch (err) {
    if (err instanceof HelmError) throw err;
    // esbuild 诊断（语法错误定位 / 越根 / 裸依赖拒绝 / CSS 资源策略）如实上抛，绝不静默截断
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `插件 ${pluginId} 编译 ${moduleRef} 失败：${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  const list = buildDepsList(rootReal, moduleRef, dependencies, npmDeps, entryExports);
  mkdirSync(stagingDir, { recursive: true });
  atomicWrite(join(stagingDir, `${baseName}.${list.contentHash}.mjs`), output);
  let gzipped: Uint8Array | undefined;
  try {
    const gz = gzipSync(Buffer.from(output, 'utf8'));
    atomicWriteBuffer(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`), gz);
    gzipped = gz;
  } catch {
    /* 预压缩失败不影响编译产物主流程 */
  }
  atomicWrite(depsListPath, `${JSON.stringify(list)}\n`);
  const finalResult: ClientCompileResult = {
    code: output,
    contentHash: list.contentHash,
    gzipped,
    exports: entryExports,
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
            const transitive = resolveTransitiveNpmSpecifier(args.path, importerReal);
            if (transitive !== null) {
              authorizeNpmPackageDir(dirname(findPackageDirOf(transitive)));
              return { path: transitive };
            }
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
        if (real === null) return null; // 不存在的文件交回 esbuild 默认报错
        const inClientRoot = isInside(rootReal, real);
        // 受控 npm 闭包：解析期授权表成员（相对导入等直达路径需授权校验）。
        const inNpmRoot = isNpmAuthorized(real);
        if (!inClientRoot && !inNpmRoot) {
          return {
            errors: [{
              text: `插件 ${pluginId} 编译拒绝越界的文件（可能为 ../ 越根、符号链接逃逸或未声明的 npm 解析）：${real}`,
            }],
          };
        }
        return null; // 交回 esbuild 默认 loader
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
  const codePath = join(stagingDir, `${safeFileName(moduleRef)}.${list.contentHash}.mjs`);
  const gzPath = join(stagingDir, `${safeFileName(moduleRef)}.${list.contentHash}.mjs.gz`);
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
    return { code, contentHash: list.contentHash, gzipped, exports: list.exports ?? [] };
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
  return {
    version: DEPS_LIST_VERSION,
    module: moduleRef,
    root: rootReal,
    contentHash: hash.digest('hex').slice(0, 24),
    dependencies: entries,
    ...(npmEntries.length > 0 ? { npmDependencies: npmEntries } : {}),
    ...(entryExports.length > 0 ? { exports: entryExports } : {}),
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
