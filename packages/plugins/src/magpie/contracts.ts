/**
 * builtin:magpie shared contracts: constants, dependency ports, and the public status-doc shape.
 *
 * Design essentials (honesty discipline in practice):
 * - Gateway config snapshot (MagpieGatewayRef): all model-catalog / quota / routing reads execute
 *   against the "root+token frozen at read time", verifying before publishing that the snapshot is
 *   still the effective config; after a config switch, the old gateway's caches or request results
 *   are never published under the new gateway's name;
 * - provider.refreshModels network failures always throw (never swallowed): the generic catalog
 *   refresh (models.refresh / POST /api/models/refresh) must surface magpie failures explicitly in
 *   errors -- never popping a "refresh succeeded" because a provider swallowed the error;
 */

export const MAGPIE_PLUGIN_ID = 'builtin:magpie'

/** The pi-ai Provider id (the model-id prefix namespace). */
export const MAGPIE_PROVIDER_ID = 'magpie'

/** The local Magpie gateway's default root address. */
export const DEFAULT_MAGPIE_ROOT = 'http://127.0.0.1:3425'

/** The local loopback gateway's default token (loopback accepts any token). */
export const DEFAULT_MAGPIE_TOKEN = 'magpie'

/** Magpie's own environment variable: the gateway root address (MAGPIE_ADDR second). */
export const MAGPIE_ROOT_ENV = 'MAGPIE_GW_URL'
export const MAGPIE_ADDR_ENV = 'MAGPIE_ADDR'

/** The plugin config (the effective view after merging config.json + credentials.json secret). */
export interface MagpiePluginConfig {
  gatewayUrl?: string
  apiKey?: string
}

/**
 * The gateway config snapshot frozen at read time. Once taken, this round's data reads and
 * publishing all happen on it; before publishing, confirm the snapshot is still the effective
 */
export interface MagpieGatewayRef {
  /** The normalized gateway root address (no trailing slash, no trailing /v1). */
  root: string
  /** The Bearer token; loopback defaults to 'magpie'. */
  token: string
  /** Whether the user explicitly configured a non-default address (vs. the default loopback fallback). */
  configuredRoot: boolean
  /** Whether the root is the local loopback (decides CLI data-source and quota-read semantics). */
  local: boolean
}

/** Same-snapshot check: a change of either root or token counts as a config switch. */
export function sameGateway(a: MagpieGatewayRef, b: MagpieGatewayRef): boolean {
  return a.root === b.root && a.token === b.token
}

// ---------------------------------------------------------------------------
// Public status doc (shared by composer.pill / settings.panel / the helm magpie status CLI)
// ---------------------------------------------------------------------------

/** One quota display row (one row per window of each subscription/plan/key). remainingPercent -1 means unknown. */
interface MagpieStatusQuota {
  provider: string
  account?: string
  remainingPercent: number
  resetText?: string
  windowLabel?: string
}

/** One routing group's recent-hit trace row. */
interface MagpieStatusRoute {
  group: string
  strategy?: string
  provider?: string
  model?: string
  timestamp?: string
}

export interface MagpieStatusDoc {
  gatewayUrl: string
  /** Whether explicitly configured by the user rather than the default loopback address. */
  configuredRoot: boolean
  local: boolean
  /** Whether the most recent network catalog refresh succeeded; when false, modelCount is a cached count, not a live result. */
  reachable: boolean
  modelCount: number
  groupCount: number
  /** The most recent successful network refresh time; advances only on success. */
  lastRefreshedAt?: number
  /** The most recent failure reason (redacted: no token). */
  lastError?: string
  /** For composer.pill and settings.panel to bind and display directly (no Emoji). */
  summaryText: string
  quotas: MagpieStatusQuota[]
  routes: MagpieStatusRoute[]
  /** Business-side diagnostics (redacted): reasons quotas / routing traces are unavailable etc.; an empty array means none. */
  diagnostics: string[]
}

/** The public status doc name. */
export const MAGPIE_STATUS_DOC = 'status'

// ---------------------------------------------------------------------------
// ctx.provider contract
// ---------------------------------------------------------------------------

// The real host (@helm/protocol HelmPluginContext) ships ctx.provider registration natively;
// ctx.host.refreshModels is the host's generic catalog-refresh port (delivered by kernel-host).
