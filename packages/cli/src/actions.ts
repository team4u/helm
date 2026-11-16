/**
 * motion state plugin command:GET /api/actions  ActionManifest -> top-level `helm <path...>` command.
 * - by default path [stripBuiltin(pluginId), actionId];cli.command can whole change write.
 * - inputSchema.properties -> --kebab-case flag, by JSON Schema type convert
 *   (kebab-case automatically mapping camelCase property;object/array/without type by JSON parse;
 *   location parameter same by schema type convert, such as runId keep string, count value field rotate number).
 * - cli.positional: by order consume CLI location parameter write input field;readFileInto 
 *   local already exists file content (UTF-8) write target field (such as `workflows run <file>` -> script).
 * - cli.timeoutMs pass-through request timeout (0 = without timeout, supply long time cost action such as workflow run --wait).
 * - manifest is external input:positional/timeoutMs in CLI side independent validate
 *   (field must store in at inputSchema.properties,readFileInto target is string,
 *   required positional connect continue,field/target must not duplicate), illegal i.e. explicit errors,
 *   independent of server side fall back.
 * - and keep name/same kebab conflict property skip independent flag(still can via whole --input express), do not disable action.
 * - command path conflict/empty path/preempt core command path all explicit errors, never static default discard.
 * - result output away through use printValue, render layer zero business field identify;--json original fidelity.
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

/** JSON Schema simple type -> flag type;object/array/without type use json(or whole --input). */
function flagTypeOf(schema: unknown): FlagSpec['type'] | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const s = schema as { type?: unknown; enum?: unknown; const?: unknown }
  if (s.type === 'number' || s.type === 'integer') return 'number'
  if (s.type === 'boolean') return 'boolean'
  if (s.type === 'string' || Array.isArray(s.enum) || 'const' in s) return 'string'
  if (s.type === 'object' || s.type === 'array') return 'json'
  // without type loosely schema(contains $ref/combine term/any JSON value such as workflow args) by
  // JSON pass (server side schema validate fall back), than string more fidelity.
  return 'json'
}

/**
 * location parameter string by schema property type convert (and flag same discipline):
 * number/integer -> Number;boolean strictly true/false;object/array/without type
 * loosely schema -> JSON.parse(illegal JSON local explicit errors);string original.
 * readFileInto file content same only write string target (manifest validate already guarantee).
 */
function coercePositionalValue(raw: string, field: string, schema: unknown): unknown {
  const type = flagTypeOf(schema)
  if (type === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      throw new CliError(`location parameter <${field}> need to number (schema type number/integer), got "${raw}"`, 'invalid_flag_value')
    }
    return n
  }
  if (type === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new CliError(`location parameter <${field}> need to true/false(schema type boolean), got "${raw}"`, 'invalid_flag_value')
  }
  if (type === 'json') {
    try {
      return JSON.parse(raw)
    } catch (err) {
      throw new CliError(
        `location parameter <${field}> need to legal JSON(schema type ${type === 'json' ? 'object/array/not declaration' : type}):${err instanceof Error ? err.message : String(err)}`,
        'invalid_flag_value',
      )
    }
  }
  return raw
}

function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** schema properties + required -> flag declaration table;skipped is cannot/do not appropriate generate independent flag property name. */
export function flagsFromSchema(schema: JsonSchema): { flags: FlagSpec[]; skipped: string[] } {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return { flags: [], skipped: [] }
  const properties = (schema as { properties?: unknown }).properties
  if (properties === undefined) return { flags: [], skipped: [] }
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new CliError(`action inputSchema.properties shape illegal: must be object`, 'invalid_action_manifest')
  }
  const required = (schema as { required?: unknown }).required
  const requiredNames = new Set(
    Array.isArray(required) && required.every((r) => typeof r === 'string') ? (required as string[]) : [],
  )
  // two iterate: first count all property name mapping to the same kebab flag time count - -
  // multiple property (fooBar and foo-bar) collide the same flag name when all skip independent flag(never static default last-wins),
  // only allows via whole --input JSON express (server side schema validate fall back).
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
    // keep name (--json/--help/--input/--current/-h) same cannot as independent flag
    if (RESERVED_FLAG_NAMES.has(name) || (kebabCounts.get(name) ?? 0) > 1) {
      skipped.push(rawName)
      continue
    }
    const type = flagTypeOf((properties as Record<string, unknown>)[rawName])
    if (type === undefined) {
      skipped.push(rawName)
      continue // cannot mapping property to whole --input commit (server side validate fall back)
    }
    flags.push({ name, type, required: requiredNames.has(rawName) })
  }
  return { flags, skipped }
}

