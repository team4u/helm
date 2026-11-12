/**
 * ui-registry.ts: 负责 7 大全界面前端扩展点的收集与校验，结合 client-compiler.ts 的模块校验与产物管理。
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
import { HelmError, RESERVED_SLASH_COMMANDS, type PluginUiContribution, type UiActionSpec } from '@helm/protocol';
import { assertModuleRefShape, clientNpmRootsOf, compilePluginClientModule, type ClientCompileResult, type ClientNpmRoot } from './client-compiler.js';
import { assertConversationScope, isPlainObject, jsonClone } from './shared.js';

/** 宿主保留的命令斜杠触发词（skill: 前缀整体保留），插件不得占用。 */
const RESERVED_COMMAND_SLASH: ReadonlySet<string> = new Set(RESERVED_SLASH_COMMANDS);

/** UI 动作三类 target 到注册 surface 的映射（统一 UiActionSpec.target 语义；plugin-host 与 registry 共用）。 */
export const UI_ACTION_SURFACES: Readonly<Record<UiActionSpec['target'], string>> = {
  'conversation:header': 'conversation.header.action',
  'conversation:row': 'conversation.row.action',
  'timeline:entry': 'timeline.entry.action',
};

/**
 * artifact.previewer 的规范 MIME：小写 type/subtype 精确值或显式 type/* 通配。
 * 拒绝 '星号斜杠星号'（等于吞掉所有产物且无裁决意义）、参数、前后缀/glob 与大写形态
 * ——匹配规则必须精确可预期，前端裁决与内核校验共用同一事实源。
 */
const CANONICAL_MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/;

/** artifact.previewer 的文件后缀：小写、前导点、可多段（如 .tar.gz），无路径段与通配符。 */
const ARTIFACT_EXTENSION_PATTERN = /^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/;

/** 补全源 doc 形态的文档名（与 docs/sessionDocs 列表同一命名约束）。 */
const COMPLETER_DOC_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 补全源 itemsField：安全顶层键字符集（拒 __proto__/constructor/prototype）。
 * 仅字符集限制还不够，原型污染键名单在补全源校验中单独拒绝。
 */
const COMPLETER_ITEMS_FIELD_PATTERN = /^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,127}$/;

const UNSAFE_TOP_LEVEL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * artifact.previewer 匹配声明列表的公共校验：非空字符串数组、逐项合法、无重复。
 */
