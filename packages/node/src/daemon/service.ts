/**
 * across platform open machine self start service:macOS launchd / Linux systemd --user / Windows schtasks.
 *
 * only do four piece matter: render service description (renderServiceSpec), write data directory Profile copy,
 * duplicate to platform takes effect location, invoke platform register command. each one step failed all explicit return
 * ok:false + message(contains failed step and reason), never static default swallow wrong or disguise succeeded;
 * system command on failure keep already write config, hand over by user retry or uninstall clean up.
 *
 * command execute via ServiceExec inject (by default is carries timeout async spawn, non-blocking event loop,
 * do not unbounded phase card die); single test inject memory execute do no side effects verify, never real install.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface ServiceSpecOptions {
  /** override process.platform(single test render three platform template use). */
  platform?: NodeJS.Platform;
  /** node can execute file path (default process.execPath). */
  nodePath?: string;
  /** helm-node CLI entry (compile artifact cli.js or tsx source entry). */
  cliEntryPath: string;
  dataDir: string;
  hubUrl?: string;
  /**
   * service file directory (default os.homedir()):launchd plist / systemd unit / Windows
   * task XML takes effect location all in this under. single test inject temp directory, ensure zero host side effect.
   */
  serviceHome?: string;
}

export interface ServiceSpec {
  platform: NodeJS.Platform;
  /** service unit Profile copy point (data directory inside). */
  configPath: string;
  /** platform takes effect path (launchd plist / systemd unit / Windows task XML). */
  targetPath: string;
  /** service unit content (plist XML / unit / task XML). */
  content: string;
  /** platform register command (argv). */
  installCmd: string[];
  /** platform unload command (argv). */
  uninstallCmd: string[];
  /** supply state probe command (argv). */
  statusCmd: string[];
}

export interface ServiceExec {
  /** execute command; return { code, stdout, stderr, timedOut }(spawn semantics;error mapping code:null + stderr). */
  run(command: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
}

export const SERVICE_EXEC_TIMEOUT_MS = 30_000;

/** by default ServiceExec: async spawn + total timeout;spawn error(ENOENT etc.) such as return code:null. */
export const defaultServiceExec: ServiceExec = {
  async run(command, args) {
    return await new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: `spawn ${command} failed: ${error instanceof Error ? error.message : String(error)}`, timedOut: false });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      let killed = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, SERVICE_EXEC_TIMEOUT_MS);
      timer.unref?.();
      const finish = (code: number | null, errorText?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          stdout,
          stderr: errorText !== undefined ? `${stderr}${stderr !== '' ? '\n' : ''}${errorText}` : stderr,
          ...(killed ? { timedOut: true } : {}),
        });
      };
      child.on('error', (error) => {
        finish(null, `cannot execute ${command}: ${error.message}`);
      });
      child.on('close', (code) => {
        finish(killed ? null : code, killed ? `command timeout (>${SERVICE_EXEC_TIMEOUT_MS}ms) by terminate: ${command}` : undefined);
      });
    });
  },
};

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

