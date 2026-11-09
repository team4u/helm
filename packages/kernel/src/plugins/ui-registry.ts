/**
 * ui-registry.ts: 负责 7 大全界面前端扩展点的收集与校验，结合 client-compiler.ts 的模块校验与产物管理。
 *
 * 职责：
 * - 收集 sidebar, screen, timeline, tool, composer, workbench, commandPalette, settingsPanel,
 *   profile.runtime, 微动作（header/row/entry.action）与 plugin.slot 等界面声明；
 * - 声明边界静态校验（id 唯一性、priority/order 安全整数、命令 slash 与宿主保留词、
 *   微动作三轨至少其一、slot target 形状、sessionDocs 列表形状、声明式 public doc 依赖预检、
 *   ConversationScope 纯对象校验、JSON-safe 序列化保真）；
 * - client.tsx 动态组件引用的形状校验（assertModuleRefShape）与 clientRoot 归属校验；
 * - 获取已编译 client 模块产物，并严格校验生命周期与 epoch 状态（防止已停用/已轮转插件返回脏产物）；
 * - enable 提交点的跨插件唯一性终检（profile.runtime kind 与 commandPalette slash），
 *   由 PluginHost 在启用提交块调用；默认停用的探测注册不占用全局名字。
 */
import { HelmError, type PluginUiContribution } from '@helm/protocol';
import { assertModuleRefShape, compilePluginClientModule, type ClientCompileResult } from './client-compiler.js';
import { assertConversationScope, isPlainObject, jsonClone } from './shared.js';

/** 宿主保留的命令斜杠触发词（skill: 前缀整体保留），插件不得占用。 */
const RESERVED_COMMAND_SLASH = new Set(['new', 'clear', 'compact']);

