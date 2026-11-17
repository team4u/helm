/**
 * 内置插件间共享编排契约（非 protocol 核心）。
 *
 * 本模块是编排业务形状的唯一权威定义，消费方为 builtin:workflow（引擎 /
 * 隔离层 / steer / 客户端投影）与外部执行插件（builtin:herdr 的执行元数据
 * 产出与 steer 动作实现）。内核 envelope（@helm/protocol）只保留通用字段与
 * 命名空间 meta（JSON-safe），不理解以下任何业务结构：
 * - workflow 运行 / 节点 / 进度 / 保存定义与文档形状（迁自 protocol workflow.ts）；
 * - 受管 worktree 清理契约（迁自 protocol worktree.ts）；
 * - 外部执行 steer 委托契约（ExternalSteerRequest / Result 与控制引用；
 *   迁自 protocol plugin.ts）；
 * - AgentSpawnRequest.meta / AgentExecutionInfo.meta 的 'builtin:workflow'
 *   命名空间业务形状（runId / 派生深度上限 / worktree 描述）及其边界校验。
 *
 * 纪律：本模块只做形状定义与边界校验（复用 @helm/protocol 的 AJV 基础设施），
 * 不携带运行时服务；业务值在消费方边界用这里的 schema 显式验证，非法输入
 * 显式拒绝、诊断不退化。protocol 不再出口这些类型。
 */
import { HelmError, sanitizeAgentNamespacedMeta, validateOrThrow, type AgentExecutionInfo, type AgentGateResult, type AgentNamespacedMeta, type JsonSafeObject, type JsonSafeValue, type JsonSchema } from '@helm/protocol'
import { isAbsoluteAgentPath } from '@helm/protocol'

// ---------------------------------------------------------------------------
// workflow 运行 / 定义 / 投影契约（迁自 @helm/protocol workflow.ts）
// ---------------------------------------------------------------------------

