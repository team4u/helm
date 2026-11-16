/**
 * compute node manage domain (Hub side):nodes list / issue / remove / upgrade.
 * pure manage side API, and `helm-node`(subject to control machine daemon) responsibility separate.
 */
import { CliError } from '../errors.js'
import type {
  NodeForwardSession,
  NodeInfo,
  NodeIssuedToken,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
} from '@helm/protocol'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { Io } from '../options.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, parseNoFlags, printResult, requirePositional } from './shared.js'
import { printText } from '../output.js'

/** nodes list person class pattern fixed column (original field may more many, only render key six column). */
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

/** issue sign result person class pattern:token plaintext only this once, sudden out render. */
function printIssuedToken(io: Io, issued: NodeIssuedToken): void {
  printText(io, [
    `node ${issued.nodeId} access token (only this once render, server side only store summary):`,
    '',
    `  ${issued.token}`,
    '',
    'subject to control machine execute:helm-node connect <hubUrl> --token <token>',
  ].join('\n'))
}

/** upgrade check person class output: when before/most new version, is otherwise has update, by isolated version. */
function printUpgradeCheck(io: Io, nodeId: string, check: NodeUpgradeCheckResult): void {
  const lines = [
    `node ${nodeId}: when before ${check.currentVersion}, most new ${check.latestVersion}`,
    check.updateAvailable ? 'has available update' : 'already is most new',
  ]
  if (check.blocked !== undefined) {
    lines.push(`by isolated version ${check.blocked.version}(${check.blocked.reason},${check.blocked.at})`)
  }
  printText(io, lines.join('\n'))
}

/**
 * upgrade result person class output. honest discipline:ok=false by command layer throw CliError(exit 1),
 * this function no longer trigger and;unconfirmed when Hub 502 will with error exit.
 */
function printUpgradeResult(io: Io, nodeId: string, result: NodeUpgradeResult): void {
  if (!result.upgraded) {
    printText(io, `node ${nodeId} no need to upgrade (when before ${result.previousVersion}, target ${result.targetVersion})`)
    return
  }
  printText(io, [
    `node ${nodeId} already upgrade:${result.previousVersion} -> ${result.targetVersion}`,
    ...(result.pid !== undefined ? [`new daemon pid ${result.pid}`] : []),
  ].join('\n'))
}

/** validate upgrade check response shape (honest: illegal response explicit errors, do not guess). */
function requireUpgradeCheckResult(nodeId: string, value: unknown): NodeUpgradeCheckResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('Hub upgrade check response must be an object', 'invalid_response')
  }
  const v = value as Record<string, unknown>
  if (
    typeof v['currentVersion'] !== 'string' ||
    typeof v['latestVersion'] !== 'string' ||
    typeof v['updateAvailable'] !== 'boolean'
  ) {
    throw new CliError('Hub upgrade check response missing field (currentVersion/latestVersion/updateAvailable)', 'invalid_response')
  }
  const blocked = v['blocked']
  if (
    blocked !== undefined &&
    (blocked === null || typeof blocked !== 'object' || Array.isArray(blocked) ||
      typeof (blocked as Record<string, unknown>)['version'] !== 'string' ||
      typeof (blocked as Record<string, unknown>)['reason'] !== 'string' ||
      typeof (blocked as Record<string, unknown>)['at'] !== 'string')
  ) {
    throw new CliError(`node ${nodeId} upgrade check blocked field illegal`, 'invalid_response')
  }
  return value as NodeUpgradeCheckResult
}

/** validate upgrade result response shape. */
function requireUpgradeResult(value: unknown): NodeUpgradeResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('Hub upgrade response must be an object', 'invalid_response')
  }
  const v = value as Record<string, unknown>
  if (
    typeof v['ok'] !== 'boolean' ||
    typeof v['previousVersion'] !== 'string' ||
    typeof v['targetVersion'] !== 'string' ||
    typeof v['upgraded'] !== 'boolean'
  ) {
    throw new CliError('Hub upgrade response missing field (ok/previousVersion/targetVersion/upgraded)', 'invalid_response')
  }
  if (v['pid'] !== undefined && (typeof v['pid'] !== 'number' || !Number.isInteger(v['pid']) || (v['pid'] as number) <= 0)) {
    throw new CliError('Hub upgrade response pid illegal', 'invalid_response')
  }
  return value as NodeUpgradeResult
}

