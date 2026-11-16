/**
 * builtin:apps: the app center and full-stack app workshop (enabled by default, non-locked and disableable).
 *
 * Responsibilities (mechanism vs policy: the kernel provides the PluginHost managed-package mechanism;
 * this plugin carries the product-layer app catalog and lifecycle orchestration):
 * - The public persistent doc catalog (AppsCatalogDoc): app-level product metadata (icon/category/
 *   pinned/workspaceDir/originConversationId/timestamps) that PluginSummary does not carry;
 * - 5 ctx.actions: validate / publish / list / update_meta / remove, auto-mapped to the `helm
 *   apps ...` CLI, HTTP, Agent Tool, Workflow, and Web -- five ends;
 * - The left-sidebar "App Center" entry + the fullscreen screen `center` (client components come
 *   from the host-port branch; this file only declares the registration structure, with a placeholder client module kept for compilation);
 * - The managed skill app-builder (SKILL.md + fullstack-template references), entering/leaving the
 *   skill catalog with the plugin via ctx.host.skills.ensureSkill.
 *
 * Honesty discipline:
 * - validate/publish relies on the host plugins.doctor's real four-phase self-check (manifest/backend/
 *   register/client), maintaining no second approximate validation; additionally enforcing "at least one
 *   ctx.ui.screen" (a hard requirement of full-stack apps; a miss is reported honestly as a missing_app_screen failure item);
 * - The host port (HelmHostApi.plugins) comes from the protocol-host branch; on this branch it is
 *   accessed via local compatibility types + an explicit 501 when missing -- never silently degrading or faking install success;
 * - Remote-node conversations + relative paths explicitly fail 400 app_source_must_be_on_hub (PluginHost
 *   and PackageManager run on the Hub host and only work on the local node's filesystem);
 * - Disabling this plugin does not affect published apps (they are independent managed external plugins whose lifecycle belongs to PluginHost).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HelmError,
  type HelmHostApi,
  type PluginDefinition,
  type PluginDoctorReport,
  type PluginSummary,
} from '@helm/protocol'
import { resolvePluginClientRoot } from './asset-paths.js'

export const APPS_PLUGIN_ID = 'builtin:apps'
export const APPS_SCREEN_ID = 'center'
export const APP_BUILDER_SKILL_ID = 'app-builder'

// ---------------------------------------------------------------------------
// Catalog data contract (public persistent doc)
// ---------------------------------------------------------------------------

export type AppCategory = 'productivity' | 'devops' | 'data' | 'finance' | 'automation' | 'other'

export const APP_CATEGORIES: readonly AppCategory[] = [
  'productivity',
  'devops',
  'data',
  'finance',
  'automation',
  'other',
]

export interface AppCatalogEntry {
  /** The pluginId of the corresponding managed plugin. */
  pluginId: string
  /** App display icon (a lucide icon name, default 'layout-grid'). */
  icon: string
  /** Business category tag. */
  category: AppCategory
  /** Whether pinned as a favorite in the app center. */
  pinned: boolean
  /** Absolute workspace source path where the app was developed (for later AI edits + direct publish hot updates). */
  workspaceDir?: string
  /** The conversation ID that first generated or most recently iterated the app (for one-click jump back to iterate). */
  originConversationId?: number
  /** First publish timestamp (epoch ms). */
  publishedAt: number
  /** Most recent publish/update timestamp (epoch ms). */
  updatedAt: number
}

export interface AppsCatalogDoc {
  apps: Record<string, AppCatalogEntry>
}

export const EMPTY_APPS_CATALOG: AppsCatalogDoc = { apps: {} }

const CATALOG_DOC = 'catalog'

// ---------------------------------------------------------------------------
// Asset directory resolution (client / skill)
// ---------------------------------------------------------------------------

