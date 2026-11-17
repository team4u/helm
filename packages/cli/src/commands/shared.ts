/**
 * static core command layer public base seat:CommandSpec/CommandContext contract and across domain small assist manually.
 * only dependency 1/2 layer (hub-client / args / output / errors / options / credentials),
 * do not import any specific command module - - keep domain file between zero horizontal dependency.
 */
import type { AuthToken } from '@helm/protocol'
import path from 'node:path'
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
  /** CLI process work directory: local file relative path unique parse base allow (never by HELM_CWD static default switch). */
  cwd: string
  hub(): Promise<HubClient>
}

export interface CommandSpec {
  path: readonly string[]
  description: string
  flags?: readonly FlagSpec[]
  /** location parameter note (only help render). */
  positional?: string
  run(ctx: CommandContext): Promise<void>
}

// ---------------------------------------------------------------------------
// count value / location parameter
// ---------------------------------------------------------------------------

/** positive integer parse (conversation ID, item ID, timeout milli second etc.); illegal value explicit errors. */
export function parsePositiveInt(raw: string, what: string, code = 'invalid_id'): number {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) <= 0) {
    throw new CliError(`${what} must be a positive integer, got "${raw}"`, code)
  }
  return Number(trimmed)
}

/** take required location parameter (ordinal + purpose note). */
export function requirePositional(positionals: readonly string[], index: number, what: string, code = 'missing_id'): string {
  const value = positionals[index]
  if (value === undefined) throw new CliError(`missing <${what}> location parameter`, code)
  return value
}

/** validate location parameter without redundant items (fromIndex start all reject, never without sound discard). */
export function assertNoExtraPositionals(positionals: readonly string[], fromIndex: number, what = 'location parameter'): void {
  if (positionals.length > fromIndex) {
    throw new CliError(`redundant${what}:${positionals.slice(fromIndex).join(' ')}`, 'unexpected_positional')
  }
}

// ---------------------------------------------------------------------------
// conversation target parse
// ---------------------------------------------------------------------------

/**
 * parse conversation target: explicit location ID or --current(read HELM_CONVERSATION_ID).
 * two all missing/illegal when explicit errors; also to out when explicit takes precedence.
 */
export function resolveConversationTarget(
  flags: Map<string, unknown>,
  positionalId: string | undefined,
  env: NodeJS.ProcessEnv,
): number {
  if (positionalId !== undefined) return parsePositiveInt(positionalId, 'conversation ID')
  if (flags.get('current') === true) {
    const raw = env['HELM_CONVERSATION_ID']
    if (!raw || !raw.trim()) {
      throw new CliError('--current need to env HELM_CONVERSATION_ID(when before not settings)', 'current_conversation_missing')
    }
    return parsePositiveInt(raw, 'HELM_CONVERSATION_ID')
  }
  throw new CliError('missing conversation target: provide explicit <id> or --current(read HELM_CONVERSATION_ID)', 'missing_conversation_target')
}

// ---------------------------------------------------------------------------
// flag value rule whole
// ---------------------------------------------------------------------------

/** --tags: accept JSON array or comma isolate string. */
export function coerceTags(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new CliError('--tags JSON must be a string array', 'invalid_flag_value')
    }
    return parsed as string[]
  }
  if (typeof raw !== 'string') throw new CliError('--tags must be JSON array or comma isolate string', 'invalid_flag_value')
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** --meta etc. JSON object flag(non- object JSON in CLI layer reject; field level validate in Hub). */
export function coerceMetaFlag(raw: unknown, flagName: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`--${flagName} must be JSON object`, 'invalid_flag_value')
  }
  return raw as Record<string, unknown>
}

/** --input: required JSON. */
export function requireJsonInput(flags: Map<string, unknown>): unknown {
  const value = flags.get('input')
  if (value === undefined) throw new CliError('missing required option --input <json>', 'missing_required_flag')
  return value
}

/** read local file all text (--system-file / --memory-file etc.; read failed explicit errors). */
export async function readTextFileFlag(filePath: string, flagName: string): Promise<string> {
  const fsp = await import('node:fs/promises')
  try {
    const st = await fsp.stat(filePath)
    if (!st.isFile()) throw new CliError(`--${flagName} points to is not common rule file:${filePath}`, 'read_failed')
    return await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(
      `read --${flagName} file failed (${filePath}):${err instanceof Error ? err.message : String(err)}`,
      'read_failed',
    )
  }
}

/** take can duplicate flag all take value (not to when is empty array). */
export function repeatedValues(flags: Map<string, unknown>, name: string): string[] {
  const v = flags.get(name)
  return Array.isArray(v) ? (v as string[]) : []
}

/**
 * parse key=value assignment sequence (--set k=v / --field k=v):
 * value is legal JSON boolean/number(contains negative number) when parse is for should mark amount, otherwise as string;
 * key is empty reject; same name key after override before.
 */
export function parseKeyValues(rawItems: readonly string[], flagName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of rawItems) {
    const eq = item.indexOf('=')
    if (eq <= 0) {
      throw new CliError(`--${flagName} must be key=value form, got "${item}"`, 'invalid_flag_value')
    }
    const key = item.slice(0, eq)
    const raw = item.slice(eq + 1)
    out[key] = parseScalarValue(raw)
  }
  return out
}

/** mark amount assignment parse:JSON boolean/number semantics, the rest one rule string(do not guess object/array). */
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
// authentication shared use
// ---------------------------------------------------------------------------

