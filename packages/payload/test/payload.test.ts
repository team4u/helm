/**
 * @helm/payload 集成测试：真实执行组装脚本、npm pack、隔离 npm install 与启动入口。
 *
 * 覆盖：
 * 1. 组装：缺产物自动补构建（显式超时），assemble 后目录/manifest/checksum 契约成立；
 * 2. 发布包契约：dist 根 package.json（@team4u/helm-hub 默认名，HELM_PAYLOAD_PACKAGE
 *    可覆盖）为可 npm pack/publish 的独立包：files 显式白名单 + 外部依赖精确版本 +
 *    @helm/protocol file:./protocol；manifest.name 与其同源；
 * 3. 布局：kernel/protocol/cli/web dist 镜像、内置插件资产落位、web 同级探测命中、
 *    不携带 node_modules；
 * 4. 负路径：依赖缺失退出码 3；checksum 篡改退出码 1；manifest 路径越界退出码 1；
 *    start 依赖缺失时拒绝拉起 kernel；
 * 5. 正路径（真实端到端，仓库外隔离目录）：npm pack dist → 安全解包（校验全部成员
 *    位于 package/ 前缀、manifest 在包根而非 dist/ 子目录）→ npm install
 *    --omit=dev --ignore-scripts → start.mjs check（依赖解析 + node:sqlite +
 *    esbuild 实测）→ start.mjs start 真实拉起 Hub 并 HTTP 探活 /api/auth/status →
 *    SIGTERM 干净退出。绝不只验 fixture。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

function runCommand(command: string, args: string[], cwd: string, timeoutMs: number, extraEnv: Record<string, string> = {}) {
  const res = spawnSync(command, args, { cwd, timeout: timeoutMs, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
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

test('payload 发布包契约：dist 根 package.json 可独立 npm pack/publish', { timeout: 60_000 }, () => {
  const distPkg = JSON.parse(readFileSync(path.join(stagingDir, 'package.json'), 'utf-8'));
  assert.equal(distPkg.name, '@team4u/helm-hub', '默认发布包名必须是 @team4u/helm-hub');
  assert.equal(distPkg.type, 'module');
  assert.equal(distPkg.private, undefined, '发布包不得标记 private');
  // files 显式白名单：根 gitignore 的 dist/ 规则不得让 npm pack 剔除 kernel/dist 等。
  assert.deepEqual(
    (distPkg.files as string[]).slice().sort(),
    ['cli', 'kernel', 'manifest.json', 'protocol', 'start.mjs', 'web'],
  );
  // @helm/protocol 物化为 file:./protocol；外部依赖全部精确版本（无 ^/~/>= 浮动）。
  assert.equal(distPkg.dependencies['@helm/protocol'], 'file:./protocol');
  const kernelDeps = JSON.parse(readFileSync(path.join(repoRoot, 'packages/kernel/package.json'), 'utf-8')).dependencies;
  for (const [name, spec] of Object.entries<string>(distPkg.dependencies)) {
    if (name === '@helm/protocol') continue;
    assert.ok(kernelDeps[name] !== undefined || name === 'ajv', `根依赖 ${name} 不在 kernel/protocol 生产依赖闭包内`);
    assert.match(spec, /^\d/, `外部依赖 ${name} 必须是精确版本，实际 ${spec}`);
    // 与仓库已安装版本一致（可复现安装；经 pnpm 符号链接取真实包，兼容 peer 后缀目录）。
    const fromDir = kernelDeps[name] !== undefined
      ? path.join(repoRoot, 'packages/kernel')
      : path.join(repoRoot, 'packages/protocol');
    const realPkgJson = JSON.parse(
      readFileSync(path.join(realpathSync(path.join(fromDir, 'node_modules', name)), 'package.json'), 'utf-8'),
    );
    assert.equal(realPkgJson.version, spec, `${name} 仓库安装版本与 dist 契约不一致`);
  }
  // workspace 构建器仍是 private，发布名只在 dist 生效。
  const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf-8'));
  assert.equal(payloadPkg.private, true);
});

test('payload manifest 契约：formatVersion/version/entries/checksum 全部成立', { timeout: 60_000 }, () => {
  const manifest: PayloadManifest = JSON.parse(readFileSync(path.join(stagingDir, 'manifest.json'), 'utf-8'));
  assert.equal(manifest.formatVersion, 1);
  const distPkg = JSON.parse(readFileSync(path.join(stagingDir, 'package.json'), 'utf-8'));
  assert.equal(manifest.version, distPkg.version, 'manifest.version 必须与 dist 根 package.json 一致');
  assert.equal(manifest.name, distPkg.name, 'manifest.name 必须与 dist 根 package.json 同源');
  assert.match(manifest.nodeEngines, /^>=/, 'nodeEngines 必须声明 engines 下限');

  const keys = Object.keys(manifest.entries).sort();
  assert.deepEqual(Object.keys(manifest.entryChecksums).sort(), keys, 'entryChecksums 与 entries 键一致');
  for (const [key, rel] of Object.entries(manifest.entries)) {
    const abs = path.join(stagingDir, rel);
    assert.ok(existsSync(abs), `entries.${key} 指向的文件不存在: ${rel}`);
    assert.equal(sha256Of(abs), manifest.entryChecksums[key], `entries.${key} checksum 不一致`);
  }
  assert.deepEqual(
    keys,
    [
      'cli', 'cliPackageJson', 'kernel', 'kernelPackageJson', 'launcher', 'protocol',
      'protocolPackageJson', 'rootPackageJson', 'webIndex',
    ].sort(),
  );
});

test('payload 布局：kernel/protocol/cli/web dist 镜像、资产落位、web 同级探测命中、无 node_modules', { timeout: 60_000 }, () => {
  assertMirrored(path.join(repoRoot, 'packages/kernel/dist'), path.join(stagingDir, 'kernel/dist'));
  assertMirrored(path.join(repoRoot, 'packages/protocol/dist'), path.join(stagingDir, 'protocol/dist'));
  assertMirrored(path.join(repoRoot, 'packages/cli/dist'), path.join(stagingDir, 'cli/dist'));
  assertMirrored(path.join(repoRoot, 'packages/web/dist'), path.join(stagingDir, 'web/dist'));

  for (const rel of expectedAssetDirs()) {
    assert.ok(
      existsSync(path.join(stagingDir, 'kernel/dist/builtin-plugins', rel)),
      `内置插件资产未落位: ${rel}`,
    );
  }
  const clients = expectedAssetDirs().filter((rel) => rel.endsWith('/client'));
  assert.ok(clients.length >= 9, `内置插件 client 目录数量异常: ${clients.length}`);

  const hubJs = path.join(stagingDir, 'kernel/dist/http/hub.js');
  assert.ok(existsSync(hubJs), 'kernel dist 缺 http/hub.js');
  const probed = path.resolve(path.dirname(hubJs), '../../../web/dist');
  assert.equal(probed, path.join(stagingDir, 'web/dist'), 'web dist 必须与 kernel 同级布局命中默认探测');
  assert.ok(existsSync(path.join(probed, 'index.html')), 'web dist 缺 index.html');

  // 诚实性：组装目录绝不携带 node_modules（依赖补齐契约是消费侧 npm install）。
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
  assert.match(res.stderr, /npm install/, '必须指引 npm install 补依赖');
  assert.match(res.stdout, /布局校验通过/, '布局校验本身应先通过');
});

test('start.mjs check：checksum 篡改 / manifest 路径越界时显式退出码 1', { timeout: 60_000 }, () => {
  const broken = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-payload-broken-'));
  cpSync(stagingDir, broken, { recursive: true });
  try {
    const env = { ...process.env };
    delete env.NODE_PATH;
    const manifestPath = path.join(broken, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.entryChecksums.kernel = '0'.repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const res = spawnSync(process.execPath, [path.join(broken, 'start.mjs'), 'check'], {
      cwd: broken, env, encoding: 'utf8', timeout: 50_000,
    });
    assert.equal(res.status, 1, `期望退出码 1（布局损坏），实际 ${res.status}\nstderr: ${res.stderr}`);
    assert.match(res.stderr, /checksum 不一致/);

    // 路径契约：绝对路径 / .. 越界必须被拒（严校验含路径，防 manifest 注入）。
    const evil = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    evil.entryChecksums.kernel = manifest.entryChecksums.kernel;
    evil.entries.kernel = '../../../etc/passwd';
    writeFileSync(manifestPath, `${JSON.stringify(evil, null, 2)}\n`);
    const res2 = spawnSync(process.execPath, [path.join(broken, 'start.mjs'), 'check'], {
      cwd: broken, env, encoding: 'utf8', timeout: 50_000,
    });
    assert.equal(res2.status, 1, `期望退出码 1（路径越界），实际 ${res2.status}\nstderr: ${res2.stderr}`);
    assert.match(res2.stderr, /路径契约失败|越出 payload 根/);
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

/**
 * 正路径端到端（真实安装与启动，不做 fixture 级替代）：
 * npm pack dist → 安全解包到仓库外 → npm install --omit=dev --ignore-scripts →
 * check 通过（依赖解析 + node:sqlite + esbuild transform 实测）→ start 真实拉起
 * Hub，HTTP 探活 /api/auth/status，SIGTERM 干净退出。
 */
