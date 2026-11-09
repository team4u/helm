/**
 * 动态插件命令：GET /api/actions 的 ActionManifest -> 顶层 `helm <path...>` 命令。
 * - 默认路径 [stripBuiltin(pluginId), actionId]；cli.command 可整体改写。
 * - inputSchema.properties -> --kebab-case flag，按 JSON Schema 类型转换
 *   （kebab-case 自动映射 camelCase 属性；object/array/无类型按 JSON 解析；
 *   位置参数同样按 schema 类型转换，如 runId 保持 string、数值字段转数字）。
 * - cli.positional：按序消费 CLI 位置参数写入 input 字段；readFileInto 把
 *   本地已存在文件的内容（UTF-8）写入目标字段（如 `workflows run <file>` -> script）。
 * - cli.timeoutMs 透传请求超时（0 = 无超时，供长耗时动作如 workflow run --wait）。
 * - manifest 是外部输入：positional/timeoutMs 在 CLI 侧独立校验
 *   （字段需存在于 inputSchema.properties、readFileInto 目标为 string、
 *   required positional 连续、field/目标不得重复），非法即显式报错，
 *   不依赖服务端兜底。
 * - 与保留名/同 kebab 冲突的属性跳过独立 flag（仍可经整体 --input 表达），不禁用动作。
 * - 命令路径冲突/空路径/抢占核心命令路径均显式报错，绝不静默丢弃。
 * - 结果输出走通用 printValue，展示层零业务字段识别；--json 原样保真。
 */
import type { ActionManifest, JsonSchema, PluginActionCliPositionalSpec } from '@helm/protocol'
import path from 'node:path'
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

function manifestLabel(manifest: ActionManifest): string {
  return `${manifest.pluginId}.${manifest.id}`
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

/**
 * 位置参数字符串按 schema 属性类型转换（与 flag 同纪律）：
 * number/integer -> Number；boolean 严格 true/false；object/array/无 type
 * 宽松 schema -> JSON.parse（非法 JSON 本地显式报错）；string 原样。
 * readFileInto 的文件内容同理只写 string 目标（manifest 校验已保证）。
 */
function coercePositionalValue(raw: string, field: string, schema: unknown): unknown {
  const type = flagTypeOf(schema)
  if (type === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      throw new CliError(`位置参数 <${field}> 需要数字（schema type number/integer），实得 "${raw}"`, 'invalid_flag_value')
    }
    return n
  }
  if (type === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new CliError(`位置参数 <${field}> 需要 true/false（schema type boolean），实得 "${raw}"`, 'invalid_flag_value')
  }
  if (type === 'json') {
    try {
      return JSON.parse(raw)
    } catch (err) {
      throw new CliError(
        `位置参数 <${field}> 需要合法 JSON（schema type ${type === 'json' ? 'object/array/未声明' : type}）：${err instanceof Error ? err.message : String(err)}`,
        'invalid_flag_value',
      )
    }
  }
  return raw
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

/** schema.properties 形状安全读取：无 properties/非对象时返回 undefined（额外字段校验另行报错）。 */
function schemaPropertiesOf(schema: JsonSchema): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const properties = (schema as { properties?: unknown }).properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return undefined
  return properties as Record<string, unknown>
}

/**
 * manifest 侧 positional 校验（外部输入在 CLI 边界显式校验，不依赖服务端）：
 * - field 必须存在于 inputSchema.properties（不存在则 CLI 无法回填必填检查，
 *   必为坏清单）。
 * - readFileInto 目标必须存在且 schema type 为 string（文件内容是 UTF-8 文本）。
 * - required positional 必须连续：optional 出现后不得再出现 required
 *   （否则中间缺参无法定位，属歧义清单）。
 * - field 与 readFileInto 目标均不得重复（重复回填互相覆盖）。
 * - 位置参数与属性 flag 同源：field/readFileInto 目标撞保留 flag 名时经 flag 提供，
 *   位置参数回填会破坏「保留名属性仅 --input 可达」约定，直接拒绝。
 */
