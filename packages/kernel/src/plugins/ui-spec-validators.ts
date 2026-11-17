/**
 * ui-spec-validators.ts: per-surface `registerUi` validation and two-phase dispatch table.
 *
 * Mechanical shape/type/pattern/unknown-key rules use precompiled TypeBox validators; cross-field
 * semantics (actionId vs client exclusivity, commandPalette slash reservations/duplicates,
 * profile.runtime kind duplicates, slot two-segment split, artifact array uniqueness, and
 * unsafe prototype keys) remain explicit. Two-phase dispatch (`validateUiSpecEarly` before
 * scope/client checks, `validateUiSpecLate` after) preserves original error precedence.
 */
import { Type, type TObject, type TProperties } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import {
  HelmError,
  RESERVED_SLASH_COMMANDS,
  parseNonEmptyLocalizedText,
  type PluginUiContribution,
  type UiActionSpec,
} from '@helm/protocol';
import { isPlainObject } from '@helm/protocol';

/** Host-reserved command slash triggers (`skill:` prefix is also reserved). */
const RESERVED_COMMAND_SLASH: ReadonlySet<string> = new Set(RESERVED_SLASH_COMMANDS);

/** UI action target -> registered surface mapping (shared by plugin-context and validation). */
export const UI_ACTION_SURFACES: Readonly<Record<UiActionSpec['target'], string>> = {
  'conversation:header': 'conversation.header.action',
  'conversation:row': 'conversation.row.action',
  'timeline:entry': 'timeline.entry.action',
};

const UI_ACTION_TARGET_BY_SURFACE: Readonly<Record<string, UiActionSpec['target']>> = Object.fromEntries(
  (Object.keys(UI_ACTION_SURFACES) as Array<UiActionSpec['target']>).map((key) => [UI_ACTION_SURFACES[key], key]),
);

const UNSAFE_TOP_LEVEL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface UiSpecContext {
  pluginId: string;
  fnName: string;
  surface: string;
  clientRoot?: string;
  hasBuildProvider: boolean;
  siblings: readonly PluginUiContribution[];
}

type UiSpecValidator = (spec: Record<string, unknown>, id: string, ctx: UiSpecContext) => void;

// ---------------------------------------------------------------------------
// Reusable TypeBox schemas & compiled validator helper
// ---------------------------------------------------------------------------

const NonEmptyString = Type.String({ minLength: 1 });
const ActionIdNoDotSchema = Type.String({ minLength: 1, pattern: '^[^.]+$' });
const CommandActionIdSchema = Type.String({ pattern: '^[A-Za-z0-9_-]+$' });
const CommandSlashSchema = Type.String({ pattern: '^[a-z0-9][a-z0-9:_-]{0,63}$' });
const RuntimeKindSchema = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' });
const MarkdownLanguageSchema = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,31}$' });
/** Canonical MIME: lowercase `type/subtype` or `type/<wildcard>` (rejects global wildcard, parameters, globs, uppercase). */
const CanonicalMimeSchema = Type.String({
  pattern: '^[a-z0-9][a-z0-9!#$&^_.+-]*\\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\\*)$',
});
/** Lowercase leading-dot multi-segment extension (e.g. `.md`, `.tar.gz`); rejects path segments/wildcards. */
const ArtifactExtensionSchema = Type.String({ pattern: '^\\.[a-z0-9]+(?:\\.[a-z0-9]+)*$' });
const COMPLETER_DOC_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const CompleterDocNameSchema = Type.String({ pattern: COMPLETER_DOC_NAME_PATTERN.source });
const CompleterItemsFieldSchema = Type.String({ pattern: '^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,127}$' });

interface DiagnosticError {
  message: string;
  details?: Record<string, unknown>;
}

type DiagnosticResolver = (
  errors: readonly TLocalizedValidationError[],
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
) => DiagnosticError;

function runCompiledUiSchema<T extends TProperties>(
  validator: Validator<TProperties, TObject<T>>,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
  resolveError: DiagnosticResolver,
): void {
  if (validator.Check(spec)) return;
  const { message, details } = resolveError(validator.Errors(spec), spec, id, ctx);
  throw new HelmError('invalid_ui_spec', message, 400, details);
}

