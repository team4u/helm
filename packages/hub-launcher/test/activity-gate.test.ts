/**
 * Activity reader validation matrix: every step of the fail-closed binding chain in
 * `readHubActivityGate` (wrapper identity, strict schema, writer belonging, writer identity,
 * freshness) plus the count formatting used in deferral messages. Real processes back the
 * pid/start-time proofs (Linux `/proc`), so the matrix exercises the production chain.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { useTempDir } from '@helm/test-kit/node';
import { readProcessStartTime, type HubPidRecord } from '../src/records.js';
import { describeActivityCounts, readHubActivityGate } from '../src/activity.js';
import { captureIo, cleanupPid, spawnAlienProcess } from './fixtures.js';

function baseRecord(pid: number, startTime: number, port: number): HubPidRecord {
  return {
    pid,
    launchId: 'test-launch',
    version: '1.0.0',
    entryPath: '/nowhere/start.mjs',
    port,
    startedAt: new Date().toISOString(),
    startTime,
  };
}

async function writeActivity(
  dir: string,
  record: Record<string, unknown>,
): Promise<string> {
  const file = path.join(dir, 'hub-activity.json');
  await fsp.writeFile(file, `${JSON.stringify(record)}\n`);
  return file;
}

function idleCounts(): Record<string, number> {
  return { activeConversations: 0, activeCompactions: 0, queuedConversations: 0, settlingConversations: 0 };
}

const idleIo = () => captureIo().io;

test('a fully bound idle heartbeat passes the gate', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-activity-');
  const writer = spawnAlienProcess();
  t.after(() => cleanupPid(writer));
  const startTime = await readProcessStartTime(writer);
  assert.ok(startTime !== null, 'test requires /proc start times (Linux)');
  await writeActivity(dir, {
    schema: 1,
    launchId: 'test-launch',
    pid: writer,
    ppid: process.pid,
    port: 3202,
    startTime,
    updatedAt: Date.now(),
    counts: idleCounts(),
  });
  const gate = await readHubActivityGate(baseRecord(writer, startTime, 3202), dir, idleIo());
  assert.deepEqual(gate, { kind: 'idle' });
});

test('busy counts surface verbatim in the gate verdict', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-activity-');
  const writer = spawnAlienProcess();
  t.after(() => cleanupPid(writer));
  const startTime = await readProcessStartTime(writer);
  assert.ok(startTime !== null);
  await writeActivity(dir, {
    schema: 1,
    launchId: 'test-launch',
    pid: writer,
    ppid: process.pid,
    port: 3202,
    startTime,
    updatedAt: Date.now(),
    counts: { activeConversations: 1, activeCompactions: 2, queuedConversations: 3, settlingConversations: 4 },
  });
  const gate = await readHubActivityGate(baseRecord(writer, startTime, 3202), dir, idleIo());
  assert.ok(gate.kind === 'busy');
  assert.deepEqual(gate.counts, { activeConversations: 1, activeCompactions: 2, queuedConversations: 3, settlingConversations: 4 });
  assert.equal(
    describeActivityCounts(gate.counts),
    '1 active conversation, 2 compactions, 3 queued, 4 settling',
  );
});

test('a two-level writer binds through ppid (payload wrapper layout)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-activity-');
  const wrapper = spawnAlienProcess();
  const hub = spawnAlienProcess();
  t.after(() => cleanupPid(wrapper));
  t.after(() => cleanupPid(hub));
  const wrapperStart = await readProcessStartTime(wrapper);
  const hubStart = await readProcessStartTime(hub);
  assert.ok(wrapperStart !== null && hubStart !== null);
  await writeActivity(dir, {
    schema: 1,
    launchId: 'test-launch',
    pid: hub,
    ppid: wrapper,
    port: 3202,
    startTime: hubStart,
    updatedAt: Date.now(),
    counts: idleCounts(),
  });
  const gate = await readHubActivityGate(baseRecord(wrapper, wrapperStart, 3202), dir, idleIo());
  assert.deepEqual(gate, { kind: 'idle' });
});

test('every broken link in the chain is unknown, never idle or busy', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-activity-');
  const writer = spawnAlienProcess();
  const foreign = spawnAlienProcess();
  t.after(() => cleanupPid(writer));
  t.after(() => cleanupPid(foreign));
  const startTime = await readProcessStartTime(writer);
  const foreignStart = await readProcessStartTime(foreign);
  assert.ok(startTime !== null && foreignStart !== null);
  const record = baseRecord(writer, startTime, 3202);
  const io = idleIo();
  const valid = {
    schema: 1,
    launchId: 'test-launch',
    pid: writer,
    ppid: process.pid,
    port: 3202,
    startTime,
    updatedAt: Date.now(),
    counts: idleCounts(),
  };

  // Record without a start-time proof.
  const noProof = await readHubActivityGate({ ...record, startTime: undefined }, dir, io);
  assert.ok(noProof.kind === 'unknown' && /start-time proof/.test(noProof.detail));

  // Wrapper start-time mismatch (pid reuse on the recorded process).
  const reused = await readHubActivityGate({ ...record, startTime: startTime + 1 }, dir, io);
  assert.ok(reused.kind === 'unknown' && /fails its start-time proof/.test(reused.detail));

  // Missing file.
  const missing = await readHubActivityGate(record, path.join(dir, 'empty'), io);
  assert.ok(missing.kind === 'unknown' && /missing or unreadable/.test(missing.detail));

  // Garbage content (unparseable JSON reads as missing-or-unreadable: never a usable signal).
  await fsp.writeFile(path.join(dir, 'hub-activity.json'), '{not-json');
  const garbage = await readHubActivityGate(record, dir, io);
  assert.ok(garbage.kind === 'unknown' && /missing or unreadable/.test(garbage.detail));

  // Schema violations: wrong schema version, missing counts fields, negative counts, bad port.
  for (const [label, mutation] of [
    ['schema', { schema: 2 }],
    ['missing settling', { counts: { activeConversations: 0, activeCompactions: 0, queuedConversations: 0 } }],
    ['negative count', { counts: { ...idleCounts(), activeCompactions: -1 } }],
    ['port zero', { port: 0 }],
    ['non-integer pid', { pid: 1.5 }],
  ] as Array<[string, Record<string, unknown>]>) {
    await writeActivity(dir, { ...valid, ...mutation });
    const gate = await readHubActivityGate(record, dir, io);
    assert.ok(gate.kind === 'unknown', `${label} must be unknown`);
  }

  // Port mismatch against the record.
  await writeActivity(dir, { ...valid, port: 9999 });
  const wrongPort = await readHubActivityGate(record, dir, io);
  assert.ok(wrongPort.kind === 'unknown' && /reports port 9999/.test(wrongPort.detail));

  // Foreign writer (neither the recorded process nor its child).
  await writeActivity(dir, { ...valid, pid: foreign, ppid: foreign });
  const alien = await readHubActivityGate(record, dir, io);
  assert.ok(alien.kind === 'unknown' && /neither the recorded hub process/.test(alien.detail));

  // Writer start-time mismatch (the recorded pid was reused after the write).
  await writeActivity(dir, { ...valid, startTime: startTime + 7 });
  const writerReused = await readHubActivityGate(record, dir, io);
  assert.ok(writerReused.kind === 'unknown' && /writer pid .* fails its start-time proof/.test(writerReused.detail));

  // Dead writer (two-level topology: the wrapper stays alive, only the heartbeat writer is gone;
  // in the single-level topology writer death is already caught by the wrapper proof above).
  const revived = spawnAlienProcess();
  t.after(() => cleanupPid(revived));
  const revivedStart = await readProcessStartTime(revived);
  assert.ok(revivedStart !== null);
  const revivedRecord = baseRecord(revived, revivedStart, 3202);
  cleanupPid(writer);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await writeActivity(dir, { ...valid, ppid: revived });
  const dead = await readHubActivityGate(revivedRecord, dir, io);
  assert.ok(dead.kind === 'unknown' && /no longer alive/.test(dead.detail));

  // Staleness (aged record and future-skewed clock alike).
  const revivedValid = { ...valid, pid: revived, startTime: revivedStart };
  await writeActivity(dir, { ...revivedValid, updatedAt: Date.now() - 60_000 });
  const stale = await readHubActivityGate(revivedRecord, dir, io);
  assert.ok(stale.kind === 'unknown' && /stale/.test(stale.detail));
  await writeActivity(dir, { ...revivedValid, updatedAt: Date.now() + 60_000 });
  const future = await readHubActivityGate(revivedRecord, dir, io);
  assert.ok(future.kind === 'unknown' && /in the future/.test(future.detail));

  // A missing writer start-time (non-Linux writer) is unknown.
  await writeActivity(dir, { ...revivedValid, startTime: null });
  const noWriterProof = await readHubActivityGate(revivedRecord, dir, io);
  assert.ok(noWriterProof.kind === 'unknown' && /no writer start-time proof/.test(noWriterProof.detail));
});


test('a held wrapper can prove the heartbeat launch without /proc', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-activity-held-');
  const { io } = captureIo();
  const pid = process.pid;
  const record = { ...baseRecord(pid, 0, 3202), startTime: undefined };
  const heartbeat = {
    schema: 1, launchId: record.launchId, pid, ppid: process.ppid, port: record.port,
    startTime: null, updatedAt: Date.now(), counts: idleCounts(),
  };
  await writeActivity(dir, heartbeat);
  assert.equal((await readHubActivityGate(record, dir, io)).kind, 'unknown');
  const held = { ownsWrapper: true };
  assert.deepEqual(await readHubActivityGate(record, dir, io, held), { kind: 'idle' });
  await writeActivity(dir, { ...heartbeat, launchId: 'previous-launch' });
  assert.equal((await readHubActivityGate(record, dir, io, held)).kind, 'unknown');
});
