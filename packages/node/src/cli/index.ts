#!/usr/bin/env node
/**
 * helm CLI 主入口。
 * - runCli(argv, options) 为唯一测试/嵌入入口；直接运行时（import.meta.url === argv[1]）才执行。
 * - 命令分发：核心静态表 + GET /api/actions 动态插件命令。
 * - --json 全局生效：成功 stdout JSON，失败 stderr JSON + 非零退出码。
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import type { CommandContext, CommandSpec } from './commands.js'
import { coreCommands } from './commands.js'
import { loadDynamicCommands } from './actions.js'
import { HubClient, resolveEndpoint } from './hub-client.js'
import { buildIo, type RunCliOptions } from './options.js'
import { CliError, describeError, errorEnvelope } from './errors.js'
import { cliCredentialOf, dataDirFor, readCredentials } from './credentials.js'

export interface CompletedRun {
  exitCode: number
}

function isDirectRun(): boolean {
  if (process.argv[1] === undefined) return false
  try {
    const self = fileURLToPath(import.meta.url)
    const entry = path.resolve(process.argv[1]!)
    return self === entry
  } catch {
    return false
  }
}

function printHelp(
  io: { out: (text: string) => void },
  core: readonly CommandSpec[],
  dynamic: readonly CommandSpec[],
): void {
  io.out('helm — 极简持久微内核个人助理 CLI（与 Web API 同权）\n\n')
  io.out('用法: helm <command> [subcommand] [--flags] [--json]\n\n')
  io.out('全局选项:\n')
  io.out('  --json            机器可读 JSON 输出（stdout；错误为 stderr + 非零退出码）\n')
  io.out('  --help, -h        显示帮助\n\n')
  io.out('核心命令:\n')
  for (const cmd of core) {
    const positional = cmd.positional ? ` ${cmd.positional}` : ''
    io.out(`  ${cmd.path.join(' ')}${positional}\n    ${cmd.description}\n`)
    for (const flag of cmd.flags ?? []) {
      const req = flag.required ? '（必填）' : ''
      io.out(`    --${flag.name} <${flag.type}>${req}${flag.help ? `  ${flag.help}` : ''}\n`)
    }
  }
  if (dynamic.length > 0) {
    io.out('\n插件命令（由 GET /api/actions 动态生成）:\n')
    for (const cmd of dynamic) {
      io.out(`  ${cmd.path.join(' ')}\n    ${cmd.description}\n`)
    }
  } else {
    io.out('\n（Hub 未提供插件动作命令；启动 Hub 后重试可见 helm <plugin> <action>）\n')
  }
  io.out('\n环境变量: HELM_HUB_URL（默认 http://127.0.0.1:3202）· HELM_TOKEN · HELM_DATA_DIR（默认 ~/.helm）· HELM_CONVERSATION_ID（--current）\n')
}

/** 剥离全局 --json/-h/--help（可出现在任意位置）。 */
function extractGlobals(argv: readonly string[]): { rest: string[]; json: boolean; help: boolean } {
  const rest: string[] = []
  let json = false
  let help = false
  for (const token of argv) {
    if (token === '--json') json = true
    else if (token === '--help' || token === '-h') help = true
    else rest.push(token)
  }
  return { rest, json, help }
}

const isOptionLike = (token: string): boolean => token.startsWith('-') && token !== '-' && token !== '--'

/** 查找精确匹配的命令；无精确匹配时返回负 consumed 表示需要更多子命令。 */
function matchCommand(
  commands: readonly CommandSpec[],
  tokens: readonly string[],
): { command: CommandSpec; consumed: number } | undefined {
  const maxDepth = Math.min(tokens.length, Math.max(...commands.map((c) => c.path.length)))
  // 先试最长路径（深命令优先，避免父路径吞掉子命令）
  for (let depth = maxDepth; depth >= 1; depth--) {
    const prefix = tokens.slice(0, depth)
    const exact = commands.filter((c) => c.path.length === prefix.length && c.path.every((seg, i) => seg === prefix[i]))
    if (exact.length > 0) return { command: exact[0]!, consumed: depth }
  }
  // 无精确匹配：试最长公共前缀做子命令提示
  for (let depth = maxDepth; depth >= 1; depth--) {
    const prefix = tokens.slice(0, depth)
    const partial = commands.filter((c) => c.path.length > prefix.length && c.path.slice(0, prefix.length).every((seg, i) => seg === prefix[i]))
    if (partial.length > 0) {
      return { command: partial[0]!, consumed: -1 } // -1 = 需要更多子命令，仅报错用
    }
  }
  return undefined
}

