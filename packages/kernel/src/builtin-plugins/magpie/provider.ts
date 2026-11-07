/**
 * Magpie 网关 → pi-ai Provider（动态目录供应商）。
 *
 * 与 pi-magpie v0.1.6 provider.ts 精髓一致：
 * - 目录来自网关自身（GET /v1/models），每次网络刷新拉取并持久化；
 * - 请求按模型 api 委托 pi-ai compat 的 stream/streamSimple 实现，
 *   baseUrl 按请求时刻生效配置动态修正（anthropic-messages 用 root，
 *   其余用 {root}/v1——models.json 的静态 baseUrl 不可信）；
 * - auth.check/resolve 返回有效结果：已同步模型在 models.getAvailable('magpie')
 *   中即为 available（loopback 网关免登录即用）。
 *
 * 诚实性纪律（关键验收）：
 * - refreshModels 网络失败一律 throw（含默认 loopback 未运行）：通用目录刷新
 *   （models.refresh → errors['magpie']）必须把失败显式呈现，绝不静默吞成
 *   errors:{} 弹「刷新成功」；
 * - allowNetwork:false 的 cache-only 恢复不触网，永不失败，也不触发
 *   onCatalogChange（cache-only 不是网络成功，绝不伪装）；
 * - 目录恢复与发布按当前 root 过滤（servedByRoot）：fetch 期间配置切换的
 *   挂起结果不再发布（发布前 sameGateway 守卫）。
 */
import {
  isModelType,
  stream as compatStream,
  streamSimple as compatStreamSimple,
  type AuthCheck,
  type AuthResult,
  type Context,
  type Provider,
  type ProviderStreamOptions,
  type RefreshModelsContext,
} from '@earendil-works/pi-ai/compat'
import { HelmError } from '@helm/protocol'
import { baseUrlFor, servedByRoot, toPiModels, type MagpieModelEntry, type PiMagpieModel } from './catalog.js'
import { fetchCatalog } from './gateway.js'
import { MAGPIE_PROVIDER_ID, MAGPIE_ROOT_ENV, sameGateway, type MagpieGatewayRef } from './contracts.js'

/**
 * 目录变化通知快照：网络刷新的成败结论（含当前生效网关），供插件同步
 * status doc 的 reachable / modelCount / lastError。cache-only 恢复不通知。
 */
export interface MagpieCatalogChange {
  gateway: MagpieGatewayRef
  ok: boolean
  modelCount: number
  error?: string
}

/** 插件对 provider 工厂的需求。 */
export interface MagpieProviderOptions {
  /** 读取当前生效网关快照（每次 refreshModels / stream 前调用）。 */
  gateway(): MagpieGatewayRef
  fetchImpl: typeof fetch
  /**
   * 网络目录刷新结果通知（成功与失败都通知；cache-only 不通知）：
   * 插件据此更新 status doc——通用 HTTP models.refresh 刷新本 Provider 时，
   * 插件状态不再与目录脱节。
   */
  onCatalogChange?(change: MagpieCatalogChange): void
}

/** provider 句柄：注册用的 Provider 与插件侧状态查询。 */
export interface MagpieProviderHandle {
  provider: Provider
  /** 当前已安装模型（最新目录在前，仅当前 root 名下）。 */
  models(): readonly PiMagpieModel[]
  /** 目录是否已成功同步过至少一次（本启用周期内）。 */
  synced(): boolean
}

/**
 * 按请求时刻生效 root 修正模型 baseUrl（Provider 契约的宽泛 Api 域收敛到
 * 本目录域；baseUrl 来自 models.json 静态目录，请求时刻必须重投影）。
 */
function forRequest(model: Parameters<Provider['stream']>[0], root: string): PiMagpieModel {
  const wide = model as PiMagpieModel
  const baseUrl = wide.api === 'anthropic-messages' ? root : baseUrlFor(root, 'v1')
  return wide.baseUrl === baseUrl ? wide : { ...wide, baseUrl }
}

/** compat 入口的归一化幂等：Provider 已传入归一后的 TranscriptContext 可直接复用（brand 向下兼容转型）。 */
function asCompatContext(context: Parameters<Provider['stream']>[1]): Context {
  return context as unknown as Context
}

/**
 * 请求选项最小类型桥：Provider 泛型方法的 ApiStreamOptions<T> /
 * SimpleStreamOptions 是具体接口（无 index signature），compat 入口接受
 * ProviderStreamOptions（StreamOptions & Record<string, unknown>），静态
 * 类型系统无法证明具体接口可索引——只在 options 一处做 unknown 桥；
 * model / context 均按原类型直传，绝不用 as never 接收。
 */
function asCompatOptions(options: ProviderStreamOptions | undefined): ProviderStreamOptions {
  return options as unknown as ProviderStreamOptions
}

/**
 * 同快照请求参数：root 取 auth.resolve 冻结进 env 的值（与 apiKey 同次
 * auth 快照），缺省（compat 直调无 auth）回落请求时刻网关快照；token
 * 缺省同源补齐——绝不跨 await 重读配置把旧 key 发新 root。
 */
