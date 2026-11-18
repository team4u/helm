/**
 * Shared foundation for static core commands: CommandSpec/CommandContext contracts and cross-domain helpers.
 * Depends only on base layers (hub-client / args / output / errors / options / credentials);
 * never imports any specific command module so domain files keep zero horizontal coupling.
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
  /** CLI process working directory: sole base for resolving local relative paths (never silently switched by HELM_CWD). */
  cwd: string
  hub(): Promise<HubClient>
}

export interface CommandSpec {
  path: readonly string[]
  description: string
  flags?: readonly FlagSpec[]
  /** Positional usage synopsis (help rendering only). */
  positional?: string
  run(ctx: CommandContext): Promise<void | number>
}

// ---------------------------------------------------------------------------
// Numeric & positional arguments
// ---------------------------------------------------------------------------

/** Positive integer parser (conversation IDs, entry IDs, timeouts in ms, etc.); fails explicitly on invalid values. */
export function parsePositiveInt(raw: string, what: string, code = 'invalid_id'): number {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) <= 0) {
    throw new CliError(`${what} must be a positive integer, got "${raw}"`, code)
  }
  return Number(trimmed)
}

/** Read a required positional argument (with position index and purpose label). */
export function requirePositional(positionals: readonly string[], index: number, what: string, code = 'missing_id'): string {
  const value = positionals[index]
  if (value === undefined) throw new CliError(`missing <${what}> positional argument`, code)
  return value
}

/** Ensure no extra positional arguments appear starting at fromIndex (never silently drop excess arguments). */
export function assertNoExtraPositionals(positionals: readonly string[], fromIndex: number, what = 'positional argument(s)'): void {
  if (positionals.length > fromIndex) {
    throw new CliError(`unexpected ${what}: ${positionals.slice(fromIndex).join(' ')}`, 'unexpected_positional')
  }
}

// ---------------------------------------------------------------------------
// Conversation target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve conversation target: explicit positional ID or --current (from HELM_CONVERSATION_ID).
 * Fails explicitly when both are missing/invalid; explicit positional takes precedence if both are provided.
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
      throw new CliError('--current requires HELM_CONVERSATION_ID to be set', 'current_conversation_missing')
    }
    return parsePositiveInt(raw, 'HELM_CONVERSATION_ID')
  }
  throw new CliError('missing conversation target: pass an explicit <id> or --current (reads HELM_CONVERSATION_ID)', 'missing_conversation_target')
}

// ---------------------------------------------------------------------------
// Flag value normalization
// ---------------------------------------------------------------------------

/** --tags: accepts a JSON string array or a comma-separated string. */
export function coerceTags(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new CliError('--tags JSON must be a string array', 'invalid_flag_value')
    }
    return parsed as string[]
  }
  if (typeof raw !== 'string') throw new CliError('--tags must be a JSON array or comma-separated string', 'invalid_flag_value')
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Object-typed JSON flags such as --meta (non-object JSON is rejected on the CLI side; fields validated by Hub). */
export function coerceMetaFlag(raw: unknown, flagName: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError(`--${flagName} must be a JSON object`, 'invalid_flag_value')
  }
  return raw as Record<string, unknown>
}

/** --input: required JSON value. */
export function requireJsonInput(flags: Map<string, unknown>): unknown {
  const value = flags.get('input')
  if (value === undefined) throw new CliError('missing required option --input <json>', 'missing_required_flag')
  return value
}

