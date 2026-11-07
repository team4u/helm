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
 * - allowNetwork:false 的 cache-only 恢复不触网，永不失败；
 * - 目录恢复按当前 root 过滤（servedByRoot）：切换网关后旧 root 缓存
 *   不再发布，先清空再等待新目录。
 */
import {
  isModelType,
  type AssistantMessageEventStream,
  type AuthCheck,
  type AuthResult,
  type Provider,
  type RefreshModelsContext,
} from '@earendil-works/pi-ai'
import { streamSimple as compatStreamSimple } from '@earendil-works/pi-ai/compat'
import { baseUrlFor, servedByRoot, toPiModels, type MagpieModelEntry, type PiMagpieModel } from './catalog.js'
import { fetchCatalog } from './gateway.js'
import { MAGPIE_PROVIDER_ID, type MagpieGatewayRef } from './contracts.js'

/** 插件对 provider 工厂的需求。 */
export interface MagpieProviderOptions {
  /** 读取当前生效网关快照（每次 refreshModels / stream 前调用）。 */
  gateway(): MagpieGatewayRef
  fetchImpl: typeof fetch
}

/** provider 句柄：注册用的 Provider 与插件侧状态查询。 */
export interface MagpieProviderHandle {
  provider: Provider
  /** 当前已安装模型（最新目录在前）。 */
  models(): readonly PiMagpieModel[]
  /** 目录是否已成功同步过至少一次（本启用周期内）。 */
  synced(): boolean
}

/**
 * pi-ai compat 的 stream/streamSimple 接收原始 Context 并自行归一，而 Provider
 * 收到的是已归一的 TranscriptContext：同消息换类型（llama.cpp 内置 provider
 * 同款委托方式）。compat 入口内部按 model.api 分发，与 Provider 契约同构，
 * 此处仅做类型委托（泛型签名不一致，用双 as 显式标注委托点）。
 */
const delegateStreamSimple = compatStreamSimple as unknown as (
  model: PiMagpieModel,
  context: never,
  options?: never,
) => AssistantMessageEventStream

/** 按请求时刻生效 root 修正模型 baseUrl（Provider 契约的宽泛 Api 域收敛到本目录域）。 */
function forRequest(model: Parameters<Provider['stream']>[0], root: string): PiMagpieModel {
  const wide = model as PiMagpieModel
  const baseUrl = wide.api === 'anthropic-messages' ? root : baseUrlFor(root, 'v1')
  return wide.baseUrl === baseUrl ? wide : { ...wide, baseUrl }
}

/** 构建 pi-ai Provider（auth 恒有效：loopback 网关免登录；远端 token 由配置注入）。 */
export function createMagpieProvider(options: MagpieProviderOptions): MagpieProviderHandle {
  const { gateway, fetchImpl } = options
  let models: PiMagpieModel[] = []
  let syncedOnce = false

  const install = (next: PiMagpieModel[]): void => {
    models = next
  }

  const provider: Provider = {
    id: MAGPIE_PROVIDER_ID,
    name: 'Magpie',
    baseUrl: baseUrlFor(gateway().root, 'v1'),
    auth: {
      apiKey: {
        name: 'Magpie gateway',
        /** 免交互：availability 由目录刷新判定，auth 恒有效。 */
        check: async (): Promise<AuthCheck> => ({ type: 'api_key', source: 'magpie gateway (loopback default or configured)' }),
        resolve: async ({ signal }): Promise<AuthResult> => {
          signal.throwIfAborted()
          const gw = gateway()
          return {
            auth: { apiKey: gw.token },
            source: gw.configuredRoot ? 'configured magpie gateway' : 'default loopback gateway',
          }
        },
      },
    },
    getModels: () => models.filter((model) => isModelType(model, 'chat')),
    getAllModels: () => models,
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
      const entries: MagpieModelEntry[] = await fetchCatalog(gw.root, gw.token, context.signal, fetchImpl)
      if (context.signal.aborted) return
      const next = toPiModels(entries, gw.root)
      if (!(await context.publish({
        persist: { models: next, checkedAt: Date.now() },
        update: () => {
          install(next)
          syncedOnce = true
        },
      }))) {
        return
      }
    },
    stream: (model, context, streamOptions) =>
      delegateStreamSimple(forRequest(model, gateway().root), context as never, streamOptions as never),
    streamSimple: (model, context, streamOptions) =>
      delegateStreamSimple(forRequest(model, gateway().root), context as never, streamOptions as never),
  }

  return {
    provider,
    models: () => models,
    synced: () => syncedOnce,
  }
}
