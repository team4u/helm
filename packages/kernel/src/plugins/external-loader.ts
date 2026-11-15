/**
 * 外部插件目录自动发现与动态加载器。
 *
 * 模块拆分（行为不变）：清单解析层（plugin.json / package.json helm 字段）
 * 见 plugin-manifest.ts；启动全量扫描与增量重扫描的公共目录访问器
 * （loadExternalPlugins / rescanExternalPlugins）见 scan-visitor.ts；
 * 本模块保留：入口解析、模块导入与定义边界校验、定义归一化、
 * 受控热重载（reload）与源目录定位。
 *
 * `<dataDir>/plugins/` 下混杂两类目录（关键背景：PluginHost.register 会为每个
 * 已注册插件创建 `<dataDir>/plugins/<pluginDataDirName(pluginId)>` 作为其 ctx.dataDir）：
 * 1. 已注册插件的纯数据目录（如 `builtin%3Aprofile`、`builtin%3Aherdr`；
 *    id 中的 `:` 落盘时统一转义为 `%3A`，否则 Windows 会把它当成 NTFS
 *    交替数据流而无法建目录，见 plugin-dir-name.ts）；
 * 2. 用户放入的外部第三方插件目录（含 plugin.json 或约定入口文件）。
 *
 * 判定规则（只认「插件入口」标记，绝不靠目录名猜测）：
 * - 存在 `plugin.json` → 必须是可解析的 JSON 对象；按 `main`（缺省回落约定
 *   入口探测）解析入口文件相对路径，严格校验不越出插件目录（防路径穿越，
 *   realpath 保证真实入口不越 root）。清单损坏 / 非对象 / main 非法 /
 *   入口越界 / 入口缺失一律显式 HelmError，绝不静默吞错（诚实性纪律）；
 *   plugin.json 可选字段：`clientRoot`（前端源根目录）、`clientDependencies`
 *   （前端受控 npm 说明符数组，映射解析根 = 插件目录）、`dependencies`
 *   （插件间依赖 ID 数组）；非法值显式拒绝，绝不静默忽略。
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
import {
  HelmError,
  type PluginBuildProvider,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginSummary,
} from '@helm/protocol';
import { registerPluginTsRoot, nextPluginGeneration, type BackendTsTransformFn } from './backend-ts-loader.js';
import { isBuiltinPluginDataDirName } from './plugin-dir-name.js';
import {
  MANIFEST_PLUGIN_ID_PATTERN,
  readHelmClientDependencies,
  readHelmClientRoot,
  readHelmField,
  readManifest,
  readManifestOptional,
} from './plugin-manifest.js';

/** 加载器所需的最小宿主形状（真实 PluginHost 结构兼容，便于独立测试）。 */
export interface ExternalPluginHost {
  register(
    definition: PluginDefinition,
    options?: { enabled?: boolean; isolateFailure?: boolean },
  ): Promise<void>;
  list(): PluginSummary[] | Promise<PluginSummary[]>;
  /** 可选：scan / load 阶段故障占位登记（真实 PluginHost 提供；测试 stub 未实现时保持旧行为上抛）。 */
  registerFailed?(spec: {
    id: string;
    name?: string;
    description?: string;
    version?: string;
    error: PluginDiagnosticError;
  }): void;
  /**
   * 可选：宿主构建端口透出（真实 PluginHost 提供）：外部插件 TS 转译函数
   * 由此取自 PluginHostOptions.buildProvider。未实现/未注入时 TS 源加载在
   * 转译阶段显式拒绝（unsupported_backend_ts_build），JS 插件不受影响。
   */
  getBuildProvider?(): PluginBuildProvider | undefined;
}

/** 从宿主形状取后端 TS 转译函数（构建端口未接线时 undefined；scan-visitor 共用）。 */
export function tsTransformOf(
  host: { getBuildProvider?(): PluginBuildProvider | undefined },
): BackendTsTransformFn | undefined {
  return host.getBuildProvider?.()?.transformBackendTs;
}

