/**
 * Immutable release staging: `releases/<version>/<uuid>/` directories verified before
 * activation and marked with a `.complete` marker.
 *
 * Two staging channels share the same immutability/cache machinery:
 * - npm staging (`layout.packages`): download every package tarball from the registry,
 *   verify the SHA-512 SRI integrity, offline-`npm install` them into the staging root,
 *   then validate the installed layout (exact name/version, required files/bins);
 * - injected `stageExtractor`: consumer-owned staging for layouts npm staging cannot
 *   express (e.g. a Hub payload whose dependencies are embedded `file:` tarballs).
 *
 * Layouts are declared per consumer via `ReleaseLayout`; nothing here hardcodes a
 * product's entry-point fields. Failure cleans the staging directory and reports it;
 * prior candidates are never deleted (in-use releases stay intact). A state directory
 * is owned by exactly one consumer — markers carry version and origin but are not
 * namespaced across different consumers' layouts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from '@helm/env-io';
import { UpgradeRejectedError } from './errors.js';
import { isStrictSemver } from '@helm/protocol';
import { computeSri, downloadTarball, fetchExactManifest, resolveRegistryUrl } from './registry.js';
import { runNpm } from './npm-runner.js';

const NPM_INSTALL_TIMEOUT_MS = 300_000;

/** One npm package composing a release, plus the installed-artifact contract to validate. */
export interface NpmPackageSpec {
  /** Registry package name (scoped names allowed). */
  name: string;
  /** Files (relative to the installed package directory) that must exist after install. */
  requiredFiles?: string[];
  /** Bin names the installed `package.json` must declare with existing target files. */
  requiredBins?: string[];
}

/**
 * Consumer-declared release layout. `resolveEntries` returns relative entry paths inside
 * the staging root (e.g. Node's daemon entry and CLI bin dir, a Hub payload's start
 * script); it is re-run on `.complete` cache reuse so a tampered marker is rejected.
 */
export interface ReleaseLayout {
  packages: NpmPackageSpec[];
  resolveEntries(root: string): Promise<Record<string, string>> | Record<string, string>;
}

/** A staged, fully verified release directory ready for activation. */
export interface StagedRelease {
  version: string;
  /** Immutable release directory (`releases/<version>/<uuid>`). */
  releaseDir: string;
  /** Consumer-defined absolute entry points, validated to stay inside `releaseDir`. */
  entries: Record<string, string>;
}

/**
 * Consumer-owned staging channel: build the payload inside `stagingDir` and return
 * relative entry paths. Also the seam used by tests to stage without a live registry.
 */
export type StageExtractor = (stagingDir: string, targetVersion: string) => Promise<Record<string, string>>;

export interface StageReleaseOptions {
  registryUrl?: string;
  fetchFn?: typeof fetch;
  /** Extra npm install args (consumer policy, e.g. `--ignore-scripts`); appended before `--registry`. */
  npmInstallArgs?: string[];
  /** Bypass `.complete` cache and build a new immutable release directory without deleting older ones. */
  force?: boolean;
  /** Overrides npm staging entirely (see `StageExtractor`). */
  stageExtractor?: StageExtractor;
}

interface CompleteMarker {
  version: string;
  candidateDir: string;
  entries: Record<string, string>;
  completedAt: string;
  origin: 'npm' | 'extractor';
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function requireStrictVersion(input: string): void {
  if (!isStrictSemver(input)) {
    throw new UpgradeRejectedError(
      `invalid SemVer version (targetVersion): "${input}" (expected strict x.y.z[-pre][+build] without v prefix)`,
    );
  }
}

function validateCompleteMarker(raw: unknown): CompleteMarker {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expected JSON object');
  const rec = raw as Record<string, unknown>;
  const requireString = (key: string): string => {
    const value = rec[key];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`field ${key} is missing or not a non-empty string`);
    }
    return value;
  };
  if (rec['origin'] !== 'npm' && rec['origin'] !== 'extractor') {
    throw new Error(`invalid field origin: ${JSON.stringify(rec['origin'])}`);
  }
  const entriesRaw = rec['entries'];
  if (entriesRaw === null || typeof entriesRaw !== 'object' || Array.isArray(entriesRaw)) {
    throw new Error('field entries is missing or not an object');
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(entriesRaw)) {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`field entries.${key} is missing or not a non-empty string`);
    }
    entries[key] = value;
  }
  return {
    version: requireString('version'),
    candidateDir: requireString('candidateDir'),
    entries,
    completedAt: requireString('completedAt'),
    origin: rec['origin'],
  };
}

