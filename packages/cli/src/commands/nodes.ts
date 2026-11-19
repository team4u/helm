/**
 * Compute node management commands (Hub side): nodes list / issue / remove / upgrade.
 * Pure control-plane API, separate from `helmx-node` (the managed machine daemon).
 */
import { CliError } from '../errors.js'
import type {
  NodeForwardSession,
  NodeInfo,
  NodeIssuedToken,
  NodeUpgradeCheckResult,
  NodeUpgradeResult,
} from '@helmx/protocol'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { Io } from '../options.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { assertNoExtraPositionals, parseNoFlags, printResult, requirePositional } from './shared.js'
import { printText } from '../output.js'

/** Fixed columns for nodes list in human mode (raw records may have more fields; show only 6 key columns). */
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

/** Human output for nodes issue: plaintext token is shown once, so highlight it prominently. */
function printIssuedToken(io: Io, issued: NodeIssuedToken): void {
  printText(io, [
    `Access token for node ${issued.nodeId} (shown once; server only stores its digest):`,
    '',
    `  ${issued.token}`,
    '',
    'Run on the managed machine: helmx-node connect <hubUrl> --token <token>',
  ].join('\n'))
}

/** Human output for upgrade check: current/latest versions, update availability, and quarantined version. */
function printUpgradeCheck(io: Io, nodeId: string, check: NodeUpgradeCheckResult): void {
  const lines = [
    `Node ${nodeId}: current ${check.currentVersion}, latest ${check.latestVersion}`,
    check.updateAvailable ? 'Update available' : 'Up to date',
  ]
  if (check.blocked !== undefined) {
    lines.push(`Quarantined version ${check.blocked.version} (${check.blocked.reason}, ${check.blocked.at})`)
  }
  printText(io, lines.join('\n'))
}

/**
 * Human output for upgrade result. Honesty rule: ok=false throws CliError (exit 1)
 * in the command handler and never reaches here; when unconfirmed, Hub 502 exits with an error.
 */
function printUpgradeResult(io: Io, nodeId: string, result: NodeUpgradeResult): void {
  if (!result.upgraded) {
    printText(io, `Node ${nodeId} does not need an upgrade (current ${result.previousVersion}, target ${result.targetVersion})`)
    return
  }
  printText(io, [
    `Node ${nodeId} upgraded: ${result.previousVersion} -> ${result.targetVersion}`,
    ...(result.pid !== undefined ? [`New daemon pid ${result.pid}`] : []),
  ].join('\n'))
}

/** Validate upgrade check response shape (honesty rule: reject invalid responses explicitly without guessing). */
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
    throw new CliError('Hub upgrade check response is missing fields (currentVersion/latestVersion/updateAvailable)', 'invalid_response')
  }
  const blocked = v['blocked']
  if (
    blocked !== undefined &&
    (blocked === null || typeof blocked !== 'object' || Array.isArray(blocked) ||
      typeof (blocked as Record<string, unknown>)['version'] !== 'string' ||
      typeof (blocked as Record<string, unknown>)['reason'] !== 'string' ||
      typeof (blocked as Record<string, unknown>)['at'] !== 'string')
  ) {
    throw new CliError(`node ${nodeId} upgrade check blocked field is invalid`, 'invalid_response')
  }
  return value as NodeUpgradeCheckResult
}

/** Validate upgrade result response shape. */
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
    throw new CliError('Hub upgrade response is missing fields (ok/previousVersion/targetVersion/upgraded)', 'invalid_response')
  }
  if (v['pid'] !== undefined && (typeof v['pid'] !== 'number' || !Number.isInteger(v['pid']) || (v['pid'] as number) <= 0)) {
    throw new CliError('Hub upgrade response has invalid pid', 'invalid_response')
  }
  return value as NodeUpgradeResult
}

/** Flag specs for nodes upgrade. */
const UPGRADE_FLAGS: readonly FlagSpec[] = [
  { name: 'check', type: 'boolean', help: 'check for available updates only (mutually exclusive with --version/--force)' },
  { name: 'version', type: 'string', help: 'target version (strict SemVer, optional v prefix; defaults to latest)' },
  { name: 'registry', type: 'string', help: 'npm registry URL (http/https)' },
  { name: 'force', type: 'boolean', help: 'force upgrade (ignore canary quarantine; mutually exclusive with --check)' },
  { name: 'current', type: 'boolean', help: 'read HELMX_NODE_ID as the target node' },
]

