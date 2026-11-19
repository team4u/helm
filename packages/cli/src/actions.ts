/**
 * Dynamic plugin commands: GET /api/actions ActionManifest -> top-level `helmx <path...>` commands.
 * - Default path: [stripBuiltin(pluginId), actionId]; cli.command can override it completely.
 * - inputSchema.properties -> --kebab-case flags, coerced per JSON Schema type
 *   (kebab-case maps automatically back to camelCase property names; object/array/untyped fields parse as JSON;
 *   positional args are coerced per schema type too, e.g. runId stays string while numeric fields become numbers).
 * - cli.positional: consumes CLI positional arguments into input fields in order; readFileInto reads
 *   an existing local file's UTF-8 contents into the target field (e.g. `workflows run <file>` -> script).
 * - cli.timeoutMs forwards per-action request timeout (0 = no timeout, for long-running actions like workflow run --wait).
 * - Manifests are external inputs: positional/timeoutMs are validated independently on the CLI side
 *   (fields must exist in inputSchema.properties, readFileInto targets must be string,
 *   required positionals must be contiguous, field/target names must not duplicate); invalid entries fail
 *   explicitly without relying on server-side fallbacks.
 * - Properties colliding with reserved names or duplicate kebab-case flags skip dedicated flags (still
 *   passable via whole --input) without disabling the action.
 * - Command path conflicts, empty paths, and core command shadowing all fail explicitly — never silently dropped.
 * - Output is rendered via printValue with zero business-field hardcoding; --json preserves raw output.
 */
import type { ActionManifest, JsonSchema, PluginActionCliPositionalSpec } from '@helmx/protocol'
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

/** Coerce a simple JSON Schema property type to a flag type; object/array/untyped schemas use json (or whole --input). */
function flagTypeOf(schema: unknown): FlagSpec['type'] | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const s = schema as { type?: unknown; enum?: unknown; const?: unknown }
  if (s.type === 'number' || s.type === 'integer') return 'number'
  if (s.type === 'boolean') return 'boolean'
  if (s.type === 'string' || Array.isArray(s.enum) || 'const' in s) return 'string'
  if (s.type === 'object' || s.type === 'array') return 'json'
  // Untyped loose schemas (including $ref / combinators / any JSON value such as workflow args)
  // are parsed as JSON (with server-side schema validation as fallback), preserving fidelity over plain strings.
  return 'json'
}

/**
 * Coerce a positional argument string per its schema property type (matching flag coercion):
 * number/integer -> Number; boolean -> strict true/false; object/array/untyped loose schemas -> JSON.parse
 * (explicit local error on invalid JSON); string -> verbatim.
 * readFileInto file contents always write directly to a string target (verified by manifest validation).
 */
function coercePositionalValue(raw: string, field: string, schema: unknown): unknown {
  const type = flagTypeOf(schema)
  if (type === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      throw new CliError(`positional argument <${field}> requires a number (schema type number/integer), got "${raw}"`, 'invalid_flag_value')
    }
    return n
  }
  if (type === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new CliError(`positional argument <${field}> requires true/false (schema type boolean), got "${raw}"`, 'invalid_flag_value')
  }
  if (type === 'json') {
    try {
      return JSON.parse(raw)
    } catch (err) {
      throw new CliError(
        `positional argument <${field}> requires valid JSON (schema type ${type === 'json' ? 'object/array/untyped' : type}): ${err instanceof Error ? err.message : String(err)}`,
        'invalid_flag_value',
      )
    }
  }
  return raw
}

function kebabCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** Convert schema properties + required into a flag spec list; skipped holds property names unsuitable for standalone flags. */
export function flagsFromSchema(schema: JsonSchema): { flags: FlagSpec[]; skipped: string[] } {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return { flags: [], skipped: [] }
  const properties = (schema as { properties?: unknown }).properties
  if (properties === undefined) return { flags: [], skipped: [] }
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new CliError(`invalid action inputSchema.properties: must be an object`, 'invalid_action_manifest')
  }
  const required = (schema as { required?: unknown }).required
  const requiredNames = new Set(
    Array.isArray(required) && required.every((r) => typeof r === 'string') ? (required as string[]) : [],
  )
  // Two passes: first count how many properties map to each kebab flag name —
  // when multiple properties (e.g. fooBar and foo-bar) collide on the same flag name, skip standalone flags for both (never silently last-wins),
  // requiring whole --input JSON instead (validated on the server).
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
    // Reserved names (--json/--help/--input/--current/-h) cannot become standalone flags either
    if (RESERVED_FLAG_NAMES.has(name) || (kebabCounts.get(name) ?? 0) > 1) {
      skipped.push(rawName)
      continue
    }
    const type = flagTypeOf((properties as Record<string, unknown>)[rawName])
    if (type === undefined) {
      skipped.push(rawName)
      continue // unmappable properties must be passed via whole --input (validated on the server)
    }
    flags.push({ name, type, required: requiredNames.has(rawName) })
  }
  return { flags, skipped }
}

