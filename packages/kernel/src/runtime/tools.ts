/**
 * 内核自带本机工具：bash（真实进程组、超时、abort、跨 chunk UTF-8 保真、
 * 输出限额显式报错）、read（按 cwd 安全读文件，realpath 防软链越界）与
 * read_artifact（spill 产物分页读取，UTF-8 边界对齐保证前进）。
 *
 * - shell 执行委托 SDK `NodeExecutionEnv.exec`（`@earendil-works/pi-durable/env/node`）：
 *   预先 aborted 的 Context 绝不 spawn；abort/timeout 杀整个进程组并可靠等待子进程
 *   退出（listener/timer 全清理，不泄露进程）；stdout/stderr 各自 `StreamDecoder` 增量
 *   解码，多字节字符跨 chunk 不撕裂；`onOutput` 按到达顺序拼接（非先 stdout 后 stderr）。
 * - 跨节点执行（EnvFabric）：runShell/read/write/edit 按 (nodeId, cwd,
 *   conversationId) 靶点在目标节点执行；nodeId !== 'local' 时经
 *   deps.envFabric（离线显式 node_offline，断线显式 unknown；EnvFabric
 *   缺失时仅允许 local 短生命周期直建，远端显式 env_fabric_missing），
 *   绝不静默回退 local 误读写 Hub 本机磁盘。
 * - 跨平台路径形状：目标路径一律按其自身形状（POSIX 绝对 / Windows 盘符绝对 /
 *   UNC）选用纯 posix/win32 规则做词法解析与 containment，绝不用 Hub 宿主
 *   node:path 默认规则解析远端路径（Linux Hub 上 resolve('C:\\workspace') 会得到
 *   错误结果，Windows/mac/Linux 跨平台承诺即不成立）；containment 在基准为根目录
 *   （/ 或 C:\\）时不叠加分隔符（防 '//' 前缀误拒根下合法文件）；盘符相对路径
 *   （C:relative）语义依赖进程当前目录，一律显式拒绝。
 * - env 注入（唯一权威在 env/scoped-env.ts 的 ScopedExecutionEnv）：local
 *   继承 process.env（真实 PATH/HOME）并剥除受管 HELM_* 变量（大小写
 *   不敏感），受管变量（HELM_ENV / HELM_HUB_URL / HELM_CONVERSATION_ID /
 *   HELM_CWD / HELM_DATA_DIR / HELM_NODE_ID / 受管 HELM_TOKEN）由 composer
 *   （buildManagedEnv）现场合成固定覆盖，deps.cliBinDir 前置注入 PATH；
 *   远端节点绝不携带 Hub 宿主环境、也绝不合成默认 PATH（节点守护进程
 *   自身合并节点 PATH/HOME 并剥除节点宿主 HELM_TOKEN）；远端
 *   HELM_HUB_URL 仅取节点注册时上报的真实 hubUrl（未上报则省略该键，
 *   绝不 fallback Hub 本机地址）。本文件不再有第二套合成规则。
 * - runShell 对宿主继承 HELM_TOKEN 做兜底脱敏：即使调用方未把宿主 token 登记进
 *   deps.redact，返回的一切聚合文本也对捕获到的宿主 token 做精确替换脱敏。
 * - HELM_TOKEN 剥除按大小写不敏感处理（Windows 环境变量名语义：helm_token /
 *   Helm_Token 等同名变体一并剥除，受管值最后固定覆写）。
 * - SecretStash 脱敏在聚合完成的全文上执行（先完整拼接再 redact，跨 chunk 撕裂的
 *   秘密也必然完整匹配），绝不反向还原；超长输出经 services.ArtifactService.spill 落盘。
 * - 输出超过 maxOutputBytes 显式失败 `output_limit_exceeded`（绝不截断当成功）。
 * - read 用 fs.promises（不阻主线程）；realpath 解析 base 与 target 后做 containment，
 *   拒绝目录与软链越界；远端节点经 env RPC 的 canonicalPath/fileInfo/readTextFile
 *   同样做 realpath 越界检查；read 错误一律脱敏。
 * - write/edit 工具：会话 (nodeId, cwd) 内安全写文本与精确替换（唯一匹配校验），
 *   越出 cwd 的绝对路径 / `..` 逃逸 / 指向 cwd 外的软链一律拒绝；读-改-写窗口经
 *   env/file-mutation-queue 与插件 API 共享同一目标节点 canonical 路径互斥队列
 *   （同文件不丢更新；详见该文件契约）。
 * - spill 指引指向 read_artifact；分页 ≤4KiB 防同量 spill 循环；
 *   read_artifact 仅允许当前会话（含父会话授权链）产物，不接受任意路径。
 * - timeoutMs 必须为正有限整数且 ≤ 上限，非法值显式 invalid_timeout。
 */

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Context, JsonValue } from '@earendil-works/chord'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { bool, int, obj, opt, str } from '@earendil-works/pi-schema'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { composeExecutionEnv } from '../env/scoped-env.js'
import { envWithFileMutationQueue, localWithFileMutationQueue } from '../env/file-mutation-queue.js'
import { redactJsonValue } from '../redact.js'
import type { HelmToolDeps } from './tool-deps.js'

/**
 * Windows 盘符（不区分大小写）：C: / c: 等。
 */
