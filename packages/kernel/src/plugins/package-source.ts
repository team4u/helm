/**
 * external plugin package install source parse (source grammar).
 *
 * most small grammar(and protocol PluginPackageSource judge other join together one one for should):
 * - npm source:`npm:<spec>`,spec is any legal npm dependency note symbol (excludes empty string);
 * - git source:`git:<repo>[@<ref>][#<subdirectory>]`,repo can is https URL,
 *   `user@host:path` SCP form or `host/path` short write (without scheme when disallows local
 *   file path mistakenly); support `<repo>#<subdirectory>` separate designate subdirectory;
 * - HTTPS Git URL:`https://...(.git)?[#<ref>][#<subdirectory>]`- -ref and
 *   subdirectory all via URL fragment pass reach,`#a#b` before is ref after is subdirectory
 *   (and Pi  `git:repo@ref#subdir` precise spirit align, but Helm explicit reject ambiguity write method);
 * - local source: absolute path or each other for Hub cwd relative path (./ ../ open head).
 *
 * reject:file://, non- https  http URL(plaintext transfer cannot message), with builtin: open head
 * source,npm spec inside embed builtin: prefix name, empty string and whitespace.
 *
 * honest discipline: failed to parse explicit HelmError('validation_error'), never guess by default source.
 */
import { isAbsolute, resolve } from 'node:path';
import { HelmError, type PluginPackageSource } from '@helm/protocol';

/** npm note symbol most small legal: non-empty, without whitespace (do not in this heavy build semver parse, hand over to npm). */
const NPM_SPEC_PATTERN = /^\S+$/;

/**
 * git repository address strictly validate (reject path inject): only allows three form - -
 * - https URL(https://host/path);
 * - SCP form (user@host:path,user can default is git@host:path);
 * - host/path short write (github.com/user/repo).
 * reject: backslash,NUL,.. route segment, absolute path (/ or symbol open head), plaintext http://,
 * file:// and other unknown scheme, contains whitespace address.
 */
function assertGitRepo(repo: string, raw: string): void {
  const fail = (detail: string): HelmError =>
    new HelmError('validation_error', `git source repository address illegal (${detail}):${repo}`, 400, { raw, repo });
  if (repo.length === 0) throw fail('empty address');
  if (repo.includes('\\') || repo.includes('\0')) throw fail('contains backslash or NUL');
  if (/\s/.test(repo)) throw fail('contains whitespace');
  if (repo.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(repo) || repo.startsWith('\\\\')) {
    throw fail('absolute path (local plugin please directly provide path, do not away git:)');
  }
  if (repo.includes('..')) throw fail('contains .. route segment');
  if (/^http:\/\//i.test(repo)) throw fail('plaintext http://(use https)');
  if (/^file:/i.test(repo)) throw fail('file: protocol');
  // scheme:// form: only allows https(the rest ssh://,git:// etc. one rule reject, avoid and SCP
  // form ambiguity and not via audit transfer protocol)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(repo)) {
    if (!/^https:\/\//i.test(repo)) throw fail('only allows https:// form (SCP please use user@host:path)');
    let parsed: URL;
    try {
      parsed = new URL(repo);
    } catch {
      throw fail('URL cannot parse');
    }
    if (parsed.hostname === '' || /^\s+$/.test(parsed.hostname)) throw fail('missing host name');
    return;
  }
  if (/^https:\/\//i.test(repo)) {
    // cannot reach:https:// already in on way scheme:// branch handle; keep guard against defend
    return;
  }
  // SCP(user@host:path, contains optional port): smoke number before is not scheme(scheme must character parent open head and
  // directly with :,SCP smoke number before is host or @host), path segment non-empty
  const scpMatch = /^([a-zA-Z0-9._~-]+@)?([a-zA-Z0-9._~-]+(?::\d+)?):(.+)$/.exec(repo);
  if (scpMatch !== null) {
    if (scpMatch[3] === undefined || scpMatch[3].length === 0 || scpMatch[3].startsWith('/')) {
      throw fail('SCP path segment illegal');
    }
    return;
  }
  // the rest scheme form (xxx:...) reject
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(repo)) throw fail('unknown protocol');
  // host/path short write:host segment character parent number open head (reject ./ ../ etc. local each other for form)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._~-]*\/[a-zA-Z0-9._~\/:@!$'()*+,;%=-]+$/.test(repo)) {
    throw fail('must be https URL,SCP user@host:path or host/path form');
  }
}

