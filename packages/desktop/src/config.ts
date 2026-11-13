/**
 * 桌面壳配置解析：显式覆盖 > 环境变量 > 缺省值，入口处强校验。
 *
 * 边界纪律：
 * - 端口铁律：默认 3202，永不占用 3000（外部）/3001/3002（botd）/3101/3102（botx）；
 * - 数据隔离：dataDir 仅作为子进程 HELM_DATA_DIR 传入（缺省沿用 kernel 的 ~/.helm 约定）；
 * - payload 入口（HELM_DESKTOP_PAYLOAD_ENTRY）：未来 npm Hub payload 的 hub 入口 JS，
 *   配置后优先于仓库 kernel dist（payload 加载路径，不 import kernel）。
 */
import { fileURLToPath } from 'node:url';
import { DesktopError } from './errors.js';

export const DESKTOP_DEFAULT_PORT = 3202;
/** 端口铁律：这些端口属于外部与历史系统，桌面壳永不占用。 */
export const FORBIDDEN_PORTS: readonly number[] = [3000, 3001, 3002, 3101, 3102];

export interface DesktopConfig {
  /** Hub 端口（默认 3202）。 */
  readonly port: number;
  /** 仅本机回环（桌面壳不承担远程接入）。 */
  readonly hostname: '127.0.0.1';
  /** http://127.0.0.1:<port> */
  readonly hubUrl: string;
  /** 传给 Hub 子进程的 HELM_DATA_DIR；undefined = kernel 缺省（~/.helm）。 */
  readonly dataDir?: string;
  /** 传给 Hub 子进程的 HELM_WEB_DIST_DIR；undefined = kernel 缺省探测。 */
  readonly webDistDir?: string;
  /** npm Hub payload 的 hub 入口 JS；设置则优先于 hubEntry。 */
  readonly payloadEntry?: string;
  /** payload 入口附加参数（HELM_DESKTOP_PAYLOAD_ENTRY_ARGS，空格拆分；仅 payload 入口可用）。 */
  readonly payloadEntryArgs?: string[];
  /** npm payload 包名（HELM_PAYLOAD_PACKAGE）；不硬编码任何 @helm 名称。 */
  readonly payloadPackage?: string;
  /** npm registry base URL（HELM_PAYLOAD_REGISTRY；缺省公开 npm registry）。 */
  readonly payloadRegistry?: string;
  /** 锁定 payload 精确版本（HELM_PAYLOAD_VERSION）；缺省跟踪 dist-tags.latest。 */
  readonly payloadVersion?: string;
  /** 仓库内 kernel dist 的 hub 入口（缺省 <repo>/packages/kernel/dist/main.js）。 */
  readonly hubEntry?: string;
  /** 完整命令覆写（最高优先，空格拆分自 HELM_DESKTOP_HUB_CMD）。 */
  readonly hubCommand?: string[];
  /** node 可执行文件覆写（用于运行 Hub 子进程）。 */
  readonly hubNode?: string;
  /** 就绪等待上限（ms）。 */
  readonly readyTimeoutMs: number;
  /** 就绪轮询间隔（ms）。 */
  readonly probeIntervalMs: number;
  /** 单次探测 HTTP 超时（ms）。 */
  readonly probeTimeoutMs: number;
  /** owned Hub 崩溃自动重启上限（稳定 stableMs 后重置）。 */
  readonly restartMaxRetries: number;
  /** 重启退避基数（ms），指数递增封顶 restartBackoffMaxMs。 */
  readonly restartBackoffMs: number;
  readonly restartBackoffMaxMs: number;
  /** 子进程稳定运行多久后重置重启预算（ms）。 */
  readonly stableMs: number;
  /** stop() 优雅期：SIGTERM 后超过此时长强制 SIGKILL（ms）。 */
  readonly stopGraceMs: number;
}

export type DesktopOverrides = Partial<
  Pick<
    DesktopConfig,
    | 'port'
    | 'dataDir'
    | 'webDistDir'
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

/** kernel dist hub 入口缺省路径（src 与 dist 下同构：均上溯两级到 packages/）。 */
export function defaultHubEntryPath(): string {
  return fileURLToPath(new URL('../../kernel/dist/main.js', import.meta.url));
}

function parsePort(raw: string | undefined, origin: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DesktopError('config_invalid', `${origin} 必须是 1 到 65535 的整数，实际: ${raw ?? '(空)'}`);
  }
  if (FORBIDDEN_PORTS.includes(port)) {
    throw new DesktopError(
      'config_invalid',
      `端口 ${port} 属于外部/历史系统保留端口（${FORBIDDEN_PORTS.join('/')}），桌面壳禁止占用`,
    );
  }
  return port;
}

