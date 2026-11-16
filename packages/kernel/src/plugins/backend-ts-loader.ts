/**
 * backend plugin TypeScript module load (external-loader transpile bottom seat).
 *
 * mechanism (Node 24 `module.registerHooks` main thread sync hook + build port inject transpile function):
 * - only transpile registered plugin directory (realpath) inside .ts/.tsx/.mts/.cts source file is ESM;
 *   file URL is exactly real source file URL(do not to cache artifact file), therefore `import.meta.url` /
 *   each other for asset locate forever points to plugin directory inside real source file, do not subject to cache path affect;
 * - module identity by Node ESM cache by URL guarantee: the same path many time import only initialize once,
 *   and host itself module sharing the same register table (never bundle a @helm/protocol / SDK build into
 *   instanceof / registry double);
 * - resolve hook patch complete TypeScript habit each other for import mapping (.js -> .ts/.tsx,.mjs -> .mts,
 *   without extension -> .ts/.tsx / index.ts). retry only in original generate parse throw ERR_MODULE_NOT_FOUND
 *   (choose indeed missing) when enter row; permission etc. other parse error original on throw. hit choose first realpath:
 *   real path exceeds out all registered (symlink escape) do not transpile, such as failed;realpath URL
 *   also guarantee.js mapping import and explicit .ts import is the same module instance (Node original generate for
 *   symlink also return realpath URL, two path day however same URL);
 * - bare note symbol hand over to Node original generate parse:Node inside placement module directly available,npm package by plugin directory to on
 *    node_modules rule parse (plugin this directory install i.e. can takes effect),`@helm/*` host public package via
 *   host itself import.meta.resolve (the same instance);
 * - esbuild will strip ESM import attributes(known not implemented), therefore plugin inside each other for .json import
 *   by load hook patch note `type: 'json'`, plugin source no need to (also cannot) write import attributes;
 * - source code transpile error (language method / type layer side parse error) explicit throw
 *   `HelmError('plugin_load_failed')`, attach file, row column number and esbuild diagnose text.
 *
 * lifecycle: hook lazy register - - first register when registerHooks, all release when deregister
 * (only reverse register this load hook instance, does not affect host process inside other hooks). succeeded register
 * plugin common resident process: plugin run phase motion state import  TS dependency need to transpile available, and module already
 * load URL in ESM cache in keep identity. therefore deactivate / unload plugin do not release,
 * do not unload already load module (same process inside restart/re- register does not repeat initialize); release only occur in
 * failed to load fall back when, only affect after continue parse behavior.
 *
 * subject to control proxy boundary load (hot reload bottom seat):nextPluginGeneration is plugin reserved under one proxy
 * proxy count number; caller in entry URL additional `?helmgen=<n>` i.e. can let the plugin each other for dependency closed package
 * in this process inside re- initialize (new module diagram,definePlugin re- execute), while old proxy count module
 * keep available (old instance continue run). proxy boundary mark record only along plugin inside each other for import pass broadcast;
 * bare note symbol (@helm/* host public package,npm package,node: inside placement) original generate parse and do not carries mark record,
 * and host and old proxy count sharing the same instance, never by proxy boundary load pollute.
 *
 * boundary and honest:
 * - outside code do not via this load transpile, load capability and result by Node original generate decide; outside
 *   .js/.cjs etc. file same pass-through Node- - this load negative duty run can message plugin code, is not
 *   sandbox: can message plugin and host same permission, path boundary is transpile scope convention while non- security promise;
 * - backend .tsx real purpose is and frontend sharing source file form pure logic module (JSX language method can write,
 *   transpile is react/jsx-runtime import, must plugin directory self prepare react or change use pure .ts);React
 *   component still belong frontend client.tsx track path (@helm/plugin-build), this where does not JSX runtime inject.
 *
 * build port: this module only keep load mechanism (resolve policy, proxy boundary pass broadcast,containment,
 * hook lifecycle); source code transpile by PluginBuildProvider.transformBackendTs provide and via
 * registerPluginTsRoot(root, { transform }) explicit inject (produce product in hub connect line by default implement).
 * kernel do not static dependency esbuild; not inject transform when need to transpile load explicit reject
 * (501 unsupported_backend_ts_build), never fall back inside placement transpile.
 */
import { registerHooks, type ModuleHooks } from 'node:module';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HelmError, type PluginBuildProvider } from '@helm/protocol';

