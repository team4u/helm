/**
 * 计算节点管理域（Hub 侧）：nodes list / issue / remove / upgrade。
 * 纯管理面 API，与 `helm-node`（受控机器守护进程）职责分离。
 */
import { CliError } from '../errors.js'
import type { NodeInfo, NodeIssuedToken, NodeUpgradeCheckResult, NodeUpgradeResult } from '@helm/protocol'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { Io } from '../options.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, parseNoFlags, printResult, requirePositional } from './shared.js'
import { printText } from '../output.js'

/** nodes list 人类模式固定列（原始字段可能更多，仅展示关键六列）。 */
const NODE_COLUMNS: ReadonlyArray<{ key: keyof NodeInfo; label: string }> = [
  { key: 'id', label: 'id' },
  { key: 'kind', label: 'kind' },
  { key: 'online', label: 'online' },
  { key: 'version', label: 'version' },
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

/** 升级检查人类输出：当前/最新版本、是否有更新、被隔离版本。 */
function printUpgradeCheck(io: Io, nodeId: string, check: NodeUpgradeCheckResult): void {
  const lines = [
    `节点 ${nodeId}：当前 ${check.currentVersion}，最新 ${check.latestVersion}`,
    check.updateAvailable ? '有可用更新' : '已是最新',
  ]
  if (check.blocked !== undefined) {
    lines.push(`被隔离版本 ${check.blocked.version}（${check.blocked.reason}，${check.blocked.at}）`)
  }
  printText(io, lines.join('\n'))
}

/**
 * 升级结果人类输出。诚实性纪律：ok=false 由命令层抛 CliError（退出 1），
 * 此函数不再触及；unconfirmed 时 Hub 502 会以错误退出。
 */
function printUpgradeResult(io: Io, nodeId: string, result: NodeUpgradeResult): void {
  if (!result.upgraded) {
    printText(io, `节点 ${nodeId} 无需升级（当前 ${result.previousVersion}，目标 ${result.targetVersion}）`)
    return
  }
  printText(io, [
    `节点 ${nodeId} 已升级：${result.previousVersion} -> ${result.targetVersion}`,
    ...(result.pid !== undefined ? [`新守护进程 pid ${result.pid}`] : []),
  ].join('\n'))
}

/** 校验升级检查响应形状（诚实性：非法响应显式报错，不猜测）。 */
function requireUpgradeCheckResult(nodeId: string, value: unknown): NodeUpgradeCheckResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('Hub 升级检查响应需为对象', 'invalid_response')
  }
  const v = value as Record<string, unknown>
  if (
    typeof v['currentVersion'] !== 'string' ||
    typeof v['latestVersion'] !== 'string' ||
    typeof v['updateAvailable'] !== 'boolean'
  ) {
    throw new CliError('Hub 升级检查响应缺字段（currentVersion/latestVersion/updateAvailable）', 'invalid_response')
  }
  const blocked = v['blocked']
  if (
    blocked !== undefined &&
    (blocked === null || typeof blocked !== 'object' || Array.isArray(blocked) ||
      typeof (blocked as Record<string, unknown>)['version'] !== 'string' ||
      typeof (blocked as Record<string, unknown>)['reason'] !== 'string' ||
      typeof (blocked as Record<string, unknown>)['at'] !== 'string')
  ) {
    throw new CliError(`节点 ${nodeId} 升级检查 blocked 字段非法`, 'invalid_response')
  }
  return value as NodeUpgradeCheckResult
}

/** 校验升级结果响应形状。 */
function requireUpgradeResult(value: unknown): NodeUpgradeResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('Hub 升级响应需为对象', 'invalid_response')
  }
  const v = value as Record<string, unknown>
  if (
    typeof v['ok'] !== 'boolean' ||
    typeof v['previousVersion'] !== 'string' ||
    typeof v['targetVersion'] !== 'string' ||
    typeof v['upgraded'] !== 'boolean'
  ) {
    throw new CliError('Hub 升级响应缺字段（ok/previousVersion/targetVersion/upgraded）', 'invalid_response')
  }
  if (v['pid'] !== undefined && (typeof v['pid'] !== 'number' || !Number.isInteger(v['pid']) || (v['pid'] as number) <= 0)) {
    throw new CliError('Hub 升级响应 pid 非法', 'invalid_response')
  }
  return value as NodeUpgradeResult
}

/** nodes upgrade flag 表。 */
const UPGRADE_FLAGS: readonly FlagSpec[] = [
  { name: 'check', type: 'boolean', help: '仅检查可用更新（与 --version/--force 互斥）' },
  { name: 'version', type: 'string', help: '目标版本（严格 SemVer，可带 v 前缀；缺省升级到 latest）' },
  { name: 'registry', type: 'string', help: 'npm Registry URL（http/https）' },
  { name: 'force', type: 'boolean', help: '强制升级（忽略金丝雀隔离；与 --check 互斥）' },
  { name: 'current', type: 'boolean', help: '读 HELM_NODE_ID 作为目标节点' },
]

