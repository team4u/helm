/**
 * scan-visitor.ts：`<dataDir>/plugins/` 目录扫描公共访问器。
 *
 * loadExternalPlugins（启动全量扫描）与 rescanExternalPlugins（增量重扫描）
 * 的目录循环约 80% 重复（跳过隐藏/builtin 数据目录、registerPluginTsRoot
 * 引用计数、入口解析、代际导入、register/registerScanFailure、finally 释放），
 * 统一收敛为 visitExternalPluginDirs；两 caller 的差异点经 ScanVisitPolicy
 * 参数化，行为与收敛前逐分支等价：
 * - 目录名同名已注册插件的快速跳过：仅 rescan（load 无此捷径——同名目录
 *   需真实导入定义后在 id 冲突分支处置）；
 * - 导入定义的 id 已注册：load 视为冲突抛 plugin_already_registered（交由
 *   故障登记降级），rescan 静默跳过计 skipped（不重载、不干扰）；
 * - 每个被跳过的目录（纯数据目录 / 已注册目录）回调 onSkipped：仅 rescan
 *   计数，load 无操作。
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  HelmError,
  type PluginDefinition,
  type PluginDiagnosticError,
} from '@helm/protocol';
import { nextPluginGeneration, registerPluginTsRoot, type BackendTsTransformFn } from './backend-ts-loader.js';
import { isBuiltinPluginDataDirName } from './plugin-dir-name.js';
import {
  importPluginDefinition,
  normalizeDefinition,
  resolvePluginEntry,
  tsTransformOf,
  type ExternalPluginHost,
} from './external-loader.js';
import { readManifestMeta } from './plugin-manifest.js';

/**
 * 扫描导入：先普通导入（兼容 top-level await；首次加载无缓存开销）；
 * 若返回的 id 已被占用（可能是旧扫描的 ESM 缓存定义），换新一代代际导入
 * 重试拿最新源码（用户可能已修复/换 id 重写目录）。仍冲突才真冲突。
 */
async function importScanDefinition(
  dirPath: string,
  entryPath: string,
  existingIds: ReadonlySet<string>,
): Promise<PluginDefinition> {
  const plain = await importPluginDefinition(dirPath, entryPath);
  if (!existingIds.has(plain.id)) return plain;
  const generation = nextPluginGeneration(dirPath);
  return importPluginDefinition(dirPath, entryPath, { generation });
}

/**
 * 故障插件占位 ID：优先 manifest 合法 id；否则目录名归一化（非法字符转 _，
 * 不与已注册 id 冲突时直接用，冲突时追加目录名后缀）。
 */
function resolveFailedPluginId(
  dirPath: string,
  dirName: string,
  existingIds: Set<string>,
): { id: string; meta: Record<string, unknown> } {
  const meta = readManifestMeta(dirPath);
  const manifestId = meta['id'];
  // 外部插件 id 禁止冒号（冒号仅作 builtin: 命名空间分隔符，与受管插件包
  // PLUGIN_ID_PATTERN 对齐；否则源目录与 ctx.dataDir 会分叉，见 plugin-dir-name.ts）
  if (
    typeof manifestId === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(manifestId) &&
    !existingIds.has(manifestId)
  ) {
    return { id: manifestId, meta };
  }
  const safe = dirName.replace(/[^A-Za-z0-9_-]/g, '_') || 'external';
  let id = safe;
  let n = 1;
  while (existingIds.has(id)) {
    id = `${safe}-${dirName.length}-${n++}`;
  }
  return { id, meta };
}

/**
 * 单目录故障登记：归一异常为 PluginDiagnosticError 后调用 registerFailed；
 * registerFailed 不可用（测试 stub）时保持旧行为上抛。
 */
async function registerScanFailure(
  plugins: ExternalPluginHost,
  dirPath: string,
  dirName: string,
  existingIds: Set<string>,
  stage: PluginDiagnosticError['stage'],
  err: unknown,
): Promise<void> {
  if (plugins.registerFailed === undefined) throw err;
  const error: PluginDiagnosticError =
    err instanceof HelmError
      ? {
          code: err.code,
          message: err.message,
          stage,
          ...((err.details as Record<string, unknown> | undefined) !== undefined
            ? { details: err.details as Record<string, unknown> }
            : {}),
        }
      : {
          code: 'plugin_scan_failed',
          message: err instanceof Error ? err.message : String(err),
          stage,
        };
  const { id, meta } = resolveFailedPluginId(dirPath, dirName, existingIds);
  plugins.registerFailed({
    id,
    ...(typeof meta['name'] === 'string' && meta['name'].length > 0 ? { name: meta['name'] } : {}),
    error: { ...error, details: { ...(error.details ?? {}), dirPath } },
  });
  existingIds.add(id);
}

/** load 与 rescan 的目录处置差异（见文件头）。 */
export interface ScanVisitPolicy {
  /** 目录名与已注册 id 同名时快速跳过（rescan：不重载；load 无此捷径）。 */
  fastSkipDirNameEqualsId: boolean;
  /** 导入定义的 id 已注册：'fail' 抛冲突错误（load，交由故障登记）；'skip' 静默跳过（rescan）。 */
  alreadyRegistered: 'fail' | 'skip';
  /** 每个被跳过的目录回调一次（rescan 计 skipped；load 无操作）。 */
  onSkipped(): void;
}