test('端到端：npm pack → 隔离 npm install → check → start 真实启动 Hub（仓库外）', { timeout: 480_000 }, async () => {
  const outsideRoot = mkdtempSync(path.join(path.dirname(repoRoot), 'helm-payload-e2e-'));
  const packDir = path.join(outsideRoot, 'pack');
  const extractDir = path.join(outsideRoot, 'extracted');
  try {
    mkdirSyncRecursive(packDir);
    mkdirSyncRecursive(extractDir);

    // 1. npm pack（在 dist 内执行；--pack-destination 避免污染 dist 目录）。
    const packRes = runCommand('npm', ['pack', '--json', '--pack-destination', packDir], stagingDir, 120_000);
    const packInfo = JSON.parse(packRes.stdout) as Array<{ filename: string }>;
    assert.equal(packInfo.length, 1, `期望单个 tarball: ${packRes.stdout}`);
    const tgz = path.join(packDir, packInfo[0].filename);
    assert.ok(existsSync(tgz));

    // 2. 安全解包：全部成员必须位于 package/ 前缀且无 .. 段，manifest 在包根。
    const list = runCommand('tar', ['-tzf', tgz], outsideRoot, 30_000).stdout.split('\n').filter(Boolean);
    assert.ok(list.length > 10, `tarball 成员过少: ${list.length}`);
    for (const member of list) {
      assert.ok(member.startsWith('package/'), `tarball 成员逃逸 package/ 前缀: ${member}`);
      assert.ok(!member.split('/').includes('..'), `tarball 成员含 ..: ${member}`);
    }
    for (const must of ['package/manifest.json', 'package/start.mjs', 'package/package.json', 'package/kernel/dist/main.js', 'package/protocol/dist/index.js', 'package/cli/dist/index.js', 'package/web/dist/index.html']) {
      assert.ok(list.includes(must), `tarball 缺 ${must}（manifest/start 必须在包根而非 dist/ 子目录）`);
    }
    runCommand('tar', ['-xzf', tgz, '-C', extractDir, '--strip-components=1'], outsideRoot, 60_000);

    // 3. 消费侧依赖补齐（updater 契约：--omit=dev --ignore-scripts）。
    runCommand('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], extractDir, 300_000);
    assert.ok(existsSync(path.join(extractDir, 'node_modules', '@helm', 'protocol', 'dist', 'index.js')), 'file:./protocol 未安装');

    // 4. check：三入口依赖解析 + node:sqlite + esbuild 实测，退出码 0。
    const env = { ...process.env };
    delete env.NODE_PATH;
    const check = spawnSync(process.execPath, [path.join(extractDir, 'start.mjs'), 'check'], {
      cwd: extractDir, env, encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(check.status, 0, `check 期望 0，实际 ${check.status}\nstdout: ${check.stdout}\nstderr: ${check.stderr}`);
    assert.match(check.stdout, /三入口/);
    assert.match(check.stdout, /node:sqlite \+ esbuild transform/);

    // 5. start：真实拉起 Hub，探活公开端点 /api/auth/status，SIGTERM 干净退出。
    const dataDir = path.join(outsideRoot, 'data');
    mkdirSyncRecursive(dataDir);
    const port = 33500 + (process.pid % 1500);
    const child = spawn(process.execPath, [path.join(extractDir, 'start.mjs'), 'start'], {
      cwd: extractDir,
      env: { ...env, HELM_PORT: String(port), HELM_HOST: '127.0.0.1', HELM_DATA_DIR: dataDir, HELM_CWD: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const exitPromise = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    let probed = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const probe = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}/api/auth/status').then(r=>r.json()).then(j=>{if(typeof j!=='object'||j===null)throw new Error('bad');process.exit(0)}).catch(()=>process.exit(1))`], { timeout: 5_000, encoding: 'utf8' });
      if (probe.status === 0) {
        probed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(probed, `Hub 未在 60s 内探活成功\nstdout: ${stdout}\nstderr: ${stderr}`);
    assert.match(stdout, /Helm Hub:/, 'Hub 启动横幅缺失');
    child.kill('SIGTERM');
    const exitInfo = await Promise.race([
      exitPromise,
      new Promise<{ code: null, signal: null }>((r) => setTimeout(() => r({ code: null, signal: null }), 15_000)),
    ]);
    if (exitInfo.code === null && exitInfo.signal === null) child.kill('SIGKILL');
    assert.equal(exitInfo.code, 0, `Hub SIGTERM 后期望干净退出 0，实际 ${exitInfo.code} ${exitInfo.signal ?? ''}\nstdout: ${stdout}\nstderr: ${stderr}`);
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

function mkdirSyncRecursive(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
