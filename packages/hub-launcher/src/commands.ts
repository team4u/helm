/**
 * Command implementations: check / update / start / stop / restart / status. Each command prints
 * either human-readable text or a JSON object (`--json`) and returns a process exit code. Errors
 * carry a stable `code` (UsageError) surfaced in the JSON error envelope by the CLI layer.
 */
import process from 'node:process';
import { readCurrentRelease, readBlockedRelease } from '@helm/update';
import { pathsOf, resolveDistTag, resolvePayloadPackageName, resolveRunIntervalMs } from './layout.js';
import { readLaunchConfig, resolveEffectiveLaunchConfig } from './records.js';
import { readRunningHub, startHub, stopHub } from './process.js';
import { checkHubUpgrade, performHubUpdate } from './update.js';
import { runLauncherLoop, type RunLoopEvent } from './run.js';
import type { UpdateCore } from './update-core.js';
import { UsageError, type LauncherIo } from './io.js';

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
  tarball?: string;
  force?: boolean;
  start?: boolean;
  json?: boolean;
  help?: boolean;
  port?: number;
  host?: string;
  dataDir?: string;
  model?: string;
  webDistDir?: string;
  healthTimeoutMs?: number;
  /** Scheduled-loop controls (`run`): check interval in seconds and the npm dist-tag channel. */
  intervalSeconds?: number;
  tag?: string;
}

