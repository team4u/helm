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
import { registerPluginTsRoot, nextPluginGeneration } from './backend-ts-loader.js';

/** 加载器所需的最小宿主形状（真实 PluginHost 结构兼容，便于独立测试）。 */
export interface ExternalPluginHost {
  register(definition: PluginDefinition, options?: { enabled?: boolean }): Promise<void>;
  list(): PluginSummary[] | Promise<PluginSummary[]>;
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
    // 为插件目录启用后端 TS 转译（含运行期动态 import 的相对 TS 依赖）。
    // 任一失败路径（导入 / id 冲突 / 宿主注册）都释放计数；成功注册则根常驻
    // 本进程：插件运行期动态 import 依赖转译可用，已加载模块在 ESM 缓存中保持
    // identity。因此插件停用/卸载不释放根、不卸载已加载模块（同进程内重新
    // 注册不重复初始化）；释放仅发生在加载失败回退时。
    const releaseTsRoot = registerPluginTsRoot(dirPath);
    let committed = false;
    try {
      const definition = await importPluginDefinition(dirPath, entryPath);
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
      committed = true;
      registered.push(normalized.id);
    } finally {
      if (!committed) releaseTsRoot();
    }
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
 * id 禁止 builtin: 前缀。仅接受 protocol PluginDefinition 的 definePlugin，
 * setup 等兼容别名一律拒绝（项目明确不做向后兼容）。返回规范化定义。
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
export function normalizeDefinition(definition: PluginDefinition, dirPath: string): PluginDefinition {
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
): Promise<string | undefined> {
  const found = await findPluginSource(dataDir, pluginId);
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
    if (entry.name.startsWith('.') || entry.name.startsWith('builtin:')) continue;
    const dirPath = resolve(pluginsDir, entry.name);
    const entryPath = await resolvePluginEntry(dirPath);
    if (entryPath === undefined) continue;
    const releaseTsRoot = registerPluginTsRoot(dirPath);
    try {
      const definition = await importPluginDefinition(dirPath, entryPath);
      if (definition.id === pluginId) hits.push({ dir: dirPath, definition });
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
  const source = await findPluginSource(dataDir, pluginId);
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
  const releaseTsRoot = registerPluginTsRoot(sourceDir);
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

/**
 * 增量重扫描插件目录：只注册「当前未注册」的外部插件（默认 disabled，
 * enabled 恢复逻辑与启动扫描一致——经持久化 pluginEnabled）；已注册插件不重载、
 * 不去重、不干扰。返回新注册 id 列表与跳过的目录计数（含纯数据目录/已注册目录）。
 */
export async function rescanExternalPlugins(
  dataDir: string,
  plugins: ExternalPluginHost,
): Promise<{ registered: string[]; skipped: number }> {
  const pluginsDir = join(dataDir, 'plugins');
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { registered: [], skipped: 0 };
    throw err;
  }
  const existingIds = new Set((await plugins.list()).map((summary) => summary.id));
  const registered: string[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('builtin:')) continue;
    const dirPath = resolve(pluginsDir, entry.name);
    const entryPath = await resolvePluginEntry(dirPath);
    if (entryPath === undefined) {
      skipped += 1; // 纯插件数据目录
      continue;
    }
    if (existingIds.size > 0) {
      // 已注册插件目录（按 id 判定需要真实导入；为避免与 reload 竞态，先按
      // 目录名快速跳过同名已注册插件的常见情形，其余仍导入判定）
      if (existingIds.has(entry.name)) {
        skipped += 1;
        continue;
      }
    }
    const releaseTsRoot = registerPluginTsRoot(dirPath);
    let committed = false;
    try {
      const definition = await importPluginDefinition(dirPath, entryPath);
      if (existingIds.has(definition.id)) {
        skipped += 1; // 目录名与 id 不一致但已注册：跳过（不重载）
        continue;
      }
      const normalized = normalizeDefinition(definition, dirPath);
      await plugins.register(normalized, { enabled: false });
      committed = true;
      existingIds.add(normalized.id);
      registered.push(normalized.id);
    } finally {
      if (!committed) releaseTsRoot();
    }
  }
  return { registered, skipped };
}
