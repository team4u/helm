/** command level parameter parse: strictly flag declaration table drive, reject unknown flag. */
import { CliError } from './errors.js'

export type FlagType = 'string' | 'number' | 'boolean' | 'json'

export interface FlagSpec {
  /** kebab-case name, such as 'expected-state-seq'. */
  name: string
  type: FlagType
  required?: boolean
  /** can duplicate flag: each time appear collect a string value, eventually type is string[](such as --set/--field). */
  repeated?: boolean
  help?: string
}

export interface ParsedArgs {
  positionals: string[]
  /** flag name (excludes --)-> already by declaration type convert value;boolean bare flag is true;repeated flag is string[]. */
  flags: Map<string, unknown>
}

function coerce(spec: FlagSpec, raw: string): unknown {
  switch (spec.type) {
    case 'string':
      return raw
    case 'number': {
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        throw new CliError(`--${spec.name} need to number, got "${raw}"`, 'invalid_flag_value')
      }
      return n
    }
    case 'json':
      try {
        return JSON.parse(raw)
      } catch (err) {
        throw new CliError(
          `--${spec.name} need to legal JSON:${err instanceof Error ? err.message : String(err)}`,
          'invalid_flag_value',
        )
      }
  }
}

/**
 * parse a command argv(excludes global --json/--help, by dispatch strip).
 * support `--flag value`,`--flag=value`,`--` after all treated as location parameter.
 */
export function parseFlags(specs: readonly FlagSpec[], argv: readonly string[]): ParsedArgs {
  const byName = new Map(specs.map((s) => [s.name, s] as const))
  const flags = new Map<string, unknown>()
  const positionals: string[] = []
  let i = 0
  while (i < argv.length) {
    const token = argv[i]!
    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=')
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
      const inline = eq === -1 ? undefined : token.slice(eq + 1)
      const spec = byName.get(name)
      if (!spec) {
        const known = specs.length > 0 ? specs.map((s) => `--${s.name}`).join(' ') : '(without)'
        throw new CliError(`unknown option --${name}(available:${known})`, 'unknown_flag')
      }
      if (spec.type === 'boolean') {
        if (inline === undefined || inline === 'true') flags.set(name, true)
        else if (inline === 'false') flags.set(name, false)
        else throw new CliError(`--${name} need to true/false, got "${inline}"`, 'invalid_flag_value')
      } else if (spec.repeated) {
        let raw = inline
        if (raw === undefined) {
          const next = argv[i + 1]
          if (next === undefined || (next.startsWith('--') && next.length > 2)) {
            throw new CliError(`--${name} missing value`, 'missing_value')
          }
          raw = next
          i += 1
        }
        const list = (flags.get(name) as string[] | undefined) ?? []
        list.push(raw)
        flags.set(name, list)
      } else {
        let raw = inline
        if (raw === undefined) {
          const next = argv[i + 1]
          if (next === undefined || (next.startsWith('--') && next.length > 2)) {
            throw new CliError(`--${name} missing value`, 'missing_value')
          }
          raw = next
          i += 1
        }
        flags.set(name, coerce(spec, raw))
      }
    } else {
      positionals.push(token)
    }
    i += 1
  }
  for (const spec of specs) {
    if (spec.required && !flags.has(spec.name)) {
      throw new CliError(`missing required option --${spec.name}`, 'missing_required_flag')
    }
  }
  return { positionals, flags }
}

/** take already type flag value (type by declaration table guarantee). */
export function flagValue<T>(flags: Map<string, unknown>, name: string): T | undefined {
  return flags.get(name) as T | undefined
}