/**
 * camelCase / original name -> kebab flag name reverse inspect:flag name -> schema property name.
 * multiple property mapping to the same flag name (fooBar and foo-bar) when placement undefined(ambiguity),
 * caller only allows via whole --input express, never static default last-wins.
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

/** schema.properties shape security read: without properties/non- object when return undefined(extra field validate another row errors). */
function schemaPropertiesOf(schema: JsonSchema): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const properties = (schema as { properties?: unknown }).properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return undefined
  return properties as Record<string, unknown>
}

/**
 * manifest side positional validate (external input in CLI boundary explicit validate, independent of server side):
 * - field must store in at inputSchema.properties(missing then CLI cannot back fill required check,
 *   must is broken manifest).
 * - readFileInto target must store in and schema type is string(file content is UTF-8 text).
 * - required positional must connect continue:optional appear after must not again appear required
 *   (otherwise middle missing reference cannot locate, belong ambiguity manifest).
 * - field and readFileInto target all must not duplicate (duplicate back fill mutual each other override).
 * - location parameter and property flag same source:field/readFileInto target collide keep flag name when via flag provide,
 *   location parameter back fill will break keep name property only --input can reach convention, directly reject.
 */
function validatePositionals(manifest: ActionManifest): PluginActionCliPositionalSpec[] {
  const raw = manifest.cli?.positional
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new CliError(`action ${manifestLabel(manifest)}  cli.positional must be array`, 'invalid_action_manifest')
  }
  const properties = schemaPropertiesOf(manifest.inputSchema) ?? {}
  const allWriteTargets = new Set<string>()
  let seenOptional = false
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new CliError(`action ${manifestLabel(manifest)}  cli.positional[${index}] must be object`, 'invalid_action_manifest')
    }
    const pos = item as Partial<PluginActionCliPositionalSpec>
    // reject unknown key:manifest is external input, redundant field (piece together write wrong declared/dest etc.)
    // many half is write wrong declaration, static default ignore will disguise into takes effect
    const allowedKeys = new Set(['field', 'required', 'readFileInto'])
    for (const key of Object.keys(pos)) {
      if (!allowedKeys.has(key)) {
        throw new CliError(
          `action ${manifestLabel(manifest)}  cli.positional[${index}] contains unknown key "${key}"(only allows field/required/readFileInto)`,
          'invalid_action_manifest',
        )
      }
    }
    if (typeof pos.field !== 'string' || pos.field.length === 0) {
      throw new CliError(`action ${manifestLabel(manifest)}  cli.positional[${index}].field must be non-empty string`, 'invalid_action_manifest')
    }
    if (pos.required !== undefined && typeof pos.required !== 'boolean') {
      throw new CliError(
        `action ${manifestLabel(manifest)}  cli.positional[${pos.field}].required must be boolean`,
        'invalid_action_manifest',
      )
    }
    if (pos.readFileInto !== undefined && (typeof pos.readFileInto !== 'string' || pos.readFileInto.length === 0)) {
      throw new CliError(
        `action ${manifestLabel(manifest)}  cli.positional[${pos.field}].readFileInto must be non-empty string field name`,
        'invalid_action_manifest',
      )
    }
    // prototype pollute key reject: ordinary object on __proto__ assignment will static default lose/change write prototype (JSON text
    // can carry self has __proto__ key),constructor/prototype same cannot security to return
    for (const dangerous of [pos.field, pos.readFileInto]) {
      if (dangerous !== undefined && (dangerous === '__proto__' || dangerous === 'constructor' || dangerous === 'prototype')) {
        throw new CliError(
          `action ${manifestLabel(manifest)}  cli.positional field name "${dangerous}" unavailable (prototype pollute key)`,
          'invalid_action_manifest',
        )
      }
    }
    // first register this items target again inspect duplicate: order without closure ground reject any two positional write the same field
    // (field:src+readFileInto:payload and after continue field:payload mutual each other override, two read same target same).
    const writeTargets: string[] = pos.readFileInto !== undefined ? [pos.field, pos.readFileInto] : [pos.field]
    for (const t of writeTargets) {
      if (allWriteTargets.has(t)) {
        throw new CliError(
          `action ${manifestLabel(manifest)}  cli.positional duplicate write field "${t}"(field/readFileInto target must not overlap)`,
          'invalid_action_manifest',
        )
      }
      allWriteTargets.add(t)
    }
    if (!Object.hasOwn(properties, pos.field)) {
      throw new CliError(
        `action ${manifestLabel(manifest)}  cli.positional field "${pos.field}" do not in inputSchema.properties in`,
        'invalid_action_manifest',
      )
    }
    if (RESERVED_FLAG_NAMES.has(kebabCase(pos.field))) {
      throw new CliError(
        `action ${manifestLabel(manifest)}  cli.positional field "${pos.field}" collide keep flag name (keep name property only can via --input express, cannot as location parameter)`,
        'invalid_action_manifest',
      )
    }
    if (pos.readFileInto !== undefined) {
      const targetSchema = properties[pos.readFileInto]
      if (!Object.hasOwn(properties, pos.readFileInto)) {
        throw new CliError(
          `action ${manifestLabel(manifest)}  cli.positional "${pos.field}"  readFileInto target "${pos.readFileInto}" do not in inputSchema.properties in`,
          'invalid_action_manifest',
        )
      }
      // target must be truly type:'string'(enumeration/const/other form all do not accept file content)
      const targetDecl = targetSchema as { type?: unknown }
      if (targetDecl === null || typeof targetDecl !== 'object' || targetDecl.type !== 'string') {
        throw new CliError(
          `action ${manifestLabel(manifest)}  cli.positional "${pos.field}"  readFileInto target "${pos.readFileInto}" must be type: string property`,
          'invalid_action_manifest',
        )
      }
      if (RESERVED_FLAG_NAMES.has(kebabCase(pos.readFileInto))) {
        throw new CliError(
          `action ${manifestLabel(manifest)}  cli.positional "${pos.field}"  readFileInto target "${pos.readFileInto}" collide keep flag name`,
          'invalid_action_manifest',
        )
      }
    }
    if (pos.required === true) {
      if (seenOptional) {
        throw new CliError(
          `action ${manifestLabel(manifest)}  cli.positional required field "${pos.field}" appear in optional after (required must connect continue)`,
          'invalid_action_manifest',
        )
      }
    } else {
      seenOptional = true
    }
  }
  return raw as PluginActionCliPositionalSpec[]
}