/** 解析节点目标：显式位置 nodeId 或 --current（读 HELM_NODE_ID）；互斥。 */
function resolveNodeTarget(flags: Map<string, unknown>, positionalId: string | undefined, env: NodeJS.ProcessEnv): string {
  const current = flags.get('current') === true
  if (positionalId !== undefined && current) {
    throw new CliError('nodeId 与 --current 互斥（二选一）', 'invalid_flag_value')
  }
  if (positionalId !== undefined) {
    if (positionalId.trim() === '') throw new CliError('nodeId 需为非空节点 ID', 'invalid_id')
    return positionalId
  }
  if (current) {
    const raw = env['HELM_NODE_ID']
    if (!raw || !raw.trim()) {
      throw new CliError('--current 需要 env HELM_NODE_ID（当前未设置）', 'current_node_missing')
    }
    return raw.trim()
  }
  throw new CliError('缺少节点目标：提供显式 <nodeId> 或 --current（读 HELM_NODE_ID）', 'missing_node_target')
}

/** nodes forward 的 host:port 端点解析：[host:]port；host 缺省 127.0.0.1（仅目标端可缺省）。 */
function parseEndpoint(raw: string, what: string, allowBarePort: boolean): { host?: string; port: number } {
  const trimmed = raw.trim()
  if (trimmed === '') throw new CliError(`${what} 需为 host:port 形式（如 127.0.0.1:8080）`, 'invalid_flag_value')
  // IPv6 文本形式：[::1]:port 或裸 ::1（含多个冒号时仅接受括号形式）。
  const bracket = trimmed.match(/^\[(.+)\]:(\d+)$/)
  if (bracket) {
    const port = Number(bracket[2])
    if (port < 1 || port > 65535) throw new CliError(`${what} 端口需为 1..65535`, 'invalid_flag_value')
    return { host: bracket[1]!, port }
  }
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon === -1) {
    if (!allowBarePort) throw new CliError(`${what} 需为 host:port 形式（如 127.0.0.1:8080）`, 'invalid_flag_value')
    if (!/^\d+$/.test(trimmed)) throw new CliError(`${what} 需为端口数字或 host:port`, 'invalid_flag_value')
    const port = Number(trimmed)
    if (port < 1 || port > 65535) throw new CliError(`${what} 端口需为 1..65535`, 'invalid_flag_value')
    return { port }
  }
  const host = trimmed.slice(0, lastColon)
  const portText = trimmed.slice(lastColon + 1)
  if (host === '' || portText === '' || !/^\d+$/.test(portText)) {
    throw new CliError(`${what} 需为 host:port 形式（如 127.0.0.1:8080；IPv6 用 [::1]:8080）`, 'invalid_flag_value')
  }
  const port = Number(portText)
  if (port < 1 || port > 65535) throw new CliError(`${what} 端口需为 1..65535`, 'invalid_flag_value')
  return { host, port }
}