function assertArtifactMatchList(
  pluginId: string,
  fnName: string,
  id: string,
  field: 'mimeTypes' | 'extensions',
  values: unknown,
  isValid: (value: string) => boolean,
  expect: string,
): void {
  if (values === undefined) return;
  if (!Array.isArray(values) || values.length === 0 || values.some((v) => typeof v !== 'string')) {
    throw new HelmError(
      'invalid_ui_spec',
      `插件 ${pluginId} ui.${fnName} 的 ${field} 必须是非空字符串数组`,
      400,
      { pluginId, id, field },
    );
  }
  for (const value of values as string[]) {
    if (!isValid(value)) {
      throw new HelmError(
        'invalid_ui_spec',
        `插件 ${pluginId} ui.${fnName} 的 ${field} 项 "${value}" 非法（${expect}）`,
        400,
        { pluginId, id, field, value },
      );
    }
  }
  const unique = new Set(values as string[]);
  if (unique.size !== values.length) {
    throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.${fnName} 的 ${field} 含重复项`, 400, {
      pluginId,
      id,
      field,
    });
  }
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
    npmDependencies?: Readonly<Record<string, string>>;
  } | undefined;
  dataDir: string;
  isDisposed: () => boolean;
  compile?: (
    pluginId: string,
    clientRoot: string,
    moduleRef: string,
    dataDir: string,
    options?: { npmRoots?: ReadonlyArray<ClientNpmRoot> },
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

    // UI 动作统一校验（conversation:header / conversation:row / timeline:entry）：
    // actionId / client 二者至少提供其一（否则宿主无法渲染也无法执行）。
    const uiActionTarget = (Object.keys(UI_ACTION_SURFACES) as Array<UiActionSpec['target']>).find(
      (key) => UI_ACTION_SURFACES[key] === surface,
    );
    if (uiActionTarget !== undefined) {
      const target = uiActionTarget;
      const actionId = (spec as { actionId?: unknown }).actionId;
      const hasClient = (spec as { client?: unknown }).client !== undefined;
      if (actionId === undefined && !hasClient) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.action（${target}）需至少提供 actionId 或 client 之一`,
          400,
          { pluginId, id },
        );
      }
      if (actionId !== undefined && (typeof actionId !== 'string' || actionId.length === 0 || actionId.includes('.'))) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.action 的 actionId 必须是非空且不含点号的动作 id（跨插件请用 actionPluginId）`,
          400,
          { pluginId, id },
        );
      }
      const actionPluginId = (spec as { actionPluginId?: unknown }).actionPluginId;
      if (actionPluginId !== undefined && (typeof actionPluginId !== 'string' || actionPluginId.length === 0)) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.action 的 actionPluginId 必须是非空插件 id`,
          400,
          { pluginId, id },
        );
      }
      // placement 仅 conversation:header 允许；kinds/roles 仅 timeline:entry 允许。
      if (target !== 'conversation:header') {
        const placement = (spec as { placement?: unknown }).placement;
        if (placement !== undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.action（${target}）不允许 placement（仅 conversation:header 支持）`,
            400,
            { pluginId, id },
          );
        }
      } else {
        const placement = (spec as { placement?: unknown }).placement;
        if (placement !== undefined && placement !== 'toolbar' && placement !== 'menu') {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.action 的 placement 仅允许 'toolbar' | 'menu'`,
            400,
            { pluginId, id },
          );
        }
      }
      if (target === 'timeline:entry') {
        const kinds = (spec as { kinds?: unknown }).kinds;
        if (
          kinds !== undefined &&
          (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => typeof k !== 'string' || k.length === 0))
        ) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.action（timeline:entry）的 kinds 必须是非空字符串数组`,
            400,
            { pluginId, id },
          );
        }
        const roles = (spec as { roles?: unknown }).roles;
        if (roles !== undefined) {
          if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => r !== 'user' && r !== 'assistant')) {
            throw new HelmError(
              'invalid_ui_spec',
              `插件 ${pluginId} ui.action（timeline:entry）的 roles 仅允许 'user' | 'assistant' 非空数组`,
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
            `插件 ${pluginId} ui.action（${target}）不允许 kinds（仅 timeline:entry 支持）`,
            400,
            { pluginId, id },
          );
        }
        const roles = (spec as { roles?: unknown }).roles;
        if (roles !== undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.action（${target}）不允许 roles（仅 timeline:entry 支持）`,
            400,
            { pluginId, id },
          );
        }
      }
      // target 字段与 surface 重复（surface 已携带语义），注册输入侧剔除避免存储歧义。
      delete (spec as Record<string, unknown>)['target'];
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
      if (actionId === undefined && !hasClient) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.command 需至少提供 actionId 或 client 之一（命令必须可触发）`,
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

    if (surface === 'markdown.codeBlock') {
      const languages = (spec as { languages?: unknown }).languages;
      if (
        !Array.isArray(languages) ||
        languages.length === 0 ||
        languages.some((l) => typeof l !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(l))
      ) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.markdownCodeBlock 的 languages 必须是非空字符串数组（每项为小写语言标识，匹配 /^[a-z0-9][a-z0-9-]{0,31}$/）`,
          400,
          { pluginId, id },
        );
      }
      const unique = new Set(languages as string[]);
      if (unique.size !== languages.length) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.markdownCodeBlock 的 languages 含重复项`, 400, {
          pluginId,
          id,
        });
      }
      if ((spec as { client?: unknown }).client === undefined) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.markdownCodeBlock 必须声明 client 组件引用（无声明式轨道）`,
          400,
          { pluginId, id },
        );
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

    if (surface === 'artifact.previewer') {
      const label = (spec as { label?: unknown }).label;
      if (typeof label !== 'string' || label.length === 0) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.artifactPreviewer 需要非空 label`, 400, {
          pluginId,
          id,
        });
      }
      assertArtifactMatchList(
        pluginId,
        fnName,
        id,
        'mimeTypes',
        (spec as { mimeTypes?: unknown }).mimeTypes,
        (value) => CANONICAL_MIME_PATTERN.test(value) && value !== '*/*',
        '仅允许小写 type/subtype 精确值或 type/* 通配，不允许 */*、参数、glob 与大写',
      );
      assertArtifactMatchList(
        pluginId,
        fnName,
        id,
        'extensions',
        (spec as { extensions?: unknown }).extensions,
        (value) => ARTIFACT_EXTENSION_PATTERN.test(value),
        '仅允许小写、前导点、可多段的后缀（如 .md、.tar.gz），不含路径段与通配符',
      );
    }

    if (surface === 'composer.completer') {
      const label = (spec as { label?: unknown }).label;
      if (typeof label !== 'string' || label.length === 0) {
        throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.composerCompleter 需要非空 label`, 400, {
          pluginId,
          id,
        });
      }
      // '/' 保留给宿主命令与技能补全；宿主统一渲染，不接受 client 视图轨。
      const forbidden = ['client'] as const;
      for (const field of forbidden) {
        if ((spec as Record<string, unknown>)[field] !== undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.composerCompleter 不允许声明 ${field}（补全由宿主统一渲染，仅接受声明式数据源）`,
            400,
            { pluginId, id, field },
          );
        }
      }
      const trigger = (spec as { trigger?: unknown }).trigger;
      if (trigger !== '@' && trigger !== '#' && trigger !== ':') {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.composerCompleter 的 trigger 仅允许 '@' | '#' | ':'（'/' 保留给命令与技能）`,
          400,
          { pluginId, id, trigger: String(trigger) },
        );
      }
      const source = (spec as { source?: unknown }).source;
      if (!isPlainObject(source)) {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.composerCompleter 需要 source（{ kind: 'action' | 'doc' | 'sessionDoc', ... }）`,
          400,
          { pluginId, id },
        );
      }
      const kind = source['kind'];
      if (kind === 'action') {
        const sourceKeys = Object.keys(source);
        if (sourceKeys.some((k) => k !== 'kind' && k !== 'actionId' && k !== 'actionPluginId')) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.composerCompleter 的 action 源仅允许 { kind, actionId, actionPluginId? }，不得混入 doc 源字段`,
            400,
            { pluginId, id },
          );
        }
        const actionId = source['actionId'];
        if (typeof actionId !== 'string' || actionId.length === 0 || actionId.includes('.')) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.composerCompleter 的 actionId 必须是非空且不含点号的动作 id（跨插件请用 actionPluginId）`,
            400,
            { pluginId, id },
          );
        }
        const actionPluginId = source['actionPluginId'];
        if (actionPluginId !== undefined && (typeof actionPluginId !== 'string' || actionPluginId.length === 0)) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.composerCompleter 的 actionPluginId 必须是非空插件 id`,
            400,
            { pluginId, id },
          );
        }
      } else if (kind === 'doc' || kind === 'sessionDoc') {
        const sourceKeys = Object.keys(source);
        if (sourceKeys.some((k) => k !== 'kind' && k !== 'name' && k !== 'itemsField')) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.composerCompleter 的 ${kind} 源仅允许 { kind, name, itemsField }，不得混入 action 源字段`,
            400,
            { pluginId, id },
          );
        }
        const name = source['name'];
        if (typeof name !== 'string' || !COMPLETER_DOC_NAME_PATTERN.test(name)) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.composerCompleter 的 ${kind} 源 name 必须是本插件公开文档名（允许字符 A-Za-z0-9._-）`,
            400,
            { pluginId, id, name: String(name) },
          );
        }
        const itemsField = source['itemsField'];
        if (
          typeof itemsField !== 'string' ||
          !COMPLETER_ITEMS_FIELD_PATTERN.test(itemsField) ||
          UNSAFE_TOP_LEVEL_KEYS.has(itemsField)
        ) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.composerCompleter 的 itemsField 必须是安全顶层键（拒 __proto__/constructor/prototype 与非常规字符）`,
            400,
            { pluginId, id, itemsField: String(itemsField) },
          );
        }
      } else {
        throw new HelmError(
          'invalid_ui_spec',
          `插件 ${pluginId} ui.composerCompleter 的 source.kind 仅允许 'action' | 'doc' | 'sessionDoc'`,
          400,
          { pluginId, id, kind: String(kind) },
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
  ): Promise<ClientCompileResult> {
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
    const compile = options.compile ?? compilePluginClientModule;
    // 受控 npm 依赖：定义声明的 specifiers -> 解析根聚合（与 doctor 链同一映射口径）。
    const npmRoots: ClientNpmRoot[] = clientNpmRootsOf(info.npmDependencies);
    const result = await compile(pluginId, clientRoot, moduleRef, options.dataDir, {
      ...(npmRoots.length > 0 ? { npmRoots } : {}),
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
