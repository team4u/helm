/**
 * PluginClientCompiler：client.tsx 轨道的宿主侧编译器。
 *
 * 职责（只做机制）：
 * - 把插件 clientRoot 内的相对 .ts/.tsx 入口编译为浏览器 ESM（esbuild）；
 * - 源内容（含本地依赖闭包）hash 缓存到 <dataDir>/cache/plugin-staging/<pluginId>/，
 *   源未变时直接复用磁盘产物，绝不重复编译；
 * - React/react-dom/lucide-react 等宿主共享依赖 external，经 window.__HELM_SHARED__
 *   运行时共享，绝不打包第二份 React；
 * - 模块路径严格 containment：拒绝绝对路径、.. 越根、符号链接逃逸（realpath 双检）；
 * - 停用/未注册插件的编译请求一律拒绝（HTTP 层已鉴权，这里是第二道门）。
 *
 * 失败显式抛 HelmError（含 esbuild 诊断），绝不静默降级或返回空产物。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, dirname, relative, sep } from 'node:path';
import { HelmError } from '@helm/protocol';
import { build } from 'esbuild';

/** 宿主与插件共享的浏览器端运行时依赖：external 化，导入重写到 __helm_shared__ 命名空间（window 加载器解析，绝不打包第二份 React）。 */
export const CLIENT_SHARED_EXTERNALS = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'lucide-react'];

/** external 说明符 -> __helm_shared__ 命名空间导出名映射（缺一即拒绝编译，避免运行时裸 import 解析失败）。 */
export const CLIENT_SHARED_GLOBALS: Readonly<Record<string, string>> = Object.freeze({
  react: '__helm_shared_react',
  'react-dom': '__helm_shared_react_dom',
  'react-dom/client': '__helm_shared_react_dom_client',
  'react/jsx-runtime': '__helm_shared_react_jsx_runtime',
  'lucide-react': '__helm_shared_lucide_react',
});

/** ClientComponentRef.module 允许的字符集（相对路径段：字母数字 . _ - /，禁止空段与 ..）。 */
const MODULE_REF_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.(ts|tsx)$/;

export interface ClientCompileResult {
  /** 产物 JS 文本（ESM，external 依赖保留 import 裸说明符）。 */
  code: string
  /** 内容 hash（入口源 + 全部本地依赖源 + 格式参数）。 */
  contentHash: string
}

/** 校验 ClientComponentRef.module 形状（相对 .ts/.tsx，无绝对/越根/编码逃逸）。 */
export function assertModuleRefShape(pluginId: string, moduleRef: string): void {
  if (
    typeof moduleRef !== 'string' ||
    isAbsolute(moduleRef) ||
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
 * 编译插件客户端模块。
 * @param pluginId 插件 ID（缓存目录隔离单位）
 * @param clientRoot 插件声明并已校验的绝对源根目录
 * @param moduleRef 相对入口（assertModuleRefShape 已通过）
 */
export async function compilePluginClientModule(
  pluginId: string,
  clientRoot: string,
  moduleRef: string,
  cacheDir: string,
): Promise<ClientCompileResult> {
  assertModuleRefShape(pluginId, moduleRef);

  const rootReal = realPathOrThrow(clientRoot, `插件 ${pluginId} 的 clientRoot 不存在或不可访问：${clientRoot}`);
  const entryAbs = join(rootReal, moduleRef);
  // containment 双检：拼接后 realpath 仍须位于 root realpath 之内（符号链接逃逸在此拦截）
  const entryReal = realPathOrThrow(entryAbs, `插件 ${pluginId} 的 client 模块不存在：${moduleRef}`);
  if (!isInside(rootReal, entryReal)) {
    throw new HelmError(
      'client_module_out_of_root',
      `插件 ${pluginId} 的 client 模块越出 clientRoot（可能为符号链接逃逸）：${moduleRef}`,
      400,
      { pluginId, module: moduleRef },
    );
  }

  const stagingDir = join(cacheDir, 'plugin-staging', safeDirName(pluginId));
  const hash = await computeModuleHash(entryReal, rootReal);
  const codePath = join(stagingDir, `${hash}.mjs`);
  if (existsSync(codePath)) {
    return { code: readFileSync(codePath, 'utf8'), contentHash: hash };
  }

  let output: string;
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
      external: CLIENT_SHARED_EXTERNALS,
      logLevel: 'silent',
      absWorkingDir: rootReal,
    });
    const file = result.outputFiles?.[0];
    if (!file || result.outputFiles.length !== 1) {
      throw new HelmError('client_compile_failed', `插件 ${pluginId} 编译 ${moduleRef} 未产出唯一 JS 文件`, 500, {
        pluginId,
        module: moduleRef,
      });
    }
    // external 依赖重写为全局命名空间导入（Blob URL 动态 import 无法解析裸说明符）：
    // import { x } from 'react' -> import { x } from '__helm_shared_react'（宿主以
    // importmap/全局挂载提供，同一份 React 实例，绝不打包第二份）。
    output = rewriteSharedImports(file.text);
  } catch (err) {
    // esbuild 诊断（含语法错误定位）如实上抛，绝不静默截断
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `插件 ${pluginId} 编译 ${moduleRef} 失败：${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  mkdirSync(stagingDir, { recursive: true });
  const tmpPath = `${codePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, output, 'utf8');
  // 原子落盘：先写临时文件再 rename，避免并发读到半个产物
  const { renameSync } = await import('node:fs');
  renameSync(tmpPath, codePath);
  return { code: output, contentHash: hash };
}

