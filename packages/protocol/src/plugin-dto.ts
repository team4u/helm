/**
 * 跨端可串行化插件 DTO 与常量（零 `node:*`、零 `@earendil-works/pi-*` 依赖）。
 *
 * 本文件由 `@helm/protocol` 与 `@helm/protocol/browser` 共同导出：
 * Web 前端、浏览器 SDK、CLI 与内核均可通过 `@helm/protocol/browser` 安全消费，
 * 不引入任何 Node 流或后端运行时依赖。
 */

import type { ConversationScope } from './conversation.js'
import type { AgentNamespacedMeta } from './meta.js'

/** JSON Schema 对象；由宿主在边界处统一校验。 */
export type JsonSchema = Record<string, unknown>

export type MaybePromise<T> = T | Promise<T>

// ---------------------------------------------------------------------------
// Hook 挂载点名称与外部触发信封
// ---------------------------------------------------------------------------

export type HookName =
  | 'trigger'
  | 'input'
  | 'before_turn'
  | 'tool_call'
  | 'tool_result'
  | 'agent_spawn'
  | 'turn_settled'

/** 后端 Hook 挂载点名称唯一真源（与 HookName 类型双向锁定）。 */
export const PLUGIN_HOOK_NAMES = [
  'trigger',
  'input',
  'before_turn',
  'tool_call',
  'tool_result',
  'agent_spawn',
  'turn_settled',
] as const satisfies readonly HookName[]

type _AssertAllHookNamesListed =
  Exclude<HookName, (typeof PLUGIN_HOOK_NAMES)[number]> extends never ? true : never
const _assertAllHookNamesListed: _AssertAllHookNamesListed = true
void _assertAllHookNamesListed

/**
 * 外部入站事件信封（cron / webhook 经 defang 防逃逸包裹后投递）。
 * 命中 threadKey 订阅时可被 transform 改写 targetConversationId 直投 Worker。
 */
export interface ExternalTriggerEnvelope {
  id: string
  /** 事件源标识，如 'cron'、'webhook:<id>'。 */
  source: string
  /** defang 包裹后的载荷文本。 */
  text: string
  /** 订阅直通键（ThreadSubscriptionDoc 路由）。 */
  threadKey?: string
  /** 可选定向投递会话；缺省目标由内核按当前 assistant 入口解析。 */
  targetConversationId?: number
  metadata?: Record<string, unknown>
  createdAt: number
}

// ---------------------------------------------------------------------------
// 子代理执行元数据与门禁结果（agent-exec 跨端共享）
// ---------------------------------------------------------------------------

/**
 * 子代理实际执行环境元数据（onResolved 回传）。
 * 原生路径至少回传 conversationId；外部运行时（如 herdr）至少回传 executionId。
 * worktree / 控制引用等业务扩展经 meta 命名空间携带（见 meta.ts）：内核只
 * 校验 envelope，不解释任何命名空间内部结构（形状由所有方插件边界校验）。
 */
export interface AgentExecutionInfo {
  /** 实际执行节点，由执行方回传；不能从父会话猜测外部插件的目标。 */
  nodeId?: string
  conversationId?: number
  /** 外部运行时内的执行标识（如 Herdr 窗格/标签 ID）。 */
  executionId?: string
  /** 实际生效的工作目录绝对路径。 */
  effectiveCwd?: string
  /**
   * 命名空间业务扩展（机制面）：与 AgentSpawnRequest.meta 同构（如受管
   * worktree 描述、外部控制动作引用等由对应插件定义形状并在边界校验）。
   * 内核 envelope 只保证 JSON-safe 与有界，透传不解释。
   */
  meta?: AgentNamespacedMeta
}

/** gate 命令执行结果；output 为失败时展示给用户的命令输出。 */
export interface AgentGateResult {
  ok: boolean
  output: string
  /** 命令退出码；超时或被强杀（无退出码可考）与无法执行时为 null。 */
  exitCode?: number | null
  /** true 表示命令超时被强制终止（进程组 SIGTERM -> SIGKILL）。 */
  timedOut?: boolean
}

// ---------------------------------------------------------------------------
// Action / Prompt / Doc / Config DTO
// ---------------------------------------------------------------------------

export interface PluginActionCliPositionalSpec {
  /** 位置参数写入的 input 字段名。 */
  field: string
  /** 是否必填。 */
  required?: boolean
  /**
   * 若该位置参数在 CLI 本地对应一个存在的文件（或以 ./ ../ / 开头），
   * 自动读取本地文件 UTF-8 文本写入此目标字段（例如 run <file.js> 写入 script），
   * 否则将位置参数字符串写入 field。
   */
  readFileInto?: string
}

