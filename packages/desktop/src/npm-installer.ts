/**
 * payload dependency install: can inject interface + host npm produce implement.
 *
 * npm business payload excludes node_modules: this install in choose directory execute
 * `npm install --omit=dev --ignore-scripts`, by target platform patch complete optionalDependencies.
 * desktop install package inject follow attach npm-cli.js; independent host invoke then from Node install layout parse npm.
 * npm unavailable when explicit throw npm_installer_unavailable, never skip install or change use other package manage.
 *
 * execute way iron rule: one rule via node can execute file directly run npm-cli.js- -Windows under npm entry
 * is .cmd batch handle,spawn cannot directly execute (also never via shell:true put wide inject side);npm-cli.js
 * from execPath beside by Node install common rule layout parse. timeout SIGKILL after must wait for child process truly
 * close only then end install(install mutual exclusion lock in this before do not release, avoid leftover process continue occupy payload directory).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DesktopError } from './errors.js';

export interface NpmInstaller {
  readonly id: string;
  /** in payload directory install produce dependency; failed must reject and attach diagnose (stderr tail part). */
  install(payloadRoot: string): Promise<void>;
}

export interface HostNpmInstallerOptions {
  /**
   * explicit install command (argv prefix, such as ['node', '<resources>/node_modules/npm/bin/npm-cli.js']).
   * provide when original use, caller negative duty its can execute; default by execPath beside Node layout parse npm-cli.js.
   */
  command?: string[];
  /** append install parameter (by default without). */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** run npm-cli.js  node can execute file (by default process.execPath);npm layout also by it parse. */
  execPath?: string;
  timeoutMs?: number;
  stderrTailLines?: number;
  /** timeout SIGKILL after wait for child process close wide limit (ms), guard against extreme platform late late do not close card deadlock. */
  killGraceMs?: number;
}

/** in execPath beside by Node install common rule layout search npm-cli.js; find fewer than return null. */
function resolveNpmCliJs(execPath: string): string | null {
  const binDir = path.dirname(execPath);
  const candidates = [
    // Windows nodejs install layout:<dir>/node_modules/npm/bin/npm-cli.js and node.exe same directory
    path.join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // Unix system package layout:<bin>/../lib/node_modules/npm(/usr/bin → /usr/lib)
    path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // version manage layout (nvm etc.):<bin>/../node_modules/npm
    path.join(binDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** produce implement:node directly run npm-cli.js install produce dependency,stderr ring shape buffer tail part follow error attach out. */
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
      this.id = npmCli !== null ? `host-npm:${this.execPath} ${npmCli}` : `host-npm:${this.execPath} (npm-cli.js not found)`;
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
        // truly wait for close again end (lock then only then release); wide limit fall back guard against close forever fewer than reach.
        killGraceTimer = setTimeout(() => {
          fail(
            new DesktopError('npm_install_failed', `npm install timeout (${this.timeoutMs}ms), child process by SIGKILL after ${this.killGraceMs}ms inside not exit`, {
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
            `npm cannot execute: ${argv.join(' ')}(${error.message});Electron not bundle npm CLI,` +
              'please ensure host Node/npm available, or via HostNpmInstaller command explicit inject npm-cli.js path',
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
          fail(new DesktopError('npm_install_failed', `npm install timeout (${this.timeoutMs}ms)`, {
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
          new DesktopError('npm_install_failed', `npm install failed (exit ${code})`, {
            cwd: payloadRoot,
            argv,
            stderrTail,
          }),
        );
      });
    });
  }

  /** default command:node + execPath beside parse to npm-cli.js; find fewer than explicit errors (does not fall back shell/npm.cmd). */
  private resolveCommand(): string[] {
    if (this.command !== undefined) return this.command;
    const npmCli = resolveNpmCliJs(this.execPath);
    if (npmCli === null) {
      throw new DesktopError(
        'npm_installer_unavailable',
        `not in ${this.execPath} beside Node common rule layout in found npm CLI(npm-cli.js).` +
          'Electron not bundle npm CLI: please install host Node/npm, or via HostNpmInstaller command explicit inject npm-cli.js path',
        { execPath: this.execPath },
      );
    }
    return [this.execPath, npmCli];
  }
}
