/**
 * File-backed dynamic model catalog cache (`models-store.json`): durable `ModelsStore` implementation for pi-ai.
 *
 * Responsibilities:
 * - Persist dynamic catalog entries (`ModelsStoreEntry`: models/etag/lastModified/checkedAt) keyed by
 *   `providerId`, enabling offline restoration via `models.refresh({ allowNetwork: false })` after restart;
 * - Serialize read/write/delete per canonical file path inside the process via `withFileLock` + atomic
 *   writes (`0600`) so concurrent updates never clobber each other;
 * - Return an empty catalog when the file is missing (`ENOENT`); explicitly throw
 *   `HelmError('models_store_corrupted')` on malformed JSON or a non-plain-object top-level value rather
 *   than silently treating it as empty (honesty discipline).
 *
 * This file contains no secrets (model catalog metadata is non-secret; `0600` is purely a consistency guard).
 */

import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from '../services/atomic-file.js'
import { withFileLock } from '../services/file-lock.js'

/** Top-level shape: `providerId` -> persisted catalog entry. */
type StoreShape = Record<string, ModelsStoreEntry>

/** `ModelsStore.update` mutator: `undefined` = no-op; `null` = delete; object = write. */
type Mutation = (current: ModelsStoreEntry | undefined) => Promise<ModelsStoreEntry | null | undefined> | ModelsStoreEntry | null | undefined

/** ENOENT predicate (missing file is a valid empty catalog; all other read errors are rethrown as-is). */
function isNoSuchFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}

/** Read and parse `models-store.json`; throws `models_store_corrupted` on corruption (never silently treated as empty). */
async function loadRaw(path: string): Promise<StoreShape> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (isNoSuchFileError(err)) return {}
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new HelmError(
      'models_store_corrupted',
      `models-store.json is not valid JSON (${path}): ${err instanceof Error ? err.message : String(err)}`,
      500,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HelmError(
      'models_store_corrupted',
      `models-store.json top-level value must be an object (providerId -> catalog entry): ${path}`,
      500,
    )
  }
  return parsed as StoreShape
}

/**
 * File-backed `ModelsStore` (for single Hub process usage; cross-process concurrent writes are outside
 * this contract — the CLI always triggers kernel refresh via HTTP instead of writing this file directly).
 */
export class FileModelsStore implements ModelsStore {
  private readonly path: string

  constructor(dataDir: string) {
    this.path = join(dataDir, 'models-store.json')
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    return withFileLock(this.path, async () => {
      const current = await loadRaw(this.path)
      return current[providerId] !== undefined ? structuredClone(current[providerId]) : undefined
    })
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    await this.update(providerId, () => entry)
  }

  async delete(providerId: string): Promise<void> {
    await this.update(providerId, () => null)
  }

  /** Read-modify-write under lock: `undefined` = no-op; `null` = delete; object = atomic write. */
  async update(providerId: string, fn: Mutation): Promise<void> {
    await withFileLock(this.path, async () => {
      const current = await loadRaw(this.path)
      const next = await fn(current[providerId])
      if (next === undefined) return
      if (next === null) delete current[providerId]
      else current[providerId] = next
      await atomicWriteJson(this.path, current, { mode: 0o600 })
    })
  }
}

/** Factory helper aligned with other service-layer store constructors (`dataDir` -> `FileModelsStore`). */
export function createFileModelsStore(dataDir: string): FileModelsStore {
  return new FileModelsStore(dataDir)
}
