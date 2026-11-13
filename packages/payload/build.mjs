#!/usr/bin/env node
/**
 * Hub npm payload 组装脚本：产出可直接 `npm pack` / `npm publish` 的独立包目录 dist/。
 *
 * 产物形态（dist/ 即发布包根，release 代理在 dist 内执行 npm pack/publish）：
 *   package.json     发布包清单（name 默认 @team4u/helm-hub，可由构建 env
 *                    HELM_PAYLOAD_PACKAGE 覆盖；manifest.name 与其同源）。dependencies
 *                    = kernel 生产依赖闭包的根集：外部依赖取仓库已安装 pnpm 实际版本
 *                    精确锁定，@helm/protocol 物化为 file:./protocol.tgz（同时携带其
 *                    dist/ 与 package.json）。消费侧（桌面 updater）解包 tgz 后执行
 *                    `npm install --omit=dev --ignore-scripts` 即可补齐依赖（esbuild
 *                    平台包按目标平台经 optionalDependencies 自动安装）。
 *   kernel/{package.json, dist/}   kernel tsc 产物 + 内置插件运行时资产
 *   protocol/{package.json, dist/} protocol 构建产物（file: 依赖本体）
 *   cli/{package.json, dist/}      CLI 产物（package.json 供定位/审计，运行时入口由
 *                                  桌面主代理经 HELM_CLI_ENTRY 指向 cli/dist/index.js）
 *   web/dist/                      Vite 产物（与 kernel 同级，命中 hub.ts 默认探测）
 *   start.mjs + manifest.json      零依赖启动入口与 version/entry/checksum 契约
 *
 * 诚实边界：本脚本仍不打包 node_modules（平台原生二进制决定自包含须按平台 vendoring，
 * 见 README）；依赖补齐契约是消费侧 npm install，start.mjs check 负责显式验收。
 */
import { createHash } from 'node:crypto';
import { create as createTar } from 'tar';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanPeerOverrides, resolveDepRealDir } from './src/dep-closure.mjs';

const payloadPkgRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(payloadPkgRoot, '../..');
const stagingDir = path.join(payloadPkgRoot, 'dist');

/** 发布载荷包名（updater 读取 resources/hub/package.json 的 name 作为更新包名）。 */
const payloadPackageName = process.env.HELM_PAYLOAD_PACKAGE ?? '@team4u/helm-hub';

/** 内置插件运行时资产子目录：kernel 各插件解析器统一先探测 dist 侧同名目录。 */
const RUNTIME_ASSET_SUBDIRS = ['client', 'skill', 'assets'];

const inputs = [
  ['kernel dist 入口', path.join(repoRoot, 'packages/kernel/dist/main.js')],
  ['kernel dist HTTP 层', path.join(repoRoot, 'packages/kernel/dist/http/hub.js')],
  ['protocol dist 入口', path.join(repoRoot, 'packages/protocol/dist/index.js')],
  ['web dist 入口', path.join(repoRoot, 'packages/web/dist/index.html')],
  ['cli dist 入口', path.join(repoRoot, 'packages/cli/dist/index.js')],
  ['kernel package.json', path.join(repoRoot, 'packages/kernel/package.json')],
  ['protocol package.json', path.join(repoRoot, 'packages/protocol/package.json')],
  ['kernel 内置插件资产源', path.join(repoRoot, 'packages/kernel/src/builtin-plugins')],
];

// 入口校验：一次性列全缺失项，绝不静默跳过（缺产物先跑仓库根 `pnpm build`）。
const missing = inputs.filter(([, p]) => !existsSync(p)).map(([label, p]) => `- ${label}: ${p}`);
if (missing.length > 0) {
  console.error(`[payload] 构建产物缺失，拒绝组装（请在仓库根执行 pnpm build 后重试）：\n${missing.join('\n')}`);
  process.exit(1);
}

const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 统计目录内文件数与总字节数（组装摘要用）。 */
function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  const visit = (cur) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) visit(p);
      else {
        files += 1;
        bytes += readFileSync(p).length;
      }
    }
  };
  visit(dir);
  return { files, bytes };
}

