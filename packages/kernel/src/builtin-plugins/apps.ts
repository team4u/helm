/**
 * builtin:apps：应用中心与全栈应用工坊（默认启用、非 locked 可停用）。
 *
 * 职责（机制与策略分离：内核提供 PluginHost 受管包机制，本插件承载产品层
 * 应用目录与生命周期编排）：
 * - 公开持久文档 catalog（AppsCatalogDoc）：应用级产品元数据（icon/category/
 *   pinned/workspaceDir/originConversationId/时间戳），PluginSummary 不承载；
 * - 5 个 ctx.action：validate / publish / list / update_meta / remove，自动映射
 *   `helm apps …` CLI、HTTP、Agent Tool、Workflow 与 Web 五端；
 * - 左栏「应用中心」入口 + 全屏 screen `center`（client 组件由宿主端口分支
 *   提供，本文件只声明注册结构，client 占位模块保编译）；
 * - 受管技能 app-builder（SKILL.md + fullstack-template references），经
 *   ctx.host.skills.ensureSkill 随插件启停进入/离开技能目录。
 *
 * 诚实性纪律：
 * - validate/publish 依赖宿主 plugins.doctor 真实四阶段自检（manifest/backend/
 *   register/client），不维护第二套近似校验；额外强制「至少一个 ctx.ui.screen」
 *   （全栈应用硬性要求，缺失以 missing_app_screen 失败项如实报告）；
 * - 宿主端口（HelmHostApi.plugins）由 protocol-host 分支提供；当前分支以本地
 *   兼容类型 + 缺失显式 501 访问，绝不静默降级或伪造安装成功；
 * - 远端节点会话 + 相对路径显式 400 app_source_must_be_on_hub（PluginHost 与
 *   PackageManager 运行在 Hub 主机，只在 local 节点文件系统上工作）；
 * - 停用本插件不影响已发布应用（它们是独立受管外部插件，生命周期归 PluginHost）。
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

export const APPS_PLUGIN_ID = 'builtin:apps'
export const APPS_SCREEN_ID = 'center'
export const APP_BUILDER_SKILL_ID = 'app-builder'

// ---------------------------------------------------------------------------
// catalog 数据契约（公开持久文档）
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
  /** 对应受管插件的 pluginId。 */
  pluginId: string
  /** 应用显示图标（lucide 图标名，缺省 'layout-grid'）。 */
  icon: string
  /** 业务分类标签。 */
  category: AppCategory
  /** 是否在应用中心置顶收藏。 */
  pinned: boolean
  /** 开发该应用的工作区源码绝对路径（供后续 AI 修改后直接 publish 热更新）。 */
  workspaceDir?: string
  /** 首次生成或最近迭代该应用的会话 ID（供一键跳回原对话继续迭代）。 */
  originConversationId?: number
  /** 首次发布时间戳（epoch 毫秒）。 */
  publishedAt: number
  /** 最近一次发布/更新时间戳（epoch 毫秒）。 */
  updatedAt: number
}

export interface AppsCatalogDoc {
  apps: Record<string, AppCatalogEntry>
}

export const EMPTY_APPS_CATALOG: AppsCatalogDoc = { apps: {} }

const CATALOG_DOC = 'catalog'

// ---------------------------------------------------------------------------
// 宿主受管包端口
// ---------------------------------------------------------------------------

/** 直接消费 protocol 定义的宿主插件治理端口，不复制第二套包管理契约。 */
function hostPluginsPort(host: HelmHostApi): HelmHostApi['plugins'] {
  return host.plugins
}

// ---------------------------------------------------------------------------
// 资产目录解析（client / skill）
// ---------------------------------------------------------------------------

/** clientRoot 兼容 src / dist 运行路径（与 workflow/herdr/json-render 同机制）。 */
function resolveClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'apps', 'client')
  if (existsSync(local)) return local
  const pkgRoot = dirname(dirname(here))
  const srcFallback = join(pkgRoot, 'src', 'builtin-plugins', 'apps', 'client')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError(
    'apps_plugin_client_missing',
    `内置插件 ${APPS_PLUGIN_ID} 找不到 client 组件目录（期望 ${local} 或 ${srcFallback}）`,
    500,
  )
}

function readSkillAssets(): { skillMd: string; references: Record<string, string> } {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'apps', 'skill')
  const dir = existsSync(local)
    ? local
    : join(dirname(dirname(here)), 'src', 'builtin-plugins', 'apps', 'skill')
  if (!existsSync(dir)) {
    throw new HelmError('apps_skill_missing', `内置插件 ${APPS_PLUGIN_ID} 找不到技能资产目录`, 500)
  }
  return {
    skillMd: readFileSync(join(dir, 'SKILL.md'), 'utf-8'),
    references: {
      'fullstack-template.md': readFileSync(join(dir, 'references', 'fullstack-template.md'), 'utf-8'),
    },
  }
}

