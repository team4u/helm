/**
 * desktop shell config parse: explicit override > environment variable > default value, entry where strong validate.
 *
 * boundary discipline:
 * - port iron rule: by default 3202, forever does not occupy 3000(external)/3001/3002(botd)/3101/3102(botx);
 * - data isolated:dataDir only as child process HELM_DATA_DIR pass (default along use kernel  ~/.helm convention);
 * - payload entry (HELM_DESKTOP_PAYLOAD_ENTRY): not come npm Hub payload  hub entry JS,
 *   config after takes precedence at repository kernel dist(payload load path, do not import kernel).
 */
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DesktopError } from './errors.js';

export const DESKTOP_DEFAULT_PORT = 3202;
/** port iron rule: these port belongs to external and history system, desktop shell forever does not occupy. */
export const FORBIDDEN_PORTS: readonly number[] = [3000, 3001, 3002, 3101, 3102];

export interface DesktopConfig {
  /** Hub port (by default 3202). */
  readonly port: number;
  /** only local machine loopback (desktop shell do not bear bear far process access). */
  readonly hostname: '127.0.0.1';
  /** http://127.0.0.1:<port> */
  readonly hubUrl: string;
  /** pass to Hub child process HELM_DATA_DIR;undefined = kernel default (~/.helm). */
  readonly dataDir?: string;
  /** pass to Hub child process HELM_WEB_DIST_DIR;undefined = kernel default probe. */
  readonly webDistDir?: string;
  /** and when before payload same edition helm CLI entry. */
  readonly cliEntry?: string;
  /** npm Hub payload  hub entry JS; settings then takes precedence at hubEntry. */
  readonly payloadEntry?: string;
  /** payload entry additional parameter (HELM_DESKTOP_PAYLOAD_ENTRY_ARGS, space split; only payload entry available). */
  readonly payloadEntryArgs?: string[];
  /** npm payload package name (HELM_PAYLOAD_PACKAGE); do not hard encode any @helm name. */
  readonly payloadPackage?: string;
  /** npm registry base URL(HELM_PAYLOAD_REGISTRY; default public npm registry). */
  readonly payloadRegistry?: string;
  /** lock payload precise version (HELM_PAYLOAD_VERSION); default trace dist-tags.latest. */
  readonly payloadVersion?: string;
  /** repository inside hub dist entry (default <repo>/packages/hub/dist/main.js). */
  readonly hubEntry?: string;
  /** complete command override (most high takes precedence, space split self HELM_DESKTOP_HUB_CMD). */
  readonly hubCommand?: string[];
  /** node can execute file override (used to run Hub child process). */
  readonly hubNode?: string;
  /** ready wait for cap (ms). */
  readonly readyTimeoutMs: number;
  /** ready polling interval (ms). */
  readonly probeIntervalMs: number;
  /** single time probe HTTP timeout (ms). */
  readonly probeTimeoutMs: number;
  /** owned Hub crash automatically restart cap (stable stableMs after reset). */
  readonly restartMaxRetries: number;
  /** restart backoff base count (ms), refer count pass increase seal top restartBackoffMaxMs. */
  readonly restartBackoffMs: number;
  readonly restartBackoffMaxMs: number;
  /** child process stable run how long after reset restart pre- compute (ms). */
  readonly stableMs: number;
  /** stop() graceful phase:SIGTERM after exceeds now long force SIGKILL(ms). */
  readonly stopGraceMs: number;
}

export type DesktopOverrides = Partial<
  Pick<
    DesktopConfig,
    | 'port'
    | 'dataDir'
    | 'webDistDir'
    | 'cliEntry'
    | 'payloadEntry'
    | 'payloadEntryArgs'
    | 'payloadPackage'
    | 'payloadRegistry'
    | 'payloadVersion'
    | 'hubEntry'
    | 'hubCommand'
    | 'hubNode'
    | 'readyTimeoutMs'
    | 'probeIntervalMs'
    | 'probeTimeoutMs'
    | 'restartMaxRetries'
    | 'restartBackoffMs'
    | 'restartBackoffMaxMs'
    | 'stableMs'
    | 'stopGraceMs'
  >
