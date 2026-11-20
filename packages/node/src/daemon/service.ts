/**
 * Node-daemon OS startup service: the renderer/executor machinery lives in `@helmx/env-io`
 * (`os-service.ts`, shared with the local Hub); this module instantiates it with the node
 * daemon's identity and invocation (`helmx-node start --data-dir <dir> [--hub <url>]`).
 */
import { join } from 'node:path';
import {
  installOsService,
  uninstallOsService,
  getOsServiceStatus,
  renderServiceSpec as renderOsServiceSpec,
  type OsServiceProfile,
  type OsServiceStatus,
  type ServiceExec,
  type ServiceOperationOptions,
  type ServiceOperationResult,
  type ServiceSpec,
} from '@helmx/env-io';

export type { ServiceExec, ServiceOperationOptions, ServiceOperationResult, ServiceSpec } from '@helmx/env-io';
export type { OsServiceStatus, ServiceRunningState } from '@helmx/env-io';
export { defaultServiceExec, SERVICE_EXEC_TIMEOUT_MS } from '@helmx/env-io';

export type NodeServiceStatus = OsServiceStatus;

/** Node-daemon service options: same shape the shared renderer accepts plus the Hub binding URL. */
export interface NodeServiceSpecOptions extends Omit<ServiceOperationOptions, never> {
  hubUrl?: string;
}

/** The node daemon's service identity and CLI invocation for the shared renderer. */
function nodeServiceProfile(dataDir: string, hubUrl?: string): OsServiceProfile {
  return {
    darwinLabel: 'ai.helmx.node',
    linuxUnit: 'helmx-node.service',
    winTask: 'HelmxNode',
    description: 'Helmx Node Daemon',
    cliArgs: ['start', '--data-dir', dataDir, ...(hubUrl !== undefined && hubUrl !== '' ? ['--hub', hubUrl] : [])],
    logPath: join(dataDir, 'node.log'),
  };
}

/** Render the node daemon's service spec for any platform (pure; used by install/uninstall/status and tests). */
export function renderServiceSpec(options: NodeServiceSpecOptions & { cliEntryPath: string; dataDir: string }): ServiceSpec {
  const { hubUrl, ...rest } = options;
  return renderOsServiceSpec({ ...rest, profile: nodeServiceProfile(options.dataDir, hubUrl) });
}

export async function installNodeService(
  cliEntryPath: string,
  dataDir: string,
  options: NodeServiceSpecOptions = {},
): Promise<ServiceOperationResult> {
  const { hubUrl, ...rest } = options;
  return await installOsService(cliEntryPath, dataDir, nodeServiceProfile(dataDir, hubUrl), rest);
}

export async function uninstallNodeService(
  cliEntryPath: string,
  dataDir: string,
  options: ServiceOperationOptions = {},
): Promise<ServiceOperationResult> {
  return await uninstallOsService(cliEntryPath, dataDir, nodeServiceProfile(dataDir), options);
}

export async function getNodeServiceStatus(
  cliEntryPath: string,
  dataDir: string,
  options: ServiceOperationOptions = {},
): Promise<NodeServiceStatus> {
  return await getOsServiceStatus(cliEntryPath, dataDir, nodeServiceProfile(dataDir), options);
}
