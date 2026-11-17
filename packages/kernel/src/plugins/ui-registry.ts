/**
 * ui-registry.ts: Collects and validates all frontend UI extension point declarations
 * across plugins, integrating build-port (PluginBuildProvider) module validation and artifact resolution.
 *
 * Responsibilities:
 * - Collect UI declarations for sidebar, screen, timeline, markdown.codeBlock, tool, composer,
 *   workbench, commandPalette, settingsPanel, profile.runtime, UI actions (header/row/entry),
 *   and plugin.slot (unified client.tsx track);
 * - Run static declaration-boundary checks (id uniqueness, finite safe integer priority/order,
 *   command slash prefix & reserved names, mutually exclusive UI action target & required action/client track,
 *   markdown.codeBlock language table, slot target shape, artifact.previewer MIME/extension matchers,
 *   composer.completer exclusion, ConversationScope plain-object validation, JSON-safe fidelity);
 * - Validate client.tsx dynamic component module references (assertModuleRefShape) and clientRoot containment;
 * - Resolve compiled client module artifacts with strict lifecycle & epoch verification (preventing stale artifacts
 *   from deactivated or cycled plugins);
 * - Enforce cross-plugin uniqueness invariants at enable commit time (profile.runtime kind and commandPalette slash),
 *   called by PluginHost during enable commit so disabled pre-registrations never occupy global names.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  HelmError,
  PREBUILT_CLIENT_MANIFEST_FILE,
  assertModuleRefShape,
  assertPrebuiltChunkName,
  assertPrebuiltClientManifest,
  clientNpmRootsOf,
  parseNonEmptyLocalizedText,
  prebuiltChunkFileName,
  type PluginBuildProvider,
  type PluginClientBundle,
  type PluginClientNpmRoot,
  type PluginUiContribution,
  type PrebuiltClientManifest,
  type PrebuiltClientModuleEntry,
} from '@helm/protocol';
import { assertConversationScope, isPlainObject, jsonClone } from './shared.js';
import {
  UI_ACTION_SURFACES,
  validateUiSpecEarly,
  validateUiSpecLate,
  type UiSpecContext,
} from './ui-spec-validators.js';

/** Mapping from the three UI action targets to registry surfaces (shared by plugin-context and validation; defined in ui-spec-validators.ts). */
export { UI_ACTION_SURFACES } from './ui-spec-validators.js';

/** Result of reading and validating a prebuilt `dist-client/manifest.json`. */
export interface LoadedPrebuiltClientManifest {
  rootReal: string;
  manifest: PrebuiltClientManifest;
}

function resolvePrebuiltFileSafe(
  rootReal: string,
  prebuiltDir: string,
  relPath: string,
  label: string,
  pluginId: string,
): string {
  const candidate = resolve(rootReal, relPath);
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    let isSymlink = false;
    try {
      isSymlink = lstatSync(candidate).isSymbolicLink();
    } catch {
      // ENOENT
    }
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client ${label} file ${isSymlink ? 'is a dangling symlink' : 'is missing'} for plugin ${pluginId}: ${relPath}`,
      400,
      { pluginId, prebuiltDir, relPath },
    );
  }
  const rel = relative(rootReal, real);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HelmError(
      'client_module_out_of_root',
      `Prebuilt client ${label} escapes prebuiltClientDir (${prebuiltDir}): ${relPath}`,
      400,
      { pluginId, prebuiltDir, relPath },
    );
  }
  let stat;
  try {
    stat = statSync(real);
  } catch {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client ${label} file cannot be read for plugin ${pluginId}: ${relPath}`,
      400,
      { pluginId, prebuiltDir, relPath },
    );
  }
  if (!stat.isFile()) {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client ${label} is not a regular file for plugin ${pluginId}: ${relPath}`,
      400,
      { pluginId, prebuiltDir, relPath },
    );
  }
  return real;
}

function resolveOptionalPrebuiltGzipSafe(
  rootReal: string,
  prebuiltDir: string,
  relPath: string,
  label: string,
  pluginId: string,
): string | undefined {
  const gzRel = `${relPath}.gz`;
  const gzCandidate = resolve(rootReal, gzRel);
  try {
    lstatSync(gzCandidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client ${label}.gz stat failed for plugin ${pluginId}: ${err instanceof Error ? err.message : String(err)}`,
      400,
      { pluginId, prebuiltDir, relPath: gzRel },
    );
  }
  return resolvePrebuiltFileSafe(rootReal, prebuiltDir, gzRel, `${label}.gz`, pluginId);
}

