/**
 * 静态核心命令层公共基座：CommandSpec/CommandContext 契约与跨领域小助手。
 * 仅依赖第 1/2 层（hub-client / args / output / errors / options / credentials），
 * 不 import 任何具体命令模块——保持领域文件之间的零横向依赖。
 */
import type { AuthToken } from '@helm/protocol'
import { CliError } from '../errors.js'
import type { HubClient } from '../hub-client.js'
import type { Io } from '../options.js'
import { printText, printValue } from '../output.js'
import { credentialsPath, updateCliCredentials } from '../credentials.js'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'

export interface CommandContext {
  io: Io
  env: NodeJS.ProcessEnv
  json: boolean
  args: string[]
  dataDir: string
  /** CLI 进程工作目录：本地文件相对路径的唯一解析基准（绝不按 HELM_CWD 静默切换）。 */
  cwd: string
  hub(): Promise<HubClient>
}

export interface CommandSpec {
  path: readonly string[]
  description: string
  flags?: readonly FlagSpec[]
  /** 位置参数说明（仅帮助展示）。 */
  positional?: string
  run(ctx: CommandContext): Promise<void>
}

// ---------------------------------------------------------------------------
// 数值 / 位置参数
// ---------------------------------------------------------------------------

/** 正整数解析（会话 ID、条目 ID、超时毫秒等）；非法值显式报错。 */
export function parsePositiveInt(raw: string, what: string, code = 'invalid_id'): number {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) <= 0) {
    throw new CliError(`${what} 需为正整数，实得 "${raw}"`, code)
  }
  return Number(trimmed)
}

/** 取必填位置参数（序号 + 用途说明）。 */
export function requirePositional(positionals: readonly string[], index: number, what: string, code = 'missing_id'): string {
  const value = positionals[index]
  if (value === undefined) throw new CliError(`缺少 <${what}> 位置参数`, code)
  return value
}

/** 校验位置参数无多余项（fromIndex 起的全部拒绝，绝不无声丢弃）。 */
export function assertNoExtraPositionals(positionals: readonly string[], fromIndex: number, what = '位置参数'): void {
  if (positionals.length > fromIndex) {
    throw new CliError(`多余${what}：${positionals.slice(fromIndex).join(' ')}`, 'unexpected_positional')
  }
}

// ---------------------------------------------------------------------------
// 会话目标解析
// ---------------------------------------------------------------------------

/**
 * 解析会话目标：显式位置 ID 或 --current（读 HELM_CONVERSATION_ID）。
 * 二者均缺失/非法时显式报错；同时给出时显式优先。
 */
export function resolveConversationTarget(
  flags: Map<string, unknown>,
  positionalId: string | undefined,
  env: NodeJS.ProcessEnv,
): number {
  if (positionalId !== undefined) return parsePositiveInt(positionalId, '会话 ID')
  if (flags.get('current') === true) {
    const raw = env['HELM_CONVERSATION_ID']
    if (!raw || !raw.trim()) {
      throw new CliError('--current 需要 env HELM_CONVERSATION_ID（当前未设置）', 'current_conversation_missing')
    }
    return parsePositiveInt(raw, 'HELM_CONVERSATION_ID')
  }
  throw new CliError('缺少会话目标：提供显式 <id> 或 --current（读 HELM_CONVERSATION_ID）', 'missing_conversation_target')
}

// ---------------------------------------------------------------------------
// flag 值规整
// ---------------------------------------------------------------------------

/** --tags：接受 JSON 数组或逗号分隔字符串。 */
export function coerceTags(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new CliError('--tags JSON 需为字符串数组', 'invalid_flag_value')
    }
    return parsed as string[]
  }
  if (typeof raw !== 'string') throw new CliError('--tags 需为 JSON 数组或逗号分隔字符串', 'invalid_flag_value')
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** --meta 等 JSON 对象 flag（非对象 JSON 在 CLI 层拒绝；字段级校验在 Hub）。 */
export function coerceMetaFlag(raw: unknown, flagName: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`--${flagName} 需为 JSON 对象`, 'invalid_flag_value')
  }
  return raw as Record<string, unknown>
}

/** --input：必填 JSON。 */
export function requireJsonInput(flags: Map<string, unknown>): unknown {
  const value = flags.get('input')
  if (value === undefined) throw new CliError('缺少必填选项 --input <json>', 'missing_required_flag')
  return value
}