/** builtin:workflow/list 动作返回的已保存工作流摘要。 */
export interface SavedWorkflowSummary {
  name: string
  path?: string
  /** 定义文件最后修改时间（epoch ms；真实 fs stat，非缓存副本）。 */
  updatedAt: number
  /** 定义文件字节数（真实 fs stat）。 */
  size: number
  /** 元数据校验失败时保留目录条目，并显式返回诊断。 */
  metadataError?: string
  description?: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

/** builtin:workflow/get 动作返回的完整定义（只读源码 + 元数据 + 文件事实）。 */
export interface SavedWorkflowDetail extends SavedWorkflowSummary {
  /** 完整脚本源码：仅供只读展示与 AI 读取；Web 端不提供编辑能力。 */
  script: string
}

/** builtin:workflow/save 动作入参：script / fromRunId 恰好提供一个。 */
export interface WorkflowSaveRequest {
  /** 完整脚本源码（与 fromRunId 二选一）。 */
  script?: string
  /** 把既有运行持久化的脚本源固化为定义（与 script 二选一；不可用于 subagent run）。 */
  fromRunId?: string
  /** 保存名称；缺省用 meta.name，与 meta.name 不一致时显式拒绝。 */
  name?: string
  /** 覆盖同名定义（默认拒绝，显式 true 才覆盖）。 */
  overwrite?: boolean
}

/** builtin:workflow/save 动作结果（保存后按真实 fs 重新构建的摘要）。 */
export interface WorkflowSaveResult {
  /** true 新建；false 显式 overwrite 覆盖了既有定义。 */
  created: boolean
  workflow: SavedWorkflowSummary
}

/** builtin:workflow/delete 动作结果（只删除定义文件，历史 run 记录不受影响）。 */
export interface WorkflowDeleteResult {
  deleted: true
  name: string
  path: string
}

/** 工作流引擎运行请求（经 builtin:workflow 动作或内核编排调用）。 */
export interface WorkflowRunRequest {
  /** 已保存工作流的名称。name、script、scriptPath 必须恰好提供一个。 */
  name?: string
  script?: string
  scriptPath?: string
  /** 原样传给脚本 args，不限于对象。 */
  args?: unknown
  resumeFromRunId?: string
  /** 目标会话；新 run 必须明确指定，resume 省略时沿用原 run 的会话。 */
  conversationId?: number
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'aborted'

export type WorkflowNodeStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

/** DAG 单节点状态（agent / action / gate / script 等统一形状）。 */
export interface WorkflowNodeState {
  id: string
  /** 节点类型：'agent' | 'action' | 'gate' | 'script' 等。 */
  kind: string
  status: WorkflowNodeStatus
  /** 直接复用成功账本结果，未新建执行上下文。HTTP、CLI 与事件使用同一字段。 */
  cached?: boolean
  /** agent 节点的执行后端标识（Profile ID 或 'herdr:<kind>'）。 */
  agentType?: string
  /** 展示名（脚本 label / 派生描述）。 */
  label?: string
  /** 实际执行节点。 */
  nodeId?: string
  /** agent 节点实际执行的会话 ID。 */
  conversationId?: number
  /** 外部运行时执行标识（如 Herdr 窗格/标签 ID）。 */
  executionId?: string
  /** 实际生效工作目录。 */
  effectiveCwd?: string
  /** isolation: 'worktree' 分配的隔离工作树（见 WorktreeExecutionDescriptor）。 */
  worktree?: WorktreeExecutionDescriptor
  /** 外部执行控制动作引用（onResolved.controls 透传；steer 据此路由外部委托）。 */
  controls?: AgentExecutionControls
  phaseIndex?: number
  phaseTitle?: string
  /** agent 节点的原始提示词（审计/重放展示用）。 */
  prompt?: string
  /** 结构化输出 JSON Schema。 */
  schema?: Record<string, unknown>
  /** 脚本声明的 gate 验收命令原文。 */
  gateCommand?: string
  /** gate 执行结果（已在执行环境内恰好一次执行）。 */
  gate?: AgentGateResult
  /** 节点实际或请求的模型标识。 */
  model?: string
  /** 节点执行尝试次数（重试时 > 1）。 */
  attempt?: number
  tokens?: number
  durationMs?: number
  startedAt?: number
  settledAt?: number
  /** 结构化输出（Schema 校验通过后）。 */
  output?: unknown
  error?: string
}

/**
 * 观察用进度行（inspect / Web 检查器渲染）。
 * agent 与 action 节点的权威状态在 `WorkflowRunSummary.nodes`；
 * 这里只保留 phase 声明与脚本 log 两类时间线事件。
 */
export type WorkflowProgressEntry =
  | { at: number; kind: 'phase'; index: number; title: string }
  | { at: number; kind: 'log'; message: string }

/** builtin:workflow 的 run/runs/inspect 动作与会话投影使用的运行摘要。 */
export interface WorkflowRunSummary {
  id: string
  name: string
  conversationId: number
  /** run 种类：DSL 编排工作流（缺省/'workflow'）或后台单子代理（'subagent'）。 */
  kind?: 'workflow' | 'subagent'
  /** 触发本次 run 的已保存工作流名（按保存定义重跑的稳定入口；内联脚本无此字段）。 */
  savedName?: string
  /** 脚本 meta.description 描述。 */
  description?: string
  /** 脚本 meta.phases 声明的阶段蓝图。 */
  phases?: Array<{ title: string; detail?: string; model?: string }>
  /**
   * 触发本次 run 的父会话 SubagentWorkflow 工具调用 ID（内核受信注入，
   * 非用户可写字段；HTTP/CLI 仅输出透传）。前端据此精确关联运行卡。
   */
  parentToolCallId?: string
  status: WorkflowRunStatus
  createdAt: number
  updatedAt: number
  result?: unknown
  error?: string
  /** 结构化错误码（如 validation_error / workflow_action_uncertain / crash_recovery_limit / secret_grant_expired_on_restart 等；取代错误文本子串猜测）。 */
  errorCode?: string
  /** 引擎权威判定的可续跑标记（仅 status='failed' 且账本/规格完整可恢复且未被活跃接管时为 true）。 */
  resumable?: boolean
  /** 投影分片瘦身：runs 会话分片剥离大体积原始 result 时保留的单行截断预览与存在标记（完整 result 经 inspect 动作按需读取）。 */
  resultPreview?: string
  hasResult?: boolean
  nodes?: WorkflowNodeState[]
  /** 观察用时间线（phase / log）；跨重启从 summary 旁文件恢复。 */
  progress?: WorkflowProgressEntry[]
  /** 从 journal 前缀重放恢复的 run 携带的源 run ID。 */
  replayedFrom?: string
  /** 已被新续跑 run 接管的源记录标识，供前端隐藏重复恢复入口。 */
  resumedByRunId?: string
  /**
   * 账本记账失败的诊断明细（agent 行写失败；恢复重放的损行计数）。
   * 只读诊断面：只影响下次 resume 的重放优化，不影响本次 run 结果；
   * HTTP/CLI/Web 仅透传展示，不据其做任何重放决策。
   */
  journalIoErrors?: string[]
  /**
   * 前台同步标记：经同步工具（background:false / 自动化缺省）启动的 run，
   * 父回合工具调用正阻塞等待；此状态下可被 detach 动作转入后台。
   */
  syncForeground?: boolean
  /** detach 转后台时间戳（转后台即视为后台 run，不可再次 detach）。 */
  detachedAt?: number
}

export type WorkflowRunState = WorkflowRunSummary

/**
 * 受管子代理默认派生深度上限：主会话直接派生的一层子代理默认可继续派生
 * 二层（1 → 2），达到上限的会话即编排叶子。派生请求（spawn meta 的
 * 'builtin:workflow' 命名空间 maxSubagentDepth）与插件配置可显式授予更深。
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 2 as const

/**
 * 派生深度绝对上限：插件配置与 spawn meta maxSubagentDepth 的共同
 * 校验边界（越界显式拒绝，防失控递归派生）。
 */
export const HARD_MAX_SUBAGENT_DEPTH = 5 as const

/** 内置编排插件 ID 与公共运行态文档名。 */
export const WORKFLOW_PLUGIN_ID = 'builtin:workflow' as const
export const WORKFLOW_RUNS_DOC = 'runs' as const

/** 全局紧凑角标文档名（仅每会话 count/tone/footerText，不含完整 run 摘要）。 */
export const WORKFLOW_RUN_BADGES_DOC = 'run-badges' as const

export interface WorkflowConversationBadgeSummary {
  count: number
  tone?: 'warn' | 'accent' | 'neutral'
  footerText?: string
}

/** `builtin:workflow` 会话级文档 `runs` 的分片快照（当前会话及后代的 run，保留直接归属）。 */
export interface WorkflowRunSessionDocState {
  runs: WorkflowRunSummary[]
}

/** `builtin:workflow` 全局紧凑角标文档 `run-badges` 的结构化快照。 */
export interface WorkflowRunBadgesDocState {
  byConversation: Record<string, WorkflowConversationBadgeSummary>
}

// ---------------------------------------------------------------------------
// 受管 worktree 清理契约（迁自 @helm/protocol worktree.ts）
// ---------------------------------------------------------------------------

/** 受管工作树清理：路径必须与节点一起定位，或使用宿主分配的稳定 ID。 */
export interface WorktreeCleanupRequest {
  worktreeId?: string
  conversationId?: number
  path?: string
  nodeId?: string
  /** 指定已合入的目标分支或提交（缺省优先用记录里的 baseBranch，再回退到主工作树 HEAD）。 */
  mergedInto?: string
  deleteBranch?: boolean
  force?: boolean
}

export interface WorktreeCleanupResult {
  worktreeId: string
  removed: boolean
  path: string
  branch: string
  nodeId: string
  branchDeleted: boolean
}

// ---------------------------------------------------------------------------
// 外部执行 steer 委托契约（迁自 @helm/protocol plugin.ts）
// ---------------------------------------------------------------------------

/**
 * 外部执行环境的控制动作引用（纯机制引用）：执行插件在 onResolved 的
 * meta（'builtin:workflow' 命名空间 controls）回传，供编排层（如
 * builtin:workflow 的 steer）经宿主 invokeAction 委托控制动作。
 * 只存 pluginId/actionId 动作坐标，绝不携带回调、运行时策略或机密；
 * 具体授权与守卫由目标插件动作独立执行（不因委托而豁免）。
 */
export type AgentExecutionControls = {
  /**
   * 插话（steer）委托：目标动作实现 ExternalSteerRequest / ExternalSteerResult，
   * 独立校验授权、归属和状态，并如实返回实际守卫级别。
   */
  steer?: { pluginId: string; actionId: string }
}

/**
 * 外部执行环境 steer 委托标准输入（builtin:workflow.steer 依据节点
 * controls.steer 组装后经宿主 invokeAction 调用执行插件动作）。
 * workflowRunId/parentConversationId 为必填外部控制契约：目标动作必须
 * 与受管执行记录强匹配，绝不凭调用方自报坐标放行。
 */
export interface ExternalSteerRequest {
  /** 受管执行标识（onResolved.executionId）。 */
  executionId: string
  /** 实际执行节点（'local' 或节点 ID）。 */
  nodeId: string
  /** 派生该执行的 workflow run ID（强匹配）。 */
  workflowRunId: string
  /** 派生该执行的父会话 ID（强匹配）。 */
  parentConversationId: number
  /** 插话指导内容（非空白；原样交执行插件组装投递文本）。 */
  text: string
}

/**
 * 外部执行环境 steer 委托标准输出（执行插件动作必须返回的严格形状；
 * 委托方逐字段核销，任何坏产物显式拒绝）。
 *
 * steered=true 仅代表文本已投递，不代表指导已被消费或执行完成。
 * preflight 是发送前预检，cas 是提交点的服务端原子复核；两者不可混称。
 */
export interface ExternalSteerResult {
  steered: true
  executionId: string
  nodeId: string
  /** 预检或提交点复核时观测的权威水位，具体语义由 guardLevel 区分。 */
  stateChangeSeq: number
  /** 外部受管执行一律 helm 归属（human/bot 归属不适用外部窗格）。 */
  ownership: 'helm'
  /** preflight：发送前预检；cas：服务端在提交点原子复核。 */
  guardLevel: 'preflight' | 'cas'
}

// ---------------------------------------------------------------------------
// spawn / execution meta 的 'builtin:workflow' 命名空间业务形状与边界校验
// ---------------------------------------------------------------------------

/**
 * 编排命名空间键：AgentSpawnRequest.meta / AgentExecutionInfo.meta 中归
 * builtin:workflow 所有的业务槽（runId / 派生深度上限 / 受管 worktree /
 * 控制引用）。外部运行时插件（如 builtin:herdr）按本模块契约读写该槽。
 */
export const WORKFLOW_META_NAMESPACE = WORKFLOW_PLUGIN_ID

/** spawn meta 业务形状（meta['builtin:workflow']；派生请求侧）。 */
export type WorkflowSpawnMeta = {
  /** 发起本次派生的 run ID（引擎注入；herdr 双轨保活清理等按此归档）。 */
  runId?: string
  /**
   * 显式授予本次派生子代理子树的派生深度上限（1..HARD_MAX_SUBAGENT_DEPTH）。
   * 缺省继承父会话生效上限；受管子代理不能提高继承的上限（由 depth 守卫
   * 钩子校验，本 schema 只做形状与硬上限校验）。
   */
  maxSubagentDepth?: number
}

/** 受管 worktree 描述（execution meta 业务形状；隔离层与外部运行时共同使用）。 */
export type WorktreeExecutionDescriptor = {
  /** worktree 绝对路径。 */
  path: string
  branch: string
  /** Helm 受管登记 ID；供 cleanup_worktree 精确定位。 */
  id?: string
  repoRoot?: string
  baseCommit?: string
  /** 创建 Worktree 时源目录检出的本地分支名（detached HEAD 时缺省）。 */
  baseBranch?: string
  /** 源目录本身是受管 Worktree 时记录其 worktreeId（多级派生父子关系）。 */
  parentWorktreeId?: string
  dirtySource?: boolean
}

/** execution meta 业务形状（meta['builtin:workflow']；onResolved 回传侧）。 */
export type WorkflowExecutionMeta = {
  /** isolation: 'worktree' 兑现后的隔离工作树描述。 */
  worktree?: WorktreeExecutionDescriptor
  /** 外部执行控制动作引用（必须与 executionId + nodeId 同时回传）。 */
  controls?: AgentExecutionControls
}

const workflowSpawnMetaSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', minLength: 1 },
    maxSubagentDepth: { type: 'integer', minimum: 1, maximum: HARD_MAX_SUBAGENT_DEPTH },
  },
}