/**
 * Read and strictly validate `manifest.json` inside a plugin's prebuilt `dist-client` directory.
 * Rejects missing directories, symlink escapes out of `prebuiltDir`, corrupt JSON, and schema violations.
 */
export function readPrebuiltClientManifest(
  prebuiltDir: string,
  pluginId = 'prebuilt',
): LoadedPrebuiltClientManifest {
  let rootStat;
  try {
    rootStat = statSync(prebuiltDir);
  } catch {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client directory does not exist for plugin ${pluginId}: ${prebuiltDir}`,
      400,
      { pluginId, prebuiltDir },
    );
  }
  if (!rootStat.isDirectory()) {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client directory is not a directory for plugin ${pluginId}: ${prebuiltDir}`,
      400,
      { pluginId, prebuiltDir },
    );
  }
  const rootReal = realpathSync(prebuiltDir);
  const manifestReal = resolvePrebuiltFileSafe(
    rootReal,
    prebuiltDir,
    PREBUILT_CLIENT_MANIFEST_FILE,
    PREBUILT_CLIENT_MANIFEST_FILE,
    pluginId,
  );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestReal, 'utf-8'));
  } catch (err) {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client manifest JSON parse failed in ${prebuiltDir}: ${err instanceof Error ? err.message : String(err)}`,
      400,
      { pluginId, prebuiltDir },
    );
  }
  return { rootReal, manifest: assertPrebuiltClientManifest(raw, prebuiltDir) };
}

interface VerifiedPrebuiltEntry {
  entry: PrebuiltClientModuleEntry;
  entryReal: string;
  entryGzReal?: string;
  chunkPaths: Map<string, { real: string; gzReal?: string }>;
}

function assertPrebuiltEntryIntegrity(
  rootReal: string,
  prebuiltDir: string,
  moduleRef: string,
  manifest: PrebuiltClientManifest,
  pluginId: string,
): VerifiedPrebuiltEntry {
  const entry = manifest.modules[moduleRef];
  if (!entry) {
    throw new HelmError(
      'prebuilt_client_invalid',
      `Prebuilt client manifest for plugin ${pluginId} does not contain declared module ${moduleRef}`,
      404,
      { pluginId, prebuiltDir, module: moduleRef },
    );
  }
  const entryReal = resolvePrebuiltFileSafe(
    rootReal,
    prebuiltDir,
    entry.entryFile,
    `entryFile(${moduleRef})`,
    pluginId,
  );
  const entryGzReal = resolveOptionalPrebuiltGzipSafe(
    rootReal,
    prebuiltDir,
    entry.entryFile,
    `entryFile(${moduleRef})`,
    pluginId,
  );
  const chunkPaths = new Map<string, { real: string; gzReal?: string }>();
  for (const chunkName of entry.chunks ?? []) {
    const chunkRel = prebuiltChunkFileName(entry.entryFile, chunkName, pluginId);
    const real = resolvePrebuiltFileSafe(rootReal, prebuiltDir, chunkRel, `chunk(${chunkName})`, pluginId);
    const gzReal = resolveOptionalPrebuiltGzipSafe(
      rootReal,
      prebuiltDir,
      chunkRel,
      `chunk(${chunkName})`,
      pluginId,
    );
    chunkPaths.set(chunkName, { real, gzReal });
  }
  return { entry, entryReal, entryGzReal, chunkPaths };
}

function materializePrebuiltBundle(
  prebuiltDir: string,
  moduleRef: string,
  verified: VerifiedPrebuiltEntry,
  chunk: string | undefined,
  pluginId: string,
): PluginClientBundle {
  const { entry, entryReal, entryGzReal, chunkPaths } = verified;
  if (chunk !== undefined) {
    const target = chunkPaths.get(chunk);
    if (!target) {
      throw new HelmError(
        'client_chunk_not_found',
        `plugin ${pluginId} module ${moduleRef} did not generate chunk: ${chunk}`,
        404,
        { pluginId, prebuiltDir, module: moduleRef, chunk },
      );
    }
    return {
      code: readFileSync(target.real, 'utf-8'),
      contentHash: entry.contentHash,
      gzipped: target.gzReal !== undefined ? readFileSync(target.gzReal) : undefined,
      exports: [],
    };
  }
  let chunks: Record<string, { code: string; gzipped?: Uint8Array }> | undefined;
  if (chunkPaths.size > 0) {
    chunks = {};
    const chunkCache = new Map<string, { code: string; gzipped?: Uint8Array }>();
    for (const [chunkName, target] of chunkPaths) {
      Object.defineProperty(chunks, chunkName, {
        enumerable: true,
        configurable: true,
        get: () => {
          const cached = chunkCache.get(chunkName);
          if (cached) return cached;
          const payload: { code: string; gzipped?: Uint8Array } = {
            code: readFileSync(target.real, 'utf-8'),
            ...(target.gzReal !== undefined ? { gzipped: readFileSync(target.gzReal) } : {}),
          };
          chunkCache.set(chunkName, payload);
          return payload;
        },
      });
    }
  }
  return {
    code: readFileSync(entryReal, 'utf-8'),
    contentHash: entry.contentHash,
    gzipped: entryGzReal !== undefined ? readFileSync(entryGzReal) : undefined,
    exports: [...entry.exports],
    ...(chunks ? { chunks } : {}),
  };
}

/**
 * Pure file reader for prebuilt `dist-client` bundles (zero `esbuild` dependency).
 * Validates `manifest.json` schema, containment inside `prebuiltDir`, and backing file presence.
 */
export function readPrebuiltClientBundle(
  prebuiltDir: string,
  moduleRef: string,
  chunk?: string,
  pluginId = 'prebuilt',
): PluginClientBundle {
  assertModuleRefShape(pluginId, moduleRef);
  if (chunk !== undefined) {
    assertPrebuiltChunkName(pluginId, chunk);
  }
  const { rootReal, manifest } = readPrebuiltClientManifest(prebuiltDir, pluginId);
  const verified = assertPrebuiltEntryIntegrity(rootReal, prebuiltDir, moduleRef, manifest, pluginId);
  return materializePrebuiltBundle(prebuiltDir, moduleRef, verified, chunk, pluginId);
}

export interface PluginClientAssetsLookup {
  clientRoot?: string;
  prebuiltClientDir?: string;
}

export interface ClientModuleOptions {
  chunk?: string;
  hash?: string;
  getPluginLifecycle: (pluginId: string) => {
    identity: unknown;
    enabled: boolean;
    phase: string;
    epoch: number;
    clientRoot?: string;
    prebuiltClientDir?: string;
    npmDependencies?: Readonly<Record<string, string>>;
  } | undefined;
  dataDir: string;
  isDisposed: () => boolean;
}

export type ClientLifecycleLookup = Pick<ClientModuleOptions, 'getPluginLifecycle' | 'dataDir' | 'isDisposed'>;

export class UiRegistry {
  private ui = new Map<string, PluginUiContribution[]>();
  private clientHashes = new Map<string, Map<string, string>>();

  constructor(
    private readonly buildProvider?: PluginBuildProvider,
    private readonly getPluginAssets?: (pluginId: string) => PluginClientAssetsLookup | undefined,
  ) {}

  registerUi(
    pluginId: string,
    surface: string,
    spec: unknown,
    fnName: string,
    clientAssets?: string | PluginClientAssetsLookup,
  ): void {
    if (!isPlainObject(spec)) {
      throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.${fnName} spec must be a plain object`, 400);
    }
    const id = spec.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.${fnName} declaration is missing id`, 400);
    }

    let list = this.ui.get(pluginId);
    if (!list) {
      list = [];
      this.ui.set(pluginId, list);
    }
    if (list.some((u) => u.surface === surface && (u.spec as { id?: string }).id === id)) {
      throw new HelmError('duplicate_ui', `plugin ${pluginId} already declared id ${id} in ${surface}`, 409);
    }

    // priority / order: when provided, must be a finite safe integer (invalid values would silently corrupt sort order).
    for (const field of ['priority', 'order'] as const) {
      const value = spec[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
        throw new HelmError(
          'invalid_ui_spec',
          `plugin ${pluginId} ui.${fnName} ${field} must be a safe integer (actual: ${String(value)})`,
          400,
          { pluginId, id, field },
        );
      }
    }

    // display copy fields: uniform display-metadata guard for every surface —
    // when label / title / description is declared it must be a plain string or
    // a supported-locale map with non-blank values (parseNonEmptyLocalizedText).
    // Surface-specific required-ness stays in the dedicated validators below.
    for (const field of ['label', 'title', 'description'] as const) {
      const value = spec[field];
      if (value !== undefined && parseNonEmptyLocalizedText(value) === undefined) {
        throw new HelmError(
          'invalid_ui_spec',
          `plugin ${pluginId} ui.${fnName}  ${field} must be display copy (non-empty string or { en, 'zh-CN' } map with non-blank values)`,
          400,
          { pluginId, id, field },
        );
      }
    }

    const lifecycleAssets = this.getPluginAssets?.(pluginId);
    const clientRoot =
      typeof clientAssets === 'string'
        ? clientAssets
        : (clientAssets?.clientRoot ?? lifecycleAssets?.clientRoot);
    const prebuiltClientDir =
      typeof clientAssets === 'object' && clientAssets !== null
        ? (clientAssets.prebuiltClientDir ?? lifecycleAssets?.prebuiltClientDir)
        : lifecycleAssets?.prebuiltClientDir;

    // Two-phase surface validation (see ui-spec-validators.ts): early checks
    // (UI action / commandPalette / profile.runtime / plugin.slot) run before scope
    // and client-ref validation, while late checks run right after in exact original order.
    const ctx: UiSpecContext = {
      pluginId,
      fnName,
      surface,
      clientRoot: clientRoot ?? prebuiltClientDir,
      hasBuildProvider: this.buildProvider !== undefined || prebuiltClientDir !== undefined,
      siblings: list,
    };
    validateUiSpecEarly(surface, spec, id, ctx);

    // Validate scope at registration time so invalid scopes cannot slip into rendering.
    assertConversationScope(pluginId, `Plugin ${pluginId} ui.${fnName}`, spec.scope);

    // Client reference: definition must provide `clientRoot` or `prebuiltClientDir` and a valid relative `.ts/.tsx` module.
    const client = spec.client;
    if (client !== undefined) {
      if (clientRoot === undefined && prebuiltClientDir === undefined) {
        throw new HelmError(
          'invalid_ui_spec',
          `Plugin ${pluginId} ui.${fnName} declared a client reference, but definition did not provide clientRoot or prebuiltClientDir`,
          400,
          { pluginId },
        );
      }
      if (!isPlainObject(client) || Object.keys(client).some((k) => k !== 'module' && k !== 'export')) {
        throw new HelmError('invalid_ui_spec', `Plugin ${pluginId} ui.${fnName} client may only contain { module, export }`, 400);
      }
      const moduleRef = String(client.module ?? '');
      assertModuleRefShape(pluginId, moduleRef);
      if (typeof client.export !== 'string' || client.export.length === 0 || !/^[A-Za-z0-9_$]+$/.test(client.export)) {
        throw new HelmError(
          'invalid_ui_spec',
          `Plugin ${pluginId} ui.${fnName} client.export must be a valid non-empty export identifier`,
          400,
        );
      }
      if (prebuiltClientDir !== undefined) {
        // Prebuilt track: verify manifest integrity, declared module, containment, backing files,
        // and exported symbol upfront — no buildProvider needed and never falls back to clientRoot.
        const { rootReal, manifest } = readPrebuiltClientManifest(prebuiltClientDir, pluginId);
        const { entry } = assertPrebuiltEntryIntegrity(rootReal, prebuiltClientDir, moduleRef, manifest, pluginId);
        if (!entry.exports.includes(client.export)) {
          throw new HelmError(
            'invalid_client_export',
            `Plugin ${pluginId} ui.${fnName} prebuilt module ${moduleRef} does not export "${client.export}" (exports: ${entry.exports.join(', ') || 'none'})`,
            422,
            { pluginId, fnName, module: moduleRef, export: client.export, exports: entry.exports },
          );
        }
      } else if (this.buildProvider === undefined) {
        // Require build port upfront for source-compiled plugins: fail registration rather than silently discarding client UI.
        throw new HelmError(
          'unsupported_client_build',
          `Plugin ${pluginId} ui.${fnName} declared a client reference, but host has no build port (PluginHostOptions.buildProvider) to compile client modules`,
          501,
          { pluginId, fnName, module: moduleRef },
        );
      }
    }

    validateUiSpecLate(surface, spec, id, ctx);

    // declaration track path only accept can JSON serialization spec(HTTP/SSE directly JSON output);
    // structuredClone accept Map/Set/Date but JSON.stringify will change shape lose data, must explicit reject.
    // The client.tsx pipeline is owned by the web compiler (this module does not compile).
    let normalized: unknown;
    try {
      normalized = jsonClone(spec);
    } catch (err) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.${fnName} declaration spec must can JSON serialization (client.tsx reference please use client field)` +
          `:${err instanceof Error ? err.message : String(err)}`,
        400,
      );
    }
    list.push({ pluginId, surface, spec: normalized });
  }

  /**
   * definePlugin after completion tail unify validate: declaration style docs/sessionDocs track path already whole remove
   * (JSON Spec migrate out kernel), this method no longer has must validate document reference; keep method supply
   * PluginHost lifecycle hang point, await badge etc. client track derived validate requirement appear when extend.
   */
  assertUiDocsRegistered(
    _pluginId: string,
    _hasPublicDoc: (docName: string) => boolean,
    _hasPublicSessionDoc: (docName: string) => boolean = () => false,
  ): void {
    void _pluginId; void _hasPublicDoc; void _hasPublicSessionDoc;
  }

  /**
   * across plugin uniqueness final inspect: all enabled plugin (contains await commit pending) UI contribution in:
   * - profile.runtime  kind must not duplicate (many plugin declaration the same kind will let Profile
   *   runtime table single appear ambiguity, explicit reject while non- by order swallow);
   * - commandPalette  slash must not duplicate (/completion list trigger term must unique).
   *
   * by PluginHost in enable commit point (enabled=true the same sync chunk) invoke:define phase
   * mention before check only than for plugin itself (by default deactivate probe enabled:false does not occupy global name); two
   * plugin concurrency enable when each define check all may via, but serial commit point final inspect guarantee at most
   * a expose duplicate items (after to explicit reject and rollback).pending also in activePluginIds in when
   * skip iterate in it, tail only sweep once, avoid the same plugin self than for mistakenly report.
   */
  assertCrossPluginUnique(pluginId: string, activePluginIds: Iterable<string>): void {
    const kindOwners = new Map<string, string>();
    const slashOwners = new Map<string, string>();
    const sweep = (ownerPluginId: string): void => {
      const list = this.ui.get(ownerPluginId);
      if (!list) return;
      for (const u of list) {
        const spec = u.spec as { kind?: unknown; slash?: unknown };
        if (u.surface === 'profile.runtime' && typeof spec.kind === 'string') {
          const prev = kindOwners.get(spec.kind);
          if (prev !== undefined) {
            throw new HelmError(
              'duplicate_profile_runtime_kind',
              `plugin ${ownerPluginId} declaration profile.runtime kind "${spec.kind}" already by plugin ${prev} occupy`,
              409,
              { pluginId: ownerPluginId, kind: spec.kind, ownerPluginId: prev },
            );
          }
          kindOwners.set(spec.kind, ownerPluginId);
        }
        if (u.surface === 'commandPalette' && typeof spec.slash === 'string') {
          const prev = slashOwners.get(spec.slash);
          if (prev !== undefined) {
            throw new HelmError(
              'duplicate_command_slash',
              `plugin ${ownerPluginId} declaration command slash trigger term /${spec.slash} already by plugin ${prev} occupy`,
              409,
              { pluginId: ownerPluginId, slash: spec.slash, ownerPluginId: prev },
            );
          }
          slashOwners.set(spec.slash, ownerPluginId);
        }
      }
    };
    for (const activeId of activePluginIds) {
      if (activeId === pluginId) continue;
      sweep(activeId);
    }
    sweep(pluginId);
  }

  listUi(activePluginIds?: Iterable<string>): PluginUiContribution[] {
    const out: PluginUiContribution[] = [];
    if (activePluginIds) {
      for (const pluginId of activePluginIds) {
        const list = this.ui.get(pluginId);
        if (!list) continue;
        for (const u of list) out.push({ ...u, spec: structuredClone(u.spec) });
      }
      return out;
    }
    for (const list of this.ui.values()) {
      for (const u of list) out.push({ ...u, spec: structuredClone(u.spec) });
    }
    return out;
  }

  /** this plugin declaration all profile.runtime kind(deactivate preflight host reference probe source). */
  getProfileRuntimeKinds(pluginId: string): string[] {
    const list = this.ui.get(pluginId);
    if (!list) return [];
    const kinds: string[] = [];
    for (const u of list) {
      if (u.surface !== 'profile.runtime') continue;
      const kind = (u.spec as { kind?: unknown }).kind;
      if (typeof kind === 'string' && kind.length > 0) kinds.push(kind);
    }
    return kinds;
  }

  getUiByPlugin(pluginId: string): PluginUiContribution[] {
    const list = this.ui.get(pluginId);
    if (!list) return [];
    return list.map((u) => ({ ...u, spec: structuredClone(u.spec) }));
  }

  /** Distinct client module references declared by this plugin's UI contributions (in declaration order). */
  getDeclaredClientModules(pluginId: string): string[] {
    const list = this.ui.get(pluginId);
    if (!list || list.length === 0) return [];
    const seen = new Set<string>();
    const modules: string[] = [];
    for (const contribution of list) {
      const client = (contribution.spec as { client?: { module?: unknown } }).client;
      if (client && typeof client.module === 'string' && !seen.has(client.module)) {
        seen.add(client.module);
        modules.push(client.module);
      }
    }
    return modules;
  }

  /** Return a snapshot of cached client module hashes (`moduleRef -> contentHash`), or undefined if none compiled. */
  getClientHashes(pluginId: string): Record<string, string> | undefined {
    const hashes = this.clientHashes.get(pluginId);
    if (!hashes || hashes.size === 0) return undefined;
    return Object.fromEntries(hashes);
  }

  /**
   * Compile every declared client UI module for `pluginId` during registration/enable/reload
   * and cache the resulting `contentHash` map on `UiRegistry`. Failures propagate without
   * swallowing or fabricating hashes.
   */
  async precompileClientModules(pluginId: string, options: ClientLifecycleLookup): Promise<void> {
    if (options.isDisposed()) {
      throw new HelmError('plugin_host_disposed', 'PluginHost has already been disposed', 409);
    }
    const modules = this.getDeclaredClientModules(pluginId);
    if (modules.length === 0) {
      this.clientHashes.delete(pluginId);
      return;
    }
    const compiled = await Promise.all(
      modules.map(async (moduleRef) => {
        const bundle = await this.compileModuleChecked(pluginId, moduleRef, options, 'defining-or-idle');
        return [moduleRef, bundle.contentHash] as const;
      }),
    );
    if (options.isDisposed()) {
      throw new HelmError('plugin_host_disposed', 'PluginHost has already been disposed', 409);
    }
    const hashes = new Map<string, string>();
    for (const [moduleRef, contentHash] of compiled) {
      hashes.set(moduleRef, contentHash);
    }
    this.clientHashes.set(pluginId, hashes);
  }

  private assertClientLifecyclePhase(
    pluginId: string,
    moduleRef: string,
    options: ClientLifecycleLookup,
    allowedPhases: 'idle-only' | 'defining-or-idle',
  ) {
    if (options.isDisposed()) {
      throw new HelmError('plugin_host_disposed', 'PluginHost has already been disposed', 409);
    }
    const info = options.getPluginLifecycle(pluginId);
    const phaseOk =
      info !== undefined &&
      ((info.enabled && info.phase === 'idle') || (allowedPhases === 'defining-or-idle' && info.phase === 'defining'));
    if (!phaseOk) {
      throw new HelmError('plugin_client_unavailable', `Plugin ${pluginId} is not enabled; client module unavailable`, 409, {
        pluginId,
        module: moduleRef,
      });
    }
    return info;
  }

  private async compileModuleChecked(
    pluginId: string,
    moduleRef: string,
    options: ClientLifecycleLookup,
    allowedPhases: 'idle-only' | 'defining-or-idle',
  ): Promise<PluginClientBundle> {
    assertModuleRefShape(pluginId, moduleRef);
    const info = this.assertClientLifecyclePhase(pluginId, moduleRef, options, allowedPhases);
    if (info.prebuiltClientDir !== undefined) {
      return readPrebuiltClientBundle(info.prebuiltClientDir, moduleRef, undefined, pluginId);
    }
    const clientRoot = info.clientRoot;
    if (clientRoot === undefined) {
      throw new HelmError('plugin_client_unavailable', `Plugin ${pluginId} did not declare clientRoot`, 404, { pluginId });
    }
    const identity = info.identity;
    const epoch = info.epoch;
    // Build port is injected via PluginHostOptions; never fabricate empty artifacts when missing.
    const provider = this.buildProvider;
    if (provider === undefined) {
      throw new HelmError(
        'unsupported_client_build',
        `Host has not wired plugin build port (PluginHostOptions.buildProvider): cannot serve client module ${moduleRef} for plugin ${pluginId}`,
        501,
        { pluginId, module: moduleRef },
      );
    }
    // Managed npm dependencies declared in manifest -> resolved relative to plugin directory.
    const npmRoots: PluginClientNpmRoot[] = clientNpmRootsOf(info.npmDependencies);
    const result = await provider.compileClientModule({
      pluginId,
      clientRoot,
      moduleRef,
      cacheDir: options.dataDir,
      npmRoots,
    });
    const current = options.getPluginLifecycle(pluginId);
    const currentPhaseOk =
      current !== undefined &&
      ((current.enabled && current.phase === 'idle') ||
        (allowedPhases === 'defining-or-idle' && current.phase === 'defining'));
    if (
      options.isDisposed() ||
      !currentPhaseOk ||
      current.identity !== identity ||
      current.epoch !== epoch
    ) {
      throw new HelmError(
        'plugin_client_unavailable',
        `plugin ${pluginId} was deactivated or entered a new enable cycle before client module compilation completed; discarding artifact`,
        409,
        { pluginId, module: moduleRef },
      );
    }
    if (typeof result.contentHash !== 'string' || result.contentHash.length === 0) {
      throw new HelmError(
        'client_compile_failed',
        `plugin ${pluginId} client module ${moduleRef} produced invalid empty contentHash`,
        500,
        { pluginId, module: moduleRef },
      );
    }
    return result;
  }

  private assertClientModuleHashMatches(
    pluginId: string,
    moduleRef: string,
    actualHash: string,
    requestedHash: string | undefined,
    chunk: string | undefined,
  ): void {
    if (requestedHash === undefined || (requestedHash.length > 0 && requestedHash === actualHash)) {
      return;
    }
    if (chunk !== undefined) {
      throw new HelmError(
        'client_chunk_stale',
        `plugin ${pluginId} requested chunk hash (${requestedHash}) does not match current artifact hash (${actualHash})`,
        409,
        { pluginId, module: moduleRef, chunk, hash: requestedHash, currentHash: actualHash },
      );
    }
    throw new HelmError(
      'client_module_stale',
      `plugin ${pluginId} requested client module hash (${requestedHash}) does not match current artifact hash (${actualHash})`,
      409,
      { pluginId, module: moduleRef, hash: requestedHash, currentHash: actualHash },
    );
  }

  async getClientModule(
    pluginId: string,
    moduleRef: string,
    options: ClientModuleOptions,
  ): Promise<PluginClientBundle> {
    if (options.isDisposed()) {
      throw new HelmError('plugin_host_disposed', 'PluginHost is already disposed', 409);
    }
    assertModuleRefShape(pluginId, moduleRef);
    if (options.chunk !== undefined) {
      if (
        typeof options.chunk !== 'string' ||
        !/^[A-Za-z0-9._-]+\.js$/.test(options.chunk) ||
        options.chunk.includes('..')
      ) {
        throw new HelmError(
          'invalid_client_module',
          `plugin ${pluginId} invalid chunk module name (must match /^[A-Za-z0-9._-]+\\.js$/ and exclude ..): ${String(options.chunk)}`,
          400,
          { pluginId, chunk: String(options.chunk) },
        );
      }
    }
    const info = this.assertClientLifecyclePhase(pluginId, moduleRef, options, 'idle-only');
    if (info.prebuiltClientDir !== undefined) {
      const { rootReal, manifest } = readPrebuiltClientManifest(info.prebuiltClientDir, pluginId);
      const verified = assertPrebuiltEntryIntegrity(
        rootReal,
        info.prebuiltClientDir,
        moduleRef,
        manifest,
        pluginId,
      );
      const trackedHashes = this.clientHashes.get(pluginId);
      if (trackedHashes?.has(moduleRef)) {
        trackedHashes.set(moduleRef, verified.entry.contentHash);
      }
      this.assertClientModuleHashMatches(
        pluginId,
        moduleRef,
        verified.entry.contentHash,
        options.hash,
        options.chunk,
      );
      return materializePrebuiltBundle(info.prebuiltClientDir, moduleRef, verified, options.chunk, pluginId);
    }
    const result = await this.compileModuleChecked(pluginId, moduleRef, options, 'idle-only');
    // Keep precompiled hash map aligned when a declared module is recompiled after source edit.
    const trackedHashes = this.clientHashes.get(pluginId);
    if (trackedHashes?.has(moduleRef)) {
      trackedHashes.set(moduleRef, result.contentHash);
    }

    this.assertClientModuleHashMatches(pluginId, moduleRef, result.contentHash, options.hash, options.chunk);

    if (options.chunk !== undefined) {
      const chunkData = result.chunks?.[options.chunk];
      if (!chunkData) {
        throw new HelmError(
          'client_chunk_not_found',
          `plugin ${pluginId} module ${moduleRef} did not generate chunk: ${options.chunk}`,
          404,
          { pluginId, module: moduleRef, chunk: options.chunk },
        );
      }
      return {
        code: chunkData.code,
        contentHash: result.contentHash,
        gzipped: chunkData.gzipped,
        exports: [],
      };
    }

    return result;
  }

  clear(pluginId: string): void {
    const list = this.ui.get(pluginId);
    if (list) list.length = 0;
    this.clientHashes.delete(pluginId);
  }

  removePlugin(pluginId: string): void {
    this.ui.delete(pluginId);
    this.clientHashes.delete(pluginId);
  }
}
