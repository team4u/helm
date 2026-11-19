/** Cross-node command execution; JSON and human output share the same success and exit semantics. */
import type { EnvExecRequest, EnvExecResponse, EnvExecStreamFrame } from '@helmx/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { parsePositiveInt, printResult, resolveConversationTarget } from './shared.js'

const ENV_EXEC_FLAGS = [
  { name: 'node', type: 'string', help: 'target node ID (defaults to current conversation node, or local)' },
  { name: 'cwd', type: 'string', help: 'working directory on the target node (absolute path)' },
  { name: 'timeout', type: 'number', help: 'command timeout in milliseconds (positive integer, max 600000)' },
  { name: 'stream', type: 'boolean', help: 'stream stdout/stderr and terminal exit frames incrementally' },
  { name: 'current', type: 'boolean', help: 'use HELMX_CONVERSATION_ID as the conversation context' },
] as const

/** Matches backend POST /api/env/exec validation (timeoutMs <= 600_000); reject out-of-range values early on the CLI side. */
const ENV_EXEC_TIMEOUT_MAX_MS = 600_000

function commandFromPositionals(positionals: readonly string[]): string | string[] {
  if (positionals.length === 0) {
    throw new CliError('missing command to execute: env exec [--node <id>] -- <command...>', 'missing_command_target')
  }
  if (positionals.length === 1 && /\s/.test(positionals[0]!)) return positionals[0]!
  return [...positionals]
}

function validExit(value: Record<string, unknown>): boolean {
  return typeof value.ok === 'boolean' && typeof value.timedOut === 'boolean' &&
    (value.exitCode === null || (Number.isInteger(value.exitCode) && (value.exitCode as number) >= 0))
}

function executionFailure(result: Pick<EnvExecResponse, 'ok' | 'exitCode' | 'timedOut'>): CliError | undefined {
  if (result.ok && result.exitCode === 0 && !result.timedOut) return undefined
  return new CliError(
    `command failed${result.timedOut ? '(timeout)' : ''}:exitCode=${String(result.exitCode)}`,
    'env_exec_failed',
    result.exitCode !== null && result.exitCode > 0 ? Math.min(result.exitCode, 255) : 1,
    result,
  )
}

export function envCommands(): CommandSpec[] {
  return [{
    path: ['env', 'exec'],
    description: 'Execute a command directly across nodes (POST /api/env/exec)',
    flags: [...ENV_EXEC_FLAGS],
    positional: '-- <command...>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(ENV_EXEC_FLAGS, ctx.args)
      const body: EnvExecRequest = { command: commandFromPositionals(parsed.positionals) }
      const nodeId = flagValue<string>(parsed.flags, 'node')
      const cwd = flagValue<string>(parsed.flags, 'cwd')
      const timeout = flagValue<number>(parsed.flags, 'timeout')
      if (nodeId !== undefined) {
        if (nodeId.trim() === '') throw new CliError('--node must be a non-empty node ID', 'invalid_flag_value')
        body.nodeId = nodeId
      }
      if (cwd !== undefined) body.cwd = cwd
      if (timeout !== undefined) {
        const timeoutMs = parsePositiveInt(String(timeout), '--timeout', 'invalid_flag_value')
        if (timeoutMs > ENV_EXEC_TIMEOUT_MAX_MS) {
          throw new CliError(`--timeout cannot exceed ${ENV_EXEC_TIMEOUT_MAX_MS}ms`, 'validation_error', 2)
        }
        body.timeoutMs = timeoutMs
      }
      if (parsed.flags.get('current') === true) {
        body.conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
      }
      if (parsed.flags.get('stream') === true) {
        body.stream = true
        await runStreamed(ctx, body)
        return
      }
      const hub = await ctx.hub()
      // Shell execution handles command timeouts itself; HTTP must not cut off long commands with the client 30s default.
      const result = await hub.request<EnvExecResponse>('POST', '/api/env/exec', { body, timeoutMs: 0 })
      if (!result || typeof result !== 'object' || !validExit(result as unknown as Record<string, unknown>) || typeof result.output !== 'string') {
        throw new CliError('Hub returned an invalid EnvExecResponse shape', 'invalid_response')
      }
      if (ctx.json) printResult(ctx, result)
      else if (result.output !== '') ctx.io.out(result.output.endsWith('\n') ? result.output : `${result.output}\n`)
      const failure = executionFailure(result)
      if (failure) throw failure
    },
  }]
}

async function runStreamed(ctx: CommandContext, body: EnvExecRequest): Promise<void> {
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let terminal = false
  let failure: CliError | undefined
  try {
    const hub = await ctx.hub()
    await hub.streamNdjson('POST', '/api/env/exec', {
      body,
      signal: controller.signal,
      onLine(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new CliError('Hub NDJSON frame must be an object', 'invalid_response')
        }
        if (terminal) throw new CliError('Hub sent more data after terminal frame', 'invalid_response')
        const raw = value as Record<string, unknown>
        if (raw.type === 'output') {
          if (typeof raw.text !== 'string' || (raw.stream !== 'stdout' && raw.stream !== 'stderr')) {
            throw new CliError('Hub output frame has invalid fields', 'invalid_response')
          }
          const frame = raw as Extract<EnvExecStreamFrame, { type: 'output' }>
          if (ctx.json) ctx.io.out(`${JSON.stringify(frame)}\n`)
          else ctx.io.out(frame.text)
          return
        }
        if (raw.type === 'exit') {
          if (!validExit(raw)) throw new CliError('Hub exit frame has invalid fields', 'invalid_response')
          const frame = raw as Extract<EnvExecStreamFrame, { type: 'exit' }>
          terminal = true
          if (ctx.json) ctx.io.out(`${JSON.stringify(frame)}\n`)
          failure = executionFailure(frame)
          return
        }
        if (raw.type === 'error') {
          const error = raw.error as Record<string, unknown> | null | undefined
          if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
            throw new CliError('Hub error frame has invalid fields', 'invalid_response')
          }
          terminal = true
          throw new CliError(error.message, error.code, 1, error.details)
        }
        throw new CliError(`Unknown Hub NDJSON frame type: ${String(raw.type)}`, 'invalid_response')
      },
    })
  } catch (error) {
    if (controller.signal.aborted || (error instanceof CliError && error.code === 'aborted')) {
      throw new CliError('cancelled (env exec)', 'aborted', 130)
    }
    throw error
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  if (!terminal) throw new CliError('node output stream ended before receiving an exit frame; command result is unknown', 'stream_incomplete')
  if (failure) throw failure
}
