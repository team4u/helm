/**
 * payload 依赖安装器：可注入接口 + 宿主 npm 生产实现。
 *
 * 诚实边界（勿宣称解决 npm 自包含）：npm 包 tarball 不含 node_modules（见
 * packages/payload/README.md），本安装器只在 payload 根目录执行受控
 * `npm install --omit=dev`。Electron 不捆绑 npm CLI：宿主 npm 不可执行时显式抛
 * npm_installer_unavailable（附指引），绝不静默跳过安装谎报成功；也不静默改用其他
 * 包管理器。esbuild 等平台原生依赖按宿主平台由 npm 解析安装，vendored / 单文件
 * bundle 路线仍未解决。
 */
import { spawn } from 'node:child_process';
import { DesktopError } from './errors.js';

export interface NpmInstaller {
  readonly id: string;
  /** 在 payload 根目录安装生产依赖；失败必须 reject 并附诊断（stderr 尾部）。 */
  install(payloadRoot: string): Promise<void>;
}

export interface HostNpmInstallerOptions {
  /**
   * npm 可执行命令（默认 ['npm']，即宿主 npm）。Electron 打包版可指向自带 npm-cli.js：
   * ['node', '<resources>/node_modules/npm/bin/npm-cli.js']。
   */
  command?: string[];
  /** 追加安装参数（默认无）。 */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stderrTailLines?: number;
}

/** 生产实现：子进程执行宿主 npm install，stderr 环形缓冲尾部随错误附出。 */
export class HostNpmInstaller implements NpmInstaller {
  readonly id: string;
  private readonly command: string[];
  private readonly extraArgs: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly tailLines: number;

  constructor(options: HostNpmInstallerOptions = {}) {
    this.command = options.command ?? ['npm'];
    this.extraArgs = options.extraArgs ?? [];
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.tailLines = options.stderrTailLines ?? 40;
    this.id = `host-npm:${this.command.join(' ')}`;
  }

  async install(payloadRoot: string): Promise<void> {
    const argv = [
      ...this.command,
      'install',
      '--omit=dev',
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
      const timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        reject(
          new DesktopError('npm_install_failed', `npm install 超时（${this.timeoutMs}ms）`, {
            cwd: payloadRoot,
            argv,
          }),
        );
      }, this.timeoutMs);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new DesktopError(
            'npm_installer_unavailable',
            `npm 无法执行: ${argv.join(' ')}（${error.message}）；Electron 未捆绑 npm CLI，` +
              '请确保宿主 npm 可用，或经 createPayloadUpdater 注入自定义 NpmInstaller',
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
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(
            new DesktopError('npm_install_failed', `npm install 失败（exit ${code}）`, {
              cwd: payloadRoot,
              argv,
              stderrTail,
            }),
          );
        }
      });
    });
  }
}
