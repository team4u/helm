/**
 * @helm/node - - across platform subject to control node daemon package (helm-node).
 *
 * edit process exit:createNodeDaemon / runNodeDaemon / runNodeDaemonHandle(daemon),
 * createNodeEnvRpcServer(each connect one proxy env RPC server) and across platform service manage (service).
 */
export {
  createNodeEnvRpcServer,
  type NodeEnvRpcServer,
  type NodeEnvRpcServerOptions,
} from './daemon/env-rpc-server.js';
export {
  collectNodeHealth,
  createNodeDaemon,
  bindIdentityFromJoinToken,
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
  runNodeDoctor,
  type NodeDoctorCheck,
  type NodeDoctorCheckStatus,
  type NodeDoctorOptions,
  type NodeDoctorReport,
} from './daemon/doctor.js';
export {
  UpgradeRejectedError,
  UpgradeCommitUnconfirmedError,
  checkNodeUpgrade,
  compareSemver,
  normalizeTargetVersion,
  getNodeVersion,
  resolveEffectiveNodeVersion,
  filterRpcRegistryUrl,
  stageReleaseFromNpm,
  performNodeUpgrade,
  readCurrentRelease,
  writeCurrentRelease,
  deleteCurrentRelease,
  readBlockedRelease,
  writeBlockedRelease,
  clearBlockedRelease,
  type BlockedReleaseRecord,
  type CheckNodeUpgradeOptions,
  type CurrentReleaseRecord,
  type PerformNodeUpgradeOptions,
  type PreparedNodeReplacement,
  type StageReleaseOptions,
  type StagedNodeRelease,
} from './daemon/upgrader.js';
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
export { runNodeCli, isDirectRun, resolveServiceEntry, defaultSpawnDaemon, controlEndpoint, type NodeCliIo, type DaemonReadyState, type PidRecord } from './cli.js';
