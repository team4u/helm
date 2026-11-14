import type * as ts from 'typescript'

export interface HygieneViolation {
  file: string
  line: number
  rule: 'timeout-missing' | 'skip-without-reason' | 'suite-timeout-env'
  message: string
}

export interface HygieneReport {
  violations: HygieneViolation[]
  stats: { testCalls: number; skipCalls: number; todoCalls: number; subtestCalls: number }
}

export declare function analyzeTestSource(tsModule: typeof ts, filePath: string, source: string): HygieneReport
export declare function collectAllTestFiles(repoRoot: string): string[]
export declare function isTestFilePath(file: string): boolean
