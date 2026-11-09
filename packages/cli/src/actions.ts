/**
 * 动态插件命令：GET /api/actions 的 ActionManifest -> 顶层 `helm <path...>` 命令。
 * - 默认路径 [stripBuiltin(pluginId), actionId]；cli.command 可整体改写。
 * - inputSchema.properties -> --kebab-case flag，按 JSON Schema 类型转换
 *   （kebab-case 自动映射 camelCase 属性；object/array/无类型按 JSON 解析）。
 * - cli.positional：按序消费 CLI 位置参数写入 input 字段；readFileInto 把
 *   本地文件内容（UTF-8）写入目标字段（如 `workflows run <file>` -> script）。
 * - cli.timeoutMs 透传请求超时（0 = 无超时，供长耗时动作如 workflow run --wait）。
 * - 与保留名/同 kebab 冲突的属性跳过独立 flag（仍可经整体 --input 表达），不禁用动作。
 * - 命令路径冲突/空路径/抢占核心命令路径均显式报错，绝不静默丢弃。
 */
import type { ActionManifest, JsonSchema, PluginActionCliPositionalSpec } from '@helm/protocol'
import { CliError } from './errors.js'
import type { HubClient } from './hub-client.js'
import type { CommandContext, CommandSpec } from './commands/index.js'
import { resolveConversationTarget } from './commands/index.js'
import { printValue } from './output.js'
import type { Io } from './options.js'
import type { FlagSpec } from './args.js'

const RESERVED_FLAG_NAMES = new Set(['json', 'help', 'input', 'current', 'h'])

function stripBuiltin(pluginId: string): string {
  return pluginId.startsWith('builtin:') ? pluginId.slice('builtin:'.length) : pluginId
}

/** JSON Schema 简单类型 -> flag 类型；object/array/无类型用 json（或整体 --input）。 */
function flagTypeOf(schema: unknown): FlagSpec['type'] | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const s = schema as { type?: unknown; enum?: unknown; const?: unknown }
  if (s.type === 'number' || s.type === 'integer') return 'number'
  if (s.type === 'boolean') return 'boolean'
  if (s.type === 'string' || Array.isArray(s.enum) || 'const' in s) return 'string'
  if (s.type === 'object' || s.type === 'array') return 'json'
  // 无 type 的宽松 schema（含 $ref/组合词/任意 JSON 值如 workflow args）按
  // JSON 传递（服务端 schema 校验兜底），比字符串更保真。
  return 'json'
}

function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** schema properties + required -> flag 声明表；skipped 为无法/不宜生成独立 flag 的属性名。 */
export function flagsFromSchema(schema: JsonSchema): { flags: FlagSpec[]; skipped: string[] } {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return { flags: [], skipped: [] }
  const properties = (schema as { properties?: unknown }).properties
  if (properties === undefined) return { flags: [], skipped: [] }
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new CliError(`动作 inputSchema.properties 形状非法：必须是对象`, 'invalid_action_manifest')
  }
  const required = (schema as { required?: unknown }).required
  const requiredNames = new Set(
    Array.isArray(required) && required.every((r) => typeof r === 'string') ? (required as string[]) : [],
  )
  // 两遍：先统计全部属性名映射到同一 kebab flag 的次数——
  // 多个属性（fooBar 与 foo-bar）撞同一 flag 名时全部跳过独立 flag（绝不静默 last-wins），
  // 只允许经整体 --input JSON 表达（服务端 schema 校验兜底）。
  const rawNames = Object.keys(properties as Record<string, unknown>)
  const kebabCounts = new Map<string, number>()
  for (const rawName of rawNames) {
    const key = kebabCase(rawName)
    kebabCounts.set(key, (kebabCounts.get(key) ?? 0) + 1)
  }
  const flags: FlagSpec[] = []
  const skipped: string[] = []
  for (const rawName of rawNames) {
    const name = kebabCase(rawName)
    // 保留名（--json/--help/--input/--current/-h）同样不可作为独立 flag
    if (RESERVED_FLAG_NAMES.has(name) || (kebabCounts.get(name) ?? 0) > 1) {
      skipped.push(rawName)
      continue
    }
    const type = flagTypeOf((properties as Record<string, unknown>)[rawName])
    if (type === undefined) {
      skipped.push(rawName)
      continue // 无法映射的属性留给整体 --input 提交（服务端校验兜底）
    }
    flags.push({ name, type, required: requiredNames.has(rawName) })
  }
  return { flags, skipped }
}

