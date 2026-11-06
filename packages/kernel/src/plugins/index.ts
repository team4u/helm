/**
 * 插件模块公共出口：PluginHost、Hook 管道、Schema 校验与任务跟踪。
 * 契约类型统一从 @helm/protocol 再导出，保证消费方单一依赖入口。
 */
export * from './plugin-host.js';
export { HookPipeline, HOOK_ALLOWED_ACTIONS, assertHookPayload, type RegisteredHook } from './hooks.js';
export { PluginTaskTracker } from './tracking.js';
export { validatePluginInput, validatePluginOutput, validateOrThrow } from './schema.js';
