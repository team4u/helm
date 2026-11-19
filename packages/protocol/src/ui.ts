/**
 * Frontend extension surface: base UI, micro interactions, runtime metadata and plugin sub-slots.
 * Each extension point is referenced and rendered via named exports from client.tsx
 * (the host shares the React runtime; this package does not import React types).
 */

import type { ConversationAttachmentRef, ConversationEntry, ConversationScope, ConversationSummary, ToolResultTruncation, WhenBusy } from './conversation.js'
import type { HelmxLocale, LocaleTranslator, LocalizedText } from './locale.js'
import type { PluginSummary } from './plugin-dto.js'

/** Reserved CSS text export name kept by the compiler; the loader mounts it onto the page only after validating the module. */
export const PLUGIN_CLIENT_CSS_EXPORT = '__helmxClientCss' as const

/** Named export reference inside a plugin client.tsx build artifact. */
export interface ClientComponentRef {
  /** Source module path relative to the plugin clientRoot (e.g. 'client.tsx', 'panels/Status.tsx'; absolute paths / escaping the root via ../ are forbidden). */
  module: string
  /** Named export name. */
  export: string
}

/**
 * Common shape of all UI extension points (client.tsx track only: the declarative JSON spec track has moved out of the kernel and is provided by the builtin:json-render plugin via markdown code blocks).
 *
 * Display copy fields (`title` and the per-surface `label` / `description`) are
 * `LocalizedText`: a plain string or a per-locale map resolved by the host UI
 * via its active locale. They never influence execution. The registration
 * boundary validates them with `parseNonEmptyLocalizedText` (supported locale
 * keys, non-blank copy) — invalid declarations are rejected, never silently
 * stripped.
 */
export interface UiSpecBase {
  /** Extension-point-unique ID (final addressing is <extension>:<pluginId>/<id>). */
  id: string
  /** Display copy for the extension (resolved by the active UI locale). */
  title?: LocalizedText
  /** client.tsx component reference (requires the plugin definition to provide clientRoot). */
  client?: ClientComponentRef
  /** Conversation scope: render this extension point only for matching conversations (or when no conversation context exists). */
  scope?: ConversationScope
}

// 1. sidebar.item & sidebar.section
export interface SidebarItemSpec extends UiSpecBase {
  label: LocalizedText
  icon?: string
  /** Click target, e.g. 'conversation:1', 'conversation:profile:superagent', 'screen:builtin:superagent/recall-graph'. */
  target?: string
  order?: number
}

export interface SidebarSectionSpec extends UiSpecBase {
  label: LocalizedText
  icon?: string
  /** Conversation filter tag inside the group (e.g. 'worker'). */
  filterTag?: string
  /** Whether the group is collapsible and its default collapsed state (e.g. the archived group). */
  collapsible?: boolean
  defaultCollapsed?: boolean
  order?: number
}

// 2. screen (full-screen custom view, supports left/right split view side by side)
export interface ScreenSpec extends UiSpecBase {
  label: LocalizedText
  icon?: string
}

// 3. timeline.renderer (take over timeline entries by entry kind / metadata)
export interface TimelineRendererSpec extends UiSpecBase {
  /** Priority descending; same priority keeps contribution order, default 0. */
  priority?: number
  /** Entry kinds to take over; omit to take over all. */
  kinds?: string[]
  /** Take over entries whose entry.data.renderer equals this value (AND with kinds). */
  matchMeta?: { renderer: string }
}

// 3.5 markdown.codeBlock (take over markdown code block rendering by fenced language)
export interface MarkdownCodeBlockSpec extends UiSpecBase {
  /** Fenced languages to take over (e.g. ['ui', 'json-render'], ['mermaid']; must be non-empty, no duplicates). */
  languages: string[]
  /** Priority descending; same priority keeps contribution order, default 0. On same-language multi-plugin conflicts the highest priority wins, ties go to the earlier contribution. */
  priority?: number
  /** Component reference (requires the plugin definition to provide clientRoot); falls back to a plain code block when no matching registration exists or the plugin is disabled. */
  client: ClientComponentRef
}