/** nodes upgrade flag table. */
const UPGRADE_FLAGS: readonly FlagSpec[] = [
  { name: 'check', type: 'boolean', help: 'only check available update (and --version/--force mutual exclusion)' },
  { name: 'version', type: 'string', help: 'target version (strictly SemVer, can carries v prefix; default upgrade to latest)' },
  { name: 'registry', type: 'string', help: 'npm Registry URL(http/https)' },
  { name: 'force', type: 'boolean', help: 'force upgrade (ignore canary isolated; and --check mutual exclusion)' },
  { name: 'current', type: 'boolean', help: 'read HELM_NODE_ID as target node' },
]

/** parse node target: explicit location nodeId or --current(read HELM_NODE_ID); mutual exclusion. */
function resolveNodeTarget(flags: Map<string, unknown>, positionalId: string | undefined, env: NodeJS.ProcessEnv): string {
  const current = flags.get('current') === true
  if (positionalId !== undefined && current) {
    throw new CliError('nodeId and --current mutual exclusion (two choose one)', 'invalid_flag_value')
  }
  if (positionalId !== undefined) {
    if (positionalId.trim() === '') throw new CliError('nodeId must be non-empty node ID', 'invalid_id')
    return positionalId
  }
  if (current) {
    const raw = env['HELM_NODE_ID']
    if (!raw || !raw.trim()) {
      throw new CliError('--current need to env HELM_NODE_ID(when before not settings)', 'current_node_missing')
    }
    return raw.trim()
  }
  throw new CliError('missing node target: provide explicit <nodeId> or --current(read HELM_NODE_ID)', 'missing_node_target')
}

/** nodes forward  host:port end point parse:[host:]port;host default 127.0.0.1(only target end can default). */
function parseEndpoint(raw: string, what: string, allowBarePort: boolean): { host?: string; port: number } {
  const trimmed = raw.trim()
  if (trimmed === '') throw new CliError(`${what} must be host:port form (such as 127.0.0.1:8080)`, 'invalid_flag_value')
  // IPv6 text form:[::1]:port or bare ::1(contains multiple smoke number when only accept parentheses form).
  const bracket = trimmed.match(/^\[(.+)\]:(\d+)$/)
  if (bracket) {
    const port = Number(bracket[2])
    if (port < 1 || port > 65535) throw new CliError(`${what} port must be 1..65535`, 'invalid_flag_value')
    return { host: bracket[1]!, port }
  }
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon === -1) {
    if (!allowBarePort) throw new CliError(`${what} must be host:port form (such as 127.0.0.1:8080)`, 'invalid_flag_value')
    if (!/^\d+$/.test(trimmed)) throw new CliError(`${what} must be port number or host:port`, 'invalid_flag_value')
    const port = Number(trimmed)
    if (port < 1 || port > 65535) throw new CliError(`${what} port must be 1..65535`, 'invalid_flag_value')
    return { port }
  }
  const host = trimmed.slice(0, lastColon)
  const portText = trimmed.slice(lastColon + 1)
  if (host === '' || portText === '' || !/^\d+$/.test(portText)) {
    throw new CliError(`${what} must be host:port form (such as 127.0.0.1:8080;IPv6 use [::1]:8080)`, 'invalid_flag_value')
  }
  const port = Number(portText)
  if (port < 1 || port > 65535) throw new CliError(`${what} port must be 1..65535`, 'invalid_flag_value')
  return { host, port }
}

/** validate Hub return forwarding conversation shape (honest: illegal response explicit errors). */
function requireNodeForwardSession(value: unknown, what: string): NodeForwardSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`${what} must be an object`, 'invalid_response')
  }
  const v = value as Record<string, unknown>
  if (
    typeof v['forwardId'] !== 'string' ||
    typeof v['nodeId'] !== 'string' ||
    typeof v['listenHost'] !== 'string' ||
    typeof v['listenPort'] !== 'number' ||
    typeof v['targetHost'] !== 'string' ||
    typeof v['targetPort'] !== 'number' ||
    typeof v['activeConnections'] !== 'number' ||
    typeof v['totalConnections'] !== 'number'
  ) {
    throw new CliError(`${what} missing field or field illegal (forwardId/nodeId/listen*/target*/activeConnections/totalConnections)`, 'invalid_response')
  }
  return value as NodeForwardSession
}

