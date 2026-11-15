/**
 * 原生 subagent：默认 agent_spawn 执行行（内核零 Git/worktree 语义）。
 *
 * - 在 pi-durable 创建原生子会话，onCreated 回调上报 convId；
 * - resume：严格校验 ref（纯数字 convId 或既有 agentId 映射），绝不静默新建假续接；
 *   缺省严格沿用原子会话镜像的 profileId/cwd/model（不重算、不偷偷回默认
 *   Profile）；显式 agentType/cwd/model 变更经同一 updateConversation 路径应用
 *   （真实 SDK configure + 镜像持久化 + 模型继承链，不重建身份字段），
 *   effort 显式时经 updateConversation 同步覆盖与 SDK 配置；onResolved/Gate 用
 *   配置落定后的实际 cwd（与 SDK 一致）；
 * - schema：AJV 全量校验（复用 plugins/schema，$async 显式拒绝），回合内
 *   register_structured_output 工具自愈（per-child 扩展注入，见
 *   structured-output.ts），工具拒绝错误参数同回合重试，最终未走工具可再文本
 *   追问一次，仍失败显式 schema_validation_failed（不吞错、不假数据）；
 * - profile：经 resolveProfile 端口读取真实 Profile（model/runtime），无效
 *   profile 显式报错；herdr runtime 未被插件接管时 unsupported_runtime；
 * - gate：真实 shell 执行（runGate，cwd 用子会话实际 cwd），失败即 spawn 失败；
 * - isolation 等执行环境要求：内核不解释（零业务分支）。带非空 isolation 的
 *   请求到达原生执行行时，说明没有插件经 agent_spawn continuation 兑现（如
 *   builtin:workflow 停用时的 worktree 隔离），显式 unsupported_runtime，
 *   绝不静默忽略。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AgentChange, Extension } from '@earendil-works/pi-durable'
import type { ModelThinkingLevel } from '@earendil-works/pi-ai'
import type { AgentSpawnRequest, ConversationPatch, ConversationSummary } from '@helm/protocol'
import { HelmError, sanitizeAgentNamespacedMeta } from '@helm/protocol'
import type { Harness } from '@earendil-works/pi-durable'
import type { Models } from '@earendil-works/pi-ai'
import { clampThinkingLevelForModel } from './models.js'
import { normalizeSessionCwd, trustedPlatformFromEnvFabric } from './target-cwd.js'
import { resolveSpawnTargetChain } from './spawn-target.js'
import type { HelmToolDeps } from './tool-deps.js'
import { runGate, MAX_TIMEOUT_MS } from './tools.js'
import {
  assertSchemaNotAsync,
  buildStructuredOutputExtension,
  parseSchemaCandidate,
  type StructuredOutputSession,
} from './structured-output.js'

const bg = BACKGROUND_CONTEXT

/** 默认 spawn profile：assistant（真实存在的常驻 profile；不新造角色枚举）。 */
const DEFAULT_SPAWN_PROFILE = 'assistant'

/** thinkingLevel 合法枚举（pi-ai ModelThinkingLevel；effort 映射到此，拒绝任意字符串）。 */
export const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface ResolvedProfile {
  model?: string
  thinkingLevel?: string
  cwd?: string
  /** Profile 默认绑定的计算节点（缺省 'local'）。 */
  nodeId?: string
  /** 外部运行时声明（如 herdr）：原生执行行不支持，显式报错。 */
  runtime?: { kind: string; agent: string; args?: string[] }
}

/**
 * 原生 spawn 依赖端口（宿主注入；runtime.ts 组合具体实现）。
 * resolveProfile 返回 undefined 表示 profile 不存在（显式报错，不静默当 default）。
 */
