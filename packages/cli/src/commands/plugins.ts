/**
 * 插件域：plugins list/enable/disable/config/doc/client 与 doctor/reload/rescan
 * （DX 闭环）、install/update/remove（受管包管理）与 actions list。config 除
 * --input <json> 外支持可重复 --set key=value（值按 JSON boolean/number 语义
 * 解析，否则 string）。plugins init 为本地脚手架命令（minimal/full 通用插件与
 * app 全栈微应用三档模板，app 产物直接通过 helm apps validate 预检）。
 */
import type {
  ActionManifest,
  PluginDoctorReport,
  PluginInstallResult,
  PluginReloadResult,
  PluginRemoveResult,
  PluginRescanResult,
  PluginSummary,
  PluginUpdateResult,
} from '@helm/protocol'
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

/**
 * 破坏性移除确认（复用 CLI 既有 TTY/非 TTY 分流惯例，与 login 密码同风格）：
 * --yes 与 --json 非交互放行；TTY 终端 stdin 提问一行（y/yes 确认）；
 * 非 TTY 无 --yes 显式拒绝——绝不在无人值守的管道上悬等输入。
 */
async function confirmRemove(ctx: CommandContext, assumedYes: boolean, pluginId: string): Promise<void> {
  if (ctx.json || assumedYes) return
  if (process.stdin.isTTY !== true) {
    throw new CliError(
      `移除 ${pluginId} 为破坏性操作（清理 Hub 主机安装目录，不可恢复）：非交互环境需 --yes 确认`,
      'confirmation_required',
    )
  }
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`将移除插件 ${pluginId} 及其安装目录（不可恢复）。输入 yes 确认：`)
    const normalized = answer.trim().toLowerCase()
    if (normalized !== 'y' && normalized !== 'yes') {
      throw new CliError('已取消：未确认移除', 'not_confirmed')
    }
  } finally {
    rl.close()
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
    description: '停用插件（POST /api/plugins/:id/disable；--force 忽略持久资源占用告警）',
    flags: [
      { name: 'force', type: 'boolean', help: '强制停用（忽略持久配置/资源占用告警；在途运行任务仍不可跳过）' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'force', type: 'boolean' }], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const force = parsed.flags.get('force') === true
      const hub = await ctx.hub()
      const path = `/api/plugins/${encodeURIComponent(id)}/disable`
      try {
        // 无 --force 时保持无 body 调用：服务端遇持久资源占用返回 409
        // plugin_in_use，由下方富化为占用清单 + --force 提示。
        printResult(
          ctx,
          force ? await hub.post<unknown>(path, { force: true }) : await hub.post<unknown>(path),
        )
      } catch (err) {
        if (!force && err instanceof CliError && err.code === 'plugin_in_use') {
          throw enrichPluginInUseError(err)
        }
        throw err
      }
    },
  })

  cmds.push({
    path: ['plugins', 'config'],
    description: '查看/更新插件配置（GET 返回 {values,schema}；PUT 发送 {values}；--set key=value 与 --unset key 可重复）',
    flags: [
      { name: 'input', type: 'json', help: '整体 values JSON 对象（与 --set 可共存，--set 覆盖对应键）' },
      { name: 'set', type: 'string', repeated: true, help: '单项赋值 key=value，可重复；值按 JSON boolean/number 解析，否则 string' },
      { name: 'unset', type: 'string', repeated: true, help: '重置指定配置键回默认值（发送 null 删除显式覆写值，可重复）' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'input', type: 'json' },
          { name: 'set', type: 'string', repeated: true },
          { name: 'unset', type: 'string', repeated: true },
        ],
        ctx.args,
      )
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hasInput = parsed.flags.has('input')
      const sets = repeatedValues(parsed.flags, 'set')
      const unsets = repeatedValues(parsed.flags, 'unset')
      for (const key of unsets) {
        if (key.length === 0 || key.includes('=')) {
          throw new CliError(`--unset 需为配置键名（非空、不含 =），实得 "${key}"`, 'invalid_flag_value')
        }
      }
      const hub = await ctx.hub()
      const path = `/api/plugins/${encodeURIComponent(id)}/config`
      if (!hasInput && sets.length === 0 && unsets.length === 0) {
        printResult(ctx, await hub.get<unknown>(path))
        return
      }
      const setValues = parseKeyValues(sets, 'set')
      for (const key of unsets) {
        if (key in setValues) {
          throw new CliError(`--set 与 --unset 不能同时作用于同一字段: ${key}`, 'conflicting_flags')
        }
      }
      const values: Record<string, unknown> = hasInput ? coerceMetaFlag(parsed.flags.get('input'), 'input') : {}
      Object.assign(values, setValues)
      for (const key of unsets) values[key] = null
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
      { name: 'chunk', type: 'string', help: '可选 chunk 文件名（如 vendor.js）' },
      { name: 'output', type: 'string', help: '写入目标文件路径（缺省 stdout；--json 时仍写文件并打印元信息）' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'module', type: 'string' },
          { name: 'chunk', type: 'string' },
          { name: 'output', type: 'string' },
        ],
        ctx.args,
      )
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const moduleRef = (parsed.flags.get('module') as string | undefined) ?? 'client.tsx'
      const chunk = parsed.flags.get('chunk') as string | undefined
      if (parsed.flags.has('output') && typeof parsed.flags.get('output') !== 'string') {
        throw new CliError('--output 需要文件路径', 'invalid_flag_value')
      }
      const outPath = parsed.flags.get('output') as string | undefined
      const hub = await ctx.hub()
      let path = `/api/plugins/${encodeURIComponent(id)}/client.mjs?module=${encodeURIComponent(moduleRef)}`
      if (chunk !== undefined) {
        path += `&chunk=${encodeURIComponent(chunk)}`
      }
      const response = await hub.raw(path)
      const code = await response.text()
      const contentHash = response.headers.get('x-helm-client-hash') ?? ''
      if (ctx.json) {
        printResult(ctx, {
          pluginId: id,
          module: moduleRef,
          ...(chunk !== undefined ? { chunk } : {}),
          contentHash,
          bytes: code.length,
        })
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
    description:
      '本地脚手架：在目标目录生成外部插件骨架（不访问 Hub）；--template app 生成可通过 helm apps validate 的全栈微应用',
    flags: [
      { name: 'dir', type: 'string', help: '目标父目录（默认 <dataDir>/plugins；目录需已存在或可创建）' },
      { name: 'name', type: 'string', help: '插件目录名与默认 id（字母数字与 - _，默认 sample-plugin）' },
      {
        name: 'template',
        type: 'string',
        help: '骨架模板：minimal（仅后端探针动作）| full（含 doc/动作/前端面板）| app（全栈微应用：doc/双动作/screen 主视图 + 侧栏入口，产物直接过 helm apps validate）；默认 full',
      },
      { name: 'force', type: 'boolean', help: '目标目录非空时继续（默认拒绝，防覆盖）' },
    ],
    positional: '[name]',
    async run(ctx: CommandContext) {
      await runPluginsInit(ctx)
    },
  })

  cmds.push({
    path: ['plugins', 'install'],
    description:
      '从 npm/git/本地路径安装外部插件包并注册（POST /api/plugins/install；默认停用，--enable 装后即启用）。source 由 Hub 解析，本地路径相对 Hub 主机；安装启用即在 Hub 内执行可信插件代码，无沙箱',
    flags: [{ name: 'enable', type: 'boolean', help: '安装后立即启用（缺省注册为停用）' }],
    positional: '<source>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'enable', type: 'boolean' }], ctx.args)
      const source = requirePositional(parsed.positionals, 0, 'source')
      if (source.trim() === '') {
        throw new CliError(
          '<source> 不能为空（npm:<spec> / git:<repo>@<ref> / HTTPS Git URL / 本地路径，语法由 Hub 解析）',
          'invalid_flag_value',
        )
      }
      assertNoExtraPositionals(parsed.positionals, 1)
      const enable = parsed.flags.get('enable') === true
      const hub = await ctx.hub()
      const result = await hub.post<PluginInstallResult>('/api/plugins/install', {
        source,
        ...(enable ? { enable: true } : {}),
      })
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      ctx.io.out(
        `已安装 ${result.summary.id}${result.record.version === '' ? '' : ` ${result.record.version}`}（来源 ${result.record.source.raw}）\n`,
      )
      ctx.io.out(`安装目录（Hub 主机）：${result.record.installPath}\n`)
      ctx.io.out(
        result.summary.enabled
          ? '状态：已启用\n'
          : `状态：已停用（启用：helm plugins enable ${result.summary.id}）\n`,
      )
    },
  })

  cmds.push({
    path: ['plugins', 'update'],
    description: '更新已安装的外部插件包并重载（POST /api/plugins/:id/update；目标须为受管安装的插件）',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      const result = await hub.post<PluginUpdateResult>(
        `/api/plugins/${encodeURIComponent(id)}/update`,
      )
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      const ver = (v: string): string => (v === '' ? '未知版本' : v)
      if (result.changed) {
        ctx.io.out(`已更新 ${result.record.pluginId}：${ver(result.previousVersion)} -> ${ver(result.record.version)}\n`)
      } else {
        ctx.io.out(`${result.record.pluginId} 源未变化，无更新（当前 ${ver(result.record.version)}）\n`)
      }
      ctx.io.out(
        `安装目录（Hub 主机）：${result.record.installPath}；状态：${result.summary.enabled ? '已启用' : '已停用'}\n`,
      )
    },
  })

  cmds.push({
    path: ['plugins', 'remove'],
    description:
      '移除受管安装的外部插件包（POST /api/plugins/:id/remove；停用并清理 Hub 主机上的安装目录与记录，不可恢复）。人类模式默认确认（TTY 输入 yes），非交互环境用 --yes',
    flags: [{ name: 'yes', type: 'boolean', help: '跳过确认（非交互/脚本环境）' }],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'yes', type: 'boolean' }], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      await confirmRemove(ctx, parsed.flags.get('yes') === true, id)
      const hub = await ctx.hub()
      const result = await hub.post<PluginRemoveResult>(
        `/api/plugins/${encodeURIComponent(id)}/remove`,
      )
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      ctx.io.out(`已移除 ${result.pluginId}（安装记录 ${result.installId}；移除前${result.wasEnabled ? '启用中' : '已停用'}）\n`)
      ctx.io.out(`已清理目录（Hub 主机）：${result.installPath}\n`)
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
// 409 plugin_in_use 富化：保留 code/details，消息附带占用清单与 --force 提示
// ---------------------------------------------------------------------------

