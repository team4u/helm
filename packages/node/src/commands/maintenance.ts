/**
 * maintain command:upgrade(self upgrade)/ doctor(only read self inspect)/ service(open machine self start manage).
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
  // --check pure query: directly read engine, do not start daemon, do not upgrade.
  if (check) {
    const { checkNodeUpgrade } = await import('../daemon/upgrader.js');
    const result = await checkNodeUpgrade(dataDir, {
      ...(registryUrl !== undefined ? { registryUrl } : {}),
    });
    emit({ ok: true, ...result, dataDir });
    return 0;
  }
  // execute upgrade: need to since has managed daemon(do not false call offline already upgrade).
  const record = await readPidRecord(dataDir);
  if (record === null) {
    throw new UsageError(
      'execute upgrade need to managed daemon in run: please first helm-node start -d(offline state cannot upgrade, do not fabricate succeeded)',
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
      `upgrade request failed: control channel cannot reach or response invalid (endpoint ${record.endpoint}, upgrade in daemon may already let; please use helm-node status confirm when before instance after retry)`,
    );
  }
  if (response.ok !== true) {
    throw new Error(`upgrade by refuse (${response.error ?? 'unknown'}); if is upgrade_in_progress please wait for when before upgrade complete`);
  }
  // boundary validate:upgrade response must be legal upgrade result object (ok===true,upgraded
  // boolean,version field complete), illegal do not output fabricate succeeded (honest discipline).
  const result = validateUpgradeResult(response.result);
  const sourcePid = record.pid; // old source pid(only render see, does not override new instance pid)
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
    io.out(`helm-node doctor(dataDir=${report.dataDir}${report.nodeId !== undefined ? `,nodeId=${report.nodeId}` : ''}${report.hubUrl !== undefined ? `,hub=${report.hubUrl}` : ''})\n`);
    for (const check of report.checks) {
      io.out(`  [${label[check.status] ?? check.status}] ${check.id}: ${check.message}\n`);
    }
    io.out(report.ok ? 'self inspect result: via (without error items)\n' : 'self inspect result: store in error items, please by hint fix after retry\n');
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
