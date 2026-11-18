/**
 * Strict SemVer entry points for the update engine.
 *
 * Parsing and precedence comparison live only in `@helm/protocol` (the repo's single
 * implementation); this module keeps the update-specific rejection envelope
 * (`UpgradeRejectedError`) so callers can distinguish invalid input from I/O failure.
 */
import { compareStrictSemver, isStrictSemver, stripSemverVPrefix } from '@helm/protocol';
import { UpgradeRejectedError } from './errors.js';

function requireStrictVersion(input: string, label: string): void {
  if (!isStrictSemver(input)) {
    throw new UpgradeRejectedError(
      `invalid SemVer version (${label}): "${input}" (expected strict x.y.z[-pre][+build] without v prefix)`,
    );
  }
}

/** Strict SemVer comparison; throws `UpgradeRejectedError` on invalid input. */
export function compareSemver(a: string, b: string): number {
  requireStrictVersion(a, 'a');
  requireStrictVersion(b, 'b');
  return compareStrictSemver(a, b);
}

/** Trim whitespace, strip an optional leading `v`/`V`, and validate strict SemVer. */
export function normalizeTargetVersion(input: string): string {
  const trimmed = stripSemverVPrefix(input);
  requireStrictVersion(trimmed, 'targetVersion');
  return trimmed;
}