function payloadPackageNameOf(ctx: CommandContext): string {
  return resolvePayloadPackageName(ctx.io.env);
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
  const result = await checkHubUpgrade({
    io: ctx.io,
    root: ctx.root,
    pkgName: payloadPackageNameOf(ctx),
    ...(ctx.core !== undefined ? { core: ctx.core } : {}),
    ...(flags.registry !== undefined ? { registryUrl: flags.registry } : {}),
    ...(flags.tag !== undefined ? tagOf(ctx, flags) : {}),
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
  const outcome = await performHubUpdate({
    io: ctx.io,
    root: ctx.root,
    pkgName: payloadPackageNameOf(ctx),
    ...(flags.registry !== undefined ? { registryUrl: flags.registry } : {}),
    ...(flags.tag !== undefined ? tagOf(ctx, flags) : {}),
    ...(flags.version !== undefined ? { targetVersion: flags.version } : {}),
    ...(flags.tarball !== undefined ? { tarballPath: flags.tarball } : {}),
    ...(flags.force ? { force: true } : {}),
    ...(flags.start ? { startIfNotRunning: true } : {}),
    launchFlags: launchFlagsOf(flags),
    ...(flags.healthTimeoutMs !== undefined ? { healthTimeoutMs: flags.healthTimeoutMs } : {}),
    ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
    ...(ctx.core !== undefined ? { core: ctx.core } : {}),
  });
  if (flagsAsJson(flags)) {
    ctx.io.out(`${JSON.stringify({ ok: true, ...outcome }, null, 2)}\n`);
    return 0;
  }
  if (!outcome.changed) {
    ctx.io.out(`already at ${outcome.targetVersion}; nothing to do (use --force to restage)\n`);
    return 0;
  }
  const lines = [`updated: ${outcome.previousVersion ?? '(none)'} -> ${outcome.targetVersion}`];
  if (outcome.restarted) lines.push(`hub restarted (pid ${outcome.pid}, ${outcome.url})`);
  else if (outcome.started) lines.push(`hub started (pid ${outcome.pid}, ${outcome.url})`);
  else lines.push('hub is not running; run start when ready');
  ctx.io.out(`${lines.join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export async function cmdStart(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  const result = await startHub(ctx.root, ctx.io, {
    flags: launchFlagsOf(flags),
    ...(flags.healthTimeoutMs !== undefined ? { healthTimeoutMs: flags.healthTimeoutMs } : {}),
    ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
  });
  if (flagsAsJson(flags)) {
    ctx.io.out(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return 0;
  }
  const healthNote = result.health === null ? ' (auxiliary health probe unanswered)' : '';
  ctx.io.out(`hub ${result.version} running: pid ${result.pid} at ${result.url}${healthNote} (log: ${result.logPath})\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

export async function cmdStop(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  const result = await stopHub(ctx.root, ctx.io);
  if (flagsAsJson(flags)) {
    ctx.io.out(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return 0;
  }
  if (!result.wasRunning) {
    ctx.io.out(result.cleanedStalePid ? 'hub was not running (stale pid record removed)\n' : 'hub is not running\n');
    return 0;
  }
  ctx.io.out(
    `hub pid ${result.pid} stopped${result.escalated ? ' (escalated after graceful timeout)' : ''}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

export async function cmdRestart(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  const stopped = await stopHub(ctx.root, ctx.io);
  const result = await startHub(ctx.root, ctx.io, {
    flags: launchFlagsOf(flags),
    ...(flags.healthTimeoutMs !== undefined ? { healthTimeoutMs: flags.healthTimeoutMs } : {}),
    ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
  });
  if (flagsAsJson(flags)) {
    ctx.io.out(`${JSON.stringify({ ok: true, stopped, ...result }, null, 2)}\n`);
    return 0;
  }
  ctx.io.out(
    `${stopped.wasRunning ? 'stopped previous hub; ' : ''}hub ${result.version} running: pid ${result.pid} at ${result.url}\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function cmdStatus(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  const paths = pathsOf(ctx.root);
  const current = await readCurrentRelease(ctx.root);
  const running = await readRunningHub(ctx.root, ctx.io, ctx.fetchFn);
  const saved = await readLaunchConfig(ctx.root);
  const effective = resolveEffectiveLaunchConfig({ env: ctx.io.env, saved });
  const blocked = await readBlockedRelease(ctx.root);
  const payload = {
    installRoot: ctx.root,
    current:
      current === null
        ? null
        : {
            version: current.version,
            updatedAt: current.updatedAt,
            entryPath: current.entries['entryPath'] ?? null,
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
      host: effective.host,
      ...(effective.dataDir !== undefined ? { dataDir: effective.dataDir } : {}),
    },
    pidFile: paths.pidPath,
    logFile: paths.hubLogPath,
  };
  if (flagsAsJson(flags)) {
    ctx.io.out(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  const lines = [
    `install root: ${ctx.root}`,
    `current:      ${current === null ? '(not installed)' : `${current.version} (${current.updatedAt})`}`,
    `running:      ${
      running === null
        ? 'no'
        : `pid ${running.record.pid} (version ${running.record.version}, ${running.alive ? 'alive' : 'DEAD'}, ${
            running.health !== null ? 'healthy' : 'health unreachable'
          })`
    }`,
    `listen:       ${effective.host}:${effective.port}`,
  ];
  if (payload.blocked !== null) {
    lines.push(`blocked:      ${payload.blocked.version} since ${payload.blocked.at} (${payload.blocked.reason})`);
  }
  lines.push(`log:          ${paths.hubLogPath}`);
  ctx.io.out(`${lines.join('\n')}\n`);
  return running !== null && (!running.alive || running.health === null) ? 1 : 0;
}


// ---------------------------------------------------------------------------
// run (foreground scheduled auto-update supervisor)
// ---------------------------------------------------------------------------

function tagOf(ctx: CommandContext, flags: CommandFlags): { tag: string } {
  try {
    return { tag: resolveDistTag(ctx.io.env, flags.tag) };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), 'invalid_dist_tag');
  }
}

function formatRunEvent(event: RunLoopEvent): string {
  switch (event.type) {
    case 'installed':
      return `installed ${event.version}`;
    case 'already-running':
      return `hub already running (pid ${event.pid}, version ${event.version}); adopted`;
    case 'started':
      return `hub ${event.version} started: pid ${event.pid} at ${event.url}`;
    case 'start-failed':
      return `warning: hub failed to start: ${event.error}`;
    case 'no-update':
      return `up to date (${event.current}; latest on tag: ${event.latest})`;
    case 'updated':
      return `updated ${event.previous} -> ${event.next}: pid ${event.pid} at ${event.url}`;
    case 'check-failed':
      return `warning: update check failed: ${event.error}`;
    case 'update-failed':
      return `warning: update failed: ${event.error}`;
    case 'stopping':
      return 'shutting down: stopping the owned hub...';
    case 'stopped':
      return event.pid !== undefined ? `hub pid ${event.pid} stopped` : 'hub was not running';
    case 'stop-failed':
      return `warning: hub stop failed: ${event.error}`;
  }
}

export async function cmdRun(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  let intervalMs: number;
  try {
    intervalMs = resolveRunIntervalMs(ctx.io.env, flags.intervalSeconds);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error), 'invalid_interval');
  }
  const tag = tagOf(ctx, flags).tag;
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let summary: Awaited<ReturnType<typeof runLauncherLoop>>;
  try {
    summary = await runLauncherLoop({
      io: ctx.io,
      root: ctx.root,
      pkgName: payloadPackageNameOf(ctx),
      ...(flags.registry !== undefined ? { registryUrl: flags.registry } : {}),
      tag,
      intervalMs,
      launchFlags: launchFlagsOf(flags),
      ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
      ...(ctx.core !== undefined ? { core: ctx.core } : {}),
      ...(flags.healthTimeoutMs !== undefined ? { healthTimeoutMs: flags.healthTimeoutMs } : {}),
      signal: controller.signal,
      onEvent: (event) => {
        if (flagsAsJson(flags)) ctx.io.out(`${JSON.stringify(event)}\n`);
        else ctx.io.out(`${formatRunEvent(event)}\n`);
      },
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  if (flagsAsJson(flags)) {
    ctx.io.out(`${JSON.stringify({ ok: true, ...summary })}\n`);
    return summary.lastError !== undefined ? 1 : 0;
  }
  ctx.io.out(
    `run loop exited: ${summary.cycles} cycle(s), ${summary.updates} update(s), hub ${summary.stoppedHub ? 'stopped' : 'not stopped'}\n`,
  );
  return summary.lastError !== undefined ? 1 : 0;
}