/** transpile function shape (PluginBuildProvider.transformBackendTs). */
export type BackendTsTransformFn = PluginBuildProvider['transformBackendTs'];

/** support transpile TypeScript source extension (.cts transpile artifact still by ESM load, keep single one module form). */
const TS_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** Node original generate can parse JS family extension (TS habit mapping source form). */
const JS_FAMILY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** registered plugin directory (realpath): reference counter and the transpile function (build port inject). */
interface TsRootEntry {
  count: number;
  transform?: BackendTsTransformFn;
}

const rootRefCounts = new Map<string, TsRootEntry>();

/**
 * module proxy boundary counter (subject to control hot reload use): realpath -> under one proxy proxy count number.
 * reload when for entry URL append `?helmgen=<n>` make Node ESM cache by new URL re- initialize
 * plugin module diagram;resolve hook will the mark record along plugin inside each other for import one by one layer pass broadcast,
 * while bare note symbol (@helm/*,npm package,node: inside placement) do not carries mark record original generate parse, still and host sharing
 * the same instance - - proxy boundary isolated only effect at plugin internal, never pollute outside module.
 */
const rootGenerations = new Map<string, number>();

/** reserved proxy boundary query parameter prefix (excludes = and value). */
const GENERATION_QUERY_PREFIX = 'helmgen=';

/**
 * extract URL  helmgen proxy count number (without mark record return undefined).
 * only in plugin inside each other for import pass broadcast chain on appear; entry by reload/doctor explicit additional.
 */
