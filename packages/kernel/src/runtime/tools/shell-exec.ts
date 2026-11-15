/**
 * shell 执行引擎（runShell / runGate / bash 工具）。
 *
 * - shell 执行委托 SDK `NodeExecutionEnv.exec`（`@earendil-works/pi-durable/env/node`）：
 *   预先 aborted 的 Context 绝不 spawn；abort/timeout 杀整个进程组并可靠等待子进程
 *   退出（listener/timer 全清理，不泄露进程）；stdout/stderr 各自 `StreamDecoder` 增量
 *   解码，多字节字符跨 chunk 不撕裂；`onOutput` 按到达顺序拼接（非先 stdout 后 stderr）。
 * - 跨节点执行（EnvFabric）：按 (nodeId, cwd, conversationId) 靶点在目标节点执行；
 *   nodeId !== 'local' 时经 deps.envFabric（离线显式 node_offline，断线显式 unknown；
 *   EnvFabric 缺失时仅允许 local 短生命周期直建，远端显式 env_fabric_missing，
 *   见 guards.ts），绝不静默回退 local 误读写 Hub 本机磁盘。
 * - 目标节点平台感知的 cwd/path 规范化（唯一实现 runtime/target-platform.ts，
 *   复用 @helm/protocol normalizeTargetPath/targetPlatformOf 原语，业务入口
 *   不得各自另写规则）：SDK NodeExecutionEnv / Remote 执行只接收已规范化路径
 *   （bash / runGate / POST /api/env/exec 与 WorktreeAllocator execGit 均经
 *   runShell 收敛）。
 * - runShell 对宿主继承 HELM_TOKEN 做兜底脱敏：即使调用方未把宿主 token 登记进
 *   deps.redact，返回的一切聚合文本也对捕获到的宿主 token 做精确替换脱敏。
 * - 输出超过 maxOutputBytes 显式失败 `output_limit_exceeded`（绝不截断当成功）。
 */
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { redactJsonValue } from '../../redact.js'
import { invalidPathText, normalizePathForTarget, targetPlatformForNode } from '../target-platform.js'
import type { HelmToolDeps } from '../tool-deps.js'
import { remoteShellGuardText, shellEnvFabricMissingText } from './guards.js'
import { buildToolEnv } from './managed-env.js'

const DEFAULT_TIMEOUT_MS = 120_000
/** timeoutMs 上限：与默认值同量级，防超大值变相无限等待。 */
export const MAX_TIMEOUT_MS = 600_000
/** bash 输出聚合上限（UTF-8 字节）：超过显式失败，绝不静默截断当成功。 */
export const MAX_OUTPUT_BYTES = 1024 * 1024
/** 流式模式（onOutputChunk）聚合预算：逐块推送不受影响（逐块输出是流式
 *  客户端的交付物），Hub 侧仅留终态诊断聚合；超限同样显式
 *  output_limit_exceeded（旧 64MiB 全文复制是内存泄漏，见审计）。 */
export const STREAM_AGGREGATE_LIMIT_BYTES = 256 * 1024

export interface ShellRunResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  signal: string | null
  /** 实际执行节点（显式/会话绑定解析结果；供 bash 结构化输出回显，不入协议响应）。 */
  nodeId?: string
  /** 实际启动工作目录（normalizePathForTarget 规范化后；win32 视图已转换）。 */
  cwd?: string
}

/** timeoutMs 校验：正有限整数且 ≤ 上限；非法显式抛错（不静默改默认）。 */
function assertTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `invalid_timeout: timeoutMs 必须是 (0, ${MAX_TIMEOUT_MS}] 的整数，收到 ${timeoutMs}`,
    )
  }
}

/** 外部 AbortSignal 挂到 SDK Context（预 aborted 时 exec 直接拒绝 spawn）。 */
function contextWithSignal(signal: AbortSignal | undefined): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}

/**
 * 真实 shell 执行（runGate 与 bash 工具共用）。委托 SDK NodeExecutionEnv：
 * 进程组 spawn、超时/abort 杀组、逐流增量 UTF-8 解码、到达顺序聚合。
 * 永不伪造成功；超限显式 output_limit_exceeded。
 */