/** Validate that a consumer/injector-returned relative path stays inside `root` (no absolute, no traversal). */
function resolveInside(root: string, relative: string, label: string): string {
  if (typeof relative !== 'string' || relative === '') {
    throw new Error(`${label} is not a non-empty string`);
  }
  if (path.isAbsolute(relative)) {
    throw new Error(`${label} is absolute, expected relative: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`${label} escapes staging directory: ${relative} (resolved to ${resolved})`);
  }
  return resolved;
}

async function readInstalledPackageJson(
  pkgDir: string,
  pkgName: string,
  version: string,
): Promise<Record<string, unknown>> {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `installed package ${pkgName} package.json unreadable (${pkgJsonPath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.name !== pkgName || parsed.version !== version) {
    throw new Error(
      `installed package name/version mismatch: expected ${pkgName}@${version}, got ${String(parsed.name)}@${String(parsed.version)} (${pkgJsonPath})`,
    );
  }
  return parsed;
}

/** Validate an installed package tree against its `NpmPackageSpec` (name, version, required files and bins). */
async function validateInstalledPackage(spec: NpmPackageSpec, stagingDir: string, version: string): Promise<void> {
  const pkgDir = path.join(stagingDir, 'node_modules', ...spec.name.split('/'));
  const pkgJson = await readInstalledPackageJson(pkgDir, spec.name, version);
  for (const requiredFile of spec.requiredFiles ?? []) {
    if (!(await fileExists(path.join(pkgDir, requiredFile)))) {
      throw new Error(`installed artifact missing ${spec.name} required file ${requiredFile}: ${path.join(pkgDir, requiredFile)}`);
    }
  }
  const bin = pkgJson['bin'];
  for (const binName of spec.requiredBins ?? []) {
    const binTarget =
      typeof bin === 'string' && binName === spec.name.split('/').pop()
        ? bin
        : bin && typeof bin === 'object' && typeof (bin as Record<string, unknown>)[binName] === 'string'
          ? ((bin as Record<string, string>)[binName])
          : undefined;
    if (binTarget === undefined) {
      throw new Error(`${spec.name} package.json missing bin declaration for "${binName}" (${path.join(pkgDir, 'package.json')})`);
    }
    if (!(await fileExists(path.resolve(pkgDir, binTarget)))) {
      throw new Error(`${spec.name} bin target file missing: ${path.resolve(pkgDir, binTarget)}`);
    }
  }
}

/** Resolve `layout.resolveEntries` against `root` into validated absolute entry paths. */
async function resolveLayoutEntries(root: string, layout: ReleaseLayout): Promise<Record<string, string>> {
  const relativeEntries = await layout.resolveEntries(root);
  if (relativeEntries === null || typeof relativeEntries !== 'object' || Array.isArray(relativeEntries)) {
    throw new Error('release layout resolveEntries must return an object of relative entry paths');
  }
  const entries: Record<string, string> = {};
  for (const [key, relative] of Object.entries(relativeEntries)) {
    entries[key] = resolveInside(root, relative, `resolveEntries entries.${key}`);
  }
  if (Object.keys(entries).length === 0) {
    throw new Error('release layout resolveEntries must return at least one entry path');
  }
  return entries;
}

/** Revalidate a `.complete` cached release before reuse (never deletes prior candidates). */
async function revalidateCachedRelease(
  stateDir: string,
  targetVersion: string,
  marker: CompleteMarker,
  layout: ReleaseLayout | undefined,
): Promise<StagedRelease> {
  const versionRoot = path.resolve(stateDir, 'releases', targetVersion);
  const inside = (candidate: string, base: string, label: string): string => {
    const resolved = path.resolve(candidate);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`.complete cache ${label} lies outside immutable release dir: ${candidate} (expected under ${base})`);
    }
    return resolved;
  };

  const candidateDir = inside(marker.candidateDir, versionRoot, 'candidateDir');
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(marker.entries)) {
    entries[key] = inside(value, candidateDir, `entry ${key}`);
  }
  for (const [key, entryPath] of Object.entries(entries)) {
    if (!(await fileExists(entryPath))) {
      throw new Error(`.complete cache reuse failed: missing entry file entries.${key}: ${entryPath}`);
    }
  }

  if (marker.origin !== 'npm' || layout === undefined) {
    return { version: targetVersion, releaseDir: candidateDir, entries };
  }

  for (const spec of layout.packages) {
    await validateInstalledPackage(spec, candidateDir, targetVersion);
  }
  // The recorded marker must agree with a fresh layout resolution; disagreement means a
  // tampered or stale marker and is rejected instead of silently reused.
  const resolved = await resolveLayoutEntries(candidateDir, layout);
  for (const key of Object.keys(resolved)) {
    if (entries[key] !== resolved[key]) {
      throw new Error(
        `.complete cache reuse failed: entries.${key} disagrees with layout resolution (marker ${entries[key]}, resolved ${resolved[key]})`,
      );
    }
  }
  for (const key of Object.keys(entries)) {
    if (resolved[key] === undefined) {
      throw new Error(`.complete cache reuse failed: entries.${key} missing from layout resolution`);
    }
  }

  return { version: targetVersion, releaseDir: candidateDir, entries };
}

