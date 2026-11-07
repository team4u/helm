/**
 * 跨平台开机自启服务：macOS launchd / Linux systemd --user / Windows schtasks。
 *
 * 只做四件事：渲染服务描述（renderServiceSpec）、写数据目录留档副本、
 * 复制到平台生效位置、调用平台注册命令。每一步失败都显式返回
 * ok:false + message（含失败步骤与原因），绝不静默吞错或伪装成功；
 * 系统命令失败时保留已写入的配置，交由用户重试或 uninstall 清理。
 *
 * 命令执行经 ServiceExec 注入（默认为带超时的异步 spawn，不阻塞事件循环、
 * 不无限期卡死）；单测注入内存执行器做无副作用验证，绝不真实安装。
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface ServiceSpecOptions {
  /** 覆盖 process.platform（单测渲染三平台模板用）。 */
  platform?: NodeJS.Platform;
  /** node 可执行文件路径（缺省 process.execPath）。 */
  nodePath?: string;
  /** helm-node CLI 入口（编译产物 cli.js 或 tsx 源入口）。 */
  cliEntryPath: string;
  dataDir: string;
  hubUrl?: string;
  /**
   * 服务文件根目录（缺省 os.homedir()）：launchd plist / systemd unit / Windows
   * 任务 XML 的生效位置均落在此根下。单测注入临时目录，确保零宿主副作用。
   */
  serviceHome?: string;
}

export interface ServiceSpec {
  platform: NodeJS.Platform;
  /** 服务单元留档副本落点（数据目录内）。 */
  configPath: string;
  /** 平台生效路径（launchd plist / systemd unit / Windows 任务 XML）。 */
  targetPath: string;
  /** 服务单元内容（plist XML / unit / 任务 XML）。 */
  content: string;
  /** 平台注册命令（argv）。 */
  installCmd: string[];
  /** 平台卸载命令（argv）。 */
  uninstallCmd: string[];
  /** 供状态探测的命令（argv）。 */
  statusCmd: string[];
}

export interface ServiceExec {
  /** 执行命令；返回 { code, stdout, stderr, timedOut }（spawn 语义；error 映射 code:null + stderr）。 */
  run(command: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }>;
}

export const SERVICE_EXEC_TIMEOUT_MS = 30_000;

