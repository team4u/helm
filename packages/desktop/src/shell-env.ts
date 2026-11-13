import { execFile } from 'node:child_process';

/** 图形会话通常不加载用户 shell 配置；只恢复 PATH，不把 shell 输出当作环境变量执行。 */
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
  if (start < 0 || end < 0) throw new Error('登录 shell 未返回有效 PATH');
  const value = output.slice(start + marker.length, end);
  if (value.length === 0 || value.includes('\n')) throw new Error('登录 shell 返回的 PATH 无效');
  env.PATH = value;
}
