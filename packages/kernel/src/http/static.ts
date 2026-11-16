/**
 * produce static hosting:packages/web/dist(Vite artifact).
 *
 * mechanism (only do file mapping and cache policy, zero business logic):
 * - path mapping:decodeURIComponent decode pathname → resolve to root inside,
 *   double heavy validate (term method prefix + realpath containment) guard against path through exceeds and symlink
 *   escape, out of bounds 404;containment use isAbsolute(relative()) decide, across
 *   (Windows symbol different) also judge out of bounds, independent of `..` prefix;
 * - hit real file: by extension back Content-Type;/assets/*(Vite carries hash artifact)
 *   back immutable long cache,index.html constant no-cache, the rest file keep guard no-cache;
 * - without extension path (SPA frontend routing such as /conversations/42): target missing and root inside
 *   store in index.html when fall back index.html(200 text/html); target out of bounds reject
 *   (contains symlink escape) one rule 404, never with SPA fall back disguise succeeded; carries extension missing 404;
 * - realpath/stat/readFile only ENOENT/ENOTDIR treated as missing;EACCES/ELOOP etc.
 *   other IO error such as throw (hub layer rotate 500 message seal), never disguise 404 mask fault
 *   (honest discipline:missing and cannot read must can zone).
 *
 * HEAD semantics: status code and response head (contains content-length) same GET, in Web Standard
 * Response layer side body placement empty - - independent of node layer discard.
 *
 * gzip(on demand, carries cache): text class extension (js/css/html/svg/json/map/txt/md/
 * xml/webmanifest) in client Accept-Encoding contains gzip and file reach threshold when compress,
 * Vary merge Accept-Encoding,content-length is compress after byte count; compress artifact by
 * file real path + mtimeMs + size cache (rebuild/change automatically expires), item cap finite
 * guard against without boundary increase long. already compress format (png/woff2 etc.) and two enter system one rule do not compress.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** extension → Content-Type(charset by text type additional). */
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

/** static gzip threshold (byte): low at this value compress benefit do not arrive overhead. */
const STATIC_GZIP_MIN_BYTES = 1024;

/** static gzip cache item cap (guard against without boundary increase long; by insert order eliminate most old). */
const STATIC_GZIP_CACHE_MAX = 32;

/** can compress text class extension (the rest extension one rule identity). */
const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js', '.mjs', '.css', '.html', '.htm', '.svg', '.json', '.map', '.txt', '.md', '.xml', '.webmanifest',
]);

/** only this two class errno means target missing; the rest (EACCES/ELOOP/EIO etc.) is real IO fault. */
export function isMissingError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** file parse result:file=can service (carry stat refer grain,gzip cache expires judge based on);missing=missing (SPA can fall back);rejected=out of bounds/non- file (404 does not fall back). */
interface FileStatFingerprint {
  mtimeMs: number
  size: number
}
type FileResolution =
  | { kind: 'file'; real: string; stat: FileStatFingerprint }
  | { kind: 'missing' }
  | { kind: 'rejected' };

/**
 * create static file service handle. directory missing (ENOENT/ENOTDIR) or store in but non- directory when throw
 * (by caller decide not enabled also is explicit diagnose);root realpath after success lock
 * real path (after continue request all with real root is base allow); other IO error such as throw.
 */
export async function createStaticServe(webDistDir: string): Promise<StaticServe> {
  const root = await realpath(webDistDir); // missing/cannot reach/non- directory: such as throw
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`static hosting directory is not directory: ${webDistDir}`);
  }
  return new StaticServe(root);
}

export class StaticServe {
  private readonly root: string;
  /** real file path -> gzip artifact cache (mtime+size refer grain validate, expires heavy press). */
  private readonly gzipCache = new Map<string, { mtimeMs: number; size: number; gz: Uint8Array }>();

  constructor(root: string) {
    this.root = root;
  }

  /**
   * handle non- /api static request (GET hit file;HEAD same head remove body).
   * @param method GET or HEAD(other method by caller block in static hosting of outside).
   * @param options.acceptGzip client Accept-Encoding is otherwise accept gzip(by
   *   hub layer parse pass; default do not compress).
   * @returns Response; cannot service (contains path through exceeds/symlink out of bounds reject) return 404/400.
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
    // parse after exceeds out (.. through exceeds) directly 404, does not give probe feedback
    if (isOutside(rel)) {
      return new Response('Not Found', { status: 404 });
    }
    const hit = await this.resolveFile(target);
    if (hit.kind === 'file') {
      return this.respondFile(method, hit.real, hit.stat, { acceptGzip });
    }
    // out of bounds/non- file (contains symlink escape): directly 404, never with SPA fall back disguise succeeded
    if (hit.kind === 'rejected') {
      return new Response('Not Found', { status: 404 });
    }
    // target missing: without extension (SPA routing) and root memory in index.html when fall back;
    // carries extension (/missing.js) or without index.html one rule 404(HTML fall back will mask true missing)
    if (extname(decoded) === '') {
      const index = await this.resolveFile(join(this.root, INDEX_HTML));
      if (index.kind === 'file') {
        return this.respondFile(method, index.real, index.stat, { acceptGzip, spaFallback: true });
      }
    }
    return new Response('Not Found', { status: 404 });
  }

  /** root inside is otherwise store in can service index.html(default probe store in only then enable judge based on). */
  async hasSpaEntry(): Promise<boolean> {
    return (await this.resolveFile(join(this.root, INDEX_HTML))).kind === 'file';
  }

  /**
   * realpath double inspect: target must parse is root inside real file (guard against symlink escape).
   * missing=missing;rejected=out of bounds or non- file;file=can service.
   * EACCES etc. real IO error on throw.
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
    // directory itself (path /):missing → by SPA fall back take over (without index.html then 404)
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

  /** text class file gzip(carries refer grain cache): cannot compress/low at threshold return undefined. */
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
    // can compress text even if this time identity(client do not accept gzip / low at threshold) also carries
    // Vary: Accept-Encoding- - the same URL store in two kinds of encode means, missing Vary 
    // identity response may by proxy cache across encode re- use. cannot compress format do not carries.
    const compressible = COMPRESSIBLE_EXTENSIONS.has(extname(fileReal).toLowerCase());
    const headers: Record<string, string> = {
      'content-type': type,
      'cache-control': cacheControl,
      'content-length': String(gz !== undefined ? gz.byteLength : body.byteLength),
      ...(compressible ? { vary: 'Accept-Encoding' } : {}),
      ...(gz !== undefined ? { 'content-encoding': 'gzip' } : {}),
      ...(opts.spaFallback ? { 'x-helm-spa-fallback': '1' } : {}),
    };
    // HEAD: same status code and response head (contains compress semantics),body in Response layer side placement empty
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(gz !== undefined ? new Uint8Array(gz) : new Uint8Array(body), { status: 200, headers });
  }
}

/** relative result exceeds out root:`..` prefix or across (different symbol / UNC prefix) absolute path. */
function isOutside(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
