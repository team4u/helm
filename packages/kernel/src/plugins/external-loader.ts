/**
 * Automatic discovery and dynamic loading of external plugin directories.
 *
 * Module layout (behavior unchanged): manifest parsing (plugin.json / package.json `helm` field)
 * lives in plugin-manifest.ts; startup full scans and incremental rescans
 * (loadExternalPlugins / rescanExternalPlugins) live in scan-visitor.ts;
 * this module owns entrypoint resolution, module import & definition boundary validation,
 * definition normalization, controlled hot reload (`reload`), and source directory lookup.
 *
 * Two kinds of directories coexist under `<dataDir>/plugins/` (note that PluginHost.register creates
 * `<dataDir>/plugins/<pluginDataDirName(pluginId)>` as `ctx.dataDir` for each registered plugin):
 * 1. Pure plugin data directories for registered plugins (e.g., `builtin%3Aprofile`, `builtin%3Aherdr`;
 *    `:` in IDs is uniformly escaped as `%3A` so Windows does not interpret it as an NTFS alternate
 *    data stream and fail directory creation — see plugin-dir-name.ts);
 * 2. User-placed external third-party plugin directories (containing plugin.json or a convention entrypoint).
 *
 * Detection rules (only rely on explicit entrypoint markers, never guess from directory names):
 * - When `plugin.json` exists: must parse as a JSON object; resolves the relative entrypoint from `main`
 *   (falling back to convention entry probes), strictly bounded inside the plugin directory (guards against
 *   path traversal, and `realpath` ensures symlinks cannot escape the root). Corrupt manifests, non-objects,
 *   invalid `main`, out-of-bounds entrypoints, or missing entrypoints throw explicit `HelmError`s rather than
 *   being silently ignored (honesty invariant). Optional fields on `plugin.json`: `clientRoot` (frontend
 *   source dir), `clientDependencies` (frontend controlled npm specifier array resolved relative to the
 *   plugin dir), and `dependencies` (cross-plugin ID array); invalid values are explicitly rejected.
 * - Without `plugin.json`: probes `index.ts` / `index.tsx` / `index.mjs` / `index.js` / `plugin.ts` /
 *   `plugin.tsx` / `plugin.mjs` / `plugin.js` in order; if none exist, treats it as an ordinary plugin data
 *   directory and skips it silently.
 * - `.ts` / `.tsx` / `.mts` / `.cts` entrypoints are transpiled in-process by `backend-ts-loader` (with
 *   `import.meta.url` pointing to the real plugin source file; relative `.js -> .ts` imports, node built-ins,
 *   local `node_modules`, and host `@helm/*` singletons are all available).
 * - IO errors: only ENOENT / ENOTDIR count as missing files; EACCES and other IO errors throw explicitly
 *   rather than being mistaken for a pure data directory.
 *
 * Security defaults:
 * - Dynamic loading uses explicit URL import via `pathToFileURL`;
 * - External plugin IDs must not use the `builtin:` prefix or collide with already-registered plugins;
 * - Any `locked` declaration is stripped (external plugins cannot mark themselves permanently resident);
 * - Only accepts `definePlugin` (the single `PluginDefinition` entrypoint; legacy aliases such as `setup`
 *   are explicitly rejected at the boundary);
 * - Registers with `{ enabled: false }` (least privilege); previously persisted `config.json.pluginEnabled[id] = true`
 *   is restored automatically inside `PluginHost.register`;
 * - External plugins without an explicit `clientRoot` default `clientRoot` to the plugin directory itself;
 *   an explicit `clientRoot` must be a non-empty string resolving to an absolute path inside the plugin
 *   directory (escapes are rejected). This check enforces a path-boundary convention only; plugin code runs
 *   with full host permissions and is not a security sandbox.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HelmError,
  parseNonEmptyLocalizedText,
  type LocalizedText,
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

/** Minimal host surface required for loading (structurally compatible with PluginHost for isolated tests). */
export interface ExternalPluginHost {
  register(
    definition: PluginDefinition,
    options?: { enabled?: boolean; isolateFailure?: boolean },
  ): Promise<void>;
  list(): PluginSummary[] | Promise<PluginSummary[]>;
  /** Optional: register a failed placeholder during scan/load (provided by PluginHost; test stubs without it preserve throw behavior). */
  registerFailed?(spec: {
    id: string;
    name?: LocalizedText;
    description?: LocalizedText;
    version?: string;
    error: PluginDiagnosticError;
  }): void;
  /**
   * Optional host build port accessor (provided by PluginHost): obtains the external-plugin TS
   * transpiler from PluginHostOptions.buildProvider. When missing, loading TS sources rejects explicitly
   * (`unsupported_backend_ts_build`); plain JS plugins are unaffected.
   */
  getBuildProvider?(): PluginBuildProvider | undefined;
}