/** Resolve target node: explicit positional nodeId or --current (reads HELMX_NODE_ID); mutually exclusive. */
function resolveNodeTarget(flags: Map<string, unknown>, positionalId: string | undefined, env: NodeJS.ProcessEnv): string {
  const current = flags.get('current') === true
  if (positionalId !== undefined && current) {
    throw new CliError('nodeId and --current are mutually exclusive', 'invalid_flag_value')
  }
  if (positionalId !== undefined) {
    if (positionalId.trim() === '') throw new CliError('nodeId must be a non-empty node ID', 'invalid_id')
    return positionalId
  }
  if (current) {
    const raw = env['HELMX_NODE_ID']
    if (!raw || !raw.trim()) {
      throw new CliError('--current requires HELMX_NODE_ID to be set', 'current_node_missing')
    }
    return raw.trim()
  }
  throw new CliError('missing node target: provide <nodeId> or --current (reads HELMX_NODE_ID)', 'missing_node_target')
}

/** Parse host:port endpoint for nodes forward: [host:]port; host defaults to 127.0.0.1 (only allowed on target end). */
function parseEndpoint(raw: string, what: string, allowBarePort: boolean): { host?: string; port: number } {
  const trimmed = raw.trim()
  if (trimmed === '') throw new CliError(`${what} must be in host:port format (e.g. 127.0.0.1:8080)`, 'invalid_flag_value')
  // IPv6 literal syntax: [::1]:port (with multiple colons, only bracketed syntax is accepted).
  const bracket = trimmed.match(/^\[(.+)\]:(\d+)$/)
  if (bracket) {
    const port = Number(bracket[2])
    if (port < 1 || port > 65535) throw new CliError(`${what} port must be in 1..65535`, 'invalid_flag_value')
    return { host: bracket[1]!, port }
  }
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon === -1) {
    if (!allowBarePort) throw new CliError(`${what} must be in host:port format (e.g. 127.0.0.1:8080)`, 'invalid_flag_value')
    if (!/^\d+$/.test(trimmed)) throw new CliError(`${what} must be a port number or host:port`, 'invalid_flag_value')
    const port = Number(trimmed)
    if (port < 1 || port > 65535) throw new CliError(`${what} port must be in 1..65535`, 'invalid_flag_value')
    return { port }
  }
  const host = trimmed.slice(0, lastColon)
  const portText = trimmed.slice(lastColon + 1)
  if (host === '' || portText === '' || !/^\d+$/.test(portText)) {
    throw new CliError(`${what} must be in host:port format (e.g. 127.0.0.1:8080; use [::1]:8080 for IPv6)`, 'invalid_flag_value')
  }
  const port = Number(portText)
  if (port < 1 || port > 65535) throw new CliError(`${what} port must be in 1..65535`, 'invalid_flag_value')
  return { host, port }
}

/** Validate forward session shape returned by Hub (honesty rule: reject invalid responses explicitly). */
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
    throw new CliError(`${what} is missing or has invalid fields (forwardId/nodeId/listen*/target*/activeConnections/totalConnections)`, 'invalid_response')
  }
  return value as NodeForwardSession
}

/** Fixed columns for nodes forwards in human mode. */
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
    `Forward ${forward.forwardId}`,
    `Listening ${forward.listenHost}:${forward.listenPort} -> node ${forward.nodeId} ${forward.targetHost}:${forward.targetPort}`,
    `Active connections ${forward.activeConnections} (total ${forward.totalConnections})`,
  ]
  if (forward.lastError !== undefined) lines.push(`Last error ${forward.lastError}`)
  printText(io, lines.join('\n'))
}

