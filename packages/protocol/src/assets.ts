/**
 * Pure-file static cognitive asset contracts (profiles / skills / providers).
 * Storage and hot-reload mechanics live in the kernel; only the cross-runtime shared data shapes are defined here.
 */

/** Static starter prompt for an empty conversation; clicking only fills the draft, never submits directly. */
export interface ProfileStarterPrompt {
  /** Display title; at most 24 Unicode code points after trimming. */
  label: string
  /** Kept verbatim; non-whitespace-only; at most 4000 Unicode code points. */
  prompt: string
}

export const PROFILE_STARTERS_MAX_ITEMS = 6
export const PROFILE_STARTER_LABEL_MAX_LENGTH = 24
export const PROFILE_STARTER_PROMPT_MAX_LENGTH = 4000

/**
 * Conversation Profile: `~/.helm/profiles/<id>/profile.json` + SYSTEM.md.
 * MEMORY.md long-term memory is self-managed by the builtin:memory plugin (not part
 * of the Profile contract). `runtime` is the protocol-layer config shape (e.g.
 * binding a Herdr CLI); the actual driving lives in builtin:herdr.
 */
export interface Profile {
  id: string
  name?: string
  /** The Profile's system prompt and memory are file-carried; detail endpoints (GET/POST/PUT) attach the full text, and it is stripped when profile.json is persisted. */
  model?: string
  /** Profile-level thinking level (off/minimal/low/medium/high/xhigh/max); follows the global default when unset. */
  thinkingLevel?: string
  /** Compute node ID the Profile binds to by default (defaults to 'local'). */
  nodeId?: string
  /** Default working directory of the Profile. */
  cwd?: string
  /** External execution config when invoked as a subagent / workflow node; durable conversations are still carried by pi-durable. */
  runtime?: ProfileRuntime
  tags?: string[]
  /** Loadable skill allowlist; defaults to all available skills, an empty array disables all. A disabled plugin's managed skills are always unavailable. */
  skills?: string[]
  /** Plugin ID that bootstrapped or manages this Profile (the frontend may hide it when that plugin is not enabled). */
  managedByPlugin?: string
  /** Whether humans can select this Profile in the "new conversation" dropdown; resident singleton roles set false; defaults to true. */
  humanSelectable?: boolean
  /** At most six items; defaults or an empty array use the host's empty-conversation prompts. */
  starters?: ProfileStarterPrompt[]
  /** Full SYSTEM.md text (read/written by detail endpoints; never written into profile.json). */
  system?: string
}

/** External agent runtime config bound to a Profile (e.g. 'herdr', driven by the corresponding plugin). */
export interface ProfileRuntime {
  kind: string
  /** External CLI agent identifier, e.g. 'agy' | 'claude' | 'codex' | 'pi'. */
  agent: string
  args?: string[]
  /** Target compute node identifier (defaults to local 'local'). */
  nodeId?: string
  /** Conversation working directory (absolute path); decided by the runtime when absent. */
  workspace?: string
  /** Environment variable overrides injected into the subprocess. */
  env?: Record<string, string>
}

/** Skill catalog summary: dataDir root `~/.helm/skills/<id>/` (SKILL.md + references/*.md), or machine-level shared source `~/.agents/skills/<id>/` (source='agents'; marks the discovery source, not a filesystem write permission). */
export interface SkillSummary {
  id: string
  name: string
  description?: string
  /** Relative paths of sub-files that support on-demand reading (e.g. 'references/xxx.md'). */
  references: string[]
  /** Plugin ID managing this skill; when that plugin is not enabled, the conversation catalog, skill menu and load_skill are all unavailable. */
  managedByPlugin?: string
  /** Source root marker: default 'data' (~/.helm/skills); 'agents' marks the machine-level shared source ~/.agents/skills (the pi ecosystem skill library); only marks the scan source, not a filesystem permission boundary. */
  source?: 'data' | 'agents'
}