/** reload/rescan 所需的完整宿主形状（含 unregister；真实 PluginHost 结构兼容）。 */
export interface ReloadablePluginHost extends ExternalPluginHost {
  unregister(pluginId: string): Promise<void>;
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

// 启动全量/增量扫描的实现已拆至 scan-visitor.ts；经本模块再导出保持既有
// 公共出口不变（hub 测试与产品消费方直接从 external-loader 导入）。
export { loadExternalPlugins, rescanExternalPlugins } from './scan-visitor.js';

// ---------------------------------------------------------------------------
// 入口解析
// ---------------------------------------------------------------------------

/**
 * 解析插件目录的入口文件：undefined 表示无任何插件入口标记（纯数据目录）。
 * plugin.json 存在时走 manifest 分支（错误一律显式抛出，绝不静默跳过）。
 */
export async function resolvePluginEntry(dirPath: string): Promise<string | undefined> {
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
    const probed = probeConventionEntry(dirPath);
    if (probed !== undefined) return probed;
    // npm 标准入口回落：package.json helm.main / main（.js 后缀重写同名 TS 源）
    const helm = readHelmField(dirPath);
    const mainSpec = helm?.main;
    if (mainSpec !== undefined) {
      // npm 产物习惯 .js 后缀指向转译前 .ts 源：同名 .ts/.tsx 存在时优先
      const tsCandidate = mainSpec.replace(/\.js$/, '.ts').replace(/\.mjs$/, '.mts').replace(/\.cjs$/, '.cts');
      const tryCandidates = tsCandidate !== mainSpec ? [tsCandidate, mainSpec] : [mainSpec];
      let resolvedSpec: string | undefined;
      for (const candidate of tryCandidates) {
        if (statSync(join(dirPath, candidate)).isFile()) {
          resolvedSpec = candidate;
          break;
        }
      }
      const spec = resolvedSpec ?? mainSpec;
      const entry = resolve(dirPath, spec);
      const rel = relative(realpathSync(dirPath), entry);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new HelmError(
          'plugin_manifest_invalid',
          `外部插件 ${dirPath} 的 package.json 入口越出插件目录: ${spec}`,
          400,
          { dirPath, main: spec },
        );
      }
      return assertEntryFile(dirPath, spec, entry);
    }
    return undefined;
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
/** 校验外部插件代码声明的插件依赖；非法形状必须显式失败，不能在清单归一化时静默丢弃。 */
function normalizeCodeDependencies(
  dirPath: string,
  pluginId: string,
  values: unknown,
): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !MANIFEST_PLUGIN_ID_PATTERN.test(value))) {
    throw new HelmError(
      'invalid_plugin_definition',
      `外部插件 ${dirPath} 的定义 ${pluginId}.dependencies 必须是插件 ID 字符串数组（仅允许字母数字 : _ -）`,
      400,
      { dirPath, pluginId, dependencies: Array.isArray(values) ? values.map((value) => String(value)) : String(values) },
    );
  }
  return [...new Set(values as string[])];

}

// ---------------------------------------------------------------------------
// 模块导入与定义校验
// ---------------------------------------------------------------------------

/** 动态导入入口模块并提取 default / plugin 导出为插件定义（可携带代际标记重新初始化模块图）。 */
export async function importPluginDefinition(
  dirPath: string,
  entryPath: string,
  options: { generation?: number } = {},
): Promise<PluginDefinition> {
  const entryUrl =
    options.generation === undefined
      ? pathToFileURL(entryPath).href
      : `${pathToFileURL(entryPath).href}?helmgen=${options.generation}`;
  let mod: { default?: unknown; plugin?: unknown };
  try {
    mod = (await import(entryUrl)) as { default?: unknown; plugin?: unknown };
  } catch (err) {
    if (err instanceof HelmError) throw err; // 转译错误已带定位，原样上抛
    throw new HelmError(
      'plugin_load_failed',
      `外部插件模块加载失败: ${entryPath}${options.generation !== undefined ? `（代际 ${options.generation}）` : ''}（${err instanceof Error ? err.message : String(err)}）`,
      500,
      { dirPath, entryPath, cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined },
    );
  }
  const candidate = mod.default ?? mod.plugin;
  return assertExternalDefinition(candidate, dirPath);
}