export interface NativeSpawnDeps extends HelmToolDeps {
  harness: Harness
  /** conversationId -> 最近 assistant 文本（由 tracker 维护）。 */
  getLastAssistantText(conversationId: number): string | undefined
  /** 全局默认模型 'provider/model'（未配置时抛 HelmError）。 */
  resolveModel(): { provider: string; modelId: string }
  /**
   * 当前 Models 集合（思考档位能力收敛用；宿主注入 ModelRegistry.models）。
   * 缺省不收敛（能力未知不破坏契约）。
   */
  modelsForClamp?(): Models | undefined
  /**
   * 模型禁用预检（ModelRegistry.assertModelEnabled 注入）：解析出最终
   * resolvedModel 后、真实创建子会话前必须调用（409 model_disabled），
   * 绝不让原生 spawn 绕过禁用约束。
   */
  assertModelEnabled?(provider: string, modelId: string): void
  /** 全局默认思考档位；未配置则使用 SDK off。 */
  resolveThinkingLevel?(): string | undefined
  /** agentId -> child convId（resume 映射，进程内稳定）。 */
  agentSessions: Map<string, number>
  /**
   * 本 Harness 共享的结构化输出结果槽（conversationId -> session）：完整装配
   * 的宿主（RuntimeAgentSpawn / buildSpawnHost）持有并注入，替代原模块级全局
   * WeakMap<Harness, Map>；并发 spawn 的隔离靠 conversationId 键（同名扩展被
   * registry 原地替换后，旧扩展闭包仍经此共享 map 动态命中自己的结果槽）。
   * 直调 runNativeSpawn 的最小装配（无 schema 场景）可缺省；请求携带 schema
   * 而未注入时显式报错（装配缺陷不静默丢结果）。
   */
  structuredOutputSessions?: Map<number, StructuredOutputSession>
  /**
   * 记录子会话与父会话关系并校验 profile 合法性；无效 profileId 必须抛
   * HelmError('not_found')。childCwd 为子会话将使用的实际 cwd（gate 也用它）。
   * modelMirror 为本子会话最终生效的模型（'provider/model'，写入镜像；空串 = 未配置）。
   * tags 为子会话标签（宿主决定；原生 spawn 不打业务角色标签）。
   * thinkingLevel 为实际 SDK 使用的档位（已按目标模型能力收敛），防止登记时
   * 重新读取继承源产生分歧。thinkingLevelOverride 为收敛后的显式覆盖
   *（request.effort 未提供时 undefined，镜像继承链语义）。
   */
  registerChildConversation(
    childId: number,
    parentId: number,
    profileId: string,
    childCwd: string,
    modelMirror: string,
    tags: string[],
    thinkingLevel?: string,
    nodeId?: string,
    thinkingLevelOverride?: string,
  ): Promise<void>
  /**
   * resume 续接时把子会话的 parentToolCallId 更新为本次父会话工具调用 ID
   * （可选；宿主同步镜像并广播 conversation.upsert）。缺省不追踪。
   */
  bindChildToolCall?(childId: number, parentToolCallId: string): void
  /**
   * 守卫式中止子会话回合（自动化取消的通用入口；零业务角色特判）：signal
   * 桥与启动期取消经此中止子会话——宿主实现现读归属事实并走内核
   * abortConversationGuarded 原子复核（human-owned 一律拒绝，看门狗红线；
   * 事实过期同样确定性拒绝）。未接线（无内核运行时的装配/部分测试）时回退
   * SDK conversation.abort，保持原始取消能力。
   */
  abortChildConversationGuarded?(childId: number): Promise<void>
  /** 按 profileId 读取真实 Profile（model/thinkingLevel/cwd/runtime）；不存在返回 undefined。 */
  resolveProfile(profileId: string): Promise<ResolvedProfile | undefined>
  /** 会话显式模型覆盖（modelOverride）；无覆盖返回 undefined。 */
  getModelOverride(childId: number): string | undefined
  /**
   * 校验子会话归属：resume 时确认 childId 的 parentConversationId 与请求一致。
   * 返回该会话记录的父 ID；会话不存在返回 undefined。
   */
  getParentOfConversation(childId: number): number | undefined
  /**
   * 读取 Helm 会话镜像（profileId / cwd / model 等真实配置）。
   * resume 沿用原子会话配置的唯一事实来源；新建路径用它取父会话 cwd
   * 回退（request>Profile>parent>Hub 链）。不存在返回 undefined。
   */
  getConversation(childId: number): ConversationSummary | undefined
  /**
   * 更新子会话配置（真实 SDK configure + 镜像持久化 + 模型继承链重算，
   * 复用宿主 updateConversation：不重建镜像、不覆盖 createdAt/title/tags）。
   * resume 显式 agentType/cwd/model/effort 变更经此路径应用。
   */
  updateConversation(childId: number, patch: ConversationPatch): Promise<ConversationSummary>
  /**
   * 将 per-child 扩展安装进 SDK registry（spawn 构造的 StructuredOutput 工具
   * 需真实注册后才能被会话按名选中；同名重装为原地替换）。
   */
  installChildExtension(extension: Extension): void
  /**
   * 附件清单块构造端口（宿主已在 spawnAgent 完成存在性与授权校验）。
   * 返回 [Attached Files] 文本块；无附件 spawn 时不注入。
   */
  resolveAttachmentsForPrompt?(): Promise<string>
  /** 节点可用性预检（离线拒绝）。新建路径靶点链统一由 spawn-target.ts 提供。 */
  assertNodeAvailable?: (nodeId: string) => void
}

export interface SpawnOutcome {
  kind: 'text'
  text: string
  kind2?: never
}

