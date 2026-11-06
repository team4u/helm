/**
 * 内核自带本机工具：bash（真实 child_process、进程组、超时、abort）、read（按 cwd
 * 安全读文件）与 read_artifact（spill 产物分页读取）。
 * - env 注入：HELM_ENV=1 / HELM_HUB_URL（按 HELM_PORT 生成）/ HELM_CONVERSATION_ID /
 *   HELM_CWD 四个宿主变量固定覆盖，防 stash/envFor 同名误覆盖；
 * - SecretStash 脱敏覆盖输出与错误；超长输出经 services.ArtifactService.spill 落盘；
 * - SDK defineTool 注册，天然经 tool_call / tool_result 钩子管道；
 * - spill 指引指向 read_artifact；分页 ≤4KiB 防同量 spill 循环；
 *   read_artifact 仅允许当前会话（含父会话授权链）产物，不接受任意路径。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { JsonValue } from '@earendil-works/chord'

/** JSON Schema 对象（defineTool parameters 接受任意 JSON Schema）。 */
type SchemaObject = Record<string, unknown>
import type { ArtifactService } from '../services/artifacts.js'
import { redactJsonValue } from '../redact.js'
import type { HelmToolDeps } from './tool-deps.js'

const DEFAULT_TIMEOUT_MS = 120_000
const ARTIFACT_PAGE_BYTES = 4 * 1024

export interface ShellRunResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  signal: string | null
}

/**
 * 真实 shell 执行（runGate 与 bash 工具共用）：进程组 spawn、超时杀组、
 * abort 杀组、输出/错误脱敏。永不伪造成功。
 */
export async function runShell(
  deps: HelmToolDeps,
  command: string,
  options: { cwd?: string; conversationId?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ShellRunResult> {
  const cwd = options.cwd ?? deps.defaultCwd
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const env = buildToolEnv(deps, cwd, options.conversationId)
  return await new Promise<ShellRunResult>((resolveRun) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let killedBy = ''

    const killGroup = (reason: string) => {
      killedBy = reason
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('timeout')
    }, timeoutMs)
    const onAbort = () => killGroup('abort')
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolveRun({
        ok: false,
        exitCode: null,
        output: deps.redact(`${stdout}${stderr}\n[spawn error] ${String(error)}`),
        timedOut,
        signal: null,
      })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const combined = deps.redact(`${stdout}${stderr}`)
      resolveRun({
        ok: !timedOut && killedBy !== 'abort' && code === 0,
        exitCode: code,
        output:
          combined +
          (timedOut ? `\n[timeout after ${timeoutMs}ms]` : '') +
          (killedBy === 'abort' ? '\n[aborted]' : ''),
        timedOut,
        signal: signal ?? null,
      })
    })
  })
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

