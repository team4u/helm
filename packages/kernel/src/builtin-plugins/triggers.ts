/**
 * builtin:triggers：cron 与 webhook 入站连接器（设计文档 §4.4）。
 *
 * 职责：
 * - 组装共享 dispatchTrigger helper（delivery.ts：目标解析 + isClosing 门禁，
 *   经 host.dispatchTrigger 统一 defang 防逃逸投递）；
 * - webhook 连接器（webhook.ts：HMAC 验签公开路由 + 生命周期动作 + secret
 *   持久化于 credentials.json pluginSecrets，stash 全局脱敏）；
 * - cron 连接器（cron.ts：持久调度与生命周期动作）；
 * - 声明式管理 UI 改为 client.tsx React 组件（screen 'manager' 订阅 crons/webhooks
 *   公共 doc；动作经 ctx.callAction；无 Emoji，icon 用 lucide 线性名）。
 *
 * 诚实性边界：
 * - webhook secret 仅允许人工 HTTP/CLI 配置；拒绝会话上下文（run_action）
 *   创建——raw secret 已进模型工具历史，本插件无法清理已入上下文的秘密；
 * - create/delete 无跨存储事务：顺序写入 + 显式回滚/报错，成功前 flushDocs，
 *   不承诺原子 exactly-once（重启 catch-up 策略由 cron 模块文档声明）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { TRIGGERS_PLUGIN_ID, type TriggersDependencies } from './triggers/contracts.js'
import { createDeliveryDispatch } from './triggers/delivery.js'
import { registerWebhook } from './triggers/webhook.js'
import { registerCron } from './triggers/cron.js'

export const TRIGGERS_SCREEN_ID = 'manager'
export { TRIGGERS_PLUGIN_ID }

/** clientRoot 兼容 src / dist 运行路径（与 workflow/herdr/memory 插件同机制）。 */
function resolveTriggersClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'triggers', 'client')
  if (existsSync(local)) return local
  const pkgRoot = dirname(dirname(here))
  const srcFallback = join(pkgRoot, 'src', 'builtin-plugins', 'triggers', 'client')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError(
    'triggers_plugin_client_missing',
    `内置插件 ${TRIGGERS_PLUGIN_ID} 找不到 client 组件目录（期望 ${local} 或 ${srcFallback}）`,
    500,
  )
}

export function createTriggersPlugin(deps: TriggersDependencies): PluginDefinition {
  return {
    id: TRIGGERS_PLUGIN_ID,
    name: '触发器（cron + webhook）',
    version: '0.1.0',
    clientRoot: resolveTriggersClientRoot(),
    definePlugin(ctx) {
      // 共享投递 helper：cron（targetProfileId 第二参）与 webhook（envelope
      // 携带已解析 target）同一实现；isClosing 在 helper 内检查。
      const dispatch = createDeliveryDispatch({
        host: ctx.host,
        profiles: deps.profiles,
        isClosing: deps.isClosing,
      })

      registerWebhook(ctx, {
        credentials: deps.credentials,
        stash: deps.stash,
        profiles: deps.profiles,
        dispatch,
        flushDocs: deps.flushDocs,
      })

      registerCron(ctx, {
        dispatchTrigger: dispatch,
        flush: deps.flushDocs,
      })

      // ---- 管理 UI（client.tsx React 轨道；无 Emoji） ----
      ctx.ui.sidebarItem({
        id: 'triggers-manager',
        label: '触发器管理',
        icon: 'clock',
        target: `screen:${TRIGGERS_PLUGIN_ID}/${TRIGGERS_SCREEN_ID}`,
        order: 15,
      })
      ctx.ui.screen({
        id: TRIGGERS_SCREEN_ID,
        label: '触发器管理',
        icon: 'clock',
        client: { module: 'index.tsx', export: 'TriggersManagerScreen' },
      })
      ctx.ui.settingsPanel({
        id: 'triggers-settings',
        label: '触发器',
        order: 40,
        client: { module: 'index.tsx', export: 'TriggersSettingsPanel' },
      })
    },
  }
}