>;

/** hub entry default path (src and dist under same construct: all on trace two level to packages/). */
export function defaultHubEntryPath(): string {
  return fileURLToPath(new URL('../../hub/dist/main.js', import.meta.url));
}

function parsePort(raw: string | undefined, origin: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DesktopError('config_invalid', `${origin} must be 1 to 65535 integer, actual: ${raw ?? '(empty)'}`);
  }
  if (FORBIDDEN_PORTS.includes(port)) {
    throw new DesktopError(
      'config_invalid',
      `port ${port} belongs to external/history system keep port (${FORBIDDEN_PORTS.join('/')}), desktop shell forbidden occupy`,
    );
  }
  return port;
}

/** not settings or empty string treated as not config (default value), the rest illegal value explicit reject. */
function envValue(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

function parsePositiveInt(raw: string | undefined, origin: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new DesktopError('config_invalid', `${origin} must be >= ${min} integer, actual: ${raw ?? '(empty)'}`);
  }
  return value;
}

/** npm version note symbol (semver and prerelease/build character collection, forbid isolate symbol). */
const SAFE_VERSION_RE = /^[a-zA-Z0-9.+~-]+$/;

/** whitespace split parameter string; empty string treated as not config. */
function parseArgList(raw: string | undefined): string[] | undefined {
  const value = envValue(raw)?.trim();
  return value === undefined ? undefined : value.split(/\s+/).filter((a) => a.length > 0);
}

/**
 * parse desktop shell config.env takes precedence read HELM_DESKTOP_* naming empty between;overrides explicit override everything
 * (test and edit process style invoke channel). illegal value explicit throws, never static default back.
 */
export function resolveDesktopConfig(env: NodeJS.ProcessEnv, overrides: DesktopOverrides = {}): DesktopConfig {
  const portRaw = overrides.port !== undefined ? String(overrides.port) : envValue(env['HELM_DESKTOP_PORT']);
  const port = portRaw === undefined ? DESKTOP_DEFAULT_PORT : parsePort(portRaw, 'port (HELM_DESKTOP_PORT)');
  const hubCommand = overrides.hubCommand ?? (env['HELM_DESKTOP_HUB_CMD']?.trim() ? env['HELM_DESKTOP_HUB_CMD'].trim().split(/\s+/) : undefined);
  if (hubCommand !== undefined && hubCommand.length === 0) {
    throw new DesktopError('config_invalid', 'hubCommand cannot be empty');
  }
  const payloadEntryArgs =
    overrides.payloadEntryArgs ?? parseArgList(env['HELM_DESKTOP_PAYLOAD_ENTRY_ARGS']);
  const payloadPackageRaw =
    overrides.payloadPackage !== undefined ? overrides.payloadPackage : envValue(env['HELM_PAYLOAD_PACKAGE']);
  const payloadPackage = payloadPackageRaw?.trim();
  if (payloadPackage === '') {
    throw new DesktopError('config_invalid', 'HELM_PAYLOAD_PACKAGE cannot is whitespace string');
  }
  const payloadRegistryRaw =
    overrides.payloadRegistry !== undefined ? overrides.payloadRegistry : envValue(env['HELM_PAYLOAD_REGISTRY']);
  if (payloadRegistryRaw !== undefined) {
    try {
      const parsed = new URL(payloadRegistryRaw);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`protocol ${parsed.protocol} unsupported`);
      }
    } catch (error) {
      throw new DesktopError(
        'config_invalid',
        `HELM_PAYLOAD_REGISTRY must be http(s) URL(${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const payloadVersionRaw =
    overrides.payloadVersion !== undefined ? overrides.payloadVersion : envValue(env['HELM_PAYLOAD_VERSION']);
  if (payloadVersionRaw !== undefined && payloadVersionRaw !== 'latest' && !SAFE_VERSION_RE.test(payloadVersionRaw)) {
    throw new DesktopError('config_invalid', `HELM_PAYLOAD_VERSION must be version number or latest, actual: ${payloadVersionRaw}`);
  }
  const payloadEntry = overrides.payloadEntry ?? envValue(env['HELM_DESKTOP_PAYLOAD_ENTRY']);
  if (payloadEntryArgs !== undefined && payloadEntry === undefined) {
    throw new DesktopError(
      'config_invalid',
      'HELM_DESKTOP_PAYLOAD_ENTRY_ARGS only in HELM_DESKTOP_PAYLOAD_ENTRY(payload entry) config after available',
    );
  }
  const config: DesktopConfig = {
    port,
    hostname: '127.0.0.1',
    hubUrl: `http://127.0.0.1:${port}`,
    dataDir: overrides.dataDir ?? env['HELM_DESKTOP_DATA_DIR'] ?? env['HELM_DATA_DIR'],
    webDistDir: overrides.webDistDir ?? env['HELM_DESKTOP_WEB_DIST'],
    cliEntry: overrides.cliEntry ?? env['HELM_CLI_ENTRY'],
    payloadEntry,
    payloadEntryArgs,
    payloadPackage,
    payloadRegistry: payloadRegistryRaw,
    payloadVersion: payloadVersionRaw,
    hubEntry: overrides.hubEntry ?? env['HELM_DESKTOP_HUB_ENTRY'] ?? defaultHubEntryPath(),
    hubCommand,
    hubNode: overrides.hubNode ?? env['HELM_DESKTOP_HUB_NODE'],
    readyTimeoutMs:
      overrides.readyTimeoutMs ??
      (envValue(env['HELM_DESKTOP_READY_TIMEOUT_MS']) !== undefined
        ? parsePositiveInt(envValue(env['HELM_DESKTOP_READY_TIMEOUT_MS']), 'HELM_DESKTOP_READY_TIMEOUT_MS', 100)
        : 30_000),
    probeIntervalMs: overrides.probeIntervalMs ?? 250,
    probeTimeoutMs: overrides.probeTimeoutMs ?? 1_500,
    restartMaxRetries: overrides.restartMaxRetries ?? 3,
    restartBackoffMs: overrides.restartBackoffMs ?? 1_000,
    restartBackoffMaxMs: overrides.restartBackoffMaxMs ?? 10_000,
    stableMs: overrides.stableMs ?? 30_000,
    stopGraceMs: overrides.stopGraceMs ?? 5_000,
  };
  if (config.probeIntervalMs < 50) {
    throw new DesktopError('config_invalid', 'probeIntervalMs small (>= 50ms)');
  }
  return config;
}

