/**
 * PluginClientCompiler:client.tsx track path host side compiler (@helm/plugin-build, kernel outside implement).
 *
 * this module is PluginBuildProvider.compileClientModule implement body, by produce product composition root (hub)
 * inject kernel PluginHost; kernel itself independent of esbuild(contract see @helm/protocol plugin-build.ts).
 *
 * responsibility (only do mechanism):
 * - plugin clientRoot inside each other for .ts/.tsx entry compile is browser ESM(esbuild bundle + metafile);
 * - dependency closed package and hash with esbuild metafile actual input is allow (export-from / motion state import /
 *   .js / .json / .css all such as accept; never rely source code regex guess import), cache re- inspect one by one dependency
 *   sha256 than for, source not change directly re- use disk artifact, never duplicate compile;
 * - host sharing dependency (react / react-dom / lucide-react / @helm/plugin-client) via esbuild
 *   virtual module shim handle:shim body inside `module.exports = globalThis.__helm_shared_*`,
 *   named / namespace / default / as-alias / export-from all by esbuild generate legal
 *   ESM bind set (compare regex change write import will produce out `const {useState as s}` this kind of illegal JS),
 *   runtime and host sharing the same instance, never bundle second React;
 * - CSS(v3 start): hand over to esbuild original generate CSS bundling(virtual outfile + write:false, do not
 *   real artifact file), local @import by dependency order original generate merge; merge result with tool name export
 *   `__helmClientCss`(@helm/protocol PLUGIN_CLIENT_CSS_EXPORT) attach in JS artifact tail part,
 *   artifact itself do not inject DOM- - load in import succeeded and cache still valid after only then inject style; without CSS
 *   when do not produce out the export (load by empty handle);
 *   - CSS asset URL only allows data: and http(s)/protocol each other for explicit absolute address (independent of plugin
 *     path base address); local each other for / each other for / fragment URL explicit compile error and create protocol inline data:;
 *   - far process @import explicit reject (do not subject to local dependency validate and cache manage control); local @import enter
 *     dependency hash; decide one rule use esbuild resolver  kind(import-rule / url-token),
 *     never use source code regex guess language method (note release in @import/url() is not import);
 * - containment: entry and each by load local file realpath all must at clientRoot realpath
 *   of inside (symlink escape one by one file intercept); non- sharing bare dependency (npm package) explicit reject - - when before unsupported
 *     npm install, never node_modules or outside file silently hit enter bundle;
 * - artifact:randomUUID temp file + rename atomic change name; same (pluginId, module, root)
 *   concurrency compile merge the same in-flight Promise, failed clear can retry.
 *
 * failed explicit throw HelmError(contains esbuild diagnose), never static default fall back or return empty artifact.
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
 * host and plugin sharing browser end runtime dependency: compile time intercept is virtual shim module (never parse
 * node_modules), runtime via globalThis.__helm_shared_* naming empty between take host the same instance.
 * specific render technique (such as diagram table store) do not this manifest - - plugin self has npm dependency away subject to control parse bundle
 *(see allowedNpmSpecifiers / containmentPlugin  npm branch).
 */
export const CLIENT_SHARED_EXTERNALS = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'lucide-react',
  '@helm/plugin-client',
] as const;

/** sharing note symbol -> host global naming empty between name (host page/test process mount; missing one i.e. runtime explicit errors). */
export const CLIENT_SHARED_GLOBALS: Readonly<Record<string, string>> = Object.freeze({
  react: '__helm_shared_react',
  'react-dom': '__helm_shared_react_dom',
  'react-dom/client': '__helm_shared_react_dom_client',
  'react/jsx-runtime': '__helm_shared_react_jsx_runtime',
  'lucide-react': '__helm_shared_lucide_react',
  '@helm/plugin-client': '__helm_shared_plugin_client',
});

/** dependency manifest (deps.json) structure version;v2 is CSS-as-JS old format,v3 start original generate CSS bundling,v4 start contains subject to control npm dependency,v5 start enable esbuild minify and pre- compress,v6 start support code split and async chunk bridge,v7 start sharing chunk register change use esbuild naming empty between bridge (key contains pluginId/moduleRef),v8 start record subject to control npm dependency declaration collection. */
const DEPS_LIST_VERSION = 8;