/** Picks the first matching error path according to an explicit precedence list. */
function findErrorByPathPrefix(
  errors: readonly TLocalizedValidationError[],
  prefixes: readonly string[],
): TLocalizedValidationError | undefined {
  for (const prefix of prefixes) {
    const match = errors.find((e) => e.instancePath === prefix || e.instancePath.startsWith(`${prefix}/`));
    if (match) return match;
  }
  return errors[0];
}

function assertUniqueStrings(
  values: readonly string[],
  pluginId: string,
  message: string,
  details: Record<string, unknown>,
): void {
  if (new Set(values).size !== values.length) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ${message}`, 400, details);
  }
}

// ---------------------------------------------------------------------------
// Early phase validators
// ---------------------------------------------------------------------------

const UI_ACTION_BASE_PROPS = {
  actionId: Type.Optional(ActionIdNoDotSchema),
  actionPluginId: Type.Optional(NonEmptyString),
};

const UI_ACTION_CHECKERS: Readonly<Record<UiActionSpec['target'], Validator<TProperties, TObject>>> = {
  'conversation:header': Compile(
    Type.Object({
      ...UI_ACTION_BASE_PROPS,
      placement: Type.Optional(Type.Enum(['toolbar', 'menu'] as const)),
      kinds: Type.Optional(Type.Never()),
      roles: Type.Optional(Type.Never()),
    }),
  ),
  'conversation:row': Compile(
    Type.Object({
      ...UI_ACTION_BASE_PROPS,
      placement: Type.Optional(Type.Never()),
      kinds: Type.Optional(Type.Never()),
      roles: Type.Optional(Type.Never()),
    }),
  ),
  'timeline:entry': Compile(
    Type.Object({
      ...UI_ACTION_BASE_PROPS,
      placement: Type.Optional(Type.Never()),
      kinds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
      roles: Type.Optional(Type.Array(Type.Enum(['user', 'assistant'] as const), { minItems: 1 })),
    }),
  ),
};

function validateUiActionSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const target = UI_ACTION_TARGET_BY_SURFACE[ctx.surface];
  if (target === undefined) return;
  if (spec['actionId'] === undefined && spec['client'] === undefined) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.action(${target}) must at least provide actionId or client of one`,
      400,
      { pluginId, id },
    );
  }
  runCompiledUiSchema(UI_ACTION_CHECKERS[target], spec, id, ctx, (errors) => {
    const err = findErrorByPathPrefix(errors, ['/actionId', '/actionPluginId', '/placement', '/kinds', '/roles']);
    const p = err?.instancePath ?? '';
    if (p.startsWith('/actionId')) {
      return {
        message: `plugin ${pluginId} ui.action  actionId must be non-empty and excludes point number action id(across plugin please use actionPluginId)`,
        details: { pluginId, id },
      };
    }
    if (p.startsWith('/actionPluginId')) {
      return { message: `plugin ${pluginId} ui.action  actionPluginId must be non-empty plugin id`, details: { pluginId, id } };
    }
    if (p.startsWith('/placement')) {
      return {
        message:
          target !== 'conversation:header'
            ? `plugin ${pluginId} ui.action(${target}) disallows placement(only conversation:header support)`
            : `plugin ${pluginId} ui.action  placement only allows 'toolbar' | 'menu'`,
        details: { pluginId, id },
      };
    }
    if (p.startsWith('/kinds')) {
      return {
        message:
          target !== 'timeline:entry'
            ? `plugin ${pluginId} ui.action(${target}) disallows kinds(only timeline:entry support)`
            : `plugin ${pluginId} ui.action(timeline:entry) kinds must be non-empty string array`,
        details: { pluginId, id },
      };
    }
    if (p.startsWith('/roles')) {
      return {
        message:
          target !== 'timeline:entry'
            ? `plugin ${pluginId} ui.action(${target}) disallows roles(only timeline:entry support)`
            : `plugin ${pluginId} ui.action(timeline:entry) roles only allows 'user' | 'assistant' non-empty array`,
        details: { pluginId, id },
      };
    }
    return { message: `plugin ${pluginId} ui.action(${target}) invalid spec: ${err?.message ?? 'unknown'}`, details: { pluginId, id } };
  });
  // `target` duplicates the registered surface name; strip to avoid storage ambiguity.
  delete spec['target'];
}

