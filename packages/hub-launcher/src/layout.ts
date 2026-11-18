/**
 * Install-root layout and product defaults for the Hub launcher.
 *
 * Program state is strictly separated from user data: releases, current/blocked pointers (via
 * `@helm/update` state ops), the pid record, and logs live under the launcher install root
 * (default `~/.helm-hub`, env `HELM_HUB_INSTALL_ROOT`), while the Hub's own `~/.helm`
 * (`HELM_DATA_DIR`) data directory and plugin state are never written by the launcher. The
 * launcher binary itself is a stable external install and is never overwritten by the releases it
 * manages (launcher self-update is explicitly out of scope).
 */
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PAYLOAD_PACKAGE = '@team4u/helm-hub';
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

/** Timeouts and cooldowns; every one is injectable/overridable so tests never rely on wall-clock luck. */
export const DEFAULTS = {
  /** Overall readiness budget when starting a Hub candidate (stdout listen line + liveness). */
  healthTimeoutMs: 60_000,
  /** Readiness poll interval (log scan + liveness). */
  healthPollMs: 500,
  /** Per-request probe timeout for a single auxiliary `GET /api/auth/status`. */
  healthRequestTimeoutMs: 2_000,
  /** Grace period between SIGTERM and process-tree escalation when stopping the Hub. */
  stopTimeoutMs: 20_000,
  /** Wait after escalation before declaring the process unstoppable. */
  stopEscalationWaitMs: 10_000,
  /** Cooldown before the same blocked version may be retried (env `HELM_UPGRADE_BLOCK_COOLDOWN_MS`). */
  blockedCooldownMs: 30 * 60_000,
  /** npm install inside a staged candidate (run through the engine's npm runner). */
  npmInstallTimeoutMs: 300_000,
  /** `node start.mjs check` self-verification budget inside staging. */
  payloadCheckTimeoutMs: 120_000,
  /** Short probe used to verify hub identity before signalling a pid. */
  identityProbeTimeoutMs: 2_000,
  /** Supervised `run` update-check interval (env `HELM_HUB_UPDATE_INTERVAL_MS`). */
  updateIntervalMs: 6 * 60 * 60 * 1000,
} as const;

export interface LauncherPaths {
  root: string;
  releasesDir: string;
  pidPath: string;
  launchConfigPath: string;
  logDir: string;
  hubLogPath: string;
  /** Serializes process-state mutations (start/stop and the update stop→commit→start window). */
  lifecycleLockPath: string;
}

export function pathsOf(root: string): LauncherPaths {
  return {
    root,
    releasesDir: path.join(root, 'releases'),
    pidPath: path.join(root, 'hub.pid'),
    launchConfigPath: path.join(root, 'launch.json'),
    logDir: path.join(root, 'logs'),
    hubLogPath: path.join(root, 'logs', 'hub.log'),
    lifecycleLockPath: path.join(root, 'lifecycle.lock'),
  };
}

export function resolveInstallRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.HELM_HUB_INSTALL_ROOT;
  if (explicit !== undefined && explicit !== '') return path.resolve(explicit);
  return path.join(os.homedir(), '.helm-hub');
}

/**
 * The Hub's data directory when no explicit value is configured (mirrors the kernel's
 * `resolveDataDir`: `HELM_DATA_DIR` when non-empty, else `~/.helm`). Used for the program/data
 * separation guard; the launched Hub process itself owns the real resolution.
 */
export function defaultHubDataDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.HELM_DATA_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  return path.join(os.homedir(), '.helm');
}

/** Published Hub payload package name (`HELM_PAYLOAD_PACKAGE` overrides; must match the payload build). */
export function resolvePayloadPackageName(env: NodeJS.ProcessEnv): string {
  const value = env.HELM_PAYLOAD_PACKAGE ?? DEFAULT_PAYLOAD_PACKAGE;
  if (value === '' || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(value)) {
    throw new Error(`invalid payload package name: "${value}"`);
  }
  return value;
}