export async function runShell(
  deps: HelmToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    /** 目标计算节点（缺省经会话绑定解析，再缺省 'local'）。 */
    nodeId?: string
    timeoutMs?: number
    signal?: AbortSignal
    maxOutputBytes?: number
    /**
     * 逐块流式回调（stdout/stderr 按到达序；聚合上限仍生效）：
     * POST /api/env/exec 的 NDJSON 流式模式用，不影响聚合脱敏语义。
     */
    onOutputChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
    /**
     * 调用方注入环境（如 herdr 插件的 Profile.runtime.env + 管理环境）：
     * 覆盖 process.env 同名项，但受管变量（HELM_* 与受管 token）仍固定覆盖。
     */
    env?: Record<string, string>
  } = {},
): Promise<ShellRunResult> {
  const requestedCwd = options.cwd ?? deps.defaultCwd
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertTimeoutMs(timeoutMs)
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  // 节点解析：显式 nodeId > 会话绑定（nodeIdOf） > 'local'。
  const explicitNodeId = options.nodeId ?? (options.conversationId !== undefined ? deps.nodeIdOf?.(options.conversationId) : undefined)
  const nodeId = explicitNodeId ?? 'local'
  // 宿主继承 HELM_TOKEN 兜底脱敏：runShell 是公共 API，调用方（如测试）
  // 可能未把它登记进 deps.redact——自行捕获并对一切返回文本精确替换
  //（与生产 Runtime 的 addRedaction 同效；不打印 secret 本身）。
  const hostToken = process.env['HELM_TOKEN']
  const redactAll = (text: string): string => {
    const base = deps.redact(text)
    return hostToken !== undefined && hostToken !== '' ? base.split(hostToken).join('[REDACTED]') : base
  }
  // 目标平台感知的 cwd 规范化（唯一入口 normalizePathForTarget，复用
  // protocol 原语）：local 用 Hub 宿主平台，远端仅用 EnvFabric 注册登记
  // 平台（未知则原样透传，不猜、不 fallback local）；win32 目标上 WSL /
  // Git Bash 的 POSIX 视图转换为规范 Windows 路径，无法映射的裸 POSIX 根
  // 显式 invalid_path（保留原始路径）。
  const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
  const cwdNorm = normalizePathForTarget(requestedCwd, platformInfo)
  if (!cwdNorm.ok) {
    return {
      ok: false,
      exitCode: null,
      output: redactAll(invalidPathText(cwdNorm)),
      timedOut: false,
      signal: null,
    }
  }
  const cwd = cwdNorm.path
  // 执行事实回显（bash 结构化输出用）：解析出的真实节点与规范化启动目录；
  // 仅存在于内部 ShellRunResult，不进 HTTP EnvExecResponse 协议。
  const withTarget = (r: ShellRunResult): ShellRunResult => ({ ...r, nodeId, cwd })
  // 远端节点：经 EnvFabric 的 RemoteExecutionEnv 执行（绝不回退 local）；
  // 配置缺失（envFabric 未注入）与节点离线分别显式失败，绝不 fallthrough local。
  if (nodeId !== 'local') {
    const guardOutput = remoteShellGuardText(deps.envFabric, nodeId)
    if (guardOutput !== undefined) {
      return withTarget({ ok: false, exitCode: null, output: guardOutput, timedOut: false, signal: null })
    }
  }
  // 远端节点：必须经 EnvFabric（无 fabric 时显式失败，绝不回退 local）；
  // local 生产同样优先经 fabric 的 ScopedExecutionEnv（统一 env 合成权威；
  // 测试未注入 fabric 时 local 允许短生命周期直建——仅此兜底，不涉远端）。
  let shell: ExecutionEnv
  let shellEnv: Record<string, string> | undefined = options.env
  let shellInheritEnv: boolean | undefined
  if (deps.envFabric !== undefined) {
    shell = deps.envFabric.envForTarget({
      nodeId,
      cwd,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    })
    // 逐调用注入 env（如 herdr 插件的 Profile.runtime.env）：受管绑定键
    // 仍由 ScopedExecutionEnv 的 composer 固定覆盖（见 scoped-env.ts）；
    // inheritEnv 保持缺省：local 由 Scoped 合成完整 env（拷贝宿主 PATH/HOME
    // 基底、剥除受管 HELM_*、受管覆盖）后对 base 显式 inheritEnv:false
    //（SDK 不得把已剥除的宿主 HELM_* 重新带回）；远端缺省 inheritEnv 让
    // 节点守护进程合并节点宿主基底（节点真实 PATH/HOME 工具链）并剥除节点
    // 宿主 HELM_TOKEN，受管合成最后覆盖；绝不合成默认 PATH 覆盖节点工具链。
  } else if (nodeId === 'local') {
    shell = new NodeExecutionEnv({ cwd })
    // 无 fabric 兜底（测试用）：仍走既有受管合成策略（宿主基底 + 受管
    // 固定覆盖 + cliBinDir PATH 前置），自带完整 env 并显式 inheritEnv:false
    // （SDK 二次继承会把已剥除的宿主 HELM_TOKEN 重新带回）。
    shellEnv = buildToolEnv(deps, cwd, options.conversationId, options.env, nodeId)
    shellInheritEnv = false
  } else {
    return withTarget({
      ok: false,
      exitCode: null,
      output: shellEnvFabricMissingText(nodeId),
      timedOut: false,
      signal: null,
    })
  }
  // 到达顺序聚合（stdout/stderr 混排按真实到达序，非先 stdout 后 stderr）。
  // 秘密脱敏在聚合全文上做：跨 chunk 撕裂的秘密在完整拼接后必然完整匹配。
  // 流式模式（onOutputChunk 活跃）聚合预算更小：超限显式失败
  // output_limit_exceeded（绝不截断当成功）——流式客户端已收到全部逐块
  // 输出，终态 output 仅作诊断，超限即放弃聚合并如实报错。
  const aggregateLimit = options.onOutputChunk !== undefined ? STREAM_AGGREGATE_LIMIT_BYTES : maxOutputBytes
  let combined = ''
  let outputBytes = 0
  let exceeded = false
  const result = await shell.exec(
    command,
    {
      cwd,
      ...(shellEnv === undefined ? {} : { env: shellEnv }),
      ...(shellInheritEnv === undefined ? {} : { inheritEnv: shellInheritEnv }),
      timeout: timeoutMs / 1000,
      onOutput: (text, _ctx, info) => {
        // 流式逐块回调不受聚合超限影响（逐块输出是流式客户端的交付物；
        // 超限只放弃 Hub 侧终态诊断聚合，绝不中断推送）。
        if (options.onOutputChunk !== undefined) {
          try {
            options.onOutputChunk({ stream: info.stream, text })
          } catch {
            // 流式回调故障不影响聚合。
          }
        }
        if (exceeded) return
        outputBytes += Buffer.byteLength(text, 'utf8')
        if (outputBytes > aggregateLimit) {
          exceeded = true
          combined = ''
          return
        }
        combined += text
      },
    },
    contextWithSignal(options.signal),
  )
  if (!result.ok) {
    // 远端断线：命令已启动、结果未知——error.code 为 unknown，绝不重试。
    if (result.error.code === 'unknown') {
      return withTarget({
        ok: false,
        exitCode: null,
        output: redactAll(combined + (combined === '' ? '' : '\n') + `[shell unknown: ${result.error.message}]`),
        timedOut: false,
        signal: null,
      })
    }
  }
  if (exceeded) {
    const limit = options.onOutputChunk !== undefined ? aggregateLimit : maxOutputBytes
    const streamNote =
      options.onOutputChunk !== undefined
        ? '（流式模式：逐块输出已全部推送，此处仅终态诊断聚合超限）'
        : ''
    return withTarget({
      ok: false,
      exitCode: null,
      output: redactAll(
        `output_limit_exceeded: 输出超过 ${limit} 字节聚合上限，已放弃聚合。${streamNote}` +
          '请重定向到文件后用 read 分页读取，或收窄命令输出。',
      ),
      timedOut: false,
      signal: null,
    })
  }
  if (!result.ok) {
    const error = result.error
    const timedOut = error.code === 'timeout'
    const aborted = error.code === 'aborted'
    const label = aborted ? 'aborted' : timedOut ? `timeout after ${timeoutMs}ms` : error.code
    return withTarget({
      ok: false,
      exitCode: null,
      output: redactAll(
        combined + (combined === '' ? '' : '\n') + `[shell ${label}: ${error.message}]`,
      ),
      timedOut,
      signal: null,
    })
  }
  return withTarget({
    ok: result.value.exitCode === 0,
    exitCode: result.value.exitCode,
    output: redactAll(combined),
    timedOut: false,
    signal: null,
  })
}

