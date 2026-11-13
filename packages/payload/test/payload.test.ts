/**
 * @helm/payload 集成测试：真实执行组装脚本与启动入口子进程。
 *
 * 覆盖：
 * 1. 组装：缺产物自动补构建（显式超时），assemble 后目录/manifest/checksum 契约成立；
 * 2. 布局：kernel dist + 内置插件 client/skill/assets 资产落位（与各解析器探测位一致）、
 *    web dist 与 hub.ts 默认探测 `../../../web/dist` 的同级布局命中、不携带 node_modules；
 * 3. 启动入口：check 在依赖缺失时显式退出码 3 并列缺失清单（诚实报告，不静默降级）；
 *    布局损坏（checksum 篡改）退出码 1；start 在依赖缺失时拒绝拉起 kernel。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const payloadPkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(payloadPkgRoot, '../..');
const stagingDir = path.join(payloadPkgRoot, 'dist');

/** manifest 契约的最小类型形状（start.mjs 侧同构校验）。 */
interface PayloadManifest {
  formatVersion: number
  name: string
  version: string
  builtAt: string
  nodeEngines: string
  entries: Record<string, string>
  entryChecksums: Record<string, string>
}

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number) {
  const res = spawnSync(command, args, { cwd, timeout: timeoutMs, encoding: 'utf8' });
  assert.equal(
    res.status,
    0,
    `命令失败: ${command} ${args.join(' ')} (cwd=${cwd})\nstdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`,
  );
  return res;
}

const sha256Of = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 递归收集目录内全部文件相对路径（POSIX 分隔）。 */
function walkFiles(rootDir: string): string[] {
  const out: string[] = [];
  const visit = (cur: string, prefix: string) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const rel = prefix === '' ? ent.name : `${prefix}/${ent.name}`;
      if (ent.isDirectory()) visit(path.join(cur, ent.name), rel);
      else out.push(rel);
    }
  };
  visit(rootDir, '');
  return out.sort();
}

/** 源 dist 内每个文件都必须原样出现在组装目录（子集校验，不做字节数巧合断言）。 */
function assertMirrored(srcDir: string, stagedDir: string) {
  for (const rel of walkFiles(srcDir)) {
    assert.ok(existsSync(path.join(stagedDir, rel)), `组装目录缺文件: ${rel}`);
  }
}

