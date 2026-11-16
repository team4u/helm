/**
 * doc-registry.ts: manage plugin public/conversation document (PluginDoc / PluginSessionDoc).
 *
 * responsibility:
 * - maintain plugin public/private doc and conversation level sessionDoc register state and handle;
 * - isolated different plugin document read write (global key pluginId:name, conversation key (pluginId, name, conversationId) three meta group);
 * - wrap global PluginDocStore and conversation dedicated use PluginSessionDocStore, and and public document
 *   update event (global SSE / conversation dedicated use subscribe stream) hit through.
 *
 * naming empty between convention:doc and sessionDoc sharing document naming empty between (the same plugin inside forbidden same name),
 * otherwise GET /api/plugins/:id/docs/:name will appear routing ambiguity.
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
  /** delete a certain plugin in the store in all global document (`${pluginId}:` prefix key); unload related clean up use. */
  deletePlugin(pluginId: string): void;
  /** wait for all queue up write truly (sync mirror ≠ persist complete; failed explicit reject). */
  flush(): Promise<void>;
}

/**
 * plugin conversation document durable layer ((pluginId, name, conversationId) three meta group key).
 * get return original JSON string (not write is undefined);put/delete is sync mirror
 * queue up write;flush wait for real, failed explicit reject. not provide the port when sessionDoc
 * declaration explicit 501(forbid memory fall back - - conversation document promise across restarts store, memory implement equals fabricate persist).
 */
export interface PluginSessionDocStore {
  get(pluginId: string, name: string, conversationId: number): string | undefined;
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void;
  delete(pluginId: string, name: string, conversationId: number): void;
  /** delete a certain plugin all conversation document (by pluginId whole clean up); unload related clean up use. */
  deletePlugin(pluginId: string): void;
  listConversationIds(pluginId: string, name: string): number[];
  flush(): Promise<void>;
}

/** doc register items: handle + visible + archive one initial value (public snapshot not write when also can read). */
export interface DocRegistration {
  handle: PluginDocHandle<unknown>;
  isPublic: boolean;
  initial: unknown;
}

/** sessionDoc register items: handle + visible + archive one initial value (not write read and delete event back value). */
export interface SessionDocRegistration {
  handle: PluginSessionDocHandle<unknown>;
  isPublic: boolean;
  initial: unknown;
}

/** conversation document related host port (by PluginHost construct when inject). */
export interface PluginDocRegistryOptions {
  /** conversation document dedicated use durable layer; missing when sessionDoc declaration explicit 501(forbid memory fall back). */
  sessionStore?: PluginSessionDocStore;
  /**
   * conversation store in validate (host getConversation adapt): each time three meta group operation before invoke,
   * reject to deleted conversation back write orphan child data; throws original on throw (such as conversation_not_found).
   */
  assertConversationExists?: (conversationId: number) => void;
  /** public sessionDoc change event (delete when value is initial value and carries deleted: true). */
  emitSessionDocUpdated?: (doc: PublicPluginSessionDoc) => void;
  /**
   * single document JSON serialization byte cap (initial / set / update unify opening path): default
   * PLUGIN_DOC_MAX_JSON_BYTES(2 MiB). only supply test inject more small value; does not change reject semantics.
   */
  maxDocJsonBytes?: number;
}

/**
 * plugin document (doc / sessionDoc) single value JSON serialization byte cap:2 MiB.
 * guard against line store in reason: document value will enter sync mirror, durable layer queue up write and public event payload,
 * without cap over large value will without sound drag collapse SQLite write queue and SSE first frame. over limit one rule in write mirror and
 * publish event before reject (413 plugin_doc_too_large), old value keep do not change.
 */
export const PLUGIN_DOC_MAX_JSON_BYTES = 2 * 1024 * 1024;

export class PluginDocRegistry {
  private pluginDocs = new Map<string, Map<string, DocRegistration>>();
  private sessionDocs = new Map<string, Map<string, SessionDocRegistration>>();

  constructor(
    private readonly store: PluginDocStore,
    private readonly emitDocUpdated: (pluginId: string, name: string, value: unknown) => void,
    private readonly options: PluginDocRegistryOptions = {},
  ) {}

