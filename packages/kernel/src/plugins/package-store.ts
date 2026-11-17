/**
 * Persistent storage for managed plugin package install records (`config.json` `pluginPackages` key).
 *
 * - Keyed by `pluginId` (`Record<pluginId, PluginPackageRecord>`); re-installing updates and preserves
 *   the existing record ID (`id`);
 * - All reads/writes run under `ConfigService` read-modify-write locking so concurrent updates never clash;
 * - Structural corruption rejects explicitly with `config_corrupt` (never silently discarded or rebuilt as `{}`);
 * - `getRecord` reads the in-memory mirror synchronized on write/load for `PluginSummary.managed` decoration.
 */
import { HelmError, type PluginPackageRecord, type PluginPackageSource } from '@helm/protocol';
import type { ConfigService } from '../services/config.js';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates `source` shape in a stored record (non-empty strings matching discriminated union fields). */
function assertSourceShape(pluginId: string, v: unknown): PluginPackageSource {
  if (!isPlainObject(v)) throw corruptSource(pluginId, 'must be an object');
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
    `Invalid config.json pluginPackages.${pluginId}.source (${detail})`,
    500,
  );
}

function corrupt(detail: string): HelmError {
  return new HelmError('config_corrupt', `Invalid config.json pluginPackages structure (${detail})`, 500);
}

/** Validates a single stored package record (rejects rather than fabricating defaults). */
function parseRecord(pluginId: string, v: unknown): PluginPackageRecord {
  if (!isPlainObject(v)) throw corrupt(`${pluginId} must be a PluginPackageRecord object`);
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
  /** Synchronized in-memory mirror updated on write/load. */
  private mirror = new Map<string, PluginPackageRecord>();

  constructor(config: ConfigService) {
    this.config = config;
  }

  /** Startup warmup: reads `config.json` into the mirror; rejects explicitly on corruption. */
  async load(): Promise<void> {
    const cfg = await this.config.get();
    const packages = cfg['pluginPackages'];
    if (packages === undefined) return;
    if (!isPlainObject(packages)) throw corrupt(`expected pluginId -> record map, got ${typeof packages}`);
    const next = new Map<string, PluginPackageRecord>();
    for (const [pluginId, value] of Object.entries(packages)) {
      next.set(pluginId, parseRecord(pluginId, value));
    }
    this.mirror = next;
  }

  /** Reads from the synchronized mirror (for `PluginSummary.managed` projection). */
  getRecord(pluginId: string): PluginPackageRecord | undefined {
    return this.mirror.get(pluginId);
  }

  listRecords(): PluginPackageRecord[] {
    return [...this.mirror.values()];
  }

  /** Writes/updates a package record under lock, reusing existing record ID when updating; syncs mirror on success. */
  async save(record: Omit<PluginPackageRecord, 'id'> & { id?: string }): Promise<PluginPackageRecord> {
    let stored!: PluginPackageRecord;
    await this.config.updateBy((current) => {
      const existing = current['pluginPackages'];
      if (existing !== undefined && !isPlainObject(existing)) {
        throw corrupt(`expected pluginId -> record map, got ${typeof existing}`);
      }
      const map = isPlainObject(existing) ? existing : {};
      // Validate all existing records before mutating so partial corruption never goes unnoticed.
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

  /** Deletes a package record under lock and updates mirror (404 `unknown_plugin_package` if missing). */
  async delete(pluginId: string): Promise<PluginPackageRecord> {
    let removed: PluginPackageRecord | undefined;
    await this.config.updateBy((current) => {
      const existing = current['pluginPackages'];
      if (existing !== undefined && !isPlainObject(existing)) {
        throw corrupt(`expected pluginId -> record map, got ${typeof existing}`);
      }
      const map = isPlainObject(existing) ? existing : {};
      const target = map[pluginId];
      if (!isPlainObject(target)) return current;
      removed = parseRecord(pluginId, target);
      const next = { ...map };
      delete next[pluginId];
      return { ...current, pluginPackages: next };
    });
    if (removed === undefined) {
      throw new HelmError('unknown_plugin_package', `Plugin ${pluginId} has no managed install record`, 404, { pluginId });
    }
    this.mirror.delete(pluginId);
    return removed;
  }
}