/** Extract the backend TS transpile function from a host-like object (returns undefined when build port is unwired; shared with scan-visitor). */
export function tsTransformOf(
  host: { getBuildProvider?(): PluginBuildProvider | undefined },
): BackendTsTransformFn | undefined {
  return host.getBuildProvider?.()?.transformBackendTs;
}

/** Full host surface required for reload/rescan (adds unregister; structurally compatible with PluginHost). */
export interface ReloadablePluginHost extends ExternalPluginHost {
  unregister(pluginId: string): Promise<void>;
}

/** Convention entrypoint probe order when plugin.json (or `main`) is absent (TypeScript preferred, matching pi conventions). */
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

// Full/incremental scan implementation lives in scan-visitor.ts; re-exported here to preserve existing public exports
// (used by hub tests and production consumers).
export { loadExternalPlugins, rescanExternalPlugins } from './scan-visitor.js';

// ---------------------------------------------------------------------------
// Entrypoint resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a plugin directory's entrypoint file: undefined indicates no plugin entrypoint marker (pure data dir).
 * When plugin.json exists, follows the manifest branch (errors always throw explicitly, never silently skipped).
 */
export async function resolvePluginEntry(dirPath: string): Promise<string | undefined> {
  const manifestPath = join(dirPath, 'plugin.json');
  let manifestExists = true;
  try {
    statSync(manifestPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      // EACCES etc. real IO fault explicit errors, do not mistakenly judge is pure data directory
      throw new HelmError(
        'plugin_scan_failed',
        `external plugin directory cannot read: ${manifestPath}(${err instanceof Error ? err.message : String(err)})`,
        500,
        { manifestPath, code },
      );
    }
    manifestExists = false;
  }
  if (!manifestExists) {
    const probed = probeConventionEntry(dirPath);
    if (probed !== undefined) return probed;
    // npm standard entry back:package.json helm.main / main(.js suffix heavy write same name TS source)
    const helm = readHelmField(dirPath);
    const mainSpec = helm?.main;
    if (mainSpec !== undefined) {
      // npm packages often point `.js` at transpiled artifacts; prefer matching `.ts`/`.tsx` sources when present.
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
          `External plugin ${dirPath} package.json entry escapes plugin directory: ${spec}`,
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
      `External plugin ${dirPath} plugin.json does not declare main and no conventional entry (${CONVENTION_ENTRIES.join(' / ')}) was found`,
      500,
      { dirPath },
    );
  }
  if (typeof main !== 'string' || main.length === 0) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} plugin.json main must be a non-empty string`,
      500,
      { dirPath, main: String(main) },
    );
  }
  const entry = resolve(dirPath, main);
  const rel = relative(realpathSync(dirPath), entry);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} plugin.json main escapes plugin directory: ${main}`,
      400,
      { dirPath, main },
    );
  }
  return assertEntryFile(dirPath, main, entry);
}