function readSkillAssets(): { skillMd: string; references: Record<string, string> } {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'apps', 'skill')
  const dir = existsSync(local)
    ? local
    : join(dirname(here), 'src', 'apps', 'skill')
  if (!existsSync(dir)) {
    throw new HelmError('apps_skill_missing', `built-in plugin ${APPS_PLUGIN_ID} cannot find its skill asset directory`, 500)
  }
  return {
    skillMd: readFileSync(join(dir, 'SKILL.md'), 'utf-8'),
    references: {
      'fullstack-template.md': readFileSync(join(dir, 'references', 'fullstack-template.md'), 'utf-8'),
    },
  }
}

// ---------------------------------------------------------------------------
// Path and input validation
// ---------------------------------------------------------------------------

/**
 * Resolve a validate/publish dir input into a Hub-local absolute path.
 * Relative paths resolve against the calling conversation's bound cwd (Hub cwd by default); a conversation
 * bound to a remote node explicitly fails 400 (PluginHost/PackageManager only work on the Hub host's filesystem).
 */
function resolveAppSourceDir(
  dir: string,
  context: { conversationId?: number },
  deps: { getConversation(id: number): { nodeId?: string; cwd: string }; hubCwd: string },
): string {
  if (dir.includes('\0')) {
    throw new HelmError('validation_error', 'app directory path contains illegal characters', 400, { dir })
  }
  let baseCwd = deps.hubCwd
  if (!isAbsolute(dir) && context.conversationId !== undefined) {
    const conv = deps.getConversation(context.conversationId)
    const nodeId = conv.nodeId ?? 'local'
    if (nodeId !== 'local') {
      throw new HelmError(
        'app_source_must_be_on_hub',
        `The conversation is bound to remote node ${nodeId}; the app source directory must live on the Hub's local (local-node) filesystem; provide a Hub-local absolute path, or use a Git/npm source instead`,
        400,
        { conversationId: context.conversationId, nodeId, dir },
      )
    }
    baseCwd = conv.cwd
  }
  const resolved = resolvePath(baseCwd, dir)
  if (!isAbsolute(resolved)) {
    throw new HelmError('validation_error', `app directory cannot be resolved to an absolute path: ${dir}`, 400, { dir, resolved })
  }
  return resolved
}

function assertNotSelfTarget(pluginId: string): void {
  if (pluginId === APPS_PLUGIN_ID) {
    throw new HelmError(
      'app_target_is_self',
      `This operation is not allowed on ${APPS_PLUGIN_ID} itself (the app center is not a publishable app)`,
      409,
      { pluginId },
    )
  }
  if (pluginId.startsWith('builtin:')) {
    throw new HelmError(
      'app_target_is_builtin',
      `built-in plugin ${pluginId} is not a full-stack app managed by the app center (only external managed plugins are operable)`,
      409,
      { pluginId },
    )
  }
}

function assertCategory(value: string): AppCategory {
  if (!(APP_CATEGORIES as readonly string[]).includes(value)) {
    throw new HelmError(
      'validation_error',
      `invalid app category: ${value} (allowed: ${APP_CATEGORIES.join(' | ')})`,
      400,
      { category: value, allowed: APP_CATEGORIES },
    )
  }
  return value as AppCategory
}

// ---------------------------------------------------------------------------
// Shared by validate / publish: doctor + screen checks
// ---------------------------------------------------------------------------

interface AppValidateResult {
  ok: boolean
  pluginId?: string
  dir: string
  checks: PluginDoctorReport['checks']
  screenIds: string[]
  /** Screen fact source: host-doctor (captured by real temporary registration) / registered (listUi fact) / deferred (no conclusion available when diagnostics fail). */
  screenBasis: 'host-doctor' | 'registered' | 'deferred'
  summary?: string
}

/**
 * Run validate: the host doctor's real four phases + the mandatory full-stack app Screen check.
 *
 * Screen facts come from real declaration execution: prefer the screens captured during the doctor's
 * temporary host register stage; on older/custom hosts lacking the field, fall back to PluginHost
 * listUi for registered plugins. If the doctor reports success but neither place has a Screen, reject
 * as missing_app_screen -- never mark an unverified draft publishable. On doctor failure keep the original diagnostics; do not use partial registration results.
 */