/** detail git repo tail part:<repo>[@<ref>][#<subdirectory>](ref must not again contains @ #). */
function splitGitTail(rest: string, raw: string): { repo: string; ref?: string; subdirectory?: string } {
  // first cut #subdirectory(fragment only allows appear once)
  const hashIndex = rest.indexOf('#');
  const subdirectory = hashIndex >= 0 ? rest.slice(hashIndex + 1) : undefined;
  let head = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  if (subdirectory !== undefined) {
    if (subdirectory.length === 0) {
      throw new HelmError('validation_error', `git source subdirectory is empty (# after must be path):${raw}`, 400, { raw });
    }
    if (subdirectory.includes('#')) {
      throw new HelmError('validation_error', `git source contains multiple #(only allows a subdirectory fragment):${raw}`, 400, { raw });
    }
    if (subdirectory.startsWith('/') || subdirectory.includes('..') || subdirectory.includes('\\')) {
      throw new HelmError('validation_error', `git source subdirectory must be repository inside relative path:${raw}`, 400, { raw });
    }
  }
  let ref: string | undefined;
  // SCP form (user@host:path) @ belongs to address; only when @ do not in first smoke number before when only then treated as ref isolate
  const firstColon = head.indexOf(':');
  const atIndex = head.lastIndexOf('@');
  const atIsRefSeparator = atIndex > 0 && (firstColon < 0 || atIndex > firstColon);
  if (atIsRefSeparator) {
    ref = head.slice(atIndex + 1);
    head = head.slice(0, atIndex);
    if (ref.length === 0) {
      throw new HelmError('validation_error', `git source ref is empty (@ after must be branch/Tag/Commit):${raw}`, 400, { raw });
    }
    if (ref.includes('#')) {
      throw new HelmError('validation_error', `git source ref illegal (must not contains #):${raw}`, 400, { raw });
    }
  }
  const repo = head;
  if (repo.length === 0) {
    throw new HelmError('validation_error', `git source missing repository address:${raw}`, 400, { raw });
  }
  return { repo, ref, subdirectory };
}

/**
 * parse plugin package source string is specification shape.
 * cwd used to each other for local path parse (caller pass Hub cwd).
 */
