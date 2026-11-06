/**
 * Hub HTTP/SSE 传输层。
 *
 * - createHubHandler(kernel, workflows)：Web Standard handler（可独立于 node:http 测试）。
 * - startHub(options)：node:http 监听（默认 3202 / 127.0.0.1；测试用 port: 0）。
 */
export { createHubHandler, isPublicPluginRoute } from './hub.js'
export { startHub, toWebRequest, writeWebResponse, type NodeHubHandle } from './node-server.js'
export {
  DEFAULT_MAX_BODY_BYTES,
  MAX_WORKFLOW_BODY_BYTES,
  ALLOWED_CORS_ORIGINS,
  jsonOk,
  errorResponse,
  errorToResponse,
} from './http-utils.js'
export { openSse, type SseSink } from './sse.js'
export type {
  AuthService,
  ArtifactService,
  CredentialService,
  EventHub,
  KernelRuntimeLike,
  PluginHost,
  PluginRouteInfo,
  ProfileService,
  ProviderService,
  SkillService,
  StartHubOptions,
  HubHandle,
  WorkflowServiceLike,
} from './contracts.js'