async function stageViaNpm(
  stagingDir: string,
  targetVersion: string,
  layout: ReleaseLayout,
  options: StageReleaseOptions,
): Promise<Record<string, string>> {
  const registryUrl = resolveRegistryUrl(options.registryUrl);
  const fetchImpl = options.fetchFn ?? fetch;

  const downloads = path.join(stagingDir, '.downloads');
  await fs.mkdir(downloads, { recursive: true });
  const tarballPaths: string[] = [];
  for (const pkgSpec of layout.packages) {
    const manifest = await fetchExactManifest(registryUrl, pkgSpec.name, targetVersion, fetchImpl);
    const tarballPath = path.join(downloads, `${pkgSpec.name.replace('/', '+')}-${targetVersion}.tgz`);
    try {
      await downloadTarball(manifest.tarball, tarballPath, { fetchFn: fetchImpl });
    } catch (error) {
      throw new Error(
        `failed to download ${pkgSpec.name}@${targetVersion} tarball (${manifest.tarball}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const actual = await computeSri(tarballPath);
    if (actual !== manifest.integrity) {
      throw new Error(
        `${pkgSpec.name}@${targetVersion} tarball sha512 integrity check failed: expected ${manifest.integrity}, got ${actual}`,
      );
    }
    tarballPaths.push(tarballPath);
  }

  await fs.writeFile(
    path.join(stagingDir, 'package.json'),
    JSON.stringify({ name: 'helm-update-staging', private: true }, null, 2) + '\n',
    'utf8',
  );
  await runNpm(
    [
      'install',
      ...tarballPaths,
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      ...(options.npmInstallArgs ?? []),
      '--registry',
      registryUrl,
    ],
    stagingDir,
    NPM_INSTALL_TIMEOUT_MS,
  );

  for (const spec of layout.packages) {
    await validateInstalledPackage(spec, stagingDir, targetVersion);
  }
  return await resolveLayoutEntries(stagingDir, layout);
}

/**
 * Stage an immutable verified release for `targetVersion` under `<stateDir>/releases/`.
 *
 * Uses the `.complete` cache when valid (unless `force`); otherwise builds through npm
 * staging (`layout`) or the injected `stageExtractor`, renames the staging directory to
 * its final immutable location, and writes the marker.
 */
export async function stageRelease(
  stateDir: string,
  targetVersion: string,
  layout?: ReleaseLayout,
  options?: StageReleaseOptions,
): Promise<StagedRelease> {
  requireStrictVersion(targetVersion);

  if (options?.stageExtractor === undefined && layout === undefined) {
    throw new UpgradeRejectedError(
      'stageRelease rejected: neither a release layout (npm staging) nor a stageExtractor was provided',
    );
  }

  const versionRoot = path.join(stateDir, 'releases', targetVersion);
  const completePath = path.join(versionRoot, '.complete');

  if (!options?.force) {
    const cached = await readMarker(completePath);
    if (cached && cached.version === targetVersion) {
      return await revalidateCachedRelease(stateDir, targetVersion, cached, layout);
    }
  }

  await fs.mkdir(versionRoot, { recursive: true });
  const stagingDir = path.join(versionRoot, `.staging-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`);

  try {
    await fs.mkdir(stagingDir, { recursive: true });
    let relativeEntries: Record<string, string>;

    if (options?.stageExtractor) {
      const extracted = await options.stageExtractor(stagingDir, targetVersion);
      if (extracted === null || typeof extracted !== 'object' || Array.isArray(extracted)) {
        throw new Error('stageExtractor must return an object of relative entry paths');
      }
      relativeEntries = {};
      for (const [key, relative] of Object.entries(extracted)) {
        const absolute = resolveInside(stagingDir, relative, `stageExtractor entries.${key}`);
        if (!(await fileExists(absolute))) {
          throw new Error(`stageExtractor entries.${key} target missing: ${absolute}`);
        }
        relativeEntries[key] = path.relative(stagingDir, absolute);
      }
      if (Object.keys(relativeEntries).length === 0) {
        throw new Error('stageExtractor must return at least one entry path');
      }
    } else {
      relativeEntries = await stageViaNpm(stagingDir, targetVersion, layout!, options ?? {});
      for (const [key, relative] of Object.entries(relativeEntries)) {
        if (!(await fileExists(path.join(stagingDir, relative)))) {
          throw new Error(`staged entries.${key} target missing after npm staging: ${path.join(stagingDir, relative)}`);
        }
      }
    }

    const candidateDir = path.join(versionRoot, randomUUID());
    await fs.rename(stagingDir, candidateDir);
    const entries: Record<string, string> = {};
    for (const [key, relative] of Object.entries(relativeEntries)) {
      entries[key] = path.join(candidateDir, relative);
    }

    const marker: CompleteMarker = {
      version: targetVersion,
      candidateDir,
      entries,
      completedAt: new Date().toISOString(),
      origin: options?.stageExtractor ? 'extractor' : 'npm',
    };
    await atomicWriteJson(completePath, marker, { mode: 0o600 });

    return { version: targetVersion, releaseDir: candidateDir, entries };
  } catch (error) {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (rmError) {
      if (error instanceof Error) {
        error.message += `; staging cleanup failed (${rmError instanceof Error ? rmError.message : String(rmError)}), leftover directory requires manual removal: ${stagingDir}`;
      }
    }
    throw error;
  }
}

async function readMarker(completePath: string): Promise<CompleteMarker | null> {
  let raw: string;
  try {
    raw = await fs.readFile(completePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(`failed to read .complete (${completePath}): ${code ?? (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    return validateCompleteMarker(JSON.parse(raw));
  } catch (error) {
    throw new Error(`.complete is corrupt (${completePath}): ${error instanceof Error ? error.message : String(error)}`);
  }
}
