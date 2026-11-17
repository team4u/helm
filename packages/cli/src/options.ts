import process from 'node:process';

/** stdin abstraction used by commands like `ask` to read piped input; tests inject stubs to avoid real process I/O. */
export interface StdinSource {
  /** Interactive terminal check: never read stdin under a TTY (prevents blocking indefinitely before EOF). */
  isTTY: boolean;
  /** Read all stdin content until EOF (only called when non-TTY). */
  readAll(): Promise<string>;
}

/** Injection hooks for runCli: tests override streams and fetch to avoid touching real process I/O. */
export interface RunCliOptions {
  env?: NodeJS.ProcessEnv;
  /** CLI process working directory (root for resolving local file paths); defaults to process.cwd(). Injected in tests to avoid process.chdir concurrency pollution. */
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

/** Default stdin source: lazy TTY check (avoids touching process state at module load), then reads stdin to completion. */
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
    // Defer resolving global fetch until invocation so tests can swap it cleanly
    fetchImpl: options.fetch ?? ((input, init) => fetch(input, init)),
    stdin: options.stdin ?? processStdin(),
  };
}
