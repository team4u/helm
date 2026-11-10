/**
 * 外部插件目录自动发现与动态加载器。
 *
 * `<dataDir>/plugins/` 下混杂两类目录（关键背景：PluginHost.register 会为每个
 * 已注册插件创建 `<dataDir>/plugins/<pluginId>` 作为其 ctx.dataDir）：
 * 1. 已注册插件的纯数据目录（如 `builtin:profile`、`builtin:herdr`）；
 * 2. 用户放入的外部第三方插件目录（含 plugin.json 或约定入口文件）。
 *
 * 判定规则（只认「插件入口」标记，绝不靠目录名猜测）：
 * - 存在 `plugin.json` → 必须是可解析的 JSON 对象；按 `main`（缺省回落约定
 *   入口探测）解析入口文件相对路径，严格校验不越出插件目录（防路径穿越，
 *   realpath 保证真实入口不越 root）。清单损坏 / 非对象 / main 非法 /
 *   入口越界 / 入口缺失一律显式 HelmError，绝不静默吞错（诚实性纪律）；
 * - 无 `plugin.json` → 依次探测 `index.ts` / `index.tsx` / `index.mjs` /
 *   `index.js` / `plugin.ts` / `plugin.tsx` / `plugin.mjs` / `plugin.js`；
 *   一个都不存在 → 只是普通插件数据目录，静默跳过。
 * - 入口为 .ts/.tsx/.mts/.cts 时由 backend-ts-loader 在进程内转译加载
 *   （源码即模块 URL，import.meta.url 指向插件真实源文件；相对 .js -> .ts
 *   映射、Node 内置 / 插件目录 npm 依赖、@helm/* 宿主同一实例全部可用）。
 * - IO 错误区分：仅 ENOENT / ENOTDIR 表示「文件不存在」；EACCES 等其他
 *   IO 错误显式抛错，绝不误判为纯数据目录跳过。
 *
 * 安全默认：
 * - 动态加载经 `pathToFileURL` 显式 URL 导入；
 * - 外部插件 id 禁止 `builtin:` 前缀（不冒充内置）、禁止与已注册插件重名；
 * - `locked` 声明一律剥离（外部插件不可自封常驻不可卸载）；
 * - 只接受 `definePlugin`（protocol PluginDefinition 唯一入口；项目明确
 *   不做兼容别名，`setup` 等旧形态在边界显式拒绝）；
 * - 注册一律 `{ enabled: false }`（最小权限）；曾持久化
 *   `config.json.pluginEnabled[id] = true` 的由 PluginHost.register 内部
 *   查询 persistedEnabled 自动恢复启用；
 * - 未显式设置 clientRoot 的外部插件默认 clientRoot = 插件目录本身；
 *   clientRoot 必须是非空字符串，相对 clientRoot 解析为插件目录内绝对路径
 *   （越界显式拒绝）。该校验只是路径边界约定（插件代码本身拥有宿主权限，
 *   并不构成安全沙箱承诺）。
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HelmError, type PluginDefinition, type PluginSummary } from '@helm/protocol';
import { registerPluginTsRoot } from './backend-ts-loader.js';

/** 加载器所需的最小宿主形状（真实 PluginHost 结构兼容，便于独立测试）。 */
export interface ExternalPluginHost {
  register(definition: PluginDefinition, options?: { enabled?: boolean }): Promise<void>;
  list(): PluginSummary[] | Promise<PluginSummary[]>;
}

/** 无 plugin.json（或 main 缺省）时的约定入口探测顺序（TypeScript 优先，同 pi 习惯）。 */
const CONVENTION_ENTRIES = [
  'index.ts',
  'index.tsx',
  'index.mjs',
  'index.js',
  'plugin.ts',
  'plugin.tsx',
  'plugin.mjs',
  'plugin.js',
] as const;

/**
 * 扫描 `<dataDir>/plugins/` 并动态加载全部外部插件（默认停用注册）。
 * 返回本次成功注册的外部插件 id 列表（按目录扫描顺序）。
 */
