/**
 * Builds the `HelmPluginContext` passed to `definePlugin` (hook, action, tool, route, doc, sessionDoc, service, provider, ui, and host).
 */
import {
  HelmError,
  parseNonEmptyLocalizedText,
  type ActionManifest,
  type ArtifactPreviewerSpec,
  type CommandSpec,
  type ComposerCompleterSpec,
  type ComposerPillSpec,
  type ComposerWidgetSpec,
  type HelmPluginContext,
  type HookHandler,
  type HookName,
  type HookOptions,
  type MarkdownCodeBlockSpec,
  type PluginActionContext,
  type PluginConfigFieldSchema,
  type PluginServiceSpec,
  type PluginSlotContributionSpec,
  type ProfileRuntimeUiSpec,
  type ScreenSpec,
  type SettingsPanelSpec,
  type SidebarItemSpec,
  type SidebarSectionSpec,
  type TimelineRendererSpec,
  type ToolViewSpec,
  type UiActionSpec,
  type WorkbenchPanelSpec,
} from '@helm/protocol';
import type { Provider } from '@earendil-works/pi-ai';
import type { HookPipeline } from './hooks.js';
import type { CapabilityRegistry } from './capability-registry.js';
import { UiRegistry, UI_ACTION_SURFACES } from './ui-registry.js';
import type { PluginDocRegistry } from './doc-registry.js';
import { assertValidId } from './shared.js';
import { assertValidProviderShape } from './provider-coordinator.js';
import { wrapHostApi, type HostApiDependencies } from './host-api.js';
import type {
  PluginConfigStore,
  PluginState,
} from './types.js';

interface CreatePluginContextOptions {
  state: PluginState;
  epoch: number;
  pipelines: Map<HookName, HookPipeline<HookName>>;
  capabilityRegistry: CapabilityRegistry;
  uiRegistry: UiRegistry;
  docRegistry: PluginDocRegistry;
  configStore?: PluginConfigStore;
  hostDeps: HostApiDependencies;
  assertNotDisposed: () => void;
  assertContextUsable: (state: PluginState, epoch: number, what: string) => void;
  isRegisteredState: (state: PluginState) => boolean;
}

/**
 * Display-copy guard for ctx.configSchema declarations: label / description,
 * when present, must be valid non-blank LocalizedText (supported locale keys
 * only). Pure shape check on the display fields — value semantics stay with
 * PluginConfigStore at write time.
 */
function assertConfigSchemaDisplayCopy(
  pluginId: string,
  schema: Record<string, PluginConfigFieldSchema>,
): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new HelmError('invalid_config_schema', `plugin ${pluginId} configSchema must be object`, 400, { pluginId });
  }
  for (const [key, field] of Object.entries(schema)) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new HelmError('invalid_config_schema', `plugin ${pluginId} config field ${key} must be object`, 400, {
        pluginId,
        field: key,
      });
    }
    for (const copyField of ['label', 'description'] as const) {
      const value = field[copyField];
      if (value !== undefined && parseNonEmptyLocalizedText(value) === undefined) {
        throw new HelmError(
          'invalid_config_schema',
          `Plugin ${pluginId} config field ${key} ${copyField} must be display copy (non-empty string or { en, 'zh-CN' } map with non-blank values)`,
          400,
          { pluginId, field: key, copyField },
        );
      }
    }
  }
}