/**
 * gate 门禁命令执行（独立 subagent 与 Workflow adapter 共用，保证只执行一次）。
 * env 使本机 Gate 与实际 Herdr 任务环境一致（插件传 Profile.runtime.env 与
 * 管理环境组成的 spawnEnv，同一 CI/工具 PATH）；受管变量仍固定覆盖。
 * timeoutMs 可选（缺省 120_000）：单次门禁超时；超时由 runShell 终止整个
 * 进程组（SIGTERM -> SIGKILL）并如实透出底层结果（timedOut=true、exitCode=null）。
 * 失败永不返回成功；输出脱敏。
 */
export async function runGate(
  deps: HelmToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    nodeId?: string
    /** 单次门禁超时毫秒数（缺省 120_000；(0, 600_000] 整数由 runShell 校验）。 */
    timeoutMs?: number
    signal?: AbortSignal
    env?: Record<string, string>
  } = {},
): Promise<{ ok: boolean; output: string; exitCode: number | null; timedOut: boolean }> {
  const result = await runShell(deps, command, {
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  return { ok: result.ok, output: result.output, exitCode: result.exitCode, timedOut: result.timedOut }
}

const bashParameters = obj({
  command: str({ description: '要执行的 shell 命令' }),
  timeoutMs: opt(
    int({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `可选超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}）`,
    }),
  ),
})

/** bash 工具（SDK defineTool；输出超阈值经 services spill）。 */
export function createBashTool(deps: HelmToolDeps): ToolRegistration<typeof bashParameters> {
  return defineTool({
    name: 'bash',
    description:
      '在会话绑定节点的 shell 中执行命令（local 为 Hub 本机；远端节点在目标节点执行）。工作目录为会话 cwd；超时默认 120 秒；输出超 32KiB 自动 spill 为产物并返回预览（用 read_artifact 读取全文）；输出超 1MiB 显式失败。',
    parameters: bashParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        exitCode: { type: ['number', 'null'] },
        output: { type: 'string' },
        timedOut: { type: 'boolean' },
        nodeId: { type: 'string', description: '实际执行节点（会话绑定解析结果）' },
        cwd: { type: 'string', description: '实际启动工作目录（目标平台规范化后，非原始入参）' },
      },
      required: ['ok', 'output'],
    } as never,
    async execute(args, api, context) {
      const agent = await api.agent(BACKGROUND_CONTEXT)
      const cwd = agent.cwd ?? deps.defaultCwd
      let result: ShellRunResult
      try {
        result = await runShell(deps, args.command, {
          cwd,
          conversationId: api.conversationId as number,
          timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: context.abortSignal,
        })
      } catch (error) {
        // invalid_timeout 等参数级错误：显式失败，绝不静默改默认。
        return {
          output: [{ type: 'text', text: deps.redact(String(error)) }],
          isError: true,
        }
      }
      const spill = await deps.artifacts.spill(
        api.conversationId as number,
        api.callId,
        result.output,
      )
      // 结构化回显实际执行事实（nodeId + 规范化启动 cwd）；文本 stdout 原样
      // 不动，绝不从外部成功文本猜测文件位置。
      const structured = redactJsonValue(
        {
          ok: result.ok,
          exitCode: result.exitCode,
          output: spill.text,
          timedOut: result.timedOut,
          ...(result.nodeId !== undefined ? { nodeId: result.nodeId } : {}),
          ...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
        },
        (t) => deps.redact(t),
      )
      // details 是持久化 UI 通道（structuredOutput 不落库）；不再携带 output——
      // 文本通道已有同一内容，避免每条 bash 结果双写 spill 预算内的全文。
      const { output: _uiDropped, ...uiFacts } = structured as Record<string, JsonValue>
      return {
        output: [{ type: 'text', text: spill.text }],
        isError: !result.ok,
        structuredOutput: structured as JsonValue,
        details: uiFacts as JsonValue,
      }
    },
  })
}