/**
 * Reverse map from kebab flag names back to camelCase/original schema property names.
 * When multiple properties map to the same flag (e.g. fooBar and foo-bar), stores undefined (ambiguous)
 * so callers must use whole --input rather than silently picking the last one.
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

/** Safely read schema.properties: returns undefined when absent or non-object (further validated elsewhere). */
function schemaPropertiesOf(schema: JsonSchema): Record<string, unknown> | undefined {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const properties = (schema as { properties?: unknown }).properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return undefined
  return properties as Record<string, unknown>
}

/**
 * Validate manifest positional specs at the CLI boundary (independent of server-side checks):
 * - field must exist in inputSchema.properties (otherwise CLI cannot enforce required checks on a broken manifest).
 * - readFileInto target must exist and have type 'string' (file contents are UTF-8 text).
 * - required positionals must be contiguous: no required positional may follow an optional one.
 * - field and readFileInto targets must not duplicate across positionals (prevents silent overwrites).
 * - reserved flag names cannot be used as field/readFileInto targets (reserved properties are only set via --input).
 */
function validatePositionals(manifest: ActionManifest): PluginActionCliPositionalSpec[] {
  const raw = manifest.cli?.positional
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new CliError(`action ${manifestLabel(manifest)} cli.positional must be an array`, 'invalid_action_manifest')
  }
  const properties = schemaPropertiesOf(manifest.inputSchema) ?? {}
  const allWriteTargets = new Set<string>()
  let seenOptional = false
  for (const [index, item] of raw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new CliError(`action ${manifestLabel(manifest)} cli.positional[${index}] must be an object`, 'invalid_action_manifest')
    }
    const pos = item as Partial<PluginActionCliPositionalSpec>
    // Reject unknown keys: manifests are external inputs, and typos like `dest` must fail explicitly rather than be silently ignored
    const allowedKeys = new Set(['field', 'required', 'readFileInto'])
    for (const key of Object.keys(pos)) {
      if (!allowedKeys.has(key)) {
        throw new CliError(
          `action ${manifestLabel(manifest)} cli.positional[${index}] contains unknown key "${key}" (only field/required/readFileInto are allowed)`,
          'invalid_action_manifest',
        )
      }
    }
    if (typeof pos.field !== 'string' || pos.field.length === 0) {
      throw new CliError(`action ${manifestLabel(manifest)} cli.positional[${index}].field must be a non-empty string`, 'invalid_action_manifest')
    }
    if (pos.required !== undefined && typeof pos.required !== 'boolean') {
      throw new CliError(
        `action ${manifestLabel(manifest)} cli.positional[${pos.field}].required must be a boolean`,
        'invalid_action_manifest',
      )
    }
    if (pos.readFileInto !== undefined && (typeof pos.readFileInto !== 'string' || pos.readFileInto.length === 0)) {
      throw new CliError(
        `action ${manifestLabel(manifest)} cli.positional[${pos.field}].readFileInto must be a non-empty string field name`,
        'invalid_action_manifest',
      )
    }
    // Reject prototype-polluting keys: assigning __proto__ on plain objects silently alters the prototype (JSON can contain own __proto__ keys)
    for (const dangerous of [pos.field, pos.readFileInto]) {
      if (dangerous !== undefined && (dangerous === '__proto__' || dangerous === 'constructor' || dangerous === 'prototype')) {
        throw new CliError(
          `action ${manifestLabel(manifest)} cli.positional field name "${dangerous}" is forbidden (prototype-polluting key)`,
          'invalid_action_manifest',
        )
      }
    }
    // Register all write targets for this positional to reject any overlap across positionals
    const writeTargets: string[] = pos.readFileInto !== undefined ? [pos.field, pos.readFileInto] : [pos.field]
    for (const t of writeTargets) {
      if (allWriteTargets.has(t)) {
        throw new CliError(
          `action ${manifestLabel(manifest)} cli.positional writes duplicate field "${t}" (field/readFileInto targets must not overlap)`,
          'invalid_action_manifest',
        )
      }
      allWriteTargets.add(t)
    }
    if (!Object.hasOwn(properties, pos.field)) {
      throw new CliError(
        `action ${manifestLabel(manifest)} cli.positional field "${pos.field}" does not exist in inputSchema.properties`,
        'invalid_action_manifest',
      )
    }
    if (RESERVED_FLAG_NAMES.has(kebabCase(pos.field))) {
      throw new CliError(
        `action ${manifestLabel(manifest)} cli.positional field "${pos.field}" collides with a reserved flag name (reserved properties must be passed via --input, not positionally)`,
        'invalid_action_manifest',
      )
    }
    if (pos.readFileInto !== undefined) {
      const targetSchema = properties[pos.readFileInto]
      if (!Object.hasOwn(properties, pos.readFileInto)) {
        throw new CliError(
          `action ${manifestLabel(manifest)} cli.positional "${pos.field}" readFileInto target "${pos.readFileInto}" does not exist in inputSchema.properties`,
          'invalid_action_manifest',
        )
      }
      // Target must explicitly declare type: 'string' (enums/const/other types cannot receive file content)
      const targetDecl = targetSchema as { type?: unknown }
      if (targetDecl === null || typeof targetDecl !== 'object' || targetDecl.type !== 'string') {
        throw new CliError(
          `action ${manifestLabel(manifest)} cli.positional "${pos.field}" readFileInto target "${pos.readFileInto}" must be a type: string property`,
          'invalid_action_manifest',
        )
      }
      if (RESERVED_FLAG_NAMES.has(kebabCase(pos.readFileInto))) {
        throw new CliError(
          `action ${manifestLabel(manifest)} cli.positional "${pos.field}" readFileInto target "${pos.readFileInto}" collides with a reserved flag name`,
          'invalid_action_manifest',
        )
      }
    }
    if (pos.required === true) {
      if (seenOptional) {
        throw new CliError(
          `action ${manifestLabel(manifest)} cli.positional required field "${pos.field}" cannot appear after an optional positional (required positionals must be contiguous)`,
          'invalid_action_manifest',
        )
      }
    } else {
      seenOptional = true
    }
  }
  return raw as PluginActionCliPositionalSpec[]
}