/** systemd do not via Shell; respectively escaping parameter quotes,specifier(%) and environment expand ($). */
function quoteSystemdArg(arg: string): string {
  if (/[\x00-\x1f\x7f]/.test(arg)) throw new Error('service parameter must not contains control character');
  const literal = arg.replaceAll('%', '%%').replaceAll('$', () => '$$');
  return /^[A-Za-z0-9@:,.+/_=-]+$/.test(literal) && literal !== ''
    ? literal
    : `"${literal.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function quoteWindowsArg(arg: string): string {
  if (/[\x00-\x1f\x7f]/.test(arg)) throw new Error('service parameter must not contains control character');
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

const DARWIN_LABEL = 'ai.helm.node';
const LINUX_UNIT = 'helm-node.service';
const WIN_TASK = 'HelmNode';

/** CLI start parameter (excludes node and entry itself):start --data-dir <dir> [--hub <url>]. */
function cliArgs(dataDir: string, hubUrl?: string): string[] {
  return ['start', '--data-dir', dataDir, ...(hubUrl !== undefined && hubUrl !== '' ? ['--hub', hubUrl] : [])];
}

/** render platform service description: do not, do not execute command, pure function convenient at three platform single test. */
export function renderServiceSpec(options: ServiceSpecOptions): ServiceSpec {
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;
  const home = options.serviceHome ?? os.homedir();
  const { cliEntryPath, dataDir, hubUrl } = options;

  if (platform === 'darwin') {
    const configPath = path.join(dataDir, 'service', `${DARWIN_LABEL}.plist`);
    const targetPath = path.join(home, 'Library', 'LaunchAgents', `${DARWIN_LABEL}.plist`);
    const programArgs = [nodePath, cliEntryPath, ...cliArgs(dataDir, hubUrl)];
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DARWIN_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    ${programArgs.map((a) => `<string>${escapeXml(a)}</string>`).join('\n    ')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(dataDir, 'node.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(dataDir, 'node.log'))}</string>
</dict>
</plist>
`;
    return {
      platform: 'darwin',
      configPath,
      targetPath,
      content,
      installCmd: ['launchctl', 'load', '-w', targetPath],
      uninstallCmd: ['launchctl', 'unload', '-w', targetPath],
      statusCmd: ['launchctl', 'list', DARWIN_LABEL],
    };
  }

  if (platform === 'win32') {
    const configPath = path.join(dataDir, 'service', `${WIN_TASK}.xml`);
    const targetPath = path.join(home, `${WIN_TASK}.xml`);
    const argumentsText = [cliEntryPath, ...cliArgs(dataDir, hubUrl)].map(quoteWindowsArg).join(' ');
    const account = [process.env.USERDOMAIN, process.env.USERNAME ?? os.userInfo().username].filter(Boolean).join('\\');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(account)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${escapeXml(account)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${escapeXml(nodePath)}</Command><Arguments>${escapeXml(argumentsText)}</Arguments></Exec></Actions>
</Task>
`;
    return {
      platform: 'win32', configPath, targetPath, content,
      installCmd: ['schtasks', '/Create', '/F', '/TN', WIN_TASK, '/XML', targetPath],
      uninstallCmd: ['schtasks', '/Delete', '/F', '/TN', WIN_TASK],
      statusCmd: ['schtasks', '/Query', '/TN', WIN_TASK, '/FO', 'CSV', '/NH'],
    };
  }

  if (platform === 'linux') {
    const configPath = path.join(dataDir, 'service', LINUX_UNIT);
    const targetPath = path.join(home, '.config', 'systemd', 'user', LINUX_UNIT);
    const execStart = [nodePath, cliEntryPath, ...cliArgs(dataDir, hubUrl)].map(quoteSystemdArg).join(' ');
    const content = `[Unit]
Description=Helm Node Daemon
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
    return {
      platform: 'linux',
      configPath,
      targetPath,
      content,
      installCmd: ['systemctl', '--user', 'enable', '--now', LINUX_UNIT],
      uninstallCmd: ['systemctl', '--user', 'disable', '--now', LINUX_UNIT],
      statusCmd: ['systemctl', '--user', 'is-active', LINUX_UNIT],
    };
  }

  throw new Error(`unsupported platform ${JSON.stringify(platform)}:helm-node service only support darwin / linux / win32`);
}

export interface ServiceOperationOptions {
  platform?: NodeJS.Platform;
  nodePath?: string;
  /** inject command execute (single test no side effects verify). */
  execCommand?: ServiceExec;
  /** service file directory (default os.homedir()); single test must inject temp directory. */
  serviceHome?: string;
}

export interface ServiceOperationResult {
  ok: boolean;
  platform: NodeJS.Platform;
  configPath: string;
  targetPath?: string;
  content: string;
  installed: boolean;
  message: string;
}

/** describeFailure: command failed can read diagnose (stderr > timeout > error text). */
function describeFailure(command: readonly string[], result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): string {
  const argvText = command.join(' ');
  const output = result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim();
  if (result.timedOut === true) return `${argvText} timeout not return`;
  if (result.code === null) return `${argvText} cannot execute:${output !== '' ? output : 'unknown error'}`;
  return `${argvText} exit code ${result.code}${output !== '' ? `:${output}` : ''}`;
}