/**
 * 读取并校验 spawn meta 的 workflow 命名空间业务值（消费方边界）：
 * 缺失命名空间返回空对象；存在即按 schema 严格校验（未知字段 / 越界深度 /
 * 空 runId 显式拒绝，不静默丢弃）。envelope（JSON-safe）在消费方边界复验：
 * spawnAgent 入口与原生执行行入口的校验不覆盖 around continuation / transform
 * 改写后的中间窗口，本函数是业务消费前的最后防线（坏 envelope 显式拒绝，
 * 绝不把损坏 meta 静默当空）。
 */
export function parseWorkflowSpawnMeta(meta: AgentNamespacedMeta | undefined): WorkflowSpawnMeta {
  if (meta === undefined) return {}
  const sanitized = sanitizeAgentNamespacedMeta(meta, {
    agentId: WORKFLOW_META_NAMESPACE,
    field: "spawn request meta",
  })
  const slot = sanitized[WORKFLOW_META_NAMESPACE]
  if (slot === undefined) return {}
  validateOrThrow(
    workflowSpawnMetaSchema,
    slot,
    `spawn meta['${WORKFLOW_META_NAMESPACE}'] 业务值非法`,
    'validation_error',
    400,
  )
  return slot as unknown as WorkflowSpawnMeta
}

