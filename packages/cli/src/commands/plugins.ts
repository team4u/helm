/**
 * 插件域：plugins list/enable/disable/config/doc/client 与 doctor/reload/rescan
 * （DX 闭环）与 actions list。config 除 --input <json> 外支持可重复 --set key=value
 * （值按 JSON boolean/number 语义解析，否则 string）。plugins init 为本地脚手架命令。
 */
import type { ActionManifest, PluginDoctorReport, PluginReloadResult, PluginRescanResult, PluginSummary } from '@helm/protocol'
import { CliError } from '../errors.js'
import { parseFlags } from '../args.js'
import { printValue } from '../output.js'
import type { HubClient } from '../hub-client.js'
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
  resolveConversationTarget,
} from './shared.js'

/**
 * 会话文档订阅（--watch）：消费专用 SSE（GET /api/plugins/:id/docs/:name/events?conversationId=N）。
 * - --json：每帧 NDJSON 输出（snapshot 帧与增量帧均原样）；
 * - 人类模式：snapshot 打印当前值，增量帧打印一行变更摘要 + 新值；
 * - 建连 404（插件停用/会话删除/文档非 public）显式报错并停止（不重试）。
 */
async function watchSessionDoc(
  ctx: CommandContext,
  hub: HubClient,
  base: string,
  conversationId: number,
  pluginId: string,
  name: string,
): Promise<void> {
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const label = `${pluginId}/${name}#会话${conversationId}`
  try {
    await hub.streamSse(`${base}/events?conversationId=${conversationId}`, {
      signal: controller.signal,
      onFrame: ({ event, data }) => {
        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          ctx.io.err(`helm: 忽略非 JSON SSE 帧（${data.slice(0, 120)}）\n`)
          return
        }
        if (ctx.json) {
          ctx.io.out(`${JSON.stringify(payload ?? null)}\n`)
          return
        }
        if (event === 'snapshot') {
          const snap = payload as { doc?: { value?: unknown; deleted?: boolean } }
          ctx.io.out(`[${label}] 快照\n`)
          printValue(ctx.io, snap.doc?.value ?? null, false)
          return
        }
        const frame = payload as { seq?: number; event?: { doc?: { value?: unknown; deleted?: boolean } } }
        const doc = frame.event?.doc
        ctx.io.out(`[${label}] 更新 seq=${frame.seq ?? '?'}${doc?.deleted === true ? '（已删除）' : ''}\n`)
        printValue(ctx.io, doc?.value ?? null, false)
      },
    })
  } catch (err) {
    if (err instanceof CliError && err.code === 'aborted') return
    throw err
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

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
    description:
      '读取插件公共文档（GET /api/plugins/:id/docs/:name；--conversation/--current 读会话文档；--watch 订阅会话文档专用 SSE）',
    flags: [
      { name: 'conversation', type: 'number', help: '会话文档目标会话 ID（与 --current 互斥）' },
      { name: 'current', type: 'boolean', help: '使用 env HELM_CONVERSATION_ID（与 --conversation 互斥）' },
      { name: 'watch', type: 'boolean', help: '订阅会话文档专用 SSE（需 --conversation/--current；Ctrl-C 退出）' },
    ],
    positional: '<pluginId> <name>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'conversation', type: 'number' },
          { name: 'current', type: 'boolean' },
          { name: 'watch', type: 'boolean' },
        ],
        ctx.args,
      )
      const pluginId = parsed.positionals[0]
      const name = parsed.positionals[1]
      if (pluginId === undefined || name === undefined) {
        throw new CliError('缺少位置参数：plugins doc <pluginId> <name>', 'missing_id')
      }
      assertNoExtraPositionals(parsed.positionals, 2)
      const hasConversation = parsed.flags.has('conversation')
      const hasCurrent = parsed.flags.get('current') === true
      if (hasConversation && hasCurrent) {
        throw new CliError('--conversation 与 --current 互斥', 'conflicting_flags')
      }
      let conversationId: number | undefined
      if (hasConversation) {
        const value = parsed.flags.get('conversation')
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
          throw new CliError('--conversation 需为正整数会话 ID', 'invalid_flag_value')
        }
        conversationId = value
      } else if (hasCurrent) {
        conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
      }
      const base = `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(name)}`
      const hub = await ctx.hub()
      if (parsed.flags.get('watch') === true) {
        if (conversationId === undefined) {
          throw new CliError('--watch 需要会话目标（--conversation <id> 或 --current）', 'missing_conversation_target')
        }
        await watchSessionDoc(ctx, hub, base, conversationId, pluginId, name)
        return
      }
      const path =
        conversationId === undefined ? base : `${base}?conversationId=${conversationId}`
      const doc = await hub.get<{
        pluginId: string
        name: string
        conversationId?: number
        value: unknown
        deleted?: boolean
      }>(path)
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
    path: ['plugins', 'doctor'],
    description: '外部插件源码静态自检（POST /api/plugins/doctor；真实加载+真实注册+client 编译）',
    flags: [
      { name: 'path', type: 'string', help: '外部插件源目录绝对路径（与 --dir 等价；--id/<id> 互斥）' },
      { name: 'dir', type: 'string', help: '--path 的兼容别名（等价）' },
      { name: 'id', type: 'string', help: '已注册外部插件 id（服务端解析其源目录；与路径互斥）' },
    ],
    positional: '[<id> | <dir>]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'path', type: 'string' },
          { name: 'dir', type: 'string' },
          { name: 'id', type: 'string' },
        ],
        ctx.args,
      )
      const pathFlag = parsed.flags.get('path')
      const dirFlag = parsed.flags.get('dir')
      const idFlag = parsed.flags.get('id')
      const positional = parsed.positionals[0]
      // 位置参数语义推断：绝对路径 -> 目录目标；否则 -> 插件 id。
      const positionalIsPath =
        positional !== undefined &&
        (positional.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(positional) || positional.startsWith('\\\\'))
      const pathDir =
        typeof pathFlag === 'string' && pathFlag.length > 0
          ? pathFlag
          : typeof dirFlag === 'string' && dirFlag.length > 0
            ? dirFlag
            : positionalIsPath
              ? positional
              : undefined
      const id =
        typeof idFlag === 'string' && idFlag.length > 0
          ? idFlag
          : !positionalIsPath && positional !== undefined
            ? positional
            : undefined
      if (pathDir === undefined && id === undefined) {
        throw new CliError('缺少目标：<id>、--path <dir> 或 --dir <dir>（择一）', 'missing_id')
      }
      if (pathDir !== undefined && id !== undefined) {
        throw new CliError('id 与路径目标互斥（择一提供）', 'conflicting_flags')
      }
      const usedPositionals = positional !== undefined && (positionalIsPath ? pathDir === positional : id === positional) ? 1 : 0
      assertNoExtraPositionals(parsed.positionals, usedPositionals)
      const hub = await ctx.hub()
      const body = pathDir !== undefined ? { path: pathDir } : { id: id! }
      const report = await hub.post<PluginDoctorReport>('/api/plugins/doctor', body)
      if (ctx.json) {
        printResult(ctx, report)
      } else {
        ctx.io.out(
          `插件自检：${report.dir}${report.pluginId ? `（id: ${report.pluginId}）` : ''}${report.requestedId ? `（目标 id: ${report.requestedId}）` : ''}\n`,
        )
        for (const check of report.checks) {
          if (check.error === undefined) {
            ctx.io.out(`  [ok] ${check.id} — ${check.label}\n`)
          } else {
            ctx.io.out(`  [!!] ${check.id} — ${check.label}\n        ${check.error.code}: ${check.error.message}\n`)
          }
        }
        ctx.io.out(report.ok ? '结论：全部检查通过\n' : '结论：存在失败项（见上）\n')
      }
      // 预检失败：报告已完整输出（stdout），以非零退出码收尾供脚本消费。
      if (!report.ok) {
        throw new CliError(
          `插件自检存在失败项（${report.checks.filter((c) => c.error !== undefined).length} 项）`,
          'doctor_failed',
        )
      }
    },
  })

  cmds.push({
    path: ['plugins', 'reload'],
    description: '外部插件受控热重载（POST /api/plugins/:id/reload；预检失败旧实例保持不动）',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      const result = await hub.post<PluginReloadResult>(
        `/api/plugins/${encodeURIComponent(id)}/reload`,
      )
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      ctx.io.out(
        `已重载 ${result.pluginId}（代际 ${result.generation}，启用状态保持：${result.wasEnabled ? '已启用' : '已停用'}）\n`,
      )
      printResult(ctx, result.summary)
    },
  })

  cmds.push({
    path: ['plugins', 'rescan'],
    description: '增量重扫描插件目录（POST /api/plugins/rescan；只注册新外部插件，默认停用）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const result = await hub.post<PluginRescanResult>('/api/plugins/rescan')
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      if (result.registered.length === 0) {
        ctx.io.out('未发现新插件（已注册插件与纯数据目录不重载）\n')
      } else {
        ctx.io.out(`新注册 ${result.registered.length} 个插件（默认停用）：\n`)
        for (const id of result.registered) ctx.io.out(`  - ${id}\n`)
        ctx.io.out('启用：helm plugins enable <id>\n')
      }
      ctx.io.out(`（跳过 ${result.skipped} 个目录；当前共 ${result.plugins.length} 个插件）\n`)
    },
  })

  cmds.push({
    path: ['plugins', 'init'],
    description: '本地脚手架：在目标目录生成外部插件骨架（plugin.json + index.ts + tsconfig.json + client/index.tsx；不访问 Hub）',
    flags: [
      { name: 'dir', type: 'string', help: '目标父目录（默认 <dataDir>/plugins；目录需已存在或可创建）' },
      { name: 'name', type: 'string', help: '插件目录名与默认 id（字母数字与 - _，默认 sample-plugin）' },
      { name: 'template', type: 'string', help: '骨架模板：minimal（仅后端探针动作）| full（含 doc/动作/前端面板）；默认 full' },
      { name: 'force', type: 'boolean', help: '目标目录非空时继续（默认拒绝，防覆盖）' },
    ],
    positional: '[name]',
    async run(ctx: CommandContext) {
      await runPluginsInit(ctx)
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

// ---------------------------------------------------------------------------
// plugins init：本地脚手架（不访问 Hub；文件落盘后用 doctor/reload 闭环验证）
// ---------------------------------------------------------------------------

/** 插件 id/目录名：字母数字开头，允许 - _（与 protocol 插件 id 规则对齐，禁 builtin:）。 */
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const SCAFFOLD_PLUGIN_JSON = (id: string, template: 'minimal' | 'full') => `${JSON.stringify(
  {
    id,
    name: `${id} 插件`,
    version: '0.1.0',
    main: 'index.ts',
    ...(template === 'full' ? { clientRoot: './client' } : {}),
  },
  null,
  2,
)}\n`

/** 插件本地 tsconfig：与宿主后端转译器习惯对齐（.js 说明符映射、ESM）。 */
const SCAFFOLD_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      jsx: 'react-jsx',
    },
    include: ['index.ts', 'client/**/*.ts', 'client/**/*.tsx'],
  },
  null,
  2,
)}\n`

const SCAFFOLD_INDEX_TS_MINIMAL = (id: string) => `/**
 * 外部插件后端入口（id: ${id}）：export default PluginDefinition。
 * 修改后可用 helm plugins reload ${id} 受控热重载（预检失败时旧实例保持可用）。
 */
