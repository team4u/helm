/** 产物域：artifacts list / put / get。 */
import type { ArtifactMetadata } from '@helm/protocol'
import path from 'node:path'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printPlainText, printResult, requirePositional, resolveConversationTarget } from './shared.js'
import { printValue } from '../output.js'

const convFlags = [{ name: 'current', type: 'boolean', help: '使用 env HELM_CONVERSATION_ID' }] as const

/**
 * 按调用方（CLI 进程）cwd 把本地路径解析为绝对路径：绝不按 HELM_CWD 静默切换，
 * 也不做全盘查找。目录差异本身是合法 cd，仅作为诊断附注返回。
 */
function resolveCallerPath(ctx: CommandContext, requested: string): { resolvedPath: string; sessionCwd?: string } {
  const resolvedPath = path.resolve(ctx.cwd, requested)
  let sessionCwd: string | undefined
  if (ctx.env['HELM_ENV'] === '1') {
    const managed = ctx.env['HELM_CWD']
    if (managed && managed !== ctx.cwd) sessionCwd = managed
  }
  return { resolvedPath, sessionCwd }
}

/** 路径诊断结构化 details（--json 信封供脚本消费）。 */
function pathDetails(requested: string, resolvedPath: string, ctx: CommandContext, sessionCwd?: string): Record<string, string> {
  return {
    requestedPath: requested,
    resolvedPath,
    cliCwd: ctx.cwd,
    ...(sessionCwd !== undefined ? { sessionCwd } : {}),
  }
}

/** 人类可读多行诊断（含可选会话 cwd 附注）。 */
function pathDiagLines(requested: string, resolvedPath: string, ctx: CommandContext, sessionCwd?: string): string {
  const hint =
    sessionCwd !== undefined ? `\n  会话 cwd（HELM_CWD）=${sessionCwd}（目录差异属合法 cd；相对路径仍按 CLI cwd 解析）` : ''
  return `\n  请求路径=${requested}\n  绝对路径=${resolvedPath}\n  CLI cwd=${ctx.cwd}${hint}`
}

export function artifactsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['artifacts', 'list'],
    description: '列出会话产物（GET /api/conversations/:id/artifacts）',
    flags: [...convFlags],
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'current', type: 'boolean' }], ctx.args)
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[0], ctx.env)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<ArtifactMetadata[]>(`/api/conversations/${id}/artifacts`))
    },
  })

  cmds.push({
    path: ['artifacts', 'put'],
    description: '上传本地文件为会话产物（POST /api/conversations/:id/artifacts）',
    flags: [
      ...convFlags,
      { name: 'name', type: 'string', help: '自定义产物名（缺省用本地文件名）' },
      { name: 'mime-type', type: 'string', help: '显式 MIME 类型' },
    ],
    positional: '<filePath> [id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'current', type: 'boolean' },
          { name: 'name', type: 'string' },
          { name: 'mime-type', type: 'string' },
        ],
        ctx.args,
      )
      const filePath = requirePositional(parsed.positionals, 0, 'filePath', 'missing_file_path')
      const id = resolveConversationTarget(parsed.flags, parsed.positionals[1], ctx.env)
      if (parsed.positionals.length > 2) {
        throw new CliError(`多余位置参数：${parsed.positionals.slice(2).join(' ')}`, 'unexpected_positional')
      }
      const fsp = await import('node:fs/promises')
      const { resolvedPath, sessionCwd } = resolveCallerPath(ctx, filePath)
      let bytes: Uint8Array
      try {
        const st = await fsp.stat(resolvedPath)
        if (!st.isFile()) {
          throw new CliError(
            `上传源不是常规文件（目录/设备）${pathDiagLines(filePath, resolvedPath, ctx, sessionCwd)}`,
            'read_failed',
            1,
            pathDetails(filePath, resolvedPath, ctx, sessionCwd),
          )
        }
        const buffer = await fsp.readFile(resolvedPath)
        bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
      } catch (err) {
        if (err instanceof CliError) throw err
        throw new CliError(
          `读取上传文件失败（${err instanceof Error ? err.message : String(err)}）${pathDiagLines(filePath, resolvedPath, ctx, sessionCwd)}`,
          'read_failed',
          1,
          pathDetails(filePath, resolvedPath, ctx, sessionCwd),
        )
      }
      const fileName = flagValue<string>(parsed.flags, 'name') ?? path.basename(resolvedPath)
      const mimeType = flagValue<string>(parsed.flags, 'mime-type')
      const hub = await ctx.hub()
      const metadata = await hub.uploadArtifact(id, fileName, bytes, mimeType)
      printResult(ctx, metadata)
      if (!ctx.json) {
        ctx.io.out(`[Artifact] id=${metadata.id} name=${metadata.name}\n`)
      }
    },
  })

  cmds.push({
    path: ['artifacts', 'get'],
    description: '读取产物内容（GET /api/artifacts/:id/content；文本直出，二进制需 --output）',
    flags: [{ name: 'output', type: 'string', help: '二进制落盘路径（按 CLI 调用方 cwd 解析为绝对路径）' }],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'output', type: 'string' }], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const output = flagValue<string>(parsed.flags, 'output')
      const hub = await ctx.hub()
      const response = await hub.raw(`/api/artifacts/${encodeURIComponent(id)}/content`)
      const contentType = response.headers.get('content-type') ?? ''
      const isText = contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('yaml') || contentType === ''
      if (output !== undefined) {
        const fsp = await import('node:fs/promises')
        const { resolvedPath, sessionCwd } = resolveCallerPath(ctx, output)
        // bytes 用实际落盘字节数：Content-Length 头缺失（分块传输等）时依然可靠。
        const buffer = Buffer.from(await response.arrayBuffer())
        try {
          await fsp.writeFile(resolvedPath, buffer)
        } catch (err) {
          throw new CliError(
            `写入产物落盘文件失败（${err instanceof Error ? err.message : String(err)}）${pathDiagLines(output, resolvedPath, ctx, sessionCwd)}`,
            'write_failed',
            1,
            pathDetails(output, resolvedPath, ctx, sessionCwd),
          )
        }
        if (ctx.json) printValue(ctx.io, { written: resolvedPath, bytes: buffer.byteLength }, true)
        else ctx.io.out(`已写入 ${resolvedPath}（${buffer.byteLength} 字节）\n`)
        return
      }
      if (!isText) {
        throw new CliError(`产物为二进制（${contentType || '未知类型'}）：使用 --output <path> 落盘`, 'binary_content_requires_output')
      }
      const text = await response.text()
      if (ctx.json) printValue(ctx.io, text, true)
      else printPlainText(ctx, text)
    },
  })

  return cmds
}
