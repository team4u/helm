/**
 * @helm/plugins 聚合出口：十一个内置插件的生产者侧工厂与公开契约。
 *
 * 消费方向（包拓扑铁律）：本包只依赖 @helm/protocol 与外部 SDK，绝不依赖
 * @helm/kernel 实现；产品组合（注册顺序与缺省启停）由 @helm/hub 负责。
 * 每个插件另提供 `@helm/plugins/<name>` 子路径出口，供按需引用。
 */
export { createProfilePlugin } from './profile.js';
export { createMemoryPlugin, MEMORY_PLUGIN_ID } from './memory.js';
export { createHerdrPlugin } from './herdr.js';
export { createWorkflowPlugin, WORKFLOW_PLUGIN_ID } from './workflow.js';
export {
  createSuperAgentPlugin,
  SUPERAGENT_PLUGIN_ID,
  SUPERAGENT_PROFILE_ID,
  WATCHDOG_PROFILE_ID,
} from './superagent.js';
export { createTriggersPlugin, TRIGGERS_PLUGIN_ID } from './triggers.js';
export {
  createAppsPlugin,
  APPS_PLUGIN_ID,
  APPS_SCREEN_ID,
  APP_BUILDER_SKILL_ID,
  APP_CATEGORIES,
  type AppCategory,
  type AppCatalogEntry,
  type AppsCatalogDoc,
} from './apps.js';
export { createJsonRenderPlugin, JSON_RENDER_PLUGIN_ID } from './json-render.js';
export { createMermaidPlugin, MERMAID_PLUGIN_ID } from './mermaid.js';
export { createMagpiePlugin, MAGPIE_PLUGIN_ID } from './magpie.js';
export { MAGPIE_PROVIDER_ID, type MagpiePluginConfig, type MagpieStatusDoc } from './magpie/contracts.js';
export { createTokenSpeedPlugin, TOKEN_SPEED_PLUGIN_ID } from './token-speed.js';
export { TOKEN_SPEED_DOC, type TokenSpeedStatus } from './token-speed/contracts.js';
export type { HerdrPluginDependencies, HerdrTransport, HerdrTarget, HerdrEvent } from './herdr/contracts.js';
