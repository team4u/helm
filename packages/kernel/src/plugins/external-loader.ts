/**
 * external plugin directory automatically discover and motion state load.
 *
 * module split (behavior do not change): manifest parse layer (plugin.json / package.json helm field)
 * see plugin-manifest.ts; start all amount scan and incremental heavy scan public directory access
 * (loadExternalPlugins / rescanExternalPlugins) see scan-visitor.ts;
 * this module keep: entry parse, module import and define boundary validate, define archive one,
 * subject to control hot reload (reload) and source directory locate.
 *
 * `<dataDir>/plugins/` under mixed two class directory (key background:PluginHost.register will is each
 * registered plugin create `<dataDir>/plugins/<pluginDataDirName(pluginId)>` as its ctx.dataDir):
 * 1. registered plugin pure data directory (such as `builtin%3Aprofile`,`builtin%3Aherdr`;
 *    id in `:` when unify escaping is `%3A`, otherwise Windows will it when into NTFS
 *    hand over replace data stream while cannot create directory, see plugin-dir-name.ts);
 * 2. user put external third way plugin directory (contains plugin.json or convention entry file).
 *
 * decide rule (only recognize plugin entry mark record, never rely directory name guess):
 * - store in `plugin.json` → must be can parse JSON object; by `main`(default back convention
 *   entry probe) parse entry file relative path, strictly validate do not exceeds out plugin directory (guard against path through exceeds,
 *   realpath guarantee real entry do not exceeds root). manifest corrupt / non- object / main illegal /
 *   entry out of bounds / entry missing one rule explicit HelmError, never static default swallow wrong (honest discipline);
 *   plugin.json optional field:`clientRoot`(frontend source directory),`clientDependencies`
 *   (frontend subject to control npm note symbol array, mapping parse = plugin directory),`dependencies`
 *   (plugin between dependency ID array); illegal value explicit reject, never static default ignore.
 * - without `plugin.json` → in order probe `index.ts` / `index.tsx` / `index.mjs` /
 *   `index.js` / `plugin.ts` / `plugin.tsx` / `plugin.mjs` / `plugin.js`;
 *   a all missing → only is ordinary plugin data directory, static default skip.
 * - entry is .ts/.tsx/.mts/.cts when by backend-ts-loader in process inside transpile load
 *   (source code i.e. module URL,import.meta.url points to plugin real source file; each other for .js -> .ts
 *   mapping,Node inside placement / plugin directory npm dependency,@helm/* host the same instance all available).
 * - IO error zone: only ENOENT / ENOTDIR means file missing;EACCES etc. other
 *   IO error explicit throws, never mistakenly judge is pure data directory skip.
 *
 * security by default:
 * - motion state load via `pathToFileURL` explicit URL import;
 * - external plugin id forbidden `builtin:` prefix (do not smoke fill inside placement), forbidden and registered plugin heavy name;
 * - `locked` declaration one rule strip (external plugin cannot self seal common resident cannot unload);
 * - only accept `definePlugin`(protocol PluginDefinition unique entry; items item explicit
 *   does not compatibility alias,`setup` etc. old form in boundary explicit reject);
 * - register one rule `{ enabled: false }`(most small permission); once persist
 *   `config.json.pluginEnabled[id] = true` by PluginHost.register internal
 *   query persistedEnabled auto-recovery enable;
 * - not explicit settings clientRoot external plugin by default clientRoot = plugin directory itself;
 *   clientRoot must be non-empty string, each other for clientRoot parse is plugin directory inside absolute path
 *   (out of bounds explicit reject). the validate only is path boundary convention (plugin code itself own host permission,
 *   does not construct into security sandbox promise).
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

/** load which must most small host shape (real PluginHost structure compatibility, convenient at independent test). */
export interface ExternalPluginHost {
  register(
    definition: PluginDefinition,
    options?: { enabled?: boolean; isolateFailure?: boolean },
  ): Promise<void>;
  list(): PluginSummary[] | Promise<PluginSummary[]>;
  /** optional:scan / load phase fault occupy register (real PluginHost provide; test stub not implemented when keep old behavior on throw). */
  registerFailed?(spec: {
    id: string;
    name?: LocalizedText;
    description?: LocalizedText;
    version?: string;
    error: PluginDiagnosticError;
  }): void;
  /**
   * optional: host build port through out (real PluginHost provide): external plugin TS transpile function
   * by this take self PluginHostOptions.buildProvider. not implemented/not inject when TS source load in
   * transpile phase explicit reject (unsupported_backend_ts_build),JS plugin do not subject to affect.
   */
  getBuildProvider?(): PluginBuildProvider | undefined;
}

