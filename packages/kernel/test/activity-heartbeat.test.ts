/**
 * Activity heartbeat writer (`activity-heartbeat.ts`): the process-private file the running Hub
 * maintains for the launcher's update busy-gate. Covers the write discipline — immediate initial
 * write, periodic refresh, the synchronous idle→busy transition rewrite (the race-bounding
 * guarantee), stop-time removal, and best-effort failure handling (never throws, reports through
 * the sink, recovers on the next tick).
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, it, test } from 'node:test';
import type { HubActivityCounts, HubActivityFile } from '@helm/protocol';
import { hubActivityFilePath, startActivityHeartbeat, type ActivityHeartbeat } from '../src/runtime/activity-heartbeat.js';
import { cleanupDir, makeTempDir, waitFor } from './helpers.js';

const IDLE: HubActivityCounts = { activeConversations: 0, activeCompactions: 0, queuedConversations: 0, settlingConversations: 0 };
const BUSY: HubActivityCounts = { activeConversations: 1, activeCompactions: 0, queuedConversations: 0, settlingConversations: 0 };

const parseFile = async (file: string): Promise<HubActivityFile> =>
  JSON.parse(await fsp.readFile(file, 'utf8')) as HubActivityFile;

describe('activity heartbeat writer', { timeout: 60_000 }, () => {
  let root = '';
  let hearts: ActivityHeartbeat[] = [];

  before(async () => {
    root = await makeTempDir('helm-activity-hb-');
  });
  after(async () => {
    for (const heart of hearts) await heart.stop().catch(() => undefined);
    await cleanupDir(root);
  });

  test('hubActivityFilePath places the heartbeat at the data dir root', () => {
    assert.equal(hubActivityFilePath('/data'), path.join('/data', 'hub-activity.json'));
  });

  it('writes a complete record immediately on start and refreshes periodically', { timeout: 60_000 }, async (t) => {
    const dir = path.join(root, 'periodic');
    let counts = { ...IDLE };
    let busyListener: (() => void) | undefined;
    const heart = startActivityHeartbeat({
      file: hubActivityFilePath(dir),
      port: 3202,
      snapshot: () => counts,
      subscribeBusyEntered: (listener) => {
        busyListener = listener;
        return () => {
          busyListener = undefined;
        };
      },
      intervalMs: 60,
    });
    hearts.push(heart);
    t.after(() => {
      void heart.stop();
    });

    const file = hubActivityFilePath(dir);
    const first = await parseFile(file);
    assert.equal(first.schema, 1);
    assert.equal(first.pid, process.pid);
    assert.equal(first.ppid, process.ppid);
    assert.equal(first.port, 3202);
    assert.ok(first.updatedAt <= Date.now() + 1_000);
    assert.deepEqual(first.counts, IDLE);
    if (process.platform === 'linux') assert.ok(typeof first.startTime === 'number' && first.startTime > 0);

    // Periodic refresh: counts flip and the next tick lands them (no transition listener needed).
    counts = { ...BUSY };
    await waitFor(async () => (await parseFile(file)).counts.activeConversations === 1, 5_000);

    // Stop removes the file (clean shutdown leaves no stale idle evidence) and is idempotent.
    await heart.stop();
    await assert.rejects(fsp.readFile(file));
    await heart.stop();
  });

  it('rewrites synchronously on the idle→busy transition (before any reader can act)', { timeout: 60_000 }, async (t) => {
    const dir = path.join(root, 'transition');
    const file = hubActivityFilePath(dir);
    let counts: HubActivityCounts = { ...IDLE };
    let listener: (() => void) | undefined;
    const heart = startActivityHeartbeat({
      file,
      port: 3202,
      snapshot: () => counts,
      subscribeBusyEntered: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      intervalMs: 3_600_000, // effectively never: only the transition path may write
    });
    hearts.push(heart);
    t.after(() => {
      void heart.stop();
    });

    await parseFile(file); // initial write landed
    counts = { activeConversations: 2, activeCompactions: 1, queuedConversations: 0, settlingConversations: 0 };
    assert.ok(listener !== undefined, 'busy transition listener must be subscribed');
    const transition = listener!;
    transition();
    // Read back in the same turn: the transition write is synchronous, no timer involved.
    const record = await parseFile(file);
    assert.equal(record.counts.activeConversations, 2);
    assert.equal(record.counts.activeCompactions, 1);
    assert.ok(record.updatedAt >= Date.now() - 1_000, 'transition write carries a current timestamp');

    // Unsubscribed on stop: a later invocation must not resurrect the file.
    await heart.stop();
    transition();
    await assert.rejects(fsp.readFile(file));
  });

  it('never throws on write failures: reports through the sink and recovers on the next tick', { timeout: 60_000 }, async (t) => {
    const dir = path.join(root, 'failure');
    const file = hubActivityFilePath(dir);
    const failures: unknown[] = [];
    const heart = startActivityHeartbeat({
      file,
      port: 3202,
      snapshot: () => ({ ...IDLE }),
      subscribeBusyEntered: () => () => undefined,
      intervalMs: 60,
      onWriteError: (error) => {
        failures.push(error);
      },
    });
    hearts.push(heart);
    t.after(() => {
      void heart.stop();
    });

    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.writeFile(dir, 'occupied by a file'); // the data dir path is now a file: writes fail
    await waitFor(() => failures.length > 0, 5_000);
    await fsp.rm(dir, { force: true }); // recover
    await waitFor(async () => {
      try {
        await parseFile(file);
        return true;
      } catch {
        return false;
      }
    }, 5_000);
    await heart.stop();
  });
});
