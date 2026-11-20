/**
 * Product routes for the Hub update surface (`/api/hub-update/*`), mounted through the kernel's
 * `productRoutes` mechanism (authenticated ahead of core dispatch). The busy gate uses the
 * kernel's own activity snapshot — an in-flight conversation, tool run, compaction, or queued
 * input defers the switch instead of killing work; `force` bypasses it explicitly.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { errorResponse, jsonOk, type ProductRouteHandler } from '@helmx/kernel';
import { isHubActivityBusy, type HubActivityCounts } from '@helmx/protocol';
import { readBlockedRelease } from '@helmx/env-io';
import { readUpdateReady, type UpdateReadyRecord } from '@helmx/env-io/hub-payload';
import { isBlockedVersionActive, type HubUpdaterHandle } from './updater.js';
import { readHubControlRecord } from './control.js';
import { sliceChangelog, type ChangelogSection, type LoadedChangelog } from './changelog.js';

export interface HubUpdateRoutesDeps {
  updater: HubUpdaterHandle | null;
  kernel: { activitySnapshot(): HubActivityCounts; dataDir: string };
  /** Install root (payload-managed hubs only; null when running unmanaged e.g. docker/dev). */
  root: string | null;
  /** Installed-version changelog (shipped CHANGELOG.md) plus the running Hub's version. */
  changelog: LoadedChangelog & { version: string };
  /** This boot's upgrade origin (`null` when the version did not change since the last run). */
  upgrade: { upgradedFrom: string | null };
  /** Test seam replacing the detached handoff spawn. */
  spawnHandoff?: (ready: UpdateReadyRecord, control: { endpoint: string; instanceId: string } | null) => Promise<{ pid: number }>;
}

/**
 * Spawn the payload's own update handoff: a detached, release-locked helper that stops this Hub
 * over the control channel, commits the staged release, starts the new one, and rolls back on
 * failure (see `packages/payload/src/update-handoff.mjs`).
 */
async function defaultSpawnHandoff(ready: UpdateReadyRecord, control: { endpoint: string; instanceId: string } | null): Promise<{ pid: number }> {
  if (control === null) {
    throw new Error('the running Hub exposes no control channel; apply requires a Hub started through the payload launcher');
  }
  const handoffPath = path.resolve(ready.releaseDir, 'update-handoff.mjs');
  const child = spawn(process.execPath, [handoffPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      HELMX_HANDOFF_ROOT: process.env.HELMX_HUB_INSTALL_ROOT ?? '',
      HELMX_HANDOFF_TARGET: ready.version,
      HELMX_HANDOFF_ENTRY: path.resolve(ready.releaseDir, ready.entryPath),
      HELMX_HANDOFF_RELEASE_DIR: ready.releaseDir,
      HELMX_HANDOFF_DATA_DIR: process.env.HELMX_DATA_DIR ?? '',
      HELMX_HANDOFF_CONTROL_ENDPOINT: control.endpoint,
      HELMX_HANDOFF_CONTROL_INSTANCE_ID: control.instanceId,
      HELMX_HANDOFF_LAUNCH_ID: randomUUID(),
    },
  });
  child.unref();
  if (child.pid === undefined) throw new Error('update handoff process pid unavailable after spawn (internal error)');
  return { pid: child.pid };
}

