import { execFile } from 'node:child_process';

/** diagram shape conversation usually do not load user shell config; only restore PATH, does not shell output when act environment variable execute. */
export async function restoreShellPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform === 'win32') return;
  const shell = env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const marker = '__HELM_PATH__';
  const output = await new Promise<string>((resolve, reject) => {
    execFile(shell, ['-ilc', `printf '${marker}%s\\0' "$PATH"`], {
      env, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => { error === null ? resolve(stdout) : reject(error); });
  });
  const start = output.lastIndexOf(marker);
  const end = output.indexOf('\0', start);
  if (start < 0 || end < 0) throw new Error('login shell not return valid PATH');
  const value = output.slice(start + marker.length, end);
  if (value.length === 0 || value.includes('\n')) throw new Error('login shell return PATH invalid');
  env.PATH = value;
}
