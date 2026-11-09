/**
 * doc-registry.ts: 管理插件公共/会话文档（PluginDoc / PluginSessionDoc）。
 *
 * 职责：
 * - 维护插件公共/私有 doc 与会话级 sessionDoc 句柄；
 * - 隔离不同插件及不同 epoch 周期的文档读写（命名空间 pluginId:name 与 pluginId:session:convId:name）；
 * - 封装底层 PluginDocStore 并与 SSE 公共文档更新事件打通。
 */
import {
  HelmError,
  type PluginDocHandle,
  type PluginDocOptions,
  type PluginSessionDocHandle,
  type PublicPluginDoc,
} from '@helm/protocol';
import { assertValidId, isPlainObject, jsonClone } from './shared.js';

export interface PluginDocStore {
  get<T>(key: string, initial: T): T;
  set<T>(key: string, value: T): void;
  /** 等待全部排队写真正落盘（同步镜像 ≠ 持久化完成；失败显式 reject）。 */
  flush(): Promise<void>;
}

/** doc 注册项：句柄 + 可见性 + 归一化初值（公共快照未写过时也能读）。 */
export interface DocRegistration {
  handle: PluginDocHandle<unknown>;
  isPublic: boolean;
  initial: unknown;
}

export class PluginDocRegistry {
  private pluginDocs = new Map<string, Map<string, DocRegistration>>();

  constructor(
    private readonly store: PluginDocStore,
    private readonly emitDocUpdated: (pluginId: string, name: string, value: unknown) => void,
  ) {}

  registerDoc<TState>(
    pluginId: string,
    name: string,
    initial: TState,
    opts: { public?: boolean } | undefined,
    assertUsable: () => void,
  ): PluginDocHandle<TState> {
    assertValidId('doc', name);
    if (opts !== undefined && (!isPlainObject(opts) || Object.keys(opts).some((k) => k !== 'public'))) {
      throw new HelmError('invalid_doc_spec', `插件 ${pluginId} doc ${name} 的选项仅允许 { public?: boolean }`, 400);
    }
    if (opts?.public !== undefined && typeof opts.public !== 'boolean') {
      throw new HelmError('invalid_doc_spec', `插件 ${pluginId} doc ${name} 的 public 选项必须是布尔值`, 400);
    }

    let docs = this.pluginDocs.get(pluginId);
    if (!docs) {
      docs = new Map();
      this.pluginDocs.set(pluginId, docs);
    }

    if (docs.has(name)) {
      throw new HelmError('duplicate_doc', `插件 ${pluginId} 重复声明 doc ${name}`, 409);
    }

    const isPublic = opts?.public === true;
    const key = `${pluginId}:${name}`;
    const store = this.store;
    const normalizedInitial = jsonClone(initial);

    const handle: PluginDocHandle<TState> = {
      get: () => {
        assertUsable();
        return jsonClone(store.get<TState>(key, normalizedInitial));
      },
      set: (next) => {
        assertUsable();
        const safe = jsonClone(next);
        store.set(key, safe);
        if (isPublic) this.emitDocUpdated(pluginId, name, safe);
      },
      update: (fn) => {
        assertUsable();
        const safe = jsonClone(fn(jsonClone(store.get<TState>(key, normalizedInitial))));
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
    _epoch: number,
    name: string,
    initial: TState,
    _opts?: PluginDocOptions,
  ): PluginSessionDocHandle<TState> {
    assertValidId('sessionDoc', name);
    const store = this.store;
    const normalizedInitial = jsonClone(initial);
    const sessionKeys = new Map<number, string>();
    const getSessionKey = (convId: number) => {
      let k = sessionKeys.get(convId);
      if (!k) {
        k = `${pluginId}:session:${convId}:${name}`;
        sessionKeys.set(convId, k);
      }
      return k;
    };
    const handle: PluginSessionDocHandle<TState> = {
      get: (convId: number) => jsonClone(store.get<TState>(getSessionKey(convId), normalizedInitial)),
      set: (convId: number, next: TState) => {
        const safe = jsonClone(next);
        store.set(getSessionKey(convId), safe);
      },
      update: (convId: number, fn: (current: TState) => TState) => {
        const safe = jsonClone(fn(jsonClone(store.get<TState>(getSessionKey(convId), normalizedInitial))));
        store.set(getSessionKey(convId), safe);
      },
      delete: (convId: number) => {
        store.set(getSessionKey(convId), normalizedInitial);
        sessionKeys.delete(convId);
      },
      listConversationIds: () => Array.from(sessionKeys.keys()),
      flush: async () => store.flush(),
    };
    return handle;
  }

  /**
   * 读取插件公共 doc 快照。私有 doc、未声明 doc、插件停用/不存在一律统一 404；
   * 未写过时返回归一化初值。
   */
  getPublicDoc(pluginId: string, name: string, isPluginActive: boolean): PublicPluginDoc {
    if (!isPluginActive) {
      throw new HelmError('plugin_doc_not_found', `插件 ${pluginId} 无公共文档 ${name}`, 404, { pluginId, name });
    }
    const docs = this.pluginDocs.get(pluginId);
    const reg = docs?.get(name);
    if (!reg || !reg.isPublic) {
      throw new HelmError('plugin_doc_not_found', `插件 ${pluginId} 无公共文档 ${name}`, 404, { pluginId, name });
    }
    return {
      pluginId,
      name,
      value: jsonClone(this.store.get(`${pluginId}:${name}`, reg.initial as never)),
    };
  }

  /**
   * 全部已启用插件公共文档快照（SSE HelmSnapshot.pluginDocs 首帧直投用）：
   * 合并每个 idle 插件中 isPublic === true 的文档。
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
    const docs = this.pluginDocs.get(pluginId);
    return docs?.get(name)?.isPublic === true;
  }

  /** 清空某插件在本周期注册的所有 doc 句柄（不影响底层的持久数据）。 */
  clear(pluginId: string): void {
    this.pluginDocs.get(pluginId)?.clear();
  }

  /** 卸载插件时移除文档注册表条目。 */
  removePlugin(pluginId: string): void {
    this.pluginDocs.delete(pluginId);
  }
}
