/**
 * Last-run version tracking (`<dataDir>/hub-version.json`): the Hub records the version it runs
 * on every boot and reports an upgrade when it differs from the previous recorded version — the
 * process-level signal behind the Web "what changed" notice (works regardless of which browser
 * or how many browsers look). Corrupt records are ignored and rewritten (no previous version can
 * be proven, so no upgrade is claimed).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

interface RunVersionRecord {
  version: string;
  since: string;
}

function validate(raw: unknown): RunVersionRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.version !== 'string' || rec.version === '') return null;
  if (typeof rec.since !== 'string' || rec.since === '') return null;
  return { version: rec.version, since: rec.since };
}

function runVersionPath(dataDir: string): string {
  return path.join(dataDir, 'hub-version.json');
}

/** Read the previously recorded run version (`null` when absent or corrupt). */
export async function readLastRunVersion(dataDir: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(runVersionPath(dataDir), 'utf8');
  } catch {
    return null;
  }
  try {
    return validate(JSON.parse(raw))?.version ?? null;
  } catch {
    return null;
  }
}

/** Record the current version and report where this boot upgraded from (`null` = no upgrade claim). */
export async function recordRunVersion(dataDir: string, version: string): Promise<{ upgradedFrom: string | null }> {
  const previous = await readLastRunVersion(dataDir);
  const upgradedFrom = previous !== null && previous !== version ? previous : null;
  const record: RunVersionRecord = { version, since: new Date().toISOString() };
  let text = JSON.stringify(record, null, 2);
  if (!text.endsWith('\n')) text += '\n';
  await fsp.mkdir(dataDir, { recursive: true }).catch(() => undefined);
  await fsp.writeFile(runVersionPath(dataDir), text, { mode: 0o600 });
  return { upgradedFrom };
}
