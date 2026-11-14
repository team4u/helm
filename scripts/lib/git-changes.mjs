/**
 * Git 变更集收集器：check-changed / check-hygiene 共用的「基线解析 + 变更文件并集」机制。
 *
 * 为什么不用 `git diff HEAD~1`：多 commit 分支、暂存区、未跟踪文件与 rename 都会被漏掉，
 * 快速反馈门建立在漏文件的选集上等于假安全。本模块把变更集定义为三元并集：
 *   committed  = merge-base(base, HEAD) .. HEAD 的提交差异（含 rename 的新旧两侧路径）
 *   worktree   = HEAD 与工作区的差异（暂存 + 未暂存一体，git diff HEAD 天然如此）
 *   untracked  = git ls-files --others --exclude-standard
 *
 * 基线（base）解析优先级：显式 --base <ref> > 分支 upstream > origin/HEAD（symbolic-ref）。
 * 三者皆无时返回 kind:'none'，由调用方显式报错要求 --base——绝不静默退化到 HEAD~1。
 *
 * 全部 git 输出用 -z（NUL 分隔）解析，路径含空格、中文、引号均安全；rename/copy 记录
 * 在 -z 模式下是 <status>\0<newPath>\0<oldPath>\0 三段，两侧路径都纳入变更集。
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
  // 分支 upstream：git rev-parse --symbolic-full-name @{upstream}，无 upstream 时退出码非 0。
  const up = spawnSync('git', ['rev-parse', '--verify', '--symbolic-full-name', '@{upstream}'], {
    cwd,
    encoding: 'utf8',
  });
  if (up.status === 0) {
    const ref = (up.stdout ?? '').trim();
    if (ref) return { ref, via: 'upstream' };
  }
  // origin/HEAD（symbolic-ref 指向默认分支，如 origin/main）。
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
 * 解析基线并计算 merge-base。
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
      throw new GitChangeError(`--base 引用不存在或不是 commit: ${base}`);
    }
    const mb = spawnSync('git', ['merge-base', base, 'HEAD'], { cwd, encoding: 'utf8' });
    if (mb.status !== 0 || !(mb.stdout ?? '').trim()) {
      throw new GitChangeError(`--base ${base} 与 HEAD 无共同祖先，无法计算 merge-base`);
    }
    return { kind: 'explicit', ref: base, mergeBase: mb.stdout.trim() };
  }
  const detected = detectDefaultRef(cwd);
  if (detected.kind === 'none') return { kind: 'none', ref: null, mergeBase: null };
  const mb = spawnSync('git', ['merge-base', detected.ref, 'HEAD'], { cwd, encoding: 'utf8' });
  if (mb.status !== 0 || !(mb.stdout ?? '').trim()) {
    throw new GitChangeError(`基线 ${detected.ref} 与 HEAD 无共同祖先，无法计算 merge-base`);
  }
  return {
    kind: detected.via,
    ref: detected.ref,
    mergeBase: mb.stdout.trim(),
  };
}

/**
 * 解析 `git diff --name-status -z` 输出（含 rename/copy 双路径展开）。
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
 * 收集完整变更集（committed ∪ worktree ∪ untracked）。
 * @param {{ base?: string, cwd: string }} opts
 * @returns {{ baseline: BaselineInfo, files: ChangedFile[] }}
 */
export function collectChangedFiles({ base, cwd }) {
  const baseline = resolveBaseline({ base, cwd });
  if (baseline.kind === 'none') {
    throw new GitChangeError(
      '未找到可用的默认基线（分支无 upstream 且无 origin/HEAD），请用 --base <ref> 显式指定基线，' +
        '例如 --base origin/main 或 --base main；不要依赖 HEAD~1 这类会漏多 commit 的猜测',
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
    throw new GitChangeError(`git ls-files 失败: ${(untrackedRaw.stderr ?? '').trim()}`);
  }
  const untracked = (untrackedRaw.stdout ?? '')
    .split('\0')
    .filter((p) => p.length > 0)
    .map((p) => ({ path: p, status: 'U', origin: /** @type {const} */ ('untracked') }));

  // 同一文件可能同时出现在多个来源（如 committed 后又改），保留全部来源与状态供复核。
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
    throw new GitChangeError(`git diff（${label}）失败: ${(res.stderr ?? '').trim()}`);
  }
  return parseNameStatusZ(res.stdout ?? '').map((f) => ({
    path: f.path,
    status: f.status,
    origin: label,
  }));
}

/** merge-base 到 HEAD 之间的提交数（仅用于报告基线落后程度）。 */
export function commitsAhead(cwd, mergeBase) {
  const res = spawnSync('git', ['rev-list', '--count', `${mergeBase}..HEAD`], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) return -1;
  return Number((res.stdout ?? '').trim());
}

/** 短 hash（仅报告用）。 */
export function shortRev(cwd, rev) {
  const res = spawnSync('git', ['rev-parse', '--short', rev], { cwd, encoding: 'utf8' });
  return res.status === 0 ? (res.stdout ?? '').trim() : rev;
}