/**
 * 边界校验外部模块导出的定义形状：非空字符串 id / name + definePlugin 函数；
 * id 禁止 builtin: 前缀与冒号（冒号仅作 builtin: 命名空间分隔符；外部插件
 * id 含冒号会破坏「源目录即 ctx.dataDir」不变量，见 plugin-dir-name.ts）。
 * 仅接受 protocol PluginDefinition 的 definePlugin，setup 等兼容别名一律拒绝
 * （项目明确不做向后兼容）。返回规范化定义。
 */
export function assertExternalDefinition(candidate: unknown, dirPath: string): PluginDefinition {
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
  if (def.icon !== undefined && (typeof def.icon !== 'string' || def.icon.trim().length === 0)) {
    throw fail('icon 提供时必须是非空字符串');
  }
  if (def.id.startsWith('builtin:')) {
    throw new HelmError(
      'invalid_plugin_definition',
      `外部插件 ${dirPath} 的 id 不允许以 builtin: 开头（不冒充内置插件）: ${def.id}`,
      400,
      { dirPath, id: def.id },
    );
  }
  if (def.id.includes(':')) {
    throw new HelmError(
      'invalid_plugin_definition',
      `外部插件 ${dirPath} 的 id 不允许包含冒号（冒号仅作 builtin: 命名空间分隔符，与受管插件包 id 规则一致）: ${def.id}`,
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
 * - 插件间依赖：代码声明与清单声明（plugin.json dependencies / package.json
 *   helm.dependencies）合并去重进入定义；非法清单值在读取处已显式拒绝。
 * - 前端受控 npm 依赖：清单声明的说明符（plugin.json clientDependencies /
 *   package.json helm.clientDependencies）统一映射为 npmDependencies，解析根
 *   恒为插件自身目录（受控边界）；代码内声明的 npmDependencies 一律剥离——
 *   外部插件不得自指任意解析根（不放开任意裸依赖）。
 * - clientRoot 未设置 → 默认插件目录本身；必须是字符串（非字符串边界拒绝）；
 *   相对路径 → 解析为插件目录内绝对路径（越出插件目录显式拒绝，防穿越）；
 *   绝对路径原样保留。路径边界校验只是约定约束，不是安全沙箱承诺。
 */
export function normalizeDefinition(definition: PluginDefinition, dirPath: string): PluginDefinition {
  const normalized = { ...definition };
  delete normalized.locked;
  // 前端受控 npm 依赖：外部插件只认清单声明，解析根映射到插件自身目录。
  const clientDeps = readHelmClientDependencies(dirPath);
  delete normalized.npmDependencies;
  if (clientDeps.length > 0) {
    normalized.npmDependencies = Object.fromEntries(clientDeps.map((spec) => [spec, dirPath]));
  }
  // 插件间依赖：代码声明 + 清单声明（plugin.json 与 package.json helm 合并）合并去重
  //（自依赖由宿主注册边界拒绝）。
  const codeDeps = normalizeCodeDependencies(dirPath, definition.id, definition.dependencies);
  const manifestDeps = [
    ...(readManifestOptional(dirPath)?.dependencies ?? []),
    ...(readHelmField(dirPath)?.dependencies ?? []),
  ];
  const seenDeps = new Set<string>();
  const mergedDeps: string[] = [];
  for (const dep of [...codeDeps, ...manifestDeps]) {
    if (seenDeps.has(dep)) continue;
    seenDeps.add(dep);
    mergedDeps.push(dep);
  }
  if (mergedDeps.length > 0) {
    normalized.dependencies = mergedDeps;
  } else {
    delete normalized.dependencies;
  }
  const clientRoot = normalized.clientRoot;
  if (clientRoot === undefined || clientRoot === '') {
    // 未显式声明：可经 plugin.json clientRoot 或 package.json helm.clientRoot 声明；否则默认插件目录本身
    const helmClientRoot = readHelmClientRoot(dirPath);
    if (helmClientRoot !== undefined) {
      const resolvedRoot = resolve(dirPath, helmClientRoot);
      const rel = relative(realpathSync(dirPath), resolvedRoot);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new HelmError(
          'invalid_plugin_definition',
          `外部插件 ${dirPath} 的清单 clientRoot 越出插件目录: ${helmClientRoot}`,
          400,
          { dirPath, clientRoot: helmClientRoot },
        );
      }
      normalized.clientRoot = resolvedRoot;
      return normalized;
    }
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

// ---------------------------------------------------------------------------
// DX 闭环：受控热重载（reload）与增量重扫描（rescan）
// ---------------------------------------------------------------------------

/**
 * 扫描插件目录，返回「定义 id 等于目标 id」的插件源目录绝对路径。
 * 与启动扫描同一判定链（resolvePluginEntry + 导入定义读真实 id）；目录名与 id
 * 不一致也能命中。无命中返回 undefined（多个命中属于目录状态异常，显式抛错）。
 * 注：探测本身会初始化模块（无代际标记的常规导入）；与启动扫描行为一致。
 * 已注册插件的探测导入命中 ESM 缓存——返回的是旧代（当前注册实例）的定义对象，
 * reload 用它作为切换失败后的回滚定义。
 */
export async function findSourceDirByPluginId(
  dataDir: string,
  pluginId: string,
  options: { transform?: BackendTsTransformFn } = {},
): Promise<string | undefined> {
  const found = await findPluginSource(dataDir, pluginId, options);
  return found?.dir;
}

/** 扫描结果：源目录 + 探测导入得到的定义（已注册插件命中 ESM 缓存，即旧代定义）。 */
export interface PluginSourceLocation {
  dir: string;
  definition: PluginDefinition;
}

async function findPluginSource(
  dataDir: string,
  pluginId: string,
  options: { transform?: BackendTsTransformFn } = {},
): Promise<PluginSourceLocation | undefined> {
  const pluginsDir = join(dataDir, 'plugins');
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const hits: PluginSourceLocation[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || isBuiltinPluginDataDirName(entry.name)) continue;
    const dirPath = resolve(pluginsDir, entry.name);
    // 其他目录损坏（坏 manifest / 坏入口）不应炸断整目录扫描：目录名与目标
    // id 不一致时即便修复也轮不到它命中，直接跳过；同名目录解析失败时目标
    // 源码本身仍处于损坏态，交由上层按未找到源目录报错。
    let entryPath: string | undefined;
    const releaseTsRoot = registerPluginTsRoot(dirPath, { transform: options.transform });
    try {
      entryPath = await resolvePluginEntry(dirPath);
      if (entryPath === undefined) continue;
      const definition = await importPluginDefinition(dirPath, entryPath);
      if (definition.id === pluginId) hits.push({ dir: dirPath, definition });
    } catch {
      // 目录损坏或入口不可导入：跳过该目录继续扫描（修复后的目标目录仍能命中）。
      continue;
    } finally {
      releaseTsRoot();
    }
  }
  if (hits.length > 1) {
    throw new HelmError(
      'plugin_reload_ambiguous',
      `多个插件目录声明的 id 均为 ${pluginId}：${hits.map((h) => h.dir).join('、')}，无法确定重载源`,
      409,
      { pluginId, dirs: hits.map((h) => h.dir) },
    );
  }
  return hits[0];
}

/**
 * 外部插件受控热重载：
 * 1. 仅限外部插件（builtin:* 前缀一律 403）；
 * 2. dry-run：doctor 全链预检（代际导入 + 临时宿主真实注册 + client 真实编译），
 *    任一失败显式抛错且旧实例保持不动（坏代码预检失败绝不打断在运行插件）；
 * 3. 切换：unregister 旧实例（在途任务检查由 PluginHost 强制：409 拒绝）后，
 *    以预检通过的新代际定义重新注册；启用状态保持重载前状态（经持久化
 *    pluginEnabled 自动恢复，最终态与预期不一致时显式报错，绝不静默）。
 *
 * reload 对插件根常驻 TS 转译不产生额外负担（registerPluginTsRoot 引用计数）。
 */
export async function reloadExternalPlugin(
  dataDir: string,
  pluginId: string,
  plugins: ReloadablePluginHost,
  options: { doctor?: (dir: string) => Promise<void> } = {},
): Promise<{ pluginId: string; wasEnabled: boolean; generation: number }> {
  if (pluginId.startsWith('builtin:')) {
    throw new HelmError(
      'plugin_locked',
      `内置插件 ${pluginId} 禁止热重载（请重启 Hub 生效内核/内置插件变更）`,
      403,
      { pluginId },
    );
  }
  const current = (await plugins.list()).find((s) => s.id === pluginId);
  if (!current) {
    throw new HelmError('unknown_plugin', `未注册的插件：${pluginId}`, 404, { pluginId });
  }
  const wasEnabled = current.enabled;
  const source = await findPluginSource(dataDir, pluginId, { transform: tsTransformOf(plugins) });
  if (source === undefined) {
    throw new HelmError(
      'plugin_source_missing',
      `在 ${join(dataDir, 'plugins')} 下未找到 id 为 ${pluginId} 的外部插件源目录`,
      404,
      { pluginId, pluginsDir: join(dataDir, 'plugins') },
    );
  }
  const sourceDir = source.dir;
  // 探测导入返回旧代定义（已注册插件的入口 URL 命中 ESM 缓存）：切换失败后的
  // 回滚定义。回滚沿用旧定义对象（同一 definePlugin 引用，无重复初始化）。
  const rollbackDefinition = source.definition;
  // dry-run 预检：失败时旧实例原封不动（不 unregister）。
  await options.doctor?.(sourceDir);

  // 预检通过后重新取下一代际号（doctor 已消耗一代，这里用新代导入实际注册）。
  const entryPath = await resolvePluginEntry(sourceDir);
  if (entryPath === undefined) {
    throw new HelmError(
      'plugin_reload_failed',
      `重载时插件入口消失（预检与切换之间源目录被改动）：${sourceDir}`,
      500,
      { pluginId, sourceDir },
    );
  }
  const releaseTsRoot = registerPluginTsRoot(sourceDir, { transform: tsTransformOf(plugins) });
  let committed = false;
  try {
    const generation = nextPluginGeneration(sourceDir);
    const definition = normalizeDefinition(
      await importPluginDefinition(sourceDir, entryPath, { generation }),
      sourceDir,
    );
    if (definition.id !== pluginId) {
      throw new HelmError(
        'plugin_reload_failed',
        `重载时插件 id 变更（预检 ${pluginId} -> 实际 ${definition.id}），拒绝切换`,
        409,
        { pluginId, actualId: definition.id, sourceDir },
      );
    }
    await plugins.unregister(pluginId);
    try {
      await plugins.register(definition, { enabled: wasEnabled });
      committed = true;
    } catch (err) {
      // 切换失败：用旧代定义尽力回滚（同一 definePlugin 引用，无重复初始化），
      // 让插件回到重载前可用状态。回滚本身失败时不掩盖原始错误，如实上报
      //（此时插件已注销，需人工修复；持久化启停状态未被动过）。
      let rollbackError: unknown;
      try {
        await plugins.register(normalizeDefinition(rollbackDefinition, sourceDir), {
          enabled: wasEnabled,
        });
      } catch (rollbackErr) {
        rollbackError = rollbackErr;
      }
      throw new HelmError(
        'plugin_reload_failed',
        `重载后重新注册失败${rollbackError === undefined ? '（已回滚到重载前实例，旧定义继续可用）' : '（回滚也失败，插件当前已注销，需人工修复后重试）'}：${err instanceof Error ? err.message : String(err)}`,
        500,
        {
          pluginId,
          sourceDir,
          generation,
          rolledBack: rollbackError === undefined,
          ...(rollbackError !== undefined
            ? { rollbackError: rollbackError instanceof Error ? { message: rollbackError.message, stack: rollbackError.stack } : String(rollbackError) }
            : {}),
          cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined,
        },
      );
    }
    const after = (await plugins.list()).find((s) => s.id === pluginId);
    if (!after) {
      throw new HelmError(
        'plugin_reload_failed',
        `重载后未在宿主清单中发现插件 ${pluginId}（内部状态不一致）`,
        500,
        { pluginId },
      );
    }
    return { pluginId, wasEnabled, generation };
  } finally {
    if (!committed) releaseTsRoot();
  }
}
