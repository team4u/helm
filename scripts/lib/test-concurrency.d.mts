export declare const DEFAULT_TEST_CONCURRENCY: number

export declare function resolveTestConcurrency(raw: string | undefined, availableParallelism: number): number
export declare function explicitTestConcurrency(args: string[]): number | undefined
export declare function withDefaultTestConcurrency(args: string[], concurrency: number): string[]
