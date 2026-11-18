/**
 * capability-registry.ts: manages registration, lookup, visibility, and execution of plugin tools,
 * actions, and dynamic routes.
 *
 * Responsibilities:
 * - Pre-compile schemas and strictly validate specs at registration (CLI commands/positionals,
 *   provider-safe aliases, relative route namespacing);
 * - Enforce `ConversationScope` visibility filtering and runtime re-validation;
 * - Derive unified tool specs (`DerivedToolSpec` from `ctx.tool` and `exposeAsTool` actions) with global uniqueness;
 * - Preflight (`prepareAction`) and execute (`invokeAction`, `executeTool`) tracked via `PluginTaskTracker`.
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
  isJsonObject,
  isPlainObject,
} from '@helm/protocol';
import { assertSchemaCompilable, validatePluginInput, validatePluginOutput } from './schema.js';
import type { PluginTaskTracker } from './tracking.js';
import {
  assertConversationScope,
  assertValidId,
  decodeSegmentStrict,
  jsonClone,
} from './shared.js'

export interface DerivedToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Structured output schema (forwarded for `ctx.tool`; omitted for `run_action` derived actions). */
  structuredOutputSchema?: JsonSchema;
  /** Cross-restart tool replay safety (forwarded when declared on ctx.tool; defaults to 'unsafe'). */
  replay?: 'safe' | 'unsafe';
  /** Full tool usage guidance paragraph (projected only for active tools). */
  promptSnippet?: string;
  /** Concise single-line guidelines (aggregated into shared `prompt.tools.guidelines`). */
  promptGuidelines?: string[];
  sourcePluginId: string;
  sourceKind: 'action' | 'tool';
  /** Fully-qualified `pluginId.actionId` when `sourceKind === 'action'`. */
  qualifiedId?: string;
}

export interface PluginRouteEntry extends PluginRouteSpec {
  pluginId: string;
}

/** Provider-safe tool name constraint (OpenAI function naming subset across providers). */
export const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Generates a deterministic provider-safe alias for an `exposeAsTool` action:
 * semantic prefix + short hash of the qualified ID (avoids illegal `:`/`.`, and hash prevents collisions).
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
 * Parses a qualified `pluginId.actionId` identifier. Since `pluginId` may contain `:`
 * (e.g. `builtin:profile`), split at the first `.` rather than the last.
 */
export function parseQualifiedActionId(qualified: string): { pluginId: string; actionId: string } {
  const dot = qualified.indexOf('.');
  if (dot <= 0 || dot >= qualified.length - 1) {
    throw new HelmError('invalid_action_id', `Invalid qualified action id: ${qualified} (expected pluginId.actionId)`, 400, {
      qualified,
    });
  }
  return { pluginId: qualified.slice(0, dot), actionId: qualified.slice(dot + 1) };
}

interface ActionEntry {
  pluginId: string;
  id: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  cli?: PluginActionSpec<unknown, unknown>['cli'];
  exposeAsTool: boolean;
  exposeToPrompt?: boolean;
  idempotent?: boolean;
  /** Usage guidance paragraph (projected when reachable via `run_action` or direct tool; defensively copied). */
  promptSnippet?: string;
  promptGuidelines?: string[];
  toolAlias: string;
  scope?: ConversationScope;
  handler: (input: never, context: PluginActionContext) => unknown;
}

interface ToolEntry {
  pluginId: string;
  spec: PluginToolSpec;
}

