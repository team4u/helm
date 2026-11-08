/**
 * helm-node 自升级引擎：npm 双包（@helm/node + @helm/cli）版本化安装事务。
 *
 * 设计要点（与 botd 升级引擎同源但更严格）：
 * - 双包同版本安装：一次 release 同时固定 @helm/node 与 @helm/cli 的精确
 *   版本，各自校验 registry 元数据 dist.integrity（sha512）后下载 tarball
 *   并校验哈希，再以本地 tgz 离线安装到同一 staging 目录；
 * - 候选目录 immutable：`releases/<ver>/<uuid>/`，永不删除（含正在运行的
 *   同版本目录）；版本根 `.complete` 指向完整候选并缓存校验过的入口；
 * - JSON 记录（current.json / update-blocked.json / .complete）仅 ENOENT
 *   返回 null，损坏与 IO 错误显式抛出（诚实错误纪律）；一律 0600 原子写；
 * - 提交点语义：`prepareReplacement` 返回"已注册但未激活"的候选，
 *   `replacement.commit()`（写 pid、发 activate 并等新 daemon 回报）才是
 *   唯一提交点；仅启动/注册不当作提交；commit 失败走 abort + 回滚 +
 *   写 blocked + 解除新命令 gate，绝不静默降级或伪造 PID。
 */
import fs, { type FileHandle } from 'node:fs/promises';
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { NodeUpgradeCheckResult, NodeUpgradeResult } from '@helm/protocol';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 输入非法/策略拒绝（调用方可映射 4xx）。 */
export class UpgradeRejectedError extends Error {}

/**
 * 提交结果未确认：activate 已发出、候选可能已向 Hub 上报 commit，仅本机
 * 确认丢失（如 ACK 超时）。这是特殊分支——不 abort、不回滚 current、不写
 * blocked；保持新 current 与 draining gate，通知 onScheduleShutdown 让旧宿主
 * 退出，向上抛“新版本已选择，激活结果未确认”而非 rollback。候选收到
 * activate 后保持激活并幂等重试 Hub commit；Hub 只依据收到的 commit 判定
 * 成功，避免 Hub 已成功却因本地 ACK 超时被反向回滚。
 */
export class UpgradeCommitUnconfirmedError extends Error {}

// —— 固定接口 ——————————————————————————————————————————————————————

/** 已就绪的候选 release（不可变目录 + 已校验入口）。 */
export interface StagedNodeRelease {
  version: string;
  /** 不可变候选目录（releases/<ver>/<uuid>）。 */
  releaseDir: string;
  /** @helm/node 守护入口（dist/cli.js）绝对路径。 */
  entryPath: string;
  /** @helm/cli 受管 helm 客户端 bin 目录（node_modules/.bin）绝对路径。 */
  cliBinDir: string;
}

/** 已完成 Hub 注册、等待激活的替换 daemon；commit() 是唯一提交点。 */
export interface PreparedNodeReplacement {
  pid: number;
  commit(): Promise<void>;
  abort(): Promise<void>;
}

export interface PerformNodeUpgradeOptions {
  targetVersion?: string;
  registryUrl?: string;
  force?: boolean;
  attemptId?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
  stageExtractor?: (stagingDir: string, targetVersion: string) => Promise<{ entryPath: string; cliBinDir: string }>;
  prepareReplacement?: (
    release: StagedNodeRelease,
    context: { attemptId: string; previousVersion: string; targetVersion: string },
  ) => Promise<PreparedNodeReplacement>;
  getActiveExecCount?: () => number;
  setDraining?: (value: boolean) => void;
  drainTimeoutMs?: number;
  onScheduleShutdown?: (pid: number) => void;
}

export interface StageReleaseOptions {
  registryUrl?: string;
  fetchFn?: typeof fetch;
  /** 仅单测注入：返回相对 staging 的入口与 bin 目录；校验无路径逃逸。 */
  stageExtractor?: (stagingDir: string, targetVersion: string) => Promise<{ entryPath: string; cliBinDir: string }>;
  /** 强制重装：跳过 .complete 缓存复用，生成新的不可变候选（绝不删除既有候选，含正在运行的同版本目录）。 */
  force?: boolean;
}

export interface CheckNodeUpgradeOptions {
  registryUrl?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
}

export interface CurrentReleaseRecord {
  version: string;
  entryPath: string;
  updatedAt: string;
  cliBinDir?: string;
}

export interface BlockedReleaseRecord {
  version: string;
  reason: string;
  at: string;
}

// —— 版本 ——————————————————————————————————————————————————————————

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

interface ParsedSemver {
  core: [number, number, number];
  pre: string[];
}

