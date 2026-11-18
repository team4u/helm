/**
 * Access to the engine-owned `current.json` from the launcher side: the shared `@helm/update`
 * record ({version, updatedAt, entries}) is the single source of truth; the Hub launcher's only
 * contract on top is the `entryPath` entry (absolute path to the committed payload `start.mjs`).
 */
import { readCurrentRelease, type CurrentReleaseRecord } from '@helm/update';
import { UsageError } from './io.js';

export interface HubCurrentRelease {
  version: string;
  entryPath: string;
  /** Verbatim engine record (used for verbatim rollback restore). */
  record: CurrentReleaseRecord;
}

export async function readCurrentEntry(root: string): Promise<HubCurrentRelease> {
  const record = await readCurrentRelease(root);
  if (record === null) {
    throw new UsageError(
      `no hub release installed under ${root}; run helm-hub-launcher update first`,
      'no_release_installed',
    );
  }
  const entryPath = record.entries['entryPath'];
  if (typeof entryPath !== 'string' || entryPath === '') {
    throw new Error(`current.json entries.entryPath is missing or invalid (got ${JSON.stringify(record.entries)})`);
  }
  return { version: record.version, entryPath, record };
}
