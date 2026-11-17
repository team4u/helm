/**
 * Asset domain routes: GET /api/artifacts/:id/content (raw byte passthrough),
 * GET /api/skills, GET /api/skills/:id, and conversation artifact upload
 * POST /api/conversations/:id/artifacts (delegated from conversation-routes).
 *
 * Artifact content reads carry three defense lines: metadata shape gate (the store is not a trusted boundary) +
 * three-layer realpath symlink-escape guard + truthful 404 on ENOENT.
 */
import { HelmError, isArtifactKind } from '@helm/protocol'
import type { ArtifactMetadata } from '@helm/protocol'
import { realpath as nodeFsRealpath, readFile as nodeFsReadFile } from 'node:fs/promises'
import { join as joinPath, sep as PATH_SEP } from 'node:path'
import { MAX_ARTIFACT_BYTES } from '../services/artifacts.js'
import { errorResponse, jsonOk, readBinaryBodyWithLimit, readJsonBody, type JsonRedactor } from './http-utils.js'
import { decodeSegment } from './route-match.js'
import type { KernelRuntimeLike } from './contracts.js'
import { requireIdParam, ValidationError } from './validate.js'
import type { RouteContext } from './route-context.js'

// ---------------------------------------------------------------------------
// /api/artifacts
// ---------------------------------------------------------------------------

