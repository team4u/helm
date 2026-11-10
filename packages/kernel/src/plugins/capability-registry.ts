/**
 * capability-registry.ts: 负责工具（Tool）、动作（Action）、自定义路由（Route）的注册、查找、可见性与执行。
 *
 * 职责：
 * - 注册边界 Schema 预编译与参数强校验（CLI 命令与位置参数、provider-safe 别名生成、相对路由命名空间拼装）；
 * - ConversationScope 会话级可见性过滤与执行期二次校验（双保险防绕过）；
 * - 工具清单派生（DerivedToolSpec，合并 ctx.tool 与 exposeAsTool 动作，校验工具名全局唯一）；
 * - 动作与工具的预检（prepareAction）、执行调度（invokeAction、executeTool）与 PluginTaskTracker 集成。
 */
import { createHash } from 'node:crypto';
import {
  HelmError,
  matchesConversationScope,
  type ActionManifest,
  type ConversationScope,
  type ConversationSummary,
  type JsonSchema,
  type PluginActionContext,
  type PluginActionSpec,
  type PluginRouteSpec,
  type PluginToolContext,
  type PluginToolSpec,
} from '@helm/protocol';
import { assertSchemaCompilable, validatePluginInput, validatePluginOutput } from './schema.js';
import type { PluginTaskTracker } from './tracking.js';
import {
  assertConversationScope,
  assertValidId,
  decodeSegmentStrict,
  isJsonObject,
  isPlainObject,
  jsonClone,
} from './shared.js';

export interface DerivedToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** 结构化输出 Schema（ctx.tool 声明时透传；run_action 派生工具无此字段）。 */
  structuredOutputSchema?: JsonSchema;
  sourcePluginId: string;
  sourceKind: 'action' | 'tool';
  /** 仅 sourceKind === 'action'：pluginId.actionId 全限定 ID。 */
  qualifiedId?: string;
}

export interface PluginRouteEntry extends PluginRouteSpec {
  pluginId: string;
}

/** 模型工具名的 provider 安全约束（OpenAI 函数名子集，全 provider 通用）。 */
export const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 为 exposeAsTool 动作生成稳定 provider-safe 别名：语义前缀 + 全限定 ID 短哈希。
 * 纯函数、跨重启确定：pi-ai convertTools 原样发送 tool.name，含 ':'/'.' 的
 * 全限定 ID 不被任何 provider 接受，且朴素清洗（替换非法字符）会碰撞，故附哈希。
 */
export function actionToolAlias(pluginId: string, actionId: string): string {
  const semantic = `${pluginId.replace(/^builtin:/, '')}.${actionId}`
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  const hash = createHash('sha1').update(`${pluginId}.${actionId}`).digest('hex').slice(0, 8);
  return `${semantic}_${hash}`;
}

/**
 * 解析全限定 actionId（pluginId.actionId）。pluginId 允许含 ':'（builtin:profile），
 * 因此不能简单 split 最后一个 '.' —— 以第一个 '.' 分割。
 */
export function parseQualifiedActionId(qualified: string): { pluginId: string; actionId: string } {
  const dot = qualified.indexOf('.');
  if (dot <= 0 || dot >= qualified.length - 1) {
    throw new HelmError('invalid_action_id', `非法动作全限定 id：${qualified}（期望 pluginId.actionId）`, 400, {
      qualified,
    });
  }
  return { pluginId: qualified.slice(0, dot), actionId: qualified.slice(dot + 1) };
}

export interface ActionEntry {
  pluginId: string;
  id: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  cli?: PluginActionSpec<unknown, unknown>['cli'];
  exposeAsTool: boolean;
  idempotent?: boolean;
  toolAlias: string;
  scope?: ConversationScope;
  handler: (input: never, context: PluginActionContext) => unknown;
}

export interface ToolEntry {
  pluginId: string;
  spec: PluginToolSpec;
}

/**
 * scope 执行期校验：scope 未声明或调用无会话上下文（人工调用）
 * 直接放行；否则经 getConversation 解析会话后按 matchesConversationScope
 * 判定。会话不存在由 getConversation 如实抛错。
 */