function validatePositionals(manifest: ActionManifest): PluginActionCliPositionalSpec[] {
  const raw = manifest.cli?.positional
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new CliError(`动作 ${manifestLabel(manifest)} 的 cli.positional 必须是数组`, 'invalid_action_manifest')
  }
  const properties = schemaPropertiesOf(manifest.inputSchema) ?? {}
  const allWriteTargets = new Set<string>()
  let seenOptional = false
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new CliError(`动作 ${manifestLabel(manifest)} 的 cli.positional[${index}] 必须是对象`, 'invalid_action_manifest')
    }
    const pos = item as Partial<PluginActionCliPositionalSpec>
    // 拒绝未知键：manifest 是外部输入，多余字段（拼写错位的 declared/dest 等）
    // 多半是写错了声明，静默忽略会伪装成生效
    const allowedKeys = new Set(['field', 'required', 'readFileInto'])
    for (const key of Object.keys(pos)) {
      if (!allowedKeys.has(key)) {
        throw new CliError(
          `动作 ${manifestLabel(manifest)} 的 cli.positional[${index}] 含未知键 "${key}"（仅允许 field/required/readFileInto）`,
          'invalid_action_manifest',
        )
      }
    }
    if (typeof pos.field !== 'string' || pos.field.length === 0) {
      throw new CliError(`动作 ${manifestLabel(manifest)} 的 cli.positional[${index}].field 必须是非空字符串`, 'invalid_action_manifest')
    }
    if (pos.required !== undefined && typeof pos.required !== 'boolean') {
      throw new CliError(
        `动作 ${manifestLabel(manifest)} 的 cli.positional[${pos.field}].required 必须是 boolean`,
        'invalid_action_manifest',
      )
    }
    if (pos.readFileInto !== undefined && (typeof pos.readFileInto !== 'string' || pos.readFileInto.length === 0)) {
      throw new CliError(
        `动作 ${manifestLabel(manifest)} 的 cli.positional[${pos.field}].readFileInto 必须是非空字符串字段名`,
        'invalid_action_manifest',
      )
    }
    // 原型污染键拒绝：普通对象上 __proto__ 赋值会静默丢失/改写原型（JSON 文本
    // 可携带自有 __proto__ 键），constructor/prototype 同理不可安全往返
    for (const dangerous of [pos.field, pos.readFileInto]) {
      if (dangerous !== undefined && (dangerous === '__proto__' || dangerous === 'constructor' || dangerous === 'prototype')) {
        throw new CliError(
          `动作 ${manifestLabel(manifest)} 的 cli.positional 字段名 "${dangerous}" 不可用（原型污染键）`,
          'invalid_action_manifest',
        )
      }
    }
    // 先登记本项目标再查重复：顺序无关地拒绝任何两个 positional 写入同一字段
    // （field:src+readFileInto:payload 与后续 field:payload 互相覆盖，两个 read 同目标同理）。
    const writeTargets: string[] = pos.readFileInto !== undefined ? [pos.field, pos.readFileInto] : [pos.field]
    for (const t of writeTargets) {
      if (allWriteTargets.has(t)) {
        throw new CliError(
          `动作 ${manifestLabel(manifest)} 的 cli.positional 重复写入字段 "${t}"（field/readFileInto 目标不得重叠）`,
          'invalid_action_manifest',
        )
      }
      allWriteTargets.add(t)
    }
    if (!Object.hasOwn(properties, pos.field)) {
      throw new CliError(
        `动作 ${manifestLabel(manifest)} 的 cli.positional field "${pos.field}" 不在 inputSchema.properties 中`,
        'invalid_action_manifest',
      )
    }
    if (RESERVED_FLAG_NAMES.has(kebabCase(pos.field))) {
      throw new CliError(
        `动作 ${manifestLabel(manifest)} 的 cli.positional field "${pos.field}" 撞保留 flag 名（保留名属性仅可经 --input 表达，不能作为位置参数）`,
        'invalid_action_manifest',
      )
    }
    if (pos.readFileInto !== undefined) {
      const targetSchema = properties[pos.readFileInto]
      if (!Object.hasOwn(properties, pos.readFileInto)) {
        throw new CliError(
          `动作 ${manifestLabel(manifest)} 的 cli.positional "${pos.field}" 的 readFileInto 目标 "${pos.readFileInto}" 不在 inputSchema.properties 中`,
          'invalid_action_manifest',
        )
      }
      // 目标必须是真正的 type:'string'（枚举/const/其他形态都不接受文件内容）
      const targetDecl = targetSchema as { type?: unknown }
      if (targetDecl === null || typeof targetDecl !== 'object' || targetDecl.type !== 'string') {
        throw new CliError(
          `动作 ${manifestLabel(manifest)} 的 cli.positional "${pos.field}" 的 readFileInto 目标 "${pos.readFileInto}" 需为 type: string 属性`,
          'invalid_action_manifest',
        )
      }
      if (RESERVED_FLAG_NAMES.has(kebabCase(pos.readFileInto))) {
        throw new CliError(
          `动作 ${manifestLabel(manifest)} 的 cli.positional "${pos.field}" 的 readFileInto 目标 "${pos.readFileInto}" 撞保留 flag 名`,
          'invalid_action_manifest',
        )
      }
    }
    if (pos.required === true) {
      if (seenOptional) {
        throw new CliError(
          `动作 ${manifestLabel(manifest)} 的 cli.positional required 字段 "${pos.field}" 出现在 optional 之后（required 必须连续）`,
          'invalid_action_manifest',
        )
      }
    } else {
      seenOptional = true
    }
  }
  return raw as PluginActionCliPositionalSpec[]
}