/**
 * 子会话在途派生互斥（进程内，按 Harness 隔离）：唯一权威锁注册表。
 *
 * 两个入口共用本注册表，避免各自为锁时互不可见：
 * - runNativeSpawn（原生执行行，含测试直调与 around-hook 包裹后的 next 续入）；
 * - RuntimeAgentSpawn.spawnAgent 的 resume 预检（宿主管道入口，钩子链前早期拒绝）。
 *
 * 占用时机（空窗红线）：
 * - resume：入口同步段（第一个 await 之前）即 claim；
 * - 新建：createConversation 返回后与 agentSessions 登记同一同步段即 claim，
 *  覆盖「子会话已存在但 onResolved 尚未回传」的空窗（该窗口内会话状态尚非
 *  working、宿主 activeSpawnExecutions 尚无坐标，仅者此处可见）。
 *
 * 只承诺本进程内互斥（跨进程/跨重启由持久状态与守卫端口负责）；外部运行时
 * （如 herdr 窗格）的 resume 互斥由其自身受管登记表负责，不经本表。
 */
const conversationInTurn = new WeakMap<Harness, Set<number>>()

function inTurnSet(harness: Harness): Set<number> {
  let set = conversationInTurn.get(harness)
  if (set === undefined) {
    set = new Set<number>()
    conversationInTurn.set(harness, set)
  }
  return set
}

/** 声明占用子会话（同步，无 await）：已被占用时抛 409 subagent_in_use。 */
export function claimSpawnConversation(harness: Harness, childId: number): void {
  const set = inTurnSet(harness)
  if (set.has(childId)) {
    throw new HelmError('subagent_in_use', `子会话 ${childId} 仍在执行，不能并发续接`, 409, { conversationId: childId })
  }
  set.add(childId)
}

/** 释放占用（finally 路径；幂等）。 */
export function releaseSpawnConversation(harness: Harness, childId: number): void {
  inTurnSet(harness).delete(childId)
}

/** 只读探询（宿主管道入口的早期拒绝用；不占用）。 */
export function isSpawnConversationInTurn(harness: Harness, childId: number): boolean {
  return conversationInTurn.get(harness)?.has(childId) ?? false
}

export async function runNativeSpawn(deps: NativeSpawnDeps, request: AgentSpawnRequest): Promise<unknown> {
  // envelope 边界（同步段）：meta 必须是 JSON-safe 命名空间对象（钩子链
  // transform 后的最终请求在此复查；业务值由命名空间所有方插件校验）。
  sanitizeAgentNamespacedMeta(request.meta, { agentId: request.agentId ?? 'subagent', field: 'spawn request meta' })
  const childId = request.resume === undefined ? undefined : resolveResumeRef(deps, request.resume, request.parentConversationId)
  if (childId !== undefined) {
    // 状态预检是与 claim 互补的第二道防线（覆盖未经本表的历史在途状态）。
    const status = deps.getConversation(childId)?.status
    if (status === 'working' || status === 'blocked') {
      throw new HelmError('subagent_in_use', `子会话 ${childId} 仍在执行，不能并发续接`, 409, { conversationId: childId })
    }
    claimSpawnConversation(deps.harness, childId)
  }
  const execution: NativeSpawnExecution = {}
  try {
    return await runNativeSpawnTurn(deps, request, execution)
  } finally {
    if (childId !== undefined) releaseSpawnConversation(deps.harness, childId)
    if (execution.childId !== undefined) releaseSpawnConversation(deps.harness, execution.childId)
  }
}

/** 新建派生的子会话 ID 回传通道（创建后同步 claim，外层 finally 统一释放）。 */
interface NativeSpawnExecution {
  childId?: number
}

/** resume 解析结果：childId（resume 时必有）+ 原子会话镜像。 */
interface SpawnResumeContext {
  childId: number | undefined
  isResume: boolean
  existing: ConversationSummary | undefined
}

/** spawn 靶点解析结果：目标节点 + 子会话实际 cwd（gate 与 onResolved 同源）。 */
interface SpawnTarget {
  nodeId: string
  childCwd: string
}

