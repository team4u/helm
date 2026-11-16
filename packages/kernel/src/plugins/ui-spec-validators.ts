/**
 * ui-spec-validators.ts:registerUi each surface declaration pure validate and dispatch table.
 *
 * registry(ui-registry.ts) retreat is store + dispatch: through use pre- (pure object / id /
 * priority|order),scope and client reference validate in registerUi this body;surface
 * dedicated belong rule by split before one by one chunk order split is two phase - -
 * - early chunk (UI action / commandPalette / profile.runtime / plugin.slot) first at
 *   scope and client reference validate execute;
 * - late phase chunk (timeline.renderer / markdown.codeBlock / tool.view /
 *   artifact.previewer / composer.completer / workbench.panel) in client
 *   reference validate after execute.
 * two phase divide only is keep split before error priority one by one byte etc. price (the same spec also step in
 * surface rule and scope/client rule when, throws first after do not change), without semantics difference other.
 * all validate all is pure function (UI action delete spec.target is unique input archive one
 * side effect, and split before consistent), error code / message / details and split before one by one character keep.
 */
import {
  HelmError,
  RESERVED_SLASH_COMMANDS,
  parseNonEmptyLocalizedText,
  type PluginUiContribution,
  type UiActionSpec,
} from '@helm/protocol';
import { isPlainObject } from './shared.js';

/** host keep command slash trigger term (skill: prefix whole keep), plugin must not occupy. */
const RESERVED_COMMAND_SLASH: ReadonlySet<string> = new Set(RESERVED_SLASH_COMMANDS);

/** UI action three class target to register surface mapping (unify UiActionSpec.target semantics;plugin-host and registry shared use). */
export const UI_ACTION_SURFACES: Readonly<Record<UiActionSpec['target'], string>> = {
  'conversation:header': 'conversation.header.action',
  'conversation:row': 'conversation.row.action',
  'timeline:entry': 'timeline.entry.action',
};

/** reverse inspect table: register surface -> UI action target(dispatch key i.e. three action surface). */
const UI_ACTION_TARGET_BY_SURFACE: Readonly<Record<string, UiActionSpec['target']>> = Object.fromEntries(
  (Object.keys(UI_ACTION_SURFACES) as Array<UiActionSpec['target']>).map((key) => [UI_ACTION_SURFACES[key], key]),
);

/**
 * artifact.previewer specification MIME: small write type/subtype precise value or explicit type/* through match.
 * reject 'asterisk slash asterisk'(equals swallow all artifact and without trim decide intent meaning), parameter, before suffix/glob and large write form
 * - - match rule must precise can pre- phase, frontend trim decide and kernel validate shared use the same fact source.
 */
const CANONICAL_MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/;

/** artifact.previewer file suffix: small write, before lead point, can many segment (such as .tar.gz), without path segment and wildcard. */
const ARTIFACT_EXTENSION_PATTERN = /^\.[a-z0-9]+(?:\.[a-z0-9]+)*$/;

/** completion source doc form document name (and docs/sessionDocs list the same naming constraint). */
const COMPLETER_DOC_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * completion source itemsField: security top-level key character collection (refuse __proto__/constructor/prototype).
 * only character collection restrict also do not enough, prototype pollute key name single in completion source validate in separate reject.
 */
const COMPLETER_ITEMS_FIELD_PATTERN = /^[A-Za-z0-9_$][A-Za-z0-9_$-]{0,127}$/;

const UNSAFE_TOP_LEVEL_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** validate context:registry in dispatch point once construct, one by one validate only read. */
export interface UiSpecContext {
  pluginId: string;
  /** declaration entry name (such as timelineRenderer), error message locate use. */
  fnName: string;
  /** this time register surface(UI action validate based on its reverse inspect target). */
  surface: string;
  /** plugin define provide clientRoot(client reference ownership check use; default means not provide). */
  clientRoot?: string;
  /** host is otherwise inject build port (client reference availability check use). */
  hasBuildProvider: boolean;
  /** this plugin registered UI contribution (commandPalette slash / profile.runtime kind plugin inside dedupe). */
  siblings: readonly PluginUiContribution[];
}

export type UiSpecValidator = (spec: Record<string, unknown>, id: string, ctx: UiSpecContext) => void;

