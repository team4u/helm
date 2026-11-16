/**
 * unify target path parse original language (local-env sub- module):file API and exec shared use,
 * zero probe, zero guess; behavior contract by test/node-local-env-win32-path.test.ts pin.
 */

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTargetPath, type TargetPlatform } from '@helm/protocol';
import { FileError, err, ok, type Result } from './errors.js';

/** item concatenate by target platform term method rule (real host on and node:path host behavior consistent, inject test under keep the same perspective). */
export function joinTargetPath(platform: TargetPlatform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
}

/** parent directory extract by target platform term method rule (input already is this original language parse after canonical path). */
export function parentTargetPath(platform: TargetPlatform, p: string): string {
  return platform === 'win32' ? win32.dirname(p) : posix.resolve(p, '..');
}

/**
 * unify target path parse original language (file API and exec shared use, zero probe, zero guess):
 *
 * - posix target: by node:path posix rule parse (/mnt/... is real path never reverse convert,
 *   and and host OS without closure - -Windows host inject test under same keep pure POSIX semantics);
 * - win32 target: first do `~` / `file://` expand, again via @helm/protocol 
 *   normalizeTargetPath unify specification - -/mnt/<symbol>/... (WSL mount view) and
 *   /<symbol>/... (Git Bash / MSYS symbol view) determinism convert is <large write symbol>:\...
 *   (while non- host resolve mistakenly anchor out <symbol>:\mnt\<symbol>\...), original generate Windows /
 *   UNC / relative path only do term method archive one, without symbol POSIX (/home,/tmp, bare / etc.)
 *   explicit structure failed (code 'invalid'), never do access choose guess;
 *   relative path anchor set to by the same rule specification after conversation cwd(conversation cwd also may is
 *   /mnt/<symbol>/... view).
 */
export function resolveTargetPath(cwd: string, path: string, platform: TargetPlatform): Result<string> {
  let normalized = path;
  if (normalized === '~') {
    normalized = homedir();
  } else if (
    normalized.startsWith('~/') ||
    (platform === 'win32' && normalized.startsWith('~\\'))
  ) {
    normalized = joinTargetPath(platform, homedir(), normalized.slice(2));
  } else if (normalized.startsWith('file://')) {
    try {
      normalized = fileURLToPath(normalized, { windows: platform === 'win32' });
    } catch {
      // distortion shape URL keep original as ordinary path, file method dimension hold do not throw exception contract.
    }
  }
  if (platform !== 'win32') {
    // first use protocol pure POSIX rule do term method archive one, again only use posix.resolve do
    // target cwd anchor set; this Windows host will not symbol/backslash rule carries target path.
    const normalizedPath = normalizeTargetPath(normalized, 'posix')
    const normalizedCwd = normalizeTargetPath(cwd, 'posix')
    if (!normalizedPath.ok || !normalizedCwd.ok) {
      // normalizeTargetPath('posix') when before will not failed; keep explicit branch with guard
      // protocol contract, avoid not come extend failed type when static default continue.
      return err(new FileError('invalid', 'Invalid POSIX target path', path))
    }
    return ok(
      posix.isAbsolute(normalizedPath.path)
        ? posix.resolve(normalizedPath.path)
        : posix.resolve(normalizedCwd.path, normalizedPath.path),
    );
  }
  const normalizedWin = normalizeTargetPath(normalized, 'win32');
  if (!normalizedWin.ok) {
    return err(new FileError('invalid', normalizedWin.reason, path));
  }
  if (win32.isAbsolute(normalizedWin.path)) {
    return ok(win32.resolve(normalizedWin.path));
  }
  const base = normalizeTargetPath(cwd, 'win32');
  if (!base.ok) {
    return err(new FileError('invalid', `conversation cwd cannot parse:${base.reason}`, path));
  }
  return ok(win32.resolve(base.path, normalizedWin.path));
}
