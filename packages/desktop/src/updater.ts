/**
 * npm payload update (real implement).
 *
 * lifecycle (three segment style: install and activate separate, start verify ownership desktop shell,updater unaware of Hub):
 * 1. stage(target):registry metadata strong validate (strictly SemVer)→ download tgz(sha512 streaming validate)→
 *    staging unwrap (payload-tar.ts containment strong validate)→ manifest contract validate (contains and registry
 *    meta  name/version consistency, do not only format)→ `start.mjs check` verify (exit 3 dependency missing when
 *    via can inject NpmInstaller install produce dependency after re- inspect)→ atomic promote rise to
 *    releases/<name>/<version>/<uuid> cannot change directory (never heavy naming/delete since has version directory)→
 *    atomic write pending.json;current.json do not motion;
 * 2. desktop shell with pending entry start new version: health then activate(info)- -previous.json save old
 *    baseline,current.json atomic switch, clear the same pending; failed to start then reject(info, error)- -
 *    record blocked.json,current keep do not motion, clear the same pending, do not modify any release directory;
 * 3. resolveCurrent / resolvePending / resolvePrevious read when strictly re- verify (state file and release
 *    manifest  name/version consistent,entryPath and manifest entries.hub consistent,containment,
 *    reject Windows absolute/symbol each other for/backslash path form), corrupt explicit errors, never static default when empty state.
 *
 * check() update decide: trace latest when only more large SemVertreated as can update (registry latest fall back do not mistakenly report);
 * explicit lock version (HELM_PAYLOAD_VERSION / pinnedVersion) by user intent than for each other etc..
 *
 * lifecycle boundary:updater only manage system product - - do not restart Hub, unaware of conversation, do not invoke Hub API. concurrency install
 * by fail-closed file lock serial (payload-lock.ts): lock by occupy only has boundary wait for, never automatically take over.
 * failed to install by system product defect class error code record blocked.json, when before version never break.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, openSync, closeSync, writeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DesktopError } from './errors.js';
import type { DesktopConfig } from './config.js';
import { KERNEL_NODE_FLOOR, compareStrictSemver, isStrictSemver, probeMeetsFloor, probeRunner, SemverFormatError } from './runners.js';
import { extractTarGzip } from './payload-tar.js';
import { PayloadFileLock } from './payload-lock.js';
import { readJsonState, writeJsonAtomic } from './payload-json.js';
import { HostNpmInstaller, type NpmInstaller } from './npm-installer.js';

// ---- public contract ----

export interface PayloadInfo {
  readonly name: string;
  readonly version: string;
  /** release directory (absolute path,releases/<name>/<version>/<uuid> cannot change directory);stage after store in. */
  readonly releaseDir?: string;
  /** Hub entry (absolute path, from payload manifest entries.hub; non- start.mjs). */
  readonly entryPath?: string;
  /** spawn additional parameter (contract on constant empty:hub entry directly start). */
  readonly entryArgs?: readonly string[];
}

export type PayloadUpdateReason = 'updater_not_configured' | 'up_to_date' | 'latest_blocked';

export interface PayloadUpdateStatus {
  updateAvailable: boolean;
  current: PayloadInfo | null;
  /** registry side most new (or lock) version;entryPath install after only then known. */
  latest: PayloadInfo | null;
  /** updateAvailable=false when reason;true when omit (current is null i.e. first time install). */
  reason?: PayloadUpdateReason;
  /** reason=latest_blocked when failed summary. */
  blocked?: { code: string; message: string; at: string };
}

export interface PayloadInstallTarget {
  name: string;
  /** semantics version number, or 'latest'(trace dist-tags). */
  version: string;
}