/** 未设置或空串视为未配置（缺省值），其余非法值显式拒绝。 */
function envValue(raw: string | undefined): string | undefined {
  return raw === undefined || raw === '' ? undefined : raw;
}

function parsePositiveInt(raw: string | undefined, origin: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new DesktopError('config_invalid', `${origin} 必须是 >= ${min} 的整数，实际: ${raw ?? '(空)'}`);
  }
  return value;
}

/** npm 版本说明符（semver 及 prerelease/build 字符集，禁分隔符）。 */
const SAFE_VERSION_RE = /^[a-zA-Z0-9.+~-]+$/;

/** 空白拆分参数串；空串视为未配置。 */
function parseArgList(raw: string | undefined): string[] | undefined {
  const value = envValue(raw)?.trim();
  return value === undefined ? undefined : value.split(/\s+/).filter((a) => a.length > 0);
}

/**
 * 解析桌面壳配置。env 优先读 HELM_DESKTOP_* 命名空间；overrides 显式覆盖一切
 * （测试与编程式调用通道）。非法值显式抛错，绝不静默回落。
 */
export function resolveDesktopConfig(env: NodeJS.ProcessEnv, overrides: DesktopOverrides = {}): DesktopConfig {
  const portRaw = overrides.port !== undefined ? String(overrides.port) : envValue(env['HELM_DESKTOP_PORT']);
  const port = portRaw === undefined ? DESKTOP_DEFAULT_PORT : parsePort(portRaw, '端口（HELM_DESKTOP_PORT）');
  const hubCommand = overrides.hubCommand ?? (env['HELM_DESKTOP_HUB_CMD']?.trim() ? env['HELM_DESKTOP_HUB_CMD'].trim().split(/\s+/) : undefined);
  if (hubCommand !== undefined && hubCommand.length === 0) {
    throw new DesktopError('config_invalid', 'hubCommand 不能为空');
  }
  const payloadEntryArgs =
    overrides.payloadEntryArgs ?? parseArgList(env['HELM_DESKTOP_PAYLOAD_ENTRY_ARGS']);
  const payloadPackageRaw =
    overrides.payloadPackage !== undefined ? overrides.payloadPackage : envValue(env['HELM_PAYLOAD_PACKAGE']);
  const payloadPackage = payloadPackageRaw?.trim();
  if (payloadPackage === '') {
    throw new DesktopError('config_invalid', 'HELM_PAYLOAD_PACKAGE 不能是空白串');
  }
  const payloadRegistryRaw =
    overrides.payloadRegistry !== undefined ? overrides.payloadRegistry : envValue(env['HELM_PAYLOAD_REGISTRY']);
  if (payloadRegistryRaw !== undefined) {
    try {
      const parsed = new URL(payloadRegistryRaw);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`协议 ${parsed.protocol} 不支持`);
      }
    } catch (error) {
      throw new DesktopError(
        'config_invalid',
        `HELM_PAYLOAD_REGISTRY 必须是 http(s) URL（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }
  const payloadVersionRaw =
    overrides.payloadVersion !== undefined ? overrides.payloadVersion : envValue(env['HELM_PAYLOAD_VERSION']);
  if (payloadVersionRaw !== undefined && payloadVersionRaw !== 'latest' && !SAFE_VERSION_RE.test(payloadVersionRaw)) {
    throw new DesktopError('config_invalid', `HELM_PAYLOAD_VERSION 必须是版本号或 latest，实际: ${payloadVersionRaw}`);
  }
  const payloadEntry = overrides.payloadEntry ?? envValue(env['HELM_DESKTOP_PAYLOAD_ENTRY']);
  if (payloadEntryArgs !== undefined && payloadEntry === undefined) {
    throw new DesktopError(
      'config_invalid',
      'HELM_DESKTOP_PAYLOAD_ENTRY_ARGS 仅在 HELM_DESKTOP_PAYLOAD_ENTRY（payload 入口）配置后可用',
    );
  }
  const config: DesktopConfig = {
    port,
    hostname: '127.0.0.1',
    hubUrl: `http://127.0.0.1:${port}`,
    dataDir: overrides.dataDir ?? env['HELM_DESKTOP_DATA_DIR'],
    webDistDir: overrides.webDistDir ?? env['HELM_DESKTOP_WEB_DIST'],
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
    throw new DesktopError('config_invalid', 'probeIntervalMs 过小（>= 50ms）');
  }
  return config;
}

/** 生效的 hub 入口与来源（payload 优先）；args 为 payload 入口附加参数（契约上恒空）。 */
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
 * Hub 子进程环境：剥离 HELM_DESKTOP_* 与 HELM_PAYLOAD_*（防桌面壳语义泄漏到 Hub），
 * 注入内核约定变量。ELECTRON_RUN_AS_NODE 由 runner 层按需追加（见 runners.ts）。
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
  return child;
}