// --- 根依赖集：kernel ∪ protocol 生产依赖，协议包以归档安装，避免目录链接 -------
// 外部依赖版本取仓库已安装 pnpm 解析结果（node_modules 符号链接指向的真实包）的
// package.json 精确版本——绝不携带 ^/~ 浮动范围进发布契约（可复现安装）。
function resolveInstalledExactVersion(pkgDir, name) {
  const resolved = resolveDepRealDir(pkgDir, name, false);
  if (resolved.error) {
    console.error(`[payload] 依赖 ${name} 未安装或不可解析（${path.relative(repoRoot, pkgDir)}/node_modules/${name}）：${resolved.error}。请先在仓库根执行 pnpm install。`);
    process.exit(1);
  }
  const version = resolved.pkgJson.version;
  if (typeof version !== 'string' || version.length === 0) {
    console.error(`[payload] 依赖 ${name} 的 package.json 缺 version`);
    process.exit(1);
  }
  return version;
}

const kernelPkgJsonPath = path.join(repoRoot, 'packages/kernel/package.json');
const protocolPkgJsonPath = path.join(repoRoot, 'packages/protocol/package.json');
const kernelDeps = Object.keys(JSON.parse(readFileSync(kernelPkgJsonPath, 'utf-8')).dependencies ?? {});
const protocolDeps = Object.keys(JSON.parse(readFileSync(protocolPkgJsonPath, 'utf-8')).dependencies ?? {});
const externalDeps = [...new Set([...kernelDeps, ...protocolDeps])].filter((name) => name !== '@helm/protocol').sort();
const rootDependencies = Object.fromEntries(
  externalDeps.map((name) => {
    const pkgDir = kernelDeps.includes(name)
      ? path.join(repoRoot, 'packages/kernel')
      : path.join(repoRoot, 'packages/protocol');
    return [name, resolveInstalledExactVersion(pkgDir, name)];
  }),
);
rootDependencies['@helm/protocol'] = 'file:./protocol.tgz';

// npm 默认严格 peer 解析（ERESOLVE），而仓库 pnpm 安装允许 peer 版本宽于声明
//（如 chord 钉 peer ws@8.21.0 而仓库锁定 8.22.1）。扫描已安装闭包生成 overrides，
// 把根持有的冲突名统一到根精确版本——消费侧裸 `npm install --omit=dev
// --ignore-scripts` 开箱可用，不要求 updater 附加 flag（.npmrc 无法随 tarball
// 分发，npm 永久把它排除在包外）。
const peerOverrides = scanPeerOverrides(
  externalDeps.map((name) => ({
    name,
    version: rootDependencies[name],
    fromPkgDir: kernelDeps.includes(name)
      ? path.join(repoRoot, 'packages/kernel')
      : path.join(repoRoot, 'packages/protocol'),
  })),
);

