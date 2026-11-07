/**
 * 静态核心命令层汇总：按 REST 资源域聚合 coreCommands()。
 * 分发层（index.ts）用本表精确匹配核心命令——管理面故障隔离的根基。
 */
import type { CommandSpec } from './shared.js'
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

export function coreCommands(): CommandSpec[] {
  return [
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
}