const COMMAND_PALETTE_CHECKER = Compile(
  Type.Object({
    slash: Type.Optional(CommandSlashSchema),
    insert: Type.Optional(NonEmptyString),
    actionId: Type.Optional(CommandActionIdSchema),
    actionPluginId: Type.Optional(NonEmptyString),
  }),
);

function validateCommandPaletteSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  runCompiledUiSchema(COMMAND_PALETTE_CHECKER, spec, id, ctx, (errors) => {
    const err = findErrorByPathPrefix(errors, ['/slash', '/insert', '/actionId', '/actionPluginId']);
    if (err?.instancePath.startsWith('/slash')) {
      return {
        message: `plugin ${pluginId} ui.command  slash must match /^[a-z0-9][a-z0-9:_-]{0,63}$/(excludes before lead /)`,
        details: { pluginId, id, slash: String(spec['slash']) },
      };
    }
    if (err?.instancePath.startsWith('/insert')) {
      return {
        message: `plugin ${pluginId} ui.command  insert must be non-empty string`,
        details: { pluginId, id },
      };
    }
    if (err?.instancePath.startsWith('/actionId')) {
      return { message: `plugin ${pluginId} ui.command  actionId must be legal action identifier` };
    }
    return { message: `plugin ${pluginId} ui.command  actionPluginId must be non-empty plugin id`, details: { pluginId, id } };
  });
  const slash = spec['slash'] as string | undefined;
  if (slash !== undefined) {
    if (RESERVED_COMMAND_SLASH.has(slash) || slash.startsWith('skill:')) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.command  slash "${slash}" and host keep command conflict (new/clear/compact and skill: prefix)`,
        400,
        { pluginId, id, slash },
      );
    }
    for (const u of ctx.siblings) {
      if (u.surface === 'commandPalette' && (u.spec as { slash?: unknown }).slash === slash) {
        throw new HelmError('duplicate_command_slash', `plugin ${pluginId} duplicate declaration slash trigger term /${slash}`, 409, {
          pluginId,
          slash,
        });
      }
    }
  }
  const actionId = spec['actionId'];
  const insert = spec['insert'] as string | undefined;
  if (insert !== undefined && insert.trim() === '') {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.command  insert must be non-empty string`,
      400,
      { pluginId, id },
    );
  }
  if (actionId !== undefined && insert !== undefined) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.command cannot declare both actionId and insert (ambiguous execution vs text-insertion semantics)`,
      400,
      { pluginId, id },
    );
  }
  if (slash !== undefined && actionId === undefined && insert === undefined) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.command declaration slash when must bind set actionId or insert`,
      400,
    );
  }
  if (actionId === undefined && insert === undefined && spec['client'] === undefined) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.command must at least provide actionId, insert, or client of one (command must can trigger)`,
      400,
      { pluginId, id },
    );
  }
}

const PROFILE_RUNTIME_KIND_CHECKER = Compile(Type.Object({ kind: RuntimeKindSchema }));
const PROFILE_RUNTIME_SUGGESTIONS_CHECKER = Compile(
  Type.Object({ agentSuggestions: Type.Optional(Type.Array(NonEmptyString)) }),
);

function validateProfileRuntimeSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  runCompiledUiSchema(PROFILE_RUNTIME_KIND_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.profileRuntime  kind must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`,
    details: { pluginId, id, kind: String(spec['kind']) },
  }));
  if (parseNonEmptyLocalizedText(spec['label']) === undefined) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.profileRuntime need to non-empty display label`, 400, {
      pluginId,
      id,
    });
  }
  runCompiledUiSchema(PROFILE_RUNTIME_SUGGESTIONS_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.profileRuntime  agentSuggestions must be non-empty string array`,
    details: { pluginId, id },
  }));
  const kind = spec['kind'] as string;
  for (const u of ctx.siblings) {
    if (u.surface === 'profile.runtime' && (u.spec as { kind?: unknown }).kind === kind) {
      throw new HelmError(
        'duplicate_profile_runtime_kind',
        `plugin ${pluginId} duplicate declaration profile.runtime kind "${kind}"`,
        409,
        { pluginId, kind },
      );
    }
  }
}

const PLUGIN_SLOT_CHECKER = Compile(
  Type.Object({ target: Type.String({ minLength: 1, maxLength: 512 }) }),
);

function validateSlotSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  runCompiledUiSchema(PLUGIN_SLOT_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.slot  target must be non-empty string (<ownerPluginId>/<slotName>)`,
    details: { pluginId, id },
  }));
  const target = spec['target'] as string;
  const slash = target.indexOf('/');
  if (slash <= 0 || slash !== target.lastIndexOf('/')) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.slot  target "${target}" must exactly contains a '/'(<ownerPluginId>/<slotName>)`,
      400,
      { pluginId, id, target },
    );
  }
  const owner = target.slice(0, slash);
  const slotName = target.slice(slash + 1);
  if (!/^[A-Za-z0-9:_-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(slotName)) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.slot  target "${target}" segment identifier illegal (ownerPluginId allows : _ -,slotName allows . _ -)`,
      400,
      { pluginId, id, target },
    );
  }
}

// ---------------------------------------------------------------------------
// Late phase validators
// ---------------------------------------------------------------------------

const TIMELINE_RENDERER_CHECKER = Compile(
  Type.Object({
    matchMeta: Type.Optional(Type.Object({ renderer: NonEmptyString }, { additionalProperties: false })),
  }),
);

function validateTimelineRendererSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  if (spec['matchMeta'] !== undefined && !isPlainObject(spec['matchMeta'])) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.timelineRenderer  matchMeta only allows { renderer: non-empty string }`, 400);
  }
  runCompiledUiSchema(TIMELINE_RENDERER_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.timelineRenderer  matchMeta only allows { renderer: non-empty string }`,
  }));
}

const MARKDOWN_CODE_BLOCK_CHECKER = Compile(
  Type.Object({
    languages: Type.Array(MarkdownLanguageSchema, { minItems: 1 }),
  }),
);

function validateMarkdownCodeBlockSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  runCompiledUiSchema(MARKDOWN_CODE_BLOCK_CHECKER, spec, id, ctx, () => ({
    message: `plugin ${pluginId} ui.markdownCodeBlock  languages must be non-empty string array (each items is small write language identifier, match /^[a-z0-9][a-z0-9-]{0,31}$/)`,
    details: { pluginId, id },
  }));
  assertUniqueStrings(spec['languages'] as string[], pluginId, 'ui.markdownCodeBlock  languages contains duplicate items', {
    pluginId,
    id,
  });
  if (spec['client'] === undefined) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.markdownCodeBlock must declaration client component reference (without declaration style track path)`,
      400,
      { pluginId, id },
    );
  }
}

const TOOL_VIEW_CHECKER = Compile(
  Type.Object({
    replaceRow: Type.Optional(Type.Boolean()),
    toolNames: Type.Array(NonEmptyString, { minItems: 1 }),
  }),
);

function validateToolViewSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  runCompiledUiSchema(TOOL_VIEW_CHECKER, spec, id, ctx, (errors) => {
    const err = findErrorByPathPrefix(errors, ['/replaceRow', '/toolNames']);
    if (err?.instancePath.startsWith('/replaceRow')) {
      return {
        message: `plugin ${pluginId} ui.toolView  replaceRow must be boolean value (actual:${typeof spec['replaceRow']})`,
        details: { pluginId, id },
      };
    }
    return { message: `plugin ${pluginId} ui.toolView  toolNames must be non-empty string array`, details: { pluginId, id } };
  });
}

const ARTIFACT_PREVIEWER_CHECKER = Compile(
  Type.Object({
    mimeTypes: Type.Optional(Type.Array(CanonicalMimeSchema, { minItems: 1 })),
    extensions: Type.Optional(Type.Array(ArtifactExtensionSchema, { minItems: 1 })),
  }),
);

const ARTIFACT_MATCH_EXPECT: Readonly<Record<'mimeTypes' | 'extensions', string>> = {
  mimeTypes: 'only allows small write type/subtype precise value or type/* through match, disallows */*, parameter,glob and large write',
  extensions: 'only allows small write, before lead point, can many segment suffix (such as .md,.tar.gz), excludes path segment and wildcard',
};

function validateArtifactPreviewerSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId, fnName } = ctx;
  if (parseNonEmptyLocalizedText(spec['label']) === undefined) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.artifactPreviewer need to non-empty display label`, 400, {
      pluginId,
      id,
    });
  }
  runCompiledUiSchema(ARTIFACT_PREVIEWER_CHECKER, spec, id, ctx, (errors) => {
    const err = findErrorByPathPrefix(errors, ['/mimeTypes', '/extensions']);
    const field: 'mimeTypes' | 'extensions' = err?.instancePath.startsWith('/extensions') ? 'extensions' : 'mimeTypes';
    const seg = err?.instancePath.slice(`/${field}/`.length);
    if (seg !== undefined && seg !== '' && /^\d+$/.test(seg)) {
      const value = (spec[field] as unknown[])[Number(seg)];
      if (typeof value === 'string') {
        return {
          message: `plugin ${pluginId} ui.${fnName}  ${field} items "${value}" illegal (${ARTIFACT_MATCH_EXPECT[field]})`,
          details: { pluginId, id, field, value },
        };
      }
    }
    return {
      message: `plugin ${pluginId} ui.${fnName}  ${field} must be non-empty string array`,
      details: { pluginId, id, field },
    };
  });
  for (const field of ['mimeTypes', 'extensions'] as const) {
    const list = spec[field] as string[] | undefined;
    if (list !== undefined) {
      assertUniqueStrings(list, pluginId, `ui.${fnName}  ${field} contains duplicate items`, { pluginId, id, field });
    }
  }
}

const COMPLETER_TRIGGER_AND_SOURCE_CHECKER = Compile(
  Type.Object({
    trigger: Type.Enum(['@', '#', ':'] as const),
    source: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('action'),
          actionId: ActionIdNoDotSchema,
          actionPluginId: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Enum(['doc', 'sessionDoc'] as const),
          name: CompleterDocNameSchema,
          itemsField: CompleterItemsFieldSchema,
        },
        { additionalProperties: false },
      ),
    ]),
  }),
);

function validateComposerCompleterSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  if (parseNonEmptyLocalizedText(spec['label']) === undefined) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.composerCompleter need to non-empty display label`, 400, {
      pluginId,
      id,
    });
  }
  // '/' is reserved for host command and skill completion; completer renders uniformly without client track.
  if (spec['client'] !== undefined) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.composerCompleter disallows declaration client(completion by host unify render, only accept declaration style data source)`,
      400,
      { pluginId, id, field: 'client' },
    );
  }
  runCompiledUiSchema(COMPLETER_TRIGGER_AND_SOURCE_CHECKER, spec, id, ctx, (errors) => {
    const triggerErr = findErrorByPathPrefix(errors, ['/trigger']);
    if (triggerErr?.instancePath.startsWith('/trigger')) {
      return {
        message: `plugin ${pluginId} ui.composerCompleter  trigger only allows '@' | '#' | ':'('/' keep to command and skill)`,
        details: { pluginId, id, trigger: String(spec['trigger']) },
      };
    }
    const source = spec['source'];
    if (!isPlainObject(source)) {
      return {
        message: `plugin ${pluginId} ui.composerCompleter need to source({ kind: 'action' | 'doc' | 'sessionDoc', ... })`,
        details: { pluginId, id },
      };
    }
    const kind = source['kind'];
    if (kind === 'action') {
      if (Object.keys(source).some((k) => k !== 'kind' && k !== 'actionId' && k !== 'actionPluginId')) {
        return {
          message: `plugin ${pluginId} ui.composerCompleter  action source only allows { kind, actionId, actionPluginId? }, must not mix doc source field`,
          details: { pluginId, id },
        };
      }
      if (typeof source['actionId'] !== 'string' || source['actionId'].length === 0 || source['actionId'].includes('.')) {
        return {
          message: `plugin ${pluginId} ui.composerCompleter  actionId must be non-empty and excludes point number action id(across plugin please use actionPluginId)`,
          details: { pluginId, id },
        };
      }
      return {
        message: `plugin ${pluginId} ui.composerCompleter  actionPluginId must be non-empty plugin id`,
        details: { pluginId, id },
      };
    }
    if (kind === 'doc' || kind === 'sessionDoc') {
      if (Object.keys(source).some((k) => k !== 'kind' && k !== 'name' && k !== 'itemsField')) {
        return {
          message: `plugin ${pluginId} ui.composerCompleter  ${kind} source only allows { kind, name, itemsField }, must not mix action source field`,
          details: { pluginId, id },
        };
      }
      if (typeof source['name'] !== 'string' || !COMPLETER_DOC_NAME_PATTERN.test(source['name'])) {
        return {
          message: `plugin ${pluginId} ui.composerCompleter  ${kind} source name must be this plugin public document name (allows character A-Za-z0-9._-)`,
          details: { pluginId, id, name: String(source['name']) },
        };
      }
      return {
        message: `plugin ${pluginId} ui.composerCompleter  itemsField must be security top-level key (refuse __proto__/constructor/prototype and very rule character)`,
        details: { pluginId, id, itemsField: String(source['itemsField']) },
      };
    }
    return {
      message: `plugin ${pluginId} ui.composerCompleter  source.kind only allows 'action' | 'doc' | 'sessionDoc'`,
      details: { pluginId, id, kind: String(kind) },
    };
  });
  const source = spec['source'] as Record<string, unknown>;
  if (!isPlainObject(source)) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.composerCompleter need to source({ kind: 'action' | 'doc' | 'sessionDoc', ... })`,
      400,
      { pluginId, id },
    );
  }
  if (
    (source['kind'] === 'doc' || source['kind'] === 'sessionDoc') &&
    UNSAFE_TOP_LEVEL_KEYS.has(source['itemsField'] as string)
  ) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.composerCompleter  itemsField must be security top-level key (refuse __proto__/constructor/prototype and very rule character)`,
      400,
      { pluginId, id, itemsField: String(source['itemsField']) },
    );
  }
}

const WORKBENCH_PANEL_CHECKER = Compile(
  Type.Object({
    badge: Type.Optional(
      Type.Object(
        {
          doc: NonEmptyString,
          countField: Type.Optional(NonEmptyString),
          toneField: Type.Optional(NonEmptyString),
          byConversationField: Type.Optional(NonEmptyString),
        },
        { additionalProperties: false },
      ),
    ),
  }),
);

function validateWorkbenchPanelSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  if (spec['badge'] !== undefined && !isPlainObject(spec['badge'])) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.workbenchPanel  badge only allows { doc, countField?, toneField?, byConversationField? }`,
      400,
    );
  }
  runCompiledUiSchema(WORKBENCH_PANEL_CHECKER, spec, id, ctx, (errors) => {
    const err = findErrorByPathPrefix(errors, ['/badge/doc', '/badge/countField', '/badge/toneField', '/badge/byConversationField', '/badge']);
    const p = err?.instancePath ?? '';
    if (p === '/badge/doc') {
      return {
        message: `plugin ${pluginId} ui.workbenchPanel  badge.doc must be non-empty string (subscribe this plugin public doc name)`,
        details: { pluginId, id },
      };
    }
    for (const field of ['countField', 'toneField', 'byConversationField'] as const) {
      if (p === `/badge/${field}`) {
        return {
          message: `plugin ${pluginId} ui.workbenchPanel  badge.${field} must be non-empty string field name`,
          details: { pluginId, id, field },
        };
      }
    }
    return {
      message: `plugin ${pluginId} ui.workbenchPanel  badge only allows { doc, countField?, toneField?, byConversationField? }`,
    };
  });
}