export interface PayloadUpdater {
  readonly id: string;
  check(): Promise<PayloadUpdateStatus>;
  /** download and verify target version, write pending.json wait for activate decide protocol; does not affect current. can repeat execution. */
  stage(target: PayloadInstallTarget): Promise<PayloadInfo>;
  /** activate already stage system product:previous.json save old baseline,current.json atomic switch, clear the same pending. */
  activate(info: PayloadInfo): Promise<void>;
  /** reject already stage system product: record blocked.json, keep current, clear the same pending, do not motion any release directory. */
  reject(info: PayloadInfo, error: Error): Promise<void>;
  /** when before takes effect system product; without then null; state do not satisfy contract when explicit throws. */
  resolveCurrent(): PayloadInfo | null;
  /** await decide protocol already stage system product (pending.json); without then null; corrupt explicit throws. */
  resolvePending(): PayloadInfo | null;
  /** most near once activate before baseline(previous.json); without then null; corrupt explicit throws. */
  resolvePrevious(): PayloadInfo | null;
}

// ---- state file shape ----

/** current.json / pending.json / previous.json shared use shape (at = write moment). */
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

/** system product defect class error code: retry without intent meaning, record blocked.json block assert the version. */
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

// ---- strictly SemVer: unique implement in runners.ts(desktop independent of work zone package, and @helm/protocol/semver same contract) ----

/**
 * sort or cannot compare semantics (keep since has export contract: consumer bootstrap.ts dependency null decide).
 * internal need to explicit reject semantics path (such as isNewerTarget) directly use compareStrictSemver(illegal throws).
 */
