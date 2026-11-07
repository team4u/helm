/**
 * 计算节点管理域（Hub 侧）：nodes list / issue / remove。
 * 纯管理面 API，与 `helm-node`（受控机器守护进程）职责分离。
 */
import { CliError } from '../errors.js'
import type { NodeInfo, NodeIssuedToken } from '@helm/protocol'
import { parseFlags } from '../args.js'
import type { Io } from '../options.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, parseNoFlags, printResult, requirePositional } from './shared.js'
import { printText } from '../output.js'

/** nodes list 人类模式固定列（原始字段可能更多，仅展示关键五列）。 */
const NODE_COLUMNS: ReadonlyArray<{ key: keyof NodeInfo; label: string }> = [
  { key: 'id', label: 'id' },
  { key: 'kind', label: 'kind' },
  { key: 'online', label: 'online' },
  { key: 'hostname', label: 'hostname' },
  { key: 'platform', label: 'platform' },
]

function printNodesTable(io: Io, nodes: NodeInfo[]): void {
  if (nodes.length === 0) {
    io.out('(empty)\n')
    return
  }
  const rows = nodes.map((n) => NODE_COLUMNS.map(({ key }) => (n[key] === undefined ? '' : String(n[key]))))
  const widths = NODE_COLUMNS.map(({ label }, i) => Math.max(label.length, ...rows.map((r) => r[i]!.length)))
  io.out(NODE_COLUMNS.map(({ label }, i) => label.padEnd(widths[i]!)).join('  ') + '\n')
  io.out(widths.map((w) => '-'.repeat(w)).join('  ') + '\n')
  for (const row of rows) {
    io.out(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ') + '\n')
  }
}

/** issue 签发结果人类模式：token 明文仅此一次，突出展示。 */
function printIssuedToken(io: Io, issued: NodeIssuedToken): void {
  printText(io, [
    `节点 ${issued.nodeId} 接入令牌（仅此一次展示，服务端只存摘要）：`,
    '',
    `  ${issued.token}`,
    '',
    '受控机器执行：helm-node connect <hubUrl> --token <token>',
  ].join('\n'))
}

export function nodesCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['nodes', 'list'],
    description: '列出计算节点与在线状态（GET /api/nodes）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const nodes = await hub.get<NodeInfo[]>('/api/nodes')
      if (!Array.isArray(nodes)) throw new CliError('Hub 节点列表必须是数组', 'invalid_response')
      if (ctx.json) {
        printResult(ctx, nodes)
        return
      }
      printNodesTable(ctx.io, nodes)
    },
  })

  cmds.push({
    path: ['nodes', 'issue'],
    description: '签发节点接入令牌（POST /api/nodes/issue；明文 token 仅返回一次）',
    positional: '<nodeId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const nodeId = requirePositional(parsed.positionals, 0, 'nodeId')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      const issued = await hub.post<NodeIssuedToken>('/api/nodes/issue', { nodeId })
      if (!issued || typeof issued !== 'object' || issued.nodeId !== nodeId || typeof issued.token !== 'string' || !issued.token.startsWith(`${nodeId}:`)) {
        throw new CliError('Hub 签发响应缺少有效的节点令牌', 'invalid_response')
      }
      if (ctx.json) {
        printResult(ctx, issued)
        return
      }
      printIssuedToken(ctx.io, issued)
    },
  })

  cmds.push({
    path: ['nodes', 'remove'],
    description: '移除受控节点并立即断开连接（DELETE /api/nodes/:id）',
    positional: '<nodeId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const nodeId = requirePositional(parsed.positionals, 0, 'nodeId')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      printResult(ctx, await hub.delete<unknown>(`/api/nodes/${encodeURIComponent(nodeId)}`))
    },
  })

  return cmds
}