function requestParams(
  model: Parameters<Provider['stream']>[0],
  context: Parameters<Provider['stream']>[1],
  options: ProviderStreamOptions | undefined,
  fallback: MagpieGatewayRef,
): { model: PiMagpieModel; context: Context; options: ProviderStreamOptions } {
  const envRoot = options?.env?.[MAGPIE_ROOT_ENV]
  const root = (typeof envRoot === 'string' && envRoot.trim() !== '' ? envRoot : fallback.root).trim()
  return {
    model: forRequest(model, root),
    context: asCompatContext(context),
    options: asCompatOptions({ ...options, apiKey: options?.apiKey ?? fallback.token }),
  }
}

/** 构建 pi-ai Provider（auth 恒有效：loopback 网关免登录；远端 token 由配置注入）。 */
export function createMagpieProvider(options: MagpieProviderOptions): MagpieProviderHandle {
  const { gateway, fetchImpl, onCatalogChange } = options
  let models: PiMagpieModel[] = []
  let syncedOnce = false

  const install = (next: PiMagpieModel[]): void => {
    models = next
  }

  const provider: Provider = {
    id: MAGPIE_PROVIDER_ID,
    name: 'Magpie',
    /** getter：供应商摘要始终投影当前生效网关根地址（配置切换即时跟随）。 */
    get baseUrl(): string {
      return baseUrlFor(gateway().root, 'v1')
    },
    auth: {
      apiKey: {
        name: 'Magpie gateway',
        /** 免交互：availability 由目录刷新判定，auth 恒有效。 */
        check: async (): Promise<AuthCheck> => ({ type: 'api_key', source: 'magpie gateway (loopback default or configured)' }),
        resolve: async ({ signal }): Promise<AuthResult> => {
          signal.throwIfAborted()
          // 冻结网关快照进 env：apiKey 与 root 来自同一次 auth 快照，
          // stream 侧从 resolved options.env 取 root，绝不跨 await 重读配置
          //（防「切 root 后旧 token 发新 root / 新 root 配旧目录」的错配）。
          const gw = gateway()
          return {
            auth: { apiKey: gw.token },
            env: { [MAGPIE_ROOT_ENV]: gw.root },
            source: gw.configuredRoot ? 'configured magpie gateway' : 'default loopback gateway',
          }
        },
      },
    },
    getModels: () => models.filter((model) => isModelType(model, 'chat') && servedByRoot(model, gateway().root)),
    getAllModels: () => models.filter((model) => servedByRoot(model, gateway().root)),
    async refreshModels(context: RefreshModelsContext): Promise<void> {
      const gw = gateway()
      // 1) 恢复持久缓存（cache-only 也执行）：只恢复属于当前 root 的模型，
      //    其余丢弃——切换网关后旧目录绝不冒充新网关的缓存。
      if (context.stored) {
        const restored = (context.stored.models as readonly PiMagpieModel[]).filter(
          (model) => model?.provider === MAGPIE_PROVIDER_ID && isModelType(model, 'chat') && servedByRoot(model, gw.root),
        )
        if (!(await context.publish({ update: () => install([...restored]) }))) return
      } else if (models.length > 0) {
        // 首次刷新前内存里可能有上个网关的残留目录：同样不冒充本网关缓存。
        if (!(await context.publish({ update: () => install([]) }))) return
      }
      if (!context.allowNetwork || context.signal.aborted) return
      // 2) 网络刷新：失败一律 throw（cache-only 恢复已完成，调用方凭
      //    errors['magpie'] 显式呈现失败；默认 loopback 未运行同样报错）。
      let entries: MagpieModelEntry[]
      try {
        entries = await fetchCatalog(gw.root, gw.token, context.signal, fetchImpl)
      } catch (error) {
        onCatalogChange?.({
          gateway: gw,
          ok: false,
          modelCount: models.filter((model) => servedByRoot(model, gw.root)).length,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      if (context.signal.aborted) return
      const next = toPiModels(entries, gw.root)
      // 发布前守卫：fetch 期间配置已切换（root/token 任一变化）的挂起结果
      // 绝不发布到新网关名下（publish 会返回 false，由调用方世代判定）。
      if (!sameGateway(gw, gateway())) {
        throw new HelmError('magpie_gateway_changed', '网关配置已变化，刷新结果未采用，请重新刷新目录', 409)
      }
      const published = await context.publish({
        persist: { models: next, checkedAt: Date.now() },
        update: () => {
          install(next)
          syncedOnce = true
        },
      })
      if (!published) return
      onCatalogChange?.({ gateway: gw, ok: true, modelCount: next.length })
    },
    stream: (model, context, streamOptions) => {
      const params = requestParams(model, context, streamOptions as ProviderStreamOptions | undefined, gateway())
      return compatStream(params.model, params.context, params.options)
    },
    streamSimple: (model, context, streamOptions) => {
      const params = requestParams(model, context, streamOptions as ProviderStreamOptions | undefined, gateway())
      return compatStreamSimple(params.model, params.context, params.options)
    },
  }

  return {
    provider,
    models: () => models.filter((model) => servedByRoot(model, gateway().root)),
    synced: () => syncedOnce,
  }
}
