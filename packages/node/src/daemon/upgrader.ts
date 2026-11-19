/**
 * `helmx-node` self-upgrade adapter over the shared update engine in `@helmx/env-io`.
 *
 * Node-specific policy kept here:
 * - the node package release layout (`@helmx/node`, package name via `HELMX_NPM_PACKAGE`, read at call time);
 * - the launcher-compatible flat `current.json` disk contract
 *   `{version, entryPath, cliBinDir?, updatedAt}` — an already-installed launcher reads
 *   `entryPath` directly after a self-upgrade, so the shared entries-map state stays an
 *   internal engine shape and never reaches this product's disk (injected `stateOps`);
 * - the daemon's own version resolution (`getNodeVersion` reads this package's
 *   `package.json`; `HELMX_VERSION_OVERRIDE` overrides for dev).
 *
 * All generic mechanism — registry access, SHA-512 SRI verified staging, immutable
 * `.complete` candidates, `upgrade.lock`, drain gate, strict commit-at-replacement
 * ordering, rollback plus cooldown — lives in `@helmx/env-io`'s update engine. Error classes are
 * re-exported from the single shared module copy so `instanceof` identity holds.
 */
import fs from 'node:fs/promises';
import rawFs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isStrictSemver, type NodeUpgradeCheckResult, type NodeUpgradeResult } from '@helmx/protocol';
import { atomicWriteJson } from '@helmx/env-io';
import {
  UpgradeCommitUnconfirmedError,
  UpgradeRejectedError,
  checkForUpdate,
  clearBlockedRelease,
  compareSemver,
  filterRpcRegistryUrl,
  normalizeTargetVersion,
  performUpdate,
  readBlockedRelease,
  readStateJson,
  runNpm,
  stageRelease,
  writeBlockedRelease,
  type BlockedReleaseRecord,
  type CheckForUpdateOptions,
  type CurrentReleaseRecord as EngineCurrentRecord,
  type NpmPackageSpec,
  type PerformUpdateOptions as EnginePerformOptions,
  type PreparedReplacement,
  type ReleaseLayout,
  type StagedRelease,
  type StageExtractor,
  type UpdateSpec,
  type UpdateStateOps,
} from '@helmx/env-io';

export { UpgradeRejectedError, UpgradeCommitUnconfirmedError };
export {
  compareSemver,
  normalizeTargetVersion,
  filterRpcRegistryUrl,
  runNpm,
  readBlockedRelease,
  writeBlockedRelease,
  clearBlockedRelease,
};
export type { BlockedReleaseRecord, CheckForUpdateOptions, PreparedReplacement };

/** Node entry keys inside a staged release (mirrors `StagedNodeRelease`). */
const ENTRY_KEY = 'entryPath';
const CLI_BIN_KEY = 'cliBinDir';

export interface StagedNodeRelease {
  version: string;
  /** Immutable release directory (`releases/<ver>/<uuid>`). */
  releaseDir: string;
  /** Absolute path to the node package's `dist/cli.js` entrypoint. */
  entryPath: string;
  /** Optional path to `node_modules/.bin` if staged by a legacy extractor. */
  cliBinDir?: string;
}

export type PreparedNodeReplacement = PreparedReplacement;

export interface PerformNodeUpgradeOptions {
  targetVersion?: string;
  registryUrl?: string;
  force?: boolean;
  attemptId?: string;
  currentVersion?: string;
  fetchFn?: typeof fetch;
  stageExtractor?: (stagingDir: string, targetVersion: string) => Promise<{ entryPath: string; cliBinDir?: string }>;
  prepareReplacement?: (
    release: StagedNodeRelease,
    context: { attemptId: string; previousVersion: string; targetVersion: string },
  ) => Promise<PreparedNodeReplacement>;
  /** Returns count of in-flight operations to drain before spawning replacement. */
  getActiveExecCount?: () => number;
  setDraining?: (value: boolean) => void;
  drainTimeoutMs?: number;
  onScheduleShutdown?: (pid: number) => void;
}

export interface StageReleaseOptions {
  registryUrl?: string;
  fetchFn?: typeof fetch;
  /** Test-only extractor returning relative paths inside `stagingDir` (validated against traversal). */
  stageExtractor?: (stagingDir: string, targetVersion: string) => Promise<{ entryPath: string; cliBinDir?: string }>;
  /** Bypass `.complete` cache and build a new immutable release directory without deleting older ones. */
  force?: boolean;
}

export type CheckNodeUpgradeOptions = CheckForUpdateOptions;

/** Launcher-compatible active release pointer (`current.json`, flat Node disk contract). */
export interface CurrentReleaseRecord {
  version: string;
  entryPath: string;
  updatedAt: string;
  cliBinDir?: string;
}

