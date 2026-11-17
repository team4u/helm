/**
 * PluginClientCompiler: host-side compiler for the `client.tsx` UI track (`@helm/plugin-build`).
 *
 * Implements `PluginBuildProvider.compileClientModule`, injected into the kernel `PluginHost` by the
 * product composition root (`@helm/hub`); the kernel itself stays independent of esbuild.
 *
 * Responsibilities (pure mechanism):
 * - Compiles relative `.ts`/`.tsx` entrypoints under `clientRoot` into browser ESM (esbuild bundle + metafile);
 * - Tracks local and controlled-npm closures via esbuild metafile inputs (`export * from`, dynamic imports,
 *   `.js`, `.json`, `.css`), re-checking per-file sha256 on disk so unchanged sources reuse cached artifacts;
 * - Virtualizes host-shared dependencies (`react`, `react-dom`, `lucide-react`, `@helm/plugin-client`) via
 *   `module.exports = globalThis.__helm_shared_*` shims so esbuild emits valid ESM bindings across default,
 *   named, namespace, aliased, and re-exported forms without bundling a second copy of React;
 * - Bundles local CSS via esbuild (virtual outfile with `write: false`), exporting merged CSS via the
 *   reserved export `__helmClientCss` (`PLUGIN_CLIENT_CSS_EXPORT`) without touching the DOM;
 *   - CSS `url()` allows only `data:`, `http(s)://`, and protocol-relative `//` URLs (local relative,
 *     root-relative, and fragment URLs are explicitly rejected with a `data:` suggestion);
 *   - Remote `@import` is explicitly rejected; local `@import` enters the dependency closure and hash;
 * - Enforces realpath containment on every loaded file inside `clientRoot` or authorized controlled-npm
 *   package directories, rejecting undeclared bare specifiers explicitly;
 * - Writes artifacts atomically (`randomUUID` temp file + rename) and deduplicates concurrent compiles
 *   for the same key. Compilation failures throw explicit `HelmError`s with diagnostics.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, dirname, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  HelmError,
  PLUGIN_CLIENT_CSS_EXPORT,
  assertModuleRefShape,
  isAbsoluteTargetPath,
  type PluginClientBundle,
  type PluginClientNpmRoot,
} from '@helm/protocol';
import { build, type Plugin as EsbuildPlugin } from 'esbuild';
import {
  collectDynamicImportTargets,
  collectStaticImportClosure,
  computeAsyncChunkPlan,
} from './client-chunk-graph.js';

/**
 * Host-shared browser runtime dependencies: resolved at compile time to virtual shims (never reading
 * plugin `node_modules`) and backed at runtime by `globalThis.__helm_shared_*`.
 */
export const CLIENT_SHARED_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'lucide-react',
  '@helm/plugin-client',
] as const;

/** Mapping from shared specifier to host global property name (mounted by host page or test harness). */
export const CLIENT_SHARED_GLOBALS: Readonly<Record<string, string>> = Object.freeze({
  react: '__helm_shared_react',
  'react-dom': '__helm_shared_react_dom',
  'react-dom/client': '__helm_shared_react_dom_client',
  'react/jsx-runtime': '__helm_shared_react_jsx_runtime',
  'lucide-react': '__helm_shared_lucide_react',
  '@helm/plugin-client': '__helm_shared_plugin_client',
});

/**
 * Dependency manifest (`deps.json`) schema version:
 * v3: native esbuild CSS bundling; v4: controlled npm dependencies; v5: minify + pre-gzip;
 * v6: code splitting + async chunk bridge; v7: isolated `__helm_chunk_share` namespace bridge;
 * v8: controlled npm declaration set recorded in cache credentials.
 */
const DEPS_LIST_VERSION = 8;

/** Compiled bundle type alias (re-exported for tools and tests). */
export type ClientCompileResult = PluginClientBundle;

// ---------------------------------------------------------------------------
// Concurrency deduplication: identical in-flight keys share one Promise
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<ClientCompileResult>>();

interface MemoryCompiledEntry {
  result: ClientCompileResult;
  /** Local dependency mtime snapshot (keyed by absolute path inside `clientRoot`). */
  localMtimes: Map<string, number>;
  /** Controlled npm stat fingerprint (`path -> { mtimeMs, size }`): triggers disk sha256 re-check on change. */
  npmStats?: Map<string, { mtimeMs: number; size: number }>;
  root: string;
}

const memoryCompiledCache = new Map<string, MemoryCompiledEntry>();

export function clearClientCompilerMemoryCache(): void {
  memoryCompiledCache.clear();
}

/**
 * Reads a cached async/shared chunk and its optional `.gz` bytes from `stagingDir`.
 */
export function readCachedChunk(
  stagingDir: string,
  baseName: string,
  contentHash: string,
  chunkName: string,
): { code: string; gzipped?: Uint8Array } | undefined {
  const chunkPath = join(stagingDir, `${baseName}.${contentHash}.chunk.${chunkName}`);
  if (!existsSync(chunkPath)) return undefined;
  try {
    const code = readFileSync(chunkPath, 'utf8');
    let gzipped: Uint8Array | undefined;
    const gzPath = join(stagingDir, `${baseName}.${contentHash}.chunk.${chunkName}.gz`);
    if (existsSync(gzPath)) {
      try {
        gzipped = readFileSync(gzPath);
      } catch {
        /* ignore pre-compressed read failure; caller can compress on demand */
      }
    }
    return { code, gzipped };
  } catch {
    return undefined;
  }
}