/** npm registry URL (explicit > `HELM_NPM_REGISTRY` from the passed env > official). */
export function resolveRegistryUrl(env: NodeJS.ProcessEnv, explicit?: string): string {
  const value = explicit ?? env.HELM_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY;
  if (!/^https?:\/\//.test(value)) {
    throw new Error(`invalid npm registry URL: "${value}" (expected http(s)://…)`);
  }
  return value.replace(/\/+$/, '');
}

/** Blocked-version cooldown override (env `HELM_UPGRADE_BLOCK_COOLDOWN_MS`, positive integer). */
export function resolveBlockedCooldownMs(env: NodeJS.ProcessEnv): number {
  const raw = env.HELM_UPGRADE_BLOCK_COOLDOWN_MS;
  if (raw === undefined || raw === '') return DEFAULTS.blockedCooldownMs;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid HELM_UPGRADE_BLOCK_COOLDOWN_MS: "${raw}" (expected a positive integer)`);
  }
  return parsed;
}

/** Supervised-run update-check interval override (env `HELM_HUB_UPDATE_INTERVAL_MS`, positive integer). */
export function resolveUpdateIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.HELM_HUB_UPDATE_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULTS.updateIntervalMs;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid HELM_HUB_UPDATE_INTERVAL_MS: "${raw}" (expected a positive integer)`);
  }
  return parsed;
}

/** npm dist-tag channel for supervised runs (env `HELM_HUB_UPDATE_TAG`, default `latest`). */
export function resolveUpdateTag(env: NodeJS.ProcessEnv): string {
  return assertDistTag(env.HELM_HUB_UPDATE_TAG && env.HELM_HUB_UPDATE_TAG !== '' ? env.HELM_HUB_UPDATE_TAG : 'latest');
}

/**
 * Validate an npm dist-tag segment. Mirrors the shared engine's rule (a single path-safe segment,
 * version-shaped values belong to the exact-version channel) so misconfiguration fails at the CLI
 * boundary with the launcher's own message; the engine re-validates at query time.
 */
export function assertDistTag(tag: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error(`invalid dist-tag "${tag}" (expected a single npm dist-tag segment such as "latest" or "beta")`);
  }
  if (/^\d+\.\d+\.\d+(-[\w.-]+)?(\+[\w.-]+)?$/.test(tag)) {
    throw new Error(`"${tag}" looks like a version, not a dist-tag; pass --version for exact-version updates`);
  }
  return tag;
}

/** Directory of a package inside an npm `node_modules` layout (`@scope/name` → `@scope/name`). */
export function packageModulesDir(modulesRoot: string, pkgName: string): string {
  return path.join(modulesRoot, ...pkgName.split('/'));
}

/**
 * Program/data separation guard: the launcher install root (releases, records, logs — written and
 * replaced by updates) must never overlap the Hub's data directory (conversations, plugins,
 * credentials — user data). Nesting in either direction is rejected explicitly: an update wiping
 * or restaging inside user data, or the Hub writing state into release directories, would both be
 * silent data corruption. The Hub's implicit default (`~/.helm`) applies when `dataDir` is unset.
 */
export function assertInstallIsolation(installRoot: string, dataDir: string | undefined, env: NodeJS.ProcessEnv): void {
  const explicit = dataDir ?? (env.HELM_DATA_DIR !== undefined && env.HELM_DATA_DIR !== '' ? env.HELM_DATA_DIR : undefined);
  const data = path.resolve(explicit ?? path.join(os.homedir(), '.helm'));
  const program = path.resolve(installRoot);
  const nested = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep);
  if (nested(program, data) || nested(data, program)) {
    throw new Error(
      `install root (${program}) and Hub data directory (${data}) must not overlap: program releases/state and user data are strictly separate trees (check HELM_HUB_INSTALL_ROOT vs HELM_DATA_DIR/--data-dir)`,
    );
  }
}