/** from host shape take backend TS transpile function (build port not connect line when undefined;scan-visitor shared use). */
export function tsTransformOf(
  host: { getBuildProvider?(): PluginBuildProvider | undefined },
): BackendTsTransformFn | undefined {
  return host.getBuildProvider?.()?.transformBackendTs;
}

/** reload/rescan which must complete host shape (contains unregister; real PluginHost structure compatibility). */
export interface ReloadablePluginHost extends ExternalPluginHost {
  unregister(pluginId: string): Promise<void>;
}

/** without plugin.json(or main default) when convention entry probe order (TypeScript takes precedence, same pi habit). */
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

// start all amount/incremental scan implement already split until scan-visitor.ts; via this module again export keep since has
// public exports do not change (hub test and produce product consumer directly from external-loader import).
export { loadExternalPlugins, rescanExternalPlugins } from './scan-visitor.js';

// ---------------------------------------------------------------------------
// entry parse
// ---------------------------------------------------------------------------

/**
 * parse plugin directory entry file:undefined means without any plugin entry mark record (pure data directory).
 * plugin.json store in when away manifest branch (error one rule explicit throw, never static default skip).
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
      // npm artifact habit .js suffix points to transpile before .ts source: same name .ts/.tsx store in when takes precedence
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
          `external plugin ${dirPath}  package.json entry exceeds out plugin directory: ${spec}`,
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
      `external plugin ${dirPath}  plugin.json not declaration main and directory inside without convention entry (${CONVENTION_ENTRIES.join(' / ')})`,
      500,
      { dirPath },
    );
  }
  if (typeof main !== 'string' || main.length === 0) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `external plugin ${dirPath}  plugin.json main must be non-empty string`,
      500,
      { dirPath, main: String(main) },
    );
  }
  const entry = resolve(dirPath, main);
  const rel = relative(realpathSync(dirPath), entry);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `external plugin ${dirPath}  plugin.json main exceeds out plugin directory: ${main}`,
      400,
      { dirPath, main },
    );
  }
  return assertEntryFile(dirPath, main, entry);
}

/**
 * confirm entry is store in ordinary file and return realpath(symlink chain to directory outside when realpath
 * out of bounds explicit reject, guarantee real entry do not exceeds root).
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
      throw new HelmError('plugin_entry_missing', `external plugin ${dirPath} entry file missing: ${main}`, 500, {
        dirPath,
        main,
      });
    }
    throw new HelmError(
      'plugin_scan_failed',
      `external plugin entry cannot read: ${entry}(${err instanceof Error ? err.message : String(err)})`,
      500,
      { dirPath, main, code },
    );
  }
  if (!isFile) {
    throw new HelmError('plugin_entry_missing', `external plugin ${dirPath} entry is not ordinary file: ${main}`, 500, {
      dirPath,
      main,
    });
  }
  const rel = relative(realpathSync(dirPath), real);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `external plugin ${dirPath}  plugin.json main(contains symlink) exceeds out plugin directory: ${main}`,
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
/** validate external plugin code declaration plugin dependency; illegal shape must explicit failed, cannot in manifest archive one when static default discard. */
function normalizeCodeDependencies(
  dirPath: string,
  pluginId: string,
  values: unknown,
): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !MANIFEST_PLUGIN_ID_PATTERN.test(value))) {
    throw new HelmError(
      'invalid_plugin_definition',
      `external plugin ${dirPath} define ${pluginId}.dependencies must be plugin ID string array (only allows character parent number : _ -)`,
      400,
      { dirPath, pluginId, dependencies: Array.isArray(values) ? values.map((value) => String(value)) : String(values) },
    );
  }
  return [...new Set(values as string[])];

}

// ---------------------------------------------------------------------------
// module import and define validate
// ---------------------------------------------------------------------------

/** motion state import entry module and extract default / plugin export is plugin define (can carry proxy boundary mark record re- initialize module diagram). */
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
    if (err instanceof HelmError) throw err; // transpile error already carries locate, original on throw
    throw new HelmError(
      'plugin_load_failed',
      `external plugin module failed to load: ${entryPath}${options.generation !== undefined ? `(proxy boundary ${options.generation})` : ''}(${err instanceof Error ? err.message : String(err)})`,
      500,
      { dirPath, entryPath, cause: err instanceof Error ? { message: err.message, stack: err.stack } : undefined },
    );
  }
  const candidate = mod.default ?? mod.plugin;
  return assertExternalDefinition(candidate, dirPath);
}

/**
 * boundary validate external module export define shape: non-empty string id / name + definePlugin function;
 * id forbidden builtin: prefix and smoke number (smoke number only act builtin: naming empty between isolate symbol; external plugin
 * id contains smoke number will break source directory i.e. ctx.dataDirinvariant, see plugin-dir-name.ts).
 * only accept protocol PluginDefinition  definePlugin,setup etc. compatibility alias one rule reject
 * (items item explicit does not to after compatibility). return specification define.
 */
