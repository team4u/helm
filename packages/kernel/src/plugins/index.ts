/**
 * plugin module public exports:PluginHost,Hook pipeline,Schema validate and task trace.
 * contract type unify from @helm/protocol again export, guarantee consumer single one dependency entry.
 */
export * from './plugin-host.js';
export { reloadExternalPlugin, type ExternalPluginHost, type ReloadablePluginHost } from './external-loader.js';
export { loadExternalPlugins, rescanExternalPlugins } from './scan-visitor.js';
export { readHelmClientDependencies } from './plugin-manifest.js';
export { registerPluginTsRoot, nextPluginGeneration, type BackendTsTransformFn } from './backend-ts-loader.js';
export { doctorPluginDir } from './plugin-doctor.js';
export { PluginPackageManager, defaultPackageRunner, tailLines, type PackageRunner, type PackageManagerHost, type PluginPackageManagerOptions } from './package-manager.js';
export { PluginPackageManagerStore } from './package-store.js';
export { parsePluginSource } from './package-source.js';
export { HookPipeline, HOOK_ALLOWED_ACTIONS, assertHookPayload, type RegisteredHook } from './hooks.js';
export { PluginTaskTracker } from './tracking.js';
export { validatePluginInput, validatePluginOutput, validateOrThrow, assertSchemaCompilable } from './schema.js';