const WINDOWS_DRIVE = /^[A-Za-z]:/
/** Windows 盘符绝对（C:\\x / C:/x：盘符后紧跟分隔符）。 */
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/
/** Windows 盘符相对（C:relative / 裸 C:）：语义依赖进程当前目录，靶点执行拒绝。 */
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:($|[^\\/])/

/**
 * 目标路径形状（按路径自身形式判定，与 Hub 宿主平台无关）：
 * - 'posix'：以 / 开头的 POSIX 绝对路径；
 * - 'win32'：Windows 盘符绝对（C:\\x / C:/x）或 UNC / 根反斜杠（\\\\server\\\\share）；
 * - undefined：相对路径（跟随会话 cwd 靶点的形状）。
 */
export function targetPathShape(p: string): 'posix' | 'win32' | undefined {
  if (p.startsWith('/')) return 'posix'
  if (p.startsWith('\\') || WINDOWS_DRIVE_ABSOLUTE.test(p)) return 'win32'
  return undefined
}

/** 按形状选纯路径规则（供 routes/runtime 复用；不依赖 Hub 宿主平台）。 */
export function pathRulesForShape(shape: 'posix' | 'win32' | undefined): typeof posix | typeof win32 {
  return shape === 'win32' ? win32 : posix
}

/** 目标路径是否绝对（POSIX / 开头、Windows 盘符绝对或 UNC / 根反斜杠）。 */
export function isAbsoluteTargetPath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || WINDOWS_DRIVE_ABSOLUTE.test(p)
}

/**
 * 按目标形状解析绝对路径：base 必须与 raw 同形状（或 raw 为相对路径）；
 * 盘符相对路径（C:relative / 裸 C:）一律拒绝（依赖进程 cwd，语义不可预测）。
 */
export function resolveTargetPath(raw: string, base: string): { ok: true; abs: string } | { ok: false; reason: string } {
  if (WINDOWS_DRIVE.test(raw) && WINDOWS_DRIVE_RELATIVE.test(raw)) {
    return { ok: false, reason: `盘符相对路径依赖进程当前目录，拒绝：${raw}` }
  }
  const shape = targetPathShape(raw) ?? targetPathShape(base)
  const rules = pathRulesForShape(shape)
  return { ok: true, abs: rules.resolve(base, raw) }
}

/**
 * containment（词法）：target 是否等于 base 或在 base 之下。
 * 用 target 自身形状的纯规则；base 为根目录（/ 或 C:\\）时不叠加分隔符
 * （base + sep 会形成 '//' 错误前缀，误拒根目录下合法文件）。
 */
export function isWithinBase(target: string, base: string): boolean {
  const shape = targetPathShape(target)
  const baseShape = targetPathShape(base)
  if (shape && baseShape && shape !== baseShape) return false
  const rules = pathRulesForShape(shape ?? baseShape)
  const relative = rules.relative(base, target)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + rules.sep) && !rules.isAbsolute(relative))
}

const DEFAULT_TIMEOUT_MS = 120_000
/** timeoutMs 上限：与默认值同量级，防超大值变相无限等待。 */
export const MAX_TIMEOUT_MS = 600_000
const ARTIFACT_PAGE_BYTES = 4 * 1024
/** bash 输出聚合上限（UTF-8 字节）：超过显式失败，绝不静默截断当成功。 */
export const MAX_OUTPUT_BYTES = 1024 * 1024
/** 流式模式（onOutputChunk）聚合预算：逐块推送不受影响（逐块输出是流式
 *  客户端的交付物），Hub 侧仅留终态诊断聚合；超限同样显式
 *  output_limit_exceeded（旧 64MiB 全文复制是内存泄漏，见审计）。 */
export const STREAM_AGGREGATE_LIMIT_BYTES = 256 * 1024
/** read 工具单文件上限：与 spill 预览链路一致的明确限额。 */
export const READ_FILE_MAX_BYTES = 128 * 1024

