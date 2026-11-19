/**
 * Command implementations: check / update / run / start / stop / restart / status. Each command
 * prints either human-readable text or a JSON object (`--json`) and returns a process exit code.
 * Errors carry a stable `code` (UsageError) surfaced in the JSON error envelope by the CLI layer.
 */
import { readCurrentRelease, readBlockedRelease } from '@helm/update';
import { assertDistTag, pathsOf, resolvePayloadPackageName, resolveRegistryUrl, resolveUpdateIntervalMs, resolveUpdateTag } from './layout.js';
import { readLaunchConfig, resolveEffectiveLaunchConfig } from './records.js';
import { readRunningHub, startHub, stopHub } from './process.js';
import { checkHubUpgrade, performHubUpdate } from './update.js';
import { runSupervised } from './run.js';
import { describeActivityCounts } from './activity.js';
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
  tag?: string;
  intervalMs?: number;
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
}

function payloadPackageNameOf(ctx: CommandContext): string {
  return resolvePayloadPackageName(ctx.io.env);
}

/** Registry URL honoring the `--registry` flag and the `HELM_NPM_REGISTRY` environment alike. */
function registryUrlOf(ctx: CommandContext, flags: CommandFlags): string {
  return resolveRegistryUrl(ctx.io.env, flags.registry);
}

function tagOf(flags: CommandFlags, env: NodeJS.ProcessEnv): string | undefined {
  if (flags.tag !== undefined) return assertDistTag(flags.tag);
  if (env.HELM_HUB_UPDATE_TAG !== undefined && env.HELM_HUB_UPDATE_TAG !== '') {
    return assertDistTag(env.HELM_HUB_UPDATE_TAG);
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
  if (outcome.deferred !== undefined) {
    ctx.io.out(
      `update to ${outcome.targetVersion} deferred: hub is busy (${describeActivityCounts(outcome.deferred.counts)}); ` +
        'nothing was stopped or changed and the current release keeps serving (pass --force to bypass)\n',
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
  else lines.push('hub is not running; run start when ready');
  ctx.io.out(`${lines.join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export async function cmdRun(ctx: CommandContext, flags: CommandFlags): Promise<number> {
  if (flags.json === true) {
    throw new UsageError(
      'run streams human-readable progress lines and is meant for a service manager or an interactive terminal; --json is not supported for run',
      'json_not_supported_for_run',
    );
  }
  return await runSupervised({
    io: ctx.io,
    root: ctx.root,
    pkgName: payloadPackageNameOf(ctx),
    registryUrl: registryUrlOf(ctx, flags),
    tag: tagOf(flags, ctx.io.env) ?? resolveUpdateTag(ctx.io.env),
    intervalMs: flags.intervalMs ?? resolveUpdateIntervalMs(ctx.io.env),
    launchFlags: launchFlagsOf(flags),
    ...(flags.healthTimeoutMs !== undefined ? { healthTimeoutMs: flags.healthTimeoutMs } : {}),
    ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
    ...(ctx.core !== undefined ? { core: ctx.core } : {}),
  });
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
