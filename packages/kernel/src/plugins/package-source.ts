/**
 * 外部插件包安装来源解析（source grammar）。
 *
 * 最小 grammar（与 protocol PluginPackageSource 判别联合一一对应）：
 * - npm 来源：`npm:<spec>`，spec 为任意合法 npm 依赖说明符（不含空串）；
 * - git 来源：`git:<repo>[@<ref>][#<subdirectory>]`，repo 可为 https URL、
 *   `user@host:path` SCP 形态或 `host/path` 短写（无 scheme 时不允许 local
 *   file path 误入）；支持 `<repo>#<subdirectory>` 单独指定子目录；
 * - HTTPS Git URL：`https://...(.git)?[#<ref>][#<subdirectory>]`——ref 与
 *   subdirectory 均经 URL fragment 传达，`#a#b` 前者为 ref 后者为子目录
 *   （与 Pi 的 `git:repo@ref#subdir` 精神对齐，但 Helm 明确拒绝歧义写法）；
 * - local 来源：绝对路径或相对 Hub cwd 的相对路径（./ ../ 开头）。
 *
 * 拒绝：file://、非 https 的 http URL（明文传输不可信）、以 builtin: 开头的
 * source、npm spec 内嵌 builtin: 前缀名、空串与空白。
 *
 * 诚实性纪律：解析失败显式 HelmError('validation_error')，绝不猜测默认来源。
 */
import { isAbsolute, resolve } from 'node:path';
import { HelmError, type PluginPackageSource } from '@helm/protocol';

/** npm 说明符最小合法性：非空、无空白（不在此重造 semver 解析器，交给 npm）。 */
const NPM_SPEC_PATTERN = /^\S+$/;

