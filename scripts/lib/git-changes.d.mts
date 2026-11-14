export declare class GitChangeError extends Error {}

export interface BaselineInfo {
  kind: 'explicit' | 'upstream' | 'origin-head' | 'none'
  ref: string | null
  mergeBase: string | null
}

export interface ChangedFile {
  path: string
  status: string
  origin: string
}

export declare function resolveBaseline(opts: { base?: string; cwd: string }): BaselineInfo
export declare function parseNameStatusZ(raw: string): Array<{ path: string; status: string }>
export declare function collectChangedFiles(opts: {
  base?: string
  cwd: string
}): { baseline: BaselineInfo; files: ChangedFile[] }
export declare function commitsAhead(cwd: string, mergeBase: string): number
export declare function shortRev(cwd: string, rev: string): string