async function runNativeSpawnTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  execution: NativeSpawnExecution,
): Promise<unknown> {
  assertSpawnRequestShape(request)

  // ---- resume 解析：纯数字 convId 或 agentId 映射；绝不猜测续接（'12abc' 拒绝）。----
  // resume 配置基线：原子会话镜像（profileId/cwd/model）是唯一事实来源。
  // 缺省沿用；显式 agentType/cwd/model 变更经同一 updateConversation 路径应用
  // （真实 SDK configure + 镜像持久化，不重建身份字段）。
  const resume = resolveSpawnResume(deps, request)

  // profile 解析：resume 缺省用原子会话 Profile（不偷偷回默认 assistant）；
  // 新建路径沿用 agentType || 默认。resume 显式 agentType 为本次 Profile 变更。
  const profileId = resume.isResume
    ? (request.agentType ?? resume.existing!.profileId)
    : (request.agentType ?? '') || DEFAULT_SPAWN_PROFILE
  const profile = await resolveProfileForSpawn(deps, profileId)

  let summary: ConversationSummary | undefined = resume.existing
  if (resume.isResume) {
    summary = await applyResumeConfiguration(deps, request, resume.childId!, resume.existing!, profileId)
  }

  // 新建路径靶点：request > profile > 父会话镜像（引擎层不再注入 cwd，父
  // 目录回退在此完成）。与 ctx.host.resolveSpawnTarget 同一权威链
  // （spawn-target.ts），绝不各自维护；resume 严格沿用原子会话镜像
  // （nodeId/cwd 不重算），显式 cwd 变更已在上方 updateConversation 收口。
  const parentSummary = deps.getConversation(request.parentConversationId)
  const target = resolveSpawnTargetForRequest(deps, request, resume.isResume, profile, summary, parentSummary)
  // gate 与子会话同 cwd（resume 用更新后的实际 cwd，不依赖 main cwd）。
  const gateCwd = target.childCwd

  const structured = prepareStructuredSession(request)
  if (structured !== undefined && deps.structuredOutputSessions === undefined) {
    // 装配缺陷显式报错：结果槽无处登记，绝不静默丢结构化结果。
    throw new HelmError(
      'invalid_state',
      '请求携带 schema 但宿主未注入 structuredOutputSessions（装配缺陷）：结构化输出结果槽无处登记',
      500,
    )
  }
  let childId = resume.childId
  if (!resume.isResume) {
    childId = await createChildConversation(
      deps,
      request,
      execution,
      profile,
      profileId,
      structured,
      target,
    )
  } else {
    notifyResumeResolved(deps, request, childId!, target)
  }

  const conversation = await deps.harness.conversation(childId as never, bg)
  if (!conversation) {
    throw new HelmError('not_found', `子会话不存在：${childId}`, 404)
  }

  // resume 续接时补挂结构化输出扩展（原会话创建时可能没有；同样需真实注册）。
  if (resume.isResume && structured) {
    const extension = buildStructuredOutputExtension(deps.structuredOutputSessions!)
    deps.installChildExtension(extension)
    await conversation.configure({ extensions: { add: [extension] } }, bg)
  }

  // 同名扩展由 Registry 按名字解析；结果槽必须按会话隔离，不能被并发派生的闭包覆盖。
  return await runChildTurn(deps, request, conversation, childId as number, structured, gateCwd)
}

/** 请求形状硬校验（同步段；全部显式拒绝，绝不静默改默认）。 */
function assertSpawnRequestShape(request: AgentSpawnRequest): void {
  if (request.isolation !== undefined && request.isolation !== null && request.isolation !== '') {
    // 内核零业务分支：非空 isolation 到达原生执行行 = 没有插件经 agent_spawn
    // continuation 兑现（如 builtin:workflow 停用时的 worktree 隔离）。
    throw new HelmError(
      'unsupported_runtime',
      `isolation='${request.isolation}' 暂不支持：原生 subagent 执行行不实现执行环境隔离（该能力由对应插件经 agent_spawn 钩子接管；当前未注册或未启用）`,
      400,
    )
  }
  if (request.signal?.aborted) {
    throw new HelmError('aborted', 'spawn 请求在创建前已取消（signal 已 abort）', 409)
  }
  const agentType = request.agentType ?? ''
  // 通用命名空间前缀判定：任何 '<namespace>:<kind>' 形式的外部运行时
  //（如 herdr:agy、docker:devbox）都须经 agent_spawn 钩子接管；无插件接管时
  // 内核零插件枚举硬编码，不点名任何插件，一律显式 unsupported_runtime。
  if (agentType.includes(':')) {
    throw new HelmError(
      'unsupported_runtime',
      `agentType '${agentType}' 是外部运行时标识（namespace:kind 形式），需要对应插件经 agent_spawn 钩子接管（当前未注册该运行时）`,
      400,
    )
  }
  if (request.effort !== undefined && !THINKING_LEVELS.has(request.effort)) {
    throw new HelmError(
      'validation_error',
      `effort '${request.effort}' 非法；合法值：${[...THINKING_LEVELS].join(' | ')}`,
      400,
    )
  }
  if (request.gateTimeoutMs !== undefined) assertGateTimeoutMs(request.gateTimeoutMs)
}

/** resume 严格解析：ref 不存在/父归属不符/镜像缺失均显式拒绝，绝不静默新建续接。 */
function resolveSpawnResume(deps: NativeSpawnDeps, request: AgentSpawnRequest): SpawnResumeContext {
  const resumeRef = request.resume
  if (resumeRef === undefined) return { childId: undefined, isResume: false, existing: undefined }
  const childId = resolveResumeRef(deps, resumeRef, request.parentConversationId)
  if (childId === undefined) {
    throw new HelmError(
      'not_found',
      `resume ref '${resumeRef}' 不存在或不属于父会话 ${request.parentConversationId}：` +
        `既非既有 agentId 会话映射，也非有效子会话 ID；绝不静默新建续接会话`,
      404,
    )
  }
  const existing = deps.getConversation(childId)
  if (existing === undefined) {
    throw new HelmError(
      'not_found',
      `resume 会话 ${childId} 无镜像记录（宿主状态不一致）；拒绝盲目续接`,
      404,
      { conversationId: childId },
    )
  }
  return { childId, isResume: true, existing }
}

