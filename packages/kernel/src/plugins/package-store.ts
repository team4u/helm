/**
 * 受管插件包安装记录持久层（config.json `pluginPackages` 键）。
 *
 * - 结构：`pluginPackages: Record<pluginId, PluginPackageRecord>`（按 pluginId
 *   键控，重复 install 同一插件覆盖更新，与契约「同一插件重复 install 复用
 *   原 ID 更新记录」一致——ID 沿用既有记录的 id）；
 * - 读写全部经 ConfigService 锁内读改写（与 pluginEnabled/plugins 同一模式，
 *   跨实例串行，绝不锁外旧快照覆盖）；
 * - 结构损坏（非对象 / 记录形状非法 / source 非法）显式 config_corrupt 拒绝，
 *   绝不静默丢弃或用 {} 重建（诚实性纪律）；
 * - getPluginPackagesSync 同步镜像仅供 PluginHost.list()/get() 映射
 *   PluginSummary.managed 使用：写入路径同步维持镜像，镜像与磁盘一致；
 *   独立构造（无 load）时镜像为空——插件清单的 managed 只反映本进程内
 *   完成的安装，重启后由 runtime 启动链 load() 恢复。
 */
import { HelmError, type PluginPackageRecord, type PluginPackageSource } from '@helm/protocol';
import type { ConfigService } from '../services/config.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** source 形状校验（判别联合最小边界）：kind 合法且对应字段为非空字符串。 */
function assertSourceShape(pluginId: string, v: unknown): PluginPackageSource {
  if (!isPlainObject(v)) throw corruptSource(pluginId, '应为对象');
  const kind = v['kind'];
  if (kind === 'npm') {
    if (typeof v['spec'] !== 'string' || v['spec'].length === 0) throw corruptSource(pluginId, 'npm source 缺少 spec');
    return { kind: 'npm', raw: String(v['raw'] ?? `npm:${v['spec']}`), spec: v['spec'] };
  }
  if (kind === 'git') {
    if (typeof v['repo'] !== 'string' || v['repo'].length === 0) throw corruptSource(pluginId, 'git source 缺少 repo');
    return {
      kind: 'git',
      raw: String(v['raw'] ?? v['repo']),
      repo: v['repo'],
      ...(v['ref'] !== undefined ? { ref: String(v['ref']) } : {}),
      ...(v['subdirectory'] !== undefined ? { subdirectory: String(v['subdirectory']) } : {}),
    };
  }
  if (kind === 'local') {
    if (typeof v['path'] !== 'string' || v['path'].length === 0) throw corruptSource(pluginId, 'local source 缺少 path');
    return { kind: 'local', raw: String(v['raw'] ?? v['path']), path: v['path'] };
  }
  throw corruptSource(pluginId, `未知 kind: ${String(kind)}`);
}

function corruptSource(pluginId: string, detail: string): HelmError {
  return new HelmError(
    'config_corrupt',
    `config.json pluginPackages.${pluginId}.source 结构非法（${detail}），拒绝读写`,
    500,
  );
}

function corrupt(detail: string): HelmError {
  return new HelmError('config_corrupt', `config.json pluginPackages 字段结构非法（${detail}）`, 500);
}

/** 单条记录形状校验（宁可拒绝不可虚构）。 */
function parseRecord(pluginId: string, v: unknown): PluginPackageRecord {
  if (!isPlainObject(v)) throw corrupt(`${pluginId} 应为 PluginPackageRecord 对象`);
  const requiredStrings = ['id', 'installPath'] as const;
  for (const key of requiredStrings) {
    if (typeof v[key] !== 'string' || (v[key] as string).length === 0) {
      throw corrupt(`${pluginId}.${key} 需为非空字符串`);
    }
  }
  if (typeof v['version'] !== 'string') throw corrupt(`${pluginId}.version 需为字符串`);
  if (typeof v['installedAt'] !== 'number' || !Number.isFinite(v['installedAt'])) {
    throw corrupt(`${pluginId}.installedAt 需为数字`);
  }
  if (typeof v['updatedAt'] !== 'number' || !Number.isFinite(v['updatedAt'])) {
    throw corrupt(`${pluginId}.updatedAt 需为数字`);
  }
  const source = assertSourceShape(pluginId, v['source']);
  return {
    id: v['id'] as string,
    pluginId,
    source,
    installPath: v['installPath'] as string,
    version: v['version'] as string,
    installedAt: v['installedAt'] as number,
    updatedAt: v['updatedAt'] as number,
  };
}

