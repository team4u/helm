/**
 * plugin-manifest.ts：外部插件清单解析层（plugin.json 与 package.json helm 字段）。
 *
 * 职责（自 external-loader 拆出，规则逐字不变）：
 * - plugin.json：必须是可解析的 JSON 对象；可选字段 `clientRoot`（前端源根
 *   目录）、`clientDependencies`（前端受控 npm 说明符数组）、`dependencies`
 *   （插件间依赖 ID 数组）；非法值显式拒绝，绝不静默忽略；
 * - package.json `helm` 字段（{ main?, clientRoot?, clientDependencies?,
 *   dependencies? }）：helm.main / 顶层 main 为 npm 标准入口（相对路径；
 *   .js 后缀重写同名 TS 源由入口解析层处理）；顶层 dependencies 保持 npm
 *   语义（运行时依赖），绝不误读为插件间依赖；
 * - 无 helm 字段时回落 package.json main（npm 标准入口）；
 * - 说明符/依赖 ID 的形状校验与去重（非法项显式 plugin_manifest_invalid）；
 * - manifest 元数据读取（id/name/description/version，供故障占位登记展示；
 *   manifest 不存在或损坏时返回空对象）。
 *
 * IO 错误纪律：仅 ENOENT / ENOTDIR 表示「文件不存在」；EACCES 等其他 IO
 * 错误显式抛错（plugin_scan_failed / plugin_manifest_invalid），绝不静默吞错。
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HelmError } from '@helm/protocol';

/**
 * npm 标准入口发现（additive，不牺牲现有 plugin.json/约定入口格式）：
 * package.json 的 `helm` 字段（{ main?, clientRoot?, clientDependencies?, dependencies? }）：
 * - helm.main / package.json.main 指定后端入口（相对路径，越根校验同
 *   plugin.json main；.js 后缀自动重写同名 .ts 源）；
 * - helm.clientRoot 供包作者声明前端源根目录，由 readHelmClientRoot 透出，
 *   normalizeDefinition 缺省仍为插件目录本身；
 * - helm.clientDependencies / plugin.json clientDependencies 声明前端受控 npm
 *   依赖说明符（裸包名/子路径），归一映射到插件自身目录作为解析根；
 * - helm.dependencies / plugin.json dependencies 声明插件间依赖（仅插件 ID）；
 *   package.json 顶层 dependencies 保持 npm 语义（运行时依赖），绝不误读；
 * - 优先级：plugin.json（main / 约定入口）> package.json helm.main >
 *   package.json main > 约定入口探测；无任何命中则为纯数据目录。
 */
export interface HelmManifest {
  /** package.json helm.clientRoot 声明（原始相对路径；未声明时缺省）。 */
  clientRoot?: string;
  /** 前端受控 npm 依赖说明符（裸包名或子路径；已验证去重）。 */
  clientDependencies?: string[];
  /** 插件间依赖 ID 列表（已验证去重）。 */
  dependencies?: string[];
}

/** 插件 ID 字符集（与宿主插件 id 同集：字母数字 : _ -）。 */
export const MANIFEST_PLUGIN_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

/**
 * 受控前端 npm 说明符合法性：非空、非路径形态（不以 . 或 / 开头）、无反斜杠、
 * 无 .. 段、无空白；允许 @scope/name 与子路径（子路径需逐项声明，不做前缀通配）。
 */
function isValidClientDependencySpec(spec: string): boolean {
  if (spec.length === 0 || spec.length > 214) return false;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.includes('\\')) return false;
  if (/\s/.test(spec)) return false;
  if (spec.split('/').includes('..')) return false;
  return /^(@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._~-]+)*$/.test(spec);
}

/** 校验并去重清单声明的前端 npm 说明符（非法项显式 plugin_manifest_invalid）。 */
function normalizeClientDependencySpecs(dirPath: string, source: string, values: unknown): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !isValidClientDependencySpec(v))) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件 ${dirPath} 的 ${source} 必须是受控 npm 说明符字符串数组（裸包名或子路径，禁止相对/绝对路径与 .. 段）`,
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

/** 校验并去重清单声明的插件间依赖 ID（非法项显式 plugin_manifest_invalid）。 */
function normalizeManifestDependencies(dirPath: string, source: string, values: unknown): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !MANIFEST_PLUGIN_ID_PATTERN.test(v))) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件 ${dirPath} 的 ${source} 必须是插件 ID 字符串数组（仅允许字母数字 : _ -；npm 依赖请声明在 package.json dependencies）`,
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

