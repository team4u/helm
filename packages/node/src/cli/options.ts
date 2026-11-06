import process from 'node:process';

/** runCli 注入点：测试以内存 writer 与 fetch 替身替换真实进程 IO。 */
export interface RunCliOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetch?: typeof fetch;
}

export interface Io {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  fetchImpl: typeof fetch;
}

export function buildIo(options: RunCliOptions = {}): Io {
  return {
    env: options.env ?? process.env,
    out: options.stdout ?? ((text) => process.stdout.write(text)),
    err: options.stderr ?? ((text) => process.stderr.write(text)),
    // 不在模块加载期捕获全局 fetch：留给每次调用，测试可注入替身
    fetchImpl: options.fetch ?? ((input, init) => fetch(input, init)),
  };
}