/** nodes forwards person class pattern fixed column. */
const FORWARD_COLUMNS: ReadonlyArray<{ key: keyof NodeForwardSession; label: string }> = [
  { key: 'forwardId', label: 'forwardId' },
  { key: 'nodeId', label: 'node' },
  { key: 'listenHost', label: 'listen' },
  { key: 'listenPort', label: 'port' },
  { key: 'targetHost', label: 'target' },
  { key: 'targetPort', label: 'port' },
  { key: 'activeConnections', label: 'active' },
]

function printForwardsTable(io: Io, forwards: NodeForwardSession[]): void {
  if (forwards.length === 0) {
    io.out('(empty)\n')
    return
  }
  const rows = forwards.map((f) => FORWARD_COLUMNS.map(({ key }) => {
    const value = f[key]
    return value === undefined ? '' : String(value)
  }))
  const widths = FORWARD_COLUMNS.map(({ label }, i) => Math.max(label.length, ...rows.map((r) => r[i]!.length)))
  io.out(FORWARD_COLUMNS.map(({ label }, i) => label.padEnd(widths[i]!)).join('  ') + '\n')
  io.out(widths.map((w) => '-'.repeat(w)).join('  ') + '\n')
  for (const row of rows) {
    io.out(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ') + '\n')
  }
}

function printForwardDetail(io: Io, forward: NodeForwardSession): void {
  const lines = [
    `forwarding ${forward.forwardId}`,
    `listen ${forward.listenHost}:${forward.listenPort} -> node ${forward.nodeId} ${forward.targetHost}:${forward.targetPort}`,
    `activity connect ${forward.activeConnections}(cumulative ${forward.totalConnections})`,
  ]
  if (forward.lastError !== undefined) lines.push(`most near error ${forward.lastError}`)
  printText(io, lines.join('\n'))
}

export function nodesCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['nodes', 'list'],
    description: 'column out compute node, online state and version (GET /api/nodes)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const nodes = await hub.get<NodeInfo[]>('/api/nodes')
      if (!Array.isArray(nodes)) throw new CliError('Hub node list must be array', 'invalid_response')
      if (ctx.json) {
        printResult(ctx, nodes)
        return
      }
      printNodesTable(ctx.io, nodes)
    },
  })

  cmds.push({
    path: ['nodes', 'issue'],
    description: 'sign node access token (POST /api/nodes/issue; plaintext token only return once)',
    positional: '<nodeId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const nodeId = requirePositional(parsed.positionals, 0, 'nodeId')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      const issued = await hub.post<NodeIssuedToken>('/api/nodes/issue', { nodeId })
      if (!issued || typeof issued !== 'object' || issued.nodeId !== nodeId || typeof issued.token !== 'string' || !issued.token.startsWith(`${nodeId}:`)) {
        throw new CliError('Hub sign response missing valid node token', 'invalid_response')
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
    description: 'remove subject to control node and immediately disconnect connect (DELETE /api/nodes/:id)',
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
    description: 'check or execute node upgrade (GET/POST /api/nodes/:id/upgrade)',
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
      // mutual exclusion:--check is only read check, cannot and upgrade execute parameter combine.
      if (check && version !== undefined) {
        throw new CliError('--check and --version mutual exclusion (check do not designate target version)', 'invalid_flag_value')
      }
      if (check && force) {
        throw new CliError('--check and --force mutual exclusion (check do not execute upgrade)', 'invalid_flag_value')
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
        if (version.trim() === '') throw new CliError('--version must be non-empty version (empty means upgrade to latest)', 'invalid_flag_value')
        body['targetVersion'] = version
      }
      if (registryUrl !== undefined) body['registryUrl'] = registryUrl
      if (force) body['force'] = true
      // upgrade contains arrange empty in-flight command and daemon replace, disable client by default 30s timeout.
      const result = await hub.request<NodeUpgradeResult>('POST', `/api/nodes/${encodeURIComponent(nodeId)}/upgrade`, {
        ...(Object.keys(body).length > 0 ? { body } : {}),
        timeoutMs: 0,
      })
      const upgraded = requireUpgradeResult(result)
      if (!upgraded.ok) {
        // honest discipline:HTTP 200 but ok:false(node reject and such as return) is failed - -
        // with error exit 1, never print not complete result also return code 0.
        throw new CliError(
          `node ${nodeId} upgrade not complete (${upgraded.previousVersion} -> ${upgraded.targetVersion})`,
          'node_upgrade_failed',
        )
      }
      if (ctx.json) printResult(ctx, upgraded)
      else printUpgradeResult(ctx.io, nodeId, upgraded)
    },
  })

  cmds.push({
    path: ['nodes', 'forward'],
    description: 'foreground local TCP port forwarding (POST /api/nodes/:id/forward;Ctrl-C exit and close)',
    flags: [
      { name: 'current', type: 'boolean', help: 'read HELM_NODE_ID as target node' },
    ],
    positional: '[<nodeId>] <listenHost:listenPort> [<targetHost>:]<targetPort>',
    async run(ctx: CommandContext) {
      const FORWARD_FLAGS: readonly FlagSpec[] = [
        { name: 'current', type: 'boolean', help: 'read HELM_NODE_ID as target node' },
      ]
      const parsed = parseFlags(FORWARD_FLAGS, ctx.args)
      // location parameter form:[<nodeId>] <listenHost:listenPort> [<targetHost>:]<targetPort>.
      // nodeId optional: first reference contains ':' i.e. is listen address (nodeId from --current parse).
      let nodeId: string
      let listenIndex = 0
      const first = parsed.positionals[0]
      if (first !== undefined && !first.includes(':')) {
        const current = parsed.flags.get('current') === true
        if (current) throw new CliError('nodeId and --current mutual exclusion (two choose one)', 'invalid_flag_value')
        if (first.trim() === '') throw new CliError('nodeId must be non-empty node ID', 'invalid_id')
        nodeId = first
        listenIndex = 1
      } else {
        const current = parsed.flags.get('current') === true
        if (!current) throw new CliError('missing node target: provide explicit <nodeId> or --current(read HELM_NODE_ID)', 'missing_node_target')
        const raw = ctx.env['HELM_NODE_ID']
        if (!raw || !raw.trim()) {
          throw new CliError('--current need to env HELM_NODE_ID(when before not settings)', 'current_node_missing')
        }
        nodeId = raw.trim()
      }
      const listenRaw = requirePositional(parsed.positionals, listenIndex, 'listenHost:listenPort')
      const targetRaw = requirePositional(parsed.positionals, listenIndex + 1, '[targetHost:]targetPort')
      assertNoExtraPositionals(parsed.positionals, listenIndex + 2)
      const listen = parseEndpoint(listenRaw, '<listenHost:listenPort>', false)
      if (listen.host === undefined) throw new CliError('listen address must explicit carry host(such as 127.0.0.1:8080)', 'invalid_flag_value')
      const target = parseEndpoint(targetRaw, '<[targetHost:]targetPort>', true)
      const hub = await ctx.hub()
      // create forwarding (listener only in this time command during store in; not and when bind set event stream when Hub side
      // foreground lease automatically stop).
      const created = await hub.post<NodeForwardSession>(
        `/api/nodes/${encodeURIComponent(nodeId)}/forward`,
        {
          listenHost: listen.host,
          listenPort: listen.port,
          targetPort: target.port,
          ...(target.host === undefined ? {} : { targetHost: target.host }),
        },
      )
      const forward = requireNodeForwardSession(created, 'Hub forwarding create response')
      const forwardId = forward.forwardId

      // explicit stop: only contain tolerate already missing (404); other error such as on throw (do not fake report clean up succeeded).
      const stopForward = async (): Promise<void> => {
        await hub
          .delete(`/api/nodes/forward/${encodeURIComponent(forwardId)}`)
          .catch((error: unknown) => {
            if (error instanceof CliError && error.code === 'not_found') return
            throw error
          })
      }

      // foreground signal: mark record cancel and interrupt event stream (command Promise self however away finally clean up after
      // normal exit, do not in signal call back in process.exit- - store inside exit to runCli caller).
      const stopController = new AbortController()
      let stopping = false
      let cleanupError: unknown
      const onSignal = (): void => {
        if (stopping) return
        stopping = true
        stopController.abort()
      }
      process.once('SIGINT', onSignal)
      process.once('SIGTERM', onSignal)

      let hubStopped = false
      if (!ctx.json) {
        printText(ctx.io, [
          `forwarding already establish:${forward.listenHost}:${forward.listenPort} -> ${nodeId} ${target.host ?? '127.0.0.1'}:${target.port}`,
          'Ctrl-C exit and close forwarding.',
        ].join('\n'))
      }
      try {
        // NDJSON event stream (i.e. foreground lease holder): foreground block; disconnect (Hub stop/network assert
        // /signal) when end. regardless of --json and otherwise all identify terminal state.signal must pass-through to stream request.
        await hub.streamNdjson(
          'GET',
          `/api/nodes/forward/${encodeURIComponent(forwardId)}/events`,
          {
            signal: stopController.signal,
            onLine: (value: unknown) => {
              const event = value as { type?: string; count?: number; message?: string }
              if (event?.type === 'connection') {
                if (ctx.json) ctx.io.out(`${JSON.stringify(value)}\n`)
                else printText(ctx.io, `connect establish (activity ${event.count ?? 0})`)
              } else if (event?.type === 'error') {
                if (ctx.json) ctx.io.out(`${JSON.stringify(value)}\n`)
                else printText(ctx.io, `forwarding error:${event.message ?? 'unknown'}`)
              } else if (event?.type === 'stopped') {
                hubStopped = true
                if (ctx.json) ctx.io.out(`${JSON.stringify(value)}\n`)
                else printText(ctx.io, 'Hub side forwarding already stop')
              }
            },
          },
        )
      } catch (error) {
        // signal interrupt stream read is not unexpected failed (away finally clean up after normal exit).
        if (!(stopping && error instanceof CliError && error.code === 'aborted')) throw error
      } finally {
        process.removeListener('SIGINT', onSignal)
        process.removeListener('SIGTERM', onSignal)
        try {
          await stopForward()
        } catch (error) {
          // clean up failed must not fake report succeeded: record after in happy path outside explicit errors.
          cleanupError = error
        }
      }
      if (cleanupError !== undefined) {
        throw new CliError(
          `forwarding already end but stop clean up failed:${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          'forward_cleanup_failed',
        )
      }
      if (stopping || hubStopped) return
      // event stream unexpected end and not received terminal state (network assert/Hub crash): such as exit non-zero.
      throw new CliError('forwarding event stream already end (Hub side forwarding may already stop)', 'forward_stream_ended')
    },
  })

  cmds.push({
    path: ['nodes', 'forwards'],
    description: 'column out activity port forwarding (GET /api/nodes/forward)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const forwards = await hub.get<NodeForwardSession[]>('/api/nodes/forward')
      if (!Array.isArray(forwards)) throw new CliError('Hub forwarding list must be array', 'invalid_response')
      const checked = forwards.map((f) => requireNodeForwardSession(f, 'Hub forwarding list items'))
      if (ctx.json) {
        printResult(ctx, checked)
        return
      }
      printForwardsTable(ctx.io, checked)
    },
  })

  cmds.push({
    path: ['nodes', 'forward-inspect'],
    description: 'view forwarding detail situation (GET /api/nodes/forward/:forwardId)',
    positional: '<forwardId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const forwardId = requirePositional(parsed.positionals, 0, 'forwardId')
      assertNoExtraPositionals(parsed.positionals, 1)
      if (!/^fwd-[0-9a-f-]{36}$/.test(forwardId)) {
        throw new CliError('forwardId must be fwd-<uuid> form', 'invalid_id')
      }
      const hub = await ctx.hub()
      const detail = await hub.get<NodeForwardSession>(`/api/nodes/forward/${encodeURIComponent(forwardId)}`)
      const checked = requireNodeForwardSession(detail, 'Hub forwarding detail situation')
      if (ctx.json) {
        printResult(ctx, checked)
        return
      }
      printForwardDetail(ctx.io, checked)
    },
  })

  cmds.push({
    path: ['nodes', 'forward-stop'],
    description: 'stop port forwarding (DELETE /api/nodes/forward/:forwardId)',
    positional: '<forwardId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const forwardId = requirePositional(parsed.positionals, 0, 'forwardId')
      assertNoExtraPositionals(parsed.positionals, 1)
      if (!/^fwd-[0-9a-f-]{36}$/.test(forwardId)) {
        throw new CliError('forwardId must be fwd-<uuid> form', 'invalid_id')
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.delete<{ ok: boolean }>(`/api/nodes/forward/${encodeURIComponent(forwardId)}`))
    },
  })

  return cmds
}
