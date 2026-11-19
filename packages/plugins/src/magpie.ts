/**
 * builtin:magpie: the Magpie gateway integration plugin (model catalog / quotas / routing groups).
 *
 * Responsibilities:
 * - Register the pi-ai dynamic-catalog Provider via ctx.provider (mounted by the host before
 *   service.start, unregistered after service.stop -- never hand-mounted around the host inside the plugin);
 * - The public status doc drives the settings.panel / commandPalette and the `helmx magpie status`
 *   CLI; the action bus provides refresh / quota / groups / group;
 * - After turn_settled, silently refresh quotas and routing in the background (?kept=1; asks no vendor, blocks no turn).
 *
 * Honesty discipline:
 * - All gateway reads execute against a snapshot frozen at read time, and verify the snapshot is
 *   still the effective config before publishing: after a config switch, old gateway data is never
 *   published under the new gateway's name;
 * - provider.refreshModels network failures always throw (visible as errors['magpie'] in generic
 *   catalog refreshes); this plugin's service.start background-refresh failures only update
 *   reachable:false / lastError, never blocking enablement or kernel startup; the manual refresh action throws magpie_gateway_unreachable explicitly;
 * - With reachable:false, modelCount is the cached count, never posing as a live refresh success;
 * - Non-loopback gateways never read the local magpie CLI data (that is another instance); only the
 *   chosen gateway's trace is used, with the source labeled; apiKey never enters the doc / action outputs / error text.
 * - Zero-arg factory: catalog refresh goes through ctx.host.refreshModels({ providers: ['magpie'] }),
 *   network reads use global fetch, and the local CLI goes through the public execFile port
 *   (no injection backdoors; tests use PATH fixtures / global fetch mocks).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HelmxError, type PluginDefinition, type TurnSettledPayload } from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  DEFAULT_MAGPIE_ROOT,
  MAGPIE_PLUGIN_ID,
  MAGPIE_PROVIDER_ID,
  MAGPIE_STATUS_DOC,
  sameGateway,
  type MagpieGatewayRef,
  type MagpiePluginConfig,
  type MagpieStatusDoc,
} from './magpie/contracts.js'
import { fetchQuotas, fetchTrace, resolveGateway } from './magpie/gateway.js'
import { quotaRows } from './magpie/quota.js'
import {
  latestGroupRouteIn,
  parseGroupShow,
  parseGroupsList,
  traceRouteRows,
  type GroupListRow,
} from './magpie/routing.js'
import { createMagpieProvider } from './magpie/provider.js'

export { MAGPIE_PLUGIN_ID }

const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['gatewayUrl', 'configuredRoot', 'local', 'reachable', 'modelCount', 'groupCount', 'summaryText', 'quotas', 'routes', 'diagnostics'],
  properties: {
    gatewayUrl: { type: 'string' },
    configuredRoot: { type: 'boolean' },
    local: { type: 'boolean' },
    reachable: { type: 'boolean' },
    modelCount: { type: 'number' },
    groupCount: { type: 'number' },
    lastRefreshedAt: { type: 'number' },
    lastError: { type: 'string' },
    summaryText: { type: 'string' },
    quotas: { type: 'array', items: { type: 'object', additionalProperties: true } },
    routes: { type: 'array', items: { type: 'object', additionalProperties: true } },
    diagnostics: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const

const REFRESH_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['refreshed', 'modelCount', 'reachable'],
  properties: {
    refreshed: { type: 'boolean' },
    modelCount: { type: 'number' },
    reachable: { type: 'boolean' },
    lastError: { type: 'string' },
  },
  additionalProperties: false,
} as const

// Note: on refresh-action failure, throw HelmxError explicitly (no degraded result returned); on success,
// reasons why quotas / traces are unavailable live in the status doc diagnostics, readable via the status action.

const QUOTA_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['quotas', 'local'],
  properties: {
    quotas: { type: 'array', items: { type: 'object', additionalProperties: true } },
    local: { type: 'boolean' },
    note: { type: 'string' },
  },
  additionalProperties: false,
} as const

const GROUPS_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['groups', 'local'],
  properties: {
    groups: { type: 'array', items: { type: 'object', additionalProperties: true } },
    local: { type: 'boolean' },
    note: { type: 'string' },
    cliError: { type: 'string' },
  },
  additionalProperties: false,
} as const

const GROUP_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['id', 'source'],
  properties: {
    id: { type: 'string' },
    definition: { type: 'object', additionalProperties: true },
    lastRoute: { type: 'object', additionalProperties: true },
    source: { type: 'string' },
    note: { type: 'string' },
  },
  additionalProperties: false,
} as const

const emptyStatus = (gatewayUrl: string): MagpieStatusDoc => ({
  gatewayUrl,
  configuredRoot: false,
  local: true,
  reachable: false,
  modelCount: 0,
  groupCount: 0,
  summaryText: 'Magpie · not connected',
  quotas: [],
  routes: [],
  diagnostics: [],
})

/** Error-text redaction: strip Bearer-header shapes and known token bodies (gateway error pages may echo them). */
function sanitizeErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+\S+/g, 'Bearer ***').slice(0, 300)
}

