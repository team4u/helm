/**
 * npm payload 更新器（真实实现）。
 *
 * 生命周期（三段式：安装与激活分离，启动验收归属桌面壳，updater 不感知 Hub）：
 * 1. stage(target)：registry 元数据强校验（严格 SemVer）→ 下载 tgz（sha512 流式校验）→
 *    staging 解包（payload-tar.ts containment 强校验）→ manifest 契约校验（含与 registry
 *    meta 的 name/version 一致性，不仅 format）→ `start.mjs check` 验收（exit 3 依赖缺失时
 *    经可注入 NpmInstaller 安装生产依赖后复检）→ 原子晋升到
 *    releases/<name>/<version>/<uuid> 不可变目录（绝不重命名/删除既有版本目录）→
 *    原子写 pending.json；current.json 不动；
 * 2. 桌面壳以 pending 入口启动新版本：健康则 activate(info)——previous.json 保存旧
 *    baseline、current.json 原子切换、清除同一 pending；启动失败则 reject(info, error)——
 *    记入 blocked.json、current 保持不动、清除同一 pending、不修改任何 release 目录；
 * 3. resolveCurrent / resolvePending / resolvePrevious 读取时严格复验（状态文件与 release
 *    manifest 的 name/version 一致、entryPath 与 manifest entries.kernel 一致、containment、
 *    拒绝 Windows 绝对/盘符相对/反斜杠路径形态），损坏显式报错，绝不静默当空态。
 *
 * check() 更新判定：跟踪 latest 时仅「更大 SemVer」视为可更新（registry latest 回退不误报）；
 * 显式锁定版本（HELM_PAYLOAD_VERSION / pinnedVersion）按用户意图比对相等性。
 *
 * 生命周期边界：updater 只管理制品——不重启 Hub、不感知会话、不调用 Hub API。并发安装
 * 由 fail-closed 文件锁串行（payload-lock.ts）：锁被占用仅有界等待，绝不自动接管。
 * 安装失败按「制品缺陷」类错误码记录 blocked.json，当前版本绝不破坏。
 */
import { createHash, randomBytes } from 'node:crypto';
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
  /** release 目录（绝对路径，releases/<name>/<version>/<uuid> 不可变目录）；stage 后存在。 */
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
  /** 下载并验收目标版本，写入 pending.json 等待激活决议；不影响 current。可重复执行。 */
  stage(target: PayloadInstallTarget): Promise<PayloadInfo>;
  /** 激活已 stage 的制品：previous.json 保存旧 baseline、current.json 原子切换、清除同一 pending。 */
  activate(info: PayloadInfo): Promise<void>;
  /** 拒绝已 stage 的制品：记入 blocked.json、保持 current、清除同一 pending、不动任何 release 目录。 */
  reject(info: PayloadInfo, error: Error): Promise<void>;
  /** 当前生效制品；无则 null；状态不满足契约时显式抛错。 */
  resolveCurrent(): PayloadInfo | null;
  /** 待决议的已 stage 制品（pending.json）；无则 null；损坏显式抛错。 */
  resolvePending(): PayloadInfo | null;
  /** 最近一次激活前的 baseline（previous.json）；无则 null；损坏显式抛错。 */
  resolvePrevious(): PayloadInfo | null;
}

// ---- 状态文件形状 ----

