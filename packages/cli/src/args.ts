/** Command-level argument parser: strictly driven by a flag spec table; rejects unknown flags. */
import { CliError } from './errors.js'

export type FlagType = 'string' | 'number' | 'boolean' | 'json'

export interface FlagSpec {
  /** Flag name in kebab-case, e.g. 'expected-state-seq'. */
  name: string
  type: FlagType
  required?: boolean
  /** Repeatable flag: collects each occurrence as a string into a final string[] (e.g. --set/--field). */
  repeated?: boolean
  help?: string
}

export interface ParsedArgs {
  positionals: string[]
  /** Flag name (without `--`) -> value coerced per spec; bare boolean flags default to true; repeated flags produce string[]. */
  flags: Map<string, unknown>
}

function coerce(spec: FlagSpec, raw: string): unknown {
  switch (spec.type) {
    case 'string':
      return raw
    case 'number': {
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        throw new CliError(`--${spec.name} requires a number, got "${raw}"`, 'invalid_flag_value')
      }
      return n
    }
    case 'json':
      try {
        return JSON.parse(raw)
      } catch (err) {
        throw new CliError(
          `--${spec.name} requires valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          'invalid_flag_value',
        )
      }
  }
}

/**
 * Parse a command's argv (excluding global --json/--help already stripped by the dispatcher).
 * Supports `--flag value`, `--flag=value`, and treating everything after `--` as positional arguments.
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
        const known = specs.length > 0 ? specs.map((s) => `--${s.name}`).join(' ') : '(none)'
        throw new CliError(`unknown option --${name} (available: ${known})`, 'unknown_flag')
      }
      if (spec.type === 'boolean') {
        if (inline === undefined || inline === 'true') flags.set(name, true)
        else if (inline === 'false') flags.set(name, false)
        else throw new CliError(`--${name} requires true/false, got "${inline}"`, 'invalid_flag_value')
      } else if (spec.repeated) {
        let raw = inline
        if (raw === undefined) {
          const next = argv[i + 1]
          if (next === undefined || (next.startsWith('--') && next.length > 2)) {
            throw new CliError(`--${name} is missing a value`, 'missing_value')
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
            throw new CliError(`--${name} is missing a value`, 'missing_value')
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

/** Read a typed flag value (type safety guaranteed by the flag spec table). */
export function flagValue<T>(flags: Map<string, unknown>, name: string): T | undefined {
  return flags.get(name) as T | undefined
}
