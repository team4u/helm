/**
 * Backend plugin TypeScript module loader (`external-loader` transpilation foundation).
 *
 * - Transpiles `.ts`/`.tsx`/`.mts`/`.cts` source files inside registered plugin roots (via realpath)
 *   using Node `module.registerHooks` + the host build port's `transformBackendTs`;
 * - Preserves real source URLs so `import.meta.url` points to real files, and ESM cache keeps
 *   `@helmx/*` singleton identity consistent with the host;
 * - Resolves TS-style relative imports (`.js -> .ts/.tsx`, extensionless -> `.ts/.tsx/index.ts`)
 *   and patches ESM `.json` imports with `type: 'json'`;
 * - Rejects symlink/relative escapes outside registered roots;
 * - Fails explicitly (`501 unsupported_backend_ts_build`) when no transpiler is injected.
 */
import { registerHooks, type ModuleHooks } from 'node:module';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HelmxError, type PluginBuildProvider } from '@helmx/protocol';

/** Transpilation function signature (`PluginBuildProvider.transformBackendTs`). */
export type BackendTsTransformFn = PluginBuildProvider['transformBackendTs'];

/** Supported TypeScript source extensions (`.cts` output is still loaded as ESM for a uniform module model). */
const TS_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** JS-family extensions natively recognized by Node (TS-style relative import sources). */
const JS_FAMILY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/** Registered plugin root directory (`realpath`): reference count and root-specific transpiler injected via the build port. */
interface TsRootEntry {
  count: number;
  transform?: BackendTsTransformFn;
}

const rootRefCounts = new Map<string, TsRootEntry>();

/**
 * Module generation counter (for controlled hot reload): root `realpath` -> next generation number.
 * On reload, appending `?helmxgen=<n>` to the entry URL makes Node's ESM cache re-initialize the
 * plugin module graph under a fresh URL; the `resolve` hook propagates this tag across relative
 * imports within the plugin root, while bare specifiers (`@helmx/*`, npm packages, `node:` builtins)
 * resolve normally without the tag and stay shared with the host—isolating generation reloads
 * strictly inside the plugin root.
 */
const rootGenerations = new Map<string, number>();

/** Reserved generation query parameter prefix (excluding `=` and value). */
const GENERATION_QUERY_PREFIX = 'helmxgen=';

/**
 * Extracts the `helmxgen` generation number from a URL (or `undefined` when absent).
 * Only appears along propagated relative-import chains inside a plugin root, seeded by reload/doctor.
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

/** Appends a `helmxgen` generation tag to a file URL unless one is already present. */
function withGenerationQuery(url: string, generation: number): string {
  if (generationOfUrl(url) !== undefined) return url;
  return `${url}?${GENERATION_QUERY_PREFIX}${generation}`;
}

/**
 * Reserves and returns the next monotonically increasing generation number for a plugin root.
 * Callers (`doctor` / `reload`) attach `?helmxgen=<n>` to the entry URL so a new module graph
 * initializes independently while previous generation modules remain usable in the ESM cache
 * and bare-specifier dependencies stay shared with the host.
 */
export function nextPluginGeneration(rootDir: string): number {
  const root = realpathSync(rootDir);
  const next = (rootGenerations.get(root) ?? 0) + 1;
  rootGenerations.set(root, next);
  return next;
}

/** Lazily registered Node module hooks instance; deregistered once all roots are released. */
let hooks: ModuleHooks | undefined;

/** Host-side package resolver: captures this module's `import.meta.resolve` pointing at the kernel workspace. */
const hostMetaResolve = import.meta.resolve;

/** Returns true if `target` (lexical or real path) lies within `root` (cross-platform via `relative` + `sep`). */
function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Returns true if `url` falls under any registered plugin root (registered by `realpath`; symlinks resolved at `resolve`). */
function isInsideAnyRoot(url: string): boolean {
  return rootOfUrl(url) !== undefined;
}

/** Returns the registered root containing `url`, or `undefined` if outside all roots. */
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

/** Returns the transpiler registered for `url`'s root (or `undefined` when unwired; `load` rejects explicitly). */
function transformOfRoot(url: string): BackendTsTransformFn | undefined {
  const root = rootOfUrl(url);
  return root === undefined ? undefined : rootRefCounts.get(root)?.transform;
}

function fileExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

/** Returns the extension of a specifier (stripping query/fragment; handles bare package names and subpaths uniformly). */
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
function rootEscapeError(specifier: string, candidate: string, real: string): HelmxError {
  return new HelmxError(
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
        // isolated module graph, while leaving bare specifiers (@helmx/* / npm / node:) shared.
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
      // Host shared contract packages (`@helmx/*`): resolve from host so plugins share singletons without double bundling.
      if (specifier.startsWith('@helmx/')) {
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
      // Compute extension from the path without query parameters (generation URLs carry `?helmxgen=N`).
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
        throw new HelmxError(
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
        if (err instanceof HelmxError) throw err;
        throw transpileError(file, err);
      }
      return { format: 'module', source: code, shortCircuit: true };
    },
  });
}

/** Wraps an esbuild transpilation failure with file and line/column diagnostics. */
function transpileError(file: string, err: unknown): HelmxError {
  const first = (err as { errors?: Array<{ text?: string; location?: { line: number; column: number } }> }).errors?.[0];
  const location = first?.location;
  const position = location ? `${location.line}:${location.column}` : '';
  const detail = first?.text ?? (err instanceof Error ? err.message : String(err));
  return new HelmxError(
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