export interface PluginActionCliSpec {
  /** 顶层命令路径；缺省为 [去掉 builtin: 的 pluginId, actionId]。 */
  command?: string[]
  /** CLI 帮助文案；缺省沿用 action description。 */
  description?: string
  /** true 时不出现在顶层 `helm <plugin> <action>` 命令中。 */
  hidden?: boolean
  /** 位置参数映射列表（按顺序消费 CLI 位置参数）。 */
  positional?: PluginActionCliPositionalSpec[]
  /** 覆盖 CLI 请求默认超时（毫秒；0 表示无超时，供长耗时动作如 workflow run 使用）。 */
  timeoutMs?: number
}

/**
 * 能力使用指引公共字段（ctx.tool、ctx.action 与 ActionManifest 同权）：
 * - 工具激活时，段落投射到 prompt.tools.<name>，要点聚合到 prompt.tools.guidelines；
 * - 动作经 run_action 可达时，指引进入 prompt.actions 目录；直接派生为工具时沿用工具投射，避免重复。
 * 两字段均可省略；动作仍按 description 自动进入可用动作目录。
 * 注册边界要求非空非纯空白字符串，promptGuidelines 必须是非空数组。
 * 仅对当前会话可达的能力投射指引；停用、scope 不匹配或工具被剥离时清理。
 */
export interface PluginPromptFields {
  /** 能力使用指引完整段落；投射到当前可达的工具或动作目录。 */
  promptSnippet?: string
  /** 使用要点列表；每项必须是非空非纯空白字符串。 */
  promptGuidelines?: string[]
}

/** 会话文档不进入全局快照；仅经指定文档的订阅流发布。delete 的 value 为初始值。 */
export interface PublicPluginSessionDoc {
  pluginId: string
  name: string
  conversationId: number
  value: unknown
  deleted?: boolean
}

/** 插件公共文档快照（跨端可读；逐值 JSON 校验/脱敏后发布，默认不公开）。 */
export interface PublicPluginDoc {
  pluginId: string
  name: string
  value: unknown
}

/** 插件服务声明的静态持久资源占用项（停用前 inUse 预检使用）。 */
export interface PluginInUseItem {
  /** 占用资源类别标识（如 'cron_job'、'webhook_endpoint'、'profile_runtime'、'profile_model'）。 */
  kind: string
  /** 资源唯一标识。 */
  id: string
  /** 面向用户的可读占用说明。 */
  label: string
}

/** 插件配置字段 Schema；secret: true 自动分离至 credentials.json。 */
export interface PluginConfigFieldSchema {
  type: 'string' | 'number' | 'boolean'
  label?: string
  description?: string
  default?: string | number | boolean
  secret?: boolean
  required?: boolean
  /** 数值字段的边界约束；写入前由宿主统一校验。 */
  minimum?: number
  maximum?: number
  integer?: boolean
}

/** 插件配置字段来源：configured（用户显式持久化覆写）、default（回退 schema.default）、unset（未配置且无 default）。 */
export type PluginConfigFieldSource = 'configured' | 'default' | 'unset'

/** GET /api/plugins/:id/config 响应体。 */
export interface PluginConfigResponse {
  values: Record<string, unknown>
  schema: Record<string, PluginConfigFieldSchema>
  sources?: Record<string, PluginConfigFieldSource>
}

/**
 * 自动化变更守卫期望（guarded mutation）：调用方携带授权时点的事实
 * （探针 ownedBy / stateChangeSeq），内核在会话串行域内、于第一个不可逆
 * 动作（SDK abort/submit 调用）之前同步复核；复核失败抛 409/404 且绝不
 * 执行变更（Watchdog human-owned 红线的内核执行层兑现）。
 */
export interface GuardedMutationExpectation {
  /**
   * 授权时点的归属（探针事实）。内核硬性要求当前归属属自动化域
   * （'bot' | 'helm'，'human' 永远拒绝）；提供具体值时进一步要求当前
   * 归属与之精确相符（bot/helm 间移交视为新事实，保守拒绝）。
   */
  expectedOwnership?: 'bot' | 'helm'
  /** 授权时点的权威水位（stateChangeSeq）；提供时当前值必须相等（CAS）。 */
  expectedStateSeq?: number
}

// ---------------------------------------------------------------------------
// 可串行化清单（GET /api/plugins 与 GET /api/actions）
// ---------------------------------------------------------------------------

/** 插件运行状态：active（已启用且正常）、disabled（已停用）、failed（加载或启用失败）。 */
export type PluginStatus = 'active' | 'disabled' | 'failed'

/** 插件加载或启用失败时的结构化诊断信息。 */
export interface PluginDiagnosticError {
  code: string
  message: string
  /** 发生故障的阶段：scan（清单/入口解析）、load（模块导入/契约校验）、define（definePlugin/UI 校验）、enable（Provider 挂载/服务启动）。 */
  stage: 'scan' | 'load' | 'define' | 'enable'
  details?: Record<string, unknown>
}