/** current.json / pending.json / previous.json 共用形状（at = 写入时刻）。 */
interface PayloadState {
  formatVersion: 1;
  name: string;
  version: string;
  releaseDir: string;
  entryPath: string;
  entryArgs: string[];
  at: string;
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

// ---- 严格 SemVer（npm 版本号即 SemVer；不引运行时依赖，按 semver.org 优先级实现） ----

/** 官方 SemVer 语法（build metadata 允许但优先级比较忽略）。 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parseSemVer(value: string): { major: number; minor: number; patch: number; prerelease: (number | string)[] } | null {
  const matched = SEMVER_RE.exec(value);
  if (matched === null) return null;
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    prerelease:
      matched[4] === undefined
        ? []
        : matched[4].split('.').map((identifier) => (/^\d+$/.test(identifier) ? Number(identifier) : identifier)),
  };
}

/** SemVer 优先级比较（build metadata 忽略；release > prerelease；数字标识 < 字母标识）。 */
function compareSemVer(a: string, b: string): number | null {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);
  if (pa === null || pb === null) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const shared = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < shared; i++) {
    const x = pa.prerelease[i]!;
    const y = pb.prerelease[i]!;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'string') return -1;
    if (typeof x === 'string' && typeof y === 'number') return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return x < y ? -1 : 1;
  }
  return pa.prerelease.length - pb.prerelease.length;
}

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
  /** 安装互斥锁的有界等待时长（fail-closed：占用即等待/超时，绝不接管）。 */
  lockTimeoutMs?: number;
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
    });
    this.id = `npm:${this.packageName}@${this.registry}`;
  }

  // ---- check ----

  async check(): Promise<PayloadUpdateStatus> {
    const current = this.resolveCurrent();
    const meta = await this.fetchRegistryVersion(this.pinnedVersion ?? 'latest');
    const latest: PayloadInfo = { name: meta.name, version: meta.version };
    if (current !== null && current.name === meta.name && !this.isNewerTarget(current.version, meta.version)) {
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

  /**
   * 目标版本相对 current 是否值得更新：
   * - 跟踪 latest：仅严格更大 SemVer 才算更新（registry latest 回退/持平不误报）；
   * - 显式锁定版本（pinnedVersion）：用户明确意图，版本不同即算更新（允许降级换装）。
   */
  private isNewerTarget(currentVersion: string, targetVersion: string): boolean {
    if (this.pinnedVersion !== undefined) return currentVersion !== targetVersion;
    const ordering = compareSemVer(currentVersion, targetVersion);
    if (ordering === null) {
      // current.version 来自已通过严格校验的 manifest/meta，正常不可达；fail-closed 不放行。
      return false;
    }
    return ordering < 0;
  }

  // ---- stage：下载验收 + pending，不动 current ----

  async stage(target: PayloadInstallTarget): Promise<PayloadInfo> {
    if (target.name !== this.packageName) {
      throw new DesktopError(
        'updater_target_mismatch',
        `安装目标 ${target.name} 与配置的 payload 包 ${this.packageName} 不一致`,
      );
    }
    const versionSpec = target.version.length > 0 ? target.version : 'latest';
    return await this.lock.run(async () => this.stageLocked(versionSpec));
  }

  private async stageLocked(versionSpec: string): Promise<PayloadInfo> {
    const stagingRoot = path.join(this.payloadRoot, 'staging');
    // 持锁清理崩溃遗留的 staging：fail-closed 锁保证此刻无其他安装者。
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
          `${blockedKey} 此前已被拒绝/安装失败（${blockedEntry.code}: ${blockedEntry.message}）`,
          { blocked: blockedEntry },
        );
      }
      // 幂等快路径 1：同版本 pending 仍待决议且制品完好 → 不重复下载。
      const pending = this.resolvePendingSoft();
      if (pending !== null && pending.name === meta.name && pending.version === meta.version) {
        return pending;
      }
      // 幂等快路径 2：目标版本即当前生效版本 → 直接以待激活身份复用（不重下载、不毁 current）。
      const current = this.resolveCurrent();
      if (current !== null && current.name === meta.name && current.version === meta.version) {
        writeJsonAtomic(this.pendingFile, this.stateOf(current, new Date().toISOString()));
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

      const { kernelEntryPath, launcherPath } = this.loadPayloadManifest(extractDir, meta);
      await this.verifyWithInstaller(extractDir, launcherPath);
      const info = this.promoteToImmutable(extractDir, meta, kernelEntryPath);
      writeJsonAtomic(this.pendingFile, this.stateOf(info, new Date().toISOString()));
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

  // ---- activate / reject：pending 决议 ----

  async activate(info: PayloadInfo): Promise<void> {
    await this.lock.run(async () => {
      const state = this.validateInfo(info, 'payload_activate_invalid');
      // current 损坏时显式抛错（fail-closed）：不能在旧状态不可信时静默换装。
      const current = this.resolveCurrent();
      const at = new Date().toISOString();
      if (current !== null && current.releaseDir !== state.releaseDir) {
        writeJsonAtomic(this.previousFile, this.stateOf(current, at));
      }
      writeJsonAtomic(this.currentFile, { ...state, at });
      this.clearPendingFor(state.name, state.version);
    });
  }

  async reject(info: PayloadInfo, error: Error): Promise<void> {
    await this.lock.run(async () => {
      const problems: string[] = [];
      if (info.name !== this.packageName) problems.push(`name 与配置的 payload 包不一致: ${info.name}`);
      if (typeof info.version !== 'string' || parseSemVer(info.version) === null) {
        problems.push(`version 不是合法 SemVer: ${String(info.version)}`);
      }
      if (problems.length > 0) {
        throw new DesktopError('payload_reject_invalid', 'reject 入参不满足契约', { problems });
      }
      // reject 是显式决议：无论错误类别一律记 blocked（环境类错误在 stage 内部已分流，不走到这里）。
      const code = error instanceof DesktopError ? error.code : 'payload_rejected';
      const details = error instanceof DesktopError ? (error.details as { stderrTail?: unknown } | undefined) : undefined;
      this.writeBlockedEntry({
        name: info.name,
        version: info.version,
        code,
        message: error.message,
        at: new Date().toISOString(),
        stderrTail: Array.isArray(details?.stderrTail) ? (details!.stderrTail as string[]) : undefined,
      });
      this.clearPendingFor(info.name, info.version);
    });
  }

  // ---- 状态读取（严格复验） ----

  resolveCurrent(): PayloadInfo | null {
    return this.readStateInfo(this.currentFile, 'current.json', 'current_payload_invalid');
  }

  resolvePending(): PayloadInfo | null {
    return this.readStateInfo(this.pendingFile, 'pending.json', 'pending_payload_invalid');
  }

  resolvePrevious(): PayloadInfo | null {
    return this.readStateInfo(this.previousFile, 'previous.json', 'previous_payload_invalid');
  }

  /** pending 快路径专用：损坏/失效视为无待决议（pending 是派生状态，重 stage 会覆写）。 */
  private resolvePendingSoft(): PayloadInfo | null {
    try {
      return this.resolvePending();
    } catch {
      return null;
    }
  }

  private readStateInfo(file: string, what: string, code: string): PayloadInfo | null {
    const raw = readJsonState(file, what);
    if (raw === undefined) return null;
    return this.infoOf(this.validateState(raw, what, code));
  }

  private get currentFile(): string {
    return path.join(this.payloadRoot, 'current.json');
  }

  private get pendingFile(): string {
    return path.join(this.payloadRoot, 'pending.json');
  }

  private get previousFile(): string {
    return path.join(this.payloadRoot, 'previous.json');
  }

  private get blockedFile(): string {
    return path.join(this.payloadRoot, 'blocked.json');
  }

  private stateOf(info: PayloadInfo, at: string): PayloadState {
    return {
      formatVersion: 1,
      name: info.name,
      version: info.version,
      releaseDir: info.releaseDir!,
      entryPath: info.entryPath!,
      entryArgs: [...(info.entryArgs ?? [])],
      at,
    };
  }

  private infoOf(state: PayloadState): PayloadInfo {
    return {
      name: state.name,
      version: state.version,
      releaseDir: state.releaseDir,
      entryPath: state.entryPath,
      entryArgs: state.entryArgs,
    };
  }

  /** activate 入参复用状态文件的整套严格校验（不落盘，仅验证）。 */
  private validateInfo(info: PayloadInfo, code: string): PayloadState {
    return this.validateState(
      {
        formatVersion: 1,
        name: info.name,
        version: info.version,
        releaseDir: info.releaseDir,
        entryPath: info.entryPath,
        entryArgs: info.entryArgs ?? [],
      },
      'activate 入参',
      code,
    );
  }

  /** 状态文件严格校验：形状 + 路径形态（拒 Windows 形态）+ containment + 存在性 + manifest 一致。 */
  private validateState(raw: unknown, what: string, code: string): PayloadState {
    const problems: string[] = [];
    const s = (raw ?? {}) as Partial<PayloadState>;
    if (s.formatVersion !== 1) problems.push(`formatVersion 必须为 1，实际 ${JSON.stringify(s.formatVersion)}`);
    if (typeof s.name !== 'string' || s.name.length === 0 || s.name.includes('\\') || s.name.includes('..')) {
      problems.push(`name 缺失或非法: ${JSON.stringify(s.name)}`);
    } else if (s.name !== this.packageName) {
      problems.push(`name 与 updater 配置的 payload 包不一致: ${s.name}`);
    }
    if (typeof s.version !== 'string' || parseSemVer(s.version) === null) {
      problems.push(`version 不是合法 SemVer: ${JSON.stringify(s.version)}`);
    }
    const releaseDirOk = this.checkManagedPath(s.releaseDir, problems, 'releaseDir');
    const entryPathOk = this.checkManagedPath(s.entryPath, problems, 'entryPath');
    if (s.entryArgs !== undefined && (!Array.isArray(s.entryArgs) || s.entryArgs.some((a) => typeof a !== 'string'))) {
      problems.push('entryArgs 必须是字符串数组');
    }
    if (releaseDirOk) {
      const containment = path.relative(this.payloadRoot, s.releaseDir!);
      if (containment.startsWith('..') || path.isAbsolute(containment)) {
        problems.push('releaseDir 逃逸 payload 管理目录');
      } else {
        if (!existsSync(s.releaseDir!) || !statSync(s.releaseDir!).isDirectory()) {
          problems.push(`releaseDir 不存在: ${s.releaseDir}`);
        }
        if (entryPathOk) {
          const entryContainment = path.relative(s.releaseDir!, s.entryPath!);
          if (entryContainment.startsWith('..') || path.isAbsolute(entryContainment)) {
            problems.push('entryPath 逃逸 releaseDir');
          } else if (!existsSync(s.entryPath!)) {
            problems.push(`entryPath 不存在: ${s.entryPath}`);
          }
        }
        if (typeof s.name === 'string' && s.name.length > 0 && typeof s.version === 'string' && s.version.length > 0) {
          this.validateReleaseManifest(s.releaseDir!, s.name, s.version, entryPathOk ? s.entryPath! : null, problems);
        }
      }
    }
    if (problems.length > 0) {
      throw new DesktopError(code, `已安装 payload 状态不满足契约（${what}）`, { what, problems });
    }
    return {
      formatVersion: 1,
      name: s.name!,
      version: s.version!,
      releaseDir: s.releaseDir!,
      entryPath: s.entryPath!,
      entryArgs: Array.isArray(s.entryArgs) ? s.entryArgs : [],
      at: typeof s.at === 'string' ? s.at : '',
    };
  }

  /**
   * 管理路径形态校验：必须 POSIX 绝对路径；显式拒绝 Windows 形态——盘符前缀（C:\ 与盘符相对
   * C:foo）与任何反斜杠（\\server 等）。注：不能直接用 path.win32.isAbsolute 判定——POSIX
   * 绝对路径（/ 开头）在 win32 语义下同样是 absolute，会误杀全部合法路径；Windows 特有
   * 形态恰为盘符前缀与反斜杠两者，显式拒绝即完备。
   */
  private checkManagedPath(value: unknown, problems: string[], what: string): value is string {
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`${what} 缺失或非字符串`);
      return false;
    }
    if (!path.isAbsolute(value)) problems.push(`${what} 必须是绝对路径: ${value}`);
    if (/^[A-Za-z]:/.test(value)) problems.push(`${what} 不得是 Windows 盘符路径形态（C:\ 或盘符相对）: ${value}`);
    if (value.includes('\\')) problems.push(`${what} 不得包含反斜杠: ${value}`);
    return true;
  }

  /** release 目录 manifest 复验：name/version 与状态文件一致，entryPath 与 entries.kernel 一致。 */
  private validateReleaseManifest(releaseDir: string, name: string, version: string, entryPath: string | null, problems: string[]): void {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
    } catch (error) {
      problems.push(`release manifest.json 缺失或非法 JSON（${error instanceof Error ? error.message : String(error)}）`);
      return;
    }
    const m = (manifest ?? {}) as Record<string, unknown>;
    if (m['formatVersion'] !== 1) problems.push('release manifest formatVersion 必须为 1');
    if (m['name'] !== name) problems.push(`release manifest name 与状态不一致: ${JSON.stringify(m['name'])} ≠ ${JSON.stringify(name)}`);
    if (m['version'] !== version) {
      problems.push(`release manifest version 与状态不一致: ${JSON.stringify(m['version'])} ≠ ${JSON.stringify(version)}`);
    }
    const entries = m['entries'];
    const entriesRecord = typeof entries === 'object' && entries !== null ? (entries as Record<string, unknown>) : {};
    const kernelRel = entriesRecord['kernel'];
    if (typeof kernelRel !== 'string' || kernelRel.length === 0) {
      problems.push('release manifest entries.kernel 缺失');
      return;
    }
    const contained: string[] = [];
    const resolved = this.containedIn(releaseDir, kernelRel, contained, 'entries.kernel');
    if (contained.length > 0) {
      problems.push(...contained);
      return;
    }
    if (entryPath !== null && resolved !== path.resolve(entryPath)) {
      problems.push(`entryPath 与 manifest entries.kernel 不一致: ${entryPath} ≠ ${resolved}`);
    }
  }

  /** 清除与 (name, version) 匹配的 pending（其他版本的待决议保留）。 */
  private clearPendingFor(name: string, version: string): void {
    const raw = readJsonState(this.pendingFile, 'pending.json');
    if (raw === undefined) return;
    const pending = raw as Partial<PayloadState>;
    if (pending.name !== name || pending.version !== version) return;
    rmSync(this.pendingFile, { force: true });
  }

  // ---- registry 元数据 ----

  private async fetchRegistryVersion(spec: string): Promise<RegistryVersion> {
    if (spec !== 'latest' && parseSemVer(spec) === null) {
      throw new DesktopError('registry_metadata_invalid', `版本说明符不是合法 SemVer: ${spec}`);
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

  /** 边界强校验：name/严格 SemVer version/dist.integrity(sha512)/dist.tarball 任一不满足显式拒绝。 */
  private validateRegistryVersion(doc: unknown, spec: string): RegistryVersion {
    const problems: string[] = [];
    const d = (doc ?? {}) as Record<string, unknown>;
    if (d['name'] !== this.packageName) problems.push(`文档 name 与请求包名不一致: ${JSON.stringify(d['name'])}`);
    const distTags = d['dist-tags'];
    const latestTag = typeof distTags === 'object' && distTags !== null ? (distTags as Record<string, unknown>)['latest'] : undefined;
    const version = spec === 'latest' ? latestTag : spec;
    if (typeof version !== 'string' || parseSemVer(version) === null) {
      problems.push(`无法解析合法 SemVer 目标版本（spec=${spec}，latest tag=${JSON.stringify(latestTag)}）`);
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

  /** staging manifest 契约校验；meta 非空时同时强校验 name/version 与 registry 元数据一致。 */
  private loadPayloadManifest(
    releaseDir: string,
    meta: RegistryVersion | null,
  ): { kernelEntryPath: string; launcherPath: string } {
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
    if (meta !== null) {
      if (m['name'] !== meta.name) problems.push(`manifest name 与 registry 元数据不一致: ${JSON.stringify(m['name'])} ≠ ${JSON.stringify(meta.name)}`);
      if (m['version'] !== meta.version) {
        problems.push(`manifest version 与 registry 元数据不一致: ${JSON.stringify(m['version'])} ≠ ${JSON.stringify(meta.version)}`);
      }
    }
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

  /** 相对路径 containment 解析（manifest 声明同样不可逃逸 releaseDir，且拒绝 Windows 形态：盘符前缀与反斜杠）。 */
  private containedIn(rootDir: string, rel: string, problems: string[], what: string): string {
    const normalized = path.posix.normalize(rel);
    if (
      normalized.length === 0 ||
      path.posix.isAbsolute(normalized) ||
      /^[A-Za-z]:/.test(normalized) ||
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
    if (parseSemVer(version) === null) {
      throw new DesktopError('registry_metadata_invalid', `版本号不是合法 SemVer: ${version}`);
    }
    return path.join(this.payloadRoot, 'releases', ...segments, version);
  }

  /**
   * 原子晋升到 releases/<name>/<version>/<uuid> 不可变目录：每次 stage 生成新 uuid，
   * 绝不重命名/删除既有版本目录（同版本重装并存，激活由 current.json 指针决定）。
   * 晋升失败（如目录被占位文件阻挡）显式报错，既有 current 与其他版本目录不受影响。
   */
  private promoteToImmutable(extractDir: string, meta: RegistryVersion, kernelEntryPath: string): PayloadInfo {
    const versionRoot = this.releaseDirFor(meta.name, meta.version);
    try {
      mkdirSync(versionRoot, { recursive: true });
    } catch (error) {
      throw new DesktopError(
        'payload_promote_failed',
        `release 版本目录无法创建: ${versionRoot}（${error instanceof Error ? error.message : String(error)}）`,
        { versionRoot },
      );
    }
    const entryRel = path.relative(extractDir, kernelEntryPath);
    for (let attempt = 0; attempt < 8; attempt++) {
      const releaseDir = path.join(versionRoot, randomBytes(8).toString('hex'));
      if (existsSync(releaseDir)) continue;
      try {
        renameSync(extractDir, releaseDir);
      } catch (error) {
        throw new DesktopError(
          'payload_promote_failed',
          `release 目录换名失败: ${releaseDir}（${error instanceof Error ? error.message : String(error)}）`,
          { releaseDir },
        );
      }
      return { name: meta.name, version: meta.version, releaseDir, entryPath: path.join(releaseDir, entryRel), entryArgs: [] };
    }
    throw new DesktopError('payload_promote_failed', `无法生成未占用的 release 目录（多次 uuid 冲突）: ${versionRoot}`, {
      versionRoot,
    });
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

  private writeBlockedEntry(entry: BlockedEntry): void {
    let state: BlockedState;
    try {
      state = this.readBlocked();
    } catch {
      // blocked.json 损坏时原错误优先上抛；此处不叠加侧信道失败
      return;
    }
    state.entries[`${entry.name}@${entry.version}`] = entry;
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

  private recordBlockedIfArtifactFault(meta: RegistryVersion, error: DesktopError): void {
    if (!ARTIFACT_FAULT_CODES.has(error.code)) return;
    const details = error.details as { stderrTail?: unknown } | undefined;
    this.writeBlockedEntry({
      name: meta.name,
      version: meta.version,
      code: error.code,
      message: error.message,
      at: new Date().toISOString(),
      stderrTail: Array.isArray(details?.stderrTail) ? (details!.stderrTail as string[]) : undefined,
    });
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

  async stage(_target: PayloadInstallTarget): Promise<never> {
    throw new DesktopError(
      'updater_not_configured',
      '未配置 payload npm 包名（HELM_PAYLOAD_PACKAGE 或 overrides.payloadPackage），无法自动安装',
    );
  }

  async activate(_info: PayloadInfo): Promise<never> {
    throw new DesktopError('updater_not_configured', '未配置 payload npm 包名，无法激活 payload');
  }

  async reject(_info: PayloadInfo, _error: Error): Promise<never> {
    throw new DesktopError('updater_not_configured', '未配置 payload npm 包名，无法记录 payload 拒绝');
  }

  resolveCurrent(): PayloadInfo | null {
    return null;
  }

  resolvePending(): PayloadInfo | null {
    return null;
  }

  resolvePrevious(): PayloadInfo | null {
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
