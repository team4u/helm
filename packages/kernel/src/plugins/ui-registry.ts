/**
 * ui-registry.ts: negative duty 7 large all UI frontend extension point collect and validate, combine build port (PluginBuildProvider) module validate and artifact manage.
 *
 * responsibility:
 * - collect sidebar, screen, timeline, markdown.codeBlock, tool, composer, workbench,
 *   commandPalette, settingsPanel, profile.runtime, UI action (header/row/entry) and
 *   plugin.slot etc. UI declaration (unify client.tsx track path);
 * - declaration boundary static validate (id uniqueness,priority/order security integer, command slash and host keep term,
 *   UI action target archive one and action/client track at least its one,markdown.codeBlock language table shape,
 *   slot target shape,artifact.previewer  MIME/suffix match declaration,composer.completer 
 *   completion source mutual exclusion and disable track,ConversationScope pure object validate,JSON-safe serialization fidelity);
 * - client.tsx motion state component reference shape validate (assertModuleRefShape) and clientRoot ownership validate;
 * - get already compile client module artifact, and strictly validate lifecycle and epoch state (guard against deactivated/already round rotate plugin return dirty artifact);
 * - enable commit point across plugin uniqueness final inspect (profile.runtime kind and commandPalette slash),
 *   by PluginHost in enable commit chunk invoke; by default deactivate probe register does not occupy global name.
 */
import {
  HelmError,
  assertModuleRefShape,
  clientNpmRootsOf,
  type PluginBuildProvider,
  type PluginClientBundle,
  type PluginClientNpmRoot,
  type PluginUiContribution,
} from '@helm/protocol';
import { assertConversationScope, isPlainObject, jsonClone } from './shared.js';
import {
  UI_ACTION_SURFACES,
  validateUiSpecEarly,
  validateUiSpecLate,
  type UiSpecContext,
} from './ui-spec-validators.js';

/** UI action three class target to register surface mapping (plugin-context and validate shared use; define see ui-spec-validators.ts). */
export { UI_ACTION_SURFACES } from './ui-spec-validators.js';

export interface ClientModuleOptions {
  chunk?: string;
  hash?: string;
  getPluginLifecycle: (pluginId: string) => {
    identity: unknown;
    enabled: boolean;
    phase: string;
    epoch: number;
    clientRoot?: string;
    npmDependencies?: Readonly<Record<string, string>>;
  } | undefined;
  dataDir: string;
  isDisposed: () => boolean;
}

export type ClientLifecycleLookup = Pick<ClientModuleOptions, 'getPluginLifecycle' | 'dataDir' | 'isDisposed'>;

export class UiRegistry {
  private ui = new Map<string, PluginUiContribution[]>();
  private clientHashes = new Map<string, Map<string, string>>();

  constructor(private readonly buildProvider?: PluginBuildProvider) {}

  registerUi(pluginId: string, surface: string, spec: unknown, fnName: string, clientRoot?: string): void {
    if (!isPlainObject(spec)) {
      throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.${fnName}  spec must be pure object`, 400);
    }
    const id = spec.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.${fnName} declaration missing id`, 400);
    }

    let list = this.ui.get(pluginId);
    if (!list) {
      list = [];
      this.ui.set(pluginId, list);
    }
    if (list.some((u) => u.surface === surface && (u.spec as { id?: string }).id === id)) {
      throw new HelmError('duplicate_ui', `plugin ${pluginId} in ${surface} duplicate declaration id ${id}`, 409);
    }

    // priority/sort field: if provide must is finite security integer (illegal value will let trim decide order static default lose control).
    for (const field of ['priority', 'order'] as const) {
      const value = spec[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
        throw new HelmError(
          'invalid_ui_spec',
          `plugin ${pluginId} ui.${fnName}  ${field} must be security integer (actual:${String(value)})`,
          400,
          { pluginId, id, field },
        );
      }
    }

    // surface dedicated belong validate two phase dispatch (see ui-spec-validators.ts document): early chunk
    // (UI action / commandPalette / profile.runtime / plugin.slot) first at through use
    // scope and client reference validate, late phase chunk in its after - - and split before one by one chunk order strictly consistent.
    const ctx: UiSpecContext = {
      pluginId,
      fnName,
      surface,
      clientRoot,
      hasBuildProvider: this.buildProvider !== undefined,
      siblings: list,
    };
    validateUiSpecEarly(surface, spec, id, ctx);

    // scope in register boundary i.e. validate (illegal scope will let render visible static default lose control)
    assertConversationScope(pluginId, `plugin ${pluginId} ui.${fnName} declaration`, spec.scope);