/** 默认 ServiceExec：异步 spawn + 总超时；spawn error（ENOENT 等）如实返回 code:null。 */
export const defaultServiceExec: ServiceExec = {
  async run(command, args) {
    return await new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: `spawn ${command} 失败: ${error instanceof Error ? error.message : String(error)}`, timedOut: false });
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
        finish(null, `无法执行 ${command}: ${error.message}`);
      });
      child.on('close', (code) => {
        finish(killed ? null : code, killed ? `命令超时（>${SERVICE_EXEC_TIMEOUT_MS}ms）被终止: ${command}` : undefined);
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

/** systemd 不经 Shell；分别转义参数引号、specifier（%）与环境展开（$）。 */
function quoteSystemdArg(arg: string): string {
  if (/[\x00-\x1f\x7f]/.test(arg)) throw new Error('服务参数不得包含控制字符');
  const literal = arg.replaceAll('%', '%%').replaceAll('$', () => '$$');
  return /^[A-Za-z0-9@:,.+/_=-]+$/.test(literal) && literal !== ''
    ? literal
    : `"${literal.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function quoteWindowsArg(arg: string): string {
  if (/[\x00-\x1f\x7f]/.test(arg)) throw new Error('服务参数不得包含控制字符');
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

const DARWIN_LABEL = 'ai.helm.node';
const LINUX_UNIT = 'helm-node.service';
const WIN_TASK = 'HelmNode';

/** CLI 启动参数（不含 node 与入口本身）：start --data-dir <dir> [--hub <url>]。 */
function cliArgs(dataDir: string, hubUrl?: string): string[] {
  return ['start', '--data-dir', dataDir, ...(hubUrl !== undefined && hubUrl !== '' ? ['--hub', hubUrl] : [])];
}

/** 渲染平台服务描述：不落盘、不执行命令，纯函数便于三平台单测。 */
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

  throw new Error(`不支持的平台 ${JSON.stringify(platform)}：helm-node service 仅支持 darwin / linux / win32`);
}

export interface ServiceOperationOptions {
  platform?: NodeJS.Platform;
  nodePath?: string;
  /** 注入命令执行器（单测无副作用验证）。 */
  execCommand?: ServiceExec;
  /** 服务文件根目录（缺省 os.homedir()）；单测必须注入临时目录。 */
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

/** describeFailure：命令失败的可读诊断（stderr > timeout > error 文本）。 */
function describeFailure(command: readonly string[], result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): string {
  const argvText = command.join(' ');
  const output = result.stderr.trim() !== '' ? result.stderr.trim() : result.stdout.trim();
  if (result.timedOut === true) return `${argvText} 超时未返回`;
  if (result.code === null) return `${argvText} 无法执行：${output !== '' ? output : '未知错误'}`;
  return `${argvText} 退出码 ${result.code}${output !== '' ? `：${output}` : ''}`;
}

/** 校验注册命令结果：非零退出、无法执行或超时都视为失败，如实诊断。 */
function assertCommandOk(command: readonly string[], result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }, step: string): void {
  if (result.code === 0 && result.timedOut !== true) return;
  throw new Error(`${step}失败：${describeFailure(command, result)}`);
}

/** 安装服务：渲染 → 写留档副本 → 复制到平台生效路径 → daemon-reload（linux）→ 平台注册。任一步失败显式报错。 */
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
    throw new Error(`创建服务配置目录失败（${path.dirname(desc.configPath)}）：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await fsp.writeFile(desc.configPath, desc.content, 'utf8');
  } catch (error) {
    throw new Error(`写入服务配置失败（${desc.configPath}）：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    await fsp.mkdir(path.dirname(desc.targetPath), { recursive: true });
    await fsp.writeFile(desc.targetPath, desc.content, 'utf8');
  } catch (error) {
    throw new Error(
      `写入平台服务文件失败（${desc.targetPath}）：${error instanceof Error ? error.message : String(error)}；留档副本已保存于 ${desc.configPath}`,
    );
  }

  if (desc.platform === 'linux') {
    const reloadCmd = ['systemctl', '--user', 'daemon-reload'];
    const reload = await exec.run(reloadCmd[0]!, reloadCmd.slice(1));
    assertCommandOk(reloadCmd, reload, 'systemd daemon-reload ');
  }

  const installResult = await exec.run(desc.installCmd[0]!, desc.installCmd.slice(1));
  assertCommandOk(desc.installCmd, installResult, '系统注册 ');
  return { ok: true, ...base, installed: true, message: `服务已安装（${desc.platform}）` };
}

/**
 * 卸载服务：平台注销 → 删除平台文件与留档副本。
 * 注销命令失败（含无法执行/超时）：显式报错且**不删除任何配置**，返回 installed 保持现状。
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
      `平台注销失败：${describeFailure(desc.uninstallCmd, uninstallResult)}；已保留配置（${desc.configPath}），可重试 uninstall`,
    );
  }

  for (const file of [desc.targetPath, desc.configPath]) {
    try {
      await fsp.rm(file, { force: true });
    } catch (error) {
      throw new Error(`注销后清理配置文件失败（${file}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok: true, ...base, installed: false, message: `服务已卸载（${desc.platform}）` };
}

export type ServiceRunningState = 'running' | 'stopped' | 'unknown';

export interface NodeServiceStatus {
  /** null 表示平台查询失败，无法确认是否已注册。 */
  installed: boolean | null;
  running: ServiceRunningState;
  platform: NodeJS.Platform;
  configPath: string;
  targetPath: string;
  /** 平台状态命令输出（诊断用）。 */
  detail?: string;
}

/** 解析平台状态命令输出 → running/stopped/unknown。 */
function parseRunningState(platform: NodeJS.Platform, result: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): ServiceRunningState {
  if (result.timedOut === true) return 'unknown';
  const text = `${result.stdout}\n${result.stderr}`.trim();
  if (platform === 'linux') {
    // systemctl is-active：active → running；inactive / failed → stopped；其他（unknown 等）→ unknown
    const state = result.stdout.trim();
    if (result.code === 0 && state === 'active') return 'running';
    if (state === 'inactive' || state === 'failed' || state === 'dead') return 'stopped';
    return 'unknown';
  }
  if (platform === 'darwin') {
    // launchctl list <label>：表格行 "PID\tStatus\tLabel"；PID 为 "-" 表示未运行；
    // "Could not find" 表示服务未加载（未运行），其余非零退出视为查询失败。
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
    // schtasks /Query：中文系统输出 "正在运行"/"就绪"，英文 "Running"/"Ready"。
    if (result.code !== 0) return 'unknown';
    if (/正在运行|Running/i.test(text) && !/Ready|就绪/i.test(text)) return 'running';
    if (/Ready|就绪/i.test(text)) return 'stopped';
    return 'unknown';
  }
  return 'unknown';
}

/** 查询服务状态：installed 以平台生效文件为准（留档副本不算安装），查询命令失败时 running=unknown + 显式 detail。 */
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
      throw new Error(`探测平台服务文件失败（${desc.targetPath}）：${error instanceof Error ? error.message : String(error)}`);
    });

  const result = await exec.run(desc.statusCmd[0]!, desc.statusCmd.slice(1));
  const detail = `${result.stdout}${result.stderr}`.trim();
  const running = parseRunningState(desc.platform, result);
  const missing = /could not find|not found|no such process|cannot find|找不到|不存在/i.test(detail);
  const installed: boolean | null = desc.platform === 'linux'
    ? targetExists
    : result.code === 0 ? true : missing ? false : null;
  const diagnostics: string[] = [];
  if (result.code === null || result.timedOut === true || (result.code !== 0 && running === 'unknown')) {
    diagnostics.push(`状态查询命令失败：${describeFailure(desc.statusCmd, result)}`);
  }
  if (!targetExists && result.code === 0) {
    // 平台报告任务存在但生效文件缺失（如人工按同名单元注册过）：如实标注，不宣称 installed。
    diagnostics.push(`平台报告服务存在，但生效文件缺失（${desc.targetPath}）`);
  }

  return {
    installed,
    running,
    ...base,
    ...(diagnostics.length > 0 ? { detail: [detail, ...diagnostics].filter((s) => s !== '').join('\n') } : detail !== '' ? { detail } : {}),
  };
}