/** 从错误 details 中提取结构合法的占用列表（usages: [{kind,id,label}]）。 */
function extractInUseUsages(details: unknown): Array<{ kind: string; id: string; label: string }> {
  if (details === null || typeof details !== 'object') return []
  const usages = (details as { usages?: unknown }).usages
  if (!Array.isArray(usages)) return []
  return usages.filter(
    (item): item is { kind: string; id: string; label: string } =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as { kind?: unknown }).kind === 'string' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { label?: unknown }).label === 'string',
  )
}

/** 保留原 CliError 的 code/details/exitCode，仅富化人类可读消息。 */
function enrichPluginInUseError(err: CliError): CliError {
  const usages = extractInUseUsages(err.details)
  if (usages.length === 0) return err
  const lines = [err.message, '占用中的持久资源：']
  for (const usage of usages) {
    lines.push(`  - [${usage.kind}] ${usage.id}：${usage.label}`)
  }
  lines.push('确认后可使用 --force 强制停用（在途运行任务仍不可跳过）。')
  return new CliError(lines.join('\n'), err.code, err.exitCode, err.details)
}

// ---------------------------------------------------------------------------
// plugins init：本地脚手架（不访问 Hub；文件落盘后用 doctor/reload 闭环验证）
// ---------------------------------------------------------------------------

