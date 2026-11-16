/**
 * managed plugin package install record durable layer (config.json `pluginPackages` key).
 *
 * - structure:`pluginPackages: Record<pluginId, PluginPackageRecord>`(by pluginId
 *   key control, duplicate install the same plugin override update, and contract the same plugin duplicate install re- use
 *   original ID update record consistent - -ID along use since has record id);
 * - read write all via ConfigService lock inside read change write (and pluginEnabled/plugins the same pattern,
 *   across instance serial, never lock outside old snapshot override);
 * - structure corrupt (non- object / record shape illegal / source illegal) explicit config_corrupt reject,
 *   never static default discard or use {} rebuild (honest discipline);
 * - getPluginPackagesSync sync mirror only supply PluginHost.list()/get() mapping
 *   PluginSummary.managed use: write path sync dimension hold mirror, mirror and disk consistent;
 *   independent construct (without load) when mirror is empty - - plugin manifest managed only reverse reflect this process inside
 *   complete install, after restart by runtime start chain load() restore.
 */
import { HelmError, type PluginPackageRecord, type PluginPackageSource } from '@helm/protocol';
import type { ConfigService } from '../services/config.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** source shape validate (judge other join together most small boundary):kind legal and for should field is non-empty string. */
function assertSourceShape(pluginId: string, v: unknown): PluginPackageSource {
  if (!isPlainObject(v)) throw corruptSource(pluginId, 'should be object');
  const kind = v['kind'];
  if (kind === 'npm') {
    if (typeof v['spec'] !== 'string' || v['spec'].length === 0) throw corruptSource(pluginId, 'npm source missing spec');
    return { kind: 'npm', raw: String(v['raw'] ?? `npm:${v['spec']}`), spec: v['spec'] };
  }
  if (kind === 'git') {
    if (typeof v['repo'] !== 'string' || v['repo'].length === 0) throw corruptSource(pluginId, 'git source missing repo');
    return {
      kind: 'git',
      raw: String(v['raw'] ?? v['repo']),
      repo: v['repo'],
      ...(v['ref'] !== undefined ? { ref: String(v['ref']) } : {}),
      ...(v['subdirectory'] !== undefined ? { subdirectory: String(v['subdirectory']) } : {}),
    };
  }
  if (kind === 'local') {
    if (typeof v['path'] !== 'string' || v['path'].length === 0) throw corruptSource(pluginId, 'local source missing path');
    return { kind: 'local', raw: String(v['raw'] ?? v['path']), path: v['path'] };
  }
  throw corruptSource(pluginId, `unknown kind: ${String(kind)}`);
}

function corruptSource(pluginId: string, detail: string): HelmError {
  return new HelmError(
    'config_corrupt',
    `config.json pluginPackages.${pluginId}.source structure illegal (${detail}), reject read write`,
    500,
  );
}

function corrupt(detail: string): HelmError {
  return new HelmError('config_corrupt', `config.json pluginPackages field structure illegal (${detail})`, 500);
}

/** single record shape validate (rather can reject cannot virtual construct). */
function parseRecord(pluginId: string, v: unknown): PluginPackageRecord {
  if (!isPlainObject(v)) throw corrupt(`${pluginId} should be PluginPackageRecord object`);
  const requiredStrings = ['id', 'installPath'] as const;
  for (const key of requiredStrings) {
    if (typeof v[key] !== 'string' || (v[key] as string).length === 0) {
      throw corrupt(`${pluginId}.${key} must be a non-empty string`);
    }
  }
  if (typeof v['version'] !== 'string') throw corrupt(`${pluginId}.version must be a string`);
  if (typeof v['installedAt'] !== 'number' || !Number.isFinite(v['installedAt'])) {
    throw corrupt(`${pluginId}.installedAt must be a number`);
  }
  if (typeof v['updatedAt'] !== 'number' || !Number.isFinite(v['updatedAt'])) {
    throw corrupt(`${pluginId}.updatedAt must be a number`);
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
  /** sync mirror (write path dimension hold; read penetrate disk lock by ConfigService guarantee). */
  private mirror = new Map<string, PluginPackageRecord>();

  constructor(config: ConfigService) {
    this.config = config;
  }

  /** start warm up: read config.json establish mirror; corrupt explicit on throw. */
  async load(): Promise<void> {
    const cfg = await this.config.get();
    const packages = cfg['pluginPackages'];
    if (packages === undefined) return;
    if (!isPlainObject(packages)) throw corrupt(`should be pluginId → record object, actual:${typeof packages}`);
    const next = new Map<string, PluginPackageRecord>();
    for (const [pluginId, value] of Object.entries(packages)) {
      next.set(pluginId, parseRecord(pluginId, value));
    }
    this.mirror = next;
  }

  /** sync mirror read (PluginSummary.managed mapping use). */
  getRecord(pluginId: string): PluginPackageRecord | undefined {
    return this.mirror.get(pluginId);
  }

  listRecords(): PluginPackageRecord[] {
    return [...this.mirror.values()];
  }

  /**
   * write/override a record: lock inside read change write, only update this plugin key; duplicate install along use since has
   * record id(idempotent stable identifier). after success sync mirror.
   */
  async save(record: Omit<PluginPackageRecord, 'id'> & { id?: string }): Promise<PluginPackageRecord> {
    let stored!: PluginPackageRecord;
    await this.config.updateBy((current) => {
      const existing = current['pluginPackages'];
      if (existing !== undefined && !isPlainObject(existing)) {
        throw corrupt(`should be pluginId → record object, actual:${typeof existing}`);
      }
      const map = isPlainObject(existing) ? existing : {};
      // validate since has all record (before write for structure corrupt such as reject, do not use part old value rebuild)
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

  /** delete record; after success sync mirror. target missing when 404(caller decide semantics). */
  async delete(pluginId: string): Promise<PluginPackageRecord> {
    let removed: PluginPackageRecord | undefined;
    await this.config.updateBy((current) => {
      const existing = current['pluginPackages'];
      if (existing !== undefined && !isPlainObject(existing)) {
        throw corrupt(`should be pluginId → record object, actual:${typeof existing}`);
      }
      const map = isPlainObject(existing) ? existing : {};
      const target = map[pluginId];
      if (!isPlainObject(target)) return current; // without change; by removed decide 404
      removed = parseRecord(pluginId, target);
      const next = { ...map };
      delete next[pluginId];
      return { ...current, pluginPackages: next };
    });
    if (removed === undefined) {
      throw new HelmError('unknown_plugin_package', `plugin ${pluginId} no managed install record`, 404, { pluginId });
    }
    this.mirror.delete(pluginId);
    return removed;
  }
}