/**
 * Runtime scope enforcement: bypassed when no scope or no conversation context (human call);
 * otherwise verifies `matchesConversationScope`. Missing conversations fail via `getConversation`.
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
    throw new HelmError('conversation_scope_violation', `${what} is not allowed on conversation ${conversationId} (outside scope)`, 403, {
      pluginId,
      conversationId,
    });
  }
}

function pluginRoutePrefix(pluginId: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/routes`;
}

/**
 * Validates and defensively copies `promptSnippet` / `promptGuidelines` at registration so blank strings
 * cannot pollute prompts and post-registration caller mutations cannot bypass validation.
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
    throw new HelmError(code, `${what} promptSnippet must be a non-empty non-whitespace string`, 400);
  }
  const guidelines = fields.promptGuidelines;
  if (
    guidelines !== undefined &&
    (!Array.isArray(guidelines) ||
      guidelines.length === 0 ||
      Array.from(guidelines).some((item) => typeof item !== 'string' || item.trim().length === 0))
  ) {
    throw new HelmError(code, `${what} promptGuidelines must be a non-empty array of non-whitespace strings`, 400);
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
    ...(entry.exposeToPrompt !== undefined ? { exposeToPrompt: entry.exposeToPrompt } : {}),
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
        `Plugin ${pluginId} action id cannot contain '.' (qualified names split on first '.'): ${spec.id}`,
        400,
      );
    }
    if (typeof spec.description !== 'string' || spec.description.length === 0) {
      throw new HelmError('invalid_action_spec', `Plugin ${pluginId} action ${spec.id} is missing description`, 400);
    }
    if (!isJsonObject(spec.inputSchema) || !isJsonObject(spec.outputSchema)) {
      throw new HelmError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} must declare both inputSchema and outputSchema`,
        400,
      );
    }
    if (typeof spec.handler !== 'function') {
      throw new HelmError('invalid_action_spec', `Plugin ${pluginId} action ${spec.id} is missing handler`, 400);
    }
    if (
      spec.cli?.command !== undefined &&
      (!Array.isArray(spec.cli.command) ||
        spec.cli.command.length === 0 ||
        !spec.cli.command.every((seg) => typeof seg === 'string' && seg.length > 0))
    ) {
      throw new HelmError(
        'invalid_action_spec',
        `Plugin ${pluginId} action ${spec.id} cli.command must be a non-empty string array`,
        400,
      );
    }
    if (spec.cli?.positional !== undefined) {
      if (!Array.isArray(spec.cli.positional)) {
        throw new HelmError(
          'invalid_action_spec',
          `Plugin ${pluginId} action ${spec.id} cli.positional must be an array`,
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
          `Plugin ${pluginId} action ${spec.id} declared cli.positional, but inputSchema is not an object with properties`,
          400,
        );
      }
      const writeTargets = new Set<string>();
      let seenOptional = false;
      for (const pos of spec.cli.positional) {
        if (!isPlainObject(pos) || Object.keys(pos).some((k) => k !== 'field' && k !== 'required' && k !== 'readFileInto')) {
          throw new HelmError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} cli.positional entries may only contain { field, required?, readFileInto? }`,
            400,
          );
        }
        if (typeof pos.field !== 'string' || pos.field.length === 0) {
          throw new HelmError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} cli.positional[].field must be a non-empty string`,
            400,
          );
        }
        if (pos.required !== undefined && typeof pos.required !== 'boolean') {
          throw new HelmError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} cli.positional[${pos.field}].required must be a boolean`,
            400,
          );
        }
        if (pos.readFileInto !== undefined && (typeof pos.readFileInto !== 'string' || pos.readFileInto.length === 0)) {
          throw new HelmError(
            'invalid_action_spec',
            `Plugin ${pluginId} action ${spec.id} cli.positional[${pos.field}].readFileInto must be a non-empty field name`,
            400,
          );
        }
        for (const name of [pos.field, pos.readFileInto] as const) {
          if (name === undefined) continue;
          if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
            throw new HelmError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional field name "${name}" is forbidden (prototype key)`,
              400,
            );
          }
          if (writeTargets.has(name)) {
            throw new HelmError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional duplicates write target "${name}" (field and readFileInto must not overlap)`,
              400,
            );
          }
          writeTargets.add(name);
          if (!Object.hasOwn(properties, name)) {
            throw new HelmError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional field "${name}" is not in inputSchema.properties`,
              400,
            );
          }
        }
        if (pos.readFileInto !== undefined) {
          const target = properties[pos.readFileInto] as { type?: unknown } | undefined;
          if (target === null || typeof target !== 'object' || target.type !== 'string') {
            throw new HelmError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional "${pos.field}" readFileInto target "${pos.readFileInto}" must have type: string`,
              400,
            );
          }
        }
        if (pos.required === true) {
          if (seenOptional) {
            throw new HelmError(
              'invalid_action_spec',
              `Plugin ${pluginId} action ${spec.id} cli.positional required field "${pos.field}" appears after an optional positional (required fields must be contiguous)`,
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
        `Plugin ${pluginId} action ${spec.id} cli.timeoutMs must be a finite number >= 0 (0 disables timeout)`,
        400,
      );
    }
    assertConversationScope(pluginId, `Plugin ${pluginId} action ${spec.id}`, spec.scope);
    if (spec.exposeToPrompt !== undefined && typeof spec.exposeToPrompt !== 'boolean') {
      throw new HelmError('invalid_action_spec', `Plugin ${pluginId} action ${spec.id} exposeToPrompt must be a boolean`, 400);
    }
    if (spec.idempotent !== undefined && typeof spec.idempotent !== 'boolean') {
      throw new HelmError('validation_error', `Plugin ${pluginId} action ${spec.id} idempotent must be a boolean`, 400);
    }
    const prompt = validatedPromptFields(`Plugin ${pluginId} action ${spec.id}`, spec, 'invalid_action_spec');

    let pluginActions = this.actions.get(pluginId);
    if (!pluginActions) {
      pluginActions = new Map();
      this.actions.set(pluginId, pluginActions);
    }
    if (pluginActions.has(spec.id)) {
      throw new HelmError('duplicate_action', `Plugin ${pluginId} declared duplicate action ${spec.id}`, 409);
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
      ...(spec.exposeToPrompt !== undefined ? { exposeToPrompt: spec.exposeToPrompt } : {}),
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
        `Plugin ${pluginId} tool name ${spec.name} must match ${PROVIDER_SAFE_TOOL_NAME.source} (provider function naming constraint)`,
        400,
      );
    }
    if (typeof spec.description !== 'string' || spec.description.length === 0) {
      throw new HelmError('invalid_tool_spec', `Plugin ${pluginId} tool ${spec.name} is missing description`, 400);
    }
    if (!isJsonObject(spec.inputSchema)) {
      throw new HelmError('invalid_tool_spec', `Plugin ${pluginId} tool ${spec.name} is missing inputSchema`, 400);
    }
    if (spec.structuredOutputSchema !== undefined) {
      if (!isJsonObject(spec.structuredOutputSchema)) {
        throw new HelmError(
          'invalid_tool_spec',
          `Plugin ${pluginId} tool ${spec.name} structuredOutputSchema must be a JSON Schema object`,
          400,
        );
      }
      assertSchemaCompilable(spec.structuredOutputSchema);
    }
    if (spec.replay !== undefined && spec.replay !== 'safe' && spec.replay !== 'unsafe') {
      throw new HelmError(
        'invalid_tool_spec',
        `Plugin ${pluginId} tool ${spec.name} replay must be 'safe' | 'unsafe' (received ${String(spec.replay)})`,
        400,
      );
    }
    const prompt = validatedPromptFields(`Plugin ${pluginId} tool ${spec.name}`, spec, 'invalid_tool_spec');
    if (typeof spec.execute !== 'function') {
      throw new HelmError('invalid_tool_spec', `Plugin ${pluginId} tool ${spec.name} is missing execute`, 400);
    }
    assertConversationScope(pluginId, `Plugin ${pluginId} tool ${spec.name}`, spec.scope);

    let pluginTools = this.tools.get(pluginId);
    if (!pluginTools) {
      pluginTools = new Map();
      this.tools.set(pluginId, pluginTools);
    }
    if (pluginTools.has(spec.name)) {
      throw new HelmError('duplicate_tool', `Plugin ${pluginId} declared duplicate tool ${spec.name}`, 409);
    }
    assertSchemaCompilable(spec.inputSchema);

    // Save a snapshot copy so caller mutations after registration cannot bypass prompt validation.
    const storedToolSpec: PluginToolSpec<TIn> = { ...spec, ...prompt };
    pluginTools.set(spec.name, { pluginId, spec: storedToolSpec as PluginToolSpec });
  }

  registerRoute(pluginId: string, spec: PluginRouteSpec): void {
    if (typeof spec.path !== 'string' || !spec.path.startsWith('/')) {
      throw new HelmError(
        'invalid_route_path',
        `Plugin ${pluginId} route path must be a relative path starting with '/' (mounted under the plugin namespace): ${String(spec.path)}`,
        400,
      );
    }
    if (spec.path === '/api' || spec.path.startsWith('/api/')) {
      throw new HelmError(
        'invalid_route_path',
        `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot include the '/api' prefix (declare a relative path; the host handles namespacing)`,
        400,
      );
    }
    if (spec.path === '/') {
      throw new HelmError('invalid_route_path', `Plugin ${pluginId} route relative path must have at least one segment ('/' alone is disallowed)`, 400);
    }
    if (spec.path.includes('?') || spec.path.includes('#')) {
      throw new HelmError(
        'invalid_route_path',
        `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot contain a query string or fragment`,
        400,
      );
    }
    for (const seg of spec.path.slice(1).split('/')) {
      if (seg.length === 0) {
        throw new HelmError(
          'invalid_route_path',
          `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot contain empty path segments ('//' or trailing slash)`,
          400,
        );
      }
      const decoded = decodeSegmentStrict(seg);
      if (decoded === '.' || decoded === '..' || decoded.includes('/')) {
        throw new HelmError(
          'invalid_route_path',
          `Plugin ${pluginId} route ${spec.method} ${spec.path} cannot contain dot segments ('.' / '..') or encoded slashes`,
          400,
        );
      }
    }
    if (typeof spec.handler !== 'function') {
      throw new HelmError('invalid_route_handler', `Plugin ${pluginId} route ${spec.path} is missing handler`, 400);
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
   * Read-only action binding lookup (used to validate action existence and `idempotent` flags referenced by UI specs).
   * Returns `undefined` when undeclared without triggering any registration side effects.
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
            ...(tool.spec.replay !== undefined ? { replay: tool.spec.replay } : {}),
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
        `Plugin tool name conflict (provider-safe names must be unique): ${[...new Set(dups.map((d) => d.name))].join(', ')}`,
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
      throw new HelmError('unknown_action', `Plugin ${pluginId} action ${actionId} is not declared (not declaration)`, 404, { pluginId, actionId });
    }
    assertScopeAllows(pluginId, `Action ${pluginId}.${actionId}`, entry.scope, context.conversationId, options.getConversation);
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
    if (!found) throw new HelmError('unknown_tool', `Tool is not registered: ${name}`, 404, { name });

    const { pluginId, spec } = found;
    options.assertActive(pluginId);
    assertScopeAllows(pluginId, `Tool ${name}`, spec.scope, context.conversationId, options.getConversation);
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
