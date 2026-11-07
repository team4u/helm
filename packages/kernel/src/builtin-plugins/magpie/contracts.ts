/**
 * builtin:magpie 共享契约：常量、依赖端口、公开状态文档形状。
 *
 * 设计要点（诚实性纪律落地）：
 * - 网关配置快照（MagpieGatewayRef）：所有模型目录 / 配额 / 路由读取都以
 *   「读取时刻冻结的 root+token」执行，发布前校验快照仍是当前生效配置，
 *   配置切换后绝不把旧网关的缓存或请求结果发布到新网关名下；
 * - provider.refreshModels 网络失败一律 throw（不吞）：通用目录刷新
 *   （models.refresh / POST /api/models/refresh）必须把 magpie 失败显式呈现在
 *   errors 中，绝不因 provider 静默吞错而弹「刷新成功」；
 * - 公开 status doc 与动作输出绝不携带 apiKey / token（密钥只经 Bearer 头）。
 *
 * ctx.provider 跨 worktree 接口时序说明：通用插件 Provider 注册表
 * （ctx.provider(provider)）由并行分支实现并由主代理接线到
 * PluginHostOptions.providers；本插件按该契约直接调用。当前宿主尚未实现时
 * asMagpieContext 显式报错（注册失败回滚），绝不静默降级为「已启用但
 * provider 未挂载」的虚假状态。
 */
import { HelmError, type HelmPluginContext, type PluginDefinition } from '@helm/protocol'
import type { Provider } from '@earendil-works/pi-ai'

export const MAGPIE_PLUGIN_ID = 'builtin:magpie'

/** pi-ai Provider id（模型 id 前缀命名空间）。 */
export const MAGPIE_PROVIDER_ID = 'magpie'

/** 本机 Magpie 网关缺省根地址。 */
export const DEFAULT_MAGPIE_ROOT = 'http://127.0.0.1:3425'

/** 本机 loopback 网关的缺省 token（loopback 接受任意 token）。 */
export const DEFAULT_MAGPIE_TOKEN = 'magpie'

/** Magpie 自身的环境变量：网关根地址（其次 MAGPIE_ADDR）。 */
export const MAGPIE_ROOT_ENV = 'MAGPIE_GW_URL'
export const MAGPIE_ADDR_ENV = 'MAGPIE_ADDR'

/** 插件配置（config.json + credentials.json secret 合并后的有效视图）。 */
export interface MagpiePluginConfig {
  gatewayUrl?: string
  apiKey?: string
}

/**
 * 读取时刻冻结的网关配置快照。快照一经取得，本轮数据读取与发布都在它之上
 * 进行；发布前必须确认快照仍是当前生效配置（见 sameGateway）。
 */
export interface MagpieGatewayRef {
  /** 归一化后的网关根地址（无尾斜杠、无尾 /v1）。 */
  root: string
  /** Bearer token；loopback 缺省 'magpie'。 */
  token: string
  /** 是否由用户显式配置了非默认地址（区别于默认回环回退）。 */
  configuredRoot: boolean
  /** root 是否本机 loopback（决定 CLI 数据源与配额读取语义）。 */
  local: boolean
}

/** 同一快照判定：root 或 token 任一变化即视为配置已切换。 */
export function sameGateway(a: MagpieGatewayRef, b: MagpieGatewayRef): boolean {
  return a.root === b.root && a.token === b.token
}

/**
 * 组合层注入依赖（app.ts 提供；测试可替换）：
 * - refreshProviderModels：经宿主 Models 集合刷新动态供应商目录
 *   （models.refresh({ providers: ['magpie'] }) 的包装），错误以
 *   errors: Record<providerId, message> 返回（不 reject）；
 * - fetchImpl / runMagpieCli：受控注入端口，测试不走真实网络 / 真实 CLI。
 */
export interface MagpiePluginDependencies {
  refreshProviderModels(options?: {
    allowNetwork?: boolean
    force?: boolean
  }): Promise<{ errors: Record<string, string>; modelCount?: number }>
  fetchImpl?: typeof fetch
  runMagpieCli?: (
    args: readonly string[],
    options?: { signal?: AbortSignal },
  ) => Promise<{ ok: boolean; stdout?: string; error?: string }>
}

// ---------------------------------------------------------------------------
// 公开 status doc（composer.pill / settings.panel / CLI helm magpie status 共用）
// ---------------------------------------------------------------------------

/** 配额展示行（每订阅/计划/密钥的每个窗口一行）。remainingPercent 为 -1 表示未知。 */
export interface MagpieStatusQuota {
  provider: string
  account?: string
  remainingPercent: number
  resetText?: string
  windowLabel?: string
}

/** 路由组最近命中轨迹行。 */
export interface MagpieStatusRoute {
  group: string
  strategy?: string
  provider?: string
  model?: string
  timestamp?: string
}

export interface MagpieStatusDoc {
  gatewayUrl: string
  /** 是否由用户显式配置而非默认回环地址。 */
  configuredRoot: boolean
  local: boolean
  /** 最近一次网络目录刷新是否成功；false 时 modelCount 为缓存计数而非实时结果。 */
  reachable: boolean
  modelCount: number
  groupCount: number
  /** 最近一次成功网络刷新时间；仅成功时推进。 */
  lastRefreshedAt?: number
  /** 最近一次失败原因（脱敏：不含 token）。 */
  lastError?: string
  /** 供 composer.pill 与 settings.panel 直接绑定展示（无 Emoji）。 */
  summaryText: string
  quotas: MagpieStatusQuota[]
  routes: MagpieStatusRoute[]
}

/** 公开状态文档名。 */
export const MAGPIE_STATUS_DOC = 'status'

// ---------------------------------------------------------------------------
// ctx.provider 契约（并行分支实现，主代理接线）
// ---------------------------------------------------------------------------

/**
 * 通用插件 Provider 注册上下文：definePlugin 期间声明，宿主在 service.start
 * 前完成注册、service.stop 后注销并跟踪归属回滚。
 */
export interface MagpiePluginContext extends HelmPluginContext {
  provider(provider: Provider): void
}

/**
 * 将宿主传入的 ctx 适配为带 provider 注册能力的形态。
 * 宿主尚未实现 ctx.provider 时显式报错（注册失败整体回滚），
 * 绝不静默降级为「插件已启用但 provider 未挂载」。
 */
export function asMagpieContext(ctx: HelmPluginContext): MagpiePluginContext {
  const candidate = ctx as Partial<MagpiePluginContext>
  if (typeof candidate.provider !== 'function') {
    throw new HelmError(
      'magpie_provider_registry_unavailable',
      `插件 ${MAGPIE_PLUGIN_ID} 需要宿主 ctx.provider 注册表（PluginHostOptions.providers）；当前宿主未实现，拒绝注册`,
      500,
      { pluginId: MAGPIE_PLUGIN_ID },
    )
  }
  return ctx as MagpiePluginContext
}

export type MagpiePluginFactory = (deps: MagpiePluginDependencies) => PluginDefinition