/**
 * artifact.previewer match declaration list public validate: non-empty string array, one by one items legal, without duplicate.
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
      `plugin ${pluginId} ui.${fnName}  ${field} must be non-empty string array`,
      400,
      { pluginId, id, field },
    );
  }
  for (const value of values as string[]) {
    if (!isValid(value)) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.${fnName}  ${field} items "${value}" illegal (${expect})`,
        400,
        { pluginId, id, field, value },
      );
    }
  }
  const unique = new Set(values as string[]);
  if (unique.size !== values.length) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.${fnName}  ${field} contains duplicate items`, 400, {
      pluginId,
      id,
      field,
    });
  }
}

/**
 * UI action unify validate (conversation:header / conversation:row / timeline:entry):
 * actionId / client two at least provide its one (otherwise host cannot render also cannot execute).
 * side effect:target field and surface duplicate (surface already carry semantics), register input side remove
 * avoid store ambiguity (and split before consistent).
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
      `plugin ${pluginId} ui.action(${target}) must at least provide actionId or client of one`,
      400,
      { pluginId, id },
    );
  }
  if (actionId !== undefined && (typeof actionId !== 'string' || actionId.length === 0 || actionId.includes('.'))) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.action  actionId must be non-empty and excludes point number action id(across plugin please use actionPluginId)`,
      400,
      { pluginId, id },
    );
  }
  const actionPluginId = spec['actionPluginId'];
  if (actionPluginId !== undefined && (typeof actionPluginId !== 'string' || actionPluginId.length === 0)) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.action  actionPluginId must be non-empty plugin id`,
      400,
      { pluginId, id },
    );
  }
  // placement only conversation:header allows;kinds/roles only timeline:entry allows.
  if (target !== 'conversation:header') {
    const placement = spec['placement'];
    if (placement !== undefined) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.action(${target}) disallows placement(only conversation:header support)`,
        400,
        { pluginId, id },
      );
    }
  } else {
    const placement = spec['placement'];
    if (placement !== undefined && placement !== 'toolbar' && placement !== 'menu') {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.action  placement only allows 'toolbar' | 'menu'`,
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
        `plugin ${pluginId} ui.action(timeline:entry) kinds must be non-empty string array`,
        400,
        { pluginId, id },
      );
    }
    const roles = spec['roles'];
    if (roles !== undefined) {
      if (!Array.isArray(roles) || roles.length === 0 || roles.some((r) => r !== 'user' && r !== 'assistant')) {
        throw new HelmError(
          'invalid_ui_spec',
          `plugin ${pluginId} ui.action(timeline:entry) roles only allows 'user' | 'assistant' non-empty array`,
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
        `plugin ${pluginId} ui.action(${target}) disallows kinds(only timeline:entry support)`,
        400,
        { pluginId, id },
      );
    }
    const roles = spec['roles'];
    if (roles !== undefined) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.action(${target}) disallows roles(only timeline:entry support)`,
        400,
        { pluginId, id },
      );
    }
  }
  delete spec['target'];
}

/** commandPalette:slash trigger term format, host keep term and plugin inside same name dedupe; command can trigger. */
function validateCommandPaletteSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const slash = spec['slash'];
  if (slash !== undefined) {
    if (typeof slash !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(slash)) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.command  slash must match /^[a-z0-9][a-z0-9:_-]{0,63}$/(excludes before lead /)`,
        400,
        { pluginId, id, slash: String(slash) },
      );
    }
    if (RESERVED_COMMAND_SLASH.has(slash) || slash.startsWith('skill:')) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.command  slash "${slash}" and host keep command conflict (new/clear/compact and skill: prefix)`,
        400,
        { pluginId, id, slash },
      );
    }
    // plugin inside same name slash directly reject (across plugin conflict in commit point final inspect).
    for (const u of ctx.siblings) {
      if (u.surface !== 'commandPalette') continue;
      const other = (u.spec as { slash?: unknown }).slash;
      if (other === slash) {
        throw new HelmError('duplicate_command_slash', `plugin ${pluginId} duplicate declaration slash trigger term /${slash}`, 409, {
          pluginId,
          slash,
        });
      }
    }
  }
  const actionId = spec['actionId'];
  if (actionId !== undefined && (typeof actionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(actionId))) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.command  actionId must be legal action identifier`, 400);
  }
  if (slash !== undefined && actionId === undefined) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.command declaration slash when must bind set actionId`, 400);
  }
  const hasClient = spec['client'] !== undefined;
  if (actionId === undefined && !hasClient) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.command must at least provide actionId or client of one (command must can trigger)`,
      400,
      { pluginId, id },
    );
  }
  const actionPluginId = spec['actionPluginId'];
  if (actionPluginId !== undefined && (typeof actionPluginId !== 'string' || actionPluginId.length === 0)) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.command  actionPluginId must be non-empty plugin id`,
      400,
      { pluginId, id },
    );
  }
}