/**
 * camelCase / 原名 -> kebab flag 名反查：flag 名 -> schema 属性名。
 * 多个属性映射到同一 flag 名（fooBar 与 foo-bar）时置 undefined（歧义），
 * 调用方只允许经整体 --input 表达，绝不静默 last-wins。
 */
function schemaPropertyNames(schema: JsonSchema): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>()
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return map
  const properties = (schema as { properties?: unknown }).properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return map
  for (const rawName of Object.keys(properties as Record<string, unknown>)) {
    const key = kebabCase(rawName)
    map.set(key, map.has(key) ? undefined : rawName)
  }
  return map
}

/**
 * 位置参数映射：按声明顺序消费 parsed.positionals，写入 input 字段。
 * - readFileInto：值是本地已存在文件（或以 ./ ../ / ~ 开头的路径形态）时读
 *   UTF-8 文本写入目标字段；路径形态但文件不存在显式报错（不猜含义）。
 * - required：位置参数与 --input 均未提供该字段时显式报缺失。
 */
async function applyPositionals(
  manifest: ActionManifest,
  positionals: readonly string[],
  input: Record<string, unknown>,
  hasWholeInput: boolean,
): Promise<void> {
  const specs: PluginActionCliPositionalSpec[] = manifest.cli?.positional ?? []
  for (const [index, pos] of specs.entries()) {
    const raw = positionals[index]
    if (raw === undefined) {
      if (pos.required === true && !hasWholeInput && input[pos.field] === undefined) {
        throw new CliError(
          `缺少位置参数 <${pos.field}>（动作 ${manifest.pluginId}.${manifest.id} 必填）`,
          'missing_positional',
        )
      }
      continue
    }
    if (pos.readFileInto !== undefined) {
      const looksLikePath = raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/') || raw.startsWith('~/')
      const fsp = await import('node:fs/promises')
      const pathMod = await import('node:path')
      const target = raw.startsWith('~/') ? pathMod.join(process.env.HOME ?? '~', raw.slice(2)) : raw
      let stat: Awaited<ReturnType<typeof fsp.stat>> | undefined
      try {
        stat = await fsp.stat(target)
      } catch {
        stat = undefined
      }
      if (stat?.isFile() === true) {
        input[pos.readFileInto] = await fsp.readFile(target, 'utf-8')
        continue
      }
      if (looksLikePath) {
        throw new CliError(
          `位置参数 <${pos.field}> 指向的文件不存在：${raw}`,
          'positional_file_not_found',
        )
      }
      // 非路径形态（如已保存工作流名）：写入 field 本身。
      input[pos.field] = raw
      continue
    }
    input[pos.field] = raw
  }
  if (positionals.length > specs.length) {
    throw new CliError(
      `多余位置参数：${positionals.slice(specs.length).join(' ')}（动作 ${manifest.pluginId}.${manifest.id} 仅接受 ${specs.length} 个）`,
      'unexpected_positional',
    )
  }
}

/**
 * 动作结果友好展示（非 --json）：识别常见形状输出摘要/表格，未知形状回
 * 退通用 printValue。这里只做展示层适配，不改变数据。
 */
function printActionResult(io: Io, result: unknown, json: boolean): void {
  if (json || result === null || typeof result !== 'object' || Array.isArray(result)) {
    printValue(io, result, json)
    return
  }
  const record = result as Record<string, unknown>
  // { run: WorkflowRunSummary }
  if ('run' in record && record['run'] !== null && typeof record['run'] === 'object') {
    const run = record['run'] as { id?: string; status?: string; result?: unknown; error?: string; conversationId?: number }
    if (typeof run.id === 'string' && typeof run.status === 'string') {
      io.out(`run ${run.id} ${run.status}\n`)
      if (run.result !== undefined) {
        printValue(io, run.result, false)
      } else if (run.error !== undefined) {
        io.out(`${String(run.error)}\n`)
      }
      return
    }
  }
  // { runs: [...] } / { workflows: [...] }
  for (const key of ['runs', 'workflows'] as const) {
    const list = record[key]
    if (Array.isArray(list)) {
      printValue(io, list, false)
      return
    }
  }
  // worktree cleanup 结果（removed/path/branch/nodeId/branchDeleted 形状）
  if (
    typeof record['removed'] === 'boolean' &&
    typeof record['path'] === 'string' &&
    typeof record['branch'] === 'string' &&
    typeof record['nodeId'] === 'string' &&
    typeof record['branchDeleted'] === 'boolean'
  ) {
    io.out(
      record['removed']
        ? `已移除受管 worktree ${record['path']}（branch: ${record['branch']}，节点 ${record['nodeId']}${record['branchDeleted'] ? '，分支已删除' : '，分支保留'}）\n`
        : `受管 worktree ${record['path']} 此前已清理（幂等跳过；branch: ${record['branch']}${record['branchDeleted'] ? '，分支已删除' : ''}）\n`,
    )
    return
  }
  printValue(io, result, false)
}