/** visitExternalPluginDirs 入参。 */
export interface ScanVisitParams {
  dataDir: string;
  plugins: ExternalPluginHost;
  /** 已注册 id 集合（调用方预填；访问器随注册成功追加，供后续目录判定）。 */
  existingIds: Set<string>;
  /** 成功注册的 id 追加目标（调用方收集返回值）。 */
  registered: string[];
  /** 后端 TS 转译函数（宿主构建端口注入；未接线时 TS 插件在转译阶段显式拒绝）。 */
  transform: BackendTsTransformFn | undefined;
  policy: ScanVisitPolicy;
}

/**
 * 扫描 `<dataDir>/plugins/` 全部外部插件目录并按 policy 处置。单目录故障
 * （scan / load 阶段）经 registerScanFailure 登记为 failed 占位，不阻断其他
 * 目录加载；register 期的 define / enable 故障由 PluginHost 的 isolateFailure
 * 机制降级为 failed 条目，同样不中断循环。plugins 目录不存在（ENOENT）时
 * 静默返回（两 caller 均视为空结果）。
 */
async function visitExternalPluginDirs(params: ScanVisitParams): Promise<void> {
  const { dataDir, plugins, existingIds, registered, transform, policy } = params;
  const pluginsDir = join(dataDir, 'plugins');
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    // 内置插件数据目录（builtin%3Aprofile 等）与隐藏目录一律不参与外部插件发现
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || isBuiltinPluginDataDirName(entry.name)) continue;
    const dirPath = resolve(pluginsDir, entry.name);
    if (policy.fastSkipDirNameEqualsId && existingIds.has(entry.name)) {
      policy.onSkipped(); // 目录名同名已注册插件：快速跳过（不重载）
      continue;
    }
    // 为插件目录启用后端 TS 转译（含运行期动态 import 的相对 TS 依赖）。
    // 任一失败路径（导入 / id 冲突 / 宿主注册）都释放计数；成功注册则根常驻
    // 本进程：插件运行期动态 import 依赖转译可用，已加载模块在 ESM 缓存中保持
    // identity。因此插件停用/卸载不释放根、不卸载已加载模块（同进程内重新
    // 注册不重复初始化）；释放仅发生在加载失败回退时。
    const releaseTsRoot = registerPluginTsRoot(dirPath, { transform });
    let committed = false;
    try {
      const entryPath = await resolvePluginEntry(dirPath);
      if (entryPath === undefined) {
        policy.onSkipped(); // 纯插件数据目录：静默跳过
        continue;
      }
      const definition = await importScanDefinition(dirPath, entryPath, existingIds);
      if (existingIds.has(definition.id)) {
        if (policy.alreadyRegistered === 'skip') {
          policy.onSkipped(); // 目录名与 id 不一致但已注册：跳过（不重载）
          continue;
        }
        throw new HelmError(
          'plugin_already_registered',
          `外部插件 ${dirPath} 的 id 与已注册插件冲突: ${definition.id}`,
          409,
          { dirPath, id: definition.id },
        );
      }
      const normalized = normalizeDefinition(definition, dirPath);
      existingIds.add(normalized.id);
      await plugins.register(normalized, { enabled: false, isolateFailure: true });
      committed = true;
      registered.push(normalized.id);
    } catch (err) {
      // 单目录故障降级登记（scan / load 阶段；register 期的 define / enable
      // 故障已被 isolateFailure 吸收不会到这）：不阻断其他目录。
      await registerScanFailure(plugins, dirPath, entry.name, existingIds, 'scan', err);
    } finally {
      if (!committed) releaseTsRoot();
    }
  }
}

/**
 * 扫描 `<dataDir>/plugins/` 并动态加载全部外部插件（默认停用注册）。
 * 返回本次成功注册的外部插件 id 列表（按目录扫描顺序）。
 * 单目录故障（scan / load 阶段）经 registerFailed 登记为 failed 占位，
 * 不阻断其他目录加载；register 期的 define / enable 故障由 PluginHost 的
 * isolateFailure 机制降级为 failed 条目，同样不中断循环。
 */
export async function loadExternalPlugins(dataDir: string, plugins: ExternalPluginHost): Promise<string[]> {
  const registered: string[] = [];
  const existingIds = new Set<string>();
  for (const summary of await plugins.list()) existingIds.add(summary.id);
  await visitExternalPluginDirs({
    dataDir,
    plugins,
    existingIds,
    registered,
    transform: tsTransformOf(plugins),
    policy: {
      fastSkipDirNameEqualsId: false,
      alreadyRegistered: 'fail',
      onSkipped: () => undefined,
    },
  });
  return registered;
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
  const registered: string[] = [];
  let skipped = 0;
  const existingIds = new Set<string>();
  for (const summary of await plugins.list()) existingIds.add(summary.id);
  await visitExternalPluginDirs({
    dataDir,
    plugins,
    existingIds,
    registered,
    transform: tsTransformOf(plugins),
    policy: {
      fastSkipDirNameEqualsId: true,
      alreadyRegistered: 'skip',
      onSkipped: () => {
        skipped += 1;
      },
    },
  });
  return { registered, skipped };
}
