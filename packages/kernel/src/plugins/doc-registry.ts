/**
 * doc-registry.ts: 管理插件公共/会话文档（PluginDoc / PluginSessionDoc）。
 *
 * 职责：
 * - 维护插件公共/私有 doc 与会话级 sessionDoc 的注册状态与句柄；
 * - 隔离不同插件的文档读写（全局键 pluginId:name，会话键 (pluginId, name, conversationId) 三元组）；
 * - 封装全局 PluginDocStore 与会话专用 PluginSessionDocStore，并与公共文档
 *   更新事件（全局 SSE / 会话专用订阅流）打通。
 *
 * 命名空间约定：doc 与 sessionDoc 共享文档命名空间（同一插件内禁止同名），
 * 否则 GET /api/plugins/:id/docs/:name 会出现路由歧义。
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
  /** 等待全部排队写真正落盘（同步镜像 ≠ 持久化完成；失败显式 reject）。 */
  flush(): Promise<void>;
}

/**
 * 插件会话文档持久层（(pluginId, name, conversationId) 三元组键）。
 * get 返回原始 JSON 字符串（未写过为 undefined）；put/delete 为同步镜像
 * 排队写；flush 等待真实落盘，失败显式 reject。未提供该端口时 sessionDoc
 * 声明显式 501（禁内存降级——会话文档承诺跨重启存活，内存实现等于伪造持久化）。
 */
export interface PluginSessionDocStore {
  get(pluginId: string, name: string, conversationId: number): string | undefined;
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void;
  delete(pluginId: string, name: string, conversationId: number): void;
  listConversationIds(pluginId: string, name: string): number[];
  flush(): Promise<void>;
}

/** doc 注册项：句柄 + 可见性 + 归一化初值（公共快照未写过时也能读）。 */
export interface DocRegistration {
  handle: PluginDocHandle<unknown>;
  isPublic: boolean;
  initial: unknown;
}

/** sessionDoc 注册项：句柄 + 可见性 + 归一化初值（未写过读取与 delete 事件的回落值）。 */
export interface SessionDocRegistration {
  handle: PluginSessionDocHandle<unknown>;
  isPublic: boolean;
  initial: unknown;
}

/** 会话文档相关宿主端口（由 PluginHost 构造时注入）。 */
export interface PluginDocRegistryOptions {
  /** 会话文档专用持久层；缺失时 sessionDoc 声明显式 501（禁内存降级）。 */
  sessionStore?: PluginSessionDocStore;
  /**
   * 会话存在性校验（宿主 getConversation 适配）：每次三元组操作前调用，
   * 拒绝向已删除会话回写孤儿数据；抛错原样上抛（如 conversation_not_found）。
   */
  assertConversationExists?: (conversationId: number) => void;
  /** 公共 sessionDoc 变更事件（delete 时 value 为初值且带 deleted: true）。 */
  emitSessionDocUpdated?: (doc: PublicPluginSessionDoc) => void;
  /**
   * 单文档 JSON 序列化字节上限（initial / set / update 统一口径）：缺省
   * PLUGIN_DOC_MAX_JSON_BYTES（2 MiB）。仅供测试注入更小值；不改变拒绝语义。
   */
  maxDocJsonBytes?: number;
}

