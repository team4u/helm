/**
 * Release notes assembly, shared by two consumers:
 * - release.yml's notes job: `node scripts/lib/release-notes.mjs --tag v0.1.2 --out <file>` with
 *   the three honest artifact status lines from the npm-publish job passed via
 *   HELMX_RELEASE_{PAYLOAD,CLI,NODE}_STATUS env vars;
 * - scripts/release.mjs (local orchestration): imports commitSubjectsSince()/resolvePreviousTag()
 *   to preview the changelog before tagging.
 *
 * Honesty constraints: the artifact status section renders the npm-publish job's actual outputs
 * verbatim (published / skipped-as-placeholder / did-not-complete); this module never fabricates
 * a publish result. The changelog is commit subjects between the previous tag and the release
 * commit, with chore(release) commits and merge-commit subjects filtered out.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILTERED_SUBJECT = [/^chore\(release\):/, /^Merge (branch|pull request|remote-tracking branch|tag)/];

/** Run git in the current working directory, returning stdout; throws with stderr on failure. */
function runGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr?.trim() || '(no stderr)'}`);
  }
  return res.stdout;
}

/** Best-effort previous tag reachable from revSpec (null when none exists yet). */
export function resolvePreviousTag(revSpec) {
  const res = spawnSync('git', ['describe', '--tags', '--abbrev=0', revSpec], { encoding: 'utf-8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

/** Commit subjects in baseRef..HEAD as markdown list items; noise commits filtered out. */
export function commitSubjectsSince(baseRef) {
  const subjects = runGit(['log', `${baseRef}..HEAD`, '--pretty=format:%s'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((subject) => !FILTERED_SUBJECT.some((re) => re.test(subject)));
  return subjects.map((subject) => `- ${subject}`).join('\n');
}

/**
 * Assemble the full release notes body. prevTag may be null (first release): the changelog
 * section then states so instead of guessing a range.
 */
export function assembleReleaseNotes({ tag, prevTag, payloadStatus, cliStatus, nodeStatus }) {
  if (!/^v\d+\.\d+\.\d+/.test(tag)) {
    throw new Error(`tag must look like v<semver>, got: ${tag}`);
  }
  for (const [label, value] of [
    ['payload', payloadStatus],
    ['cli', cliStatus],
    ['node', nodeStatus],
  ]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`missing ${label} artifact status line (HELMX_RELEASE_${label.toUpperCase()}_STATUS) — refusing to assemble notes without the npm-publish job's actual outputs`);
    }
  }
  const changelog = prevTag ? commitSubjectsSince(prevTag) : '';
  const changelogSection = prevTag
    ? changelog || '-（上一版本以来无可列出的提交）'
    : '-（首次发布）';
  return [
    `## 变更明细（${prevTag ? `${prevTag}..${tag}` : '首次发布'}）`,
    '',
    changelogSection,
    '',
    '## 制品发布状态',
    '',
    '> 由本次 release.yml 各作业实际输出渲染（绝不伪称已发布）。',
    '',
    `- Hub payload：${payloadStatus.trim()}`,
    `- CLI：${cliStatus.trim()}`,
    `- 节点守护进程：${nodeStatus.trim()}`,
    '',
  ].join('\n');
}

function printHelp() {
  console.log(`
用法: node scripts/lib/release-notes.mjs --tag <v版本号> --out <文件路径>

环境变量（必填，来自 release.yml notes 作业注入的 npm-publish 作业输出）:
  HELMX_RELEASE_PAYLOAD_STATUS  Hub payload 制品的发布状态行
  HELMX_RELEASE_CLI_STATUS      CLI 制品的发布状态行
  HELMX_RELEASE_NODE_STATUS     节点守护进程制品的发布状态行

说明: 变更明细取上一 tag 至本次 tag 的提交列表（过滤 chore(release) 与 merge 提交），
制品状态行原样渲染 npm-publish 作业的真实输出，不编造发布结果。
`);
}

function main() {
  const args = process.argv.slice(2);
  let tag = '';
  let out = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) tag = args[++i];
    else if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`未知参数: ${args[i]}（--help 查看用法）`);
      process.exit(1);
    }
  }
  if (!tag || !out) {
    console.error('需要 --tag <v版本号> 与 --out <文件路径>（--help 查看用法）');
    process.exit(1);
  }
  // The workflow checks out the tagged commit, so the previous tag resolves from its parent;
  // a failure here (first release) degrades to the "first release" changelog section.
  const prevTag = resolvePreviousTag('HEAD^');
  const notes = assembleReleaseNotes({
    tag,
    prevTag,
    payloadStatus: process.env.HELMX_RELEASE_PAYLOAD_STATUS,
    cliStatus: process.env.HELMX_RELEASE_CLI_STATUS,
    nodeStatus: process.env.HELMX_RELEASE_NODE_STATUS,
  });
  writeFileSync(path.resolve(process.cwd(), out), notes);
  console.log(`[release-notes] assembled ${out} (${prevTag ? `${prevTag}..${tag}` : '首次发布'}, ${notes.length} bytes)`);
}

// CLI entry only when invoked directly; the functions above stay importable for scripts/release.mjs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[release-notes] 装配失败: ${err.message}`);
    process.exit(1);
  }
}
