/**
 * 后端插件 TypeScript 模块加载器（external-loader 的转译底座）。
 *
 * 机制（Node 24 `module.registerHooks` 主线程同步钩子 + esbuild `transformSync`）：
 * - 只转译「已注册插件根目录」内的 .ts/.tsx/.mts/.cts 源文件为 ESM；文件 URL 就是
 *   真实源文件 URL（不落到缓存产物文件），因此 `import.meta.url` / 相对资源定位
 *   永远指向插件目录内的真实源文件，不受缓存路径影响；
 * - 模块 identity 由 Node ESM 缓存按 URL 保证：同一路径多次 import 只初始化一次，
 *   与宿主自身模块共享同一注册表（绝不 bundle 一份 @helm/protocol / SDK 造成
 *   instanceof / registry 双份）；
 * - resolve 钩子补齐 TypeScript 习惯的相对导入映射（.js -> .ts/.tsx、.mjs -> .mts、
 *   无扩展名 -> .ts/.tsx / index.ts）。裸说明符交给 Node 原生解析：Node 内置模块
 *   直接可用，npm 包按「插件目录向上」的 node_modules 规则解析（插件本目录安装
 *   即可生效），`@helm/*` 宿主公共包回落到宿主自身解析结果（同一实例）；
 * - esbuild 会剥离 ESM import attributes（已知未实现），因此插件内相对 .json 导入
 *   由 load 钩子补注 `type: 'json'`，插件源无需（也无法）写 import attributes；
 * - 源码转译错误（语法 / 类型层面的解析错误）显式抛
 *   `HelmError('plugin_load_failed')`，附文件、行列号与 esbuild 诊断文本。
 *
 * 边界与诚实性：
 * - registerHooks 无法反注册（Node 24 限制），故钩子常驻进程但 roots 集合归零后
 *   对任何文件都是纯透传（零行为）；根目录集合跨多次加载共享，同一插件目录重复
 *   注册按引用计数合并；
 * - 后端 .tsx 的真实用途是「与前端共享源文件形态的纯逻辑模块」（JSX 语法可写、
 *   转译为 react/jsx-runtime 导入，需插件目录自备 react 或改用纯 .ts）；React
 *   组件仍属前端 client.tsx 轨道（client-compiler），此处不做 JSX 运行时注入；
 * - 该加载器只负责「正确地运行可信插件代码」，不是沙箱：插件代码与宿主同权限。
 */
import { registerHooks } from 'node:module';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { HelmError } from '@helm/protocol';

/** 支持转译的 TypeScript 源扩展名（.cts 转译产物仍按 ESM 加载，保持单一模块形态）。 */
const TS_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** 已注册插件根目录（realpath）与引用计数。 */
const rootRefCounts = new Map<string, number>();

/** 宿主侧包解析器：捕获本模块自身的 import.meta.resolve（跨任意运行环境稳定指向 kernel 工作区）。 */
const hostMetaResolve = import.meta.resolve;

/** url 是否位于任一已注册根目录之下（词法前缀判定；入口 realpath 已由 loader 保证）。 */
function isInsideAnyRoot(url: string): boolean {
  if (rootRefCounts.size === 0 || !url.startsWith('file:')) return false;
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return false;
  }
  for (const root of rootRefCounts.keys()) {
    if (path === root || path.startsWith(`${root}/`)) return true;
  }
  return false;
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

/** 相对说明符解析失败时的 TypeScript 习惯候选（tsc --module nodenext 的映射子集）。 */
function tsResolutionCandidates(resolvedPath: string): string[] {
  const ext = fileExtension(resolvedPath);
  if (ext === '.js') {
    const stem = resolvedPath.slice(0, -3);
    return [`${stem}.ts`, `${stem}.tsx`];
  }
  if (ext === '.mjs') return [`${resolvedPath.slice(0, -4)}.mts`];
  if (ext === '.cjs') return [`${resolvedPath.slice(0, -4)}.cts`];
  // 目录形态（解析器已补 index 前但未命中的场合）与无扩展名形态都回落 ts 探测
  return [`${resolvedPath}.ts`, `${resolvedPath}.tsx`, join(resolvedPath, 'index.ts'), join(resolvedPath, 'index.tsx')];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// 常驻进程的同步钩子：roots 为空时全部透传（零行为）。见文件头「边界与诚实性」。
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (parent === undefined || !isInsideAnyRoot(parent)) {
      return nextResolve(specifier, context);
    }
    // 相对导入：Node 原生解析失败后按 TS 习惯映射重试（.js -> .ts 等）
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        let target: string;
        try {
          target = fileURLToPath(new URL(specifier, parent));
        } catch {
          throw err;
        }
        for (const candidate of tsResolutionCandidates(target)) {
          if (isFile(candidate)) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          }
        }
        throw err;
      }
    }
    // 宿主公共包：用宿主自身解析位置，保证与宿主同一模块实例（不做双份 bundle）。
    // 限定 @helm/*（本仓公共契约包）；其他裸说明符一律按插件目录原生解析。
    if (specifier.startsWith('@helm/')) {
      try {
        const url = hostMetaResolve(specifier)
        if (typeof url === 'string' && url.startsWith('file:')) {
          return { url, shortCircuit: true }
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
 * 为插件根目录启用后端 TS 转译（引用计数；同一目录重复注册合并）。
 * 返回取消函数：计数归零后该目录不再参与转译。
 */
export function registerPluginTsRoot(rootDir: string): () => void {
  let root: string;
  try {
    root = realpathSync(rootDir);
  } catch {
    root = rootDir; // 入口存在性由 external-loader 显式校验，这里不重复报错
  }
  const count = rootRefCounts.get(root) ?? 0;
  rootRefCounts.set(root, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = rootRefCounts.get(root);
    if (current === undefined) return;
    if (current <= 1) rootRefCounts.delete(root);
    else rootRefCounts.set(root, current - 1);
  };
}

/** 测试与诊断用：当前已注册的插件根目录快照。 */
export function registeredPluginTsRoots(): string[] {
  return [...rootRefCounts.keys()].sort();
}
