/**
 * Port to the shared generic update engine (`@helm/update`, extraction in flight on the swarm
 * board — see group blackboard briefs #7/#10/#14). The Hub launcher deliberately contains ZERO
 * copies of the generic update mechanism (registry metadata fetch, SHA512-verified download,
 * immutable staging with `.complete`, upgrade locking, the npm runner). Everything generic flows
 * through this interface; everything Hub-specific (pid management, health gate, rollback policy)
 * stays in this package.
 *
 * Binding plan: once `@helm/update` lands, `resolveUpdateCore()` returns an adapter over it and the
 * package gains the `@helm/update` dependency. Until then it returns `null` and update commands
 * fail with an explicit "engine not wired" error — lifecycle commands (start/stop/restart/status)
 * are unaffected. Tests inject a fake core (test/fixtures.ts) that stands in for the generic layer.
 */
/**
 * Staging specification for one immutable Hub release candidate. The generic engine owns the
 * staging directory lifecycle; the launcher owns what "install" and "revalidate" mean for the Hub
 * payload layout (npm install + `start.mjs check`).
 */
export interface StageHubReleaseSpec {
  /** Strict-semver target version (names the `releases/<version>/` root). */
  version: string;
  /**
   * Populate `stagingDir` with the candidate payload and return the `start.mjs` entry path
   * relative to `stagingDir`. Throwing aborts staging (the engine removes the staging directory).
   */
  install(stagingDir: string): Promise<string>;
  /** Revalidate a `.complete`-cached candidate before reuse; throwing discards the cache. */
  revalidate(candidateDir: string, entryRelative: string): Promise<void>;
  /** Bypass the `.complete` cache and build a fresh candidate. */
  force?: boolean;
}

export interface FetchLatestOptions {
  registryUrl?: string;
  fetchFn?: typeof fetch;
}

export interface DownloadVerifiedTarballOptions {
  registryUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Generic update-engine capabilities consumed by the launcher. Function contracts (all shared with
 * the node daemon upgrader semantics):
 * - `fetchLatestVersion`: registry `<registry>/<pkg>/latest` → strict-semver version string;
 * - `downloadVerifiedTarball`: fetch the exact version's tarball URL from registry metadata and
 *   verify its `dist.integrity` sha512 SRI before writing to `destPath` (0600, hard timeout);
 * - `runNpm`: spawn npm without a shell (win32 `npm-cli.js` resolution), hard timeout with
 *   process-tree termination, bounded output with tail diagnostics;
 * - `stageImmutableRelease`: build a candidate under `releases/<version>/` via the spec's
 *   `install` callback inside a `.staging-*` directory, rename to an immutable `<uuid>` candidate,
 *   then atomically write the `.complete` marker; a valid cached marker short-circuits via
 *   `revalidate` (a revalidation failure discards the cache and restages);
 * - `withUpdateLock`: exclusive `update.lock` (`O_EXCL`) around the whole update flow.
 */
export interface UpdateCore {
  fetchLatestVersion(pkgName: string, options?: FetchLatestOptions): Promise<string>;

  downloadVerifiedTarball(
    pkgName: string,
    version: string,
    destPath: string,
    options?: DownloadVerifiedTarballOptions,
  ): Promise<void>;

  runNpm(args: readonly string[], cwd: string, timeoutMs: number): Promise<void>;

  stageImmutableRelease(releasesDir: string, spec: StageHubReleaseSpec): Promise<{
    version: string;
    releaseDir: string;
    entryPath: string;
    reusedCached: boolean;
  }>;

  withUpdateLock<T>(rootDir: string, fn: () => Promise<T>): Promise<T>;
}

/**
 * Production binding status. Returns `null` until the `@helm/update` adapter is wired in (core
 * package integration); callers must surface an explicit error, never a silent fallback.
 */
export function resolveUpdateCore(): UpdateCore | null {
  // Pending: return an adapter over `@helm/update` here once the shared engine lands (board #15).
  return null;
}
