/** 工作流域：workflows list/run/runs/inspect/abort。 */
import type { WorkflowRunRequest, WorkflowRunSummary } from '@helm/protocol'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  parseNoFlags,
  printResult,
  requirePositional,
  resolveConversationTarget,
} from './shared.js'
import { printValue } from '../output.js'

const convFlags: FlagSpec[] = [{ name: 'current', type: 'boolean', help: '使用 env HELM_CONVERSATION_ID' }]

export function workflowsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['workflows', 'list'],
    description: '列出已保存工作流（GET /api/workflows）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<unknown[]>('/api/workflows'))
    },
  })

  cmds.push({
    path: ['workflows', 'run'],
    description: '运行工作流（POST /api/workflows/run；--wait 等待终态）',
    flags: [
      { name: 'args', type: 'json', help: '原样传给脚本的 args' },
      { name: 'resume-from-run-id', type: 'string', help: '断点重放 runId' },
      { name: 'current', type: 'boolean', help: '绑定 env HELM_CONVERSATION_ID 会话' },
      { name: 'wait', type: 'boolean', help: '等待终态（?wait=1；failed/aborted 非零退出）' },
    ],
    positional: '<nameOrFile>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'args', type: 'json' },
          { name: 'resume-from-run-id', type: 'string' },
          { name: 'current', type: 'boolean' },
          { name: 'wait', type: 'boolean' },
        ],
        ctx.args,
      )
      const target = requirePositional(parsed.positionals, 0, 'nameOrFile', 'missing_target')
      assertNoExtraPositionals(parsed.positionals, 1)
      const body: Record<string, unknown> = {}
      // CLI 层判断文件/名称：存在即本机文件（发绝对路径 scriptPath），否则视为已保存名称
      const fsp = await import('node:fs/promises')
      const pathMod = await import('node:path')
      let isFile = false
      try {
        const st = await fsp.stat(target)
        isFile = st.isFile()
      } catch {
        isFile = false
      }
      if (isFile) body.scriptPath = pathMod.resolve(target)
      else body.name = target
      const args = parsed.flags.get('args')
      if (args !== undefined) body.args = args
      const resume = flagValue<string>(parsed.flags, 'resume-from-run-id')
      if (resume !== undefined) body.resumeFromRunId = resume
      if (parsed.flags.get('current') === true) {
        body.conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
      }
      const wait = parsed.flags.get('wait') === true
      const hub = await ctx.hub()
      const summary = await hub.request<WorkflowRunSummary>(
        'POST',
        `/api/workflows/run${wait ? '?wait=1' : ''}`,
        { body: body satisfies WorkflowRunRequest, ...(wait ? { timeoutMs: 0 } : {}) },
      )
      // --wait：终态 failed/aborted 已由 Hub 错误信封转为 CliError 非零退出；
      // 此处只剩 completed。人类模式输出终端摘要行 + result（不把空 result 当成功文本）。
      if (wait && !ctx.json) {
        ctx.io.out(`run ${summary.id} ${summary.status}\n`)
        if (summary.result !== undefined) printValue(ctx.io, summary.result, false)
        return
      }
      printResult(ctx, summary)
    },
  })

  cmds.push({
    path: ['workflows', 'runs'],
    description: '列出工作流运行（GET /api/workflows/runs；可选 --current 过滤本会话）',
    flags: [...convFlags],
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'current', type: 'boolean' }], ctx.args)
      assertNoExtraPositionals(parsed.positionals, 0, '位置参数（查单个 run 用 helm workflows inspect <runId>）：')
      let qs = ''
      if (parsed.flags.get('current') === true) {
        const conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
        qs = `?conversationId=${conversationId}`
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<WorkflowRunSummary[]>(`/api/workflows/runs${qs}`))
    },
  })

  cmds.push({
    path: ['workflows', 'inspect'],
    description: '查看工作流运行（GET /api/workflows/runs/:runId）',
    positional: '<runId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'runId')
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<WorkflowRunSummary>(`/api/workflows/runs/${encodeURIComponent(id)}`))
    },
  })

  cmds.push({
    path: ['workflows', 'abort'],
    description: '中止工作流运行（POST /api/workflows/runs/:runId/abort）',
    positional: '<runId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'runId')
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/workflows/runs/${encodeURIComponent(id)}/abort`))
    },
  })

  return cmds
}