  /**
   * document value body accumulate guard against line:JSON serialization result exceeds cap when in write mirror/durable layer/publish event before
   * explicit reject (413 plugin_doc_too_large,details carry pluginId/name/kind/bytes/
   * maxBytes), old value keep do not change. reference should already jsonClone(loop reference/undefined/
   * non- pure object etc. cannot serialization value in that one step already explicit failed, this where no longer duplicate validate).
   */
  private assertWithinLimit(
    pluginId: string,
    kind: 'doc' | 'sessionDoc',
    name: string,
    value: unknown,
    extraDetails?: Record<string, unknown>,
  ): void {
    const maxBytes = this.options.maxDocJsonBytes ?? PLUGIN_DOC_MAX_JSON_BYTES;
    const json = JSON.stringify(value);
    // jsonClone already reject undefined/function/loop reference; this where guard against defend honor bottom, never static default write empty.
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

  registerDoc<TState>(
    pluginId: string,
    name: string,
    initial: TState,
    opts: { public?: boolean } | undefined,
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
      throw new HelmError('duplicate_doc', `plugin ${pluginId} duplicate declaration doc ${name}`, 409);
    }
    // doc and sessionDoc sharing naming empty between: same name will build into document routing ambiguity.
    if (this.sessionDocs.get(pluginId)?.has(name)) {
      throw new HelmError(
        'duplicate_doc',
        `plugin ${pluginId} duplicate declaration document name ${name}(doc and sessionDoc sharing naming empty between, forbidden same name)`,
        409,
      );
    }

    const isPublic = opts?.public === true;
    const key = `${pluginId}:${name}`;
    const store = this.store;
    const normalizedInitial = jsonClone(initial);
    this.assertWithinLimit(pluginId, 'doc', name, normalizedInitial);

    const handle: PluginDocHandle<TState> = {
      get: () => {
        assertUsable();
        return jsonClone(store.get<TState>(key, normalizedInitial));
      },
      set: (next) => {
        assertUsable();
        const safe = jsonClone(next);
        // body accumulate guard against line first at mirror write and event publish: reject when old value keep do not change.
        this.assertWithinLimit(pluginId, 'doc', name, safe);
        store.set(key, safe);
        if (isPublic) this.emitDocUpdated(pluginId, name, safe);
      },
      update: (fn) => {
        assertUsable();
        const safe = jsonClone(fn(jsonClone(store.get<TState>(key, normalizedInitial))));
        this.assertWithinLimit(pluginId, 'doc', name, safe);
        store.set(key, safe);
        if (isPublic) this.emitDocUpdated(pluginId, name, safe);
      },
      flush: async () => {
        assertUsable();
        return store.flush();
      },
    };

    docs.set(name, {
      handle: handle as PluginDocHandle<unknown>,
      isPublic,
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
    // durable layer port missing when explicit 501(forbid memory fall back: conversation document promise across restarts store).
    const sessionStore = this.options.sessionStore;
    if (!sessionStore) {
      throw new HelmError(
        'session_doc_store_unavailable',
        `plugin ${pluginId} declaration sessionDoc ${name}, but not provide conversation document durable layer (sessionStore missing), reject memory fall back`,
        501,
        { pluginId, name },
      );
    }
    // conversation store in validate port missing when explicit 501: never can skip validate pretend conversation store in (guard against orphan child back write expires).
    if (!this.options.assertConversationExists) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `plugin ${pluginId} declaration sessionDoc ${name}, but not provide conversation store in validate port (assertConversationExists missing), reject pretend verify conversation store in`,
        501,
        { pluginId, name },
      );
    }
    // public document must provide event port: missing when explicit reject, never static default lose public update event.
    if (opts?.public === true && !this.options.emitSessionDocUpdated) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `plugin ${pluginId} declaration public sessionDoc ${name}, but not provide public conversation document event port (emitSessionDocUpdated missing), reject static default discard update`,
        501,
        { pluginId, name },
      );
    }
    // document name and doc sharing naming empty between: same name will let GET /api/plugins/:id/docs/:name routing ambiguity.
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
    const handle = this.createSessionDocHandle(
      pluginId,
      name,
      normalizedInitial,
      isPublic,
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
      initial: normalizedInitial,
    });

    return handle;
  }

  /**
   * construct sessionDoc handle: each time operation all via assertUsable lifecycle guard (host closed package
   * already wrap epoch and subject to control stop window); three meta group operation extra validate correct security integer conversation ID and
   * conversation store in (after deletion async call back rebuild orphan child data by reject); value one rule JSON deep copy;
   * public document publish dedicated use event (delete event value constant is initial value and carries deleted: true).
   */
  private createSessionDocHandle<TState>(
    pluginId: string,
    name: string,
    initial: TState,
    isPublic: boolean,
    assertUsable: () => void,
  ): PluginSessionDocHandle<TState> {
    const store = this.options.sessionStore!;
    // register boundary already explicit validate must to port non-empty (see registerSessionDoc), this where only type narrow.
    const assertConversationExists = this.options.assertConversationExists!;
    const emitSessionDocUpdated = this.options.emitSessionDocUpdated;
    const emit = (conversationId: number, value: unknown, deleted?: boolean): void => {
      if (!isPublic) return;
      if (!emitSessionDocUpdated) {
        // guard against defend explicit reject (register boundary already guarantee public must has event port), never static default lose update.
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
    // not write when fall back archive one initial value; durable layer is JSON string semantics, parse result day however is deep copy.
    const readRaw = (conversationId: number): TState => {
      const raw = store.get(pluginId, name, conversationId);
      return raw === undefined ? jsonClone(initial) : (JSON.parse(raw) as TState);
    };
    const assertTupleUsable = (conversationId: number): void => {
      assertUsable();
      this.assertSessionDocId(conversationId);
      assertConversationExists(conversationId);
    };
    return {
      get: (conversationId) => {
        assertTupleUsable(conversationId);
        return jsonClone(readRaw(conversationId));
      },
      set: (conversationId, next) => {
        assertTupleUsable(conversationId);
        const safe = jsonClone(next);
        // body accumulate guard against line first at durable layer put and event publish: reject when old value keep do not change.
        this.assertWithinLimit(pluginId, 'sessionDoc', name, safe, { conversationId });
        store.put(pluginId, name, conversationId, JSON.stringify(safe));
        emit(conversationId, safe);
      },
      update: (conversationId, fn) => {
        assertTupleUsable(conversationId);
        const safe = jsonClone(fn(jsonClone(readRaw(conversationId))));
        this.assertWithinLimit(pluginId, 'sessionDoc', name, safe, { conversationId });
        store.put(pluginId, name, conversationId, JSON.stringify(safe));
        emit(conversationId, safe);
      },
      delete: (conversationId) => {
        assertTupleUsable(conversationId);
        store.delete(pluginId, name, conversationId);
        // not write document delete same publish deleted(consumer based on this back to initial state), value constant is initial value.
        emit(conversationId, jsonClone(initial), true);
      },
      listConversationIds: () => {
        assertUsable();
        return [...store.listConversationIds(pluginId, name)].sort((a, b) => a - b);
      },
      flush: async () => {
        assertUsable();
        return store.flush();
      },
    };
  }

  /** conversation ID boundary validate: correct security integer (illegal value one rule 400 invalid_conversation_id). */
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

  /** doc/sessionDoc option validate: only allows { public?: boolean }. */
  private assertDocOpts(
    pluginId: string,
    kind: 'doc' | 'sessionDoc',
    name: string,
    opts: PluginDocOptions | undefined,
  ): void {
    if (opts !== undefined && (!isPlainObject(opts) || Object.keys(opts).some((k) => k !== 'public'))) {
      throw new HelmError('invalid_doc_spec', `plugin ${pluginId} ${kind} ${name} option only allows { public?: boolean }`, 400);
    }
    if (opts?.public !== undefined && typeof opts.public !== 'boolean') {
      throw new HelmError('invalid_doc_spec', `plugin ${pluginId} ${kind} ${name}  public option must be boolean value`, 400);
    }
  }

  /**
   * read plugin public doc snapshot. private doc, not declaration doc, plugin deactivate/missing one rule unify 404
   * (external without from probe private doc is otherwise store in); not write when return archive one initial value.
   * name hit public sessionDoc when explicit hint must conversationId(routing ambiguity hint,
   * without leaking private store in - - private sessionDoc and not declaration name same 404).
   */
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
      value: jsonClone(this.store.get(`${pluginId}:${name}`, reg.initial as never)),
    };
  }

  /**
   * read plugin public sessionDoc snapshot (GET /api/plugins/:id/docs/:name?conversationId=N
   * and dedicated use SSE first frame shared use). private/not declaration/plugin deactivate one rule 404 plugin_doc_not_found
   * (without leaking store in difference); conversation missing by host port such as throws and original on throw; durable layer port
   * missing explicit 501, never fall back global doc key. name hit public global doc when explicit hint
   * do not connect conversationId.
   */
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
    if (!sessionStore) {
      throw new HelmError(
        'session_doc_store_unavailable',
        `plugin ${pluginId} conversation document ${name} without durable layer port (sessionStore missing)`,
        501,
        { pluginId, name, conversationId },
      );
    }
    const assertConversationExists = this.options.assertConversationExists;
    if (!assertConversationExists) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `plugin ${pluginId} conversation document ${name} missing conversation store in validate port, reject pretend verify conversation store in`,
        501,
        { pluginId, name, conversationId },
      );
    }
    // conversation store in: missing/deleted by host port such as throws and original on throw (original not_found).
    assertConversationExists(conversationId);
    const raw = sessionStore.get(pluginId, name, conversationId);
    return {
      pluginId,
      name,
      conversationId,
      value: raw === undefined ? jsonClone(reg.initial) : jsonClone(JSON.parse(raw) as unknown),
    };
  }

  /**
   * all enabled plugin public document snapshot (SSE HelmSnapshot.pluginDocs first frame direct throw use):
   * only contains global public doc(conversation document does not enter global first frame).
   */
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
          value: jsonClone(this.store.get(`${pluginId}:${name}`, reg.initial as never)),
        });
      }
    }
    return out;
  }

  /** check a certain plugin is otherwise declaration name is name  public doc. */
  hasPublicDoc(pluginId: string, name: string): boolean {
    return this.pluginDocs.get(pluginId)?.get(name)?.isPublic === true;
  }

  /** check a certain plugin is otherwise declaration name is name  public sessionDoc. */
  hasPublicSessionDoc(pluginId: string, name: string): boolean {
    return this.sessionDocs.get(pluginId)?.get(name)?.isPublic === true;
  }

  /** empty a certain plugin in this cycle register all doc / sessionDoc handle (does not affect underlying durable data). */
  clear(pluginId: string): void {
    this.pluginDocs.get(pluginId)?.clear();
    this.sessionDocs.get(pluginId)?.clear();
  }

  /** unload plugin when remove two document register table item. */
  removePlugin(pluginId: string): void {
    this.pluginDocs.delete(pluginId);
    this.sessionDocs.delete(pluginId);
  }

  /**
   * unload related clean up: delete the plugin persist all document data (global doc + all conversation document).
   * in plugin instance deregister after invoke (no longer through handle guard); and removePlugin different, this method
   * truly clear underlying durable data, re- install same ID plugin will not read back old data.sessionStore not
   * connect line when the plugin cannot can store in conversation document data, skip i.e. without data can delete (non- fall back).
   *
   * two deletePlugin all queue after wait for each store flush: any one underlying DELETE on failure
   * explicit reject(caller based on this block assert delete directory/delete record, keep install record with convenient retry), never
   * in not before virtual call clean up succeeded. produce connect line in two port shared use the same HelmStore(the same
   * persist tail chain), two time flush idempotent, produces no extra wait for or double heavy errors.
   */
  async purgePlugin(pluginId: string): Promise<void> {
    const sessionStore = this.options.sessionStore;
    this.store.deletePlugin(pluginId);
    sessionStore?.deletePlugin(pluginId);
    await Promise.all([
      this.store.flush(),
      ...(sessionStore !== undefined ? [sessionStore.flush()] : []),
    ]);
  }
}