export function parsePluginSource(raw: string, cwd: string): PluginPackageSource {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new HelmError('validation_error', 'plugin package source source must be a non-empty string', 400);
  }
  if (raw !== raw.trim()) {
    throw new HelmError('validation_error', `plugin package source must not contains first tail whitespace:${raw}`, 400, { raw });
  }
  if (raw.startsWith('builtin:') || raw.startsWith('builtin%3A')) {
    throw new HelmError('validation_error', `plugin package source disallows builtin: prefix (built-in plugin does not participate package install):${raw}`, 400, { raw });
  }
  if (raw.startsWith('file://')) {
    throw new HelmError(
      'validation_error',
      `unsupported file:// protocol (local plugin please directly provide absolute path or ./ ../ relative path):${raw}`,
      400,
      { raw },
    );
  }
  if (raw.startsWith('npm:')) {
    const spec = raw.slice('npm:'.length);
    if (!NPM_SPEC_PATTERN.test(spec)) {
      throw new HelmError('validation_error', `npm source note symbol illegal:${spec}(npm:<spec>,spec is npm dependency note symbol)`, 400, { raw });
    }
    if (spec.startsWith('builtin:')) {
      throw new HelmError('validation_error', `npm note symbol must not with builtin: open head:${spec}`, 400, { raw });
    }
    return { kind: 'npm', raw, spec };
  }
  if (raw.startsWith('git+')) {
    throw new HelmError(
      'validation_error',
      `unsupported git+ URL scheme(use git:<repo>[@<ref>] or https Git URL):${raw}`,
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
    // HTTPS Git URL:#<ref>[#<subdirectory>] or directly #<subdirectory>
    const hashIndex = raw.indexOf('#');
    const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const fragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : undefined;
    let repo = base;
    let ref: string | undefined;
    let subdirectory: string | undefined;
    if (fragment !== undefined) {
      const parts = fragment.split('#');
      if (parts.length > 2) {
        throw new HelmError('validation_error', `git URL contains many # fragment (at most ref and subdirectory two):${raw}`, 400, { raw });
      }
      if (parts.length === 2) {
        const parsedRef = parts[0]!;
        subdirectory = parts[1];
        if (parsedRef.length === 0) {
          throw new HelmError('validation_error', `git URL ref is empty:${raw}`, 400, { raw });
        }
        ref = parsedRef;
      } else {
        // single fragment: contains / treated as subdirectory, otherwise treated as ref(branch name/tag common form)
        if (fragment.includes('/')) subdirectory = fragment;
        else ref = fragment;
      }
      if (subdirectory !== undefined) {
        if (subdirectory.length === 0 || subdirectory.startsWith('/') || subdirectory.includes('..') || subdirectory.includes('\\')) {
          throw new HelmError('validation_error', `git URL subdirectory must be repository inside relative path:${raw}`, 400, { raw });
        }
      }
    }
    // tail part @ref(.git suffix form, such as https://...git@v1): only when URL without userinfo @ when
    const atOutsideUser = findTrailingRefAt(repo);
    if (atOutsideUser >= 0) {
      ref = repo.slice(atOutsideUser + 1);
      repo = repo.slice(0, atOutsideUser);
      if (ref.length === 0 || ref.includes('/')) {
        throw new HelmError('validation_error', `git URL tail part @ref illegal:${raw}`, 400, { raw });
      }
    }
    let parsedHost: URL;
    try {
      parsedHost = new URL(repo);
    } catch {
      throw new HelmError('validation_error', `git URL illegal:${raw}`, 400, { raw });
    }
    if (parsedHost.hostname === '' || /^\s+$/.test(parsedHost.hostname)) {
      throw new HelmError('validation_error', `git URL missing host name:${raw}`, 400, { raw });
    }
    return { kind: 'git', raw, repo, ref, subdirectory };
  }
  if (/^http:\/\//i.test(raw)) {
    throw new HelmError(
      'validation_error',
      `unsupported plaintext http:// Git URL(use https or git: form):${raw}`,
      400,
      { raw },
    );
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    throw new HelmError(
      'validation_error',
      `unsupported source protocol (only support npm: / git: / https Git URL / local path):${raw}`,
      400,
      { raw },
    );
  }
  // local path: absolute path or ./ ../ relative path (bare directory name reject - - too easy and npm/git confuse)
  if (isAbsolute(raw) || raw.startsWith('./') || raw.startsWith('../') || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    const path = resolve(cwd, raw);
    if (path.includes('\0')) {
      throw new HelmError('validation_error', `local path contains illegal character:${raw}`, 400, { raw });
    }
    return { kind: 'local', raw, path };
  }
  throw new HelmError(
    'validation_error',
    `cannot identify plugin package source:${raw}(support npm:<spec>,git:<repo>[@<ref>],HTTPS Git URL, local absolute/relative path)`,
    400,
    { raw },
  );
}

/** find out URL path segment in finally a @(skip userinfo  user@host and port). */
function findTrailingRefAt(repo: string): number {
  try {
    const url = new URL(repo);
    const path = url.pathname;
    const at = path.lastIndexOf('@');
    if (at < 0) return -1;
    // only recognize can.git suffix or path end segment after @ref form, and ref excludes /
    const tail = path.slice(at + 1);
    if (tail.includes('/')) return -1;
    // rebuild: return the whole repo string in for should location
    const beforePath = repo.lastIndexOf(url.pathname);
    if (beforePath < 0) return -1;
    return beforePath + at;
  } catch {
    return -1;
  }
}