export function assertExternalDefinition(candidate: unknown, dirPath: string): PluginDefinition {
  const fail = (detail: string): HelmError =>
    new HelmError('invalid_plugin_definition', `external plugin ${dirPath} module export illegal:${detail}`, 400, { dirPath });
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw fail('not export default or plugin define object');
  }
  const def = candidate as Record<string, unknown>;
  if (typeof def.id !== 'string' || def.id.length === 0) throw fail('missing non-empty string id');
  // name optional (same protocol PluginDefinition): not provide when render name by PluginHost
  // back id; provide when must be display copy (non-empty string or supported-locale map), do not
  // another add required constraint (and built-in plugin same right)
  if (def.name !== undefined && parseNonEmptyLocalizedText(def.name) === undefined) {
    throw fail(`name provide when must be display copy (non-empty string or { en, 'zh-CN' } map with non-blank values)`);
  }
  if (def.icon !== undefined && (typeof def.icon !== 'string' || def.icon.trim().length === 0)) {
    throw fail('icon provide when must be non-empty string');
  }
  if (def.id.startsWith('builtin:')) {
    throw new HelmError(
      'invalid_plugin_definition',
      `external plugin ${dirPath}  id disallows with builtin: open head (do not smoke fill built-in plugin): ${def.id}`,
      400,
      { dirPath, id: def.id },
    );
  }
  if (def.id.includes(':')) {
    throw new HelmError(
      'invalid_plugin_definition',
      `external plugin ${dirPath}  id disallows contains smoke number (smoke number only act builtin: naming empty between isolate symbol, and managed plugin package id rule consistent): ${def.id}`,
      400,
      { dirPath, id: def.id },
    );
  }
  if (typeof def.definePlugin !== 'function') {
    throw fail('missing definePlugin function (external plugin only accept protocol PluginDefinition, without compatibility alias)');
  }
  return def as unknown as PluginDefinition;
}

/**
 * external plugin define archive one:
 * - strip locked(external plugin cannot self seal common resident cannot unload, start stop right archive user persist state);
 * - plugin between dependency: code declaration and manifest declaration (plugin.json dependencies / package.json
 *   helm.dependencies) merge dedupe enter define; illegal manifest value in read where already explicit reject.
 * - frontend subject to control npm dependency: manifest declaration note symbol (plugin.json clientDependencies /
 *   package.json helm.clientDependencies) unify mapping is npmDependencies, parse
 *   constant is plugin itself directory (subject to control boundary); code inside declaration npmDependencies one rule strip - -
 *   external plugin must not self refer any parse (do not put open any bare dependency).
 * - clientRoot not settings → by default plugin directory itself; must be string (non- string boundary reject);
 *   relative path → parse is plugin directory inside absolute path (exceeds out plugin directory explicit reject, guard against through exceeds);
 *   absolute path original keep. path boundary validate only is convention constraint, is not security sandbox promise.
 */
export function normalizeDefinition(definition: PluginDefinition, dirPath: string): PluginDefinition {
  const normalized = { ...definition };
  delete normalized.locked;
  // frontend subject to control npm dependency: external plugin only recognize manifest declaration, parse mapping to plugin itself directory.
  const clientDeps = readHelmClientDependencies(dirPath);
  delete normalized.npmDependencies;
  if (clientDeps.length > 0) {
    normalized.npmDependencies = Object.fromEntries(clientDeps.map((spec) => [spec, dirPath]));
  }
  // plugin between dependency: code declaration + manifest declaration (plugin.json and package.json helm merge) merge dedupe
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
          `external plugin ${dirPath} manifest clientRoot exceeds out plugin directory: ${helmClientRoot}`,
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
      `external plugin ${dirPath}  clientRoot must be non-empty string`,
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
        `external plugin ${dirPath} each other for clientRoot exceeds out plugin directory: ${clientRoot}`,
        400,
        { dirPath, clientRoot },
      );
    }
    normalized.clientRoot = resolvedRoot;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// DX closed ring: subject to control hot reload (reload) and incremental heavy scan (rescan)
// ---------------------------------------------------------------------------

/**
 * scan plugin directory, return define id equals target idplugin source directory absolute path.
 * and start scan the same decide chain (resolvePluginEntry + import define read real id); directory name and id
 * inconsistent also can hit. without hit return undefined(multiple hit belongs to directory state exception, explicit throws).
 * note: probe itself will initialize module (without proxy boundary mark record common rule import); and start scan behavior consistent.
 * registered plugin probe import hit ESM cache - - return is old proxy (when before register instance) define object,
 * reload use it as switch failed after rollback define.
 */
export async function findSourceDirByPluginId(
  dataDir: string,
  pluginId: string,
  options: { transform?: BackendTsTransformFn } = {},
): Promise<string | undefined> {
  const found = await findPluginSource(dataDir, pluginId, options);
  return found?.dir;
}

