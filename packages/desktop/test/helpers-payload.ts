/**
 * payload updater 测试共享工具：ustar 构造器（故意允许非法条目名以验证 containment）、
 * 契约同构的 fixture payload（start.mjs 模拟真实退出码 0/1/3）、假 npm registry
 * （真实 HTTP）、假依赖安装器。
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { NpmInstaller } from '../src/npm-installer.js';

export const FIXTURE_PACKAGE = 'helm-desktop-fixture-payload';
export const FIXTURE_DEP = 'fixture-kernel-dep';

// ---- tar 构造器 ----

export interface TarEntry {
  name: string;
  /** undefined = 目录条目。 */
  content?: Buffer | string;
  mode?: number;
}

/** 构造 ustar tarball（仅文件/目录；checksum/size 字段严格，可触发解包器校验路径）。 */
export function buildTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const headerFor = (name: string, size: number, typeflag: string, mode: number): Buffer => {
    const h = Buffer.alloc(512, 0);
    h.write(name.slice(0, 99), 0, 100, 'utf8');
    h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'utf8');
    h.write('0000000\0', 108, 8, 'utf8');
    h.write('0000000\0', 116, 8, 'utf8');
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    h.write('00000000000\0', 136, 12, 'utf8');
    h.write('        ', 148, 8, 'utf8');
    h.write(typeflag, 156, 1, 'utf8');
    h.write('ustar\0', 257, 6, 'utf8');
    h.write('00', 263, 2, 'utf8');
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    return h;
  };
  for (const entry of entries) {
    const content = entry.content;
    const isDir = content === undefined;
    const body = isDir
      ? Buffer.alloc(0)
      : Buffer.isBuffer(content)
        ? content
        : Buffer.from(content, 'utf8');
    blocks.push(headerFor(entry.name, body.length, isDir ? '5' : '0', entry.mode ?? (isDir ? 0o755 : 0o644)));
    if (!isDir) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad > 0) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ---- fixture payload（契约同构 @helm/payload：manifest + start.mjs + kernel） ----

export const FIXTURE_START_MJS = `#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[2] !== 'check') { console.error('用法: node start.mjs <check|start>'); process.exit(1); }
let manifest;
try { manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')); }
catch (error) { console.error('manifest 损坏:', error.message); process.exit(1); }
if (manifest.formatVersion !== 1) { console.error('formatVersion 非法'); process.exit(1); }
const problems = [];
for (const [key, rel] of Object.entries(manifest.entries ?? {})) {
  const abs = path.resolve(root, rel);
  if (!existsSync(abs)) { problems.push(key + ' 缺失'); continue; }
  const actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
  if (manifest.entryChecksums?.[key] !== actual) problems.push(key + ' checksum 不一致');
}
if (problems.length > 0) { console.error(problems.join('; ')); process.exit(1); }
let deps = {};
try { deps = JSON.parse(readFileSync(path.resolve(root, manifest.entries.kernelPackageJson), 'utf8')).dependencies ?? {}; }
catch { console.error('kernel package.json 损坏'); process.exit(1); }
const missing = Object.keys(deps).filter((d) => !existsSync(path.join(root, 'node_modules', d)));
if (missing.length > 0) { console.error('依赖缺失: ' + missing.join(', ')); process.exit(3); }
console.log('fixture payload ok');
process.exit(0);
`;

export type FixtureCorruption =
  | 'manifest-json'
  | 'format-version'
  | 'checksums'
  | 'entry-missing'
  | 'kernel-is-launcher';

export interface FixturePayloadOptions {
  version: string;
  /** kernel/package.json 声明的依赖名列表（默认 [FIXTURE_DEP]；空数组 = 无依赖）。 */
  deps?: string[];
  /** 预置 node_modules（vendored 场景）。 */
  vendoredDeps?: string[];
  corrupt?: FixtureCorruption;
  /** 额外 tar 条目（containment 攻击用，置于 package/ 之外或穿越路径）。 */
  extraEntries?: TarEntry[];
}