/** manifest side cli.timeoutMs validate:>= 0 finite number (0 means without timeout). */
function validateTimeoutMs(manifest: ActionManifest): number | undefined {
  const raw = manifest.cli?.timeoutMs
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new CliError(
      `action ${manifestLabel(manifest)}  cli.timeoutMs must be >= 0 finite number (0 means without timeout), got ${JSON.stringify(raw)}`,
      'invalid_action_manifest',
    )
  }
  return raw
}

/**
 * path form decide (across platform, based on node:path decide while non- regex):
 * explicit each other for prefix (./ ../),~ or ~/ open head, or any one platform perspective under absolute path
 * (POSIX /,win32 symbol C:\ / C:/ and UNC \\server\share;windows on \x also compute).
 * the rest (demo,demo.js) treated as ordinary value (such as already save workflow name).
 */
function isPathLike(raw: string): boolean {
  // explicit each other for prefix (correct/backslash two form) and ~ expand (two kinds of isolate symbol,expandHome sync support)
  if (
    raw.startsWith('./') || raw.startsWith('../') ||
    raw.startsWith('.\\') || raw.startsWith('..\\') ||
    raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
  ) return true
  if (raw.startsWith('\\') || raw.startsWith('/')) return true // POSIX absolute;win32 \\ each other for and UNC same prefix
  // symbol prefix (does not distinguish large small write):C:\x,C:/x, symbol each other for c:x only explicit isolate symbol form compute path
  if (raw.length >= 3 && raw[1] === ':' && /[a-zA-Z]/.test(raw[0]!) && (raw[2] === '\\' || raw[2] === '/')) return true
  return false
}