/** bash 工具（SDK defineTool；输出超阈值经 services spill）。 */
export function createBashTool(deps: HelmToolDeps): ToolRegistration<SchemaObject, JsonValue> {
  return defineTool<SchemaObject, JsonValue>({
    name: 'bash',
    description:
      '在本机 bash 中执行命令。工作目录为会话 cwd；超时默认 120 秒；输出超 32KiB 自动 spill 为产物并返回预览（用 read_artifact 读取全文）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeoutMs: { type: 'number', description: '可选超时毫秒数（默认 120000）' },
      },
      required: ['command'],
      additionalProperties: false,
    } as SchemaObject,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        exitCode: { type: ['number', 'null'] },
        output: { type: 'string' },
        timedOut: { type: 'boolean' },
      },
      required: ['ok', 'output'],
    } as SchemaObject,
    async execute(args, api, _context) {
      const command = String((args as { command: string }).command)
      const timeoutMs =
        typeof (args as { timeoutMs?: number }).timeoutMs === 'number'
          ? (args as { timeoutMs: number }).timeoutMs
          : DEFAULT_TIMEOUT_MS
      const agent = await api.agent(BACKGROUND_CONTEXT)
      const cwd = agent.cwd ?? deps.defaultCwd
      const result = await runShell(deps, command, {
        cwd,
        conversationId: api.conversationId as number,
        timeoutMs,
      })
      const spill = await deps.artifacts.spill(api.conversationId as number, api.callId, result.output)
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

/** read 工具：按会话 cwd 相对路径安全读取文本文件（拦截越界）。 */
export function createReadTool(deps: HelmToolDeps): ToolRegistration<SchemaObject, JsonValue> {
  return defineTool<SchemaObject, JsonValue>({
    name: 'read',
    description: '读取文本文件内容；路径相对会话 cwd，拒绝越界绝对路径与 ../ 逃逸。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（相对会话 cwd）' },
      },
      required: ['path'],
      additionalProperties: false,
    } as SchemaObject,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    } as SchemaObject,
    async execute(args, api, _context) {
      const raw = String((args as { path: string }).path)
      const agent = await api.agent(BACKGROUND_CONTEXT)
      const base = resolve(agent.cwd ?? deps.defaultCwd)
      let target = raw
      if (!isAbsolute(raw)) target = join(base, raw)
      target = resolve(target)
      if (target !== base && !target.startsWith(base + '/')) {
        return {
          output: [{ type: 'text', text: `path_escape_denied: ${raw}（基准目录 ${base}）` }],
          isError: true,
        }
      }
      let size: number
      try {
        size = statSync(target).size
        if (size > 128 * 1024) throw new Error(`file_too_large: ${size} bytes（>128KiB）`)
      } catch (error) {
        return {
          output: [{ type: 'text', text: `read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
      const content = deps.redact(readFileSync(target, 'utf8'))
      const spill = await deps.artifacts.spill(api.conversationId as number, `read-${api.callId}`, content)
      void size
      return {
        output: [{ type: 'text', text: spill.text }],
        structuredOutput: { path: raw, content: spill.text } as JsonValue,
      }
    },
  })
}

/**
 * read_artifact 工具：分页读取 spill 产物。仅允许当前会话及其父链授权会话的产物，
 * 不接受任意文件路径；每页 ≤4KiB 并返回 nextOffset，避免同量 spill 循环。
 */
export function createReadArtifactTool(
  deps: HelmToolDeps,
  isAuthorized: (conversationId: number, artifactConversationId: number) => boolean,
): ToolRegistration<SchemaObject, JsonValue> {
  return defineTool<SchemaObject, JsonValue>({
    name: 'read_artifact',
    description:
      '分页读取产物（spill 全文等）。每页最多 4KiB，返回 nextOffset；为空表示已读完。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '产物 ID（artifact metadata 的 id）' },
        offset: { type: 'number', description: '起始字节偏移（默认 0）' },
        limit: { type: 'number', description: `本次读取字节数上限（默认 ${ARTIFACT_PAGE_BYTES}，最大 ${ARTIFACT_PAGE_BYTES}）` },
      },
      required: ['id'],
      additionalProperties: false,
    } as SchemaObject,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'number' },
        nextOffset: { type: 'number' },
        chunk: { type: 'string' },
      },
      required: ['id', 'chunk'],
    } as SchemaObject,
    async execute(args, api, _context) {
      const id = String((args as { id: string }).id)
      const offset = Math.max(0, Number((args as { offset?: number }).offset ?? 0) || 0)
      const limit = Math.min(
        ARTIFACT_PAGE_BYTES,
        Math.max(1, Number((args as { limit?: number }).limit ?? ARTIFACT_PAGE_BYTES) || ARTIFACT_PAGE_BYTES),
      )
      const conversationId = (api as { conversationId?: number }).conversationId as number
      const meta = (() => {
        try {
          return deps.artifacts.get(id)
        } catch {
          return undefined
        }
      })()
      if (!meta) {
        return {
          output: [{ type: 'text', text: `artifact_not_found: ${id}` }],
          isError: true,
        } as never
      }
      if (!isAuthorized(conversationId, meta.conversationId)) {
        return {
          output: [
            { type: 'text', text: `artifact_forbidden: 产物 ${id} 属于会话 ${meta.conversationId}，当前会话 ${conversationId} 无权读取` },
          ],
          isError: true,
        }
      }
      let content: string
      try {
        content = await deps.artifacts.readContent(id)
      } catch (error: unknown) {
        return {
          output: [{ type: 'text', text: `artifact_read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
      const buffer = Buffer.from(content, 'utf8')
      if (offset > buffer.length) {
        return {
          output: [{ type: 'text', text: `offset_out_of_range: ${offset} > ${buffer.length}` }],
          isError: true,
        }
      }
      const end = Math.min(buffer.length, offset + limit)
      // 对齐 UTF-8 边界：回退到上一个字符起点。
      let safeEnd = end
      while (safeEnd > offset && safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) {
        safeEnd -= 1
      }
      const chunk = buffer.subarray(offset, safeEnd).toString('utf8')
      const nextOffset = safeEnd < buffer.length ? safeEnd : undefined
      const header = `[artifact ${id} bytes ${offset}-${safeEnd}/${buffer.length}]`
      const text = nextOffset === undefined ? `${header}\n${chunk}` : `${header}\n${chunk}\n[nextOffset=${nextOffset}]`
      return {
        output: [{ type: 'text', text }],
        structuredOutput: { id, offset, nextOffset, chunk } as JsonValue,
      }
    },
  })
}