/** 插件 id/目录名：字母数字开头，允许 - _（与 protocol 插件 id 规则对齐，禁 builtin:）。 */
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** 脚手架模板集合：minimal 仅后端 / full 通用插件面板 / app 全栈微应用（过 apps validate）。 */
type ScaffoldTemplate = 'minimal' | 'full' | 'app'

const SCAFFOLD_TEMPLATES: readonly ScaffoldTemplate[] = ['minimal', 'full', 'app']

const SCAFFOLD_PLUGIN_JSON = (id: string, template: ScaffoldTemplate) => `${JSON.stringify(
  {
    id,
    name: template === 'app' ? `${id} 应用` : `${id} 插件`,
    version: '0.1.0',
    main: 'index.ts',
    ...(template === 'app' || template === 'full' ? { clientRoot: './client' } : {}),
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
  clientRoot: './client',
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
import { usePluginDoc, ScreenSection, DataTable, KvGrid } from '@helm/plugin-client'

export function SamplePanel(): React.JSX.Element {
  const state = usePluginDoc<{ count: number }>('state')
  const loading = state === undefined
  return (
    <ScreenSection title="示例面板">
      {loading ? (
        <div className="loading-state" role="status">计数读取中…</div>
      ) : (
        <KvGrid
          items={[
            { key: '当前计数', value: state.count },
            { key: '更新方式', value: '调用 increment 动作更新计数' },
          ]}
        />
      )}
      <DataTable columns={1} empty={!loading && state !== undefined && state.count === 0} emptyLabel="计数为零">
        <thead>
          <tr>
            <th>计数记录</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>count = {state === undefined ? '—' : state.count}</td>
          </tr>
        </tbody>
      </DataTable>
    </ScreenSection>
  )
}
`

