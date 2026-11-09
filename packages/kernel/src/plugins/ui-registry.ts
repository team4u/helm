/**
 * ui-registry.ts: 负责 7 大全界面前端扩展点的收集与校验，结合 client-compiler.ts 的模块校验与产物管理。
 *
 * 职责：
 * - 收集 sidebar, screen, timeline, tool, composer, workbench, commandPalette, settingsPanel 等界面声明；
 * - 声明边界静态校验（id 唯一性、声明式 public doc 依赖预检、ConversationScope 纯对象校验、JSON-safe 序列化保真）；
 * - client.tsx 动态组件引用的形状校验（assertModuleRefShape）与 clientRoot 归属校验；
 * - 获取已编译 client 模块产物，并严格校验生命周期与 epoch 状态（防止已停用/已轮转插件返回脏产物）。
 */
import { HelmError, type PluginUiContribution } from '@helm/protocol';
import { assertModuleRefShape, compilePluginClientModule, type ClientCompileResult } from './client-compiler.js';
import { assertConversationScope, isPlainObject, jsonClone } from './shared.js';

export interface ClientModuleOptions {
  getPluginLifecycle: (pluginId: string) => {
    identity: unknown;
    enabled: boolean;
    phase: string;
    epoch: number;
    clientRoot?: string;
  } | undefined;
  dataDir: string;
  isDisposed: () => boolean;
  compile?: (
    pluginId: string,
    clientRoot: string,
    moduleRef: string,
    dataDir: string,
  ) => Promise<ClientCompileResult>;
}

export class UiRegistry {
  private ui = new Map<string, PluginUiContribution[]>();

