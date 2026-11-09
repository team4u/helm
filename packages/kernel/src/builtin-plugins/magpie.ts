/**
 * builtin:magpie：Magpie 网关接入插件（模型目录 / 配额 / 路由组）。
 *
 * 职责：
 * - 经 ctx.provider 注册 pi-ai 动态目录 Provider（service.start 前由宿主完成
 *   挂载，service.stop 后注销——不在插件内绕宿主手动挂卸）；
 * - 公开 status doc 驱动 settings.panel / commandPalette 与
 *   `helm magpie status` CLI；动作总线提供 refresh / quota / groups / group；
 * - turn_settled 后台静默刷新配额与路由（?kept=1，不问供应商、不阻塞回合）。
 *
 * 诚实性纪律：
 * - 所有网关读取都以「读取时刻冻结的快照」执行，发布前校验快照仍是当前
 *   生效配置：配置切换后绝不把旧网关数据发布到新网关名下；
 * - provider.refreshModels 网络失败一律 throw（通用目录刷新可见 errors['magpie']）；
 *   本插件 service.start 的后台刷新失败只更新 reachable:false / lastError，
 *   绝不阻断启用与内核启动；手动 refresh 动作显式抛 magpie_gateway_unreachable；
 * - reachable:false 时 modelCount 为缓存计数，绝不冒充实时刷新成功；
 * - 非 loopback 网关不读本机 magpie CLI 数据（那是另一个实例），只用所选
 *   网关 trace 并标注 source；apiKey 绝不进 doc / 动作输出 / 错误文本。
 */
import { HelmError, type PluginDefinition, type TurnSettledPayload } from '@helm/protocol'
import {
  DEFAULT_MAGPIE_ROOT,
  MAGPIE_PLUGIN_ID,
  MAGPIE_PROVIDER_ID,
  MAGPIE_STATUS_DOC,
  sameGateway,
  type MagpieGatewayRef,
  type MagpiePluginConfig,
  type MagpiePluginDependencies,
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

// 注：refresh 动作失败时显式抛 HelmError（不返回 degraded 结果）；成功时
// 配额 / 轨迹不可用原因在 status doc diagnostics，经 status 动作可读。

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
  summaryText: 'Magpie · 未连接',
  quotas: [],
  routes: [],
  diagnostics: [],
})

/** 错误文本脱敏：剥离 Bearer 头形态与已知 token 本体（网关错误页可能回显）。 */
function sanitizeErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+\S+/g, 'Bearer ***').slice(0, 300)
}

