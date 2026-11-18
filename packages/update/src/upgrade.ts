/**
 * Update orchestration: check, stage, drain, activate, roll back.
 *
 * `performUpdate` commits strictly at `replacement.commit()`: the state pointer is
 * written first, then the replacement confirms activation. Failure rolls back the
 * pointer and records a cooldown block; `UpgradeCommitUnconfirmedError` (activation
 * was signaled but confirmation was lost) never aborts or rolls back, because the
 * candidate may already have committed upstream.
 *
 * Product policy (what counts as in-flight work, how a replacement is spawned and
 * confirmed) is injected; the mechanism (lock, cooldown, drain gate, commit order)
 * lives here. `upgrade.lock` gives cross-process exclusion.
 */
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { isStrictSemver } from '@helm/protocol';
import { UpgradeCommitUnconfirmedError, UpgradeRejectedError } from './errors.js';
import { compareSemver, normalizeTargetVersion } from './semver.js';
import { fetchLatestVersion, resolveRegistryUrl } from './registry.js';
import {
  clearBlockedRelease,
  readBlockedRelease,
  readCurrentRelease,
  writeBlockedRelease,
  writeCurrentRelease,
  deleteCurrentRelease,
  type BlockedReleaseRecord,
} from './state.js';
import { stageRelease, type ReleaseLayout, type StageExtractor, type StagedRelease } from './staging.js';

