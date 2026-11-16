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
