/**
 * Node-daemon control channel surface: the transport lives in `@helmx/env-io` (`control.ts`,
 * shared with the local Hub); this module keeps the node-specific pieces — the daemon ready
 * states and the strict boundary validation for control-channel upgrade results.
 */
import { UsageError } from './cli-context.js';

export {
  controlEndpoint,
  controlRequest,
  createControlServer,
  CONTROL_TIMEOUT_MS,
  CONTROL_STOP_TIMEOUT_MS,
  CONTROL_UPGRADE_TIMEOUT_MS,
  CONTROL_MAX_LINE_BYTES,
  STOP_EXIT_TIMEOUT_MS,
  type ControlRequest,
  type ControlResponse,
  type ControlServer,
} from '@helmx/env-io';

/** Background daemon readiness state: `registered` (Hub registration succeeded) or `starting` (reconnecting). */
export type DaemonReadyState = 'registered' | 'starting';

/** Total timeout waiting for daemon readiness reporting. */
export const READY_TIMEOUT_MS = 45_000;

/** Delay before the old daemon exits after committing an upgrade so the RPC response flushes. */
export const UPGRADE_EXIT_DELAY_MS = 100;

/** Endpoint prefix namespacing the node daemon's control sockets. */
export const NODE_CONTROL_PRODUCT = 'helmx-node';

/**
 * Boundary validation for control-channel upgrade results: requires `ok === true`, boolean
 * `upgraded`, non-empty `previousVersion`/`targetVersion`, and positive integer `pid` when upgraded.
 */
export function validateUpgradeResult(
  raw: unknown,
): { previousVersion: string; targetVersion: string; upgraded: boolean; pid?: number } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new UsageError('upgrade response is not a valid object (refusing to assume success; check actual state with helmx-node status)', 'invalid_upgrade_result');
  }
  const record = raw as Record<string, unknown>;
  if (record['ok'] !== true) {
    throw new UsageError(
      `upgrade response ok is not true (${JSON.stringify(record['ok'] ?? '(missing)')}; refusing to assume success)`,
      'invalid_upgrade_result',
    );
  }
  if (typeof record['upgraded'] !== 'boolean') {
    throw new UsageError('upgrade response is missing boolean field upgraded (refusing to assume success)', 'invalid_upgrade_result');
  }
  for (const key of ['previousVersion', 'targetVersion'] as const) {
    if (typeof record[key] !== 'string' || (record[key] as string) === '') {
      throw new UsageError(`upgrade response is missing non-empty string ${key} (refusing to assume success)`, 'invalid_upgrade_result');
    }
  }
  const pid = record['pid'];
  if ((record['upgraded'] || pid !== undefined) && (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new UsageError('upgrade response is missing positive integer pid for replacement instance (refusing to assume success)', 'invalid_upgrade_result');
  }
  return {
    previousVersion: record['previousVersion'] as string,
    targetVersion: record['targetVersion'] as string,
    upgraded: record['upgraded'] as boolean,
    ...(typeof pid === 'number' ? { pid } : {}),
  };
}
