/**
 * Update orchestration: the launcher-owned commit sequence with candidate health gating and
 * rollback. Product policy lives here (cooldowns, stop-before-commit ordering, restart, blocked
 * bookkeeping); generic update mechanics stay in the injected `UpdateCore`.
 *
 * Flow (single `update.lock` critical section):
 *   resolve target (explicit --version | registry latest) → validate strict semver
 *   → blocked-cooldown gate → same-version no-op → downgrade guard
 *   → stage candidate (verified download + npm install + `start.mjs check`)
 *   → [if running] graceful stop (identity-verified; failure aborts before any state change)
 *   → atomically commit `current.json`
 *   → [if it was running / --start] start the candidate and wait for health
 *       └─ on failure: restore previous `current.json`, restart the previous release, write
 *          `update-blocked.json`, and surface the full diagnostic chain (never a silent fallback)
 *   → clear any blocked marker on success.
 *
 * Two Hubs are never started against the same data directory concurrently: the stop completes
 * before the commit, and the start path itself refuses to double-start.
 */
import { compareStrictSemver, isStrictSemver } from '@helm/protocol';
import { pathsOf, resolveBlockedCooldownMs } from './layout.js';
import {
  clearBlockedRelease,
  deleteCurrentRelease,
  isBlockedActive,
  readBlockedRelease,
  readCurrentRelease,
  readPidRecord,
  writeBlockedRelease,
  writeCurrentRelease,
  type CurrentReleaseRecord,
  type LaunchConfig,
} from './records.js';
import { isAliveOf, UsageError, type LauncherIo } from './io.js';
import { startHub, stopHub } from './process.js';
import { stageHubRelease } from './staging.js';
import type { UpdateCore } from './update-core.js';

export interface PerformUpdateOptions {
  io: LauncherIo;
  core: UpdateCore;
  root: string;
  pkgName: string;
  registryUrl?: string;
  /** Explicit target version (strict SemVer). */
  targetVersion?: string;
  /** Local tarball install source; requires `targetVersion`. */
  tarballPath?: string;
  force?: boolean;
  /** Start the Hub after committing even when it was not running before. */
  startIfNotRunning?: boolean;
  /** Launch flags for the post-commit start (highest precedence, persisted on success). */
  launchFlags?: LaunchConfig;
  fetchFn?: typeof fetch;
  healthTimeoutMs?: number;
  pollMs?: number;
  stopTimeoutMs?: number;
  npmInstallTimeoutMs?: number;
  payloadCheckTimeoutMs?: number;
}

export interface UpdateOutcome {
  previousVersion: string | null;
  targetVersion: string;
  /** False when the target already matched current and nothing was staged or restarted. */
  changed: boolean;
  /** True when the Hub was running and was restarted onto the new release. */
  restarted: boolean;
  /** True when the update started the Hub although it was not running before. */
  started: boolean;
  reusedCachedStage: boolean;
  pid?: number;
  url?: string;
}

/** Resolve and validate the effective target version (explicit flag, or registry latest). */
async function resolveTargetVersion(options: PerformUpdateOptions): Promise<string> {
  if (options.tarballPath !== undefined) {
    if (options.targetVersion === undefined) {
      throw new UsageError('--tarball requires an explicit --version to name the staged release', 'tarball_requires_version');
    }
    return options.targetVersion;
  }
  if (options.targetVersion !== undefined) return options.targetVersion;
  const latest = await options.core.fetchLatestVersion(options.pkgName, {
    ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  });
  if (!isStrictSemver(latest)) {
    throw new Error(`registry latest version is not strict SemVer: "${latest}"`);
  }
  return latest;
}

