/**
 * 组装 HelmPluginContext（hook, action, tool, route, doc, sessionDoc, service, provider, ui 与 host）。
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

  /** 注册方法仅在本启用周期的 definePlugin 执行期间可用。 */
  const assertOpen = (what: string) => {
    assertNotDisposed();
    if (epoch !== state.epoch || state.phase !== 'defining') {
      throw new HelmError(
        'plugin_context_closed',
        `插件 ${pluginId} 的 definePlugin 上下文已关闭（停用或进入新启用周期），不允许 ${what}`,
        409,
      );
    }
  };

  /**
   * doc 句柄在本周期内（含运行期）可写；停用中或周期更替后失效。
   * 例外：受控停止 doc 写入窗口（宿主正在 await 的本插件服务 stop 链，
   * epoch 由句柄闭包保证一致）允许最终持久化写入，见 PluginState.stopWindow。
   */
  const assertDocUsable = (name: string) => {
    if (state.stopWindow && isRegisteredState(state) && state.epoch === epoch) {
      return;
    }
    assertContextUsable(state, epoch, `doc ${name} 句柄`);
  };

  const addHook = <N extends HookName>(name: N, fn: HookHandler<N>, opts?: HookOptions) => {
    assertOpen(`追加 ${name} 钩子`);
    (pipelines.get(name) as unknown as HookPipeline<N>).add(pluginId, fn, opts?.priority ?? 0);
    state.hooks.add(name);
  };

  const host = wrapHostApi(state, epoch, hostDeps);

  const ctx: HelmPluginContext = {
    pluginId,
    dataDir: state.dataDir,
    getConfig: () => (configStore ? configStore.get(pluginId) : {}) as never,
    configSchema: (schema) => {
      assertOpen('声明 configSchema');
      if (state.configSchema) {
        throw new HelmError('duplicate_config_schema', `插件 ${pluginId} 重复声明 configSchema`, 409);
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
      assertOpen(`声明动作 ${spec.id}`);
      capabilityRegistry.registerAction(pluginId, spec);
    },

    tool: (spec) => {
      assertOpen(`声明工具 ${spec.name}`);
      capabilityRegistry.registerTool(pluginId, spec);
    },

    route: (spec) => {
      assertOpen(`声明路由 ${spec.path}`);
      capabilityRegistry.registerRoute(pluginId, spec);
    },

    doc: (name, initial, opts) => {
      assertOpen(`声明 doc ${name}`);
      return docRegistry.registerDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
    },

    sessionDoc: (name, initial, opts) => {
      assertOpen(`声明 sessionDoc ${name}`);
      return docRegistry.registerSessionDoc(pluginId, name, initial, opts, () => assertDocUsable(name));
    },

    service: (spec: PluginServiceSpec) => {
      assertOpen(`声明服务 ${spec.id}`);
      assertValidId('服务', spec.id);
      if (spec.liveTasks !== undefined && typeof spec.liveTasks !== 'function') {
        throw new HelmError(
          'invalid_service_spec',
          `插件 ${pluginId} 服务 ${spec.id} 的 liveTasks 必须是返回字符串数组的函数`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      if (spec.liveWorktrees !== undefined && typeof spec.liveWorktrees !== 'function') {
        throw new HelmError(
          'invalid_service_spec',
          `插件 ${pluginId} 服务 ${spec.id} 的 liveWorktrees 必须是返回 { nodeId, path } 数组的函数`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      if (spec.prepare !== undefined && typeof spec.prepare !== 'function') {
        throw new HelmError(
          'invalid_service_spec',
          `插件 ${pluginId} 服务 ${spec.id} 的 prepare 必须是函数`,
          400,
          { pluginId, serviceId: spec.id },
        );
      }
      if (state.services.some((s) => s.id === spec.id)) {
        throw new HelmError('duplicate_service', `插件 ${pluginId} 重复声明服务 ${spec.id}`, 409);
      }
      state.services.push({ ...spec, pluginId, started: false, prepared: false });
    },

    provider: (provider: Provider) => {
      assertOpen(`声明 provider ${(provider as { id?: unknown })?.id ?? '<unknown>'}`);
      assertValidProviderShape(pluginId, provider);
      if (state.providers.some((p) => p.provider.id === provider.id)) {
        throw new HelmError('duplicate_provider', `插件 ${pluginId} 重复声明 provider ${provider.id}`, 409);
      }
      state.providers.push({ provider, unregister: null });
    },

    ui: {
      sidebarItem: (spec: SidebarItemSpec) => {
        assertOpen('声明 ui.sidebarItem');
        uiRegistry.registerUi(pluginId, 'sidebar.item', spec, 'sidebarItem', state.definition.clientRoot);
      },
      sidebarSection: (spec: SidebarSectionSpec) => {
        assertOpen('声明 ui.sidebarSection');
        uiRegistry.registerUi(pluginId, 'sidebar.section', spec, 'sidebarSection', state.definition.clientRoot);
      },
      screen: (spec: ScreenSpec) => {
        assertOpen('声明 ui.screen');
        uiRegistry.registerUi(pluginId, 'screen', spec, 'screen', state.definition.clientRoot);
      },
      timelineRenderer: (spec: TimelineRendererSpec) => {
        assertOpen('声明 ui.timelineRenderer');
        uiRegistry.registerUi(pluginId, 'timeline.renderer', spec, 'timelineRenderer', state.definition.clientRoot);
      },
      markdownCodeBlock: (spec: MarkdownCodeBlockSpec) => {
        assertOpen('声明 ui.markdownCodeBlock');
        uiRegistry.registerUi(pluginId, 'markdown.codeBlock', spec, 'markdownCodeBlock', state.definition.clientRoot);
      },
      toolView: (spec: ToolViewSpec) => {
        assertOpen('声明 ui.toolView');
        uiRegistry.registerUi(pluginId, 'tool.view', spec, 'toolView', state.definition.clientRoot);
      },
      composerPill: (spec: ComposerPillSpec) => {
        assertOpen('声明 ui.composerPill');
        uiRegistry.registerUi(pluginId, 'composer.pill', spec, 'composerPill', state.definition.clientRoot);
      },
      composerWidget: (spec: ComposerWidgetSpec) => {
        assertOpen('声明 ui.composerWidget');
        uiRegistry.registerUi(pluginId, 'composer.widget', spec, 'composerWidget', state.definition.clientRoot);
      },
      composerCompleter: (spec: ComposerCompleterSpec) => {
        assertOpen('声明 ui.composerCompleter');
        uiRegistry.registerUi(pluginId, 'composer.completer', spec, 'composerCompleter', state.definition.clientRoot);
      },
      artifactPreviewer: (spec: ArtifactPreviewerSpec) => {
        assertOpen('声明 ui.artifactPreviewer');
        uiRegistry.registerUi(pluginId, 'artifact.previewer', spec, 'artifactPreviewer', state.definition.clientRoot);
      },
      workbenchPanel: (spec: WorkbenchPanelSpec) => {
        assertOpen('声明 ui.workbenchPanel');
        uiRegistry.registerUi(pluginId, 'workbench.panel', spec, 'workbenchPanel', state.definition.clientRoot);
      },
      command: (spec: CommandSpec) => {
        assertOpen('声明 ui.command');
        uiRegistry.registerUi(pluginId, 'commandPalette', spec, 'command', state.definition.clientRoot);
      },
      settingsPanel: (spec: SettingsPanelSpec) => {
        assertOpen('声明 ui.settingsPanel');
        uiRegistry.registerUi(pluginId, 'settings.panel', spec, 'settingsPanel', state.definition.clientRoot);
      },
      profileRuntime: (spec: ProfileRuntimeUiSpec) => {
        assertOpen('声明 ui.profileRuntime');
        uiRegistry.registerUi(pluginId, 'profile.runtime', spec, 'profileRuntime', state.definition.clientRoot);
      },
      action: (spec: UiActionSpec) => {
        assertOpen(`声明 ui.action（${spec.target}）`);
        const surface = UI_ACTION_SURFACES[spec.target];
        if (surface === undefined) {
          throw new HelmError(
            'invalid_ui_spec',
            `插件 ${pluginId} ui.action 的 target 非法（${String(spec.target)}；允许 conversation:header | conversation:row | timeline:entry）`,
            400,
            { pluginId, target: String(spec.target) },
          );
        }
        uiRegistry.registerUi(pluginId, surface, spec, 'action', state.definition.clientRoot);
      },
      slot: (spec: PluginSlotContributionSpec) => {
        assertOpen('声明 ui.slot');
        uiRegistry.registerUi(pluginId, 'plugin.slot', spec, 'slot', state.definition.clientRoot);
      },
    },

    host,
  };

  return ctx;
}