// ---------------------------------------------------------------------------
// 路径与输入校验
// ---------------------------------------------------------------------------

/**
 * 解析 validate/publish 的 dir 输入为 Hub 本机绝对路径。
 * 相对路径按调用会话绑定 cwd（缺省 Hub cwd）解析；会话绑定远端节点时显式
 * 400（PluginHost/PackageManager 只在 Hub 主机文件系统上工作）。
 */
function resolveAppSourceDir(
  dir: string,
  context: { conversationId?: number },
  deps: { getConversation(id: number): { nodeId?: string; cwd: string }; hubCwd: string },
): string {
  if (dir.includes('\0')) {
    throw new HelmError('validation_error', '应用目录路径含非法字符', 400, { dir })
  }
  let baseCwd = deps.hubCwd
  if (!isAbsolute(dir) && context.conversationId !== undefined) {
    const conv = deps.getConversation(context.conversationId)
    const nodeId = conv.nodeId ?? 'local'
    if (nodeId !== 'local') {
      throw new HelmError(
        'app_source_must_be_on_hub',
        `会话绑定在远端节点 ${nodeId}，应用源码目录必须在 Hub 本机（local 节点）文件系统上；请提供 Hub 本机绝对路径，或改用 Git/npm 来源`,
        400,
        { conversationId: context.conversationId, nodeId, dir },
      )
    }
    baseCwd = conv.cwd
  }
  const resolved = resolvePath(baseCwd, dir)
  if (!isAbsolute(resolved)) {
    throw new HelmError('validation_error', `应用目录无法解析为绝对路径：${dir}`, 400, { dir, resolved })
  }
  return resolved
}

function assertNotSelfTarget(pluginId: string): void {
  if (pluginId === APPS_PLUGIN_ID) {
    throw new HelmError(
      'app_target_is_self',
      `不允许对 ${APPS_PLUGIN_ID} 自身执行本操作（应用中心自身不是可发布应用）`,
      409,
      { pluginId },
    )
  }
  if (pluginId.startsWith('builtin:')) {
    throw new HelmError(
      'app_target_is_builtin',
      `内置插件 ${pluginId} 不是应用中心管理的全栈应用（仅外部受管插件可操作）`,
      409,
      { pluginId },
    )
  }
}

function assertCategory(value: string): AppCategory {
  if (!(APP_CATEGORIES as readonly string[]).includes(value)) {
    throw new HelmError(
      'validation_error',
      `应用分类非法：${value}（允许 ${APP_CATEGORIES.join(' | ')}）`,
      400,
      { category: value, allowed: APP_CATEGORIES },
    )
  }
  return value as AppCategory
}

// ---------------------------------------------------------------------------
// validate / publish 共用：doctor + screen 检查
// ---------------------------------------------------------------------------

interface AppValidateResult {
  ok: boolean
  pluginId?: string
  dir: string
  checks: PluginDoctorReport['checks']
  screenIds: string[]
  /** Screen 事实来源：host-doctor（真实临时注册捕获）/ registered（listUi 事实）/ deferred（诊断失败时无可用结论）。 */
  screenBasis: 'host-doctor' | 'registered' | 'deferred'
  summary?: string
}

