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
 *
 * gzip（按需、带缓存）：文本类扩展名（js/css/html/svg/json/map/txt/md/
 * xml/webmanifest）在客户端 Accept-Encoding 含 gzip 且文件达到阈值时压缩，
 * Vary 合并 Accept-Encoding，content-length 为压缩后字节数；压缩产物按
 * 文件真实路径 + mtimeMs + size 缓存（重建/变更自动失效），条目上限有限
 * 防无界增长。已压缩格式（png/woff2 等）与二进制一律不压缩。
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
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

/** 静态 gzip 阈值（字节）：低于此值压缩收益不抵开销。 */
const STATIC_GZIP_MIN_BYTES = 1024;

/** 静态 gzip 缓存条目上限（防无界增长；按插入序淘汰最旧）。 */
const STATIC_GZIP_CACHE_MAX = 32;

/** 可压缩的文本类扩展名（其余扩展名一律 identity）。 */
const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js', '.mjs', '.css', '.html', '.htm', '.svg', '.json', '.map', '.txt', '.md', '.xml', '.webmanifest',
]);

/** 仅这两类 errno 表示「目标不存在」；其余（EACCES/ELOOP/EIO 等）是真实 IO 故障。 */
export function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** 文件解析结果：file=可服务（携带 stat 指纹，gzip 缓存失效判据）；missing=不存在（SPA 可回退）；rejected=越界/非文件（404 不回退）。 */
interface FileStatFingerprint {
  mtimeMs: number
  size: number
}
type FileResolution =
  | { kind: 'file'; real: string; stat: FileStatFingerprint }
  | { kind: 'missing' }
  | { kind: 'rejected' };

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
  /** 真实文件路径 -> gzip 产物缓存（mtime+size 指纹校验，失效重压）。 */
  private readonly gzipCache = new Map<string, { mtimeMs: number; size: number; gz: Uint8Array }>();

  constructor(root: string) {
    this.root = root;
  }

  /**
   * 处理非 /api 的静态请求（GET 命中文件；HEAD 同头去 body）。
   * @param method GET 或 HEAD（其他方法由调用方挡在静态托管之外）。
   * @param options.acceptGzip 客户端 Accept-Encoding 是否接受 gzip（由
   *   hub 层解析传入；缺省不压缩）。
   * @returns Response；不可服务（含路径穿越/符号链接越界拒绝）返回 404/400。
   */
  async serve(method: string, pathname: string, options?: { acceptGzip?: boolean }): Promise<Response> {
    const acceptGzip = options?.acceptGzip === true;
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
      return this.respondFile(method, hit.real, hit.stat, { acceptGzip });
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
        return this.respondFile(method, index.real, index.stat, { acceptGzip, spaFallback: true });
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
    let info: { isFile(): boolean; mtimeMs: number; size: number };
    try {
      info = await stat(real);
    } catch (err) {
      if (isMissingError(err)) return { kind: 'missing' };
      throw err;
    }
    if (!info.isFile()) return { kind: 'rejected' };
    return { kind: 'file', real, stat: { mtimeMs: info.mtimeMs, size: info.size } };
  }

  /** 文本类文件 gzip（带指纹缓存）：不可压缩/低于阈值返回 undefined。 */
  private gzipMaybe(fileReal: string, fingerprint: FileStatFingerprint, body: Buffer): Uint8Array | undefined {
    if (!COMPRESSIBLE_EXTENSIONS.has(extname(fileReal).toLowerCase())) return undefined;
    if (body.byteLength < STATIC_GZIP_MIN_BYTES) return undefined;
    const cached = this.gzipCache.get(fileReal);
    if (
      cached !== undefined &&
      cached.mtimeMs === fingerprint.mtimeMs &&
      cached.size === fingerprint.size
    ) {
      return cached.gz;
    }
    const gz = gzipSync(body);
    this.gzipCache.delete(fileReal);
    this.gzipCache.set(fileReal, { mtimeMs: fingerprint.mtimeMs, size: fingerprint.size, gz });
    if (this.gzipCache.size > STATIC_GZIP_CACHE_MAX) {
      const oldest = this.gzipCache.keys().next().value;
      if (oldest !== undefined) this.gzipCache.delete(oldest);
    }
    return gz;
  }

  private async respondFile(
    method: string,
    fileReal: string,
    fingerprint: FileStatFingerprint,
    opts: { acceptGzip?: boolean; spaFallback?: boolean } = {},
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
    const gz = opts.acceptGzip === true ? this.gzipMaybe(fileReal, fingerprint, body) : undefined;
    // 可压缩文本即使本次 identity（客户端不接受 gzip / 低于阈值）也带
    // Vary: Accept-Encoding——同一 URL 存在两种编码表示，缺 Vary 的
    // identity 响应可能被代理缓存跨编码复用。不可压缩格式不带。
    const compressible = COMPRESSIBLE_EXTENSIONS.has(extname(fileReal).toLowerCase());
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': cacheControl,
      'content-length': String(gz !== undefined ? gz.byteLength : body.byteLength),
      ...(compressible ? { vary: 'Accept-Encoding' } : {}),
      ...(gz !== undefined ? { 'content-encoding': 'gzip' } : {}),
      ...(opts.spaFallback ? { 'x-helm-spa-fallback': '1' } : {}),
    };
    // HEAD：同状态码与响应头（含压缩语义），body 在 Response 层面置空
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(gz !== undefined ? new Uint8Array(gz) : new Uint8Array(body), { status: 200, headers });
  }
}

/** relative 结果越出 root：`..` 前缀或跨盘（不同盘符 / UNC 前缀）绝对路径。 */
function isOutside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
