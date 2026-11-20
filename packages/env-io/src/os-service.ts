/**
 * Cross-platform OS startup service management shared by `helmx-node` and the local Hub launcher:
 * macOS `launchd` / Linux `systemd --user` / Windows `schtasks`.
 *
 * Renders the unit/plist/XML spec from a product-neutral `OsServiceProfile`, writes a copy under
 * `<dataDir>/service/`, copies it to the OS target location, and invokes the platform registration
 * command. All failures throw explicitly with step and command diagnostics while leaving written
 * configs intact for retry or uninstall.
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Product-specific service identity and invocation. `cliArgs` typically runs the product's CLI in
 * the foreground (`start --data-dir <dir>`): launchd `KeepAlive` / systemd `Restart=always` own
 * supervision and restart, so the managed process must stay attached.
 */
export interface OsServiceProfile {
  /** macOS launchd Label (reverse-DNS style, also the plist basename). */
  darwinLabel: string;
  /** Linux systemd --user unit filename. */
  linuxUnit: string;
  /** Windows schtasks task name. */
  winTask: string;
  /** Linux unit `Description=`. */
  description: string;
  /** Arguments after the CLI entrypoint (e.g. `['start', '--data-dir', dir]`). */
  cliArgs: readonly string[];
  /** macOS log file for `StandardOutPath`/`StandardErrorPath` (Linux logs go to the journal). */
  logPath: string;
}

export interface ServiceSpecOptions {
  /** Override `process.platform` (used by unit tests rendering all three platform templates). */
  platform?: NodeJS.Platform;
  /** Node executable path (defaults to `process.execPath`). */
  nodePath?: string;
  /** Product CLI entrypoint (compiled `cli.js` or source `cli.ts`). */
  cliEntryPath: string;
  dataDir: string;
  /** Product identity and invocation. */
  profile: OsServiceProfile;
  /** User home directory under which OS service files live (tests inject a temp directory). */
  serviceHome?: string;
}

export interface ServiceSpec {
  platform: NodeJS.Platform;
  /** Local copy stored inside `dataDir`. */
  configPath: string;
  /** OS-active service definition path (launchd plist / systemd unit / Windows task XML). */
  targetPath: string;
  /** Rendered service definition contents. */
  content: string;
  /** Platform registration command argv. */
  installCmd: string[];
  /** Platform deregistration command argv. */
  uninstallCmd: string[];
  /** Platform status query command argv. */
  statusCmd: string[];
}

export interface ServiceExec {
  /** Execute command and return `{ code, stdout, stderr, timedOut }` (`code: null` on spawn/timeout failure). */
  run(command: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
}

export const SERVICE_EXEC_TIMEOUT_MS = 30_000;

/** Default `ServiceExec` using async `spawn` with a hard timeout. */
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
        finish(killed ? null : code, killed ? `command timed out (>${SERVICE_EXEC_TIMEOUT_MS}ms) and was killed: ${command}` : undefined);
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

/** Escape quotes, systemd `%` specifiers, and `$` env expansions for `ExecStart`. */
function quoteSystemdArg(arg: string): string {
  if (/[\x00-\x1f\x7f]/.test(arg)) throw new Error('service argument must not contain control characters');
  const literal = arg.replaceAll('%', '%%').replaceAll('$', () => '$$');
  return /^[A-Za-z0-9@:,.+/_=-]+$/.test(literal) && literal !== ''
    ? literal
    : `"${literal.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function quoteWindowsArg(arg: string): string {
  if (/[\x00-\x1f\x7f]/.test(arg)) throw new Error('service argument must not contain control characters');
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

/** Pure template renderer for all three platform service specifications. */
export function renderServiceSpec(options: ServiceSpecOptions): ServiceSpec {
  const platform = options.platform ?? process.platform;
  const nodePath = options.nodePath ?? process.execPath;
  const home = options.serviceHome ?? os.homedir();
  const { cliEntryPath, dataDir, profile } = options;

  if (platform === 'darwin') {
    const configPath = path.join(dataDir, 'service', `${profile.darwinLabel}.plist`);
    const targetPath = path.join(home, 'Library', 'LaunchAgents', `${profile.darwinLabel}.plist`);
    const programArgs = [nodePath, cliEntryPath, ...profile.cliArgs];
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${profile.darwinLabel}</string>
  <key>ProgramArguments</key>
  <array>
    ${programArgs.map((a) => `<string>${escapeXml(a)}</string>`).join('\n    ')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(profile.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(profile.logPath)}</string>
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
      statusCmd: ['launchctl', 'list', profile.darwinLabel],
    };
  }

  if (platform === 'win32') {
    const configPath = path.join(dataDir, 'service', `${profile.winTask}.xml`);
    const targetPath = path.join(home, `${profile.winTask}.xml`);
    const argumentsText = [cliEntryPath, ...profile.cliArgs].map(quoteWindowsArg).join(' ');
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
      installCmd: ['schtasks', '/Create', '/F', '/TN', profile.winTask, '/XML', targetPath],
      uninstallCmd: ['schtasks', '/Delete', '/F', '/TN', profile.winTask],
      statusCmd: ['schtasks', '/Query', '/TN', profile.winTask, '/FO', 'CSV', '/NH'],
    };
  }

  if (platform === 'linux') {
    const configPath = path.join(dataDir, 'service', profile.linuxUnit);
    const targetPath = path.join(home, '.config', 'systemd', 'user', profile.linuxUnit);
    const execStart = [nodePath, cliEntryPath, ...profile.cliArgs].map(quoteSystemdArg).join(' ');
    const content = `[Unit]
Description=${profile.description}
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
      installCmd: ['systemctl', '--user', 'enable', '--now', profile.linuxUnit],
      uninstallCmd: ['systemctl', '--user', 'disable', '--now', profile.linuxUnit],
      statusCmd: ['systemctl', '--user', 'is-active', profile.linuxUnit],
    };
  }

  throw new Error(`unsupported platform ${JSON.stringify(platform)}: OS service management only supports darwin, linux, and win32`);
}

