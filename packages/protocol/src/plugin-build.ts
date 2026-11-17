/**
 * Plugin build port contract (the single interface between the kernel PluginHost and the build implementation package).
 *
 * Mechanism/policy separation: the kernel holds the mechanisms (registry / lifecycle /
 * module hooks) while compilation and transpilation tooling (esbuild) is implemented by
 * an external provider and injected explicitly (the product composition injects the
 * default implementation in hub). The kernel never statically or dynamically imports
 * the build implementation package; this module contains only types and pure functions,
 * keeping protocol free of heavy runtime dependencies and browser-safe.
 */
import { HelmError } from './error.js';

/**
 * Controlled npm dependency declaration: `specifiers` are the allowed exact bare
 * specifiers (subpaths must be declared item by item, no prefix wildcards), and
 * `packageRoot` is the resolution root providing those packages (usually the plugin
 * host package root; packages resolve from its node_modules; with the pnpm symlink
 * layout the boundary is the package directory's realpath).
 */
export interface PluginClientNpmRoot {
  specifiers: ReadonlyArray<string>;
  packageRoot: string;
}

/** client.tsx build output (single entry). */
export interface PluginClientBundle {
  /** Output JS text (self-contained browser ESM; shared dependencies resolve at runtime via globalThis.__helm_shared_*). */
  code: string;
  /** Content hash (entry + all local/controlled npm dependency content sha256 + compile options). */
  contentHash: string;
  /** Pre-gzipped bytes of the output (for fast HTTP responses). */
  gzipped?: Uint8Array;
  /** Named exports of the output entry module (including preserved CSS exports; consumed by dangling-export validation). */
  exports: string[];
  /** Async split chunks (produced by the code-splitting path; key is the chunk file name). */
  chunks?: Record<string, { code: string; gzipped?: Uint8Array }>;
}

/** client module compile request: the kernel gathers facts, the provider performs the compile. */
export interface PluginClientCompileRequest {
  /** Plugin ID (the cache directory isolation unit). */
  pluginId: string;
  /** The plugin's declared and validated absolute source root. */
  clientRoot: string;
  /** Relative entry (shape already checked by assertModuleRefShape). */
  moduleRef: string;
  /** Host dataDir; output and dependency manifests land in <cacheDir>/plugin-staging/<pluginId>/. */
  cacheDir: string;
  /** Controlled npm dependency resolution roots (an empty array when none declared). */
  npmRoots: ReadonlyArray<PluginClientNpmRoot>;
}

/** Backend TS source transform request (the external plugin Node module hooks foundation; called synchronously). */
export interface PluginBackendTsTransform {
  /** Full source file text. */
  source: string;
  /** Absolute source file path (for diagnostics and sourcefile positioning). */
  file: string;
  /** Source form: 'ts' for .ts/.mts/.cts, 'tsx' for .tsx. */
  kind: 'ts' | 'tsx';
}

/**
 * Plugin build port: the kernel PluginHost's only compile/transpile dependency.
 *
 * When not injected (buildProvider missing), the kernel explicitly rejects the
 * related capabilities, never silently degrading:
 * - UI contribution registration with a client reference -> 501 unsupported_client_build;
 * - external plugin TS source transform -> 501 unsupported_backend_ts_build.
 */
export interface PluginBuildProvider {
  /** Compile a plugin client.tsx module into browser ESM output (with disk/memory caching, concurrent merging, hash invalidation and gzip). */
  compileClientModule(request: PluginClientCompileRequest): Promise<PluginClientBundle>;
  /** Synchronously transpile backend TS source text into ESM (jsx: automatic, target: node20; semantics match esbuild transformSync). */
  transformBackendTs(transform: PluginBackendTsTransform): string;
}

/** Allowed character set for ClientComponentRef.module (relative path segments: alphanumeric . _ -; empty segments and .. forbidden). */
const MODULE_REF_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.(ts|tsx)$/;

/**
 * Validate the shape of ClientComponentRef.module (relative .ts/.tsx; no absolute,
 * root-escaping, or encoding escapes). The kernel registration boundary and the
 * build implementation share this validation (judged by the path's own form,
 * cross-platform).
 */
export function assertModuleRefShape(pluginId: string, moduleRef: string): void {
  if (
    typeof moduleRef !== 'string' ||
    moduleRef.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(moduleRef) ||
    moduleRef.startsWith('\\') ||
    moduleRef.includes('\\') ||
    moduleRef.split('/').includes('..') ||
    !MODULE_REF_PATTERN.test(moduleRef)
  ) {
    throw new HelmError(
      'invalid_client_module',
      `client module reference of plugin ${pluginId} is invalid (must be a relative .ts/.tsx path inside clientRoot; absolute paths / .. root escapes / backslashes forbidden): ${String(moduleRef)}`,
      400,
      { pluginId, module: String(moduleRef) },
    );
  }
}

