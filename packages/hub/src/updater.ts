/**
 * In-Hub background updater: when the Hub runs from a payload-managed install root
 * (`HELMX_HUB_INSTALL_ROOT` set by the launcher / update handoff), a timer periodically checks
 * the npm dist-tag and SILENTLY STAGES newer candidates (verified unpack + npm install +
 * `start.mjs check`) without ever touching the running process. Switching is a separate,
 * explicit act (`helmx update` or the Web UI apply button) — the VS Code-style "download now,
 * restart when you choose" policy.
 *
 * Honesty boundaries: check/stage failures are recorded (`lastError`) and logged to stderr,
 * never swallowed and never fatal to the serving Hub; a blocked release cooldown suppresses
 * restaging of the blocked version; staging never gates on activity because it cannot disturb
 * the running Hub (the busy gate lives in the apply step, where a restart actually happens).
 */
import process from 'node:process';
import { readBlockedRelease, readCurrentRelease } from '@helmx/env-io';
import { readUpdateReady, stageHubRelease, writeUpdateReady, defaultHubUpdateCore, resolveRegistryUrlForEnv, type HubUpdateCore } from '@helmx/env-io/hub-payload';

/** Blocked-release cooldown (mirrors the launcher's `HELMX_UPGRADE_BLOCK_COOLDOWN_MS` default). */
const BLOCKED_COOLDOWN_MS = 30 * 60_000;

export interface HubUpdateStatus {
  active: boolean;
  channel: string;
  intervalMs: number;
  currentVersion: string | null;
  readyVersion: string | null;
  lastCheckAt: string | null;
  lastError: string | null;
  blocked: { version: string; reason: string; at: string } | null;
}

export interface HubUpdaterHandle {
  status(): HubUpdateStatus;
  /** Run one check/stage cycle immediately (test/manual trigger); concurrent calls serialize. */
  triggerCheck(): Promise<void>;
  stop(): Promise<void>;
}

export interface HubUpdaterOptions {
  /** Install root owning `releases/` + state (payload-managed hubs only; omitted = unmanaged). */
  root?: string;
  pkgName: string;
  env: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  /** Test seam for the registry/npm machinery. */
  core?: HubUpdateCore;
  /** Test seam replacing the staging transaction (defaults to the shared `stageHubRelease`). */
  stage?: (options: { version: string; pkgName: string }) => Promise<{ version: string; entryPath: string; releaseDir: string }>;
  /** Effective hub data directory (isolation guard for staging). */
  dataDir: string;
  /** Override the check interval (env `HELMX_HUB_UPDATE_INTERVAL_MS`, default 15 minutes, 0 disables). */
  intervalMs?: number;
  /** Override the channel (env `HELMX_HUB_UPDATE_TAG`, default `latest`). */
  channel?: string;
  log?: (line: string) => void;
}

export interface UpdaterConfig {
  root: string;
  channel: string;
  intervalMs: number;
  registryUrl: string;
}

/** Resolve updater config; `null` when this Hub is not payload-managed or updates are disabled. */
export function resolveUpdaterConfig(options: { root?: string; env: NodeJS.ProcessEnv; intervalMs?: number; channel?: string }): UpdaterConfig | null {
  const root = options.root ?? options.env.HELMX_HUB_INSTALL_ROOT;
  if (root === undefined || root === '') return null;
  const rawInterval = options.intervalMs ?? parseInterval(options.env.HELMX_HUB_UPDATE_INTERVAL_MS);
  if (rawInterval === 0) return null;
  const channel = options.channel ?? (options.env.HELMX_HUB_UPDATE_TAG && options.env.HELMX_HUB_UPDATE_TAG !== '' ? options.env.HELMX_HUB_UPDATE_TAG : 'latest');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(channel)) {
    throw new Error(`invalid HELMX_HUB_UPDATE_TAG: "${channel}" (expected a dist-tag segment such as latest or beta)`);
  }
  if (/^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/.test(channel)) {
    throw new Error(`invalid HELMX_HUB_UPDATE_TAG: "${channel}" looks like a version, not a dist-tag`);
  }
  return { root, channel, intervalMs: rawInterval, registryUrl: resolveRegistryUrlForEnv(options.env) };
}