/** Confirms entrypoint is a regular file inside `dirPath` (symlink escapes fail loudly). */
function assertEntryFile(dirPath: string, main: string, entry: string): string {
  let real: string;
  let isFile: boolean;
  try {
    real = realpathSync(entry);
    isFile = statSync(real).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new HelmError('plugin_entry_missing', `External plugin ${dirPath} entry file is missing: ${main}`, 500, {
        dirPath,
        main,
      });
    }
    throw new HelmError(
      'plugin_scan_failed',
      `External plugin entry cannot be read: ${entry} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { dirPath, main, code },
    );
  }
  if (!isFile) {
    throw new HelmError('plugin_entry_missing', `External plugin ${dirPath} entry is not a regular file: ${main}`, 500, {
      dirPath,
      main,
    });
  }
  const rel = relative(realpathSync(dirPath), real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} plugin.json main (resolved symlink) escapes plugin directory: ${main}`,
      400,
      { dirPath, main },
    );
  }
  return real;
}

/** in order probe convention entry file; hit i.e. return absolute path, all missing return undefined. */
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
          `external plugin directory probe failed: ${join(dirPath, name)}(${err instanceof Error ? err.message : String(err)})`,
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
/** Validates plugin dependencies declared in JS definition (invalid shapes fail explicitly). */
function normalizeCodeDependencies(
  dirPath: string,
  pluginId: string,
  values: unknown,
): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !MANIFEST_PLUGIN_ID_PATTERN.test(value))) {
    throw new HelmError(
      'invalid_plugin_definition',
      `External plugin ${dirPath} definition ${pluginId}.dependencies must be an array of plugin IDs (letters, digits, :, _, - only)`,
      400,
      { dirPath, pluginId, dependencies: Array.isArray(values) ? values.map((value) => String(value)) : String(values) },
    );
  }
  return [...new Set(values as string[])];

}

// ---------------------------------------------------------------------------
// Module import & definition validation
// ---------------------------------------------------------------------------