/** parse ~ prefix is user main directory; the rest original (win32 path isolate symbol by fs self row handle). */
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
 * readFileInto location parameter parse:
 * - already exists ordinary file -> UTF-8 content write readFileInto target.
 * - path form but target is not ordinary file (missing/directory etc.)-> explicit errors (do not guess contains meaning, not silently when name).
 * - non- path form -> by schema type convert after write field itself.
 * stat/readFile non- ENOENT IO fault (permission, illegal path etc.) explicit on throw, never swallow.
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
          `location parameter <${pos.field}> points to path missing:${raw}`,
          'positional_file_not_found',
        )
      }
      // non- path form (such as already save workflow name): write field itself.
      return { field: pos.field, value: coercePositionalValue(raw, pos.field, properties[pos.field]) }
    }
    throw new CliError(
      `location parameter <${pos.field}> read ${raw} failed:${err instanceof Error ? err.message : String(err)}`,
      'positional_file_unreadable',
    )
  }
  if (!stat.isFile()) {
    throw new CliError(
      `location parameter <${pos.field}> points to is not ordinary file (${raw}${stat.isDirectory() ? ', is directory' : ''})`,
      'positional_not_a_file',
    )
  }
  let content: string
  try {
    content = await fsp.readFile(target, 'utf-8')
  } catch (err) {
    throw new CliError(
      `location parameter <${pos.field}> read file ${raw} failed:${err instanceof Error ? err.message : String(err)}`,
      'positional_file_unreadable',
    )
  }
  return { field: pos.readFileInto!, value: content }
}

