/**
 * ui-spec-validators.ts：registerUi 各 surface 声明的纯校验器与分发表。
 *
 * registry（ui-registry.ts）退化为存储 + 派发：通用前置（纯对象 / id /
 * priority|order）、scope 与 client 引用校验留在 registerUi 本体；surface
 * 专属规则按拆分前的逐块顺序拆为两阶段——
 * - 早期块（UI 动作 / commandPalette / profile.runtime / plugin.slot）先于
 *   scope 与 client 引用校验执行；
 * - 晚期块（timeline.renderer / markdown.codeBlock / tool.view /
 *   artifact.previewer / composer.completer / workbench.panel）在 client
 *   引用校验之后执行。
 * 两阶段划分只为保持拆分前的错误优先级逐字节等价（同一 spec 同时踩中
 * surface 规则与 scope/client 规则时，抛错先后不变），无语义差别。
 * 全部校验器均为纯函数（UI 动作的 delete spec.target 是唯一的输入归一
 * 副作用，与拆分前一致），错误码 / 消息 / details 与拆分前逐字保持。
 */
import {
  HelmError,
  RESERVED_SLASH_COMMANDS,
  type PluginUiContribution,
  type UiActionSpec,
} from '@helm/protocol';
import { isPlainObject } from './shared.js';

/** 宿主保留的命令斜杠触发词（skill: 前缀整体保留），插件不得占用。 */
const RESERVED_COMMAND_SLASH: ReadonlySet<string> = new Set(RESERVED_SLASH_COMMANDS);

/** UI 动作三类 target 到注册 surface 的映射（统一 UiActionSpec.target 语义；plugin-host 与 registry 共用）。 */
export const UI_ACTION_SURFACES: Readonly<Record<UiActionSpec['target'], string>> = {
  'conversation:header': 'conversation.header.action',
  'conversation:row': 'conversation.row.action',
  'timeline:entry': 'timeline.entry.action',
};

/** 反查表：注册 surface -> UI 动作 target（派发键即三个动作 surface）。 */
const UI_ACTION_TARGET_BY_SURFACE: Readonly<Record<string, UiActionSpec['target']>> = Object.fromEntries(
  (Object.keys(UI_ACTION_SURFACES) as Array<UiActionSpec['target']>).map((key) => [UI_ACTION_SURFACES[key], key]),
);

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

/** 校验器上下文：registry 在派发点一次构造，逐校验器只读。 */
export interface UiSpecContext {
  pluginId: string;
  /** 声明入口名（如 timelineRenderer），错误消息定位用。 */
  fnName: string;
  /** 本次注册的 surface（UI 动作校验器据其反查 target）。 */
  surface: string;
  /** 插件定义提供的 clientRoot（client 引用归属检查用；缺省表示未提供）。 */
  clientRoot?: string;
  /** 宿主是否注入构建端口（client 引用可用性检查用）。 */
  hasBuildProvider: boolean;
  /** 本插件已注册的 UI 贡献（commandPalette slash / profile.runtime kind 的插件内去重）。 */
  siblings: readonly PluginUiContribution[];
}

export type UiSpecValidator = (spec: Record<string, unknown>, id: string, ctx: UiSpecContext) => void;

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

/**
 * UI 动作统一校验（conversation:header / conversation:row / timeline:entry）：
 * actionId / client 二者至少提供其一（否则宿主无法渲染也无法执行）。
 * 副作用：target 字段与 surface 重复（surface 已携带语义），注册输入侧剔除
 * 避免存储歧义（与拆分前一致）。
 */
function validateUiActionSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId, fnName } = ctx;
  const target = UI_ACTION_TARGET_BY_SURFACE[ctx.surface];
  if (target === undefined) return;
  const actionId = spec['actionId'];
  const hasClient = spec['client'] !== undefined;
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
  const actionPluginId = spec['actionPluginId'];
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
    const placement = spec['placement'];
    if (placement !== undefined) {
      throw new HelmError(
        'invalid_ui_spec',
        `插件 ${pluginId} ui.action（${target}）不允许 placement（仅 conversation:header 支持）`,
        400,
        { pluginId, id },
      );
    }
  } else {
    const placement = spec['placement'];
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
    const kinds = spec['kinds'];
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
    const roles = spec['roles'];
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
    const kinds = spec['kinds'];
    if (kinds !== undefined) {
      throw new HelmError(
        'invalid_ui_spec',
        `插件 ${pluginId} ui.action（${target}）不允许 kinds（仅 timeline:entry 支持）`,
        400,
        { pluginId, id },
      );
    }
    const roles = spec['roles'];
    if (roles !== undefined) {
      throw new HelmError(
        'invalid_ui_spec',
        `插件 ${pluginId} ui.action（${target}）不允许 roles（仅 timeline:entry 支持）`,
        400,
        { pluginId, id },
      );
    }
  }
  delete spec['target'];
}

/** commandPalette：slash 触发词格式、宿主保留词与插件内同名去重；命令可触发性。 */
function validateCommandPaletteSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const slash = spec['slash'];
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
    for (const u of ctx.siblings) {
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
  const actionId = spec['actionId'];
  if (actionId !== undefined && (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(actionId))) {
    throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.command 的 actionId 必须是合法动作标识`, 400);
  }
  if (slash !== undefined && actionId === undefined) {
    throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.command 声明 slash 时必须绑定 actionId`, 400);
  }
  const hasClient = spec['client'] !== undefined;
  if (actionId === undefined && !hasClient) {
    throw new HelmError(
      'invalid_ui_spec',
      `插件 ${pluginId} ui.command 需至少提供 actionId 或 client 之一（命令必须可触发）`,
      400,
      { pluginId, id },
    );
  }
  const actionPluginId = spec['actionPluginId'];
  if (actionPluginId !== undefined && (typeof actionPluginId !== 'string' || actionPluginId.length === 0)) {
    throw new HelmError(
      'invalid_ui_spec',
      `插件 ${pluginId} ui.command 的 actionPluginId 必须是非空插件 id`,
      400,
      { pluginId, id },
    );
  }
}