/**
 * Aggregate the npmDependencies declared by a plugin definition (specifier ->
 * resolution root) into compiler-validatable roots. Shared by the kernel runtime
 * chain (ui-registry) and the doctor static self-check chain, guaranteeing a
 * single mapping criterion.
 */
export function clientNpmRootsOf(
  npmDependencies: Readonly<Record<string, string>> | undefined,
): PluginClientNpmRoot[] {
  const npmByRoot = new Map<string, string[]>();
  for (const [spec, packageRoot] of Object.entries(npmDependencies ?? {})) {
    const list = npmByRoot.get(packageRoot) ?? [];
    list.push(spec);
    npmByRoot.set(packageRoot, list);
  }
  return [...npmByRoot.entries()].map(([packageRoot, specifiers]) => ({ packageRoot, specifiers }));
}

// ---------------------------------------------------------------------------
// Prebuilt client bundle contract (browser-safe, zero node:* / esbuild deps)
// ---------------------------------------------------------------------------

/** Prebuilt manifest schema version. */
export const PREBUILT_CLIENT_MANIFEST_VERSION = 1 as const;

/** Conventional subdirectory inside a plugin directory containing prebuilt client artifacts. */
export const PREBUILT_CLIENT_DIR_NAME = 'dist-client';

/** Manifest filename inside a prebuilt client directory. */
export const PREBUILT_CLIENT_MANIFEST_FILE = 'manifest.json';

/** Valid chunk filename pattern (single relative .js filename; no slashes or '..'). */
const PREBUILT_CHUNK_NAME_PATTERN = /^[A-Za-z0-9._-]+\.js$/;

/** Valid relative path inside prebuiltClientDir (POSIX segments of safe characters; no empty or '..' segments). */
const PREBUILT_REL_FILE_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Per-entry metadata recorded inside `dist-client/manifest.json`. */
export interface PrebuiltClientModuleEntry {
  /** Entry JS file path relative to the prebuilt client directory (POSIX separators). */
  entryFile: string;
  /** Deterministic content hash of the compiled entry module and its dependencies. */
  contentHash: string;
  /** Named exports of the entry module (including `__helmClientCss` when CSS was bundled). */
  exports: string[];
  /** Async/shared chunk filenames emitted for this entry (when code splitting occurred). */
  chunks?: string[];
}

/** Static manifest written into `dist-client/manifest.json` by `buildPluginClientBundleDir`. */
export interface PrebuiltClientManifest {
  version: typeof PREBUILT_CLIENT_MANIFEST_VERSION;
  /** Mapping from declared `ClientComponentRef.module` (e.g. `'index.tsx'`) to its prebuilt entry metadata. */
  modules: Record<string, PrebuiltClientModuleEntry>;
}

/** Options accepted by `@helm/plugin-build`'s `buildPluginClientBundleDir`. */
export interface BuildPluginClientBundleDirOptions {
  pluginId: string;
  clientRoot: string;
  outDir: string;
  /** Relative `.ts`/`.tsx` entry modules inside `clientRoot`; when omitted, scans non-declaration `.ts`/`.tsx` files. */
  modules?: ReadonlyArray<string>;
  /** Controlled npm dependency resolution roots (defaults to `[]`). */
  npmRoots?: ReadonlyArray<PluginClientNpmRoot>;
}

/** Output summary returned by `buildPluginClientBundleDir`. */
export interface BuildPluginClientBundleDirResult {
  pluginId: string;
  clientRoot: string;
  outDir: string;
  manifestPath: string;
  manifest: PrebuiltClientManifest;
  /** Total byte size across all emitted artifact files (`manifest.json`, `.mjs`, `.js`, and `.gz`). */
  totalBytes: number;
}

/** Validates an async/shared chunk filename requested or declared by a plugin client module. */
export function assertPrebuiltChunkName(pluginId: string, chunk: string): void {
  if (
    typeof chunk !== 'string' ||
    !PREBUILT_CHUNK_NAME_PATTERN.test(chunk) ||
    chunk.includes('..')
  ) {
    throw new HelmError(
      'invalid_client_module',
      `plugin ${pluginId} invalid chunk module name (must match /^[A-Za-z0-9._-]+\\.js$/ and exclude ..): ${String(chunk)}`,
      400,
      { pluginId, chunk: String(chunk) },
    );
  }
}

/** Canonical prebuilt chunk path relative to `prebuiltClientDir` for a given entry file and chunk name. */
export function prebuiltChunkFileName(entryFile: string, chunkName: string, pluginId = 'prebuilt'): string {
  assertPrebuiltChunkName(pluginId, chunkName);
  const stem = entryFile.endsWith('.mjs') ? entryFile.slice(0, -4) : entryFile;
  return `${stem}.chunk.${chunkName}`;
}