export function createHubUpdateRoutes(deps: HubUpdateRoutesDeps): ProductRouteHandler {
  const spawnHandoff = deps.spawnHandoff ?? defaultSpawnHandoff;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const normalized = url.pathname.replace(/\/+$/, '');
    if (normalized !== '/api/hub-update/status' && normalized !== '/api/hub-update/apply' && normalized !== '/api/hub-update/changelog') {
      return undefined;
    }
    if (normalized === '/api/hub-update/changelog') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return errorResponse(undefined, 405, 'method_not_allowed', 'changelog is read-only; use GET');
      }
      const from = url.searchParams.get('from') ?? undefined;
      if (from !== undefined && !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(from)) {
        return errorResponse(undefined, 400, 'invalid_from', 'from must be a strict SemVer version such as 1.2.3');
      }
      if (!deps.changelog.available) {
        return jsonOk(undefined, { available: false, version: deps.changelog.version });
      }
      const sliced = sliceChangelog(deps.changelog.sections, from);
      return jsonOk(undefined, {
        available: true,
        version: deps.changelog.version,
        ...(from !== undefined ? { from, fromMatched: sliced.fromMatched } : {}),
        sections: sliced.sections satisfies ChangelogSection[],
      });
    }
    if (normalized === '/api/hub-update/status') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return errorResponse(undefined, 405, 'method_not_allowed', 'use GET for status and POST for apply');
      }
      const ready = deps.root !== null ? await readUpdateReady(deps.root).catch(() => null) : null;
      const blocked = deps.root !== null ? await readBlockedRelease(deps.root) : null;
      const updaterStatus = deps.updater?.status() ?? null;
      return jsonOk(undefined, {
        active: deps.root !== null && updaterStatus !== null,
        ...(updaterStatus !== null ? { channel: updaterStatus.channel, intervalMs: updaterStatus.intervalMs, lastCheckAt: updaterStatus.lastCheckAt, lastError: updaterStatus.lastError } : {}),
        currentVersion: updaterStatus?.currentVersion ?? deps.changelog.version,
        readyVersion: updaterStatus?.readyVersion ?? ready?.version ?? null,
        blocked,
        upgradedFrom: deps.upgrade.upgradedFrom,
        changelogAvailable: deps.changelog.available,
      });
    }

    // POST /api/hub-update/apply { force?: boolean }
    if (request.method !== 'POST') {
      return errorResponse(undefined, 405, 'method_not_allowed', 'use GET for status and POST for apply');
    }
    if (deps.root === null || deps.updater === null) {
      return errorResponse(undefined, 409, 'hub_update_unmanaged', 'this Hub is not running from a payload-managed install root; update it the way it was deployed (e.g. rebuild the image, or helmx update from the host)');
    }
    let force = false;
    const contentType = request.headers.get('content-type') ?? '';
    if (contentType.startsWith('application/json')) {
      const text = await request.text();
      if (text.trim() !== '') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return errorResponse(undefined, 400, 'invalid_json', 'body must be valid JSON');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return errorResponse(undefined, 400, 'invalid_body', 'body must be a JSON object');
        }
        const rawForce = (parsed as Record<string, unknown>)['force'];
        if (rawForce !== undefined && typeof rawForce !== 'boolean') {
          return errorResponse(undefined, 400, 'invalid_body', 'force must be a boolean');
        }
        force = rawForce === true;
      }
    }
    const ready = await readUpdateReady(deps.root).catch(() => null);
    if (ready === null) {
      return errorResponse(undefined, 409, 'no_staged_update', 'no staged update is waiting; run helmx update (or wait for the background check) first');
    }
    const blocked = await readBlockedRelease(deps.root);
    if (isBlockedVersionActive(blocked, ready.version, new Date())) {
      return errorResponse(undefined, 409, 'update_blocked_cooldown', `version ${ready.version} is blocked (${blocked!.reason}) and inside the retry cooldown`);
    }
    const counts = deps.kernel.activitySnapshot();
    if (!force && isHubActivityBusy(counts)) {
      return errorResponse(undefined, 409, 'hub_busy', 'the Hub has live work (conversations, tools, compaction, or queued input); retry when idle or pass force', { counts });
    }
    const control = await readHubControlRecord(deps.kernel.dataDir).catch(() => null);
    try {
      const spawned = await spawnHandoff(ready, control !== null ? { endpoint: control.endpoint, instanceId: control.instanceId } : null);
      return jsonOk(undefined, { ok: true, switching: true, targetVersion: ready.version, handoffPid: spawned.pid }, { status: 202 });
    } catch (error) {
      return errorResponse(undefined, 500, 'handoff_spawn_failed', error instanceof Error ? error.message : String(error));
    }
  };
}
