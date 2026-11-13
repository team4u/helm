/**
 * npm payload 更新器（真实实现，替换骨架 Stub）。
 *
 * 路线（与 packages/payload/README.md 一致，不宣称解决 npm 自包含）：
 * 1. 从公开 npm registry 读取包元数据（dist-tags.latest 或锁定的精确版本）；
 * 2. 边界校验 name / version / dist.integrity（必须 sha512，base64 解码 64 字节）；
 * 3. 下载 tgz 到 <payloadRoot>/staging 临时区，流式落盘时校验 sha512 完整性；
 * 4. 解包（payload-tar.ts containment 强校验）到 staging/extract，经 manifest 契约
 *    校验后以 `start.mjs check` 验收；exit 3（依赖缺失）时经可注入 NpmInstaller 在
 *    payload 根目录安装生产依赖后复检；
 * 5. 验收通过后原子换名到 releases/<name>/<version>/ 不可变目录，原子写 current.json；
 *    安装失败按「制品缺陷」类错误码记录 blocked.json，当前版本绝不破坏。
 *
 * 生命周期边界：updater 只管理制品——不重启 Hub、不感知会话、不调用 Hub API。换装由
 * 桌面壳在 supervisor.stop() 之后、下一次 start() 时经 resolveCurrent() 选择新入口
 * （见 main.ts）；并发安装由文件锁串行（payload-lock.ts）。
 *
 * 启动参数契约：payload 的 start.mjs 是「带命令参数的启动器」（check|start），不是
 * Hub 入口。本更新器把 manifest.entries.kernel 解析出的 kernel 入口作为 entryPath
 * 返回（entryArgs 恒空），manifest 校验显式拒绝 entries.kernel 指向 launcher 的声明，
 * 绝不把 start.mjs 当普通 Hub 入口直接启动。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, openSync, closeSync, writeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DesktopError } from './errors.js';
import type { DesktopConfig } from './config.js';
import { KERNEL_NODE_FLOOR, probeMeetsFloor, probeRunner } from './runners.js';
import { extractTarGzip } from './payload-tar.js';
import { PayloadFileLock } from './payload-lock.js';
import { readJsonState, writeJsonAtomic } from './payload-json.js';
import { HostNpmInstaller, type NpmInstaller } from './npm-installer.js';

// ---- 公共契约 ----

export interface PayloadInfo {
  readonly name: string;
  readonly version: string;
  /** release 根目录（绝对路径）；安装完成后才存在。 */
  readonly releaseDir?: string;
  /** Hub 入口（绝对路径，来自 payload manifest entries.kernel；非 start.mjs）。 */
  readonly entryPath?: string;
  /** spawn 附加参数（契约上恒空：kernel 入口直接启动）。 */
  readonly entryArgs?: readonly string[];
}

export type PayloadUpdateReason = 'updater_not_configured' | 'up_to_date' | 'latest_blocked';

export interface PayloadUpdateStatus {
  updateAvailable: boolean;
  current: PayloadInfo | null;
  /** registry 侧最新（或锁定）版本；entryPath 安装后才已知。 */
  latest: PayloadInfo | null;
  /** updateAvailable=false 时的原因；true 时省略（current 为 null 即首次安装）。 */
  reason?: PayloadUpdateReason;
  /** reason=latest_blocked 时的失败摘要。 */
  blocked?: { code: string; message: string; at: string };
}

export interface PayloadInstallTarget {
  name: string;
  /** 语义版本号，或 'latest'（跟踪 dist-tags）。 */
  version: string;
}

export interface PayloadUpdater {
  readonly id: string;
  check(): Promise<PayloadUpdateStatus>;
  downloadAndInstall(target: PayloadInstallTarget): Promise<PayloadInfo>;
  resolveCurrent(): PayloadInfo | null;
}

// ---- 状态文件形状 ----

interface CurrentState {
  formatVersion: 1;
  name: string;
  version: string;
  releaseDir: string;
  entryPath: string;
  entryArgs: string[];
  installedAt: string;
}

interface BlockedEntry {
  name: string;
  version: string;
  code: string;
  message: string;
  at: string;
  stderrTail?: string[];
}

