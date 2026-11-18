/**
 * Update orchestration: the launcher-owned commit sequence with candidate readiness gating and
 * rollback. Product policy lives here (cooldowns, stop-before-commit ordering, restart, blocked
 * bookkeeping); every generic mechanism — registry lookup, verified staging, immutable
 * `releases/`, `current.json`/`update-blocked.json` state, `upgrade.lock` — comes from
 * `@helm/update`.
 *
 * Flow (engine `upgrade.lock` critical section; the stop→commit→start tail additionally holds
 *   `lifecycle.lock` so start/stop/update never interleave):
 *   resolve target (explicit --version | registry dist-tag) → blocked-cooldown gate
 *   → same-version no-op → downgrade guard
 *   → stage candidate through the engine (SRI-verified download + safe unpack + offline npm
 *     install + `start.mjs check` + `manifest.nodeEngines` gate)
 *   → [if running] graceful stop (identity-verified; failure aborts before any state change)
 *   → atomically commit `current.json` (engine state ops)
 *   → [if it was running / --start] start the candidate and gate on its own listen line
 *       └─ on failure: restore the previous `current.json` verbatim, restart the previous
 *          release, write `update-blocked.json`, and surface the full diagnostic chain (never a
 *          silent fallback)
 *   → clear any blocked marker on success.
 *
 * Process control goes through the injected `HubLifecycleDriver` when present (the supervised
 * `run` command holds its own `ChildProcess`); the default driver is the pid-record flow above.
 *
 * Two Hubs are never started against the same data directory concurrently: the stop completes
 * before the commit, and the start path itself refuses to double-start. The short stop→start
 * window is honest downtime, not a zero-downtime canary.
 */
import { compareStrictSemver, isStrictSemver } from '@helm/protocol';
import {
  clearBlockedRelease,
  deleteCurrentRelease,
  readBlockedRelease,
  readCurrentRelease,
  withUpdateLock,
  writeBlockedRelease,
  writeCurrentRelease,
  type CurrentReleaseRecord,
} from '@helm/update';
import { defaultHubDataDir, pathsOf, resolveBlockedCooldownMs } from './layout.js';
import { isBlockedActive, readLaunchConfig, readPidRecord, resolveEffectiveLaunchConfig, type LaunchConfig } from './records.js';
import { isAliveOf, UsageError, type LauncherIo } from './io.js';
import { startHubLocked, stopHubLocked, withLifecycleLock } from './process.js';
import { defaultUpdateCore, type UpdateCore } from './update-core.js';
import { stageHubRelease } from './staging.js';

export interface PerformUpdateOptions {
  io: LauncherIo;
  root: string;
  pkgName: string;
  registryUrl?: string;
  /** Explicit target version (strict SemVer). */
  targetVersion?: string;
  /** npm dist-tag channel used when no explicit version is given (default `latest`). */
  tag?: string;
  /** Local tarball install source; requires `targetVersion`. */
  tarballPath?: string;
  force?: boolean;
  /** Start the Hub after committing even when it was not running before. */
  startIfNotRunning?: boolean;
  /** Launch flags for the post-commit start (highest precedence, persisted on success). */
  launchFlags?: LaunchConfig;
  fetchFn?: typeof fetch;
  /** Test seam: port-shaped fake standing in for the real adapter (registry/npm seams). */
  core?: UpdateCore;
  /**
   * Lifecycle driver overriding the record-based detached start/stop (the supervised `run`
   * command injects one that holds the spawned `ChildProcess`). Absent = default record flow.
   */
  driver?: HubLifecycleDriver;
  healthTimeoutMs?: number;
  pollMs?: number;
  stopTimeoutMs?: number;
  payloadCheckTimeoutMs?: number;
}

/**
 * Process-control seam behind the update orchestration. The default implementation talks to the
 * pid record (detached hubs started by earlier launcher runs); a supervising caller injects its
 * own so every stop/start/rollback in the sequence targets the process it holds.
 */
export interface HubLifecycleDriver {
  /** Whether a hub controlled by this driver is currently running. */
  isRunning(): Promise<boolean>;
  /** Stop that hub (graceful, then escalated). Must throw on failure. */
  stop(): Promise<void>;
  /** Start the committed release and gate on its readiness. */
  start(): Promise<{ pid: number; url: string }>;
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
  pid?: number;
  url?: string;
}

/** Resolve and validate the effective target version (explicit flag, or the registry dist-tag). */
async function resolveTargetVersion(options: PerformUpdateOptions): Promise<string> {
  if (options.tarballPath !== undefined) {
    if (options.targetVersion === undefined) {
      throw new UsageError('--tarball requires an explicit --version to name the staged release', 'tarball_requires_version');
    }
    return options.targetVersion;
  }
  if (options.targetVersion !== undefined) return options.targetVersion;
  const core = options.core ?? defaultUpdateCore();
  const latest = await core.fetchLatestVersion(options.pkgName, {
    ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.tag !== undefined ? { tag: options.tag } : {}),
  });
  if (!isStrictSemver(latest)) {
    throw new Error(`registry latest version is not strict SemVer: "${latest}"`);
  }
  return latest;
}