/** profile.runtime：kind 必填且格式合法；重复 kind 插件内直接拒绝（跨插件冲突在提交点终检）。 */
function validateProfileRuntimeSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const kind = spec['kind'];
  if (typeof kind !== 'string' || kind.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(kind)) {
    throw new HelmError(
      'invalid_ui_spec',
      `插件 ${pluginId} ui.profileRuntime 的 kind 必须匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`,
      400,
      { pluginId, id, kind: String(kind) },
    );
  }
  const label = spec['label'];
  if (typeof label !== 'string' || label.length === 0) {
    throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.profileRuntime 需要非空 label`, 400, {
      pluginId,
      id,
    });
  }
  const agentSuggestions = spec['agentSuggestions'];
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
  for (const u of ctx.siblings) {
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

/** plugin.slot：target 必须恰有一个 '/'，两段均为合法标识。 */
function validateSlotSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const target = spec['target'];
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

/** timeline.renderer：matchMeta 仅允许 { renderer: 非空字符串 }。 */
function validateTimelineRendererSpec(spec: Record<string, unknown>, _id: string, ctx: UiSpecContext): void {
  const { pluginId, fnName } = ctx;
  const matchMeta = spec['matchMeta'];
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

/** markdown.codeBlock：languages 非空小写标识数组、无重复；必须声明 client 组件引用。 */
function validateMarkdownCodeBlockSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const languages = spec['languages'];
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
  if (spec['client'] === undefined) {
    throw new HelmError(
      'invalid_ui_spec',
      `插件 ${pluginId} ui.markdownCodeBlock 必须声明 client 组件引用（无声明式轨道）`,
      400,
      { pluginId, id },
    );
  }
}

/** tool.view：replaceRow 布尔；toolNames 非空字符串数组。 */
function validateToolViewSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const replaceRow = spec['replaceRow'];
  if (replaceRow !== undefined && typeof replaceRow !== 'boolean') {
    throw new HelmError(
      'invalid_ui_spec',
      `插件 ${pluginId} ui.toolView 的 replaceRow 必须是布尔值（实际：${typeof replaceRow}）`,
      400,
      { pluginId, id },
    );
  }
  const toolNames = spec['toolNames'];
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

/** artifact.previewer：非空 label 与规范 MIME/后缀匹配声明列表。 */
function validateArtifactPreviewerSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId, fnName } = ctx;
  const label = spec['label'];
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
    spec['mimeTypes'],
    (value) => CANONICAL_MIME_PATTERN.test(value) && value !== '*/*',
    '仅允许小写 type/subtype 精确值或 type/* 通配，不允许 */*、参数、glob 与大写',
  );
  assertArtifactMatchList(
    pluginId,
    fnName,
    id,
    'extensions',
    spec['extensions'],
    (value) => ARTIFACT_EXTENSION_PATTERN.test(value),
    '仅允许小写、前导点、可多段的后缀（如 .md、.tar.gz），不含路径段与通配符',
  );
}

/** composer.completer：label/trigger/补全源形状与互斥（禁 client 视图轨）。 */
function validateComposerCompleterSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const label = spec['label'];
  if (typeof label !== 'string' || label.length === 0) {
    throw new HelmError('invalid_ui_spec', `插件 ${pluginId} ui.composerCompleter 需要非空 label`, 400, {
      pluginId,
      id,
    });
  }
  // '/' 保留给宿主命令与技能补全；宿主统一渲染，不接受 client 视图轨。
  const forbidden = ['client'] as const;
  for (const field of forbidden) {
    if (spec[field] !== undefined) {
      throw new HelmError(
        'invalid_ui_spec',
        `插件 ${pluginId} ui.composerCompleter 不允许声明 ${field}（补全由宿主统一渲染，仅接受声明式数据源）`,
        400,
        { pluginId, id, field },
      );
    }
  }
  const trigger = spec['trigger'];
  if (trigger !== '@' && trigger !== '#' && trigger !== ':') {
    throw new HelmError(
      'invalid_ui_spec',
      `插件 ${pluginId} ui.composerCompleter 的 trigger 仅允许 '@' | '#' | ':'（'/' 保留给命令与技能）`,
      400,
      { pluginId, id, trigger: String(trigger) },
    );
  }
  const source = spec['source'];
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

/** workbench.panel：badge 仅允许声明式字段形状（doc 订阅 + 计数/色调字段名）。 */
function validateWorkbenchPanelSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const badge = spec['badge'];
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

/**
 * 早期 surface 校验器（scope 与 client 引用通用校验之前派发）：
 * UI 动作三 surface、commandPalette、profile.runtime、plugin.slot。
 */
const EARLY_VALIDATORS: Readonly<Record<string, UiSpecValidator>> = {
  [UI_ACTION_SURFACES['conversation:header']]: validateUiActionSpec,
  [UI_ACTION_SURFACES['conversation:row']]: validateUiActionSpec,
  [UI_ACTION_SURFACES['timeline:entry']]: validateUiActionSpec,
  commandPalette: validateCommandPaletteSpec,
  'profile.runtime': validateProfileRuntimeSpec,
  'plugin.slot': validateSlotSpec,
};

/**
 * 晚期 surface 校验器（client 引用通用校验之后派发）：timeline.renderer、
 * markdown.codeBlock、tool.view、artifact.previewer、composer.completer、
 * workbench.panel。
 */
const LATE_VALIDATORS: Readonly<Record<string, UiSpecValidator>> = {
  'timeline.renderer': validateTimelineRendererSpec,
  'markdown.codeBlock': validateMarkdownCodeBlockSpec,
  'tool.view': validateToolViewSpec,
  'artifact.previewer': validateArtifactPreviewerSpec,
  'composer.completer': validateComposerCompleterSpec,
  'workbench.panel': validateWorkbenchPanelSpec,
};

/** 早期阶段派发：无对应校验器的 surface（sidebar/screen 等）直接通过。 */
export function validateUiSpecEarly(
  surface: string,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
): void {
  EARLY_VALIDATORS[surface]?.(spec, id, ctx);
}

/** 晚期阶段派发：无对应校验器的 surface 直接通过。 */
export function validateUiSpecLate(
  surface: string,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
): void {
  LATE_VALIDATORS[surface]?.(spec, id, ctx);
}