/** profile 解析：不存在显式 404；声明外部运行时而无插件接管显式 400（不默默降级原生）。 */
async function resolveProfileForSpawn(deps: NativeSpawnDeps, profileId: string): Promise<ResolvedProfile> {
  const profile = await deps.resolveProfile(profileId)
  if (profile === undefined) {
    throw new HelmError(
      'not_found',
      `agentType '${profileId}' 不是已注册的 Profile（profiles/${profileId} 不存在）`,
      404,
    )
  }
  if (profile.runtime) {
    // Profile 显式声明外部运行时（如 herdr）而未有其插件接管 -> 不默默降级原生。
    throw new HelmError(
      'unsupported_runtime',
      `Profile '${profileId}' 声明 runtime.kind='${profile.runtime.kind}'（agent '${profile.runtime.agent}'），` +
        `需要对应插件接管；原生 subagent 执行行不支持该运行时`,
      400,
    )
  }
  return profile
}

/** resume 配置应用：显式 agentType/cwd/model/effort 变更经 updateConversation 同步
 * SDK 与镜像；配置落定后对生效模型做禁用预检（409 model_disabled）。 */
async function applyResumeConfiguration(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  childId: number,
  existing: ConversationSummary,
  profileId: string,
): Promise<ConversationSummary> {
  let summary: ConversationSummary | undefined = existing
  const patch: ConversationPatch = {}
  // 显式 agentType 与原子会话 Profile 不同才是变更（相同则不产生无意义写）。
  if (request.agentType !== undefined && request.agentType !== existing.profileId) {
    patch.profileId = profileId
  }
  // 显式 cwd 才改写；缺省严格沿用原子会话 cwd（绝不重算到 Profile/Hub 目录）。
  if (request.cwd !== undefined && request.cwd !== existing.cwd) patch.cwd = request.cwd
  // 显式 model 才改写（'provider/model' 覆盖；清覆盖由 '' 显式表达，走同一
  // updateConversation 语义：重算继承链 + 真实 SDK configure + 镜像持久化）。
  if (request.model !== undefined && request.model !== deps.getModelOverride(childId)) {
    patch.model = request.model
  }
  if (request.effort !== undefined) patch.thinkingLevel = request.effort
  if (Object.keys(patch).length > 0) {
    summary = await deps.updateConversation(childId, patch)
  }
  // resume 禁用预检：配置落定后、提交输入前对生效模型收口。显式 model 变更
  // 已在 updateConversation 内检查；这里覆盖其余路径——子会话绑定/继承的
  // 模型后来被用户禁用时拒绝 resume（409 model_disabled），绝不绕过禁用策略。
  // 空模型沿用既有未配置语义（submit 阶段 no_model），不在此伪造错误。
  if (summary!.model !== '') {
    const modelRef = parseSpawnModel(summary!.model)
    deps.assertModelEnabled?.(modelRef.provider, modelRef.modelId)
  }
  return summary!
}

/** 靶点解析：resume 严格沿用镜像；新建走 request > profile > 父会话权威链
 * （进入 SDK createConversation / 镜像登记 / gate / onResolved 前按目标节点
 * 平台统一收口：win32 目标上不可映射的 POSIX cwd 显式拒绝，绝不落库；
 * 远端平台无可信信息时透传，不改写）。 */
function resolveSpawnTargetForRequest(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  isResume: boolean,
  profile: ResolvedProfile,
  summary: ConversationSummary | undefined,
  parentSummary: ConversationSummary | undefined,
): SpawnTarget {
  let nodeId: string
  let childCwd: string
  if (isResume) {
    nodeId = summary!.nodeId ?? 'local'
    childCwd = summary!.cwd
  } else {
    const chain = resolveSpawnTargetChain({
      profileNodeId: profile.nodeId,
      parentNodeId: parentSummary?.nodeId,
      requestCwd: request.cwd,
      profileCwd: profile.cwd,
      parentCwd: parentSummary?.cwd,
      defaultCwd: deps.defaultCwd,
      normalize: (cwd, targetNodeId) =>
        normalizeSessionCwd(cwd, {
          nodeId: targetNodeId,
          trustedPlatform: trustedPlatformFromEnvFabric(deps.envFabric),
          entry: 'agent_spawn',
        }),
    })
    nodeId = chain.nodeId
    childCwd = chain.sourceCwd
  }
  deps.assertNodeAvailable?.(nodeId)
  return { nodeId, childCwd }
}

