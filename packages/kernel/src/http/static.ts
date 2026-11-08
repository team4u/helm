/**
 * 生产静态托管：packages/web/dist（Vite 产物）。
 *
 * 机制（只做文件映射与缓存策略，零业务逻辑）：
 * - 路径映射：decodeURIComponent 解码 pathname → resolve 到 webDistDir 内，
 *   双重校验（前缀 + realpath）防路径穿越与符号链接逃逸，越界 404；
 * - 命中真实文件：按扩展名回 Content-Type；/assets/*（Vite 带 hash 产物）
 *   回 immutable 长缓存，index.html 恒 no-cache，其余文件保守 no-cache；
 * - 无扩展名路径（SPA 前端路由如 /conversations/42）：文件不存在时回退
 *   index.html（200 text/html），让前端路由接管；
 * - 带扩展名但文件不存在（如 /missing.js）：404（HTML 回退会掩盖真缺失）。
 *
 * HEAD 语义：状态码与响应头同 GET，body 由 node http 层丢弃。
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

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

/**
 * 创建静态文件服务句柄；目录不可用（不存在 / realpath 失败）返回 undefined，
 * 调用方按「未启用静态托管」处理（回落既有 JSON 404）。
 */
export async function createStaticServe(webDistDir: string): Promise<StaticServe | undefined> {
  try {
    const root = await realpath(webDistDir);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return undefined;
    return new StaticServe(root);
  } catch {
    return undefined;
  }
}

export class StaticServe {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * 处理非 /api 的 GET/HEAD 静态请求。
   * @returns Response；不可服务（含路径穿越拒绝）返回 404/400。
   */
  async serve(pathname: string): Promise<Response> {
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
    if (rel.startsWith('..')) {
      return new Response('Not Found', { status: 404 });
    }
    const fileReal = await this.resolveFile(target);
    if (fileReal !== undefined) {
      return this.respondFile(fileReal);
    }
    // 文件不存在：无扩展名（SPA 路由）回退 index.html；带扩展名 404
    if (extname(decoded) === '') {
      const indexReal = await this.resolveFile(join(this.root, INDEX_HTML));
      if (indexReal !== undefined) {
        return this.respondFile(indexReal, { spaFallback: true });
      }
    }
    return new Response('Not Found', { status: 404 });
  }

  /**
   * realpath 双检：目标必须解析为 root 内的真实文件（防符号链接逃逸）。
   * 不存在 / 越界 / 是目录 → undefined。
   */
  private async resolveFile(target: string): Promise<string | undefined> {
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      return undefined;
    }
    const rel = relative(this.root, real);
    if (rel.length === 0 || rel.startsWith(`..${sep}`) || rel === '..' || rel.split(sep).includes('..')) {
      return undefined;
    }
    try {
      if (!(await stat(real)).isFile()) return undefined;
    } catch {
      return undefined;
    }
    return real;
  }

  private async respondFile(fileReal: string, opts: { spaFallback?: boolean } = {}): Promise<Response> {
    let body: Buffer;
    try {
      body = await readFile(fileReal);
    } catch {
      return new Response('Not Found', { status: 404 });
    }
    const rel = relative(this.root, fileReal);
    const type = CONTENT_TYPES[extname(fileReal).toLowerCase()] ?? 'application/octet-stream';
    const cacheControl = rel.split(sep)[0] === 'assets'
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': cacheControl,
      ...(opts.spaFallback ? { 'x-helm-spa-fallback': '1' } : {}),
    };
    return new Response(new Uint8Array(body), { status: 200, headers });
  }
}