/**
 * 合并写入 spawn meta 的 workflow 命名空间业务值（生产方辅助；返回新对象，
 * 保留其他命名空间与既有业务键）。值为 undefined 的键不写入。
 */
export function withWorkflowSpawnMeta(
  meta: AgentNamespacedMeta | undefined,
  patch: WorkflowSpawnMeta,
): AgentNamespacedMeta {
  const existing = meta?.[WORKFLOW_META_NAMESPACE] ?? {}
  const next: { [key: string]: JsonSafeValue | undefined } = { ...existing }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value
  }
  return { ...(meta ?? {}), [WORKFLOW_META_NAMESPACE]: next }
}

/** 非空 trim 后仍非空的字符串字段校验（controls 坐标用）。 */
function requireTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function workflowMetaError(reason: string): HelmError {
  return new HelmError(
    'meta_invalid',
    `execution meta['${WORKFLOW_META_NAMESPACE}'] 业务值非法：${reason}`,
    502,
    { namespace: WORKFLOW_META_NAMESPACE, reason },
  )
}

/** 校验并克隆 controls（严格形状：拒绝未知键与非空 trim 字符串之外的任何值）。 */
function sanitizeControls(value: unknown): AgentExecutionControls {
  const source = value as Partial<AgentExecutionControls> | null
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw workflowMetaError('controls 必须是对象')
  }
  for (const key of Object.keys(source)) {
    if (key !== 'steer') {
      throw workflowMetaError(`controls 未知字段 "${key}"`)
    }
  }
  const out: AgentExecutionControls = {}
  const steer = source.steer as Partial<NonNullable<AgentExecutionControls['steer']>> | undefined
  if (steer !== undefined) {
    if (steer === null || typeof steer !== 'object' || Array.isArray(steer)) {
      throw workflowMetaError('controls.steer 必须是对象')
    }
    for (const key of Object.keys(steer)) {
      if (key !== 'pluginId' && key !== 'actionId') {
        throw workflowMetaError(`controls.steer 未知字段 "${key}"`)
      }
    }
    const pluginId = requireTrimmedString(steer.pluginId)
    const actionId = requireTrimmedString(steer.actionId)
    if (pluginId === undefined || actionId === undefined) {
      throw workflowMetaError('controls.steer.pluginId/actionId 必须是非空 trim 字符串')
    }
    out.steer = { pluginId, actionId }
  }
  if (out.steer === undefined) {
    throw workflowMetaError('controls 至少包含 steer')
  }
  return out
}