/** 结构化输出任务槽初始化（无 schema 即纯文本 spawn）。 */
function prepareStructuredSession(request: AgentSpawnRequest): StructuredOutputSession | undefined {
  if (!request.schema) return undefined
  assertSchemaNotAsync(request.schema)
  return { schema: request.schema, accepted: undefined }
}

/** 新建子会话：模型解析链 -> 禁用预检 -> 扩展安装 -> 创建 -> 空窗 claim ->
 * 镜像登记 -> onResolved 回传实际元数据。 */
async function createChildConversation(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  execution: NativeSpawnExecution,
  profile: ResolvedProfile,
  profileId: string,
  structured: StructuredOutputSession | undefined,
  target: SpawnTarget,
): Promise<number> {
  // 模型解析链（与会话策略同构）：请求显式 model > profile.model > 全局默认。
  const modelRef = request.model ? parseSpawnModel(request.model) : undefined
  const profileModelRef = profile.model ? parseSpawnModel(profile.model) : undefined
  const resolvedModel = modelRef ?? profileModelRef ?? deps.resolveModel()
  // 禁用模型在创建前显式拒绝（409 model_disabled）：三条解析路径
  //（显式 request / profile / 全局默认）统一在此收口，绝不静默落到禁用模型。
  deps.assertModelEnabled?.(resolvedModel.provider, resolvedModel.modelId)
  const createModelRef = `${resolvedModel.provider}/${resolvedModel.modelId}`
  const extension = structured ? buildStructuredOutputExtension(deps.structuredOutputSessions!) : undefined
  if (extension) deps.installChildExtension(extension)
  const inheritedLevel = request.effort ?? profile.thinkingLevel ?? deps.resolveThinkingLevel?.()
  const modelsInstance = deps.modelsForClamp?.()
  const thinkingLevel = modelsInstance
    ? clampThinkingLevelForModel(modelsInstance, resolvedModel, inheritedLevel)
    : inheritedLevel
  const agentChange: AgentChange = {
    model: { provider: resolvedModel.provider, modelId: resolvedModel.modelId },
    cwd: target.childCwd,
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ModelThinkingLevel } : {}),
    // extensions 需传扩展对象：SDK 存名（names()）但快照解析发生在 install 之后。
    ...(extension ? { extensions: { add: [extension] } } : {}),
  }
  const conv = await deps.harness.createConversation(
    { ownership: { kind: 'ownerless' }, agent: agentChange },
    bg,
  )
  const childId = conv.id as number
  if (request.agentId) deps.agentSessions.set(request.agentId, childId)
  // 空窗闭合（见 conversationInTurn 注释）：子会话已存在但 onResolved 尚未
  // 回传、镜像状态尚非 working 的窗口内，仅此同步占用可见——与 agentSessions
  // 登记同一同步段 claim，任何并发 resume（宿主管道或直调）立即被拒。
  claimSpawnConversation(deps.harness, childId)
  execution.childId = childId
  // 原生 spawn 不打业务角色标签（tags 由宿主策略决定，内核零角色硬编码）。
  await deps.registerChildConversation(
    childId,
    request.parentConversationId,
    profileId,
    target.childCwd,
    createModelRef,
    [],
    thinkingLevel,
    target.nodeId,
    request.effort !== undefined ? thinkingLevel : undefined,
  )
  // onResolved 在配置全部落定（创建 + 镜像登记）后回传实际元数据。
  request.onResolved?.({
    nodeId: target.nodeId,
    conversationId: childId,
    effectiveCwd: target.childCwd,
  })
  return childId
}

/** resume 续接：显式 model/cwd/effort 变更已由 updateConversation 同步 SDK 与镜像。
 * parentToolCallId 同步更新（本次工具调用的运行期关联立即指向该子会话）；
 * onResolved 回传更新后的实际 cwd（与 SDK 一致）。 */
function notifyResumeResolved(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  childId: number,
  target: SpawnTarget,
): void {
  if (request.parentToolCallId !== undefined && request.parentToolCallId !== '') {
    deps.bindChildToolCall?.(childId, request.parentToolCallId)
  }
  request.onResolved?.({
    nodeId: target.nodeId,
    conversationId: childId,
    effectiveCwd: target.childCwd,
  })
}

/** 提交并守卫子会话回合。
 *
 * ---- signal 桥：运行中 abort -> 守卫中止子会话；listener 在 finally 摘除。----
 * 经宿主守卫入口（内核串行域内原子复核归属+水位；human-owned 拒绝），
 * 不再直接 conversation.abort——自动取消无条件杀子会话会越过看门狗红线
 *（ownership 已翻转为 human 的续接子会话受保护）。守卫拒绝时：子会话
 * 受保护继续独立运行，父侧等待立即以 aborted 终结（本 spawn 不再持有
 * 父任务），绝不强杀受保护子会话。
 */
