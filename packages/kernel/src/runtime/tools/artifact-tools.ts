/**
 * 会话产物工具（register_artifact / read_artifact）。
 *
 * register_artifact：把会话靶点节点上的真实普通文件复制登记为当前会话产物
 *（经 artifacts.writeUploaded 落 Hub 数据目录，Web 可预览/下载），支持二进制，
 * 上限 15 MiB。诚实性契约：远端必经 EnvFabric 的 canonicalPath / fileInfo
 * 预检 + openBinaryReader 同 fd 有界读取；节点离线或 EnvFabric 缺失显式失败
 *（guards.ts），绝不回退 local 误读 Hub 本机磁盘，也不 fallback
 * readBinaryFile 的无界全量缓冲；只接受普通文件（stat 预检 + O_NONBLOCK
 *（平台支持时）封 stat→open 竞态 + 同一 fd fstat 权威复核）；local 有界
 * 循环读到 EOF（readArtifactBytesFromHandle）。尺寸超限/中途变更文案在此
 * 常量化（预检/打开后/读取后共用，绝不漂移）。
 *
 * read_artifact：分页读取 spill 产物（≤4KiB，UTF-8 边界对齐保证前进）；仅
 * 允许当前会话（含父会话授权链）产物，不接受任意路径。诚实性：仅把
 *「产物不存在」（FileNotFoundError）归为 artifact_not_found；存储真实读取
 * 失败如实透出原始错误（artifact_read_failed，经脱敏），绝不吞成 not_found。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { constants as fsConstants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { MAX_ARTIFACT_BYTES } from '../../services/artifacts.js'
import { FileNotFoundError } from '../../services/index.js'
import { resolveTargetPath } from './target-path.js'
import { resolveToolTarget } from './tool-target.js'
import { requireRemoteEnv } from './guards.js'
import { basenameForShape } from './file-env.js'
import type { HelmToolDeps } from '../tool-deps.js'

/** register_artifact 共用分类/超限文案（预检 / 打开后复核 / 读取后共用）。 */
const registerIsDirectoryText = (path: string): string =>
  `register_failed: ${path} 是目录，register_artifact 仅支持普通文件`
const artifactTooLargeText = (path: string, size: number): string =>
  `artifact_too_large: ${path} 为 ${size} 字节，超过单产物 ${MAX_ARTIFACT_BYTES} 字节（15 MiB）上限`
const artifactTooLargeReadText = (path: string, size: number): string =>
  `artifact_too_large: ${path} 读取到 ${size} 字节，超过单产物 ${MAX_ARTIFACT_BYTES} 字节（15 MiB）上限`

/** register_artifact local 读取结果：成功携带完整字节；失败为机器可读码。 */
export type ArtifactFileBytes =
  | { ok: true; bytes: Buffer; size: number }
  | { ok: false; code: 'artifact_too_large'; read: number }
  | { ok: false; code: 'file_changed'; detail: string }

/** helper 读取所需的最小句柄面（真实 FileHandle 结构化满足，便于测试注入短读/变更）。 */
export interface ArtifactReadHandle {
  stat(): Promise<{ size: number; mtimeMs: number; ctimeMs: number }>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number; buffer: Buffer }>
}

/** 单次读取块大小（有界循环读，避免一次性占 15 MiB 缓冲）。 */
const ARTIFACT_READ_CHUNK_BYTES = 256 * 1024

/** local 打开标志：O_RDONLY + 平台支持时 O_NONBLOCK。stat 预检与 open 之间存在
 *  竞态窗口（普通文件被换成 FIFO/设备文件会使纯 O_RDONLY 的 open 无限阻塞），
 *  O_NONBLOCK 让 open 立即返回、由同一 fd 上的 fstat 权威拒绝；Windows
 *  libuv 不支持 O_NONBLOCK，仅用 O_RDONLY（Windows 无 FIFO，风险面不同）。 */
