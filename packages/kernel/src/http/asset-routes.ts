/**
 * 资产领域路由：GET /api/artifacts/:id/content（原始字节直传）、
 * GET /api/skills、GET /api/skills/:id，以及会话产物上传
 * POST /api/conversations/:id/artifacts（由 conversation-routes 委派）。
 *
 * 产物内容读取带三重防线：元数据形状门禁（仓库不是可信边界）+
 * 三层 realpath 防符号链接越界 + ENOENT 如实 404。
 */
import { HelmError } from '@helm/protocol'
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
    }
    const disposition = inline ? 'inline' : 'attachment'
    const fallbackName = metadata.name.replace(/[^\x20-\x7e]|["\\]/g, '_')
    const encodedName = encodeURIComponent(metadata.name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    headers['content-disposition'] = `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`
    // 原始字节直传（二进制不转字符串，不做 JSON 脱敏缓冲）。
    return new Response(buffer as unknown as BodyInit, { headers })
  }
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}

/**
 * 产物元数据形状门禁：path 必须形如 artifacts/<positiveConvId>/<file>，
 * 且 conversationId 为正整数。仓库（内存 Map/sqlite）不是可信边界，
 * 手改 DB 的伪造 meta 不得让 HTTP 层读任意文件。
 */
function assertArtifactMetadataShape(metadata: ArtifactMetadata): void {
  if (
    !Number.isInteger(metadata.conversationId) ||
    metadata.conversationId <= 0 ||
    typeof metadata.path !== 'string'
  ) {
    throw new HelmError('artifact_metadata_illegal', `产物元数据非法: ${metadata.id}`, 500)
  }
  const parts = metadata.path.split('/')
  if (
    parts.length !== 3 ||
    parts[0] !== 'artifacts' ||
    !/^[1-9]\d*$/.test(parts[1] ?? '') ||
    parts[2] === undefined || parts[2].length === 0 ||
    parts[2] === '.' || parts[2] === '..'
  ) {
    throw new HelmError('artifact_metadata_illegal', `产物登记路径非法: ${metadata.path}`, 500)
  }
}

/**
 * 按登记元数据读取产物原始字节（realpath 防符号链接越界）。
 * - metadata.path 经 assertArtifactMetadataShape 已限定为
 *   artifacts/<convId>/<file>；
 * - 三层 realpath（artifacts 根 / 会话目录 / 目标文件）后必须满足：
 *   会话目录仍在真实 artifacts 根内（防 artifacts/<convId> 本身是逃逸
 *   软链），目标文件仍在会话目录内（防文件名段是逃逸软链）；
 * - ENOENT 如实 404；其他读失败（EACCES 等）原样上抛交顶层定性，
 *   绝不统一伪称 missing。
 */
async function readArtifactBytes(kernel: KernelRuntimeLike, metadata: ArtifactMetadata): Promise<Uint8Array> {
  const artifactsRootReal = await nodeFsRealpath(joinPath(kernel.dataDir, 'artifacts'))
  const convRootReal = await nodeFsRealpath(joinPath(artifactsRootReal, String(metadata.conversationId)))
  // 会话目录本身不得是逃出 artifacts 根的符号链接。
  if (!convRootReal.startsWith(artifactsRootReal + PATH_SEP)) {
    throw new HelmError('artifact_path_illegal', '产物会话目录越出 artifacts 根，拒绝读取', 500)
  }
  const target = joinPath(convRootReal, metadata.path.split('/')[2]!)
  const targetReal = await nodeFsRealpath(target)
  if (targetReal !== convRootReal && !targetReal.startsWith(convRootReal + PATH_SEP)) {
    throw new HelmError('artifact_path_illegal', '产物登记路径越界', 500)
  }
  try {
    const buffer = await nodeFsReadFile(targetReal)
    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HelmError('artifact_file_missing', `产物文件缺失: ${metadata.id}`, 404)
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 会话产物上传（POST /api/conversations/:id/artifacts，挂载点在会话领域）
// ---------------------------------------------------------------------------

/** 严格 base64（标准/URL-safe 均拒残缺 shape；空串允许 = 0 字节）。 */
function decodeBase64Strict(value: string): Uint8Array {
  if (value === '') return new Uint8Array(0)
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new ValidationError('contentBase64 不是合法 base64')
  }
  const buffer = Buffer.from(normalized, 'base64')
  // 回读长度一致才可信（Buffer 宽容忽略尾部残缺字符，不能用）。
  const recheck = buffer.toString('base64').replaceAll('=', '')
  if (recheck !== normalized.replaceAll('=', '')) {
    throw new ValidationError('contentBase64 不是合法 base64')
  }
  return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
}

/**
 * POST /api/conversations/:id/artifacts：跨平台产物上传。
 * - application/json：{ name, contentBase64, mimeType? }（Web 前端/base64 场景）；
 * - 其他（application/octet-stream 等二进制流）：文件名经
 *   x-artifact-filename 头（含 % 时严格解码）或 ?name= 查询参数；
 * 体积上限统一 MAX_ARTIFACT_BYTES（15 MiB）；成功 201 返回产物元数据。
 */
export async function postConversationArtifact(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  id: number,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  // 会话存在性校验（不存在自动 404，不留孤儿产物）。
  await kernel.getConversationDetail(id, { limit: 1 })
  const contentType = (ctx.request.headers.get('content-type') ?? '').toLowerCase()
  let name: string
  let bytes: Uint8Array
  let mimeType: string | undefined
  if (contentType.includes('application/json')) {
    // base64 膨胀系数 ~1.37 + 16KiB 余量；超限映射为 413 artifact_too_large。
    const jsonMaxBytes = Math.ceil(MAX_ARTIFACT_BYTES * 1.37) + 16 * 1024
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(ctx.request, jsonMaxBytes)
    } catch (error) {
      if (error instanceof HelmError && error.code === 'body_too_large') {
        throw new HelmError('artifact_too_large', `请求体超过 ${jsonMaxBytes} 字节上限`, 413, {
          maxBytes: jsonMaxBytes,
        })
      }
      throw error
    }
    const rawName = body.name
    if (typeof rawName !== 'string' || rawName.length === 0) {
      throw new ValidationError('name 需为非空字符串')
    }
    name = rawName
    const rawContent = body.contentBase64
    if (typeof rawContent !== 'string') {
      throw new ValidationError('contentBase64 需为字符串')
    }
    bytes = decodeBase64Strict(rawContent)
    const rawMime = body.mimeType
    if (rawMime !== undefined && typeof rawMime !== 'string') {
      throw new ValidationError('mimeType 需为字符串')
    }
    mimeType = rawMime
    const unknown = Object.keys(body).filter((k) => !['name', 'contentBase64', 'mimeType'].includes(k))
    if (unknown.length > 0) throw new ValidationError(`不支持的字段: ${unknown.join(', ')}`)
  } else {
    const headerName = ctx.request.headers.get('x-artifact-filename')
    const rawName =
      headerName !== null
        ? headerName.includes('%')
          ? decodeSegment(headerName)
          : headerName
        : ctx.url.searchParams.get('name')
    if (rawName === null || rawName.trim() === '') {
      throw new ValidationError('缺少文件名（请提供 x-artifact-filename 请求头或 ?name= 查询参数）')
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
  // 服务层兑底：writeUploaded 落盘前复核会话存在（入口快速路径检查与写盘
  // 之间隔整个上传体读取，最长可达 15 MiB 时长）；非 not_found 错误如实
  // 上抛，不伪称会话缺失。
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
      throw new HelmError('path_traversal', `技能文件路径越界: ${skillId}/${path}`, 400)
    }
    const text = await kernel.skills.readFile(skillId, path)
    return jsonOk(redactor, { text })
  }
  return errorResponse(redactor, 404, 'not_found', '路由不存在')
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false
  if (path.startsWith('/') || path.includes('\\')) return false
  const parts = path.split('/')
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..')
}