export async function performHubUpdate(options: PerformUpdateOptions): Promise<UpdateOutcome> {
  const { io, root } = options;
  const paths = pathsOf(root);
  const core = options.core ?? defaultUpdateCore();
  return await withUpdateLock(root, async () => {
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
      return { previousVersion, targetVersion, changed: false, restarted: false, started: false };
    }
    if (previousVersion !== null && compareStrictSemver(targetVersion, previousVersion) < 0 && options.force !== true) {
      throw new UsageError(
        `target version ${targetVersion} is older than current ${previousVersion}; pass --force to downgrade deliberately`,
        'downgrade_rejected',
      );
    }

    // Program/data separation guard for staging: effective data dir (flags > env > launch.json > ~/.helm).
    const effectiveDataDir = resolveEffectiveLaunchConfig({
      ...(options.launchFlags !== undefined ? { flags: options.launchFlags } : {}),
      env: io.env,
      saved: await readLaunchConfig(root),
    }).dataDir ?? defaultHubDataDir(io.env);
    const staged = await stageHubRelease({
      io,
      core,
      root,
      version: targetVersion,
      pkgName: options.pkgName,
      dataDir: effectiveDataDir,
      ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
      ...(options.tarballPath !== undefined ? { tarballPath: options.tarballPath } : {}),
      ...(options.force ? { force: true } : {}),
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
      ...(options.payloadCheckTimeoutMs !== undefined ? { payloadCheckTimeoutMs: options.payloadCheckTimeoutMs } : {}),
    });

    // One atomic lifecycle section: the wasRunning decision, the stop of the old hub, the
    // pointer commit, the candidate start (and its rollback) never interleave with concurrent
    // start/stop commands on the same machine (#77 lifecycle-lock requirement).
    return await withLifecycleLock(root, async (): Promise<UpdateOutcome> => {
      const wasRunning = options.driver !== undefined
        ? await options.driver.isRunning()
        : await (async () => {
            const pidRecord = await readPidRecord(root);
            return pidRecord !== null && isAliveOf(io)(pidRecord.pid);
          })();
      if (wasRunning) {
        // Stop before any state changes: a failed stop aborts the update with current.json intact.
        if (options.driver !== undefined) await options.driver.stop();
        else {
          await stopHubLocked(root, io, {
            ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {}),
            ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
          });
        }
      }

      const previousRecord: CurrentReleaseRecord | null = current;
      await writeCurrentRelease(root, {
        version: targetVersion,
        updatedAt: new Date().toISOString(),
        entries: { entryPath: staged.entryPath },
      });

      if (!wasRunning && options.startIfNotRunning !== true) {
        await clearBlockedRelease(root);
        return { previousVersion, targetVersion, changed: true, restarted: false, started: false };
      }

      try {
        const started =
          options.driver !== undefined
            ? await options.driver.start()
            : await startHubLocked(root, io, {
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
        const rollbackNotes: string[] = [`candidate ${targetVersion} failed to become ready: ${reason}`];
        // Roll the pointer back before restarting anything (verbatim engine record restore).
        if (previousRecord !== null) await writeCurrentRelease(root, previousRecord);
        else await deleteCurrentRelease(root);
        if (wasRunning) {
          try {
            const oldStart =
              options.driver !== undefined
                ? await options.driver.start()
                : await startHubLocked(root, io, {
                    ...(options.launchFlags !== undefined ? { flags: options.launchFlags } : {}),
                    ...(options.healthTimeoutMs !== undefined ? { healthTimeoutMs: options.healthTimeoutMs } : {}),
                    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
                    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
                  });
            rollbackNotes.push(`rolled back to ${previousRecord?.version ?? '?'} (pid ${oldStart.pid}, ${oldStart.url})`);
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
          reason: `candidate readiness failed: ${reason.slice(0, 500)}`,
          at: new Date().toISOString(),
        });
        throw new Error(rollbackNotes.join('\n'));
      }
    });
  });
}

export interface HubUpgradeCheckResult {
  currentVersion: string | null;
  latestVersion: string;
  updateAvailable: boolean;
  blocked: { version: string; reason: string; at: string } | null;
}

/** Registry check without touching any state (the `check` command). */
export async function checkHubUpgrade(options: {
  io: LauncherIo;
  root: string;
  pkgName: string;
  registryUrl?: string;
  tag?: string;
  fetchFn?: typeof fetch;
  core?: UpdateCore;
}): Promise<HubUpgradeCheckResult> {
  const core = options.core ?? defaultUpdateCore();
  const latestVersion = await core.fetchLatestVersion(options.pkgName, {
    ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.tag !== undefined ? { tag: options.tag } : {}),
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