/** Standard props received by markdown.codeBlock components. */
export interface MarkdownCodeBlockProps {
  /** Lower-cased fenced language (exact match with declared languages; no substring/prefix matching). */
  language: string
  /** Raw code block text (trailing newline stripped; not parsed in any way — JSON validity is up to the component). */
  code: string
  /** Owning conversation context (undefined when rendered without a conversation). */
  conversationId?: number
}

// 4. tool.view (take over tool-call inline cards by toolName)
export interface ToolViewSpec extends UiSpecBase {
  priority?: number
  toolNames: string[]
  /**
   * When true, fully replaces the outer default .trace-row tool row (the plugin
   * component renders the pill bar and inline details itself),
   * avoiding double bars.
   */
  replaceRow?: boolean
}

// 5. composer.pill & composer.widget
export interface ComposerPillSpec extends UiSpecBase {
  label: LocalizedText
  icon?: string
}

export interface ComposerWidgetSpec extends UiSpecBase {}
/**
 * Completions only insert text; they never execute commands carried by
 * candidates. Item labels are runtime data produced by plugin actions/docs
 * (not registration-time display metadata), so they stay plain strings.
 */
export interface ComposerCompletionItem {
  id: string
  label: string
  insertText: string
  hint?: string
  icon?: string
}

/** Query actions receive only text and context identity (real conversations pass conversationId; the standby draft state may pass profileId). */
export interface ComposerCompletionQuery {
  query: string
  conversationId?: number
  profileId?: string
}

export interface ComposerCompletionResult {
  items: ComposerCompletionItem[]
}

/** Document sources only read the contributing plugin's own public docs; itemsField is the top-level array field name. */
export type ComposerCompletionSource =
  | { kind: 'action'; actionId: string; actionPluginId?: string }
  | { kind: 'doc' | 'sessionDoc'; name: string; itemsField: string }

/** Completions are rendered uniformly by the host and accept no client callbacks or views. '/' is reserved for commands and skills. */
export interface ComposerCompleterSpec extends Omit<UiSpecBase, 'client'> {
  label: LocalizedText
  trigger: '@' | '#' | ':'
  priority?: number
  source: ComposerCompletionSource
}

/** Exact MIME values or type/*; extensions are dot-prefixed lowercase suffixes (including multi-segment suffixes). The two matchers are OR-combined. */
export interface ArtifactPreviewerSpec extends UiSpecBase {
  label: LocalizedText
  icon?: string
  priority?: number
  mimeTypes?: string[]
  extensions?: string[]
}

/** Preview components run on the main site and are trusted plugin code; blob content is not trusted HTML. */
export interface ArtifactPreviewerProps {
  artifactId: string
  conversationId?: number
  /** Default when name metadata is not loaded; never passes artifactId off as the file name. */
  name?: string
  mimeType: string
  size: number
  /** Lifecycle is managed by the host; plugins must not revoke it themselves. */
  blobUrl: string
  /** Decodes at most 1 MiB of text content; null for binary or over-limit content. */
  text: string | null
}

// 6. workbench.panel (conversation-aware right-drawer panel)
export interface WorkbenchPanelBadgeSpec {
  /** Subscribed public doc name of this plugin. */
  doc: string
  /** Global numeric counter field name (reads docValue[countField]). */
  countField?: string
  /** Global badge tone field name (reads docValue[toneField], values: 'warn' | 'accent' | 'neutral'). */
  toneField?: string
  /**
   * Field name of the stats map indexed by conversation ID (reads
   * docValue[byConversationField][String(conversationId)], shaped as
   * { count: number; tone?: 'warn' | 'accent' | 'neutral'; footerText?: string }).
   */
  byConversationField?: string
}