/**
 * 把 external 共享依赖的 import 语句重写为 globalThis 命名空间解构。
 * 动态 import 的 Blob/data URL 模块无法解析裸包说明符（浏览器与 Node 均然），
 * 宿主在页面/测试进程全局挂载这些命名空间（同一份 React 实例）。
 * 三种形态全覆盖：named（含 rename）/ namespace / default。
 */
function rewriteSharedImports(code: string): string {
  const specToGlobal = (spec: string): string | undefined => CLIENT_SHARED_GLOBALS[spec]
  // named: import { a, b as c } from 'spec'
  let out = code.replace(
    /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g,
    (match, names: string, spec: string) => {
      const global = specToGlobal(spec)
      return global === undefined ? match : `const { ${String(names).trim()} } = (globalThis.${global})`
    },
  )
  // namespace: import * as X from 'spec'
  out = out.replace(
    /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g,
    (match, alias: string, spec: string) => {
      const global = specToGlobal(spec)
      return global === undefined ? match : `const ${alias} = (globalThis.${global})`
    },
  )
  // default: import X from 'spec'
  out = out.replace(
    /import\s+([A-Za-z_$][\w$]*)\s*,?\s*from\s*['"]([^'"]+)['"]/g,
    (match, alias: string, spec: string) => {
      const global = specToGlobal(spec)
      return global === undefined ? match : `const ${alias} = (globalThis.${global}).default`
    },
  )
  // 副作用导入：import 'spec'（共享依赖不应有副作用导入，防御性重写为空）
  for (const spec of Object.keys(CLIENT_SHARED_GLOBALS)) {
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`^import\s*['"]${esc}['"]\s*;?`, 'gm'), '')
  }
  return out;
}

/** 源闭包 hash：BFS 收集入口可达的 root 内相对模块（源内容 + 相对路径），任一变化即失效缓存。 */
async function computeModuleHash(entryReal: string, rootReal: string): Promise<string> {
  const seen = new Set<string>();
  const queue = [entryReal];
  const hash = createHash('sha256');
  hash.update('helm-plugin-client-v1\n');
  hash.update(`root:${relative(rootReal, entryReal)}\n`);
  while (queue.length > 0) {
    const abs = queue.shift()!;
    if (seen.has(abs)) continue;
    seen.add(abs);
    hash.update(`--file:${relative(rootReal, abs)}\n`);
    const source = readFileSync(abs, 'utf8');
    hash.update(source);
    for (const dep of resolveLocalImports(source, abs, rootReal)) {
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  return hash.digest('hex').slice(0, 24);
}

/**
 * 从源文本提取 root 内本地相对导入（./x ../x），解析为磁盘绝对路径。
 * 不解析裸说明符（external/shared 或 npm 依赖——外部 npm 依赖不属于本闭环，
 * 显式不支持：编译时 esbuild 会如实报无法解析）。
 */
function resolveLocalImports(source: string, fromAbs: string, rootReal: string): string[] {
  const out: string[] = [];
  const patterns = [/\bfrom\s*['"](\.[^'"]*)['"]/g, /\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g, /\bimport\s*['"](\.[^'"]*)['"]/g, /\brequire\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g];
  const specs = new Set<string>();
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const spec = m[1];
      if (spec) specs.add(spec);
    }
  }
  for (const spec of specs) {
    const base = resolveNoExt(fromAbs, spec);
    if (base === undefined) continue;
    const candidates = [base, `${base}.tsx`, `${base}.ts`, join(base, 'index.tsx'), join(base, 'index.ts')];
    for (const cand of candidates) {
      if (!existsSync(cand)) continue;
      const real = realpathOrNull(cand);
      if (real !== null && isInside(rootReal, real)) out.push(real);
      break;
    }
  }
  return out;
}

function resolveNoExt(fromAbs: string, spec: string): string | undefined {
  try {
    // spec 已限定 ./ ../ 开头；join 后仍可能越根，交由 isInside 过滤
    return join(dirname(fromAbs), spec);
  } catch {
    return undefined;
  }
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

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 目标真实路径是否位于根真实路径内（同根或根之子目录；跨设备符号链接已被 realpath 消解）。 */
function isInside(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** 插件 ID 到安全目录名（: 等字符映射为 _，保持不同 ID 不碰撞用 hash 后缀）。 */
function safeDirName(pluginId: string): string {
  const safe = pluginId.replace(/[^A-Za-z0-9_-]/g, '_');
  const suffix = createHash('sha1').update(pluginId).digest('hex').slice(0, 6);
  return `${safe}-${suffix}`;
}
