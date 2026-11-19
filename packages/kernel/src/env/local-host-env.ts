/**
 * Hub local execution environment wrapper (`LocalHostExecutionEnv`):
 *
 * Reuses pi-durable `NodeExecutionEnv` for file I/O, process-tree termination, incremental streaming
 * decoding, and spill-to-disk logic (preserving `id === 'node:local'` so it shares the file mutation queue
 * with `file-env.ts`), while delegating pre-command shell resolution to `resolveHostShellConfig` in `@helmx/env-io`:
 * - discovers Winget / Scoop / non-standard Git Bash installs;
 * - skips System32 / Sysnative / WindowsApps WSL launchers so Windows hosts never silently enter WSL;
 *   returns explicit `shell_unavailable` if no native bash is available.
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
import { resolveHostShellConfig, type ShellProbeIo } from '@helmx/env-io'

interface LocalHostExecutionEnvOptions {
  cwd: string
  shellPath?: string
  shellEnv?: NodeJS.ProcessEnv
  watch?: NodeWatchOptions
  /** Test injection hook: override host shell probe I/O (never passed in production). */
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
    // argv array executes the binary directly without shell resolution.
    if (typeof command !== 'string') {
      return super.exec(command, options, context)
    }
    const platform = this.#shellProbeIo?.platform ?? process.platform
    // On POSIX hosts without a custom shellPath or injected probe, behavior matches SDK defaults with zero extra probing.
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