/**
 * app 模板后端：public doc 持久条目 + 两个双 Schema 动作 + screen 主视图 + 侧栏直达入口。
 * 与 apps/todo-demo 种子应用及 app-builder 技能 fullstack-template.md 保持同一形状；
 * 写后 flush（诚实性：不谎报已持久化）；无 Emoji；动作同时声明 input/outputSchema
 * （单点 Schema 契约，缺失会在 doctor register 阶段被拒）。
 */
const SCAFFOLD_INDEX_TS_APP = (id: string, label: string) => `/**
 * 全栈微应用后端入口（id: ${id}）：export default PluginDefinition。
 * 修改后用 helm apps validate 复检，再 helm apps publish 热更新发布。
 */
import { randomUUID } from 'node:crypto'
import type { PluginDefinition } from '@helm/protocol'

interface Item {
  id: string
  title: string
  done: boolean
  createdAt: number
}

export default {
  id: '${id}',
  name: '${label}',
  description: '最小全栈微应用：持久条目 + 新增/勾选动作 + 主视图。',
  version: '0.1.0',
  clientRoot: './client',
  definePlugin(ctx) {
    // 持久业务数据：public doc 供前端 usePluginDoc 实时订阅
    const items = ctx.doc<{ list: Item[] }>('items', { list: [] }, { public: true })

    // 共享 outputSchema：动作统一返回 { ok: true }
    const okSchema = {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
      additionalProperties: false,
    } as const

    ctx.action<{ title: string }, { ok: boolean }>({
      id: 'add_item',
      description: '新增一条条目',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 } },
        required: ['title'],
        additionalProperties: false,
      },
      outputSchema: okSchema,
      exposeAsTool: true,
      async handler(input) {
        items.update((current) => ({
          list: [
            { id: randomUUID(), title: input.title, done: false, createdAt: Date.now() },
            ...current.list,
          ],
        }))
        await items.flush()
        return { ok: true }
      },
    })

    ctx.action<{ id: string; done: boolean }, { ok: boolean }>({
      id: 'set_done',
      description: '勾选/取消勾选条目',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, done: { type: 'boolean' } },
        required: ['id', 'done'],
        additionalProperties: false,
      },
      outputSchema: okSchema,
      exposeAsTool: true,
      async handler(input) {
        items.update((current) => ({
          list: current.list.map((it) => (it.id === input.id ? { ...it, done: input.done } : it)),
        }))
        await items.flush()
        return { ok: true }
      },
    })

    // 全栈应用硬性要求：至少一个 ctx.ui.screen（apps validate 的 missing_app_screen 检查项）
    ctx.ui.screen({
      id: 'main',
      label: '${label}',
      client: { module: 'index.tsx', export: 'MainScreen' },
    })

    // 侧栏直达入口（协议允许 screen:<pluginId>/<screenId> 目标；不需要可直接删除本段，
    // 应用仍可从应用中心打开）
    ctx.ui.sidebarItem({
      id: 'open-main',
      label: '${label}',
      icon: 'layout-grid',
      target: 'screen:${id}/main',
    })
  },
} satisfies PluginDefinition
`

