/** across node command execute;JSON and person class output use identical succeeded decide and cancel semantics. */
import type { EnvExecRequest, EnvExecResponse, EnvExecStreamFrame } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { parsePositiveInt, printResult, resolveConversationTarget } from './shared.js'

const ENV_EXEC_FLAGS = [
  { name: 'node', type: 'string', help: 'target node ID(default inherit when before conversation, otherwise local)' },
  { name: 'cwd', type: 'string', help: 'target node work directory (absolute path)' },
  { name: 'timeout', type: 'number', help: 'command timeout milli second count (positive integer, cap 600000)' },
  { name: 'stream', type: 'boolean', help: 'one by one frame back pass stdout/stderr and terminal state' },
  { name: 'current', type: 'boolean', help: 'read HELM_CONVERSATION_ID as conversation context' },
] as const

/** and backend POST /api/env/exec validate align (timeoutMs <= 600_000), out of bounds in CLI side first row reject. */
const ENV_EXEC_TIMEOUT_MAX_MS = 600_000

function commandFromPositionals(positionals: readonly string[]): string | string[] {
  if (positionals.length === 0) {
    throw new CliError('missing await execute command:env exec [--node <id>] -- <command...>', 'missing_command_target')
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
    description: 'across node directly execute command (POST /api/env/exec)',
    flags: [...ENV_EXEC_FLAGS],
    positional: '-- <command...>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(ENV_EXEC_FLAGS, ctx.args)
      const body: EnvExecRequest = { command: commandFromPositionals(parsed.positionals) }
      const nodeId = flagValue<string>(parsed.flags, 'node')
      const cwd = flagValue<string>(parsed.flags, 'cwd')
      const timeout = flagValue<number>(parsed.flags, 'timeout')
      if (nodeId !== undefined) {
        if (nodeId.trim() === '') throw new CliError('--node must be non-empty node ID', 'invalid_flag_value')
        body.nodeId = nodeId
      }
      if (cwd !== undefined) body.cwd = cwd
      if (timeout !== undefined) {
        const timeoutMs = parsePositiveInt(String(timeout), '--timeout', 'invalid_flag_value')
        if (timeoutMs > ENV_EXEC_TIMEOUT_MAX_MS) {
          throw new CliError(`--timeout cannot exceeds ${ENV_EXEC_TIMEOUT_MAX_MS} milli second`, 'validation_error', 2)
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
      // Shell self carries command pre- compute,HTTP must not use client 30 second default value grab first interrupt long command.
      const result = await hub.request<EnvExecResponse>('POST', '/api/env/exec', { body, timeoutMs: 0 })
      if (!result || typeof result !== 'object' || !validExit(result as unknown as Record<string, unknown>) || typeof result.output !== 'string') {
        throw new CliError('Hub response non- EnvExecResponse shape', 'invalid_response')
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
          throw new CliError('Hub NDJSON frame must be object', 'invalid_response')
        }
        if (terminal) throw new CliError('Hub in terminal state after continue send data', 'invalid_response')
        const raw = value as Record<string, unknown>
        if (raw.type === 'output') {
          if (typeof raw.text !== 'string' || (raw.stream !== 'stdout' && raw.stream !== 'stderr')) {
            throw new CliError('Hub output frame field illegal', 'invalid_response')
          }
          const frame = raw as Extract<EnvExecStreamFrame, { type: 'output' }>
          if (ctx.json) ctx.io.out(`${JSON.stringify(frame)}\n`)
          else ctx.io.out(frame.text)
          return
        }
        if (raw.type === 'exit') {
          if (!validExit(raw)) throw new CliError('Hub terminal state frame field illegal', 'invalid_response')
          const frame = raw as Extract<EnvExecStreamFrame, { type: 'exit' }>
          terminal = true
          if (ctx.json) ctx.io.out(`${JSON.stringify(frame)}\n`)
          failure = executionFailure(frame)
          return
        }
        if (raw.type === 'error') {
          const error = raw.error as Record<string, unknown> | null | undefined
          if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
            throw new CliError('Hub error frame field illegal', 'invalid_response')
          }
          terminal = true
          throw new CliError(error.message, error.code, 1, error.details)
        }
        throw new CliError(`Hub NDJSON frame type unknown:${String(raw.type)}`, 'invalid_response')
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
  if (!terminal) throw new CliError('node output stream in terminal state before interrupt, command result unknown', 'stream_incomplete')
  if (failure) throw failure
}
