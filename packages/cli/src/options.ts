import process from 'node:process';

/** stdin 抽象：ask 等命令读取管道内容；测试注入替身避免真实进程 IO。 */
export interface StdinSource {
  /** 交互终端判定：TTY 下绝不读取管道（避免阻塞等待永不到来的 EOF）。 */
  isTTY: boolean;
  /** 读取管道全部内容直到 EOF（仅非 TTY 时调用）。 */
  readAll(): Promise<string>;
}

/** runCli 注入点：测试以内存 writer 与 fetch 替身替换真实进程 IO。 */
export interface RunCliOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetch?: typeof fetch;
  stdin?: StdinSource;
}

export interface Io {
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  fetchImpl: typeof fetch;
  stdin: StdinSource;
}

/** 默认 stdin 源：TTY 判定（惰性，避免模块加载期触碰进程状态）后整读管道。 */
function processStdin(): StdinSource {
  return {
    get isTTY(): boolean {
      return process.stdin.isTTY === true;
    },
    async readAll(): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
  };
}

export function buildIo(options: RunCliOptions = {}): Io {
  return {
    env: options.env ?? process.env,
    out: options.stdout ?? ((text) => process.stdout.write(text)),
    err: options.stderr ?? ((text) => process.stderr.write(text)),
    // 不在模块加载期捕获全局 fetch：留给每次调用，测试可注入替身
    fetchImpl: options.fetch ?? ((input, init) => fetch(input, init)),
    stdin: options.stdin ?? processStdin(),
  };
}
