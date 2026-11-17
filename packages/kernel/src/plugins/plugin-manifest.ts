/**
 * plugin-manifest.ts: external plugin manifest parser (`plugin.json` and `package.json` `helm` field).
 *
 * Responsibilities:
 * - `plugin.json`: JSON object with optional `clientRoot`, `clientDependencies` (managed frontend npm
 *   specifiers), and `dependencies` (inter-plugin IDs); invalid shapes fail with `plugin_manifest_invalid`;
 * - `package.json` `helm` field: `{ main?, clientRoot?, clientDependencies?, dependencies? }`, while
 *   top-level `dependencies` remains standard npm runtime dependencies;
 * - Specifier/ID validation, deduplication, and lightweight metadata reading (`id/name/description/version`).
 *
 * IO discipline: only ENOENT/ENOTDIR indicate missing files; EACCES and other IO failures throw explicitly.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HelmError } from '@helm/protocol';

/**
 * Metadata extracted from `plugin.json` / `package.json#helm`:
 * - `clientRoot`: relative frontend source directory (defaults to plugin root);
 * - `clientDependencies`: managed frontend npm specifiers (bare names/subpaths resolved in plugin dir);
 * - `dependencies`: inter-plugin IDs (distinct from npm `dependencies`).
 */
export interface HelmManifest {
  /** Relative `clientRoot` path declared in manifest (optional). */
  clientRoot?: string;
  /** Relative `clientDist` prebuilt client directory path declared in manifest (optional). */
  clientDist?: string;
  /** Managed frontend npm dependency specifiers (bare names or subpaths, deduplicated). */
  clientDependencies?: string[];
  /** Inter-plugin dependency IDs (deduplicated). */
  dependencies?: string[];
}

/** Allowed characters for plugin IDs (`[A-Za-z0-9:_-]+`). */
export const MANIFEST_PLUGIN_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

/**
 * Validates managed frontend npm specifiers: non-empty, no leading `.` or `/`, no backslashes,
 * no `..` segments, and no whitespace (`@scope/name` and explicit subpaths are allowed).
 */
function isValidClientDependencySpec(spec: string): boolean {
  if (spec.length === 0 || spec.length > 214) return false;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.includes('\\')) return false;
  if (/\s/.test(spec)) return false;
  if (spec.split('/').includes('..')) return false;
  return /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._~-]+)*$/.test(spec);
}

/** Validates and deduplicates frontend npm dependency specifiers (`plugin_manifest_invalid` on bad entries). */
function normalizeClientDependencySpecs(dirPath: string, source: string, values: unknown): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !isValidClientDependencySpec(v))) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} ${source} must be an array of npm specifiers (bare package names or subpaths; relative/absolute paths and '..' are disallowed)`,
      400,
      { dirPath, source, values: Array.isArray(values) ? values.map((v) => String(v)) : String(values) },
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const spec of values as string[]) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    out.push(spec);
  }
  return out.length > 0 ? out : undefined;
}

/** Validates and deduplicates inter-plugin dependency IDs (`plugin_manifest_invalid` on bad entries). */
function normalizeManifestDependencies(dirPath: string, source: string, values: unknown): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !MANIFEST_PLUGIN_ID_PATTERN.test(v))) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} ${source} must be an array of plugin IDs (letters, digits, :, _, - only; declare npm packages in package.json dependencies)`,
      400,
      { dirPath, source, values: Array.isArray(values) ? values.map((v) => String(v)) : String(values) },
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dep of values as string[]) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    out.push(dep);
  }
  return out.length > 0 ? out : undefined;
}

/** Reads `clientRoot` from `plugin.json` or `package.json#helm` (`plugin.json` takes precedence). */
export function readHelmClientRoot(dirPath: string): string | undefined {
  const manifestClientRoot = readManifestStringField(dirPath, 'clientRoot');
  if (manifestClientRoot !== undefined) return manifestClientRoot;
  return readHelmField(dirPath)?.clientRoot;
}

/** Reads `clientDist` from `plugin.json` or `package.json#helm` (`plugin.json` takes precedence). */
export function readHelmClientDist(dirPath: string): string | undefined {
  const manifestClientDist = readManifestStringField(dirPath, 'clientDist');
  if (manifestClientDist !== undefined) return manifestClientDist;
  return readHelmField(dirPath)?.clientDist;
}

/** Reads frontend managed npm dependencies from `plugin.json` and `package.json#helm` (merged & deduplicated). */
export function readHelmClientDependencies(dirPath: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (specs: string[] | undefined): void => {
    for (const spec of specs ?? []) {
      if (seen.has(spec)) continue;
      seen.add(spec);
      out.push(spec);
    }
  };
  add(readManifestOptional(dirPath)?.clientDependencies);
  add(readHelmField(dirPath)?.clientDependencies);
  return out;
}