export interface ShellRunResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  signal: string | null
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
  const cwd = options.cwd ?? deps.defaultCwd
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertTimeoutMs(timeoutMs)
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  // 节点解析：显式 nodeId > 会话绑定（nodeIdOf） > 'local'。
  const explicitNodeId = options.nodeId ?? (options.conversationId !== undefined ? deps.nodeIdOf?.(options.conversationId) : undefined)
  const nodeId = explicitNodeId ?? 'local'
  // 宿主继承 HELM_TOKEN 兜底脱敏：runShell 是公共 API，调用方（如测试）
  // 可能未把它登记进 deps.redact——自行捕获并对一切返回文本精确替换
  // （与生产 Runtime 的 addRedaction 同效；不打印 secret 本身）。
  const hostToken = process.env['HELM_TOKEN']
  const redactAll = (text: string): string => {
    const base = deps.redact(text)
    return hostToken !== undefined && hostToken !== '' ? base.split(hostToken).join('[REDACTED]') : base
  }
  // 远端节点：经 EnvFabric 的 RemoteExecutionEnv 执行（绝不回退 local）；
  // 配置缺失（envFabric 未注入）与节点离线分别显式失败，绝不 fallthrough local。
  if (nodeId !== 'local') {
    if (deps.envFabric === undefined) {
      return {
        ok: false,
        exitCode: null,
        output: `env_fabric_missing: 节点 ${nodeId} 为远端但 EnvFabric 未注入（无法建立远端执行，绝不回退本机）`,
        timedOut: false,
        signal: null,
      }
    }
    if (!deps.envFabric.isOnline(nodeId)) {
      return {
        ok: false,
        exitCode: null,
        output: `node_offline: 节点 ${nodeId} 离线或未接入，无法在远端执行命令（绝不回退本机执行）`,
        timedOut: false,
        signal: null,
      }
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
    return {
      ok: false,
      exitCode: null,
      output: `env_fabric_missing: 节点 ${nodeId} 为远端但 EnvFabric 未注入（无法建立远端执行，绝不回退本机）`,
      timedOut: false,
      signal: null,
    }
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
      return {
        ok: false,
        exitCode: null,
        output: redactAll(combined + (combined === '' ? '' : '\n') + `[shell unknown: ${result.error.message}]`),
        timedOut: false,
        signal: null,
      }
    }
  }
  if (exceeded) {
    const limit = options.onOutputChunk !== undefined ? aggregateLimit : maxOutputBytes
    const streamNote =
      options.onOutputChunk !== undefined
        ? '（流式模式：逐块输出已全部推送，此处仅终态诊断聚合超限）'
        : ''
    return {
      ok: false,
      exitCode: null,
      output: redactAll(
        `output_limit_exceeded: 输出超过 ${limit} 字节聚合上限，已放弃聚合。${streamNote}` +
          '请重定向到文件后用 read 分页读取，或收窄命令输出。',
      ),
      timedOut: false,
      signal: null,
    }
  }
  if (!result.ok) {
    const error = result.error
    const timedOut = error.code === 'timeout'
    const aborted = error.code === 'aborted'
    const label = aborted ? 'aborted' : timedOut ? `timeout after ${timeoutMs}ms` : error.code
    return {
      ok: false,
      exitCode: null,
      output: redactAll(
        combined + (combined === '' ? '' : '\n') + `[shell ${label}: ${error.message}]`,
      ),
      timedOut,
      signal: null,
    }
  }
  return {
    ok: result.value.exitCode === 0,
    exitCode: result.value.exitCode,
    output: redactAll(combined),
    timedOut: false,
    signal: null,
  }
}

/**
 * gate 门禁命令执行（独立 subagent 与 Workflow adapter 共用，保证只执行一次）。
 * env 使本机 Gate 与实际 Herdr 任务环境一致（插件传 Profile.runtime.env 与
 * 管理环境组成的 spawnEnv，同一 CI/工具 PATH）；受管变量仍固定覆盖。
 * 失败永不返回成功；输出脱敏。
 */
export async function runGate(
  deps: HelmToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    nodeId?: string
    signal?: AbortSignal
    env?: Record<string, string>
  } = {},
): Promise<{ ok: boolean; output: string }> {
  const result = await runShell(deps, command, { ...options, timeoutMs: DEFAULT_TIMEOUT_MS })
  return { ok: result.ok, output: result.output }
}

/** 组装工具环境：process.env < options.env < 受管变量（固定覆盖，见 buildManagedEnv）。 */
export function buildToolEnv(
  deps: HelmToolDeps,
  cwd: string,
  conversationId?: number,
  extraEnv?: Record<string, string>,
  nodeId: string = 'local',
): Record<string, string> {
  return composeExecutionEnv(nodeId, buildManagedEnv(deps, cwd, conversationId, nodeId), extraEnv, {
    cliBinDir: deps.cliBinDir,
  })
}

/**
 * 宿主受管环境变量（不含 process.env）：会话 SecretStash 注入 + 固定覆盖的
 * HELM_ENV / HELM_HUB_URL / HELM_CONVERSATION_ID / HELM_CWD /（仅 local）
 * HELM_DATA_DIR，以及受管 HELM_TOKEN（无受管 token 时绝不透传同名继承值）。
 * local（继承 process.env）与远端（不携带宿主进程环境）共用此构造。
 * 远端专用语义：
 * - HELM_HUB_URL 仅取节点 register 时上报的真实回连地址（守恒）；节点未上报
 *   时省略该键（daemon 侧保持其 shellEnv 的真实 hubUrl），绝不 fallback
 *   deps.hubUrl（那可能是 Hub 本机 127.0.0.1，远端不可达）；
 * - HELM_DATA_DIR 是 Hub 本机路径，不注入远端（防节点误用 Hub 磁盘路径）；
 * - HELM_TOKEN 为 Hub 进程受管 token：远端子进程凭它经 HTTP 回连 Hub 鉴权
 *  （verifyToken 认进程内摘要；诚实边界：token 会出现在远端机器内存/环境，
 *   与本机子进程同权，不承诺对远端机器零泄漏）。
 */
export function buildManagedEnv(
  deps: HelmToolDeps,
  cwd: string,
  conversationId?: number,
  nodeId: string = 'local',
): Record<string, string> {
  const stashEnv = conversationId === undefined ? {} : deps.stashEnvFor(conversationId)
  const managedToken = deps.processToken?.()
  // 远端回连地址守恒：仅用节点注册时上报的真实 hubUrl；未上报则省略该键，
  // 绝不 fallback deps.hubUrl（Hub 本机地址对远端不可达）。
  const nodeHubUrl = nodeId !== 'local' ? deps.envFabric?.getNodeHubUrl(nodeId) : undefined
  const hubUrl = nodeId === 'local' ? deps.hubUrl : nodeHubUrl
  const env: Record<string, string> = {
    ...stashEnv,
    HELM_ENV: '1',
    ...(hubUrl !== undefined ? { HELM_HUB_URL: hubUrl } : {}),
    HELM_CONVERSATION_ID: String(conversationId ?? 0),
    HELM_CWD: cwd,
    ...(nodeId === 'local' ? { HELM_DATA_DIR: deps.dataDir } : {}),
    HELM_NODE_ID: nodeId,
  }
  if (managedToken === undefined) delete env['HELM_TOKEN']
  else env['HELM_TOKEN'] = managedToken
  return env
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
export function createBashTool(deps: HelmToolDeps): ToolRegistration<typeof bashParameters, never> {
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
      const structured = redactJsonValue(
        {
          ok: result.ok,
          exitCode: result.exitCode,
          output: spill.text,
          timedOut: result.timedOut,
        },
        (t) => deps.redact(t),
      )
      return {
        output: [{ type: 'text', text: spill.text }],
        isError: !result.ok,
        structuredOutput: structured as JsonValue,
      }
    },
  })
}

