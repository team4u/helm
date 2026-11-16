import process from 'node:process';

/** stdin abstraction:ask etc. command read pipeline content; test inject replace body avoid real process IO. */
export interface StdinSource {
  /** interaction terminal decide:TTY under never read pipeline (avoid block wait for forever fewer than come EOF). */
  isTTY: boolean;
  /** read pipeline all content until EOF(only non- TTY when invoke). */
  readAll(): Promise<string>;
}

/** runCli inject point: test within store writer and fetch replace body replace real process IO. */
export interface RunCliOptions {
  env?: NodeJS.ProcessEnv;
  /** CLI process work directory (local file path parse base allow); default process.cwd(). test inject with avoid process.chdir concurrency pollute. */
  cwd?: string;
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

/** by default stdin source:TTY decide (lazy, avoid module load phase trigger touch process state) after whole read pipeline. */
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
    // do not in module load phase catch global fetch: to each time invoke, test can inject replace body
    fetchImpl: options.fetch ?? ((input, init) => fetch(input, init)),
    stdin: options.stdin ?? processStdin(),
  };
}
