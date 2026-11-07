/**
 * @helm/node —— 跨平台受控节点守护进程包（helm-node）。
 *
 * 编程出口：createNodeDaemon / runNodeDaemon / runNodeDaemonHandle（daemon）、
 * createNodeEnvRpcServer（每连接一代 env RPC server）与跨平台服务管理（service）。
 */
export {
  createNodeEnvRpcServer,
  type NodeEnvRpcServer,
  type NodeEnvRpcServerOptions,
} from './daemon/env-rpc-server.js';
export {
  bindIdentityFromJoinToken,
  createNodeDaemon,
  parseJoinToken,
  readNodeIdentity,
  resolveNodeDataDir,
  runNodeDaemon,
  runNodeDaemonHandle,
  writeNodeIdentity,
  type HubSideFunctions,
  type NodeDaemon,
  type NodeDaemonOptions,
  type NodeIdentity,
} from './daemon/index.js';
export {
  defaultServiceExec,
  getNodeServiceStatus,
  installNodeService,
  renderServiceSpec,
  uninstallNodeService,
  type ServiceExec,
  type ServiceOperationOptions,
  type ServiceOperationResult,
  type ServiceRunningState,
  type ServiceSpec,
  type ServiceSpecOptions,
  type NodeServiceStatus,
} from './daemon/service.js';
export { runNodeCli, isDirectRun, resolveServiceEntry, type NodeCliIo, type DaemonReadyState } from './cli.js';
