/**
 * ui-registry.ts: 负责 7 大全界面前端扩展点的收集与校验，结合构建端口（PluginBuildProvider）的模块校验与产物管理。
 *
 * 职责：
 * - 收集 sidebar, screen, timeline, markdown.codeBlock, tool, composer, workbench,
 *   commandPalette, settingsPanel, profile.runtime, UI 动作（header/row/entry）与
 *   plugin.slot 等界面声明（统一 client.tsx 轨道）；
 * - 声明边界静态校验（id 唯一性、priority/order 安全整数、命令 slash 与宿主保留词、
 *   UI 动作 target 归一化与动作/client 轨至少其一、markdown.codeBlock 语言表形状、
 *   slot target 形状、artifact.previewer 的 MIME/后缀匹配声明、composer.completer 的
 *   补全源互斥与禁用轨、ConversationScope 纯对象校验、JSON-safe 序列化保真）；
 * - client.tsx 动态组件引用的形状校验（assertModuleRefShape）与 clientRoot 归属校验；
 * - 获取已编译 client 模块产物，并严格校验生命周期与 epoch 状态（防止已停用/已轮转插件返回脏产物）；
 * - enable 提交点的跨插件唯一性终检（profile.runtime kind 与 commandPalette slash），
 *   由 PluginHost 在启用提交块调用；默认停用的探测注册不占用全局名字。
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

/** UI 动作三类 target 到注册 surface 的映射（plugin-context 与校验器共用；定义见 ui-spec-validators.ts）。 */
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

export class UiRegistry {
  private ui = new Map<string, PluginUiContribution[]>();

  constructor(private readonly buildProvider?: PluginBuildProvider) {}