/**
 * Compiles a plugin client module into browser ESM (concurrency-safe and content-hash cached).
 *
 * @param pluginId Plugin ID (isolates cache directory under `<cacheDir>/plugin-staging/`)
 * @param clientRoot Declared and validated absolute source root directory
 * @param moduleRef Relative entrypoint path inside `clientRoot` (validated by `assertModuleRefShape`)
 * @param cacheDir Host cache root (`plugin-staging/<pluginId>/` stores bundles and `deps.json`)
 */
export async function compilePluginClientModule(
  pluginId: string,
  clientRoot: string,
  moduleRef: string,
  cacheDir: string,
  options?: { npmRoots?: ReadonlyArray<ClientNpmRoot> },
): Promise<ClientCompileResult> {
  assertModuleRefShape(pluginId, moduleRef);
  const npmKey = npmRootsKey(options?.npmRoots ?? []);
  const key = `${pluginId}\0${moduleRef}\0${realPathOrThrow(clientRoot, `plugin ${pluginId} clientRoot cannot be accessed: ${clientRoot}`)}\0${npmKey}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = compileUncached(pluginId, clientRoot, moduleRef, cacheDir, options?.npmRoots ?? []).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

/** Disk dependency manifest (`deps.json`) used to revalidate cache entries across restarts. */
interface DepsListFile {
  version: typeof DEPS_LIST_VERSION;
  module: string;
  /** Canonical `clientRoot` realpath (invalidates stale cache if moved/re-rooted). */
  root: string;
  contentHash: string;
  /** Local dependencies relative to `root` with content sha256 (includes entry). */
  dependencies: Array<{ path: string; sha256: string }>;
  /** Controlled npm dependency files with absolute realpath and content sha256. */
  npmDependencies?: Array<{ root: string; path: string; sha256: string }>;
  /** Declared controlled npm specifiers (prevents reusing stale bundles after removing declarations). */
  npmSpecifiers?: string[];
  /** Entry named exports (including `__helmClientCss` when CSS was bundled). */
  exports?: string[];
  /** Async/shared chunk filenames emitted alongside the entry. */
  chunks?: string[];
}

/** Controlled npm dependency resolution root (`PluginClientNpmRoot` alias). */
export type ClientNpmRoot = PluginClientNpmRoot;

function npmRootsKey(roots: ReadonlyArray<ClientNpmRoot>): string {
  return roots
    .map((root) => `${root.packageRoot}:${[...root.specifiers].sort().join(',')}`)
    .sort()
    .join(';');
}

function npmSpecifiersKey(roots: ReadonlyArray<ClientNpmRoot>): string[] {
  return roots.flatMap((root) => root.specifiers.map((specifier) => `${root.packageRoot}\0${specifier}`)).sort();
}

async function compileUncached(
  pluginId: string,
  clientRoot: string,
  moduleRef: string,
  cacheDir: string,
  npmRoots: ReadonlyArray<ClientNpmRoot> = [],
): Promise<ClientCompileResult> {
  const rootReal = realPathOrThrow(
    clientRoot,
    `plugin ${pluginId} clientRoot is missing or inaccessible: ${clientRoot}`,
  );
  const entryReal = assertEntryInsideRoot(pluginId, rootReal, moduleRef);

  // 1. In-memory fast path: check local file mtimes and controlled-npm (mtime, size) fingerprints;
  //    any change falls through to full disk sha256 re-verification before recompiling.
  const npmKey = npmRootsKey(npmRoots);
  const memKey = `${pluginId}\0${moduleRef}\0${rootReal}\0${npmKey}`;
  const memEntry = memoryCompiledCache.get(memKey);
  if (memEntry && memEntry.root === rootReal) {
    let fresh = true;
    for (const [abs, mtime] of memEntry.localMtimes) {
      try {
        if (statSync(abs).mtimeMs !== mtime) {
          fresh = false;
          break;
        }
      } catch {
        fresh = false;
        break;
      }
    }
    if (fresh) {
      const npmStats = memEntry.npmStats ?? new Map();
      for (const [path, st] of npmStats) {
        try {
          const cur = statSync(path);
          if (cur.mtimeMs !== st.mtimeMs || cur.size !== st.size) {
            fresh = false;
            break;
          }
        } catch {
          fresh = false;
          break;
        }
      }
    }
    if (fresh) {
      return memEntry.result;
    }
    memoryCompiledCache.delete(memKey);
  }

  const stagingDir = join(cacheDir, 'plugin-staging', safeDirName(pluginId));
  const baseName = safeFileName(moduleRef);
  const depsListPath = join(stagingDir, `${baseName}.deps.json`);

  // 2. Disk cache revalidation: reuse artifact only when manifest and every dependency sha256 match.
  const cached = readCachedResult(stagingDir, depsListPath, rootReal, moduleRef, pluginId, npmRoots);
  if (cached) {
    recordMemoryCache(memKey, rootReal, depsListPath, cached);
    return cached;
  }

  // Pass 1: in-memory esbuild with code splitting enabled to inspect module graph and CSS.
  let pass1Result: Awaited<ReturnType<typeof build>>;
  try {
    pass1Result = await build({
      entryPoints: [entryReal],
      bundle: true,
      splitting: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      jsx: 'automatic',
      write: false,
      sourcemap: false,
      metafile: true,
      absWorkingDir: rootReal,
      outdir: join(stagingDir, '__virtual_out__'),
      logLevel: 'silent',
      plugins: [
        sharedShimPlugin(),
        containmentPlugin(pluginId, rootReal, npmRoots),
        cssPolicyPlugin(pluginId),
      ],
    });
  } catch (err) {
    if (err instanceof HelmError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `plugin ${pluginId} compile ${moduleRef} failed: ${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  const pass1Metafile = pass1Result.metafile;
  const pass1OutputFiles = pass1Result.outputFiles;
  if (!pass1Metafile || !pass1OutputFiles) {
    throw new HelmError('client_compile_failed', `plugin ${pluginId} Pass 1 build produced no metafile or outputFiles`, 500);
  }

  // Guard the compiler-reserved CSS export name against accidental collision.
  if (Object.values(pass1Metafile.outputs).some((file) => file.exports?.includes(PLUGIN_CLIENT_CSS_EXPORT))) {
    throw new HelmError(
      'client_compile_failed',
      `plugin ${pluginId} module ${moduleRef} uses reserved compiler export name "${PLUGIN_CLIENT_CSS_EXPORT}"; please rename that export`,
      422,
      { pluginId, module: moduleRef, reservedExport: PLUGIN_CLIENT_CSS_EXPORT },
    );
  }

  const virtualFiles = new Map<string, string>();
  const metaByBase = new Map<string, (typeof pass1Metafile.outputs)[string]>();
  const cssFiles: string[] = [];

  for (const f of pass1OutputFiles) {
    const b = basename(f.path);
    if (b.endsWith('.css')) {
      cssFiles.push(f.text);
    } else if (b.endsWith('.js')) {
      virtualFiles.set(b, f.text);
    }
  }
  for (const [outPath, meta] of Object.entries(pass1Metafile.outputs)) {
    if (outPath.endsWith('.js')) {
      metaByBase.set(basename(outPath), meta);
    }
  }

  const css = cssFiles.join('\n');

  // Locate the entry output basename from Pass 1 metafile.
  const relEntry = relative(rootReal, entryReal);
  let entryBaseName = '';
  for (const [b, meta] of metaByBase) {
    if (meta.entryPoint && (meta.entryPoint === relEntry || meta.entryPoint === entryReal || meta.entryPoint.endsWith(moduleRef))) {
      entryBaseName = b;
      break;
    }
  }
  if (!entryBaseName) {
    if (virtualFiles.size === 1) {
      entryBaseName = virtualFiles.keys().next().value!;
    } else {
      throw new HelmError(
        'client_compile_failed',
        `plugin ${pluginId} compile ${moduleRef} could not uniquely locate entry JS output`,
        500,
        { pluginId, module: moduleRef },
      );
    }
  }

  const dependencies = collectLocalDependencies(pass1Metafile, rootReal);
  const npmDeps = collectNpmDependencies(pass1Metafile, rootReal, npmRoots);

  const baseClosure = collectStaticImportClosure(metaByBase, entryBaseName);
  const dynamicTargets = collectDynamicImportTargets(metaByBase, baseClosure);

  const jsMeta = metaByBase.get(entryBaseName);
  const entryExports = [...(jsMeta?.exports ?? []), ...(css.length > 0 ? [PLUGIN_CLIENT_CSS_EXPORT] : [])];

  // Fast path (no dynamic imports -> single self-contained entry bundle).
  if (dynamicTargets.size === 0) {
    let mainOutput = '';
    try {
      const pass2 = await build({
        stdin: {
          contents: virtualFiles.get(entryBaseName)!,
          loader: 'js',
          sourcefile: entryBaseName,
        },
        bundle: true,
        format: 'esm',
        target: 'es2022',
        platform: 'browser',
        write: false,
        sourcemap: false,
        minifyWhitespace: true,
        minifyIdentifiers: true,
        logLevel: 'silent',
        plugins: [
          {
            name: 'vfs-resolver',
            setup(b) {
              b.onResolve({ filter: /.*/ }, (args) => {
                const target = basename(args.path);
                return { path: target, namespace: 'vfs' };
              });
              b.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
                const c = virtualFiles.get(args.path);
                if (c === undefined) return { errors: [{ text: `Missing virtual file: ${args.path}` }] };
                return { contents: c, loader: 'js' };
              });
            },
          },
        ],
      });
      mainOutput = appendCssExport(pass2.outputFiles[0]!.text, css);
    } catch (err) {
      if (err instanceof HelmError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new HelmError('client_compile_failed', `plugin ${pluginId} compile ${moduleRef} convergence failed: ${message}`, 422, {
        pluginId,
        module: moduleRef,
      });
    }

    const list = buildDepsList(rootReal, moduleRef, dependencies, npmDeps, npmRoots, entryExports);
    mkdirSync(stagingDir, { recursive: true });
    atomicWrite(join(stagingDir, `${baseName}.${list.contentHash}.mjs`), mainOutput);
    let gzipped: Uint8Array | undefined;
    try {
      const gz = gzipSync(Buffer.from(mainOutput, 'utf8'));
      atomicWriteBuffer(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`), gz);
      gzipped = gz;
    } catch {
      /* on-demand gzip fallback remains available */
    }
    atomicWrite(depsListPath, `${JSON.stringify(list)}\n`);
    const finalResult: ClientCompileResult = {
      code: mainOutput,
      contentHash: list.contentHash,
      gzipped,
      exports: entryExports,
      chunks: {},
    };
    recordMemoryCache(memKey, rootReal, depsListPath, finalResult);
    return finalResult;
  }

  // Split path (dynamicTargets.size > 0): compute shared async chunks and prerequisite topology.
  const { sharedAsyncChunks, chunkDeps } = computeAsyncChunkPlan(metaByBase, baseClosure, dynamicTargets);

  const allUnits = new Set<string>([...sharedAsyncChunks, ...dynamicTargets]);
  const list = buildDepsList(rootReal, moduleRef, dependencies, npmDeps, npmRoots, entryExports, Array.from(allUnits));

  // Namespace bridge registration into `globalThis.__helm_chunk_share`:
  // Each shared virtual chunk is wrapped in `import * as ns` so esbuild retains all exports (including
  // default expressions, re-exports, and string-named exports) without regex code generation, keyed
  // strictly by `pluginId\0moduleRef\0contentHash\0file` so multiple plugins stay isolated.
  const chunkShareKeyExpr = (file: string): string =>
    JSON.stringify(`${pluginId}\0${moduleRef}\0${list.contentHash}\0${file}`);
  const filesToRegister = new Set<string>([...baseClosure, ...sharedAsyncChunks]);
  filesToRegister.delete(entryBaseName);
  const chunkNsBridges = new Map<string, string>();
  for (const F of filesToRegister) {
    if (!virtualFiles.has(F)) continue;
    const bridgeName = `__helm_ns__:${F}`;
    chunkNsBridges.set(F, bridgeName);
    virtualFiles.set(
      bridgeName,
      `import * as __helm_ns from ${JSON.stringify(`__helm_chunk__:${F}`)};\n` +
        `;(globalThis.__helm_chunk_share ??= {})[${chunkShareKeyExpr(F)}] = __helm_ns;\n`,
    );
  }

  // Pass 2 convergence: bundle the main entry (registering `baseClosure` namespaces) and every async unit.
  const baseRegisterFiles = [...baseClosure].filter((f) => f !== entryBaseName && virtualFiles.has(f));
  async function bundleUnit(unitName: string, isMain: boolean): Promise<string> {
    const isNsBridge = !isMain && sharedAsyncChunks.has(unitName);
    let unitCode = virtualFiles.get(isNsBridge ? chunkNsBridges.get(unitName)! : unitName);
    if (unitCode === undefined) {
      throw new HelmError('client_compile_failed', `Missing virtual file ${unitName}`, 500);
    }
    if (isMain && baseRegisterFiles.length > 0) {
      const regImports = baseRegisterFiles
        .map((f) => `import ${JSON.stringify(`__helm_ns__:${f}`)};`)
        .join('\n');
      unitCode = `${regImports}\n${unitCode}`;
    }
    const res = await build({
      stdin: {
        contents: unitCode,
        loader: 'js',
        sourcefile: unitName,
      },
      bundle: true,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      write: false,
      sourcemap: false,
      minifyWhitespace: true,
      minifyIdentifiers: true,
      minifySyntax: true,
      logLevel: 'silent',
      plugins: [
        {
          name: 'pass2-resolver',
          setup(b) {
            b.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === 'dynamic-import') {
                const target = basename(args.path);
                return { path: '__HELM_DYN_IMPORT__:' + target, external: true };
              }
              if (args.kind === 'import-statement') {
                // Namespace bridge target: resolves directly to the Pass 1 virtual chunk body.
                if (args.path.startsWith('__helm_chunk__:')) {
                  return { path: basename(args.path.slice('__helm_chunk__:'.length)), namespace: 'vfs' };
                }
                // Pre-registration bridge imported by the main bundle.
                if (args.path.startsWith('__helm_ns__:')) {
                  return { path: args.path, namespace: 'vfs' };
                }
                const target = basename(args.path);
                if (isMain) {
                  return { path: target, namespace: 'vfs' };
                } else {
                  if ((baseClosure.has(target) || sharedAsyncChunks.has(target)) && target !== unitName) {
                    return { path: target, namespace: 'proxy' };
                  }
                  return { path: target, namespace: 'vfs' };
                }
              }
              return null;
            });
            b.onLoad({ filter: /.*/, namespace: 'proxy' }, (args) => {
              const T = args.path;
              const meta = metaByBase.get(T);
              const exports = meta?.exports || [];
              const proxyLines = [
                `const __s = (globalThis.__helm_chunk_share ?? {})[${chunkShareKeyExpr(T)}] || {};`,
              ];
              for (const exp of exports) {
                if (exp === 'default') {
                  proxyLines.push('export default __s["default"];');
                } else {
                  proxyLines.push(`export const ${exp} = __s[${JSON.stringify(exp)}];`);
                }
              }
              if (exports.length === 0) {
                proxyLines.push('export {};');
              }
              return { contents: proxyLines.join('\n'), loader: 'js' };
            });
            b.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
              const content = virtualFiles.get(args.path);
              if (content === undefined) {
                return { errors: [{ text: `Missing virtual file: ${args.path}` }] };
              }
              return { contents: content, loader: 'js' };
            });
          },
        },
      ],
    });
    let out = res.outputFiles[0]!.text;
    out = out.replace(/import\s*\(\s*["'`]__HELM_DYN_IMPORT__:([^"'`]+)["'`]\s*\)/g, (_match, target) => {
      const deps = chunkDeps[target] ?? [];
      return `globalThis.__helm_import_chunk(${JSON.stringify(pluginId)}, ${JSON.stringify(moduleRef)}, ${JSON.stringify(list.contentHash)}, ${JSON.stringify(target)}, ${JSON.stringify(deps)})`;
    });
    return out;
  }

  let mainJs: string;
  try {
    mainJs = await bundleUnit(entryBaseName, true);
    mainJs = appendCssExport(mainJs, css);
  } catch (err) {
    if (err instanceof HelmError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `plugin ${pluginId} main bundle convergence failed for ${moduleRef}: ${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  const chunkOutputs: Record<string, { code: string; gzipped?: Uint8Array }> = {};
  try {
    await Promise.all(
      Array.from(allUnits).map(async (unitName) => {
        const code = await bundleUnit(unitName, false);
        let gzipped: Uint8Array | undefined;
        try {
          gzipped = gzipSync(Buffer.from(code, 'utf8'));
        } catch {
          /* ignore */
        }
        chunkOutputs[unitName] = { code, gzipped };
      }),
    );
  } catch (err) {
    if (err instanceof HelmError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `plugin ${pluginId} chunk convergence failed for ${moduleRef}: ${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  // Persist artifacts atomically and populate in-memory cache.
  mkdirSync(stagingDir, { recursive: true });
  atomicWrite(join(stagingDir, `${baseName}.${list.contentHash}.mjs`), mainJs);
  let gzipped: Uint8Array | undefined;
  try {
    const gz = gzipSync(Buffer.from(mainJs, 'utf8'));
    atomicWriteBuffer(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`), gz);
    gzipped = gz;
  } catch {
    /* ignore */
  }

  for (const [chunkName, chunkData] of Object.entries(chunkOutputs)) {
    atomicWrite(join(stagingDir, `${baseName}.${list.contentHash}.chunk.${chunkName}`), chunkData.code);
    if (chunkData.gzipped) {
      atomicWriteBuffer(join(stagingDir, `${baseName}.${list.contentHash}.chunk.${chunkName}.gz`), chunkData.gzipped);
    }
  }

  atomicWrite(depsListPath, `${JSON.stringify(list)}\n`);

  const finalResult: ClientCompileResult = {
    code: mainJs,
    contentHash: list.contentHash,
    gzipped,
    exports: entryExports,
    chunks: chunkOutputs,
  };
  recordMemoryCache(memKey, rootReal, depsListPath, finalResult);
  return finalResult;
}

function recordMemoryCache(
  memKey: string,
  rootReal: string,
  depsListPath: string,
  result: ClientCompileResult,
): void {
  try {
    const list = JSON.parse(readFileSync(depsListPath, 'utf8')) as DepsListFile;
    const localMtimes = new Map<string, number>();
    for (const dep of list.dependencies) {
      const abs = join(rootReal, dep.path);
      try {
        localMtimes.set(abs, statSync(abs).mtimeMs);
      } catch {
        /* ignore */
      }
    }
    const npmStats = new Map<string, { mtimeMs: number; size: number }>();
    for (const dep of list.npmDependencies ?? []) {
      try {
        const st = statSync(dep.path);
        npmStats.set(dep.path, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* missing file: omit stat so disk manifest check triggers recompile */
      }
    }
    memoryCompiledCache.set(memKey, {
      result,
      localMtimes,
      ...(npmStats.size > 0 ? { npmStats } : {}),
      root: rootReal,
    });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// CSS: exported via reserved named binding (DOM injection owned by the loader)
// ---------------------------------------------------------------------------

/** Picks a non-colliding local identifier before exporting the merged CSS via `__helmClientCss`. */
function appendCssExport(js: string, css: string): string {
  if (css.length === 0) return js;
  let binding = '__helmCssText';
  while (js.includes(binding)) binding += '_';
  return `${js}\nconst ${binding} = ${JSON.stringify(css)};\nexport { ${binding} as ${PLUGIN_CLIENT_CSS_EXPORT} };\n`;
}

// ---------------------------------------------------------------------------
// Shared host-dependency shims
// ---------------------------------------------------------------------------

/**
 * Resolves host-shared bare specifiers to virtual `helm-shared` modules backed by
 * `module.exports = globalThis.__helm_shared_*`, delegating CJS/ESM interop to esbuild.
 */
function sharedShimPlugin(): EsbuildPlugin {
  return {
    name: 'helm-shared-shim',
    setup(b) {
      for (const spec of CLIENT_SHARED_EXTERNALS) {
        b.onResolve({ filter: exactLiteralFilter(spec) }, () => ({
          path: spec,
          namespace: 'helm-shared',
        }));
      }
      b.onLoad({ filter: /.*/, namespace: 'helm-shared' }, (args) => {
        const globalName = CLIENT_SHARED_GLOBALS[args.path];
        if (globalName === undefined) {
          return { errors: [{ text: `unknown shared dependency specifier: ${args.path}` }] };
        }
        return {
          contents: `module.exports = (globalThis.${globalName});`,
          loader: 'js',
        };
      });
    },
  };
}

function exactLiteralFilter(spec: string): RegExp {
  return new RegExp(`^${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

// ---------------------------------------------------------------------------
// Containment & controlled npm dependency resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a declared controlled npm specifier from its authorized `packageRoot/node_modules`.
 * Subpath specifiers must be declared explicitly; returns `null` when undeclared or unresolvable.
 */
function resolveNpmSpecifier(
  spec: string,
  npmRoots: ReadonlyArray<ClientNpmRoot>,
): { path: string; pkgDir: string } | null {
  for (const root of npmRoots) {
    if (!root.specifiers.includes(spec)) continue;
    const nmReal = realpathOrNull(join(root.packageRoot, 'node_modules'));
    if (nmReal === null) continue;
    const { pkg, sub } = splitNpmSpecifier(spec);
    const pkgReal = realpathOrNull(join(nmReal, pkg));
    if (pkgReal === null) continue;
    const entry = resolveNpmPackageEntry(pkgReal, sub === '' ? pkg : `${pkg}/${sub}`);
    if (entry === null) continue;
    return { path: entry, pkgDir: pkgReal };
  }
  return null;
}

function splitNpmSpecifier(spec: string): { pkg: string; sub: string } {
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return { pkg: parts.slice(0, 2).join('/'), sub: parts.slice(2).join('/') };
  }
  return { pkg: parts[0] ?? spec, sub: parts.slice(1).join('/') };
}

function resolveNpmPackageEntry(pkgDir: string, spec: string): string | null {
  const pkgJsonPath = join(pkgDir, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const { sub } = splitNpmSpecifier(spec);
  const exportKey = sub === '' ? '.' : `./${sub}`;
  const candidates: string[] = [];
  const exp = pkg['exports'];
  if (exp !== null && typeof exp === 'object' && !Array.isArray(exp)) {
    const entry = (exp as Record<string, unknown>)[exportKey];
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const readCond = (value: unknown): string | null => {
        if (typeof value === 'string') return value;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const inner = (value as Record<string, unknown>)['default'];
          return typeof inner === 'string' ? inner : null;
        }
        return null;
      };
      const fromImport = readCond((entry as Record<string, unknown>)['import']);
      const fromDefault = readCond((entry as Record<string, unknown>)['default']);
      if (fromImport !== null) candidates.push(fromImport);
      if (fromDefault !== null) candidates.push(fromDefault);
    } else if (typeof entry === 'string') {
      candidates.push(entry);
    }
  }
  if (sub === '') {
    if (typeof pkg['module'] === 'string') candidates.push(pkg['module']);
    if (typeof pkg['main'] === 'string') candidates.push(pkg['main']);
  } else {
    candidates.push(`./${sub}`);
  }
  for (const rel of candidates) {
    if (typeof rel !== 'string' || rel === '') continue;
    const abs = rel.startsWith('./') ? join(pkgDir, rel.slice(2)) : join(pkgDir, rel);
    const real = realpathOrNull(abs);
    if (real !== null && existsSync(real)) return real;
  }
  return null;
}

/**
 * Enforces `clientRoot` and controlled-npm realpath containment at resolve and load time.
 */
function containmentPlugin(
  pluginId: string,
  rootReal: string,
  npmRoots: ReadonlyArray<ClientNpmRoot> = [],
): EsbuildPlugin {
  const authorizedNpmDirs = new Set<string>();
  const authorizeNpmPackageDir = (pkgDir: string): string | null => {
    const real = realpathOrNull(pkgDir);
    if (real === null) return null;
    authorizedNpmDirs.add(real);
    return real;
  };
  const isNpmAuthorized = (realPath: string): boolean => {
    for (const dir of authorizedNpmDirs) {
      if (isInside(dir, realPath)) return true;
    }
    return false;
  };
  return {
    name: 'helm-containment',
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (isAbsoluteTargetPath(args.path)) return null;
        if (args.kind === 'url-token' || args.kind === 'import-rule') return null;
        if ((CLIENT_SHARED_EXTERNALS as readonly string[]).includes(args.path)) return null;
        const npm = resolveNpmSpecifier(args.path, npmRoots);
        if (npm !== null) {
          authorizeNpmPackageDir(npm.pkgDir);
          return { path: npm.path };
        }
        const declaredRoot = npmRoots.find((r) => r.specifiers.includes(args.path));
        if (declaredRoot !== undefined) {
          return {
            errors: [{
              text:
                `plugin ${pluginId} cannot parse declared frontend dependency "${args.path}" inside ${join(declaredRoot.packageRoot, 'node_modules')} ` +
                '(dependency not installed or package entry missing); install this dependency in the plugin directory and retry (managed installs add it automatically during install/update)',
            }],
          };
        }
        if (args.importer !== '') {
          const importerReal = realpathOrNull(args.importer);
          if (importerReal !== null && isNpmAuthorized(importerReal)) {
            return null;
          }
        }
        const importer = args.importer || 'entry';
        return {
          errors: [{
            text:
              `plugin ${pluginId} must reject bare dependency "${args.path}" (imported by ${importer}): ` +
              `undeclared controlled npm dependency; clientRoot only permits relative imports, shared dependencies (${CLIENT_SHARED_EXTERNALS.join(', ')}), and declared npm specifiers`,
          }],
        };
      });
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        const importerReal = realpathOrNull(args.importer);
        if (importerReal !== null && isNpmAuthorized(importerReal)) return null;
        const candidate = realpathOrNull(resolve(args.resolveDir, args.path));
        if (candidate === null || isInside(rootReal, candidate) || isNpmAuthorized(candidate)) return null;
        return {
          errors: [{
            text: `plugin ${pluginId} rejected out of bounds relative import (escapes root via ../ or points to an undeclared npm file): ${candidate}`,
          }],
        };
      });
      b.onLoad({ filter: /.*/ }, (args) => {
        if (args.namespace !== 'file') return null;
        if (!/\.[cm]?[jt]sx?$|\.json$|\.css$/.test(args.path)) return null;
        const real = realpathOrNull(args.path);
        if (real === null) return null;
        const inClientRoot = isInside(rootReal, real);
        const inNpmRoot = isNpmAuthorized(real);
        if (!inClientRoot && !inNpmRoot) {
          if (real.includes(sep + 'node_modules' + sep)) {
            const pkgDir = findPackageDirOf(real);
            if (pkgDir !== null) {
              authorizeNpmPackageDir(pkgDir);
              return null;
            }
          }
          return {
            errors: [{
              text: `plugin ${pluginId} rejected out of bounds file (escapes root via ../, symlink escape, or undeclared npm resolution): ${real}`,
            }],
          };
        }
        return null;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CSS asset policy (driven by esbuild resolver kind)
// ---------------------------------------------------------------------------

function isAllowedCssAssetUrl(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (url.length === 0) return true;
  if (/^data:/i.test(url)) return true;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith('//')) return true;
  return false;
}

function findPackageDirOf(fileReal: string): string {
  let dir = dirname(fileReal);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return fileReal;
    dir = parent;
  }
}

function cssPolicyPlugin(pluginId: string): EsbuildPlugin {
  return {
    name: 'helm-css-policy',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'url-token') {
          if (isAllowedCssAssetUrl(args.path)) return null;
          return {
            errors: [{
              text:
                `plugin ${pluginId} stylesheet ${args.importer} asset reference "${args.path}" was rejected: ` +
                'local relative, root-relative, or fragment URLs resolve against the wrong host page base URL (plugins have no static asset endpoint); ' +
                'use an inline data: URL or an explicit https:// absolute URL instead',
            }],
          };
        }
        if (args.kind === 'import-rule') {
          if (/^(https?:)?\/\//i.test(args.path)) {
            return {
              errors: [{
                text:
                  `plugin ${pluginId} stylesheet ${args.importer} remote @import "${args.path}" was rejected: ` +
                  'remote stylesheets are outside local dependency validation and cache management; copy the stylesheet into clientRoot and import it relatively',
              }],
            };
          }
          return null;
        }
        return null;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Cache revalidation and dependency manifests
// ---------------------------------------------------------------------------

function readCachedResult(
  stagingDir: string,
  depsListPath: string,
  rootReal: string,
  moduleRef: string,
  _pluginId: string,
  npmRoots: ReadonlyArray<ClientNpmRoot>,
): ClientCompileResult | undefined {
  if (!existsSync(depsListPath)) return undefined;
  let list: DepsListFile;
  try {
    list = JSON.parse(readFileSync(depsListPath, 'utf8')) as DepsListFile;
  } catch {
    return undefined;
  }
  if (
    list.version !== DEPS_LIST_VERSION ||
    list.module !== moduleRef ||
    list.root !== rootReal ||
    typeof list.contentHash !== 'string' ||
    !Array.isArray(list.dependencies) ||
    JSON.stringify(list.npmSpecifiers ?? []) !== JSON.stringify(npmSpecifiersKey(npmRoots))
  ) {
    return undefined;
  }
  for (const dep of list.dependencies) {
    const abs = join(rootReal, dep.path);
    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
    if (sha256(source) !== dep.sha256) return undefined;
  }
  for (const dep of list.npmDependencies ?? []) {
    let source: string;
    try {
      source = readFileSync(dep.path, 'utf8');
    } catch {
      return undefined;
    }
    if (sha256(source) !== dep.sha256) return undefined;
  }
  const baseName = safeFileName(moduleRef);
  const codePath = join(stagingDir, `${baseName}.${list.contentHash}.mjs`);
  const gzPath = join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`);
  if (!existsSync(codePath)) return undefined;
  try {
    const code = readFileSync(codePath, 'utf8');
    let gzipped: Uint8Array | undefined;
    if (existsSync(gzPath)) {
      try {
        gzipped = readFileSync(gzPath);
      } catch {
        /* ignore; caller can gzip on demand */
      }
    }
    const chunks: Record<string, { code: string; gzipped?: Uint8Array }> = {};
    if (Array.isArray(list.chunks) && list.chunks.length > 0) {
      // Lazy getters avoid pre-reading all async chunks on a main-module cache hit.
      for (const chunkName of list.chunks) {
        let cached: { code: string; gzipped?: Uint8Array } | undefined | null = null;
        Object.defineProperty(chunks, chunkName, {
          enumerable: true,
          get: () => {
            if (cached === null) cached = readCachedChunk(stagingDir, baseName, list.contentHash, chunkName);
            return cached;
          },
        });
      }
    }
    return { code, contentHash: list.contentHash, gzipped, exports: list.exports ?? [], chunks };
  } catch {
    return undefined;
  }
}

function collectLocalDependencies(
  metafile: { inputs: Record<string, unknown> } | undefined,
  rootReal: string,
): string[] {
  if (!metafile) return [];
  const out = new Set<string>();
  for (const inputKey of Object.keys(metafile.inputs)) {
    const abs = isAbsolute(inputKey) ? inputKey : join(rootReal, inputKey);
    const real = realpathOrNull(abs);
    if (real !== null && isInside(rootReal, real)) out.add(real);
  }
  return [...out].sort();
}

function collectNpmDependencies(
  metafile: { inputs: Record<string, unknown> } | undefined,
  rootReal: string,
  npmRoots: ReadonlyArray<ClientNpmRoot>,
): Array<{ root: string; files: string[] }> {
  if (!metafile || npmRoots.length === 0) return [];
  const files = new Set<string>();
  for (const inputKey of Object.keys(metafile.inputs)) {
    const abs = isAbsolute(inputKey) ? inputKey : join(rootReal, inputKey);
    const real = realpathOrNull(abs);
    if (real !== null && !isInside(rootReal, real)) files.add(real);
  }
  return files.size === 0 ? [] : [{ root: 'authorized-npm-closure', files: [...files].sort() }];
}

function buildDepsList(
  rootReal: string,
  moduleRef: string,
  dependencies: string[],
  npmDeps: Array<{ root: string; files: string[] }> = [],
  npmRoots: ReadonlyArray<ClientNpmRoot> = [],
  entryExports: string[] = [],
  chunks?: string[],
): DepsListFile {
  const hash = createHash('sha256');
  hash.update(`helm-plugin-client-v${DEPS_LIST_VERSION}\n`);
  hash.update(`module:${moduleRef}\n`);
  for (const specifier of npmSpecifiersKey(npmRoots)) {
    hash.update(`--npm-spec:${specifier}\n`);
  }
  const entries = dependencies.map((abs) => {
    const rel = relative(rootReal, abs);
    const sha = sha256(readFileSync(abs, 'utf8'));
    hash.update(`--file:${rel}\n${sha}\n`);
    return { path: rel, sha256: sha };
  });
  const npmEntries = npmDeps.flatMap(({ root, files }) =>
    files.map((abs) => {
      const sha = sha256(readFileSync(abs, 'utf8'));
      hash.update(`--npm:${root}::${abs}\n${sha}\n`);
      return { root, path: abs, sha256: sha };
    }),
  );
  if (chunks && chunks.length > 0) {
    for (const c of [...chunks].sort()) {
      hash.update(`--chunk:${c}\n`);
    }
  }
  return {
    version: DEPS_LIST_VERSION,
    module: moduleRef,
    root: rootReal,
    contentHash: hash.digest('hex').slice(0, 24),
    dependencies: entries,
    ...(npmEntries.length > 0 ? { npmDependencies: npmEntries } : {}),
    npmSpecifiers: npmSpecifiersKey(npmRoots),
    ...(entryExports.length > 0 ? { exports: entryExports } : {}),
    ...(chunks && chunks.length > 0 ? { chunks: [...chunks].sort() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Atomic file writes and path containment helpers
// ---------------------------------------------------------------------------

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const MAX_RENAME_RETRIES = 5;

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmp: string, targetPath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, targetPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= MAX_RENAME_RETRIES || !code || !RETRYABLE_RENAME_CODES.has(code)) {
        throw err;
      }
      sleepSyncMs(10 * 2 ** attempt);
    }
  }
}

function atomicWriteRaw(targetPath: string, content: string | Buffer | Uint8Array): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmp = `${targetPath}.tmp-${randomUUID()}`;
  try {
    if (typeof content === 'string') {
      writeFileSync(tmp, content, 'utf8');
    } else {
      writeFileSync(tmp, content);
    }
    renameWithRetry(tmp, targetPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure so original error propagates */
    }
    throw err;
  }
}

export function atomicWrite(targetPath: string, content: string): void {
  atomicWriteRaw(targetPath, content);
}

export function atomicWriteBuffer(targetPath: string, content: Buffer | Uint8Array): void {
  atomicWriteRaw(targetPath, content);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function realPathOrThrow(p: string, message: string): string {
  try {
    const st = statSync(p);
    if (!st.isFile() && !st.isDirectory()) throw new Error('not a file or directory');
    return realpathSync(p);
  } catch {
    throw new HelmError('client_root_invalid', message, 400, { path: p });
  }
}

function assertEntryInsideRoot(pluginId: string, rootReal: string, moduleRef: string): string {
  const absPath = join(rootReal, moduleRef);
  let real: string;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) throw new Error('not a regular file');
    real = realpathSync(absPath);
  } catch {
    throw new HelmError('client_root_invalid', `plugin ${pluginId} client module is missing: ${moduleRef}`, 400, {
      pluginId,
      module: moduleRef,
    });
  }
  if (!isInside(rootReal, real)) {
    throw new HelmError(
      'client_module_out_of_root',
      `plugin ${pluginId} client module escapes clientRoot (possible symlink escape): ${moduleRef}`,
      400,
      { pluginId, module: moduleRef },
    );
  }
  return real;
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

export function isInside(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Deterministic filesystem-safe directory name for a plugin ID. */
export function safeDirName(pluginId: string): string {
  const safe = pluginId.replace(/[^A-Za-z0-9_-]/g, '_');
  const suffix = createHash('sha1').update(pluginId).digest('hex').slice(0, 6);
  return `${safe}-${suffix}`;
}

/** Deterministic filesystem-safe file prefix for a moduleRef. */
export function safeFileName(moduleRef: string): string {
  const safe = moduleRef.replace(/[^A-Za-z0-9._-]+/g, '_');
  const suffix = createHash('sha1').update(moduleRef).digest('hex').slice(0, 6);
  return `${safe}-${suffix}`;
}