    // client reference: must plugin define provide clientRoot, and module shape legal (each other for .ts/.tsx);
    // dangling reference (cannot compile) in register boundary reject, never to render phase at static default whitespace.
    const client = spec.client;
    if (client !== undefined) {
      if (clientRoot === undefined) {
        throw new HelmError(
          'invalid_ui_spec',
          `plugin ${pluginId} ui.${fnName} declaration client reference but plugin define not provide clientRoot`,
          400,
          { pluginId },
        );
      }
      if (!isPlainObject(client) || Object.keys(client).some((k) => k !== 'module' && k !== 'export')) {
        throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.${fnName}  client only allows { module, export }`, 400);
      }
      assertModuleRefShape(pluginId, String(client.module ?? ''));
      if (typeof client.export !== 'string' || client.export.length === 0 || !/^[A-Za-z0-9_$]+$/.test(client.export)) {
        throw new HelmError(
          'invalid_ui_spec',
          `plugin ${pluginId} ui.${fnName}  client.export must be non-empty legal export name`,
          400,
        );
      }
      // build port in register boundary final inspect: without provider host cannot compile client.tsx,
      // explicit reject the whole declaration (plugin enable failed) while non- static default discard UI contribution.
      if (this.buildProvider === undefined) {
        throw new HelmError(
          'unsupported_client_build',
          `plugin ${pluginId} ui.${fnName} declaration client reference, but host not inject plugin build port (PluginHostOptions.buildProvider): cannot compile client.tsx, explicit reject while non- static default discard UI`,
          501,
          { pluginId, fnName, module: String(client.module ?? '') },
        );
      }
    }

    validateUiSpecLate(surface, spec, id, ctx);

    // declaration track path only accept can JSON serialization spec(HTTP/SSE directly JSON output);
    // structuredClone accept Map/Set/Date but JSON.stringify will change shape lose data, must explicit reject.
    // client.tsx track path by web compiler negative duty (this module do not compile).
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
      throw new HelmError('plugin_host_disposed', 'PluginHost already dispose', 409);
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
      throw new HelmError('plugin_host_disposed', 'PluginHost already dispose', 409);
    }
    const hashes = new Map<string, string>();
    for (const [moduleRef, contentHash] of compiled) {
      hashes.set(moduleRef, contentHash);
    }
    this.clientHashes.set(pluginId, hashes);
  }

  private async compileModuleChecked(
    pluginId: string,
    moduleRef: string,
    options: ClientLifecycleLookup,
    allowedPhases: 'idle-only' | 'defining-or-idle',
  ): Promise<PluginClientBundle> {
    if (options.isDisposed()) {
      throw new HelmError('plugin_host_disposed', 'PluginHost already dispose', 409);
    }
    assertModuleRefShape(pluginId, moduleRef);
    const info = options.getPluginLifecycle(pluginId);
    const phaseOk =
      info !== undefined &&
      ((info.enabled && info.phase === 'idle') || (allowedPhases === 'defining-or-idle' && info.phase === 'defining'));
    if (!phaseOk) {
      throw new HelmError('plugin_client_unavailable', `plugin ${pluginId} not enabled, do not provide client module`, 409, {
        pluginId,
        module: moduleRef,
      });
    }
    const clientRoot = info.clientRoot;
    if (clientRoot === undefined) {
      throw new HelmError('plugin_client_unavailable', `plugin ${pluginId} not declaration clientRoot`, 404, { pluginId });
    }
    const identity = info.identity;
    const epoch = info.epoch;
    // build port by PluginHostOptions inject (produce product in hub connect line by default implement); missing when
    // explicit 501, never static default return empty artifact or fall back inside placement compiler.
    const provider = this.buildProvider;
    if (provider === undefined) {
      throw new HelmError(
        'unsupported_client_build',
        `host not inject plugin build port (PluginHostOptions.buildProvider): cannot provide plugin ${pluginId}  client module ${moduleRef}`,
        501,
        { pluginId, module: moduleRef },
      );
    }
    // subject to control npm dependency: define declaration specifiers -> parse aggregate (and doctor chain the same mapping opening path).
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
        `plugin ${pluginId} in client module compile complete before deactivated or enter new enable cycle, artifact act abandon`,
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

  async getClientModule(
    pluginId: string,
    moduleRef: string,
    options: ClientModuleOptions,
  ): Promise<PluginClientBundle> {
    if (options.isDisposed()) {
      throw new HelmError('plugin_host_disposed', 'PluginHost already dispose', 409);
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
          `plugin ${pluginId}  chunk module name illegal (must match /^[A-Za-z0-9._-]+\\.js$/ and excludes ..):${String(options.chunk)}`,
          400,
          { pluginId, chunk: String(options.chunk) },
        );
      }
    }
    const result = await this.compileModuleChecked(pluginId, moduleRef, options, 'idle-only');
    // Keep precompiled hash map aligned when a declared module is recompiled after source edit.
    const trackedHashes = this.clientHashes.get(pluginId);
    if (trackedHashes?.has(moduleRef)) {
      trackedHashes.set(moduleRef, result.contentHash);
    }

    if (options.hash !== undefined && (options.hash.length === 0 || options.hash !== result.contentHash)) {
      if (options.chunk !== undefined) {
        throw new HelmError(
          'client_chunk_stale',
          `plugin ${pluginId} request chunk hash (${options.hash}) and when before artifact hash (${result.contentHash}) does not match`,
          409,
          { pluginId, module: moduleRef, chunk: options.chunk, hash: options.hash, currentHash: result.contentHash },
        );
      }
      throw new HelmError(
        'client_module_stale',
        `plugin ${pluginId} request client module hash (${options.hash}) and current artifact hash (${result.contentHash}) does not match`,
        409,
        { pluginId, module: moduleRef, hash: options.hash, currentHash: result.contentHash },
      );
    }

    if (options.chunk !== undefined) {
      const chunkData = result.chunks?.[options.chunk];
      if (!chunkData) {
        throw new HelmError(
          'client_chunk_not_found',
          `plugin ${pluginId} module ${moduleRef} not generate chunk: ${options.chunk}`,
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
