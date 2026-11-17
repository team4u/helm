/**
 * Backend plugin TypeScript module loader (`external-loader` transpilation foundation).
 *
 * - Transpiles `.ts`/`.tsx`/`.mts`/`.cts` source files inside registered plugin roots (via realpath)
 *   using Node `module.registerHooks` + the host build port's `transformBackendTs`;
 * - Preserves real source URLs so `import.meta.url` points to real files, and ESM cache keeps
 *   `@helm/*` singleton identity consistent with the host;
 * - Resolves TS-style relative imports (`.js -> .ts/.tsx`, extensionless -> `.ts/.tsx/index.ts`)
 *   and patches ESM `.json` imports with `type: 'json'`;
 * - Rejects symlink/relative escapes outside registered roots (`reject transpile`);
 * - Fails explicitly (`501 unsupported_backend_ts_build`) when no transpiler is injected.
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
 * When a relative specifier fails standard ESM resolution (ERR_MODULE_NOT_FOUND),
 * probe TypeScript candidate extensions matching tsc `--module nodenext` conventions.
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

/** Reject `.js`-style specifiers that resolve to TypeScript sources outside the plugin root. */
function rootEscapeError(specifier: string, candidate: string, real: string): HelmError {
  return new HelmError(
    'plugin_load_failed',
    `external plugin relative dependency ${specifier} resolved to TypeScript source outside plugin directory ${candidate} (real path ${real}), reject transpile; if an external module is truly required, reference its actual extension explicitly`,
    500,
    { specifier, candidate, real },
  );
}

/** Register process-wide Node module hooks (idempotent). */
function ensureHooks(): void {
  if (hooks !== undefined) return;
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (parent === undefined || !isInsideAnyRoot(parent)) {
        return nextResolve(specifier, context);
      }
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        // Propagate generation tag from parent across internal relative imports so reloads get a fresh
        // isolated module graph, while leaving bare specifiers (@helm/* / npm / node:) shared.
        const parentGeneration = generationOfUrl(parent);
        /** Append generation tag only to URLs inside plugin roots so shared modules are not duplicated. */
        const settle = (url: string): { url: string; shortCircuit?: boolean } =>
          parentGeneration === undefined || !isInsideAnyRoot(url)
            ? { url }
            : { url: withGenerationQuery(url, parentGeneration), shortCircuit: true };
        let resolved: { url: string; shortCircuit?: boolean };
        try {
          resolved = nextResolve(specifier, context);
        } catch (err) {
          // Only probe TS candidates on ERR_MODULE_NOT_FOUND; preserve permission and other errors.
          if ((err as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw err;
          let target: string;
          try {
            target = fileURLToPath(new URL(specifier, parent));
          } catch {
            throw err;
          }
          for (const candidate of tsResolutionCandidates(target)) {
            if (!isFile(candidate)) continue;
            // Resolve symlinks to deduplicate URLs and reject targets escaping the plugin directory.
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
        // Re-check `.js -> .ts` resolutions handled by downstream hooks (such as tsx) for realpath containment.
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
        // For regular resolutions (e.g. relative .json or valid external targets), re-attach generation if inside root
        // because Node's URL resolution drops the parent query string.
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
      // Host shared contract packages (`@helm/*`): resolve from host so plugins share singletons without double bundling.
      if (specifier.startsWith('@helm/')) {
        try {
          const url = hostMetaResolve(specifier);
          if (typeof url === 'string' && url.startsWith('file:')) {
            return { url, shortCircuit: true };
          }
        } catch {
          // If unavailable on host (e.g. frontend-only packages), fall through to plugin directory resolution.
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
      // Rewrite relative `.json` imports to include `type: 'json'` since esbuild strips ESM import attributes.
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
        // Propagate source read failures (permissions / deleted race) directly.
        throw err;
      }
      // Transpiler must be injected by the build port; never silently fall back.
      const transform = transformOfRoot(url);
      if (transform === undefined) {
        throw new HelmError(
          'unsupported_backend_ts_build',
          `Host has not wired plugin build port (PluginHostOptions.buildProvider.transformBackendTs): cannot transpile external plugin TS source ${file}`,
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

/** Wraps an esbuild transpilation failure with file and line/column diagnostics. */
function transpileError(file: string, err: unknown): HelmError {
  const first = (err as { errors?: Array<{ text?: string; location?: { line: number; column: number } }> }).errors?.[0];
  const location = first?.location;
  const position = location ? `${location.line}:${location.column}` : '';
  const detail = first?.text ?? (err instanceof Error ? err.message : String(err));
  return new HelmError(
    'plugin_load_failed',
    `External plugin TypeScript transpilation failed: ${file}${position ? `:${position}` : ''} (${detail})`,
    500,
    { file, line: location?.line, column: location?.column, detail },
  );
}

/**
 * Registers a plugin directory root for backend TypeScript transpilation (reference-counted, lazy hooks).
 * Returns a release callback that unregisters the loader hooks when the last root is released.
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