export async function loadExternalPlugins(dataDir: string, plugins: ExternalPluginHost): Promise<string[]> {
  const pluginsDir = join(dataDir, 'plugins');
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const registered: string[] = [];
  for (const entry of entries) {
    // 数据目录（builtin:profile 等）与隐藏目录一律不参与外部插件发现
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('builtin:')) continue;
    const dirPath = resolve(pluginsDir, entry.name);
    const entryPath = await resolvePluginEntry(dirPath);
    if (entryPath === undefined) continue; // 纯插件数据目录：静默跳过
    // 为插件目录启用后端 TS 转译（含运行期动态 import 的相对 TS 依赖）；
    // 加载失败释放计数，成功则常驻本进程（插件模块永不重复初始化）。
    const releaseTsRoot = registerPluginTsRoot(dirPath);
    let definition: PluginDefinition;
    try {
      definition = await importPluginDefinition(dirPath, entryPath);
    } catch (err) {
      releaseTsRoot();
      throw err;
    }
    const existingIds = new Set((await plugins.list()).map((summary) => summary.id));
    if (existingIds.has(definition.id)) {
      throw new HelmError(
        'plugin_already_registered',
        `外部插件 ${dirPath} 的 id 与已注册插件冲突: ${definition.id}`,
        409,
        { dirPath, id: definition.id },
      );
    }
    const normalized = normalizeDefinition(definition, dirPath);
    await plugins.register(normalized, { enabled: false });
    registered.push(normalized.id);
  }
  return registered;
}

// ---------------------------------------------------------------------------
// 入口解析
// ---------------------------------------------------------------------------

/**
 * 解析插件目录的入口文件：undefined 表示无任何插件入口标记（纯数据目录）。
 * plugin.json 存在时走 manifest 分支（错误一律显式抛出，绝不静默跳过）。
 */
async function resolvePluginEntry(dirPath: string): Promise<string | undefined> {
  const manifestPath = join(dirPath, 'plugin.json');
  let manifestExists = true;
  try {
    statSync(manifestPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      // EACCES 等真实 IO 故障显式报错，不误判为纯数据目录
      throw new HelmError(
        'plugin_scan_failed',
        `外部插件目录不可读: ${manifestPath}（${err instanceof Error ? err.message : String(err)}）`,
        500,
        { manifestPath, code },
      );
    }
    manifestExists = false;
  }
  if (!manifestExists) {
    return probeConventionEntry(dirPath);
  }
  const manifest = readManifest(manifestPath);
  const main = manifest['main'];
  if (main === undefined) {
    const probed = probeConventionEntry(dirPath);
    if (probed !== undefined) return probed;
    throw new HelmError(
      'plugin_entry_missing',
      `外部插件 ${dirPath} 的 plugin.json 未声明 main 且目录内无约定入口（${CONVENTION_ENTRIES.join(' / ')}）`,
      500,
      { dirPath },
    );
  }
  if (typeof main !== 'string' || main.length === 0) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件 ${dirPath} 的 plugin.json main 必须是非空字符串`,
      500,
      { dirPath, main: String(main) },
    );
  }
  const entry = resolve(dirPath, main);
  const rel = relative(realpathSync(dirPath), entry);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件 ${dirPath} 的 plugin.json main 越出插件目录: ${main}`,
      400,
      { dirPath, main },
    );
  }
  return assertEntryFile(dirPath, main, entry);
}

/**
 * 确认入口是存在的普通文件并返回 realpath（symlink 链到目录外时 realpath
 * 越界显式拒绝，保证真实入口不越 root）。
 */
function assertEntryFile(dirPath: string, main: string, entry: string): string {
  let real: string;
  let isFile: boolean;
  try {
    real = realpathSync(entry);
    isFile = statSync(real).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new HelmError('plugin_entry_missing', `外部插件 ${dirPath} 的入口文件不存在: ${main}`, 500, {
        dirPath,
        main,
      });
    }
    throw new HelmError(
      'plugin_scan_failed',
      `外部插件入口不可读: ${entry}（${err instanceof Error ? err.message : String(err)}）`,
      500,
      { dirPath, main, code },
    );
  }
  if (!isFile) {
    throw new HelmError('plugin_entry_missing', `外部插件 ${dirPath} 的入口不是普通文件: ${main}`, 500, {
      dirPath,
      main,
    });
  }
  const rel = relative(realpathSync(dirPath), real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件 ${dirPath} 的 plugin.json main（含符号链接）越出插件目录: ${main}`,
      400,
      { dirPath, main },
    );
  }
  return real;
}

/** 依次探测约定入口文件；命中即返回绝对路径，全部缺失返回 undefined。 */
function probeConventionEntry(dirPath: string): string | undefined {
  for (const name of CONVENTION_ENTRIES) {
    let file: boolean;
    try {
      file = statSync(join(dirPath, name)).isFile();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new HelmError(
          'plugin_scan_failed',
          `外部插件目录探测失败: ${join(dirPath, name)}（${err instanceof Error ? err.message : String(err)}）`,
          500,
          { dirPath, code },
        );
      }
      continue;
    }
    if (file) return assertEntryFile(dirPath, name, join(dirPath, name));
  }
  return undefined;
}

/** 读取并解析 plugin.json；损坏 / 非对象一律显式 plugin_manifest_invalid。 */
function readManifest(manifestPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件清单读取失败: ${manifestPath}（${err instanceof Error ? err.message : String(err)}）`,
      500,
      { manifestPath },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件清单不是合法 JSON: ${manifestPath}（${err instanceof Error ? err.message : String(err)}）`,
      500,
      { manifestPath },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件清单必须是 JSON 对象: ${manifestPath}`,
      500,
      { manifestPath },
    );
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 模块导入与定义校验
// ---------------------------------------------------------------------------