export interface WorkbenchPanelSpec extends UiSpecBase {
  label: LocalizedText
  icon?: string
  order?: number
  /** Dynamic badge and status bar config (drives workbench drawer tab counts, footer summaries and the top bar "Workbench" aggregate badge). */
  badge?: WorkbenchPanelBadgeSpec
}

// 7. commandPalette (⌘K) & settings.panel
export interface CommandSpec extends UiSpecBase {
  title: LocalizedText
  icon?: string
  /** Trigger word without /; also derives the composer slash menu. Must not override host reserved commands. */
  slash?: string
  /** Display copy describing the command (resolved by the active UI locale). */
  description?: LocalizedText
  /** Quick commands reuse the ctx.action endpoint. */
  actionId?: string
  actionPluginId?: string
  input?: Record<string, unknown>
  keywords?: string[]
}

export interface SettingsPanelSpec extends UiSpecBase {
  label: LocalizedText
  order?: number
}

/** External Profile runtime metadata; the form structure is driven by the host's generic ProfileRuntime contract. */
export interface ProfileRuntimeUiSpec {
  id: string
  kind: string
  label: LocalizedText
  icon?: string
  /** Display copy describing the runtime (resolved by the active UI locale). */
  description?: LocalizedText
  agentSuggestions?: string[]
  order?: number
}

/** Unified UI action declaration: one shape serves three micro slots (distinguished by target), no more duplicated methods. */
export interface UiActionSpec extends UiSpecBase {
  target: 'conversation:header' | 'conversation:row' | 'timeline:entry'
  label: LocalizedText
  icon?: string
  order?: number
  /** conversation:header only: 'toolbar' renders direct buttons, 'menu' (default) folds into the dropdown. */
  placement?: 'toolbar' | 'menu'
  /** Plugin action delegated to the host for execution (mutually exclusive with client; missing both is rejected at the registration boundary). */
  actionId?: string
  actionPluginId?: string
  input?: Record<string, unknown>
  /** timeline:entry only: entry kinds to take over (default matches all). */
  kinds?: string[]
  /** timeline:entry only: text message roles to take over. */
  roles?: Array<'user' | 'assistant'>
}

/** Injects content into a named sub-slot of another plugin. */
export interface PluginSlotContributionSpec extends UiSpecBase {
  /** <ownerPluginId>/<slotName>, must contain exactly one /. */
  target: string
  order?: number
  priority?: number
}

/** Fully qualified name of the Profile detail drawer plugin extension sub-slot (provided by builtin:profile, injected by other plugins). */
export const PROFILE_DETAIL_SECTION_SLOT = 'builtin:profile/detail-section' as const

/** Namespace reserved by the host node center; does not imply a builtin:node plugin exists. */
export const NODE_DETAIL_SECTION_SLOT = 'builtin:node/detail-section' as const

/** Namespace reserved by the host composer status row; does not imply a builtin:composer plugin exists.
 * Contribution components receive ComposerScopeProps with the same shape as
 * composer.pill/widget (conversation + composer) and render next to the
 * read-only context usage state; read-only rate metrics (e.g. builtin:token-speed)
 * are contributed through this slot; on mobile they also stay in the toolbar
 * status area (not folded into the more menu). */
export const COMPOSER_STATUS_SLOT = 'builtin:composer/status' as const

/** Namespace reserved by the host composer top tray; does not imply a builtin:composer plugin exists.
 * Contribution components receive ComposerScopeProps (conversation + composer)
 * and render directly above the AskDock (not folded into a more menu on either
 * desktop or mobile); with nothing in flight they should return null to zero
 * the height. */
export const COMPOSER_DOCK_SLOT = 'builtin:composer/dock' as const

/** Only mounted for existing nodes; contains no node access tokens or other credentials. */
export interface NodeDetailSlotProps {
  nodeId: string
  isLocal: boolean
  isOnline: boolean
  isNew: boolean
}

