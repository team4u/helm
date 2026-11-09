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
import { isAbsolute, join, dirname, relative, sep } from 'node:path';
import { HelmError, PLUGIN_CLIENT_CSS_EXPORT } from '@helm/protocol';
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

/** 依赖清单（deps.json）结构版本；v2 为 CSS-as-JS 旧格式，v3 起为原生 CSS bundling。 */
const DEPS_LIST_VERSION = 3;

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
  version: 3
  module: string
  /** clientRoot realpath（根变更/移动后旧缓存直接失效，不误用）。 */
  root: string
  contentHash: string
  /** 全部本地依赖：相对 root 的路径 + 内容 sha256（含入口自身）。 */
  dependencies: Array<{ path: string; sha256: string }>
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

  // 真实编译：metafile 收集实际依赖闭包；onLoad 逐文件 containment；裸依赖显式拒绝。
  // 虚拟 outfile：esbuild 原生 CSS bundling 要求 JS→CSS import 有输出路径（write:false
  // 不落盘，仅用于命名 outputFiles；JS 与 CSS 分别取自 outputFiles）。
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
      outfile: join(stagingDir, `${baseName}.virtual.mjs`),
      logLevel: 'silent',
      plugins: [
        sharedShimPlugin(),
        containmentPlugin(pluginId, rootReal),
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
    const js = jsFiles[0]!.text;
    const css = cssFiles[0]?.text ?? '';
    output = appendCssExport(js, css);
    dependencies = collectLocalDependencies(result.metafile, rootReal);
  } catch (err) {
    if (err instanceof HelmError) throw err;
    // esbuild 诊断（语法错误定位 / 越根 / 裸依赖拒绝 / CSS 资源策略）如实上抛，绝不静默截断
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
// CSS：序列化为具名导出附在 JS 产物尾部（产物不注入 DOM，加载器负责注入）
// ---------------------------------------------------------------------------

/**
 * 把合并后的 CSS 以保留具名导出名附在 JS 产物尾部。
 *
 * 公开占用：插件自身导出保留名（export 子句或内联 export 声明）时显式拒绝，
 * 否则编译器附贴的导出会与插件语义冲突。
 *
 * 绑定名不直接用保留导出名：源码中未导出的同名局部变量会留存于 bundle 产物
 * （metafile exports 检测不到），直接 append `export const __helmClientCss`
 * 会形成重复声明。这里为 CSS 文本选择一个确定性绑定名，用保守 includes 避让
 * 产物已出现的标识符（逐步追加下划线；非解析/改写，只连缀新声明），再以
 * `export { binding as __helmClientCss }` 导出。
 */
function appendCssExport(js: string, css: string): string {
  if (css.length === 0) return js;
  if (exportClauseHasName(js, PLUGIN_CLIENT_CSS_EXPORT)) {
    throw new HelmError(
      'client_compile_failed',
      `插件 CSS 导出冲突：插件模块自身占用了保留导出名 "${PLUGIN_CLIENT_CSS_EXPORT}"（编译器用它返回合并后的样式文本），请改名该导出`,
      422,
      { reservedExport: PLUGIN_CLIENT_CSS_EXPORT },
    );
  }
  let binding = '__helmCssText';
  while (js.includes(binding)) binding += '_';
  const literal = JSON.stringify(css);
  return `${js}\nconst ${binding} = ${literal};\nexport { ${binding} as ${PLUGIN_CLIENT_CSS_EXPORT} };\n`;
}

interface ExportClause {
  names: string[]
}

/** 产物尾部 `export { ... };` 子句的定位与具名导出清单；无子句返回 null。 */
function exportClauseIndex(js: string): ExportClause | null {
  const re = /\nexport\s*\{([^}]*)\};?\s*$/;
  const m = re.exec(js);
  if (!m) return null;
  const names = (m[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      // `local as exported` / `local as default`：取 as 后的导出名
      const asMatch = /^[\w$]+(?:\s+as\s+([\w$]+))$/.exec(s);
      return asMatch ? (asMatch[1] ?? s) : s;
    });
  return { names };
}

/** 产物是否已导出保留名（export 子句或内联 export 声明形式）。 */
function exportClauseHasName(js: string, name: string): boolean {
  const clause = exportClauseIndex(js);
  if (clause && clause.names.includes(name)) return true;
  const inline = new RegExp(
    `\\bexport\\s+(?:const|let|var|function|class|async\\s+function)\\s+${name.replace(/\$/g, '\\$')}\\b`,
  );
  return inline.test(js);
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
 * - 裸说明符（非共享、非 CSS 语法引用）→ 显式编译错误（当前不支持 npm 安装；绝不解析
 *   node_modules）；CSS url()/@import 引用交由 cssPolicyPlugin 处理；
 * - 本地文件 onLoad 阶段 realpath containment：越出 clientRoot realpath（含符号链接
 *   逃逸和 CSS @import 越根）即拒绝——旧实现只检查入口，依赖文件可把根外代码带进 bundle。
 */
function containmentPlugin(pluginId: string, rootReal: string): EsbuildPlugin {
  return {
    name: 'helm-containment',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        // CSS 语法引用（url() 资源 / @import）不是 npm 说明符：交由 cssPolicyPlugin
        // 按资源策略处理（data:/https: 放行，本地相对显式拒绝），绝不误报裸依赖
        if (args.kind === 'url-token' || args.kind === 'import-rule') return null;
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
      b.onResolve({ filter: /.*/, namespace: 'file' }, (args) => {
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
  hash.update(`helm-plugin-client-v${DEPS_LIST_VERSION}\n`);
  hash.update(`module:${moduleRef}\n`);
  const entries = dependencies.map((abs) => {
    const rel = relative(rootReal, abs);
    const sha = sha256(readFileSync(abs, 'utf8'));
    hash.update(`--file:${rel}\n${sha}\n`);
    return { path: rel, sha256: sha };
  });
  return {
    version: DEPS_LIST_VERSION,
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
