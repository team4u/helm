/**
 * 插件域：plugins list/enable/disable/config/doc 与 actions list。
 * config 除 --input <json> 外支持可重复 --set key=value（值按 JSON boolean/number 语义解析，否则 string）。
 */
import type { ActionManifest, PluginSummary } from '@helm/protocol'
import { CliError } from '../errors.js'
import { parseFlags } from '../args.js'
import { printValue } from '../output.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  coerceMetaFlag,
  parseKeyValues,
  parseNoFlags,
  printPlainText,
  printResult,
  repeatedValues,
  requirePositional,
} from './shared.js'

export function pluginsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['plugins', 'list'],
    description: '列出插件（GET /api/plugins）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<PluginSummary[]>('/api/plugins'))
    },
  })

  cmds.push({
    path: ['plugins', 'enable'],
    description: '启用插件（POST /api/plugins/:id/enable）',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/plugins/${encodeURIComponent(id)}/enable`))
    },
  })

  cmds.push({
    path: ['plugins', 'disable'],
    description: '停用插件（POST /api/plugins/:id/disable）',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/plugins/${encodeURIComponent(id)}/disable`))
    },
  })

  cmds.push({
    path: ['plugins', 'config'],
    description: '查看/更新插件配置（GET 返回 {values,schema}；PUT 发送 {values}；--set key=value 可重复）',
    flags: [
      { name: 'input', type: 'json', help: '整体 values JSON 对象（与 --set 可共存，--set 覆盖对应键）' },
      { name: 'set', type: 'string', repeated: true, help: '单项赋值 key=value，可重复；值按 JSON boolean/number 解析，否则 string' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'input', type: 'json' },
          { name: 'set', type: 'string', repeated: true },
        ],
        ctx.args,
      )
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hasInput = parsed.flags.has('input')
      const sets = repeatedValues(parsed.flags, 'set')
      const hub = await ctx.hub()
      const path = `/api/plugins/${encodeURIComponent(id)}/config`
      if (!hasInput && sets.length === 0) {
        printResult(ctx, await hub.get<unknown>(path))
        return
      }
      const values: Record<string, unknown> = hasInput ? coerceMetaFlag(parsed.flags.get('input'), 'input') : {}
      Object.assign(values, parseKeyValues(sets, 'set'))
      printResult(ctx, await hub.put<unknown>(path, { values }))
    },
  })

  cmds.push({
    path: ['plugins', 'doc'],
    description: '读取插件公共文档（GET /api/plugins/:id/docs/:name；私有/不存在 404）',
    positional: '<pluginId> <name>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const pluginId = parsed.positionals[0]
      const name = parsed.positionals[1]
      if (pluginId === undefined || name === undefined) {
        throw new CliError('缺少位置参数：plugins doc <pluginId> <name>', 'missing_id')
      }
      assertNoExtraPositionals(parsed.positionals, 2)
      const hub = await ctx.hub()
      const doc = await hub.get<{ pluginId: string; name: string; value: unknown }>(
        `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(name)}`,
      )
      if (ctx.json) {
        printResult(ctx, doc)
        return
      }
      // 人类模式：文档名 + 值（JSON 保真；文本值直出）
      if (typeof doc.value === 'string') {
        ctx.io.out(`${doc.name}\n`)
        printPlainText(ctx, doc.value)
        return
      }
      printValue(ctx.io, doc.value, false)
    },
  })

  cmds.push({
    path: ['plugins', 'client'],
    description: '获取插件 client.tsx 编译产物（GET /api/plugins/:id/client.mjs?module=...；--module 缺省 client.tsx）',
    flags: [
      { name: 'module', type: 'string', help: '相对插件 clientRoot 的模块路径（缺省 client.tsx）' },
      { name: 'output', type: 'string', help: '写入目标文件路径（缺省 stdout；--json 时仍写文件并打印元信息）' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'module', type: 'string' },
          { name: 'output', type: 'string' },
        ],
        ctx.args,
      )
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const moduleRef = (parsed.flags.get('module') as string | undefined) ?? 'client.tsx'
      if (parsed.flags.has('output') && typeof parsed.flags.get('output') !== 'string') {
        throw new CliError('--output 需要文件路径', 'invalid_flag_value')
      }
      const outPath = parsed.flags.get('output') as string | undefined
      const hub = await ctx.hub()
      const path = `/api/plugins/${encodeURIComponent(id)}/client.mjs?module=${encodeURIComponent(moduleRef)}`
      const response = await hub.raw(path)
      const code = await response.text()
      const contentHash = response.headers.get('x-helm-client-hash') ?? ''
      if (ctx.json) {
        printResult(ctx, { pluginId: id, module: moduleRef, contentHash, bytes: code.length })
      }
      if (outPath !== undefined) {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(outPath, code, 'utf8')
        if (!ctx.json) ctx.io.out(`已写入 ${outPath}（${code.length} 字节，hash ${contentHash}）\n`)
        return
      }
      if (!ctx.json) ctx.io.out(code)
    },
  })

  cmds.push({
    path: ['actions', 'list'],
    description: '列出插件动作清单（GET /api/actions）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<ActionManifest[]>('/api/actions'))
    },
  })

  return cmds
}