function generationOfUrl(url: string): number | undefined {
  const queryStart = url.lastIndexOf('?');
  if (queryStart === -1) return undefined;
  const params = url.slice(queryStart + 1).split('&');
  for (const param of params) {
    if (!param.startsWith(GENERATION_QUERY_PREFIX)) continue;
    const value = Number(param.slice(GENERATION_QUERY_PREFIX.length));
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** to file URL additional helmgen proxy count mark record (already has mark record when original return). */
function withGenerationQuery(url: string, generation: number): string {
  if (generationOfUrl(url) !== undefined) return url;
  return `${url}?${GENERATION_QUERY_PREFIX}${generation}`;
}

/**
 * reserved and return plugin under one proxy proxy count number (single tune pass increase).
 * caller (doctor / reload) use it construct carries `?helmgen=<n>` entry URL, implement subject to control hot reload:
 * the same plugin directory new proxy count module diagram independent initialize, old proxy count module in ESM cache in keep available
 * (old plugin instance continue run); bare note symbol dependency do not subject to affect (and host same instance).
 */
export function nextPluginGeneration(rootDir: string): number {
  const root = realpathSync(rootDir);
  const next = (rootGenerations.get(root) ?? 0) + 1;
  rootGenerations.set(root, next);
  return next;
}

/** lazy register hook instance; all release when deregister(see file head lifecycle). */
let hooks: ModuleHooks | undefined;

/** host side package parse: catch this module itself import.meta.resolve(across any run environment stable points to kernel work zone). */
const hostMetaResolve = import.meta.resolve;

/** target(term method or real path) is otherwise at root inside (across platform:relative + sep, do not hard encode isolate symbol). */
function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** url is otherwise at any one registered directory of under (with realpath register;symlink URL by resolve layer consume solve). */
function isInsideAnyRoot(url: string): boolean {
  return rootOfUrl(url) !== undefined;
}

/** url which belong registered (without then undefined);transformOfRoot and decide shared use the same iterate. */
function rootOfUrl(url: string): string | undefined {
  if (rootRefCounts.size === 0 || !url.startsWith('file:')) return undefined;
  let path: string;
  try {
    path = fileURLToPath(url);
  } catch {
    return undefined;
  }
  for (const root of rootRefCounts.keys()) {
    if (isInsideRoot(root, path)) return root;
  }
  return undefined;
}

/** take url which belong registered transpile function (not inject when undefined;load hook explicit reject). */
function transformOfRoot(url: string): BackendTsTransformFn | undefined {
  const root = rootOfUrl(url);
  return root === undefined ? undefined : rootRefCounts.get(root)?.transform;
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

/** note symbol extension (remove query/fragment; bare package name and sub- path unify take tail part segment). */
function specifierExtension(specifier: string): string {
  const clean = specifier.split('?')[0]!.split('#')[0]!;
  return fileExtension(clean);
}

/**
 * each other for note symbol failed to parse when TypeScript habit choose (tsc --module nodenext mapping sub- collection).
 * only in original generate parse confirm target missing (ERR_MODULE_NOT_FOUND) after one by one probe.
 */
function tsResolutionCandidates(resolvedPath: string): string[] {
  const ext = fileExtension(resolvedPath);
  if (ext === '.js') {
    const stem = resolvedPath.slice(0, -3);
    return [`${stem}.ts`, `${stem}.tsx`];
  }
  if (ext === '.mjs') return [`${resolvedPath.slice(0, -4)}.mts`];
  if (ext === '.cjs') return [`${resolvedPath.slice(0, -4)}.cts`];
  return [`${resolvedPath}.ts`, `${resolvedPath}.tsx`, join(resolvedPath, 'index.ts'), join(resolvedPath, 'index.tsx')];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

/** .js family note symbol parse out outside TS source: unify reject (do not transpile outside code, never because mapping source different while opening path do not one). */
function rootEscapeError(specifier: string, candidate: string, real: string): HelmError {
  return new HelmError(
    'plugin_load_failed',
    `external plugin each other for dependency ${specifier} parse to plugin directory outside TypeScript source ${candidate}(real path ${real}), reject transpile; such as indeed must reference outside module, please directly use its real extension note symbol`,
    500,
    { specifier, candidate, real },
  );
}

/** register process hook (idempotent: registered when re- use the same instance). */
function ensureHooks(): void {
  if (hooks !== undefined) return;
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (parent === undefined || !isInsideAnyRoot(parent)) {
        return nextResolve(specifier, context);
      }
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        // proxy boundary pass broadcast: parent module carry helmgen mark record when, parse result if at plugin inside then additional
        // the same mark record - - new proxy count each other for dependency closed package whole re- initialize; bare note symbol (@helm/* /
        // npm / node:) do not away this branch, and host and old proxy count sharing the same instance, never by pollute.
        const parentGeneration = generationOfUrl(parent);
        /** inside file URL additional proxy boundary mark record (outside file do not mark record: sharing module do not duplicate instance). */
        const settle = (url: string): { url: string; shortCircuit?: boolean } =>
          parentGeneration === undefined || !isInsideAnyRoot(url)
            ? { url }
            : { url: withGenerationQuery(url, parentGeneration), shortCircuit: true };
        let resolved: { url: string; shortCircuit?: boolean };
        try {
          resolved = nextResolve(specifier, context);
        } catch (err) {
          // only choose indeed missing only then by TS habit retry; permission etc. other parse error original on throw
          if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
          let target: string;
          try {
            target = fileURLToPath(new URL(specifier, parent));
          } catch {
            throw err;
          }
          for (const candidate of tsResolutionCandidates(target)) {
            if (!isFile(candidate)) continue;
            // realpath: since guarantee and explicit .ts import same URL(the same module instance), again intercept
            // symlink points to outside choose (exceeds do not transpile, never outside source code edit enter transpile scope)
            let real: string;
            try {
              real = realpathSync(candidate);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === 'ENOENT' || code === 'ENOTDIR') continue;
              throw error;
            }
            if (!isInsideAnyRoot(pathToFileURL(real).href)) {
              throw rootEscapeError(specifier, candidate, real);
            }
              return settle(pathToFileURL(real).href);
          }
          throw err;
        }
        // after continue hook (such as development phase tsx) may already in nextResolve inside complete .js -> .ts mapping:
        // .js family note symbol TS extend result one rule by this load policy re-check (realpath + inside),
        // guarantee and self shoot fall back the same opening path (identity specification + exceeds reject do not because mapping source while different)
        const resolvedUrl = resolved.url;
        if (
          typeof resolvedUrl === 'string' &&
          resolvedUrl.startsWith('file:') &&
          JS_FAMILY_EXTENSIONS.has(specifierExtension(specifier)) &&
          TS_SOURCE_EXTENSIONS.has(fileExtension(resolvedUrl))
        ) {
          let real: string;
          try {
            real = realpathSync(fileURLToPath(resolvedUrl));
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') return resolved;
            throw error;
          }
          if (!isInsideAnyRoot(pathToFileURL(real).href)) {
            throw rootEscapeError(specifier, resolvedUrl, real);
          }
          return settle(pathToFileURL(real).href);
        }
        // common rule parse result (contains each other for .json / outside legal target): inside file patch complete proxy boundary mark record
        //(Node each other for URL parse will discard parent query, guard against defend re- additional).
        if (
          parentGeneration !== undefined &&
          typeof resolvedUrl === 'string' &&
          resolvedUrl.startsWith('file:') &&
          generationOfUrl(resolvedUrl) === undefined
        ) {
          return settle(resolvedUrl);
        }
        return resolved;
      }
      // host public package: use host itself parse location, guarantee and host the same module instance (does not double bundle).
      // limit set @helm/*(this warehouse public contract package); other bare note symbol one rule by plugin directory original generate parse.
      if (specifier.startsWith('@helm/')) {
        try {
          const url = hostMetaResolve(specifier);
          if (typeof url === 'string' && url.startsWith('file:')) {
            return { url, shortCircuit: true };
          }
        } catch {
          // host side also not installed (such as @helm/web only frontend available): to under way by plugin directory original generate parse,
          // still failed then such as throw Node original generate ERR_MODULE_NOT_FOUND
        }
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!isInsideAnyRoot(url)) {
        return nextLoad(url, context);
      }
      // extension by remove query real path compute (proxy boundary URL carry ?helmgen=N mark record).
      const ext = fileExtension(fileURLToPath(url));
      // plugin inside each other for .json:esbuild transpile will strip import attributes(source file write also will by strip),
      // by host in load boundary patch note type=json, plugin source `import x from './x.json'` directly available.
      if (ext === '.json') {
        return nextLoad(url, {
          ...context,
          importAttributes: { ...context.importAttributes, type: 'json' },
        });
      }
      if (!TS_SOURCE_EXTENSIONS.has(ext)) {
        return nextLoad(url, context);
      }
      const file = fileURLToPath(url);
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch (err) {
        // read source failed (permission / race delete): such as throw Node original generate error, not silently skip
        throw err;
      }
      // transpile function by build port inject (by store): missing when explicit reject, never fall back inside placement transpile.
      const transform = transformOfRoot(url);
      if (transform === undefined) {
        throw new HelmError(
          'unsupported_backend_ts_build',
          `host not inject plugin build port (PluginHostOptions.buildProvider.transformBackendTs): cannot transpile external plugin TS source ${file}`,
          501,
          { file },
        );
      }
      let code: string;
      try {
        code = transform({
          source,
          file,
          kind: ext === '.tsx' ? 'tsx' : 'ts',
        });
      } catch (err) {
        if (err instanceof HelmError) throw err;
        throw transpileError(file, err);
      }
      return { format: 'module', source: code, shortCircuit: true };
    },
  });
}

