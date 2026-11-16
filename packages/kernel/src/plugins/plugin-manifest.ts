/**
 * plugin-manifest.ts: external plugin manifest parse layer (plugin.json and package.json helm field).
 *
 * responsibility (self external-loader split out, rule one by one character do not change):
 * - plugin.json: must be can parse JSON object; optional field `clientRoot`(frontend source
 *   directory),`clientDependencies`(frontend subject to control npm note symbol array),`dependencies`
 *   (plugin between dependency ID array); illegal value explicit reject, never static default ignore;
 * - package.json `helm` field ({ main?, clientRoot?, clientDependencies?,
 *   dependencies? }):helm.main / top-level main is npm standard entry (relative path;
 *   .js suffix heavy write same name TS source by entry parse layer handle); top-level dependencies keep npm
 *   semantics (runtime dependency), never mistakenly read is plugin between dependency;
 * - without helm field when back package.json main(npm standard entry);
 * - note symbol/dependency ID shape validate and dedupe (illegal items explicit plugin_manifest_invalid);
 * - manifest metadata read (id/name/description/version, supply fault occupy register render;
 *   manifest missing or corrupt when return empty object).
 *
 * IO error discipline: only ENOENT / ENOTDIR means file missing;EACCES etc. other IO
 * error explicit throws (plugin_scan_failed / plugin_manifest_invalid), never static default swallow wrong.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HelmError } from '@helm/protocol';

/**
 * npm standard entry discover (additive, do not sacrifice existing plugin.json/convention entry format):
 * package.json  `helm` field ({ main?, clientRoot?, clientDependencies?, dependencies? }):
 * - helm.main / package.json.main designate backend entry (relative path, exceeds validate same
 *   plugin.json main;.js suffix automatically heavy write same name .ts source);
 * - helm.clientRoot supply package act declaration frontend source directory, by readHelmClientRoot through out,
 *   normalizeDefinition default still is plugin directory itself;
 * - helm.clientDependencies / plugin.json clientDependencies declaration frontend subject to control npm
 *   dependency note symbol (bare package name/sub- path), archive one mapping to plugin itself directory as parse;
 * - helm.dependencies / plugin.json dependencies declaration plugin between dependency (only plugin ID);
 *   package.json top-level dependencies keep npm semantics (runtime dependency), never mistakenly read;
 * - priority:plugin.json(main / convention entry)> package.json helm.main >
 *   package.json main > convention entry probe; without any hit then is pure data directory.
 */
export interface HelmManifest {
  /** package.json helm.clientRoot declaration (original relative path; not declaration when default). */
  clientRoot?: string;
  /** frontend subject to control npm dependency note symbol (bare package name or sub- path; already verify dedupe). */
  clientDependencies?: string[];
  /** plugin between dependency ID list (already verify dedupe). */
  dependencies?: string[];
}

/** plugin ID character collection (and host plugin id same collection: character parent number : _ -). */
export const MANIFEST_PLUGIN_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

/**
 * subject to control frontend npm note conforms to method: non-empty, non- path form (do not with . or / open head), without backslash,
 * without .. segment, without whitespace; allows @scope/name and sub- path (sub- path must one by one items declaration, does not prefix through match).
 */
function isValidClientDependencySpec(spec: string): boolean {
  if (spec.length === 0 || spec.length > 214) return false;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.includes('\\')) return false;
  if (/\s/.test(spec)) return false;
  if (spec.split('/').includes('..')) return false;
  return /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._~-]+)*$/.test(spec);
}

/** validate and dedupe manifest declaration frontend npm note symbol (illegal items explicit plugin_manifest_invalid). */
function normalizeClientDependencySpecs(dirPath: string, source: string, values: unknown): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !isValidClientDependencySpec(v))) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `external plugin ${dirPath}  ${source} must be subject to control npm note symbol string array (bare package name or sub- path, forbidden each other for/absolute path and .. segment)`,
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

/** validate and dedupe manifest declaration plugin between dependency ID(illegal items explicit plugin_manifest_invalid). */
function normalizeManifestDependencies(dirPath: string, source: string, values: unknown): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !MANIFEST_PLUGIN_ID_PATTERN.test(v))) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `external plugin ${dirPath}  ${source} must be plugin ID string array (only allows character parent number : _ -;npm dependency please declaration in package.json dependencies)`,
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