/** Generic props passed to plugin client.tsx components for the target: PROFILE_DETAIL_SECTION_SLOT sub-slot (without concrete plugin business fields). */
export interface ProfileDetailSlotProps {
  /** The single Profile ID currently being viewed/edited (empty string in create mode). */
  profileId: string
  /** Whether the drawer is in new-Profile mode (not yet persisted). */
  isNew: boolean
  /** Whether the host drawer is in a saving/deleting disabled state. */
  disabled: boolean
}

/** ctx.ui: base extension surface plus fine-grained composition extension surfaces. */
export interface PluginUiRegistry {
  sidebarItem(spec: SidebarItemSpec): void
  sidebarSection(spec: SidebarSectionSpec): void
  screen(spec: ScreenSpec): void
  timelineRenderer(spec: TimelineRendererSpec): void
  markdownCodeBlock(spec: MarkdownCodeBlockSpec): void
  toolView(spec: ToolViewSpec): void
  composerPill(spec: ComposerPillSpec): void
  composerWidget(spec: ComposerWidgetSpec): void
  composerCompleter(spec: ComposerCompleterSpec): void
  artifactPreviewer(spec: ArtifactPreviewerSpec): void
  workbenchPanel(spec: WorkbenchPanelSpec): void
  command(spec: CommandSpec): void
  settingsPanel(spec: SettingsPanelSpec): void
  profileRuntime(spec: ProfileRuntimeUiSpec): void
  /** Unified UI action registration (three micro slots: conversation:header / conversation:row / timeline:entry). */
  action(spec: UiActionSpec): void
  slot(spec: PluginSlotContributionSpec): void
}

// ---------------------------------------------------------------------------
// Standard component props (pure data shapes, consumed by client.tsx
// implementations and passed by the host; no React types imported)
// ---------------------------------------------------------------------------

/** screen: full-screen custom view (supports left/right split view side by side). */
export interface ScreenProps {
  pluginId: string
  screenId: string
  isSplit: boolean
  params: Readonly<Record<string, string>>
  /** undefined deletes the key; default replaces history, explicit push appends a new entry. */
  setParams(patch: Record<string, string | undefined>, options?: { push?: boolean }): void
}

/** timeline.renderer: takes over rendering of a single timeline entry. */
export interface TimelineRendererProps {
  entry: ConversationEntry
  conversationId: number
}

/** Lightweight summary of all tool calls in the same conversation (for plugins to dedupe themselves, e.g. folding multiple resumes of the same sub-conversation). */
export interface ToolViewSiblingCall {
  callId: string
  toolName: string
  input?: unknown
  status: 'running' | 'done' | 'error'
  result?: unknown
  structuredOutput?: unknown
  /** Present when the result is a truncated preview from the detail endpoint; plugins must not treat result as the full original text. */
  resultTruncation?: ToolResultTruncation
}

/** tool.view: serializable data of a tool call process and result. */
export interface ToolViewProps {
  callId: string
  toolName: string
  input?: unknown
  status: 'running' | 'done' | 'error'
  result?: unknown
  structuredOutput?: unknown
  /** Present when the result is a truncated preview from the detail endpoint; plugins must not treat result as the full original text. */
  resultTruncation?: ToolResultTruncation
  isError?: boolean
  startedAt?: number
  durationMs?: number
  artifactRef?: string
  conversationId: number
  /** All tool calls in the currently loaded timeline (chronological), for plugins to compute folding/continuation relationships themselves. */
  siblingCalls?: ReadonlyArray<ToolViewSiblingCall>
}

export interface ComposerController {
  readonly draft: string
  readonly attachments: ReadonlyArray<ConversationAttachmentRef>
  readonly sending: boolean
  setDraft(text: string): void
  insertText(text: string): void
  /** Omits text to submit the current draft with attachments; explicit text does not consume the original draft. Must reject on failure. */
  submit(text?: string, options?: { whenBusy?: WhenBusy }): Promise<void>
}

/** composer.pill / composer.widget: composer area extensions. */
export interface ComposerScopeProps {
  conversation: ConversationSummary
  composer: ComposerController
}