export interface ServiceOperationOptions {
  platform?: NodeJS.Platform;
  nodePath?: string;
  /** Test-only override for running OS service commands without side effects. */
  execCommand?: ServiceExec;
  /** Service target root directory (defaults to `os.homedir()`; tests must inject a temp dir). */
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

/** Format actionable failure diagnostics from command stdout/stderr/timeout. */
function describeFailure(command: readonly string[], result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): string {
  const argvText = command.join(' ');
  const output = result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim();
  if (result.timedOut === true) return `${argvText} timed out`;
  if (result.code === null) return `${argvText} failed to execute: ${output !== '' ? output : 'unknown error'}`;
  return `${argvText} exited with code ${result.code}${output !== '' ? `: ${output}` : ''}`;
}

function assertCommandOk(command: readonly string[], result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }, step: string): void {
  if (result.code === 0 && result.timedOut !== true) return;
  throw new Error(`${step}failed: ${describeFailure(command, result)}`);
}

function specOptionsOf(cliEntryPath: string, dataDir: string, profile: OsServiceProfile, options: ServiceOperationOptions): ServiceSpecOptions {
  return {
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
    ...(options.serviceHome !== undefined ? { serviceHome: options.serviceHome } : {}),
    cliEntryPath,
    dataDir,
    profile,
  };
}

