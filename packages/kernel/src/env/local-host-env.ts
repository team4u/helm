/**
 * Hub 本机执行环境包装（LocalHostExecutionEnv）：
 *
 * 复用 pi-durable `NodeExecutionEnv` 的文件 I/O、进程树杀组、流式增量解码与
 * 溢写逻辑（保持 `id === 'node:local'`，与 `file-env.ts` 文件互斥队列同源），
 * 同时把命令执行前的 Shell 探测委托给 `@helm/env-io` 的 `resolveHostShellConfig`：
 * - 补齐 Winget / Scoop / 非标盘符 Git Bash 探测；
 * - 跳过 System32 / Sysnative / WindowsApps 等 WSL 启动器，绝不让 Windows
 *   宿主机隐式跨进 WSL；无可用原生 bash 时显式返回 `shell_unavailable`。
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
  /** 测试注入口：覆写宿主机 Shell 探测 I/O（生产不传）。 */
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
    // argv 数组直接执行程序，不经 shell 解析。
    if (typeof command !== 'string') {
      return super.exec(command, options, context)
    }
    const platform = this.#shellProbeIo?.platform ?? process.platform
    // POSIX 宿主机无自定义 shellPath / 注入探测时与 SDK 原生行为完全一致，零额外探测开销。
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
