/**
 * Atomic release state files under a state directory (kept separate from user data):
 * `current.json` (active release pointer) and `update-blocked.json` (failure cooldown).
 *
 * Honesty rules identical to the original helm-node engine: corruption and I/O errors
 * throw explicitly; `null` is returned only on `ENOENT`. Writes are atomic (`0600`,
 * temp file + rename) via `@helm/env-io`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteJson } from '@helm/env-io';

/** Active release pointer (`current.json`). `entries` holds consumer-defined absolute entry paths. */
export interface CurrentReleaseRecord {
  version: string;
  updatedAt: string;
  /** Consumer-defined entry points into the active release directory (e.g. `entryPath`, `cliBinDir`). */
  entries: Record<string, string>;
}

/** Failure cooldown record (`update-blocked.json`). */
export interface BlockedReleaseRecord {
  version: string;
  reason: string;
  at: string;
}

async function readJsonRecord<T>(filePath: string, validate: (raw: unknown) => T, label: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(
      `failed to read ${label} (${filePath}): ${code ?? (error instanceof Error ? error.message : String(error))}`,
    );
  }
  try {
    return validate(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${label} is corrupt (${filePath}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`field ${key} is missing or not a non-empty string`);
  }
  return value;
}

function requireEntries(raw: Record<string, unknown>): Record<string, string> {
  const value = raw['entries'];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('field entries is missing or not an object');
  }
  const entries: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`field entries.${key} is missing or not a non-empty string`);
    }
    entries[key] = entry;
  }
  if (Object.keys(entries).length === 0) {
    throw new Error('field entries must contain at least one entry path');
  }
  return entries;
}

function validateCurrentRecord(raw: unknown): CurrentReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  return {
    version: requireString(rec, 'version'),
    updatedAt: requireString(rec, 'updatedAt'),
    entries: requireEntries(rec),
  };
}

function validateBlockedRecord(raw: unknown): BlockedReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  return {
    version: requireString(rec, 'version'),
    reason: requireString(rec, 'reason'),
    at: requireString(rec, 'at'),
  };
}

const currentReleasePath = (stateDir: string) => path.join(stateDir, 'current.json');
const blockedReleasePath = (stateDir: string) => path.join(stateDir, 'update-blocked.json');

export async function readCurrentRelease(stateDir: string): Promise<CurrentReleaseRecord | null> {
  return readJsonRecord(currentReleasePath(stateDir), validateCurrentRecord, 'current.json');
}

export async function writeCurrentRelease(stateDir: string, record: CurrentReleaseRecord): Promise<void> {
  validateCurrentRecord(record);
  await atomicWriteJson(currentReleasePath(stateDir), record, { mode: 0o600 });
}

export async function deleteCurrentRelease(stateDir: string): Promise<void> {
  await fs.rm(currentReleasePath(stateDir), { force: true });
}

export async function readBlockedRelease(stateDir: string): Promise<BlockedReleaseRecord | null> {
  return readJsonRecord(blockedReleasePath(stateDir), validateBlockedRecord, 'update-blocked.json');
}

export async function writeBlockedRelease(stateDir: string, record: BlockedReleaseRecord): Promise<void> {
  validateBlockedRecord(record);
  await atomicWriteJson(blockedReleasePath(stateDir), record, { mode: 0o600 });
}

export async function clearBlockedRelease(stateDir: string): Promise<void> {
  await fs.rm(blockedReleasePath(stateDir), { force: true });
}
