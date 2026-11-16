/**
 * Git change-set collector: the shared baseline-resolution + changed-file-union mechanism
 * for check-changed / check-hygiene.
 *
 * Why not `git diff HEAD~1`: multi-commit branches, the staging area, untracked files, and
 * renames would all be missed, and a fast feedback gate built on a lossy selection is
 * false safety. This module defines the change set as a union of three sources:
 *   committed  = commit diff merge-base(base, HEAD) .. HEAD (both sides of renames)
 *   worktree   = diff between HEAD and the working tree (staged + unstaged as one; git
 *                 diff HEAD does this natively)
 *   untracked  = git ls-files --others --exclude-standard
 *
 * Baseline (base) resolution priority: explicit --base <ref> > branch upstream >
 * origin/HEAD (symbolic-ref).
 * When none exists, kind:'none' is returned and the caller must error out demanding --base
 * — never silently degrade to HEAD~1.
 *
 * All git output is parsed with -z (NUL-delimited), safe for paths with spaces, CJK
 * characters, or quotes; in -z mode a rename/copy record is the three segments
 * <status>\0<newPath>\0<oldPath>\0 and both paths join the change set.
 */
import { spawnSync } from 'node:child_process';

/** @typedef {{ kind: 'explicit' | 'upstream' | 'origin-head' | 'none', ref: string | null, mergeBase: string | null }} BaselineInfo */
/** @typedef {{ path: string, status: string, origin: 'committed' | 'worktree' | 'untracked' }} ChangedFile */

export class GitChangeError extends Error {}

/**
 * @param {string} cwd
 * @returns {{ ref: string, via: 'upstream' | 'origin-head' } | { kind: 'none' }}
 */
function detectDefaultRef(cwd) {
  // Branch upstream: git rev-parse --symbolic-full-name @{upstream}; non-zero exit when absent.
  const up = spawnSync('git', ['rev-parse', '--verify', '--symbolic-full-name', '@{upstream}'], {
    cwd,
    encoding: 'utf8',
  });
  if (up.status === 0) {
    const ref = (up.stdout ?? '').trim();
    if (ref) return { ref, via: 'upstream' };
  }
  // origin/HEAD (symbolic-ref pointing at the default branch, e.g. origin/main).
  const head = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  if (head.status === 0) {
    const ref = (head.stdout ?? '').trim();
    if (ref) return { ref, via: 'origin-head' };
  }
  return { kind: 'none' };
}

/**
 * Resolve the baseline and compute the merge-base.
 * @param {{ base?: string, cwd: string }} opts
 * @returns {BaselineInfo}
 */
export function resolveBaseline({ base, cwd }) {
  if (base) {
    const verify = spawnSync('git', ['rev-parse', '--verify', `${base}^{commit}`], {
      cwd,
      encoding: 'utf8',
    });
    if (verify.status !== 0) {
      throw new GitChangeError(`--base ref does not exist or is not a commit: ${base}`);
    }
    const mb = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd, encoding: 'utf8' });
    if (mb.status !== 0 || !(mb.stdout ?? '').trim()) {
      throw new GitChangeError(`--base ${base} and HEAD share no common ancestor; cannot compute merge-base`);
    }
    return { kind: 'explicit', ref: base, mergeBase: mb.stdout.trim() };
  }
  const detected = detectDefaultRef(cwd);
  if (detected.kind === 'none') return { kind: 'none', ref: null, mergeBase: null };
  const mb = spawnSync('git', ['merge-base', detected.ref, 'HEAD'], { cwd, encoding: 'utf8' });
  if (mb.status !== 0 || !(mb.stdout ?? '').trim()) {
    throw new GitChangeError(`baseline ${detected.ref} and HEAD share no common ancestor; cannot compute merge-base`);
  }
  return {
    kind: detected.via,
    ref: detected.ref,
    mergeBase: mb.stdout.trim(),
  };
}

/**
 * Parse `git diff --name-status -z` output (rename/copy dual-path expansion included).
 * @param {string} raw
 * @returns {{ path: string, status: string }[]}
 */
export function parseNameStatusZ(raw) {
  const tokens = raw.split('\0');
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) {
      i += 1;
      continue;
    }
    const path = tokens[i + 1];
    if (path === undefined) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const origPath = tokens[i + 2];
      out.push({ path, status });
      if (origPath !== undefined) {
        out.push({ path: origPath, status });
        i += 3;
        continue;
      }
      i += 2;
      continue;
    }
    out.push({ path, status });
    i += 2;
  }
  return out;
}

/**
 * Collect the full change set (committed ∪ worktree ∪ untracked).
 * @param {{ base?: string, cwd: string }} opts
 * @returns {{ baseline: BaselineInfo, files: ChangedFile[] }}
 */
export function collectChangedFiles({ base, cwd }) {
  const baseline = resolveBaseline({ base, cwd });
  if (baseline.kind === 'none') {
    throw new GitChangeError(
      'No usable default baseline found (branch has no upstream and no origin/HEAD); specify one explicitly ' +
        'with --base <ref>, e.g. --base origin/main or --base main; do not rely on HEAD~1 guesses that miss commits',
    );
  }
  const mb = /** @type {string} */ (baseline.mergeBase);

  const committed = runNameStatus(['--name-status', '-z', '-M', mb, 'HEAD'], cwd, 'committed');
  const worktree = runNameStatus(['--name-status', '-z', '-M', 'HEAD'], cwd, 'worktree');
  const untrackedRaw = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd,
    encoding: 'utf8',
  });
  if (untrackedRaw.status !== 0) {
    throw new GitChangeError(`git ls-files failed: ${(untrackedRaw.stderr ?? '').trim()}`);
  }
  const untracked = (untrackedRaw.stdout ?? '')
    .split('\0')
    .filter((p) => p.length > 0)
    .map((p) => ({ path: p, status: 'U', origin: /** @type {const} */ ('untracked') }));

  // The same file may appear in multiple sources (e.g. committed then modified again); keep all sources and statuses for review.
  const merged = new Map();
  for (const f of [...committed, ...worktree, ...untracked]) {
    const prev = merged.get(f.path) ?? { path: f.path, statuses: new Set(), origins: new Set() };
    prev.statuses.add(f.status);
    prev.origins.add(f.origin);
    merged.set(f.path, prev);
  }
  const files = [...merged.values()]
    .map((f) => ({
      path: f.path,
      status: [...f.statuses].sort().join('/'),
      origin: [...f.origins].sort().join('+'),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { baseline, files };
}

/** @returns {{ path: string, status: string, origin: 'committed' | 'worktree' }[]} */
function runNameStatus(args, cwd, label) {
  const res = spawnSync('git', ['diff', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new GitChangeError(`git diff (${label}) failed: ${(res.stderr ?? '').trim()}`);
  }
  return parseNameStatusZ(res.stdout ?? '').map((f) => ({
    path: f.path,
    status: f.status,
    origin: label,
  }));
}

/** Commit count between merge-base and HEAD (only to report how far behind the baseline is). */
export function commitsAhead(cwd, mergeBase) {
  const res = spawnSync('git', ['rev-list', '--count', `${mergeBase}..HEAD`], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) return -1;
  return Number((res.stdout ?? '').trim());
}

/** Short hash (reporting only). */
export function shortRev(cwd, rev) {
  const res = spawnSync('git', ['rev-parse', '--short', rev], { cwd, encoding: 'utf8' });
  return res.status === 0 ? (res.stdout ?? '').trim() : rev;
}
