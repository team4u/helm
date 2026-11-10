/**
 * 后端插件 TypeScript 模块加载器（external-loader 的转译底座）。
 *
 * 机制（Node 24 `module.registerHooks` 主线程同步钩子 + esbuild `transformSync`）：
 * - 只转译「已注册插件根目录」（realpath）内的 .ts/.tsx/.mts/.cts 源文件为 ESM；
 *   文件 URL 就是真实源文件 URL（不落到缓存产物文件），因此 `import.meta.url` /
 *   相对资源定位永远指向插件目录内的真实源文件，不受缓存路径影响；
 * - 模块 identity 由 Node ESM 缓存按 URL 保证：同一路径多次 import 只初始化一次，
 *   与宿主自身模块共享同一注册表（绝不 bundle 一份 @helm/protocol / SDK 造成
 *   instanceof / registry 双份）；
 * - resolve 钩子补齐 TypeScript 习惯的相对导入映射（.js -> .ts/.tsx、.mjs -> .mts、
 *   无扩展名 -> .ts/.tsx / index.ts）。重试仅在原生解析抛 ERR_MODULE_NOT_FOUND
 *   （候选确实缺失）时进行；权限等其他解析错误原样上抛。命中的候选先 realpath：
 *   真实路径越出全部已注册根的（symlink 逃逸）不转译、如实失败；realpath URL
 *   同时保证「.js 映射导入」与「显式 .ts 导入」是同一模块实例（Node 原生对
 *   symlink 也返回 realpath URL，两条路径天然同 URL）；
 * - 裸说明符交给 Node 原生解析：Node 内置模块直接可用，npm 包按「插件目录向上」
 *   的 node_modules 规则解析（插件本目录安装即可生效），`@helm/*` 宿主公共包经
 *   宿主自身 import.meta.resolve 落位（同一实例）；
 * - esbuild 会剥离 ESM import attributes（已知未实现），因此插件内相对 .json 导入
 *   由 load 钩子补注 `type: 'json'`，插件源无需（也无法）写 import attributes；
 * - 源码转译错误（语法 / 类型层面的解析错误）显式抛
 *   `HelmError('plugin_load_failed')`，附文件、行列号与 esbuild 诊断文本。
 *
 * 生命周期：钩子懒注册——首个根注册时 registerHooks，全部根释放时 deregister
 * （只反注册本加载器的钩子实例，不影响宿主进程内其他 hooks）。成功注册的
 * 插件根常驻进程：插件运行期动态 import 的 TS 依赖需要转译可用，且模块已
 * 加载的 URL 在 ESM 缓存中保持 identity。因此「停用 / 卸载插件」不释放根、
 * 不卸载已加载模块（同进程内重启/重新注册不重复初始化）；释放仅发生在
 * 加载失败回退时，只影响后续解析行为。
 *
 * 边界与诚实性：
 * - 根外代码不经本加载器转译，加载能力与结果由 Node 原生决定；根外
 *   .js/.cjs 等文件同样透传 Node——本加载器负责运行可信插件代码，不是
 *   沙箱：可信插件与宿主同权限，路径边界是转译范围的约定而非安全承诺；
 * - 后端 .tsx 的真实用途是「与前端共享源文件形态的纯逻辑模块」（JSX 语法可写、
 *   转译为 react/jsx-runtime 导入，需插件目录自备 react 或改用纯 .ts）；React
 *   组件仍属前端 client.tsx 轨道（client-compiler），此处不做 JSX 运行时注入。
 */
import { registerHooks, type ModuleHooks } from 'node:module';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { HelmError } from '@helm/protocol';

/** 支持转译的 TypeScript 源扩展名（.cts 转译产物仍按 ESM 加载，保持单一模块形态）。 */
const TS_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** Node 原生可解析的 JS 家族扩展名（TS 习惯映射的源形态）。 */
const JS_FAMILY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** 已注册插件根目录（realpath）与引用计数。 */
const rootRefCounts = new Map<string, number>();

/** 懒注册的钩子实例；全部根释放时 deregister（见文件头「生命周期」）。 */
let hooks: ModuleHooks | undefined;

