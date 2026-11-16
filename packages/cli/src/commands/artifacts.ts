/** artifact domain:artifacts list / put / get. */
import type { ArtifactMetadata } from '@helm/protocol'
import path from 'node:path'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { printPlainText, printResult, requirePositional, resolveConversationTarget } from './shared.js'
import { printValue } from '../output.js'

const convFlags = [{ name: 'current', type: 'boolean', help: 'use env HELM_CONVERSATION_ID' }] as const

/**
 * by caller (CLI process)cwd local path parse is absolute path: never by HELM_CWD static default switch,
 * also does not all find. directory difference itself is legal cd, only as diagnose attach note return.
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

/** path diagnose structure details(--json message seal supply script consume). */
function pathDetails(requested: string, resolvedPath: string, ctx: CommandContext, sessionCwd?: string): Record<string, string> {
  return {
    requestedPath: requested,
    resolvedPath,
    cliCwd: ctx.cwd,
    ...(sessionCwd !== undefined ? { sessionCwd } : {}),
  }
}

/** person class can read many row diagnose (contains optional conversation cwd attach note). */
function pathDiagLines(requested: string, resolvedPath: string, ctx: CommandContext, sessionCwd?: string): string {
  const hint =
    sessionCwd !== undefined ? `\n  conversation cwd(HELM_CWD)=${sessionCwd}(directory difference belong legal cd; relative path still by CLI cwd parse)` : ''
  return `\n  request path=${requested}\n  absolute path=${resolvedPath}\n  CLI cwd=${ctx.cwd}${hint}`
}

export function artifactsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['artifacts', 'list'],
    description: 'column out conversation artifact (GET /api/conversations/:id/artifacts)',
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
    description: 'upload local file is conversation artifact (POST /api/conversations/:id/artifacts)',
    flags: [
      ...convFlags,
      { name: 'name', type: 'string', help: 'self define artifact name (default use local filename)' },
      { name: 'mime-type', type: 'string', help: 'explicit MIME type' },
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
        throw new CliError(`redundant location parameter:${parsed.positionals.slice(2).join(' ')}`, 'unexpected_positional')
      }
      const fsp = await import('node:fs/promises')
      const { resolvedPath, sessionCwd } = resolveCallerPath(ctx, filePath)
      let bytes: Uint8Array
      try {
        const st = await fsp.stat(resolvedPath)
        if (!st.isFile()) {
          throw new CliError(
            `upload source is not common rule file (directory/device)${pathDiagLines(filePath, resolvedPath, ctx, sessionCwd)}`,
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
          `read upload file failed (${err instanceof Error ? err.message : String(err)})${pathDiagLines(filePath, resolvedPath, ctx, sessionCwd)}`,
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
    description: 'read artifact content (GET /api/artifacts/:id/content; text direct out, two enter system must --output)',
    flags: [{ name: 'output', type: 'string', help: 'two enter system path (by CLI caller cwd parse is absolute path)' }],
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
        // complete receive after only then write file, transfer failed cannot by mistakenly report is write failed or override already has deliver file.
        let buffer: Buffer
        try {
          buffer = Buffer.from(await response.arrayBuffer())
        } catch (err) {
          throw new CliError(
            `download artifact content failed (${err instanceof Error ? err.message : String(err)})${pathDiagLines(output, resolvedPath, ctx, sessionCwd)}`,
            'download_failed',
            1,
            pathDetails(output, resolvedPath, ctx, sessionCwd),
          )
        }
        try {
          await fsp.writeFile(resolvedPath, buffer)
        } catch (err) {
          throw new CliError(
            `write artifact file failed (${err instanceof Error ? err.message : String(err)})${pathDiagLines(output, resolvedPath, ctx, sessionCwd)}`,
            'write_failed',
            1,
            pathDetails(output, resolvedPath, ctx, sessionCwd),
          )
        }
        if (ctx.json) printValue(ctx.io, { written: resolvedPath, bytes: buffer.byteLength }, true)
        else ctx.io.out(`already write ${resolvedPath}(${buffer.byteLength} byte)\n`)
        return
      }
      if (!isText) {
        throw new CliError(`artifact is two enter system (${contentType || 'unknown type'}): use --output <path> `, 'binary_content_requires_output')
      }
      const text = await response.text()
      if (ctx.json) printValue(ctx.io, text, true)
      else printPlainText(ctx, text)
    },
  })

  return cmds
}
