/**
 * doc-registry.ts: manages plugin public/session documents (`PluginDoc` / `PluginSessionDoc`).
 *
 * Responsibilities:
 * - Track registrations and handles for plugin-scoped `doc` and conversation-scoped `sessionDoc`;
 * - Isolate reads/writes across plugins (`pluginId:name` globally, `(pluginId, name, conversationId)` per session);
 * - Support durable storage via `PluginDocStore` / `PluginSessionDocStore` as well as in-memory transient
 *   documents (`durable: false`) without touching SQLite, while preserving 2 MiB validation and public SSE streams.
 *
 * Namespace rule: `doc` and `sessionDoc` share the per-plugin document name space (duplicate names across them
 * are rejected) to prevent routing ambiguity on `GET /api/plugins/:id/docs/:name`.
 */
import {
  HelmError,
  type PluginDocHandle,
  type PluginDocOptions,
  type PluginSessionDocHandle,
  type PublicPluginDoc,
  type PublicPluginSessionDoc,
} from '@helm/protocol';
import { assertValidId, isPlainObject, jsonClone } from './shared.js';

export interface PluginDocStore {
  get<T>(key: string, initial: T): T;
  set<T>(key: string, value: T): void;
  /** Delete all global documents belonging to a plugin (`${pluginId}:` prefix); used for uninstall cleanup. */
  deletePlugin(pluginId: string): void;
  /** Wait for all queued writes to be durably persisted (in-memory mirror updates do not guarantee flush; rejects on failure). */
  flush(): Promise<void>;
}

/**
 * Durable backing store for plugin session documents keyed by `(pluginId, name, conversationId)`.
 * `get` returns the raw JSON string (or `undefined` if unwritten); `put`/`delete` update the sync mirror
 * and enqueue writes; `flush` awaits real persistence and rejects explicitly on failure. Missing this port
 * fails durable `sessionDoc` registration with 501 (no silent in-memory fallback).
 */
export interface PluginSessionDocStore {
  get(pluginId: string, name: string, conversationId: number): string | undefined;
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void;
  delete(pluginId: string, name: string, conversationId: number): void;
  /** Delete all session documents belonging to a plugin; used for uninstall cleanup. */
  deletePlugin(pluginId: string): void;
  listConversationIds(pluginId: string, name: string): number[];
  flush(): Promise<void>;
}

/** Registered `doc` metadata: handle, visibility, durability, and normalized initial value. */
export interface DocRegistration {
  handle: PluginDocHandle<unknown>;
  isPublic: boolean;
  durable: boolean;
  initial: unknown;
}

/** Registered `sessionDoc` metadata: handle, visibility, durability, and normalized initial/fallback value. */
export interface SessionDocRegistration {
  handle: PluginSessionDocHandle<unknown>;
  isPublic: boolean;
  durable: boolean;
  initial: unknown;
}

/** Host ports for plugin session documents (injected when constructing `PluginHost`). */
export interface PluginDocRegistryOptions {
  /** Durable store for `sessionDoc`; required whenever `durable !== false` (missing throws 501). */
  sessionStore?: PluginSessionDocStore;
  /**
   * Conversation existence check (adapted from host `getConversation`): invoked before tuple operations
   * so writes to deleted conversations fail cleanly with the host error (e.g. `conversation_not_found`).
   */
  assertConversationExists?: (conversationId: number) => void;
  /** Emits updates for public `sessionDoc` entries (deletions carry initial value with `deleted: true`). */
  emitSessionDocUpdated?: (doc: PublicPluginSessionDoc) => void;
  /**
   * Maximum serialized JSON size in bytes for any single document value (`initial` / `set` / `update`).
   * Defaults to `PLUGIN_DOC_MAX_JSON_BYTES` (2 MiB); smaller values may be injected in tests.
   */
  maxDocJsonBytes?: number;
}

/**
 * Maximum JSON-serialized byte size for a single `doc` / `sessionDoc` value: 2 MiB.
 * Prevents oversized payloads from stalling SQLite write queues or SSE snapshots;
 * writes exceeding this limit fail with `413 plugin_doc_too_large` before touching storage or events.
 */
export const PLUGIN_DOC_MAX_JSON_BYTES = 2 * 1024 * 1024;

export class PluginDocRegistry {
  private pluginDocs = new Map<string, Map<string, DocRegistration>>();
  private sessionDocs = new Map<string, Map<string, SessionDocRegistration>>();
  private transientDocs = new Map<string, Map<string, unknown>>();
  private transientSessionDocs = new Map<string, Map<string, Map<number, unknown>>>();

