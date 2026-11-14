export interface WorkspacePackage {
  name: string
  dir: string
  workspaceDeps: string[]
}

export declare const FULL_TIER_TRIGGERS: Set<string>
export declare const PACKAGE_TIERS: Record<string, string>
export declare function loadWorkspacePackages(repoRoot: string): WorkspacePackage[]
export declare function reverseClosure(seedDirs: string[], pkgs: WorkspacePackage[]): Set<string>
export declare function classifyChange(file: string): {
  pkg: string | null
  kind: 'test' | 'source' | 'root-trigger' | 'outside'
}
export declare function computeAffectedPackages(
  files: string[],
  pkgs: WorkspacePackage[],
): { affected: Set<string>; fullTier: boolean; outside: string[] }
export declare function testFilesOfPackage(repoRoot: string, pkgDir: string): string[]
export declare function planCheckCommands(input: {
  affectedDirs: string[]
  testFiles: string[]
  pm: { cmd: string; args: string[] }
  execPath: string
  repoRoot: string
}): Array<{ cmd: string; args: string[]; label: string }>