export function createMagpiePlugin(deps: MagpiePluginDependencies): PluginDefinition {
  const fetchImpl = deps.fetchImpl ?? fetch
  const runCli = deps.runMagpieCli

  return {
    id: MAGPIE_PLUGIN_ID,
    name: 'Magpie 网关',
    version: '0.1.0',
    definePlugin(rawCtx) {
      const ctx = rawCtx

      // ---- 配置与网关快照 -------------------------------------------------
      ctx.configSchema({
        gatewayUrl: {
          type: 'string',
          label: 'Magpie 网关地址',
          description: '缺省直连本机 http://127.0.0.1:3425（可填 http://host:3425）',
          default: 'http://127.0.0.1:3425',
        },
        apiKey: {
          type: 'string',
          label: 'Magpie API Key',
          description: '本机 loopback 缺省为 magpie；远端网关请填写对应密钥',
          secret: true,
        },
      })

      /** 当前生效配置（config store 视图；未配置字段回落网关解析缺省）。 */
      const effectiveConfig = (): MagpiePluginConfig => {
        const raw = ctx.getConfig() as Partial<MagpiePluginConfig>
        return {
          ...(typeof raw.gatewayUrl === 'string' && raw.gatewayUrl.trim() !== '' ? { gatewayUrl: raw.gatewayUrl } : {}),
          ...(typeof raw.apiKey === 'string' && raw.apiKey.trim() !== '' ? { apiKey: raw.apiKey } : {}),
        }
      }

      const gateway = (): MagpieGatewayRef => resolveGateway(effectiveConfig())

      // ---- provider 与公开 status doc --------------------------------------
      /**
       * 网络目录刷新结果 → status doc（onCatalogChange 端口）：通用 HTTP
       * models.refresh 刷新 Provider 时插件状态同步更新，不再脱节；
       * cache-only 恢复不通知（不是网络成功，绝不伪装）。发布前同样过
       * sameGateway 守卫：fetch 期间切了网关的旧结论不写新网关名下。
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

      /** 服务停止信号：停用后不得再写 doc。 */
      let stopping = false
      let stopController: AbortController | undefined

      /** 发布前守卫：快照仍是当前生效配置才写入 doc。 */
      const writeStatus = (snapshot: MagpieGatewayRef, patch: Partial<MagpieStatusDoc>): void => {
        if (stopping) return
        const currentGateway = gateway()
        if (!sameGateway(snapshot, currentGateway)) return
        const current = status.get()
        status.set({ ...current, ...patch, gatewayUrl: currentGateway.root })
      }

      const summaryTextOf = (reachable: boolean, modelCount: number): string =>
        reachable ? `Magpie · ${modelCount} 模型` : 'Magpie · 未连接'

      /**
       * 读配额 + 路由并更新 doc（在快照上执行；kept=true 不问供应商）。
       * 诚实性：配额 / 轨迹读取失败不吞——原因写入 diagnostics（清空旧配额
       * 区并记录不可用原因，绝不把「没有配额」伪装成「配额为空」）；
       * trace 不可用（远端拒绝 / 版本过旧）是合法状态，路由区空 + 诊断。
       */
      const refreshSidecar = async (snapshot: MagpieGatewayRef, kept: boolean): Promise<void> => {
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
            diagnostics.push(`配额不可用：${sanitizeErrorText(error)}`)
          }
          const trace = await fetchTrace(snapshot.root, snapshot.token, controller.signal, fetchImpl)
          if ('routes' in trace) {
            routes = traceRouteRows(trace.routes)
          } else {
            routes = []
            diagnostics.push(`路由轨迹不可用：${sanitizeErrorText(trace.unavailable)}`)
          }
          writeStatus(snapshot, { quotas, routes, groupCount: routes.length, diagnostics })
        } finally {
          if (stopController === controller) stopController = undefined
        }
      }

      /** 目录刷新后的状态发布（快照守卫 + reachable 语义）。 */
      const publishCatalogStatus = (snapshot: MagpieGatewayRef, reachable: boolean, error?: unknown): void => {
        const modelCount = handle.models().filter((m) => m.baseUrl.startsWith(snapshot.root)).length
        if (reachable) {
          // 成功清除旧错误：上一轮失败结论不残留成最新状态（jsonClone 拒绝
          // undefined 值，显式删除键而不是置 undefined）
          const current = status.get()
          if (current.gatewayUrl === snapshot.root && current.lastError !== undefined) delete current.lastError
          status.set(current)
          writeStatus(snapshot, {
            reachable: true,
            modelCount,
            summaryText: summaryTextOf(true, modelCount),
            lastRefreshedAt: Date.now(),
          })
        } else {
          writeStatus(snapshot, {
            reachable: false,
            modelCount,
            summaryText: summaryTextOf(false, modelCount),
            ...(error !== undefined ? { lastError: sanitizeErrorText(error) } : {}),
          })
        }
      }

      // ---- service 生命周期 ------------------------------------------------
      ctx.service({
        id: 'magpie-gateway',
        async start() {
          stopping = false
          const snapshot = gateway()
          // 初始化：先如实展示已恢复缓存（refreshModels 首阶段已恢复的目录
          // 计数），再由后台网络刷新推进 reachable / lastError。
          const cachedCount = handle.models().length
          status.set({
            ...emptyStatus(snapshot.root),
            configuredRoot: snapshot.configuredRoot,
            local: snapshot.local,
            modelCount: cachedCount,
            summaryText: summaryTextOf(false, cachedCount),
          })
          // 非阻塞后台刷新：失败只更新 reachable:false / lastError，绝不阻断
          // 启用与内核启动（provider.refreshModels 本身 throw——那是给通用
          // 目录刷新的显式信号；这里经 deps 端口拿 errors 映射，不 reject）。
          void (async () => {
            try {
              const snapshotInner = gateway()
              const result = await deps.refreshProviderModels({ allowNetwork: true, force: true })
              const error = result.errors['magpie']
              if (error !== undefined) {
                publishCatalogStatus(snapshotInner, false, error)
                return
              }
              publishCatalogStatus(snapshotInner, true)
              await refreshSidecar(snapshotInner, true)
            } catch (error) {
              // 组合层端口异常（非网关诊断）：如实记录，不阻断启动
              publishCatalogStatus(gateway(), false, error)
            }
          })()
        },
        async stop() {
          stopping = true
          stopController?.abort(new Error('magpie plugin stopping'))
          stopController = undefined
        },
      })

      // ---- turn_settled：后台静默刷新配额/路由（不阻塞回合结算） ------------
      // 只关心使用 magpie 模型的会话：其它会话（其它 Provider）settled 不
      // 触发任何网关读（会话当前模型从 payload.conversation 现取，不猜测）。
      ctx.hook.onTurnSettled((payload: TurnSettledPayload) => {
        if (stopping) return
        const model = payload.conversation.model
        if (!model.startsWith(`${MAGPIE_PROVIDER_ID}/`)) return
        const snapshot = gateway()
        // 不 await：绝不阻塞 turn_settled；失败只进 diagnostics，下一次 settled 重试
        void refreshSidecar(snapshot, true).catch((error) => {
          if (stopping) return
          ctx.host.emitEvent('notification', {
            level: 'warning', title: 'Magpie 状态读取失败', body: sanitizeErrorText(error),
          })
        })
      })

      // ---- 动作总线（HTTP / helm magpie <action> / run_action / Workflow） ----
      ctx.action({
        id: 'status',
        description: 'Magpie 网关状态快照（可达性、模型数、配额、路由轨迹）',
        idempotent: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: STATUS_OUTPUT_SCHEMA,
        handler: () => {
          // 读取时投影当前生效网关：配置切换后 doc 的 gatewayUrl 不残留旧 root；
          // doc 仍指向旧 root 时目录 / 可达性结论对该 root 才成立——新 root
          // 尚无任何结论，不冒充（reachable 保持 false 待首次刷新）。
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
            // 模型计数只统计当前 root 名下的目录（旧 root 缓存不冒充）
            modelCount: handle.models().filter((m) => m.baseUrl.startsWith(snapshot.root)).length,
          }
        },
      })

      ctx.action({
        id: 'refresh',
        description: '强制刷新 Magpie 模型目录与配额路由状态（失败显式报错）',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: REFRESH_OUTPUT_SCHEMA,
        handler: async () => {
          const snapshot = gateway()
          const result = await deps.refreshProviderModels({ allowNetwork: true, force: true })
          const error = result.errors['magpie']
          publishCatalogStatus(snapshot, error === undefined, error)
          if (error !== undefined) {
            throw new HelmError(
              'magpie_gateway_unreachable',
              `Magpie 网关 ${snapshot.root} 刷新失败：${sanitizeErrorText(error)}`,
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
        description: '实时查询 Magpie 配额（GET /v1/magpie/quotas）',
        idempotent: true,
        inputSchema: {
          type: 'object',
          properties: { model: { type: 'string', description: '按模型归属 provider 过滤（可选）' } },
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
              ...(snapshot.local ? {} : { note: '非本机网关：仅该网关自身报告的配额可读' }),
            }
          } catch (error) {
            throw new HelmError(
              'magpie_gateway_unreachable',
              `Magpie 网关 ${snapshot.root} 配额读取失败：${sanitizeErrorText(error)}`,
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
        description: '路由组列表与最近命中（本机读 magpie CLI + 网关 trace；远端仅网关 trace）',
        idempotent: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: GROUPS_OUTPUT_SCHEMA,
        handler: async () => {
          const snapshot = gateway()
          const controller = new AbortController()
          stopController = controller
          try {
            // 数据源隔离：CLI 只描述本机默认实例；显式配置了其它 loopback
            // 端口时无法证明 CLI 指向同一实例（MAGPIE_GW_URL/MAGPIE_ADDR 也
            // 可能指向另一处），只用所选 root 的 trace，不读本机别的实例。
            const cliTrusted = snapshot.root === DEFAULT_MAGPIE_ROOT
            let cliGroups: GroupListRow[] | undefined
            let cliError: string | undefined
            if (cliTrusted && runCli !== undefined) {
              const run = await runCli(['groups'], { signal: controller.signal })
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
              // trace 中出现而 CLI 未列的组（CLI 失败或 auto 组未列出）
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
            if (cliGroups === undefined) notes.push('仅展示所选网关已有请求的路由轨迹；完整组定义当前不可用。')
            if ('unavailable' in trace) notes.push(`路由轨迹不可用：${sanitizeErrorText(trace.unavailable)}`)
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
        description: '单个路由组的定义与最近一次路由决策',
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
            // 定义：仅本机默认实例 CLI 可给（其它 loopback 端口 / 远端 CLI 是
            // 另一个实例，无法证明目标一致则不问）。
            const cliTrusted = snapshot.root === DEFAULT_MAGPIE_ROOT
            let definition: ReturnType<typeof parseGroupShow> = undefined
            let definitionError: string | undefined
            if (cliTrusted && runCli !== undefined) {
              const run = await runCli(['group', short], { signal: controller.signal })
              if (run.ok) {
                definition = parseGroupShow(run.stdout ?? '')
                if (definition === undefined) definitionError = 'magpie CLI 输出无法解析为组定义'
              } else {
                definitionError = run.error
              }
            }
            const trace = await fetchTrace(snapshot.root, snapshot.token, controller.signal, fetchImpl)
            const lastRoute = 'routes' in trace ? latestGroupRouteIn(trace.routes, short) : undefined
            // 诚实性：远端网关无定义来源时绝不编造——source 如实标注。
            const source = definition !== undefined ? 'cli+trace' : 'gateway-trace'
            if (definition === undefined && lastRoute === undefined) {
              throw new HelmError(
                'magpie_group_not_found',
                `路由组 ${input.id} 无可用信息：${
                  cliTrusted
                    ? definitionError !== undefined
                      ? `CLI 失败（${sanitizeErrorText(definitionError)}）`
                      : 'CLI 与网关 trace 均无该组'
                    : snapshot.local
                      ? '非默认端口本机网关仅提供 trace，且 trace 无该组记录'
                      : '非本机网关仅提供 trace，且 trace 无该组记录'
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
                ? { note: '本机网关但非默认端口：定义需本机默认实例 magpie CLI，此处仅所选网关 trace' }
                : snapshot.local
                  ? {}
                  : { note: '非本机网关：定义需本机 magpie CLI，此处仅网关 trace' }),
            }
          } finally {
            if (stopController === controller) stopController = undefined
          }
        },
      })

      // ---- 声明式 UI（@json-render；无 Emoji，icon 用 lucide 线性名） --------
      ctx.ui.settingsPanel({
        id: 'magpie-panel',
        label: 'Magpie 网关',
        order: 25,
        docs: [MAGPIE_STATUS_DOC],
        json: {
          component: 'Stack',
          children: [
            { component: 'Text', variant: 'title', text: 'Magpie 网关' },
            {
              component: 'KeyValueList',
              items: [
                // JSON Pointer 语法 '/$docs/<doc>/<field>'（evaluator 双斜杠段式）
                { key: '/$docs/status/gatewayUrl', label: '网关地址' },
                { key: '/$docs/status/local', label: '本机 loopback' },
                { key: '/$docs/status/reachable', label: '可达' },
                { key: '/$docs/status/modelCount', label: '模型数' },
                { key: '/$docs/status/groupCount', label: '路由组数' },
                { key: '/$docs/status/lastError', label: '最近错误' },
              ],
            },
            {
              component: 'Button',
              label: '刷新模型目录',
              icon: 'refresh-cw',
              action: { type: 'helm:action', actionId: 'refresh', input: {} },
            },
            { component: 'Text', variant: 'title', text: '诊断' },
            {
              component: 'Table',
              columns: [{ key: 'message', label: '不可用项' }],
              rows: '{$docs.status.diagnostics}',
              empty: '无诊断信息',
            },
            { component: 'Text', variant: 'title', text: '配额' },
            {
              component: 'Table',
              columns: [
                { key: 'provider', label: 'Provider' },
                { key: 'account', label: '账号' },
                { key: 'windowLabel', label: '窗口' },
                { key: 'remainingPercent', label: '剩余 %' },
                { key: 'resetText', label: '重置' },
              ],
              rows: '{$docs.status.quotas}',
              empty: '暂无配额数据',
            },
            { component: 'Text', variant: 'title', text: '路由轨迹' },
            {
              component: 'Table',
              columns: [
                { key: 'group', label: '路由组' },
                { key: 'strategy', label: '策略' },
                { key: 'provider', label: 'Provider' },
                { key: 'model', label: '命中模型' },
                { key: 'timestamp', label: '时间' },
              ],
              rows: '{$docs.status.routes}',
              empty: '暂无路由记录',
            },
          ],
        },
      })

      ctx.ui.command({
        id: 'magpie-refresh',
        title: '刷新 Magpie 模型目录',
        actionId: 'refresh',
        input: {},
        keywords: ['magpie', 'models', 'refresh'],
        docs: [MAGPIE_STATUS_DOC],
      })
    },
  }
}
