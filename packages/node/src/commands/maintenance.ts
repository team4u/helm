/**
 * 维护命令：upgrade（自升级）/ doctor（只读自检）/ service（开机自启管理）。
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
  // --check 纯查询：直接读引擎，不启动 daemon、不升级。
  if (check) {
    const { checkNodeUpgrade } = await import('../daemon/upgrader.js');
    const result = await checkNodeUpgrade(dataDir, {
      ...(registryUrl !== undefined ? { registryUrl } : {}),
    });
    emit({ ok: true, ...result, dataDir });
    return 0;
  }
  // 执行升级：需要既有受管 daemon（不假称离线已升级）。
  const record = await readPidRecord(dataDir);
  if (record === null) {
    throw new UsageError(
      '执行升级需要受管守护进程在运行：请先 helm-node start -d（离线状态无法升级，不伪造成功）',
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
      `升级请求失败：控制通道不可达或响应无效（endpoint ${record.endpoint}，升级中 daemon 可能已让位；请用 helm-node status 确认当前实例后重试）`,
    );
  }
  if (response.ok !== true) {
    throw new Error(`升级被拒（${response.error ?? 'unknown'}）；若为 upgrade_in_progress 请等待当前升级完成`);
  }
  // 边界校验：upgrade 响应必须是合法的升级结果对象（ok===true、upgraded
  // 布尔、version 字段完整），不合法不输出伪造成功（诚实性纪律）。
  const result = validateUpgradeResult(response.result);
  const sourcePid = record.pid; // 旧源 pid（仅展示参考，不覆盖新实例 pid）
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
    io.out(`helm-node doctor（dataDir=${report.dataDir}${report.nodeId !== undefined ? `，nodeId=${report.nodeId}` : ''}${report.hubUrl !== undefined ? `，hub=${report.hubUrl}` : ''}）\n`);
    for (const check of report.checks) {
      io.out(`  [${label[check.status] ?? check.status}] ${check.id}: ${check.message}\n`);
    }
    io.out(report.ok ? '自检结果：通过（无 error 项）\n' : '自检结果：存在 error 项，请按提示修复后重试\n');
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
