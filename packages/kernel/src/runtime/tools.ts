/**
 * 内核自带本机工具：bash（真实进程组、超时、abort、跨 chunk UTF-8 保真、
 * 输出限额显式报错）、read（按 cwd 安全读文件，realpath 防软链越界）与
 * read_artifact（spill 产物分页读取，UTF-8 边界对齐保证前进）。
 *
 * - shell 执行委托 SDK `NodeExecutionEnv.exec`（`@earendil-works/pi-durable/env/node`）：
 *   预先 aborted 的 Context 绝不 spawn；abort/timeout 杀整个进程组并可靠等待子进程
 *   退出（listener/timer 全清理，不泄露进程）；stdout/stderr 各自 `StreamDecoder` 增量
 *   解码，多字节字符跨 chunk 不撕裂；`onOutput` 按到达顺序拼接（非先 stdout 后 stderr）。
 * - env 注入：HELM_ENV=1 / HELM_HUB_URL（按 HELM_PORT 生成）/ HELM_CONVERSATION_ID /
 *   HELM_CWD 四个宿主变量固定覆盖，防 stash/envFor 同名误覆盖。
 * - SecretStash 脱敏在聚合完成的全文上执行（先完整拼接再 redact，跨 chunk 撕裂的
 *   秘密也必然完整匹配），绝不反向还原；超长输出经 services.ArtifactService.spill 落盘。
 * - 输出超过 maxOutputBytes 显式失败 `output_limit_exceeded`（绝不截断当成功）。
 * - read 用 fs.promises（不阻主线程）；realpath 解析 base 与 target 后做 containment，
 *   拒绝目录与软链越界；read 错误一律脱敏。
 * - spill 指引指向 read_artifact；分页 ≤4KiB 防同量 spill 循环；
 *   read_artifact 仅允许当前会话（含父会话授权链）产物，不接受任意路径。
 * - timeoutMs 必须为正有限整数且 ≤ 上限，非法值显式 invalid_timeout。
 */

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Context, JsonValue } from '@earendil-works/chord'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { redactJsonValue } from '../redact.js'
import type { HelmToolDeps } from './tool-deps.js'

const DEFAULT_TIMEOUT_MS = 120_000
/** timeoutMs 上限：与默认值同量级，防超大值变相无限等待。 */
export const MAX_TIMEOUT_MS = 600_000
const ARTIFACT_PAGE_BYTES = 4 * 1024
/** bash 输出聚合上限（UTF-8 字节）：超过显式失败，绝不静默截断当成功。 */
export const MAX_OUTPUT_BYTES = 1024 * 1024
/** read 工具单文件上限：与 spill 预览链路一致的明确限额。 */
export const READ_FILE_MAX_BYTES = 128 * 1024

export interface ShellRunResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  signal: string | null
}

/** timeoutMs 校验：正有限整数且 ≤ 上限；非法显式抛错（不静默改默认）。 */
function assertTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `invalid_timeout: timeoutMs 必须是 (0, ${MAX_TIMEOUT_MS}] 的整数，收到 ${timeoutMs}`,
    )
  }
}

/** 外部 AbortSignal 挂到 SDK Context（预 aborted 时 exec 直接拒绝 spawn）。 */
function contextWithSignal(signal: AbortSignal | undefined): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}

/**
 * 真实 shell 执行（runGate 与 bash 工具共用）。委托 SDK NodeExecutionEnv：
 * 进程组 spawn、超时/abort 杀组、逐流增量 UTF-8 解码、到达顺序聚合。
 * 永不伪造成功；超限显式 output_limit_exceeded。
 */