interface BlockedState {
  formatVersion: 1;
  entries: Record<string, BlockedEntry>;
}

const BLOCKED_MAX_ENTRIES = 100;

/** 「制品缺陷」类错误码：重试无意义，记入 blocked.json 阻断该版本。 */
const ARTIFACT_FAULT_CODES = new Set([
  'payload_manifest_invalid',
  'payload_check_failed',
  'tarball_integrity_mismatch',
  'tar_entry_escape',
  'tar_entry_invalid',
  'tar_entry_prefix',
  'tar_entry_limit',
  'tar_size_limit',
  'tar_unsupported_type',
  'tar_header_invalid',
  'tar_truncated',
  'tar_extract_failed',
  'tar_link_escape',
]);

/** 版本号必须路径安全（semver 及 prerelease/build 字符集，禁分隔符）。 */
const SAFE_VERSION_RE = /^[a-zA-Z0-9.+~-]+$/;

interface RegistryVersion {
  name: string;
  version: string;
  integrity: string;
  tarball: string;
}

interface CheckRunResult {
  code: number;
  stdoutTail: string[];
  stderrTail: string[];
}

// ---- 真实更新器 ----

export interface NpmPayloadUpdaterOptions {
  /** npm 包名（必填，可含 scope；不硬编码任何 @helm 名称）。 */
  packageName: string;
  /** registry base URL（缺省公开 npm registry）。 */
  registry?: string;
  /** 锁定精确版本；缺省跟踪 dist-tags.latest。 */
  pinnedVersion?: string;
  /** payload 管理根目录（<dataDir>/payload）。 */
  payloadRoot: string;
  fetchImpl?: typeof fetch;
  /** 依赖安装器；不提供则依赖缺失时显式报错（不静默跳过）。 */
  npmInstaller?: NpmInstaller;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  isElectron?: boolean;
  stderrTailLines?: number;
  metadataTimeoutMs?: number;
  downloadTimeoutMs?: number;
  checkTimeoutMs?: number;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  maxTarballBytes?: number;
  maxExtractedBytes?: number;
  maxExtractEntries?: number;
}

export class NpmPayloadUpdater implements PayloadUpdater {
  readonly id: string;
  private readonly packageName: string;
  private readonly registry: string;
  private readonly pinnedVersion?: string;
  private readonly payloadRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly npmInstaller?: NpmInstaller;
  private readonly env: NodeJS.ProcessEnv;
  private readonly execPath: string;
  private readonly isElectron: boolean;
  private readonly tailLines: number;
  private readonly metadataTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly checkTimeoutMs: number;
  private readonly maxTarballBytes: number;
  private readonly maxExtractedBytes: number;
  private readonly maxExtractEntries: number;
  private readonly lock: PayloadFileLock;
  private checkNode: { executable: string; env: NodeJS.ProcessEnv } | null = null;

