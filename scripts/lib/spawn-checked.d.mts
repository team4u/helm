export interface ManagedCommand {
  cmd: string
  args: string[]
  label: string
}

export interface KillTimings {
  pollMs?: number
  cleanupGraceMs?: number
  lastResortMs?: number
}

export declare const DEFAULT_KILL_TIMINGS: Required<KillTimings>
export declare function resolvePackageManagerInvoke(env?: NodeJS.ProcessEnv): { cmd: string; args: string[] }
export declare function runManagedCommand(
  command: ManagedCommand,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timings?: KillTimings },
): Promise<number>
export declare function runSequentially(
  commands: ManagedCommand[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timings?: KillTimings },
): Promise<number>