export async function runShell(
  deps: HelmToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    timeoutMs?: number
    signal?: AbortSignal
    maxOutputBytes?: number
  } = {},
): Promise<ShellRunResult> {
  const cwd = options.cwd ?? deps.defaultCwd
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertTimeoutMs(timeoutMs)
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const env = buildToolEnv(deps, cwd, options.conversationId)
  // 每次 exec 独立 env 实例：activeChildPids 等可变状态不跨调用共享。
  const shell = new NodeExecutionEnv({ cwd, shellPath: '/bin/bash' })
  // 到达顺序聚合（stdout/stderr 混排按真实到达序，非先 stdout 后 stderr）。
  // 秘密脱敏在聚合全文上做：跨 chunk 撕裂的秘密在完整拼接后必然完整匹配。
  let combined = ''
  let outputBytes = 0
  let exceeded = false
  const result = await shell.exec(
    command,
    {
      cwd,
      env,
      timeout: timeoutMs / 1000,
      onOutput: (text) => {
        if (exceeded) return
        outputBytes += Buffer.byteLength(text, 'utf8')
        if (outputBytes > maxOutputBytes) {
          exceeded = true
          combined = ''
          return
        }
        combined += text
      },
    },
    contextWithSignal(options.signal),
  )
  if (exceeded) {
    return {
      ok: false,
      exitCode: null,
      output: deps.redact(
        `output_limit_exceeded: 输出超过 ${maxOutputBytes} 字节上限，已放弃聚合。` +
          '请重定向到文件后用 read 分页读取，或收窄命令输出。',
      ),
      timedOut: false,
      signal: null,
    }
  }
  if (!result.ok) {
    const error = result.error
    const timedOut = error.code === 'timeout'
    const aborted = error.code === 'aborted'
    const label = aborted ? 'aborted' : timedOut ? `timeout after ${timeoutMs}ms` : error.code
    return {
      ok: false,
      exitCode: null,
      output: deps.redact(
        combined + (combined === '' ? '' : '\n') + `[shell ${label}: ${error.message}]`,
      ),
      timedOut,
      signal: null,
    }
  }
  return {
    ok: result.value.exitCode === 0,
    exitCode: result.value.exitCode,
    output: deps.redact(combined),
    timedOut: false,
    signal: null,
  }
}

/**
 * gate 门禁命令执行（独立 subagent 与 Workflow adapter 共用，保证只执行一次）。
 * 失败永不返回成功；输出脱敏。
 */
export async function runGate(
  deps: HelmToolDeps,
  command: string,
  options: { cwd?: string; conversationId?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; output: string }> {
  const result = await runShell(deps, command, { ...options, timeoutMs: DEFAULT_TIMEOUT_MS })
  return { ok: result.ok, output: result.output }
}

/** 组装工具环境：宿主四变量固定覆盖 stash 注入的同名项。 */
export function buildToolEnv(
  deps: HelmToolDeps,
  cwd: string,
  conversationId?: number,
): Record<string, string> {
  const stashEnv = conversationId === undefined ? {} : deps.stashEnvFor(conversationId)
  return {
    ...process.env,
    ...stashEnv,
    HELM_ENV: '1',
    HELM_HUB_URL: deps.hubUrl,
    HELM_CONVERSATION_ID: String(conversationId ?? 0),
    HELM_CWD: cwd,
  }
}

const bashParameters = obj({
  command: str({ description: '要执行的 shell 命令' }),
  timeoutMs: opt(
    int({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `可选超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}）`,
    }),
  ),
})

/** bash 工具（SDK defineTool；输出超阈值经 services spill）。 */
export function createBashTool(deps: HelmToolDeps): ToolRegistration<typeof bashParameters, never> {
  return defineTool({
    name: 'bash',
    description:
      '在本机 bash 中执行命令。工作目录为会话 cwd；超时默认 120 秒；输出超 32KiB 自动 spill 为产物并返回预览（用 read_artifact 读取全文）；输出超 1MiB 显式失败。',
    parameters: bashParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        exitCode: { type: ['number', 'null'] },
        output: { type: 'string' },
        timedOut: { type: 'boolean' },
      },
      required: ['ok', 'output'],
    } as never,
    async execute(args, api, context) {
      const agent = await api.agent(BACKGROUND_CONTEXT)
      const cwd = agent.cwd ?? deps.defaultCwd
      let result: ShellRunResult
      try {
        result = await runShell(deps, args.command, {
          cwd,
          conversationId: api.conversationId as number,
          timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: context.abortSignal,
        })
      } catch (error) {
        // invalid_timeout 等参数级错误：显式失败，绝不静默改默认。
        return {
          output: [{ type: 'text', text: deps.redact(String(error)) }],
          isError: true,
        }
      }
      const spill = await deps.artifacts.spill(
        api.conversationId as number,
        api.callId,
        result.output,
      )
      const structured = redactJsonValue(
        {
          ok: result.ok,
          exitCode: result.exitCode,
          output: spill.text,
          timedOut: result.timedOut,
        },
        (t) => deps.redact(t),
      )
      return {
        output: [{ type: 'text', text: spill.text }],
        isError: !result.ok,
        structuredOutput: structured as JsonValue,
      }
    },
  })
}

