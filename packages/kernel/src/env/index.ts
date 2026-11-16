/**
 * kernel env domain public exports: across platform node connection pool and execute environment orchestration.
 * local constant is process inside NodeExecutionEnv; remote via /ws/node WS+birpc invoke
 * node daemon NodeEnvRpcFunctions, never static default fall back local.
 */

export { createEnvFabric } from './fabric.js'
export type { EnvFabric, EnvFabricOptions, EnvOptionsComposer } from './fabric.js'
export { createScopedExecutionEnv, MANAGED_EXEC_ENV_VARS } from './scoped-env.js'
export type { EnvTarget, ScopedExecutionEnv } from './scoped-env.js'
export { envWithFileMutationQueue, localWithFileMutationQueue } from './file-mutation-queue.js'
export { NodeRegistry, tokenAuthenticator, sha256hex, sanitizeNodeHealth, normalizeTunnelTarget, HelmUpgradeBusyError, HelmUpgradeTimeoutError, HelmUpgradeCancelledError } from './registry.js'
export type { NodeRegistryOptions, NodeConnection, RegisterOutcome, HubConnectionLocal, NodeSideFunctions, UpgradeWaiterHandle } from './registry.js'
export { RemoteExecutionEnv } from './remote-env.js'
export type { NodeRpcResolver, RemoteExecutionEnvOptions } from './remote-env.js'
export { ExecOutputHub } from './exec-output.js'
export { attachNodeWsGateway } from './ws-gateway.js'
export type { NodeWsGateway, NodeWsGatewayOptions } from './ws-gateway.js'
export { attachNodeTunnelGateway } from './ws-tunnel-gateway.js'
export type { NodeTunnelGateway, NodeTunnelGatewayOptions } from './ws-tunnel-gateway.js'
export { NodeForwardService, parseNodeForwardInput, NODE_FORWARD_LEASE_TIMEOUT_MS } from './forward.js'
export type { NodeForwardInput, NodeForwardSession, NodeForwardEvent } from './forward.js'
