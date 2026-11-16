/**
 * static core command layer aggregate: by REST asset domain aggregate coreCommands().
 * dispatch layer (index.ts) use this table precise match core command - - manage side fault isolated base.
 * workflows / worktrees domain already strip is builtin:workflow plugin action (motion state command).
 */
import { CORE_CLI_COMMAND_PATHS } from '@helm/protocol'
import type { CommandSpec } from './shared.js'
import { CliError } from '../errors.js'
import { authCommands } from './auth.js'
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
  // type/contract
  // - - count value and location parameter - -
  parsePositiveInt,
  requirePositional,
  assertNoExtraPositionals,
  // - - conversation target - -
  resolveConversationTarget,
  // - - flag value rule whole - -
  coerceTags,
  coerceMetaFlag,
  requireJsonInput,
  readTextFileFlag,
  repeatedValues,
  parseKeyValues,
  parseScalarValue,
  // - - authentication - -
  readPasswordFromStdin,
  authAndSave,
  resolvePasswordFlag,
  // - - output/enumeration - -
  printResult,
  printPlainText,
  enumFlag,
  validateEnum,
  parseNoFlags,
} from './shared.js'

/**
 * static command table complete validate: path all etc. unique + mutual do not is prefix.
 * matchCommand  exact[0] only take first hit, duplicate/prefix conflict will by static default swallow - -
 * must in aggregate where explicit expose is internal error, guard against not come new increase command collide path after silently wrong routing.
 */
function assertCommandTableValid(commands: readonly CommandSpec[]): void {
  const seen = new Map<string, string>()
  for (const cmd of commands) {
    const key = cmd.path.join(' ')
    const dup = seen.get(key)
    if (dup !== undefined) {
      throw new CliError(
        `static command table internal error: path duplicate "${key}"(${dup} and ${cmd.description}), will by matchCommand static default swallow`,
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
          `static command table internal error: path prefix conflict "${cmd.path.join(' ')}" swallow "${other.path.join(' ')}"`,
          'command_table_conflict',
        )
      }
    }
  }
  const expected = new Set<string>(CORE_CLI_COMMAND_PATHS)
  for (const key of seen.keys()) {
    if (!expected.has(key)) {
      throw new CliError(
        `static command table internal error: new increase command "${key}" not sync register until @helm/protocol CORE_CLI_COMMAND_PATHS(and inside placement helm-cli skill)`,
        'command_table_conflict',
      )
    }
  }
  for (const key of expected) {
    if (!seen.has(key)) {
      throw new CliError(
        `static command table internal error:CORE_CLI_COMMAND_PATHS in "${key}" in coreCommands() in missing`,
        'command_table_conflict',
      )
    }
  }
}

export function coreCommands(): CommandSpec[] {
  const commands = [
    ...authCommands(),
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