/** stdin read one row password (only non- TTY;TTY under hint change use --password, never interaction block). */
export async function readPasswordFromStdin(): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    // readline already remove except row tail; no longer trim- - password in first tail space is user input one part
    return await rl.question('')
  } finally {
    rl.close()
  }
}

/** setup/login shared use: swap token and cli credentials atomic write credentials.json(request itself no need to authentication). */
export async function authAndSave(ctx: CommandContext, path: '/api/auth/setup' | '/api/auth/login', password: string): Promise<void> {
  const hub = await ctx.hub()
  const { token } = await hub.request<AuthToken>('POST', path, { body: { password }, auth: false })
  if (typeof token !== 'string' || token.length === 0) {
    throw new CliError('Hub not return token(response missing string field token)', 'invalid_response')
  }
  await updateCliCredentials(ctx.dataDir, { hubUrl: hub.baseUrl, token })
  if (ctx.json) {
    printValue(ctx.io, { token }, true)
  } else {
    ctx.io.out(`already login ${hub.baseUrl}(credentials already write ${credentialsPath(ctx.dataDir)})\n`)
  }
}

/** setup/login shared use password parse:--password takes precedence, non- TTY stdin fall back. */
export async function resolvePasswordFlag(ctx: CommandContext, flags: Map<string, unknown>): Promise<string> {
  const raw = flagValue<string>(flags, 'password')
  const password = raw ?? (process.stdin.isTTY ? undefined : await readPasswordFromStdin())
  if (!password) {
    throw new CliError('missing password: provide --password <password>, or via stdin pass (TTY under must explicit --password)', 'missing_password')
  }
  return password
}

// ---------------------------------------------------------------------------
// output / enumeration small assist manually
// ---------------------------------------------------------------------------

export function printResult(ctx: CommandContext, value: unknown): void {
  printValue(ctx.io, value, ctx.json)
}

export function printPlainText(ctx: CommandContext, text: string): void {
  printText(ctx.io, text)
}

export function enumFlag<T extends readonly string[]>(name: string, values: T, help: string): FlagSpec {
  return { name, type: 'string', help: `${help}(${values.join('|')})` }
}

export function validateEnum(raw: unknown, values: readonly string[], flagName: string): string {
  if (typeof raw !== 'string' || !values.includes(raw)) {
    throw new CliError(`--${flagName} must be ${values.join('|')}, got "${String(raw)}"`, 'invalid_flag_value')
  }
  return raw
}

/** without flag command through use parse entry (reject everything flag and location parameter). */
export function parseNoFlags(ctx: CommandContext): void {
  parseFlags([], ctx.args)
}

// ---------------------------------------------------------------------------
// caller cwd local file path helpers (artifacts put/get, conversations file --output)
// ---------------------------------------------------------------------------

/**
 * Resolve a path against the CLI caller's cwd (never silently switched to HELM_CWD).
 * If HELM_ENV=1 and HELM_CWD differs, attach sessionCwd purely as diagnostic context.
 */
export function resolveCallerPath(ctx: CommandContext, requested: string): { resolvedPath: string; sessionCwd?: string } {
  const resolvedPath = path.resolve(ctx.cwd, requested)
  let sessionCwd: string | undefined
  if (ctx.env['HELM_ENV'] === '1') {
    const managed = ctx.env['HELM_CWD']
    if (managed && managed !== ctx.cwd) sessionCwd = managed
  }
  return { resolvedPath, sessionCwd }
}

export function pathDetails(requested: string, resolvedPath: string, ctx: CommandContext, sessionCwd?: string): Record<string, string> {
  return {
    requestedPath: requested,
    resolvedPath,
    cliCwd: ctx.cwd,
    ...(sessionCwd !== undefined ? { sessionCwd } : {}),
  }
}

export function pathDiagLines(requested: string, resolvedPath: string, ctx: CommandContext, sessionCwd?: string): string {
  const hint =
    sessionCwd !== undefined ? `\n  conversation cwd(HELM_CWD)=${sessionCwd}(directory difference belong legal cd; relative path still by CLI cwd parse)` : ''
  return `\n  request path=${requested}\n  absolute path=${resolvedPath}\n  CLI cwd=${ctx.cwd}${hint}`
}

/** Download a binary Response completely into memory before writing to caller's resolved output path. */
export async function writeDownloadedOutput(
  ctx: CommandContext,
  response: Response,
  output: string,
  what: string,
): Promise<void> {
  const fsp = await import('node:fs/promises')
  const { resolvedPath, sessionCwd } = resolveCallerPath(ctx, output)
  let buffer: Buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (err) {
    throw new CliError(
      `download ${what} content failed (${err instanceof Error ? err.message : String(err)})${pathDiagLines(output, resolvedPath, ctx, sessionCwd)}`,
      'download_failed',
      1,
      pathDetails(output, resolvedPath, ctx, sessionCwd),
    )
  }
  try {
    await fsp.writeFile(resolvedPath, buffer)
  } catch (err) {
    throw new CliError(
      `write ${what} file failed (${err instanceof Error ? err.message : String(err)})${pathDiagLines(output, resolvedPath, ctx, sessionCwd)}`,
      'write_failed',
      1,
      pathDetails(output, resolvedPath, ctx, sessionCwd),
    )
  }
  if (ctx.json) printValue(ctx.io, { written: resolvedPath, bytes: buffer.byteLength }, true)
  else ctx.io.out(`already write ${resolvedPath}(${buffer.byteLength} byte)\n`)
}