export function assertScopeAllows(
  pluginId: string,
  what: string,
  scope: ConversationScope | undefined,
  conversationId: number | undefined,
  getConversation: (id: number) => ConversationSummary,
): void {
  if (scope === undefined || conversationId === undefined) return;
  const conversation = getConversation(conversationId);
  if (!matchesConversationScope(scope, conversation)) {
    throw new HelmError('conversation_scope_violation', `${what} 不允许在会话 ${conversationId} 上执行（scope 未命中）`, 403, {
      pluginId,
      conversationId,
    });
  }
}

function pluginRoutePrefix(pluginId: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/routes`;
}

function toManifest(entry: ActionEntry): ActionManifest {
  const manifest: ActionManifest = {
    pluginId: entry.pluginId,
    id: entry.id,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    exposeAsTool: entry.exposeAsTool,
    ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
    ...(entry.idempotent !== undefined ? { idempotent: entry.idempotent } : {}),
  };
  if (entry.cli) manifest.cli = entry.cli;
  return manifest;
}

export interface CapabilityExecutionOptions {
  assertActive: (pluginId: string) => void;
  getConversation: (id: number) => ConversationSummary;
  tracker: PluginTaskTracker;
  isPluginRegistered: (pluginId: string) => boolean;
}

export class CapabilityRegistry {
  private actions = new Map<string, Map<string, ActionEntry>>();
  private tools = new Map<string, Map<string, ToolEntry>>();
  private routes = new Map<string, PluginRouteEntry[]>();

  registerAction<TIn, TOut>(pluginId: string, spec: PluginActionSpec<TIn, TOut>): void {
    assertValidId('动作', spec.id);
    if (spec.id.includes('.')) {
      throw new HelmError(
        'invalid_action_spec',
        `插件 ${pluginId} 动作 id 不允许点号（全限定解析以首个 '.' 分割）：${spec.id}`,
        400,
      );
    }
    if (typeof spec.description !== 'string' || spec.description.length === 0) {
      throw new HelmError('invalid_action_spec', `插件 ${pluginId} 动作 ${spec.id} 缺少 description`, 400);
    }
    if (!isJsonObject(spec.inputSchema) || !isJsonObject(spec.outputSchema)) {
      throw new HelmError(
        'invalid_action_spec',
        `插件 ${pluginId} 动作 ${spec.id} 必须同时声明 inputSchema 与 outputSchema（单点 Schema 契约）`,
        400,
      );
    }
    if (typeof spec.handler !== 'function') {
      throw new HelmError('invalid_action_spec', `插件 ${pluginId} 动作 ${spec.id} 缺少 handler`, 400);
    }
    if (
      spec.cli?.command !== undefined &&
      (!Array.isArray(spec.cli.command) ||
        spec.cli.command.length === 0 ||
        !spec.cli.command.every((seg) => typeof seg === 'string' && seg.length > 0))
    ) {
      throw new HelmError(
        'invalid_action_spec',
        `插件 ${pluginId} 动作 ${spec.id} 的 cli.command 必须是非空字符串数组（语义化顶层命令路径）`,
        400,
      );
    }
    if (spec.cli?.positional !== undefined) {
      if (!Array.isArray(spec.cli.positional)) {
        throw new HelmError(
          'invalid_action_spec',
          `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 必须是数组`,
          400,
        );
      }
      const properties =
        spec.inputSchema.type === 'object' && isJsonObject(spec.inputSchema.properties)
          ? (spec.inputSchema.properties as Record<string, unknown>)
          : undefined;
      if (properties === undefined) {
        throw new HelmError(
          'invalid_action_spec',
          `插件 ${pluginId} 动作 ${spec.id} 声明 cli.positional 但 inputSchema 不是带 properties 的 object`,
          400,
        );
      }
      const writeTargets = new Set<string>();
      let seenOptional = false;
      for (const pos of spec.cli.positional) {
        if (!isPlainObject(pos) || Object.keys(pos).some((k) => k !== 'field' && k !== 'required' && k !== 'readFileInto')) {
          throw new HelmError(
            'invalid_action_spec',
            `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 项仅允许 { field, required?, readFileInto? }`,
            400,
          );
        }
        if (typeof pos.field !== 'string' || pos.field.length === 0) {
          throw new HelmError(
            'invalid_action_spec',
            `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional[].field 必须是非空字符串`,
            400,
          );
        }
        if (pos.required !== undefined && typeof pos.required !== 'boolean') {
          throw new HelmError(
            'invalid_action_spec',
            `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional[${pos.field}].required 必须是 boolean`,
            400,
          );
        }
        if (pos.readFileInto !== undefined && (typeof pos.readFileInto !== 'string' || pos.readFileInto.length === 0)) {
          throw new HelmError(
            'invalid_action_spec',
            `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional[${pos.field}].readFileInto 必须是非空字符串字段名`,
            400,
          );
        }
        for (const name of [pos.field, pos.readFileInto] as const) {
          if (name === undefined) continue;
          if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
            throw new HelmError(
              'invalid_action_spec',
              `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 字段名 "${name}" 不可用（原型污染键）`,
              400,
            );
          }
          if (writeTargets.has(name)) {
            throw new HelmError(
              'invalid_action_spec',
              `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 重复写入字段 "${name}"（field/readFileInto 目标不得重叠）`,
              400,
            );
          }
          writeTargets.add(name);
          if (!Object.hasOwn(properties, name)) {
            throw new HelmError(
              'invalid_action_spec',
              `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional 字段 "${name}" 不在 inputSchema.properties 中`,
              400,
            );
          }
        }
        if (pos.readFileInto !== undefined) {
          const target = properties[pos.readFileInto] as { type?: unknown } | undefined;
          if (target === null || typeof target !== 'object' || target.type !== 'string') {
            throw new HelmError(
              'invalid_action_spec',
              `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional "${pos.field}" 的 readFileInto 目标 "${pos.readFileInto}" 需为 type: string 属性`,
              400,
            );
          }
        }
        if (pos.required === true) {
          if (seenOptional) {
            throw new HelmError(
              'invalid_action_spec',
              `插件 ${pluginId} 动作 ${spec.id} 的 cli.positional required 字段 "${pos.field}" 出现在 optional 之后（required 必须连续）`,
              400,
            );
          }
        } else {
          seenOptional = true;
        }
      }
    }
    if (
      spec.cli?.timeoutMs !== undefined &&
      (typeof spec.cli.timeoutMs !== 'number' || !Number.isFinite(spec.cli.timeoutMs) || spec.cli.timeoutMs < 0)
    ) {
      throw new HelmError(
        'invalid_action_spec',
        `插件 ${pluginId} 动作 ${spec.id} 的 cli.timeoutMs 必须是 >= 0 的有限数字（0 表示无超时）`,
        400,
      );
    }
    assertConversationScope(pluginId, `插件 ${pluginId} 动作 ${spec.id}`, spec.scope);
    if (spec.idempotent !== undefined && typeof spec.idempotent !== 'boolean') {
      throw new HelmError('validation_error', `插件 ${pluginId} 动作 ${spec.id} 的 idempotent 必须为 boolean`, 400);
    }

    let pluginActions = this.actions.get(pluginId);
    if (!pluginActions) {
      pluginActions = new Map();
      this.actions.set(pluginId, pluginActions);
    }
    if (pluginActions.has(spec.id)) {
      throw new HelmError('duplicate_action', `插件 ${pluginId} 重复声明动作 ${spec.id}`, 409);
    }

    assertSchemaCompilable(spec.inputSchema);
    assertSchemaCompilable(spec.outputSchema);

    pluginActions.set(spec.id, {
      pluginId,
      id: spec.id,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      cli: spec.cli,
      exposeAsTool: spec.exposeAsTool === true,
      ...(spec.idempotent !== undefined ? { idempotent: spec.idempotent } : {}),
      toolAlias: actionToolAlias(pluginId, spec.id),
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
      handler: spec.handler as (input: never, context: PluginActionContext) => unknown,
    });
  }

  registerTool<TIn>(pluginId: string, spec: PluginToolSpec<TIn>): void {
    assertValidId('工具', spec.name);
    if (!PROVIDER_SAFE_TOOL_NAME.test(spec.name)) {
      throw new HelmError(
        'invalid_tool_spec',
        `插件 ${pluginId} 工具名 ${spec.name} 必须匹配 ${PROVIDER_SAFE_TOOL_NAME.source}（provider 函数名约束）`,
        400,
      );
    }
    if (typeof spec.description !== 'string' || spec.description.length === 0) {
      throw new HelmError('invalid_tool_spec', `插件 ${pluginId} 工具 ${spec.name} 缺少 description`, 400);
    }
    if (!isJsonObject(spec.inputSchema)) {
      throw new HelmError('invalid_tool_spec', `插件 ${pluginId} 工具 ${spec.name} 缺少 inputSchema`, 400);
    }
    if (spec.structuredOutputSchema !== undefined) {
      if (!isJsonObject(spec.structuredOutputSchema)) {
        throw new HelmError(
          'invalid_tool_spec',
          `插件 ${pluginId} 工具 ${spec.name} 的 structuredOutputSchema 必须是 JSON Schema 对象`,
          400,
        );
      }
      assertSchemaCompilable(spec.structuredOutputSchema);
    }
    if (typeof spec.execute !== 'function') {
      throw new HelmError('invalid_tool_spec', `插件 ${pluginId} 工具 ${spec.name} 缺少 execute`, 400);
    }
    assertConversationScope(pluginId, `插件 ${pluginId} 工具 ${spec.name}`, spec.scope);

    let pluginTools = this.tools.get(pluginId);
    if (!pluginTools) {
      pluginTools = new Map();
      this.tools.set(pluginId, pluginTools);
    }
    if (pluginTools.has(spec.name)) {
      throw new HelmError('duplicate_tool', `插件 ${pluginId} 重复声明工具 ${spec.name}`, 409);
    }
    assertSchemaCompilable(spec.inputSchema);

    pluginTools.set(spec.name, { pluginId, spec: spec as PluginToolSpec });
  }

  registerRoute(pluginId: string, spec: PluginRouteSpec): void {
    if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) {
      throw new HelmError(
        'invalid_route_path',
        `插件 ${pluginId} 路由 path 必须是以 / 开头的相对路径（宿主自动挂载到插件命名空间）：${String(spec.path)}`,
        400,
      );
    }
    if (spec.path === '/api' || spec.path.startsWith('/api/')) {
      throw new HelmError(
        'invalid_route_path',
        `插件 ${pluginId} 路由 ${spec.method} ${spec.path} 不允许携带 /api 前缀（请声明相对路径，宿主负责命名空间拼接）`,
        400,
      );
    }
    if (spec.path === '/') {
      throw new HelmError('invalid_route_path', `插件 ${pluginId} 路由相对路径至少需要一段（不允许仅 /）`, 400);
    }
    if (spec.path.includes('?') || spec.path.includes('#')) {
      throw new HelmError(
        'invalid_route_path',
        `插件 ${pluginId} 路由 ${spec.method} ${spec.path} 不允许携带查询串或片段`,
        400,
      );
    }
    for (const seg of spec.path.slice(1).split('/')) {
      if (seg.length === 0) {
        throw new HelmError(
          'invalid_route_path',
          `插件 ${pluginId} 路由 ${spec.method} ${spec.path} 不允许空路径段（// 或尾斜杠）`,
          400,
        );
      }
      const decoded = decodeSegmentStrict(seg);
      if (decoded === '.' || decoded === '..' || decoded.includes('/')) {
        throw new HelmError(
          'invalid_route_path',
          `插件 ${pluginId} 路由 ${spec.method} ${spec.path} 不允许点段（. / ..）或编码斜杠`,
          400,
        );
      }
    }
    if (typeof spec.handler !== 'function') {
      throw new HelmError('invalid_route_handler', `插件 ${pluginId} 路由 ${spec.path} 缺少 handler`, 400);
    }

    let pluginRoutes = this.routes.get(pluginId);
    if (!pluginRoutes) {
      pluginRoutes = [];
      this.routes.set(pluginId, pluginRoutes);
    }
    pluginRoutes.push({ ...spec, path: `${pluginRoutePrefix(pluginId)}${spec.path}`, pluginId });
  }

  getActionIds(pluginId: string): string[] {
    const list = this.actions.get(pluginId);
    return list ? [...list.keys()] : [];
  }

  getToolNames(pluginId: string): string[] {
    const list = this.tools.get(pluginId);
    return list ? [...list.keys()] : [];
  }

  listActions(activePluginIds: Iterable<string>): ActionManifest[] {
    const out: ActionManifest[] = [];
    for (const pluginId of activePluginIds) {
      const pluginActions = this.actions.get(pluginId);
      if (!pluginActions) continue;
      for (const entry of pluginActions.values()) {
        out.push(toManifest(entry));
      }
    }
    return out;
  }

  listTools(activePluginIds: Iterable<string>, conversation?: ConversationSummary): DerivedToolSpec[] {
    const out: DerivedToolSpec[] = [];
    for (const pluginId of activePluginIds) {
      const pluginTools = this.tools.get(pluginId);
      if (pluginTools) {
        for (const tool of pluginTools.values()) {
          if (conversation !== undefined && !matchesConversationScope(tool.spec.scope, conversation)) continue;
          out.push({
            name: tool.spec.name,
            description: tool.spec.description,
            inputSchema: tool.spec.inputSchema,
            ...(tool.spec.structuredOutputSchema !== undefined
              ? { structuredOutputSchema: tool.spec.structuredOutputSchema }
              : {}),
            sourcePluginId: pluginId,
            sourceKind: 'tool',
          });
        }
      }
      const pluginActions = this.actions.get(pluginId);
      if (pluginActions) {
        for (const action of pluginActions.values()) {
          if (!action.exposeAsTool) continue;
          if (conversation !== undefined && !matchesConversationScope(action.scope, conversation)) continue;
          out.push({
            name: action.toolAlias,
            description: action.description,
            inputSchema: action.inputSchema,
            sourcePluginId: pluginId,
            sourceKind: 'action',
            qualifiedId: `${pluginId}.${action.id}`,
          });
        }
      }
    }
    const dups = out.filter((t, i) => out.findIndex((x) => x.name === t.name) !== i);
    if (dups.length > 0) {
      throw new HelmError(
        'duplicate_tool_name',
        `插件工具名冲突（provider-safe 名必须唯一）：${[...new Set(dups.map((d) => d.name))].join(', ')}`,
        500,
        { duplicates: [...new Set(dups.map((d) => d.name))] },
      );
    }
    return out;
  }

  listRoutes(activePluginIds: Iterable<string>): PluginRouteEntry[] {
    const out: PluginRouteEntry[] = [];
    for (const pluginId of activePluginIds) {
      const pluginRoutes = this.routes.get(pluginId);
      if (!pluginRoutes) continue;
      for (const r of pluginRoutes) out.push({ ...r });
    }
    return out;
  }

  prepareAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext,
    options: Pick<CapabilityExecutionOptions, 'assertActive' | 'getConversation'>,
  ): { idempotent: boolean } {
    options.assertActive(pluginId);
    const actions = this.actions.get(pluginId);
    const entry = actions?.get(actionId);
    if (!entry) {
      throw new HelmError('unknown_action', `插件 ${pluginId} 未声明动作 ${actionId}`, 404, { pluginId, actionId });
    }
    assertScopeAllows(pluginId, `动作 ${pluginId}.${actionId}`, entry.scope, context.conversationId, options.getConversation);
    validatePluginInput(pluginId, actionId, entry.inputSchema, input);
    return { idempotent: entry.idempotent === true };
  }

  async invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext,
    options: Pick<CapabilityExecutionOptions, 'assertActive' | 'getConversation' | 'tracker'>,
  ): Promise<unknown> {
    this.prepareAction(pluginId, actionId, input, context, options);
    const entry = this.actions.get(pluginId)!.get(actionId)!;
    const raw = await options.tracker.withTask(pluginId, `action:${pluginId}.${actionId}`, () =>
      Promise.resolve(entry.handler(input as never, context)),
    );
    validatePluginOutput(pluginId, actionId, entry.outputSchema, raw);
    return jsonClone(raw);
  }

  async executeTool(
    name: string,
    input: unknown,
    context: PluginToolContext,
    options: CapabilityExecutionOptions,
  ): Promise<unknown> {
    const found = this.findToolByName(name, options);
    if (!found) throw new HelmError('unknown_tool', `未注册的工具：${name}`, 404, { name });

    const { pluginId, spec } = found;
    options.assertActive(pluginId);
    assertScopeAllows(pluginId, `工具 ${name}`, spec.scope, context.conversationId, options.getConversation);
    validatePluginInput(pluginId, spec.name, spec.inputSchema, input);
    return options.tracker.withTask(pluginId, `tool:${name}`, () =>
      Promise.resolve(spec.execute(input as never, context)),
    );
  }

  private findToolByName(
    name: string,
    options: CapabilityExecutionOptions,
  ): { pluginId: string; spec: PluginToolSpec } | undefined {
    // 1. ctx.tool 直投名（provider-safe，无 '.'）
    for (const [pluginId, pluginTools] of this.tools) {
      if (!options.isPluginRegistered(pluginId)) continue;
      const direct = pluginTools.get(name);
      if (direct) return { pluginId, spec: direct.spec };
    }
    // 2. 全限定动作名 pluginId.actionId（pluginId 可含 ':'，取首个 '.' 分割）
    const dot = name.indexOf('.');
    if (dot > 0) {
      const pluginId = name.slice(0, dot);
      const actionId = name.slice(dot + 1);
      if (options.isPluginRegistered(pluginId)) {
        const spec = this.derivedToolSpec(pluginId, actionId, name, options);
        if (spec) return spec;
      }
    }
    // 3. provider-safe 别名（不含 '.'，需扫描 exposeAsTool 动作）
    for (const pluginId of this.actions.keys()) {
      if (!options.isPluginRegistered(pluginId)) continue;
      const spec = this.derivedToolSpec(pluginId, name, name, options);
      if (spec) return spec;
    }
    return undefined;
  }

  private derivedToolSpec(
    pluginId: string,
    key: string,
    displayName: string,
    options: CapabilityExecutionOptions,
  ): { pluginId: string; spec: PluginToolSpec } | undefined {
    const actions = this.actions.get(pluginId);
    if (!actions) return undefined;
    for (const action of actions.values()) {
      const match = action.exposeAsTool && (action.id === key || action.toolAlias === key);
      if (!match) continue;
      const actionId = action.id;
      return {
        pluginId,
        spec: {
          name: displayName,
          description: action.description,
          inputSchema: action.inputSchema,
          ...(action.scope !== undefined ? { scope: action.scope } : {}),
          execute: (input: unknown, ctx: PluginToolContext) =>
            this.invokeAction(
              pluginId,
              actionId,
              input,
              {
                conversationId: ctx.conversationId,
                signal: ctx.signal,
              },
              options,
            ),
        },
      };
    }
    return undefined;
  }

  clear(pluginId: string): void {
    this.actions.get(pluginId)?.clear();
    this.tools.get(pluginId)?.clear();
    const r = this.routes.get(pluginId);
    if (r) r.length = 0;
  }

  removePlugin(pluginId: string): void {
    this.actions.delete(pluginId);
    this.tools.delete(pluginId);
    this.routes.delete(pluginId);
  }
}