/** 宿主侧包解析器：捕获本模块自身的 import.meta.resolve（跨任意运行环境稳定指向 kernel 工作区）。 */
const hostMetaResolve = import.meta.resolve;

/** target（词法或真实路径）是否位于 root 内（跨平台：relative + sep，不硬编码分隔符）。 */
function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** url 是否位于任一已注册根目录之下（根以 realpath 注册；symlink URL 由 resolve 层消解）。 */
function isInsideAnyRoot(url: string): boolean {
  if (rootRefCounts.size === 0 || !url.startsWith('file:')) return false;
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return false;
  }
  for (const root of rootRefCounts.keys()) {
    if (isInsideRoot(root, path)) return true;
  }
  return false;
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

/** 说明符的扩展名（去 query/fragment；裸包名与子路径统一取尾部段）。 */
function specifierExtension(specifier: string): string {
  const clean = specifier.split('?')[0]!.split('#')[0]!;
  return fileExtension(clean);
}

/**
 * 相对说明符解析失败时的 TypeScript 习惯候选（tsc --module nodenext 的映射子集）。
 * 仅在原生解析确认目标缺失（ERR_MODULE_NOT_FOUND）后逐一探测。
 */
function tsResolutionCandidates(resolvedPath: string): string[] {
  const ext = fileExtension(resolvedPath);
  if (ext === '.js') {
    const stem = resolvedPath.slice(0, -3);
    return [`${stem}.ts`, `${stem}.tsx`];
  }
  if (ext === '.mjs') return [`${resolvedPath.slice(0, -4)}.mts`];
  if (ext === '.cjs') return [`${resolvedPath.slice(0, -4)}.cts`];
  return [`${resolvedPath}.ts`, `${resolvedPath}.tsx`, join(resolvedPath, 'index.ts'), join(resolvedPath, 'index.tsx')];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** .js 家族说明符解析出根外 TS 源：统一拒绝（不转译根外代码，绝不因映射来源不同而口径不一）。 */
function rootEscapeError(specifier: string, candidate: string, real: string): HelmError {
  return new HelmError(
    'plugin_load_failed',
    `外部插件相对依赖 ${specifier} 解析到插件根目录外的 TypeScript 源 ${candidate}（真实路径 ${real}），拒绝转译；如确需引用根外模块，请直接使用其真实扩展名说明符`,
    500,
    { specifier, candidate, real },
  );
}

/** 注册进程钩子（幂等：已注册时复用同一实例）。 */
function ensureHooks(): void {
  if (hooks !== undefined) return;
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (parent === undefined || !isInsideAnyRoot(parent)) {
        return nextResolve(specifier, context);
      }
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        let resolved: { url: string; shortCircuit?: boolean };
        try {
          resolved = nextResolve(specifier, context);
        } catch (err) {
          // 仅「候选确实缺失」才按 TS 习惯重试；权限等其他解析错误原样上抛
          if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
          let target: string;
          try {
            target = fileURLToPath(new URL(specifier, parent));
          } catch {
            throw err;
          }
          for (const candidate of tsResolutionCandidates(target)) {
            if (!isFile(candidate)) continue;
            // realpath：既保证与显式 .ts 导入同 URL（同一模块实例），又拦截
            // symlink 指向根外的候选（越根不转译，绝不把根外源码收编进转译范围）
            let real: string;
            try {
              real = realpathSync(candidate);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === 'ENOENT' || code === 'ENOTDIR') continue;
              throw error;
            }
            if (!isInsideAnyRoot(pathToFileURL(real).href)) {
              throw rootEscapeError(specifier, candidate, real);
            }
            return { url: pathToFileURL(real).href, shortCircuit: true };
          }
          throw err;
        }
        // 后续钩子（如开发期 tsx）可能已在 nextResolve 内完成 .js -> .ts 映射：
        // .js 家族说明符的 TS 扩展结果一律按本加载器策略复核（realpath + 根内），
        // 保证与自射回退同一口径（identity 规范化 + 越根拒绝不因映射来源而异）
        const resolvedUrl = resolved.url;
        if (
          typeof resolvedUrl === 'string' &&
          resolvedUrl.startsWith('file:') &&
          JS_FAMILY_EXTENSIONS.has(specifierExtension(specifier)) &&
          TS_SOURCE_EXTENSIONS.has(fileExtension(resolvedUrl))
        ) {
          let real: string;
          try {
            real = realpathSync(fileURLToPath(resolvedUrl));
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') return resolved;
            throw error;
          }
          if (!isInsideAnyRoot(pathToFileURL(real).href)) {
            throw rootEscapeError(specifier, resolvedUrl, real);
          }
          return { url: pathToFileURL(real).href, shortCircuit: true };
        }
        return resolved;
      }
      // 宿主公共包：用宿主自身解析位置，保证与宿主同一模块实例（不做双份 bundle）。
      // 限定 @helm/*（本仓公共契约包）；其他裸说明符一律按插件目录原生解析。
      if (specifier.startsWith('@helm/')) {
        try {
          const url = hostMetaResolve(specifier);
          if (typeof url === 'string' && url.startsWith('file:')) {
            return { url, shortCircuit: true };
          }
        } catch {
          // 宿主侧也未安装（如 @helm/web 仅前端可用）：落到下方按插件目录原生解析，
          // 仍失败则如实抛 Node 原生 ERR_MODULE_NOT_FOUND
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!isInsideAnyRoot(url)) {
        return nextLoad(url, context);
      }
      const ext = fileExtension(url);
      // 插件内相对 .json：esbuild 转译会剥离 import attributes（源文件写也会被剥），
      // 由宿主在加载边界补注 type=json，插件源 `import x from './x.json'` 直接可用。
      if (ext === '.json') {
        return nextLoad(url, {
          ...context,
          importAttributes: { ...context.importAttributes, type: 'json' },
        });
      }
      if (!TS_SOURCE_EXTENSIONS.has(ext)) {
        return nextLoad(url, context);
      }
      const file = fileURLToPath(url);
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch (err) {
        // 读源失败（权限 / 竞态删除）：如实抛 Node 原生错误，不静默跳过
        throw err;
      }
      let code: string;
      try {
        const result = transformSync(source, {
          loader: ext === '.tsx' ? 'tsx' : 'ts',
          jsx: 'automatic',
          format: 'esm',
          sourcefile: file,
          target: 'node20',
        });
        code = result.code;
      } catch (err) {
        throw transpileError(file, err);
      }
      return { format: 'module', source: code, shortCircuit: true };
    },
  });
}

