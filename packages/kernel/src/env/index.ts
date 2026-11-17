/**
 * Public exports for the kernel `env` domain: cross-platform node connection pool and execution environment orchestration.
 * `local` always runs in-process via `NodeExecutionEnv`; remote targets invoke the node daemon's `NodeEnvRpcFunctions`
 * over `/ws/node` WS+birpc and never fall back silently to local.
 */

export { createEnvFabric } from './fabric.js'
export type { EnvFabric, EnvOptionsComposer } from './fabric.js'
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
export { NodeForwardService } from './forward.js'
export type { NodeForwardInput, NodeForwardSession, NodeForwardEvent } from './forward.js'