function parseStrictSemver(input: string, label: string): ParsedSemver {
  const match = STRICT_SEMVER.exec(input);
  if (!match) {
    throw new UpgradeRejectedError(`非法 SemVer 版本号（${label}）："${input}"（要求严格 x.y.z[-pre][+build]，不允许 v 前缀）`);
  }
  const [, major, minor, patch, pre] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    pre: pre === undefined ? [] : pre.split('.'),
  };
}

/** 严格 SemVer 比较（预发布优先级：正式版 > 预发布；数字段按数值、字母段按 ASCII；build metadata 按规范不参与比较）。非法输入抛 UpgradeRejectedError。 */
export function compareSemver(a: string, b: string): number {
  const pa = parseStrictSemver(a, 'a');
  const pb = parseStrictSemver(b, 'b');
  for (let i = 0; i < 3; i++) {
    if (pa.core[i]! > pb.core[i]!) return 1;
    if (pa.core[i]! < pb.core[i]!) return -1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const sa = pa.pre[i];
    const sb = pb.pre[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa) ? Number(sa) : undefined;
    const nb = /^\d+$/.test(sb) ? Number(sb) : undefined;
    if (na !== undefined && nb !== undefined) return na > nb ? 1 : -1;
    if (na !== undefined) return -1; // 数字标识符 < 字母标识符
    if (nb !== undefined) return 1;
    return sa < sb ? -1 : 1; // ASCII 字典序，不用 localeCompare
  }
  return 0;
}

/** Web/UI 允许 ` v1.0.0 ` 形态：trim 并去掉一个 v 前缀，再严格校验。 */
export function normalizeTargetVersion(input: string): string {
  const trimmed = input.trim().replace(/^v/, '');
  parseStrictSemver(trimmed, 'targetVersion');
  return trimmed;
}

let cachedPackageVersion: string | undefined;

/** 读取自身 @helm/node 包 package.json 的版本（不读 current.json 假装运行版）；HELM_VERSION_OVERRIDE 用于开发覆盖。 */
export function getNodeVersion(): string {
  const override = process.env.HELM_VERSION_OVERRIDE?.trim();
  if (override) return override;
  if (!cachedPackageVersion) {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
    let version: string;
    try {
      const parsed = JSON.parse(rawFs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version !== 'string' || !STRICT_SEMVER.test(parsed.version)) {
        throw new Error(`version 字段缺失或非法：${JSON.stringify(parsed.version)}`);
      }
      version = parsed.version;
    } catch (error) {
      // 读不到自身版本属于安装损坏，显式报错而不是假装一个默认版本。
      throw new Error(`无法读取 @helm/node 自身版本（${pkgPath}）：${error instanceof Error ? error.message : String(error)}`);
    }
    cachedPackageVersion = version;
  }
  return cachedPackageVersion;
}

/** 离线 CLI 读取当前激活入口的版本：current.json 优先，缺失回退自身包版本。 */
export async function resolveEffectiveNodeVersion(dataDir: string): Promise<string> {
  const current = await readCurrentRelease(dataDir);
  return current?.version ?? getNodeVersion();
}

// —— registry 允许清单 ————————————————————————————————————————————

const normalizeRegistry = (url: string | undefined): string => (url ?? '').trim().replace(/\/+$/, '');

/**
 * RPC 入站 registry 允许清单：仅官方 registry 或显式配置的 HELM_NPM_REGISTRY。
 * 显式传入其他源时抛 UpgradeRejectedError（不静默换源）；未传返回 undefined
 * （调用方自行走 env/默认解析）。
 */
export function filterRpcRegistryUrl(registryUrl?: string): string | undefined {
  const requested = normalizeRegistry(registryUrl);
  if (!requested) return undefined;
  if (requested === DEFAULT_REGISTRY) return requested;
  const envRegistry = normalizeRegistry(process.env.HELM_NPM_REGISTRY);
  if (envRegistry && requested === envRegistry) return requested;
  throw new UpgradeRejectedError(
    `拒绝非受信 npm registry：${requested}（仅允许 ${DEFAULT_REGISTRY} 或 HELM_NPM_REGISTRY 配置的源）`,
  );
}

function resolveRegistryUrl(explicit?: string): string {
  return normalizeRegistry(explicit || process.env.HELM_NPM_REGISTRY || DEFAULT_REGISTRY);
}

// —— JSON 记录：仅 ENOENT 返回 null，损坏/IO 错误显式抛出；0600 原子写 ————

async function readJsonRecord<T>(filePath: string, validate: (raw: unknown) => T, label: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(`读取 ${label} 失败（${filePath}）：${code ?? (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    return validate(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${label} 损坏（${filePath}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 0600 原子写：同目录临时文件 + rename（失败清理临时文件并如实抛出）。 */
async function writeSecureJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw new Error(`写入 ${filePath} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`字段 ${key} 缺失或不是非空字符串`);
  }
  return value;
}

