/**
 * External plugin package source grammar parser.
 *
 * Supported sources (matching protocol `PluginPackageSource` discriminated union):
 * - npm: `npm:<spec>` (`<spec>` is any non-empty npm dependency specifier without whitespace);
 * - git: `git:<repo>[@<ref>][#<subdirectory>]` (`repo` may be https URL, `user@host:path` SCP, or `host/path` shorthand);
 * - HTTPS Git URL: `https://...(.git)?[#<ref>][#<subdirectory>]`;
 * - local: absolute path or Hub-cwd-relative path (`./` or `../`).
 *
 * Rejected: `file://`, plaintext `http://`, `builtin:` prefixes, empty strings, and bare relative names.
 */
import { isAbsolute, resolve } from 'node:path';
import { HelmxError, type PluginPackageSource } from '@helmx/protocol';

/** Minimal npm specifier check: non-empty with no whitespace (semver parsing belongs to npm). */
const NPM_SPEC_PATTERN = /^\S+$/;

/**
 * Strictly validates a git repository address (rejects path injection):
 * accepts `https://host/path`, `user@host:path` SCP, or `host/path` shorthand.
 */
function assertGitRepo(repo: string, raw: string): void {
  const fail = (detail: string): HelmxError =>
    new HelmxError('validation_error', `Invalid git repository address (${detail}): ${repo}`, 400, { raw, repo });
  if (repo.length === 0) throw fail('empty address');
  if (repo.includes('\\') || repo.includes('\0')) throw fail('contains backslash or NUL');
  if (/\s/.test(repo)) throw fail('contains whitespace');
  if (repo.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(repo) || repo.startsWith('\\\\')) {
    throw fail('absolute path (pass local plugin paths directly without git:)');
  }
  if (repo.includes('..')) throw fail('contains .. segment');
  if (/^http:\/\//i.test(repo)) throw fail('plaintext http:// (use https)');
  if (/^file:/i.test(repo)) throw fail('file: protocol');
  // scheme:// addresses: allow only https:// (reject ssh://, git://, etc. for clarity and safety)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(repo)) {
    if (!/^https:\/\//i.test(repo)) throw fail('only https:// is allowed (use user@host:path for SCP)');
    let parsed: URL;
    try {
      parsed = new URL(repo);
    } catch {
      throw fail('unparseable URL');
    }
    if (parsed.hostname === '' || /^\s+$/.test(parsed.hostname)) throw fail('missing hostname');
    return;
  }
  if (/^https:\/\//i.test(repo)) {
    // Unreachable: handled above; kept as defensive guard.
    return;
  }
  // SCP form (`user@host:path`, optional port): host/user precedes `:`, non-empty relative path follows.
  const scpMatch = /^([a-zA-Z0-9._~-]+@)?([a-zA-Z0-9._~-]+(?::\d+)?):(.+)$/.exec(repo);
  if (scpMatch !== null) {
    if (scpMatch[3] === undefined || scpMatch[3].length === 0 || scpMatch[3].startsWith('/')) {
      throw fail('invalid SCP path segment');
    }
    return;
  }
  // Reject any remaining `scheme:...` forms.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(repo)) throw fail('unknown protocol');
  // `host/path` shorthand: host must start alphanumeric (rejects `./` and `../`).
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._~-]*\/[a-zA-Z0-9._~\/:@!$'()*+,;%=-]+$/.test(repo)) {
    throw fail('expected https URL, SCP user@host:path, or host/path');
  }
}

/** Splits `<repo>[@<ref>][#<subdirectory>]` tail (`ref` cannot contain `@` or `#`). */
function splitGitTail(rest: string, raw: string): { repo: string; ref?: string; subdirectory?: string } {
  // Split `#subdirectory` first (only one fragment allowed)
  const hashIndex = rest.indexOf('#');
  const subdirectory = hashIndex >= 0 ? rest.slice(hashIndex + 1) : undefined;
  let head = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  if (subdirectory !== undefined) {
    if (subdirectory.length === 0) {
      throw new HelmxError('validation_error', `Git source subdirectory is empty (expected path after '#'): ${raw}`, 400, { raw });
    }
    if (subdirectory.includes('#')) {
      throw new HelmxError('validation_error', `Git source contains multiple '#' characters (only one subdirectory fragment is allowed): ${raw}`, 400, { raw });
    }
    if (subdirectory.startsWith('/') || subdirectory.includes('..') || subdirectory.includes('\\')) {
      throw new HelmxError('validation_error', `Git source subdirectory must be a relative path inside the repository: ${raw}`, 400, { raw });
    }
  }
  let ref: string | undefined;
  // In SCP `user@host:path`, `@` belongs to userinfo; `@` is a ref separator only when no `:` follows it.
  const firstColon = head.indexOf(':');
  const atIndex = head.lastIndexOf('@');
  const atIsRefSeparator = atIndex > 0 && (firstColon < 0 || atIndex > firstColon);
  if (atIsRefSeparator) {
    ref = head.slice(atIndex + 1);
    head = head.slice(0, atIndex);
    if (ref.length === 0) {
      throw new HelmxError('validation_error', `Git source ref is empty (expected branch/tag/commit after '@'): ${raw}`, 400, { raw });
    }
    if (ref.includes('#')) {
      throw new HelmxError('validation_error', `Invalid git source ref (cannot contain '#'): ${raw}`, 400, { raw });
    }
  }
  const repo = head;
  if (repo.length === 0) {
    throw new HelmxError('validation_error', `Git source is missing repository address: ${raw}`, 400, { raw });
  }
  return { repo, ref, subdirectory };
}

