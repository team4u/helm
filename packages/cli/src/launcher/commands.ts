/**
 * Command implementations: check / update / start / stop / restart. Each command prints either
 * human-readable text or a JSON object (`--json`) and returns a process exit code. Errors carry
 * a stable `code` (UsageError) surfaced in the JSON error envelope by the CLI layer.
 *
 * Verb split (matches `helmx-node`): `start`/`stop`/`restart` own the local Hub lifecycle;
 * `update` is the explicit, proactive update command (`claude update` semantics). There is no
 * supervised watch mode — background update readiness is surfaced by the Hub itself
 * (`/api/hub-update`) and applied by `helmx update` or the Web UI.
 */
import { readCurrentRelease, readBlockedRelease } from '@helmx/env-io';
import { assertDistTag, pathsOf, resolvePayloadPackageName, resolveRegistryUrl } from './layout.js';
import { readLaunchConfig, readPidRecord, resolveEffectiveLaunchConfig } from './records.js';
import { readRunningHub, startHub, stopHubGraceful, withLifecycleLock } from './process.js';
import { checkHubUpgrade, performHubUpdate } from './update.js';
import { runHubForeground } from './run.js';
import { describeActivityCounts } from './activity.js';
import type { UpdateCore } from './update-core.js';
import { UsageError, isAliveOf, type LauncherIo } from './io.js';

export interface CommandContext {
  io: LauncherIo;
  root: string;
  /** Test seams: fake registry fetch and a port-shaped update-core fake (no registry/npm). */
  fetchFn?: typeof fetch;
  core?: UpdateCore;
}

export interface CommandFlags {
  version?: string;
  registry?: string;
  tag?: string;
  tarball?: string;
  force?: boolean;
  json?: boolean;
  detached?: boolean;
  port?: number;
  host?: string;
  dataDir?: string;
  model?: string;
  webDistDir?: string;
  healthTimeoutMs?: number;
}

function payloadPackageNameOf(ctx: CommandContext): string {
  return resolvePayloadPackageName(ctx.io.env);
}

/** Registry URL honoring the `--registry` flag and the `HELMX_NPM_REGISTRY` environment alike. */
function registryUrlOf(ctx: CommandContext, flags: CommandFlags): string {
  return resolveRegistryUrl(ctx.io.env, flags.registry);
}

function tagOf(flags: CommandFlags, env: NodeJS.ProcessEnv): string | undefined {
  if (flags.tag !== undefined) return assertDistTag(flags.tag);
  if (env.HELMX_HUB_UPDATE_TAG !== undefined && env.HELMX_HUB_UPDATE_TAG !== '') {
    return assertDistTag(env.HELMX_HUB_UPDATE_TAG);
  }
  return undefined;
}

function launchFlagsOf(flags: CommandFlags) {
  return {
    ...(flags.port !== undefined ? { port: flags.port } : {}),
    ...(flags.host !== undefined ? { host: flags.host } : {}),
    ...(flags.dataDir !== undefined ? { dataDir: flags.dataDir } : {}),
    ...(flags.model !== undefined ? { model: flags.model } : {}),
    ...(flags.webDistDir !== undefined ? { webDistDir: flags.webDistDir } : {}),
  };
}