const REPO_SEGMENT = /[A-Za-z0-9._~:@!$'()*+,;%=-]+/;

/** 细分 git repo 尾部：<repo>[@<ref>][#<subdirectory>]（ref 不得再含 @ #）。 */
function splitGitTail(rest: string, raw: string): { repo: string; ref?: string; subdirectory?: string } {
  // 先切 #subdirectory（fragment 只允许出现一次）
  const hashIndex = rest.indexOf('#');
  const subdirectory = hashIndex >= 0 ? rest.slice(hashIndex + 1) : undefined;
  let head = hashIndex >= 0 ? rest.slice(0, hashIndex) : rest;
  if (subdirectory !== undefined) {
    if (subdirectory.length === 0) {
      throw new HelmError('validation_error', `git 来源子目录为空（# 后需为路径）：${raw}`, 400, { raw });
    }
    if (subdirectory.includes('#')) {
      throw new HelmError('validation_error', `git 来源含多个 #（仅允许一个子目录片段）：${raw}`, 400, { raw });
    }
    if (subdirectory.startsWith('/') || subdirectory.includes('..') || subdirectory.includes('\\')) {
      throw new HelmError('validation_error', `git 来源子目录需为仓库内相对路径：${raw}`, 400, { raw });
    }
  }
  let ref: string | undefined;
  // SCP 形态（user@host:path）的 @ 属于地址；仅当 @ 不在首个冒号之前时才视为 ref 分隔
  const firstColon = head.indexOf(':');
  const atIndex = head.lastIndexOf('@');
  const atIsRefSeparator = atIndex > 0 && (firstColon < 0 || atIndex > firstColon);
  if (atIsRefSeparator) {
    ref = head.slice(atIndex + 1);
    head = head.slice(0, atIndex);
    if (ref.length === 0) {
      throw new HelmError('validation_error', `git 来源 ref 为空（@ 后需为分支/Tag/Commit）：${raw}`, 400, { raw });
    }
    if (ref.includes('#')) {
      throw new HelmError('validation_error', `git 来源 ref 非法（不得含 #）：${raw}`, 400, { raw });
    }
  }
  const repo = head;
  if (repo.length === 0) {
    throw new HelmError('validation_error', `git 来源缺少仓库地址：${raw}`, 400, { raw });
  }
  return { repo, ref, subdirectory };
}

/**
 * 解析插件包来源字符串为规范化形状。
 * cwd 用于相对 local 路径解析（调用方传 Hub cwd）。
 */
export function parsePluginSource(raw: string, cwd: string): PluginPackageSource {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new HelmError('validation_error', '插件包来源 source 需为非空字符串', 400);
  }
  if (raw !== raw.trim()) {
    throw new HelmError('validation_error', `插件包来源不得含首尾空白：${raw}`, 400, { raw });
  }
  if (raw.startsWith('builtin:') || raw.startsWith('builtin%3A')) {
    throw new HelmError('validation_error', `插件包来源不允许 builtin: 前缀（内置插件不参与包安装）：${raw}`, 400, { raw });
  }
  if (raw.startsWith('file://')) {
    throw new HelmError(
      'validation_error',
      `不支持 file:// 协议（本地插件请直接提供绝对路径或 ./ ../ 相对路径）：${raw}`,
      400,
      { raw },
    );
  }
  if (raw.startsWith('npm:')) {
    const spec = raw.slice('npm:'.length);
    if (!NPM_SPEC_PATTERN.test(spec)) {
      throw new HelmError('validation_error', `npm 来源说明符非法：${spec}（npm:<spec>，spec 为 npm 依赖说明符）`, 400, { raw });
    }
    if (spec.startsWith('builtin:')) {
      throw new HelmError('validation_error', `npm 说明符不得以 builtin: 开头：${spec}`, 400, { raw });
    }
    return { kind: 'npm', raw, spec };
  }
  if (raw.startsWith('git+')) {
    throw new HelmError(
      'validation_error',
      `不支持 git+ URL scheme（请使用 git:<repo>[@<ref>] 或 https Git URL）：${raw}`,
      400,
      { raw },
    );
  }
  if (raw.startsWith('git:')) {
    const parsed = splitGitTail(raw.slice('git:'.length), raw);
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(parsed.repo) && !REPO_SEGMENT.test(parsed.repo)) {
      throw new HelmError('validation_error', `git 来源仓库地址非法：${parsed.repo}`, 400, { raw });
    }
    return { kind: 'git', raw, ...parsed };
  }
  if (/^https:\/\//i.test(raw)) {
    // HTTPS Git URL：#<ref>[#<subdirectory>] 或直接 #<subdirectory>
    const hashIndex = raw.indexOf('#');
    const base = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const fragment = hashIndex >= 0 ? raw.slice(hashIndex + 1) : undefined;
    let repo = base;
    let ref: string | undefined;
    let subdirectory: string | undefined;
    if (fragment !== undefined) {
      const parts = fragment.split('#');
      if (parts.length > 2) {
        throw new HelmError('validation_error', `git URL 含过多 # 片段（至多 ref 与子目录两个）：${raw}`, 400, { raw });
      }
      if (parts.length === 2) {
        const parsedRef = parts[0]!;
        subdirectory = parts[1];
        if (parsedRef.length === 0) {
          throw new HelmError('validation_error', `git URL ref 为空：${raw}`, 400, { raw });
        }
        ref = parsedRef;
      } else {
        // 单 fragment：含 / 视为子目录，否则视为 ref（分支名/tag 常见形态）
        if (fragment.includes('/')) subdirectory = fragment;
        else ref = fragment;
      }
      if (subdirectory !== undefined) {
        if (subdirectory.length === 0 || subdirectory.startsWith('/') || subdirectory.includes('..') || subdirectory.includes('\\')) {
          throw new HelmError('validation_error', `git URL 子目录需为仓库内相对路径：${raw}`, 400, { raw });
        }
      }
    }
    // 尾部 @ref（.git 后缀形式，如 https://...git@v1）：仅当 URL 无 userinfo @ 时
    const atOutsideUser = findTrailingRefAt(repo);
    if (atOutsideUser >= 0) {
      ref = repo.slice(atOutsideUser + 1);
      repo = repo.slice(0, atOutsideUser);
      if (ref.length === 0 || ref.includes('/')) {
        throw new HelmError('validation_error', `git URL 尾部 @ref 非法：${raw}`, 400, { raw });
      }
    }
    let parsedHost: URL;
    try {
      parsedHost = new URL(repo);
    } catch {
      throw new HelmError('validation_error', `git URL 非法：${raw}`, 400, { raw });
    }
    if (parsedHost.hostname === '' || /^\s+$/.test(parsedHost.hostname)) {
      throw new HelmError('validation_error', `git URL 缺少主机名：${raw}`, 400, { raw });
    }
    return { kind: 'git', raw, repo, ref, subdirectory };
  }
  if (/^http:\/\//i.test(raw)) {
    throw new HelmError(
      'validation_error',
      `不支持明文 http:// Git URL（请使用 https 或 git: 形态）：${raw}`,
      400,
      { raw },
    );
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    throw new HelmError(
      'validation_error',
      `不支持的来源协议（仅支持 npm: / git: / https Git URL / 本地路径）：${raw}`,
      400,
      { raw },
    );
  }
  // local 路径：绝对路径或 ./ ../ 相对路径（裸目录名拒绝——太易与 npm/git 混淆）
  if (isAbsolute(raw) || raw.startsWith('./') || raw.startsWith('../') || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    const path = resolve(cwd, raw);
    if (path.includes('\0')) {
      throw new HelmError('validation_error', `本地路径含非法字符：${raw}`, 400, { raw });
    }
    return { kind: 'local', raw, path };
  }
  throw new HelmError(
    'validation_error',
    `无法识别的插件包来源：${raw}（支持 npm:<spec>、git:<repo>[@<ref>]、HTTPS Git URL、本地绝对/相对路径）`,
    400,
    { raw },
  );
}

/** 找出 URL path 段中最后一个 @（跳过 userinfo 的 user@host 与 port）。 */
function findTrailingRefAt(repo: string): number {
  try {
    const url = new URL(repo);
    const path = url.pathname;
    const at = path.lastIndexOf('@');
    if (at < 0) return -1;
    // 只认可「.git 后缀或路径末段之后」的 @ref 形态，且 ref 不含 /
    const tail = path.slice(at + 1);
    if (tail.includes('/')) return -1;
    // 重建：返回整个 repo 字符串中的对应位置
    const beforePath = repo.lastIndexOf(url.pathname);
    if (beforePath < 0) return -1;
    return beforePath + at;
  } catch {
    return -1;
  }
}