/** 读取本地文件全文（--system-file / --memory-file 等；读失败显式报错）。 */
export async function readTextFileFlag(filePath: string, flagName: string): Promise<string> {
  const fsp = await import('node:fs/promises')
  try {
    const st = await fsp.stat(filePath)
    if (!st.isFile()) throw new CliError(`--${flagName} 指向的不是常规文件：${filePath}`, 'read_failed')
    return await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(
      `读取 --${flagName} 文件失败（${filePath}）：${err instanceof Error ? err.message : String(err)}`,
      'read_failed',
    )
  }
}

/** 取可重复 flag 的全部取值（未给时为空数组）。 */
export function repeatedValues(flags: Map<string, unknown>, name: string): string[] {
  const v = flags.get(name)
  return Array.isArray(v) ? (v as string[]) : []
}

/**
 * 解析 key=value 赋值序列（--set k=v / --field k=v）：
 * 值为合法 JSON boolean/number（含负数）时解析为对应标量，否则作为 string；
 * key 为空拒绝；同名 key 后者覆盖前者。
 */
export function parseKeyValues(rawItems: readonly string[], flagName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of rawItems) {
    const eq = item.indexOf('=')
    if (eq <= 0) {
      throw new CliError(`--${flagName} 需为 key=value 形式，实得 "${item}"`, 'invalid_flag_value')
    }
    const key = item.slice(0, eq)
    const raw = item.slice(eq + 1)
    out[key] = parseScalarValue(raw)
  }
  return out
}

/** 标量赋值解析：JSON boolean/number 语义，其余一律 string（不猜对象/数组）。 */
export function parseScalarValue(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return raw
}

// ---------------------------------------------------------------------------
// 鉴权共用
// ---------------------------------------------------------------------------

/** stdin 读一行密码（仅非 TTY；TTY 下提示改用 --password，绝不交互阻塞）。 */
export async function readPasswordFromStdin(): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    // readline 已去除行尾；不再 trim——密码中的首尾空格是用户输入的一部分
    return await rl.question('')
  } finally {
    rl.close()
  }
}

/** setup/login 共用：换 token 并把 cli 凭据原子写入 credentials.json（请求本身无需鉴权）。 */
export async function authAndSave(ctx: CommandContext, path: '/api/auth/setup' | '/api/auth/login', password: string): Promise<void> {
  const hub = await ctx.hub()
  const { token } = await hub.request<AuthToken>('POST', path, { body: { password }, auth: false })
  if (typeof token !== 'string' || token.length === 0) {
    throw new CliError('Hub 未返回 token（响应缺 string 字段 token）', 'invalid_response')
  }
  await updateCliCredentials(ctx.dataDir, { hubUrl: hub.baseUrl, token })
  if (ctx.json) {
    printValue(ctx.io, { token }, true)
  } else {
    ctx.io.out(`已登录 ${hub.baseUrl}（凭据已写入 ${credentialsPath(ctx.dataDir)}）\n`)
  }
}

/** setup/login 共用的密码解析：--password 优先，非 TTY stdin 兜底。 */
export async function resolvePasswordFlag(ctx: CommandContext, flags: Map<string, unknown>): Promise<string> {
  const raw = flagValue<string>(flags, 'password')
  const password = raw ?? (process.stdin.isTTY ? undefined : await readPasswordFromStdin())
  if (!password) {
    throw new CliError('缺少密码：提供 --password <password>，或经 stdin 传入（TTY 下必须显式 --password）', 'missing_password')
  }
  return password
}

// ---------------------------------------------------------------------------
// 输出 / 枚举小助手
// ---------------------------------------------------------------------------

export function printResult(ctx: CommandContext, value: unknown): void {
  printValue(ctx.io, value, ctx.json)
}

export function printPlainText(ctx: CommandContext, text: string): void {
  printText(ctx.io, text)
}

export function enumFlag<T extends readonly string[]>(name: string, values: T, help: string): FlagSpec {
  return { name, type: 'string', help: `${help}（${values.join('|')}）` }
}

export function validateEnum(raw: unknown, values: readonly string[], flagName: string): string {
  if (typeof raw !== 'string' || !values.includes(raw)) {
    throw new CliError(`--${flagName} 需为 ${values.join('|')}，实得 "${String(raw)}"`, 'invalid_flag_value')
  }
  return raw
}

/** 无 flag 命令的通用解析入口（拒绝一切 flag 与位置参数）。 */
export function parseNoFlags(ctx: CommandContext): void {
  parseFlags([], ctx.args)
}
