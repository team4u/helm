/**
 * scan-visitor.ts:`<dataDir>/plugins/` directory scan public access.
 *
 * loadExternalPlugins(start all amount scan) and rescanExternalPlugins(incremental heavy scan)
 * directory loop about 80% duplicate (skip hide/builtin data directory,registerPluginTsRoot
 * reference counter, entry parse, proxy boundary import,register/registerScanFailure,finally release),
 * unify converge is visitExternalPluginDirs; two caller difference point via ScanVisitPolicy
 * parameter, behavior and converge before one by one branch etc. price:
 * - directory name same name registered plugin fast skip: only rescan(load without this quick path - - same name directory
 *   must real import define after in id conflict branch where placement);
 * - import define id registered:load treated as conflict throw plugin_already_registered(hand over by
 *   fault register fall back),rescan static default skip count skipped(do not reload, do not interference);
 * - each by skip directory (pure data directory / registered directory) call back onSkipped: only rescan
 *   counter,load without operation.
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
 * scan import: first ordinary import (compatibility top-level await; first time load without cache overhead);
 * if return id already by occupy (may is old scan ESM cache define), swap new one proxy proxy boundary import
 * retry take most new source code (user may already fix/swap id heavy write directory). still conflict only then true conflict.
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
 * fault plugin occupy ID: takes precedence manifest legal id; otherwise directory name archive one (illegal character rotate _,
 * do not and registered id conflict when directly use, conflict when append directory name suffix).
 */
function resolveFailedPluginId(
  dirPath: string,
  dirName: string,
  existingIds: Set<string>,
): { id: string; meta: Record<string, unknown> } {
  const meta = readManifestMeta(dirPath);
  const manifestId = meta['id'];
  // external plugin id forbidden smoke number (smoke number only act builtin: naming empty between isolate symbol, and managed plugin package
  // PLUGIN_ID_PATTERN align; otherwise source directory and ctx.dataDir will fork, see plugin-dir-name.ts)
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
 * single directory fault register: archive one exception is PluginDiagnosticError after invoke registerFailed;
 * registerFailed unavailable (test stub) when keep old behavior on throw.
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

/** load and rescan directory where placement difference (see file head). */
export interface ScanVisitPolicy {
  /** directory name and registered id same name when fast skip (rescan: do not reload;load without this quick path). */
  fastSkipDirNameEqualsId: boolean;
  /** import define id registered:'fail' throw conflict error (load, hand over by fault register);'skip' static default skip (rescan). */
  alreadyRegistered: 'fail' | 'skip';
  /** each by skip directory call back once (rescan count skipped;load without operation). */
  onSkipped(): void;
}

/** visitExternalPluginDirs reference. */
export interface ScanVisitParams {
  dataDir: string;
  plugins: ExternalPluginHost;
  /** registered id set (caller pre- fill; access follow register succeeded append, supply after continue directory decide). */
  existingIds: Set<string>;
  /** succeeded register id append target (caller collect return value). */
  registered: string[];
  /** backend TS transpile function (host build port inject; not connect line when TS plugin in transpile phase explicit reject). */
  transform: BackendTsTransformFn | undefined;
  policy: ScanVisitPolicy;
}

/**
 * scan `<dataDir>/plugins/` all external plugin directory and by policy where placement. single directory fault
 * (scan / load phase) via registerScanFailure register is failed occupy, do not block assert other
 * directory load;register phase define / enable fault by PluginHost  isolateFailure
 * mechanism fall back is failed item, same without interruption loop.plugins directory missing (ENOENT) when
 * static default return (two caller all treated as empty result).
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
    // built-in plugin data directory (builtin%3Aprofile etc.) and hide directory one rule does not participate external plugin discover
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || isBuiltinPluginDataDirName(entry.name)) continue;
    const dirPath = resolve(pluginsDir, entry.name);
    if (policy.fastSkipDirNameEqualsId && existingIds.has(entry.name)) {
      policy.onSkipped(); // directory name same name registered plugin: fast skip (do not reload)
      continue;
    }
    // is plugin directory enable backend TS transpile (contains run phase motion state import each other for TS dependency).
    // any one failed path (import / id conflict / host register) all release counter; succeeded register then common resident
    // this process: plugin run phase motion state import dependency transpile available, already load module in ESM cache in keep
    // identity. therefore plugin deactivate/unload do not release, do not unload already load module (same process inside re-
    // register does not repeat initialize); release only occur in failed to load fall back when.
    const releaseTsRoot = registerPluginTsRoot(dirPath, { transform });
    let committed = false;
    try {
      const entryPath = await resolvePluginEntry(dirPath);
      if (entryPath === undefined) {
        policy.onSkipped(); // pure plugin data directory: static default skip
        continue;
      }
      const definition = await importScanDefinition(dirPath, entryPath, existingIds);
      if (existingIds.has(definition.id)) {
        if (policy.alreadyRegistered === 'skip') {
          policy.onSkipped(); // directory name and id inconsistent but registered: skip (do not reload)
          continue;
        }
        throw new HelmError(
          'plugin_already_registered',
          `external plugin ${dirPath}  id and registered plugin conflict: ${definition.id}`,
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
      // single directory fault fall back register (scan / load phase;register phase define / enable
      // fault already by isolateFailure absorb will not to this): do not block assert other directory.
      await registerScanFailure(plugins, dirPath, entry.name, existingIds, 'scan', err);
    } finally {
      if (!committed) releaseTsRoot();
    }
  }
}

/**
 * scan `<dataDir>/plugins/` and motion state load all external plugin (by default deactivate register).
 * return this time succeeded register external plugin id list (by directory scan order).
 * single directory fault (scan / load phase) via registerFailed register is failed occupy,
 * do not block assert other directory load;register phase define / enable fault by PluginHost 
 * isolateFailure mechanism fall back is failed item, same without interruption loop.
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
 * incremental heavy scan plugin directory: only register when before not registered external plugin (by default disabled,
 * enabled restore logic and start scan consistent - - via persist pluginEnabled); registered plugin do not reload,
 * do not dedupe, do not interference. return new register id list and skip directory counter (contains pure data directory/registered directory).
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
