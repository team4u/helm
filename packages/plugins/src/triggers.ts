/**
 * builtin:triggers: the cron and webhook inbound connector (design doc §4.4).
 *
 * Responsibilities:
 * - Assemble the shared dispatchTrigger helper (delivery.ts: target resolution + isClosing gate,
 *   delivered via host.dispatchTrigger with unified defang anti-escape);
 * - The webhook connector (webhook.ts: HMAC-verified public route + lifecycle actions + the
 *   secret persisted in credentials.json pluginSecrets, bound to this plugin's namespace via
 *   ctx.host.secrets, globally redacted via addRedaction);
 * - The cron connector (cron.ts: persistent scheduling and lifecycle actions);
 * - The declarative management UI is now client.tsx React components (screen 'manager' subscribing to
 *   the crons/webhooks public docs; actions via ctx.callAction; no Emoji, lucide line icons).
 *
 * Honesty boundaries:
 * - The webhook secret is configurable only via manual HTTP/CLI; conversation contexts (run_action)
 *   are rejected from creating it -- the raw secret is already in the model tool history, and this
 *   plugin cannot clean a secret already in context;
 * - create/delete has no cross-store transaction: sequential writes + explicit rollback/errors;
 *   doc.flush() really flushes before success; atomic exactly-once is not promised (the restart catch-up policy
 *   is declared in the cron module docs).
 */
import { HelmxError, type PluginDefinition } from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import { TRIGGERS_PLUGIN_ID } from './triggers/contracts.js'
import { createDeliveryDispatch } from './triggers/delivery.js'
import { registerWebhook } from './triggers/webhook.js'
import { registerCron } from './triggers/cron.js'

const TRIGGERS_SCREEN_ID = 'manager'
export { TRIGGERS_PLUGIN_ID }

export function createTriggersPlugin(): PluginDefinition {
  return {
    id: TRIGGERS_PLUGIN_ID,
    name: { en: 'Triggers (cron + webhook)', 'zh-CN': '触发器（cron + webhook）' },
    description: {
      en: 'Inbound connector: cron timers and webhook inbound triggers, delivered to target conversations via escape-proof envelopes.',
      'zh-CN': '入站连接器：cron 定时与 webhook 入站触发，经防逃逸信封投递到目标会话。',
    },
    icon: 'webhook',
    version: '0.1.0',
    ...resolvePluginClientAssets(TRIGGERS_PLUGIN_ID, 'triggers', 'triggers_plugin_client_missing'),
    definePlugin(ctx) {
      // Shared delivery helper: cron (targetProfileId as the second argument) and webhook (the envelope
      // carries an already-resolved target) share one implementation; isClosing is checked inside the
      // helper (a reader-function wrapper over the ctx.host getter).
      const dispatch = createDeliveryDispatch({
        host: ctx.host,
        profiles: ctx.host.profiles,
        isClosing: () => ctx.host.isClosing,
      })

      registerWebhook(ctx, { dispatch })

      registerCron(ctx, { dispatchTrigger: dispatch })

      // ---- Management UI (client.tsx React track; no Emoji) ----
      ctx.ui.sidebarItem({
        id: 'triggers-manager',
        label: { en: 'Trigger Manager', 'zh-CN': '触发器管理' },
        icon: 'clock',
        target: `screen:${TRIGGERS_PLUGIN_ID}/${TRIGGERS_SCREEN_ID}`,
        order: 15,
      })
      ctx.ui.screen({
        id: TRIGGERS_SCREEN_ID,
        label: { en: 'Trigger Manager', 'zh-CN': '触发器管理' },
        icon: 'clock',
        client: { module: 'index.tsx', export: 'TriggersManagerScreen' },
      })
      ctx.ui.settingsPanel({
        id: 'triggers-settings',
        label: { en: 'Triggers', 'zh-CN': '触发器' },
        order: 40,
        client: { module: 'index.tsx', export: 'TriggersSettingsPanel' },
      })
    },
  }
}
