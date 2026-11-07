/** 命令级参数解析：严格 flag 声明表驱动，拒绝未知 flag。 */
import { CliError } from './errors.js'

export type FlagType = 'string' | 'number' | 'boolean' | 'json'

export interface FlagSpec {
  /** kebab-case 名，如 'expected-state-seq'。 */
  name: string
  type: FlagType
  required?: boolean
  /** 可重复 flag：每次出现收集一个 string 值，最终类型为 string[]（如 --set/--field）。 */
  repeated?: boolean
  help?: string
}

export interface ParsedArgs {
  positionals: string[]
  /** flag 名（不含 --）-> 已按声明类型转换的值；boolean 裸 flag 为 true；repeated flag 为 string[]。 */
  flags: Map<string, unknown>
}

function coerce(spec: FlagSpec, raw: string): unknown {
  switch (spec.type) {
    case 'string':
      return raw
    case 'number': {
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        throw new CliError(`--${spec.name} 需要数字，实得 "${raw}"`, 'invalid_flag_value')
      }
      return n
    }
    case 'json':
      try {
        return JSON.parse(raw)
      } catch (err) {
        throw new CliError(
          `--${spec.name} 需要合法 JSON：${err instanceof Error ? err.message : String(err)}`,
          'invalid_flag_value',
        )
      }
  }
}

/**
 * 解析一条命令的 argv（不含全局 --json/--help，由 dispatch 剥离）。
 * 支持 `--flag value`、`--flag=value`、`--` 之后全部视为位置参数。
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
        const known = specs.length > 0 ? specs.map((s) => `--${s.name}`).join(' ') : '（无）'
        throw new CliError(`未知选项 --${name}（可用：${known}）`, 'unknown_flag')
      }
      if (spec.type === 'boolean') {
        if (inline === undefined || inline === 'true') flags.set(name, true)
        else if (inline === 'false') flags.set(name, false)
        else throw new CliError(`--${name} 需要 true/false，实得 "${inline}"`, 'invalid_flag_value')
      } else if (spec.repeated) {
        let raw = inline
        if (raw === undefined) {
          const next = argv[i + 1]
          if (next === undefined || (next.startsWith('--') && next.length > 2)) {
            throw new CliError(`--${name} 缺少取值`, 'missing_value')
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
            throw new CliError(`--${name} 缺少取值`, 'missing_value')
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
      throw new CliError(`缺少必填选项 --${spec.name}`, 'missing_required_flag')
    }
  }
  return { positionals, flags }
}

/** 取已类型化 flag 值（类型由声明表保证）。 */
export function flagValue<T>(flags: Map<string, unknown>, name: string): T | undefined {
  return flags.get(name) as T | undefined
}