import type { PluginDefinition } from '@helm/protocol'

export default {
  id: '${id}',
  version: '0.1.0',
  description: '外部插件（helm plugins init --template minimal 生成）',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: '连通性探针',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { pong: { type: 'boolean' } },
        required: ['pong'],
        additionalProperties: false,
      },
      idempotent: true,
      handler: () => ({ pong: true }),
    })
  },
} satisfies PluginDefinition
`

const SCAFFOLD_INDEX_TS_FULL = (id: string) => `/**
 * 外部插件后端入口（id: ${id}）：export default PluginDefinition。
 * 修改后可用 helm plugins reload ${id} 受控热重载（预检失败时旧实例保持可用）。
 */
import type { PluginDefinition } from '@helm/protocol'

export default {
  id: '${id}',
  version: '0.1.0',
  description: '示例外部插件（helm plugins init 生成）',
  definePlugin(ctx) {
    const state = ctx.doc('state', { count: 0 }, { public: true })
    ctx.action({
      id: 'increment',
      description: '计数加一',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
        additionalProperties: false,
      },
      idempotent: false,
      handler() {
        state.update((current) => ({ count: current.count + 1 }))
        return { count: state.get().count }
      },
    })
    ctx.ui.workbenchPanel({
      id: 'sample-panel',
      label: '示例面板',
      client: { module: 'index.tsx', export: 'SamplePanel' },
    })
  },
} satisfies PluginDefinition
`

const SCAFFOLD_CLIENT_INDEX_TSX = `import React from 'react'
import { usePluginDoc } from '@helm/plugin-client'