export interface PluginSummary {
  id: string
  name: string
  /** 插件简短功能描述（来自插件定义，前端直接展示，不做 ID 特判）。 */
  description?: string
  /**
   * 插件线性矢量图标名称（对应 HelmIcon name，可选）。
   * 缺省时前端使用默认图标占位（DEFAULT_PLUGIN_ICON: 'puzzle'）。
   */
  icon?: string
  version?: string
  /** 依赖的其他插件 ID 列表（注册边界去重归一；启用前必须全部已启用）。 */
  dependencies?: string[]
  /** 常驻不可卸载（如 builtin:profile）。 */
  locked: boolean
  enabled: boolean
  /** 插件当前状态：active | disabled | failed。 */
  status?: PluginStatus
  /** 当 status === 'failed' 时携带结构化诊断信息。 */
  error?: PluginDiagnosticError
  hooks: HookName[]
  actions: string[]
  tools: string[]
  /**
   * 受管包安装元数据（additive，可选）：仅当插件来自包安装器
   * （plugins install/update）时存在；手放置入目录的插件缺省。
   * 内置插件（builtin:*）永无该字段。
   */
  managed?: PluginManagedMeta
}

/** 受管插件包元数据（PluginSummary.managed 的形状；additive 可选字段）。 */
export interface PluginManagedMeta {
  /** 安装来源（解析后的规范化形状；含 source 原文回显）。 */
  source: PluginPackageSource
  /** 安装记录 ID（与 PluginPackageRecord.id 一致）。 */
  installId: string
  /** 已安装版本（来自包清单 version；未读到时为空串）。 */
  installedVersion: string
  /** 最近一次安装/更新完成时间（epoch 毫秒）。 */
  installedAt: number
}

/** 单个已注册动作的可串行化清单，供 CLI / Web / Workflow 消费。 */
export interface ActionManifest extends PluginPromptFields {
  pluginId: string
  id: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  exposeAsTool?: boolean
  /**
   * 该动作是否为幂等/只读操作（默认 false）：
   * - false：中断或失败时账本标记 workflow_action_uncertain，拒绝自动恢复重跑副作用；
   * - true：成功时前缀缓存复用，中断或失败时允许 resumeFromRunId 从该步起安全重跑。
   */
  idempotent?: boolean
  cli?: PluginActionCliSpec
  scope?: ConversationScope
}

// ---------------------------------------------------------------------------
// 外部插件生态 DX 闭环（doctor / reload / rescan；helm plugins init 为 CLI 本地命令）
// ---------------------------------------------------------------------------

/** doctor 单项检查结果。 */
export interface PluginDoctorCheck {
  /** 检查项标识：manifest / backend / register / client。 */
  id: string
  /** 检查项人类可读标题。 */
  label: string
  /** ok 时省略；失败时为结构化诊断（code / message / details）。 */
  error?: { code: string; message: string; details?: unknown }
}

/** 外部插件源码静态自检报告（POST /api/plugins/doctor）。 */
export interface PluginDoctorReport {
  /** 被检目录的绝对路径（请求方给定或经插件 id 解析后的源目录）。 */
  dir: string
  /** 请求目标：id 模式时为解析出的源目录；path/dir 模式时与 dir 一致。 */
  requestedId?: string
  /** 从目录真实清单/入口推导出的插件 id（未到达定义导出时缺省）。 */
  pluginId?: string
  ok: boolean
  /** 逐项检查结果（按执行顺序）：manifest -> backend -> register -> client。 */
  checks: PluginDoctorCheck[]
  /** doctor 加载真实注册后得到的能力摘要（register 通过时存在）。 */
  summary?: PluginSummary
  /**
   * 真实注册阶段经 ctx.ui.screen 声明并通过原始注册校验的视图 id 列表
   *（register 通过时存在；additive 可选字段）。供上层（如 builtin:apps 的
   * validate/publish）在安装前硬性校验全栈应用至少声明一个 Screen。
   * 只记录真实调用，不做静态扫描或近似推导。
   */
  screens?: string[]
}

/** 受控热重载结果（POST /api/plugins/:id/reload）。 */
export interface PluginReloadResult {
  pluginId: string
  /** 重载前启用状态（重载保持该状态不变）。 */
  wasEnabled: boolean
  /** 本次重载使用的模块代际号（用于诊断，单调递增）。 */
  generation: number
  /** 重载成功后该插件当前清单。 */
  summary: PluginSummary
}

