/**
 * Hub HTTP/SSE 传输层。
 *
 * - createHubHandler(kernel)：Web Standard handler（可独立于 node:http 测试）。
 * - startHub(options)：node:http 监听（默认 3202 / 127.0.0.1；测试用 port: 0）。
 */
export { createHubHandler, isPublicPluginRoute, type HubHandlerOptions } from './hub.js'
export { startHub, toWebRequest, writeWebResponse, type NodeHubHandle } from './node-server.js'
export { createStaticServe, StaticServe } from './static.js'
export {
  DEFAULT_MAX_BODY_BYTES,
  ALLOWED_CORS_ORIGINS,
  jsonOk,
  errorResponse,
  errorToResponse,
  makeJsonRedactor,
  readBinaryBodyWithLimit,
  readJsonBody,
  readJsonValue,
  type JsonRedactor,
} from './http-utils.js'
export { decodeSegment, decodeSegments, matchFullPath, PathDecodeError } from './route-match.js'
export { openSse, type SseSink } from './sse.js'
export {
  parseConversationCompactBody,
  parseConversationForkBody,
  parseConversationResetBody,
  parseDetailPagination,
  parseInputBody,
  ValidationError,
} from './validate.js'
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
  SessionDocEventPort,
  SkillService,
  StartHubOptions,
  HubHandle,
} from './contracts.js'