/** Validate manifest cli.timeoutMs: finite number >= 0 (0 means no timeout). */
function validateTimeoutMs(manifest: ActionManifest): number | undefined {
  const raw = manifest.cli?.timeoutMs
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new CliError(
      `action ${manifestLabel(manifest)} cli.timeoutMs must be a finite number >= 0 (0 means no timeout), got ${JSON.stringify(raw)}`,
      'invalid_action_manifest',
    )
  }
  return raw
}

/**
 * Cross-platform path shape check (without regex platform fragility):
 * explicit relative prefixes (./ ../), leading ~ or ~/, or absolute paths on any platform
 * (POSIX /, Windows drive C:\ / C:/ and UNC \\server\share; leading \x on Windows also counts).
 * Everything else (e.g. demo, demo.js) is treated as a plain value (such as a saved workflow name).
 */
function isPathLike(raw: string): boolean {
  // Explicit relative prefixes (forward/backslashes) and ~ home expansion (both separators supported by expandHome)
  if (
    raw.startsWith('./') || raw.startsWith('../') ||
    raw.startsWith('.\\') || raw.startsWith('..\\') ||
    raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')
  ) return true
  if (raw.startsWith('\\') || raw.startsWith('/')) return true // POSIX absolute; Windows root-relative \ and UNC \\ prefix
  // Drive prefix (case-insensitive): C:\x or C:/x; drive-relative c:x counts only with an explicit separator
  if (raw.length >= 3 && raw[1] === ':' && /[a-zA-Z]/.test(raw[0]!) && (raw[2] === '\\' || raw[2] === '/')) return true
  return false
}

