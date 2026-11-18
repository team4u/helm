/**
 * Controlled npm process runner: spawn without a shell, cap captured output, and kill
 * the entire process group on timeout so install-script descendants can never keep
 * writing to a staging directory after the runner has given up.
 */
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { killProcessTree } from '@helm/env-io';

const NPM_OUTPUT_DIAG_LINES = 40;
const NPM_OUTPUT_CAP = 400_000;

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  return lines.slice(-count).join('\n');
}

/**
 * Resolve npm invocation without shell interpolation: on Windows, Node prohibits direct `spawn`
 * of `.cmd` with `shell: false`, so locate `node_modules/npm/bin/npm-cli.js` beside `process.execPath`.
 */
function resolveNpmCommand(): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(execDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const cliJs of candidates) {
    if (rawFs.existsSync(cliJs)) return { command: process.execPath, args: [cliJs] };
  }
  throw new Error(
    `unable to locate npm entrypoint npm-cli.js (tried: ${candidates.join(' ; ')}); cannot spawn npm.cmd directly without a shell`,
  );
}

/** Run npm with a hard timeout, killing the entire process group via `killProcessTree` on expiry. */
export function runNpm(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  let npm: { command: string; args: string[] };
  try {
    npm = resolveNpmCommand();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const fullArgs = [...npm.args, ...args];
  const displayCmd = `npm ${args[0]}`;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(npm.command, fullArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      reject(new Error(`failed to spawn ${displayCmd} (${npm.command}): ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < NPM_OUTPUT_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < NPM_OUTPUT_CAP) stderr += chunk.toString('utf8');
    });
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
      reject(
        new Error(
          `${displayCmd} timed out (${timeoutMs}ms) and was terminated; last ${NPM_OUTPUT_DIAG_LINES} lines:\n${lastLines(`${stdout}\n${stderr}`, NPM_OUTPUT_DIAG_LINES)}`,
        ),
      );
    }, timeoutMs);
    child.on('error', (error) => finish(new Error(`${displayCmd} failed to start: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish(null);
      else {
        finish(
          new Error(
            `${displayCmd} failed with exit code ${code}; last ${NPM_OUTPUT_DIAG_LINES} lines:\n${lastLines(`${stdout}\n${stderr}`, NPM_OUTPUT_DIAG_LINES)}`,
          ),
        );
      }
    });
  });
}
