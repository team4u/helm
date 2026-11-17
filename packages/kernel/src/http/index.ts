/**
 * Hub HTTP/SSE transfer layer.
 *
 * - createHubHandler(kernel):Web Standard handler(can independent at node:http test).
 * - startHub(options):node:http listen (by default 3202 / 127.0.0.1; test use port: 0).
 */
export { createHubHandler, isPublicPluginRoute, type HubHandlerOptions } from './hub.js'
export { startHub, toWebRequest, writeWebResponse, type NodeHubHandle } from './node-server.js'
export { createStaticServe, StaticServe } from './static.js'
export {
  DEFAULT_MAX_BODY_BYTES,
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
  ConversationFileContent,
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