/** profile.runtime:kind required and format legal; duplicate kind plugin inside directly reject (across plugin conflict in commit point final inspect). */
function validateProfileRuntimeSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const kind = spec['kind'];
  if (typeof kind !== 'string' || kind.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(kind)) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.profileRuntime  kind must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`,
      400,
      { pluginId, id, kind: String(kind) },
    );
  }
  const label = spec['label'];
  if (parseNonEmptyLocalizedText(label) === undefined) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.profileRuntime need to non-empty display label`, 400, {
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
      `plugin ${pluginId} ui.profileRuntime  agentSuggestions must be non-empty string array`,
      400,
      { pluginId, id },
    );
  }
  // plugin inside duplicate kind directly reject (across plugin conflict in commit point final inspect).
  for (const u of ctx.siblings) {
    if (u.surface !== 'profile.runtime') continue;
    const other = (u.spec as { kind?: unknown }).kind;
    if (other === kind) {
      throw new HelmError(
        'duplicate_profile_runtime_kind',
        `plugin ${pluginId} duplicate declaration profile.runtime kind "${kind}"`,
        409,
        { pluginId, kind },
      );
    }
  }
}

/** plugin.slot:target must exactly has a '/', two segment all is legal identifier. */
function validateSlotSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const target = spec['target'];
  if (typeof target !== 'string' || target.length === 0 || target.length > 512) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.slot  target must be non-empty string (<ownerPluginId>/<slotName>)`,
      400,
      { pluginId, id },
    );
  }
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

/** timeline.renderer:matchMeta only allows { renderer: non-empty string }. */
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
        `plugin ${pluginId} ui.timelineRenderer  matchMeta only allows { renderer: non-empty string }`,
        400,
      );
    }
  }
}

/** markdown.codeBlock:languages non-empty small write identifier array, without duplicate; must declaration client component reference. */
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
      `plugin ${pluginId} ui.markdownCodeBlock  languages must be non-empty string array (each items is small write language identifier, match /^[a-z0-9][a-z0-9-]{0,31}$/)`,
      400,
      { pluginId, id },
    );
  }
  const unique = new Set(languages as string[]);
  if (unique.size !== languages.length) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.markdownCodeBlock  languages contains duplicate items`, 400, {
      pluginId,
      id,
    });
  }
  if (spec['client'] === undefined) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.markdownCodeBlock must declaration client component reference (without declaration style track path)`,
      400,
      { pluginId, id },
    );
  }
}

/** tool.view:replaceRow boolean;toolNames non-empty string array. */
function validateToolViewSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const replaceRow = spec['replaceRow'];
  if (replaceRow !== undefined && typeof replaceRow !== 'boolean') {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.toolView  replaceRow must be boolean value (actual:${typeof replaceRow})`,
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
      `plugin ${pluginId} ui.toolView  toolNames must be non-empty string array`,
      400,
      { pluginId, id },
    );
  }
}