export function compareSemVer(a: string, b: string): number | null {
  try {
    return compareStrictSemver(a, b);
  } catch (error) {
    if (error instanceof SemverFormatError) return null;
    throw error;
  }
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

// ---- real update ----

export interface NpmPayloadUpdaterOptions {
  /** npm package name (required, can contains scope; do not hard encode any @helm name). */
  packageName: string;
  /** registry base URL(default public npm registry). */
  registry?: string;
  /** lock precise version; default trace dist-tags.latest. */
  pinnedVersion?: string;
  /** payload manage directory (<dataDir>/payload). */
  payloadRoot: string;
  fetchImpl?: typeof fetch;
  /** dependency install; do not provide then dependency missing when explicit errors (not silently skip). */
  npmInstaller?: NpmInstaller;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  isElectron?: boolean;
  stderrTailLines?: number;
  metadataTimeoutMs?: number;
  downloadTimeoutMs?: number;
  checkTimeoutMs?: number;
  /** install mutual exclusion lock has boundary while waiting long (fail-closed: occupy i.e. wait for/timeout, never take over). */
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
   * target version each other for current is otherwise value obtain update:
   * - trace latest: only strictly more large SemVer only then compute update (registry latest fall back/hold flat do not mistakenly report);
   * - explicit lock version (pinnedVersion): user explicit intent, version different i.e. compute update (allows fall back swap install).
   */
  private isNewerTarget(currentVersion: string, targetVersion: string): boolean {
    if (this.pinnedVersion !== undefined && this.pinnedVersion !== 'latest') return currentVersion !== targetVersion;
    // two side version all from already via strictly validate manifest/meta, illegal belong state corrupt: explicit throws, not silently when act no need to update.
    return compareStrictSemver(currentVersion, targetVersion) < 0;
  }

  // ---- stage: download verify + pending, do not motion current ----

  async stage(target: PayloadInstallTarget): Promise<PayloadInfo> {
    if (target.name !== this.packageName) {
      throw new DesktopError(
        'updater_target_mismatch',
        `install target ${target.name} and config payload package ${this.packageName} inconsistent`,
      );
    }
    const versionSpec = target.version.length > 0 ? target.version : 'latest';
    return await this.lock.run(async () => this.stageLocked(versionSpec));
  }

  private async stageLocked(versionSpec: string): Promise<PayloadInfo> {
    const stagingRoot = path.join(this.payloadRoot, 'staging');
    // hold lock clean up crash legacy staging:fail-closed lock guarantee right now without other install.
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
          `${blockedKey} this before already by reject/failed to install (${blockedEntry.code}: ${blockedEntry.message})`,
          { blocked: blockedEntry },
        );
      }
      // idempotent fast path 1: same version pending still await decide protocol and system product completely well → does not repeat download.
      const pending = this.resolvePendingSoft();
      if (pending !== null && pending.name === meta.name && pending.version === meta.version) {
        return pending;
      }
      // idempotent fast path 2: target version i.e. when before takes effect version → directly with await activate identity re- use (do not heavy download, do not destroy current).
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

      const { hubEntryPath, launcherPath } = this.loadPayloadManifest(extractDir, meta);
      await this.verifyWithInstaller(extractDir, launcherPath);
      const info = this.promoteToImmutable(extractDir, meta, hubEntryPath);
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

  // ---- activate / reject:pending decide protocol ----

  async activate(info: PayloadInfo): Promise<void> {
    await this.lock.run(async () => {
      const state = this.validateInfo(info, 'payload_activate_invalid');
      // current corrupt when explicit throws (fail-closed): cannot in old state cannot message when static default swap install.
      const current = this.resolveCurrent();
      const at = new Date().toISOString();
      if (current !== null && current.releaseDir !== state.releaseDir) {
        writeJsonAtomic(this.previousFile, this.stateOf(current, at));
      }
      this.clearPendingFor(state.name, state.version);
      // current is finally a can failed commit step, after commit must not again throws trigger reverse restore.
      writeJsonAtomic(this.currentFile, { ...state, at });
    });
  }

  async reject(info: PayloadInfo, error: Error): Promise<void> {
    await this.lock.run(async () => {
      const problems: string[] = [];
      if (info.name !== this.packageName) problems.push(`name and config payload package inconsistent: ${info.name}`);
      if (typeof info.version !== 'string' || !isStrictSemver(info.version)) {
        problems.push(`version is not legal SemVer: ${String(info.version)}`);
      }
      if (problems.length > 0) {
        throw new DesktopError('payload_reject_invalid', 'reject reference do not satisfy contract', { problems });
      }
      // reject is explicit decide protocol: regardless of error class other one rule record blocked(environment class error in stage internal already stream, do not away to this in).
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

  // ---- state read (strictly re- verify) ----

  resolveCurrent(): PayloadInfo | null {
    return this.readStateInfo(this.currentFile, 'current.json', 'current_payload_invalid');
  }

  resolvePending(): PayloadInfo | null {
    return this.readStateInfo(this.pendingFile, 'pending.json', 'pending_payload_invalid');
  }

  resolvePrevious(): PayloadInfo | null {
    return this.readStateInfo(this.previousFile, 'previous.json', 'previous_payload_invalid');
  }

  /** pending fast path dedicated use: corrupt/expires treated as without await decide protocol (pending is derive state, heavy stage will override). */
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

  /** activate reference re- use state file the whole set strictly validate (do not, only verify). */
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
      'activate reference',
      code,
    );
  }

  /** state file strictly validate: shape + path form (refuse Windows form)+ containment + store in + manifest consistent. */
  private validateState(raw: unknown, what: string, code: string): PayloadState {
    const problems: string[] = [];
    const s = (raw ?? {}) as Partial<PayloadState>;
    if (s.formatVersion !== 1) problems.push(`formatVersion must is 1, actual ${JSON.stringify(s.formatVersion)}`);
    if (typeof s.name !== 'string' || s.name.length === 0 || s.name.includes('\\') || s.name.includes('..')) {
      problems.push(`name missing or illegal: ${JSON.stringify(s.name)}`);
    } else if (s.name !== this.packageName) {
      problems.push(`name and updater config payload package inconsistent: ${s.name}`);
    }
    if (typeof s.version !== 'string' || !isStrictSemver(s.version)) {
      problems.push(`version is not legal SemVer: ${JSON.stringify(s.version)}`);
    }
    const releaseDirOk = this.checkManagedPath(s.releaseDir, problems, 'releaseDir');
    const entryPathOk = this.checkManagedPath(s.entryPath, problems, 'entryPath');
    if (s.entryArgs !== undefined && (!Array.isArray(s.entryArgs) || s.entryArgs.some((a) => typeof a !== 'string'))) {
      problems.push('entryArgs must be string array');
    }
    if (releaseDirOk) {
      const containment = path.relative(this.payloadRoot, s.releaseDir!);
      if (containment.startsWith('..') || path.isAbsolute(containment)) {
        problems.push('releaseDir escape payload manage directory');
      } else {
        if (!existsSync(s.releaseDir!) || !statSync(s.releaseDir!).isDirectory()) {
          problems.push(`releaseDir missing: ${s.releaseDir}`);
        }
        if (entryPathOk) {
          const entryContainment = path.relative(s.releaseDir!, s.entryPath!);
          if (entryContainment.startsWith('..') || path.isAbsolute(entryContainment)) {
            problems.push('entryPath escape releaseDir');
          } else if (!existsSync(s.entryPath!)) {
            problems.push(`entryPath missing: ${s.entryPath}`);
          }
        }
        if (typeof s.name === 'string' && s.name.length > 0 && typeof s.version === 'string' && s.version.length > 0) {
          this.validateReleaseManifest(s.releaseDir!, s.name, s.version, entryPathOk ? s.entryPath! : null, problems);
        }
      }
    }
    if (problems.length > 0) {
      throw new DesktopError(code, `installed payload state do not satisfy contract (${what})`, { what, problems });
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

  /** state file store local machine absolute path;Windows local machine symbol and UNC path by after continue containment verify. */
  private checkManagedPath(value: unknown, problems: string[], what: string): value is string {
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`${what} missing or non- string`);
      return false;
    }
    if (!path.isAbsolute(value)) {
      problems.push(`${what} must be local machine absolute path: ${value}`);
      return false;
    }
    if (process.platform !== 'win32' && (/^[A-Za-z]:/.test(value) || value.includes('\\'))) {
      problems.push(`${what} contains other platform path form: ${value}`);
      return false;
    }
    return true;
  }

  /** release directory manifest re- verify:name/version and state file consistent,entryPath and entries.hub consistent. */
  private validateReleaseManifest(releaseDir: string, name: string, version: string, entryPath: string | null, problems: string[]): void {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
    } catch (error) {
      problems.push(`release manifest.json missing or illegal JSON(${error instanceof Error ? error.message : String(error)})`);
      return;
    }
    const m = (manifest ?? {}) as Record<string, unknown>;
    if (m['formatVersion'] !== 1) problems.push('release manifest formatVersion must is 1');
    if (m['name'] !== name) problems.push(`release manifest name and state inconsistent: ${JSON.stringify(m['name'])} ≠ ${JSON.stringify(name)}`);
    if (m['version'] !== version) {
      problems.push(`release manifest version and state inconsistent: ${JSON.stringify(m['version'])} ≠ ${JSON.stringify(version)}`);
    }
    const entries = m['entries'];
    const entriesRecord = typeof entries === 'object' && entries !== null ? (entries as Record<string, unknown>) : {};
    const hubRel = entriesRecord['hub'];
    if (typeof hubRel !== 'string' || hubRel.length === 0) {
      problems.push('release manifest entries.hub missing');
      return;
    }
    const contained: string[] = [];
    const resolved = this.containedIn(releaseDir, hubRel, contained, 'entries.hub');
    if (contained.length > 0) {
      problems.push(...contained);
      return;
    }
    if (entryPath !== null && resolved !== path.resolve(entryPath)) {
      problems.push(`entryPath and manifest entries.hub inconsistent: ${entryPath} ≠ ${resolved}`);
    }
  }

  /** clear and (name, version) match pending(other version await decide protocol keep). */
  private clearPendingFor(name: string, version: string): void {
    const raw = readJsonState(this.pendingFile, 'pending.json');
    if (raw === undefined) return;
    const pending = raw as Partial<PayloadState>;
    if (pending.name !== name || pending.version !== version) return;
    rmSync(this.pendingFile, { force: true });
  }

  // ---- registry metadata ----

  private async fetchRegistryVersion(spec: string): Promise<RegistryVersion> {
    if (spec !== 'latest' && !isStrictSemver(spec)) {
      throw new DesktopError('registry_metadata_invalid', `version note symbol is not legal SemVer: ${spec}`);
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
        `registry metadata failed to get: ${url}(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (!response.ok) {
      throw new DesktopError('registry_metadata_failed', `registry metadata failed to get: HTTP ${response.status} ${url}`);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new DesktopError(
        'registry_metadata_failed',
        `registry metadata failed to read: ${url}(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (text.length > 32 * 1024 * 1024) {
      throw new DesktopError('registry_metadata_failed', `registry metadata over limit (>32MiB): ${url}`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (error) {
      throw new DesktopError(
        'registry_metadata_failed',
        `registry metadata is not legal JSON: ${url}(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return this.validateRegistryVersion(doc, spec);
  }

  /** boundary strong validate:name/strictly SemVer version/dist.integrity(sha512)/dist.tarball any one do not satisfy explicit reject. */
  private validateRegistryVersion(doc: unknown, spec: string): RegistryVersion {
    const problems: string[] = [];
    const d = (doc ?? {}) as Record<string, unknown>;
    if (d['name'] !== this.packageName) problems.push(`document name and request package name inconsistent: ${JSON.stringify(d['name'])}`);
    const distTags = d['dist-tags'];
    const latestTag = typeof distTags === 'object' && distTags !== null ? (distTags as Record<string, unknown>)['latest'] : undefined;
    const version = spec === 'latest' ? latestTag : spec;
    if (typeof version !== 'string' || !isStrictSemver(version)) {
      problems.push(`cannot parse legal SemVer target version (spec=${spec},latest tag=${JSON.stringify(latestTag)})`);
    }
    const versions = d['versions'];
    const entry =
      typeof version === 'string' && typeof versions === 'object' && versions !== null
        ? (versions as Record<string, unknown>)[version]
        : undefined;
    if (typeof entry !== 'object' || entry === null) {
      problems.push(`registry missing version ${String(version)}`);
    }
    let integrity: unknown;
    let tarball: unknown;
    if (typeof entry === 'object' && entry !== null) {
      const e = entry as Record<string, unknown>;
      if (e['name'] !== this.packageName) problems.push(`version item name inconsistent: ${JSON.stringify(e['name'])}`);
      if (e['version'] !== version) problems.push(`version item version inconsistent: ${JSON.stringify(e['version'])}`);
      const dist = e['dist'];
      if (typeof dist === 'object' && dist !== null) {
        integrity = (dist as Record<string, unknown>)['integrity'];
        tarball = (dist as Record<string, unknown>)['tarball'];
      } else {
        problems.push('dist field missing');
      }
    }
    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
      problems.push(`dist.integrity must be sha512-<base64>, actual: ${JSON.stringify(integrity)}`);
    } else if (Buffer.from(integrity.slice('sha512-'.length), 'base64').length !== 64) {
      problems.push('dist.integrity sha512 summary length illegal (must 64 byte)');
    }
    if (typeof tarball !== 'string' || tarball.length === 0) {
      problems.push('dist.tarball missing');
    } else {
      try {
        const parsed = new URL(tarball);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          problems.push(`dist.tarball protocol illegal: ${parsed.protocol}`);
        }
      } catch {
        problems.push(`dist.tarball is not legal URL: ${tarball}`);
      }
    }
    if (problems.length > 0) {
      throw new DesktopError('registry_metadata_invalid', `registry metadata contract do not satisfy (${this.packageName}@${spec})`, {
        problems,
      });
    }
    return { name: this.packageName, version: version as string, integrity: integrity as string, tarball: tarball as string };
  }

  // ---- download and complete ----

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
        `payload tarball download failed: ${meta.tarball}(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (!response.ok || response.body === null) {
      throw new DesktopError('tarball_download_failed', `payload tarball download failed: HTTP ${response.status} ${meta.tarball}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxTarballBytes) {
      throw new DesktopError('tarball_too_large', `payload tarball exceeds cap (${declared} > ${this.maxTarballBytes} byte)`);
    }
    const expected = Buffer.from(meta.integrity.slice('sha512-'.length), 'base64');
    const hash = createHash('sha512');
    const fh = openSync(destFile, 'w');
    let total = 0;
    let tooLarge = false;
    // Node fetch  body runtime can async iterate, but DOM lib type not declaration; explicit assertion is AsyncIterable.
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
        `payload tarball download interrupt: ${meta.tarball}(${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      closeSync(fh);
    }
    if (tooLarge) {
      rmSync(destFile, { force: true });
      throw new DesktopError('tarball_too_large', `payload tarball download exceeds cap (> ${this.maxTarballBytes} byte)`);
    }
    const actual = hash.digest();
    if (!actual.equals(expected)) {
      rmSync(destFile, { force: true });
      throw new DesktopError(
        'tarball_integrity_mismatch',
        `payload tarball sha512 complete validation failed (expectation ${expected.toString('base64')}, actual ${actual.toString('base64')})`,
        { tarball: meta.tarball, version: meta.version },
      );
    }
  }

  // ---- payload manifest contract ----

  /** staging manifest contract validate;meta non-empty when also strong validate name/version and registry metadata consistent. */
  private loadPayloadManifest(
    releaseDir: string,
    meta: RegistryVersion | null,
  ): { hubEntryPath: string; launcherPath: string } {
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
    } catch (error) {
      throw new DesktopError(
        'payload_manifest_invalid',
        `payload manifest.json missing or illegal JSON: ${error instanceof Error ? error.message : String(error)}`,
        { releaseDir },
      );
    }
    const problems: string[] = [];
    const m = (manifest ?? {}) as Record<string, unknown>;
    if (m['formatVersion'] !== 1) problems.push(`formatVersion must is 1, actual ${JSON.stringify(m['formatVersion'])}`);
    if (meta !== null) {
      if (m['name'] !== meta.name) problems.push(`manifest name and registry metadata inconsistent: ${JSON.stringify(m['name'])} ≠ ${JSON.stringify(meta.name)}`);
      if (m['version'] !== meta.version) {
        problems.push(`manifest version and registry metadata inconsistent: ${JSON.stringify(m['version'])} ≠ ${JSON.stringify(meta.version)}`);
      }
    }
    const entries = m['entries'];
    const entriesRecord = typeof entries === 'object' && entries !== null ? (entries as Record<string, unknown>) : {};
    const hubRel = entriesRecord['hub'];
    const launcherRel = typeof entriesRecord['launcher'] === 'string' && entriesRecord['launcher'].length > 0 ? entriesRecord['launcher'] : 'start.mjs';
    if (typeof hubRel !== 'string' || hubRel.length === 0) {
      problems.push('entries.hub missing (Hub entry declaration)');
    } else if (hubRel === launcherRel || hubRel === 'start.mjs') {
      problems.push('entries.hub must not points to launcher(start.mjs is carries command parameter start, is not Hub entry)');
    }
    let hubEntryPath: string | null = null;
    if (typeof hubRel === 'string') {
      hubEntryPath = this.containedIn(releaseDir, hubRel, problems, 'entries.hub');
    }
    const launcherPath = this.containedIn(releaseDir, launcherRel, problems, 'entries.launcher');
    if (hubEntryPath !== null && !existsSync(hubEntryPath)) problems.push(`entries.hub file missing: ${hubRel}`);
    if (!existsSync(launcherPath)) problems.push(`launcher file missing: ${launcherRel}`);
    if (problems.length > 0) {
      throw new DesktopError('payload_manifest_invalid', 'payload manifest contract do not satisfy', { releaseDir, problems });
    }
    return { hubEntryPath: hubEntryPath!, launcherPath };
  }

  /** relative path containment parse (manifest declaration same cannot escape releaseDir, and reject Windows form: symbol prefix and backslash). */
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
      problems.push(`${what} declaration path illegal: ${rel}`);
      return path.join(rootDir, 'invalid');
    }
    return path.resolve(rootDir, normalized);
  }

  // ---- start.mjs check verify + dependency install ----

  private async verifyWithInstaller(releaseDir: string, launcherPath: string): Promise<void> {
    const first = await this.runStartCheck(releaseDir, launcherPath);
    if (first.code === 0) return;
    if (first.code === 3) {
      if (this.npmInstaller === undefined) {
        throw new DesktopError(
          'payload_deps_missing',
          'payload runtime dependency missing and not config NpmInstaller(npm tarball excludes node_modules; production by default host npm, see packages/payload/README.md)',
          { releaseDir, stdoutTail: first.stdoutTail, stderrTail: first.stderrTail },
        );
      }
      await this.npmInstaller.install(releaseDir);
      const second = await this.runStartCheck(releaseDir, launcherPath);
      if (second.code === 0) return;
      if (second.code === 3) {
        throw new DesktopError('payload_deps_unresolved', `NpmInstaller(${this.npmInstaller.id}) execute after payload still report dependency missing`, {
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
    return new DesktopError('payload_check_failed', `payload start check verify failed (exit ${run.code})`, {
      releaseDir,
      stdoutTail: run.stdoutTail,
      stderrTail: run.stderrTail,
    });
  }

  /** run payload self carries start.mjs check(real contract:0 via / 1 layout corrupt / 3 dependency missing). */
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
          new DesktopError('payload_check_failed', `payload start check timeout (${this.checkTimeoutMs}ms)`, {
            releaseDir,
            stderrTail,
          }),
        );
      }, this.checkTimeoutMs);
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new DesktopError('payload_check_failed', `payload check cannot execute: ${error.message}`, { releaseDir }));
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

  /** choose can run check  Node: and runners.ts the same capability probe (>= floor and node:sqlite). */
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
        // host Node choose; all unavailable when under way explicit errors
      }
    }
    const hostNode = this.isElectron ? 'node' : this.execPath;
    const probe = await probeRunner(hostNode, { env: this.env });
    if (!probeMeetsFloor(probe)) {
      throw new DesktopError(
        'payload_check_node_unavailable',
        `cannot found can run payload check  Node(must >= ${KERNEL_NODE_FLOOR} and node:sqlite; actual Node ${probe.node},sqlite=${probe.sqlite})`,
        { hostNode },
      );
    }
    this.checkNode = { executable: hostNode, env: { ...this.env } };
    return this.checkNode;
  }

  // ---- promote rise is cannot change release ----

  private releaseDirFor(name: string, version: string): string {
    const segments = name.split('/');
    for (const segment of segments) {
      if (segment.length === 0 || segment === '.' || segment === '..' || segment.includes('\\')) {
        throw new DesktopError('registry_metadata_invalid', `package name unavailable act path: ${name}`);
      }
    }
    if (!isStrictSemver(version)) {
      throw new DesktopError('registry_metadata_invalid', `version number is not legal SemVer: ${version}`);
    }
    return path.join(this.payloadRoot, 'releases', ...segments, version);
  }

  /**
   * atomic promote rise to releases/<name>/<version>/<uuid> cannot change directory: each time stage generate new uuid,
   * never heavy naming/delete since has version directory (same version heavy install and store, activate by current.json pointer decide).
   * promote rise failed (such as directory by occupy file block) explicit errors, since has current and other version directory do not subject to affect.
   */
  private promoteToImmutable(extractDir: string, meta: RegistryVersion, hubEntryPath: string): PayloadInfo {
    const versionRoot = this.releaseDirFor(meta.name, meta.version);
    try {
      mkdirSync(versionRoot, { recursive: true });
    } catch (error) {
      throw new DesktopError(
        'payload_promote_failed',
        `release version directory cannot create: ${versionRoot}(${error instanceof Error ? error.message : String(error)})`,
        { versionRoot },
      );
    }
    const entryRel = path.relative(extractDir, hubEntryPath);
    for (let attempt = 0; attempt < 8; attempt++) {
      const releaseDir = path.join(versionRoot, randomBytes(8).toString('hex'));
      if (existsSync(releaseDir)) continue;
      try {
        renameSync(extractDir, releaseDir);
      } catch (error) {
        throw new DesktopError(
          'payload_promote_failed',
          `release directory swap name failed: ${releaseDir}(${error instanceof Error ? error.message : String(error)})`,
          { releaseDir },
        );
      }
      return { name: meta.name, version: meta.version, releaseDir, entryPath: path.join(releaseDir, entryRel), entryArgs: [] };
    }
    throw new DesktopError('payload_promote_failed', `cannot generate not occupy release directory (many time uuid conflict): ${versionRoot}`, {
      versionRoot,
    });
  }

  // ---- blocked.json maintain ----

  private readBlocked(): BlockedState {
    const raw = readJsonState(this.blockedFile, 'blocked.json');
    if (raw === undefined) return { formatVersion: 1, entries: {} };
    const b = raw as Partial<BlockedState>;
    if (b.formatVersion !== 1 || typeof b.entries !== 'object' || b.entries === null) {
      throw new DesktopError('blocked_state_invalid', 'blocked.json already corrupt (shape do not satisfy contract)', { blockedFile: this.blockedFile });
    }
    return { formatVersion: 1, entries: b.entries };
  }

  private writeBlockedEntry(entry: BlockedEntry): void {
    let state: BlockedState;
    try {
      state = this.readBlocked();
    } catch {
      // blocked.json corrupt when original error takes precedence on throw; this where do not stack add side message path failed
      return;
    }
    state.entries[`${entry.name}@${entry.version}`] = entry;
    // over limit eliminate most old (object key keep insert order).
    const keys = Object.keys(state.entries);
    if (keys.length > BLOCKED_MAX_ENTRIES) {
      for (const key of keys.slice(0, keys.length - BLOCKED_MAX_ENTRIES)) delete state.entries[key];
    }
    try {
      writeJsonAtomic(this.blockedFile, state);
    } catch {
      // record failed do not mask install error
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
      // same on: install already succeeded, side message path failed do not on throw
    }
  }
}

// ---- not config implement (honest declaration, does not pretend to be) ----

export class UnconfiguredPayloadUpdater implements PayloadUpdater {
  readonly id = 'unconfigured';

  async check(): Promise<PayloadUpdateStatus> {
    return { updateAvailable: false, current: null, latest: null, reason: 'updater_not_configured' };
  }

  async stage(_target: PayloadInstallTarget): Promise<never> {
    throw new DesktopError(
      'updater_not_configured',
      'not config payload npm package name (HELM_PAYLOAD_PACKAGE or overrides.payloadPackage), cannot automatically install',
    );
  }

  async activate(_info: PayloadInfo): Promise<never> {
    throw new DesktopError('updater_not_configured', 'not config payload npm package name, cannot activate payload');
  }

  async reject(_info: PayloadInfo, _error: Error): Promise<never> {
    throw new DesktopError('updater_not_configured', 'not config payload npm package name, cannot record payload reject');
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

// ---- work vendor ----

export interface PayloadUpdaterDeps {
  fetchImpl?: typeof fetch;
  npmInstaller?: NpmInstaller;
  execPath?: string;
  isElectron?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** by config choose updater: not config package name → honest return UnconfiguredPayloadUpdater. */
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
