#!/usr/bin/env node
/**
 * helm CLI 主入口。
 * - runCli(argv, options) 为唯一测试/嵌入入口；直接运行时（import.meta.url === argv[1]）才执行。
 * - 命令分发：核心静态表优先精确匹配执行；仅当无核心匹配时才拉取 /api/actions
 *   构建动态命令（此时才做冲突校验并显式报错）。核心管理面（plugins disable 等）
 *   永不因坏插件 manifest 而不可用——故障隔离。
 * - --json 全局生效：成功 stdout JSON，失败 stderr JSON + 非零退出码。
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import type { CommandContext, CommandSpec } from './commands.js'
import { coreCommands } from './commands.js'
import { loadDynamicCommands } from './actions.js'
import { HubClient, resolveEndpoint } from './hub-client.js'
import { buildIo, type Io, type RunCliOptions } from './options.js'
import { CliError, describeError, errorEnvelope } from './errors.js'
import { dataDirFor, loadCliCredential } from './credentials.js'

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
  io: Io,
  core: readonly CommandSpec[],
  dynamic: readonly CommandSpec[],
  diagnostics: readonly string[],
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
    io.out('\n（当前未获取到插件动作命令；未启动 Hub、未登录或无可用动作时如此）\n')
  }
  io.out('\n环境变量: HELM_HUB_URL（默认 http://127.0.0.1:3202）· HELM_TOKEN · HELM_DATA_DIR（默认 ~/.helm）· HELM_CONVERSATION_ID（--current）\n')
  for (const d of diagnostics) io.err(`helm: ${d}\n`)
}

/**
 * 剥离全局 --json/-h/--help（可出现在任意位置）；`--` 之后的内容原样保留，
 * 由命令级解析处理（`send 1 -- --json` 应把 `--json` 当文本发送）。
 */
function extractGlobals(argv: readonly string[]): { rest: string[]; json: boolean; help: boolean } {
  const rest: string[] = []
  let json = false
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--') {
      rest.push(...argv.slice(i))
      break
    }
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

function printCommandDetail(io: Io, cmd: CommandSpec): void {
  io.out(`${cmd.path.join(' ')}${cmd.positional ? ` ${cmd.positional}` : ''}\n  ${cmd.description}\n`)
  for (const flag of cmd.flags ?? []) {
    const req = flag.required ? '（必填）' : ''
    io.out(`  --${flag.name} <${flag.type}>${req}${flag.help ? `  ${flag.help}` : ''}\n`)
  }
}

/**
 * 读凭据并构建 HubClient；凭据损坏时抛错（不吞成「无凭据」）。
 * HELM_TOKEN 优先：显式给出时短路磁盘，不触碰任何凭据文件。
 */
async function hubFromEnv(env: NodeJS.ProcessEnv, dataDir: string, io: Io): Promise<HubClient> {
  if (env['HELM_TOKEN']) {
    return new HubClient(resolveEndpoint(env, {}), io)
  }
  const credential = await loadCliCredential(dataDir)
  return new HubClient(resolveEndpoint(env, credential), io)
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
        if (!clientHolder.client) clientHolder.client = await hubFromEnv(env, dataDir, io)
        return clientHolder.client
      },
    }
  }

  // 帮助/无命令场景：核心帮助永远可用；动态命令与凭据诊断尽力而为、单独呈现
  if (rest.length === 0 || help) {
    const diagnostics: string[] = []
    let dynamic: CommandSpec[] = []
    const loadDynamic = async (): Promise<CommandSpec[]> => {
      if (dynamic.length > 0) return dynamic
      dynamic = (await loadDynamicCommands(await hubFromEnv(env, dataDir, io), corePaths)).map((d) => d.spec)
      return dynamic
    }
    try {
      await loadDynamic()
    } catch (err) {
      // 帮助不得因 Hub/凭据/manifest 问题失败：降级为核心帮助 + 独立诊断行（stderr）
      diagnostics.push(`动态插件命令不可用：${describeError(err).message}`)
    }
    if (rest.length === 0) {
      // helm --json 单独使用属于非法组合（帮助是纯文本，不伪造 JSON 输出）
      if (json) return emitError(describeError(new CliError('缺少命令（helm --help 查看用法）', 'missing_command')))
      printHelp(io, core, dynamic, diagnostics)
      return 0
    }
    const matched = matchCommand(core, rest)
    if (matched && matched.consumed >= 0) {
      const cmd = matched.command
      printCommandDetail(io, cmd)
    } else {
      // 非核心命令的帮助：尽力拉动态命令展示其 flag 说明（含 --input 回退说明）
      let dynamicMatched: CommandSpec | undefined
      try {
        const dyn = await loadDynamic()
        const dm = matchCommand(dyn, rest)
        if (dm && dm.consumed >= 0) dynamicMatched = dm.command
      } catch (err) {
        diagnostics.push(`动态插件命令不可用：${describeError(err).message}`)
      }
      if (dynamicMatched !== undefined) printCommandDetail(io, dynamicMatched)
      else printHelp(io, core, dynamic, diagnostics)
    }
    return 0
  }

  // 核心命令精确匹配即直接执行（管理面故障隔离）。
  // 注意：不在此提前拒绝「需要更多子命令」的前缀匹配——若坏插件声明了同名父路径
  // 抢占核心子命令（如动态 ["asks"] 遮蔽核心 asks list），需在拉取 manifest 后才能判定，
  // 因此前缀匹配继续走动态路径并在那里校验。
  const coreMatched = matchCommand(core, rest)
  if (coreMatched !== undefined && coreMatched.consumed > 0) {
    const ctx = makeContext()
    ctx.args = rest.slice(coreMatched.consumed)
    try {
      await coreMatched.command.run(ctx)
      return 0
    } catch (err) {
      return emitError(describeError(err))
    }
  }

  // 无核心精确匹配才解析动态命令（拉 /api/actions + 冲突校验，非法显式报错）。
  // 注意：若存在「需要更多子命令」的核心前缀匹配（如 helm asks list 的 asks），
  // 动态父路径声明可能遮蔽核心子命令——此时必须在执行前拒绝，不让坏插件冒名接管。
  const corePartial = coreMatched !== undefined && coreMatched.consumed < 0 ? coreMatched.command.path : undefined
  let dynamicSpecs: CommandSpec[]
  try {
    dynamicSpecs = (await loadDynamicCommands(await hubFromEnv(env, dataDir, io), corePaths)).map((d) => d.spec)
  } catch (err) {
    return emitError(describeError(err))
  }
  const matched = matchCommand([...core, ...dynamicSpecs], rest)
  if (!matched || matched.consumed < 0) {
    const head = rest.filter((t) => !isOptionLike(t)).slice(0, 2).join(' ')
    return emitError(describeError(new CliError(`未知命令：helm ${head || '(空)'}（helm --help 查看可用命令）`, 'unknown_command')))
  }
  // 动态命令遮蔽了核心命令（全等或前缀）：显式拒绝，绝不静默放行冒名执行
  const isDynamic = !core.some((c) => c === matched.command)
  if (isDynamic && corePartial !== undefined) {
    const joined = matched.command.path.join(' ')
    return emitError(describeError(new CliError(
      `插件动作命令 "helm ${joined}" 抢占核心命令 "helm ${corePartial.join(' ')}" 路径：拒绝执行（请检查插件 cli.command 声明）`,
      'command_conflict',
    )))
  }
  const ctx = makeContext()
  ctx.args = rest.slice(matched.consumed)
  try {
    await matched.command.run(ctx)
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