/** workbench.panel: conversation-aware right-drawer panel. */
export interface WorkbenchPanelProps {
  conversation: ConversationSummary
}

/**
 * Serialized UI contribution (element of the ui array in event snapshots):
 * surface is the extension point name (e.g. 'sidebar.item', 'screen', 'timeline.renderer').
 */
export interface PluginUiContribution {
  pluginId: string
  surface: string
  spec: unknown
}

/**
 * Known UI contributions of the discriminated union: covers all registered
 * surfaces so consumers (e.g. groupUiContributions) can skip `as unknown as`
 * casts after the guard.
 */
export type KnownPluginUiContribution =
  | { pluginId: string; surface: 'sidebar.item'; spec: SidebarItemSpec }
  | { pluginId: string; surface: 'sidebar.section'; spec: SidebarSectionSpec }
  | { pluginId: string; surface: 'screen'; spec: ScreenSpec }
  | { pluginId: string; surface: 'timeline.renderer'; spec: TimelineRendererSpec }
  | { pluginId: string; surface: 'markdown.codeBlock'; spec: MarkdownCodeBlockSpec }
  | { pluginId: string; surface: 'tool.view'; spec: ToolViewSpec }
  | { pluginId: string; surface: 'composer.pill'; spec: ComposerPillSpec }
  | { pluginId: string; surface: 'composer.widget'; spec: ComposerWidgetSpec }
  | { pluginId: string; surface: 'composer.completer'; spec: ComposerCompleterSpec }
  | { pluginId: string; surface: 'artifact.previewer'; spec: ArtifactPreviewerSpec }
  | { pluginId: string; surface: 'workbench.panel'; spec: WorkbenchPanelSpec }
  | { pluginId: string; surface: 'commandPalette' | 'command'; spec: CommandSpec }
  | { pluginId: string; surface: 'settings.panel'; spec: SettingsPanelSpec }
  | { pluginId: string; surface: 'profile.runtime'; spec: ProfileRuntimeUiSpec }
  | { pluginId: string; surface: 'conversation.header.action'; spec: UiActionSpec }
  | { pluginId: string; surface: 'conversation.row.action'; spec: UiActionSpec }
  | { pluginId: string; surface: 'timeline.entry.action'; spec: UiActionSpec }
  | { pluginId: string; surface: 'plugin.slot'; spec: PluginSlotContributionSpec }

/** Single source of truth of known UI contribution surfaces (bi-directionally locked with KnownPluginUiContribution). */
export const KNOWN_PLUGIN_UI_SURFACES = [
  'sidebar.item',
  'sidebar.section',
  'screen',
  'timeline.renderer',
  'markdown.codeBlock',
  'tool.view',
  'composer.pill',
  'composer.widget',
  'composer.completer',
  'artifact.previewer',
  'workbench.panel',
  'commandPalette',
  'command',
  'settings.panel',
  'profile.runtime',
  'conversation.header.action',
  'conversation.row.action',
  'timeline.entry.action',
  'plugin.slot',
] as const satisfies readonly KnownPluginUiContribution['surface'][]

type _AssertAllKnownUiSurfacesListed =
  Exclude<KnownPluginUiContribution['surface'], (typeof KNOWN_PLUGIN_UI_SURFACES)[number]> extends never
    ? true
    : never
const _assertAllKnownUiSurfacesListed: _AssertAllKnownUiSurfacesListed = true
void _assertAllKnownUiSurfacesListed

const KNOWN_PLUGIN_UI_SURFACE_SET: ReadonlySet<string> = new Set(KNOWN_PLUGIN_UI_SURFACES)

/**
 * Validate and narrow a PluginUiContribution: checks the known surface and a
 * non-null plain-object spec, then returns the discriminated-union member;
 * unknown surfaces or non-object specs return undefined.
 */
