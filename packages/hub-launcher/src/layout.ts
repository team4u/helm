/**
 * Install-root layout and product defaults for the Hub launcher.
 *
 * Program state is strictly separated from user data: releases, current/blocked pointers, the pid
 * record, and logs live under the launcher install root (default `~/.helm-hub`, env
 * `HELM_HUB_INSTALL_ROOT`), while the Hub's own `~/.helm` (`HELM_DATA_DIR`) data directory and
 * plugin state are never written by the launcher. The launcher binary itself is a stable external
 * install and is never overwritten by the releases it manages.
 */
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_PAYLOAD_PACKAGE = '@team4u/helm-hub';

/** Timeouts and cooldowns; every one is injectable/overridable so tests never rely on wall-clock luck. */
export const DEFAULTS = {
  /** Overall readiness budget when starting a Hub candidate (health polling). */
  healthTimeoutMs: 60_000,
  /** Health poll interval. */
  healthPollMs: 500,
  /** Per-request probe timeout for a single `GET /api/auth/status`. */
  healthRequestTimeoutMs: 2_000,
  /** Grace period between SIGTERM and process-tree escalation when stopping the Hub. */
  stopTimeoutMs: 20_000,
  /** Wait after escalation before declaring the process unstoppable. */
  stopEscalationWaitMs: 10_000,
  /** Cooldown before the same blocked version may be retried (env `HELM_HUB_BLOCKED_COOLDOWN_MS`). */
  blockedCooldownMs: 30 * 60_000,
  /** npm install inside a staged candidate (delegated to the update core). */
  npmInstallTimeoutMs: 300_000,
  /** `node start.mjs check` self-verification budget inside staging. */
  payloadCheckTimeoutMs: 120_000,
  /** Short probe used to verify hub identity before signalling a pid. */
  identityProbeTimeoutMs: 2_000,
} as const;

export interface LauncherPaths {
  root: string;
  releasesDir: string;
  currentPath: string;
  blockedPath: string;
  pidPath: string;
  launchConfigPath: string;
  logDir: string;
  hubLogPath: string;
  startLockPath: string;
}

export function pathsOf(root: string): LauncherPaths {
  return {
    root,
    releasesDir: path.join(root, 'releases'),
    currentPath: path.join(root, 'current.json'),
    blockedPath: path.join(root, 'update-blocked.json'),
    pidPath: path.join(root, 'hub.pid'),
    launchConfigPath: path.join(root, 'launch.json'),
    logDir: path.join(root, 'logs'),
    hubLogPath: path.join(root, 'logs', 'hub.log'),
    startLockPath: path.join(root, 'start.lock'),
  };
}

export function resolveInstallRoot(env: NodeJS.ProcessEnv): string {
  const explicit = env.HELM_HUB_INSTALL_ROOT;
  if (explicit !== undefined && explicit !== '') return path.resolve(explicit);
  return path.join(os.homedir(), '.helm-hub');
}

/** npm registry URL (explicit > `HELM_NPM_REGISTRY` > official). */
export function resolveRegistryUrl(env: NodeJS.ProcessEnv, explicit?: string): string {
  const value = explicit ?? env.HELM_NPM_REGISTRY ?? DEFAULT_NPM_REGISTRY;
  if (!/^https?:\/\//.test(value)) {
    throw new Error(`invalid npm registry URL: "${value}" (expected http(s)://…)`);
  }
  return value.replace(/\/+$/, '');
}

/** Published Hub payload package name (`HELM_PAYLOAD_PACKAGE` overrides; must match the payload build). */
export function resolvePayloadPackageName(env: NodeJS.ProcessEnv): string {
  const value = env.HELM_PAYLOAD_PACKAGE ?? DEFAULT_PAYLOAD_PACKAGE;
  if (value === '' || !/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(value)) {
    throw new Error(`invalid payload package name: "${value}"`);
  }
  return value;
}

/** Blocked-version cooldown override (env `HELM_HUB_BLOCKED_COOLDOWN_MS`, positive integer). */
export function resolveBlockedCooldownMs(env: NodeJS.ProcessEnv): number {
  const raw = env.HELM_HUB_BLOCKED_COOLDOWN_MS;
  if (raw === undefined || raw === '') return DEFAULTS.blockedCooldownMs;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid HELM_HUB_BLOCKED_COOLDOWN_MS: "${raw}" (expected a positive integer)`);
  }
  return parsed;
}

/** Directory of a package inside an npm `node_modules` layout (`@scope/name` → `@scope/name`). */
export function packageModulesDir(modulesRoot: string, pkgName: string): string {
  return path.join(modulesRoot, ...pkgName.split('/'));
}