export function createPluginContext(options: CreatePluginContextOptions): HelmPluginContext {
  const {
    state,
    epoch,
    pipelines,
    capabilityRegistry,
    uiRegistry,
    docRegistry,
    configStore,
    hostDeps,
    assertNotDisposed,
    assertContextUsable,
    isRegisteredState,
  } = options;
  const pluginId = state.definition.id;

  /** Registration methods are only valid during `definePlugin` execution for this enablement cycle. */
  const assertOpen = (what: string) => {
    assertNotDisposed();
    if (epoch !== state.epoch || state.phase !== 'defining') {
      throw new HelmError(
        'plugin_context_closed',
        `Plugin ${pluginId} definePlugin context has closed (disabled or entered a new enablement cycle); cannot ${what}`,
        409,
      );
    }
  };

  /**
   * Doc handles remain writable throughout the active cycle and invalidate on disable or cycle advance.
   * Exception: during a controlled service shutdown window (`PluginState.stopWindow`), handles of matching
   * epoch may still flush final state.
   */
  const assertDocUsable = (name: string) => {
    if (state.stopWindow && isRegisteredState(state) && state.epoch === epoch) {
      return;
    }
    assertContextUsable(state, epoch, `doc ${name} handle`);
  };

  const addHook = <N extends HookName>(name: N, fn: HookHandler<N>, opts?: HookOptions) => {
    assertOpen(`add ${name} hook`);
    (pipelines.get(name) as unknown as HookPipeline<N>).add(pluginId, fn, opts?.priority ?? 0);
    state.hooks.add(name);
  };

  const host = wrapHostApi(state, epoch, hostDeps);

  const ctx: HelmPluginContext = {
    pluginId,
    dataDir: state.dataDir,
    getConfig: () => (configStore ? configStore.get(pluginId) : {}) as never,
    configSchema: (schema) => {
      assertOpen('declare configSchema');
      if (state.configSchema) {
        throw new HelmError('duplicate_config_schema', `Plugin ${pluginId} declared duplicate configSchema`, 409);
      }
      assertConfigSchemaDisplayCopy(pluginId, schema);
      state.configSchema = schema;
    },

    hook: {
      onTrigger: (fn, o) => addHook('trigger', fn, o),
      onInput: (fn, o) => addHook('input', fn, o),
      onBeforeTurn: (fn, o) => addHook('before_turn', fn, o),
      onToolCall: (fn, o) => addHook('tool_call', fn, o),
      onToolResult: (fn, o) => addHook('tool_result', fn, o),
      onAgentSpawn: (fn, o) => addHook('agent_spawn', fn, o),
      onTurnSettled: (fn, o) => addHook('turn_settled', fn, o),
    },

    action: (spec) => {
      assertOpen(`declare action ${spec.id}`);
      capabilityRegistry.registerAction(pluginId, spec);
    },

    tool: (spec) => {
      assertOpen(`declare tool ${spec.name}`);
      capabilityRegistry.registerTool(pluginId, spec);
    },

    route: (spec) => {
      assertOpen(`declare route ${spec.path}`);
      capabilityRegistry.registerRoute(pluginId, spec);
    },

    doc: (name, initial, opts) => {
      assertOpen(`declare doc ${name}`);
      return docRegistry.registerDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
    },

    sessionDoc: (name, initial, opts) => {
      assertOpen(`declare sessionDoc ${name}`);
      return docRegistry.registerSessionDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
    },

    service: (spec: PluginServiceSpec) => {
      assertOpen(`declare service ${spec.id}`);
      assertValidId('service', spec.id);
      if (spec.liveTasks !== undefined && typeof spec.liveTasks !== 'function') {
        throw new HelmError(
          'invalid_service_spec',
          `Plugin ${pluginId} service ${spec.id} liveTasks must be a function returning a string array`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      if (spec.prepare !== undefined && typeof spec.prepare !== 'function') {
        throw new HelmError(
          'invalid_service_spec',
          `Plugin ${pluginId} service ${spec.id} prepare must be a function`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      if (state.services.some((s) => s.id === spec.id)) {
        throw new HelmError('duplicate_service', `Plugin ${pluginId} declared duplicate service ${spec.id}`, 409);
      }
      state.services.push({ ...spec, pluginId, started: false, prepared: false });
    },

    provider: (provider: Provider) => {
      assertOpen(`declare provider ${(provider as { id?: unknown })?.id ?? '<unknown>'}`);
      assertValidProviderShape(pluginId, provider);
      if (state.providers.some((p) => p.provider.id === provider.id)) {
        throw new HelmError('duplicate_provider', `Plugin ${pluginId} declared duplicate provider ${provider.id}`, 409);
      }
      state.providers.push({ provider, unregister: null });
    },

    ui: {
      sidebarItem: (spec: SidebarItemSpec) => {
        assertOpen('declare ui.sidebarItem');
        uiRegistry.registerUi(pluginId, 'sidebar.item', spec, 'sidebarItem', state.definition.clientRoot);
      },
      sidebarSection: (spec: SidebarSectionSpec) => {
        assertOpen('declare ui.sidebarSection');
        uiRegistry.registerUi(pluginId, 'sidebar.section', spec, 'sidebarSection', state.definition.clientRoot);
      },
      screen: (spec: ScreenSpec) => {
        assertOpen('declare ui.screen');
        uiRegistry.registerUi(pluginId, 'screen', spec, 'screen', state.definition.clientRoot);
      },
      timelineRenderer: (spec: TimelineRendererSpec) => {
        assertOpen('declare ui.timelineRenderer');
        uiRegistry.registerUi(pluginId, 'timeline.renderer', spec, 'timelineRenderer', state.definition.clientRoot);
      },
      markdownCodeBlock: (spec: MarkdownCodeBlockSpec) => {
        assertOpen('declare ui.markdownCodeBlock');
        uiRegistry.registerUi(pluginId, 'markdown.codeBlock', spec, 'markdownCodeBlock', state.definition.clientRoot);
      },
      toolView: (spec: ToolViewSpec) => {
        assertOpen('declare ui.toolView');
        uiRegistry.registerUi(pluginId, 'tool.view', spec, 'toolView', state.definition.clientRoot);
      },
      composerPill: (spec: ComposerPillSpec) => {
        assertOpen('declare ui.composerPill');
        uiRegistry.registerUi(pluginId, 'composer.pill', spec, 'composerPill', state.definition.clientRoot);
      },
      composerWidget: (spec: ComposerWidgetSpec) => {
        assertOpen('declare ui.composerWidget');
        uiRegistry.registerUi(pluginId, 'composer.widget', spec, 'composerWidget', state.definition.clientRoot);
      },
      composerCompleter: (spec: ComposerCompleterSpec) => {
        assertOpen('declare ui.composerCompleter');
        uiRegistry.registerUi(pluginId, 'composer.completer', spec, 'composerCompleter', state.definition.clientRoot);
      },
      artifactPreviewer: (spec: ArtifactPreviewerSpec) => {
        assertOpen('declare ui.artifactPreviewer');
        uiRegistry.registerUi(pluginId, 'artifact.previewer', spec, 'artifactPreviewer', state.definition.clientRoot);
      },
      workbenchPanel: (spec: WorkbenchPanelSpec) => {
        assertOpen('declare ui.workbenchPanel');
        uiRegistry.registerUi(pluginId, 'workbench.panel', spec, 'workbenchPanel', state.definition.clientRoot);
      },
      command: (spec: CommandSpec) => {
        assertOpen('declare ui.command');
        uiRegistry.registerUi(pluginId, 'commandPalette', spec, 'command', state.definition.clientRoot);
      },
      settingsPanel: (spec: SettingsPanelSpec) => {
        assertOpen('declare ui.settingsPanel');
        uiRegistry.registerUi(pluginId, 'settings.panel', spec, 'settingsPanel', state.definition.clientRoot);
      },
      profileRuntime: (spec: ProfileRuntimeUiSpec) => {
        assertOpen('declare ui.profileRuntime');
        uiRegistry.registerUi(pluginId, 'profile.runtime', spec, 'profileRuntime', state.definition.clientRoot);
      },
      action: (spec: UiActionSpec) => {
        assertOpen(`declare ui.action(${spec.target})`);
        const surface = UI_ACTION_SURFACES[spec.target];
        if (surface === undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `Plugin ${pluginId} ui.action target is invalid (${String(spec.target)}; allowed: conversation:header | conversation:row | timeline:entry)`,
            400,
            { pluginId, target: String(spec.target) },
          );
        }
        uiRegistry.registerUi(pluginId, surface, spec, 'action', state.definition.clientRoot);
      },
      slot: (spec: PluginSlotContributionSpec) => {
        assertOpen('declare ui.slot');
        uiRegistry.registerUi(pluginId, 'plugin.slot', spec, 'slot', state.definition.clientRoot);
      },
    },

    host,
  };

  return ctx;
}