/** Expand leading ~ to the user's home directory; leave everything else untouched (Windows separators handled by fs). */
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
 * Resolve a readFileInto positional argument:
 * - Existing regular file -> read UTF-8 contents into the readFileInto target field.
 * - Path-like string that is not a regular file (missing, directory, etc.) -> fail explicitly (never guess or treat as a name).
 * - Non-path string -> coerce per schema type and write to the positional's own field.
 * Non-ENOENT stat/readFile I/O errors (permissions, invalid path, etc.) always propagate explicitly.
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
          `positional argument <${pos.field}> points to a missing path: ${raw}`,
          'positional_file_not_found',
        )
      }
      // Non-path form (e.g. saved workflow name): write to the positional's own field.
      return { field: pos.field, value: coercePositionalValue(raw, pos.field, properties[pos.field]) }
    }
    throw new CliError(
      `positional argument <${pos.field}> failed to read ${raw}: ${err instanceof Error ? err.message : String(err)}`,
      'positional_file_unreadable',
    )
  }
  if (!stat.isFile()) {
    throw new CliError(
      `positional argument <${pos.field}> does not point to a regular file (${raw}${stat.isDirectory() ? ', is a directory' : ''})`,
      'positional_not_a_file',
    )
  }
  let content: string
  try {
    content = await fsp.readFile(target, 'utf-8')
  } catch (err) {
    throw new CliError(
      `positional argument <${pos.field}> failed to read file ${raw}: ${err instanceof Error ? err.message : String(err)}`,
      'positional_file_unreadable',
    )
  }
  return { field: pos.readFileInto!, value: content }
}

