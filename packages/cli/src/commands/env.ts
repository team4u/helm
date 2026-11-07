/** 跨节点命令执行；JSON 与人类输出使用相同的成功判定和取消语义。 */
import type { EnvExecRequest, EnvExecResponse, EnvExecStreamFrame } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { parsePositiveInt, printResult, resolveConversationTarget } from './shared.js'

const ENV_EXEC_FLAGS = [
  { name: 'node', type: 'string', help: '目标节点 ID（缺省继承当前会话，否则 local）' },
  { name: 'cwd', type: 'string', help: '目标节点工作目录（绝对路径）' },
  { name: 'timeout', type: 'number', help: '命令超时毫秒数（正整数）' },
  { name: 'stream', type: 'boolean', help: '逐帧回传 stdout/stderr 与终态' },
  { name: 'current', type: 'boolean', help: '读取 HELM_CONVERSATION_ID 作为会话上下文' },
] as const

function commandFromPositionals(positionals: readonly string[]): string | string[] {
  if (positionals.length === 0) {
    throw new CliError('缺少待执行命令：env exec [--node <id>] -- <command...>', 'missing_command_target')
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
    `命令失败${result.timedOut ? '（超时）' : ''}：exitCode=${String(result.exitCode)}`,
    'env_exec_failed',
    result.exitCode !== null && result.exitCode > 0 ? Math.min(result.exitCode, 255) : 1,
    result,
  )
}

export function envCommands(): CommandSpec[] {
  return [{
    path: ['env', 'exec'],
    description: '跨节点直接执行命令（POST /api/env/exec）',
    flags: [...ENV_EXEC_FLAGS],
    positional: '-- <command...>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(ENV_EXEC_FLAGS, ctx.args)
      const body: EnvExecRequest = { command: commandFromPositionals(parsed.positionals) }
      const nodeId = flagValue<string>(parsed.flags, 'node')
      const cwd = flagValue<string>(parsed.flags, 'cwd')
      const timeout = flagValue<number>(parsed.flags, 'timeout')
      if (nodeId !== undefined) {
        if (nodeId.trim() === '') throw new CliError('--node 需为非空节点 ID', 'invalid_flag_value')
        body.nodeId = nodeId
      }
      if (cwd !== undefined) body.cwd = cwd
      if (timeout !== undefined) body.timeoutMs = parsePositiveInt(String(timeout), '--timeout', 'invalid_flag_value')
      if (parsed.flags.get('current') === true) {
        body.conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
      }
      if (parsed.flags.get('stream') === true) {
        body.stream = true
        await runStreamed(ctx, body)
        return
      }
      const hub = await ctx.hub()
      // Shell 自带命令预算，HTTP 不应用客户端的 30 秒默认值抢先中断长命令。
      const result = await hub.request<EnvExecResponse>('POST', '/api/env/exec', { body, timeoutMs: 0 })
      if (!result || typeof result !== 'object' || !validExit(result as unknown as Record<string, unknown>) || typeof result.output !== 'string') {
        throw new CliError('Hub 响应非 EnvExecResponse 形状', 'invalid_response')
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
          throw new CliError('Hub NDJSON 帧必须是对象', 'invalid_response')
        }
        if (terminal) throw new CliError('Hub 在终态后继续发送数据', 'invalid_response')
        const raw = value as Record<string, unknown>
        if (raw.type === 'output') {
          if (typeof raw.text !== 'string' || (raw.stream !== 'stdout' && raw.stream !== 'stderr')) {
            throw new CliError('Hub 输出帧字段非法', 'invalid_response')
          }
          const frame = raw as Extract<EnvExecStreamFrame, { type: 'output' }>
          if (ctx.json) ctx.io.out(`${JSON.stringify(frame)}\n`)
          else ctx.io.out(frame.text)
          return
        }
        if (raw.type === 'exit') {
          if (!validExit(raw)) throw new CliError('Hub 终态帧字段非法', 'invalid_response')
          const frame = raw as Extract<EnvExecStreamFrame, { type: 'exit' }>
          terminal = true
          if (ctx.json) ctx.io.out(`${JSON.stringify(frame)}\n`)
          failure = executionFailure(frame)
          return
        }
        if (raw.type === 'error') {
          const error = raw.error as Record<string, unknown> | null | undefined
          if (!error || typeof error.code !== 'string' || typeof error.message !== 'string') {
            throw new CliError('Hub 错误帧字段非法', 'invalid_response')
          }
          terminal = true
          throw new CliError(error.message, error.code, 1, error.details)
        }
        throw new CliError(`Hub NDJSON 帧类型未知：${String(raw.type)}`, 'invalid_response')
      },
    })
  } catch (error) {
    if (controller.signal.aborted || (error instanceof CliError && error.code === 'aborted')) {
      throw new CliError('已取消（env exec）', 'aborted', 130)
    }
    throw error
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  if (!terminal) throw new CliError('节点输出流在终态前中断，命令结果未知', 'stream_incomplete')
  if (failure) throw failure
}
