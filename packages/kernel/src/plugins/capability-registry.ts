/**
 * capability-registry.ts: negative duty tool (Tool), action (Action), self define routing (Route) register, find, visible and execute.
 *
 * responsibility:
 * - register boundary Schema pre- compile and parameter strong validate (CLI command and location parameter,provider-safe alias generate, each other for routing naming empty between piece together install);
 * - ConversationScope conversation level visible filter and execute phase second validate (double keep risk guard against bypass);
 * - tool manifest derive (DerivedToolSpec, merge ctx.tool and exposeAsTool action, validate tool name global unique);
 * - action and tool preflight (prepareAction), execute scheduling (invokeAction,executeTool) and PluginTaskTracker collection into.
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
  /** structure output Schema(ctx.tool declaration when pass-through;run_action derive tool without this field). */
  structuredOutputSchema?: JsonSchema;
  /** tool use refer quote complete segment (only activate tool throw shoot; inactive produces no phantom text). */
  promptSnippet?: string;
  /** single row want point (aggregate enter prompt.tools.guidelines sharing section). */
  promptGuidelines?: string[];
  sourcePluginId: string;
  sourceKind: 'action' | 'tool';
  /** only sourceKind === 'action':pluginId.actionId all limit set ID. */
  qualifiedId?: string;
}

export interface PluginRouteEntry extends PluginRouteSpec {
  pluginId: string;
}

/** model tool name provider security constraint (OpenAI function name sub- collection, all provider through use). */
export const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * is exposeAsTool action generate stable provider-safe alias: semantics prefix + all limit set ID short hash.
 * pure function, across restarts determine:pi-ai convertTools original send tool.name, contains ':'/'.' 
 * all limit set ID do not by any provider accept, and plain cleanse (replace illegal character) will collision, reason attach hash.
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
 * parse all limit set actionId(pluginId.actionId).pluginId allows contains ':'(builtin:profile),
 * therefore cannot simple split finally a '.' - - with a '.' split.
 */