/**
 * 执行 validate：宿主 doctor 真实四阶段 + 全栈应用 Screen 强制检查。
 *
 * Screen 事实来自真实声明执行：优先使用 doctor 临时宿主 register 阶段捕获的
 * screens；旧/定制宿主缺少字段时，已注册插件回退到 PluginHost listUi。若
 * doctor 报告成功但两处都没有 Screen，则作为 missing_app_screen 拒绝，绝不把
 * 未经验证的草稿标记为可发布。doctor 失败时保持原诊断，不使用部分注册结果。
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
    // 仅当目标确实已注册（草稿目录 doctor 也会报出 id）才以 listUi 为事实源
    screenIds = screensOf(port, report.pluginId)
    screenBasis = 'registered'
  }

  if (screenIds.length === 0 && (screenBasis !== 'deferred' || report.ok)) {
    checks.push({
      id: 'missing_app_screen',
      label: '全栈应用 Screen 检查',
      error: {
        code: 'missing_app_screen',
        message: '应用必须声明至少一个 ctx.ui.screen（全栈应用的前端主视图）',
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

/** 基于宿主 listUi 收集指定插件的 screen id 列表（已注册插件事实）。 */
function screensOf(port: HelmHostApi['plugins'], pluginId: string): string[] {
  return port
    .listUi()
    .filter((c) => c.pluginId === pluginId && c.surface === 'screen')
    .map((c) => (c.spec as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string')
}

// ---------------------------------------------------------------------------
// 插件定义
// ---------------------------------------------------------------------------

/**
 * @param deps.hubCwd Hub 主机 cwd（相对路径兜底解析基准；缺省 process.cwd()）。
 * 测试可注入；运行时由宿主端口分支接入真实 init.cwd。
 */
export function createAppsPlugin(deps: { hubCwd?: string } = {}): PluginDefinition {
  const hubCwd = deps.hubCwd ?? process.cwd()
  return {
    id: APPS_PLUGIN_ID,
    name: '应用中心',
    description: '全栈微应用目录与生命周期：validate/publish/list/remove 动作、应用中心视图与 app-builder 受管技能。',
    icon: 'boxes',
    version: '0.1.0',
    locked: false,
    clientRoot: resolveClientRoot(),
    definePlugin(ctx) {
      const catalog = ctx.doc<AppsCatalogDoc>(CATALOG_DOC, EMPTY_APPS_CATALOG, { public: true })

      /** 会话解析依赖（延迟经 ctx.host 读取，保持与宿主端口一致的边界）。 */
      const getConversation = (id: number) => ctx.host.getConversation(id)

      // ---- validate ------------------------------------------------------
      ctx.action<{ dir: string }, AppValidateResult>({
        id: 'validate',
        description: '对工作区应用目录执行静态预检（doctor 四阶段 + Screen 检查）；相对路径按调用会话 cwd 解析',
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
          const port = hostPluginsPort(ctx.host)
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
        description: '发布（或升级）工作区全栈应用：先 validate，再受管安装或热更新并启用，登记 catalog 元数据',
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
          const port = hostPluginsPort(ctx.host)
          const resolvedDir = resolveAppSourceDir(input.dir, context, { getConversation, hubCwd })
          const category = input.category !== undefined ? assertCategory(input.category) : undefined

          // 1. 与 validate 相同的预检（未通过显式 422，附完整诊断）
          const validation = await validateAppDir(port, resolvedDir)
          if (!validation.ok) {
            const failed = validation.checks.filter((c) => c.error !== undefined)
            throw new HelmError(
              'app_validate_failed',
              `应用预检未通过（${failed.length} 项失败），已拒绝发布：${failed.map((c) => `${c.label}：${c.error!.message}`).join('；')}`,
              422,
              { dir: resolvedDir, checks: validation.checks },
            )
          }
          const pluginId = validation.pluginId
          if (pluginId === undefined) {
            throw new HelmError(
              'app_validate_failed',
              `预检通过但未识别出插件 id（内部状态不一致）：${resolvedDir}`,
              500,
              { dir: resolvedDir, checks: validation.checks },
            )
          }
          assertNotSelfTarget(pluginId)

          // 2. 受管安装或热更新
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
              // 安装成功但启用失败：如实报错（安装记录已保留，可重试 enable）
              throw new HelmError(
                'app_enable_failed',
                `应用 ${pluginId} 已安装但启用失败（安装记录保留，可重试）：${result.enableError.message}`,
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

          // 3. screen 复核与 catalog 登记（发布后从宿主 listUi 读取事实）
          const screenIds = screensOf(port, pluginId)
          if (screenIds.length === 0) {
            throw new HelmError(
              'missing_app_screen',
              `应用 ${pluginId} 已安装但未发现任何已启用 Screen（应用中心无法打开）；请检查 ctx.ui.screen 声明与插件启用状态`,
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
        description: '汇总当前全部全栈应用（宿主插件/UI 清单左连接 catalog 元数据；孤儿 catalog 条目自动忽略）',
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
          const port = hostPluginsPort(ctx.host)
          const summaries = port.list()
          const ui = port.listUi()
          const catalogState = catalog.get()
          const apps = summaries
            .filter((s) => {
              if (s.id.startsWith('builtin:')) {
                // 内置插件不混入用户应用列表（含本插件自身的 center screen）
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
        description: '更新应用的 catalog 元数据（置顶/分类/图标/源码目录/来源会话）；不改插件本体',
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
          // 目标必须已存在于 catalog（未发布的应用没有元数据可改）
          if (existing === undefined) {
            throw new HelmError(
              'app_not_published',
              `应用 ${input.pluginId} 未在应用中心登记（先 publish 再修改元数据）`,
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
        description: '卸载受管安装的全栈应用并清理 catalog 登记（本地源码目录不受影响）',
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
          const port = hostPluginsPort(ctx.host)
          // 卸载（宿主端口对无受管记录的插件显式 404；不静默跳过）
          const result = await port.remove(input.pluginId)
          // catalog 清理（未登记条目也幂等清理，保持一致）
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

      // ---- UI：应用中心入口与全屏视图 ------------------------------------

      ctx.ui.sidebarItem({
        id: 'app-center',
        label: '应用中心',
        icon: 'layout-grid',
        target: `screen:${APPS_PLUGIN_ID}/${APPS_SCREEN_ID}`,
        order: 15,
      })
      ctx.ui.screen({
        id: APPS_SCREEN_ID,
        label: '应用中心',
        icon: 'layout-grid',
        client: { module: 'index.tsx', export: 'AppCenterScreen' },
      })

      // ---- 受管技能 app-builder -------------------------------------------

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
