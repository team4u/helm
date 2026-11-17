/** Artifact commands: artifacts list / put / get. */
import type { ArtifactMetadata } from '@helm/protocol'
import path from 'node:path'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  pathDetails,
  pathDiagLines,
  printPlainText,
  printResult,
  requirePositional,
  resolveCallerPath,
  resolveConversationTarget,
  writeDownloadedOutput,
} from './shared.js'
import { printValue } from '../output.js'

const convFlags = [{ name: 'current', type: 'boolean', help: 'use HELM_CONVERSATION_ID from environment' }] as const

export function artifactsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['artifacts', 'list'],
    description: 'List conversation artifacts (GET /api/conversations/:id/artifacts)',
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
    description: 'Upload a local file as a conversation artifact (POST /api/conversations/:id/artifacts)',
    flags: [
      ...convFlags,
      { name: 'name', type: 'string', help: 'custom artifact name (defaults to local filename)' },
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
        throw new CliError(`unexpected positional argument: ${parsed.positionals.slice(2).join(' ')}`, 'unexpected_positional')
      }
      const fsp = await import('node:fs/promises')
      const { resolvedPath, sessionCwd } = resolveCallerPath(ctx, filePath)
      let bytes: Uint8Array
      try {
        const st = await fsp.stat(resolvedPath)
        if (!st.isFile()) {
          throw new CliError(
            `upload source is not a regular file (directory/device)${pathDiagLines(filePath, resolvedPath, ctx, sessionCwd)}`,
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
          `failed to read upload file (${err instanceof Error ? err.message : String(err)})${pathDiagLines(filePath, resolvedPath, ctx, sessionCwd)}`,
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
    description: 'Read artifact content (GET /api/artifacts/:id/content; prints text directly, requires --output for binary)',
    flags: [{ name: 'output', type: 'string', help: 'output file path for binary content (resolved relative to CLI cwd)' }],
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
        await writeDownloadedOutput(ctx, response, output, 'artifact')
        return
      }
      if (!isText) {
        throw new CliError(`artifact is binary (${contentType || 'unknown type'}): use --output <path>`, 'binary_content_requires_output')
      }
      const text = await response.text()
      if (ctx.json) printValue(ctx.io, text, true)
      else printPlainText(ctx, text)
    },
  })

  return cmds
}
