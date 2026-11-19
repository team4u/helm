/**
 * `@helmx/protocol/browser` — browser-safe contract entry.
 *
 * Re-exports only the cross-runtime DTOs, pure helpers and UI contracts that carry
 * no `node:*` and no `@earendil-works/pi-*` dependency, for browser consumers
 * such as `@helmx/web` and `@helmx/plugin-client`.
 */

export * from './conversation.js'
export * from './activity.js'
export * from './ask.js'
export * from './artifact.js'
export * from './assets.js'
export * from './env-rpc.js'
export * from './node-forward.js'
export * from './events.js'
export * from './error.js'
export * from './http.js'
export * from './locale.js'
export * from './plugin-dto.js'
export * from './plugin-build.js'
export * from './redact.js'
export * from './target-path.js'
export * from './http-body.js'
export * from './schema.js'
export * from './ui.js'
export * from './semver.js'
export * from './meta.js'
export * from './utils.js'
export * from './tool-presentation.js'
export {
  isAbsoluteAgentPath,
  sanitizeAgentExecutionInfo,
  sanitizeAgentGateResult,
  agentGateResultMissingError,
} from './agent-exec.js'
