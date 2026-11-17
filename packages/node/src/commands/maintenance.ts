/**
 * Maintenance commands: `upgrade` (self-upgrade), `doctor` (read-only diagnostics), `service` (OS service management).
 */
import { UsageError, readPidRecord } from '../cli-context.js';
import { controlRequest, CONTROL_UPGRADE_TIMEOUT_MS, validateUpgradeResult } from '../control.js';
import { flagString, resolveHubUrl, type CommandContext } from './shared.js';
import { resolveServiceEntry } from '../service-entry.js';

export async function upgradeCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const registryUrl = flagString(parsed, 'registry');
  const targetVersion = flagString(parsed, 'version');
  const check = parsed.flags.get('check') === true;
  const force = parsed.flags.get('force') === true;
  // `--check` is read-only and never starts a daemon or mutates state.
  if (check) {
    const { checkNodeUpgrade } = await import('../daemon/upgrader.js');
    const result = await checkNodeUpgrade(dataDir, {
      ...(registryUrl !== undefined ? { registryUrl } : {}),
    });
    emit({ ok: true, ...result, dataDir });
    return 0;
  }
  // Executing an upgrade requires a live managed daemon.
  const record = await readPidRecord(dataDir);
  if (record === null) {
    throw new UsageError(
      'executing an upgrade requires a running managed daemon: run helm-node start -d first (cannot upgrade offline)',
      'not_running',
    );
  }
  const input = {
    ...(targetVersion !== undefined ? { targetVersion } : {}),
    ...(registryUrl !== undefined ? { registryUrl } : {}),
    ...(force ? { force: true } : {}),
  };
  const response = await controlRequest(
    record.endpoint,
    { type: 'upgrade', instanceId: record.instanceId, input },
    CONTROL_UPGRADE_TIMEOUT_MS,
    { pid: record.pid, instanceId: record.instanceId },
  );
  if (response === null) {
    throw new Error(
      `upgrade request failed: control channel unreachable or invalid response (endpoint ${record.endpoint}; daemon may have yielded during upgrade; check helm-node status before retrying)`,
    );
  }
  if (response.ok !== true) {
    throw new Error(`upgrade rejected (${response.error ?? 'unknown'}); if upgrade_in_progress, wait for the current upgrade to finish`);
  }
  // Validate response schema before emitting success.
  const result = validateUpgradeResult(response.result);
  const sourcePid = record.pid;
  emit({
    ok: true,
    ...result,
    previousPid: sourcePid,
    dataDir,
  });
  return 0;
}

export async function doctorCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const { runNodeDoctor } = await import('../daemon/doctor.js');
  const report = await runNodeDoctor({
    dataDir,
    ...(flagString(parsed, 'hub') !== undefined ? { hubUrl: flagString(parsed, 'hub') } : {}),
    env: io.env,
  });
  if (parsed.json) {
    emit(report);
  } else {
    const label: Record<string, string> = { ok: 'OK  ', warn: 'WARN', error: 'FAIL', info: 'INFO' };
    io.out(`helm-node doctor (dataDir=${report.dataDir}${report.nodeId !== undefined ? `, nodeId=${report.nodeId}` : ''}${report.hubUrl !== undefined ? `, hub=${report.hubUrl}` : ''})\n`);
    for (const check of report.checks) {
      io.out(`  [${label[check.status] ?? check.status}] ${check.id}: ${check.message}\n`);
    }
    io.out(report.ok ? 'doctor result: passed (no errors)\n' : 'doctor result: errors found; fix the reported issues and retry\n');
  }
  return report.ok ? 0 : 1;
}

export async function serviceCommand(ctx: CommandContext): Promise<number> {
  const { io, parsed, dataDir, emit } = ctx;
  const action = parsed.positional[0];
  const { installNodeService, uninstallNodeService, getNodeServiceStatus } = await import('../daemon/service.js');
  const cliEntryPath = io.serviceEntry ?? resolveServiceEntry();
  if (action === 'install') {
    const hubUrl = await resolveHubUrl(io, parsed, false);
    const result = await installNodeService(cliEntryPath, dataDir, {
      ...(hubUrl !== '' ? { hubUrl } : {}),
    });
    emit(result);
    return result.ok ? 0 : 1;
  }
  if (action === 'uninstall') {
    const result = await uninstallNodeService(cliEntryPath, dataDir);
    emit(result);
    return result.ok ? 0 : 1;
  }
  const status = await getNodeServiceStatus(cliEntryPath, dataDir);
  emit(status);
  return 0;
}