/** takes effect hub entry and source (payload takes precedence);args is payload entry additional parameter (contract on constant empty). */
export interface HubEntrySelection {
  entry: string;
  source: 'payload' | 'hub-entry';
  args: readonly string[];
}

export function resolveHubEntry(config: DesktopConfig): HubEntrySelection | null {
  if (config.hubCommand !== undefined) return null;
  if (config.payloadEntry !== undefined) {
    return { entry: config.payloadEntry, source: 'payload', args: config.payloadEntryArgs ?? [] };
  }
  if (config.hubEntry !== undefined) return { entry: config.hubEntry, source: 'hub-entry', args: [] };
  return { entry: defaultHubEntryPath(), source: 'hub-entry', args: [] };
}

/**
 * Hub child process environment: strip HELM_DESKTOP_* and HELM_PAYLOAD_*(guard against desktop shell semantics leak leak to Hub),
 * inject kernel convention variable.ELECTRON_RUN_AS_NODE by runner layer on demand append (see runners.ts).
 */
export function buildHubChildEnv(config: DesktopConfig, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith('HELM_DESKTOP_') || key.startsWith('HELM_PAYLOAD_')) continue;
    child[key] = value;
  }
  child['HELM_PORT'] = String(config.port);
  child['HELM_HOST'] = config.hostname;
  if (config.dataDir !== undefined) child['HELM_DATA_DIR'] = config.dataDir;
  if (config.webDistDir !== undefined) child['HELM_WEB_DIST_DIR'] = config.webDistDir;
  if (config.cliEntry !== undefined) child['HELM_CLI_ENTRY'] = config.cliEntry;
  child['HELM_CWD'] = baseEnv['HELM_CWD'] ?? homedir();
  return child;
}