/** Availability rule shared by the conversation skill catalog and load_skill; not a filesystem or tool-execution permission boundary. */
export function isSkillAvailable(
  skill: SkillSummary,
  profile: Pick<Profile, 'skills'>,
  enabledPluginIds: ReadonlySet<string>,
): boolean {
  return (skill.managedByPlugin === undefined || enabledPluginIds.has(skill.managedByPlugin)) &&
    (profile.skills === undefined || profile.skills.includes(skill.id))
}

/** Public model catalog entry of `GET /api/models`. */
export interface ModelCatalogEntry {
  provider: string
  modelId: string
  available: boolean
  /** Real known model context window (tokens); omitted when unknown. */
  contextWindow?: number
  /** User explicitly disabled this model (catalog annotation; available still reflects credential usability — the two are independent). */
  disabled?: boolean
}

/** Full catalog of `GET /api/models`: model list + per-model thinking levels (off/minimal/low/medium/high/xhigh/max). */
export interface ModelCatalog {
  models: ModelCatalogEntry[]
  /** provider/modelId -> supported thinking levels (defaults to off only). */
  thinkingLevels: Record<string, string[]>
  /** Global default model (config.json.model / startup argument; omitted when unset). */
  defaultModel?: string
  /** Global default thinking level (config.json.thinkingLevel; omitted when unset). */
  defaultThinkingLevel?: string
  /** Per-model thinking defaults keyed by full `'provider/modelId'` reference (config.json.modelThinkingLevels; omitted when empty). */
  modelThinkingLevels?: Record<string, string>
  /** Global compaction model (config.json.compactionModel; omitted when unset). */
  defaultCompactionModel?: string
  /** Global compaction thinking level (config.json.compactionThinkingLevel; omitted when unset). */
  defaultCompactionThinkingLevel?: string
}

/** Public catalog of PI built-in providers, plugin dynamic providers and enabled custom gateways; contains no credentials or private request headers. */
export interface ModelProviderSummary {
  id: string
  name: string
  modelCount: number
  authMethods: Array<{ type: 'api_key' | 'oauth'; label: string }>
  /** Whether remote dynamic catalog refresh is supported (providers implementing refreshModels). */
  dynamic?: boolean
  /** The provider's public gateway root URL or baseUrl (non-secret display). */
  baseUrl?: string
  /** Plugin ID that registered this provider (auto-filled by the kernel; absent for non-plugin providers). */
  pluginId?: string
}

/** Result of `POST /api/models/refresh` dynamic model catalog refresh. */
export interface ModelProvidersRefreshResult {
  /** Target provider IDs refreshed by this request (an empty array means all configured dynamic providers). */
  providers: string[]
  /** Whether the refresh was aborted midway. */
  aborted: boolean
  /** Per dynamic provider refresh errors (providerId -> error message). */
  errors: Record<string, string>
  /** Latest model catalog after the refresh. */
  models: ModelCatalogEntry[]
  /** Latest provider catalog summary after the refresh. */
  providerCatalog: ModelProviderSummary[]
}

/** `PUT /api/models/filter` request body: per-provider set of explicitly disabled model IDs (empty array = clear all disabled entries for that provider; provider omitted = clear all). */
export interface SetModelFilterBody {
  provider?: string
  disabledModels: string[]
}

/** `PUT /api/models/filter` response: the full updated model catalog. */
export interface SetModelFilterResult {
  catalog: ModelCatalog
}

/**
 * `~/.helm/providers.json` custom model gateway entry.
 * Must never contain secret fields — API keys always live in credentials.json (mode 0600).
 */
export interface ProviderConfig {
  id: string
  /** OpenAI / Anthropic compatible protocol type. */
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  /** Model IDs available under this gateway. */
  models: string[]
  /** Display name (non-secret). */
  label?: string
  /** Whether enabled. */
  enabled: boolean
}
