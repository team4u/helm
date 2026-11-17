/**
 * Production static asset hosting for `packages/web/dist` (Vite build output).
 *
 * Mechanism (only file mapping and cache policy; zero business logic):
 * - Path mapping: decodeURIComponent(pathname) -> resolve inside root with two-layer validation
 *   (lexical relative check + realpath containment) to block path traversal and symlink escapes (404);
 *   containment uses `isAbsolute(relative())`, treating cross-drive paths (Windows) as out of bounds too.
 * - Real file hits: maps extension to Content-Type; `/assets/*` (Vite hashed assets) get immutable
 *   long-lived caching, `index.html` is always `no-cache`, and all other files stay conservative `no-cache`.
 * - Extensionless paths (SPA frontend routes like `/conversations/42`): fall back to `index.html`
 *   (200 text/html) when the target is missing and `index.html` exists under root; out-of-bounds targets
 *   (including symlink escapes) always return 404 rather than masking with SPA fallback; missing files
 *   with extensions always return 404.
 * - `realpath`/`stat`/`readFile` only treat `ENOENT`/`ENOTDIR` as missing; real I/O errors (`EACCES`/`ELOOP`,
 *   etc.) propagate as-is (wrapped into 500 by the Hub layer) instead of being disguised as 404 (honest
 *   discipline: missing and unreadable must be distinguishable).
 *
 * HEAD semantics: identical status and headers (including `content-length`) to GET, with an empty body
 * at the Web Standard Response layer independent of Node adapter stripping.
 *
 * On-demand cached gzip: compresses text extensions (js/css/html/svg/json/map/txt/md/xml/webmanifest)
 * when client `Accept-Encoding` accepts gzip and size meets the threshold, merges `Vary: Accept-Encoding`,
 * sets `content-length` to compressed byte length, and caches by `realpath + mtimeMs + size` (bounded LRU/FIFO
 * to avoid unbounded growth). Pre-compressed and binary formats (png/woff2, etc.) are never recompressed.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Extension -> Content-Type (with UTF-8 charset for text types). */
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

/** Static gzip threshold (bytes): below this, compression gains do not outweigh overhead. */
const STATIC_GZIP_MIN_BYTES = 1024;

/** Maximum cached gzip artifacts (prevents unbounded growth; evicts oldest by insertion order). */
const STATIC_GZIP_CACHE_MAX = 32;

/** Compressible text extensions (all others stay identity-encoded). */
const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js', '.mjs', '.css', '.html', '.htm', '.svg', '.json', '.map', '.txt', '.md', '.xml', '.webmanifest',
]);

/** Only these two errnos mean the target does not exist; all others (EACCES/ELOOP/EIO, etc.) are real I/O faults. */
function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** File resolution outcome: `file` = servable (with stat fingerprint for gzip cache invalidation); `missing` = absent (SPA fallback eligible); `rejected` = out of bounds / non-file (404, no fallback). */
interface FileStatFingerprint {
  mtimeMs: number
  size: number
}
type FileResolution =
  | { kind: 'file'; real: string; stat: FileStatFingerprint }
  | { kind: 'missing' }
  | { kind: 'rejected' };

/**
 * Create a static file server handle. Throws if the directory is missing (`ENOENT`/`ENOTDIR`) or not a
 * directory (lets callers that explicitly enabled it surface a clear diagnostic); pins the canonical
 * `realpath` of the root for all subsequent containment checks. Rethrows all other I/O errors verbatim.
 */
export async function createStaticServe(webDistDir: string): Promise<StaticServe> {
  const root = await realpath(webDistDir); // missing / inaccessible / non-directory: rethrow verbatim
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`static hosting path is not a directory: ${webDistDir}`);
  }
  return new StaticServe(root);
}

export class StaticServe {
  private readonly root: string;
  /** Real file path -> cached gzip artifact (validated via mtime + size fingerprint; recompressed on change). */
  private readonly gzipCache = new Map<string, { mtimeMs: number; size: number; gz: Uint8Array }>();

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Handle non-`/api` static requests (GET serves body; HEAD returns identical headers with empty body).
   * @param method GET or HEAD (other methods are blocked by the caller outside static hosting).
   * @param options.acceptGzip Whether client `Accept-Encoding` accepts gzip (parsed by Hub; defaults to false).
   * @returns Response; unservable paths (including path traversal / symlink escapes) return 404/400.
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
    // Out-of-bounds lexical resolution (`..` traversal): fail immediately with 404 without probing hints
    if (isOutside(rel)) {
      return new Response('Not Found', { status: 404 });
    }
    const hit = await this.resolveFile(target);
    if (hit.kind === 'file') {
      return this.respondFile(method, hit.real, hit.stat, { acceptGzip });
    }
    // Out-of-bounds or non-file (including symlink escapes): return 404 immediately, never mask with SPA fallback
    if (hit.kind === 'rejected') {
      return new Response('Not Found', { status: 404 });
    }
    // Missing target: fall back to `index.html` only for extensionless paths (SPA routes) when `index.html` exists;
    // missing paths with extensions (`/missing.js`) or missing `index.html` return 404 (HTML fallback would mask missing assets).
    if (extname(decoded) === '') {
      const index = await this.resolveFile(join(this.root, INDEX_HTML));
      if (index.kind === 'file') {
        return this.respondFile(method, index.real, index.stat, { acceptGzip, spaFallback: true });
      }
    }
    return new Response('Not Found', { status: 404 });
  }

  /** Whether a servable `index.html` exists under root (used to decide auto-enabling). */
  async hasSpaEntry(): Promise<boolean> {
    return (await this.resolveFile(join(this.root, INDEX_HTML))).kind === 'file';
  }

  /**
   * Double check via `realpath`: target must resolve to a regular file inside `root` (prevents symlink escapes).
   * `missing` = absent; `rejected` = out of bounds or non-regular file; `file` = servable.
   * Real I/O errors such as `EACCES` are rethrown verbatim.
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
    // The root directory itself (path `/`): treat as missing so SPA fallback handles it (404 if no index.html)
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

  /** Gzip-compress text files (with fingerprint cache): returns undefined if incompressible or below threshold. */
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
    // Compressible text files always carry `Vary: Accept-Encoding` even when served as identity (e.g. client
    // didn't accept gzip or payload was below threshold)—the URL has two representations, and omitting Vary
    // could let proxies reuse an identity response across encodings. Incompressible formats omit Vary.
    const compressible = COMPRESSIBLE_EXTENSIONS.has(extname(fileReal).toLowerCase());
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': cacheControl,
      'content-length': String(gz !== undefined ? gz.byteLength : body.byteLength),
      ...(compressible ? { vary: 'Accept-Encoding' } : {}),
      ...(gz !== undefined ? { 'content-encoding': 'gzip' } : {}),
      ...(opts.spaFallback ? { 'x-helm-spa-fallback': '1' } : {}),
    };
    // HEAD: identical status and response headers (including compression headers), empty body on Response
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(gz !== undefined ? new Uint8Array(gz) : new Uint8Array(body), { status: 200, headers });
  }
}

/** Whether a `relative()` result escapes root: `..` prefix or cross-drive absolute path (different drive letter / UNC prefix). */
function isOutside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
