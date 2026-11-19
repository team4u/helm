/**
 * Unified target-path resolution primitive (shared by file APIs and exec).
 * Performs zero filesystem probing or guesswork; behavior contract is pinned by
 * `test/node-local-env-win32-path.test.ts`.
 */

import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileError, err, ok, type Result as SdkResult } from '@earendil-works/pi-durable/env';
import { normalizeTargetPath, type TargetPlatform } from '@helmx/protocol';

function joinTargetPath(platform: TargetPlatform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
}

/**
 * Resolve a target path against `cwd` according to `platform`'s lexical rules:
 *
 * - `posix` target: resolves strictly by `node:path/posix` rules (`/mnt/...` is a real path
 *   and is never rewritten; unaffected by host OS even under injected tests on Windows).
 * - `win32` target: expands `~` and `file://`, then normalizes via `@helmx/protocol`'s
 *   `normalizeTargetPath` — `/mnt/<drive>/...` (WSL mount view) and `/<drive>/...`
 *   (Git Bash / MSYS drive view) deterministically map to `<DRIVE>:\...`; native Windows,
 *   UNC, and relative paths are lexically normalized; driveless POSIX roots (`/home`, `/tmp`,
 *   bare `/`) fail deterministically with code `'invalid'` without probing the filesystem.
 *   Relative paths anchor to `cwd` normalized by the same rule.
 */
export function resolveTargetPath(
  cwd: string,
  path: string,
  platform: TargetPlatform,
): SdkResult<string, FileError> {
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
      // Keep malformed URLs as plain paths so filesystem methods preserve their non-throwing contract.
    }
  }
  if (platform !== 'win32') {
    // Normalize purely with protocol's POSIX rules, then anchor via posix.resolve so a Windows
    // host never leaks drive-letter/backslash semantics into POSIX target paths.
    const normalizedPath = normalizeTargetPath(normalized, 'posix');
    const normalizedCwd = normalizeTargetPath(cwd, 'posix');
    if (!normalizedPath.ok || !normalizedCwd.ok) {
      // normalizeTargetPath('posix') never fails today; keep an explicit guard against future error kinds.
      return err(new FileError('invalid', 'Invalid POSIX target path', path));
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
    return err(new FileError('invalid', `Failed to resolve session cwd: ${base.reason}`, path));
  }
  return ok(win32.resolve(base.path, normalizedWin.path));
}