/** Dynamically imports plugin entrypoint (with optional generation cache-buster) and extracts `default`/`plugin` export. */
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
    if (err instanceof HelmError) throw err; // Transpilation error already carries file/line diagnostics.
    throw new HelmError(
      'plugin_load_failed',
      `Failed to load external plugin module: ${entryPath}${options.generation !== undefined ? ` (generation ${options.generation})` : ''} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { dirPath, entryPath, cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined },
    );
  }
  const candidate = mod.default ?? mod.plugin;
  return assertExternalDefinition(candidate, dirPath);
}

/**
 * Validates an external plugin module's exported definition: requires non-empty `id` (no `builtin:` prefix or `:`),
 * optional localized `name`, and `definePlugin` function.
 */
export function assertExternalDefinition(candidate: unknown, dirPath: string): PluginDefinition {
  const fail = (detail: string): HelmError =>
    new HelmError('invalid_plugin_definition', `Invalid external plugin export in ${dirPath}: ${detail}`, 400, { dirPath });
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw fail('did not export a default or plugin definition object');
  }
  const def = candidate as Record<string, unknown>;
  if (typeof def.id !== 'string' || def.id.length === 0) throw fail('missing non-empty string id');
  if (def.name !== undefined && parseNonEmptyLocalizedText(def.name) === undefined) {
    throw fail(`name provide when must be display copy (non-empty string or { en, 'zh-CN' } map with non-blank values)`);
  }
  if (def.icon !== undefined && (typeof def.icon !== 'string' || def.icon.trim().length === 0)) {
    throw fail('icon must be a non-empty string when provided');
  }
  if (def.id.startsWith('builtin:')) {
    throw new HelmError(
      'invalid_plugin_definition',
      `External plugin ${dirPath} id cannot start with 'builtin:': ${def.id}`,
      400,
      { dirPath, id: def.id },
    );
  }
  if (def.id.includes(':')) {
    throw new HelmError(
      'invalid_plugin_definition',
      `External plugin ${dirPath} id cannot contain ':' (smoke number; colons are reserved for builtin: namespaces): ${def.id}`,
      400,
      { dirPath, id: def.id },
    );
  }
  if (typeof def.definePlugin !== 'function') {
    throw fail('missing definePlugin function (external plugins must implement PluginDefinition)');
  }
  return def as unknown as PluginDefinition;
}

/**
 * external plugin define archive one:
 * - Strip `locked` (external plugins cannot mark themselves resident/non-unloadable);
 * - Cross-plugin dependencies: merge & deduplicate code and manifest (`plugin.json` `dependencies` /
 *   `package.json#helm.dependencies`); invalid manifest values already fail when read;
 * - Frontend controlled npm dependencies: normalize manifest specifiers (`plugin.json` `clientDependencies` /
 *   `package.json#helm.clientDependencies`) into `npmDependencies` anchored at the plugin directory itself
 *   while stripping code-declared `npmDependencies` so external plugins cannot open arbitrary bare dependencies;
 * - Default missing `clientRoot` to the plugin directory itself; require a string when provided; resolve
 *   relative paths inside the plugin directory (escapes reject explicitly); preserve absolute paths.
 *   Path bounds enforce a convention only and do not constitute a security sandbox.
 */
export function normalizeDefinition(definition: PluginDefinition, dirPath: string): PluginDefinition {
  const normalized = { ...definition };
  delete normalized.locked;
  // Frontend controlled npm dependencies: external plugins honor manifest declarations anchored to dirPath only.
  const clientDeps = readHelmClientDependencies(dirPath);
  delete normalized.npmDependencies;
  if (clientDeps.length > 0) {
    normalized.npmDependencies = Object.fromEntries(clientDeps.map((spec) => [spec, dirPath]));
  }
  // Cross-plugin dependencies: merge & deduplicate code and manifest (`plugin.json` and `package.json#helm`).
  //(self dependency by host register boundary reject).
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
    // not explicit declaration: can via plugin.json clientRoot or package.json helm.clientRoot declaration; otherwise by default plugin directory itself
    const helmClientRoot = readHelmClientRoot(dirPath);
    if (helmClientRoot !== undefined) {
      const resolvedRoot = resolve(dirPath, helmClientRoot);
      const rel = relative(realpathSync(dirPath), resolvedRoot);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new HelmError(
          'invalid_plugin_definition',
          `External plugin ${dirPath} manifest clientRoot escapes plugin directory: ${helmClientRoot}`,
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
      `External plugin ${dirPath} clientRoot must be a non-empty string`,
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
        `External plugin ${dirPath} relative clientRoot escapes plugin directory: ${clientRoot}`,
        400,
        { dirPath, clientRoot },
      );
    }
    normalized.clientRoot = resolvedRoot;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// DX loop: controlled hot reload (reload) and incremental rescan (rescan)
// ---------------------------------------------------------------------------

/**
 * Scan plugin directories and return the absolute path of the source directory whose definition id
 * equals the target `pluginId`. Follows the same resolution chain as startup scan (resolvePluginEntry
 * + import definition to inspect real id), so directory names differing from plugin id still match.
 * Returns undefined when absent (multiple hits indicate conflicting directories and throw explicitly).
 * Note: probing initializes modules (without cache-busting query strings for normal imports, consistent
 * with startup scan); registered plugins hit ESM cache and yield the old proxy definition object, which
 * reload keeps for rollback on switch failure.
 */
export async function findSourceDirByPluginId(
  dataDir: string,
  pluginId: string,
  options: { transform?: BackendTsTransformFn } = {},
): Promise<string | undefined> {
  const found = await findPluginSource(dataDir, pluginId, options);
  return found?.dir;
}

/** Scan hit: source directory path plus imported definition (for registered plugins, hits ESM cache with old proxy def). */
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
    // Corruption in unrelated directories must not break the whole scan; if the target's own directory
    // fails to parse, its source itself is broken and the caller receives missing-source error.
    let entryPath: string | undefined;
    const releaseTsRoot = registerPluginTsRoot(dirPath, { transform: options.transform });
    try {
      entryPath = await resolvePluginEntry(dirPath);
      if (entryPath === undefined) continue;
      const definition = await importPluginDefinition(dirPath, entryPath);
      if (definition.id === pluginId) hits.push({ dir: dirPath, definition });
    } catch {
      // Corrupt directory or unimportable entry: skip and continue scanning (valid targets still resolve).
      continue;
    } finally {
      releaseTsRoot();
    }
  }
  if (hits.length > 1) {
    throw new HelmError(
      'plugin_reload_ambiguous',
      `multiple plugin directories declare id ${pluginId}: ${hits.map((h) => h.dir).join(', ')}; cannot determine reload source`,
      409,
      { pluginId, dirs: hits.map((h) => h.dir) },
    );
  }
  return hits[0];
}