/** 内置插件运行时资产期望落位：src 侧存在的 client/skill/assets 子目录全部出现在 dist 侧。 */
function expectedAssetDirs() {
  const builtinSrc = path.join(repoRoot, 'packages/kernel/src/builtin-plugins');
  const expected = [];
  for (const ent of readdirSync(builtinSrc, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    for (const sub of ['client', 'skill', 'assets']) {
      if (existsSync(path.join(builtinSrc, ent.name, sub))) expected.push(`${ent.name}/${sub}`);
    }
  }
  return expected.sort();
}

test('payload 组装：补齐缺失构建产物后执行 build.mjs 成功', { timeout: 480_000 }, () => {
  // 缺啥补啥（已构建的 CI 流程零额外耗时）；构建命令显式超时，失败即带输出终止。
  if (!existsSync(path.join(repoRoot, 'packages/protocol/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helm/protocol', 'run', 'build'], repoRoot, 180_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/kernel/dist/main.js'))) {
    runCommand('pnpm', ['--filter', '@helm/kernel', 'run', 'build'], repoRoot, 240_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/web/dist/index.html'))) {
    runCommand('pnpm', ['--filter', '@helm/web', 'run', 'build'], repoRoot, 300_000);
  }
  if (!existsSync(path.join(repoRoot, 'packages/cli/dist/index.js'))) {
    runCommand('pnpm', ['--filter', '@helm/cli', 'run', 'build'], repoRoot, 120_000);
  }

  runCommand(process.execPath, [path.join(payloadPkgRoot, 'build.mjs')], repoRoot, 120_000);
  assert.ok(existsSync(path.join(stagingDir, 'manifest.json')), 'manifest.json 未生成');
});

test('payload manifest 契约：formatVersion/version/entries/checksum 全部成立', { timeout: 60_000 }, () => {
  const manifest: PayloadManifest = JSON.parse(readFileSync(path.join(stagingDir, 'manifest.json'), 'utf-8'));
  assert.equal(manifest.formatVersion, 1);
  const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf-8'));
  assert.equal(manifest.version, payloadPkg.version, 'manifest.version 必须与 @helm/payload 包版本一致');
  assert.equal(manifest.name, payloadPkg.name);
  assert.match(manifest.nodeEngines, /^>=/, 'nodeEngines 必须声明 engines 下限');

  const keys = Object.keys(manifest.entries).sort();
  assert.deepEqual(Object.keys(manifest.entryChecksums).sort(), keys, 'entryChecksums 与 entries 键一致');
  for (const [key, rel] of Object.entries(manifest.entries)) {
    const abs = path.join(stagingDir, rel);
    assert.ok(existsSync(abs), `entries.${key} 指向的文件不存在: ${rel}`);
    assert.equal(sha256Of(abs), manifest.entryChecksums[key], `entries.${key} checksum 不一致`);
  }
  assert.deepEqual(
    Object.keys(manifest.entries).sort(),
    ['cli', 'kernel', 'kernelPackageJson', 'launcher', 'webIndex'].sort(),
  );
});

test('payload 布局：kernel/web/cli dist 镜像、内置插件资产落位、web 同级探测命中、无 node_modules', { timeout: 60_000 }, () => {
  assertMirrored(path.join(repoRoot, 'packages/kernel/dist'), path.join(stagingDir, 'kernel/dist'));
  assertMirrored(path.join(repoRoot, 'packages/web/dist'), path.join(stagingDir, 'web/dist'));
  assertMirrored(path.join(repoRoot, 'packages/cli/dist'), path.join(stagingDir, 'cli/dist'));

  // 内置插件运行时资产落位 = 各解析器 dist 侧首选探测位
  //（workflow/profile/superagent/json-render/apps 等 resolveClientRoot / assets 解析）。
  for (const rel of expectedAssetDirs()) {
    assert.ok(
      existsSync(path.join(stagingDir, 'kernel/dist/builtin-plugins', rel)),
      `内置插件资产未落位: ${rel}`,
    );
  }
  // 覆盖当前内置插件的 client 目录（profile 无 client，只有 skill）。
  const clients = expectedAssetDirs().filter((rel) => rel.endsWith('/client'));
  assert.ok(clients.length >= 9, `内置插件 client 目录数量异常: ${clients.length}`);

  // hub.ts 默认 web dist 探测（hub.js 起 ../../../web/dist）必须命中组装内 web dist。
  const hubJs = path.join(stagingDir, 'kernel/dist/http/hub.js');
  assert.ok(existsSync(hubJs), 'kernel dist 缺 http/hub.js');
  const probed = path.resolve(path.dirname(hubJs), '../../../web/dist');
  assert.equal(probed, path.join(stagingDir, 'web/dist'), 'web dist 必须与 kernel 同级布局命中默认探测');
  assert.ok(existsSync(path.join(probed, 'index.html')), 'web dist 缺 index.html');

  // 诚实性：组装目录绝不携带 node_modules（自包含未解决，依赖状态由 start.mjs 显式报告）。
  const stagedFiles = walkFiles(stagingDir);
  assert.ok(
    stagedFiles.every((rel) => !rel.split('/').includes('node_modules')),
    'payload 组装目录不应包含 node_modules',
  );
});

test('start.mjs check：依赖缺失时显式退出码 3 并列出缺失清单', { timeout: 60_000 }, () => {
  // 仓库工作区内 payload dist 旁无 kernel 依赖（pnpm 不提升到根 node_modules），
  // check 必须诚实退出 3；剥离 NODE_PATH 保证判定不受宿主环境污染。
  const env = { ...process.env };
  delete env.NODE_PATH;
  const res = spawnSync(process.execPath, [path.join(stagingDir, 'start.mjs'), 'check'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 50_000,
  });
  assert.equal(res.status, 3, `期望退出码 3（依赖缺失），实际 ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stderr, /运行时依赖缺失/, '必须显式报告缺失依赖');
  assert.match(res.stderr, /node_modules/, '必须说明 node_modules 未携带');
  assert.match(res.stdout, /布局校验通过/, '布局校验本身应先通过');
});

test('start.mjs check：checksum 篡改时显式退出码 1', { timeout: 60_000 }, () => {
  const broken = path.join(tmpdir(), `helm-payload-broken-${process.pid}`);
  rmSync(broken, { recursive: true, force: true });
  cpSync(stagingDir, broken, { recursive: true });
  try {
    const manifestPath = path.join(broken, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.entryChecksums.kernel = '0'.repeat(64);
    // 重写后 manifest 仍合法可读，仅 checksum 被篡改
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const env = { ...process.env };
    delete env.NODE_PATH;
    const res = spawnSync(process.execPath, [path.join(broken, 'start.mjs'), 'check'], {
      cwd: broken,
      env,
      encoding: 'utf8',
      timeout: 50_000,
    });
    assert.equal(res.status, 1, `期望退出码 1（布局损坏），实际 ${res.status}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /checksum 不一致/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
  }
});

test('start.mjs start：依赖缺失时拒绝拉起 kernel（无 Helm Hub 输出）', { timeout: 60_000 }, () => {
  const env = { ...process.env };
  delete env.NODE_PATH;
  const res = spawnSync(process.execPath, [path.join(stagingDir, 'start.mjs'), 'start'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 50_000,
  });
  assert.equal(res.status, 3, `期望退出码 3（拒绝启动），实际 ${res.status}\nstderr: ${res.stderr}`);
  assert.doesNotMatch(res.stdout, /Helm Hub:/, '依赖缺失时不得出现 kernel 启动输出');
});

test('start.mjs 无参数：用法错误退出码 1', { timeout: 30_000 }, () => {
  const res = spawnSync(process.execPath, [path.join(stagingDir, 'start.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /用法/);
});
