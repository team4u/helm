/**
 * atomic JSON state file: write side same directory tmp + fsync + rename(POSIX atomic swap name),
 * read side zone missing (undefined) and corrupt (explicit throw updater_state_corrupt, forbidden static default when act empty state).
 *
 * supply payload updater  current.json / blocked.json use; failed to write never affect since has file.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { DesktopError } from './errors.js';

/** atomic write JSON:tmp file fsync after rename to target; any one step failed original file keep do not change. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  let fh: number;
  try {
    fh = openSync(tmp, 'w');
  } catch (error) {
    throw new DesktopError(
      'updater_state_write_failed',
      `state file cannot write: ${file}(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    writeSync(fh, data, 0, data.length);
    fsyncSync(fh);
  } finally {
    closeSync(fh);
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // clean up exhaust force while is:tmp leftover does not affect correct
    }
    throw new DesktopError(
      'updater_state_write_failed',
      `state file atomic swap name failed: ${file}(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * read JSON state: file missing return undefined; store in but illegal JSON explicit throw
 * updater_state_corrupt(caller must explicit handle, must not when act empty state continue).
 */
export function readJsonState(file: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new DesktopError(
      'updater_state_read_failed',
      `${what} cannot read: ${file}(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DesktopError('updater_state_corrupt', `${what} already corrupt (illegal JSON): ${file}`, {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