  registerUi(pluginId: string, surface: string, spec: unknown, fnName: string, clientRoot?: string): void {
    if (!isPlainObject(spec)) {
      throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 的 spec 必须是纯对象`, 400);
    }
    const id = spec.id;
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

    // 优先级/排序字段：若提供必须为有限安全整数（非法值会让裁决顺序静默失控）。
    for (const field of ['priority', 'order'] as const) {
      const value = spec[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 的 ${field} 必须是安全整数（实际：${String(value)}）`,
          400,
          { pluginId, id, field },
        );
      }
    }

    // surface 专属校验分两阶段派发（见 ui-spec-validators.ts 文档）：早期块
    // （UI 动作 / commandPalette / profile.runtime / plugin.slot）先于通用
    // scope 与 client 引用校验，晚期块在其后——与拆分前的逐块顺序严格一致。
    const ctx: UiSpecContext = {
      pluginId,
      fnName,
      surface,
      clientRoot,
      hasBuildProvider: this.buildProvider !== undefined,
      siblings: list,
    };
    validateUiSpecEarly(surface, spec, id, ctx);

    // scope 在注册边界即校验（非法 scope 会让渲染可见性静默失控）
    assertConversationScope(pluginId, `插件 ${pluginId} ui.${fnName} 声明`, spec.scope);

    // client 引用：需插件定义提供 clientRoot，且 module 形状合法（相对 .ts/.tsx）；
    // 悬空引用（无法编译）在注册边界拒绝，绝不留给渲染期于静默空白。
    const client = spec.client;
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
      // 构建端口在注册边界终检：无 provider 的宿主无法编译 client.tsx，
      // 显式拒绝整个声明（插件 enable 失败）而非静默丢弃 UI 贡献。
      if (this.buildProvider === undefined) {
        throw new HelmError(
          'unsupported_client_build',
          `插件 ${pluginId} ui.${fnName} 声明 client 引用，但宿主未注入插件构建端口（PluginHostOptions.buildProvider）：无法编译 client.tsx，显式拒绝而非静默丢弃 UI`,
          501,
          { pluginId, fnName, module: String(client.module ?? '') },
        );
      }
    }

    validateUiSpecLate(surface, spec, id, ctx);

    // 声明性轨道只接受可 JSON 序列化 spec（HTTP/SSE 直接 JSON 输出）；
    // structuredClone 接受 Map/Set/Date 但 JSON.stringify 会改形丢数据，必须显式拒绝。
    // client.tsx 轨道由 web 编译器负责（本模块不编译）。
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

  /**
   * definePlugin 完成后的末尾统一校验：声明式 docs/sessionDocs 轨道已整体移除
   * （JSON Spec 迁出内核），本方法不再有需校验的文档引用；保留方法供
   * PluginHost 生命周期挂点，待 badge 等 client 轨衍生校验需求出现时扩展。
   */
  assertUiDocsRegistered(
    _pluginId: string,
    _hasPublicDoc: (docName: string) => boolean,
    _hasPublicSessionDoc: (docName: string) => boolean = () => false,
  ): void {
    void _pluginId; void _hasPublicDoc; void _hasPublicSessionDoc;
  }

  /**
   * 跨插件唯一性终检：全部已启用插件（含待提交的 pending）的 UI 贡献中：
   * - profile.runtime 的 kind 不得重复（多插件声明同一 kind 会让 Profile
   *   运行时表单出现歧义，显式拒绝而非按顺序吞掉）；
   * - commandPalette 的 slash 不得重复（/补全列表触发词必须唯一）。
   *
   * 由 PluginHost 在启用提交点（enabled=true 同一同步块）调用：define 阶段的
   * 提前检查只比对插件自身（默认停用探测 enabled:false 不占用全局名字）；两个
   * 插件并发 enable 时各自 define 检查都可能通过，但串行化的提交点终检保证至多
   * 一个暴露重复项（后到者显式拒绝并回滚）。pending 也在 activePluginIds 中时
   * 跳过迭代中的它，末尾只 sweep 一次，避免同一插件自比对误报。
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
              `插件 ${ownerPluginId} 声明的 profile.runtime kind "${spec.kind}" 已被插件 ${prev} 占用`,
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
              `插件 ${ownerPluginId} 声明的命令斜杠触发词 /${spec.slash} 已被插件 ${prev} 占用`,
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

  /** 本插件声明的全部 profile.runtime kind（停用预检的宿主引用探测源）。 */
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

  async getClientModule(
    pluginId: string,
    moduleRef: string,
    options: ClientModuleOptions,
  ): Promise<PluginClientBundle> {
    if (options.isDisposed()) {
      throw new HelmError('plugin_host_disposed', 'PluginHost 已 dispose', 409);
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
          `插件 ${pluginId} 的 chunk 模块名称非法（需匹配 /^[A-Za-z0-9._-]+\\.js$/ 且不含 ..）：${String(options.chunk)}`,
          400,
          { pluginId, chunk: String(options.chunk) },
        );
      }
    }
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
    // 构建端口由 PluginHostOptions 注入（产品在 hub 接线默认实现）；缺失时
    // 显式 501，绝不静默返回空产物或回退内置编译器。
    const provider = this.buildProvider;
    if (provider === undefined) {
      throw new HelmError(
        'unsupported_client_build',
        `宿主未注入插件构建端口（PluginHostOptions.buildProvider）：无法提供插件 ${pluginId} 的 client 模块 ${moduleRef}`,
        501,
        { pluginId, module: moduleRef },
      );
    }
    // 受控 npm 依赖：定义声明的 specifiers -> 解析根聚合（与 doctor 链同一映射口径）。
    const npmRoots: PluginClientNpmRoot[] = clientNpmRootsOf(info.npmDependencies);
    const result = await provider.compileClientModule({
      pluginId,
      clientRoot,
      moduleRef,
      cacheDir: options.dataDir,
      npmRoots,
    });
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

    if (options.chunk !== undefined) {
      if (options.hash !== undefined && options.hash !== result.contentHash) {
        throw new HelmError(
          'client_chunk_stale',
          `插件 ${pluginId} 请求的 chunk hash (${options.hash}) 与当前产物 hash (${result.contentHash}) 不匹配`,
          409,
          { pluginId, module: moduleRef, chunk: options.chunk, hash: options.hash, currentHash: result.contentHash },
        );
      }
      const chunkData = result.chunks?.[options.chunk];
      if (!chunkData) {
        throw new HelmError(
          'client_chunk_not_found',
          `插件 ${pluginId} 模块 ${moduleRef} 未生成 chunk: ${options.chunk}`,
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
  }

  removePlugin(pluginId: string): void {
    this.ui.delete(pluginId);
  }
}