/**
 * app 模板前端：仅用 @helm/plugin-client 宿主原语（Screen/ScreenSection/KvGrid/
 * DataTable/Checkbox）+ 宿主 CSS 变量与 .btn 按钮；无 Emoji；13px 正文。
 */
const SCAFFOLD_CLIENT_APP_TSX = `import { useState, type ReactNode } from 'react'
import {
  usePluginContext,
  usePluginDoc,
  Screen,
  ScreenSection,
  DataTable,
  KvGrid,
  Checkbox,
} from '@helm/plugin-client'
import './styles.css'

interface Item {
  id: string
  title: string
  done: boolean
  createdAt: number
}

export function MainScreen(): ReactNode {
  const { callAction, notify } = usePluginContext()
  const doc = usePluginDoc<{ list: Item[] }>('items')
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)

  const list = doc?.list ?? []
  const doneCount = list.filter((it) => it.done).length

  const add = async () => {
    const title = draft.trim()
    if (title === '') return
    setPending(true)
    try {
      await callAction('add_item', { title })
      setDraft('')
    } catch (err) {
      notify('新增失败：' + (err instanceof Error ? err.message : String(err)), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <Screen title="条目工作台" subtitle={'已完成 ' + doneCount + ' / ' + list.length}>
      <ScreenSection title="新增条目">
        <div className="app-form">
          <input
            className="app-input"
            value={draft}
            placeholder="输入条目标题后回车…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
          />
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => void add()}>
            新增
          </button>
        </div>
      </ScreenSection>

      <ScreenSection title="概览">
        <KvGrid
          items={[
            { key: '条目总数', value: list.length },
            { key: '已完成', value: doneCount },
            { key: '数据来源', value: "public doc 'items'（usePluginDoc 实时订阅）" },
          ]}
        />
      </ScreenSection>

      <ScreenSection title="条目列表">
        <DataTable
          loading={doc === undefined}
          empty={list.length === 0}
          emptyLabel="暂无条目，输入标题新增第一条"
          columns={2}
          label="条目列表"
        >
          <thead>
            <tr>
              <th>状态</th>
              <th>内容</th>
            </tr>
          </thead>
          <tbody>
            {list.map((it) => (
              <tr key={it.id}>
                <td className="app-col-check">
                  <Checkbox
                    checked={it.done}
                    onChange={(checked) => {
                      void callAction('set_done', { id: it.id, done: checked }).catch((err: unknown) =>
                        notify('更新失败：' + (err instanceof Error ? err.message : String(err)), 'error'),
                      )
                    }}
                  />
                </td>
                <td className={it.done ? 'app-done' : ''}>{it.title}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </ScreenSection>
    </Screen>
  )
}
`

/** app 模板补充样式：仅布局微调，颜色一律走宿主 CSS 变量。 */
const SCAFFOLD_CLIENT_APP_CSS = `.app-form { display: flex; gap: 8px; }
.app-input { flex: 1; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 13px; color: var(--fg); }
.app-input:focus { outline: none; border-color: var(--accent); }
.app-col-check { width: 48px; }
.app-done { text-decoration: line-through; color: var(--fg-muted); }
`