async function validateAppDir(
  port: HelmHostApi['plugins'],
  dir: string,
): Promise<AppValidateResult> {
  const report = await port.doctor({ dir })
  const checks = [...report.checks]
  let screenIds: string[] = []
  let screenBasis: AppValidateResult['screenBasis'] = 'deferred'

  if (report.screens !== undefined) {
    screenIds = report.screens
    screenBasis = 'host-doctor'
  } else if (report.pluginId !== undefined && port.list().some((s) => s.id === report.pluginId)) {
    // Only use listUi as the fact source when the target is really registered (doctor also reports the id for draft directories)
    screenIds = screensOf(port, report.pluginId)
    screenBasis = 'registered'
  }

  if (screenIds.length === 0 && (screenBasis !== 'deferred' || report.ok)) {
    checks.push({
      id: 'missing_app_screen',
      label: 'Full-stack app Screen check',
      error: {
        code: 'missing_app_screen',
        message: 'the app must declare at least one ctx.ui.screen (the frontend main view of a full-stack app)',
        details: { dir, pluginId: report.pluginId, screenBasis },
      },
    })
  }

  return {
    ok: checks.every((c) => c.error === undefined),
    pluginId: report.pluginId,
    dir,
    checks,
    screenIds,
    screenBasis,
    ...(report.summary !== undefined ? { summary: report.summary.name } : {}),
  }
}