interface DynamicCommand {
  spec: CommandSpec
  manifest: ActionManifest
}

/** manifest -> 动态命令（含路径校验）。 */
export function dynamicCommandOf(manifest: ActionManifest): DynamicCommand {
  if (manifest.cli?.hidden === true) throw new CliError('hidden', 'hidden_action')
  const segments = manifest.cli?.command ?? [stripBuiltin(manifest.pluginId), manifest.id]
  if (segments.length === 0) throw new CliError(`动作 ${manifest.pluginId}.${manifest.id} 的 cli.command 为空路径`, 'invalid_command_path')
  for (const seg of segments) {
    if (typeof seg !== 'string' || seg.length === 0 || seg.startsWith('-') || seg.includes(' ') || seg.includes('/') || seg.includes(':')) {
      throw new CliError(
        `动作 ${manifest.pluginId}.${manifest.id} 的 cli.command 段非法："${String(seg)}"（需非空、不含空格/斜杠/冒号、不以 - 开头）`,
        'invalid_command_path',
      )
    }
  }
  const { flags, skipped } = flagsFromSchema(manifest.inputSchema)
  const propertyNames = schemaPropertyNames(manifest.inputSchema)
  const positionals = manifest.cli?.positional ?? []
  const timeoutMs = manifest.cli?.timeoutMs
  const inputHelp = skipped.length > 0
    ? `整体 input JSON；属性 ${skipped.map((s) => `"${s}"`).join(', ')} 无独立 flag（名称冲突），只能经 --input 表达`
    : '整体 input JSON（与属性 flag 互斥）'
  const description = manifest.cli?.description ?? manifest.description
  const pluginId = manifest.pluginId
  const actionId = manifest.id
  const spec: CommandSpec = {
    path: segments,
    description: `${description}（插件动作 ${pluginId}.${actionId}）`,
    flags: [
      ...flags,
      { name: 'input', type: 'json', help: inputHelp },
      { name: 'current', type: 'boolean', help: '附带 env HELM_CONVERSATION_ID 会话上下文' },
    ],
    positional: positionals.length > 0
      ? positionals.map((p) => (p.required === true ? `<${p.field}>` : `[${p.field}]`)).join(' ')
      : undefined,
    async run(ctx) {
      const { parseFlags } = await import('./args.js')
      // required 语义由本函数自行判定（--input 整体提交可满足必填），传入解析器前剥离
      const parseSpecs = [
        ...flags.map((f) => ({ ...f, required: false })),
        { name: 'input', type: 'json' as const },
        { name: 'current', type: 'boolean' as const },
      ]
      const parsed = parseFlags(parseSpecs, ctx.args)
      if (parsed.flags.has('input')) {
        // 动作无位置参数语义时，额外位置参数（含 -- 之后）显式拒绝，绝不无声丢弃。
        if (parsed.positionals.length > 0) {
          throw new CliError(
            `多余位置参数：${parsed.positionals.join(' ')}（该动作不接受位置参数；请用 --input 整体表达）`,
            'unexpected_positional',
          )
        }
        for (const flag of flags) {
          if (parsed.flags.has(flag.name)) {
            throw new CliError(`--input 与属性 flag --${flag.name} 互斥`, 'conflicting_flags')
          }
        }
      } else {
        // 动作未声明位置参数时，任何位置参数显式拒绝（绝不无声丢弃）。
        if (positionals.length === 0 && parsed.positionals.length > 0) {
          throw new CliError(
            `多余位置参数：${parsed.positionals.join(' ')}（该动作不接受位置参数；参数请用 --flag 或 --input）`,
            'unexpected_positional',
          )
        }
      }
      let input: unknown
      if (parsed.flags.has('input')) {
        input = parsed.flags.get('input')
      } else {
        const obj: Record<string, unknown> = {}
        for (const [flagName, value] of parsed.flags) {
          if (flagName === 'current') continue
          const propName = propertyNames.get(flagName)
          if (propName === undefined) continue
          obj[propName] = value
        }
        // 位置参数最后消费（属性 flag 之后；重复字段时位置参数覆盖 flag 更直观）
        await applyPositionals(manifest, parsed.positionals, obj, false)
        input = obj
      }
      // 必填字段终检（schema required + positional.required 均覆盖：
      // --input 整体提交跳过逐项检查，服务端 schema 校验兜底）
      if (!parsed.flags.has('input')) {
        const required = (manifest.inputSchema as { required?: unknown }).required
        if (Array.isArray(required)) {
          for (const name of required as string[]) {
            if ((input as Record<string, unknown>)[name] === undefined) {
              const flagName = [...propertyNames.entries()].find(([, n]) => n === name)?.[0]
              throw new CliError(
                `缺少必填参数 --${flagName ?? name}（或 <${name}> 位置参数）`,
                'missing_required_flag',
              )
            }
          }
        }
      }
      const body: Record<string, unknown> = { input }
      if (parsed.flags.get('current') === true) {
        body.conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
      }
      const hub = await ctx.hub()
      const result = await hub.request<unknown>(
        'POST',
        `/api/actions/${encodeURIComponent(pluginId)}/${encodeURIComponent(actionId)}`,
        { body, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
      )
      printActionResult(ctx.io, result, ctx.json)
    },
  }
  return { spec, manifest }
}

/** 校验动态命令不与既有命令冲突、不抢占核心路径前缀。 */
export function assertNoConflict(existingPaths: readonly (readonly string[])[], candidate: readonly string[]): void {
  const joined = candidate.join(' ')
  for (const existing of existingPaths) {
    const other = existing.join(' ')
    if (other === joined) {
      throw new CliError(`插件动作命令 "helm ${joined}" 与既有命令冲突`, 'command_conflict')
    }
    // 互为前缀也算冲突：避免遮蔽核心父命令（如 ["tasks"] 会拦截 tasks list 之类）
    const minLen = Math.min(existing.length, candidate.length)
    if (minLen > 0 && existing.slice(0, minLen).join(' ') === candidate.slice(0, minLen).join(' ')) {
      throw new CliError(
        `插件动作命令 "helm ${joined}" 与既有命令 "helm ${other}" 路径前缀冲突`,
        'command_conflict',
      )
    }
  }
}

export interface DynamicRegistry {
  /** 全部非 hidden 动态命令（含 manifest 引用）。 */
  commands: DynamicCommand[]
}

/** 拉取 /api/actions 并构建动态命令；manifest 非法项显式报错。 */
export async function loadDynamicCommands(hub: HubClient, corePaths: readonly (readonly string[])[]): Promise<DynamicCommand[]> {
  const manifests = await hub.get<ActionManifest[]>('/api/actions')
  if (!Array.isArray(manifests)) {
    throw new CliError('GET /api/actions 响应需为数组', 'invalid_response')
  }
  const taken: (readonly string[])[] = [...corePaths]
  const commands: DynamicCommand[] = []
  const seen = new Map<string, string>() // path -> pluginId.actionId
  for (const manifest of manifests) {
    let dyn: DynamicCommand
    try {
      dyn = dynamicCommandOf(manifest)
    } catch (err) {
      if (err instanceof CliError && err.code === 'hidden_action') continue
      throw err
    }
    assertNoConflict(taken, dyn.spec.path)
    const key = dyn.spec.path.join(' ')
    const prev = seen.get(key)
    if (prev) {
      throw new CliError(
        `插件动作命令 "helm ${key}" 重复注册：${prev} 与 ${manifest.pluginId}.${manifest.id}`,
        'command_conflict',
      )
    }
    seen.set(key, `${manifest.pluginId}.${manifest.id}`)
    taken.push(dyn.spec.path)
    commands.push(dyn)
  }
  return commands
}