export function parsePluginUiContribution(
  item: PluginUiContribution,
): KnownPluginUiContribution | undefined {
  if (item === null || typeof item !== 'object') return undefined
  if (typeof item.pluginId !== 'string' || typeof item.surface !== 'string') return undefined
  if (!KNOWN_PLUGIN_UI_SURFACE_SET.has(item.surface)) return undefined
  if (item.spec === null || typeof item.spec !== 'object' || Array.isArray(item.spec)) return undefined
  return item as KnownPluginUiContribution
}

// ---------------------------------------------------------------------------
// client.tsx track: runtime contract between host and plugin components
// (pure types, no React import)
// ---------------------------------------------------------------------------

/**
 * Host context inside client.tsx components (return value of usePluginContext()):
 * all capabilities come from the real host (callAction goes through
 * POST /api/actions, openScreen/openSplitScreen go through host navigation,
 * getPluginDoc is a one-shot read); no mocks.
 * For reactive doc subscriptions use usePluginDoc from the shared module
 * (import from '@helmx/plugin-client').
 */
export interface CallActionOptions {
  pluginId?: string
  conversationId?: number
}

export interface PluginClientContext {
  pluginId: string
  /** Defaults to addressing the current plugin and slot conversation; can explicitly cross plugins. */
  callAction(actionId: string, input?: unknown, options?: CallActionOptions): Promise<unknown>
  /** Submits input to the target or current conversation; explicitly rejects when there is none. */
  submitInput(text: string, options?: { conversationId?: number; whenBusy?: WhenBusy }): Promise<void>
  /** Opens a target on the main screen (conversation:<id> / screen:<pluginId>/<screenId> etc.). */
  openScreen(target: string): void
  /** Opens a target in the right split pane. */
  openSplitScreen(target: string): void
  /** Opens the sub-conversation side drawer modal (unified sub-conversation view entry; does not change workbench open state). */
  openConversationDrawer(conversationId: number): void
  /** Opens the artifact preview modal. */
  openArtifact(artifactId: string): void
  /** Opens the workbench drawer (optionally activating a specific panel ID). */
  openWorkbench(panelId?: string): void
  /** Closes the workbench drawer. */
  closeWorkbench(): void
  /** Sends a global notification toast. */
  notify(message: string, tone?: 'info' | 'warning' | 'error'): void
  /** Reads the current value of this plugin's public doc (one-shot Promise; for subscription updates use the usePluginDoc shared hook). */
  getPluginDoc(docName: string, pluginId?: string): Promise<unknown>
  getPluginSessionDoc(docName: string, options?: { conversationId?: number; pluginId?: string }): Promise<unknown>
  /** Provided only by composer-area extensions and their sub-slots. */
  composer?: ComposerController
  /** Current conversation ID (undefined for slots without conversation context, e.g. some settings.panel). */
  conversationId?: number
  /** Current host theme. */
  theme: 'light' | 'dark'
  /** Current host UI locale (normalized via HELMX_LOCALES / normalizeLocaleTag). */
  locale: HelmxLocale
  /** Minimal translator: resolves LocalizedText display copy for the current locale. */
  translate: LocaleTranslator
}

/**
 * Host shared module importable by plugin client.tsx (the compiler virtualizes
 * it into the __helmx_shared_plugin_client global namespace, sharing the same
 * mechanism as React — never bundles a second React copy).
 *
 * The single source of truth of exported symbols is PLUGIN_CLIENT_SHARED_EXPORTS:
 * - hooks: usePluginContext / usePluginLocale / usePluginTranslator / usePluginDoc / usePluginSessionDoc /
 *   useToolActivity / useConversations / useConversation / usePlugins / useConversationBackground
 *   (read-only per-conversation background in-flight facts derived by the host from the
 *   generic workbench badge contract, plugin-ID-free);
 * - accessibility base components: Switch / Select / MultiSelect / Checkbox / Tabs family /
 *   SegmentedControl / HelmxIcon / ViewBoundary / Callout;
 * - StatusLight: unified status light (visually dot-only; the localized label
 *   becomes the screen-reader accessible name, never visible status text) for
 *   card main status slots, reusing the host .status-dot vocabulary;
 * - lightweight layout primitives: Screen (page container + header) / ScreenSection (sectioning) /
 *   DataTable (composable table with unified loading/empty) / KvGrid (key-value overview);
 * - content display: MarkdownView (standard markdown rendering) / CodeBlockView
 *   (syntax-highlighted code block) / CopyButton (copy button);
 * - formatting pure functions: formatTime (compact MM-DD HH:mm) / formatCompactTimestamp
 *   (MM-DD HH:mm:ss log timestamp) / formatDurationMs (millisecond duration summary) /
 *   formatBytes (human-readable bytes, 1024-based);
 * - PluginSlot: inter-plugin sub-slot rendering primitive.
 */