/** Reads optional metadata (`id/name/description/version`) from `plugin.json` for failed placeholders (returns `{}` if missing/corrupt). */
export function readManifestMeta(dirPath: string): Record<string, unknown> {
  try {
    return readManifest(join(dirPath, 'plugin.json'));
  } catch {
    return {};
  }
}

/** Reads `plugin.json` if present (returns `undefined` if missing; IO errors throw explicitly). */
function readManifestIfPresent(dirPath: string): Record<string, unknown> | undefined {
  const manifestPath = join(dirPath, 'plugin.json');
  let exists = true;
  try {
    exists = statSync(manifestPath).isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new HelmError(
      'plugin_scan_failed',
      `Cannot read external plugin directory manifest: ${manifestPath} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { manifestPath, code },
    );
  }
  if (!exists) return undefined;
  return readManifest(manifestPath);
}

/** Reads optional extended fields from `plugin.json` (`clientDependencies` / `dependencies`). */
export function readManifestOptional(dirPath: string): HelmManifest | undefined {
  const manifest = readManifestIfPresent(dirPath);
  if (manifest === undefined) return undefined;
  const clientDependencies = normalizeClientDependencySpecs(dirPath, 'plugin.json clientDependencies', manifest['clientDependencies']);
  const dependencies = normalizeManifestDependencies(dirPath, 'plugin.json dependencies', manifest['dependencies']);
  return {
    ...(clientDependencies !== undefined ? { clientDependencies } : {}),
    ...(dependencies !== undefined ? { dependencies } : {}),
  };
}

/** Reads a non-empty optional string field from `plugin.json` (returns `undefined` when missing; rejects non-string or empty values). */
function readManifestStringField(dirPath: string, field: 'clientRoot' | 'clientDist'): string | undefined {
  const manifest = readManifestIfPresent(dirPath);
  if (manifest === undefined) return undefined;
  const value = manifest[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} plugin.json ${field} must be a non-empty string`,
      500,
      { dirPath, [field]: String(value) },
    );
  }
  return value;
}

/** Reads `package.json#helm` (validates object shape; returns `null` when `package.json` is absent). */
export function readHelmField(
  dirPath: string,
): { main?: string; clientRoot?: string; clientDist?: string; clientDependencies?: string[]; dependencies?: string[] } | null {
  const pkgPath = join(dirPath, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new HelmError(
      'plugin_scan_failed',
      `Cannot read external plugin package.json: ${pkgPath} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { dirPath, code },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin package.json is not valid JSON: ${pkgPath} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { dirPath },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const helm = (parsed as Record<string, unknown>)['helm'];
  if (helm === undefined) {
    // Fallback to standard npm package.json `main` when `helm` is absent.
    const main = (parsed as Record<string, unknown>)['main'];
    if (typeof main === 'string' && main.length > 0) return { main };
    return null;
  }
  if (typeof helm !== 'object' || helm === null || Array.isArray(helm)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin ${dirPath} package.json helm field must be an object`,
      500,
      { dirPath },
    );
  }
  const result: { main?: string; clientRoot?: string; clientDist?: string; clientDependencies?: string[]; dependencies?: string[] } = {};
  const helmObj = helm as Record<string, unknown>;
  for (const field of ['main', 'clientRoot', 'clientDist'] as const) {
    const val = helmObj[field];
    if (val !== undefined) {
      if (typeof val !== 'string' || val.length === 0) {
        throw new HelmError(
          'plugin_manifest_invalid',
          `External plugin ${dirPath} package.json helm.${field} must be a non-empty string`,
          500,
          { dirPath },
        );
      }
      result[field] = val;
    }
  }
  const clientDependencies = normalizeClientDependencySpecs(
    dirPath,
    'package.json helm.clientDependencies',
    helmObj['clientDependencies'],
  );
  if (clientDependencies !== undefined) result.clientDependencies = clientDependencies;
  const dependencies = normalizeManifestDependencies(
    dirPath,
    'package.json helm.dependencies',
    helmObj['dependencies'],
  );
  if (dependencies !== undefined) result.dependencies = dependencies;
  if (
    result.main === undefined &&
    result.clientRoot === undefined &&
    result.clientDist === undefined &&
    result.clientDependencies === undefined &&
    result.dependencies === undefined
  ) {
    return null;
  }
  return result;
}

/** Reads and parses `plugin.json`; corrupt or non-object files fail explicitly with `plugin_manifest_invalid`. */
export function readManifest(manifestPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `Failed to read external plugin manifest: ${manifestPath} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { manifestPath },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin manifest is not valid JSON: ${manifestPath} (${err instanceof Error ? err.message : String(err)})`,
      500,
      { manifestPath },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `External plugin manifest must be a JSON object: ${manifestPath}`,
      500,
      { manifestPath },
    );
  }
  return parsed as Record<string, unknown>;
}