const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
const payloadPkg = JSON.parse(readFileSync(path.join(payloadPkgRoot, 'package.json'), 'utf-8'));
const distPackageJson = {
  name: payloadPackageName,
  version: payloadPkg.version,
  type: 'module',
  description: 'helm Hub 运行时载荷（kernel + protocol + cli + web dist 与零依赖启动入口）',
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/team4u/helm.git', directory: 'packages/payload' },
  publishConfig: { access: 'public' },
  engines: { node: rootPkg.engines?.node ?? '>=24.12.0' },
  files: ['kernel', 'protocol', 'protocol.tgz', 'cli', 'web', 'start.mjs', 'manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  dependencies: Object.fromEntries(Object.keys(rootDependencies).sort().map((k) => [k, rootDependencies[k]])),
  ...(peerOverrides.size > 0
    ? { overrides: Object.fromEntries([...peerOverrides.entries()].sort(([a], [b]) => a.localeCompare(b))) }
    : {}),
};

// --- 组装（先清空重建，产物可重入） --------------------------------------------------
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

cpSync(path.join(repoRoot, 'packages/kernel/dist'), path.join(stagingDir, 'kernel/dist'), { recursive: true });
cpSync(kernelPkgJsonPath, path.join(stagingDir, 'kernel/package.json'));
cpSync(path.join(repoRoot, 'packages/protocol/dist'), path.join(stagingDir, 'protocol/dist'), { recursive: true });
cpSync(protocolPkgJsonPath, path.join(stagingDir, 'protocol/package.json'));
cpSync(path.join(repoRoot, 'packages/cli/dist'), path.join(stagingDir, 'cli/dist'), { recursive: true });
cpSync(path.join(repoRoot, 'packages/cli/package.json'), path.join(stagingDir, 'cli/package.json'));
cpSync(path.join(repoRoot, 'packages/web/dist'), path.join(stagingDir, 'web/dist'), { recursive: true });
cpSync(path.join(payloadPkgRoot, 'src/start.mjs'), path.join(stagingDir, 'start.mjs'));
cpSync(path.join(repoRoot, 'LICENSE'), path.join(stagingDir, 'LICENSE'));
cpSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), path.join(stagingDir, 'THIRD_PARTY_NOTICES.md'));
// 运行时报告载荷发布版本，避免 Hub / CLI 仍报工作区旧版本。
for (const component of ['kernel', 'protocol', 'cli']) {
  const manifestPath = path.join(stagingDir, component, 'package.json');
  const componentPackage = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, `${JSON.stringify({ ...componentPackage, version: payloadPkg.version }, null, 2)}\n`);
}
// 目录形式的 file: 依赖在 Windows 会生成指向 staging 的 junction；归档安装可安全搬移。
await createTar({ cwd: path.join(stagingDir, 'protocol'), file: path.join(stagingDir, 'protocol.tgz'), gzip: true, portable: true, prefix: 'package' }, ['package.json', 'dist']);
writeFileSync(path.join(stagingDir, 'package.json'), `${JSON.stringify(distPackageJson, null, 2)}\n`);

// 内置插件运行时资产：src/builtin-plugins/<name>/{client,skill,assets}
// → dist/kernel/dist/builtin-plugins/<name>/{...}（各插件解析器的首选探测位）。
const builtinSrc = path.join(repoRoot, 'packages/kernel/src/builtin-plugins');
const copiedAssets = [];
for (const ent of readdirSync(builtinSrc, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!ent.isDirectory()) continue;
  for (const sub of RUNTIME_ASSET_SUBDIRS) {
    const from = path.join(builtinSrc, ent.name, sub);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(stagingDir, 'kernel/dist/builtin-plugins', ent.name, sub), { recursive: true });
    copiedAssets.push(`builtin-plugins/${ent.name}/${sub}`);
  }
}

// --- manifest（version / entry / checksum 契约；路径相对 payload 根，POSIX 分隔） ----
const entries = {
  launcher: 'start.mjs',
  rootPackageJson: 'package.json',
  kernel: 'kernel/dist/main.js',
  kernelPackageJson: 'kernel/package.json',
  protocol: 'protocol/dist/index.js',
  protocolArchive: 'protocol.tgz',
  protocolPackageJson: 'protocol/package.json',
  cli: 'cli/dist/index.js',
  cliPackageJson: 'cli/package.json',
  webIndex: 'web/dist/index.html',
};
const manifest = {
  formatVersion: 1,
  name: distPackageJson.name,
  version: distPackageJson.version,
  builtAt: new Date().toISOString(),
  nodeEngines: distPackageJson.engines.node,
  entries,
  entryChecksums: Object.fromEntries(
    Object.entries(entries).map(([key, rel]) => [key, sha256Of(path.join(stagingDir, rel))]),
  ),
};
writeFileSync(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const stats = walkStats(stagingDir);
console.log(`[payload] 组装完成: ${stagingDir}`);
console.log(`[payload] 发布包名: ${distPackageJson.name}@${distPackageJson.version}（HELM_PAYLOAD_PACKAGE 可覆盖）`);
console.log(`[payload] 根依赖 ${Object.keys(rootDependencies).length} 项（外部精确版本 ${externalDeps.length} + @helm/protocol file:./protocol.tgz）`);
console.log(`[payload] 文件 ${stats.files} 个，共 ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB`);
console.log(`[payload] 运行时资产目录 ${copiedAssets.length} 个: ${copiedAssets.join(', ')}`);
console.log('[payload] 注意: 未打包 node_modules；消费侧 tgz 解包后 npm install --omit=dev --ignore-scripts 补依赖（start.mjs check 验收）');
