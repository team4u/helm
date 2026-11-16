/**
 * group install HelmPluginContext(hook, action, tool, route, doc, sessionDoc, service, provider, ui and host).
 */
import {
  HelmError,
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

export interface CreatePluginContextOptions {
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

  /** register method only in this enable cycle definePlugin execute during available. */
  const assertOpen = (what: string) => {
    assertNotDisposed();
    if (epoch !== state.epoch || state.phase !== 'defining') {
      throw new HelmError(
        'plugin_context_closed',
        `plugin ${pluginId}  definePlugin context already close (deactivate or enter new enable cycle), disallows ${what}`,
        409,
      );
    }
  };

  /**
   * doc handle in this cycle inside (contains run phase) can write; deactivate in or cycle more replace after expires.
   * exception: subject to control stop doc write window (host is now await this plugin service stop chain,
   * epoch by handle closed package guarantee consistent) allows eventually persist write, see PluginState.stopWindow.
   */
  const assertDocUsable = (name: string) => {
    if (state.stopWindow && isRegisteredState(state) && state.epoch === epoch) {
      return;
    }
    assertContextUsable(state, epoch, `doc ${name} handle`);
  };

  const addHook = <N extends HookName>(name: N, fn: HookHandler<N>, opts?: HookOptions) => {
    assertOpen(`append ${name} hook`);
    (pipelines.get(name) as unknown as HookPipeline<N>).add(pluginId, fn, opts?.priority ?? 0);
    state.hooks.add(name);
  };

  const host = wrapHostApi(state, epoch, hostDeps);

  const ctx: HelmPluginContext = {
    pluginId,
    dataDir: state.dataDir,
    getConfig: () => (configStore ? configStore.get(pluginId) : {}) as never,
    configSchema: (schema) => {
      assertOpen('declaration configSchema');
      if (state.configSchema) {
        throw new HelmError('duplicate_config_schema', `plugin ${pluginId} duplicate declaration configSchema`, 409);
      }
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
      assertOpen(`declaration action ${spec.id}`);
      capabilityRegistry.registerAction(pluginId, spec);
    },

    tool: (spec) => {
      assertOpen(`declaration tool ${spec.name}`);
      capabilityRegistry.registerTool(pluginId, spec);
    },

    route: (spec) => {
      assertOpen(`declaration routing ${spec.path}`);
      capabilityRegistry.registerRoute(pluginId, spec);
    },

    doc: (name, initial, opts) => {
      assertOpen(`declaration doc ${name}`);
      return docRegistry.registerDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
    },

    sessionDoc: (name, initial, opts) => {
      assertOpen(`declaration sessionDoc ${name}`);
      return docRegistry.registerSessionDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
    },

    service: (spec: PluginServiceSpec) => {
      assertOpen(`declaration service ${spec.id}`);
      assertValidId('service', spec.id);
      if (spec.liveTasks !== undefined && typeof spec.liveTasks !== 'function') {
        throw new HelmError(
          'invalid_service_spec',
          `plugin ${pluginId} service ${spec.id}  liveTasks must be return string array function`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      if (spec.prepare !== undefined && typeof spec.prepare !== 'function') {
        throw new HelmError(
          'invalid_service_spec',
          `plugin ${pluginId} service ${spec.id}  prepare must be function`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      if (state.services.some((s) => s.id === spec.id)) {
        throw new HelmError('duplicate_service', `plugin ${pluginId} duplicate declaration service ${spec.id}`, 409);
      }
      state.services.push({ ...spec, pluginId, started: false, prepared: false });
    },

    provider: (provider: Provider) => {
      assertOpen(`declaration provider ${(provider as { id?: unknown })?.id ?? '<unknown>'}`);
      assertValidProviderShape(pluginId, provider);
      if (state.providers.some((p) => p.provider.id === provider.id)) {
        throw new HelmError('duplicate_provider', `plugin ${pluginId} duplicate declaration provider ${provider.id}`, 409);
      }
      state.providers.push({ provider, unregister: null });
    },

    ui: {
      sidebarItem: (spec: SidebarItemSpec) => {
        assertOpen('declaration ui.sidebarItem');
        uiRegistry.registerUi(pluginId, 'sidebar.item', spec, 'sidebarItem', state.definition.clientRoot);
      },
      sidebarSection: (spec: SidebarSectionSpec) => {
        assertOpen('declaration ui.sidebarSection');
        uiRegistry.registerUi(pluginId, 'sidebar.section', spec, 'sidebarSection', state.definition.clientRoot);
      },
      screen: (spec: ScreenSpec) => {
        assertOpen('declaration ui.screen');
        uiRegistry.registerUi(pluginId, 'screen', spec, 'screen', state.definition.clientRoot);
      },
      timelineRenderer: (spec: TimelineRendererSpec) => {
        assertOpen('declaration ui.timelineRenderer');
        uiRegistry.registerUi(pluginId, 'timeline.renderer', spec, 'timelineRenderer', state.definition.clientRoot);
      },
      markdownCodeBlock: (spec: MarkdownCodeBlockSpec) => {
        assertOpen('declaration ui.markdownCodeBlock');
        uiRegistry.registerUi(pluginId, 'markdown.codeBlock', spec, 'markdownCodeBlock', state.definition.clientRoot);
      },
      toolView: (spec: ToolViewSpec) => {
        assertOpen('declaration ui.toolView');
        uiRegistry.registerUi(pluginId, 'tool.view', spec, 'toolView', state.definition.clientRoot);
      },
      composerPill: (spec: ComposerPillSpec) => {
        assertOpen('declaration ui.composerPill');
        uiRegistry.registerUi(pluginId, 'composer.pill', spec, 'composerPill', state.definition.clientRoot);
      },
      composerWidget: (spec: ComposerWidgetSpec) => {
        assertOpen('declaration ui.composerWidget');
        uiRegistry.registerUi(pluginId, 'composer.widget', spec, 'composerWidget', state.definition.clientRoot);
      },
      composerCompleter: (spec: ComposerCompleterSpec) => {
        assertOpen('declaration ui.composerCompleter');
        uiRegistry.registerUi(pluginId, 'composer.completer', spec, 'composerCompleter', state.definition.clientRoot);
      },
      artifactPreviewer: (spec: ArtifactPreviewerSpec) => {
        assertOpen('declaration ui.artifactPreviewer');
        uiRegistry.registerUi(pluginId, 'artifact.previewer', spec, 'artifactPreviewer', state.definition.clientRoot);
      },
      workbenchPanel: (spec: WorkbenchPanelSpec) => {
        assertOpen('declaration ui.workbenchPanel');
        uiRegistry.registerUi(pluginId, 'workbench.panel', spec, 'workbenchPanel', state.definition.clientRoot);
      },
      command: (spec: CommandSpec) => {
        assertOpen('declaration ui.command');
        uiRegistry.registerUi(pluginId, 'commandPalette', spec, 'command', state.definition.clientRoot);
      },
      settingsPanel: (spec: SettingsPanelSpec) => {
        assertOpen('declaration ui.settingsPanel');
        uiRegistry.registerUi(pluginId, 'settings.panel', spec, 'settingsPanel', state.definition.clientRoot);
      },
      profileRuntime: (spec: ProfileRuntimeUiSpec) => {
        assertOpen('declaration ui.profileRuntime');
        uiRegistry.registerUi(pluginId, 'profile.runtime', spec, 'profileRuntime', state.definition.clientRoot);
      },
      action: (spec: UiActionSpec) => {
        assertOpen(`declaration ui.action(${spec.target})`);
        const surface = UI_ACTION_SURFACES[spec.target];
        if (surface === undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `plugin ${pluginId} ui.action  target illegal (${String(spec.target)}; allows conversation:header | conversation:row | timeline:entry)`,
            400,
            { pluginId, target: String(spec.target) },
          );
        }
        uiRegistry.registerUi(pluginId, surface, spec, 'action', state.definition.clientRoot);
      },
      slot: (spec: PluginSlotContributionSpec) => {
        assertOpen('declaration ui.slot');
        uiRegistry.registerUi(pluginId, 'plugin.slot', spec, 'slot', state.definition.clientRoot);
      },
    },

    host,
  };

  return ctx;
}