/** manifest 侧 cli.timeoutMs 校验：>= 0 的有限数字（0 表示无超时）。 */
function validateTimeoutMs(manifest: ActionManifest): number | undefined {
  const raw = manifest.cli?.timeoutMs
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new CliError(
      `动作 ${manifestLabel(manifest)} 的 cli.timeoutMs 必须是 >= 0 的有限数字（0 表示无超时），实得 ${JSON.stringify(raw)}`,
      'invalid_action_manifest',
    )
  }
  return raw
}

/**
 * 路径形态判定（跨平台，基于 node:path 判定而非正则）：
 * 显式相对前缀（./ ../）、~ 或 ~/ 开头、或任一平台视角下的绝对路径
 * （POSIX /、win32 盘符 C:\ / C:/ 与 UNC \\server\share；windows 上 \x 也算）。
 * 其余（demo、demo.js）视为普通值（如已保存工作流名）。
 */
function isPathLike(raw: string): boolean {
  // 显式相对前缀（正/反斜杠两形态）与 ~ 展开（两种分隔符，expandHome 同步支持）
  if (
    raw.startsWith('./') || raw.startsWith('../') ||
    raw.startsWith('.\\') || raw.startsWith('..\\') ||
    raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
  ) return true
  if (raw.startsWith('\\') || raw.startsWith('/')) return true // POSIX 绝对；win32 \\ 根相对与 UNC 同前缀
  // 盘符前缀（不区分大小写）：C:\x、C:/x、盘符相对 c:x 仅显式分隔符形态算路径
  if (raw.length >= 3 && raw[1] === ':' && /[a-zA-Z]/.test(raw[0]!) && (raw[2] === '\\' || raw[2] === '/')) return true
  return false
}

/** 解析 ~ 前缀为用户主目录；其余原样（win32 的路径分隔符由 fs 自行处理）。 */
function expandHome(raw: string, env: NodeJS.ProcessEnv): string {
  if (raw === '~') return env['HOME'] ?? env['USERPROFILE'] ?? raw
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    const home = env['HOME'] ?? env['USERPROFILE']
    if (home === undefined) return raw
    return path.join(home, raw.slice(2))
  }
  return raw
}

/**
 * readFileInto 位置参数解析：
 * - 已存在普通文件 -> UTF-8 内容写入 readFileInto 目标。
 * - 路径形态但目标不是普通文件（缺失/目录等）-> 显式报错（不猜含义、不静默当名字）。
 * - 非路径形态 -> 按 schema 类型转换后写入 field 本身。
 * stat/readFile 的非 ENOENT IO 故障（权限、非法路径等）显式上抛，绝不吞掉。
 */