export function fixturePayloadEntries(options: FixturePayloadOptions): TarEntry[] {
  const { version } = options;
  const deps = options.deps ?? [FIXTURE_DEP];
  const kernelPkgJson = `${JSON.stringify(
    { name: 'fixture-kernel', version, dependencies: Object.fromEntries(deps.map((d) => [d, '*'])) },
    null,
    2,
  )}\n`;
  const kernelMain = `// fixture kernel entry (${version})\nconsole.log('fixture kernel ${version}');\n`;
  const entries: TarEntry[] = [
    { name: 'package/' },
    { name: 'package/kernel/' },
    { name: 'package/kernel/dist/' },
    { name: 'package/kernel/dist/main.js', content: kernelMain },
    { name: 'package/kernel/package.json', content: kernelPkgJson },
    { name: 'package/start.mjs', content: FIXTURE_START_MJS },
  ];
  for (const dep of options.vendoredDeps ?? []) {
    entries.push({ name: `package/node_modules/${dep}/` });
    entries.push({
      name: `package/node_modules/${dep}/package.json`,
      content: `${JSON.stringify({ name: dep, version: '1.0.0' })}\n`,
    });
  }
  const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifest: Record<string, unknown> = {
    formatVersion: 1,
    name: FIXTURE_PACKAGE,
    version,
    entries: { launcher: 'start.mjs', kernel: 'kernel/dist/main.js', kernelPackageJson: 'kernel/package.json' },
    entryChecksums: {
      launcher: checksum(FIXTURE_START_MJS),
      kernel: checksum(kernelMain),
      kernelPackageJson: checksum(kernelPkgJson),
    },
  };
  if (options.corrupt === 'format-version') manifest['formatVersion'] = 2;
  if (options.corrupt === 'kernel-is-launcher') (manifest['entries'] as Record<string, unknown>)['kernel'] = 'start.mjs';
  if (options.corrupt === 'checksums') (manifest['entryChecksums'] as Record<string, unknown>)['kernel'] = '0'.repeat(64);
  let manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.corrupt === 'manifest-json') manifestText = '{ broken json';
  entries.push({ name: 'package/manifest.json', content: manifestText });
  const finalEntries =
    options.corrupt === 'entry-missing'
      ? entries.filter((e) => e.name !== 'package/kernel/dist/main.js')
      : entries;
  return [...finalEntries, ...(options.extraEntries ?? [])];
}

export function buildFixtureTarball(options: FixturePayloadOptions): Buffer {
  return gzipSync(buildTar(fixturePayloadEntries(options)));
}

export function sha512Integrity(buf: Buffer): string {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`;
}

// ---- 假 npm registry（真实 HTTP 服务） ----

interface RegistryEntry {
  tarball: Buffer;
  integrity?: string;
}

export class FakeNpmRegistry {
  private readonly server: Server;
  url: string;
  private readonly versions = new Map<string, RegistryEntry>();
  private latest = '';
  private metadataDelayMs = 0;

  private constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req.url ?? '/', res);
    });
    this.url = '';
  }
  static async start(): Promise<FakeNpmRegistry> {
    const registry = new FakeNpmRegistry();
    await new Promise<void>((resolve, reject) => {
      registry.server.once('error', reject);
      registry.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = registry.server.address() as AddressInfo;
    registry.url = `http://127.0.0.1:${address.port}`;
    return registry;
  }

  /** 发布版本；默认同时移动 latest tag。 */
  publish(version: string, tarball: Buffer, options: { integrity?: string; asLatest?: boolean } = {}): void {
    this.versions.set(version, { tarball, integrity: options.integrity });
    if (options.asLatest !== false) this.latest = version;
  }

  setMetadataDelayMs(ms: number): void {
    this.metadataDelayMs = ms;
  }

  private async handle(rawUrl: string, res: ServerResponse): Promise<void> {
    const url = new URL(rawUrl, 'http://127.0.0.1');
    if (url.pathname === `/${encodeURIComponent(FIXTURE_PACKAGE)}`) {
      if (this.metadataDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.metadataDelayMs));
      const versions: Record<string, unknown> = {};
      for (const [version, entry] of this.versions) {
        versions[version] = {
          name: FIXTURE_PACKAGE,
          version,
          dist: {
            integrity: entry.integrity ?? sha512Integrity(entry.tarball),
            tarball: `${this.url}/${FIXTURE_PACKAGE}/-/${FIXTURE_PACKAGE}-${version}.tgz`,
          },
        };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: FIXTURE_PACKAGE, 'dist-tags': { latest: this.latest }, versions }));
      return;
    }
    const tgzMatch = url.pathname.match(new RegExp(`^/${FIXTURE_PACKAGE}/-/${FIXTURE_PACKAGE}-(.+)\\.tgz$`));
    if (tgzMatch !== null) {
      const entry = this.versions.get(decodeURIComponent(tgzMatch[1]!));
      if (entry === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(entry.tarball);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ---- 假依赖安装器 ----

export class FakeNpmInstaller implements NpmInstaller {
  readonly id = 'fake-npm';
  readonly calls: string[] = [];

  constructor(private readonly handler: (payloadRoot: string) => void | Promise<void> = defaultInstall) {}

  async install(payloadRoot: string): Promise<void> {
    this.calls.push(payloadRoot);
    await this.handler(payloadRoot);
  }
}

/** 默认行为：安装 FIXTURE_DEP 到 payload 根 node_modules（与真实 npm 语义同构）。 */
function defaultInstall(payloadRoot: string): void {
  const depDir = `${payloadRoot}/node_modules/${FIXTURE_DEP}`;
  mkdirSync(depDir, { recursive: true });
  writeFileSync(`${depDir}/package.json`, `${JSON.stringify({ name: FIXTURE_DEP, version: '1.0.0' })}\n`);
}
