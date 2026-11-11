/**
 * 插件模块公共出口：PluginHost、Hook 管道、Schema 校验与任务跟踪。
 * 契约类型统一从 @helm/protocol 再导出，保证消费方单一依赖入口。
 */
export * from './plugin-host.js';
export { loadExternalPlugins, type ExternalPluginHost, type ReloadablePluginHost, reloadExternalPlugin, rescanExternalPlugins } from './external-loader.js';
export { registerPluginTsRoot, nextPluginGeneration } from './backend-ts-loader.js';
export { doctorPluginDir } from './plugin-doctor.js';
export { PluginPackageManager, defaultPackageRunner, tailLines, type PackageRunner, type PackageManagerHost, type PluginPackageManagerOptions } from './package-manager.js';
export { PluginPackageManagerStore } from './package-store.js';
export { parsePluginSource } from './package-source.js';
export { compilePluginClientModule, assertModuleRefShape, CLIENT_SHARED_EXTERNALS } from './client-compiler.js';
export { HookPipeline, HOOK_ALLOWED_ACTIONS, assertHookPayload, type RegisteredHook } from './hooks.js';
export { PluginTaskTracker } from './tracking.js';
export { validatePluginInput, validatePluginOutput, validateOrThrow, assertSchemaCompilable } from './schema.js';