/** validate register command result: non-zero exit, cannot execute or timeout all treated as failed, such as diagnose. */
function assertCommandOk(command: readonly string[], result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }, step: string): void {
  if (result.code === 0 && result.timedOut !== true) return;
  throw new Error(`${step}failed:${describeFailure(command, result)}`);
}

/** install service: render → write Profile copy → duplicate to platform takes effect path → daemon-reload(linux)→ platform register. any one step failed explicit errors. */
export async function installNodeService(
  cliEntryPath: string,
  dataDir: string,
  options: ServiceOperationOptions & { hubUrl?: string } = {},
): Promise<ServiceOperationResult> {
  const exec = options.execCommand ?? defaultServiceExec;
  const desc = renderServiceSpec({
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
    ...(options.serviceHome !== undefined ? { serviceHome: options.serviceHome } : {}),
    cliEntryPath,
    dataDir,
    ...(options.hubUrl !== undefined && options.hubUrl !== '' ? { hubUrl: options.hubUrl } : {}),
  });
  const base = {
    platform: desc.platform,
    configPath: desc.configPath,
    targetPath: desc.targetPath,
    content: desc.content,
  };

  try {
    await fsp.mkdir(path.dirname(desc.configPath), { recursive: true });
  } catch (error) {
    throw new Error(`create service config directory failed (${path.dirname(desc.configPath)}):${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await fsp.writeFile(desc.configPath, desc.content, 'utf8');
  } catch (error) {
    throw new Error(`write service config failed (${desc.configPath}):${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await fsp.mkdir(path.dirname(desc.targetPath), { recursive: true });
    await fsp.writeFile(desc.targetPath, desc.content, 'utf8');
  } catch (error) {
    throw new Error(
      `write platform service file failed (${desc.targetPath}):${error instanceof Error ? error.message : String(error)}; Profile copy already save at ${desc.configPath}`,
    );
  }

  if (desc.platform === 'linux') {
    const reloadCmd = ['systemctl', '--user', 'daemon-reload'];
    const reload = await exec.run(reloadCmd[0]!, reloadCmd.slice(1));
    assertCommandOk(reloadCmd, reload, 'systemd daemon-reload ');
  }

  const installResult = await exec.run(desc.installCmd[0]!, desc.installCmd.slice(1));
  assertCommandOk(desc.installCmd, installResult, 'system register ');
  return { ok: true, ...base, installed: true, message: `service installed (${desc.platform})` };
}

/**
 * unload service: platform deregister → delete platform file and Profile copy.
 * deregister command failed (contains cannot execute/timeout): explicit errors and**do not delete any config**, return installed keep now state.
 */
export async function uninstallNodeService(
  cliEntryPath: string,
  dataDir: string,
  options: ServiceOperationOptions = {},
): Promise<ServiceOperationResult> {
  const exec = options.execCommand ?? defaultServiceExec;
  const desc = renderServiceSpec({
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
    ...(options.serviceHome !== undefined ? { serviceHome: options.serviceHome } : {}),
    cliEntryPath,
    dataDir,
  });
  const base = {
    platform: desc.platform,
    configPath: desc.configPath,
    targetPath: desc.targetPath,
    content: desc.content,
  };

  const uninstallResult = await exec.run(desc.uninstallCmd[0]!, desc.uninstallCmd.slice(1));
  if (uninstallResult.code !== 0 || uninstallResult.timedOut === true) {
    throw new Error(
      `platform deregister failed:${describeFailure(desc.uninstallCmd, uninstallResult)}; already keep config (${desc.configPath}), can retry uninstall`,
    );
  }

  for (const file of [desc.targetPath, desc.configPath]) {
    try {
      await fsp.rm(file, { force: true });
    } catch (error) {
      throw new Error(`deregister after clean up config file failed (${file}):${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: true, ...base, installed: false, message: `service uninstalled (${desc.platform})` };
}

export type ServiceRunningState = 'running' | 'stopped' | 'unknown';

export interface NodeServiceStatus {
  /** null means platform query failed, cannot confirm is otherwise registered. */
  installed: boolean | null;
  running: ServiceRunningState;
  platform: NodeJS.Platform;
  configPath: string;
  targetPath: string;
  /** platform state command output (diagnose use). */
  detail?: string;
}

/** parse platform state command output → running/stopped/unknown. */
function parseRunningState(platform: NodeJS.Platform, result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): ServiceRunningState {
  if (result.timedOut === true) return 'unknown';
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (platform === 'linux') {
    // systemctl is-active:active → running;inactive / failed → stopped; other (unknown etc.)→ unknown
    const state = result.stdout.trim();
    if (result.code === 0 && state === 'active') return 'running';
    if (state === 'inactive' || state === 'failed' || state === 'dead') return 'stopped';
    return 'unknown';
  }
  if (platform === 'darwin') {
    // launchctl list <label>: table row "PID\tStatus\tLabel";PID is "-" means not run;
    // "Could not find" means service not load (not run), the rest non-zero exit treated as query failed.
    if (/could not find|no such process/i.test(text)) return 'stopped';
    if (result.code !== 0) return 'unknown';
    if (/"PID"\s*=\s*\d+|pid\s*=\s*\d+|state\s*=\s*running/.test(text)) return 'running';
    const row = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.endsWith(DARWIN_LABEL));
    if (row !== undefined) {
      const pidField = row.split('\t').map((f) => f.trim()).filter((f) => f !== '')[0] ?? '-';
      if (/^\d+$/.test(pidField)) return 'running';
      return 'stopped';
    }
    return 'unknown';
  }
  if (platform === 'win32') {
    // schtasks /Query: Chinese system output "is now run"/"ready", English "Running"/"Ready".
    if (result.code !== 0) return 'unknown';
    if (/is now run|Running/i.test(text) && !/Ready|ready/i.test(text)) return 'running';
    if (/Ready|ready/i.test(text)) return 'stopped';
    return 'unknown';
  }
  return 'unknown';
}

/** query service state:installed with platform takes effect file is allow (Profile copy do not compute install), query command on failure running=unknown + explicit detail. */
export async function getNodeServiceStatus(
  cliEntryPath: string,
  dataDir: string,
  options: ServiceOperationOptions = {},
): Promise<NodeServiceStatus> {
  const exec = options.execCommand ?? defaultServiceExec;
  const desc = renderServiceSpec({
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
    ...(options.serviceHome !== undefined ? { serviceHome: options.serviceHome } : {}),
    cliEntryPath,
    dataDir,
  });
  const base = { platform: desc.platform, configPath: desc.configPath, targetPath: desc.targetPath };

  const targetExists = await fsp
    .stat(desc.targetPath)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error(`probe platform service file failed (${desc.targetPath}):${error instanceof Error ? error.message : String(error)}`);
    });

  const result = await exec.run(desc.statusCmd[0]!, desc.statusCmd.slice(1));
  const detail = `${result.stdout}${result.stderr}`.trim();
  const running = parseRunningState(desc.platform, result);
  const missing = /could not find|not found|no such process|cannot find|find fewer than|missing/i.test(detail);
  const installed: boolean | null = desc.platform === 'linux'
    ? targetExists
    : result.code === 0 ? true : missing ? false : null;
  const diagnostics: string[] = [];
  if (result.code === null || result.timedOut === true || (result.code !== 0 && running === 'unknown')) {
    diagnostics.push(`state query command failed:${describeFailure(desc.statusCmd, result)}`);
  }
  if (!targetExists && result.code === 0) {
    // platform report task store in but takes effect file missing (such as human by same name unit register): such as mark note, do not declare call installed.
    diagnostics.push(`platform report service store in, but takes effect file missing (${desc.targetPath})`);
  }

  return {
    installed,
    running,
    ...base,
    ...(diagnostics.length > 0 ? { detail: [detail, ...diagnostics].filter((s) => s !== '').join('\n') } : detail !== '' ? { detail } : {}),
  };
}