export class PluginPackageManagerStore {
  private readonly config: ConfigService;
  /** 同步镜像（写入路径维持；读取穿透磁盘锁由 ConfigService 保证）。 */
  private mirror = new Map<string, PluginPackageRecord>();

  constructor(config: ConfigService) {
    this.config = config;
  }

  /** 启动预热：读 config.json 建立镜像；损坏显式上抛。 */
  async load(): Promise<void> {
    const cfg = await this.config.get();
    const packages = cfg['pluginPackages'];
    if (packages === undefined) return;
    if (!isPlainObject(packages)) throw corrupt(`应为 pluginId → 记录 对象，实际：${typeof packages}`);
    const next = new Map<string, PluginPackageRecord>();
    for (const [pluginId, value] of Object.entries(packages)) {
      next.set(pluginId, parseRecord(pluginId, value));
    }
    this.mirror = next;
  }

  /** 同步镜像读取（PluginSummary.managed 映射用）。 */
  getRecord(pluginId: string): PluginPackageRecord | undefined {
    return this.mirror.get(pluginId);
  }

  listRecords(): PluginPackageRecord[] {
    return [...this.mirror.values()];
  }

  /**
   * 写入/覆盖一条记录：锁内读改写，只更新本插件键；重复 install 沿用既有
   * 记录 id（幂等稳定标识）。成功后同步镜像。
   */
  async save(record: Omit<PluginPackageRecord, 'id'> & { id?: string }): Promise<PluginPackageRecord> {
    let stored!: PluginPackageRecord;
    await this.config.updateBy((current) => {
      const existing = current['pluginPackages'];
      if (existing !== undefined && !isPlainObject(existing)) {
        throw corrupt(`应为 pluginId → 记录 对象，实际：${typeof existing}`);
      }
      const map = isPlainObject(existing) ? existing : {};
      // 校验既有全部记录（写入前对结构损坏如实拒绝，不用部分旧值重建）
      for (const [pid, v] of Object.entries(map)) parseRecord(pid, v);
      const prevId = isPlainObject(map[record.pluginId])
        ? (map[record.pluginId] as Record<string, unknown>)['id']
        : undefined;
      const id = record.id ?? (typeof prevId === 'string' && prevId.length > 0 ? prevId : `plugpkg-${record.pluginId}`);
      stored = { ...record, id } as PluginPackageRecord;
      return { ...current, pluginPackages: { ...map, [record.pluginId]: stored } };
    });
    this.mirror.set(stored.pluginId, stored);
    return stored;
  }

  /** 删除记录；成功后同步镜像。目标不存在时 404（调用方决定语义）。 */
  async delete(pluginId: string): Promise<PluginPackageRecord> {
    let removed: PluginPackageRecord | undefined;
    await this.config.updateBy((current) => {
      const existing = current['pluginPackages'];
      if (existing !== undefined && !isPlainObject(existing)) {
        throw corrupt(`应为 pluginId → 记录 对象，实际：${typeof existing}`);
      }
      const map = isPlainObject(existing) ? existing : {};
      const target = map[pluginId];
      if (!isPlainObject(target)) return current; // 无变化；由 removed 判定 404
      removed = parseRecord(pluginId, target);
      const next = { ...map };
      delete next[pluginId];
      return { ...current, pluginPackages: next };
    });
    if (removed === undefined) {
      throw new HelmError('unknown_plugin_package', `插件 ${pluginId} 没有受管安装记录`, 404, { pluginId });
    }
    this.mirror.delete(pluginId);
    return removed;
  }
}