let cachedPackageVersion: string | undefined;

/** Read the node package's own `package.json` version (`HELMX_VERSION_OVERRIDE` overrides for dev). */
export function getNodeVersion(): string {
  const override = process.env.HELMX_VERSION_OVERRIDE?.trim();
  if (override) return override;
  if (!cachedPackageVersion) {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    // Published single-file bundle layout (<pkg>/dist/cli.js) keeps package.json one level up;
    // the workspace source layout (dist/daemon/upgrader.js) keeps it two levels up.
    const pkgCandidates = [path.resolve(selfDir, '../package.json'), path.resolve(selfDir, '../../package.json')];
    let pkgPath: string | undefined;
    for (const candidate of pkgCandidates) {
      if (rawFs.existsSync(candidate)) {
        pkgPath = candidate;
        break;
      }
    }
    if (pkgPath === undefined) {
      throw new Error(`failed to locate node package.json (tried ${pkgCandidates.join(', ')})`);
    }
    let version: string;
    try {
      const parsed = JSON.parse(rawFs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version !== 'string' || !isStrictSemver(parsed.version)) {
        throw new Error(`version field missing or invalid: ${JSON.stringify(parsed.version)}`);
      }
      version = parsed.version;
    } catch (error) {
      throw new Error(`failed to read node package version (${pkgPath}): ${error instanceof Error ? error.message : String(error)}`);
    }
    cachedPackageVersion = version;
  }
  return cachedPackageVersion;
}

/** Resolve effective node version for offline CLI status: `current.json` takes precedence over own package version. */
export async function resolveEffectiveNodeVersion(dataDir: string): Promise<string> {
  const current = await readCurrentRelease(dataDir);
  return current?.version ?? getNodeVersion();
}

// ---------------------------------------------------------------------------
// Node `current.json` state: flat record IO + codec into the engine's canonical shape
// ---------------------------------------------------------------------------

const currentReleasePath = (dataDir: string) => path.join(dataDir, 'current.json');

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`field ${key} is missing or not a non-empty string`);
  }
  return value;
}

function validateCurrentRecord(raw: unknown): CurrentReleaseRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const record: CurrentReleaseRecord = {
    version: requireString(rec, 'version'),
    entryPath: requireString(rec, 'entryPath'),
    updatedAt: requireString(rec, 'updatedAt'),
  };
  if (rec.cliBinDir !== undefined && typeof rec.cliBinDir !== 'string') {
    throw new Error('field cliBinDir must be a string');
  }
  return rec.cliBinDir === undefined ? record : { ...record, cliBinDir: rec.cliBinDir };
}

export async function readCurrentRelease(dataDir: string): Promise<CurrentReleaseRecord | null> {
  return readStateJson(currentReleasePath(dataDir), validateCurrentRecord, 'current.json');
}

export async function writeCurrentRelease(dataDir: string, record: CurrentReleaseRecord): Promise<void> {
  validateCurrentRecord(record as unknown);
  await atomicWriteJson(currentReleasePath(dataDir), record, { mode: 0o600 });
}

export async function deleteCurrentRelease(dataDir: string): Promise<void> {
  await fs.rm(currentReleasePath(dataDir), { force: true });
}

/** Canonical engine record → Node flat record (loses nothing: absent `cliBinDir` stays absent). */
function toNodeCurrentRecord(record: EngineCurrentRecord): CurrentReleaseRecord {
  const entryPath = record.entries[ENTRY_KEY];
  const cliBinDir = record.entries[CLI_BIN_KEY];
  if (entryPath === undefined) {
    throw new Error(`current.json codec: staged release entries missing "${ENTRY_KEY}" (${JSON.stringify(Object.keys(record.entries))})`);
  }
  return { version: record.version, entryPath, updatedAt: record.updatedAt, ...(cliBinDir !== undefined ? { cliBinDir } : {}) };
}

/** Node flat record → canonical engine record. */
function toEngineCurrentRecord(record: CurrentReleaseRecord): EngineCurrentRecord {
  const entries: Record<string, string> = { [ENTRY_KEY]: record.entryPath };
  if (record.cliBinDir !== undefined) entries[CLI_BIN_KEY] = record.cliBinDir;
  return { version: record.version, entries, updatedAt: record.updatedAt };
}

/**
 * Keeps `current.json` in the Node flat disk contract while the engine reasons about its
 * canonical entries-map shape; commit, rollback restore, and version fallback all cross here.
 */
const nodeStateOps: UpdateStateOps = {
  readCurrent: async (dataDir: string) => {
    const record = await readCurrentRelease(dataDir);
    return record === null ? null : toEngineCurrentRecord(record);
  },
  writeCurrent: async (dataDir: string, record: EngineCurrentRecord) => {
    await writeCurrentRelease(dataDir, toNodeCurrentRecord(record));
  },
  deleteCurrent: (dataDir: string) => deleteCurrentRelease(dataDir),
};

