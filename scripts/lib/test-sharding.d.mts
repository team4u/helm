import type * as ts from 'typescript'

export interface PurityAnalysis {
  pure: boolean
  reasons: string[]
}

export declare function resolveRelativeTestHelper(fromFile: string, specifier: string): string | null
export declare function analyzeTestSourcePurity(
  tsModule: typeof ts,
  filePath: string,
  source: string,
  resolveHelper?: (fromFile: string, specifier: string) => { path: string; source: string } | null,
  visited?: Set<string>,
): PurityAnalysis
export declare function analyzeTestFilePurity(tsModule: typeof ts, absFilePath: string): PurityAnalysis
export declare function shouldDisableSharding(extraArgs: string[]): boolean
export declare function partitionFilesForSharding(input: {
  ts: typeof ts
  repoRoot: string
  files: string[]
  cpus: number
  filesPerShard?: number
  weightFn: (relPath: string) => number
}): {
  pureFiles: string[]
  isolatedFiles: string[]
  shards: string[][]
}