/** compile artifact (@helm/protocol PluginClientBundle local alias, supply test and tool directly reference). */
export type ClientCompileResult = PluginClientBundle;

// ---------------------------------------------------------------------------
// concurrency merge: same key in-flight compile sharing the same Promise; failed i.e. clear can retry
// ---------------------------------------------------------------------------

const inflight = new Map<string, Promise<ClientCompileResult>>();

interface MemoryCompiledEntry {
  result: ClientCompileResult;
  /** local dependency mtime snapshot (each other for clientRoot absolute path). */
  localMtimes: Map<string, number>;
  /** subject to control npm dependency stat refer grain (path -> { mtimeMs, size }): any one change only then do one by one file sha256 re-check. */
  npmStats?: Map<string, { mtimeMs: number; size: number }>;
  root: string;
}

const memoryCompiledCache = new Map<string, MemoryCompiledEntry>();

export function clearClientCompilerMemoryCache(): void {
  memoryCompiledCache.clear();
}

/**
 * based on (stagingDir, baseName, contentHash, chunkName) read single chunk content and gzip byte.
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
        /* ignore */
      }
    }
    return { code, gzipped };
  } catch {
    return undefined;
  }
}

/**
 * compile plugin client module (concurrency-safe: same key in-flight compile merge; cache hit when zero compile).
 * @param pluginId plugin ID(cache directory isolated unit)
 * @param clientRoot plugin declaration and already validate absolute source directory
 * @param moduleRef each other for entry (assertModuleRefShape already via)
 * @param cacheDir host dataDir(artifact and dependency manifest <cacheDir>/cache/plugin-staging/<pluginId>/)
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
  const key = `${pluginId}\0${moduleRef}\0${realPathOrThrow(clientRoot, `plugin ${pluginId}  clientRoot cannot access:${clientRoot}`)}\0${npmKey}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = compileUncached(pluginId, clientRoot, moduleRef, cacheDir, options?.npmRoots ?? []).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, run);
  return run;
}

/** dependency manifest (deps.json) structure: across restarts can re- inspect cache credentials. */
interface DepsListFile {
  version: typeof DEPS_LIST_VERSION
  module: string
  /** clientRoot realpath(change/move after old cache directly expires, do not mistakenly use). */
  root: string
  contentHash: string
  /** all local dependency: each other for root path + content sha256(contains entry itself). */
  dependencies: Array<{ path: string; sha256: string }>
  /** subject to control npm dependency: parse identifier + absolute path + content sha256(v4 new increase). */
  npmDependencies?: Array<{ root: string; path: string; sha256: string }>
  /** subject to control npm dependency declaration (parse + precise note symbol), used to guard against declaration undo after back put old bundle. */
  npmSpecifiers?: string[]
  /** entry tool name export (old manifest default when cache hit way take fewer than exports, must exports caller should re- compile or fault tolerance). */
  exports?: string[]
  /** async chunk filename manifest (v6 new increase). */
  chunks?: string[]
}