const readParameters = obj({
  path: str({ description: '文件路径（相对会话 cwd）' }),
})

/** read 工具：按会话 cwd 相对路径安全读取文本文件（realpath 拦截软链越界）。 */
export function createReadTool(deps: HelmToolDeps): ToolRegistration<typeof readParameters, never> {
  return defineTool({
    name: 'read',
    description:
      '读取文本文件内容；路径相对会话 cwd，拒绝越界绝对路径、../ 逃逸与软链指向目录外的目标；单文件上限 128KiB（超限请用 bash + read_artifact 分页）。',
    parameters: readParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    } as never,
    async execute(args, api, _context) {
      const raw = args.path
      const agent = await api.agent(BACKGROUND_CONTEXT)
      const base = resolve(agent.cwd ?? deps.defaultCwd)
      try {
        // realpath 解析两侧再 containment：lexical 前缀检查绕不过软链。
        const [baseReal, targetReal] = await Promise.all([
          realpath(base),
          realpath(isAbsolute(raw) ? resolve(raw) : resolve(base, raw)),
        ])
        if (targetReal !== baseReal && !targetReal.startsWith(baseReal + sep)) {
          return {
            output: [
              {
                type: 'text',
                text: `path_escape_denied: ${raw}（基准目录 ${baseReal}，realpath 后越界）`,
              },
            ],
            isError: true,
          }
        }
        const info = await lstat(targetReal)
        if (info.isDirectory()) {
          return {
            output: [{ type: 'text', text: `read_failed: ${raw} 是目录，read 仅支持普通文件` }],
            isError: true,
          }
        }
        if (!info.isFile()) {
          return {
            output: [
              {
                type: 'text',
                text: `read_failed: ${raw} 不是普通文件（${info.isSymbolicLink() ? 'symlink' : '特殊文件'}）`,
              },
            ],
            isError: true,
          }
        }
        const size = (await stat(targetReal)).size
        if (size > READ_FILE_MAX_BYTES) {
          return {
            output: [
              {
                type: 'text',
                text:
                  `file_too_large: ${raw} 为 ${size} 字节，超过 read 工具 ${READ_FILE_MAX_BYTES} 字节上限。` +
                  '请用 bash 命令输出到文件后经 read_artifact 分页读取，或用 head/tail/sed 取所需片段。',
              },
            ],
            isError: true,
          }
        }
        const content = deps.redact(await readFile(targetReal, 'utf8'))
        const spill = await deps.artifacts.spill(
          api.conversationId as number,
          `read-${api.callId}`,
          content,
        )
        return {
          output: [{ type: 'text', text: spill.text }],
          structuredOutput: { path: raw, content: spill.text } as JsonValue,
        }
      } catch (error) {
        return {
          output: [{ type: 'text', text: `read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

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
      const meta = await deps.artifacts.get(id).catch(() => undefined)
      if (!meta) {
        return {
          output: [{ type: 'text', text: `artifact_not_found: ${id}` }],
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
