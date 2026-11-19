/**
 * Safe unpacking of a packed payload tarball into a staging root.
 *
 * npm-pack archives carry a single `package/` root prefix; the Hub payload additionally embeds
 * its dependency closure as `file:./<pkg>.tgz` members, which `npm install <outer.tgz>` cannot
 * resolve (npm reads the spec's relative `file:` references before the outer archive lands on
 * disk and fails with ENOENT). The launcher therefore unpacks first and runs a plain
 * `npm install` in the unpacked root — the exact layout the payload's own e2e sequence uses.
 *
 * Security contract (every violation is an explicit error, never a silent skip):
 * - members must stay under the `package/` prefix with normalized relative segments (no `..`,
 *   `.`, empty segments, absolute paths, or backslashes);
 * - only regular files and directories are allowed — links, devices, and FIFOs are rejected;
 * - `package/package.json` must exist and at least one regular file must be present;
 * - node-tar parser warnings (its own hardening against escapes and forbidden link paths) are
 *   treated as fatal: an archive that could only be partially parsed is not unpacked;
 * - after extraction the destination tree is re-walked and must contain only regular files and
 *   directories (on-disk proof that nothing else slipped through).
 *
 * The tarball is always read from a launcher-owned copy inside the staging directory (registry
 * download or an explicit copy of a local `--tarball`), so both validation and extraction passes
 * observe identical bytes.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';

/** Entry types allowed on disk: npm-pack archives contain nothing else. */
const ALLOWED_ENTRY_TYPES = new Set(['File', 'Directory']);

/** Path policy (shared by the validation pass and the extraction filter). */
function tarPathViolation(name: string): string | null {
  if (name.includes('\\')) return `entry "${name}" contains a backslash`;
  if (name !== 'package/' && !name.startsWith('package/')) {
    return `entry "${name}" is outside the package/ root`;
  }
  const segments = name.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment === '' && i === segments.length - 1) continue; // trailing slash on directories
    if (segment === '' || segment === '.' || segment === '..') {
      return `entry "${name}" contains a forbidden path segment`;
    }
  }
  return null;
}

/** Full policy: path shape plus entry type (links, devices, and FIFOs are rejected). */
function tarEntryViolation(name: string, type: string): string | null {
  if (!ALLOWED_ENTRY_TYPES.has(type)) {
    return `entry "${name}" has type ${type}; only regular files and directories are allowed`;
  }
  return tarPathViolation(name);
}

/** Walk a directory tree and return every member's kind; rejects anything but files/dirs. */
async function assertTreeIsPlainFiles(dir: string): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await assertTreeIsPlainFiles(full);
    } else if (!entry.isFile()) {
      throw new Error(`unpacked tree contains a non-regular member: ${full}`);
    }
  }
}

/**
 * Unpack `tarballPath` (an npm-pack archive) into `destDir`, stripping the `package/` prefix.
 * `destDir` must be empty or freshly created by the caller (the engine's staging root).
 */
export async function unpackPayloadTarball(tarballPath: string, destDir: string): Promise<void> {
  // Pass 1: validate every header node-tar is willing to emit, and treat parser warnings as
  // fatal (node-tar drops invalid members with a warning instead of failing the stream).
  const warnings: string[] = [];
  const members: { name: string; type: string }[] = [];
  try {
    await tar.list({
      file: tarballPath,
      onentry: (entry) => {
        members.push({ name: entry.path, type: entry.type });
      },
      onwarn: (code, message) => {
        warnings.push(`${code}: ${message}`);
      },
    });
  } catch (error) {
    throw new Error(
      `payload tarball is unreadable (${tarballPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (warnings.length > 0) {
    throw new Error(`payload tarball raised parser warnings and is refused: ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}`);
  }
  if (members.length === 0) throw new Error('payload tarball contains no entries');
  if (!members.some((member) => member.type === 'File')) {
    throw new Error('payload tarball contains no regular files');
  }
  let sawPackageJson = false;
  for (const member of members) {
    const violation = tarEntryViolation(member.name, member.type);
    if (violation !== null) throw new Error(`payload tarball security check failed: ${violation}`);
    if (member.name === 'package/package.json') sawPackageJson = true;
  }
  if (!sawPackageJson) throw new Error('payload tarball has no package/package.json member');

  // Pass 2: extract with the same policy as a belt-and-braces filter (a filtered member is
  // skipped, never written; the on-disk walk below is the final authority).
  const extractWarnings: string[] = [];
  try {
    await tar.extract({
      file: tarballPath,
      cwd: destDir,
      strip: 1,
      filter: (name) => tarPathViolation(name) === null,
      onwarn: (code, message) => {
        extractWarnings.push(`${code}: ${message}`);
      },
    });
  } catch (error) {
    throw new Error(
      `payload tarball failed to extract into ${destDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (extractWarnings.length > 0) {
    throw new Error(`payload extraction raised parser warnings and is refused: ${extractWarnings[0]}`);
  }

  // Pass 3: on-disk proof — nothing but regular files and directories landed under destDir.
  await assertTreeIsPlainFiles(destDir);
}