/**
 * subject to control npm dependency declaration:specifiers is allows precise bare note symbol (contains sub- path must one by one items declaration),
 * packageRoot is provide these package parse (usually is built-in plugin host package,node_modules inside).
 * parse artifact by file realpath containment validate after follow local dependency one and enter deps hash and cache re- inspect.
 */
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
    `plugin ${pluginId}  clientRoot missing or cannot access:${clientRoot}`,
  );
  const entryReal = assertEntryInsideRoot(pluginId, rootReal, moduleRef);

  // 1. process inside memory cache fast path: local dependency by mtime decide; subject to control npm dependency by (mtime, size)
  //    refer grain decide, any one change only then retreat back one by one file sha256 re-check (disk manifest re- inspect),npm content update after
  //    never forever long return old bundle.
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

  // cache re- inspect: manifest legal and each dependency sha256 and disk consistent when re- use artifact, zero compile
  const cached = readCachedResult(stagingDir, depsListPath, rootReal, moduleRef, pluginId, npmRoots);
  if (cached) {
    recordMemoryCache(memKey, rootReal, depsListPath, cached);
    return cached;
  }

  // Pass 1: open start splitting: true memory build
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
    throw new HelmError('client_compile_failed', `plugin ${pluginId} compile ${moduleRef} failed:${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  const pass1Metafile = pass1Result.metafile;
  const pass1OutputFiles = pass1Result.outputFiles;
  if (!pass1Metafile || !pass1OutputFiles) {
    throw new HelmError('client_compile_failed', `plugin ${pluginId} Pass 1 memory build not produce out metafile or outputFiles`, 500);
  }

  // validate keep export
  if (Object.values(pass1Metafile.outputs).some((file) => file.exports?.includes(PLUGIN_CLIENT_CSS_EXPORT))) {
    throw new HelmError(
      'client_compile_failed',
      `plugin ${pluginId} module ${moduleRef} occupy compiler keep export name "${PLUGIN_CLIENT_CSS_EXPORT}", please change name the export`,
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

  // seek entryBaseName
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
        `plugin ${pluginId} compile ${moduleRef} cannot unique locate entry JS artifact`,
        500,
        { pluginId, module: moduleRef },
      );
    }
  }

  const dependencies = collectLocalDependencies(pass1Metafile, rootReal);
  const npmDeps = collectNpmDependencies(pass1Metafile, rootReal, npmRoots);

  // entry static closed package and can reach motion state import target: pure function diagram rule plan (see client-chunk-graph.ts)
  const baseClosure = collectStaticImportClosure(metaByBase, entryBaseName);
  const dynamicTargets = collectDynamicImportTargets(metaByBase, baseClosure);

  const jsMeta = metaByBase.get(entryBaseName);
  const entryExports = [...(jsMeta?.exports ?? []), ...(css.length > 0 ? [PLUGIN_CLIENT_CSS_EXPORT] : [])];

  // fast path (without code split ordinary plugin)
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
      throw new HelmError('client_compile_failed', `plugin ${pluginId} compile ${moduleRef} converge failed:${message}`, 422, {
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
    } catch {}
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

  // package path (dynamicTargets.size > 0): set divide / reference counter / sharing chunk pass closed package /
  // pre- dependency topology sort is pure function diagram rule plan (see client-chunk-graph.ts, can independent single test)
  const { sharedAsyncChunks, chunkDeps } = computeAsyncChunkPlan(metaByBase, baseClosure, dynamicTargets);

  const allUnits = new Set<string>([...sharedAsyncChunks, ...dynamicTargets]);
  const list = buildDepsList(rootReal, moduleRef, dependencies, npmDeps, npmRoots, entryExports, Array.from(allUnits));

  // step B(v7): naming empty between bridge register __helm_chunk_share.
  // for each must register virtual chunk generate `import * as ns from <chunk>` bridge wrap module,
  // via esbuild generate getter naming empty between object after whole write __helm_chunk_share:
  // - export manifest from Pass 1 metafile(generate real metadata), contains default / again export /
  //   string naming export etc. all form, no longer use regex guess generate code;
  // - `import * as ns` reference all export,Tree-shaking cannot discard any bind set.
  // key by pluginId \0 moduleRef \0 contentHash \0 chunk isolated: two plugin same source same
  // hash when mutual do not interference, deactivate a will not delete another sharing table.
  const chunkShareKeyExpr = (file: string): string =>
    JSON.stringify(`${pluginId}\0${moduleRef}\0${list.contentHash}\0${file}`);
  const filesToRegister = new Set<string>([...baseClosure, ...sharedAsyncChunks]);
  filesToRegister.delete(entryBaseName);
  const chunkNsBridges = new Map<string, string>(); // file -> bridge wrap module virtual filename
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

  // step D:Pass 2 converge build (main package + sharing chunk naming empty between bridge + async unit)
  // main package extra pre- baseClosure each file register import (ESM by order evaluate: first dependency, again register, after entry),
  // main module seek value when baseClosure sharing table i.e. already fill - - async chunk  proxy no need to wait for extra network request.
  // the same vfs module in main package inside only inline a (register bridge and entry dependency points to the same instance, produces no body accumulate duplicate).
  const baseRegisterFiles = [...baseClosure].filter((f) => f !== entryBaseName && virtualFiles.has(f));
  async function bundleUnit(unitName: string, isMain: boolean): Promise<string> {
    // main package/async unit directly compile itself; sharing chunk via naming empty between bridge wrap compile (guard against tree-shaking +
    // write __helm_chunk_share). bridge inside import * as ns reference all export,esbuild will
    // Pass 1 virtual chunk original inline and generate getter naming empty between object.
    const isNsBridge = !isMain && sharedAsyncChunks.has(unitName);
    let unitCode = virtualFiles.get(isNsBridge ? chunkNsBridges.get(unitName)! : unitName);
    if (unitCode === undefined) {
      throw new HelmError('client_compile_failed', `find fewer than virtual file ${unitName}`, 500);
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
                // naming empty between bridge:`__helm_chunk__:<file>` points to by bridge Pass 1 virtual chunk
                // this body (note prefix decide must in basename before,basename will strip prefix)
                if (args.path.startsWith('__helm_chunk__:')) {
                  return { path: basename(args.path.slice('__helm_chunk__:'.length)), namespace: 'vfs' };
                }
                // main package pre- register import:`__helm_ns__:<file>` parse to for should register bridge module
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
    throw new HelmError('client_compile_failed', `plugin ${pluginId} main package converge failed to compile:${message}`, 422, {
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
        } catch {}
        chunkOutputs[unitName] = { code, gzipped };
      }),
    );
  } catch (err) {
    if (err instanceof HelmError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new HelmError('client_compile_failed', `plugin ${pluginId} package converge failed to compile:${message}`, 422, {
      pluginId,
      module: moduleRef,
    });
  }

  // step E: atomic and memory cache
  mkdirSync(stagingDir, { recursive: true });
  atomicWrite(join(stagingDir, `${baseName}.${list.contentHash}.mjs`), mainJs);
  let gzipped: Uint8Array | undefined;
  try {
    const gz = gzipSync(Buffer.from(mainJs, 'utf8'));
    atomicWriteBuffer(join(stagingDir, `${baseName}.${list.contentHash}.mjs.gz`), gz);
    gzipped = gz;
  } catch {}

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
    // subject to control npm dependency: record stat refer grain (mtime + size), content update after fast path can can rely expires.
    // stat refer grain and disk manifest one by one file sha256 re-check jointly construct into two layer guard against line: refer grain change directly expires;
    // refer grain not change but manifest sha256 inconsistent (extreme scenario) also by disk re- inspect honor bottom.
    const npmStats = new Map<string, { mtimeMs: number; size: number }>();
    for (const dep of list.npmDependencies ?? []) {
      try {
        const st = statSync(dep.path);
        npmStats.set(dep.path, { mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* file disappear: do not record refer grain, disk manifest re- inspect phase will expires heavy compile */
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
// CSS: serialization is tool name export attach in JS artifact tail part (artifact do not inject DOM, load negative duty inject)
// ---------------------------------------------------------------------------

/** metadata bind set must avoid let artifact in local variable, while non- only avoid let its public export name. */
function appendCssExport(js: string, css: string): string {
  if (css.length === 0) return js;
  let binding = '__helmCssText';
  while (js.includes(binding)) binding += '_';
  return `${js}\nconst ${binding} = ${JSON.stringify(css)};\nexport { ${binding} as ${PLUGIN_CLIENT_CSS_EXPORT} };\n`;
}

// ---------------------------------------------------------------------------
// sharing dependency virtual shim: legal ESM/CJS bind set, runtime from host global naming empty between take the same instance
// ---------------------------------------------------------------------------

/**
 * esbuild plugin: sharing dependency note symbol parse to 'helm-shared' virtual naming empty between;shim module body
 * only `module.exports = globalThis.__helm_shared_*`.esbuild  CJS-interop layer
 * (__toESM/__copyProps getter) is named(contains as alias)/ namespace / default /
 * export * from all generate legal bind set - - this is do not use source code regex heavy write importkey:
 * regex change write will produce `const { useState as s } = ...`(illegal JS) and leak default+named mixed etc. form.
 */
function sharedShimPlugin(): EsbuildPlugin {
  return {
    name: 'helm-shared-shim',
    setup(b) {
      for (const spec of CLIENT_SHARED_EXTERNALS) {
        const globalName = CLIENT_SHARED_GLOBALS[spec];
        b.onResolve({ filter: exactLiteralFilter(spec) }, () => ({
          path: spec,
          namespace: 'helm-shared',
        }));
      }
      b.onLoad({ filter: /.*/, namespace: 'helm-shared' }, (args) => {
        const globalName = CLIENT_SHARED_GLOBALS[args.path];
        if (globalName === undefined) {
          return { errors: [{ text: `unknown sharing dependency note symbol:${args.path}` }] };
        }
        return {
          contents: `module.exports = (globalThis.${globalName});`,
          loader: 'js',
        };
      });
    },
  };
}

/** precise match note symbol literal (do not swallow react-dom / sub- path; sharing sub- path do not in manifest inside will by explicit reject). */
function exactLiteralFilter(spec: string): RegExp {
  return new RegExp(`^${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

// ---------------------------------------------------------------------------
// containment: local file one by one realpath validate; bare dependency explicit reject
// ---------------------------------------------------------------------------

/**
 * subject to control npm note symbol parse: hit declaration specifiers when module parse to for should packageRoot 
 * node_modules inside (independent of cwd, do not subject to process chdir affect); return null means not declaration.
 * sub- path note symbol (such as 'pkg/lib/x.js') want seek one by one items explicit declaration, does not prefix through match.
 */
function resolveNpmSpecifier(
  spec: string,
  npmRoots: ReadonlyArray<ClientNpmRoot>,
): { path: string; pkgDir: string } | null {
  for (const root of npmRoots) {
    if (!root.specifiers.includes(spec)) continue;
    const nmReal = realpathOrNull(join(root.packageRoot, 'node_modules'));
    if (nmReal === null) continue;
    // packageRoot/node_modules inside package may is pnpm symlink (points to workspace store):
    // authorization and parse all with package directory realpath is boundary (splitNpmSpecifier strip sub- path).
    const { pkg, sub } = splitNpmSpecifier(spec);
    const pkgReal = realpathOrNull(join(nmReal, pkg));
    if (pkgReal === null) continue;
    const entry = resolveNpmPackageEntry(pkgReal, sub === '' ? pkg : `${pkg}/${sub}`);
    if (entry === null) continue;
    return { path: entry, pkgDir: pkgReal };
  }
  return null;
}

/**
 * parse npm package directory ESM entry (package.json exports[condition] / module / main).
 * only read field and validate target store in; any field illegal all return null(hand over back on layer by not declaration dependency reject),
 * never let esbuild for self define path do directory guess.
 */
/** spec split is package name + sub- path:@scope/name and name two kinds of form, the rest is sub- path segment. */
function splitNpmSpecifier(spec: string): { pkg: string; sub: string } {
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    return { pkg: parts.slice(0, 2).join('/'), sub: parts.slice(2).join('/') };
  }
  return { pkg: parts[0] ?? spec, sub: parts.slice(1).join('/') };
}

/**
 * parse npm package (or its sub- path) entry:package.json exports sub- path mapping (import/default)→
 * module/main(only); without exports when sub- path by package inside relative path direct take. any field illegal all return
 * null(by not declaration dependency reject), never let esbuild for self define path do directory guess.
 */
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
      // condition value may is string ("import": "./x.mjs") or embed set object ({ import: { default } }).
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
 * esbuild plugin:
 * - bare note symbol: sharing dependency by sharedShimPlugin(first register) handle; subject to control npm note symbol (caller
 *   explicit declaration specifiers + packageRoot) parse enter bundle and one by one file containment; the rest
 *   bare note symbol explicit compile error (never static default parse any node_modules);CSS url()/@import reference
 *   hand over by cssPolicyPlugin handle;
 * - local file onLoad phase realpath containment: exceeds out clientRoot realpath(contains symlink
 *   escape and CSS @import exceeds) i.e. reject - - old implement only check entry, dependency file can outside code carries enter bundle.
 */
function containmentPlugin(
  pluginId: string,
  rootReal: string,
  npmRoots: ReadonlyArray<ClientNpmRoot> = [],
): EsbuildPlugin {
  // npm closed package authorization table: via subject to control parse (declaration note symbol, or already authorization package inside file pass bare note symbol)
  // parse out package directory realpathset. authorization with package directory is unit - - each other for import and package inside
  // node_modules pass parse day however in authorization directory inside; parse i.e. authorization, symlink layout
  //(pnpm .pnpm store) does not affect boundary decide.
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
      // each other for import: no need to separate authorization - - package directory authorization model under each other for target day however at already authorization directory inside
      //(such as mermaid.core.mjs -> ./chunks/*.mjs); hand over back esbuild by default parse.
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        // symbol / UNC absolute path is not bare note symbol:filter only exclude `.` and `/` open head,
        // `D:\...`,`\\server\share\...` will enter come (Windows on entry and local dependency
        // all is this form). hand over back esbuild by default parse.
        if (isAbsoluteTargetPath(args.path)) return null;
        // CSS language method reference (url() asset / @import) is not npm note symbol: hand over by cssPolicyPlugin
        // by asset policy handle (data:/https: let through, local each other for explicit reject), never mistakenly report bare dependency
        if (args.kind === 'url-token' || args.kind === 'import-rule') return null;
        // sharing note symbol by sharedShimPlugin(first register) handle
        if ((CLIENT_SHARED_EXTERNALS as readonly string[]).includes(args.path)) return null;
        // subject to control npm note symbol: parse enter declaration packageRoot and authorization which in package directory (parse i.e. authorization).
        const npm = resolveNpmSpecifier(args.path, npmRoots);
        if (npm !== null) {
          authorizeNpmPackageDir(npm.pkgDir);
          return { path: npm.path };
        }
        // already declaration but failed to parse (not installed/entry missing): and not declaration strictly zone, never mistakenly lead troubleshoot direction.
        const declaredRoot = npmRoots.find((r) => r.specifiers.includes(args.path));
        if (declaredRoot !== undefined) {
          return {
            errors: [{
              text:
                `plugin ${pluginId} declaration frontend dependency "${args.path}" in ${join(declaredRoot.packageRoot, 'node_modules')} inside cannot parse` +
                '(dependency not installed or package entry missing); please in plugin directory install the dependency after retry (managed install by install/update automatically patch install)',
            }],
          };
        }
        // pass dependency: import way at already authorization package directory inside when, hand over back esbuild original generate parse;
        // onLoad will by actual file path do authorization and containment validate.
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
              `plugin ${pluginId} compile reject bare dependency "${args.path}"(by ${importer} introduce):` +
              `not declaration is subject to control npm dependency;clientRoot inside only allows each other for import, sharing dependency (${CLIENT_SHARED_EXTERNALS.join(', ')}) and declaration npm note symbol`,
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
            text: `plugin ${pluginId} compile reject out of bounds each other for import (may is ../ exceeds or not declaration npm file):${candidate}`,
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
          // clientRoot each other for exceeds import already in onResolve phase reject; from already authorization npm
          // package pass dependency by this call back by node_modules package directory one by one step accept authorization.
          if (real.includes(sep + 'node_modules' + sep)) {
            const pkgDir = findPackageDirOf(real);
            if (pkgDir !== null) {
              authorizeNpmPackageDir(pkgDir);
              return null;
            }
          }
          return {
            errors: [{
              text: `plugin ${pluginId} compile reject out of bounds file (may is ../ exceeds, symlink escape or not declaration npm parse):${real}`,
            }],
          };
        }
        return null;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CSS asset policy:esbuild resolver kind decide (never use source code regex guess language method)
// ---------------------------------------------------------------------------

/**
 * allows CSS asset URL: independent of plugin path base address explicit absolute address (data: inline and
 * http(s)/protocol each other for outside chain). empty string (url() without reference) original keep (legal CSS, by browser handle).
 */
function isAllowedCssAssetUrl(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (url.length === 0) return true;
  if (/^data:/i.test(url)) return true;
  if (/^https?:\/\//i.test(url)) return true;
  if (url.startsWith('//')) return true;
  return false;
}

/** file which belong package directory: to on find most near package.json which in directory (npm layout inside must reach). */
function findPackageDirOf(fileReal: string): string {
  let dir = dirname(fileReal);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return fileReal;
    dir = parent;
  }
}

/**
 * from subject to control package closed package inside import file parse pass bare note symbol: to on find most near node_modules package directory,
 * read package.json entry (and directly declaration the same entry semantics). find fewer than return null(by not declaration reject).
 */
function resolveTransitiveNpmSpecifier(spec: string, importerReal: string): string | null {
  const { pkg, sub } = splitNpmSpecifier(spec);
  let dir = findPackageDirOf(importerReal);
  for (;;) {
    const pkgReal = realpathOrNull(join(dir, 'node_modules', pkg));
    if (pkgReal !== null) {
      const entry = resolveNpmPackageEntry(pkgReal, sub === '' ? pkg : `${pkg}/${sub}`);
      if (entry !== null) return entry;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * esbuild plugin: by resolver kind manage CSS language method reference - -
 * - url-token(url() asset):data: / http(s) / protocol each other for let through (hand over back by default parse,esbuild
 *   original keep); local each other for / each other for / fragment etc. the rest form explicit reject and create protocol inline data:;
 * - import-rule(CSS @import): local each other for by by default parse parse (via onLoad containment
 *   validate realpath exceeds, local @import enter dependency closed package and hash); far process (http(s)/protocol each other for)
 *   explicit reject - - outside chain style do not subject to local dependency validate and cache manage control.
 */
function cssPolicyPlugin(pluginId: string): EsbuildPlugin {
  return {
    name: 'helm-css-policy',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'url-token') {
          if (isAllowedCssAssetUrl(args.path)) return null; // hand over back by default parse (esbuild original keep)
          return {
            errors: [{
              text:
                `plugin ${pluginId} style ${args.importer} reference asset "${args.path}" by reject:` +
                'local each other for/each other for/fragment URL will each other for host page error base address parse (plugin without static assets end point);' +
                'use... instead inline data: URL or explicit https:// absolute address',
            }],
          };
        }
        if (args.kind === 'import-rule') {
          if (/^(https?:)?\/\//i.test(args.path)) {
            return {
              errors: [{
                text:
                  `plugin ${pluginId} style ${args.importer} far process @import "${args.path}" by reject:` +
                  'far process style do not subject to local dependency validate and cache manage control; please style duplicate enter clientRoot after each other for reference',
              }],
            };
          }
          return null; // local @import: by default parse + onLoad containment(exceeds reject)
        }
        return null;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// cache re- inspect and dependency manifest
// ---------------------------------------------------------------------------

/** read cache artifact: manifest legal + each dependency sha256 and disk consistent only then re- use; otherwise undefined(heavy compile). */
function readCachedResult(
  stagingDir: string,
  depsListPath: string,
  rootReal: string,
  moduleRef: string,
  pluginId: string,
  npmRoots: ReadonlyArray<ClientNpmRoot>,
): ClientCompileResult | undefined {
  if (!existsSync(depsListPath)) return undefined;
  let list: DepsListFile;
  try {
    list = JSON.parse(readFileSync(depsListPath, 'utf8')) as DepsListFile;
  } catch {
    return undefined; // manifest corrupt: treated as not cache, re- compile
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
      return undefined; // dependency by delete: expires heavy compile
    }
    if (sha256(source) !== dep.sha256) return undefined;
  }
  for (const dep of list.npmDependencies ?? []) {
    // npm dependency file real path and content change: expires heavy compile; identifier only used to diagnose/hash, do not as local path access.
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
        /* read pre- compress file failed then empty, by caller on demand generate */
      }
    }
    const chunks: Record<string, { code: string; gzipped?: Uint8Array }> = {};
    if (Array.isArray(list.chunks) && list.chunks.length > 0) {
      // main module cache hit do not pre- read all chunk: one by one chunk lazy read (getter first time access only then memory),
      // ordinary main module request zero extra disk read;chunk missing same lazy decide (missing when machine retreat back undefined).
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

/** from metafile inputs collect rootReal inside all local dependency (contains entry; sort guarantee determinism). */
function collectLocalDependencies(
  metafile: { inputs: Record<string, unknown> } | undefined,
  rootReal: string,
): string[] {
  if (!metafile) return [];
  const out = new Set<string>();
  for (const inputKey of Object.keys(metafile.inputs)) {
    // metafile key each other for absWorkingDir(or absolute path); virtual naming empty between input excludes '/' path form
    const abs = isAbsolute(inputKey) ? inputKey : join(rootReal, inputKey);
    const real = realpathOrNull(abs);
    if (real !== null && isInside(rootReal, real)) out.add(real);
  }
  return [...out].sort();
}

/**
 * from metafile inputs collect subject to control npm dependency file (clientRoot of outside input).
 * compile already succeeded means all exceeds input all via parse phase authorization (bare note symbol all subject to control parse),
 * therefore this where only needs to byclientRoot of outside archive group; file collection change follow hash reverse reflect to cache credentials.
 */
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

/** group install dependency manifest: one by one dependency sha256(content seek address, across restarts stable; independent of mtime).
 * npm dependency by (parse realpath, absolute path) reference and hash- - path or content any one change i.e. expires. */
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
// and path tool
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

/** temp file (randomUUID)+ rename atomic; failed clean up temp file (can retry). */
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
      /* clean up failed do not mask original error */
    }
    throw err;
  }
}

function atomicWrite(targetPath: string, content: string): void {
  atomicWriteRaw(targetPath, content);
}

function atomicWriteBuffer(targetPath: string, content: Buffer | Uint8Array): void {
  atomicWriteRaw(targetPath, content);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function realPathOrThrow(p: string, message: string): string {
  try {
    const st = statSync(p);
    if (!st.isFile() && !st.isDirectory()) throw new Error('not file/dir');
    return realpathSync(p);
  } catch {
    throw new HelmError('client_root_invalid', message, 400, { path: p });
  }
}

/** entry file containment: missing / non- file / realpath exceeds (symlink escape) explicit reject. */
function assertEntryInsideRoot(pluginId: string, rootReal: string, moduleRef: string): string {
  const absPath = join(rootReal, moduleRef);
  let real: string;
  try {
    const st = statSync(absPath);
    if (!st.isFile()) throw new Error('not file');
    real = realpathSync(absPath);
  } catch {
    throw new HelmError('client_root_invalid', `plugin ${pluginId}  client module missing:${moduleRef}`, 400, {
      pluginId,
      module: moduleRef,
    });
  }
  if (!isInside(rootReal, real)) {
    throw new HelmError(
      'client_module_out_of_root',
      `plugin ${pluginId}  client module exceeds out clientRoot(may is symlink escape):${moduleRef}`,
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

/** target real path is otherwise at real path inside (same or of subdirectory; symlink already by realpath consume solve). */
function isInside(rootReal: string, target: string): boolean {
  const rel = relative(rootReal, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** plugin ID to security directory name (: etc. character mapping is _,hash suffix guarantee different ID do not collision);staging naming contract,node-chunk-bridge same opening path push lead. */
export function safeDirName(pluginId: string): string {
  const safe = pluginId.replace(/[^A-Za-z0-9_-]/g, '_');
  const suffix = createHash('sha1').update(pluginId).digest('hex').slice(0, 6);
  return `${safe}-${suffix}`;
}

/** moduleRef to security filename (/ and special character mapping,hash suffix guarantee unique);staging naming contract,node-chunk-bridge same opening path push lead. */
export function safeFileName(moduleRef: string): string {
  const safe = moduleRef.replace(/[^A-Za-z0-9._-]+/g, '_');
  const suffix = createHash('sha1').update(moduleRef).digest('hex').slice(0, 6);
  return `${safe}-${suffix}`;
}
