/**
 * builtin:triggers：cron 与 webhook 入站连接器（设计文档 §4.4）。
 *
 * 职责：
 * - 组装共享 dispatchTrigger helper（delivery.ts：目标解析 + isClosing 门禁，
 *   经 host.dispatchTrigger 统一 defang 防逃逸投递）；
 * - webhook 连接器（webhook.ts：HMAC 验签公开路由 + 生命周期动作 + secret
 *   持久化于 credentials.json pluginSecrets，stash 全局脱敏）；
 * - cron 连接器经 deps.registerCron 注入（cron.ts 由并行模块实现；本文件
 *   不静态依赖，保持可独立编译验证）；
 * - 声明式管理 UI（screen 'manager' 订阅 crons/webhooks 公共 doc；动作经
 *   helm:action 挂载；无 Emoji，icon 用 lucide 线性名）。
 *
 * 诚实性边界：
 * - webhook secret 仅允许人工 HTTP/CLI 配置；拒绝会话上下文（run_action）
 *   创建——raw secret 已进模型工具历史，本插件无法清理已入上下文的秘密；
 * - create/delete 无跨存储事务：顺序写入 + 显式回滚/报错，成功前 flushDocs，
 *   不承诺原子 exactly-once（重启 catch-up 策略由 cron 模块文档声明）。
 */
import type { PluginDefinition } from '@helm/protocol'
import { TRIGGERS_PLUGIN_ID, type TriggersDependencies } from './triggers/contracts.js'
import { createDeliveryDispatch } from './triggers/delivery.js'
import { registerWebhook } from './triggers/webhook.js'

export const TRIGGERS_SCREEN_ID = 'manager'
export { TRIGGERS_PLUGIN_ID }

export function createTriggersPlugin(deps: TriggersDependencies): PluginDefinition {
  return {
    id: TRIGGERS_PLUGIN_ID,
    name: '触发器（cron + webhook）',
    version: '0.1.0',
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

      deps.registerCron(ctx, {
        dispatchTrigger: dispatch,
        flush: deps.flushDocs,
      })

      // ---- 声明式管理 UI（@json-render；无 Emoji） ----
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
        docs: ['crons', 'webhooks'],
        json: {
          component: 'Stack',
          children: [
            { component: 'Text', variant: 'title', text: 'Cron 定时任务' },
            {
              component: 'Table',
              columns: [
                { key: 'id', label: 'ID' },
                { key: 'schedule', label: '调度' },
                { key: 'text', label: '指令' },
                { key: 'enabled', label: '启用' },
                { key: 'lastRunAt', label: '上次运行' },
                { key: 'nextRunAt', label: '下次运行' },
                { key: 'lastError', label: '最近错误' },
              ],
              rows: '{$docs.crons.jobs}',
              rowActions: [
                { label: '立即触发', action: { type: 'helm:action', actionId: 'cron_trigger', input: { id: '{$row.id}' } } },
                { label: '删除', action: { type: 'helm:action', actionId: 'cron_delete', input: { id: '{$row.id}' } } },
              ],
            },
            { component: 'Text', variant: 'title', text: 'Webhook 端点' },
            {
              component: 'Table',
              columns: [
                { key: 'id', label: 'ID' },
                { key: 'description', label: '描述' },
                { key: 'threadKey', label: 'ThreadKey' },
                { key: 'createdAt', label: '创建时间' },
              ],
              rows: '{$docs.webhooks.webhooks}',
              rowActions: [
                { label: '删除', action: { type: 'helm:action', actionId: 'webhook_delete', input: { id: '{$row.id}' } } },
              ],
            },
            {
              component: 'Text',
              variant: 'muted',
              text: 'secret 不在文档中展示；创建与删除请使用 helm cron / helm webhook 命令或对应动作端点。',
            },
          ],
        },
      })
      ctx.ui.settingsPanel({
        id: 'triggers-settings',
        label: '触发器',
        order: 40,
        docs: ['crons', 'webhooks'],
        json: {
          component: 'Stack',
          children: [
            { component: 'Text', variant: 'title', text: '触发器' },
            {
              component: 'KeyValueList',
              items: [
                { key: '/$docs/crons/jobs/length', label: 'Cron 任务数' },
                { key: '/$docs/webhooks/webhooks/length', label: 'Webhook 端点数' },
              ],
            },
            {
              component: 'Text',
              variant: 'muted',
              text: 'cron 调度细节与 webhook 验签 secret 的管理请前往触发器管理视图或使用 helm CLI。',
            },
          ],
        },
      })
    },
  }
}