/**
 * Controlled hot reload for external plugins:
 * 1. Restricted to external plugins (`builtin:*` prefix always rejected with 403);
 * 2. Dry-run preflight via doctor (cache-busting import + temp-host register + client compile): any failure
 *    throws explicitly and leaves the live instance untouched;
 * 3. Atomic swap: unregister old instance (live-task guard rejects with 409 unless ready), then re-register
 *    with a fresh cache-busting import; enabled state is preserved across reload via persisted `pluginEnabled`.
 *
 * Reload imposes no persistent overhead on resident TS transpilation (`registerPluginTsRoot` ref-counting).
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
      `built-in plugin ${pluginId} cannot be hot-reloaded (restart Hub to apply built-in plugin changes)`,
      403,
      { pluginId },
    );
  }
  const current = (await plugins.list()).find((s) => s.id === pluginId);
  if (!current) {
    throw new HelmError('unknown_plugin', `unregistered plugin: ${pluginId}`, 404, { pluginId });
  }
  const wasEnabled = current.enabled;
  const source = await findPluginSource(dataDir, pluginId, { transform: tsTransformOf(plugins) });
  if (source === undefined) {
    throw new HelmError(
      'plugin_source_missing',
      `no external plugin source directory with id ${pluginId} found under ${join(dataDir, 'plugins')}`,
      404,
      { pluginId, pluginsDir: join(dataDir, 'plugins') },
    );
  }
  const sourceDir = source.dir;
  // Probe import returned the old cached definition object; reuse it to roll back on swap failure.
  const rollbackDefinition = source.definition;
  // Dry-run preflight: keep the old instance untouched on failure.
  await options.doctor?.(sourceDir);

  // Obtain a fresh cache-busting generation for the actual reload import.
  const entryPath = await resolvePluginEntry(sourceDir);
  if (entryPath === undefined) {
    throw new HelmError(
      'plugin_reload_failed',
      `plugin entrypoint disappeared during reload (source changed between preflight and swap): ${sourceDir}`,
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
        `plugin id changed during reload (preflight ${pluginId} -> actual ${definition.id}); aborting swap`,
        409,
        { pluginId, actualId: definition.id, sourceDir },
      );
    }
    await plugins.unregister(pluginId);
    try {
      await plugins.register(definition, { enabled: wasEnabled });
      committed = true;
    } catch (err) {
      // Swap failed: attempt best-effort rollback to the pre-reload definition without masking the root error.
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
        `re-registration failed during reload ${rollbackError === undefined ? '(rolled back to pre-reload instance; previous definition remains active)' : '(rollback also failed; plugin is currently unregistered — fix manually and retry)'}: ${err instanceof Error ? err.message : String(err)}`,
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
        `plugin ${pluginId} missing from host list after reload (inconsistent internal state)`,
        500,
        { pluginId },
      );
    }
    return { pluginId, wasEnabled, generation };
  } finally {
    if (!committed) releaseTsRoot();
  }
}