  constructor(
    private readonly store: PluginDocStore,
    private readonly emitDocUpdated: (pluginId: string, name: string, value: unknown) => void,
    private readonly options: PluginDocRegistryOptions = {},
  ) {}

  /**
   * Validates JSON serializability and enforces the byte limit in a single `JSON.stringify` pass,
   * returning the serialized JSON string so durable stores can persist it without re-serializing.
   */
  private serializeBoundedJson(
    pluginId: string,
    kind: 'doc' | 'sessionDoc',
    name: string,
    value: unknown,
    maxBytes = this.options.maxDocJsonBytes ?? PLUGIN_DOC_MAX_JSON_BYTES,
    extraDetails?: Record<string, unknown>,
  ): string {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      throw new HelmError(
        'invalid_json_value',
        `Plugin ${pluginId} ${kind} ${name} value cannot be serialized to JSON: ${error instanceof Error ? error.message : String(error)}`,
        400,
        { pluginId, name, kind, ...(extraDetails ?? {}) },
      );
    }
    // Defensive backstop: `jsonClone` already rejects undefined/functions/cycles.
    if (json === undefined) {
      throw new HelmError(
        'invalid_doc_value',
        `Plugin ${pluginId} ${kind} ${name} value cannot be serialized to JSON (top-level undefined or function)`,
        400,
        { pluginId, name, kind, ...(extraDetails ?? {}) },
      );
    }
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > maxBytes) {
      throw new HelmError(
        'plugin_doc_too_large',
        `Plugin ${pluginId} ${kind} ${name} JSON payload is ${bytes} bytes, exceeding limit of ${maxBytes} bytes (write rejected; previous value unchanged)`,
        413,
        { pluginId, name, kind, bytes, maxBytes, ...(extraDetails ?? {}) },
      );
    }
    return json;
  }

  private getTransientDoc(pluginId: string, name: string, initial: unknown): unknown {
    const map = this.transientDocs.get(pluginId);
    return structuredClone(map?.has(name) ? map.get(name) : initial);
  }

  private setTransientDoc(pluginId: string, name: string, value: unknown): void {
    let map = this.transientDocs.get(pluginId);
    if (!map) {
      map = new Map();
      this.transientDocs.set(pluginId, map);
    }
    map.set(name, value);
  }

  private setTransientSessionDoc(
    pluginId: string,
    name: string,
    conversationId: number,
    value: unknown,
  ): void {
    let byName = this.transientSessionDocs.get(pluginId);
    if (!byName) {
      byName = new Map();
      this.transientSessionDocs.set(pluginId, byName);
    }
    let byConv = byName.get(name);
    if (!byConv) {
      byConv = new Map();
      byName.set(name, byConv);
    }
    byConv.set(conversationId, value);
  }

  private deleteTransientSessionDocEntry(
    pluginId: string,
    name: string,
    conversationId: number,
  ): void {
    const byName = this.transientSessionDocs.get(pluginId);
    const byConv = byName?.get(name);
    if (!byName || !byConv) return;
    byConv.delete(conversationId);
    if (byConv.size === 0) byName.delete(name);
    if (byName.size === 0) this.transientSessionDocs.delete(pluginId);
  }

  private assertConversationAliveOrCleanup(conversationId: number): void {
    const assertConversationExists = this.options.assertConversationExists!;
    try {
      assertConversationExists(conversationId);
    } catch (err) {
      if (err instanceof HelmError && err.status === 404) {
        this.deleteConversation(conversationId);
      }
      throw err;
    }
  }

  private pruneDeadTransientConversations(pluginId: string, name: string): number[] {
    const byConv = this.transientSessionDocs.get(pluginId)?.get(name);
    if (!byConv || byConv.size === 0) return [];
    const assertConversationExists = this.options.assertConversationExists;
    if (!assertConversationExists) return [...byConv.keys()];
    for (const cid of [...byConv.keys()]) {
      try {
        assertConversationExists(cid);
      } catch (err) {
        if (err instanceof HelmError && err.status === 404) {
          this.deleteConversation(cid);
          continue;
        }
        throw err;
      }
    }
    return [...(this.transientSessionDocs.get(pluginId)?.get(name)?.keys() ?? [])];
  }

  private readDocValue(pluginId: string, name: string, durable: boolean, initial: unknown): unknown {
    return durable
      ? jsonClone(this.store.get(`${pluginId}:${name}`, initial as never))
      : this.getTransientDoc(pluginId, name, initial);
  }

  registerDoc<TState>(
    pluginId: string,
    name: string,
    initial: TState,
    opts: PluginDocOptions | undefined,
    assertUsable: () => void,
  ): PluginDocHandle<TState> {
    assertValidId('doc', name);
    this.assertDocOpts(pluginId, 'doc', name, opts);

    let docs = this.pluginDocs.get(pluginId);
    if (!docs) {
      docs = new Map();
      this.pluginDocs.set(pluginId, docs);
    }

    if (docs.has(name)) {
      throw new HelmError('duplicate_doc', `Plugin ${pluginId} declared duplicate doc ${name}`, 409);
    }
    // `doc` and `sessionDoc` share one namespace per plugin to avoid routing ambiguity.
    if (this.sessionDocs.get(pluginId)?.has(name)) {
      throw new HelmError(
        'duplicate_doc',
        `Plugin ${pluginId} declared duplicate document name ${name} (doc and sessionDoc share one namespace)`,
        409,
      );
    }

    const isPublic = opts?.public === true;
    const durable = opts?.durable !== false;
    const key = `${pluginId}:${name}`;
    const store = this.store;
    const normalizedInitial = jsonClone(initial);
    this.serializeBoundedJson(pluginId, 'doc', name, normalizedInitial);

    const readCurrent = (): TState =>
      this.readDocValue(pluginId, name, durable, normalizedInitial) as TState;

    const writeNext = (safe: TState): void => {
      // Enforce payload limit before touching storage/memory or emitting public events.
      this.serializeBoundedJson(pluginId, 'doc', name, safe);
      if (durable) {
        store.set(key, safe);
        if (isPublic) this.emitDocUpdated(pluginId, name, safe);
      } else {
        this.setTransientDoc(pluginId, name, safe);
        if (isPublic) this.emitDocUpdated(pluginId, name, structuredClone(safe));
      }
    };

    const handle: PluginDocHandle<TState> = {
      get: () => {
        assertUsable();
        return readCurrent();
      },
      set: (next) => {
        assertUsable();
        writeNext(jsonClone(next));
      },
      update: (fn) => {
        assertUsable();
        writeNext(jsonClone(fn(readCurrent())));
      },
      flush: async () => {
        assertUsable();
        return durable ? store.flush() : Promise.resolve();
      },
    };

    docs.set(name, {
      handle: handle as PluginDocHandle<unknown>,
      isPublic,
      durable,
      initial: normalizedInitial,
    });

    return handle;
  }

  registerSessionDoc<TState>(
    pluginId: string,
    name: string,
    initial: TState,
    opts: PluginDocOptions | undefined,
    assertUsable: () => void,
  ): PluginSessionDocHandle<TState> {
    assertValidId('sessionDoc', name);
    this.assertDocOpts(pluginId, 'sessionDoc', name, opts);
    const durable = opts?.durable !== false;
    // Durable sessionDoc requires a persistent store; never silently degrade to memory.
    if (durable && !this.options.sessionStore) {
      throw new HelmError(
        'session_doc_store_unavailable',
        `Plugin ${pluginId} declared durable sessionDoc ${name}, but no sessionDoc durable store is configured (sessionStore missing)`,
        501,
        { pluginId, name },
      );
    }
    // Never skip conversation existence validation (prevents orphaned writes after deletion).
    if (!this.options.assertConversationExists) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `Plugin ${pluginId} declared sessionDoc ${name}, but no conversation existence check port is configured (assertConversationExists missing)`,
        501,
        { pluginId, name },
      );
    }
    // Public docs must have an event emitter port; never silently drop updates.
    if (opts?.public === true && !this.options.emitSessionDocUpdated) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `Plugin ${pluginId} declared public sessionDoc ${name}, but no public sessionDoc event port is configured (emitSessionDocUpdated missing)`,
        501,
        { pluginId, name },
      );
    }
    // `doc` and `sessionDoc` share one namespace per plugin to avoid routing ambiguity on GET /api/plugins/:id/docs/:name.
    if (this.pluginDocs.get(pluginId)?.has(name) || this.sessionDocs.get(pluginId)?.has(name)) {
      throw new HelmError(
        'duplicate_doc',
        `Plugin ${pluginId} declared duplicate document name ${name} (doc and sessionDoc share one namespace)`,
        409,
      );
    }

    const isPublic = opts?.public === true;
    const normalizedInitial = jsonClone(initial);
    this.serializeBoundedJson(pluginId, 'sessionDoc', name, normalizedInitial);
    const handle = this.createSessionDocHandle(
      pluginId,
      name,
      normalizedInitial,
      isPublic,
      durable,
      assertUsable,
    );

    let docs = this.sessionDocs.get(pluginId);
    if (!docs) {
      docs = new Map();
      this.sessionDocs.set(pluginId, docs);
    }
    docs.set(name, {
      handle: handle as PluginSessionDocHandle<unknown>,
      isPublic,
      durable,
      initial: normalizedInitial,
    });

    return handle;
  }

  /**
   * Builds a `sessionDoc` handle guarded by `assertUsable` (host epoch & stop window) plus tuple checks
   * (`conversationId` must be a positive safe integer belonging to an existing conversation). Values are
   * always JSON deep-cloned on input and isolated on reads, and public docs emit `plugin.session_doc.updated`
   * (`deleted: true` sends initial value).
   */
  private createSessionDocHandle<TState>(
    pluginId: string,
    name: string,
    initial: TState,
    isPublic: boolean,
    durable: boolean,
    assertUsable: () => void,
  ): PluginSessionDocHandle<TState> {
    const store = this.options.sessionStore;
    const assertConversationExists = this.options.assertConversationExists!;
    const emitSessionDocUpdated = this.options.emitSessionDocUpdated;
    const emit = (conversationId: number, value: unknown, deleted?: boolean): void => {
      if (!isPublic) return;
      if (!emitSessionDocUpdated) {
        throw new HelmError(
          'session_doc_port_unavailable',
          `Plugin ${pluginId} public sessionDoc ${name} is missing its event emitter port`,
          501,
          { pluginId, name, conversationId },
        );
      }
      emitSessionDocUpdated({
        pluginId,
        name,
        conversationId,
        value,
        ...(deleted === true ? { deleted: true } : {}),
      });
    };
    const readRaw = (conversationId: number): TState => {
      if (!durable) {
        const byConv = this.transientSessionDocs.get(pluginId)?.get(name);
        return structuredClone(
          byConv?.has(conversationId) ? (byConv.get(conversationId) as TState) : initial,
        );
      }
      const raw = store!.get(pluginId, name, conversationId);
      return raw === undefined ? structuredClone(initial) : (JSON.parse(raw) as TState);
    };
    const writeNext = (conversationId: number, safe: TState): void => {
      // Enforce payload limit before touching storage/memory or emitting public events.
      const maxBytes = this.options.maxDocJsonBytes ?? PLUGIN_DOC_MAX_JSON_BYTES;
      const json = this.serializeBoundedJson(pluginId, 'sessionDoc', name, safe, maxBytes, {
        conversationId,
      });
      if (durable) {
        store!.put(pluginId, name, conversationId, json);
        if (isPublic) emit(conversationId, safe);
      } else {
        this.setTransientSessionDoc(pluginId, name, conversationId, safe);
        if (isPublic) emit(conversationId, structuredClone(safe));
      }
    };
    const assertTupleUsable = (conversationId: number): void => {
      assertUsable();
      this.assertSessionDocId(conversationId);
      this.assertConversationAliveOrCleanup(conversationId);
    };
    return {
      get: (conversationId) => {
        assertTupleUsable(conversationId);
        return readRaw(conversationId);
      },
      set: (conversationId, next) => {
        assertTupleUsable(conversationId);
        writeNext(conversationId, jsonClone(next));
      },
      update: (conversationId, fn) => {
        assertTupleUsable(conversationId);
        writeNext(conversationId, jsonClone(fn(readRaw(conversationId))));
      },
      delete: (conversationId) => {
        assertTupleUsable(conversationId);
        if (durable) {
          store!.delete(pluginId, name, conversationId);
        } else {
          this.deleteTransientSessionDocEntry(pluginId, name, conversationId);
        }
        // Deleting an unwritten or existing entry emits `deleted: true` with the initial value.
        if (isPublic) emit(conversationId, structuredClone(initial), true);
      },
      listConversationIds: () => {
        assertUsable();
        const ids = durable
          ? store!.listConversationIds(pluginId, name)
          : this.pruneDeadTransientConversations(pluginId, name);
        return [...ids].sort((a, b) => a - b);
      },
      flush: async () => {
        assertUsable();
        return durable ? store!.flush() : Promise.resolve();
      },
    };
  }

  /** Validates that `conversationId` is a positive safe integer (`400 invalid_conversation_id`). */
  private assertSessionDocId(conversationId: number): void {
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
      throw new HelmError(
        'invalid_conversation_id',
        `Session doc conversationId must be a positive safe integer, received: ${String(conversationId)}`,
        400,
        { conversationId: String(conversationId) },
      );
    }
  }

  /** Validates doc/sessionDoc options: only `{ public?: boolean, durable?: boolean }` are allowed. */
  private assertDocOpts(
    pluginId: string,
    kind: 'doc' | 'sessionDoc',
    name: string,
    opts: PluginDocOptions | undefined,
  ): void {
    if (
      opts !== undefined &&
      (!isPlainObject(opts) || Object.keys(opts).some((k) => k !== 'public' && k !== 'durable'))
    ) {
      throw new HelmError(
        'invalid_doc_spec',
        `Plugin ${pluginId} ${kind} ${name} options may only contain { public?: boolean, durable?: boolean }`,
        400,
      );
    }
    if (opts?.public !== undefined && typeof opts.public !== 'boolean') {
      throw new HelmError(
        'invalid_doc_spec',
        `Plugin ${pluginId} ${kind} ${name} option 'public' must be a boolean`,
        400,
      );
    }
    if (opts?.durable !== undefined && typeof opts.durable !== 'boolean') {
      throw new HelmError(
        'invalid_doc_spec',
        `Plugin ${pluginId} ${kind} ${name} option 'durable' must be a boolean`,
        400,
      );
    }
  }

  /**
   * Reads a public global `doc` snapshot. Private/undeclared docs and inactive plugins uniformly return 404
   * without leaking existence; unwritten docs fall back to the normalized initial value. Hitting a public
   * `sessionDoc` returns `400 session_doc_requires_conversation`.
   */
  getPublicDoc(pluginId: string, name: string, isPluginActive: boolean): PublicPluginDoc {
    if (!isPluginActive) {
      throw new HelmError('plugin_doc_not_found', `Plugin ${pluginId} has no public doc ${name}`, 404, {
        pluginId,
        name,
      });
    }
    const reg = this.pluginDocs.get(pluginId)?.get(name);
    if (!reg || !reg.isPublic) {
      if (this.sessionDocs.get(pluginId)?.get(name)?.isPublic === true) {
        throw new HelmError(
          'session_doc_requires_conversation',
          `Plugin ${pluginId} document ${name} is a sessionDoc; reading requires a conversationId query parameter`,
          400,
          { pluginId, name },
        );
      }
      throw new HelmError('plugin_doc_not_found', `Plugin ${pluginId} has no public doc ${name}`, 404, {
        pluginId,
        name,
      });
    }
    return {
      pluginId,
      name,
      value: this.readDocValue(pluginId, name, reg.durable, reg.initial),
    };
  }

  /**
   * Reads a public `sessionDoc` snapshot (used by HTTP GET and dedicated SSE initial snapshot frames).
   * Private/undeclared/inactive docs return 404; missing conversations propagate host error; hitting a
   * public global doc returns `400 global_doc_unexpected_conversation`.
   */
  getPublicSessionDoc(
    pluginId: string,
    name: string,
    conversationId: number,
    isPluginActive: boolean,
  ): PublicPluginSessionDoc {
    this.assertSessionDocId(conversationId);
    if (!isPluginActive) {
      throw new HelmError(
        'plugin_doc_not_found',
        `Plugin ${pluginId} has no public sessionDoc ${name}`,
        404,
        { pluginId, name, conversationId },
      );
    }
    const reg = this.sessionDocs.get(pluginId)?.get(name);
    if (!reg || !reg.isPublic) {
      if (this.pluginDocs.get(pluginId)?.get(name)?.isPublic === true) {
        throw new HelmError(
          'global_doc_unexpected_conversation',
          `Plugin ${pluginId} document ${name} is a global doc; do not pass conversationId`,
          400,
          { pluginId, name, conversationId },
        );
      }
      throw new HelmError(
        'plugin_doc_not_found',
        `Plugin ${pluginId} has no public sessionDoc ${name}`,
        404,
        { pluginId, name, conversationId },
      );
    }
    const assertConversationExists = this.options.assertConversationExists;
    if (!assertConversationExists) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `Plugin ${pluginId} sessionDoc ${name} is missing conversation existence check port`,
        501,
        { pluginId, name, conversationId },
      );
    }
    if (!reg.durable) {
      this.assertConversationAliveOrCleanup(conversationId);
      const byConv = this.transientSessionDocs.get(pluginId)?.get(name);
      return {
        pluginId,
        name,
        conversationId,
        value: structuredClone(byConv?.has(conversationId) ? byConv.get(conversationId) : reg.initial),
      };
    }
    const sessionStore = this.options.sessionStore;
    if (!sessionStore) {
      throw new HelmError(
        'session_doc_store_unavailable',
        `Plugin ${pluginId} durable sessionDoc ${name} is missing durable backing store (sessionStore missing)`,
        501,
        { pluginId, name, conversationId },
      );
    }
    assertConversationExists(conversationId);
    const raw = sessionStore.get(pluginId, name, conversationId);
    return {
      pluginId,
      name,
      conversationId,
      value: raw === undefined ? structuredClone(reg.initial) : JSON.parse(raw),
    };
  }

  /** Lists all public global doc snapshots for active plugins (for `HelmSnapshot.pluginDocs`). */
  listPublicDocs(activePluginIds: Iterable<string>): PublicPluginDoc[] {
    const out: PublicPluginDoc[] = [];
    for (const pluginId of activePluginIds) {
      const docs = this.pluginDocs.get(pluginId);
      if (!docs) continue;
      for (const [name, reg] of docs) {
        if (!reg.isPublic) continue;
        out.push({
          pluginId,
          name,
          value: this.readDocValue(pluginId, name, reg.durable, reg.initial),
        });
      }
    }
    return out;
  }

  /** Returns whether `pluginId` declared a public global doc named `name`. */
  hasPublicDoc(pluginId: string, name: string): boolean {
    return this.pluginDocs.get(pluginId)?.get(name)?.isPublic === true;
  }

  /** Returns whether `pluginId` declared a public sessionDoc named `name`. */
  hasPublicSessionDoc(pluginId: string, name: string): boolean {
    return this.sessionDocs.get(pluginId)?.get(name)?.isPublic === true;
  }

  /** Returns whether `pluginId` declared any in-memory transient (`durable: false`) sessionDoc. */
  hasTransientSessionDocs(pluginId: string): boolean {
    const docs = this.sessionDocs.get(pluginId);
    if (!docs) return false;
    for (const reg of docs.values()) {
      if (!reg.durable) return true;
    }
    return false;
  }

  /** Evicts in-memory transient `sessionDoc` entries for a deleted conversation across all plugins. */
  deleteConversation(conversationId: number): void {
    for (const [pluginId, byName] of this.transientSessionDocs) {
      for (const [name, byConv] of byName) {
        byConv.delete(conversationId);
        if (byConv.size === 0) byName.delete(name);
      }
      if (byName.size === 0) this.transientSessionDocs.delete(pluginId);
    }
  }

  /** Clears all registered `doc` / `sessionDoc` handles and transient entries for `pluginId` (leaves durable rows intact). */
  clear(pluginId: string): void {
    this.pluginDocs.get(pluginId)?.clear();
    this.sessionDocs.get(pluginId)?.clear();
    this.transientDocs.delete(pluginId);
    this.transientSessionDocs.delete(pluginId);
  }

  /** Removes a plugin's registration tables and transient in-memory entries (called on disable/unregister). */
  removePlugin(pluginId: string): void {
    this.pluginDocs.delete(pluginId);
    this.sessionDocs.delete(pluginId);
    this.transientDocs.delete(pluginId);
    this.transientSessionDocs.delete(pluginId);
  }

  /**
   * Deletes all persistent and transient documents for an uninstalled plugin (`doc` + `sessionDoc`).
   * Called after unregistering the plugin; awaits `flush()` on all backing stores and rejects if any flush fails.
   */
  async purgePlugin(pluginId: string): Promise<void> {
    this.transientDocs.delete(pluginId);
    this.transientSessionDocs.delete(pluginId);
    const sessionStore = this.options.sessionStore;
    this.store.deletePlugin(pluginId);
    sessionStore?.deletePlugin(pluginId);
    await Promise.all([
      this.store.flush(),
      ...(sessionStore !== undefined ? [sessionStore.flush()] : []),
    ]);
  }
}