function validateCurrentRecord(raw: unknown): CurrentReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('不是对象');
  const rec = raw as Record<string, unknown>;
  const record: CurrentReleaseRecord = {
    version: requireString(rec, 'version'),
    entryPath: requireString(rec, 'entryPath'),
    updatedAt: requireString(rec, 'updatedAt'),
  };
  if (rec.cliBinDir !== undefined && typeof rec.cliBinDir !== 'string') {
    throw new Error('字段 cliBinDir 不是字符串');
  }
  return rec.cliBinDir === undefined ? record : { ...record, cliBinDir: rec.cliBinDir };
}

function validateBlockedRecord(raw: unknown): BlockedReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('不是对象');
  const rec = raw as Record<string, unknown>;
  return {
    version: requireString(rec, 'version'),
    reason: requireString(rec, 'reason'),
    at: requireString(rec, 'at'),
  };
}

const currentReleasePath = (dataDir: string) => path.join(dataDir, 'current.json');
const blockedReleasePath = (dataDir: string) => path.join(dataDir, 'update-blocked.json');

export async function readCurrentRelease(dataDir: string): Promise<CurrentReleaseRecord | null> {
  return readJsonRecord(currentReleasePath(dataDir), validateCurrentRecord, 'current.json');
}

export async function writeCurrentRelease(dataDir: string, record: CurrentReleaseRecord): Promise<void> {
  validateCurrentRecord(record as unknown);
  await writeSecureJson(currentReleasePath(dataDir), record);
}

export async function deleteCurrentRelease(dataDir: string): Promise<void> {
  await fs.rm(currentReleasePath(dataDir), { force: true });
}

export async function readBlockedRelease(dataDir: string): Promise<BlockedReleaseRecord | null> {
  return readJsonRecord(blockedReleasePath(dataDir), validateBlockedRecord, 'update-blocked.json');
}

export async function writeBlockedRelease(dataDir: string, record: BlockedReleaseRecord): Promise<void> {
  validateBlockedRecord(record);
  await writeSecureJson(blockedReleasePath(dataDir), record);
}

export async function clearBlockedRelease(dataDir: string): Promise<void> {
  await fs.rm(blockedReleasePath(dataDir), { force: true });
}

// —— 升级检查 ——————————————————————————————————————————————————————

export async function checkNodeUpgrade(
  dataDir: string,
  options?: CheckNodeUpgradeOptions,
): Promise<NodeUpgradeCheckResult> {
  const registryUrl = resolveRegistryUrl(options?.registryUrl);
  const pkgName = process.env.HELM_NPM_PACKAGE || '@helm/node';
  const fetchImpl = options?.fetchFn ?? fetch;
  const url = `${registryUrl}/${pkgName}/latest`;

  let latestVersion: string;
  try {
    const data = (await fetchJsonWithTimeout(url, fetchImpl, METADATA_TIMEOUT_MS)) as { version?: unknown };
    if (typeof data.version !== 'string') {
      throw new Error(`响应缺少 version 字段：${JSON.stringify(data).slice(0, 200)}`);
    }
    latestVersion = data.version;
  } catch (error) {
    throw new Error(`查询 ${url} 最新版本失败：${error instanceof Error ? error.message : String(error)}`);
  }
  // registry 返回非法版本是明确的坏数据，直接拒绝而不是带病比较。
  parseStrictSemver(latestVersion, 'latest');

  const currentVersion =
    options?.currentVersion ?? (await readCurrentRelease(dataDir))?.version ?? getNodeVersion();
  const blocked = (await readBlockedRelease(dataDir)) || undefined;

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    ...(blocked ? { blocked } : {}),
  };
}

// —— staging：npm 双包下载 + 校验 + 本地 tgz 安装 ————————————————————

const METADATA_TIMEOUT_MS = 30_000;
const TARBALL_TIMEOUT_MS = 180_000;
const NPM_INSTALL_TIMEOUT_MS = 300_000;
const NPM_OUTPUT_DIAG_LINES = 40;

