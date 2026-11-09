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
 * - containment：入口与每个被加载的本地文件 realpath 都必须位于 clientRoot realpath
 *   之内（符号链接逃逸逐文件拦截）；非共享裸依赖（npm 包）显式拒绝——当前不支持
 *   npm 安装，绝不把 node_modules 或根外文件悄悄打进 bundle；
 * - 产物落盘：randomUUID 临时文件 + rename 原子改名；同 (pluginId, module, root)
 *   并发编译合并同一 in-flight Promise，失败清除可重试。
 *
 * 失败显式抛 HelmError（含 esbuild 诊断），绝不静默降级或返回空产物。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { isAbsolute, join, dirname, relative, sep } from 'node:path';
import { HelmError } from '@helm/protocol';
import { build, type Plugin as EsbuildPlugin } from 'esbuild';

/**
 * 宿主与插件共享的浏览器端运行时依赖：编译期拦截为虚拟 shim 模块（绝不解析
 * node_modules），运行时经 globalThis.__helm_shared_* 命名空间取宿主同一实例。
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

export interface ClientCompileResult {
  /** 产物 JS 文本（自包含 ESM；共享依赖经 globalThis 命名空间运行时解析）。 */
  code: string
  /** 内容 hash（入口 + 全部本地依赖内容 sha256 + 编译参数）。 */
  contentHash: string
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
): Promise<ClientCompileResult> {
  assertModuleRefShape(pluginId, moduleRef);
  const key = `${pluginId}\0${moduleRef}\0${realPathOrThrow(clientRoot, `插件 ${pluginId} 的 clientRoot 不可访问：${clientRoot}`)}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = compileUncached(pluginId, clientRoot, moduleRef, cacheDir).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

/** 依赖清单（deps.json）结构：跨重启可复查的缓存凭据。 */
interface DepsListFile {
  version: 2
  module: string
  /** clientRoot realpath（根变更/移动后旧缓存直接失效，不误用）。 */
  root: string
  contentHash: string
  /** 全部本地依赖：相对 root 的路径 + 内容 sha256（含入口自身）。 */
  dependencies: Array<{ path: string; sha256: string }>
}

function cssAsJsPlugin(pluginId: string, moduleRef: string): EsbuildPlugin {
  return {
    name: 'helm-plugin-css',
    setup(b) {
      b.onLoad({ filter: /\.css$/, namespace: 'file' }, (args) => {
        const source = readFileSync(args.path, 'utf8');
        // @import/url() 在注入页面后会相对页面解析，而非插件目录；静默错误基址
        // 比显式拒绝更危险（样式会莫名指向宿主路径）。
        const unsupported = /@import\b|url\(/i.exec(source);
        if (unsupported !== null) {
          return {
            errors: [{
              text:
                `插件 ${pluginId} 的样式 ${args.path} 含 ${unsupported[0]}：` +
                '插件样式必须自包含（不支持 @import 与 url()，避免相对页面解析错基址）',
            }],
          };
        }
        const key = `${pluginId}::${moduleRef}`;
        const contents = [
          `const css = ${JSON.stringify(source)};`,
          'if (typeof document !== "undefined") {',
          `  const key = ${JSON.stringify(key)};`,
          '  let sheet = null;',
          '  for (const node of document.querySelectorAll("style[data-helm-plugin-css]")) {',
          '    if (node.dataset.helmPluginCss === key) { sheet = node; break; }',
          '  }',
          '  if (sheet === null) {',
          '    sheet = document.createElement("style");',
          '    sheet.dataset.helmPluginCss = key;',
          `    sheet.dataset.helmPluginCssPlugin = ${JSON.stringify(pluginId)};`,
          '    document.head.appendChild(sheet);',
          '  }',
          '  sheet.textContent = css;',
          '}',
          'export default css;',
        ].join('\n');
        return { contents, loader: 'js' };
      });
    },
  };
}

async function compileUncached(
  pluginId: string,
  clientRoot: string,
  moduleRef: string,
  cacheDir: string,
): Promise<ClientCompileResult> {
  const rootReal = realPathOrThrow(
    clientRoot,
    `插件 ${pluginId} 的 clientRoot 不存在或不可访问：${clientRoot}`,
  );
  const entryReal = assertEntryInsideRoot(pluginId, rootReal, moduleRef);

  const stagingDir = join(cacheDir, 'plugin-staging', safeDirName(pluginId));
  const baseName = safeFileName(moduleRef);
  const depsListPath = join(stagingDir, `${baseName}.deps.json`);

  // 缓存复查：清单合法且每个依赖 sha256 与磁盘一致时复用产物，零编译
  const cached = readCachedResult(stagingDir, depsListPath, rootReal, moduleRef);
  if (cached) return cached;

  // 真实编译：metafile 收集实际依赖闭包；onLoad 逐文件 containment；裸依赖显式拒绝
  let output = '';
  let dependencies: string[];
  try {
    const result = await build({
      entryPoints: [entryReal],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      jsx: 'automatic',
      write: false,
      minify: false,
      sourcemap: false,
      metafile: true,
      absWorkingDir: rootReal,
      logLevel: 'silent',
      plugins: [sharedShimPlugin(), containmentPlugin(pluginId, rootReal), cssAsJsPlugin(pluginId, moduleRef)],
    });
    const file = result.outputFiles?.[0];
    if (!file || result.outputFiles.length !== 1) {
      throw new HelmError('client_compile_failed', `插件 ${pluginId} 编译 ${moduleRef} 未产出唯一 JS 文件`, 500, {
        pluginId,
        module: moduleRef,
      });
    }
    output = file.text;
    dependencies = collectLocalDependencies(result.metafile, rootReal);
  } catch (err) {
    // esbuild 诊断（语法错误定位 / 越根 / 裸依赖拒绝）如实上抛，绝不静默截断
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `插件 ${pluginId} 编译 ${moduleRef} 失败：${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  const list = buildDepsList(rootReal, moduleRef, dependencies);
  mkdirSync(stagingDir, { recursive: true });
  atomicWrite(join(stagingDir, `${baseName}.${list.contentHash}.mjs`), output);
  atomicWrite(depsListPath, `${JSON.stringify(list)}\n`);
  return { code: output, contentHash: list.contentHash };
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
 * esbuild 插件：
 * - 裸说明符（非共享）→ 显式编译错误（当前不支持 npm 安装；绝不解析 node_modules）；
 * - 本地文件 onLoad 阶段 realpath containment：越出 clientRoot realpath（含符号链接
 *   逃逸与 ../ 相对越根）即拒绝——旧实现只检查入口，依赖文件可把根外代码带进 bundle。
 */
function containmentPlugin(pluginId: string, rootReal: string): EsbuildPlugin {
  return {
    name: 'helm-containment',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        // 共享说明符由 sharedShimPlugin（先注册）处理，这里只剩非共享裸依赖
        const importer = args.importer || '入口';
        return {
          errors: [{
            text:
              `插件 ${pluginId} 编译拒绝裸依赖 "${args.path}"（被 ${importer} 引入）：` +
              `当前不支持 npm 包安装；clientRoot 内只允许相对导入与共享依赖（${CLIENT_SHARED_EXTERNALS.join(', ')}）`,
          }],
        };
      });
      b.onLoad({ filter: /\.[cm]?[jt]sx?$|\.json$|\.css$/ }, (args) => {
        if (args.namespace !== 'file') return null;
        const real = realpathOrNull(args.path);
        if (real === null) return null; // 不存在的文件交回 esbuild 默认报错
        if (!isInside(rootReal, real)) {
          return {
            errors: [{
              text: `插件 ${pluginId} 编译拒绝越出 clientRoot 的文件（可能为 ../ 越根或符号链接逃逸）：${real}`,
            }],
          };
        }
        return null; // 交回 esbuild 默认 loader
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
    list.version !== 2 ||
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
  const codePath = join(stagingDir, `${safeFileName(moduleRef)}.${list.contentHash}.mjs`);
  if (!existsSync(codePath)) return undefined;
  try {
    return { code: readFileSync(codePath, 'utf8'), contentHash: list.contentHash };
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

/** 组装依赖清单：逐依赖 sha256（内容寻址，跨重启稳定；不依赖 mtime）。 */
function buildDepsList(rootReal: string, moduleRef: string, dependencies: string[]): DepsListFile {
  const hash = createHash('sha256');
  hash.update('helm-plugin-client-v2\n');
  hash.update(`module:${moduleRef}\n`);
  const entries = dependencies.map((abs) => {
    const rel = relative(rootReal, abs);
    const sha = sha256(readFileSync(abs, 'utf8'));
    hash.update(`--file:${rel}\n${sha}\n`);
    return { path: rel, sha256: sha };
  });
  return {
    version: 2,
    module: moduleRef,
    root: rootReal,
    contentHash: hash.digest('hex').slice(0, 24),
    dependencies: entries,
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