/** Read a local file as UTF-8 text (--system-file, etc.; fails explicitly on error). */
export async function readTextFileFlag(filePath: string, flagName: string): Promise<string> {
  const fsp = await import('node:fs/promises')
  try {
    const st = await fsp.stat(filePath)
    if (!st.isFile()) throw new CliError(`--${flagName} does not point to a regular file: ${filePath}`, 'read_failed')
    return await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(
      `failed to read --${flagName} file (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      'read_failed',
    )
  }
}

/** Return all occurrences of a repeatable flag (or [] when unset). */
export function repeatedValues(flags: Map<string, unknown>, name: string): string[] {
  const v = flags.get(name)
  return Array.isArray(v) ? (v as string[]) : []
}

/**
 * Parse key=value assignments (--set k=v / --field k=v):
 * valid JSON booleans/numbers (including negatives) parse to scalars, everything else stays string;
 * empty keys are rejected; later duplicate keys overwrite earlier ones.
 */
export function parseKeyValues(rawItems: readonly string[], flagName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of rawItems) {
    const eq = item.indexOf('=')
    if (eq <= 0) {
      throw new CliError(`--${flagName} must be in key=value format, got "${item}"`, 'invalid_flag_value')
    }
    const key = item.slice(0, eq)
    const raw = item.slice(eq + 1)
    out[key] = parseScalarValue(raw)
  }
  return out
}

/** Scalar assignment coercion: JSON boolean/number semantics; everything else stays a string (never guesses objects/arrays). */
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
// Shared authentication helpers
// ---------------------------------------------------------------------------

/** Read one line of password from stdin (non-TTY only; TTY prompts callers to pass --password rather than blocking). */
export async function readPasswordFromStdin(): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    // readline already strips the trailing newline; do not trim — leading/trailing spaces can be part of the password
    return await rl.question('')
  } finally {
    rl.close()
  }
}

/** Shared by setup/login: exchange password for token and atomically save CLI credentials to cli-token (unauthenticated request). */
export async function authAndSave(ctx: CommandContext, path: '/api/auth/setup' | '/api/auth/login', password: string): Promise<void> {
  const hub = await ctx.hub()
  const { token } = await hub.request<AuthToken>('POST', path, { body: { password }, auth: false })
  if (typeof token !== 'string' || token.length === 0) {
    throw new CliError('Hub did not return a token (missing string field "token" in response)', 'invalid_response')
  }
  await updateCliCredentials(ctx.dataDir, { hubUrl: hub.baseUrl, token })
  if (ctx.json) {
    printValue(ctx.io, { token }, true)
  } else {
    ctx.io.out(`Logged in to ${hub.baseUrl} (credentials saved to ${credentialsPath(ctx.dataDir)})\n`)
  }
}

/** Shared password resolution for setup/login: --password takes precedence, falling back to non-TTY stdin. */
export async function resolvePasswordFlag(ctx: CommandContext, flags: Map<string, unknown>): Promise<string> {
  const raw = flagValue<string>(flags, 'password')
  const password = raw ?? (process.stdin.isTTY ? undefined : await readPasswordFromStdin())
  if (!password) {
    throw new CliError('missing password: pass --password <password> or pipe via stdin (--password is required under a TTY)', 'missing_password')
  }
  return password
}

// ---------------------------------------------------------------------------
// Output & enum helpers
// ---------------------------------------------------------------------------

export function printResult(ctx: CommandContext, value: unknown): void {
  printValue(ctx.io, value, ctx.json)
}

export function printPlainText(ctx: CommandContext, text: string): void {
  printText(ctx.io, text)
}

export function enumFlag<T extends readonly string[]>(name: string, values: T, help: string): FlagSpec {
  return { name, type: 'string', help: `${help} (${values.join('|')})` }
}

export function validateEnum(raw: unknown, values: readonly string[], flagName: string): string {
  if (typeof raw !== 'string' || !values.includes(raw)) {
    throw new CliError(`--${flagName} must be ${values.join('|')}, got "${String(raw)}"`, 'invalid_flag_value')
  }
  return raw
}

/** Shared parser for flagless commands (rejects all flags and positional arguments). */
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
    sessionCwd !== undefined ? `\n  conversation cwd (HELM_CWD)=${sessionCwd} (directory difference is normal when cd'ing; relative paths still resolve against CLI cwd)` : ''
  return `\n  requested path=${requested}\n  resolved path=${resolvedPath}\n  CLI cwd=${ctx.cwd}${hint}`
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
      `failed to download ${what} content (${err instanceof Error ? err.message : String(err)})${pathDiagLines(output, resolvedPath, ctx, sessionCwd)}`,
      'download_failed',
      1,
      pathDetails(output, resolvedPath, ctx, sessionCwd),
    )
  }
  try {
    await fsp.writeFile(resolvedPath, buffer)
  } catch (err) {
    throw new CliError(
      `failed to write ${what} file (${err instanceof Error ? err.message : String(err)})${pathDiagLines(output, resolvedPath, ctx, sessionCwd)}`,
      'write_failed',
      1,
      pathDetails(output, resolvedPath, ctx, sessionCwd),
    )
  }
  if (ctx.json) printValue(ctx.io, { written: resolvedPath, bytes: buffer.byteLength }, true)
  else ctx.io.out(`wrote ${resolvedPath} (${buffer.byteLength} bytes)\n`)
}
