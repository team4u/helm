/**
 * doc-registry.ts: manage plugin public/conversation document (PluginDoc / PluginSessionDoc).
 *
 * responsibility:
 * - maintain plugin public/private doc and conversation level sessionDoc register state and handle;
 * - support durable (SQLite-backed, default true) and transient (`durable: false`, in-memory only, zero SQLite I/O) modes;
 * - isolated different plugin document read write (global key pluginId:name, conversation key (pluginId, name, conversationId) three meta group);
 * - wrap global PluginDocStore and conversation dedicated use PluginSessionDocStore, and public document
 *   update event (global SSE / conversation dedicated use subscribe stream) hit through.
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
  deletePlugin(pluginId: string): void;
  flush(): Promise<void>;
}

export interface PluginSessionDocStore {
  get(pluginId: string, name: string, conversationId: number): string | undefined;
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void;
  delete(pluginId: string, name: string, conversationId: number): void;
  deletePlugin(pluginId: string): void;
  listConversationIds(pluginId: string, name: string): number[];
  flush(): Promise<void>;
}

export interface DocRegistration {
  handle: PluginDocHandle<unknown>;
  isPublic: boolean;
  durable: boolean;
  initial: unknown;
}

export interface SessionDocRegistration {
  handle: PluginSessionDocHandle<unknown>;
  isPublic: boolean;
  durable: boolean;
  initial: unknown;
}

export interface PluginDocRegistryOptions {
  sessionStore?: PluginSessionDocStore;
  assertConversationExists?: (conversationId: number) => void;
  emitSessionDocUpdated?: (doc: PublicPluginSessionDoc) => void;
  maxDocJsonBytes?: number;
}

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

  private assertWithinLimit(
    pluginId: string,
    kind: 'doc' | 'sessionDoc',
    name: string,
    value: unknown,
    extraDetails?: Record<string, unknown>,
  ): void {
    const maxBytes = this.options.maxDocJsonBytes ?? PLUGIN_DOC_MAX_JSON_BYTES;
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new HelmError(
        'invalid_doc_value',
        `plugin ${pluginId} ${kind} ${name} value cannot JSON serialization (top-level is undefined or function)`,
        400,
        { pluginId, name, kind, ...(extraDetails ?? {}) },
      );
    }
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > maxBytes) {
      throw new HelmError(
        'plugin_doc_too_large',
        `plugin ${pluginId} ${kind} ${name}  JSON serialization result ${bytes} byte, exceeds cap ${maxBytes} byte (reject write, old value keep do not change)`,
        413,
        { pluginId, name, kind, bytes, maxBytes, ...(extraDetails ?? {}) },
      );
    }
  }

  private ensureTransientPluginDocs(pluginId: string): Map<string, unknown> {
    let map = this.transientDocs.get(pluginId);
    if (!map) {
      map = new Map();
      this.transientDocs.set(pluginId, map);
    }
    return map;
  }

  private ensureTransientSessionDocMap(pluginId: string, name: string): Map<number, unknown> {
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
    return byConv;
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

  private pruneDeadTransientConversations(convMap: Map<number, unknown>): void {
    const assertConversationExists = this.options.assertConversationExists;
    if (!assertConversationExists) return;
    for (const cid of [...convMap.keys()]) {
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

    if (docs.has(name) || this.sessionDocs.get(pluginId)?.has(name)) {
      throw new HelmError(
        'duplicate_doc',
        `plugin ${pluginId} duplicate declaration document name ${name}(doc and sessionDoc sharing naming empty between, forbidden same name)`,
        409,
      );
    }

    const isPublic = opts?.public === true;
    const durable = opts?.durable !== false;
    const key = `${pluginId}:${name}`;
    const store = this.store;
    const normalizedInitial = jsonClone(initial);
    this.assertWithinLimit(pluginId, 'doc', name, normalizedInitial);

    const readCurrent = (): TState => {
      if (!durable) {
        const cur = this.transientDocs.get(pluginId)?.get(name);
        return jsonClone((cur === undefined ? normalizedInitial : cur) as TState);
      }
      return jsonClone(store.get<TState>(key, normalizedInitial));
    };
    const writeCurrent = (safe: TState): void => {
      if (durable) store.set(key, safe);
      else this.ensureTransientPluginDocs(pluginId).set(name, safe);
      if (isPublic) this.emitDocUpdated(pluginId, name, safe);
    };

    const handle: PluginDocHandle<TState> = {
      get: () => {
        assertUsable();
        return readCurrent();
      },
      set: (next) => {
        assertUsable();
        const safe = jsonClone(next);
        this.assertWithinLimit(pluginId, 'doc', name, safe);
        writeCurrent(safe);
      },
      update: (fn) => {
        assertUsable();
        const safe = jsonClone(fn(readCurrent()));
        this.assertWithinLimit(pluginId, 'doc', name, safe);
        writeCurrent(safe);
      },
      flush: async () => {
        assertUsable();
        if (durable) return store.flush();
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
    if (durable && !this.options.sessionStore) {
      throw new HelmError(
        'session_doc_store_unavailable',
        `plugin ${pluginId} declaration sessionDoc ${name}, but not provide conversation document durable layer (sessionStore missing), reject memory fall back`,
        501,
        { pluginId, name },
      );
    }
    if (!this.options.assertConversationExists) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `plugin ${pluginId} declaration sessionDoc ${name}, but not provide conversation store in validate port (assertConversationExists missing), reject pretend verify conversation store in`,
        501,
        { pluginId, name },
      );
    }
    if (opts?.public === true && !this.options.emitSessionDocUpdated) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `plugin ${pluginId} declaration public sessionDoc ${name}, but not provide public conversation document event port (emitSessionDocUpdated missing), reject static default discard update`,
        501,
        { pluginId, name },
      );
    }
    if (this.pluginDocs.get(pluginId)?.has(name) || this.sessionDocs.get(pluginId)?.has(name)) {
      throw new HelmError(
        'duplicate_doc',
        `plugin ${pluginId} duplicate declaration document name ${name}(doc and sessionDoc sharing naming empty between, forbidden same name)`,
        409,
      );
    }

    const isPublic = opts?.public === true;
    const normalizedInitial = jsonClone(initial);
    this.assertWithinLimit(pluginId, 'sessionDoc', name, normalizedInitial);
    const handle = this.createSessionDocHandle(pluginId, name, normalizedInitial, isPublic, durable, assertUsable);

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

  private createSessionDocHandle<TState>(
    pluginId: string,
    name: string,
    initial: TState,
    isPublic: boolean,
    durable: boolean,
    assertUsable: () => void,
  ): PluginSessionDocHandle<TState> {
    const store = this.options.sessionStore;
    const emitSessionDocUpdated = this.options.emitSessionDocUpdated;
    const emit = (conversationId: number, value: unknown, deleted?: boolean): void => {
      if (!isPublic) return;
      if (!emitSessionDocUpdated) {
        throw new HelmError(
          'session_doc_port_unavailable',
          `plugin ${pluginId} public sessionDoc ${name} missing event publish port, reject static default discard update`,
          501,
          { pluginId, name, conversationId },
        );
      }
      emitSessionDocUpdated({
        pluginId,
        name,
        conversationId,
        value: jsonClone(value),
        ...(deleted === true ? { deleted: true } : {}),
      });
    };
    const assertTupleUsable = (conversationId: number): void => {
      assertUsable();
      this.assertSessionDocId(conversationId);
      this.assertConversationAliveOrCleanup(conversationId);
    };
    const readValue = (conversationId: number): TState => {
      if (!durable) {
        const raw = this.transientSessionDocs.get(pluginId)?.get(name)?.get(conversationId);
        return jsonClone((raw === undefined ? initial : raw) as TState);
      }
      const raw = store!.get(pluginId, name, conversationId);
      return raw === undefined ? jsonClone(initial) : jsonClone(JSON.parse(raw) as TState);
    };
    const writeValue = (conversationId: number, safe: TState): void => {
      if (durable) {
        store!.put(pluginId, name, conversationId, JSON.stringify(safe));
      } else {
        const convMap = this.ensureTransientSessionDocMap(pluginId, name);
        if (!convMap.has(conversationId) && convMap.size > 0) this.pruneDeadTransientConversations(convMap);
        convMap.set(conversationId, safe);
      }
      emit(conversationId, safe);
    };

    return {
      get: (conversationId) => {
        assertTupleUsable(conversationId);
        return readValue(conversationId);
      },
      set: (conversationId, next) => {
        assertTupleUsable(conversationId);
        const safe = jsonClone(next);
        this.assertWithinLimit(pluginId, 'sessionDoc', name, safe, { conversationId });
        writeValue(conversationId, safe);
      },
      update: (conversationId, fn) => {
        assertTupleUsable(conversationId);
        const safe = jsonClone(fn(readValue(conversationId)));
        this.assertWithinLimit(pluginId, 'sessionDoc', name, safe, { conversationId });
        writeValue(conversationId, safe);
      },
      delete: (conversationId) => {
        assertTupleUsable(conversationId);
        if (durable) store!.delete(pluginId, name, conversationId);
        else this.transientSessionDocs.get(pluginId)?.get(name)?.delete(conversationId);
        emit(conversationId, jsonClone(initial), true);
      },
      listConversationIds: () => {
        assertUsable();
        if (durable) return [...store!.listConversationIds(pluginId, name)].sort((a, b) => a - b);
        const convMap = this.transientSessionDocs.get(pluginId)?.get(name);
        if (!convMap || convMap.size === 0) return [];
        this.pruneDeadTransientConversations(convMap);
        return [...convMap.keys()].sort((a, b) => a - b);
      },
      flush: async () => {
        assertUsable();
        if (durable) return store!.flush();
      },
    };
  }

  private assertSessionDocId(conversationId: number): void {
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
      throw new HelmError(
        'invalid_conversation_id',
        `conversation document conversationId must be correct security integer, receives:${String(conversationId)}`,
        400,
        { conversationId: String(conversationId) },
      );
    }
  }

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
        `plugin ${pluginId} ${kind} ${name} option only allows { public?: boolean, durable?: boolean }`,
        400,
      );
    }
    if (opts?.public !== undefined && typeof opts.public !== 'boolean') {
      throw new HelmError('invalid_doc_spec', `plugin ${pluginId} ${kind} ${name}  public option must be boolean value`, 400);
    }
    if (opts?.durable !== undefined && typeof opts.durable !== 'boolean') {
      throw new HelmError('invalid_doc_spec', `plugin ${pluginId} ${kind} ${name} durable option must be boolean value`, 400);
    }
  }

  private readDocValue(pluginId: string, name: string, reg: DocRegistration): unknown {
    if (!reg.durable) {
      const cur = this.transientDocs.get(pluginId)?.get(name);
      return jsonClone(cur === undefined ? reg.initial : cur);
    }
    return jsonClone(this.store.get(`${pluginId}:${name}`, reg.initial as never));
  }

  getPublicDoc(pluginId: string, name: string, isPluginActive: boolean): PublicPluginDoc {
    if (!isPluginActive) {
      throw new HelmError('plugin_doc_not_found', `plugin ${pluginId} without public document ${name}`, 404, { pluginId, name });
    }
    const reg = this.pluginDocs.get(pluginId)?.get(name);
    if (!reg || !reg.isPublic) {
      if (this.sessionDocs.get(pluginId)?.get(name)?.isPublic === true) {
        throw new HelmError(
          'session_doc_requires_conversation',
          `plugin ${pluginId} document ${name} is conversation document, read must carry conversationId query parameter`,
          400,
          { pluginId, name },
        );
      }
      throw new HelmError('plugin_doc_not_found', `plugin ${pluginId} without public document ${name}`, 404, { pluginId, name });
    }
    return {
      pluginId,
      name,
      value: this.readDocValue(pluginId, name, reg),
    };
  }

  getPublicSessionDoc(
    pluginId: string,
    name: string,
    conversationId: number,
    isPluginActive: boolean,
  ): PublicPluginSessionDoc {
    this.assertSessionDocId(conversationId);
    if (!isPluginActive) {
      throw new HelmError('plugin_doc_not_found', `plugin ${pluginId} without public conversation document ${name}`, 404, {
        pluginId,
        name,
        conversationId,
      });
    }
    const reg = this.sessionDocs.get(pluginId)?.get(name);
    if (!reg || !reg.isPublic) {
      if (this.pluginDocs.get(pluginId)?.get(name)?.isPublic === true) {
        throw new HelmError(
          'global_doc_unexpected_conversation',
          `plugin ${pluginId} document ${name} is global document, do not connect conversationId`,
          400,
          { pluginId, name, conversationId },
        );
      }
      throw new HelmError('plugin_doc_not_found', `plugin ${pluginId} without public conversation document ${name}`, 404, {
        pluginId,
        name,
        conversationId,
      });
    }
    const sessionStore = this.options.sessionStore;
    if (reg.durable && !sessionStore) {
      throw new HelmError(
        'session_doc_store_unavailable',
        `plugin ${pluginId} conversation document ${name} without durable layer port (sessionStore missing)`,
        501,
        { pluginId, name, conversationId },
      );
    }
    if (!this.options.assertConversationExists) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `plugin ${pluginId} conversation document ${name} missing conversation store in validate port, reject pretend verify conversation store in`,
        501,
        { pluginId, name, conversationId },
      );
    }
    this.assertConversationAliveOrCleanup(conversationId);
    if (!reg.durable) {
      const cur = this.transientSessionDocs.get(pluginId)?.get(name)?.get(conversationId);
      return {
        pluginId,
        name,
        conversationId,
        value: jsonClone(cur === undefined ? reg.initial : cur),
      };
    }
    const raw = sessionStore!.get(pluginId, name, conversationId);
    return {
      pluginId,
      name,
      conversationId,
      value: raw === undefined ? jsonClone(reg.initial) : jsonClone(JSON.parse(raw) as unknown),
    };
  }

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
          value: this.readDocValue(pluginId, name, reg),
        });
      }
    }
    return out;
  }

  hasPublicDoc(pluginId: string, name: string): boolean {
    return this.pluginDocs.get(pluginId)?.get(name)?.isPublic === true;
  }

  hasPublicSessionDoc(pluginId: string, name: string): boolean {
    return this.sessionDocs.get(pluginId)?.get(name)?.isPublic === true;
  }

  /** Clear all in-memory transient sessionDoc entries belonging to a deleted conversation across plugins. */
  deleteConversation(conversationId: number): void {
    for (const byDoc of this.transientSessionDocs.values()) {
      for (const byConv of byDoc.values()) {
        byConv.delete(conversationId);
      }
    }
  }

  clear(pluginId: string): void {
    this.pluginDocs.get(pluginId)?.clear();
    this.sessionDocs.get(pluginId)?.clear();
    this.transientDocs.delete(pluginId);
    this.transientSessionDocs.delete(pluginId);
  }

  removePlugin(pluginId: string): void {
    this.pluginDocs.delete(pluginId);
    this.sessionDocs.delete(pluginId);
    this.transientDocs.delete(pluginId);
    this.transientSessionDocs.delete(pluginId);
  }

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