function parseInterval(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 15 * 60_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid HELMX_HUB_UPDATE_INTERVAL_MS: "${raw}" (expected 0 or a positive integer)`);
  }
  return parsed;
}

/** Cooldown gate: a blocked version is not restaged until the cooldown passes. */
export function isBlockedVersionActive(
  blocked: { version: string; at: string } | null,
  version: string,
  now: Date,
  cooldownMs: number = BLOCKED_COOLDOWN_MS,
): boolean {
  if (blocked === null || blocked.version !== version) return false;
  const at = Date.parse(blocked.at);
  if (!Number.isFinite(at)) return true; // unparseable: keep blocking rather than guessing
  return now.getTime() - at < cooldownMs;
}

/** Start the background check/stage loop; returns `null` when inactive. */
export function startHubUpdater(options: HubUpdaterOptions): HubUpdaterHandle | null {
  const config = resolveUpdaterConfig({ root: options.root, env: options.env, intervalMs: options.intervalMs, channel: options.channel });
  if (config === null) return null;
  const core = options.core ?? defaultHubUpdateCore();
  const log = options.log ?? ((line: string) => process.stderr.write(`[hub-updater] ${line}\n`));
  // Default staging binding (env-io `stageHubRelease` with this updater's resolved config).
  const defaultStage = async (request: { version: string; pkgName: string }): Promise<{ version: string; entryPath: string; releaseDir: string }> =>
    await stageHubRelease({
      env: options.env,
      core,
      root: config.root,
      version: request.version,
      pkgName: request.pkgName,
      dataDir: options.dataDir,
      registryUrl: config.registryUrl,
      ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    });
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | undefined;
  const state: HubUpdateStatus = {
    active: true,
    channel: config.channel,
    intervalMs: config.intervalMs,
    currentVersion: null,
    readyVersion: null,
    lastCheckAt: null,
    lastError: null,
    blocked: null,
  };

  const oneCycle = async (): Promise<void> => {
    state.lastCheckAt = new Date().toISOString();
    try {
      const current = await readCurrentRelease(config.root);
      state.currentVersion = current?.version ?? null;
      const blocked = await readBlockedRelease(config.root);
      state.blocked = blocked;
      const ready = await readUpdateReady(config.root).catch(() => null);
      state.readyVersion = ready?.version ?? null;
      if (current === null) return; // nothing committed to update from; the CLI owns bootstrap installs
      const latest = await core.fetchLatestVersion(options.pkgName, {
        registryUrl: config.registryUrl,
        ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
        tag: config.channel,
      });
      if (latest === current.version) {
        state.lastError = null;
        return;
      }
      if (isBlockedVersionActive(blocked, latest, new Date())) {
        state.lastError = null;
        return; // cooldown: the blocked version is not retried until it passes
      }
      if (ready !== null && ready.version === latest) {
        state.lastError = null;
        return; // already staged and waiting for the explicit apply
      }
      const staged = await (options.stage ?? defaultStage)({
        version: latest,
        pkgName: options.pkgName,
      });
      await writeUpdateReady(config.root, {
        version: staged.version,
        entryPath: staged.entryPath,
        releaseDir: staged.releaseDir,
        tag: config.channel,
        stagedAt: new Date().toISOString(),
      });
      state.readyVersion = staged.version;
      state.lastError = null;
      log(`staged ${staged.version} (from tag "${config.channel}"); apply via helmx update or the Web UI`);
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      log(`check/stage cycle failed: ${state.lastError}`);
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      const run = (inFlight ?? Promise.resolve()).then(() => oneCycle()).finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      void run.finally(schedule);
    }, config.intervalMs);
    timer.unref?.();
  };
  schedule();

  return {
    status: () => ({ ...state }),
    triggerCheck: async () => {
      const run = (inFlight ?? Promise.resolve()).then(() => oneCycle()).finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      await run;
    },
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight?.catch(() => undefined);
    },
  };
}
