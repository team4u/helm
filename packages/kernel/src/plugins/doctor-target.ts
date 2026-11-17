/**
 * doctor-target.ts: unified directory path validation for external plugin doctor targets.
 *
 * Shared by HTTP `parseDoctorTarget` (http/plugin-routes.ts, fail-fast) and
 * `PluginHost.doctorExternalPlugin` (for host.plugins callers):
 * - Must be a cross-platform absolute directory path: POSIX `/`, Windows drive `^[a-zA-Z]:[\\/]`,
 *   or full UNC `\\\\server\\share` (see `shared.ts` `isCrossPlatformAbsolutePath`);
 * - Must not contain `..` traversal segments (split on both `/` and `\`).
 * Invalid paths fail explicitly with `HelmError('validation_error', ..., 400)`.
 */
import { HelmError } from '@helm/protocol';
import { isCrossPlatformAbsolutePath } from './shared.js';

/** Validates a doctor target directory path (`field` names the input field, e.g. `'dir'` / `'path'`). */
export function assertDoctorTargetDir(dir: string, field: string): void {
  if (!isCrossPlatformAbsolutePath(dir) || dir.split(/[\\/]/).includes('..')) {
    throw new HelmError(
      'validation_error',
      `Doctor target '${field}' must be a cross-platform absolute directory path without '..' segments (starting with '/' or drive letter): ${dir}`,
      400,
      { dir },
    );
  }
}
