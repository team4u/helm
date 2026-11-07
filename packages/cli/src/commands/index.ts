/**
 * 静态核心命令层汇总：按 REST 资源域聚合 coreCommands()。
 * 分发层（index.ts）用本表精确匹配核心命令——管理面故障隔离的根基。
 */
import type { CommandSpec } from './shared.js'
import { CliError } from '../errors.js'
import { authCommands } from './auth.js'
import { conversationsCommands } from './conversations.js'
import { asksCommands } from './asks.js'
import { profilesCommands } from './profiles.js'
import { providersCommands } from './providers.js'
import { nodesCommands } from './nodes.js'
import { envCommands } from './env.js'
import { pluginsCommands } from './plugins.js'
import { workflowsCommands } from './workflows.js'
import { artifactsCommands } from './artifacts.js'
import { skillsCommands } from './skills.js'
import { modelsCommands } from './models.js'
import { searchCommands } from './search.js'
import { apiCommands } from './api.js'

export type { CommandContext, CommandSpec } from './shared.js'
export {
  // 类型/契约
  // —— 数值与位置参数 ——
  parsePositiveInt,
  requirePositional,
  assertNoExtraPositionals,
  // —— 会话目标 ——
  resolveConversationTarget,
  // —— flag 值规整 ——
  coerceTags,
  coerceMetaFlag,
  requireJsonInput,
  readTextFileFlag,
  repeatedValues,
  parseKeyValues,
  parseScalarValue,
  // —— 鉴权 ——
  readPasswordFromStdin,
  authAndSave,
  resolvePasswordFlag,
  // —— 输出/枚举 ——
  printResult,
  printPlainText,
  enumFlag,
  validateEnum,
  parseNoFlags,
} from './shared.js'

/**
 * 静态命令表完整性校验：路径全等唯一 + 互不为前缀。
 * matchCommand 的 exact[0] 只取首个命中，重复/前缀冲突会被静默吞掉——
 * 必须在汇总处显式暴露为内部错误，防止未来新增命令撞路径后悄悄错路由。
 */
function assertCommandTableValid(commands: readonly CommandSpec[]): void {
  const seen = new Map<string, string>()
  for (const cmd of commands) {
    const key = cmd.path.join(' ')
    const dup = seen.get(key)
    if (dup !== undefined) {
      throw new CliError(
        `静态命令表内部错误：路径重复 "${key}"（${dup} 与 ${cmd.description}），会被 matchCommand 静默吞掉`,
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
          `静态命令表内部错误：路径前缀冲突 "${cmd.path.join(' ')}" 吞掉 "${other.path.join(' ')}"`,
          'command_table_conflict',
        )
      }
    }
  }
}

export function coreCommands(): CommandSpec[] {
  const commands = [
    ...authCommands(),
    ...conversationsCommands(),
    ...asksCommands(),
    ...profilesCommands(),
    ...providersCommands(),
    ...nodesCommands(),
    ...envCommands(),
    ...pluginsCommands(),
    ...workflowsCommands(),
    ...artifactsCommands(),
    ...skillsCommands(),
    ...modelsCommands(),
    ...searchCommands(),
    ...apiCommands(),
  ]
  assertCommandTableValid(commands)
  return commands
}
