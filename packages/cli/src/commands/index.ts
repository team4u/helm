/**
 * Static core command registry: aggregates coreCommands() across REST resource domains.
 * The dispatcher (index.ts) uses this table for exact core command matching — the basis for management-plane fault isolation.
 * The workflows / worktrees domains have been extracted into builtin:workflow plugin actions (dynamic commands).
 */
import { CORE_CLI_COMMAND_PATHS } from '@helmx/protocol'
import type { CommandSpec } from './shared.js'
import { CliError } from '../errors.js'
import { authCommands } from './auth.js'
import { updateCommand } from './update.js'
import { conversationsCommands } from './conversations.js'
import { askCommands } from './ask.js'
import { asksCommands } from './asks.js'
import { profilesCommands } from './profiles.js'
import { providersCommands } from './providers.js'
import { nodesCommands } from './nodes.js'
import { envCommands } from './env.js'
import { pluginsCommands } from './plugins.js'
import { artifactsCommands } from './artifacts.js'
import { skillsCommands } from './skills.js'
import { modelsCommands } from './models.js'
import { searchCommands } from './search.js'
import { apiCommands } from './api.js'

export type { CommandContext, CommandSpec } from './shared.js'
export {
  // types / helpers
  // -- numeric & positional args --
  parsePositiveInt,
  requirePositional,
  assertNoExtraPositionals,
  // -- conversation target --
  resolveConversationTarget,
  // -- flag value normalization --
  coerceTags,
  coerceMetaFlag,
  requireJsonInput,
  readTextFileFlag,
  repeatedValues,
  parseKeyValues,
  parseScalarValue,
  // -- authentication --
  readPasswordFromStdin,
  authAndSave,
  resolvePasswordFlag,
  // -- output / enums --
  printResult,
  printPlainText,
  enumFlag,
  validateEnum,
  parseNoFlags,
} from './shared.js'

/**
 * Static command table integrity check: all paths must be identical-unique and prefix-disjoint.
 * Since matchCommand returns only the first match in exact[0], duplicate or prefix collisions would
 * be silently swallowed — expose them explicitly here so future commands cannot misroute quietly.
 */
function assertCommandTableValid(commands: readonly CommandSpec[]): void {
  const seen = new Map<string, string>()
  for (const cmd of commands) {
    const key = cmd.path.join(' ')
    const dup = seen.get(key)
    if (dup !== undefined) {
      throw new CliError(
        `static command table internal error: duplicate path "${key}" (${dup} and ${cmd.description}), which matchCommand would silently shadow`,
        'command_table_conflict',
      )
    }
    seen.set(key, cmd.description)
  }
  for (const cmd of commands) {
    for (const other of commands) {
      if (cmd === other || other.path.length >= cmd.path.length) continue
      if (other.path.every((seg, i) => seg === cmd.path[i])) {
        throw new CliError(
          `static command table internal error: path prefix conflict "${cmd.path.join(' ')}" shadows "${other.path.join(' ')}"`,
          'command_table_conflict',
        )
      }
    }
  }
  const expected = new Set<string>(CORE_CLI_COMMAND_PATHS)
  for (const key of seen.keys()) {
    if (!expected.has(key)) {
      throw new CliError(
        `static command table internal error: new command "${key}" is not registered in @helmx/protocol CORE_CLI_COMMAND_PATHS (and the built-in helmx-cli skill)`,
        'command_table_conflict',
      )
    }
  }
  for (const key of expected) {
    if (!seen.has(key)) {
      throw new CliError(
        `static command table internal error: "${key}" from CORE_CLI_COMMAND_PATHS is missing in coreCommands()`,
        'command_table_conflict',
      )
    }
  }
}

export function coreCommands(): CommandSpec[] {
  const commands = [
    ...authCommands(),
    updateCommand,
    ...conversationsCommands(),
    ...askCommands(),
    ...asksCommands(),
    ...profilesCommands(),
    ...providersCommands(),
    ...nodesCommands(),
    ...envCommands(),
    ...pluginsCommands(),
    ...artifactsCommands(),
    ...skillsCommands(),
    ...modelsCommands(),
    ...searchCommands(),
    ...apiCommands(),
  ]
  assertCommandTableValid(commands)
  return commands
}