async function resolveReadFilePositional(
  manifest: ActionManifest,
  pos: PluginActionCliPositionalSpec,
  raw: string,
  properties: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<{ field: string; value: unknown }> {
  const fsp = await import('node:fs/promises')
  const target = expandHome(raw, env)
  let stat: Awaited<ReturnType<typeof fsp.stat>>
  try {
    stat = await fsp.stat(target)
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (isPathLike(raw)) {
        throw new CliError(
          `位置参数 <${pos.field}> 指向的路径不存在：${raw}`,
          'positional_file_not_found',
        )
      }
      // 非路径形态（如已保存工作流名）：写入 field 本身。
      return { field: pos.field, value: coercePositionalValue(raw, pos.field, properties[pos.field]) }
    }
    throw new CliError(
      `位置参数 <${pos.field}> 读取 ${raw} 失败：${err instanceof Error ? err.message : String(err)}`,
      'positional_file_unreadable',
    )
  }
  if (!stat.isFile()) {
    throw new CliError(
      `位置参数 <${pos.field}> 指向的不是普通文件（${raw}${stat.isDirectory() ? '，是目录' : ''}）`,
      'positional_not_a_file',
    )
  }
  let content: string
  try {
    content = await fsp.readFile(target, 'utf-8')
  } catch (err) {
    throw new CliError(
      `位置参数 <${pos.field}> 读取文件 ${raw} 失败：${err instanceof Error ? err.message : String(err)}`,
      'positional_file_unreadable',
    )
  }
  return { field: pos.readFileInto!, value: content }
}

/**
 * 位置参数映射：按声明顺序消费 parsed.positionals，写入 input 字段。
 * - readFileInto：见 resolveReadFilePositional。
 * - 已由属性 flag 提供的字段再给位置参数：显式冲突报错（不悄悄覆盖）。
 * - required：位置参数与 --input 均未提供该字段时显式报缺失。
 */
async function applyPositionals(
  manifest: ActionManifest,
  positionals: readonly string[],
  input: Record<string, unknown>,
  hasWholeInput: boolean,
  properties: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
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
    const resolved =
      pos.readFileInto !== undefined
        ? await resolveReadFilePositional(manifest, pos, raw, properties, env)
        : { field: pos.field, value: coercePositionalValue(raw, pos.field, properties[pos.field]) }
    if (input[resolved.field] !== undefined) {
      throw new CliError(
        `字段 ${resolved.field} 同时由 --${kebabCase(resolved.field)} flag 与位置参数 <${pos.field}> 提供：请只给一处`,
        'conflicting_positional',
      )
    }
    input[resolved.field] = resolved.value
  }
  if (positionals.length > specs.length) {
    throw new CliError(
      `多余位置参数：${positionals.slice(specs.length).join(' ')}（动作 ${manifest.pluginId}.${manifest.id} 仅接受 ${specs.length} 个）`,
      'unexpected_positional',
    )
  }
}

interface DynamicCommand {
  spec: CommandSpec
  manifest: ActionManifest
}

/** manifest -> 动态命令（含路径与 cli 扩展字段校验）。 */
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
  const positionals = validatePositionals(manifest)
  const timeoutMs = validateTimeoutMs(manifest)
  const { flags, skipped } = flagsFromSchema(manifest.inputSchema)
  const propertyNames = schemaPropertyNames(manifest.inputSchema)
  const inputHelp = skipped.length > 0
    ? `整体 input JSON；属性 ${skipped.map((s) => `"${s}"`).join(', ')} 无独立 flag（名称冲突），只能经 --input 表达`
    : '整体 input JSON（与属性 flag/位置参数互斥）'
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
        // null 原型：字段名即使为 __proto__ 也只写为自有属性，绝不改写原型链
        //（manifest 校验已拒绝原型污染键，这里是无声丢弃的纵深防御）
        const obj: Record<string, unknown> = Object.create(null)
        for (const [flagName, value] of parsed.flags) {
          if (flagName === 'current') continue
          const propName = propertyNames.get(flagName)
          if (propName === undefined) continue
          obj[propName] = value
        }
        // 位置参数最后消费：与属性 flag 提供同名字段时显式冲突报错（绝不悄悄覆盖）
        await applyPositionals(
          manifest,
          parsed.positionals,
          obj,
          false,
          schemaPropertiesOf(manifest.inputSchema) ?? {},
          ctx.env,
        )
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