/**
 * Map positional arguments in declaration order into the input object:
 * - readFileInto: see resolveReadFilePositional.
 * - Field already supplied via property flag -> explicit conflict error (never silently overwrite).
 * - Required positional omitted without --input -> explicit missing_positional error.
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
          `missing positional argument <${pos.field}> (required by action ${manifest.pluginId}.${manifest.id})`,
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
        `field "${resolved.field}" specified by both --${kebabCase(resolved.field)} and positional <${pos.field}>: provide only one`,
        'conflicting_positional',
      )
    }
    input[resolved.field] = resolved.value
  }
  if (positionals.length > specs.length) {
    throw new CliError(
      `unexpected positional argument(s): ${positionals.slice(specs.length).join(' ')} (action ${manifest.pluginId}.${manifest.id} accepts at most ${specs.length})`,
      'unexpected_positional',
    )
  }
}

interface DynamicCommand {
  spec: CommandSpec
  manifest: ActionManifest
}

/** Convert an ActionManifest into a dynamic CLI CommandSpec (validating path and cli extensions). */
export function dynamicCommandOf(manifest: ActionManifest): DynamicCommand {
  if (manifest.cli?.hidden === true) throw new CliError('hidden', 'hidden_action')
  const segments = manifest.cli?.command ?? [stripBuiltin(manifest.pluginId), manifest.id]
  if (segments.length === 0) throw new CliError(`action ${manifest.pluginId}.${manifest.id} has an empty cli.command path`, 'invalid_command_path')
  for (const seg of segments) {
    if (typeof seg !== 'string' || seg.length === 0 || seg.startsWith('-') || seg.includes(' ') || seg.includes('/') || seg.includes(':')) {
      throw new CliError(
        `action ${manifest.pluginId}.${manifest.id} has invalid cli.command segment "${String(seg)}" (must be non-empty, without spaces/slashes/colons, and not start with '-')`,
        'invalid_command_path',
      )
    }
  }
  const positionals = validatePositionals(manifest)
  const timeoutMs = validateTimeoutMs(manifest)
  const { flags, skipped } = flagsFromSchema(manifest.inputSchema)
  const propertyNames = schemaPropertyNames(manifest.inputSchema)
  const inputHelp = skipped.length > 0
    ? `full input JSON; properties ${skipped.map((s) => `"${s}"`).join(', ')} have no standalone flags (name collision) and must be passed via --input`
    : 'full input JSON (mutually exclusive with property flags and positionals)'
  const description = manifest.cli?.description ?? manifest.description
  const pluginId = manifest.pluginId
  const actionId = manifest.id
  const spec: CommandSpec = {
    path: segments,
    description: `${description} (plugin action ${pluginId}.${actionId})`,
    flags: [
      ...flags,
      { name: 'input', type: 'json', help: inputHelp },
      { name: 'current', type: 'boolean', help: 'attach conversation context from HELMX_CONVERSATION_ID' },
    ],
    positional: positionals.length > 0
      ? positionals.map((p) => (p.required === true ? `<${p.field}>` : `[${p.field}]`)).join(' ')
      : undefined,
    async run(ctx) {
      const { parseFlags } = await import('./args.js')
      // Enforce required checks below rather than in parseFlags (since whole --input satisfies required fields)
      const parseSpecs = [
        ...flags.map((f) => ({ ...f, required: false })),
        { name: 'input', type: 'json' as const },
        { name: 'current', type: 'boolean' as const },
      ]
      const parsed = parseFlags(parseSpecs, ctx.args)
      if (parsed.flags.has('input')) {
        // When using --input, reject any extra positionals (including tokens after `--`) instead of silently dropping them
        if (parsed.positionals.length > 0) {
          throw new CliError(
            `unexpected positional argument(s): ${parsed.positionals.join(' ')} (this command takes no positionals when using --input)`,
            'unexpected_positional',
          )
        }
        for (const flag of flags) {
          if (parsed.flags.has(flag.name)) {
            throw new CliError(`--input and property flag --${flag.name} are mutually exclusive`, 'conflicting_flags')
          }
        }
      } else {
        // When no positionals are declared, reject any positional arguments instead of silently dropping them
        if (positionals.length === 0 && parsed.positionals.length > 0) {
          throw new CliError(
            `unexpected positional argument(s): ${parsed.positionals.join(' ')} (this action accepts no positionals; use --flag or --input)`,
            'unexpected_positional',
          )
        }
      }
      let input: unknown
      if (parsed.flags.has('input')) {
        input = parsed.flags.get('input')
      } else {
        // Null-prototype object prevents __proto__ property assignment from mutating the prototype chain (defense in depth alongside manifest validation)
        const obj: Record<string, unknown> = Object.create(null)
        for (const [flagName, value] of parsed.flags) {
          if (flagName === 'current') continue
          const propName = propertyNames.get(flagName)
          if (propName === undefined) continue
          obj[propName] = value
        }
        // Apply positionals last: conflicts with same-named property flags fail explicitly (never silently overwritten)
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
      // Final required-field check (covers both schema.required and positional.required; skipped when --input is passed, leaving validation to the server)
      if (!parsed.flags.has('input')) {
        const required = (manifest.inputSchema as { required?: unknown }).required
        if (Array.isArray(required)) {
          for (const name of required as string[]) {
            if ((input as Record<string, unknown>)[name] === undefined) {
              const flagName = [...propertyNames.entries()].find(([, n]) => n === name)?.[0]
              throw new CliError(
                `missing required option --${flagName ?? name} (or positional <${name}>)`,
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

/** Verify a dynamic command does not collide with or shadow an existing command path prefix. */
export function assertNoConflict(existingPaths: readonly (readonly string[])[], candidate: readonly string[]): void {
  const joined = candidate.join(' ')
  for (const existing of existingPaths) {
    const other = existing.join(' ')
    if (other === joined) {
      throw new CliError(`plugin action command "helmx ${joined}" conflicts with existing command`, 'command_conflict')
    }
    // Prefix overlap also counts as a conflict to avoid shadowing parent commands (e.g. ["tasks"] intercepting `tasks list`)
    const minLen = Math.min(existing.length, candidate.length)
    if (minLen > 0 && existing.slice(0, minLen).join(' ') === candidate.slice(0, minLen).join(' ')) {
      throw new CliError(
        `plugin action command "helmx ${joined}" has a path prefix conflict with existing command "helmx ${other}"`,
        'command_conflict',
      )
    }
  }
}

export interface DynamicRegistry {
  /** All non-hidden dynamic commands (with their manifest references). */
  commands: DynamicCommand[]
}

/** Fetch /api/actions and build dynamic commands; invalid manifests fail explicitly. */
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
        `duplicate plugin action command "helmx ${key}": registered by both ${prev} and ${manifest.pluginId}.${manifest.id}`,
        'command_conflict',
      )
    }
    seen.set(key, `${manifest.pluginId}.${manifest.id}`)
    taken.push(dyn.spec.path)
    commands.push(dyn)
  }
  return commands
}
