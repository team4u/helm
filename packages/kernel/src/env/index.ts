/**
 * kernel env 域公共出口：跨平台节点连接池与执行环境编排。
 * local 恒为进程内 NodeExecutionEnv；远端经 /ws/node WS+birpc 调用
 * 节点守护进程的 NodeEnvRpcFunctions，绝不静默回退 local。
 */

export { createEnvFabric } from './fabric.js'
export type { EnvFabric, EnvFabricOptions, EnvOptionsComposer } from './fabric.js'
export { createScopedExecutionEnv } from './scoped-env.js'
export type { EnvTarget, ScopedExecutionEnv } from './scoped-env.js'
export { NodeRegistry, tokenAuthenticator, sha256hex, sanitizeNodeHealth } from './registry.js'
export type { NodeRegistryOptions, NodeConnection, RegisterOutcome, HubConnectionLocal, NodeSideFunctions } from './registry.js'
export { RemoteExecutionEnv } from './remote-env.js'
export type { NodeRpcResolver, RemoteExecutionEnvOptions } from './remote-env.js'
export { ExecOutputHub } from './exec-output.js'
export { attachNodeWsGateway } from './ws-gateway.js'
export type { NodeWsGateway, NodeWsGatewayOptions } from './ws-gateway.js'