/** 把 esbuild 转译失败包装成带文件与行列定位的显式 HelmError（绝不静默吞错）。 */
function transpileError(file: string, err: unknown): HelmError {
  const first = (err as { errors?: Array<{ text?: string; location?: { line: number; column: number } }> }).errors?.[0];
  const location = first?.location;
  const position = location ? `${location.line}:${location.column}` : '';
  const detail = first?.text ?? (err instanceof Error ? err.message : String(err));
  return new HelmError(
    'plugin_load_failed',
    `外部插件源码转译失败: ${file}${position ? `:${position}` : ''}（${detail}）`,
    500,
    { file, line: location?.line, column: location?.column, detail },
  );
}

/**
 * 为插件根目录启用后端 TS 转译（引用计数；同一目录重复注册合并，钩子懒注册）。
 * 返回释放函数：计数归零时目录移出转译范围并 deregister 进程钩子（只反注册
 * 本加载器的钩子实例，不影响宿主进程内其他 hooks）。
 */
export function registerPluginTsRoot(rootDir: string): () => void {
  const root = realpathSync(rootDir);
  const count = rootRefCounts.get(root) ?? 0;
  rootRefCounts.set(root, count + 1);
  if (count === 0) ensureHooks();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = rootRefCounts.get(root);
    if (current === undefined) return;
    if (current <= 1) {
      rootRefCounts.delete(root);
      if (rootRefCounts.size === 0 && hooks !== undefined) {
        hooks.deregister();
        hooks = undefined;
      }
    } else {
      rootRefCounts.set(root, current - 1);
    }
  };
}