export async function runCli(argv: readonly string[] = [], options: RunCliOptions = {}): Promise<number> {
  const io = buildIo(options)
  const { rest, json, help } = extractGlobals(argv)
  const emitError = (described: ReturnType<typeof describeError>): number => {
    if (json) io.err(`${JSON.stringify(errorEnvelope(described))}\n`)
    else io.err(`error: ${described.message}\n`)
    return described.exitCode
  }

  const core = coreCommands()
  const corePaths = core.map((c) => c.path)

  // 无命令：帮助或错误
  if (rest.length === 0) {
    if (json) return emitError(describeError(new CliError('缺少命令（helm --help 查看用法）', 'missing_command')))
    let dynamic: CommandSpec[] = []
    try {
      const env = options.env ?? process.env
      const dataDir = dataDirFor(env)
      const credential = cliCredentialOf(await readCredentials(dataDir).catch(() => ({})))
      const hub = new HubClient(resolveEndpoint(env, credential), io)
      dynamic = (await loadDynamicCommands(hub, corePaths)).map((d) => d.spec)
    } catch {
      dynamic = [] // Hub 不可达时帮助仍可用（动态命令留空并提示）
    }
    printHelp(io, core, dynamic)
    return 0
  }

  // 帮助请求：任意位置 --help 优先于执行
  if (help) {
    let dynamic: CommandSpec[] = []
    try {
      const env = options.env ?? process.env
      const dataDir = dataDirFor(env)
      const credential = cliCredentialOf(await readCredentials(dataDir).catch(() => ({})))
      const hub = new HubClient(resolveEndpoint(env, credential), io)
      dynamic = (await loadDynamicCommands(hub, corePaths)).map((d) => d.spec)
    } catch {
      dynamic = []
    }
    // 有具体命令时只展示该命令帮助
    const matched = matchCommand(core, rest)
    if (matched && matched.consumed >= 0) {
      const cmd = matched.command
      io.out(`${cmd.path.join(' ')}${cmd.positional ? ` ${cmd.positional}` : ''}\n  ${cmd.description}\n`)
      for (const flag of cmd.flags ?? []) {
        const req = flag.required ? '（必填）' : ''
        io.out(`  --${flag.name} <${flag.type}>${req}${flag.help ? `  ${flag.help}` : ''}\n`)
      }
      return 0
    }
    printHelp(io, core, dynamic)
    return 0
  }

  const env = options.env ?? process.env
  const dataDir = dataDirFor(env)

  const makeContext = (): CommandContext => {
    const clientHolder: { client?: HubClient } = {}
    return {
      io,
      env,
      json,
      args: [],
      dataDir,
      async hub() {
        if (!clientHolder.client) {
          const credential = cliCredentialOf(await readCredentials(dataDir).catch(() => ({})))
          clientHolder.client = new HubClient(resolveEndpoint(env, credential), io)
        }
        return clientHolder.client
      },
    }
  }

  // 动态命令解析：默认拉取 /api/actions（一次）以全量冲突检测；
  // 但 setup/login/status 本身无需鉴权（登录前拉不到动作清单），跳过预拉
  const AUTH_FREE = new Set(['setup', 'login', 'status'])
  const coreMatched = matchCommand(core, rest)
  const skipPreflight = coreMatched !== undefined && coreMatched.consumed > 0 && coreMatched.command.path.length === 1 && AUTH_FREE.has(coreMatched.command.path[0]!)
  let dynamicSpecs: CommandSpec[] = []
  if (!skipPreflight) {
    try {
      const ctx0 = makeContext()
      dynamicSpecs = (await loadDynamicCommands(await ctx0.hub(), corePaths)).map((d) => d.spec)
    } catch (err) {
      return emitError(describeError(err))
    }
  }

  const matched = matchCommand([...core, ...dynamicSpecs], rest)
  if (!matched || matched.consumed < 0) {
    const head = rest.filter((t) => !isOptionLike(t)).slice(0, 2).join(' ')
    return emitError(describeError(new CliError(`未知命令：helm ${head || '(空)'}（helm --help 查看可用命令）`, 'unknown_command')))
  }
  const { command, consumed } = matched
  const ctx = makeContext()
  ctx.args = rest.slice(consumed)
  try {
    await command.run(ctx)
    return 0
  } catch (err) {
    return emitError(describeError(err))
  }
}

if (isDirectRun()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    },
  )
}