export async function performHubUpdate(options: PerformUpdateOptions): Promise<UpdateOutcome> {
  const { io, core, root } = options;
  const paths = pathsOf(root);
  return await core.withUpdateLock(root, async () => {
    const targetVersion = await resolveTargetVersion(options);
    if (!isStrictSemver(targetVersion)) {
      throw new UsageError(
        `invalid target version: "${targetVersion}" (expected strict x.y.z[-pre][+build] without v prefix)`,
        'invalid_version',
      );
    }

    const blocked = await readBlockedRelease(root);
    if (
      blocked !== null &&
      blocked.version === targetVersion &&
      options.force !== true &&
      isBlockedActive(blocked, new Date(), resolveBlockedCooldownMs(io.env))
    ) {
      throw new UsageError(
        `update to ${targetVersion} is blocked since ${blocked.at} (reason: ${blocked.reason}); wait for the cooldown, pick another --version, or pass --force`,
        'update_blocked_cooldown',
      );
    }

    const current = await readCurrentRelease(root);
    const previousVersion = current?.version ?? null;
    if (previousVersion === targetVersion && options.force !== true) {
      return { previousVersion, targetVersion, changed: false, restarted: false, started: false, reusedCachedStage: false };
    }
    if (previousVersion !== null && compareStrictSemver(targetVersion, previousVersion) < 0 && options.force !== true) {
      throw new UsageError(
        `target version ${targetVersion} is older than current ${previousVersion}; pass --force to downgrade deliberately`,
        'downgrade_rejected',
      );
    }

    const staged = await stageHubRelease({
      io,
      core,
      root,
      version: targetVersion,
      pkgName: options.pkgName,
      ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
      ...(options.tarballPath !== undefined ? { tarballPath: options.tarballPath } : {}),
      ...(options.force ? { force: true } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      ...(options.npmInstallTimeoutMs !== undefined ? { npmInstallTimeoutMs: options.npmInstallTimeoutMs } : {}),
      ...(options.payloadCheckTimeoutMs !== undefined ? { payloadCheckTimeoutMs: options.payloadCheckTimeoutMs } : {}),
    });

    const pidRecord = await readPidRecord(root);
    const wasRunning = pidRecord !== null && isAliveOf(io)(pidRecord.pid);
    if (wasRunning) {
      // Stop before any state changes: a failed stop aborts the update with current.json intact.
      await stopHub(root, io, {
        ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      });
    }

    const previousRecord: CurrentReleaseRecord | null = current;
    await writeCurrentRelease(root, {
      version: targetVersion,
      releaseDir: staged.releaseDir,
      entryPath: staged.entryPath,
      updatedAt: new Date().toISOString(),
    });

    if (!wasRunning && options.startIfNotRunning !== true) {
      await clearBlockedRelease(root);
      return {
        previousVersion,
        targetVersion,
        changed: true,
        restarted: false,
        started: false,
        reusedCachedStage: staged.reusedCached,
      };
    }

    try {
      const started = await startHub(root, io, {
        ...(options.launchFlags !== undefined ? { flags: options.launchFlags } : {}),
        ...(options.healthTimeoutMs !== undefined ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
        ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      });
      await clearBlockedRelease(root);
      return {
        previousVersion,
        targetVersion,
        changed: true,
        restarted: wasRunning,
        started: !wasRunning,
        reusedCachedStage: staged.reusedCached,
        pid: started.pid,
        url: started.url,
      };
    } catch (healthError) {
      // A concurrently started hub is not a candidate failure: keep the committed pointer, skip
      // the blocked marker, and surface the race explicitly (the user started something mid-update).
      if (healthError instanceof UsageError && healthError.code === 'hub_already_running') {
        await clearBlockedRelease(root);
        throw new UsageError(
          `current.json was committed to ${targetVersion}, but another hub instance was started concurrently and was not restarted by this update; stop or restart it manually when convenient`,
          'update_race_with_start',
        );
      }
      const reason = healthError instanceof Error ? healthError.message : String(healthError);
      const rollbackNotes: string[] = [`candidate ${targetVersion} failed to start healthy: ${reason}`];
      // Roll the pointer back before restarting anything.
      if (previousRecord !== null) await writeCurrentRelease(root, previousRecord);
      else await deleteCurrentRelease(root);
      let restartedOld: { pid: number; url: string } | null = null;
      if (wasRunning) {
        try {
          const oldStart = await startHub(root, io, {
            ...(options.launchFlags !== undefined ? { flags: options.launchFlags } : {}),
            ...(options.healthTimeoutMs !== undefined ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
            ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
            ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
          });
          restartedOld = { pid: oldStart.pid, url: oldStart.url };
        } catch (oldError) {
          rollbackNotes.push(
            `ROLLBACK INCOMPLETE: previous release ${previousVersion ?? '(none)'} failed to restart: ${
              oldError instanceof Error ? oldError.message : String(oldError)
            } (current.json restored${previousRecord !== null ? ` to ${previousRecord.version}` : ' to empty'}; start it manually after investigating ${paths.hubLogPath})`,
          );
        }
      }
      await writeBlockedRelease(root, {
        version: targetVersion,
        reason: `candidate health check failed: ${reason.slice(0, 500)}`,
        at: new Date().toISOString(),
      });
      if (restartedOld !== null) {
        rollbackNotes.push(`rolled back to ${previousRecord?.version ?? '?'} (pid ${restartedOld.pid}, ${restartedOld.url})`);
      }
      throw new Error(rollbackNotes.join('\n'));
    }
  });
}

/** Registry check without touching any state (the `check` command). */
export interface HubUpgradeCheckResult {
  currentVersion: string | null;
  latestVersion: string;
  updateAvailable: boolean;
  blocked: { version: string; reason: string; at: string } | null;
}

export async function checkHubUpgrade(options: {
  io: LauncherIo;
  core: UpdateCore;
  root: string;
  pkgName: string;
  registryUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<HubUpgradeCheckResult> {
  const latestVersion = await options.core.fetchLatestVersion(options.pkgName, {
    ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
  });
  if (!isStrictSemver(latestVersion)) {
    throw new Error(`registry latest version is not strict SemVer: "${latestVersion}"`);
  }
  const current = await readCurrentRelease(options.root);
  const blocked = await readBlockedRelease(options.root);
  return {
    currentVersion: current?.version ?? null,
    latestVersion,
    updateAvailable: current === null || compareStrictSemver(latestVersion, current.version) > 0,
    blocked,
  };
}