function flagsAsJson(flags: CommandFlags): boolean {
  return flags.json === true;
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

export async function cmdCheck(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  const tag = tagOf(flags, ctx.io.env);
  const result = await checkHubUpgrade({
    io: ctx.io,
    root: ctx.root,
    pkgName: payloadPackageNameOf(ctx),
    ...(ctx.core !== undefined ? { core: ctx.core } : {}),
    registryUrl: registryUrlOf(ctx, flags),
    ...(tag !== undefined ? { tag } : {}),
    ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
  });
  if (flagsAsJson(flags)) {
    ctx.io.out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const lines = [
    `current:  ${result.currentVersion ?? '(not installed)'}`,
    `latest:   ${result.latestVersion}`,
    `update:   ${result.updateAvailable ? 'available' : 'up to date'}`,
  ];
  if (result.blocked !== null) {
    lines.push(`blocked:  ${result.blocked.version} since ${result.blocked.at} (${result.blocked.reason})`);
  }
  ctx.io.out(`${lines.join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export async function cmdUpdate(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  const tag = tagOf(flags, ctx.io.env);
  const outcome = await performHubUpdate({
    io: ctx.io,
    root: ctx.root,
    pkgName: payloadPackageNameOf(ctx),
    registryUrl: registryUrlOf(ctx, flags),
    ...(flags.version !== undefined ? { targetVersion: flags.version } : {}),
    ...(tag !== undefined ? { tag } : {}),
    ...(flags.tarball !== undefined ? { tarballPath: flags.tarball } : {}),
    ...(flags.force ? { force: true } : {}),
    startIfNotRunning: true,
    launchFlags: launchFlagsOf(flags),
    ...(flags.healthTimeoutMs !== undefined ? { healthTimeoutMs: flags.healthTimeoutMs } : {}),
    ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
    ...(ctx.core !== undefined ? { core: ctx.core } : {}),
  });
  if (flagsAsJson(flags)) {
    ctx.io.out(`${JSON.stringify({ ok: true, ...outcome }, null, 2)}\n`);
    return 0;
  }
  if (outcome.deferred !== undefined) {
    ctx.io.out(
      `update to ${outcome.targetVersion} deferred: hub is busy (${describeActivityCounts(outcome.deferred.counts)}); ` +
        'the candidate is staged and the current release keeps serving (pass --force to bypass)\n',
    );
    return 0;
  }
  if (!outcome.changed) {
    ctx.io.out(`already at ${outcome.targetVersion}; nothing to do (use --force to restage)\n`);
    return 0;
  }
  const lines = [`updated: ${outcome.previousVersion ?? '(none)'} -> ${outcome.targetVersion}`];
  if (outcome.restarted) lines.push(`hub restarted (pid ${outcome.pid}, ${outcome.url})`);
  else if (outcome.started) lines.push(`hub started (pid ${outcome.pid}, ${outcome.url})`);
  ctx.io.out(`${lines.join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// start / stop / restart
// ---------------------------------------------------------------------------

interface StartedInfo {
  pid: number;
  version: string;
  url: string;
  logPath: string;
}

/** Refuse when a hub this command did not start is already running (never adopt foreign processes). */
async function assertNoExistingHub(ctx: CommandContext): Promise<void> {
  const record = await readPidRecord(ctx.root);
  if (record !== null && isAliveOf(ctx.io)(record.pid)) {
    throw new UsageError(
      `a hub is already running (pid ${record.pid}, version ${record.version}); use helmx restart to take it over, helmx stop to stop it, or keep managing it manually`,
      'start_refuses_existing_hub',
    );
  }
}

/** Install-if-needed then start detached; shared by `start -d` and `restart`. */
async function ensureHubStartedDetached(ctx: CommandContext, flags: CommandFlags): Promise<StartedInfo> {
  await assertNoExistingHub(ctx);
  const current = await readCurrentRelease(ctx.root);
  if (current === null) {
    const outcome = await performHubUpdate({
      io: ctx.io,
      root: ctx.root,
      pkgName: payloadPackageNameOf(ctx),
      registryUrl: registryUrlOf(ctx, flags),
      ...(tagOf(flags, ctx.io.env) !== undefined ? { tag: tagOf(flags, ctx.io.env)! } : {}),
      startIfNotRunning: true,
      launchFlags: launchFlagsOf(flags),
      ...(flags.healthTimeoutMs !== undefined ? { healthTimeoutMs: flags.healthTimeoutMs } : {}),
      ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
      ...(ctx.core !== undefined ? { core: ctx.core } : {}),
    });
    if (outcome.pid === undefined || outcome.url === null) {
      throw new UsageError('install finished without a running hub (internal error)', 'bootstrap_start_failed');
    }
    return { pid: outcome.pid, version: outcome.targetVersion, url: outcome.url as string, logPath: pathsOf(ctx.root).hubLogPath };
  }
  const started = await startHub(ctx.root, ctx.io, {
    flags: launchFlagsOf(flags),
    ...(flags.healthTimeoutMs !== undefined ? { healthTimeoutMs: flags.healthTimeoutMs } : {}),
    ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
  });
  return { pid: started.pid, version: started.version, url: started.url, logPath: started.logPath };
}

export async function cmdStart(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  if (flags.detached === true) {
    const started = await ensureHubStartedDetached(ctx, flags);
    if (flagsAsJson(flags)) {
      ctx.io.out(`${JSON.stringify({ ok: true, detached: true, pid: started.pid, version: started.version, url: started.url, log: started.logPath }, null, 2)}\n`);
      return 0;
    }
    ctx.io.out(`hub started (pid ${started.pid}, ${started.url})\nlog: ${started.logPath}\n`);
    return 0;
  }
  if (flagsAsJson(flags)) {
    throw new UsageError(
      'foreground start streams hub log lines and is meant for an interactive terminal or a service manager; --json is only supported with --detached',
      'json_not_supported_for_foreground_start',
    );
  }
  return await runHubForeground({
    io: ctx.io,
    root: ctx.root,
    pkgName: payloadPackageNameOf(ctx),
    registryUrl: registryUrlOf(ctx, flags),
    ...(tagOf(flags, ctx.io.env) !== undefined ? { tag: tagOf(flags, ctx.io.env)! } : {}),
    launchFlags: launchFlagsOf(flags),
    ...(flags.healthTimeoutMs !== undefined ? { healthTimeoutMs: flags.healthTimeoutMs } : {}),
    ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
    ...(ctx.core !== undefined ? { core: ctx.core } : {}),
  });
}

export async function cmdStop(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  const result = await stopHubGraceful(ctx.root, ctx.io);
  if (flagsAsJson(flags)) {
    ctx.io.out(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return 0;
  }
  if (!result.wasRunning) {
    ctx.io.out(result.cleanedStalePid ? 'hub was not running (stale pid record removed)\n' : 'hub is not running\n');
    return 0;
  }
  const via = result.via === 'control-channel' ? ' via control channel' : '';
  ctx.io.out(`hub pid ${result.pid} stopped${via}${result.escalated ? ' (escalated after graceful timeout)' : ''}\n`);
  return 0;
}

export async function cmdRestart(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  const stopped = await stopHubGraceful(ctx.root, ctx.io);
  const started = await ensureHubStartedDetached(ctx, flags);
  if (flagsAsJson(flags)) {
    ctx.io.out(
      `${JSON.stringify({ ok: true, wasRunning: stopped.wasRunning, pid: started.pid, version: started.version, url: started.url, log: started.logPath }, null, 2)}\n`,
    );
    return 0;
  }
  const lines = [
    stopped.wasRunning ? `hub pid ${stopped.pid} stopped` : 'hub was not running',
    `hub started (pid ${started.pid}, ${started.url})`,
  ];
  ctx.io.out(`${lines.join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// local snapshot (merged into `helmx status`)
// ---------------------------------------------------------------------------

export interface LocalHubSnapshot {
  installRoot: string;
  current: { version: string; updatedAt: string } | null;
  running:
    | { pid: number; version: string; port: number; alive: boolean; healthy: boolean; startedAt: string }
    | null;
  blocked: { version: string; reason: string; at: string } | null;
  launch: { port: number; host?: string; dataDir?: string };
  pidFile: string;
  logFile: string;
}

/** Read-only local-Hub snapshot for `helmx status` (no side effects, honest about liveness). */
export async function readLocalHubSnapshot(ctx: CommandContext): Promise<LocalHubSnapshot> {
  const paths = pathsOf(ctx.root);
  const current = await readCurrentRelease(ctx.root);
  const running = await readRunningHub(ctx.root, ctx.io, ctx.fetchFn);
  const saved = await readLaunchConfig(ctx.root);
  const effective = resolveEffectiveLaunchConfig({ env: ctx.io.env, saved });
  const blocked = await readBlockedRelease(ctx.root);
  return {
    installRoot: ctx.root,
    current:
      current === null
        ? null
        : {
            version: current.version,
            updatedAt: current.updatedAt,
          },
    running:
      running === null
        ? null
        : {
            pid: running.record.pid,
            version: running.record.version,
            port: running.record.port,
            alive: running.alive,
            healthy: running.health !== null,
            startedAt: running.record.startedAt,
          },
    blocked,
    launch: {
      port: effective.port,
      ...(effective.host !== undefined ? { host: effective.host } : {}),
      ...(effective.dataDir !== undefined ? { dataDir: effective.dataDir } : {}),
    },
    pidFile: paths.pidPath,
    logFile: paths.hubLogPath,
  };
}