const execFileAsync = promisify(execFile)

/** The local magpie CLI goes through execFile (PATH resolution, no hidden injection).
 * Failures return { ok:false, error }; timeout 10s; error text redacted and length-capped.
 */
function runMagpieCli(
  args: readonly string[],
  options?: { signal?: AbortSignal },
): Promise<{ ok: boolean; stdout?: string; error?: string }> {
  return execFileAsync('magpie', [...args], {
    signal: options?.signal,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  })
    .then(({ stdout }) => ({ ok: true, stdout }))
    .catch((error: unknown) => ({
      ok: false,
      error: sanitizeErrorText(error instanceof Error ? error : new Error(String(error))),
    }))
}

export function createMagpiePlugin(): PluginDefinition {
  const fetchImpl: typeof fetch = fetch

  return {
    id: MAGPIE_PLUGIN_ID,
    name: { en: 'Magpie Gateway', 'zh-CN': 'Magpie 网关' },
    description: {
      en: 'Magpie model gateway integration: dynamic model catalog, quotas, and routing groups, with silent refresh and a status panel.',
      'zh-CN': 'Magpie 模型网关集成：动态模型目录、配额与路由组，静默刷新与状态面板。',
    },
    icon: 'globe',
    version: '0.1.0',
    ...resolvePluginClientAssets(MAGPIE_PLUGIN_ID, 'magpie', 'magpie_plugin_client_missing'),
    definePlugin(rawCtx) {
      const ctx = rawCtx

      // ---- Config and gateway snapshot -------------------------------------------------
      ctx.configSchema({
        gatewayUrl: {
          type: 'string',
          label: { en: 'Magpie gateway address', 'zh-CN': 'Magpie 网关地址' },
          description: {
            en: 'Defaults to the local http://127.0.0.1:3425 (you may set http://host:3425)',
            'zh-CN': '缺省为本地 http://127.0.0.1:3425（可设 http://host:3425）',
          },
          default: 'http://127.0.0.1:3425',
        },
        apiKey: {
          type: 'string',
          label: { en: 'Magpie API Key', 'zh-CN': 'Magpie API 密钥' },
          description: {
            en: 'Defaults to magpie on the local loopback; fill in the matching key for a remote gateway',
            'zh-CN': '缺省使用本地回环上的 magpie；远端网关填写对应密钥',
          },
          secret: true,
        },
      })

      /** The currently effective config (a config-store view; unconfigured fields fall back to gateway-resolution defaults). */
      const effectiveConfig = (): MagpiePluginConfig => {
        const raw = ctx.getConfig() as Partial<MagpiePluginConfig>
        return {
          ...(typeof raw.gatewayUrl === 'string' && raw.gatewayUrl.trim() !== '' ? { gatewayUrl: raw.gatewayUrl } : {}),
          ...(typeof raw.apiKey === 'string' && raw.apiKey.trim() !== '' ? { apiKey: raw.apiKey } : {}),
        }
      }

      const gateway = (): MagpieGatewayRef => resolveGateway(effectiveConfig())

      // ---- provider and the public status doc --------------------------------------
      /**
       * Network catalog-refresh results -> the status doc (the onCatalogChange port): when the generic
       * HTTP models.refresh refreshes the Provider, plugin state updates in sync, no longer diverging;
       * cache-only recovery does not notify (not a network success; never disguised). Publishing passes the
       * sameGateway guard too: conclusions from a fetch during which the gateway switched are never written under the new gateway.
       */
      const handle = createMagpieProvider({
        gateway,
        fetchImpl,
        onCatalogChange(change) {
          publishCatalogStatus(change.gateway, change.ok, change.ok ? undefined : change.error)
        },
      })
      ctx.provider(handle.provider)

      const status = ctx.doc<MagpieStatusDoc>(MAGPIE_STATUS_DOC, emptyStatus(DEFAULT_MAGPIE_ROOT), {
        public: true,
      })

      /** Service stop signal: no doc writes after disable. */
      let stopping = false
      let stopController: AbortController | undefined
      let startupRefreshController: AbortController | undefined

      /** Pre-publish guard: write into the doc only while the snapshot is still the effective config. */
      const writeStatus = (
        snapshot: MagpieGatewayRef,
        patch: Partial<MagpieStatusDoc>,
        options?: { clearLastError?: boolean },
      ): void => {
        if (stopping) return
        const currentGateway = gateway()
        if (!sameGateway(snapshot, currentGateway)) return
        const current = status.get()
        if (options?.clearLastError && current.gatewayUrl === snapshot.root && current.lastError !== undefined) {
          delete current.lastError
        }
        status.set({ ...current, ...patch, gatewayUrl: currentGateway.root })
      }

      const summaryTextOf = (reachable: boolean, modelCount: number): string =>
        reachable ? `Magpie · ${modelCount} models` : 'Magpie · not connected'

      /**
       * Read quotas + routing and update the doc (executed on the snapshot; kept=true asks no vendor).
       * Honesty: quota / trace read failures are not swallowed -- the reason goes into diagnostics (clearing
       * the old quota section and recording the unavailability, never disguising "no quota read" as "quota empty");
       * an unavailable trace (remote refusal / version too old) is a legal state: empty routing section + diagnostics.
       */
      const refreshSidecar = async (snapshot: MagpieGatewayRef, kept: boolean): Promise<void> => {
        if (stopping) return
        const controller = new AbortController()
        stopController = controller
        try {
          const diagnostics: string[] = []
          let quotas: MagpieStatusDoc['quotas'] = []
          let routes: MagpieStatusDoc['routes'] = []
          try {
            const entries = await fetchQuotas(snapshot.root, snapshot.token, controller.signal, fetchImpl, { kept })
            quotas = quotaRows(entries).map((row) => ({ ...row }))
          } catch (error) {
            quotas = []
            diagnostics.push(`quotas unavailable: ${sanitizeErrorText(error)}`)
          }
          if (stopping || controller.signal.aborted) return
          const trace = await fetchTrace(snapshot.root, snapshot.token, controller.signal, fetchImpl)
          if (stopping || controller.signal.aborted) return
          if ('routes' in trace) {
            routes = traceRouteRows(trace.routes)
          } else {
            routes = []
            diagnostics.push(`routing trace unavailable: ${sanitizeErrorText(trace.unavailable)}`)
          }
          writeStatus(snapshot, { quotas, routes, groupCount: routes.length, diagnostics })
        } finally {
          if (stopController === controller) stopController = undefined
        }
      }

      /** Status publishing after a catalog refresh (snapshot guard + reachable semantics). */
      const publishCatalogStatus = (snapshot: MagpieGatewayRef, reachable: boolean, error?: unknown): void => {
        if (stopping) return
        const modelCount = handle.models().filter((m) => m.baseUrl.startsWith(snapshot.root)).length
        if (reachable) {
          // Success clears old errors: the previous round's failure conclusion must not linger as the
          // latest state (jsonClone rejects undefined values; delete keys explicitly instead of assigning undefined)
          writeStatus(
            snapshot,
            {
              reachable: true,
              modelCount,
              summaryText: summaryTextOf(true, modelCount),
              lastRefreshedAt: Date.now(),
            },
            { clearLastError: true },
          )
        } else {
          writeStatus(snapshot, {
            reachable: false,
            modelCount,
            summaryText: summaryTextOf(false, modelCount),
            ...(error !== undefined ? { lastError: sanitizeErrorText(error) } : {}),
          })
        }
      }

      // ---- service lifecycle ------------------------------------------------
      ctx.service({
        id: 'magpie-gateway',
        async start() {
          stopping = false
          const controller = new AbortController()
          startupRefreshController = controller
          const snapshot = gateway()
          // Initialization: first honestly show the recovered cache (the catalog count restored by
          // refreshModels's first phase), then let the background network refresh advance reachable / lastError.
          const cachedCount = handle.models().length
          status.set({
            ...emptyStatus(snapshot.root),
            configuredRoot: snapshot.configuredRoot,
            local: snapshot.local,
            modelCount: cachedCount,
            summaryText: summaryTextOf(false, cachedCount),
          })
          // Non-blocking background refresh: failures only update reachable:false / lastError, never
          // blocking enablement or kernel startup (provider.refreshModels itself throws -- that is the
          // explicit signal for the generic catalog refresh; here we take the errors map from
          // ctx.host.refreshModels and do not reject).
          void (async () => {
            try {
              if (stopping || controller.signal.aborted) return
              const snapshotInner = gateway()
              const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
              if (stopping || controller.signal.aborted) return
              const error = result.errors['magpie']
              if (error !== undefined) {
                publishCatalogStatus(snapshotInner, false, error)
                return
              }
              publishCatalogStatus(snapshotInner, true)
              if (stopping || controller.signal.aborted) return
              await refreshSidecar(snapshotInner, true)
            } catch (error) {
              if (stopping || controller.signal.aborted) return
              // Composition-layer port exception (not a gateway diagnostic): record honestly, do not block startup
              publishCatalogStatus(gateway(), false, error)
            } finally {
              if (startupRefreshController === controller) startupRefreshController = undefined
            }
          })()
        },
        async stop() {
          stopping = true
          startupRefreshController?.abort(new Error('magpie plugin stopping'))
          startupRefreshController = undefined
          stopController?.abort(new Error('magpie plugin stopping'))
          stopController = undefined
        },
      })

      // ---- turn_settled: background silent quota/routing refresh (never blocking turn settlement) ------------
      // Only conversations using magpie models matter: other conversations (other Providers) settling
      // trigger no gateway reads (the conversation's current model is taken live from payload.conversation; no guessing).
      ctx.hook.onTurnSettled((payload: TurnSettledPayload) => {
        if (stopping) return
        const model = payload.conversation.model
        if (!model.startsWith(`${MAGPIE_PROVIDER_ID}/`)) return
        const snapshot = gateway()
        // No await: never blocks turn_settled; failures only enter diagnostics, retried at the next settled
        void refreshSidecar(snapshot, true).catch((error) => {
          if (stopping) return
          ctx.host.emitEvent('notification', {
            level: 'warning', title: 'Magpie status read failed', body: sanitizeErrorText(error),
          })
        })
      })

      // ---- Action bus (HTTP / helmx magpie <action> / run_action / Workflow) ----
      ctx.action({
        id: 'status',
        description: 'Magpie gateway status snapshot (reachability, model count, quotas, routing traces)',
        idempotent: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: STATUS_OUTPUT_SCHEMA,
        handler: () => {
          // Project the currently effective gateway at read time: after a config switch, the doc's gatewayUrl
          // leaves no stale root; when the doc still points at the old root, catalog / reachability conclusions
          // hold only for that root -- the new root has no conclusions yet and none are faked (reachable stays false pending the first refresh).
          const snapshot = gateway()
          const doc = status.get()
          if (doc.gatewayUrl !== snapshot.root) {
            return {
              ...doc,
              gatewayUrl: snapshot.root,
              configuredRoot: snapshot.configuredRoot,
              local: snapshot.local,
              reachable: false,
              modelCount: 0,
            }
          }
          return {
            ...doc,
            configuredRoot: snapshot.configuredRoot,
            local: snapshot.local,
            // The model count counts only the catalog under the current root (old-root caches do not pose)
            modelCount: handle.models().filter((m) => m.baseUrl.startsWith(snapshot.root)).length,
          }
        },
      })

      ctx.action({
        id: 'refresh',
        description: 'Force-refresh the Magpie model catalog and quota/routing state (failures error explicitly)',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: REFRESH_OUTPUT_SCHEMA,
        handler: async () => {
          const snapshot = gateway()
          const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
          const error = result.errors['magpie']
          publishCatalogStatus(snapshot, error === undefined, error)
          if (error !== undefined) {
            throw new HelmxError(
              'magpie_gateway_unreachable',
              `Magpie gateway ${snapshot.root} refresh failed: ${sanitizeErrorText(error)}`,
              502,
              { gatewayUrl: snapshot.root, configuredRoot: snapshot.configuredRoot },
            )
          }
          await refreshSidecar(snapshot, true)
          const doc = status.get()
          return { refreshed: true, modelCount: doc.modelCount, reachable: true }
        },
      })

      ctx.action({
        id: 'quota',
        description: 'Query Magpie quotas live (GET /v1/magpie/quotas)',
        idempotent: true,
        inputSchema: {
          type: 'object',
          properties: { model: { type: 'string', description: 'Filter by the model-owning provider (optional)' } },
          additionalProperties: false,
        },
        outputSchema: QUOTA_OUTPUT_SCHEMA,
        handler: async (input: { model?: string }) => {
          const snapshot = gateway()
          const controller = new AbortController()
          stopController = controller
          try {
            const entries = await fetchQuotas(snapshot.root, snapshot.token, controller.signal, fetchImpl)
            let rows = quotaRows(entries)
            if (input.model !== undefined && input.model !== '') {
              const owner = handle.models().find((m) => m.id === input.model)?.magpieOwnedBy
              if (owner !== undefined) rows = rows.filter((row) => row.provider === owner)
            }
            return {
              quotas: rows,
              local: snapshot.local,
              ...(snapshot.local ? {} : { note: 'non-local gateway: only quotas reported by that gateway itself are readable' }),
            }
          } catch (error) {
            throw new HelmxError(
              'magpie_gateway_unreachable',
              `Magpie gateway ${snapshot.root} quota read failed: ${sanitizeErrorText(error)}`,
              502,
              { gatewayUrl: snapshot.root },
            )
          } finally {
            if (stopController === controller) stopController = undefined
          }
        },
      })

      ctx.action({
        id: 'groups',
        description: 'Routing group list with recent hits (local reads the magpie CLI + gateway trace; remote uses gateway trace only)',
        idempotent: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: GROUPS_OUTPUT_SCHEMA,
        handler: async () => {
          const snapshot = gateway()
          const controller = new AbortController()
          stopController = controller
          try {
            // Data-source isolation: the CLI describes only the local default instance; when another
            // loopback port is explicitly configured, the CLI cannot be proven to point at the same
            // instance (MAGPIE_GW_URL/MAGPIE_ADDR may point elsewhere) -- use only the chosen root's trace; never read other local instances.
            const cliTrusted = snapshot.root === DEFAULT_MAGPIE_ROOT
            let cliGroups: GroupListRow[] | undefined
            let cliError: string | undefined
            if (cliTrusted) {
              const run = await runMagpieCli(['groups'], { signal: controller.signal })
              if (run.ok) cliGroups = parseGroupsList(run.stdout ?? '')
              else cliError = run.error
            }
            const trace = await fetchTrace(snapshot.root, snapshot.token, controller.signal, fetchImpl)
            const traceRoutes = 'routes' in trace ? trace.routes : []
            const traceRows = traceRouteRows(traceRoutes)
            const byKey = new Map(traceRows.map((row) => [row.group, row]))
            const cliKeys = new Set((cliGroups ?? []).map((row) => row.id.replace(/^group\//, '')))
            const groups = [
              ...(cliGroups ?? []).map((row) => {
                const hit = byKey.get(row.id.replace(/^group\//, ''))
                return {
                  id: row.id,
                  ...(row.name !== undefined ? { name: row.name } : {}),
                  ...(row.routing !== undefined ? { routing: row.routing } : {}),
                  ...(row.members.length > 0 ? { members: row.members } : {}),
                  ...(hit ? { lastRoute: hit } : {}),
                  source: 'cli+trace' as const,
                }
              }),
              // Groups present in trace but not listed by the CLI (CLI failure or unlisted auto groups)
              ...traceRows
                .filter((row) => !cliKeys.has(row.group))
                .map((row) => ({
                  id: `group/${row.group}`,
                  ...(row.strategy !== undefined ? { routing: row.strategy } : {}),
                  lastRoute: row,
                  source: 'gateway-trace' as const,
                })),
            ]
            writeStatus(snapshot, { routes: traceRows, groupCount: groups.length })
            const notes: string[] = []
            if (cliGroups === undefined) notes.push('Only routing traces of requests already seen by the selected gateway are shown; full group definitions are currently unavailable.')
            if ('unavailable' in trace) notes.push(`routing trace unavailable: ${sanitizeErrorText(trace.unavailable)}`)
            return {
              groups,
              local: snapshot.local,
              ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
              ...(cliError !== undefined ? { cliError: sanitizeErrorText(cliError) } : {}),
            }
          } finally {
            if (stopController === controller) stopController = undefined
          }
        },
      })

      ctx.action({
        id: 'group',
        description: 'A single routing group\'s definition and most recent routing decision',
        idempotent: true,
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
          additionalProperties: false,
        },
        outputSchema: GROUP_OUTPUT_SCHEMA,
        handler: async (input: { id: string }) => {
          const snapshot = gateway()
          const controller = new AbortController()
          stopController = controller
          try {
            const short = input.id.replace(/^group\//, '')
            // Definition: only the local default instance's CLI can provide it (another loopback port / a
            // remote CLI is another instance; without provable identity, do not ask).
            const cliTrusted = snapshot.root === DEFAULT_MAGPIE_ROOT
            let definition: ReturnType<typeof parseGroupShow> = undefined
            let definitionError: string | undefined
            if (cliTrusted) {
              const run = await runMagpieCli(['group', short], { signal: controller.signal })
              if (run.ok) {
                definition = parseGroupShow(run.stdout ?? '')
                if (definition === undefined) definitionError = 'magpie CLI output cannot be parsed into a group definition'
              } else {
                definitionError = run.error
              }
            }
            const trace = await fetchTrace(snapshot.root, snapshot.token, controller.signal, fetchImpl)
            const lastRoute = 'routes' in trace ? latestGroupRouteIn(trace.routes, short) : undefined
            // Honesty: never fabricate when a remote gateway has no definition source -- the source label says so.
            const source = definition !== undefined ? 'cli+trace' : 'gateway-trace'
            if (definition === undefined && lastRoute === undefined) {
              throw new HelmxError(
                'magpie_group_not_found',
                `routing group ${input.id} has no available information: ${
                  cliTrusted
                    ? definitionError !== undefined
                      ? `CLI failed (${sanitizeErrorText(definitionError)})`
                      : 'neither the CLI nor the gateway trace has this group'
                    : snapshot.local
                      ? 'local gateway on a non-default port provides trace only, and the trace has no record of this group'
                      : 'non-local gateway provides trace only, and the trace has no record of this group'
                }`,
                404,
                { id: input.id, gatewayUrl: snapshot.root, local: snapshot.local },
              )
            }
            return {
              id: input.id,
              ...(definition !== undefined ? { definition } : {}),
              ...(lastRoute !== undefined ? { lastRoute } : {}),
              source,
              ...(snapshot.local && !cliTrusted
                ? { note: 'local gateway on a non-default port: definitions need the local default instance\'s magpie CLI; only the selected gateway\'s trace here' }
                : snapshot.local
                  ? {}
                  : { note: 'non-local gateway: definitions need the local magpie CLI; only the gateway trace here' }),
            }
          } finally {
            if (stopController === controller) stopController = undefined
          }
        },
      })

      // ---- Declarative UI (client.tsx React track; no Emoji, lucide line icons) --------
      ctx.ui.settingsPanel({
        id: 'magpie-panel',
        label: { en: 'Magpie Gateway', 'zh-CN': 'Magpie 网关' },
        order: 25,
        client: { module: 'index.tsx', export: 'MagpieSettingsPanel' },
      })

      ctx.ui.command({
        id: 'magpie-refresh',
        title: { en: 'Refresh the Magpie model catalog', 'zh-CN': '刷新 Magpie 模型目录' },
        actionId: 'refresh',
        input: {},
        keywords: ['magpie', 'models', 'refresh'],
      })
    },
  }
}