/**
 * location parameter mapping: by declaration order consume parsed.positionals, write input field.
 * - readFileInto: see resolveReadFilePositional.
 * - already by property flag provide field again to location parameter: explicit conflict errors (do not silently override).
 * - required: location parameter and --input all not provide the field when explicit report missing.
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
          `missing location parameter <${pos.field}>(action ${manifest.pluginId}.${manifest.id} required)`,
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
        `field ${resolved.field} also by --${kebabCase(resolved.field)} flag and location parameter <${pos.field}> provide: please only to one where`,
        'conflicting_positional',
      )
    }
    input[resolved.field] = resolved.value
  }
  if (positionals.length > specs.length) {
    throw new CliError(
      `redundant location parameter:${positionals.slice(specs.length).join(' ')}(action ${manifest.pluginId}.${manifest.id} only accept ${specs.length} )`,
      'unexpected_positional',
    )
  }
}

interface DynamicCommand {
  spec: CommandSpec
  manifest: ActionManifest
}

/** manifest -> motion state command (contains path and cli extend field validate). */
export function dynamicCommandOf(manifest: ActionManifest): DynamicCommand {
  if (manifest.cli?.hidden === true) throw new CliError('hidden', 'hidden_action')
  const segments = manifest.cli?.command ?? [stripBuiltin(manifest.pluginId), manifest.id]
  if (segments.length === 0) throw new CliError(`action ${manifest.pluginId}.${manifest.id}  cli.command is empty path`, 'invalid_command_path')
  for (const seg of segments) {
    if (typeof seg !== 'string' || seg.length === 0 || seg.startsWith('-') || seg.includes(' ') || seg.includes('/') || seg.includes(':')) {
      throw new CliError(
        `action ${manifest.pluginId}.${manifest.id}  cli.command segment illegal:"${String(seg)}"(must non-empty, excludes space/slash/smoke number, do not with - open head)`,
        'invalid_command_path',
      )
    }
  }
  const positionals = validatePositionals(manifest)
  const timeoutMs = validateTimeoutMs(manifest)
  const { flags, skipped } = flagsFromSchema(manifest.inputSchema)
  const propertyNames = schemaPropertyNames(manifest.inputSchema)
  const inputHelp = skipped.length > 0
    ? `whole input JSON; property ${skipped.map((s) => `"${s}"`).join(', ')} without independent flag(name conflict), only can via --input express`
    : 'whole input JSON(and property flag/location parameter mutual exclusion)'
  const description = manifest.cli?.description ?? manifest.description
  const pluginId = manifest.pluginId
  const actionId = manifest.id
  const spec: CommandSpec = {
    path: segments,
    description: `${description}(plugin action ${pluginId}.${actionId})`,
    flags: [
      ...flags,
      { name: 'input', type: 'json', help: inputHelp },
      { name: 'current', type: 'boolean', help: 'attach carries env HELM_CONVERSATION_ID conversation context' },
    ],
    positional: positionals.length > 0
      ? positionals.map((p) => (p.required === true ? `<${p.field}>` : `[${p.field}]`)).join(' ')
      : undefined,
    async run(ctx) {
      const { parseFlags } = await import('./args.js')
      // required semantics by this function self row decide (--input whole commit can satisfy required), pass parse before strip
      const parseSpecs = [
        ...flags.map((f) => ({ ...f, required: false })),
        { name: 'input', type: 'json' as const },
        { name: 'current', type: 'boolean' as const },
      ]
      const parsed = parseFlags(parseSpecs, ctx.args)
      if (parsed.flags.has('input')) {
        // action without location parameter semantics when, extra location parameter (contains -- after) explicit reject, never without sound discard.
        if (parsed.positionals.length > 0) {
          throw new CliError(
            `redundant location parameter:${parsed.positionals.join(' ')}(the action do not accept location parameter; please use --input whole express)`,
            'unexpected_positional',
          )
        }
        for (const flag of flags) {
          if (parsed.flags.has(flag.name)) {
            throw new CliError(`--input and property flag --${flag.name} mutual exclusion`, 'conflicting_flags')
          }
        }
      } else {
        // action not declaration location parameter when, any location parameter explicit reject (never without sound discard).
        if (positionals.length === 0 && parsed.positionals.length > 0) {
          throw new CliError(
            `redundant location parameter:${parsed.positionals.join(' ')}(the action do not accept location parameter; parameter please use --flag or --input)`,
            'unexpected_positional',
          )
        }
      }
      let input: unknown
      if (parsed.flags.has('input')) {
        input = parsed.flags.get('input')
      } else {
        // null prototype: field name even if is __proto__ also only write is self has property, never change write prototype chain
        //(manifest validate already reject prototype pollute key, this in is without sound discard in depth guard against defend)
        const obj: Record<string, unknown> = Object.create(null)
        for (const [flagName, value] of parsed.flags) {
          if (flagName === 'current') continue
          const propName = propertyNames.get(flagName)
          if (propName === undefined) continue
          obj[propName] = value
        }
        // location parameter finally consume: and property flag provide same name segment when explicit conflict errors (never silently override)
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
      // required field final inspect (schema required + positional.required all override:
      // --input whole commit skip one by one items check, server side schema validate fall back)
      if (!parsed.flags.has('input')) {
        const required = (manifest.inputSchema as { required?: unknown }).required
        if (Array.isArray(required)) {
          for (const name of required as string[]) {
            if ((input as Record<string, unknown>)[name] === undefined) {
              const flagName = [...propertyNames.entries()].find(([, n]) => n === name)?.[0]
              throw new CliError(
                `missing required parameter --${flagName ?? name}(or <${name}> location parameter)`,
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

/** validate motion state command do not and since has command conflict, do not preempt core path prefix. */
export function assertNoConflict(existingPaths: readonly (readonly string[])[], candidate: readonly string[]): void {
  const joined = candidate.join(' ')
  for (const existing of existingPaths) {
    const other = existing.join(' ')
    if (other === joined) {
      throw new CliError(`plugin action command "helm ${joined}" and since has command conflict`, 'command_conflict')
    }
    // mutual is prefix also compute conflict: avoid obscure core parent command (such as ["tasks"] will intercept tasks list of class)
    const minLen = Math.min(existing.length, candidate.length)
    if (minLen > 0 && existing.slice(0, minLen).join(' ') === candidate.slice(0, minLen).join(' ')) {
      throw new CliError(
        `plugin action command "helm ${joined}" and since has command "helm ${other}" path prefix conflict`,
        'command_conflict',
      )
    }
  }
}

export interface DynamicRegistry {
  /** all non- hidden motion state command (contains manifest reference). */
  commands: DynamicCommand[]
}

/** pull /api/actions and build motion state command;manifest illegal items explicit errors. */
export async function loadDynamicCommands(hub: HubClient, corePaths: readonly (readonly string[])[]): Promise<DynamicCommand[]> {
  const manifests = await hub.get<ActionManifest[]>('/api/actions')
  if (!Array.isArray(manifests)) {
    throw new CliError('GET /api/actions response must be an array', 'invalid_response')
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
        `plugin action command "helm ${key}" duplicate register:${prev} and ${manifest.pluginId}.${manifest.id}`,
        'command_conflict',
      )
    }
    seen.set(key, `${manifest.pluginId}.${manifest.id}`)
    taken.push(dyn.spec.path)
    commands.push(dyn)
  }
  return commands
}
