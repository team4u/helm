/**
 * Git changeset collect:check-changed / check-hygiene shared use baseline parse + change file and collection mechanism.
 *
 * is what do not use `git diff HEAD~1`: many commit branch, staged zone, untracked file and rename all will by leak,
 * fast feedback gate establish in leak file choose collection on equals false security. this module changeset define is three meta and collection:
 *   committed  = merge-base(base, HEAD) .. HEAD commit difference (contains rename new old two side path)
 *   worktree   = HEAD and work zone difference (staged + unstaged one body,git diff HEAD day however such as this)
 *   untracked  = git ls-files --others --exclude-standard
 *
 * baseline (base) parse priority: explicit --base <ref> > branch upstream > origin/HEAD(symbolic-ref).
 * three all without when return kind:'none', by caller explicit errors want seek --base- - never static default retreat to HEAD~1.
 *
 * all git output use -z(NUL isolate) parse, path contains space, Chinese, quotes all security;rename/copy record
 * in -z pattern under is <status>\0<newPath>\0<oldPath>\0 three segment, two side path all accept changeset.
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
  // branch upstream:git rev-parse --symbolic-full-name @{upstream}, without upstream when exit code non- 0.
  const up = spawnSync('git', ['rev-parse', '--verify', '--symbolic-full-name', '@{upstream}'], {
    cwd,
    encoding: 'utf8',
  });
  if (up.status === 0) {
    const ref = (up.stdout ?? '').trim();
    if (ref) return { ref, via: 'upstream' };
  }
  // origin/HEAD(symbolic-ref points to by default branch, such as origin/main).
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
 * parse baseline and compute merge-base.
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
      throw new GitChangeError(`--base reference missing or is not commit: ${base}`);
    }
    const mb = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd, encoding: 'utf8' });
    if (mb.status !== 0 || !(mb.stdout ?? '').trim()) {
      throw new GitChangeError(`--base ${base} and HEAD without jointly ancestor, cannot compute merge-base`);
    }
    return { kind: 'explicit', ref: base, mergeBase: mb.stdout.trim() };
  }
  const detected = detectDefaultRef(cwd);
  if (detected.kind === 'none') return { kind: 'none', ref: null, mergeBase: null };
  const mb = spawnSync('git', ['merge-base', detected.ref, 'HEAD'], { cwd, encoding: 'utf8' });
  if (mb.status !== 0 || !(mb.stdout ?? '').trim()) {
    throw new GitChangeError(`baseline ${detected.ref} and HEAD without jointly ancestor, cannot compute merge-base`);
  }
  return {
    kind: detected.via,
    ref: detected.ref,
    mergeBase: mb.stdout.trim(),
  };
}

/**
 * parse `git diff --name-status -z` output (contains rename/copy double path expand).
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
 * collect complete changeset (committed ∪ worktree ∪ untracked).
 * @param {{ base?: string, cwd: string }} opts
 * @returns {{ baseline: BaselineInfo, files: ChangedFile[] }}
 */
export function collectChangedFiles({ base, cwd }) {
  const baseline = resolveBaseline({ base, cwd });
  if (baseline.kind === 'none') {
    throw new GitChangeError(
      'not found available by default baseline (branch without upstream and without origin/HEAD), please use --base <ref> explicit designate baseline,' +
        'e.g. --base origin/main or --base main; do not want dependency HEAD~1 this kind of will leak many commit guess',
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

  // the same file may also appear in multiple source (such as committed after again change), keep all source and state supply re-check.
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
    throw new GitChangeError(`git diff(${label}) failed: ${(res.stderr ?? '').trim()}`);
  }
  return parseNameStatusZ(res.stdout ?? '').map((f) => ({
    path: f.path,
    status: f.status,
    origin: label,
  }));
}

/** merge-base to HEAD between commit count (only used to report baseline after degree). */
export function commitsAhead(cwd, mergeBase) {
  const res = spawnSync('git', ['rev-list', '--count', `${mergeBase}..HEAD`], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) return -1;
  return Number((res.stdout ?? '').trim());
}

/** short hash(only report use). */
export function shortRev(cwd, rev) {
  const res = spawnSync('git', ['rev-parse', '--short', rev], { cwd, encoding: 'utf8' });
  return res.status === 0 ? (res.stdout ?? '').trim() : rev;
}