/** 校验并克隆受管 worktree 描述（绝对路径 / 非空分支 / 可选登记字段）。 */
function sanitizeWorktreeDescriptor(value: unknown): WorktreeExecutionDescriptor {
  const source = value as Partial<WorktreeExecutionDescriptor> | null
  if (
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    typeof source.path !== 'string' ||
    source.path.length === 0 ||
    !isAbsoluteAgentPath(source.path) ||
    typeof source.branch !== 'string' ||
    source.branch.length === 0
  ) {
    throw workflowMetaError('worktree 必须是 { path: 绝对路径, branch: 非空 }')
  }
  const out: WorktreeExecutionDescriptor = { path: source.path, branch: source.branch }
  for (const key of ['id', 'repoRoot', 'baseCommit', 'baseBranch', 'parentWorktreeId'] as const) {
    const field = source[key]
    if (field !== undefined) {
      if (typeof field !== 'string' || field === '' || (key === 'repoRoot' && !isAbsoluteAgentPath(field))) {
        throw workflowMetaError(`worktree.${key} 非法`)
      }
      out[key] = field
    }
  }
  if (source.dirtySource !== undefined) {
    if (typeof source.dirtySource !== 'boolean') throw workflowMetaError('worktree.dirtySource 必须是布尔值')
    out.dirtySource = source.dirtySource
  }
  return out
}