const SCAFFOLD_README = (template: ScaffoldTemplate) =>
  template === 'app'
    ? `# 全栈微应用（helm plugins init --template app 生成）

- 后端入口：\`index.ts\`（public doc 'items' + add_item/set_done 双 Schema 动作 + ctx.ui.screen + 侧栏入口）
- 前端组件：\`client/index.tsx\`（clientRoot 为 ./client，仅用 @helm/plugin-client 宿主原语）
- 清单：\`plugin.json\`；本地类型检查：\`tsconfig.json\`（宿主运行时转译不依赖它，仅供编辑器/CI）

## 开发闭环（无需发布到宿主即可验证）

\`\`\`bash
helm plugins doctor <本目录绝对路径>   # 四阶段自检：manifest/backend/register/client
helm apps validate <本目录绝对路径>   # doctor + 全栈应用 Screen 强制检查
helm apps publish <本目录绝对路径>    # 预检通过后受管安装并启用，登记应用中心
helm apps remove <pluginId>           # 卸载（本地源码目录不受影响）
\`\`\`

侧栏入口（ctx.ui.sidebarItem）可删；删除后应用仍可从应用中心打开。同形参考样本：仓库 \`apps/todo-demo\`。
`
    : `# 外部插件（helm plugins init 生成）

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
  if (templateRaw !== undefined && !SCAFFOLD_TEMPLATES.includes(templateRaw as ScaffoldTemplate)) {
    throw new CliError(`--template 需为 ${SCAFFOLD_TEMPLATES.join(' | ')}`, 'invalid_flag_value')
  }
  const template = (templateRaw ?? 'full') as ScaffoldTemplate
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
    template === 'minimal'
      ? SCAFFOLD_INDEX_TS_MINIMAL(name)
      : template === 'app'
        ? SCAFFOLD_INDEX_TS_APP(name, `${name} 应用`)
        : SCAFFOLD_INDEX_TS_FULL(name),
    'utf8',
  )
  await fsp.writeFile(path.join(target, 'tsconfig.json'), SCAFFOLD_TSCONFIG, 'utf8')
  if (template === 'full') {
    await fsp.mkdir(path.join(target, 'client'), { recursive: true })
    await fsp.writeFile(path.join(target, 'client', 'index.tsx'), SCAFFOLD_CLIENT_INDEX_TSX, 'utf8')
    files.push('client/index.tsx')
  }
  if (template === 'app') {
    await fsp.mkdir(path.join(target, 'client'), { recursive: true })
    await fsp.writeFile(path.join(target, 'client', 'index.tsx'), SCAFFOLD_CLIENT_APP_TSX, 'utf8')
    await fsp.writeFile(path.join(target, 'client', 'styles.css'), SCAFFOLD_CLIENT_APP_CSS, 'utf8')
    files.push('client/index.tsx', 'client/styles.css')
  }
  await fsp.writeFile(path.join(target, 'README.md'), SCAFFOLD_README(template), 'utf8')
  files.push('README.md')

  const summary = {
    pluginId: name,
    dir: target,
    template,
    files,
    targetExisted,
    nextSteps:
      template === 'app'
        ? [`helm plugins doctor ${target}`, `helm apps validate ${target}`, `helm apps publish ${target}`]
        : [`helm plugins doctor ${target}`, 'helm plugins rescan', `helm plugins enable ${name}`],
  }
  if (ctx.json) {
    printResult(ctx, summary)
    return
  }
  ctx.io.out(
    `已生成${template === 'app' ? '全栈微应用' : '插件'}骨架（模板 ${template}）：${target}${targetExisted ? '（目录已存在，文件已写入/覆盖）' : ''}\n`,
  )
  for (const file of summary.files) ctx.io.out(`  - ${file}\n`)
  ctx.io.out('后续步骤：\n')
  for (const step of summary.nextSteps) ctx.io.out(`  ${step}\n`)
}