export async function handleArtifactsDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  const fourth = segments[3]
  if (second !== undefined && third === 'content' && method === 'GET' && fourth === undefined) {
    const artifactId = requireIdParam(second, 'artifactId')
    const metadata = await kernel.artifacts.get(artifactId)
    assertArtifactMetadataShape(metadata)
    const buffer = await readArtifactBytes(kernel, metadata)
    const inline = ctx.url.searchParams.get('inline') === '1'
    const headers: Record<string, string> = {
      'content-type': metadata.mimeType,
      'content-length': String(buffer.byteLength),
      'cache-control': 'private, max-age=31536000, immutable',
    }
    const disposition = inline ? 'inline' : 'attachment'
    const fallbackName = metadata.name.replace(/[^\x20-\x7e]|["\\]/g, '_')
    const encodedName = encodeURIComponent(metadata.name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    headers['content-disposition'] = `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
    // Raw bytes passthrough (binary is not converted to string; no JSON redaction buffering).
    return new Response(buffer as unknown as BodyInit, { headers })
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

/**
 * Artifact metadata shape gate: path must have the form artifacts/<positiveConvId>/<file>,
 * conversationId must be a positive integer, and kind must be 'upload' | 'registered' | 'spill'.
 * The store (in-memory Map / sqlite) is not a trusted boundary; hand-edited DB entries must not
 * allow the HTTP layer to read arbitrary files.
 */
function assertArtifactMetadataShape(metadata: ArtifactMetadata): void {
  if (
    !Number.isInteger(metadata.conversationId) ||
    metadata.conversationId <= 0 ||
    !isArtifactKind(metadata.kind) ||
    typeof metadata.path !== 'string'
  ) {
    throw new HelmError('artifact_metadata_illegal', `invalid artifact metadata: ${metadata.id}`, 500)
  }
  const parts = metadata.path.split('/')
  if (
    parts.length !== 3 ||
    parts[0] !== 'artifacts' ||
    !/^[1-9]\d*$/.test(parts[1] ?? '') ||
    parts[2] === undefined || parts[2].length === 0 ||
    parts[2] === '.' || parts[2] === '..'
  ) {
    throw new HelmError('artifact_metadata_illegal', `invalid artifact registration path: ${metadata.path}`, 500)
  }
}

/**
 * Read raw artifact bytes using registered metadata (realpath guards against symlink escapes).
 * - metadata.path is constrained to artifacts/<convId>/<file> by assertArtifactMetadataShape;
 * - Three-layer realpath (artifacts root / conversation dir / target file) must ensure:
 *   the conversation dir stays inside the real artifacts root (prevents symlink escape on artifacts/<convId>),
 *   and the target file stays inside the conversation dir (prevents symlink escape on the filename segment);
 * - Map ENOENT faithfully to 404; rethrow other read failures (EACCES, etc.) as-is to the top level
 *   instead of misreporting them as missing.
 */
async function readArtifactBytes(kernel: KernelRuntimeLike, metadata: ArtifactMetadata): Promise<Uint8Array> {
  const artifactsRootReal = await nodeFsRealpath(joinPath(kernel.dataDir, 'artifacts'))
  const convRootReal = await nodeFsRealpath(joinPath(artifactsRootReal, String(metadata.conversationId)))
  // The conversation directory itself must not be a symlink escaping the artifacts root.
  if (!convRootReal.startsWith(artifactsRootReal + PATH_SEP)) {
    throw new HelmError('artifact_path_illegal', 'artifact conversation directory escapes artifacts root; read rejected', 500)
  }
  const target = joinPath(convRootReal, metadata.path.split('/')[2]!)
  const targetReal = await nodeFsRealpath(target)
  if (targetReal !== convRootReal && !targetReal.startsWith(convRootReal + PATH_SEP)) {
    throw new HelmError('artifact_path_illegal', 'artifact registration path escapes allowed root', 500)
  }
  try {
    const buffer = await nodeFsReadFile(targetReal)
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HelmError('artifact_file_missing', `artifact file missing: ${metadata.id}`, 404)
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Conversation artifact upload (POST /api/conversations/:id/artifacts, mounted under conversation domain)
// ---------------------------------------------------------------------------

/** Strict base64 decoder (both standard and URL-safe reject malformed trailing bits; empty string yields 0 bytes). */
function decodeBase64Strict(value: string): Uint8Array {
  if (value === '') return new Uint8Array(0)
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ValidationError('contentBase64 is not valid base64')
  }
  const buffer = Buffer.from(normalized, 'base64')
  // Round-trip re-encode must match (Node Buffer tolerates malformed trailing characters, so reject them here).
  const recheck = buffer.toString('base64').replaceAll('=', '')
  if (recheck !== normalized.replaceAll('=', '')) {
    throw new ValidationError('contentBase64 is not valid base64')
  }
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
}

/**
 * POST /api/conversations/:id/artifacts: cross-platform artifact upload.
 * - application/json: `{ name, contentBase64, mimeType? }` (Web frontend / base64 path);
 * - otherwise (application/octet-stream and other binary streams): filename via
 *   x-artifact-filename header (strictly decoded when containing `%`) or `?name=` query param;
 * Body size cap is MAX_ARTIFACT_BYTES (15 MiB); returns 201 with artifact metadata on success.
 */
export async function postConversationArtifact(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  id: number,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  // Verify conversation exists upfront (missing -> 404 immediately to avoid orphaned artifacts).
  await kernel.getConversationDetail(id, { limit: 1 })
  const contentType = (ctx.request.headers.get('content-type') ?? '').toLowerCase()
  let name: string
  let bytes: Uint8Array
  let mimeType: string | undefined
  if (contentType.includes('application/json')) {
    // Base64 expansion factor ~1.37 + 16 KiB headroom; exceeding maps to 413 artifact_too_large.
    const jsonMaxBytes = Math.ceil(MAX_ARTIFACT_BYTES * 1.37) + 16 * 1024
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(ctx.request, jsonMaxBytes)
    } catch (error) {
      if (error instanceof HelmError && error.code === 'body_too_large') {
        throw new HelmError('artifact_too_large', `request body exceeds ${jsonMaxBytes} byte limit`, 413, {
          maxBytes: jsonMaxBytes,
        })
      }
      throw error
    }
    const rawName = body.name
    if (typeof rawName !== 'string' || rawName.length === 0) {
      throw new ValidationError('name must be a non-empty string')
    }
    name = rawName
    const rawContent = body.contentBase64
    if (typeof rawContent !== 'string') {
      throw new ValidationError('contentBase64 must be a string')
    }
    bytes = decodeBase64Strict(rawContent)
    const rawMime = body.mimeType
    if (rawMime !== undefined && typeof rawMime !== 'string') {
      throw new ValidationError('mimeType must be a string')
    }
    mimeType = rawMime
    const unknown = Object.keys(body).filter((k) => !['name', 'contentBase64', 'mimeType'].includes(k))
    if (unknown.length > 0) throw new ValidationError(`unsupported field(s): ${unknown.join(', ')}`)
  } else {
    const headerName = ctx.request.headers.get('x-artifact-filename')
    const rawName =
      headerName !== null
        ? headerName.includes('%')
          ? decodeSegment(headerName)
          : headerName
        : ctx.url.searchParams.get('name')
    if (rawName === null || rawName.trim() === '') {
      throw new ValidationError('missing filename (provide x-artifact-filename header or ?name= query parameter)')
    }
    name = rawName
    const headerMime = ctx.request.headers.get('x-artifact-mime-type')
    mimeType =
      headerMime !== null && headerMime.trim() !== ''
        ? headerMime
        : (() => {
            const q = ctx.url.searchParams.get('mimeType')
            return q !== null && q.trim() !== '' ? q : undefined
          })()
    bytes = await readBinaryBodyWithLimit(ctx.request, MAX_ARTIFACT_BYTES)
  }
  // Service-layer safety net: recheck conversation existence inside writeUploaded (between the initial
  // fast check and writing, reading up to a 15 MiB upload body may take a long time); rethrow non-not_found
  // errors as-is rather than misreporting missing conversation.
  const metadata = await kernel.artifacts.writeUploaded(id, {
    name,
    bytes,
    ...(mimeType !== undefined ? { mimeType } : {}),
  }, {
    conversationExists: async (cid) => {
      try {
        await kernel.getConversationDetail(cid, { limit: 1 })
        return true
      } catch (error) {
        if (error instanceof HelmError && error.code === 'not_found') return false
        throw error
      }
    },
  })
  return jsonOk(redactor, metadata, { status: 201 })
}

// ---------------------------------------------------------------------------
// /api/skills
// ---------------------------------------------------------------------------

export async function handleSkillsDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const { method, segments } = ctx
  const second = segments[1]
  const third = segments[2]
  if (second === undefined && method === 'GET') {
    return jsonOk(redactor, await kernel.skills.list())
  }
  const skillId = requireIdParam(second ?? '', 'skillId')
  if (third === undefined && method === 'GET') {
    const path = ctx.url.searchParams.get('path') ?? undefined
    if (path !== undefined && !isSafeRelativePath(path)) {
      throw new HelmError('path_traversal', `skill file path out of bounds: ${skillId}/${path}`, 400)
    }
    const text = await kernel.skills.readFile(skillId, path)
    return jsonOk(redactor, { text })
  }
  return errorResponse(redactor, 404, 'not_found', 'route not found')
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (path.startsWith('/') || path.includes('\\')) return false
  const parts = path.split('/')
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..')
}