/** Parses a plugin package `source` string (`cwd` resolves relative local paths). */
export function parsePluginSource(raw: string, cwd: string): PluginPackageSource {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new HelmxError('validation_error', 'Plugin package source must be a non-empty string', 400);
  }
  if (raw !== raw.trim()) {
    throw new HelmxError('validation_error', `Plugin package source cannot have leading or trailing whitespace: ${raw}`, 400, { raw });
  }
  if (raw.startsWith('builtin:') || raw.startsWith('builtin%3A')) {
    throw new HelmxError('validation_error', `Plugin package source cannot use builtin: prefix (built-in plugins are not package-managed): ${raw}`, 400, { raw });
  }
  if (raw.startsWith('file://')) {
    throw new HelmxError(
      'validation_error',
      `file:// URLs are not supported (pass an absolute path or ./ ../ relative path directly): ${raw}`,
      400,
      { raw },
    );
  }
  if (raw.startsWith('npm:')) {
    const spec = raw.slice('npm:'.length);
    if (!NPM_SPEC_PATTERN.test(spec)) {
      throw new HelmxError('validation_error', `Invalid npm specifier: ${spec} (expected npm:<spec>)`, 400, { raw });
    }
    if (spec.startsWith('builtin:')) {
      throw new HelmxError('validation_error', `npm specifier cannot start with builtin: (${spec})`, 400, { raw });
    }
    return { kind: 'npm', raw, spec };
  }
  if (raw.startsWith('git+')) {
    throw new HelmxError(
      'validation_error',
      `git+ URL scheme is not supported (use git:<repo>[@<ref>] or https Git URL): ${raw}`,
      400,
      { raw },
    );
  }
  if (raw.startsWith('git:')) {
    const parsed = splitGitTail(raw.slice('git:'.length), raw);
    assertGitRepo(parsed.repo, raw);
    return { kind: 'git', raw, ...parsed };
  }
  if (/^https:\/\//i.test(raw)) {
    // HTTPS Git URL: `#<ref>[#<subdirectory>]` or `#<subdirectory>`
    const hashIndex = raw.indexOf('#');
    const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const fragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : undefined;
    let repo = base;
    let ref: string | undefined;
    let subdirectory: string | undefined;
    if (fragment !== undefined) {
      const parts = fragment.split('#');
      if (parts.length > 2) {
        throw new HelmxError('validation_error', `Git URL has too many '#' fragments (at most ref and subdirectory): ${raw}`, 400, { raw });
      }
      if (parts.length === 2) {
        const parsedRef = parts[0]!;
        subdirectory = parts[1];
        if (parsedRef.length === 0) {
          throw new HelmxError('validation_error', `Git URL ref is empty: ${raw}`, 400, { raw });
        }
        ref = parsedRef;
      } else {
        // Single fragment: treat paths containing '/' as subdirectory, otherwise as ref.
        if (fragment.includes('/')) subdirectory = fragment;
        else ref = fragment;
      }
      if (subdirectory !== undefined) {
        if (subdirectory.length === 0 || subdirectory.startsWith('/') || subdirectory.includes('..') || subdirectory.includes('\\')) {
          throw new HelmxError('validation_error', `Git URL subdirectory must be a relative path inside the repository: ${raw}`, 400, { raw });
        }
      }
    }
    // Trailing `@ref` (e.g. `https://...git@v1`), only when no userinfo `@` precedes path
    const atOutsideUser = findTrailingRefAt(repo);
    if (atOutsideUser >= 0) {
      ref = repo.slice(atOutsideUser + 1);
      repo = repo.slice(0, atOutsideUser);
      if (ref.length === 0 || ref.includes('/')) {
        throw new HelmxError('validation_error', `Invalid trailing @ref in git URL: ${raw}`, 400, { raw });
      }
    }
    let parsedHost: URL;
    try {
      parsedHost = new URL(repo);
    } catch {
      throw new HelmxError('validation_error', `Invalid git URL: ${raw}`, 400, { raw });
    }
    if (parsedHost.hostname === '' || /^\s+$/.test(parsedHost.hostname)) {
      throw new HelmxError('validation_error', `Git URL is missing hostname: ${raw}`, 400, { raw });
    }
    return { kind: 'git', raw, repo, ref, subdirectory };
  }
  if (/^http:\/\//i.test(raw)) {
    throw new HelmxError(
      'validation_error',
      `Plaintext http:// git URLs are not supported (use https or git:): ${raw}`,
      400,
      { raw },
    );
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    throw new HelmxError(
      'validation_error',
      `Unsupported plugin package protocol (expected npm:, git:, https Git URL, or local path): ${raw}`,
      400,
      { raw },
    );
  }
  // Local path: absolute or explicit ./ / ../ relative path (bare names rejected to avoid npm/git ambiguity)
  if (isAbsolute(raw) || raw.startsWith('./') || raw.startsWith('../') || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    const path = resolve(cwd, raw);
    if (path.includes('\0')) {
      throw new HelmxError('validation_error', `Local path contains illegal character: ${raw}`, 400, { raw });
    }
    return { kind: 'local', raw, path };
  }
  throw new HelmxError(
    'validation_error',
    `Unrecognized plugin package source: ${raw} (expected npm:<spec>, git:<repo>[@<ref>], https Git URL, or local absolute/relative path)`,
    400,
    { raw },
  );
}

/** Finds the trailing `@` inside the URL pathname (skipping `user@host` and `:port`). */
function findTrailingRefAt(repo: string): number {
  try {
    const url = new URL(repo);
    const path = url.pathname;
    const at = path.lastIndexOf('@');
    if (at < 0) return -1;
    const tail = path.slice(at + 1);
    if (tail.includes('/')) return -1;
    const beforePath = repo.lastIndexOf(url.pathname);
    if (beforePath < 0) return -1;
    return beforePath + at;
  } catch {
    return -1;
  }
}