export const HELMX_PLUGIN_CLIENT_SHARED_MODULE = '@helmx/plugin-client'

/** usePlugins(): reactive snapshot of host plugin list and Screen contributions (SSE driven, no polling). */
export interface UsePluginsResult {
  /** Current plugin summaries of the host (kept in sync with SSE plugin.changed in real time). */
  plugins: PluginSummary[]
  /** Screen contribution list registered by currently enabled plugins (with owning pluginId). */
  screens: Array<{ pluginId: string; spec: ScreenSpec }>
}

/** GET /api/plugins/:id/client.mjs response metadata (HTTP error envelope on failure, never JS). */
export interface PluginClientModuleInfo {
  pluginId: string
  /** Requested module relative path. */
  module: string
  /** Build artifact content hash (including all local dependencies; recompiled when sources change). */
  contentHash: string
}

/** Single source of truth of all ctx.ui registration method names (bi-directionally locked with the PluginUiRegistry interface). */
export const PLUGIN_UI_METHOD_NAMES = [
  'sidebarItem',
  'sidebarSection',
  'screen',
  'timelineRenderer',
  'markdownCodeBlock',
  'toolView',
  'composerPill',
  'composerWidget',
  'composerCompleter',
  'artifactPreviewer',
  'workbenchPanel',
  'command',
  'settingsPanel',
  'profileRuntime',
  'action',
  'slot',
] as const satisfies readonly (keyof PluginUiRegistry)[]

type _AssertAllPluginUiMethodsListed =
  Exclude<keyof PluginUiRegistry, (typeof PLUGIN_UI_METHOD_NAMES)[number]> extends never
    ? true
    : never
const _assertAllPluginUiMethodsListed: _AssertAllPluginUiMethodsListed = true
void _assertAllPluginUiMethodsListed

/** Host reserved in-conversation slash command triggers (plugin command.slash must not occupy them). */
export const RESERVED_SLASH_COMMANDS = ['new', 'clear', 'compact'] as const

/** Single source of truth of runtime symbols exported by @helmx/plugin-client for plugin client.tsx. */
export const PLUGIN_CLIENT_SHARED_EXPORTS = [
  'usePluginContext',
  'usePluginLocale',
  'usePluginTranslator',
  'usePluginDoc',
  'usePluginSessionDoc',
  'useToolActivity',
  'useConversations',
  'useConversation',
  'usePlugins',
  'usePluginConfig',
  'useConversationBackground',
  'PluginSlot',
  'Switch',
  'Select',
  'MultiSelect',
  'Checkbox',
  'Tabs',
  'TabsList',
  'TabsTrigger',
  'TabsContent',
  'SegmentedControl',
  'HelmxIcon',
  'MarkdownView',
  'CodeBlockView',
  'CopyButton',
  'ViewBoundary',
  'Callout',
  'StatusLight',
  'normalizeStatusLightTone',
  'Dialog',
  'DialogPortal',
  'DialogOverlay',
  'DialogContent',
  'DialogTitle',
  'DialogDescription',
  'DialogClose',
  'DialogTrigger',
  'Screen',
  'ScreenSection',
  'DataTable',
  'KvGrid',
  'formatTime',
  'formatCompactTimestamp',
  'formatDurationMs',
  'formatBytes',
] as const