export function SamplePanel(): React.JSX.Element {
  const state = usePluginDoc<{ count: number }>('state')
  return (
    <div className="section-flat">
      <div className="font-medium">示例面板</div>
      <div className="text-subtle">当前计数：{state?.count ?? 0}</div>
      <div className="text-subtle text-xs">
        调用 increment 动作更新计数（helm <plugin> increment --json）。
      </div>
    </div>
  )
}
`

const SCAFFOLD_README = (template: 'minimal' | 'full') => `# 外部插件（helm plugins init 生成）

- 后端入口：\`index.ts\`（export default PluginDefinition）${template === 'full' ? '\n- 前端组件：\`client/index.tsx\`（clientRoot 声明为 ./client）' : ''}
- 清单：\`plugin.json\`；本地类型检查：\`tsconfig.json\`（宿主运行时转译不依赖它，仅供编辑器/CI）

## 开发闭环

\`\`\`bash
helm plugins doctor <本目录绝对路径>     # 静态自检（真实加载+真实注册+client 编译）
helm plugins rescan                      # Hub 增量发现新目录（默认停用）
helm plugins enable <id>                 # 启用
helm plugins reload <id>                 # 修改代码后受控热重载（预检失败旧实例保持）
\`\`\`
`

/** 生成插件骨架文件（存在性预检 + 非空目录拒绝 + 模板选择 + 明确产出清单）。 */
async function runPluginsInit(ctx: CommandContext): Promise<void> {
  const parsed = parseFlags(
    [
      { name: 'dir', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'template', type: 'string' },
      { name: 'force', type: 'boolean' },
    ],
    ctx.args,
  )
  const nameFlag = parsed.flags.get('name')
  const namePositional = parsed.positionals[0]
  const name = typeof nameFlag === 'string' && nameFlag.length > 0 ? nameFlag : namePositional
  if (typeof name !== 'string' || name.length === 0) {
    throw new CliError('缺少 <name>（--name 或位置参数）', 'missing_id')
  }
  if (!PLUGIN_NAME_PATTERN.test(name) || name.startsWith('builtin:')) {
    throw new CliError(
      `插件名非法：${name}（需匹配 ${PLUGIN_NAME_PATTERN}，且禁止 builtin: 前缀）`,
      'invalid_flag_value',
    )
  }
  const templateRaw = parsed.flags.get('template')
  if (templateRaw !== undefined && templateRaw !== 'minimal' && templateRaw !== 'full') {
    throw new CliError('--template 需为 minimal | full', 'invalid_flag_value')
  }
  const template = (templateRaw ?? 'full') as 'minimal' | 'full'
  const usedPositionals = name === namePositional ? 1 : 0
  assertNoExtraPositionals(parsed.positionals, usedPositionals)
  const parentDir =
    typeof parsed.flags.get('dir') === 'string' && (parsed.flags.get('dir') as string).length > 0
      ? (parsed.flags.get('dir') as string)
      : `${ctx.dataDir}/plugins`
  const target = `${parentDir.replace(/\/+$/, '')}/${name}`
  const force = parsed.flags.get('force') === true

  const fsp = await import('node:fs/promises')
  const path = await import('node:path')
  // 父目录：不存在时创建（与 plugins 目录约定一致）；存在但非目录显式报错。
  try {
    const st = await fsp.stat(parentDir)
    if (!st.isDirectory()) {
      throw new CliError(`--dir 不是目录：${parentDir}`, 'invalid_flag_value')
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof CliError) throw err
      throw new CliError(
        `检查 --dir 失败（${parentDir}）：${err instanceof Error ? err.message : String(err)}`,
        'read_failed',
      )
    }
    await fsp.mkdir(parentDir, { recursive: true })
  }
  // 目标目录：已存在且非空时默认拒绝（--force 继续）；已存在为空时复用。
  let targetExisted = false
  try {
    const st = await fsp.stat(target)
    if (!st.isDirectory()) {
      throw new CliError(`目标路径已存在且不是目录：${target}`, 'conflict')
    }
    targetExisted = true
    const existing = await fsp.readdir(target)
    if (existing.length > 0 && !force) {
      throw new CliError(
        `目标目录非空：${target}（使用 --force 继续；现有文件不会被删除，但同名文件将被覆盖）`,
        'conflict',
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof CliError) throw err
      throw new CliError(
        `检查目标目录失败（${target}）：${err instanceof Error ? err.message : String(err)}`,
        'read_failed',
      )
    }
  }
  // 目标目录不存在时创建（minimal 模板无 client 子目录，根目录必须显式建）。
  await fsp.mkdir(target, { recursive: true })
  const files: string[] = ['plugin.json', 'index.ts', 'tsconfig.json']
  await fsp.writeFile(path.join(target, 'plugin.json'), SCAFFOLD_PLUGIN_JSON(name, template), 'utf8')
  await fsp.writeFile(
    path.join(target, 'index.ts'),
    template === 'full' ? SCAFFOLD_INDEX_TS_FULL(name) : SCAFFOLD_INDEX_TS_MINIMAL(name),
    'utf8',
  )
  await fsp.writeFile(path.join(target, 'tsconfig.json'), SCAFFOLD_TSCONFIG, 'utf8')
  if (template === 'full') {
    await fsp.mkdir(path.join(target, 'client'), { recursive: true })
    await fsp.writeFile(path.join(target, 'client', 'index.tsx'), SCAFFOLD_CLIENT_INDEX_TSX, 'utf8')
    files.push('client/index.tsx')
  }
  await fsp.writeFile(path.join(target, 'README.md'), SCAFFOLD_README(template), 'utf8')
  files.push('README.md')

  const summary = {
    pluginId: name,
    dir: target,
    template,
    files,
    targetExisted,
    nextSteps: [
      `helm plugins doctor ${target}`,
      'helm plugins rescan',
      `helm plugins enable ${name}`,
    ],
  }
  if (ctx.json) {
    printResult(ctx, summary)
    return
  }
  ctx.io.out(
    `已生成插件骨架（模板 ${template}）：${target}${targetExisted ? '（目录已存在，文件已写入/覆盖）' : ''}\n`,
  )
  for (const file of summary.files) ctx.io.out(`  - ${file}\n`)
  ctx.io.out('后续步骤：\n')
  for (const step of summary.nextSteps) ctx.io.out(`  ${step}\n`)
}