/** Install and enable the OS service: render -> write copy -> write active path -> daemon-reload (linux) -> register. */
export async function installOsService(
  cliEntryPath: string,
  dataDir: string,
  profile: OsServiceProfile,
  options: ServiceOperationOptions = {},
): Promise<ServiceOperationResult> {
  const exec = options.execCommand ?? defaultServiceExec;
  const desc = renderServiceSpec(specOptionsOf(cliEntryPath, dataDir, profile, options));
  const base = {
    platform: desc.platform,
    configPath: desc.configPath,
    targetPath: desc.targetPath,
    content: desc.content,
  };

  try {
    await fsp.mkdir(path.dirname(desc.configPath), { recursive: true });
  } catch (error) {
    throw new Error(`failed to create service config directory (${path.dirname(desc.configPath)}): ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await fsp.writeFile(desc.configPath, desc.content, 'utf8');
  } catch (error) {
    throw new Error(`failed to write service config (${desc.configPath}): ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await fsp.mkdir(path.dirname(desc.targetPath), { recursive: true });
    await fsp.writeFile(desc.targetPath, desc.content, 'utf8');
  } catch (error) {
    throw new Error(
      `failed to write platform service file (${desc.targetPath}): ${error instanceof Error ? error.message : String(error)}; local copy saved at ${desc.configPath}`,
    );
  }

  if (desc.platform === 'linux') {
    const reloadCmd = ['systemctl', '--user', 'daemon-reload'];
    const reload = await exec.run(reloadCmd[0]!, reloadCmd.slice(1));
    assertCommandOk(reloadCmd, reload, 'systemd daemon-reload ');
  }

  const installResult = await exec.run(desc.installCmd[0]!, desc.installCmd.slice(1));
  assertCommandOk(desc.installCmd, installResult, 'service registration ');
  return { ok: true, ...base, installed: true, message: `service installed (${desc.platform})` };
}

/**
 * Uninstall the OS service: deregister first, then delete service files.
 * Preserves configs and throws explicitly if deregistration fails.
 */
export async function uninstallOsService(
  cliEntryPath: string,
  dataDir: string,
  profile: OsServiceProfile,
  options: ServiceOperationOptions = {},
): Promise<ServiceOperationResult> {
  const exec = options.execCommand ?? defaultServiceExec;
  const desc = renderServiceSpec(specOptionsOf(cliEntryPath, dataDir, profile, options));
  const base = {
    platform: desc.platform,
    configPath: desc.configPath,
    targetPath: desc.targetPath,
    content: desc.content,
  };

  const uninstallResult = await exec.run(desc.uninstallCmd[0]!, desc.uninstallCmd.slice(1));
  if (uninstallResult.code !== 0 || uninstallResult.timedOut === true) {
    throw new Error(
      `platform deregistration failed: ${describeFailure(desc.uninstallCmd, uninstallResult)}; retained config (${desc.configPath}) for retry`,
    );
  }

  for (const file of [desc.targetPath, desc.configPath]) {
    try {
      await fsp.rm(file, { force: true });
    } catch (error) {
      throw new Error(`failed to remove config file after deregistration (${file}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: true, ...base, installed: false, message: `service uninstalled (${desc.platform})` };
}

export type ServiceRunningState = 'running' | 'stopped' | 'unknown';

export interface OsServiceStatus {
  /** `null` indicates the platform query failed so installation state is unknown. */
  installed: boolean | null;
  running: ServiceRunningState;
  platform: NodeJS.Platform;
  configPath: string;
  targetPath: string;
  /** Raw platform status output and diagnostics. */
  detail?: string;
}

/** Parse OS status command output into `running`, `stopped`, or `unknown`. */
function parseRunningState(platform: NodeJS.Platform, result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }, darwinLabel: string): ServiceRunningState {
  if (result.timedOut === true) return 'unknown';
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (platform === 'linux') {
    const state = result.stdout.trim();
    if (result.code === 0 && state === 'active') return 'running';
    if (state === 'inactive' || state === 'failed' || state === 'dead') return 'stopped';
    return 'unknown';
  }
  if (platform === 'darwin') {
    if (/could not find|no such process/i.test(text)) return 'stopped';
    if (result.code !== 0) return 'unknown';
    if (/"PID"\s*=\s*\d+|pid\s*=\s*\d+|state\s*=\s*running/.test(text)) return 'running';
    const row = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.endsWith(darwinLabel));
    if (row !== undefined) {
      const pidField = row.split('\t').map((f) => f.trim()).filter((f) => f !== '')[0] ?? '-';
      if (/^\d+$/.test(pidField)) return 'running';
      return 'stopped';
    }
    return 'unknown';
  }
  if (platform === 'win32') {
    // `schtasks` emits localized status labels; match native Windows output.
    if (result.code !== 0) return 'unknown';
    if (/正在运行|Running/i.test(text) && !/Ready|就绪/i.test(text)) return 'running';
    if (/Ready|就绪/i.test(text)) return 'stopped';
    return 'unknown';
  }
  return 'unknown';
}

/** Query service installation and running state, surfacing query command failures honestly as `unknown`. */
export async function getOsServiceStatus(
  cliEntryPath: string,
  dataDir: string,
  profile: OsServiceProfile,
  options: ServiceOperationOptions = {},
): Promise<OsServiceStatus> {
  const exec = options.execCommand ?? defaultServiceExec;
  const desc = renderServiceSpec(specOptionsOf(cliEntryPath, dataDir, profile, options));
  const base = { platform: desc.platform, configPath: desc.configPath, targetPath: desc.targetPath };

  const targetExists = await fsp
    .stat(desc.targetPath)
    .then(() => true)
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new Error(`failed to stat platform service file (${desc.targetPath}): ${error instanceof Error ? error.message : String(error)}`);
    });

  const result = await exec.run(desc.statusCmd[0]!, desc.statusCmd.slice(1));
  const detail = `${result.stdout}${result.stderr}`.trim();
  const running = parseRunningState(desc.platform, result, profile.darwinLabel);
  const missing = /could not find|not found|no such process|cannot find|找不到|不存在/i.test(detail);
  const installed: boolean | null = desc.platform === 'linux'
    ? targetExists
    : result.code === 0 ? true : missing ? false : null;
  const diagnostics: string[] = [];
  if (result.code === null || result.timedOut === true || (result.code !== 0 && running === 'unknown')) {
    diagnostics.push(`status query command failed: ${describeFailure(desc.statusCmd, result)}`);
  }
  if (!targetExists && result.code === 0) {
    diagnostics.push(`platform reports service exists, but active unit file is missing (${desc.targetPath})`);
  }

  return {
    installed,
    running,
    ...base,
    ...(diagnostics.length > 0 ? { detail: [detail, ...diagnostics].filter((s) => s !== '').join('\n') } : detail !== '' ? { detail } : {}),
  };
}
