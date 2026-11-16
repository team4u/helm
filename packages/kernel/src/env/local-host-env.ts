/**
 * Hub local machine execute environment wrap (LocalHostExecutionEnv):
 *
 * re- use pi-durable `NodeExecutionEnv` file I/O, process tree kill group, streaming incremental decode and
 * overflow write logic (keep `id === 'node:local'`, and `file-env.ts` file mutual exclusion queue same source),
 * also command execute before Shell probe delegate to `@helm/env-io`  `resolveHostShellConfig`:
 * - patch complete Winget / Scoop / non- mark symbol Git Bash probe;
 * - skip System32 / Sysnative / WindowsApps etc. WSL start, never let Windows
 *   host machine implicit across enter WSL; without available original generate bash when explicit return `shell_unavailable`.
 */
import type { Context } from '@earendil-works/chord/context'
import {
  ExecutionError,
  err,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
} from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv, type NodeWatchOptions } from '@earendil-works/pi-durable/env/node'
import { resolveHostShellConfig, type ShellProbeIo } from '@helm/env-io'

export interface LocalHostExecutionEnvOptions {
  cwd: string
  shellPath?: string
  shellEnv?: NodeJS.ProcessEnv
  watch?: NodeWatchOptions
  /** test inject opening: override host machine Shell probe I/O(produce do not pass). */
  shellProbeIo?: ShellProbeIo
}

export class LocalHostExecutionEnv extends NodeExecutionEnv implements ExecutionEnv {
  readonly #explicitShellPath?: string
  readonly #shellEnv?: NodeJS.ProcessEnv
  readonly #watchOptions?: NodeWatchOptions
  readonly #shellProbeIo?: ShellProbeIo
  readonly #activeShellEnvs = new Set<NodeExecutionEnv>()

  constructor(options: LocalHostExecutionEnvOptions) {
    super({
      cwd: options.cwd,
      ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
      ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
      ...(options.watch === undefined ? {} : { watch: options.watch }),
    })
    this.#explicitShellPath = options.shellPath
    this.#shellEnv = options.shellEnv
    this.#watchOptions = options.watch
    this.#shellProbeIo = options.shellProbeIo
  }

  override async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    // argv array directly execute program, do not via shell parse.
    if (typeof command !== 'string') {
      return super.exec(command, options, context)
    }
    const platform = this.#shellProbeIo?.platform ?? process.platform
    // POSIX host machine without self define shellPath / inject probe when and SDK original generate behavior fully consistent, zero extra probe overhead.
    if (platform !== 'win32' && this.#explicitShellPath === undefined && this.#shellProbeIo === undefined) {
      return super.exec(command, options, context)
    }
    if (context.abortSignal?.aborted) {
      return err(new ExecutionError('aborted', 'aborted'))
    }
    const resolved = await resolveHostShellConfig(this.#explicitShellPath, this.#shellProbeIo)
    if (!resolved.ok) {
      return err(new ExecutionError('shell_unavailable', resolved.message))
    }
    if (context.abortSignal?.aborted) {
      return err(new ExecutionError('aborted', 'aborted'))
    }
    const runner = new NodeExecutionEnv({
      cwd: this.cwd,
      shellPath: resolved.value.shell,
      ...(this.#shellEnv === undefined ? {} : { shellEnv: this.#shellEnv }),
      ...(this.#watchOptions === undefined ? {} : { watch: this.#watchOptions }),
    })
    this.#activeShellEnvs.add(runner)
    try {
      return await runner.exec(command, options, context)
    } finally {
      this.#activeShellEnvs.delete(runner)
    }
  }

  override async cleanup(context: Context): Promise<void> {
    const runners = [...this.#activeShellEnvs]
    await Promise.all([
      super.cleanup(context),
      ...runners.map((runner) => runner.cleanup(context)),
    ])
  }
}

export function createLocalExecutionEnv(options: LocalHostExecutionEnvOptions): LocalHostExecutionEnv {
  return new LocalHostExecutionEnv(options)
}