export function parseQualifiedActionId(qualified: string): { pluginId: string; actionId: string } {
  const dot = qualified.indexOf('.');
  if (dot <= 0 || dot >= qualified.length - 1) {
    throw new HelmError('invalid_action_id', `illegal action all limit set id:${qualified}(expectation pluginId.actionId)`, 400, {
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
  /** action use refer quote (via run_action or directly tool can reach when throw shoot; already validate guard against defend copy). */
  promptSnippet?: string;
  promptGuidelines?: string[];
  toolAlias: string;
  scope?: ConversationScope;
  handler: (input: never, context: PluginActionContext) => unknown;
}

export interface ToolEntry {
  pluginId: string;
  spec: PluginToolSpec;
}

/**
 * scope execute phase validate:scope not declaration or invoke without conversation context (human invoke)
 * directly let through; otherwise via getConversation parse conversation after by matchesConversationScope
 * decide. conversation missing by getConversation such as throws.
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
    throw new HelmError('conversation_scope_violation', `${what} disallows in conversation ${conversationId} on execute (scope missed)`, 403, {
      pluginId,
      conversationId,
    });
  }
}

function pluginRoutePrefix(pluginId: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/routes`;
}

/**
 * tool use refer quote field register boundary strong validate (ctx.tool and ctx.action same standard, guard against hint directory
 * by empty text pollute):promptSnippet non-empty non- pure whitespace string;promptGuidelines non-empty
 * array and one by one items non-empty non- pure whitespace. via after return guard against defend copy (array duplicate), declaration register after
 * original ground modify do not back pour already validate data.
 */
function validatedPromptFields(
  what: string,
  fields: { promptSnippet?: unknown; promptGuidelines?: unknown },
  code: 'invalid_tool_spec' | 'invalid_action_spec',
): { promptSnippet?: string; promptGuidelines?: string[] } {
  if (
    fields.promptSnippet !== undefined &&
    (typeof fields.promptSnippet !== 'string' || fields.promptSnippet.trim().length === 0)
  ) {
    throw new HelmError(code, `${what}  promptSnippet must be non-empty non- pure whitespace string`, 400);
  }
  const guidelines = fields.promptGuidelines;
  if (
    guidelines !== undefined &&
    (!Array.isArray(guidelines) ||
      guidelines.length === 0 ||
      Array.from(guidelines).some((item) => typeof item !== 'string' || item.trim().length === 0))
  ) {
    throw new HelmError(code, `${what}  promptGuidelines must be non-empty string array (each items non-empty non- pure whitespace)`, 400);
  }
  return {
    ...(typeof fields.promptSnippet === 'string' ? { promptSnippet: fields.promptSnippet } : {}),
    ...(Array.isArray(guidelines) ? { promptGuidelines: [...(guidelines as string[])] } : {}),
  };
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
    ...(entry.promptSnippet !== undefined ? { promptSnippet: entry.promptSnippet } : {}),
    ...(entry.promptGuidelines !== undefined
      ? { promptGuidelines: [...entry.promptGuidelines] }
      : {}),
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
    assertValidId('action', spec.id);
    if (spec.id.includes('.')) {
      throw new HelmError(
        'invalid_action_spec',
        `plugin ${pluginId} action id disallows point number (all limit set parse with first '.' split):${spec.id}`,
        400,
      );
    }
    if (typeof spec.description !== 'string' || spec.description.length === 0) {
      throw new HelmError('invalid_action_spec', `plugin ${pluginId} action ${spec.id} missing description`, 400);
    }
    if (!isJsonObject(spec.inputSchema) || !isJsonObject(spec.outputSchema)) {
      throw new HelmError(
        'invalid_action_spec',
        `plugin ${pluginId} action ${spec.id} must also declaration inputSchema and outputSchema(single point Schema contract)`,
        400,
      );
    }
    if (typeof spec.handler !== 'function') {
      throw new HelmError('invalid_action_spec', `plugin ${pluginId} action ${spec.id} missing handler`, 400);
    }
    if (
      spec.cli?.command !== undefined &&
      (!Array.isArray(spec.cli.command) ||
        spec.cli.command.length === 0 ||
        !spec.cli.command.every((seg) => typeof seg === 'string' && seg.length > 0))
    ) {
      throw new HelmError(
        'invalid_action_spec',
        `plugin ${pluginId} action ${spec.id}  cli.command must be non-empty string array (semantics top-level command path)`,
        400,
      );
    }
    if (spec.cli?.positional !== undefined) {
      if (!Array.isArray(spec.cli.positional)) {
        throw new HelmError(
          'invalid_action_spec',
          `plugin ${pluginId} action ${spec.id}  cli.positional must be array`,
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
          `plugin ${pluginId} action ${spec.id} declaration cli.positional but inputSchema is not carries properties  object`,
          400,
        );
      }
      const writeTargets = new Set<string>();
      let seenOptional = false;
      for (const pos of spec.cli.positional) {
        if (!isPlainObject(pos) || Object.keys(pos).some((k) => k !== 'field' && k !== 'required' && k !== 'readFileInto')) {
          throw new HelmError(
            'invalid_action_spec',
            `plugin ${pluginId} action ${spec.id}  cli.positional items only allows { field, required?, readFileInto? }`,
            400,
          );
        }
        if (typeof pos.field !== 'string' || pos.field.length === 0) {
          throw new HelmError(
            'invalid_action_spec',
            `plugin ${pluginId} action ${spec.id}  cli.positional[].field must be non-empty string`,
            400,
          );
        }
        if (pos.required !== undefined && typeof pos.required !== 'boolean') {
          throw new HelmError(
            'invalid_action_spec',
            `plugin ${pluginId} action ${spec.id}  cli.positional[${pos.field}].required must be boolean`,
            400,
          );
        }
        if (pos.readFileInto !== undefined && (typeof pos.readFileInto !== 'string' || pos.readFileInto.length === 0)) {
          throw new HelmError(
            'invalid_action_spec',
            `plugin ${pluginId} action ${spec.id}  cli.positional[${pos.field}].readFileInto must be non-empty string field name`,
            400,
          );
        }
        for (const name of [pos.field, pos.readFileInto] as const) {
          if (name === undefined) continue;
          if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
            throw new HelmError(
              'invalid_action_spec',
              `plugin ${pluginId} action ${spec.id}  cli.positional field name "${name}" unavailable (prototype pollute key)`,
              400,
            );
          }
          if (writeTargets.has(name)) {
            throw new HelmError(
              'invalid_action_spec',
              `plugin ${pluginId} action ${spec.id}  cli.positional duplicate write field "${name}"(field/readFileInto target must not overlap)`,
              400,
            );
          }
          writeTargets.add(name);
          if (!Object.hasOwn(properties, name)) {
            throw new HelmError(
              'invalid_action_spec',
              `plugin ${pluginId} action ${spec.id}  cli.positional field "${name}" do not in inputSchema.properties in`,
              400,
            );
          }
        }
        if (pos.readFileInto !== undefined) {
          const target = properties[pos.readFileInto] as { type?: unknown } | undefined;
          if (target === null || typeof target !== 'object' || target.type !== 'string') {
            throw new HelmError(
              'invalid_action_spec',
              `plugin ${pluginId} action ${spec.id}  cli.positional "${pos.field}"  readFileInto target "${pos.readFileInto}" must be type: string property`,
              400,
            );
          }
        }
        if (pos.required === true) {
          if (seenOptional) {
            throw new HelmError(
              'invalid_action_spec',
              `plugin ${pluginId} action ${spec.id}  cli.positional required field "${pos.field}" appear in optional after (required must connect continue)`,
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
        `plugin ${pluginId} action ${spec.id}  cli.timeoutMs must be >= 0 finite number (0 means without timeout)`,
        400,
      );
    }
    assertConversationScope(pluginId, `plugin ${pluginId} action ${spec.id}`, spec.scope);
    if (spec.idempotent !== undefined && typeof spec.idempotent !== 'boolean') {
      throw new HelmError('validation_error', `plugin ${pluginId} action ${spec.id}  idempotent must is boolean`, 400);
    }
    const prompt = validatedPromptFields(`plugin ${pluginId} action ${spec.id}`, spec, 'invalid_action_spec');

    let pluginActions = this.actions.get(pluginId);
    if (!pluginActions) {
      pluginActions = new Map();
      this.actions.set(pluginId, pluginActions);
    }
    if (pluginActions.has(spec.id)) {
      throw new HelmError('duplicate_action', `plugin ${pluginId} duplicate declaration action ${spec.id}`, 409);
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
      ...(prompt.promptSnippet !== undefined ? { promptSnippet: prompt.promptSnippet } : {}),
      ...(prompt.promptGuidelines !== undefined ? { promptGuidelines: prompt.promptGuidelines } : {}),
      toolAlias: actionToolAlias(pluginId, spec.id),
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
      handler: spec.handler as (input: never, context: PluginActionContext) => unknown,
    });
  }

  registerTool<TIn>(pluginId: string, spec: PluginToolSpec<TIn>): void {
    assertValidId('tool', spec.name);
    if (!PROVIDER_SAFE_TOOL_NAME.test(spec.name)) {
      throw new HelmError(
        'invalid_tool_spec',
        `plugin ${pluginId} tool name ${spec.name} must match ${PROVIDER_SAFE_TOOL_NAME.source}(provider function name constraint)`,
        400,
      );
    }
    if (typeof spec.description !== 'string' || spec.description.length === 0) {
      throw new HelmError('invalid_tool_spec', `plugin ${pluginId} tool ${spec.name} missing description`, 400);
    }
    if (!isJsonObject(spec.inputSchema)) {
      throw new HelmError('invalid_tool_spec', `plugin ${pluginId} tool ${spec.name} missing inputSchema`, 400);
    }
    if (spec.structuredOutputSchema !== undefined) {
      if (!isJsonObject(spec.structuredOutputSchema)) {
        throw new HelmError(
          'invalid_tool_spec',
          `plugin ${pluginId} tool ${spec.name}  structuredOutputSchema must be JSON Schema object`,
          400,
        );
      }
      assertSchemaCompilable(spec.structuredOutputSchema);
    }
    const prompt = validatedPromptFields(`plugin ${pluginId} tool ${spec.name}`, spec, 'invalid_tool_spec');
    if (typeof spec.execute !== 'function') {
      throw new HelmError('invalid_tool_spec', `plugin ${pluginId} tool ${spec.name} missing execute`, 400);
    }
    assertConversationScope(pluginId, `plugin ${pluginId} tool ${spec.name}`, spec.scope);

    let pluginTools = this.tools.get(pluginId);
    if (!pluginTools) {
      pluginTools = new Map();
      this.tools.set(pluginId, pluginTools);
    }
    if (pluginTools.has(spec.name)) {
      throw new HelmError('duplicate_tool', `plugin ${pluginId} duplicate declaration tool ${spec.name}`, 409);
    }
    assertSchemaCompilable(spec.inputSchema);

    // save declaration snapshot, avoid register after heavy bind refer quote field or modify array bypass validate.
    const storedToolSpec: PluginToolSpec<TIn> = { ...spec, ...prompt };
    pluginTools.set(spec.name, { pluginId, spec: storedToolSpec as PluginToolSpec });
  }

  registerRoute(pluginId: string, spec: PluginRouteSpec): void {
    if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) {
      throw new HelmError(
        'invalid_route_path',
        `plugin ${pluginId} routing path must be with / open head relative path (host automatically mount to plugin naming empty between):${String(spec.path)}`,
        400,
      );
    }
    if (spec.path === '/api' || spec.path.startsWith('/api/')) {
      throw new HelmError(
        'invalid_route_path',
        `plugin ${pluginId} routing ${spec.method} ${spec.path} disallows carry /api prefix (please declaration relative path, host negative duty naming empty between concatenate)`,
        400,
      );
    }
    if (spec.path === '/') {
      throw new HelmError('invalid_route_path', `plugin ${pluginId} routing relative path at least need to one segment (disallows only /)`, 400);
    }
    if (spec.path.includes('?') || spec.path.includes('#')) {
      throw new HelmError(
        'invalid_route_path',
        `plugin ${pluginId} routing ${spec.method} ${spec.path} disallows carry query string or fragment`,
        400,
      );
    }
    for (const seg of spec.path.slice(1).split('/')) {
      if (seg.length === 0) {
        throw new HelmError(
          'invalid_route_path',
          `plugin ${pluginId} routing ${spec.method} ${spec.path} disallows empty path segment (// or tail slash)`,
          400,
        );
      }
      const decoded = decodeSegmentStrict(seg);
      if (decoded === '.' || decoded === '..' || decoded.includes('/')) {
        throw new HelmError(
          'invalid_route_path',
          `plugin ${pluginId} routing ${spec.method} ${spec.path} disallows point segment (. / ..) or encode slash`,
          400,
        );
      }
    }
    if (typeof spec.handler !== 'function') {
      throw new HelmError('invalid_route_handler', `plugin ${pluginId} routing ${spec.path} missing handler`, 400);
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

  /**
   * only read action bind set query (UI declaration reference action store in and idempotent mark record validate use).
   * not declaration return undefined; does not trigger any register side effect.
   */
  getActionBinding(pluginId: string, actionId: string): { idempotent: boolean } | undefined {
    const entry = this.actions.get(pluginId)?.get(actionId);
    return entry ? { idempotent: entry.idempotent === true } : undefined;
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
            ...(tool.spec.promptSnippet !== undefined ? { promptSnippet: tool.spec.promptSnippet } : {}),
            ...(tool.spec.promptGuidelines !== undefined
              ? { promptGuidelines: [...tool.spec.promptGuidelines] }
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
            ...(action.promptSnippet !== undefined ? { promptSnippet: action.promptSnippet } : {}),
            ...(action.promptGuidelines !== undefined
              ? { promptGuidelines: [...action.promptGuidelines] }
              : {}),
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
        `plugin tool name conflict (provider-safe name must unique):${[...new Set(dups.map((d) => d.name))].join(', ')}`,
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
      throw new HelmError('unknown_action', `plugin ${pluginId} not declaration action ${actionId}`, 404, { pluginId, actionId });
    }
    assertScopeAllows(pluginId, `action ${pluginId}.${actionId}`, entry.scope, context.conversationId, options.getConversation);
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
    if (!found) throw new HelmError('unknown_tool', `not registered tool:${name}`, 404, { name });

    const { pluginId, spec } = found;
    options.assertActive(pluginId);
    assertScopeAllows(pluginId, `tool ${name}`, spec.scope, context.conversationId, options.getConversation);
    validatePluginInput(pluginId, spec.name, spec.inputSchema, input);
    return options.tracker.withTask(pluginId, `tool:${name}`, () =>
      Promise.resolve(spec.execute(input as never, context)),
    );
  }

  private findToolByName(
    name: string,
    options: CapabilityExecutionOptions,
  ): { pluginId: string; spec: PluginToolSpec } | undefined {
    // 1. ctx.tool direct throw name (provider-safe, without '.')
    for (const [pluginId, pluginTools] of this.tools) {
      if (!options.isPluginRegistered(pluginId)) continue;
      const direct = pluginTools.get(name);
      if (direct) return { pluginId, spec: direct.spec };
    }
    // 2. all limit set action name pluginId.actionId(pluginId can contains ':', take first '.' split)
    const dot = name.indexOf('.');
    if (dot > 0) {
      const pluginId = name.slice(0, dot);
      const actionId = name.slice(dot + 1);
      if (options.isPluginRegistered(pluginId)) {
        const spec = this.derivedToolSpec(pluginId, actionId, name, options);
        if (spec) return spec;
      }
    }
    // 3. provider-safe alias (excludes '.', must scan exposeAsTool action)
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
