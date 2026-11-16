/**
 * doctor-target.ts: external plugin doctor target directory path unify boundary validate.
 *
 * HTTP parseDoctorTarget(http/plugin-routes.ts, early refuse) and
 * PluginHost.doctorExternalPlugin(host.plugins port and HTTP same right, fall back re- inspect)
 * double where invoke the same implement (single point archive one, rule no longer double where maintain):
 * - must be across platform absolute directory path:POSIX `/`,Windows symbol `^[a-zA-Z]:[\\/]`,
 *   complete UNC `\\\\server\\share`(see shared.ts isCrossPlatformAbsolutePath);
 * - excludes .. through exceeds segment (correct backslash all by segment isolate).
 * invalid input explicit HelmError validation_error 400, never static default change write.
 */
import { HelmError } from '@helm/protocol';
import { isCrossPlatformAbsolutePath } from './shared.js';

/** validate doctor target directory path (field used to error message locate, such as 'dir' / 'path'). */
export function assertDoctorTargetDir(dir: string, field: string): void {
  if (!isCrossPlatformAbsolutePath(dir) || dir.split(/[\\/]/).includes('..')) {
    throw new HelmError(
      'validation_error',
      `doctor target ${field} must be excludes .. segment across platform absolute directory path (with / or symbol open head):${dir}`,
      400,
      { dir },
    );
  }
}