// ---------------------------------------------------------------------------
// Node package layout + update source
// ---------------------------------------------------------------------------

const nodePackageName = (): string => process.env.HELMX_NPM_PACKAGE || '@helmx/node';

/** Single `@helmx/node` staging layout. */
function makeNodeReleaseLayout(): ReleaseLayout {
  const nodePkg = nodePackageName();
  const packages: NpmPackageSpec[] = [
    { name: nodePkg, requiredFiles: ['dist/cli.js'] },
  ];
  return {
    packages,
    resolveEntries: () => ({
      [ENTRY_KEY]: path.join('node_modules', ...nodePkg.split('/'), 'dist', 'cli.js'),
    }),
  };
}

function makeNodeUpdateSpec(): UpdateSpec {
  return {
    packageName: nodePackageName(),
    getFallbackVersion: getNodeVersion,
    stateOps: nodeStateOps,
    layout: makeNodeReleaseLayout(),
  };
}

// ---------------------------------------------------------------------------
// Adapter surface (public export names unchanged)
// ---------------------------------------------------------------------------

function wrapNodeExtractor(
  extractor: (stagingDir: string, targetVersion: string) => Promise<{ entryPath: string; cliBinDir?: string }>,
): StageExtractor {
  return async (stagingDir, targetVersion) => {
    const res = await extractor(stagingDir, targetVersion);
    return {
      [ENTRY_KEY]: res.entryPath,
      ...(res.cliBinDir !== undefined ? { [CLI_BIN_KEY]: res.cliBinDir } : {}),
    };
  };
}

function toStagedNodeRelease(staged: StagedRelease): StagedNodeRelease {
  const entryPath = staged.entries[ENTRY_KEY];
  if (entryPath === undefined) {
    throw new Error(
      `staged release entries missing ${ENTRY_KEY}: ${JSON.stringify(Object.keys(staged.entries))}`,
    );
  }
  const cliBinDir = staged.entries[CLI_BIN_KEY];
  return { version: staged.version, releaseDir: staged.releaseDir, entryPath, ...(cliBinDir !== undefined ? { cliBinDir } : {}) };
}

export async function checkNodeUpgrade(
  dataDir: string,
  options?: CheckNodeUpgradeOptions,
): Promise<NodeUpgradeCheckResult> {
  return checkForUpdate(dataDir, makeNodeUpdateSpec(), options);
}

export async function stageReleaseFromNpm(
  dataDir: string,
  targetVersion: string,
  options?: StageReleaseOptions,
): Promise<StagedNodeRelease> {
  const staged = await stageReleaseFromEngine(dataDir, targetVersion, options);
  return toStagedNodeRelease(staged);
}

async function stageReleaseFromEngine(
  dataDir: string,
  targetVersion: string,
  options?: StageReleaseOptions,
): Promise<StagedRelease> {
  return stageRelease(dataDir, targetVersion, makeNodeReleaseLayout(), {
    ...(options?.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options?.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options?.force !== undefined ? { force: options.force } : {}),
    ...(options?.stageExtractor !== undefined ? { stageExtractor: wrapNodeExtractor(options.stageExtractor) } : {}),
  });
}

export async function performNodeUpgrade(
  dataDir: string,
  options?: PerformNodeUpgradeOptions,
): Promise<NodeUpgradeResult> {
  const engineOptions: EnginePerformOptions | undefined = options === undefined ? undefined : {
    ...(options.targetVersion !== undefined ? { targetVersion: options.targetVersion } : {}),
    ...(options.registryUrl !== undefined ? { registryUrl: options.registryUrl } : {}),
    ...(options.force !== undefined ? { force: options.force } : {}),
    ...(options.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
    ...(options.currentVersion !== undefined ? { currentVersion: options.currentVersion } : {}),
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.stageExtractor !== undefined ? { stageExtractor: wrapNodeExtractor(options.stageExtractor) } : {}),
    ...(options.prepareReplacement !== undefined
      ? {
          prepareReplacement: async (release: StagedRelease, context: { attemptId: string; previousVersion: string; targetVersion: string }) =>
            options.prepareReplacement!(toStagedNodeRelease(release), context),
        }
      : {}),
    ...(options.getActiveExecCount !== undefined ? { getActiveExecCount: options.getActiveExecCount } : {}),
    ...(options.setDraining !== undefined ? { setDraining: options.setDraining } : {}),
    ...(options.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
    ...(options.onScheduleShutdown !== undefined ? { onScheduleShutdown: options.onScheduleShutdown } : {}),
  };
  return performUpdate(dataDir, makeNodeUpdateSpec(), engineOptions);
}