/** artifact.previewer: non-empty label and specification MIME/suffix match declaration list. */
function validateArtifactPreviewerSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId, fnName } = ctx;
  const label = spec['label'];
  if (parseNonEmptyLocalizedText(label) === undefined) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.artifactPreviewer need to non-empty display label`, 400, {
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
    'only allows small write type/subtype precise value or type/* through match, disallows */*, parameter,glob and large write',
  );
  assertArtifactMatchList(
    pluginId,
    fnName,
    id,
    'extensions',
    spec['extensions'],
    (value) => ARTIFACT_EXTENSION_PATTERN.test(value),
    'only allows small write, before lead point, can many segment suffix (such as .md,.tar.gz), excludes path segment and wildcard',
  );
}

/** composer.completer:label/trigger/completion source shape and mutual exclusion (forbid client view track). */
function validateComposerCompleterSpec(spec: Record<string, unknown>, id: string, ctx: UiSpecContext): void {
  const { pluginId } = ctx;
  const label = spec['label'];
  if (parseNonEmptyLocalizedText(label) === undefined) {
    throw new HelmError('invalid_ui_spec', `plugin ${pluginId} ui.composerCompleter need to non-empty display label`, 400, {
      pluginId,
      id,
    });
  }
  // '/' keep to host command and skill completion; host unify render, do not accept client view track.
  const forbidden = ['client'] as const;
  for (const field of forbidden) {
    if (spec[field] !== undefined) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.composerCompleter disallows declaration ${field}(completion by host unify render, only accept declaration style data source)`,
        400,
        { pluginId, id, field },
      );
    }
  }
  const trigger = spec['trigger'];
  if (trigger !== '@' && trigger !== '#' && trigger !== ':') {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.composerCompleter  trigger only allows '@' | '#' | ':'('/' keep to command and skill)`,
      400,
      { pluginId, id, trigger: String(trigger) },
    );
  }
  const source = spec['source'];
  if (!isPlainObject(source)) {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.composerCompleter need to source({ kind: 'action' | 'doc' | 'sessionDoc', ... })`,
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
        `plugin ${pluginId} ui.composerCompleter  action source only allows { kind, actionId, actionPluginId? }, must not mix doc source field`,
        400,
        { pluginId, id },
      );
    }
    const actionId = source['actionId'];
    if (typeof actionId !== 'string' || actionId.length === 0 || actionId.includes('.')) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.composerCompleter  actionId must be non-empty and excludes point number action id(across plugin please use actionPluginId)`,
        400,
        { pluginId, id },
      );
    }
    const actionPluginId = source['actionPluginId'];
    if (actionPluginId !== undefined && (typeof actionPluginId !== 'string' || actionPluginId.length === 0)) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.composerCompleter  actionPluginId must be non-empty plugin id`,
        400,
        { pluginId, id },
      );
    }
  } else if (kind === 'doc' || kind === 'sessionDoc') {
    const sourceKeys = Object.keys(source);
    if (sourceKeys.some((k) => k !== 'kind' && k !== 'name' && k !== 'itemsField')) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.composerCompleter  ${kind} source only allows { kind, name, itemsField }, must not mix action source field`,
        400,
        { pluginId, id },
      );
    }
    const name = source['name'];
    if (typeof name !== 'string' || !COMPLETER_DOC_NAME_PATTERN.test(name)) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.composerCompleter  ${kind} source name must be this plugin public document name (allows character A-Za-z0-9._-)`,
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
        `plugin ${pluginId} ui.composerCompleter  itemsField must be security top-level key (refuse __proto__/constructor/prototype and very rule character)`,
        400,
        { pluginId, id, itemsField: String(itemsField) },
      );
    }
  } else {
    throw new HelmError(
      'invalid_ui_spec',
      `plugin ${pluginId} ui.composerCompleter  source.kind only allows 'action' | 'doc' | 'sessionDoc'`,
      400,
      { pluginId, id, kind: String(kind) },
    );
  }
}

/** workbench.panel:badge only allows declaration style field shape (doc subscribe + counter/color tune field name). */
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
        `plugin ${pluginId} ui.workbenchPanel  badge only allows { doc, countField?, toneField?, byConversationField? }`,
        400,
      );
    }
    if (typeof badge.doc !== 'string' || badge.doc.length === 0) {
      throw new HelmError(
        'invalid_ui_spec',
        `plugin ${pluginId} ui.workbenchPanel  badge.doc must be non-empty string (subscribe this plugin public doc name)`,
        400,
        { pluginId, id },
      );
    }
    for (const field of ['countField', 'toneField', 'byConversationField'] as const) {
      const value = badge[field];
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
        throw new HelmError(
          'invalid_ui_spec',
          `plugin ${pluginId} ui.workbenchPanel  badge.${field} must be non-empty string field name`,
          400,
          { pluginId, id, field },
        );
      }
    }
  }
}

/**
 * early surface validate (scope and client reference through use validate before dispatch):
 * UI action three surface,commandPalette,profile.runtime,plugin.slot.
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
 * late phase surface validate (client reference through use validate after dispatch):timeline.renderer,
 * markdown.codeBlock,tool.view,artifact.previewer,composer.completer,
 * workbench.panel.
 */
const LATE_VALIDATORS: Readonly<Record<string, UiSpecValidator>> = {
  'timeline.renderer': validateTimelineRendererSpec,
  'markdown.codeBlock': validateMarkdownCodeBlockSpec,
  'tool.view': validateToolViewSpec,
  'artifact.previewer': validateArtifactPreviewerSpec,
  'composer.completer': validateComposerCompleterSpec,
  'workbench.panel': validateWorkbenchPanelSpec,
};

/** early phase dispatch: without for should validate surface(sidebar/screen etc.) directly via. */
export function validateUiSpecEarly(
  surface: string,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
): void {
  EARLY_VALIDATORS[surface]?.(spec, id, ctx);
}

/** late phase phase dispatch: without for should validate surface directly via. */
export function validateUiSpecLate(
  surface: string,
  spec: Record<string, unknown>,
  id: string,
  ctx: UiSpecContext,
): void {
  LATE_VALIDATORS[surface]?.(spec, id, ctx);
}