async function fetchJsonWithTimeout(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTarballWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  destPath: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const body = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(destPath, body, { mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`下载超时（${timeoutMs}ms）`);
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

interface RegistryManifest {
  integrity: string;
  tarball: string;
}

async function fetchExactManifest(
  registryUrl: string,
  pkgName: string,
  version: string,
  fetchImpl: typeof fetch,
): Promise<RegistryManifest> {
  const url = `${registryUrl}/${pkgName}/${version}`;
  let data: { name?: unknown; version?: unknown; dist?: { integrity?: unknown; tarball?: unknown } };
  try {
    data = (await fetchJsonWithTimeout(url, fetchImpl, METADATA_TIMEOUT_MS)) as typeof data;
  } catch (error) {
    throw new Error(`获取 ${pkgName}@${version} 元数据失败（${url}）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (data.name !== pkgName) {
    throw new Error(`registry 元数据包名不符：期望 ${pkgName}，实际 ${JSON.stringify(data.name)}`);
  }
  if (data.version !== version) {
    throw new Error(`registry 元数据版本不符：期望 ${version}，实际 ${JSON.stringify(data.version)}`);
  }
  const integrity = data.dist?.integrity;
  const tarball = data.dist?.tarball;
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) {
    throw new Error(`${pkgName}@${version} 元数据缺少合法的 sha512 dist.integrity`);
  }
  if (typeof tarball !== 'string' || !/^https?:\/\//.test(tarball)) {
    throw new Error(`${pkgName}@${version} 元数据缺少合法的 dist.tarball`);
  }
  return { integrity, tarball };
}

function computeSri(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = rawFs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(`sha512-${hash.digest('base64')}`));
  });
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  return lines.slice(-count).join('\n');
}

/**
 * 解析 npm 入口：Windows 上现代 Node 不允许 spawn(.cmd, shell:false)，因此
 * 不猜 npm.cmd，而是定位 node 可执行文件旁的 node_modules/npm/bin/npm-cli.js
 * （官方 Windows 安装布局），以 [process.execPath, npmCliJs] 执行——无 shell、
 * 无字符串拼接注入。定位不到时显式报错，不做不安全的 fallback。
 */
function resolveNpmCommand(): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(execDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // zip 布局：node.exe 在 bin/ 下
  ];
  for (const cliJs of candidates) {
    if (rawFs.existsSync(cliJs)) return { command: process.execPath, args: [cliJs] };
  }
  throw new Error(
    `无法定位 npm 入口 npm-cli.js（已尝试：${candidates.join(' ; ')}）。当前 Node 禁止直接 spawn npm.cmd，请修复 Node 安装或在 PATH 中提供官方 npm 布局后重试`,
  );
}

/** 运行 npm（有界超时）；失败错误包含退出码与输出最后 40 行诊断。 */
function runNpm(args: string[], cwd: string, timeoutMs: number): Promise<void> {
  let npm: { command: string; args: string[] };
  try {
    npm = resolveNpmCommand();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const fullArgs = [...npm.args, ...args];
  const displayCmd = `npm ${args[0]}`;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(npm.command, fullArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (error) {
      reject(new Error(`无法启动 ${displayCmd}（${npm.command}）：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 400_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 400_000) stderr += chunk.toString('utf8');
    });
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`${displayCmd} 超时（${timeoutMs}ms）被终止。输出最后 ${NPM_OUTPUT_DIAG_LINES} 行：\n${lastLines(`${stdout}\n${stderr}`, NPM_OUTPUT_DIAG_LINES)}`));
    }, timeoutMs);
    child.on('error', (error) => finish(new Error(`${displayCmd} 启动失败：${error.message}`)));
    // 用 close（而非 exit）确保流已排空，诊断输出完整。
    child.on('close', (code) => {
      if (code === 0) finish(null);
      else {
        finish(
          new Error(
            `${displayCmd} 以退出码 ${code} 失败。输出最后 ${NPM_OUTPUT_DIAG_LINES} 行：\n${lastLines(`${stdout}\n${stderr}`, NPM_OUTPUT_DIAG_LINES)}`,
          ),
        );
      }
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

interface CompleteMarker {
  version: string;
  candidateDir: string;
  entryPath: string;
  cliBinDir: string;
  completedAt: string;
  /** 候选来源：npm 正常安装（'npm'）或测试注入的 stageExtractor（'extractor'，复用时仅验证结构）。 */
  origin?: 'npm' | 'extractor';
}

function validateCompleteMarker(raw: unknown): CompleteMarker {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('不是对象');
  const rec = raw as Record<string, unknown>;
  const marker: CompleteMarker = {
    version: requireString(rec, 'version'),
    candidateDir: requireString(rec, 'candidateDir'),
    entryPath: requireString(rec, 'entryPath'),
    cliBinDir: requireString(rec, 'cliBinDir'),
    completedAt: requireString(rec, 'completedAt'),
  };
  if (rec.origin !== undefined && rec.origin !== 'npm' && rec.origin !== 'extractor') {
    throw new Error(`字段 origin 非法：${JSON.stringify(rec.origin)}`);
  }
  return rec.origin === undefined ? marker : { ...marker, origin: rec.origin };
}

/** stageExtractor 返回的相对路径必须落在 stagingDir 内（拒绝绝对路径与逃逸）。 */
function resolveInside(stagingDir: string, relative: string, label: string): string {
  if (typeof relative !== 'string' || relative === '') {
    throw new Error(`stageExtractor 返回的 ${label} 不是非空字符串`);
  }
  if (path.isAbsolute(relative)) {
    throw new Error(`stageExtractor 返回的 ${label} 必须是相对路径，收到绝对路径：${relative}`);
  }
  const resolved = path.resolve(stagingDir, relative);
  if (resolved !== stagingDir && !resolved.startsWith(stagingDir + path.sep)) {
    throw new Error(`stageExtractor 返回的 ${label} 路径逃逸：${relative}（解析为 ${resolved}）`);
  }
  return resolved;
}

async function readInstalledPackageJson(pkgDir: string, pkgName: string, version: string): Promise<Record<string, unknown>> {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`安装产物 ${pkgName} 的 package.json 不可读（${pkgJsonPath}）：${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.name !== pkgName || parsed.version !== version) {
    throw new Error(
      `安装产物包名/版本不符：期望 ${pkgName}@${version}，实际 ${String(parsed.name)}@${String(parsed.version)}（${pkgJsonPath}）`,
    );
  }
  return parsed;
}

/**
 * 缓存复用前的严格复核：candidate/entry/bin 必须位于本版本不可变目录内，
 * 且双包 package.json 名称/版本与入口/bin 目标仍有效（stageExtractor 产物
 * 按测试路径仅验证结构与存在性）。任何不匹配显式拒绝，不删除旧候选。
 */
async function revalidateCachedRelease(
  dataDir: string,
  targetVersion: string,
  marker: CompleteMarker,
): Promise<StagedNodeRelease | null> {
  const versionRoot = path.resolve(dataDir, 'releases', targetVersion);
  const inside = (candidate: string, base: string, label: string): string => {
    const resolved = path.resolve(candidate);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`.complete 缓存的 ${label} 不在本版本不可变目录内：${candidate}（期望位于 ${base} 下）`);
    }
    return resolved;
  };

  const candidateDir = inside(marker.candidateDir, versionRoot, 'candidateDir');
  const entryPath = inside(marker.entryPath, candidateDir, 'entryPath');
  const cliBinDir = inside(marker.cliBinDir, candidateDir, 'cliBinDir');
  if (!(await fileExists(entryPath))) {
    throw new Error(`.complete 缓存复用失败：入口文件不存在：${entryPath}`);
  }
  if (!(await fileExists(cliBinDir))) {
    throw new Error(`.complete 缓存复用失败：bin 目录不存在：${cliBinDir}`);
  }

  // stageExtractor（测试注入）产物仅验证结构；npm 产物重新核对双包元信息与入口/bin。
  if (marker.origin !== 'npm') {
    return { version: targetVersion, releaseDir: candidateDir, entryPath, cliBinDir };
  }

  const nodePkg = process.env.HELM_NPM_PACKAGE || '@helm/node';
  const cliPkg = process.env.HELM_NPM_CLI_PACKAGE || '@helm/cli';
  const nodePkgDir = path.join(candidateDir, 'node_modules', ...nodePkg.split('/'));
  const cliPkgDir = path.join(candidateDir, 'node_modules', ...cliPkg.split('/'));
  await readInstalledPackageJson(nodePkgDir, nodePkg, targetVersion);
  const cliPkgJson = await readInstalledPackageJson(cliPkgDir, cliPkg, targetVersion);
  if (path.relative(candidateDir, entryPath) !== path.join('node_modules', ...nodePkg.split('/'), 'dist', 'cli.js')) {
    throw new Error(`.complete 缓存的入口不是 ${nodePkg} 的 dist/cli.js：${entryPath}`);
  }
  if (!(await fileExists(path.join(cliPkgDir, 'dist', 'index.js')))) {
    throw new Error(`.complete 缓存复用失败：${cliPkg} 入口 dist/index.js 不存在（${cliPkgDir}）`);
  }
  const bin = cliPkgJson.bin;
  const binTarget =
    typeof bin === 'string' ? bin : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>).helm === 'string'
      ? (bin as Record<string, string>).helm
      : undefined;
  if (binTarget === undefined) {
    throw new Error(`.complete 缓存复用失败：${cliPkg} package.json 缺少 helm bin 声明`);
  }
  if (!(await fileExists(path.resolve(cliPkgDir, binTarget)))) {
    throw new Error(`.complete 缓存复用失败：${cliPkg} bin 目标不存在：${binTarget}`);
  }

  return { version: targetVersion, releaseDir: candidateDir, entryPath, cliBinDir };
}

export async function stageReleaseFromNpm(
  dataDir: string,
  targetVersion: string,
  options?: StageReleaseOptions,
): Promise<StagedNodeRelease> {
  parseStrictSemver(targetVersion, 'targetVersion');

  const versionRoot = path.join(dataDir, 'releases', targetVersion);
  const completePath = path.join(versionRoot, '.complete');

  // 已有完整候选且非 force：严格复核缓存标记与产物后复用，绝不删除旧候选。
  // force 跳过缓存重新下载安装，生成新的不可变候选。
  if (!options?.force) {
    const cached = await readJsonRecord(completePath, validateCompleteMarker, '.complete');
    if (cached && cached.version === targetVersion) {
      const revalidated = await revalidateCachedRelease(dataDir, targetVersion, cached);
      if (revalidated) return revalidated;
    }
  }

  await fs.mkdir(versionRoot, { recursive: true });
  const stagingDir = path.join(versionRoot, `.staging-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);

  try {
    await fs.mkdir(stagingDir, { recursive: true });
    let entryRelative: string;
    let binRelative: string;

    if (options?.stageExtractor) {
      const extracted = await options.stageExtractor(stagingDir, targetVersion);
      const entryPath = resolveInside(stagingDir, extracted.entryPath, 'entryPath');
      const cliBinDir = resolveInside(stagingDir, extracted.cliBinDir, 'cliBinDir');
      if (!(await fileExists(entryPath))) {
        throw new Error(`stageExtractor 返回的入口文件不存在：${entryPath}`);
      }
      if (!(await fileExists(cliBinDir))) {
        throw new Error(`stageExtractor 返回的 bin 目录不存在：${cliBinDir}`);
      }
      entryRelative = path.relative(stagingDir, entryPath);
      binRelative = path.relative(stagingDir, cliBinDir);
    } else {
      const registryUrl = resolveRegistryUrl(options?.registryUrl);
      const nodePkg = process.env.HELM_NPM_PACKAGE || '@helm/node';
      const cliPkg = process.env.HELM_NPM_CLI_PACKAGE || '@helm/cli';
      const fetchImpl = options?.fetchFn ?? fetch;

      // 双包各自取精确版本元数据 → 下载 tarball → sha512 校验。
      const downloads = path.join(stagingDir, '.downloads');
      await fs.mkdir(downloads, { recursive: true });
      const tarballPaths: string[] = [];
      for (const pkgName of [nodePkg, cliPkg]) {
        const manifest = await fetchExactManifest(registryUrl, pkgName, targetVersion, fetchImpl);
        const tarballPath = path.join(downloads, `${pkgName.replace('/', '+')}-${targetVersion}.tgz`);
        try {
          await fetchTarballWithTimeout(manifest.tarball, fetchImpl, TARBALL_TIMEOUT_MS, tarballPath);
        } catch (error) {
          throw new Error(`下载 ${pkgName}@${targetVersion} tarball 失败（${manifest.tarball}）：${error instanceof Error ? error.message : String(error)}`);
        }
        const actual = await computeSri(tarballPath);
        if (actual !== manifest.integrity) {
          throw new Error(
            `${pkgName}@${targetVersion} tarball sha512 完整性校验失败：期望 ${manifest.integrity}，实际 ${actual}`,
          );
        }
        tarballPaths.push(tarballPath);
      }

      await fs.writeFile(
        path.join(stagingDir, 'package.json'),
        JSON.stringify({ name: 'helm-node-release', private: true }, null, 2) + '\n',
        'utf8',
      );
      await runNpm(
        [
          'install',
          ...tarballPaths,
          '--omit=dev',
          '--no-audit',
          '--no-fund',
          '--registry',
          registryUrl,
        ],
        stagingDir,
        NPM_INSTALL_TIMEOUT_MS,
      );

      // 安装产物三重校验：package.json 名称/版本 + node dist/cli.js + cli dist/index.js 与 bin 目标。
      const nodePkgDir = path.join(stagingDir, 'node_modules', ...nodePkg.split('/'));
      const cliPkgDir = path.join(stagingDir, 'node_modules', ...cliPkg.split('/'));
      await readInstalledPackageJson(nodePkgDir, nodePkg, targetVersion);
      const cliPkgJson = await readInstalledPackageJson(cliPkgDir, cliPkg, targetVersion);

      const nodeEntry = path.join(nodePkgDir, 'dist', 'cli.js');
      if (!(await fileExists(nodeEntry))) {
        throw new Error(`安装产物缺少 @helm/node 守护入口 dist/cli.js：${nodeEntry}`);
      }
      const cliEntry = path.join(cliPkgDir, 'dist', 'index.js');
      if (!(await fileExists(cliEntry))) {
        throw new Error(`安装产物缺少 @helm/cli 入口 dist/index.js：${cliEntry}`);
      }
      const bin = cliPkgJson.bin;
      const binTarget =
        typeof bin === 'string' ? bin : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>).helm === 'string'
          ? (bin as Record<string, string>).helm
          : undefined;
      if (binTarget === undefined) {
        throw new Error(`@helm/cli 安装产物 package.json 缺少 helm bin 声明（${path.join(cliPkgDir, 'package.json')}）`);
      }
      const binFile = path.resolve(cliPkgDir, binTarget);
      if (!(await fileExists(binFile))) {
        throw new Error(`@helm/cli bin 目标文件不存在：${binFile}`);
      }

      entryRelative = path.relative(stagingDir, nodeEntry);
      binRelative = 'node_modules/.bin';
    }

    // 候选目录 immutable：staging 原子改名为 releases/<ver>/<uuid>，永不复用/删除。
    const candidateDir = path.join(versionRoot, randomUUID());
    await fs.rename(stagingDir, candidateDir);
    const finalEntry = path.join(candidateDir, entryRelative);
    const finalBin = path.join(candidateDir, binRelative);

    const marker: CompleteMarker = {
      version: targetVersion,
      candidateDir,
      entryPath: finalEntry,
      cliBinDir: finalBin,
      completedAt: new Date().toISOString(),
      origin: options?.stageExtractor ? 'extractor' : 'npm',
    };
    await writeSecureJson(completePath, marker);

    return { version: targetVersion, releaseDir: candidateDir, entryPath: finalEntry, cliBinDir: finalBin };
  } catch (error) {
    // 只清理本次 staging（未改名的半成品）；历史候选一律保留。
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

// —— 升级事务 ——————————————————————————————————————————————————————

const UPGRADE_BLOCK_COOLDOWN_MS = (): number => {
  const raw = Number(process.env.HELM_UPGRADE_BLOCK_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30 * 60 * 1000;
};

const DRAIN_POLL_INTERVAL_MS = 50;

/** 跨进程升级锁：upgrade.lock（O_CREAT|O_EXCL）。不做陈锁仲裁，占用即显式拒绝。 */
async function withUpgradeLock<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(dataDir, 'upgrade.lock');
  await fs.mkdir(dataDir, { recursive: true });
  let handle: FileHandle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new UpgradeRejectedError(`升级已在进行中（锁文件已存在：${lockPath}）`);
    }
    throw new Error(`创建升级锁失败（${lockPath}）：${code ?? (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    await handle.write(`${process.pid} ${new Date().toISOString()}\n`);
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function performNodeUpgrade(
  dataDir: string,
  options?: PerformNodeUpgradeOptions,
): Promise<NodeUpgradeResult> {
  return withUpgradeLock(dataDir, async () => {
    if (!options?.prepareReplacement) {
      // 没有受管 daemon 提交点就没有真实 PID，明确拒绝而不是伪造。
      throw new UpgradeRejectedError(
        '拒绝升级：未提供 prepareReplacement（helm-node 升级需要受管 daemon 完成注册与激活提交，不伪造 PID）',
      );
    }

    const previousVersion =
      options?.currentVersion ?? (await readCurrentRelease(dataDir))?.version ?? getNodeVersion();

    let targetVersion: string;
    if (options?.targetVersion !== undefined && options.targetVersion !== '') {
      targetVersion = normalizeTargetVersion(options.targetVersion);
    } else {
      const check = await checkNodeUpgrade(dataDir, {
        registryUrl: options?.registryUrl,
        currentVersion: previousVersion,
        fetchFn: options?.fetchFn,
      });
      targetVersion = check.latestVersion;
    }

    if (!options?.force && targetVersion === previousVersion) {
      return { ok: true, previousVersion, targetVersion, upgraded: false };
    }

    if (!options?.force && compareSemver(targetVersion, previousVersion) < 0) {
      throw new UpgradeRejectedError(
        `拒绝从 ${previousVersion} 降级到 ${targetVersion}（防降级保护；如确需降级请使用 force）`,
      );
    }

    const blocked = await readBlockedRelease(dataDir);
    if (blocked && blocked.version === targetVersion && !options?.force) {
      const blockedAtMs = Date.parse(blocked.at);
      const withinCooldown = Number.isFinite(blockedAtMs) && Date.now() - blockedAtMs < UPGRADE_BLOCK_COOLDOWN_MS();
      if (withinCooldown) {
        throw new UpgradeRejectedError(`版本 ${targetVersion} 处于失败冷却期，拒绝重试：${blocked.reason}（blocked at ${blocked.at}）`);
      }
    }

    // 旧 current 快照在进入 drain 前读取：drain 之后的一切失败都走统一回滚路径。
    const existingCurrent = await readCurrentRelease(dataDir);

    const attemptId = options?.attemptId ?? randomUUID();
    let committed = false;
    // 提交未确认分支（UpgradeCommitUnconfirmedError）也不释放 gate：新版本可能已激活。
    let keepGate = false;
    let gateReleased = false;
    const releaseGate = async () => {
      if (gateReleased) return;
      gateReleased = true;
      options?.setDraining?.(false);
    };
    /** 写 blocked 失败不吞：附在错误中如实上报。 */
    const writeBlockedOrFail = async (reason: string): Promise<string> => {
      try {
        await writeBlockedRelease(dataDir, { version: targetVersion, reason, at: new Date().toISOString() });
        return `已写入版本 ${targetVersion} 的 blocked 记录`;
      } catch (blockedError) {
        return `写入 blocked 记录失败（需人工处理）：${blockedError instanceof Error ? blockedError.message : String(blockedError)}`;
      }
    };

    try {
      const staged = await stageReleaseFromNpm(dataDir, targetVersion, {
        registryUrl: options?.registryUrl,
        fetchFn: options?.fetchFn,
        stageExtractor: options?.stageExtractor,
        force: options?.force,
      });

      // 进入排空：停止受理新命令，等待已受理 exec 全部结束（不强杀）。
      options?.setDraining?.(true);

      const getActiveExecCount = options?.getActiveExecCount ?? (() => 0);
      const drainTimeoutMs = options?.drainTimeoutMs ?? 30_000;
      const drainStart = Date.now();
      while (getActiveExecCount() > 0) {
        if (Date.now() - drainStart > drainTimeoutMs) {
          throw new Error(`等待在途命令排空超时（${drainTimeoutMs}ms，剩余 ${getActiveExecCount()} 个），本次升级已放弃且未做任何变更`);
        }
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
      }

      let replacement: PreparedNodeReplacement;
      try {
        replacement = await options.prepareReplacement(staged, { attemptId, previousVersion, targetVersion });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const blockedNote = await writeBlockedOrFail(reason);
        throw new Error(
          `准备替换 daemon 失败（升级到 ${targetVersion} 中止，current 未变更，宿主保持接管状态）：${reason}；${blockedNote}`,
        );
      }

      // 提交点：一切可能影响成败的文件操作（含清理 blocked）都在 commit 之前完成；
      // commit 是最后的 fallible 提交步骤，之后仅剩非关键通知，不得因清理失败
      // 误报升级失败（否则新进程已向 Hub 回报提交而旧进程永久 draining）。
      try {
        await writeCurrentRelease(dataDir, {
          version: targetVersion,
          entryPath: staged.entryPath,
          cliBinDir: staged.cliBinDir,
          updatedAt: new Date().toISOString(),
        });
        await clearBlockedRelease(dataDir);
        await replacement.commit();
      } catch (error) {
        if (error instanceof UpgradeCommitUnconfirmedError) {
          // 特殊分支：activate 已发出、候选可能已向 Hub 上报 commit，仅本机确认
          // 丢失。反向回滚会让 Hub 已成功的升级被本地 ACK 超时撤销——因此不
          // abort、不回滚 current、不写 blocked；保持新 current 与 gate，旧宿主
          // 让位，由候选幂等重试 Hub commit。
          options?.onScheduleShutdown?.(replacement.pid);
          keepGate = true;
          throw new Error(
            `升级到 ${targetVersion}：新版本已选择，激活结果未确认（${error.message}）。不回滚：current.json 已指向 ${targetVersion}，候选将幂等重试向 Hub 提交，旧宿主已安排退出`,
            { cause: error },
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        const rollbackNotes: string[] = [];
        try {
          await replacement.abort();
          rollbackNotes.push('replacement 已 abort');
        } catch (abortError) {
          rollbackNotes.push(`replacement abort 失败：${abortError instanceof Error ? abortError.message : String(abortError)}`);
        }
        try {
          if (existingCurrent) {
            await writeCurrentRelease(dataDir, existingCurrent);
            rollbackNotes.push(`current.json 已还原到 ${existingCurrent.version}`);
          } else {
            await deleteCurrentRelease(dataDir);
            rollbackNotes.push('current.json 已删除（此前不存在）');
          }
        } catch (restoreError) {
          rollbackNotes.push(`current.json 还原失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
        rollbackNotes.push(await writeBlockedOrFail(reason));
        throw new Error(
          `升级到 ${targetVersion} 提交失败，已回滚到 ${previousVersion}：${reason}；回滚详情：${rollbackNotes.join('；')}`,
        );
      }

      // 提交已成：旧宿主让位（gate 保持 draining，等待退出）；清理失败不再影响结果。
      committed = true;
      options?.onScheduleShutdown?.(replacement.pid);

      return { ok: true, previousVersion, targetVersion, upgraded: true, pid: replacement.pid };
    } finally {
      // 任何失败（含回调抛错、读取损坏、写 blocked 失败）都解除 gate；成功与
      // 提交未确认路径不解除（旧宿主即将退出，新宿主已接管或可能已接管）。
      if (!committed && !keepGate) await releaseGate();
    }
  });
}