/** for outside read plugin.json clientRoot or package.json helm.clientRoot(normalizeDefinition increase strong use;plugin.json takes precedence). */
export function readHelmClientRoot(dirPath: string): string | undefined {
  const manifestClientRoot = readManifestClientRoot(dirPath);
  if (manifestClientRoot !== undefined) return manifestClientRoot;
  return readHelmField(dirPath)?.clientRoot;
}

/** for outside read manifest declaration frontend subject to control npm note symbol (plugin.json and package.json helm merge dedupe; supply managed install patch install). */
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

/**
 * from plugin.json read optional metadata (id/name/description/version), supply fault occupy
 * register render;manifest missing or corrupt when return empty object.
 */
export function readManifestMeta(dirPath: string): Record<string, unknown> {
  try {
    return readManifest(join(dirPath, 'plugin.json'));
  } catch {
    return {};
  }
}

/** read plugin.json(missing return undefined;IO error explicit throws, not silently when without manifest). */
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
      `external plugin directory cannot read: ${manifestPath}(${err instanceof Error ? err.message : String(err)})`,
      500,
      { manifestPath, code },
    );
  }
  if (!exists) return undefined;
  return readManifest(manifestPath);
}

/** read plugin.json optional extend field (clientDependencies / dependencies; without plugin.json return undefined). */
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

/** read plugin.json  clientRoot field (without plugin.json return undefined; store in but non- string explicit errors). */
function readManifestClientRoot(dirPath: string): string | undefined {
  const manifest = readManifestIfPresent(dirPath);
  if (manifest === undefined) return undefined;
  const clientRoot = manifest['clientRoot'];
  if (clientRoot === undefined) return undefined;
  if (typeof clientRoot !== 'string' || clientRoot.length === 0) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `external plugin ${dirPath}  plugin.json clientRoot must be non-empty string`,
      500,
      { dirPath, clientRoot: String(clientRoot) },
    );
  }
  return clientRoot;
}

/** read package.json  helm field (object shape validate; without package.json return null). */
export function readHelmField(
  dirPath: string,
): { main?: string; clientRoot?: string; clientDependencies?: string[]; dependencies?: string[] } | null {
  const pkgPath = join(dirPath, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(pkgPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new HelmError(
      'plugin_scan_failed',
      `external plugin package.json cannot read: ${pkgPath}(${err instanceof Error ? err.message : String(err)})`,
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
      `external plugin package.json is not legal JSON: ${pkgPath}(${err instanceof Error ? err.message : String(err)})`,
      500,
      { dirPath },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const helm = (parsed as Record<string, unknown>)['helm'];
  if (helm === undefined) {
    // without helm field: back package.json main(npm standard entry)
    const main = (parsed as Record<string, unknown>)['main'];
    if (typeof main === 'string' && main.length > 0) return { main };
    return null;
  }
  if (typeof helm !== 'object' || helm === null || Array.isArray(helm)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `external plugin ${dirPath}  package.json helm field must be object`,
      500,
      { dirPath },
    );
  }
  const result: { main?: string; clientRoot?: string; clientDependencies?: string[]; dependencies?: string[] } = {};
  const helmObj = helm as Record<string, unknown>;
  const main = helmObj['main'];
  if (main !== undefined) {
    if (typeof main !== 'string' || main.length === 0) {
      throw new HelmError(
        'plugin_manifest_invalid',
        `external plugin ${dirPath}  package.json helm.main must be non-empty string`,
        500,
        { dirPath },
      );
    }
    result.main = main;
  }
  const clientRoot = helmObj['clientRoot'];
  if (clientRoot !== undefined) {
    if (typeof clientRoot !== 'string' || clientRoot.length === 0) {
      throw new HelmError(
        'plugin_manifest_invalid',
        `external plugin ${dirPath}  package.json helm.clientRoot must be non-empty string`,
        500,
        { dirPath },
      );
    }
    result.clientRoot = clientRoot;
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
    result.clientDependencies === undefined &&
    result.dependencies === undefined
  ) {
    return null;
  }
  return result;
}

/** read and parse plugin.json; corrupt / non- object one rule explicit plugin_manifest_invalid. */
export function readManifest(manifestPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `external plugin manifest failed to read: ${manifestPath}(${err instanceof Error ? err.message : String(err)})`,
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
      `external plugin manifest is not legal JSON: ${manifestPath}(${err instanceof Error ? err.message : String(err)})`,
      500,
      { manifestPath },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `external plugin manifest must be JSON object: ${manifestPath}`,
      500,
      { manifestPath },
    );
  }
  return parsed as Record<string, unknown>;
}
