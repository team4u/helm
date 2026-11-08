/**
 * 生产静态托管：packages/web/dist（Vite 产物）。
 *
 * 机制（只做文件映射与缓存策略，零业务逻辑）：
 * - 路径映射：decodeURIComponent 解码 pathname → resolve 到 root 内，
 *   双重校验（词法前缀 + realpath containment）防路径穿越与符号链接
 *   逃逸，越界 404；containment 用 isAbsolute(relative()) 判定，跨盘
 *   （Windows 盘符不同）也判越界，不依赖 `..` 前缀；
 * - 命中真实文件：按扩展名回 Content-Type；/assets/*（Vite 带 hash 产物）
 *   回 immutable 长缓存，index.html 恒 no-cache，其余文件保守 no-cache；
 * - 无扩展名路径（SPA 前端路由如 /conversations/42）：目标「缺失」且 root 内
 *   存在 index.html 时回退 index.html（200 text/html）；目标「越界拒绝」
 *   （含 symlink 逃逸）一律 404，绝不以 SPA 回退伪装成功；带扩展名缺失 404；
 * - realpath/stat/readFile 仅 ENOENT/ENOTDIR 视为「不存在」；EACCES/ELOOP 等
 *   其他 IO 错误如实抛出（hub 层转 500 信封），绝不伪装 404 掩盖故障
 *   （诚实性纪律：missing 与不可读必须可区分）。
 *
 * HEAD 语义：状态码与响应头（含 content-length）同 GET，在 Web Standard
 * Response 层面 body 置空——不依赖 node 层丢弃。
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 扩展名 → Content-Type（charset 按文本类型附加）。 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const INDEX_HTML = 'index.html';

/** 仅这两类 errno 表示「目标不存在」；其余（EACCES/ELOOP/EIO 等）是真实 IO 故障。 */
export function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** 文件解析结果：file=可服务；missing=不存在（SPA 可回退）；rejected=越界/非文件（404 不回退）。 */
type FileResolution = { kind: 'file'; real: string } | { kind: 'missing' } | { kind: 'rejected' };

/**
 * 创建静态文件服务句柄。目录缺失（ENOENT/ENOTDIR）或存在但非目录时抛出
 * （由调用方决定「未启用」还是「显式诊断」）；root realpath 成功后锁定
 * 真实路径（后续请求都以真实 root 为基准）；其他 IO 错误如实抛出。
 */
export async function createStaticServe(webDistDir: string): Promise<StaticServe> {
  const root = await realpath(webDistDir); // 缺失/不可达/非目录：如实抛出
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`静态托管目录不是目录: ${webDistDir}`);
  }
  return new StaticServe(root);
}

export class StaticServe {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * 处理非 /api 的静态请求（GET 命中文件；HEAD 同头去 body）。
   * @param method GET 或 HEAD（其他方法由调用方挡在静态托管之外）。
   * @returns Response；不可服务（含路径穿越/符号链接越界拒绝）返回 404/400。
   */
  async serve(method: string, pathname: string): Promise<Response> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (decoded.includes('\0')) {
      return new Response('Bad Request', { status: 400 });
    }
    const target = resolve(this.root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
    const rel = relative(this.root, target);
    // 解析后越出根（.. 穿越）直接 404，不给探测反馈
    if (isOutside(rel)) {
      return new Response('Not Found', { status: 404 });
    }
    const hit = await this.resolveFile(target);
    if (hit.kind === 'file') {
      return this.respondFile(method, hit.real);
    }
    // 越界/非文件（含 symlink 逃逸）：直接 404，绝不以 SPA 回退伪装成功
    if (hit.kind === 'rejected') {
      return new Response('Not Found', { status: 404 });
    }
    // 目标缺失：无扩展名（SPA 路由）且 root 内存在 index.html 时回退；
    // 带扩展名（/missing.js）或无 index.html 一律 404（HTML 回退会掩盖真缺失）
    if (extname(decoded) === '') {
      const index = await this.resolveFile(join(this.root, INDEX_HTML));
      if (index.kind === 'file') {
        return this.respondFile(method, index.real, { spaFallback: true });
      }
    }
    return new Response('Not Found', { status: 404 });
  }

  /** root 内是否存在可服务的 index.html（缺省探测「存在才启用」的判据）。 */
  async hasSpaEntry(): Promise<boolean> {
    return (await this.resolveFile(join(this.root, INDEX_HTML))).kind === 'file';
  }

  /**
   * realpath 双检：目标必须解析为 root 内的真实文件（防符号链接逃逸）。
   * missing=不存在；rejected=越界或非文件；file=可服务。
   * EACCES 等真实 IO 错误上抛。
   */
  private async resolveFile(target: string): Promise<FileResolution> {
    let real: string;
    try {
      real = await realpath(target);
    } catch (err) {
      if (isMissingError(err)) return { kind: 'missing' };
      throw err;
    }
    const rel = relative(this.root, real);
    // 目录自身（根路径 /）：missing → 由 SPA 回退接管（无 index.html 则 404）
    if (rel.length === 0) return { kind: 'missing' };
    if (isOutside(rel) || rel.split(sep).includes('..')) {
      return { kind: 'rejected' };
    }
    try {
      if (!(await stat(real)).isFile()) return { kind: 'rejected' };
    } catch (err) {
      if (isMissingError(err)) return { kind: 'missing' };
      throw err;
    }
    return { kind: 'file', real };
  }

  private async respondFile(
    method: string,
    fileReal: string,
    opts: { spaFallback?: boolean } = {},
  ): Promise<Response> {
    let body: Buffer;
    try {
      body = await readFile(fileReal);
    } catch (err) {
      if (isMissingError(err)) return new Response('Not Found', { status: 404 });
      throw err;
    }
    const rel = relative(this.root, fileReal);
    const type = CONTENT_TYPES[extname(fileReal).toLowerCase()] ?? 'application/octet-stream';
    const cacheControl = rel.split(sep)[0] === 'assets'
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': cacheControl,
      'content-length': String(body.byteLength),
      ...(opts.spaFallback ? { 'x-helm-spa-fallback': '1' } : {}),
    };
    // HEAD：同状态码与响应头（含 content-length），body 在 Response 层面置空
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(new Uint8Array(body), { status: 200, headers });
  }
}

/** relative 结果越出 root：`..` 前缀或跨盘（不同盘符 / UNC 前缀）绝对路径。 */
function isOutside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
