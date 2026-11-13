/**
 * payload 依赖安装器：可注入接口 + 宿主 npm 生产实现。
 *
 * npm 业务载荷不含 node_modules：本安装器在候选根目录执行
 * `npm install --omit=dev --ignore-scripts`，按目标平台补齐 optionalDependencies。
 * 桌面安装包注入随附的 npm-cli.js；独立宿主调用则从 Node 安装布局解析 npm。
 * npm 不可用时显式抛 npm_installer_unavailable，绝不跳过安装或改用其他包管理器。
 *
 * 执行方式铁律：一律经 node 可执行文件直接运行 npm-cli.js——Windows 下 npm 入口
 * 是 .cmd 批处理，spawn 无法直接执行（也绝不经 shell:true 放宽注入面）；npm-cli.js
 * 从 execPath 旁按 Node 安装常规布局解析。超时 SIGKILL 后必须等待子进程真正
 * close 才结束 install（安装互斥锁在此之前不释放，避免残留进程继续占用 payload 目录）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DesktopError } from './errors.js';

export interface NpmInstaller {
  readonly id: string;
  /** 在 payload 根目录安装生产依赖；失败必须 reject 并附诊断（stderr 尾部）。 */
  install(payloadRoot: string): Promise<void>;
}

export interface HostNpmInstallerOptions {
  /**
   * 显式安装命令（argv 前缀，如 ['node', '<resources>/node_modules/npm/bin/npm-cli.js']）。
   * 提供时原样使用，调用方负责其可执行性；缺省按 execPath 旁 Node 布局解析 npm-cli.js。
   */
  command?: string[];
  /** 追加安装参数（默认无）。 */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** 运行 npm-cli.js 的 node 可执行文件（默认 process.execPath）；npm 布局也按它解析。 */
  execPath?: string;
  timeoutMs?: number;
  stderrTailLines?: number;
  /** 超时 SIGKILL 后等待子进程 close 的宽限（ms），防极端平台迟迟不 close 卡死锁。 */
  killGraceMs?: number;
}

/** 在 execPath 旁按 Node 安装常规布局搜索 npm-cli.js；找不到返回 null。 */
function resolveNpmCliJs(execPath: string): string | null {
  const binDir = path.dirname(execPath);
  const candidates = [
    // Windows nodejs 安装布局：<dir>/node_modules/npm/bin/npm-cli.js 与 node.exe 同目录
    path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Unix 系统包布局：<bin>/../lib/node_modules/npm（/usr/bin → /usr/lib）
    path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // 版本管理器布局（nvm 等）：<bin>/../node_modules/npm
    path.join(binDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 生产实现：node 直接运行 npm-cli.js 安装生产依赖，stderr 环形缓冲尾部随错误附出。 */
export class HostNpmInstaller implements NpmInstaller {
  readonly id: string;
  private readonly command?: string[];
  private readonly extraArgs: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly execPath: string;
  private readonly timeoutMs: number;
  private readonly tailLines: number;
  private readonly killGraceMs: number;

  constructor(options: HostNpmInstallerOptions = {}) {
    this.command = options.command;
    this.extraArgs = options.extraArgs ?? [];
    this.env = options.env ?? process.env;
    this.execPath = options.execPath ?? process.execPath;
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.tailLines = options.stderrTailLines ?? 40;
    this.killGraceMs = options.killGraceMs ?? 10_000;
    if (this.command !== undefined) {
      this.id = `host-npm:${this.command.join(' ')}`;
    } else {
      const npmCli = resolveNpmCliJs(this.execPath);
      this.id = npmCli !== null ? `host-npm:${this.execPath} ${npmCli}` : `host-npm:${this.execPath} (npm-cli.js 未找到)`;
    }
  }

  async install(payloadRoot: string): Promise<void> {
    const argv = [
      ...this.resolveCommand(),
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      ...this.extraArgs,
    ];
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      npm_config_color: 'false',
      npm_config_progress: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    };
    await new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: payloadRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stderrTail: string[] = [];
      let settled = false;
      let timedOut = false;
      let killGraceTimer: NodeJS.Timeout | null = null;
      const fail = (error: DesktopError) => {
        if (settled) return;
        settled = true;
        if (killGraceTimer !== null) clearTimeout(killGraceTimer);
        reject(error);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
        // 真正等待 close 再结束（锁随后才释放）；宽限兜底防 close 永不到达。
        killGraceTimer = setTimeout(() => {
          fail(
            new DesktopError('npm_install_failed', `npm install 超时（${this.timeoutMs}ms），子进程被 SIGKILL 后 ${this.killGraceMs}ms 内未退出`, {
              cwd: payloadRoot,
              argv,
              stderrTail,
            }),
          );
        }, this.killGraceMs);
      }, this.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        fail(
          new DesktopError(
            'npm_installer_unavailable',
            `npm 无法执行: ${argv.join(' ')}（${error.message}）；Electron 未捆绑 npm CLI，` +
              '请确保宿主 Node/npm 可用，或经 HostNpmInstaller command 显式注入 npm-cli.js 路径',
            { argv },
          ),
        );
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.length === 0) continue;
          stderrTail.push(line);
          if (stderrTail.length > this.tailLines) stderrTail.shift();
        }
      });
      child.stdout?.on('data', () => {});
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          fail(new DesktopError('npm_install_failed', `npm install 超时（${this.timeoutMs}ms）`, {
            cwd: payloadRoot,
            argv,
            stderrTail,
          }));
          return;
        }
        if (code === 0) {
          if (settled) return;
          settled = true;
          resolve();
          return;
        }
        fail(
          new DesktopError('npm_install_failed', `npm install 失败（exit ${code}）`, {
            cwd: payloadRoot,
            argv,
            stderrTail,
          }),
        );
      });
    });
  }

  /** 缺省命令：node + execPath 旁解析到的 npm-cli.js；找不到显式报错（不回退 shell/npm.cmd）。 */
  private resolveCommand(): string[] {
    if (this.command !== undefined) return this.command;
    const npmCli = resolveNpmCliJs(this.execPath);
    if (npmCli === null) {
      throw new DesktopError(
        'npm_installer_unavailable',
        `未在 ${this.execPath} 旁的 Node 常规布局中找到 npm CLI（npm-cli.js）。` +
          'Electron 未捆绑 npm CLI：请安装宿主 Node/npm，或经 HostNpmInstaller command 显式注入 npm-cli.js 路径',
        { execPath: this.execPath },
      );
    }
    return [this.execPath, npmCli];
  }
}
