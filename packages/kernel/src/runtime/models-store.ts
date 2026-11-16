/**
 * file edition motion state model directory cache (models-store.json):pi-ai ModelsStore durable implement.
 *
 * responsibility:
 * - by providerId persist motion state directory item (ModelsStoreEntry:models/etag/lastModified/
 *   checkedAt), after restart models.refresh({ allowNetwork: false }) can offline restore cache directory;
 * - read/write/delete all via withFileLock by real path process inside serial + atomic (0600),
 *   concurrency update without losing each other write;
 * - file missing (ENOENT) return empty directory;JSON failed to parse or top-level non- plain object explicit throw
 *   HelmError('models_store_corrupted'), never static default when empty directory use (honest discipline).
 *
 * the file excludes any secret key (model directory metadata non- secret;0600 only is consistency keep guard permission).
 */

import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from '../services/atomic-file.js'
import { withFileLock } from '../services/file-lock.js'

/** top-level shape:providerId -> persist directory item. */
type StoreShape = Record<string, ModelsStoreEntry>

/** ModelsStore.update change function:undefined = do not change write;null = delete; object = write. */
type Mutation = (current: ModelsStoreEntry | undefined) => Promise<ModelsStoreEntry | null | undefined> | ModelsStoreEntry | null | undefined

/** ENOENT decide (file missing is legal empty directory, the rest read error original on throw). */
function isNoSuchFileError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  )
}

/** read and parse models-store.json; corrupt explicit throw models_store_corrupted(not silently empty). */
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
      `models-store.json is not legal JSON(${path}):${err instanceof Error ? err.message : String(err)}`,
      500,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HelmError(
      'models_store_corrupted',
      `models-store.json top-level must be an object (providerId -> directory item):${path}`,
      500,
    )
  }
  return parsed as StoreShape
}

/**
 * file edition ModelsStore(single Hub process use; across process write concurrency do not in this contract scope - -
 * CLI one rule via HTTP trigger kernel refresh, do not direct write the file).
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

  /** lock inside read change write:fn return undefined do not change write;null delete; object write and atomic. */
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

/** work vendor: and services layer the rest store same construct (dataDir -> FileModelsStore). */
export function createFileModelsStore(dataDir: string): FileModelsStore {
  return new FileModelsStore(dataDir)
}