/** Validates a relative file path inside `prebuiltClientDir` (blocks absolute paths, backslashes, '..', and '.' segments). */
export function assertPrebuiltRelativeFile(prebuiltDir: string, relPath: unknown, label: string): string {
  if (
    typeof relPath !== 'string' ||
    relPath.length === 0 ||
    relPath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(relPath) ||
    relPath.startsWith('\\') ||
    relPath.includes('\\') ||
    !PREBUILT_REL_FILE_PATTERN.test(relPath) ||
    relPath.split('/').some((seg) => seg === '.' || seg === '..')
  ) {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client ${label} in ${prebuiltDir} must be a safe relative path without '..' or absolute prefixes: ${String(relPath)}`,
      400,
      { prebuiltDir, label, path: String(relPath) },
    );
  }
  return relPath;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates and normalizes a parsed `dist-client/manifest.json` structure (pure, zero I/O). */
export function assertPrebuiltClientManifest(raw: unknown, prebuiltDir: string): PrebuiltClientManifest {
  if (!isPlainRecord(raw)) {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client manifest in ${prebuiltDir} must be a JSON object`,
      400,
      { prebuiltDir },
    );
  }
  if (raw['version'] !== PREBUILT_CLIENT_MANIFEST_VERSION) {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client manifest in ${prebuiltDir} has unsupported version ${String(raw['version'])} (expected ${PREBUILT_CLIENT_MANIFEST_VERSION})`,
      400,
      { prebuiltDir, version: raw['version'] },
    );
  }
  const rawModules = raw['modules'];
  if (!isPlainRecord(rawModules)) {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client manifest in ${prebuiltDir} must declare a modules object`,
      400,
      { prebuiltDir },
    );
  }

  const modules: Record<string, PrebuiltClientModuleEntry> = {};
  for (const [moduleRef, rawEntry] of Object.entries(rawModules)) {
    assertModuleRefShape('prebuilt', moduleRef);
    if (!isPlainRecord(rawEntry)) {
      throw new HelmError(
        'prebuilt_client_invalid',
        `Prebuilt client manifest entry for ${moduleRef} in ${prebuiltDir} must be an object`,
        400,
        { prebuiltDir, module: moduleRef },
      );
    }
    const entryFile = assertPrebuiltRelativeFile(prebuiltDir, rawEntry['entryFile'], `modules[${moduleRef}].entryFile`);
    const contentHash = rawEntry['contentHash'];
    if (typeof contentHash !== 'string' || contentHash.trim().length === 0 || /[\s/\\]/.test(contentHash)) {
      throw new HelmError(
        'prebuilt_client_invalid',
        `Prebuilt client manifest entry for ${moduleRef} in ${prebuiltDir} has invalid contentHash`,
        400,
        { prebuiltDir, module: moduleRef },
      );
    }
    const rawExports = rawEntry['exports'];
    if (!Array.isArray(rawExports) || rawExports.some((e) => typeof e !== 'string' || e.length === 0)) {
      throw new HelmError(
        'prebuilt_client_invalid',
        `Prebuilt client manifest entry for ${moduleRef} in ${prebuiltDir} must declare exports as a string array`,
        400,
        { prebuiltDir, module: moduleRef },
      );
    }
    const rawChunks = rawEntry['chunks'];
    let chunks: string[] | undefined;
    if (rawChunks !== undefined) {
      if (!Array.isArray(rawChunks)) {
        throw new HelmError(
          'prebuilt_client_invalid',
          `Prebuilt client manifest entry for ${moduleRef} in ${prebuiltDir} must declare chunks as an array`,
          400,
          { prebuiltDir, module: moduleRef },
        );
      }
      const seenChunks = new Set<string>();
      chunks = [];
      for (const chunkName of rawChunks) {
        assertPrebuiltChunkName('prebuilt', chunkName as string);
        if (seenChunks.has(chunkName as string)) {
          throw new HelmError(
            'prebuilt_client_invalid',
            `Prebuilt client manifest entry for ${moduleRef} in ${prebuiltDir} contains duplicate chunk: ${String(chunkName)}`,
            400,
            { prebuiltDir, module: moduleRef, chunk: String(chunkName) },
          );
        }
        seenChunks.add(chunkName as string);
        chunks.push(chunkName as string);
      }
    }
    modules[moduleRef] = {
      entryFile,
      contentHash,
      exports: [...(rawExports as string[])],
      ...(chunks !== undefined && chunks.length > 0 ? { chunks } : {}),
    };
  }

  return {
    version: PREBUILT_CLIENT_MANIFEST_VERSION,
    modules,
  };
}
