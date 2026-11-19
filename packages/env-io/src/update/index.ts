/**
 * The shared self-update engine for long-running Helm processes (`@helm/node` daemon
 * today, the local Hub launcher next), living under `@helm/env-io`'s `update/` subtree
 * and re-exported from the package root.
 *
 * Mechanisms provided (policy stays with the consumer):
 * - npm registry access: dist-tag/exact metadata fetch with timeouts, SHA-512 SRI verified
 *   tarball download (`downloadVerifiedTarball`), registry allowlisting for RPC-exposed inputs;
 * - immutable release staging: `releases/<version>/<uuid>/` directories with a `.complete`
 *   marker, cache revalidation, layout declared per product via `ReleaseLayout`
 *   (Node's dual `@helm/node` + `@helm/cli` packages, a single Hub payload, or an injected
 *   `stageExtractor` for layouts npm staging cannot express);
 * - atomic state: `current.json` / `update-blocked.json` (explicit corruption errors,
 *   `0600` atomic writes) and a cross-process `upgrade.lock`;
 * - controlled npm runner: shell-free spawn, capped output, process-group kill on timeout;
 * - update orchestration: `performUpdate` with drain gate, strict commit-at-replacement
 *   semantics, rollback plus failure cooldown, and the never-roll-back contract for
 *   `UpgradeCommitUnconfirmedError`; `current.json` disk format is codec-injectable
 *   (`UpdateStateOps`) so consumers with pre-existing on-disk contracts keep them.
 *
 * The engine depends only on `@helm/protocol` (strict SemVer) and the host package's own
 * I/O helpers (atomic writes, process-tree termination); it never imports the kernel,
 * plugins, or the Hub, and keeps no product policy inside.
 */
export {
  UpgradeRejectedError,
  UpgradeCommitUnconfirmedError,
} from './errors.js';
export { compareSemver, normalizeTargetVersion } from './semver.js';
export {
  DEFAULT_REGISTRY,
  METADATA_TIMEOUT_MS,
  TARBALL_TIMEOUT_MS,
  filterRpcRegistryUrl,
  resolveRegistryUrl,
  fetchExactManifest,
  fetchLatestVersion,
  downloadTarball,
  downloadVerifiedTarball,
  computeSri,
  type RegistryManifest,
  type DownloadTarballOptions,
} from './registry.js';
export {
  readCurrentRelease,
  writeCurrentRelease,
  deleteCurrentRelease,
  readBlockedRelease,
  writeBlockedRelease,
  clearBlockedRelease,
  readStateJson,
  type CurrentReleaseRecord,
  type BlockedReleaseRecord,
  type UpdateStateOps,
} from './state.js';
export { runNpm } from './npm-runner.js';
export {
  stageRelease,
  type NpmPackageSpec,
  type ReleaseLayout,
  type StagedRelease,
  type StageExtractor,
  type StageReleaseOptions,
} from './staging.js';
export {
  checkForUpdate,
  performUpdate,
  withUpdateLock,
  type UpdateSource,
  type UpdateSpec,
  type CheckForUpdateOptions,
  type UpdateCheckResult,
  type PerformUpdateOptions,
  type PreparedReplacement,
  type UpdateResult,
} from './upgrade.js';