async function runChildTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  conversation: Awaited<ReturnType<Harness['conversation']>> & object,
  childId: number,
  structured: StructuredOutputSession | undefined,
  gateCwd: string,
): Promise<unknown> {
  const outputSessions = deps.structuredOutputSessions
  if (structured !== undefined) outputSessions?.set(childId, structured)

  const abortChildTurn = (): Promise<void> => {
    const guarded = deps.abortChildConversationGuarded
    if (guarded !== undefined) return guarded(childId)
    return Promise.resolve(conversation.abort(bg)).then(() => undefined)
  }
  let abortError: HelmError | undefined
  /** 守卫拒绝时的父侧释放（race 败者已吸收，迟到结果不外溢）。 */
  let releaseParentOnGuardRefusal: ((error: HelmError) => void) | undefined
  const onAbort = () => {
    abortError = new HelmError('aborted', '子代理执行被取消（request.signal abort）', 499, {
      conversationId: childId,
    })
    void abortChildTurn().then(
      () => {
        // 子会话已中止：其回合结算后 driveTurn 自然返回（abortError 兜底）。
      },
      (guardError: unknown) => {
        const message = guardError instanceof Error ? guardError.message : String(guardError)
        abortError = new HelmError(
          'aborted',
          `子代理执行已取消；子会话 ${String(childId)} 受守卫保护未中止（${message}）`,
          499,
          { conversationId: childId },
        )
        process.stderr.write(`[helm] 子会话 ${String(childId)} 取消被拒/失败: ${message}\n`)
        releaseParentOnGuardRefusal?.(abortError)
      },
    )
  }
  if (request.signal) request.signal.addEventListener('abort', onAbort, { once: true })
  const guardRefusal = new Promise<never>((_, reject) => {
    releaseParentOnGuardRefusal = reject
  })
  try {
    if (request.signal?.aborted) {
      await abortChildTurn().catch((error: unknown) => {
        process.stderr.write(
          `[helm] 子会话 ${String(childId)} 启动期取消被拒/失败: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        )
      })
      throw new HelmError('aborted', '子代理启动期间已取消', 499, { conversationId: childId })
    }
    const turn = driveTurn(deps, request, conversation, childId, structured, gateCwd)
    // 守卫拒绝先行后，迟到的子回合结果/异常不再外溢（race 已由拒绝终结）。
    void turn.catch(() => {})
    return await Promise.race([turn, guardRefusal])
  } catch (error) {
    if (abortError !== undefined && error !== abortError) throw abortError
    throw error
  } finally {
    if (request.signal) request.signal.removeEventListener('abort', onAbort)
    if (outputSessions !== undefined && outputSessions.get(childId) === structured) outputSessions.delete(childId)
  }
}

/** 一个回合的提交、等待与终态检查（schema 分支先检查 settled 再取文本）。 */
async function driveTurn(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  conversation: Awaited<ReturnType<Harness['conversation']>> & object,
  childId: number,
  structured: StructuredOutputSession | undefined,
  gateCwd: string,
): Promise<unknown> {
  // 附件：宿主已校验授权；拼在任务正文之后、交接契约之前。
  const attachmentBlock =
    request.attachments !== undefined && request.attachments.length > 0 && deps.resolveAttachmentsForPrompt
      ? `\n\n${await deps.resolveAttachmentsForPrompt()}\n`
      : ''
  const basePrompt = `${request.prompt}${attachmentBlock}`
  const promptText = structured
    ? `${basePrompt}

<structured_output_contract>
完成回答后，调用 register_structured_output 工具提交最终结构化结果（output 参数必须满足给定 JSON Schema）。
Schema: ${JSON.stringify(structured.schema)}
</structured_output_contract>`
    : basePrompt

  const submission = await conversation.submit(
    { type: 'input', content: promptText, whenBusy: 'followUp' },
    bg,
  )
  const settled = await submission.wait(bg)
  assertNotUnanswered(settled, childId)

  if (structured) {
    if (structured.accepted !== undefined) {
      await settleGate(deps, request, gateCwd, childId)
      return structured.accepted
    }
    // 未走工具：一次文本自愈追问（模型可能直接输出 JSON 文本）。
    const text = deps.getLastAssistantText(childId) ?? ''
    const parsed = parseSchemaCandidate(text, structured.schema)
    if (parsed.ok) {
      await settleGate(deps, request, gateCwd, childId)
      return parsed.value
    }
    const heal = await conversation.submit(
      {
        type: 'input',
        content:
          `你上一条回答未通过 register_structured_output 工具提交结果。请立即调用 ` +
          `register_structured_output 工具，output 参数为满足 Schema 的合法 JSON。` +
          `
Schema: ${JSON.stringify(structured.schema)}`,
        whenBusy: 'followUp',
      },
      bg,
    )
    const healSettled = await heal.wait(bg)
    assertNotUnanswered(healSettled, childId)
    if (structured.accepted !== undefined) {
      await settleGate(deps, request, gateCwd, childId)
      return structured.accepted
    }
    const lastText = deps.getLastAssistantText(childId) ?? ''
    const retry = parseSchemaCandidate(lastText, structured.schema)
    if (retry.ok) {
      await settleGate(deps, request, gateCwd, childId)
      return retry.value
    }
    throw new HelmError(
      'schema_validation_failed',
      `子代理（会话 ${childId}）两次输出均未通过 Schema 校验；最后输出开头：${(retry.raw || lastText).slice(0, 200)}`,
      502,
      { conversationId: childId, lastText: lastText.slice(0, 1000) },
    )
  }

  await settleGate(deps, request, gateCwd, childId)
  const text = deps.getLastAssistantText(childId)
  if (text === undefined || text === '') {
    throw new HelmError('subagent_failed', `子代理（会话 ${childId}）完成但无文本输出`, 502, {
      conversationId: childId,
    })
  }
  return text
}

/** 未完成回合（失败/中止等）显式报错；绝不返回旧 assistant 文本冒充结果。 */
function assertNotUnanswered(settled: { status: string; reason?: string }, childId: number): void {
  if (settled.status !== 'unanswered') return
  throw new HelmError(
    'subagent_failed',
    `子代理（会话 ${childId}）回合未完成：${settled.reason}`,
    502,
    { conversationId: childId, reason: settled.reason },
  )
}

async function settleGate(
  deps: NativeSpawnDeps,
  request: AgentSpawnRequest,
  cwd: string,
  childId: number,
): Promise<void> {
  if (!request.gate) return
  // cwd 用子会话实际工作目录，不依赖请求缺省 main cwd；gate 是验收命令，
  // 输出直接进错误诊断（不挂会话，避免误注入会话级 stash 环境）。
  // conversationId 使 runGate 解析子会话绑定节点（远端 gate 在远端执行）；
  // gateTimeoutMs 缺省 120_000（runGate 内），超时杀整个进程组并如实回传。
  const gate = await runGate(deps, request.gate, {
    cwd,
    conversationId: childId,
    signal: request.signal,
    ...(request.gateTimeoutMs !== undefined ? { timeoutMs: request.gateTimeoutMs } : {}),
  })
  // 执行环境内恰好一次执行后回传完整结果（exitCode/timedOut 供宿主引擎
  // 判定失败与重试策略；宿主引擎据此免二次执行）。
  request.onGateResult?.({
    ok: gate.ok,
    output: gate.output,
    exitCode: gate.exitCode,
    timedOut: gate.timedOut,
  })
  if (!gate.ok) {
    const label = gate.timedOut ? '执行超时，已被强制终止' : `exitCode=${gate.exitCode}`
    throw new HelmError(
      'gate_failed',
      `验收命令失败（${label}）：${request.gate}\n${gate.output.slice(-2000)}`,
      502,
      {
        exitCode: gate.exitCode,
        timedOut: gate.timedOut,
        output: gate.output.slice(-4000),
      },
    )
  }
}

/** gateTimeoutMs 边界：正整数且 ≤ MAX_TIMEOUT_MS（与 bash/runGate 超时同界）；非法显式拒绝（不静默改默认）。 */
function assertGateTimeoutMs(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new HelmError(
      'validation_error',
      `gateTimeoutMs 必须是 (0, ${MAX_TIMEOUT_MS}] 的整数，收到 ${value}`,
      400,
      { gateTimeoutMs: value },
    )
  }
}

function parseSpawnModel(ref: string): { provider: string; modelId: string } {
  const slash = ref.indexOf('/')
  if (slash <= 0) throw new HelmError('validation_error', `模型引用格式应为 'provider/model'：${ref}`)
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

/**
 * resume ref 严格解析：仅接受纯十进制整数 convId（agentId 映射先翻译成 convId 再走同一校验）。
 * 会话必须真实存在且父归属正确；任何失败返回 undefined（调用方显式报错，
 * 绝不 Number.parseInt('12abc') 宽容续接到错误会话，绝不静默新建假续接）。
 */
function resolveResumeRef(deps: NativeSpawnDeps, ref: string, parentId: number): number | undefined {
  const mapped = deps.agentSessions.get(ref)
  const candidate = mapped ?? (/^\d+$/.test(ref) ? Number(ref) : undefined)
  if (candidate === undefined || !Number.isSafeInteger(candidate) || candidate <= 0) return undefined
  const parent = deps.getParentOfConversation(candidate)
  if (parent === undefined || parent !== parentId) return undefined
  return candidate
}