/** 对外读取 plugin.json clientRoot 或 package.json helm.clientRoot（normalizeDefinition 增强用；plugin.json 优先）。 */
export function readHelmClientRoot(dirPath: string): string | undefined {
  const manifestClientRoot = readManifestClientRoot(dirPath);
  if (manifestClientRoot !== undefined) return manifestClientRoot;
  return readHelmField(dirPath)?.clientRoot;
}

/** 对外读取清单声明的前端受控 npm 说明符（plugin.json 与 package.json helm 合并去重；供受管安装补装）。 */
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
 * 从 plugin.json 读取可选元数据（id/name/description/version），供故障占位
 * 登记展示；manifest 不存在或损坏时返回空对象。
 */
export function readManifestMeta(dirPath: string): Record<string, unknown> {
  try {
    return readManifest(join(dirPath, 'plugin.json'));
  } catch {
    return {};
  }
}

/** 读取 plugin.json（不存在返回 undefined；IO 错误显式抛错，不静默当无清单）。 */
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
      `外部插件目录不可读: ${manifestPath}（${err instanceof Error ? err.message : String(err)}）`,
      500,
      { manifestPath, code },
    );
  }
  if (!exists) return undefined;
  return readManifest(manifestPath);
}

/** 读取 plugin.json 的可选扩展字段（clientDependencies / dependencies；无 plugin.json 返回 undefined）。 */
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

/** 读取 plugin.json 的 clientRoot 字段（无 plugin.json 返回 undefined；存在但非字符串显式报错）。 */
function readManifestClientRoot(dirPath: string): string | undefined {
  const manifest = readManifestIfPresent(dirPath);
  if (manifest === undefined) return undefined;
  const clientRoot = manifest['clientRoot'];
  if (clientRoot === undefined) return undefined;
  if (typeof clientRoot !== 'string' || clientRoot.length === 0) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件 ${dirPath} 的 plugin.json clientRoot 必须是非空字符串`,
      500,
      { dirPath, clientRoot: String(clientRoot) },
    );
  }
  return clientRoot;
}

/** 读取 package.json 的 helm 字段（对象形状校验；无 package.json 返回 null）。 */
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
      `外部插件 package.json 不可读: ${pkgPath}（${err instanceof Error ? err.message : String(err)}）`,
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
      `外部插件 package.json 不是合法 JSON: ${pkgPath}（${err instanceof Error ? err.message : String(err)}）`,
      500,
      { dirPath },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const helm = (parsed as Record<string, unknown>)['helm'];
  if (helm === undefined) {
    // 无 helm 字段：回落 package.json main（npm 标准入口）
    const main = (parsed as Record<string, unknown>)['main'];
    if (typeof main === 'string' && main.length > 0) return { main };
    return null;
  }
  if (typeof helm !== 'object' || helm === null || Array.isArray(helm)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件 ${dirPath} 的 package.json helm 字段必须是对象`,
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
        `外部插件 ${dirPath} 的 package.json helm.main 必须是非空字符串`,
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
        `外部插件 ${dirPath} 的 package.json helm.clientRoot 必须是非空字符串`,
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

/** 读取并解析 plugin.json；损坏 / 非对象一律显式 plugin_manifest_invalid。 */
export function readManifest(manifestPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件清单读取失败: ${manifestPath}（${err instanceof Error ? err.message : String(err)}）`,
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
      `外部插件清单不是合法 JSON: ${manifestPath}（${err instanceof Error ? err.message : String(err)}）`,
      500,
      { manifestPath },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HelmError(
      'plugin_manifest_invalid',
      `外部插件清单必须是 JSON 对象: ${manifestPath}`,
      500,
      { manifestPath },
    );
  }
  return parsed as Record<string, unknown>;
}
