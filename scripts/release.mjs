#!/usr/bin/env node
/**
 * pnpm release — 本地发版编排（docs/releasing.md 的自动化入口）。
 *
 * 与 release.yml 流水线的职责边界（参考 actiondock 模式，触发事实源保持不变）：
 * - 本脚本：工作区/分支守卫 → 变更明细预览 → 本地全量质量门禁 → 锁步 bump 全部
 *   packages/<pkg>/package.json 版本 → 创建 chore(release): v<ver> 提交与轻量 tag → 推送
 *   main 与 tag。**不创建 GitHub Release、不触碰 npm**。
 * - release.yml（由推送的 v* tag 触发）：verify → build → npm-publish → notes。GitHub
 *   Release 及其 Release notes 由流水线的 notes 作业在 npm 发布完成后如实渲染，本地
 *   不预写任何发布说明，避免与实际发布结果漂移。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitSubjectsSince, resolvePreviousTag } from './lib/release-notes.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, { allowFailure = false } = {}) {
  const res = spawnSync(cmd, args, { cwd: rootDir, encoding: 'utf-8', shell: process.platform === 'win32' });
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`${cmd} ${args.join(' ')} 失败 (exit ${res.status}):\n${res.stderr || res.stdout || '(无输出)'}`);
  }
  return res;
}

function git(args, options) {
  return run('git', args, options);
}

function printHelp() {
  console.log(`
用法: node scripts/release.mjs [版本号] [选项]

版本参数（缺省 --patch）:
  1.2.3 | v1.2.3        显式目标版本（禁止 build 元数据）
  --patch               自增修订号 (x.y.Z)
  --minor               自增次版本号 (x.Y.0)
  --major               自增主版本号 (X.0.0)
  --prerelease [id]     自增预发布号（缺省 id 为 beta；发 beta dist-tag）

守卫与流程选项:
  --dry-run             模拟运行：只预览变更明细与计划动作，不修改任何文件
  --skip-verify         跳过本地全量质量门禁（typecheck/lint/check:hygiene/build/test:all；
                        流水线仍会全量重验，此项只是本地提速逃生口）
  --push                提交后推送 main 与 v* tag（触发 release.yml）
  --allow-dirty         允许工作区存在未提交改动（不建议）
  --allow-non-main      允许从非 main 分支发版（要求 HEAD 与 origin/main 一致，边缘场景）

说明:
  - 版本单一来源是 packages/payload/package.json；脚本会锁步更新全部 packages/<pkg>/package.json。
  - GitHub Release 与 Release notes 由流水线 notes 作业在 npm 发布后生成，本地不预写。
`);
}

function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = { dryRun: false, skipVerify: false, push: false, allowDirty: false, allowNonMain: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-verify') options.skipVerify = true;
    else if (arg === '--push') options.push = true;
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else if (arg === '--allow-non-main') options.allowNonMain = true;
    else if (arg === '--patch' || arg === '--minor' || arg === '--major') options.bumpType = arg.slice(2);
    else if (arg === '--prerelease') {
      options.bumpType = 'prerelease';
      if (args[i + 1] && !args[i + 1].startsWith('--')) options.preId = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('--') && !options.version) {
      options.version = arg.replace(/^v/, '');
    } else {
      console.error(`未知参数: ${arg}（--help 查看用法）`);
      process.exit(1);
    }
  }
  return options;
}

/** 纯数字三元组 + 可选预发布段的极简 semver 解析（够用即止，不做完整 semver）。 */
function parseSemverLoose(version) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!m) throw new Error(`版本号不符合 x.y.z[-预发布] 形态: ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

function bumpSemver(current, bumpType, preId = 'beta') {
  const cur = parseSemverLoose(current);
  if (bumpType === 'patch') return `${cur.major}.${cur.minor}.${cur.patch + 1}`;
  if (bumpType === 'minor') return `${cur.major}.${cur.minor + 1}.0`;
  if (bumpType === 'major') return `${cur.major + 1}.0.0`;
  // prerelease: 同段递增（1.2.3-beta.1 -> 1.2.3-beta.2），或从正式版开出首个预发布
  if (cur.pre !== null) {
    const base = `${cur.major}.${cur.minor}.${cur.patch}`;
    const segs = cur.pre.split('.');
    const last = segs[segs.length - 1];
    if (/^\d+$/.test(last) && segs.slice(0, -1).join('.').length > 0) {
      segs[segs.length - 1] = String(Number(last) + 1);
      return `${base}-${segs.join('.')}`;
    }
    if (/^\d+$/.test(last)) return `${base}-${last + 1}`;
    return `${base}-${cur.pre}.1`;
  }
  return `${cur.major}.${cur.minor}.${cur.patch + 1}-${preId}.1`;
}

/** 锁步更新全部 packages/<pkg>/package.json 的 version 字段，返回被更新的文件相对路径列表。 */
function bumpWorkspaceVersions(targetVersion) {
  const updated = [];
  for (const dir of readdirSync(path.join(rootDir, 'packages'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgPath = path.join(rootDir, 'packages', dir.name, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch {
      continue; // 无 package.json 的目录跳过
    }
    if (typeof pkg.version !== 'string') {
      throw new Error(`packages/${dir.name}/package.json 缺少 version 字段，锁步 bump 无法进行`);
    }
    pkg.version = targetVersion;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    updated.push(`packages/${dir.name}/package.json`);
  }
  if (updated.length === 0) throw new Error('packages/ 下没有找到任何带 version 的 package.json');
  return updated.sort();
}

function main() {
  const options = parseCliArgs();
  const payloadPkg = JSON.parse(readFileSync(path.join(rootDir, 'packages/payload/package.json'), 'utf-8'));
  const currentVersion = payloadPkg.version;

  let targetVersion = options.version;
  if (!targetVersion) targetVersion = bumpSemver(currentVersion, options.bumpType ?? 'patch', options.preId);
  parseSemverLoose(targetVersion);
  if (targetVersion === currentVersion) {
    throw new Error(`目标版本 ${targetVersion} 与当前版本相同，无需发版`);
  }

  console.log('=== helmx 本地发版编排（GitHub Release notes 由流水线生成） ===');
  console.log(`当前版本: ${currentVersion}（单一来源 packages/payload/package.json）`);
  console.log(`目标版本: ${targetVersion}${targetVersion.includes('-') ? '（预发布 → beta dist-tag）' : ''}`);
  console.log(`模拟运行: ${options.dryRun ? '是' : '否'}\n`);

  // 1. 工作区守卫：干净树 + main 分支（或显式豁免且 HEAD 与 origin/main 一致）
  if (!options.allowDirty) {
    const status = git(['status', '--porcelain'], { allowFailure: true });
    if (status.stdout.trim()) throw new Error('工作区存在未提交改动，请先提交或贮藏（或 --allow-dirty 自担风险）');
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (branch !== 'main') {
    if (!options.allowNonMain) throw new Error(`当前分支是 ${branch}，发版必须从 main 进行（worktree 边缘场景可 --allow-non-main）`);
    git(['fetch', 'origin', 'main'], { allowFailure: true });
    const local = git(['rev-parse', 'HEAD']).stdout.trim();
    const remote = git(['rev-parse', 'origin/main'], { allowFailure: true }).stdout.trim();
    if (!remote.trim() || local !== remote.trim()) {
      throw new Error('--allow-non-main 要求 HEAD 与 origin/main 完全一致，先同步再发版');
    }
  }
  console.log(`当前分支: ${branch}`);

  // 2. 变更明细预览（与流水线 notes 作业同一提炼逻辑：上个 tag..HEAD，滤 chore(release)/merge）
  const prevTag = resolvePreviousTag('HEAD');
  const changelog = prevTag ? commitSubjectsSince(prevTag) : '';
  console.log(`基准版本: ${prevTag ?? '（首次发布）'}`);
  console.log('\n流水线将渲染的变更明细:');
  console.log(changelog || '-（无可列出的提交）');
  console.log('');

  // 3. 本地全量质量门禁（流水线会重验，这里提前拦截省一轮 CI）
  if (options.skipVerify) {
    console.log('提示: --skip-verify 跳过本地门禁（release.yml 仍会全量验证）。');
  } else {
    for (const [label, cmdArgs] of [
      ['typecheck', ['pnpm', ['typecheck']]],
      ['lint', ['pnpm', ['lint']]],
      ['check:hygiene', ['pnpm', ['check:hygiene']]],
      ['build', ['pnpm', ['build']]],
      ['test:all', ['pnpm', ['test:all']]],
    ]) {
      console.log(`- ${label}...`);
      run(cmdArgs[0], cmdArgs[1]);
    }
    console.log('本地门禁全部通过。\n');
  }

  if (options.dryRun) {
    console.log(`[模拟运行] 未执行任何修改。计划: 锁步 bump ${updatedPreviewCount()} 个 package.json → 提交 chore(release): v${targetVersion} → ${options.push ? '推送 main + tag' : '（未指定 --push，不会推送）'} v${targetVersion}`);
    return;
  }

  // 4. 锁步 bump + 提交 + 轻量 tag
  const updated = bumpWorkspaceVersions(targetVersion);
  console.log(`锁步更新版本至 ${targetVersion}（${updated.length} 个 package.json）`);
  git(['add', ...updated.map((rel) => rel.replaceAll('\\', '/'))]);
  git(['commit', '-m', `chore(release): v${targetVersion}`]);
  const tag = `v${targetVersion}`;
  if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFailure: true }).status === 0) {
    throw new Error(`tag ${tag} 已存在，拒绝重复打 tag`);
  }
  git(['tag', tag]);
  console.log(`已创建提交 chore(release): v${targetVersion} 与轻量 tag ${tag}`);

  // 5. 推送 main 与 tag（tag 推送即触发 release.yml）
  if (options.push) {
    const pushTarget = branch === 'main' ? 'main' : 'HEAD:main';
    git(['push', 'origin', pushTarget]);
    git(['push', 'origin', tag]);
    console.log(`已推送 ${pushTarget} 与 ${tag}；release.yml 已触发，GitHub Release notes 将在 npm 发布完成后由 notes 作业生成。`);
  } else {
    console.log('\n未指定 --push，未推送。手动执行:');
    console.log(`  git push origin ${branch === 'main' ? 'main' : 'HEAD:main'}`);
    console.log(`  git push origin ${tag}`);
    console.log('推送 tag 后在 Actions 观察 verify → build → npm-publish → notes。');
  }
}

function updatedPreviewCount() {
  return readdirSync(path.join(rootDir, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => {
      try {
        return typeof JSON.parse(readFileSync(path.join(rootDir, 'packages', d.name, 'package.json'), 'utf-8')).version === 'string';
      } catch {
        return false;
      }
    }).length;
}

try {
  main();
} catch (err) {
  console.error(`\n发版流程终止: ${err.message}`);
  process.exit(1);
}