  constructor(options: NpmPayloadUpdaterOptions) {
    this.packageName = options.packageName;
    this.registry = (options.registry ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
    this.pinnedVersion = options.pinnedVersion;
    this.payloadRoot = options.payloadRoot;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.npmInstaller = options.npmInstaller;
    this.env = options.env ?? process.env;
    this.execPath = options.execPath ?? process.execPath;
    this.isElectron = options.isElectron ?? process.versions.electron !== undefined;
    this.tailLines = options.stderrTailLines ?? 40;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 30_000;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 300_000;
    this.checkTimeoutMs = options.checkTimeoutMs ?? 120_000;
    this.maxTarballBytes = options.maxTarballBytes ?? 512 * 1024 * 1024;
    this.maxExtractedBytes = options.maxExtractedBytes ?? 1024 * 1024 * 1024;
    this.maxExtractEntries = options.maxExtractEntries ?? 200_000;
    this.lock = new PayloadFileLock(path.join(this.payloadRoot, '.lock'), {
      acquireTimeoutMs: options.lockTimeoutMs,
      staleMs: options.lockStaleMs,
    });
    this.id = `npm:${this.packageName}@${this.registry}`;
  }

  // ---- check ----

  async check(): Promise<PayloadUpdateStatus> {
    const current = this.resolveCurrent();
    const meta = await this.fetchRegistryVersion(this.pinnedVersion ?? 'latest');
    const latest: PayloadInfo = { name: meta.name, version: meta.version };
    if (current !== null && current.name === meta.name && current.version === meta.version) {
      return { updateAvailable: false, current, latest, reason: 'up_to_date' };
    }
    const blockedEntry = this.readBlocked().entries[`${meta.name}@${meta.version}`];
    if (blockedEntry !== undefined) {
      return {
        updateAvailable: false,
        current,
        latest,
        reason: 'latest_blocked',
        blocked: { code: blockedEntry.code, message: blockedEntry.message, at: blockedEntry.at },
      };
    }
    return { updateAvailable: true, current, latest };
  }

  // ---- downloadAndInstall ----

  async downloadAndInstall(target: PayloadInstallTarget): Promise<PayloadInfo> {
    if (target.name !== this.packageName) {
      throw new DesktopError(
        'updater_target_mismatch',
        `安装目标 ${target.name} 与配置的 payload 包 ${this.packageName} 不一致`,
      );
    }
    const versionSpec = target.version.length > 0 ? target.version : 'latest';
    return await this.lock.run(async () => this.installLocked(versionSpec));
  }

  private async installLocked(versionSpec: string): Promise<PayloadInfo> {
    const stagingRoot = path.join(this.payloadRoot, 'staging');
    // 持锁清理崩溃遗留的 staging（上一进程未及清理的全部内容）。
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(stagingRoot, { recursive: true });
    let meta: RegistryVersion | null = null;
    try {
      meta = await this.fetchRegistryVersion(versionSpec);
      const blockedKey = `${meta.name}@${meta.version}`;
      const blockedEntry = this.readBlocked().entries[blockedKey];
      if (blockedEntry !== undefined) {
        throw new DesktopError(
          'updater_version_blocked',
          `${blockedKey} 此前安装失败已被标记阻断（${blockedEntry.code}: ${blockedEntry.message}）`,
          { blocked: blockedEntry },
        );
      }
      // 幂等快路径：目标版本即当前版本且制品完好 → 不重复下载。
      const current = this.resolveCurrent();
      if (current !== null && current.version === meta.version && current.name === meta.name) {
        return current;
      }

      const tgzPath = path.join(stagingRoot, 'payload.tgz');
      await this.downloadTarball(meta, tgzPath);
      const extractDir = path.join(stagingRoot, 'extract');
      await extractTarGzip(tgzPath, extractDir, {
        maxEntries: this.maxExtractEntries,
        maxTotalBytes: this.maxExtractedBytes,
      });
      rmSync(tgzPath, { force: true });

      const { kernelEntryPath, launcherPath } = this.loadPayloadManifest(extractDir);
      await this.verifyWithInstaller(extractDir, launcherPath);
      const info = this.promote(extractDir, meta, kernelEntryPath);
      this.unblockVersion(meta.version);
      return info;
    } catch (error) {
      if (meta !== null && error instanceof DesktopError) {
        this.recordBlockedIfArtifactFault(meta, error);
      }
      throw error;
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  // ---- resolveCurrent ----

  resolveCurrent(): PayloadInfo | null {
    const raw = readJsonState(this.currentFile, 'current.json');
    if (raw === undefined) return null;
    const problems: string[] = [];
    const c = raw as Partial<CurrentState>;
    if (c.formatVersion !== 1) problems.push(`formatVersion 必须为 1，实际 ${JSON.stringify(c.formatVersion)}`);
    if (typeof c.name !== 'string' || c.name.length === 0) problems.push('name 缺失');
    if (typeof c.version !== 'string' || c.version.length === 0) problems.push('version 缺失');
    if (typeof c.releaseDir !== 'string' || !path.isAbsolute(c.releaseDir)) problems.push('releaseDir 缺失或非绝对路径');
    if (typeof c.entryPath !== 'string' || !path.isAbsolute(c.entryPath)) problems.push('entryPath 缺失或非绝对路径');
    if (c.entryArgs !== undefined && (!Array.isArray(c.entryArgs) || c.entryArgs.some((a) => typeof a !== 'string'))) {
      problems.push('entryArgs 必须是字符串数组');
    }
    if (typeof c.releaseDir === 'string' && path.isAbsolute(c.releaseDir)) {
      const containment = path.relative(this.payloadRoot, c.releaseDir);
      if (containment.startsWith('..') || path.isAbsolute(containment)) problems.push('releaseDir 逃逸 payload 管理目录');
      else {
        if (!existsSync(c.releaseDir) || !statSync(c.releaseDir).isDirectory()) problems.push(`releaseDir 不存在: ${c.releaseDir}`);
        if (typeof c.entryPath === 'string' && path.isAbsolute(c.entryPath)) {
          const entryContainment = path.relative(c.releaseDir, c.entryPath);
          if (entryContainment.startsWith('..') || path.isAbsolute(entryContainment)) {
            problems.push('entryPath 逃逸 releaseDir');
          } else if (!existsSync(c.entryPath)) {
            problems.push(`entryPath 不存在: ${c.entryPath}`);
          }
        }
      }
    }
    if (problems.length > 0) {
      throw new DesktopError('current_payload_invalid', '已安装 payload 状态不满足契约（current.json）', {
        currentFile: this.currentFile,
        problems,
      });
    }
    return {
      name: c.name!,
      version: c.version!,
      releaseDir: c.releaseDir,
      entryPath: c.entryPath,
      entryArgs: c.entryArgs ?? [],
    };
  }

  private get currentFile(): string {
    return path.join(this.payloadRoot, 'current.json');
  }

  private get blockedFile(): string {
    return path.join(this.payloadRoot, 'blocked.json');
  }

  // ---- registry 元数据 ----

  private async fetchRegistryVersion(spec: string): Promise<RegistryVersion> {
    if (spec !== 'latest' && !SAFE_VERSION_RE.test(spec)) {
      throw new DesktopError('registry_metadata_invalid', `版本说明符含非法字符: ${spec}`);
    }
    const url = `${this.registry}/${encodeURIComponent(this.packageName)}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
        signal: AbortSignal.timeout(this.metadataTimeoutMs),
      });
    } catch (error) {
      throw new DesktopError(
        'registry_metadata_failed',
        `registry 元数据获取失败: ${url}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (!response.ok) {
      throw new DesktopError('registry_metadata_failed', `registry 元数据获取失败: HTTP ${response.status} ${url}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new DesktopError(
        'registry_metadata_failed',
        `registry 元数据读取失败: ${url}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (text.length > 32 * 1024 * 1024) {
      throw new DesktopError('registry_metadata_failed', `registry 元数据超限（>32MiB）: ${url}`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (error) {
      throw new DesktopError(
        'registry_metadata_failed',
        `registry 元数据不是合法 JSON: ${url}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    return this.validateRegistryVersion(doc, spec);
  }

  /** 边界强校验：name/version/dist.integrity(sha512)/dist.tarball 任一不满足显式拒绝。 */
  private validateRegistryVersion(doc: unknown, spec: string): RegistryVersion {
    const problems: string[] = [];
    const d = (doc ?? {}) as Record<string, unknown>;
    if (d['name'] !== this.packageName) problems.push(`文档 name 与请求包名不一致: ${JSON.stringify(d['name'])}`);
    const distTags = d['dist-tags'];
    const latestTag = typeof distTags === 'object' && distTags !== null ? (distTags as Record<string, unknown>)['latest'] : undefined;
    const version = spec === 'latest' ? latestTag : spec;
    if (typeof version !== 'string' || version.length === 0 || !SAFE_VERSION_RE.test(version)) {
      problems.push(`无法解析目标版本（spec=${spec}，latest tag=${JSON.stringify(latestTag)}）`);
    }
    const versions = d['versions'];
    const entry =
      typeof version === 'string' && typeof versions === 'object' && versions !== null
        ? (versions as Record<string, unknown>)[version]
        : undefined;
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`registry 不存在版本 ${String(version)}`);
    }
    let integrity: unknown;
    let tarball: unknown;
    if (typeof entry === 'object' && entry !== null) {
      const e = entry as Record<string, unknown>;
      if (e['name'] !== this.packageName) problems.push(`版本条目 name 不一致: ${JSON.stringify(e['name'])}`);
      if (e['version'] !== version) problems.push(`版本条目 version 不一致: ${JSON.stringify(e['version'])}`);
      const dist = e['dist'];
      if (typeof dist === 'object' && dist !== null) {
        integrity = (dist as Record<string, unknown>)['integrity'];
        tarball = (dist as Record<string, unknown>)['tarball'];
      } else {
        problems.push('dist 字段缺失');
      }
    }
    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
      problems.push(`dist.integrity 必须是 sha512-<base64>，实际: ${JSON.stringify(integrity)}`);
    } else if (Buffer.from(integrity.slice('sha512-'.length), 'base64').length !== 64) {
      problems.push('dist.integrity sha512 摘要长度非法（须 64 字节）');
    }
    if (typeof tarball !== 'string' || tarball.length === 0) {
      problems.push('dist.tarball 缺失');
    } else {
      try {
        const parsed = new URL(tarball);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          problems.push(`dist.tarball 协议非法: ${parsed.protocol}`);
        }
      } catch {
        problems.push(`dist.tarball 不是合法 URL: ${tarball}`);
      }
    }
    if (problems.length > 0) {
      throw new DesktopError('registry_metadata_invalid', `registry 元数据契约不满足（${this.packageName}@${spec}）`, {
        problems,
      });
    }
    return { name: this.packageName, version: version as string, integrity: integrity as string, tarball: tarball as string };
  }

  // ---- 下载与完整性 ----

  private async downloadTarball(meta: RegistryVersion, destFile: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(meta.tarball, {
        headers: { accept: 'application/octet-stream' },
        signal: AbortSignal.timeout(this.downloadTimeoutMs),
      });
    } catch (error) {
      throw new DesktopError(
        'tarball_download_failed',
        `payload tarball 下载失败: ${meta.tarball}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (!response.ok || response.body === null) {
      throw new DesktopError('tarball_download_failed', `payload tarball 下载失败: HTTP ${response.status} ${meta.tarball}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxTarballBytes) {
      throw new DesktopError('tarball_too_large', `payload tarball 超过上限（${declared} > ${this.maxTarballBytes} 字节）`);
    }
    const expected = Buffer.from(meta.integrity.slice('sha512-'.length), 'base64');
    const hash = createHash('sha512');
    const fh = openSync(destFile, 'w');
    let total = 0;
    let tooLarge = false;
    // Node fetch 的 body 运行时可异步迭代，但 DOM lib 类型未声明；显式断言为 AsyncIterable。
    const bodyStream = response.body as unknown as AsyncIterable<Uint8Array | Buffer>;
    try {
      for await (const chunk of bodyStream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > this.maxTarballBytes) {
          tooLarge = true;
          break;
        }
        hash.update(buf);
        writeSync(fh, buf, 0, buf.length);
      }
    } catch (error) {
      throw new DesktopError(
        'tarball_download_failed',
        `payload tarball 下载中断: ${meta.tarball}（${error instanceof Error ? error.message : String(error)}）`,
      );
    } finally {
      closeSync(fh);
    }
    if (tooLarge) {
      rmSync(destFile, { force: true });
      throw new DesktopError('tarball_too_large', `payload tarball 下载超过上限（> ${this.maxTarballBytes} 字节）`);
    }
    const actual = hash.digest();
    if (!actual.equals(expected)) {
      rmSync(destFile, { force: true });
      throw new DesktopError(
        'tarball_integrity_mismatch',
        `payload tarball sha512 完整性校验失败（期望 ${expected.toString('base64')}，实际 ${actual.toString('base64')}）`,
        { tarball: meta.tarball, version: meta.version },
      );
    }
  }

  // ---- payload manifest 契约 ----

  private loadPayloadManifest(releaseDir: string): { kernelEntryPath: string; launcherPath: string } {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
    } catch (error) {
      throw new DesktopError(
        'payload_manifest_invalid',
        `payload manifest.json 缺失或非法 JSON: ${error instanceof Error ? error.message : String(error)}`,
        { releaseDir },
      );
    }
    const problems: string[] = [];
    const m = (manifest ?? {}) as Record<string, unknown>;
    if (m['formatVersion'] !== 1) problems.push(`formatVersion 必须为 1，实际 ${JSON.stringify(m['formatVersion'])}`);
    const entries = m['entries'];
    const entriesRecord = typeof entries === 'object' && entries !== null ? (entries as Record<string, unknown>) : {};
    const kernelRel = entriesRecord['kernel'];
    const launcherRel = typeof entriesRecord['launcher'] === 'string' && entriesRecord['launcher'].length > 0 ? entriesRecord['launcher'] : 'start.mjs';
    if (typeof kernelRel !== 'string' || kernelRel.length === 0) {
      problems.push('entries.kernel 缺失（Hub 入口声明）');
    } else if (kernelRel === launcherRel || kernelRel === 'start.mjs') {
      problems.push('entries.kernel 不得指向 launcher（start.mjs 是带命令参数的启动器，不是 Hub 入口）');
    }
    let kernelEntryPath: string | null = null;
    if (typeof kernelRel === 'string') {
      kernelEntryPath = this.containedIn(releaseDir, kernelRel, problems, 'entries.kernel');
    }
    const launcherPath = this.containedIn(releaseDir, launcherRel, problems, 'entries.launcher');
    if (kernelEntryPath !== null && !existsSync(kernelEntryPath)) problems.push(`entries.kernel 文件不存在: ${kernelRel}`);
    if (!existsSync(launcherPath)) problems.push(`launcher 文件不存在: ${launcherRel}`);
    if (problems.length > 0) {
      throw new DesktopError('payload_manifest_invalid', 'payload manifest 契约不满足', { releaseDir, problems });
    }
    return { kernelEntryPath: kernelEntryPath!, launcherPath };
  }

  /** 相对路径 containment 解析（manifest 声明同样不可逃逸 releaseDir）。 */
  private containedIn(rootDir: string, rel: string, problems: string[], what: string): string {
    const normalized = path.posix.normalize(rel);
    if (
      normalized.length === 0 ||
      path.posix.isAbsolute(normalized) ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized.includes('\\')
    ) {
      problems.push(`${what} 声明路径非法: ${rel}`);
      return path.join(rootDir, 'invalid');
    }
    return path.resolve(rootDir, normalized);
  }

  // ---- start.mjs check 验收 + 依赖安装 ----

  private async verifyWithInstaller(releaseDir: string, launcherPath: string): Promise<void> {
    const first = await this.runStartCheck(releaseDir, launcherPath);
    if (first.code === 0) return;
    if (first.code === 3) {
      if (this.npmInstaller === undefined) {
        throw new DesktopError(
          'payload_deps_missing',
          'payload 运行时依赖缺失且未配置 NpmInstaller（npm tarball 不含 node_modules；生产环境默认宿主 npm，见 packages/payload/README.md）',
          { releaseDir, stdoutTail: first.stdoutTail, stderrTail: first.stderrTail },
        );
      }
      await this.npmInstaller.install(releaseDir);
      const second = await this.runStartCheck(releaseDir, launcherPath);
      if (second.code === 0) return;
      if (second.code === 3) {
        throw new DesktopError('payload_deps_unresolved', `NpmInstaller（${this.npmInstaller.id}）执行后 payload 仍报告依赖缺失`, {
          releaseDir,
          stdoutTail: second.stdoutTail,
          stderrTail: second.stderrTail,
        });
      }
      throw this.checkFailure(releaseDir, second);
    }
    throw this.checkFailure(releaseDir, first);
  }

  private checkFailure(releaseDir: string, run: CheckRunResult): DesktopError {
    return new DesktopError('payload_check_failed', `payload start check 验收失败（exit ${run.code}）`, {
      releaseDir,
      stdoutTail: run.stdoutTail,
      stderrTail: run.stderrTail,
    });
  }

  /** 运行 payload 自带 start.mjs check（真实契约：0 通过 / 1 布局损坏 / 3 依赖缺失）。 */
  private async runStartCheck(releaseDir: string, launcherPath: string): Promise<CheckRunResult> {
    const node = await this.resolveCheckNode();
    return await new Promise<CheckRunResult>((resolve, reject) => {
      const child = spawn(node.executable, [launcherPath, 'check'], {
        cwd: releaseDir,
        env: node.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutTail: string[] = [];
      const stderrTail: string[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        reject(
          new DesktopError('payload_check_failed', `payload start check 超时（${this.checkTimeoutMs}ms）`, {
            releaseDir,
            stderrTail,
          }),
        );
      }, this.checkTimeoutMs);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DesktopError('payload_check_failed', `payload check 无法执行: ${error.message}`, { releaseDir }));
      });
      const tail = (sink: string[], chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.length === 0) continue;
          sink.push(line);
          if (sink.length > this.tailLines) sink.shift();
        }
      };
      child.stdout?.on('data', (chunk: Buffer) => tail(stdoutTail, chunk));
      child.stderr?.on('data', (chunk: Buffer) => tail(stderrTail, chunk));
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdoutTail, stderrTail });
      });
    });
  }

  /** 选择可运行 check 的 Node：与 runners.ts 同一能力探测（>= floor 且 node:sqlite）。 */
  private async resolveCheckNode(): Promise<{ executable: string; env: NodeJS.ProcessEnv }> {
    if (this.checkNode !== null) return this.checkNode;
    if (this.isElectron) {
      const electronEnv = { ...this.env, ELECTRON_RUN_AS_NODE: '1' };
      try {
        const probe = await probeRunner(this.execPath, { env: electronEnv });
        if (probeMeetsFloor(probe)) {
          this.checkNode = { executable: this.execPath, env: electronEnv };
          return this.checkNode;
        }
      } catch {
        // 落入宿主 Node 候选；全部不可用时下方显式报错
      }
    }
    const hostNode = this.isElectron ? 'node' : this.execPath;
    const probe = await probeRunner(hostNode, { env: this.env });
    if (!probeMeetsFloor(probe)) {
      throw new DesktopError(
        'payload_check_node_unavailable',
        `无法找到可运行 payload check 的 Node（需 >= ${KERNEL_NODE_FLOOR} 且 node:sqlite；实际 Node ${probe.node}，sqlite=${probe.sqlite}）`,
        { hostNode },
      );
    }
    this.checkNode = { executable: hostNode, env: { ...this.env } };
    return this.checkNode;
  }

  // ---- 晋升为不可变 release ----

  private releaseDirFor(name: string, version: string): string {
    const segments = name.split('/');
    for (const segment of segments) {
      if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\')) {
        throw new DesktopError('registry_metadata_invalid', `包名不可用作路径: ${name}`);
      }
    }
    if (!SAFE_VERSION_RE.test(version)) {
      throw new DesktopError('registry_metadata_invalid', `版本号含路径不安全字符: ${version}`);
    }
    return path.join(this.payloadRoot, 'releases', ...segments, version);
  }

  private promote(extractDir: string, meta: RegistryVersion, kernelEntryPath: string): PayloadInfo {
    const releaseDir = this.releaseDirFor(meta.name, meta.version);
    mkdirSync(path.dirname(releaseDir), { recursive: true });
    // 同版本重装：旧目录暂挪 staging，新目录原子换名成功后再删；失败回滚保旧。
    let trash: string | null = null;
    if (existsSync(releaseDir)) {
      trash = `${releaseDir}.old-${createHash('sha256').update(`${Date.now()}${process.pid}`).digest('hex').slice(0, 8)}`;
      renameSync(releaseDir, trash);
    }
    try {
      renameSync(extractDir, releaseDir);
    } catch (error) {
      if (trash !== null) {
        try {
          renameSync(trash, releaseDir);
        } catch {
          // 回滚尽力而为：换名失败本身已显式上抛
        }
      }
      throw new DesktopError(
        'payload_promote_failed',
        `release 目录换名失败: ${releaseDir}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    const entryPath = path.join(releaseDir, path.relative(extractDir, kernelEntryPath));
    writeJsonAtomic(this.currentFile, {
      formatVersion: 1,
      name: meta.name,
      version: meta.version,
      releaseDir,
      entryPath,
      entryArgs: [],
      installedAt: new Date().toISOString(),
    } satisfies CurrentState);
    if (trash !== null) {
      rmSync(trash, { recursive: true, force: true });
    }
    return { name: meta.name, version: meta.version, releaseDir, entryPath, entryArgs: [] };
  }

  // ---- blocked.json 维护 ----

  private readBlocked(): BlockedState {
    const raw = readJsonState(this.blockedFile, 'blocked.json');
    if (raw === undefined) return { formatVersion: 1, entries: {} };
    const b = raw as Partial<BlockedState>;
    if (b.formatVersion !== 1 || typeof b.entries !== 'object' || b.entries === null) {
      throw new DesktopError('blocked_state_invalid', 'blocked.json 已损坏（形状不满足契约）', { blockedFile: this.blockedFile });
    }
    return { formatVersion: 1, entries: b.entries };
  }

  private recordBlockedIfArtifactFault(meta: RegistryVersion, error: DesktopError): void {
    if (!ARTIFACT_FAULT_CODES.has(error.code)) return;
    let state: BlockedState;
    try {
      state = this.readBlocked();
    } catch {
      // blocked.json 损坏时安装错误优先上抛；此处不叠加侧信道失败
      return;
    }
    const details = error.details as { stderrTail?: unknown } | undefined;
    const entry: BlockedEntry = {
      name: meta.name,
      version: meta.version,
      code: error.code,
      message: error.message,
      at: new Date().toISOString(),
      stderrTail: Array.isArray(details?.stderrTail) ? (details!.stderrTail as string[]) : undefined,
    };
    state.entries[`${meta.name}@${meta.version}`] = entry;
    // 超限淘汰最旧（对象键保持插入序）。
    const keys = Object.keys(state.entries);
    if (keys.length > BLOCKED_MAX_ENTRIES) {
      for (const key of keys.slice(0, keys.length - BLOCKED_MAX_ENTRIES)) delete state.entries[key];
    }
    try {
      writeJsonAtomic(this.blockedFile, state);
    } catch {
      // 记录失败不掩盖安装错误
    }
  }

  private unblockVersion(version: string): void {
    let state: BlockedState;
    try {
      state = this.readBlocked();
    } catch {
      return;
    }
    const key = `${this.packageName}@${version}`;
    if (state.entries[key] === undefined) return;
    delete state.entries[key];
    try {
      writeJsonAtomic(this.blockedFile, state);
    } catch {
      // 同上：安装已成功，侧信道失败不上抛
    }
  }
}

// ---- 未配置实现（诚实声明，不伪装） ----

export class UnconfiguredPayloadUpdater implements PayloadUpdater {
  readonly id = 'unconfigured';

  async check(): Promise<PayloadUpdateStatus> {
    return { updateAvailable: false, current: null, latest: null, reason: 'updater_not_configured' };
  }

  async downloadAndInstall(_target: PayloadInstallTarget): Promise<never> {
    throw new DesktopError(
      'updater_not_configured',
      '未配置 payload npm 包名（HELM_PAYLOAD_PACKAGE 或 overrides.payloadPackage），无法自动安装',
    );
  }

  resolveCurrent(): PayloadInfo | null {
    return null;
  }
}

// ---- 工厂 ----

export interface PayloadUpdaterDeps {
  fetchImpl?: typeof fetch;
  npmInstaller?: NpmInstaller;
  execPath?: string;
  isElectron?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** 按配置选择 updater：未配置包名 → 诚实返回 UnconfiguredPayloadUpdater。 */
export function createPayloadUpdater(config: DesktopConfig, deps: PayloadUpdaterDeps = {}): PayloadUpdater {
  const packageName = config.payloadPackage?.trim();
  if (packageName === undefined || packageName.length === 0) {
    return new UnconfiguredPayloadUpdater();
  }
  const dataDir = config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : path.join(homedir(), '.helm');
  return new NpmPayloadUpdater({
    packageName,
    registry: config.payloadRegistry,
    pinnedVersion: config.payloadVersion,
    payloadRoot: path.join(dataDir, 'payload'),
    fetchImpl: deps.fetchImpl ?? fetch,
    npmInstaller: deps.npmInstaller ?? new HostNpmInstaller({ env: deps.env }),
    env: deps.env,
    execPath: deps.execPath ?? process.execPath,
    isElectron: deps.isElectron ?? process.versions.electron !== undefined,
  });
}