  registerUi(pluginId: string, surface: string, spec: unknown, fnName: string, clientRoot?: string): void {
    const id = (spec as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 声明缺少 id`, 400);
    }

    let list = this.ui.get(pluginId);
    if (!list) {
      list = [];
      this.ui.set(pluginId, list);
    }
    if (list.some((u) => u.surface === surface && (u.spec as { id?: string }).id === id)) {
      throw new HelmError('duplicate_ui', `插件 ${pluginId} 在 ${surface} 重复声明 id ${id}`, 409);
    }

    const docs = (spec as { docs?: unknown }).docs;
    if (docs !== undefined) {
      if (!Array.isArray(docs) || docs.length === 0 || docs.some((d) => typeof d !== 'string' || d.length === 0)) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 的 docs 必须是非空字符串数组的文档名列表`,
          400,
        );
      }
      const unique = new Set(docs as string[]);
      if (unique.size !== docs.length) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 的 docs 含重复文档名`, 400);
      }
      for (const name of unique) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 的 docs 含非法文档名 ${JSON.stringify(name)}（允许字符 A-Za-z0-9._-）`,
            400,
          );
        }
      }
    }

    assertConversationScope(pluginId, `插件 ${pluginId} ui.${fnName} 声明`, (spec as { scope?: unknown }).scope);

    const client = (spec as { client?: unknown }).client;
    if (client !== undefined) {
      if (clientRoot === undefined) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 声明 client 引用但插件定义未提供 clientRoot`,
          400,
          { pluginId },
        );
      }
      if (!isPlainObject(client) || Object.keys(client).some((k) => k !== 'module' && k !== 'export')) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 的 client 仅允许 { module, export }`, 400);
      }
      assertModuleRefShape(pluginId, String(client.module ?? ''));
      if (typeof client.export !== 'string' || client.export.length === 0 || !/^[A-Za-z0-9_$]+$/.test(client.export)) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 的 client.export 必须是非空合法导出名`,
          400,
        );
      }
    }

    if (surface === 'timeline.renderer') {
      const matchMeta = (spec as { matchMeta?: unknown }).matchMeta;
      if (matchMeta !== undefined) {
        if (
          !isPlainObject(matchMeta) ||
          Object.keys(matchMeta).some((k) => k !== 'renderer') ||
          typeof matchMeta.renderer !== 'string' ||
          matchMeta.renderer.length === 0
        ) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.timelineRenderer 的 matchMeta 仅允许 { renderer: 非空字符串 }`,
            400,
          );
        }
      }
    }

    if (surface === 'tool.view') {
      const replaceRow = (spec as { replaceRow?: unknown }).replaceRow;
      if (replaceRow !== undefined && typeof replaceRow !== 'boolean') {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.toolView 的 replaceRow 必须是布尔值（实际：${typeof replaceRow}）`,
          400,
          { pluginId, id },
        );
      }
      const toolNames = (spec as { toolNames?: unknown }).toolNames;
      if (
        !Array.isArray(toolNames) ||
        toolNames.length === 0 ||
        toolNames.some((t) => typeof t !== 'string' || t.length === 0)
      ) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.toolView 的 toolNames 必须是非空字符串数组`,
          400,
          { pluginId, id },
        );
      }
    }

    if (surface === 'workbench.panel') {
      const badge = (spec as { badge?: unknown }).badge;
      if (badge !== undefined) {
        if (
          !isPlainObject(badge) ||
          Object.keys(badge).some(
            (k) => k !== 'doc' && k !== 'countField' && k !== 'toneField' && k !== 'byConversationField',
          )
        ) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.workbenchPanel 的 badge 仅允许 { doc, countField?, toneField?, byConversationField? }`,
            400,
            { pluginId, id },
          );
        }
        if (typeof badge.doc !== 'string' || badge.doc.length === 0) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.workbenchPanel 的 badge.doc 必须是非空字符串（订阅的本插件 public doc 名）`,
            400,
            { pluginId, id },
          );
        }
        for (const field of ['countField', 'toneField', 'byConversationField'] as const) {
          const value = badge[field];
          if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
            throw new HelmError(
              'invalid_ui_spec',
              `插件 ${pluginId} ui.workbenchPanel 的 badge.${field} 必须是非空字符串字段名`,
              400,
              { pluginId, id, field },
            );
          }
        }
      }
    }

    let normalized: unknown;
    try {
      normalized = jsonClone(spec);
    } catch (err) {
      throw new HelmError(
        'invalid_ui_spec',
        `插件 ${pluginId} ui.${fnName} 声明的 spec 必须可 JSON 序列化（client.tsx 引用请用 client 字段）` +
          `：${err instanceof Error ? err.message : String(err)}`,
        400,
      );
    }
    list.push({ pluginId, surface, spec: normalized });
  }

  assertUiDocsRegistered(pluginId: string, hasPublicDoc: (docName: string) => boolean): void {
    const list = this.ui.get(pluginId);
    if (!list || list.length === 0) return;
    const required = new Map<string, Array<{ surface: string; id: string }>>();
    const collect = (doc: string, from: { surface: string; id: string }): void => {
      const l = required.get(doc) ?? [];
      l.push(from);
      required.set(doc, l);
    };
    for (const u of list) {
      const spec = u.spec as { docs?: unknown; badge?: { doc?: unknown } };
      const docs = spec.docs;
      if (Array.isArray(docs)) {
        for (const name of docs) {
          if (typeof name === 'string') collect(name, { surface: u.surface, id: String((spec as { id?: unknown }).id) });
        }
      }
      const badgeDoc = spec.badge?.doc;
      if (typeof badgeDoc === 'string') {
        collect(badgeDoc, { surface: u.surface, id: String((spec as { id?: unknown }).id) });
      }
    }
    for (const [name, usages] of required) {
      if (!hasPublicDoc(name)) {
        const where = usages.map((u) => `${u.surface}#${u.id}`).join(', ');
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} 的 UI 声明（${where}）引用了未注册为 public doc 的文档 ${name}`,
          400,
          { pluginId, doc: name, usages },
        );
      }
    }
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

  getUiByPlugin(pluginId: string): PluginUiContribution[] {
    const list = this.ui.get(pluginId);
    if (!list) return [];
    return list.map((u) => ({ ...u, spec: structuredClone(u.spec) }));
  }

  async getClientModule(
    pluginId: string,
    moduleRef: string,
    options: ClientModuleOptions,
  ): Promise<ClientCompileResult> {
    if (options.isDisposed()) {
      throw new HelmError('plugin_host_disposed', 'PluginHost 已 dispose', 409);
    }
    assertModuleRefShape(pluginId, moduleRef);
    const info = options.getPluginLifecycle(pluginId);
    if (!info || !info.enabled || info.phase !== 'idle') {
      throw new HelmError('plugin_client_unavailable', `插件 ${pluginId} 未启用，不提供 client 模块`, 409, {
        pluginId,
        module: moduleRef,
      });
    }
    const clientRoot = info.clientRoot;
    if (clientRoot === undefined) {
      throw new HelmError('plugin_client_unavailable', `插件 ${pluginId} 未声明 clientRoot`, 404, { pluginId });
    }
    const identity = info.identity;
    const epoch = info.epoch;
    const compile = options.compile ?? compilePluginClientModule;
    const result = await compile(pluginId, clientRoot, moduleRef, options.dataDir);
    const current = options.getPluginLifecycle(pluginId);
    if (
      options.isDisposed() ||
      !current ||
      current.identity !== identity ||
      current.epoch !== epoch ||
      !current.enabled ||
      current.phase !== 'idle'
    ) {
      throw new HelmError(
        'plugin_client_unavailable',
        `插件 ${pluginId} 在 client 模块编译完成前已停用或进入新启用周期，产物作废`,
        409,
        { pluginId, module: moduleRef },
      );
    }
    return result;
  }

  clear(pluginId: string): void {
    const list = this.ui.get(pluginId);
    if (list) list.length = 0;
  }

  removePlugin(pluginId: string): void {
    this.ui.delete(pluginId);
  }
}