export function nodesCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['nodes', 'list'],
    description: 'List compute nodes, online status, and versions (GET /api/nodes)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const nodes = await hub.get<NodeInfo[]>('/api/nodes')
      if (!Array.isArray(nodes)) throw new CliError('Hub node list must be an array', 'invalid_response')
      if (ctx.json) {
        printResult(ctx, nodes)
        return
      }
      printNodesTable(ctx.io, nodes)
    },
  })

  cmds.push({
    path: ['nodes', 'issue'],
    description: 'Issue a node access token (POST /api/nodes/issue; plaintext token returned once)',
    positional: '<nodeId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const nodeId = requirePositional(parsed.positionals, 0, 'nodeId')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      const issued = await hub.post<NodeIssuedToken>('/api/nodes/issue', { nodeId })
      if (!issued || typeof issued !== 'object' || issued.nodeId !== nodeId || typeof issued.token !== 'string' || !issued.token.startsWith(`${nodeId}:`)) {
        throw new CliError('Hub issue response is missing a valid node token', 'invalid_response')
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
    description: 'Remove a managed node and disconnect it immediately (DELETE /api/nodes/:id)',
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
    description: 'Check or execute a node upgrade (GET/POST /api/nodes/:id/upgrade)',
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
      // Mutual exclusion: --check is read-only and cannot be combined with upgrade execution flags.
      if (check && version !== undefined) {
        throw new CliError('--check and --version are mutually exclusive (cannot specify a target version when checking)', 'invalid_flag_value')
      }
      if (check && force) {
        throw new CliError('--check and --force are mutually exclusive (check does not execute an upgrade)', 'invalid_flag_value')
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
        if (version.trim() === '') throw new CliError('--version must be a non-empty version (omit to upgrade to latest)', 'invalid_flag_value')
        body['targetVersion'] = version
      }
      if (registryUrl !== undefined) body['registryUrl'] = registryUrl
      if (force) body['force'] = true
      // Upgrade drains in-flight commands and replaces the daemon; disable the default 30s client timeout.
      const result = await hub.request<NodeUpgradeResult>('POST', `/api/nodes/${encodeURIComponent(nodeId)}/upgrade`, {
        ...(Object.keys(body).length > 0 ? { body } : {}),
        timeoutMs: 0,
      })
      const upgraded = requireUpgradeResult(result)
      if (!upgraded.ok) {
        // Honesty rule: HTTP 200 with ok:false (explicitly rejected by node) is a failure —
        // exit 1 and never print an incomplete result as exit code 0.
        throw new CliError(
          `node ${nodeId} upgrade did not complete (${upgraded.previousVersion} -> ${upgraded.targetVersion})`,
          'node_upgrade_failed',
        )
      }
      if (ctx.json) printResult(ctx, upgraded)
      else printUpgradeResult(ctx.io, nodeId, upgraded)
    },
  })

  cmds.push({
    path: ['nodes', 'forward'],
    description: 'Foreground local TCP port forwarding (POST /api/nodes/:id/forward; press Ctrl-C to exit and close)',
    flags: [
      { name: 'current', type: 'boolean', help: 'read HELMX_NODE_ID as the target node' },
    ],
    positional: '[<nodeId>] <listenHost:listenPort> [<targetHost>:]<targetPort>',
    async run(ctx: CommandContext) {
      const FORWARD_FLAGS: readonly FlagSpec[] = [
        { name: 'current', type: 'boolean', help: 'read HELMX_NODE_ID as the target node' },
      ]
      const parsed = parseFlags(FORWARD_FLAGS, ctx.args)
      // Positional layout: [<nodeId>] <listenHost:listenPort> [<targetHost>:]<targetPort>.
      // nodeId is optional: if the first positional contains ':', it is the listen address (and nodeId resolves via --current).
      let nodeId: string
      let listenIndex = 0
      const first = parsed.positionals[0]
      if (first !== undefined && !first.includes(':')) {
        const current = parsed.flags.get('current') === true
        if (current) throw new CliError('nodeId and --current are mutually exclusive', 'invalid_flag_value')
        if (first.trim() === '') throw new CliError('nodeId must be a non-empty node ID', 'invalid_id')
        nodeId = first
        listenIndex = 1
      } else {
        const current = parsed.flags.get('current') === true
        if (!current) throw new CliError('missing node target: provide <nodeId> or --current (reads HELMX_NODE_ID)', 'missing_node_target')
        const raw = ctx.env['HELMX_NODE_ID']
        if (!raw || !raw.trim()) {
          throw new CliError('--current requires HELMX_NODE_ID to be set', 'current_node_missing')
        }
        nodeId = raw.trim()
      }
      const listenRaw = requirePositional(parsed.positionals, listenIndex, 'listenHost:listenPort')
      const targetRaw = requirePositional(parsed.positionals, listenIndex + 1, '[targetHost:]targetPort')
      assertNoExtraPositionals(parsed.positionals, listenIndex + 2)
      const listen = parseEndpoint(listenRaw, '<listenHost:listenPort>', false)
      if (listen.host === undefined) throw new CliError('listen address must include an explicit host (e.g. 127.0.0.1:8080)', 'invalid_flag_value')
      const target = parseEndpoint(targetRaw, '<[targetHost:]targetPort>', true)
      const hub = await ctx.hub()
      // Create the forwarder (listener lives only for the duration of this command; Hub foreground lease auto-stops if the event stream is never attached).
      const created = await hub.post<NodeForwardSession>(
        `/api/nodes/${encodeURIComponent(nodeId)}/forward`,
        {
          listenHost: listen.host,
          listenPort: listen.port,
          targetPort: target.port,
          ...(target.host === undefined ? {} : { targetHost: target.host }),
        },
      )
      const forward = requireNodeForwardSession(created, 'Hub forward create response')
      const forwardId = forward.forwardId

      // Explicit stop: only tolerate already-removed (404 / not_found); rethrow other errors instead of falsely reporting cleanup success.
      const stopForward = async (): Promise<void> => {
        await hub
          .delete(`/api/nodes/forward/${encodeURIComponent(forwardId)}`)
          .catch((error: unknown) => {
            if (error instanceof CliError && error.code === 'not_found') return
            throw error
          })
      }

      // Foreground signal handling: mark stopping and abort the event stream so the Promise finishes through finally cleanup cleanly
      // without calling process.exit inside a signal callback (the runCli caller owns process exit).
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
          `Forwarding established: ${forward.listenHost}:${forward.listenPort} -> ${nodeId} ${target.host ?? '127.0.0.1'}:${target.port}`,
          'Press Ctrl-C to exit and close forwarding.',
        ].join('\n'))
      }
      try {
        // NDJSON event stream (acts as foreground lease holder): blocks until disconnected (Hub stopped / network drop / signal).
        // Always recognize terminal states regardless of --json; forward signal to the streaming request.
        await hub.streamNdjson(
          'GET',
          `/api/nodes/forward/${encodeURIComponent(forwardId)}/events`,
          {
            signal: stopController.signal,
            onLine: (value: unknown) => {
              const event = value as { type?: string; count?: number; message?: string }
              if (event?.type === 'connection') {
                if (ctx.json) ctx.io.out(`${JSON.stringify(value)}\n`)
                else printText(ctx.io, `Connection established (active ${event.count ?? 0})`)
              } else if (event?.type === 'error') {
                if (ctx.json) ctx.io.out(`${JSON.stringify(value)}\n`)
                else printText(ctx.io, `Forwarding error: ${event.message ?? 'unknown'}`)
              } else if (event?.type === 'stopped') {
                hubStopped = true
                if (ctx.json) ctx.io.out(`${JSON.stringify(value)}\n`)
                else printText(ctx.io, 'Hub stopped forwarding')
              }
            },
          },
        )
      } catch (error) {
        // Aborting the stream via signal is expected shutdown (proceeds through finally cleanup and exits 0).
        if (!(stopping && error instanceof CliError && error.code === 'aborted')) throw error
      } finally {
        process.removeListener('SIGINT', onSignal)
        process.removeListener('SIGTERM', onSignal)
        try {
          await stopForward()
        } catch (error) {
          // Never falsely report cleanup success: record error and throw outside the normal return path.
          cleanupError = error
        }
      }
      if (cleanupError !== undefined) {
        throw new CliError(
          `forwarding ended, but cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          'forward_cleanup_failed',
        )
      }
      if (stopping || hubStopped) return
      // Event stream ended unexpectedly without a terminal frame (network drop / Hub crash): exit non-zero honestly.
      throw new CliError('forwarding event stream ended (Hub may have stopped forwarding)', 'forward_stream_ended')
    },
  })

  cmds.push({
    path: ['nodes', 'forwards'],
    description: 'List active port forwards (GET /api/nodes/forward)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const forwards = await hub.get<NodeForwardSession[]>('/api/nodes/forward')
      if (!Array.isArray(forwards)) throw new CliError('Hub forward list must be an array', 'invalid_response')
      const checked = forwards.map((f) => requireNodeForwardSession(f, 'Hub forward list item'))
      if (ctx.json) {
        printResult(ctx, checked)
        return
      }
      printForwardsTable(ctx.io, checked)
    },
  })

  cmds.push({
    path: ['nodes', 'forward-inspect'],
    description: 'Inspect port forward details (GET /api/nodes/forward/:forwardId)',
    positional: '<forwardId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const forwardId = requirePositional(parsed.positionals, 0, 'forwardId')
      assertNoExtraPositionals(parsed.positionals, 1)
      if (!/^fwd-[0-9a-f-]{36}$/.test(forwardId)) {
        throw new CliError('forwardId must be in fwd-<uuid> format', 'invalid_id')
      }
      const hub = await ctx.hub()
      const detail = await hub.get<NodeForwardSession>(`/api/nodes/forward/${encodeURIComponent(forwardId)}`)
      const checked = requireNodeForwardSession(detail, 'Hub forward details')
      if (ctx.json) {
        printResult(ctx, checked)
        return
      }
      printForwardDetail(ctx.io, checked)
    },
  })

  cmds.push({
    path: ['nodes', 'forward-stop'],
    description: 'Stop port forwarding (DELETE /api/nodes/forward/:forwardId)',
    positional: '<forwardId>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const forwardId = requirePositional(parsed.positionals, 0, 'forwardId')
      assertNoExtraPositionals(parsed.positionals, 1)
      if (!/^fwd-[0-9a-f-]{36}$/.test(forwardId)) {
        throw new CliError('forwardId must be in fwd-<uuid> format', 'invalid_id')
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.delete<{ ok: boolean }>(`/api/nodes/forward/${encodeURIComponent(forwardId)}`))
    },
  })

  return cmds
}