const readParameters = obj({
  path: str({ description: '文件路径（相对会话 cwd）' }),
})

/** read 工具：按会话 (nodeId, cwd) 安全读取文本文件（realpath 拦截软链越界；远端经 env RPC）。 */
export function createReadTool(deps: HelmToolDeps): ToolRegistration<typeof readParameters, never> {
  return defineTool({
    name: 'read',
    description:
      '读取文本文件内容；路径相对会话 cwd，拒绝越界绝对路径、../ 逃逸与软链指向目录外的目标；单文件上限 128KiB（超限请用 bash + read_artifact 分页）；会话绑定远端节点时在目标节点读取。',
    parameters: readParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    } as never,
    async execute(args, api, context) {
      const raw = args.path
      const agent = await api.agent(BACKGROUND_CONTEXT)
      // 路径语义按会话 cwd 靶点形状（POSIX/Windows）解析，绝不用 Hub 宿主
      // node:path 默认规则解析远端路径（Linux Hub 上 resolve('C:\\x') 会得到
      // 错误结果）；api.agent 与工具共享同一 SDK Context（cancel 传播到远端）。
      const sessionId = agent.cwd ?? deps.defaultCwd
      const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
      if (!isAbsoluteTargetPath(sessionId)) {
        return {
          output: [
            { type: 'text', text: `read_failed: 会话 cwd 非绝对路径（${sessionId}），拒绝读取` },
          ],
          isError: true,
        }
      }
      const resolvedR = resolveTargetPath(raw, sessionId)
      if (!resolvedR.ok) {
        return { output: [{ type: 'text', text: `path_escape_denied: ${resolvedR.reason}` }], isError: true }
      }
      const lexicalAbs = resolvedR.abs
      if (!isWithinBase(lexicalAbs, sessionId)) {
        return {
          output: [
            {
              type: 'text',
              text: `path_escape_denied: ${raw}（解析为 ${lexicalAbs}，越出会话 cwd ${sessionId}）`,
            },
          ],
          isError: true,
        }
      }
      try {
        if (nodeId !== 'local') {
          if (deps.envFabric === undefined) {
            return {
              output: [
                {
                  type: 'text',
                  text: `env_fabric_missing: 节点 ${nodeId} 为远端但 EnvFabric 未注入（无法读取远端文件，绝不回退本机）`,
                },
              ],
              isError: true,
            }
          }
          // 远端节点：经 env RPC 的 canonicalPath + fileInfo + readTextFile。
          if (!deps.envFabric.isOnline(nodeId)) {
            return {
              output: [{ type: 'text', text: `node_offline: 节点 ${nodeId} 离线，无法读取远端文件（绝不回退本机）` }],
              isError: true,
            }
          }
          const env = deps.envFabric.envFor(nodeId, sessionId)
          const baseRealR = await env.canonicalPath(sessionId, context)
          if (!baseRealR.ok) throw new Error(baseRealR.error.message)
          const baseReal = baseRealR.value
          const targetRealR = await env.canonicalPath(lexicalAbs, context)
          if (!targetRealR.ok) throw new Error(targetRealR.error.message)
          const targetReal = targetRealR.value
          if (!isWithinBase(targetReal, baseReal)) {
            return {
              output: [
                {
                  type: 'text',
                  text: `path_escape_denied: ${raw}（基准目录 ${baseReal}，canonicalPath 后越界）`,
                },
              ],
              isError: true,
            }
          }
          const infoR = await env.fileInfo(targetReal, context)
          if (!infoR.ok) throw new Error(infoR.error.message)
          if (infoR.value.kind === 'directory') {
            return {
              output: [{ type: 'text', text: `read_failed: ${raw} 是目录，read 仅支持普通文件` }],
              isError: true,
            }
          }
          if (infoR.value.kind !== 'file') {
            return {
              output: [
                { type: 'text', text: `read_failed: ${raw} 不是普通文件（kind=${infoR.value.kind}）` },
              ],
              isError: true,
            }
          }
          if (infoR.value.size > READ_FILE_MAX_BYTES) {
            return {
              output: [
                {
                  type: 'text',
                  text:
                    `file_too_large: ${raw} 为 ${infoR.value.size} 字节，超过 read 工具 ${READ_FILE_MAX_BYTES} 字节上限。` +
                    '请用 bash 命令输出到文件后经 read_artifact 分页读取，或用 head/tail/sed 取所需片段。',
                },
              ],
              isError: true,
            }
          }
          const contentR = await env.readTextFile(targetReal, context)
          if (!contentR.ok) throw new Error(contentR.error.message)
          const content = deps.redact(contentR.value)
          const spill = await deps.artifacts.spill(
            api.conversationId as number,
            `read-${api.callId}`,
            content,
          )
          return {
            output: [{ type: 'text', text: spill.text }],
            structuredOutput: { path: raw, content: spill.text } as JsonValue,
          }
        }
        // local 节点：进程内 fs（realpath 解析两侧再 containment：lexical 前缀检查绕不过软链）。
        const [baseReal, targetReal] = await Promise.all([
          realpath(sessionId),
          realpath(lexicalAbs),
        ])
        if (!isWithinBase(targetReal, baseReal)) {
          return {
            output: [
              {
                type: 'text',
                text: `path_escape_denied: ${raw}（基准目录 ${baseReal}，realpath 后越界）`,
              },
            ],
            isError: true,
          }
        }
        const info = await lstat(targetReal)
        if (info.isDirectory()) {
          return {
            output: [{ type: 'text', text: `read_failed: ${raw} 是目录，read 仅支持普通文件` }],
            isError: true,
          }
        }
        if (!info.isFile()) {
          return {
            output: [
              {
                type: 'text',
                text: `read_failed: ${raw} 不是普通文件（${info.isSymbolicLink() ? 'symlink' : '特殊文件'}）`,
              },
            ],
            isError: true,
          }
        }
        const size = (await stat(targetReal)).size
        if (size > READ_FILE_MAX_BYTES) {
          return {
            output: [
              {
                type: 'text',
                text:
                  `file_too_large: ${raw} 为 ${size} 字节，超过 read 工具 ${READ_FILE_MAX_BYTES} 字节上限。` +
                  '请用 bash 命令输出到文件后经 read_artifact 分页读取，或用 head/tail/sed 取所需片段。',
              },
            ],
            isError: true,
          }
        }
        const content = deps.redact(await readFile(targetReal, 'utf8'))
        const spill = await deps.artifacts.spill(
          api.conversationId as number,
          `read-${api.callId}`,
          content,
        )
        return {
          output: [{ type: 'text', text: spill.text }],
          structuredOutput: { path: raw, content: spill.text } as JsonValue,
        }
      } catch (error) {
        return {
          output: [{ type: 'text', text: `read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

/**
 * write/edit 共享：解析会话靶点 (nodeId, cwd)。
 * 会话 cwd 按其自身形状（POSIX/Windows）保留原样，绝不用 Hub 宿主 resolve
 * 污染（远端节点可能是 Windows 靶点，Hub 在 Linux 上 resolve 会得到错误结果）。
 */
function resolveToolTarget(
  deps: HelmToolDeps,
  api: { agent(cwd: unknown): Promise<{ cwd?: string }>; conversationId: number | string },
): { nodeId: string; base: string } | { error: string } {
  // 同步取 agent cwd：read/write/edit 的 makeApi 测试替身与 SDK 契约均为
  // Promise<agent>；resolveToolTarget 改为 async 后由调用方 await。
  return (async () => {
    const agent = await api.agent(BACKGROUND_CONTEXT)
    const base = agent.cwd ?? deps.defaultCwd
    if (!isAbsoluteTargetPath(base)) {
      return { error: `会话 cwd 非绝对路径（${base}），拒绝文件操作` }
    }
    const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
    return { nodeId, base }
  })() as never
}

/**
 * 靶点内路径安全解析：拒绝越出 base 的绝对路径与 `..` 逃逸。
 * 词法解析与 containment 一律按目标路径形状的纯 posix/win32 规则
 * （绝不用 Hub 宿主 path 默认规则解析远端路径）；基准为根目录时不叠加
 * 分隔符（防 '//' 前缀误拒）。已存在目标经 canonicalPath/realpath 后再做
 * containment（软链越界拒绝）；新文件（不存在）逐级向上找最近已存在祖先
 * 并校验其真实路径仍在 base 内——但权限错误（permission_denied）绝不当
 * 「不存在」处理（显式上抛，不静默误判）。
 */
async function resolveWritableTarget(
  env: {
    canonicalPath(
      path: string,
      ctx: Context,
    ): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>
  },
  raw: string,
  base: string,
  context: Context,
): Promise<{ ok: true; abs: string; baseReal: string } | { ok: false; message: string }> {
  // 词法预检：拒绝任何形式的越界输入（绝对路径仅允许 base 内部）；
  // 盘符相对路径（C:relative）在此显式拒绝。
  const resolvedR = resolveTargetPath(raw, base)
  if (!resolvedR.ok) return { ok: false, message: `path_escape_denied: ${resolvedR.reason}` }
  const absolute = resolvedR.abs
  if (!isWithinBase(absolute, base)) {
    return {
      ok: false,
      message: `path_escape_denied: ${raw}（解析为 ${absolute}，越出会话 cwd ${base}）`,
    }
  }
  const baseRealR = await env.canonicalPath(base, context)
  if (!baseRealR.ok) return { ok: false, message: `read_failed: 无法解析会话 cwd（${baseRealR.error.message}）` }
  const baseReal = baseRealR.value
  const targetRealR = await env.canonicalPath(absolute, context)
  if (targetRealR.ok) {
    const targetReal = targetRealR.value
    if (!isWithinBase(targetReal, baseReal)) {
      return {
        ok: false,
        message: `path_escape_denied: ${raw}（基准目录 ${baseReal}，canonicalPath 后越界；拒绝软链指向 cwd 外的目标）`,
      }
    }
    return { ok: true, abs: targetReal, baseReal }
  }
  // 目标不存在：允许在 cwd 内创建新文件（词法 containment 已过）；
  // 逐级向上找最近的已存在祖先并校验其真实路径仍在 base 内（防软链中转逃逸）。
  // 权限错误（permission_denied）不是「不存在」：显式上抛，绝不误当缺失父目录。
  // dirname 按目标形状规则（win32 靶点下反斜杠才是分隔符；posix.dirname 会把
  // 'C:\workspace\src' 当无分隔符字符串，探测链会立即走错）。
  const rules = pathRulesForShape(targetPathShape(absolute) ?? targetPathShape(base))
  let probe = rules.dirname(absolute)
  for (let depth = 0; depth < 64; depth += 1) {
    const probeR = await env.canonicalPath(probe, context)
    if (probeR.ok) {
      if (!isWithinBase(probeR.value, baseReal)) {
        return {
          ok: false,
          message: `path_escape_denied: ${raw}（祖先目录 ${probe} 经软链越出会话 cwd，拒绝写入）`,
        }
      }
      return { ok: true, abs: absolute, baseReal }
    }
    if (probeR.error.code === 'permission_denied') {
      return {
        ok: false,
        message: `write_failed: 无权探测祖先目录 ${probe}（${probeR.error.message}）`,
      }
    }
    const parent = rules.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  return { ok: true, abs: absolute, baseReal }
}

const writeParameters = obj({
  path: str({ description: '目标文件路径（相对会话 cwd；允许在 cwd 内创建新文件或子目录）' }),
  content: str({ description: '要写入的 UTF-8 文本内容（整体覆盖）' }),
  artifact: opt(
    bool({
      description:
        '是否同时登记为当前会话产物（Web 界面可见/可预览/可下载，并在输出中返回 [Artifact] id=<id>；在回复正文中可用 [文件名](artifact:<id>) 或 ![图片](artifact:<id>) 直接渲染）',
    }),
  ),
})

/** write 工具：在会话 (nodeId, cwd) 内安全写入文本文件（拒绝越界与软链逃逸）。 */
export function createWriteTool(deps: HelmToolDeps): ToolRegistration<typeof writeParameters, never> {
  return defineTool({
    name: 'write',
    description:
      '写入 UTF-8 文本文件（整体覆盖）。路径相对会话 cwd；允许在 cwd 内创建新文件或子目录；拒绝越出 cwd 的绝对路径、../ 逃逸与指向 cwd 外的软链；会话绑定远端节点时在目标节点写入。默认文件仅写入会话 cwd（Web 界面不可见）；若需交付用户在 Web 预览或下载，传 artifact: true 同步登记为会话产物并获取产物 ID，在回复中用 [文件名](artifact:<id>) 或 ![标题](artifact:<id>) 直接渲染到聊天界面。',
    parameters: writeParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        bytesWritten: { type: 'number' },
        artifactId: { type: 'string' },
      },
      required: ['path', 'bytesWritten'],
    } as never,
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api as never)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `write_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base } = target0
      try {
        const onWriteSuccess = async (targetAbs: string, bytes: number) => {
          if (args.artifact === true) {
            if (deps.artifacts.writeUploaded === undefined) {
              return {
                output: [
                  {
                    type: 'text' as const,
                    text: 'write_failed: 产物服务未配置 writeUploaded，无法登记会话产物',
                  },
                ],
                isError: true,
              }
            }
            const fileName = pathRulesForShape(targetPathShape(targetAbs)).basename(targetAbs)
            const meta = await deps.artifacts.writeUploaded(api.conversationId as number, {
              name: fileName,
              bytes: Buffer.from(args.content, 'utf8'),
            })
            return {
              output: [
                {
                  type: 'text' as const,
                  text: `write_ok: ${args.path}（${bytes} 字节）\n[Artifact] id=${meta.id} name=${meta.name}`,
                },
              ],
              structuredOutput: {
                path: args.path,
                bytesWritten: bytes,
                artifactId: meta.id,
              } as JsonValue,
            }
          }
          return {
            output: [{ type: 'text' as const, text: `write_ok: ${args.path}（${bytes} 字节）` }],
            structuredOutput: { path: args.path, bytesWritten: bytes } as JsonValue,
          }
        }

        if (nodeId !== 'local') {
          if (deps.envFabric === undefined) {
            return {
              output: [
                {
                  type: 'text',
                  text: `env_fabric_missing: 节点 ${nodeId} 为远端但 EnvFabric 未注入（无法写入远端文件，绝不回退本机）`,
                },
              ],
              isError: true,
            }
          }
          if (!deps.envFabric.isOnline(nodeId)) {
            return {
              output: [{ type: 'text', text: `node_offline: 节点 ${nodeId} 离线，无法写入远端文件（绝不回退本机）` }],
              isError: true,
            }
          }
          const env = deps.envFabric.envFor(nodeId, base)
          const target = await resolveWritableTarget(env, args.path, base, context)
          if (!target.ok) {
            return { output: [{ type: 'text', text: target.message }], isError: true }
          }
          const bytes = Buffer.byteLength(args.content, 'utf8')
          // 互斥队列：同文件读-改-写窗口与插件/其他工具排队（见 env/file-mutation-queue.ts）。
          // 新文件的父目录可能不存在：先确保目录（recursive，仍在 containment 内）；
          // dirname 按目标形状规则（win32 反斜杠分隔符）。
          return await envWithFileMutationQueue(env, target.abs, async () => {
            const parent = pathRulesForShape(targetPathShape(target.abs)).dirname(target.abs)
            const mkdirResult = await env.createDir(parent, { recursive: true }, context)
            if (!mkdirResult.ok) throw new Error(mkdirResult.error.message)
            const writeResult = await env.writeFile(target.abs, args.content, context)
            if (!writeResult.ok) throw new Error(writeResult.error.message)
            return await onWriteSuccess(target.abs, bytes)
          }, context)
        }
        // local 节点：进程内 fs。
        const target = await resolveWritableTarget(
          {
            canonicalPath: async (p, _ctx) => {
              try {
                return { ok: true, value: await realpath(p) }
              } catch (error) {
                const code = (error as { code?: string }).code
                return {
                  ok: false,
                  error: {
                    // EACCES/EPERM 归一为 permission_denied（探测链区分「无权」与「不存在」）。
                    code: code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'not_found',
                    message: String(error),
                  },
                }
              }
            },
          },
          args.path,
          base,
          context,
        )
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        const bytes = Buffer.byteLength(args.content, 'utf8')
        // local 与远端共享同一进程级队列（localWithFileMutationQueue 的 key 前缀
        // 与 NodeExecutionEnv.id 一致，两种入口互斥）。
        return await localWithFileMutationQueue(target.abs, async () => {
          await mkdir(pathRulesForShape(targetPathShape(target.abs)).dirname(target.abs), { recursive: true })
          await writeFile(target.abs, args.content, 'utf8')
          return await onWriteSuccess(target.abs, bytes)
        }, context.abortSignal)
      } catch (error) {
        return {
          output: [{ type: 'text', text: `write_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

const editParameters = obj({
  path: str({ description: '目标文件路径（相对会话 cwd）' }),
  oldText: str({ description: '要被替换的精确文本（必须在文件中恰好出现一次）' }),
  newText: str({ description: '替换后的文本' }),
})

/**
 * edit 工具：精确文本替换。oldText 必须在目标文件中唯一精确匹配（不存在
 * 或出现多次均显式报错，绝不模糊替换或静默跳过）；替换后写回原文件。
 */
export function createEditTool(deps: HelmToolDeps): ToolRegistration<typeof editParameters, never> {
  return defineTool({
    name: 'edit',
    description:
      '精确替换文件文本片段。oldText 必须在文件中恰好出现一次（不存在或多次出现均报错）；路径相对会话 cwd，拒绝越界；会话绑定远端节点时在目标节点读取与写回。',
    parameters: editParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        replaced: { type: 'boolean' },
      },
      required: ['path', 'replaced'],
    } as never,
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api as never)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `edit_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base } = target0
      try {
        if (nodeId !== 'local') {
          if (deps.envFabric === undefined) {
            return {
              output: [
                {
                  type: 'text',
                  text: `env_fabric_missing: 节点 ${nodeId} 为远端但 EnvFabric 未注入（无法编辑远端文件，绝不回退本机）`,
                },
              ],
              isError: true,
            }
          }
          if (!deps.envFabric.isOnline(nodeId)) {
            return {
              output: [{ type: 'text', text: `node_offline: 节点 ${nodeId} 离线，无法编辑远端文件（绝不回退本机）` }],
              isError: true,
            }
          }
          const env = deps.envFabric.envFor(nodeId, base)
          const target = await resolveWritableTarget(env, args.path, base, context)
          if (!target.ok) {
            return { output: [{ type: 'text', text: target.message }], isError: true }
          }
          // 互斥队列：读-改-写整体持锁（读旧内容与写回之间不被其他变更插入）。
          return await envWithFileMutationQueue(env, target.abs, async () => {
            const readResult = await env.readTextFile(target.abs, context)
            if (!readResult.ok) throw new Error(readResult.error.message)
            const count = countOccurrences(readResult.value, args.oldText)
            if (count === 0) {
              return {
                output: [{ type: 'text', text: `edit_failed: oldText 在 ${args.path} 中不存在（拒绝无操作编辑）` }],
                isError: true,
              }
            }
            if (count > 1) {
              return {
                output: [
                  {
                    type: 'text',
                    text: `edit_failed: oldText 在 ${args.path} 中出现 ${count} 次（需唯一匹配；请扩大上下文使 oldText 唯一）`,
                  },
                ],
                isError: true,
              }
            }
            const updated = readResult.value.replace(args.oldText, args.newText)
            const writeResult = await env.writeFile(target.abs, updated, context)
            if (!writeResult.ok) throw new Error(writeResult.error.message)
            return {
              output: [{ type: 'text', text: `edit_ok: ${args.path}（已替换 1 处）` }],
              structuredOutput: { path: args.path, replaced: true } as JsonValue,
            }
          }, context)
        }
        // local 节点：进程内 fs。
        const target = await resolveWritableTarget(
          {
            canonicalPath: async (p, _ctx) => {
              try {
                return { ok: true, value: await realpath(p) }
              } catch (error) {
                const code = (error as { code?: string }).code
                return {
                  ok: false,
                  error: {
                    code: code === 'EACCES' || code === 'EPERM' ? 'permission_denied' : 'not_found',
                    message: String(error),
                  },
                }
              }
            },
          },
          args.path,
          base,
          context,
        )
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        return await localWithFileMutationQueue(target.abs, async () => {
          const content = await readFile(target.abs, 'utf8')
          const count = countOccurrences(content, args.oldText)
          if (count === 0) {
            return {
              output: [{ type: 'text', text: `edit_failed: oldText 在 ${args.path} 中不存在（拒绝无操作编辑）` }],
              isError: true,
            }
          }
          if (count > 1) {
            return {
              output: [
                {
                  type: 'text',
                  text: `edit_failed: oldText 在 ${args.path} 中出现 ${count} 次（需唯一匹配；请扩大上下文使 oldText 唯一）`,
                },
              ],
              isError: true,
            }
          }
          const updated = content.replace(args.oldText, args.newText)
          await writeFile(target.abs, updated, 'utf8')
          return {
            output: [{ type: 'text', text: `edit_ok: ${args.path}（已替换 1 处）` }],
            structuredOutput: { path: args.path, replaced: true } as JsonValue,
          }
        }, context.abortSignal)
      } catch (error) {
        return {
          output: [{ type: 'text', text: `edit_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

/** 非重叠出现次数统计（edit 唯一匹配校验用）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

const readArtifactParameters = obj({
  id: str({ description: '产物 ID（artifact metadata 的 id）' }),
  offset: opt(int({ minimum: 0, description: '起始字节偏移（默认 0）' })),
  limit: opt(
    int({
      minimum: 1,
      maximum: ARTIFACT_PAGE_BYTES,
      description: `本次读取字节数上限（默认 ${ARTIFACT_PAGE_BYTES}，最大 ${ARTIFACT_PAGE_BYTES}）`,
    }),
  ),
})

/**
 * read_artifact 工具：分页读取 spill 产物。仅允许当前会话及其父链授权会话的产物，
 * 不接受任意文件路径；每页 ≤4KiB，UTF-8 边界对齐且保证 nextOffset 严格前进。
 */
export function createReadArtifactTool(
  deps: HelmToolDeps,
  isAuthorized: (conversationId: number, artifactConversationId: number) => boolean,
): ToolRegistration<typeof readArtifactParameters, never> {
  return defineTool({
    name: 'read_artifact',
    description:
      '分页读取产物（spill 全文等）。每页最多 4KiB，按 UTF-8 边界对齐返回 nextOffset；为空表示已读完。',
    parameters: readArtifactParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'number' },
        nextOffset: { type: 'number' },
        chunk: { type: 'string' },
      },
      required: ['id', 'offset', 'chunk'],
    } as never,
    async execute(args, api, _context) {
      const id = args.id
      const offset = args.offset ?? 0
      const limit = args.limit ?? ARTIFACT_PAGE_BYTES
      const conversationId = api.conversationId as number
      const meta = await deps.artifacts.get(id).catch(() => undefined)
      if (!meta) {
        return {
          output: [{ type: 'text', text: `artifact_not_found: ${id}` }],
          isError: true,
        }
      }
      if (!isAuthorized(conversationId, meta.conversationId)) {
        return {
          output: [
            {
              type: 'text',
              text: `artifact_forbidden: 产物 ${id} 属于会话 ${meta.conversationId}，当前会话 ${conversationId} 无权读取`,
            },
          ],
          isError: true,
        }
      }
      let buffer: Buffer
      try {
        buffer = Buffer.from(await deps.artifacts.readBuffer(id))
      } catch (error) {
        return {
          output: [{ type: 'text', text: `artifact_read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
      if (offset > buffer.length) {
        return {
          output: [{ type: 'text', text: `offset_out_of_range: ${offset} > ${buffer.length}` }],
          isError: true,
        }
      }
      if (offset === buffer.length) {
        return {
          output: [
            { type: 'text', text: `[artifact ${id} bytes ${offset}-${offset}/${buffer.length}]\n（已读完）` },
          ],
          structuredOutput: { id, offset, chunk: '' } as JsonValue,
        }
      }
      // UTF-8 边界对齐：offset 或 end 落在多字节序列中间时，起点跳到下一个
      // 完整字符首字节、终点回退到字符起点（保前进且绝不解出替换符）。
      let start = offset
      while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1
      const end = Math.min(buffer.length, offset + limit)
      let safeEnd = Math.max(end, start)
      while (safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd -= 1
      // 兜底：limit=1 且 start 是多字节首字节时 safeEnd 可能退回 start；推进到
      // 下一个字符首字节，保证一页至少完整读出一个字符。
      while (safeEnd <= start && safeEnd < buffer.length) {
        safeEnd += 1
        while (safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd += 1
      }
      const chunk = buffer.subarray(start, safeEnd).toString('utf8')
      const hasMore = safeEnd < buffer.length
      const header = `[artifact ${id} bytes ${offset}-${safeEnd}/${buffer.length}${start > offset ? `（offset ${offset} 位于多字节字符中间，已从 ${start} 起读）` : ''}]`
      const text = hasMore ? `${header}\n${chunk}\n[nextOffset=${safeEnd}]` : `${header}\n${chunk}`
      // nextOffset 仅在还有剩余时出现，绝不输出 undefined 字段（JSON-safe）。
      const structured: Record<string, unknown> = { id, offset, chunk }
      if (hasMore) structured['nextOffset'] = safeEnd
      return {
        output: [{ type: 'text', text }],
        structuredOutput: structured as JsonValue,
      }
    },
  })
}