/** 动态导入入口模块并提取 default / plugin 导出为插件定义。 */
async function importPluginDefinition(dirPath: string, entryPath: string): Promise<PluginDefinition> {
  let mod: { default?: unknown; plugin?: unknown };
  try {
    mod = (await import(pathToFileURL(entryPath).href)) as { default?: unknown; plugin?: unknown };
  } catch (err) {
    if (err instanceof HelmError) throw err; // 转译错误已带定位，原样上抛
    throw new HelmError(
      'plugin_load_failed',
      `外部插件模块加载失败: ${entryPath}（${err instanceof Error ? err.message : String(err)}）`,
      500,
      { dirPath, entryPath, cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined },
    );
  }
  const candidate = mod.default ?? mod.plugin;
  return assertExternalDefinition(candidate, dirPath);
}

/**
 * 边界校验外部模块导出的定义形状：非空字符串 id / name + definePlugin 函数；
 * id 禁止 builtin: 前缀。仅接受 protocol PluginDefinition 的 definePlugin，
 * setup 等兼容别名一律拒绝（项目明确不做向后兼容）。返回规范化定义。
 */
function assertExternalDefinition(candidate: unknown, dirPath: string): PluginDefinition {
  const fail = (detail: string): HelmError =>
    new HelmError('invalid_plugin_definition', `外部插件 ${dirPath} 的模块导出非法：${detail}`, 400, { dirPath });
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw fail('未导出 default 或 plugin 定义对象');
  }
  const def = candidate as Record<string, unknown>;
  if (typeof def.id !== 'string' || def.id.length === 0) throw fail('缺少非空字符串 id');
  // name 可选（同 protocol PluginDefinition）：未提供时展示名由 PluginHost
  // 回落 id；提供时必须是非空字符串，不另加必填约束（与内置插件同权）
  if (def.name !== undefined && (typeof def.name !== 'string' || def.name.length === 0)) {
    throw fail('name 提供时必须是非空字符串');
  }
  if (def.id.startsWith('builtin:')) {
    throw new HelmError(
      'invalid_plugin_definition',
      `外部插件 ${dirPath} 的 id 不允许以 builtin: 开头（不冒充内置插件）: ${def.id}`,
      400,
      { dirPath, id: def.id },
    );
  }
  if (typeof def.definePlugin !== 'function') {
    throw fail('缺少 definePlugin 函数（外部插件仅接受 protocol PluginDefinition，无兼容别名）');
  }
  return def as unknown as PluginDefinition;
}

/**
 * 外部插件定义归一化：
 * - 剥离 locked（外部插件不可自封常驻不可卸载，启停权归用户持久化状态）；
 * - clientRoot 未设置 → 默认插件目录本身；必须是字符串（非字符串边界拒绝）；
 *   相对路径 → 解析为插件目录内绝对路径（越出插件目录显式拒绝，防穿越）；
 *   绝对路径原样保留。路径边界校验只是约定约束，不是安全沙箱承诺。
 */
function normalizeDefinition(definition: PluginDefinition, dirPath: string): PluginDefinition {
  const normalized = { ...definition };
  delete normalized.locked;
  const clientRoot = normalized.clientRoot;
  if (clientRoot === undefined || clientRoot === '') {
    normalized.clientRoot = dirPath;
    return normalized;
  }
  if (typeof clientRoot !== 'string' || clientRoot.length === 0) {
    throw new HelmError(
      'invalid_plugin_definition',
      `外部插件 ${dirPath} 的 clientRoot 必须是非空字符串`,
      400,
      { dirPath, clientRoot: String(clientRoot) },
    );
  }
  if (!isAbsolute(clientRoot)) {
    const resolvedRoot = resolve(dirPath, clientRoot);
    const rel = relative(realpathSync(dirPath), resolvedRoot);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new HelmError(
        'invalid_plugin_definition',
        `外部插件 ${dirPath} 的相对 clientRoot 越出插件目录: ${clientRoot}`,
        400,
        { dirPath, clientRoot },
      );
    }
    normalized.clientRoot = resolvedRoot;
  }
  return normalized;
}