/**  esbuild transpile failed wrap into carries file and row column locate explicit HelmError(never static default swallow wrong). */
function transpileError(file: string, err: unknown): HelmError {
  const first = (err as { errors?: Array<{ text?: string; location?: { line: number; column: number } }> }).errors?.[0];
  const location = first?.location;
  const position = location ? `${location.line}:${location.column}` : '';
  const detail = first?.text ?? (err instanceof Error ? err.message : String(err));
  return new HelmError(
    'plugin_load_failed',
    `external plugin source code transpile failed: ${file}${position ? `:${position}` : ''}(${detail})`,
    500,
    { file, line: location?.line, column: location?.column, detail },
  );
}

/**
 * is plugin directory enable backend TS transpile (reference counter; the same directory duplicate register merge, hook lazy register).
 * options.transform is the transpile function (PluginBuildProvider.transformBackendTs,
 * by external plugin load chain from host build port pass-through); duplicate register when explicit provide transform override
 * old value, not provide when keep since has value (same process the same pure function semantics).
 * return release function: counter reset to zero when directory move out transpile scope and deregister process hook (only reverse register
 * this load hook instance, does not affect host process inside other hooks).
 */
export function registerPluginTsRoot(
  rootDir: string,
  options: { transform?: BackendTsTransformFn } = {},
): () => void {
  const root = realpathSync(rootDir);
  const entry = rootRefCounts.get(root);
  if (entry === undefined) {
    rootRefCounts.set(root, { count: 1, transform: options.transform });
    ensureHooks();
  } else {
    entry.count += 1;
    if (options.transform !== undefined) entry.transform = options.transform;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = rootRefCounts.get(root);
    if (current === undefined) return;
    if (current.count <= 1) {
      rootRefCounts.delete(root);
      if (rootRefCounts.size === 0 && hooks !== undefined) {
        hooks.deregister();
        hooks = undefined;
      }
    } else {
      current.count -= 1;
    }
  };
}