/**
 * 插件文档（doc / sessionDoc）单值 JSON 序列化字节上限：2 MiB。
 * 防线存在的原因：文档值会进入同步镜像、持久层排队写与公共事件载荷，
 * 无上限的超大值会无声拖垮 SQLite 写队列与 SSE 首帧。超限一律在写入镜像与
 * 发布事件之前拒绝（413 plugin_doc_too_large），旧值保持不变。
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
   * 文档值体积防线：JSON 序列化结果超过上限时在写入镜像/持久层/发布事件之前
   * 显式拒绝（413 plugin_doc_too_large，details 携带 pluginId/name/kind/bytes/
   * maxBytes），旧值保持不变。入参应已经过 jsonClone（循环引用/undefined/
   * 非纯对象等不可序列化值在那一步已显式失败，此处不再重复校验）。
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
    // jsonClone 已拒绝 undefined/函数/循环引用；此处防御性兑底，绝不静默写空。
    if (json === undefined) {
      throw new HelmError(
        'invalid_doc_value',
        `插件 ${pluginId} ${kind} ${name} 的值不可 JSON 序列化（顶层为 undefined 或函数）`,
        400,
        { pluginId, name, kind, ...(extraDetails ?? {}) },
      );
    }
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > maxBytes) {
      throw new HelmError(
        'plugin_doc_too_large',
        `插件 ${pluginId} ${kind} ${name} 的 JSON 序列化结果 ${bytes} 字节，超过上限 ${maxBytes} 字节（拒绝写入，旧值保持不变）`,
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
      throw new HelmError('duplicate_doc', `插件 ${pluginId} 重复声明 doc ${name}`, 409);
    }
    // doc 与 sessionDoc 共享命名空间：同名会造成文档路由歧义。
    if (this.sessionDocs.get(pluginId)?.has(name)) {
      throw new HelmError(
        'duplicate_doc',
        `插件 ${pluginId} 重复声明文档名 ${name}（doc 与 sessionDoc 共享命名空间，禁止同名）`,
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
        // 体积防线先于镜像写入与事件发布：拒绝时旧值保持不变。
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
    // 持久层端口缺失时显式 501（禁内存降级：会话文档承诺跨重启存活）。
    const sessionStore = this.options.sessionStore;
    if (!sessionStore) {
      throw new HelmError(
        'session_doc_store_unavailable',
        `插件 ${pluginId} 声明 sessionDoc ${name}，但未提供会话文档持久层（sessionStore 缺失），拒绝内存降级`,
        501,
        { pluginId, name },
      );
    }
    // 会话存在性校验端口缺失时显式 501：绝不能跳过校验假装会话存在（防孤儿回写失效）。
    if (!this.options.assertConversationExists) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `插件 ${pluginId} 声明 sessionDoc ${name}，但未提供会话存在性校验端口（assertConversationExists 缺失），拒绝假装验证会话存在`,
        501,
        { pluginId, name },
      );
    }
    // public 文档必须提供事件端口：缺失时显式拒绝，绝不静默丢公共更新事件。
    if (opts?.public === true && !this.options.emitSessionDocUpdated) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `插件 ${pluginId} 声明 public sessionDoc ${name}，但未提供公共会话文档事件端口（emitSessionDocUpdated 缺失），拒绝静默丢弃更新`,
        501,
        { pluginId, name },
      );
    }
    // 文档名与 doc 共享命名空间：同名会让 GET /api/plugins/:id/docs/:name 路由歧义。
    if (this.pluginDocs.get(pluginId)?.has(name) || this.sessionDocs.get(pluginId)?.has(name)) {
      throw new HelmError(
        'duplicate_doc',
        `插件 ${pluginId} 重复声明文档名 ${name}（doc 与 sessionDoc 共享命名空间，禁止同名）`,
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
   * 构造 sessionDoc 句柄：每次操作均经 assertUsable 生命周期守卫（宿主闭包
   * 已封装 epoch 与受控停止窗口）；三元组操作额外校验正安全整数会话 ID 与
   * 会话存在性（删除后异步回调重建孤儿数据被拒绝）；值一律 JSON 深拷贝；
   * public 文档发布专用事件（delete 事件 value 恒为初值且带 deleted: true）。
   */
  private createSessionDocHandle<TState>(
    pluginId: string,
    name: string,
    initial: TState,
    isPublic: boolean,
    assertUsable: () => void,
  ): PluginSessionDocHandle<TState> {
    const store = this.options.sessionStore!;
    // 注册边界已显式校验必给端口非空（见 registerSessionDoc），此处仅类型收窄。
    const assertConversationExists = this.options.assertConversationExists!;
    const emitSessionDocUpdated = this.options.emitSessionDocUpdated;
    const emit = (conversationId: number, value: unknown, deleted?: boolean): void => {
      if (!isPublic) return;
      if (!emitSessionDocUpdated) {
        // 防御性显式拒绝（注册边界已保证 public 必有事件端口），绝不静默丢更新。
        throw new HelmError(
          'session_doc_port_unavailable',
          `插件 ${pluginId} public sessionDoc ${name} 缺少事件发布端口，拒绝静默丢弃更新`,
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
    // 未写过时回退归一化初值；持久层为 JSON 字符串语义，解析结果天然是深拷贝。
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
        // 体积防线先于持久层 put 与事件发布：拒绝时旧值保持不变。
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
        // 未写过的文档删除同样发布 deleted（消费方据此回到初始态），值恒为初始值。
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

  /** 会话 ID 边界校验：正安全整数（非法值一律 400 invalid_conversation_id）。 */
  private assertSessionDocId(conversationId: number): void {
    if (!Number.isSafeInteger(conversationId) || conversationId <= 0) {
      throw new HelmError(
        'invalid_conversation_id',
        `会话文档的 conversationId 必须是正安全整数，收到：${String(conversationId)}`,
        400,
        { conversationId: String(conversationId) },
      );
    }
  }

  /** doc/sessionDoc 选项校验：仅允许 { public?: boolean }。 */
  private assertDocOpts(
    pluginId: string,
    kind: 'doc' | 'sessionDoc',
    name: string,
    opts: PluginDocOptions | undefined,
  ): void {
    if (opts !== undefined && (!isPlainObject(opts) || Object.keys(opts).some((k) => k !== 'public'))) {
      throw new HelmError('invalid_doc_spec', `插件 ${pluginId} ${kind} ${name} 的选项仅允许 { public?: boolean }`, 400);
    }
    if (opts?.public !== undefined && typeof opts.public !== 'boolean') {
      throw new HelmError('invalid_doc_spec', `插件 ${pluginId} ${kind} ${name} 的 public 选项必须是布尔值`, 400);
    }
  }

  /**
   * 读取插件公共 doc 快照。私有 doc、未声明 doc、插件停用/不存在一律统一 404
   * （外部无从探测私有 doc 是否存在）；未写过时返回归一化初值。
   * 名称命中 public sessionDoc 时明确提示需 conversationId（路由歧义提示，
   * 不泄漏私有存在性——私有 sessionDoc 与未声明名称同样 404）。
   */
  getPublicDoc(pluginId: string, name: string, isPluginActive: boolean): PublicPluginDoc {
    if (!isPluginActive) {
      throw new HelmError('plugin_doc_not_found', `插件 ${pluginId} 无公共文档 ${name}`, 404, { pluginId, name });
    }
    const reg = this.pluginDocs.get(pluginId)?.get(name);
    if (!reg || !reg.isPublic) {
      if (this.sessionDocs.get(pluginId)?.get(name)?.isPublic === true) {
        throw new HelmError(
          'session_doc_requires_conversation',
          `插件 ${pluginId} 的文档 ${name} 是会话文档，读取需携带 conversationId 查询参数`,
          400,
          { pluginId, name },
        );
      }
      throw new HelmError('plugin_doc_not_found', `插件 ${pluginId} 无公共文档 ${name}`, 404, { pluginId, name });
    }
    return {
      pluginId,
      name,
      value: jsonClone(this.store.get(`${pluginId}:${name}`, reg.initial as never)),
    };
  }

  /**
   * 读取插件公共 sessionDoc 快照（GET /api/plugins/:id/docs/:name?conversationId=N
   * 与专用 SSE 首帧共用）。私有/未声明/插件停用一律 404 plugin_doc_not_found
   * （不泄漏存在性差异）；会话不存在由宿主端口如实抛错并原样上抛；持久层端口
   * 缺失显式 501，绝不回退全局 doc 键。名称命中 public 全局 doc 时明确提示
   * 不接 conversationId。
   */
  getPublicSessionDoc(
    pluginId: string,
    name: string,
    conversationId: number,
    isPluginActive: boolean,
  ): PublicPluginSessionDoc {
    this.assertSessionDocId(conversationId);
    if (!isPluginActive) {
      throw new HelmError('plugin_doc_not_found', `插件 ${pluginId} 无公共会话文档 ${name}`, 404, {
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
          `插件 ${pluginId} 的文档 ${name} 是全局文档，不接 conversationId`,
          400,
          { pluginId, name, conversationId },
        );
      }
      throw new HelmError('plugin_doc_not_found', `插件 ${pluginId} 无公共会话文档 ${name}`, 404, {
        pluginId,
        name,
        conversationId,
      });
    }
    const sessionStore = this.options.sessionStore;
    if (!sessionStore) {
      throw new HelmError(
        'session_doc_store_unavailable',
        `插件 ${pluginId} 的会话文档 ${name} 无持久层端口（sessionStore 缺失）`,
        501,
        { pluginId, name, conversationId },
      );
    }
    const assertConversationExists = this.options.assertConversationExists;
    if (!assertConversationExists) {
      throw new HelmError(
        'session_doc_port_unavailable',
        `插件 ${pluginId} 的会话文档 ${name} 缺少会话存在性校验端口，拒绝假装验证会话存在`,
        501,
        { pluginId, name, conversationId },
      );
    }
    // 会话存在性：不存在/已删除由宿主端口如实抛错并原样上抛（原样 not_found）。
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
   * 全部已启用插件公共文档快照（SSE HelmSnapshot.pluginDocs 首帧直投用）：
   * 只含全局公共 doc（会话文档不进全局首帧）。
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

  /** 检查某插件是否声明了名为 name 的 public doc。 */
  hasPublicDoc(pluginId: string, name: string): boolean {
    return this.pluginDocs.get(pluginId)?.get(name)?.isPublic === true;
  }

  /** 检查某插件是否声明了名为 name 的 public sessionDoc。 */
  hasPublicSessionDoc(pluginId: string, name: string): boolean {
    return this.sessionDocs.get(pluginId)?.get(name)?.isPublic === true;
  }

  /** 清空某插件在本周期注册的所有 doc / sessionDoc 句柄（不影响底层的持久数据）。 */
  clear(pluginId: string): void {
    this.pluginDocs.get(pluginId)?.clear();
    this.sessionDocs.get(pluginId)?.clear();
  }

  /** 卸载插件时移除两个文档注册表的条目。 */
  removePlugin(pluginId: string): void {
    this.pluginDocs.delete(pluginId);
    this.sessionDocs.delete(pluginId);
  }
}