/** 微动作三类 surface：actionId / client / json 三轨至少提供其一。 */
const MICRO_ACTION_SURFACES = new Set([
  'conversation.header.action',
  'conversation.row.action',
  'timeline.entry.action',
]);

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
      const value = (spec as Record<string, unknown>)[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 的 ${field} 必须是安全整数（实际：${String(value)}）`,
          400,
          { pluginId, id, field },
        );
      }
    }

    // 微动作三轨：actionId / client / json 至少提供其一（否则宿主无法渲染也无法执行）。
    if (MICRO_ACTION_SURFACES.has(surface)) {
      const actionId = (spec as { actionId?: unknown }).actionId;
      const hasClient = (spec as { client?: unknown }).client !== undefined;
      const hasJson = (spec as { json?: unknown }).json !== undefined;
      if (actionId === undefined && !hasClient && !hasJson) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 需至少提供 actionId、client、json 三者之一`,
          400,
          { pluginId, id },
        );
      }
      // 这里只校验动作寻址形状；目标插件可稍后注册，调用时由动作总线判定可用性。
      if (actionId !== undefined) {
        if (typeof actionId !== 'string' || actionId.length === 0 || actionId.includes('.')) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 的 actionId 必须是非空且不含点号的动作 id（跨插件请用 actionPluginId）`,
            400,
            { pluginId, id },
          );
        }
      }
      const actionPluginId = (spec as { actionPluginId?: unknown }).actionPluginId;
      if (actionPluginId !== undefined && (typeof actionPluginId !== 'string' || actionPluginId.length === 0)) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 的 actionPluginId 必须是非空插件 id`,
          400,
          { pluginId, id },
        );
      }
      // placement 仅 conversation.header.action 允许；kinds/roles 仅 timeline.entry.action 允许。
      if (surface !== 'conversation.header.action') {
        const placement = (spec as { placement?: unknown }).placement;
        if (placement !== undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 不允许 placement（仅 conversationHeaderAction 支持）`,
            400,
            { pluginId, id },
          );
        }
      } else {
        const placement = (spec as { placement?: unknown }).placement;
        if (placement !== undefined && placement !== 'toolbar' && placement !== 'menu') {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 的 placement 仅允许 'toolbar' | 'menu'`,
            400,
            { pluginId, id },
          );
        }
      }
      if (surface === 'timeline.entry.action') {
        const kinds = (spec as { kinds?: unknown }).kinds;
        if (
          kinds !== undefined &&
          (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => typeof k !== 'string' || k.length === 0))
        ) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 的 kinds 必须是非空字符串数组`,
            400,
            { pluginId, id },
          );
        }
        const roles = (spec as { roles?: unknown }).roles;
        if (roles !== undefined) {
          if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => r !== 'user' && r !== 'assistant')) {
            throw new HelmError(
              'invalid_ui_spec',
              `插件 ${pluginId} ui.${fnName} 的 roles 仅允许 'user' | 'assistant' 非空数组`,
              400,
              { pluginId, id },
            );
          }
        }
      } else {
        const kinds = (spec as { kinds?: unknown }).kinds;
        if (kinds !== undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 不允许 kinds（仅 timelineEntryAction 支持）`,
            400,
            { pluginId, id },
          );
        }
        const roles = (spec as { roles?: unknown }).roles;
        if (roles !== undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 不允许 roles（仅 timelineEntryAction 支持）`,
            400,
            { pluginId, id },
          );
        }
      }
    }

    // commandPalette：slash 触发词格式与宿主保留词。
    if (surface === 'commandPalette') {
      const slash = (spec as { slash?: unknown }).slash;
      if (slash !== undefined) {
        if (typeof slash !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(slash)) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.command 的 slash 必须匹配 /^[a-z0-9][a-z0-9:_-]{0,63}$/（不含前导 /）`,
            400,
            { pluginId, id, slash: String(slash) },
          );
        }
        if (RESERVED_COMMAND_SLASH.has(slash) || slash.startsWith('skill:')) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.command 的 slash "${slash}" 与宿主保留命令冲突（new/clear/compact 与 skill: 前缀）`,
            400,
            { pluginId, id, slash },
          );
        }
        // 插件内同名 slash 直接拒绝（跨插件冲突在提交点终检）。
        for (const u of list) {
          if (u.surface !== 'commandPalette') continue;
          const other = (u.spec as { slash?: unknown }).slash;
          if (other === slash) {
            throw new HelmError('duplicate_command_slash', `插件 ${pluginId} 重复声明斜杠触发词 /${slash}`, 409, {
              pluginId,
              slash,
            });
          }
        }
      }
      const actionId = (spec as { actionId?: unknown }).actionId;
      if (actionId !== undefined && (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(actionId))) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.command 的 actionId 必须是合法动作标识`, 400);
      }
      if (slash !== undefined && actionId === undefined) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.command 声明 slash 时必须绑定 actionId`, 400);
      }
      const hasClient = (spec as { client?: unknown }).client !== undefined;
      const hasJson = (spec as { json?: unknown }).json !== undefined;
      if (actionId === undefined && !hasClient && !hasJson) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.command 需至少提供 actionId、client、json 三者之一（命令必须可触发）`,
          400,
          { pluginId, id },
        );
      }
      const actionPluginId = (spec as { actionPluginId?: unknown }).actionPluginId;
      if (actionPluginId !== undefined && (typeof actionPluginId !== 'string' || actionPluginId.length === 0)) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.command 的 actionPluginId 必须是非空插件 id`,
          400,
          { pluginId, id },
        );
      }
    }

    // profile.runtime：kind 必填非空；重复 kind 在提交点终检（跨插件）。
    if (surface === 'profile.runtime') {
      const kind = (spec as { kind?: unknown }).kind;
      if (typeof kind !== 'string' || kind.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(kind)) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.profileRuntime 的 kind 必须匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`,
          400,
          { pluginId, id, kind: String(kind) },
        );
      }
      const label = (spec as { label?: unknown }).label;
      if (typeof label !== 'string' || label.length === 0) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.profileRuntime 需要非空 label`, 400, {
          pluginId,
          id,
        });
      }
      const agentSuggestions = (spec as { agentSuggestions?: unknown }).agentSuggestions;
      if (
        agentSuggestions !== undefined &&
        (!Array.isArray(agentSuggestions) ||
          agentSuggestions.some((s) => typeof s !== 'string' || s.length === 0))
      ) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.profileRuntime 的 agentSuggestions 必须是非空字符串数组`,
          400,
          { pluginId, id },
        );
      }
      // 插件内重复 kind 直接拒绝（跨插件冲突在提交点终检）。
      for (const u of list) {
        if (u.surface !== 'profile.runtime') continue;
        const other = (u.spec as { kind?: unknown }).kind;
        if (other === kind) {
          throw new HelmError(
            'duplicate_profile_runtime_kind',
            `插件 ${pluginId} 重复声明 profile.runtime kind "${kind}"`,
            409,
            { pluginId, kind },
          );
        }
      }
    }

    // plugin.slot：target 必须恰有一个 '/'，两段均为合法标识。
    if (surface === 'plugin.slot') {
      const target = (spec as { target?: unknown }).target;
      if (typeof target !== 'string' || target.length === 0 || target.length > 512) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.slot 的 target 必须是非空字符串（<ownerPluginId>/<slotName>）`,
          400,
          { pluginId, id },
        );
      }
      const slash = target.indexOf('/');
      if (slash <= 0 || slash !== target.lastIndexOf('/')) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.slot 的 target "${target}" 必须恰含一个 '/'（<ownerPluginId>/<slotName>）`,
          400,
          { pluginId, id, target },
        );
      }
      const owner = target.slice(0, slash);
      const slotName = target.slice(slash + 1);
      if (!/^[A-Za-z0-9:_-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(slotName)) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.slot 的 target "${target}" 段标识非法（ownerPluginId 允许 : _ -，slotName 允许 . _ -）`,
          400,
          { pluginId, id, target },
        );
      }
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

    // sessionDocs：声明式轨道订阅的本插件公开会话文档名列表；边界即校验
    //（非法 doc 名/非数组会让 $sessionDocs 挂载静默失效，必须显式拒绝）。
    const sessionDocsList = (spec as { sessionDocs?: unknown }).sessionDocs;
    if (sessionDocsList !== undefined) {
      if (
        !Array.isArray(sessionDocsList) ||
        sessionDocsList.length === 0 ||
        sessionDocsList.some((d) => typeof d !== 'string' || d.length === 0)
      ) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.${fnName} 的 sessionDocs 必须是非空字符串数组的会话文档名列表`,
          400,
        );
      }
      const uniqueSession = new Set(sessionDocsList as string[]);
      if (uniqueSession.size !== sessionDocsList.length) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 的 sessionDocs 含重复文档名`, 400);
      }
      for (const name of uniqueSession) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.${fnName} 的 sessionDocs 含非法文档名 ${JSON.stringify(name)}（允许字符 A-Za-z0-9._-）`,
            400,
          );
        }
      }
    }

    // scope 在注册边界即校验（非法 scope 会让渲染可见性静默失控）
    assertConversationScope(pluginId, `插件 ${pluginId} ui.${fnName} 声明`, (spec as { scope?: unknown }).scope);

    // client 引用：需插件定义提供 clientRoot，且 module 形状合法（相对 .ts/.tsx）；
    // 悬空引用（无法编译）在注册边界拒绝，绝不留给渲染期于静默空白。
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
   * definePlugin 完成后的末尾统一校验：
   * - UI 声明引用的 docs / badge.doc 必须是本插件已注册的 public 全局 doc；
   * - spec.sessionDocs 必须是本插件已注册的 public sessionDoc（独立于全局
   *   docs 校验；badge.doc 仍要求全局 doc，不要求出现在 docs 数组中）。
   * doc 声明可晚于 UI 声明，故在定义期末校验；非法引用会让 $docs/
   * $sessionDocs 挂载/角标静默失效，必须显式拒绝。
   * hasPublicSessionDoc 缺省视为无任何公开会话文档（声明了 sessionDocs 即拒绝），
   * 纯 global 校验的既有调用方与单测不受影响。
   */
  assertUiDocsRegistered(
    pluginId: string,
    hasPublicDoc: (docName: string) => boolean,
    hasPublicSessionDoc: (docName: string) => boolean = () => false,
  ): void {
    const list = this.ui.get(pluginId);
    if (!list || list.length === 0) return;
    const requiredDocs = new Map<string, Array<{ surface: string; id: string }>>();
    const requiredSessionDocs = new Map<string, Array<{ surface: string; id: string }>>();
    const collect = (
      into: Map<string, Array<{ surface: string; id: string }>>,
      doc: string,
      from: { surface: string; id: string },
    ): void => {
      const l = into.get(doc) ?? [];
      l.push(from);
      into.set(doc, l);
    };
    for (const u of list) {
      const spec = u.spec as { id?: unknown; docs?: unknown; sessionDocs?: unknown; badge?: { doc?: unknown } };
      const from = { surface: u.surface, id: String(spec.id) };
      if (Array.isArray(spec.docs)) {
        for (const name of spec.docs) {
          if (typeof name === 'string') collect(requiredDocs, name, from);
        }
      }
      if (Array.isArray(spec.sessionDocs)) {
        for (const name of spec.sessionDocs) {
          if (typeof name === 'string') collect(requiredSessionDocs, name, from);
        }
      }
      const badgeDoc = spec.badge?.doc;
      if (typeof badgeDoc === 'string') {
        collect(requiredDocs, badgeDoc, from);
      }
    }
    for (const [name, usages] of requiredDocs) {
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
    for (const [name, usages] of requiredSessionDocs) {
      if (!hasPublicSessionDoc(name)) {
        const where = usages.map((u) => `${u.surface}#${u.id}`).join(', ');
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} 的 UI 声明（${where}）引用了未注册为 public sessionDoc 的会话文档 ${name}，或该文档缺少 public: true`,
          400,
          { pluginId, sessionDoc: name, usages },
        );
      }
    }
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