/** 外部插件目录重扫描结果（POST /api/plugins/rescan）。 */
export interface PluginRescanResult {
  /** 本次扫描注册成功的外部插件 id（默认 disabled）。 */
  registered: string[]
  /** 扫描到的纯数据目录 / 已注册插件目录被跳过的数量（诊断用）。 */
  skipped: number
  /** 全部插件当前清单。 */
  plugins: PluginSummary[]
}

// ---------------------------------------------------------------------------
// 外部插件包管理（source grammar / 安装记录 / install / update / remove）
// 仅可串行化类型；具体解析器（source 字符串 -> 规范化形状）与安装执行由
// kernel 实现，protocol 不携带运行时。
// ---------------------------------------------------------------------------

/** npm 注册表来源：`npm:<spec>`（spec 为任意合法 npm 依赖说明符）。 */
export interface PluginSourceNpm {
  kind: 'npm'
  /** 原始 source 字符串（规范回显，如 `npm:helm-plugin-foo@^1.2.0`）。 */
  raw: string
  /** npm 依赖说明符（去 `npm:` 前缀后的部分，如 `helm-plugin-foo@^1.2.0`）。 */
  spec: string
}

/** Git 来源：`git:<repo>@<ref>` 或 HTTPS Git URL（`https://...git[#<ref>]`）。 */
export interface PluginSourceGit {
  kind: 'git'
  /** 原始 source 字符串（规范回显）。 */
  raw: string
  /** Git 仓库地址（如 `https://github.com/user/helm-plugin-foo.git` 或 `git@host:path` 形式的 repo 部分）。 */
  repo: string
  /** 检出的 Git ref（分支/Tag/Commit；缺省由安装器决定，通常仓库默认分支）。 */
  ref?: string
  /** 仓库内子目录（monorepo 布局；缺省为仓库根）。 */
  subdirectory?: string
}

/** 本地路径来源：绝对路径或相对 Hub cwd / 插件根目录的相对路径。 */
export interface PluginSourceLocal {
  kind: 'local'
  /** 原始 source 字符串（规范回显，保留用户写法）。 */
  raw: string
  /** 解析后的绝对路径（安装器规范化；Windows 亦为绝对路径）。 */
  path: string
}

/** 规范化插件包来源（判别联合，kind 判别）。 */
export type PluginPackageSource = PluginSourceNpm | PluginSourceGit | PluginSourceLocal

/** 受管插件包安装记录（持久化于安装器私有存储；非全局首帧/SSE 广播载荷）。 */
export interface PluginPackageRecord {
  /** 安装记录 ID（幂等稳定标识；同一插件重复 install 复用原 ID 更新记录）。 */
  id: string
  /** 安装目标插件 id（包清单声明；如 `my-plugin`）。 */
  pluginId: string
  /** 规范化安装来源。 */
  source: PluginPackageSource
  /** 安装目标磁盘绝对路径（<dataDir>/plugins/<pluginId>）。 */
  installPath: string
  /** 包清单声明版本；未读到时为空串（不虚构）。 */
  version: string
  /** 首次安装完成时间（epoch 毫秒）。 */
  installedAt: number
  /** 最近一次更新完成时间（epoch 毫秒）；从未更新时与 installedAt 相同。 */
  updatedAt: number
  /** 启用状态由插件系统自身管理，不在此记录（避免双源）。 */
}

/** 安装结果（POST /api/plugins/install）。 */
export interface PluginInstallResult {
  /** 安装记录（已持久化）。 */
  record: PluginPackageRecord
  /** 安装后插件当前清单（安装即注册，默认停用，与 rescan 同语义）。 */
  summary: PluginSummary
  /**
   * enable: true 但启用失败时的结构化诊断（additive 可选）：安装与记录
   * 已成功保留（不回滚），启用失败原因如实透出供调用方重试 enable。
   */
  enableError?: { code: string; message: string }
}

/** 更新结果（POST /api/plugins/:id/update）。 */
export interface PluginUpdateResult {
  /** 更新后的安装记录（version / updatedAt 已推进）。 */
  record: PluginPackageRecord
  /** 更新并重载（或重新注册）后的插件清单。 */
  summary: PluginSummary
  /** 本次更新是否实际变更（源未变化时 false，幂等语义如实回报）。 */
  changed: boolean
  /** 更新前版本（诊断用；未读到时为空串）。 */
  previousVersion: string
}

/** 移除结果（POST /api/plugins/:id/remove）。 */
export interface PluginRemoveResult {
  /** 被移除的插件 id。 */
  pluginId: string
  /** 被清理的安装目录绝对路径。 */
  installPath: string
  /** 移除前是否处于启用状态（启用中移除需先停用；此处回显事实）。 */
  wasEnabled: boolean
  /** 移除的安装记录 ID。 */
  installId: string
}