function artifactOpenFlags(): number {
  return process.platform === 'win32'
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | (fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK!
}

/**
 * 同一 FileHandle 上有界读到 EOF（register_artifact local 路径唯一实现）：
 * 逐块循环到 EOF（短读只推进游标，绝不当完整文件）；总预算 MAX+1（读到
 * 上限+1 即实证超限）；读后同 fd stat 对比 size/mtime/ctime，中途变更显式
 * file_changed，绝不把旧前缀登记成功。
 */
export async function readArtifactBytesFromHandle(handle: ArtifactReadHandle): Promise<ArtifactFileBytes> {
  const before = await handle.stat()
  const budget = MAX_ARTIFACT_BYTES + 1
  const chunks: Buffer[] = []
  let total = 0
  let position = 0
  for (;;) {
    const want = Math.min(ARTIFACT_READ_CHUNK_BYTES, budget - total)
    if (want <= 0) return { ok: false, code: 'artifact_too_large', read: total }
    const chunk = Buffer.alloc(want)
    const { bytesRead } = await handle.read(chunk, 0, want, position)
    if (bytesRead === 0) break
    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
    position += bytesRead
    if (total > MAX_ARTIFACT_BYTES) return { ok: false, code: 'artifact_too_large', read: total }
  }
  const after = await handle.stat()
  if (
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    return {
      ok: false,
      code: 'file_changed',
      detail: `读取期间文件发生变化（size ${before.size} -> ${after.size}，mtime ${before.mtimeMs} -> ${after.mtimeMs}，ctime ${before.ctimeMs} -> ${after.ctimeMs}），拒绝登记可能不完整的快照`,
    }
  }
  return { ok: true, bytes: Buffer.concat(chunks, total), size: after.size }
}

const registerArtifactParameters = obj({
  path: str({ description: '要登记为会话产物的源文件路径（相对会话 cwd 或绝对路径，支持 ../ 跨目录，与 bash 同权）' }),
  name: opt(str({ description: '产物展示名（缺省用源文件名）' })),
  mimeType: opt(str({ description: 'MIME 类型（缺省按扩展名探测；文本类会脱敏后落盘，二进制字节原样保留）' })),
})

/**
 * register_artifact 工具：把会话靶点节点上的真实普通文件复制登记为当前
 * 会话产物（经 artifacts.writeUploaded 落 Hub 数据目录，Web 可预览/下载）。
 * 结构化结果回显 artifactId、源文件绝对路径（local 为词法绝对路径、远端
 * 为 canonical 解析后）、nodeId、name、size/mime；二进制保真与文本脱敏
 * 由 ArtifactService 统一处理；一切异常文本经 deps.redact 脱敏。
 */
export function createRegisterArtifactTool(
  deps: HelmToolDeps,
): ToolRegistration<typeof registerArtifactParameters, never> {
  return defineTool({
    name: 'register_artifact',
    description:
      '把会话靶点节点上的真实普通文件登记为当前会话产物（复制进 Hub 数据目录，Web 界面可见/可预览/可下载）。支持二进制（字节原样保真）与文本（脱敏后落盘）；单文件上限 15 MiB；会话绑定远端节点时在目标节点读取，绝不回退本机。生成新文本内容时优先用 write(..., artifact: true)；本工具用于把已有文件（如命令输出、构建产物、图片）交给用户。',
    parameters: registerArtifactParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: '产物 ID（可用 [文件名](artifact:<id>) 渲染）' },
        path: { type: 'string', description: '源文件绝对路径（远端为 canonical 解析后）' },
        nodeId: { type: 'string', description: '实际读取节点' },
        name: { type: 'string', description: '产物展示名' },
        size: { type: 'number', description: '登记字节数（文本类为脱敏后大小）' },
        mimeType: { type: 'string', description: '产物 MIME 类型' },
      },
      required: ['artifactId', 'path', 'nodeId', 'name', 'size', 'mimeType'],
    } as never,
    async execute(args, api, context) {
      if (deps.artifacts.writeUploaded === undefined) {
        return {
          output: [
            { type: 'text', text: 'register_failed: 产物服务未配置 writeUploaded，无法登记会话产物' },
          ],
          isError: true,
        }
      }
      const target0 = await resolveToolTarget(deps, api)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `register_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      try {
        const resolvedR = resolveTargetPath(args.path, base, platform)
        if (!resolvedR.ok) {
          return { output: [{ type: 'text', text: `invalid_path: ${resolvedR.reason}` }], isError: true }
        }
        const lexicalAbs = resolvedR.abs
        const displayName = args.name ?? basenameForShape(lexicalAbs)
        let bytes: Uint8Array
        let sourcePath: string
        if (nodeId !== 'local') {
          // 远端：必经 EnvFabric（缺失/离线显式失败，绝不回退 local）。
          const remote = requireRemoteEnv(deps.envFabric, nodeId, base, '读取')
          if ('error' in remote) {
            return { output: [{ type: 'text', text: remote.error }], isError: true }
          }
          const env = remote.env
          // canonicalPath 先解析软链（与 read 一致）：fileInfo 是 lstat 语义。
          const targetRealR = await env.canonicalPath(lexicalAbs, context)
          if (!targetRealR.ok) throw new Error(targetRealR.error.message)
          sourcePath = targetRealR.value
          const infoR = await env.fileInfo(sourcePath, context)
          if (!infoR.ok) throw new Error(infoR.error.message)
          const info = infoR.value
          if (info.kind === 'directory') {
            return {
              output: [{ type: 'text', text: registerIsDirectoryText(args.path) }],
              isError: true,
            }
          }
          if (info.kind !== 'file') {
            return {
              output: [
                { type: 'text', text: `register_failed: ${args.path} 不是普通文件（kind=${info.kind}）` },
              ],
              isError: true,
            }
          }
          if (info.size > MAX_ARTIFACT_BYTES) {
            return {
              output: [{ type: 'text', text: artifactTooLargeText(args.path, info.size) }],
              isError: true,
            }
          }
          // 有界二进制读取：openBinaryReader 打开后的同 fd positional 读取
          //（节点实现 O_NONBLOCK 打开 + 同 fd fstat 拒特殊文件），绝不走
          // readBinaryFile 的无界全量缓冲（源文件增长数 GB 会先整体缓冲传输
          // 后才拒绝）。打开失败显式拒绝，无任何回退。
          const readerR = await env.openBinaryReader(sourcePath, { noFollow: true }, context)
          if (!readerR.ok) throw new Error(readerR.error.message)
          const reader = readerR.value
          try {
            // 打开后权威信息（同 fd，非路径视图）：kind/size/mtime 以 reader
            // 的 info 为准，预检 size 只作快速拒绝。
            const openedR = await reader.info(context)
            if (!openedR.ok) throw new Error(openedR.error.message)
            const opened = openedR.value
            if (opened.kind !== 'file') {
              return {
                output: [
                  {
                    type: 'text',
                    text: `register_failed: ${args.path} 在打开后不是普通文件（kind=${opened.kind}），拒绝读取`,
                  },
                ],
                isError: true,
              }
            }
            if (opened.size > MAX_ARTIFACT_BYTES) {
              return {
                output: [{ type: 'text', text: artifactTooLargeText(args.path, opened.size) }],
                isError: true,
              }
            }
            // 请求上限+1：SDK 契约「最多 length 字节、仅 EOF 处更短」，内部
            // 循环短读至 length 或 EOF——超限即实证，绝无先全量后拒绝。
            const readR = await reader.read(0, MAX_ARTIFACT_BYTES + 1, context)
            if (!readR.ok) throw new Error(readR.error.message)
            const readBytes = readR.value
            if (readBytes.byteLength > MAX_ARTIFACT_BYTES) {
              return {
                output: [{ type: 'text', text: artifactTooLargeReadText(args.path, readBytes.byteLength) }],
                isError: true,
              }
            }
            // 读后二次 info（同 fd）：size/mtime 与打开时不一致或读取长短与
            // 稳定 size 不一致均拒绝（读途中增长/截断不得截断当成功）。
            const afterR = await reader.info(context)
            if (!afterR.ok) throw new Error(afterR.error.message)
            const after = afterR.value
            if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
              return {
                output: [
                  {
                    type: 'text',
                    text:
                      `file_changed: ${args.path} 读取期间文件发生变化` +
                      `（size ${opened.size} -> ${after.size}，mtime ${opened.mtimeMs} -> ${after.mtimeMs}），拒绝登记可能不完整的快照`,
                  },
                ],
                isError: true,
              }
            }
            if (readBytes.byteLength !== opened.size) {
              return {
                output: [
                  {
                    type: 'text',
                    text: `file_changed: ${args.path} 读取到 ${readBytes.byteLength} 字节与稳定大小 ${opened.size} 不一致，拒绝截断当成功`,
                  },
                ],
                isError: true,
              }
            }
            bytes = readBytes
          } finally {
            // 取消/失败路径同样释放远端句柄（节点侧 reader 生命周期与连接
            // 绑定，显式 close 立即回收）。
            await reader.close(BACKGROUND_CONTEXT)
          }
        } else {
          // local：与 read 工具同构——先 stat（跟随软链）预检分类（目录/特殊
          // 文件/超限；FIFO 等特殊文件在无竞态场景下预检即拒绝）；打开用
          // O_NONBLOCK（平台支持时）封住 stat→open 竞态窗口（普通文件被换成
          // FIFO 后纯 O_RDONLY 的 open 会无限阻塞）；同一 fd 上 fstat 权威复核
          // 后有界循环读到 EOF（短读继续、超限实证、中途变更显式 file_changed，
          // 见 readArtifactBytesFromHandle）。
          const preInfo = await stat(lexicalAbs)
          if (preInfo.isDirectory()) {
            return {
              output: [{ type: 'text', text: registerIsDirectoryText(args.path) }],
              isError: true,
            }
          }
          if (!preInfo.isFile()) {
            return {
              output: [
                { type: 'text', text: `register_failed: ${args.path} 不是普通文件（特殊文件）` },
              ],
              isError: true,
            }
          }
          if (preInfo.size > MAX_ARTIFACT_BYTES) {
            return {
              output: [{ type: 'text', text: artifactTooLargeText(args.path, preInfo.size) }],
              isError: true,
            }
          }
          const handle = await open(lexicalAbs, artifactOpenFlags())
          try {
            const statInfo = await handle.stat()
            if (statInfo.isDirectory()) {
              return {
                output: [{ type: 'text', text: registerIsDirectoryText(args.path) }],
                isError: true,
              }
            }
            if (!statInfo.isFile()) {
              return {
                output: [
                  { type: 'text', text: `register_failed: ${args.path} 在打开后不是普通文件（特殊文件），拒绝读取` },
                ],
                isError: true,
              }
            }
            if (statInfo.size > MAX_ARTIFACT_BYTES) {
              return {
                output: [{ type: 'text', text: artifactTooLargeText(args.path, statInfo.size) }],
                isError: true,
              }
            }
            const read = await readArtifactBytesFromHandle(handle)
            if (!read.ok) {
              if (read.code === 'artifact_too_large') {
                return {
                  output: [{ type: 'text', text: artifactTooLargeReadText(args.path, read.read) }],
                  isError: true,
                }
              }
              return {
                output: [
                  { type: 'text', text: `file_changed: ${args.path} ${read.detail}` },
                ],
                isError: true,
              }
            }
            bytes = read.bytes
          } finally {
            await handle.close()
          }
          sourcePath = lexicalAbs
        }
        const meta = await deps.artifacts.writeUploaded(api.conversationId as number, {
          name: displayName,
          bytes,
          ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
        })
        return {
          output: [
            {
              type: 'text',
              text:
                `[Artifact] id=${meta.id} name=${meta.name}\n` +
                `register_artifact_ok: 源 ${sourcePath}（节点 ${nodeId}，${meta.size} 字节，${meta.mimeType}）`,
            },
          ],
          structuredOutput: {
            artifactId: meta.id,
            path: sourcePath,
            nodeId,
            name: meta.name,
            size: meta.size,
            mimeType: meta.mimeType,
          } as JsonValue,
        }
      } catch (error) {
        return {
          output: [{ type: 'text', text: `register_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

const ARTIFACT_PAGE_BYTES = 4 * 1024

const readArtifactParameters = obj({
  id: str({ description: '产物 ID（artifact metadata 的 id）' }),
  offset: opt(int({ minimum: 0, description: '起始字节偏移（默认 0）' })),
  limit: opt(
    int({
      minimum: 1,
      maximum: ARTIFACT_PAGE_BYTES,
      description: `本次读取字节数上限（默认 ${ARTIFACT_PAGE_BYTES}，最大 ${ARTIFACT_PAGE_BYTES}）`,
    }),
  ),
})

/**
 * read_artifact 工具：分页读取 spill 产物。仅允许当前会话及其父链授权会话的产物，
 * 不接受任意文件路径；每页 ≤4KiB，UTF-8 边界对齐且保证 nextOffset 严格前进。
 */
export function createReadArtifactTool(
  deps: HelmToolDeps,
  isAuthorized: (conversationId: number, artifactConversationId: number) => boolean,
): ToolRegistration<typeof readArtifactParameters, never> {
  return defineTool({
    name: 'read_artifact',
    description:
      '分页读取产物（spill 全文等）。每页最多 4KiB，按 UTF-8 边界对齐返回 nextOffset；为空表示已读完。',
    parameters: readArtifactParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'number' },
        nextOffset: { type: 'number' },
        chunk: { type: 'string' },
      },
      required: ['id', 'offset', 'chunk'],
    } as never,
    async execute(args, api, _context) {
      const id = args.id
      const offset = args.offset ?? 0
      const limit = args.limit ?? ARTIFACT_PAGE_BYTES
      const conversationId = api.conversationId as number
      // 诚实性：仅「产物不存在」（FileNotFoundError）是 artifact_not_found；
      // 存储真实读取失败（仓库/DB 故障等）如实透出原始错误文本（经脱敏，
      // 与下方 readBuffer 同码 artifact_read_failed），绝不吞成 not_found。
      let meta: Awaited<ReturnType<HelmToolDeps['artifacts']['get']>>
      try {
        meta = await deps.artifacts.get(id)
      } catch (error) {
        if (error instanceof FileNotFoundError) {
          return {
            output: [{ type: 'text', text: `artifact_not_found: ${id}` }],
            isError: true,
          }
        }
        return {
          output: [{ type: 'text', text: `artifact_read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
      if (!isAuthorized(conversationId, meta.conversationId)) {
        return {
          output: [
            {
              type: 'text',
              text: `artifact_forbidden: 产物 ${id} 属于会话 ${meta.conversationId}，当前会话 ${conversationId} 无权读取`,
            },
          ],
          isError: true,
        }
      }
      let buffer: Buffer
      try {
        buffer = Buffer.from(await deps.artifacts.readBuffer(id))
      } catch (error) {
        return {
          output: [{ type: 'text', text: `artifact_read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
      if (offset > buffer.length) {
        return {
          output: [{ type: 'text', text: `offset_out_of_range: ${offset} > ${buffer.length}` }],
          isError: true,
        }
      }
      if (offset === buffer.length) {
        return {
          output: [
            { type: 'text', text: `[artifact ${id} bytes ${offset}-${offset}/${buffer.length}]\n（已读完）` },
          ],
          structuredOutput: { id, offset, chunk: '' } as JsonValue,
        }
      }
      // UTF-8 边界对齐：offset 或 end 落在多字节序列中间时，起点跳到下一个
      // 完整字符首字节、终点回退到字符起点（保前进且绝不解出替换符）。
      let start = offset
      while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1
      const end = Math.min(buffer.length, offset + limit)
      let safeEnd = Math.max(end, start)
      while (safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd -= 1
      // 兜底：limit=1 且 start 是多字节首字节时 safeEnd 可能退回 start；推进到
      // 下一个字符首字节，保证一页至少完整读出一个字符。
      while (safeEnd <= start && safeEnd < buffer.length) {
        safeEnd += 1
        while (safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd += 1
      }
      const chunk = buffer.subarray(start, safeEnd).toString('utf8')
      const hasMore = safeEnd < buffer.length
      const header = `[artifact ${id} bytes ${offset}-${safeEnd}/${buffer.length}${start > offset ? `（offset ${offset} 位于多字节字符中间，已从 ${start} 起读）` : ''}]`
      const text = hasMore ? `${header}\n${chunk}\n[nextOffset=${safeEnd}]` : `${header}\n${chunk}`
      // nextOffset 仅在还有剩余时出现，绝不输出 undefined 字段（JSON-safe）。
      const structured: Record<string, unknown> = { id, offset, chunk }
      if (hasMore) structured['nextOffset'] = safeEnd
      return {
        output: [{ type: 'text', text }],
        structuredOutput: structured as JsonValue,
      }
    },
  })
}