const DRAIN_POLL_INTERVAL_MS = 50;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** Failure cooldown for a rejected version; overridable via `HELM_UPGRADE_BLOCK_COOLDOWN_MS`. */
const UPGRADE_BLOCK_COOLDOWN_MS = (): number => {
  const raw = Number(process.env.HELM_UPGRADE_BLOCK_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60 * 1000;
};

/** What is being updated: which registry package decides `latest`, plus the staging layout. */
export interface UpdateSource {
  /** Registry package queried for the `latest` dist-tag (Node: `@helm/node`; Hub: the payload package). */
  packageName: string;
  /**
   * Current-version fallback when `current.json` is absent and no explicit `currentVersion`
   * was passed (e.g. reading the running launcher's own `package.json`).
   */
  getFallbackVersion?: () => string;
}

export interface UpdateSpec extends UpdateSource {
  /** Staging layout used when no `stageExtractor` is injected. */
  layout: ReleaseLayout;
}

export interface CheckForUpdateOptions {
  registryUrl?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  blocked?: BlockedReleaseRecord;
}

export interface PerformUpdateOptions {
  targetVersion?: string;
  registryUrl?: string;
  force?: boolean;
  attemptId?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
  /** Extra npm install args passed through to staging (consumer policy, e.g. `--ignore-scripts`). */
  npmInstallArgs?: string[];
  /** Overrides npm staging entirely (see `StageExtractor`). */
  stageExtractor?: StageExtractor;
  /**
   * Prepares and activates the replacement process; `commit()` confirms activation,
   * `abort()` kills it. Required — the engine never fabricates a PID.
   */
  prepareReplacement?: (
    release: StagedRelease,
    context: { attemptId: string; previousVersion: string; targetVersion: string },
  ) => Promise<PreparedReplacement>;
  /** Returns count of in-flight operations to drain before activating the replacement. */
  getActiveExecCount?: () => number;
  setDraining?: (value: boolean) => void;
  drainTimeoutMs?: number;
  onScheduleShutdown?: (pid: number) => void;
}

/** A replacement process managed by the consumer; the engine only orchestrates commit/abort. */
export interface PreparedReplacement {
  pid: number;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface UpdateResult {
  ok: boolean;
  previousVersion: string;
  targetVersion: string;
  upgraded: boolean;
  pid?: number;
}

/** Query the registry for the latest version and compare it against the current one. */
export async function checkForUpdate(
  stateDir: string,
  source: UpdateSource,
  options?: CheckForUpdateOptions,
): Promise<UpdateCheckResult> {
  const registryUrl = resolveRegistryUrl(options?.registryUrl);
  const fetchImpl = options?.fetchFn ?? fetch;

  const latestVersion = await fetchLatestVersion(registryUrl, source.packageName, fetchImpl);
  if (!isStrictSemver(latestVersion)) {
    throw new UpgradeRejectedError(
      `invalid SemVer version (latest): "${latestVersion}" (expected strict x.y.z[-pre][+build] without v prefix)`,
    );
  }

  const currentVersion = await resolveCurrentVersion(stateDir, source, options?.currentVersion, 'checkForUpdate');
  const blocked = (await readBlockedRelease(stateDir)) || undefined;

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    ...(blocked ? { blocked } : {}),
  };
}

async function resolveCurrentVersion(
  stateDir: string,
  source: UpdateSource,
  explicit: string | undefined,
  label: string,
): Promise<string> {
  if (explicit !== undefined && explicit !== '') return explicit;
  const current = await readCurrentRelease(stateDir);
  if (current !== null) return current.version;
  if (source.getFallbackVersion !== undefined) return source.getFallbackVersion();
  throw new UpgradeRejectedError(
    `${label}: no current version resolvable (current.json is absent, no explicit currentVersion, and the update source provides no getFallbackVersion)`,
  );
}

/** Cross-process exclusive update lock (`upgrade.lock`, `O_CREAT|O_EXCL`). */
export async function withUpdateLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(stateDir, 'upgrade.lock');
  await fs.mkdir(stateDir, { recursive: true });
  let handle: FileHandle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new UpgradeRejectedError(`upgrade already in progress (lock file exists: ${lockPath})`);
    }
    throw new Error(
      `failed to create upgrade lock (${lockPath}): ${code ?? (error instanceof Error ? error.message : String(error))}`,
    );
  }
  try {
    await handle.write(`${process.pid} ${new Date().toISOString()}\n`);
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Perform a full update: resolve the target, stage it, drain in-flight work, activate
 * the replacement, and commit or roll back. See the module header for the commit
 * ordering and rollback invariants.
 */
export async function performUpdate(
  stateDir: string,
  spec: UpdateSpec,
  options?: PerformUpdateOptions,
): Promise<UpdateResult> {
  return withUpdateLock(stateDir, async () => {
    if (!options?.prepareReplacement) {
      throw new UpgradeRejectedError(
        'upgrade rejected: prepareReplacement was not provided (an injected replacement lifecycle is required to register and commit activation; refusing to fabricate a PID)',
      );
    }

    const previousVersion = await resolveCurrentVersion(stateDir, spec, options?.currentVersion, 'performUpdate');

    let targetVersion: string;
    if (options?.targetVersion !== undefined && options.targetVersion !== '') {
      targetVersion = normalizeTargetVersion(options.targetVersion);
    } else {
      const check = await checkForUpdate(stateDir, spec, {
        registryUrl: options?.registryUrl,
        currentVersion: previousVersion,
        fetchFn: options?.fetchFn,
      });
      targetVersion = check.latestVersion;
    }

    if (!options?.force && targetVersion === previousVersion) {
      return { ok: true, previousVersion, targetVersion, upgraded: false };
    }

    if (!options?.force && compareSemver(targetVersion, previousVersion) < 0) {
      throw new UpgradeRejectedError(
        `refusing downgrade from ${previousVersion} to ${targetVersion} (pass force=true to downgrade)`,
      );
    }

    const blocked = await readBlockedRelease(stateDir);
    if (blocked && blocked.version === targetVersion && !options?.force) {
      const blockedAtMs = Date.parse(blocked.at);
      const withinCooldown = Number.isFinite(blockedAtMs) && Date.now() - blockedAtMs < UPGRADE_BLOCK_COOLDOWN_MS();
      if (withinCooldown) {
        throw new UpgradeRejectedError(
          `version ${targetVersion} is in failure cooldown, rejecting retry: ${blocked.reason} (blocked at ${blocked.at})`,
        );
      }
    }

    const existingCurrent = await readCurrentRelease(stateDir);

    const attemptId = options?.attemptId ?? randomUUID();
    let committed = false;
    let keepGate = false;
    let gateReleased = false;
    const releaseGate = async () => {
      if (gateReleased) return;
      gateReleased = true;
      options?.setDraining?.(false);
    };
    const writeBlockedOrFail = async (reason: string): Promise<string> => {
      try {
        await writeBlockedRelease(stateDir, { version: targetVersion, reason, at: new Date().toISOString() });
        return `recorded blocked release for ${targetVersion}`;
      } catch (blockedError) {
        return `write blocked record failed (manual cleanup required): ${blockedError instanceof Error ? blockedError.message : String(blockedError)}`;
      }
    };

    try {
      const staged = await stageRelease(stateDir, targetVersion, spec.layout, {
        registryUrl: options?.registryUrl,
        fetchFn: options?.fetchFn,
        npmInstallArgs: options?.npmInstallArgs,
        force: options?.force,
        stageExtractor: options?.stageExtractor,
      });

      options?.setDraining?.(true);

      const getActiveExecCount = options?.getActiveExecCount ?? (() => 0);
      const drainTimeoutMs = options?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      const drainStart = Date.now();
      while (getActiveExecCount() > 0) {
        if (Date.now() - drainStart > drainTimeoutMs) {
          throw new Error(
            `timed out draining in-flight operations (${drainTimeoutMs}ms, ${getActiveExecCount()} remaining); upgrade aborted with no changes`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
      }

      let replacement: PreparedReplacement;
      try {
        replacement = await options.prepareReplacement(staged, { attemptId, previousVersion, targetVersion });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const blockedNote = await writeBlockedOrFail(reason);
        throw new Error(
          `failed to prepare replacement (upgrade to ${targetVersion} aborted; current unchanged, previous process remains active): ${reason}; ${blockedNote}`,
        );
      }

      try {
        await writeCurrentRelease(stateDir, {
          version: targetVersion,
          entries: staged.entries,
          updatedAt: new Date().toISOString(),
        });
        await clearBlockedRelease(stateDir);
        await replacement.commit();
      } catch (error) {
        if (error instanceof UpgradeCommitUnconfirmedError) {
          options?.onScheduleShutdown?.(replacement.pid);
          keepGate = true;
          throw new Error(
            `upgrade to ${targetVersion}: replacement was activated, but confirmation was unconfirmed (${error.message}); not rolling back (current.json points to ${targetVersion}, candidate will retry commit idempotently, previous process scheduled to exit)`,
            { cause: error },
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        const rollbackNotes: string[] = [];
        try {
          await replacement.abort();
          rollbackNotes.push('replacement aborted');
        } catch (abortError) {
          rollbackNotes.push(`replacement abort failed: ${abortError instanceof Error ? abortError.message : String(abortError)}`);
        }
        try {
          if (existingCurrent) {
            await writeCurrentRelease(stateDir, existingCurrent);
            rollbackNotes.push(`current.json restored to ${existingCurrent.version}`);
          } else {
            await deleteCurrentRelease(stateDir);
            rollbackNotes.push('current.json deleted (was absent)');
          }
        } catch (restoreError) {
          rollbackNotes.push(
            `current.json restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
        rollbackNotes.push(await writeBlockedOrFail(reason));
        throw new Error(
          `upgrade to ${targetVersion} commit failed and rolled back to ${previousVersion}: ${reason}; rollback details: ${rollbackNotes.join('; ')}`,
        );
      }

      committed = true;
      options?.onScheduleShutdown?.(replacement.pid);

      return { ok: true, previousVersion, targetVersion, upgraded: true, pid: replacement.pid };
    } finally {
      if (!committed && !keepGate) await releaseGate();
    }
  });
}
