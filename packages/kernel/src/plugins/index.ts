/**
 * Public exports for the plugin host module: PluginHost, hook pipeline, schema validation, and task tracking.
 * Protocol contract types are re-exported from `@helm/protocol` as the single source of truth.
 */
export * from './plugin-host.js';
export { reloadExternalPlugin, type ExternalPluginHost, type ReloadablePluginHost } from './external-loader.js';
export { loadExternalPlugins, rescanExternalPlugins } from './scan-visitor.js';
export { readHelmClientDependencies, readHelmClientDist } from './plugin-manifest.js';
export { readPrebuiltClientManifest, readPrebuiltClientBundle, type LoadedPrebuiltClientManifest } from './ui-registry.js';
export { registerPluginTsRoot, nextPluginGeneration, type BackendTsTransformFn } from './backend-ts-loader.js';
export { doctorPluginDir } from './plugin-doctor.js';
export { PluginPackageManager, defaultPackageRunner, tailLines, type PackageRunner, type PackageManagerHost, type PluginPackageManagerOptions } from './package-manager.js';
export { PluginPackageManagerStore } from './package-store.js';
export { parsePluginSource } from './package-source.js';
export { HookPipeline, HOOK_ALLOWED_ACTIONS, assertHookPayload, type RegisteredHook } from './hooks.js';
export { PluginTaskTracker } from './tracking.js';
export { validatePluginInput, validatePluginOutput, validateOrThrow, assertSchemaCompilable } from './schema.js';