/** Collect the given plugin's screen id list from the host listUi (registered-plugin facts). */
function screensOf(port: HelmHostApi['plugins'], pluginId: string): string[] {
  return port
    .listUi()
    .filter((c) => c.pluginId === pluginId && c.surface === 'screen')
    .map((c) => (c.spec as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string')
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

/**
 * @param deps.hubCwd The Hub host cwd (the fallback resolution base for relative paths; default process.cwd()).
 * Injectable in tests; at runtime the host-port branch supplies the real init.cwd.
 */
export function createAppsPlugin(deps: { hubCwd?: string } = {}): PluginDefinition {
  const hubCwd = deps.hubCwd ?? process.cwd()
  return {
    id: APPS_PLUGIN_ID,
    name: 'App Center',
    description: 'Full-stack micro-app catalog and lifecycle: validate/publish/list/remove actions, the app center view, and the managed app-builder skill.',
    icon: 'boxes',
    version: '0.1.0',
    locked: false,
    clientRoot: resolvePluginClientRoot(APPS_PLUGIN_ID, 'apps', 'apps_plugin_client_missing'),
    definePlugin(ctx) {
      const catalog = ctx.doc<AppsCatalogDoc>(CATALOG_DOC, EMPTY_APPS_CATALOG, { public: true })

      /** Conversation-resolution dependency (read lazily via ctx.host, keeping the host-port boundary). */
      const getConversation = (id: number) => ctx.host.getConversation(id)

      // ---- validate ------------------------------------------------------
      ctx.action<{ dir: string }, AppValidateResult>({
        id: 'validate',
        description: 'Run a static precheck (doctor four phases + Screen check) on a workspace app directory; relative paths resolve against the calling conversation cwd',
        inputSchema: {
          type: 'object',
          properties: { dir: { type: 'string', minLength: 1 } },
          required: ['dir'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            pluginId: { type: 'string' },
            dir: { type: 'string' },
            checks: { type: 'array', items: { type: 'object' } },
            screenIds: { type: 'array', items: { type: 'string' } },
            screenBasis: { type: 'string', enum: ['host-doctor', 'registered', 'deferred'] },
            summary: { type: 'string' },
          },
          required: ['ok', 'dir', 'checks', 'screenIds', 'screenBasis'],
          additionalProperties: false,
        },
        cli: {
          command: ['apps', 'validate'],
          positional: [{ field: 'dir', required: true }],
        },
        idempotent: true,
        exposeAsTool: true,
        async handler(input, context) {
          const port = ctx.host.plugins
          const dir = resolveAppSourceDir(input.dir, context, { getConversation, hubCwd })
          return validateAppDir(port, dir)
        },
      })

      // ---- publish -------------------------------------------------------
      ctx.action<
        {
          dir: string
          icon?: string
          category?: AppCategory
          pinned?: boolean
          conversationId?: number
        },
        {
          pluginId: string
          mode: 'installed' | 'updated'
          screenTarget: string
          catalogEntry: AppCatalogEntry
          version: string
          enabled: boolean
        }
      >({
        id: 'publish',
        description: 'Publish (or upgrade) a workspace full-stack app: validate first, then managed-install or hot-update and enable, registering catalog metadata',
        inputSchema: {
          type: 'object',
          properties: {
            dir: { type: 'string', minLength: 1 },
            icon: { type: 'string', minLength: 1 },
            category: { type: 'string', enum: [...APP_CATEGORIES] },
            pinned: { type: 'boolean' },
            conversationId: { type: 'number', minimum: 1 },
          },
          required: ['dir'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            pluginId: { type: 'string' },
            mode: { type: 'string', enum: ['installed', 'updated'] },
            screenTarget: { type: 'string' },
            catalogEntry: { type: 'object' },
            version: { type: 'string' },
            enabled: { type: 'boolean' },
          },
          required: ['pluginId', 'mode', 'screenTarget', 'catalogEntry', 'version', 'enabled'],
          additionalProperties: false,
        },
        cli: {
          command: ['apps', 'publish'],
          positional: [{ field: 'dir', required: true }],
        },
        exposeAsTool: true,
        async handler(input, context) {
          const port = ctx.host.plugins
          const resolvedDir = resolveAppSourceDir(input.dir, context, { getConversation, hubCwd })
          const category = input.category !== undefined ? assertCategory(input.category) : undefined

          // 1. The same precheck as validate (an explicit 422 on failure, with full diagnostics)
          const validation = await validateAppDir(port, resolvedDir)
          if (!validation.ok) {
            const failed = validation.checks.filter((c) => c.error !== undefined)
            throw new HelmError(
              'app_validate_failed',
              `App precheck failed (${failed.length} failing items); publishing refused: ${failed.map((c) => `${c.label}: ${c.error!.message}`).join('; ')}`,
              422,
              { dir: resolvedDir, checks: validation.checks },
            )
          }
          const pluginId = validation.pluginId
          if (pluginId === undefined) {
            throw new HelmError(
              'app_validate_failed',
              `Precheck passed but no plugin id identified (inconsistent internal state): ${resolvedDir}`,
              500,
              { dir: resolvedDir, checks: validation.checks },
            )
          }
          assertNotSelfTarget(pluginId)

          // 2. Managed install or hot update
          const existing = port.list().find((s) => s.id === pluginId)
          const managedSource = existing?.managed?.source
          const sameSource =
            managedSource !== undefined &&
            managedSource.kind === 'local' &&
            managedSource.path === resolvedDir

          let mode: 'installed' | 'updated'
          let summary: PluginSummary
          if (existing === undefined || !sameSource) {
            const result = await port.install(resolvedDir, { enable: true })
            if (result.enableError !== undefined) {
              // Install succeeded but enable failed: report honestly (the install record is kept; enable can be retried)
              throw new HelmError(
                'app_enable_failed',
                `App ${pluginId} installed but enabling failed (install record kept; retryable): ${result.enableError.message}`,
                422,
                { pluginId, enableError: result.enableError, installId: result.record.id },
              )
            }
            mode = existing === undefined ? 'installed' : 'updated'
            summary = result.summary
          } else {
            const result = await port.update(pluginId)
            summary = result.summary
            if (!summary.enabled) {
              await port.enable(pluginId)
              const refreshed = port.list().find((s) => s.id === pluginId)
              if (refreshed !== undefined) summary = refreshed
            }
            mode = 'updated'
          }

          // 3. Screen recheck and catalog registration (facts read from the host listUi after publishing)
          const screenIds = screensOf(port, pluginId)
          if (screenIds.length === 0) {
            throw new HelmError(
              'missing_app_screen',
              `App ${pluginId} installed but no enabled Screen found (the app center cannot open it); check the ctx.ui.screen declarations and the plugin enablement state`,
              422,
              { pluginId },
            )
          }
          const now = Date.now()
          const prev = catalog.get().apps[pluginId]
          const originConversationId =
            input.conversationId ?? context.conversationId ?? prev?.originConversationId
          const entry: AppCatalogEntry = {
            pluginId,
            icon: input.icon ?? prev?.icon ?? 'layout-grid',
            category: category ?? prev?.category ?? 'other',
            pinned: input.pinned ?? prev?.pinned ?? false,
            workspaceDir: resolvedDir,
            ...(originConversationId !== undefined ? { originConversationId } : {}),
            publishedAt: prev?.publishedAt ?? now,
            updatedAt: now,
          }
          catalog.update((current) => ({ apps: { ...current.apps, [pluginId]: entry } }))
          await catalog.flush()

          return {
            pluginId,
            mode,
            screenTarget: `screen:${pluginId}/${screenIds[0]}`,
            catalogEntry: entry,
            version: summary.version ?? '',
            enabled: summary.enabled,
          }
        },
      })

      // ---- list ----------------------------------------------------------
      ctx.action<
        Record<string, never>,
        {
          apps: Array<{
            pluginId: string
            name: string
            description?: string
            version?: string
            enabled: boolean
            status?: string
            screens: string[]
            catalog?: AppCatalogEntry
          }>
        }
      >({
        id: 'list',
        description: 'Aggregate all current full-stack apps (host plugin/UI list left-joined with catalog metadata; orphan catalog entries ignored automatically)',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: {
            apps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  pluginId: { type: 'string' },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  version: { type: 'string' },
                  enabled: { type: 'boolean' },
                  status: { type: 'string' },
                  screens: { type: 'array', items: { type: 'string' } },
                  catalog: { type: 'object' },
                },
                required: ['pluginId', 'name', 'enabled', 'screens'],
                additionalProperties: false,
              },
            },
          },
          required: ['apps'],
          additionalProperties: false,
        },
        cli: { command: ['apps', 'list'] },
        idempotent: true,
        exposeAsTool: true,
        async handler() {
          const port = ctx.host.plugins
          const summaries = port.list()
          const ui = port.listUi()
          const catalogState = catalog.get()
          const apps = summaries
            .filter((s) => {
              if (s.id.startsWith('builtin:')) {
                // Built-in plugins are not mixed into the user app list (incl. this plugin's own center screen)
                return false
              }
              const screens = ui
                .filter((c) => c.pluginId === s.id && c.surface === 'screen')
                .map((c) => (c.spec as { id?: unknown }).id)
                .filter((id): id is string => typeof id === 'string')
              return screens.length > 0 || catalogState.apps[s.id] !== undefined
            })
            .map((s) => {
              const screens = ui
                .filter((c) => c.pluginId === s.id && c.surface === 'screen')
                .map((c) => (c.spec as { id?: unknown }).id)
                .filter((id): id is string => typeof id === 'string')
              const entry = catalogState.apps[s.id]
              return {
                pluginId: s.id,
                name: s.name,
                ...(s.description !== undefined ? { description: s.description } : {}),
                ...(s.version !== undefined ? { version: s.version } : {}),
                enabled: s.enabled,
                ...(s.status !== undefined ? { status: s.status } : {}),
                screens,
                ...(entry !== undefined ? { catalog: entry } : {}),
              }
            })
          return { apps }
        },
      })

      // ---- update_meta ---------------------------------------------------
      ctx.action<
        {
          pluginId: string
          pinned?: boolean
          category?: AppCategory
          icon?: string
          workspaceDir?: string
          originConversationId?: number
        },
        { pluginId: string; catalogEntry: AppCatalogEntry }
      >({
        id: 'update_meta',
        description: 'Update an app catalog metadata (pinned/category/icon/source dir/origin conversation); does not touch the plugin itself',
        inputSchema: {
          type: 'object',
          properties: {
            pluginId: { type: 'string', minLength: 1 },
            pinned: { type: 'boolean' },
            category: { type: 'string', enum: [...APP_CATEGORIES] },
            icon: { type: 'string', minLength: 1 },
            workspaceDir: { type: 'string', minLength: 1 },
            originConversationId: { type: 'number', minimum: 1 },
          },
          required: ['pluginId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            pluginId: { type: 'string' },
            catalogEntry: { type: 'object' },
          },
          required: ['pluginId', 'catalogEntry'],
          additionalProperties: false,
        },
        cli: {
          command: ['apps', 'update_meta'],
          positional: [{ field: 'pluginId', required: true }],
        },
        async handler(input) {
          assertNotSelfTarget(input.pluginId)
          const category = input.category !== undefined ? assertCategory(input.category) : undefined
          const existing = catalog.get().apps[input.pluginId]
          // The target must already exist in the catalog (unpublished apps have no metadata to change)
          if (existing === undefined) {
            throw new HelmError(
              'app_not_published',
              `App ${input.pluginId} is not registered in the app center (publish first, then edit metadata)`,
              404,
              { pluginId: input.pluginId },
            )
          }
          const entry: AppCatalogEntry = {
            ...existing,
            ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
            ...(category !== undefined ? { category } : {}),
            ...(input.icon !== undefined ? { icon: input.icon } : {}),
            ...(input.workspaceDir !== undefined ? { workspaceDir: input.workspaceDir } : {}),
            ...(input.originConversationId !== undefined
              ? { originConversationId: input.originConversationId }
              : {}),
            updatedAt: Date.now(),
          }
          catalog.update((current) => ({ apps: { ...current.apps, [input.pluginId]: entry } }))
          await catalog.flush()
          return { pluginId: input.pluginId, catalogEntry: entry }
        },
      })

      // ---- remove --------------------------------------------------------
      ctx.action<{ pluginId: string }, { pluginId: string; installPath: string; wasEnabled: boolean }>({
        id: 'remove',
        description: 'Uninstall a managed-installed full-stack app and clean the catalog registration (the local source directory is unaffected)',
        inputSchema: {
          type: 'object',
          properties: { pluginId: { type: 'string', minLength: 1 } },
          required: ['pluginId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            pluginId: { type: 'string' },
            installPath: { type: 'string' },
            wasEnabled: { type: 'boolean' },
          },
          required: ['pluginId', 'installPath', 'wasEnabled'],
          additionalProperties: false,
        },
        cli: {
          command: ['apps', 'remove'],
          positional: [{ field: 'pluginId', required: true }],
        },
        async handler(input) {
          assertNotSelfTarget(input.pluginId)
          const port = ctx.host.plugins
          // Uninstall (the host port explicitly 404s plugins without a managed record; no silent skip)
          const result = await port.remove(input.pluginId)
          // Catalog cleanup (unregistered entries are also cleaned idempotently, staying consistent)
          catalog.update((current) => {
            if (current.apps[input.pluginId] === undefined) return current
            const apps = { ...current.apps }
            delete apps[input.pluginId]
            return { apps }
          })
          await catalog.flush()
          return {
            pluginId: result.pluginId,
            installPath: result.installPath,
            wasEnabled: result.wasEnabled,
          }
        },
      })

      // ---- UI: app center entry and fullscreen view ------------------------------------

      ctx.ui.sidebarItem({
        id: 'app-center',
        label: 'App Center',
        icon: 'layout-grid',
        target: `screen:${APPS_PLUGIN_ID}/${APPS_SCREEN_ID}`,
        order: 15,
      })
      ctx.ui.screen({
        id: APPS_SCREEN_ID,
        label: 'App Center',
        icon: 'layout-grid',
        client: { module: 'index.tsx', export: 'AppCenterScreen' },
      })

      // ---- Managed skill app-builder -------------------------------------------

      ctx.service({
        id: 'app-builder-skill',
        async start() {
          const assets = readSkillAssets()
          await ctx.host.skills.ensureSkill({
            id: APP_BUILDER_SKILL_ID,
            skillMd: assets.skillMd,
            references: assets.references,
          })
        },
        async stop() {},
      })
    },
  }
}
