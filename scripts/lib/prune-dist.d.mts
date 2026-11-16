export interface PruneDistOptions {
  pkgRoot: string
  force?: boolean
  preserveClients?: boolean
  tsBuildInfoFile?: string | null
  env?: NodeJS.ProcessEnv
}

export interface PruneDistResult {
  mode: 'wiped' | 'pruned' | 'noop'
  removedFiles: string[]
  removedDirs: string[]
}

export declare function resolveTsBuildInfoFile(pkgRoot: string): string | null
export declare function pruneDist(options: PruneDistOptions): PruneDistResult
export declare function runCleanDistCli(
  pkgRoot: string,
  argv?: string[],
  options?: { preserveClients?: boolean },
): PruneDistResult
