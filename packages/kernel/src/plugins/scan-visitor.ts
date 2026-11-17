/**
 * scan-visitor.ts: shared `<dataDir>/plugins/` directory visitor used by both startup
 * scanning (`loadExternalPlugins`) and incremental discovery (`rescanExternalPlugins`),
 * parameterized by `ScanVisitPolicy`.
 */
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  HelmError,
  parseNonEmptyLocalizedText,
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
 * Imports a plugin definition; if its ID collides with an existing plugin (possibly due to an older
 * cached scan module), retries once with a fresh generation cache-buster to inspect latest source.
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
 * Resolves the placeholder ID for a failed external plugin: prefers a valid `manifest.id` (no colon),
 * otherwise falls back to a sanitized directory name deduplicated against `existingIds`.
 */
function resolveFailedPluginId(
  dirPath: string,
  dirName: string,
  existingIds: Set<string>,
): { id: string; meta: Record<string, unknown> } {
  const meta = readManifestMeta(dirPath);
  const manifestId = meta['id'];
  // Colons are reserved for `builtin:` plugin IDs so external dirs align cleanly with ctx.dataDir.
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

/** Records a directory scan/load error via `registerFailed` (or rethrows on minimal test hosts lacking it). */
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
  const metaName = parseNonEmptyLocalizedText(meta['name']);
  plugins.registerFailed({
    id,
    ...(metaName !== undefined ? { name: metaName } : {}),
    error: { ...error, details: { ...(error.details ?? {}), dirPath } },
  });
  existingIds.add(id);
}

/** Behavioral policy distinguishing startup scan (`load`) vs incremental `rescan`. */
export interface ScanVisitPolicy {
  /** Skip immediately when directory name matches an already-registered plugin ID (true for `rescan`). */
  fastSkipDirNameEqualsId: boolean;
  /** Conflict handling after import: `'fail'` throws `plugin_already_registered` (`load`); `'skip'` silently skips (`rescan`). */
  alreadyRegistered: 'fail' | 'skip';
  /** Invoked for each skipped directory (`rescan` increments skipped count). */
  onSkipped(): void;
}

export interface ScanVisitParams {
  dataDir: string;
  plugins: ExternalPluginHost;
  /** Registered plugin IDs seen so far (updated in place as directories succeed or register as failed). */
  existingIds: Set<string>;
  /** Output list of newly registered plugin IDs. */
  registered: string[];
  /** Backend TS transpiler from host build port (missing rejects TS plugins during transpilation). */
  transform: BackendTsTransformFn | undefined;
  policy: ScanVisitPolicy;
}

/**
 * Scans `<dataDir>/plugins/` according to `policy`. Individual scan/load errors record a `failed`
 * placeholder without blocking sibling plugins; missing `<dataDir>/plugins/` (`ENOENT`) returns cleanly.
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
    // Built-in plugin data dirs (`builtin%3A...`) and dotfiles never participate in external plugin discovery.
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || isBuiltinPluginDataDirName(entry.name)) continue;
    const dirPath = resolve(pluginsDir, entry.name);
    if (policy.fastSkipDirNameEqualsId && existingIds.has(entry.name)) {
      policy.onSkipped();
      continue;
    }
    // Enable backend TS transpilation for the plugin root; released on failure, retained across process lifetime on success.
    const releaseTsRoot = registerPluginTsRoot(dirPath, { transform });
    let committed = false;
    try {
      const entryPath = await resolvePluginEntry(dirPath);
      if (entryPath === undefined) {
        policy.onSkipped(); // Pure data directory: skip silently
        continue;
      }
      const definition = await importScanDefinition(dirPath, entryPath, existingIds);
      if (existingIds.has(definition.id)) {
        if (policy.alreadyRegistered === 'skip') {
          policy.onSkipped();
          continue;
        }
        throw new HelmError(
          'plugin_already_registered',
          `External plugin ${dirPath} id collides with an already registered plugin: ${definition.id}`,
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
      // Single-directory fault fallback registration (scan/load phase; define/enable failures during
      // `register` are already absorbed by `isolateFailure` and never reach here): do not block other directories.
      await registerScanFailure(plugins, dirPath, entry.name, existingIds, 'scan', err);
    } finally {
      if (!committed) releaseTsRoot();
    }
  }
}

/**
 * Scans `<dataDir>/plugins/` and dynamically loads all external plugins (registered disabled by default).
 * Returns the list of external plugin IDs registered in this pass (in directory scan order).
 * Single-directory faults in the scan/load phase are recorded as `failed` placeholders via `registerFailed`
 * without blocking other directories; define/enable faults during `register` are downgraded to `failed` entries
 * by `PluginHost`'s `isolateFailure` mechanism, likewise without interrupting the loop.
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
 * Incrementally rescans the plugins directory: registers only newly discovered external plugins
 * (disabled by default, with enabled-state restoration matching startup scan via persisted `pluginEnabled`);
 * already-registered plugins are neither reloaded nor disturbed. Returns newly registered IDs and
 * the skipped directory count (including pure data directories and already-registered directories).
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
