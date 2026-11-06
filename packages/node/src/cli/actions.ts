/**
 * 动态插件命令：GET /api/actions 的 ActionManifest -> 顶层 `helm <path...>` 命令。
 * - 默认路径 [stripBuiltin(pluginId), actionId]；cli.command 可整体改写。
 * - inputSchema.properties -> --kebab-case flag，按 JSON Schema 类型转换。
 * - 冲突/空路径/抢占核心命令路径均显式报错，绝不静默丢弃。
 */
import type { ActionManifest, JsonSchema } from '@helm/protocol'
import { CliError } from './errors.js'
import type { HubClient } from './hub-client.js'
import type { CommandContext, CommandSpec } from './commands.js'
import { resolveConversationTarget } from './commands.js'
import type { FlagSpec } from './args.js'

const RESERVED_FLAG_NAMES = new Set(['json', 'help', 'input', 'current', 'h'])

function stripBuiltin(pluginId: string): string {
  return pluginId.startsWith('builtin:') ? pluginId.slice('builtin:'.length) : pluginId
}

/** JSON Schema 简单类型 -> flag 类型；object/array 用 json（或整体 --input）。 */
function flagTypeOf(schema: unknown): FlagSpec['type'] | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const s = schema as { type?: unknown; enum?: unknown; const?: unknown }
  if (s.type === 'number' || s.type === 'integer') return 'number'
  if (s.type === 'boolean') return 'boolean'
  if (s.type === 'string' || Array.isArray(s.enum) || 'const' in s) return 'string'
  if (s.type === 'object' || s.type === 'array') return 'json'
  // 无 type 的宽松 schema（含 $ref/组合词）按字符串传递，由服务端校验
  return 'string'
}

function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** schema properties + required -> flag 声明表。 */
export function flagsFromSchema(schema: JsonSchema): FlagSpec[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return []
  const properties = (schema as { properties?: unknown }).properties
  if (properties === undefined) return []
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new CliError(`动作 inputSchema.properties 形状非法：必须是对象`, 'invalid_action_manifest')
  }
  const required = (schema as { required?: unknown }).required
  const requiredNames = new Set(
    Array.isArray(required) && required.every((r) => typeof r === 'string') ? (required as string[]) : [],
  )
  const specs: FlagSpec[] = []
  for (const [rawName, propSchema] of Object.entries(properties as Record<string, unknown>)) {
    const name = kebabCase(rawName)
    if (RESERVED_FLAG_NAMES.has(name)) {
      throw new CliError(
        `动作属性 "${rawName}" 生成的 flag --${name} 与保留名冲突`,
        'action_flag_conflict',
      )
    }
    const type = flagTypeOf(propSchema)
    if (type === undefined) continue // 无法映射的属性静默留给 --input 整体提交（服务端校验兜底）
    specs.push({ name, type, required: requiredNames.has(rawName) })
  }
  return specs
}

/** camelCase / 原名 -> kebab flag 名反查：flag 名 -> schema 属性名。 */
function schemaPropertyNames(schema: JsonSchema): Map<string, string> {
  const map = new Map<string, string>()
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return map
  const properties = (schema as { properties?: unknown }).properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return map
  for (const rawName of Object.keys(properties as Record<string, unknown>)) {
    map.set(kebabCase(rawName), rawName)
  }
  return map
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
  const flags = flagsFromSchema(manifest.inputSchema)
  const propertyNames = schemaPropertyNames(manifest.inputSchema)
  const description = manifest.cli?.description ?? manifest.description
  const pluginId = manifest.pluginId
  const actionId = manifest.id
  const spec: CommandSpec = {
    path: segments,
    description: `${description}（插件动作 ${pluginId}.${actionId}）`,
    flags: [
      ...flags,
      { name: 'input', type: 'json', help: '整体 input JSON（与属性 flag 互斥）' },
      { name: 'current', type: 'boolean', help: '附带 env HELM_CONVERSATION_ID 会话上下文' },
    ],
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
        for (const flag of flags) {
          if (parsed.flags.has(flag.name)) {
            throw new CliError(`--input 与属性 flag --${flag.name} 互斥`, 'conflicting_flags')
          }
        }
      }
      for (const flag of flags) {
        if (flag.required && !parsed.flags.has(flag.name) && !parsed.flags.has('input')) {
          throw new CliError(`缺少必填选项 --${flag.name}`, 'missing_required_flag')
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
        input = obj
      }
      const body: Record<string, unknown> = { input }
      if (parsed.flags.get('current') === true) {
        body.conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
      }
      const hub = await ctx.hub()
      const result = await hub.post<unknown>(
        `/api/actions/${encodeURIComponent(pluginId)}/${encodeURIComponent(actionId)}`,
        body,
      )
      const { printValue } = await import('./output.js')
      printValue(ctx.io, result, ctx.json)
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