// ---------------------------------------------------------------------------
// Two-phase dispatch tables
// ---------------------------------------------------------------------------

const EARLY_VALIDATORS: Readonly<Record<string, UiSpecValidator>> = {
  [UI_ACTION_SURFACES['conversation:header']]: validateUiActionSpec,
  [UI_ACTION_SURFACES['conversation:row']]: validateUiActionSpec,
  [UI_ACTION_SURFACES['timeline:entry']]: validateUiActionSpec,
  commandPalette: validateCommandPaletteSpec,
  'profile.runtime': validateProfileRuntimeSpec,
  'plugin.slot': validateSlotSpec,
};

const LATE_VALIDATORS: Readonly<Record<string, UiSpecValidator>> = {
  'timeline.renderer': validateTimelineRendererSpec,
  'markdown.codeBlock': validateMarkdownCodeBlockSpec,
  'tool.view': validateToolViewSpec,
  'artifact.previewer': validateArtifactPreviewerSpec,
  'composer.completer': validateComposerCompleterSpec,
  'workbench.panel': validateWorkbenchPanelSpec,
};

export function validateUiSpecEarly(
  surface: string,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
): void {
  EARLY_VALIDATORS[surface]?.(spec, id, ctx);
}

export function validateUiSpecLate(
  surface: string,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
): void {
  LATE_VALIDATORS[surface]?.(spec, id, ctx);
}