/** scan result: source directory + probe import obtain to define (registered plugin hit ESM cache, i.e. old proxy define). */
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
    // other directory corrupt (broken manifest / broken entry) must not blast assert whole directory scan: directory name and target
    // id inconsistent when i.e. convenient fix also round fewer than it hit, directly skip; same name directory failed to parse when target
    // source code itself still where at corrupt state, hand over by on layer by not found source directory errors.
    let entryPath: string | undefined;
    const releaseTsRoot = registerPluginTsRoot(dirPath, { transform: options.transform });
    try {
      entryPath = await resolvePluginEntry(dirPath);
      if (entryPath === undefined) continue;
      const definition = await importPluginDefinition(dirPath, entryPath);
      if (definition.id === pluginId) hits.push({ dir: dirPath, definition });
    } catch {
      // directory corrupt or entry cannot import: skip the directory continue scan (fix after target directory still can hit).
      continue;
    } finally {
      releaseTsRoot();
    }
  }
  if (hits.length > 1) {
    throw new HelmError(
      'plugin_reload_ambiguous',
      `multiple plugin directory declaration id all is ${pluginId}:${hits.map((h) => h.dir).join(',')}, cannot determine reload source`,
      409,
      { pluginId, dirs: hits.map((h) => h.dir) },
    );
  }
  return hits[0];
}

/**
 * external plugin subject to control hot reload:
 * 1. only limit external plugin (builtin:* prefix one rule 403);
 * 2. dry-run:doctor all chain preflight (proxy boundary import + temporary host real register + client real compile),
 *    any one failed explicit throws and old instance keep do not motion (broken code preflight failed never interrupt in run plugin);
 * 3. switch:unregister old instance (in-flight task check by PluginHost force:409 reject) after,
 *    with preflight via new proxy boundary define re- register; enable state keep reload before state (via persist
 *    pluginEnabled auto-recovery, eventually state and pre- phase inconsistent when explicit errors, never static default).
 *
 * reload for plugin common resident TS transpile produces no extra negative bear (registerPluginTsRoot reference counter).
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
      `built-in plugin ${pluginId} forbidden hot reload (please restart Hub takes effect kernel/built-in plugin change)`,
      403,
      { pluginId },
    );
  }
  const current = (await plugins.list()).find((s) => s.id === pluginId);
  if (!current) {
    throw new HelmError('unknown_plugin', `not registered plugin:${pluginId}`, 404, { pluginId });
  }
  const wasEnabled = current.enabled;
  const source = await findPluginSource(dataDir, pluginId, { transform: tsTransformOf(plugins) });
  if (source === undefined) {
    throw new HelmError(
      'plugin_source_missing',
      `in ${join(dataDir, 'plugins')} under not found id is ${pluginId} external plugin source directory`,
      404,
      { pluginId, pluginsDir: join(dataDir, 'plugins') },
    );
  }
  const sourceDir = source.dir;
  // probe import return old proxy define (registered plugin entry URL hit ESM cache): switch failed after
  // rollback define. rollback along use old define object (the same definePlugin reference, without duplicate initialize).
  const rollbackDefinition = source.definition;
  // dry-run preflight: on failure old instance original seal do not motion (do not unregister).
  await options.doctor?.(sourceDir);

  // preflight via after re- take under one proxy boundary number (doctor already consume one proxy, this in use new proxy import actual register).
  const entryPath = await resolvePluginEntry(sourceDir);
  if (entryPath === undefined) {
    throw new HelmError(
      'plugin_reload_failed',
      `reload when plugin entry disappear (preflight and switch between source directory by change):${sourceDir}`,
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
        `reload when plugin id change (preflight ${pluginId} -> actual ${definition.id}), reject switch`,
        409,
        { pluginId, actualId: definition.id, sourceDir },
      );
    }
    await plugins.unregister(pluginId);
    try {
      await plugins.register(definition, { enabled: wasEnabled });
      committed = true;
    } catch (err) {
      // switch failed: use old proxy define exhaust force rollback (the same definePlugin reference, without duplicate initialize),
      // let plugin back to reload before available state. rollback itself on failure do not mask original error, such as on report
      //(now plugin deregistered, must human fix; persist start stop state not passively).
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
        `reload after re- register failed${rollbackError === undefined ? '(already rollback to reload before instance, old define continue available)' : '(rollback also failed, plugin when before deregistered, must human fix after retry)'}:${err instanceof Error ? err.message : String(err)}`,
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
        `reload after not in host manifest in discover plugin ${pluginId}(internal state inconsistent)`,
        500,
        { pluginId },
      );
    }
    return { pluginId, wasEnabled, generation };
  } finally {
    if (!committed) releaseTsRoot();
  }
}