/**
 * 读取并校验 execution meta 的 workflow 命名空间业务值（消费方边界）。
 * 入参为已过内核 envelope 校验的 AgentExecutionInfo；命名空间缺失返回
 * 空对象；存在即严格校验 worktree 描述与 controls 形状，并保持通用安全
 * 不变量：控制引用只对外部执行有意义，必须与 executionId + nodeId 同时
 * 回传（孤立 controls 拒绝；原生执行的控制走内核 guarded 端口，不经 controls）。
 */
export function extractWorkflowExecutionMeta(info: AgentExecutionInfo): WorkflowExecutionMeta {
  if (info.meta === undefined) return {}
  // envelope 复验（与 parseWorkflowSpawnMeta 同理）：不信任中间链改写后的
  // 形状，坏 envelope 在业务消费前显式拒绝（引擎/隔离层入口虽已 sanitize，
  // 这里守住一切漏判路径）。
  const sanitized = sanitizeAgentNamespacedMeta(info.meta, {
    agentId: WORKFLOW_META_NAMESPACE,
    field: 'onResolved meta',
  })
  const slot = sanitized[WORKFLOW_META_NAMESPACE]
  if (slot === undefined) return {}
  if (slot === null || typeof slot !== 'object' || Array.isArray(slot)) {
    throw workflowMetaError('命名空间的值必须是普通对象')
  }
  for (const key of Object.keys(slot)) {
    if (key !== 'worktree' && key !== 'controls') {
      throw workflowMetaError(`未知字段 "${key}"`)
    }
  }
  const out: WorkflowExecutionMeta = {}
  const raw = slot as Record<string, unknown>
  if (raw['worktree'] !== undefined) out.worktree = sanitizeWorktreeDescriptor(raw['worktree'])
  if (raw['controls'] !== undefined) {
    out.controls = sanitizeControls(raw['controls'])
    if (info.executionId === undefined || info.nodeId === undefined) {
      throw workflowMetaError(
        'controls 必须与 executionId + nodeId 同时回传（孤立控制引用拒绝；原生执行不需要 controls）',
      )
    }
  }
  return out
}

/**
 * 构造/合并 execution meta 的 workflow 命名空间（生产方辅助；外部运行时如
 * builtin:herdr 回传 worktree / controls 时使用）。传入 existing 时合并进
 * 既有 meta：其他命名空间（其他插件注入的业务槽）经 envelope sanitizer
 * 防御性克隆/校验后原样保留；workflow 命名空间按键覆盖合并（未提及的
 * 既有键如 controls 保留），给其他插件链留出的命名空间不因本轮写入丢失。
 */
export function workflowExecutionMeta(
  value: WorkflowExecutionMeta,
  existing?: AgentNamespacedMeta,
): AgentNamespacedMeta {
  const merged: Record<string, JsonSafeObject> =
    existing === undefined
      ? {}
      : { ...sanitizeAgentNamespacedMeta(existing, {
          agentId: WORKFLOW_META_NAMESPACE,
          field: 'execution meta 合并基底',
        }) }
  const previous = merged[WORKFLOW_META_NAMESPACE] ?? {}
  const slot: { [key: string]: JsonSafeValue | undefined } = { ...previous }
  if (value.worktree !== undefined) slot['worktree'] = value.worktree
  if (value.controls !== undefined) slot['controls'] = value.controls
  merged[WORKFLOW_META_NAMESPACE] = slot as JsonSafeObject
  return merged
}