export function nodesCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['nodes', 'list'],
    description: '列出计算节点、在线状态与版本（GET /api/nodes）',
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

  cmds.push({
    path: ['nodes', 'upgrade'],
    description: '检查或执行节点升级（GET/POST /api/nodes/:id/upgrade）',
    flags: [...UPGRADE_FLAGS],
    positional: '[<nodeId>]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(UPGRADE_FLAGS, ctx.args)
      assertNoExtraPositionals(parsed.positionals, 1)
      const nodeId = resolveNodeTarget(parsed.flags, parsed.positionals[0], ctx.env)
      const check = parsed.flags.get('check') === true
      const version = flagValue<string>(parsed.flags, 'version')
      const registry = flagValue<string>(parsed.flags, 'registry')
      const force = parsed.flags.get('force') === true
      // 互斥：--check 是只读检查，不能与升级执行参数组合。
      if (check && version !== undefined) {
        throw new CliError('--check 与 --version 互斥（检查不指定目标版本）', 'invalid_flag_value')
      }
      if (check && force) {
        throw new CliError('--check 与 --force 互斥（检查不执行升级）', 'invalid_flag_value')
      }
      const registryUrl = registry !== undefined ? registry : undefined
      const hub = await ctx.hub()
      if (check) {
        const query = registryUrl !== undefined ? `?registryUrl=${encodeURIComponent(registryUrl)}` : ''
        const result = await hub.get<NodeUpgradeCheckResult>(`/api/nodes/${encodeURIComponent(nodeId)}/upgrade/check${query}`)
        const checked = requireUpgradeCheckResult(nodeId, result)
        if (ctx.json) printResult(ctx, checked)
        else printUpgradeCheck(ctx.io, nodeId, checked)
        return
      }
      const body: Record<string, unknown> = {}
      if (version !== undefined) {
        if (version.trim() === '') throw new CliError('--version 需为非空版本（留空表示升级到 latest）', 'invalid_flag_value')
        body['targetVersion'] = version
      }
      if (registryUrl !== undefined) body['registryUrl'] = registryUrl
      if (force) body['force'] = true
      // 升级含排空在途命令与守护进程替换，禁用客户端默认 30s 超时。
      const result = await hub.request<NodeUpgradeResult>('POST', `/api/nodes/${encodeURIComponent(nodeId)}/upgrade`, {
        ...(Object.keys(body).length > 0 ? { body } : {}),
        timeoutMs: 0,
      })
      const upgraded = requireUpgradeResult(result)
      if (!upgraded.ok) {
        // 诚实性纪律：HTTP 200 但 ok:false（节点拒绝且如实返回）是失败——
        // 以错误退出 1，绝不打印未完成结果还返 code 0。
        throw new CliError(
          `节点 ${nodeId} 升级未完成（${upgraded.previousVersion} -> ${upgraded.targetVersion}）`,
          'node_upgrade_failed',
        )
      }
      if (ctx.json) printResult(ctx, upgraded)
      else printUpgradeResult(ctx.io, nodeId, upgraded)
    },
  })

  cmds.push({
    path: ['nodes', 'forward'],
    description: '本地 TCP 端口转发（POST /api/nodes/:id/forward；Ctrl-C 退出并关闭）',
    positional: '<nodeId> <listenHost:listenPort> [<targetHost>:]<targetPort>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const nodeId = requirePositional(parsed.positionals, 0, 'nodeId')
      const listenRaw = requirePositional(parsed.positionals, 1, 'listenHost:listenPort')
      const targetRaw = requirePositional(parsed.positionals, 2, '[targetHost:]targetPort')
      assertNoExtraPositionals(parsed.positionals, 3)
      if (nodeId.trim() === '' || /[\/\s]/.test(nodeId)) throw new CliError('nodeId 需为非空节点 ID', 'invalid_id')
      const listen = parseEndpoint(listenRaw, '<listenHost:listenPort>', false)
      if (listen.host === undefined) throw new CliError('监听地址必须显式携带 host（如 127.0.0.1:8080）', 'invalid_flag_value')
      const target = parseEndpoint(targetRaw, '<[targetHost:]targetPort>', true)
      const hub = await ctx.hub()
      // 创建转发（监听器只在本次命令期间存在）。
      const created = await hub.post<{ forwardId: string; listenHost: string; listenPort: number }>(
        `/api/nodes/${encodeURIComponent(nodeId)}/forward`,
        {
          listenHost: listen.host,
          listenPort: listen.port,
          targetPort: target.port,
          ...(target.host === undefined ? {} : { targetHost: target.host }),
        },
      )
      if (created === null || typeof created !== 'object' || typeof created.forwardId !== 'string') {
        throw new CliError('Hub 转发创建响应缺少 forwardId', 'invalid_response')
      }
      const forwardId = created.forwardId
      const stopForward = async (): Promise<void> => {
        await hub.delete(`/api/nodes/forward/${encodeURIComponent(forwardId)}`).catch(() => undefined)
      }
      // 前台：信号退出时显式停止转发（监听器/隧道同步销毁）。
      let stopping = false
      let hubStopped = false
      const onSignal = (): void => {
        if (stopping) return
        stopping = true
        process.removeListener('SIGINT', onSignal)
        process.removeListener('SIGTERM', onSignal)
        void stopForward().finally(() => process.exit(0))
      }
      process.on('SIGINT', onSignal)
      process.on('SIGTERM', onSignal)
      if (!ctx.json) {
        printText(ctx.io, [
          `转发已建立：${created.listenHost}:${created.listenPort} -> ${nodeId} ${target.host ?? '127.0.0.1'}:${target.port}`,
          'Ctrl-C 退出并关闭转发。',
        ].join('\n'))
      }
      try {
        // NDJSON 事件流：前台阻塞；断开（Hub 重启/网络断）时退出。
        await hub.streamNdjson('GET', `/api/nodes/forward/${encodeURIComponent(forwardId)}/events`, {
          onLine: (value: unknown) => {
            if (ctx.json) {
              ctx.io.out(`${JSON.stringify(value)}\n`)
              return
            }
            const event = value as { type?: string; count?: number; message?: string }
            if (event?.type === 'connection') {
              printText(ctx.io, `连接建立（活动 ${event.count ?? 0}）`)
            } else if (event?.type === 'error') {
              printText(ctx.io, `转发错误：${event.message ?? '未知'}`)
            } else if (event?.type === 'stopped') {
              hubStopped = true
              if (!ctx.json) printText(ctx.io, 'Hub 侧转发已停止')
            }
          },
        })
      } finally {
        await stopForward()
      }
      if (stopping || hubStopped) return
      // 事件流意外结束（Hub 侧已停止）：如实退出非零。
      throw new CliError('转发事件流已结束（Hub 侧转发可能已停止）', 'forward_stream_ended')
    },
  })

  return cmds
}
