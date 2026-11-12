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
 */

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
 * 零参工厂：全部依赖直接消费 ctx.host 公共端口（HelmHostApi）：
 * - refreshModels({ providers: ['magpie'] })：经宿主通用目录刷新链路刷新
 *   自身 provider（错误以 result.errors['magpie'] 返回，不 reject）；
 * - 网络读取用 global fetch；本机 magpie CLI 经 execFile 公开环境端口
 *   （测试以 PATH fixture / mock global fetch 替代，不留生产后门）。
 */
export interface MagpieRefreshPort {
  refreshModels(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<{ errors: Record<string, string> }>
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
  /** 业务侧诊断（脱敏）：配额 / 路由轨迹不可用的原因等；空数组表示无诊断。 */
  diagnostics: string[]
}

/** 公开状态文档名。 */
export const MAGPIE_STATUS_DOC = 'status'

// ---------------------------------------------------------------------------
// ctx.provider 契约
// ---------------------------------------------------------------------------

// 真实宿主（@helm/protocol HelmPluginContext）已内置 ctx.provider 注册能力；
// ctx.host.refreshModels 为宿主通用目录刷新端口（kernel-host 交付）。
