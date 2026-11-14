/**
 * 内核自带本机工具：bash（真实进程组、超时、abort、跨 chunk UTF-8 保真、
 * 输出限额显式报错）、read（读文本文件）、read_artifact（spill 产物分页
 * 读取，UTF-8 边界对齐保证前进）与 register_artifact（把靶点节点上的
 * 真实普通文件复制登记为会话产物，支持二进制，上限 15 MiB）。
 * read/write/edit/register_artifact 的结构化 path 与成功消息回显真实
 * target 绝对路径（read 为词法绝对路径或远端 canonical）与 nodeId；
 * bash 结构化输出回显实际 nodeId/cwd（规范化后启动目录）；文本 stdout
 * 原样不动，绝不从外部成功文本猜测文件位置。
 *
 * 文件路径契约（read/write/edit，对齐 pi）：会话 cwd 仅作为相对路径的解析
 * 基准，绝对路径与 ../ 跨目录访问一律允许——bash 本就无文件边界，文件工具
 * 与 bash 同权，不设 cwd 沙箱；权限边界交给操作系统本身。
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
 *   UNC）选用纯 posix/win32 规则做词法解析，绝不用 Hub 宿主 node:path 默认
 *   规则解析远端路径（Linux Hub 上 resolve('C:\\workspace') 会得到错误结果，
 *   Windows/mac/Linux 跨平台承诺即不成立）；盘符相对路径（C:relative）语义
 *   依赖进程当前目录，一律显式拒绝。
 * - 目标节点平台感知的 cwd/path 规范化（唯一实现 runtime/target-platform.ts，
 *   复用 @helm/protocol normalizeTargetPath/targetPlatformOf 原语，业务入口
 *   不得各自另写规则）：local 用 Hub 宿主 process.platform，远端仅用
 *   EnvFabric.nodePlatformOf 登记平台（未知则原样透传，不猜、不 fallback
 *   local）；win32 目标上 WSL / Git Bash 的 POSIX 视图确定性转规范 Windows
 *   路径，无法映射的裸 POSIX 根显式 invalid_path 并保留原始路径；
 *   Linux/macOS 与远端 POSIX 语义不变；SDK NodeExecutionEnv / Remote 执行
 *   只接收已规范化路径。
 * - env 注入（唯一权威在 env/scoped-env.ts 的 ScopedExecutionEnv）：local
 *   继承 process.env（真实 PATH/HOME）并剥除受管 HELM_* 变量（大小写
 *   不敏感），受管变量（HELM_ENV / HELM_HUB_URL / HELM_CONVERSATION_ID /
 *   HELM_CWD / HELM_DATA_DIR / HELM_NODE_ID / HELM_EXECUTION_SCOPE /
 *   受管 HELM_TOKEN）由 composer（buildManagedEnv）现场合成固定覆盖，
 *   deps.cliBinDir 前置注入 PATH；
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
 * - read 用 fs.promises（不阻主线程）；仅支持普通文件（目录/特殊文件拒绝，
 *   单文件 128KiB 上限）；fd 读取——fstat 与读取同一 fd，校验即所读内容；
 *   远端节点经 env RPC 的 canonicalPath/fileInfo/readTextFile（canonicalPath
 *   先解析软链，使 lstat 语义的 fileInfo 看到真实目标）；read 错误一律脱敏。
 * - write/edit 工具：写文本与精确替换（oldText 唯一匹配校验）；目标已存在时
 *   经 canonicalPath/realpath 解析到真实路径再写（软链别名写到真实文件，与
 *   互斥队列 key 对齐），新文件按词法绝对路径写入；读-改-写窗口经
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
import { constants as fsConstants } from 'node:fs'
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MAX_ARTIFACT_BYTES } from '../services/artifacts.js'
import { composeExecutionEnv, MANAGED_EXEC_ENV_VARS } from '../env/scoped-env.js'
import { envWithFileMutationQueue, localWithFileMutationQueue } from '../env/file-mutation-queue.js'
import { redactJsonValue } from '../redact.js'
import {
  isAbsoluteTargetPath,
  normalizeTargetPath,
  targetPathShape,
  type TargetPlatform,
} from '@helm/protocol'
import { invalidPathText, normalizePathForTarget, targetPlatformForNode } from './target-platform.js'
import type { HelmToolDeps } from './tool-deps.js'

// 形状判定与词法规则子集（normalize/join/dirname/basename）已收口
// @helm/protocol（浏览器安全纯函数，内核与 builtin-plugins 共享）；依赖
// node:path 完整实现的 resolve 语义（进程 cwd / 大小写规则）留在内核
// （Node 环境），下方再导出 isAbsoluteTargetPath/targetPathShape 供既有
// 相对路径引用保持稳定。
export { isAbsoluteTargetPath, targetPathShape } from '@helm/protocol'

import { posix, win32 } from 'node:path'

/** Windows 盘符（不区分大小写）：C: / c: 等。 */
const WINDOWS_DRIVE = /^[A-Za-z]:/
/** Windows 盘符相对（C:relative / 裸 C:）：语义依赖进程当前目录，靶点执行拒绝。 */
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:($|[^\\/])/

/**
 * 按形状选 node:path 完整规则（内核 Node 环境专用：resolve/relative 等
 * 语义依赖 Node 实现；词法子集见 @helm/protocol pathRulesForShape）。
 */
function nodePathForShape(shape: 'posix' | 'win32' | undefined): typeof posix | typeof win32 {
  return shape === 'win32' ? win32 : posix
}

/**
 * 按目标形状解析绝对路径：base（会话 cwd）仅作相对路径基准，绝对路径与
 * ../ 跨目录均合法；盘符相对路径（C:relative / 裸 C:）一律拒绝（依赖进程
 * cwd，语义不可预测）。
 *
 * platform === 'win32'（目标节点平台已知为 Windows）：base 与绝对 raw 先经
 * protocol normalizeTargetPath 做确定性规范化（WSL /mnt/<盘符>、Git Bash
 * /<盘符>、//server/share POSIX 视图转规范 Windows 路径；无法映射的裸
 * POSIX 根显式拒绝并保留原始路径），再按 win32 规则解析相对段。platform
 * 缺省（远端平台未知）：沿用按形状选规则的既有语义（不猜平台），
 * Linux/macOS 与远端 POSIX 语义不变。
 */
export function resolveTargetPath(
  raw: string,
  base: string,
  platform?: TargetPlatform,
): { ok: true; abs: string } | { ok: false; reason: string } {
  if (WINDOWS_DRIVE.test(raw) && WINDOWS_DRIVE_RELATIVE.test(raw)) {
    return { ok: false, reason: `盘符相对路径依赖进程当前目录，拒绝：${raw}` }
  }
  if (platform === 'win32') {
    const baseN = normalizeTargetPath(base, 'win32')
    if (!baseN.ok) return { ok: false, reason: baseN.reason }
    const rawN = isAbsoluteTargetPath(raw) ? normalizeTargetPath(raw, 'win32') : undefined
    if (rawN !== undefined && !rawN.ok) return { ok: false, reason: rawN.reason }
    return { ok: true, abs: win32.resolve(baseN.path, rawN !== undefined ? rawN.path : raw) }
  }
  const shape = targetPathShape(raw) ?? targetPathShape(base)
  const rules = nodePathForShape(shape)
  return { ok: true, abs: rules.resolve(base, raw) }
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
  // （与生产 Runtime 的 addRedaction 同效；不打印 secret 本身）。
  const hostToken = process.env['HELM_TOKEN']
  const redactAll = (text: string): string => {
    const base = deps.redact(text)
    return hostToken !== undefined && hostToken !== '' ? base.split(hostToken).join('[REDACTED]') : base
  }
  // 目标平台感知的 cwd 规范化（唯一入口 normalizePathForTarget，复用
  // protocol 原语）：local 用 Hub 宿主平台，远端仅用 EnvFabric 注册登记
  // 平台（未知则原样透传，不猜、不 fallback local）；win32 目标上 WSL /
  // Git Bash 的 POSIX 视图转换为规范 Windows 路径，无法映射的裸 POSIX 根
  // 显式 invalid_path（保留原始路径）。SDK NodeExecutionEnv / Remote 执行
  // 只接收已规范化路径（bash / runGate / POST /api/env/exec 与
  // WorktreeAllocator execGit 均经本函数收敛，不得各自另写规则）。
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
    if (deps.envFabric === undefined) {
      return withTarget({
        ok: false,
        exitCode: null,
        output: `env_fabric_missing: 节点 ${nodeId} 为远端但 EnvFabric 未注入（无法建立远端执行，绝不回退本机）`,
        timedOut: false,
        signal: null,
      })
    }
    // isOnline 仅是「调用时已知晓离线」的快速失败提示；检查后到 RPC 之间
    // 断连的行为由 RemoteExecutionEnv 统一决定：等待节点重连（尊重 context
    // 取消，见 env/remote-env.ts 的离线韧性语义）。两条路径语义有意不同
    //（前者已知的确定离线立即报错，后者在途韧性等待），不是遗漏。
    if (!deps.envFabric.isOnline(nodeId)) {
      return withTarget({
        ok: false,
        exitCode: null,
        output: `node_offline: 节点 ${nodeId} 离线或未接入，无法在远端执行命令（绝不回退本机执行）`,
        timedOut: false,
        signal: null,
      })
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
      output: `env_fabric_missing: 节点 ${nodeId} 为远端但 EnvFabric 未注入（无法建立远端执行，绝不回退本机）`,
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
 * 执行作用域锚点：HELM_EXECUTION_SCOPE = `helm-<sha256 前 24 hex>`。
 * 输入仅含非机密执行事实（Helm 实例标识 dataDir、会话 ID、节点 ID、实际
 * cwd，数组 JSON 序列化防分隔符歧义）；同会话同靶点多命令恒定相同，跨
 * 会话/节点/工作树/Helm 实例不同。它是供工具显式采用的稳定资源命名提示
 * （锁文件/临时目录/缓存前缀等），不是 OS 沙箱、不承诺自动隔离第三方
 * daemon；绝不包含任何 secret。
 */
export function executionScopeHash(
  dataDir: string,
  conversationId: number | undefined,
  nodeId: string,
  cwd: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([dataDir, conversationId ?? 0, nodeId, cwd]))
    .digest('hex')
  return `helm-${digest.slice(0, 24)}`
}

/**
 * 宿主受管环境变量（不含 process.env）：会话 SecretStash 注入 + 固定覆盖的
 * HELM_ENV / HELM_HUB_URL / HELM_CONVERSATION_ID / HELM_CWD / HELM_EXECUTION_SCOPE /
 * （仅 local）HELM_DATA_DIR，以及受管 HELM_TOKEN（无受管 token 时绝不透传同名继承值）。
 * stash 键命中受管身份变量（含大小写变体）时一律剥除（Windows env 名大小写
 * 不敏感，别名劫持回连/身份/作用域变量）；受管值仅在此合成 canonical 名。
 * local（继承 process.env）与远端（不携带宿主进程环境）共用此构造。
 * options.stashEnv 可覆盖默认的「全部活跃秘密」（外部 spawn 最小授权用：
 * 传 {} 即不携带任何会话机密，只保留受管 HELM_*）。
 * 远端专用语义：
 * - HELM_HUB_URL 仅取节点 register 时上报的真实回连地址（守恒）；节点未上报
 *   时省略该键（daemon 侧保持其 shellEnv 的真实 hubUrl），绝不 fallback
 *   deps.hubUrl（那可能是 Hub 本机 127.0.0.1，远端不可达）；
 * - HELM_DATA_DIR 是 Hub 本机路径，不注入远端（防节点误用 Hub 磁盘路径）；
 * - HELM_TOKEN 为 Hub 进程受管 token：远端子进程凭它经 HTTP 回连 Hub 鉴权
 *  （verifyToken 认进程内摘要；诚实边界：token 会出现在远端机器内存/环境，
 *   与本机子进程同权，不承诺对远端机器零泄漏）。
 */
/** 受管身份变量名大写集：stash/profile 一切大小写变体均不得提供（Windows
 *  env 名大小写不敏感，lowercase 别名可在子进程读取时劫持 canonical 值）。 */
const MANAGED_ENV_UPPER = new Set<string>(MANAGED_EXEC_ENV_VARS.map((name) => name.toUpperCase()))

export function buildManagedEnv(
  deps: HelmToolDeps,
  cwd: string,
  conversationId?: number,
  nodeId: string = 'local',
  options: { stashEnv?: Record<string, string> } = {},
): Record<string, string> {
  const stashEnv =
    options.stashEnv !== undefined
      ? options.stashEnv
      : conversationId === undefined
        ? {}
        : deps.stashEnvFor(conversationId)
  // stash 一律不得携带受管身份变量（含大小写变体）：受管值仅由下方固定覆盖
  // 合成 canonical 名；secret 命中 helm_execution_scope / Helm_Cwd 等别名时
  // 直接剥除（Windows env 名大小写不敏感，别名可劫持子进程读取）。拷贝用
  // 展开语义（DefineOwnProperty）保留 __proto__ 等自有键，剥除用 delete。
  const safeStashEnv: Record<string, string> = { ...stashEnv }
  for (const key of Object.keys(stashEnv)) {
    if (MANAGED_ENV_UPPER.has(key.toUpperCase())) delete safeStashEnv[key]
  }
  const managedToken = deps.processToken?.()
  // 远端回连地址守恒：仅用节点注册时上报的真实 hubUrl；未上报则省略该键，
  // 绝不 fallback deps.hubUrl（Hub 本机地址对远端不可达）。
  const nodeHubUrl = nodeId !== 'local' ? deps.envFabric?.getNodeHubUrl(nodeId) : undefined
  const hubUrl = nodeId === 'local' ? deps.hubUrl : nodeHubUrl
  const env: Record<string, string> = {
    ...safeStashEnv,
    HELM_ENV: '1',
    ...(hubUrl !== undefined ? { HELM_HUB_URL: hubUrl } : {}),
    HELM_CONVERSATION_ID: String(conversationId ?? 0),
    HELM_CWD: cwd,
    ...(nodeId === 'local' ? { HELM_DATA_DIR: deps.dataDir } : {}),
    HELM_NODE_ID: nodeId,
    HELM_EXECUTION_SCOPE: executionScopeHash(deps.dataDir, conversationId, nodeId, cwd),
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
      return {
        output: [{ type: 'text', text: spill.text }],
        isError: !result.ok,
        structuredOutput: structured as JsonValue,
      }
    },
  })
}

const readParameters = obj({
  path: str({ description: '文件路径（相对会话 cwd 或绝对路径，支持 ../ 跨目录）' }),
})

/**
 * read 工具：按会话 (nodeId, cwd) 靶点读取文本文件。cwd 仅作相对路径基准，
 * 绝对路径与 ../ 跨目录一律允许（与 bash 同权）；仅支持普通文件，保留
 * 128KiB 上限；远端经 env RPC（canonicalPath 先解析软链，使 lstat 语义的
 * fileInfo 看到真实目标）。
 */
export function createReadTool(deps: HelmToolDeps): ToolRegistration<typeof readParameters, never> {
  return defineTool({
    name: 'read',
    description:
      '读取文本文件内容；路径相对会话 cwd 解析，支持绝对路径与 ../ 跨目录访问（与 bash 同权）；仅支持普通文件，单文件上限 128KiB（超限请用 bash + read_artifact 分页）；会话绑定远端节点时在目标节点读取。',
    parameters: readParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '实际读取的绝对路径（远端为 canonical 解析后；非原始入参）' },
        nodeId: { type: 'string', description: '实际读取节点' },
        content: { type: 'string' },
      },
      required: ['path', 'nodeId', 'content'],
    } as never,
    async execute(args, api, context) {
      const raw = args.path
      const agent = await api.agent(BACKGROUND_CONTEXT)
      // 路径语义按会话 cwd 靶点形状（POSIX/Windows）解析，绝不用 Hub 宿主
      // node:path 默认规则解析远端路径（Linux Hub 上 resolve('C:\\x') 会得到
      // 错误结果）；api.agent 与工具共享同一 SDK Context（cancel 传播到远端）。
      const sessionId = agent.cwd ?? deps.defaultCwd
      const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
      // 平台感知解析（与 bash 同一平台来源与原语）：远端平台未知时沿用按
      // 形状选规则的既有语义（不猜平台）；win32 目标上 POSIX 视图路径
      // 先确定性转换为规范 Windows 路径，无法映射的裸 POSIX 根显式拒绝。
      const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
      if (!isAbsoluteTargetPath(sessionId)) {
        return {
          output: [
            { type: 'text', text: `read_failed: 会话 cwd 非绝对路径（${sessionId}），拒绝读取` },
          ],
          isError: true,
        }
      }
      const resolvedR = resolveTargetPath(
        raw,
        sessionId,
        platformInfo.known ? platformInfo.platform : undefined,
      )
      if (!resolvedR.ok) {
        return { output: [{ type: 'text', text: `invalid_path: ${resolvedR.reason}` }], isError: true }
      }
      const lexicalAbs = resolvedR.abs
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
          // 先经 canonicalPath 解析软链：fileInfo 是 lstat 语义（软链 kind='symlink'），
          // 解析到真实目标后才能与 local 的跟随语义一致；目标不存在/悬空软链在此
          // 如实报错（catch 统一转 read_failed）。
          const targetRealR = await env.canonicalPath(lexicalAbs, context)
          if (!targetRealR.ok) throw new Error(targetRealR.error.message)
          const targetReal = targetRealR.value
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
            structuredOutput: { path: targetReal, nodeId, content: spill.text } as JsonValue,
          }
        }
        // local 节点：进程内 fs。stat（跟随软链）先做普通文件预检，给出清晰
        // 错误分类（目录/特殊文件/超限）；随后 fd 读取：fstat 与读取同一 fd，
        // 校验即所读内容（打开与预检之间目标被替换时以 fd 为准）。
        const info = await stat(lexicalAbs)
        if (info.isDirectory()) {
          return {
            output: [{ type: 'text', text: `read_failed: ${raw} 是目录，read 仅支持普通文件` }],
            isError: true,
          }
        }
        if (!info.isFile()) {
          return {
            output: [
              { type: 'text', text: `read_failed: ${raw} 不是普通文件（特殊文件）` },
            ],
            isError: true,
          }
        }
        if (info.size > READ_FILE_MAX_BYTES) {
          return {
            output: [
              {
                type: 'text',
                text:
                  `file_too_large: ${raw} 为 ${info.size} 字节，超过 read 工具 ${READ_FILE_MAX_BYTES} 字节上限。` +
                  '请用 bash 命令输出到文件后经 read_artifact 分页读取，或用 head/tail/sed 取所需片段。',
              },
            ],
            isError: true,
          }
        }
        // 打开跟随软链（与 bash 同权，软链指向哪里是用户文件系统自己的事实）；
        // 预检之后、打开之前目标被替换时，以同一 fd 上的 fstat 复核为准。
        const handle = await open(lexicalAbs, fsConstants.O_RDONLY)
        try {
          const statInfo = await handle.stat()
          if (!statInfo.isFile()) {
            return {
              output: [{ type: 'text', text: `read_failed: ${raw} 在打开后不是普通文件，拒绝读取` }],
              isError: true,
            }
          }
          if (statInfo.size > READ_FILE_MAX_BYTES) {
            return {
              output: [
                {
                  type: 'text',
                  text:
                    `file_too_large: ${raw} 为 ${statInfo.size} 字节，超过 read 工具 ${READ_FILE_MAX_BYTES} 字节上限。` +
                    '请用 bash 命令输出到文件后经 read_artifact 分页读取，或用 head/tail/sed 取所需片段。',
                },
              ],
              isError: true,
            }
          }
          const content = deps.redact(await handle.readFile({ encoding: 'utf8' }))
          const spill = await deps.artifacts.spill(
            api.conversationId as number,
            `read-${api.callId}`,
            content,
          )
          return {
            output: [{ type: 'text', text: spill.text }],
            structuredOutput: { path: lexicalAbs, nodeId, content: spill.text } as JsonValue,
          }
        } finally {
          await handle.close()
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
 * write/edit 共享：解析会话靶点 (nodeId, cwd, platform)。会话 cwd 按其
 * 自身形状（POSIX/Windows）保留原样，绝不用 Hub 宿主 resolve 污染（远端
 * 节点可能是 Windows 靶点，Hub 在 Linux 上 resolve 会得到错误结果）；
 * platform 为目标节点平台（远端未知时 undefined，按形状选规则——与
 * bash/runShell 的平台来源同一原语，不在此另写规则）。
 */
function resolveToolTarget(
  deps: HelmToolDeps,
  api: { agent(cwd: unknown): Promise<{ cwd?: string }>; conversationId: number | string },
): { nodeId: string; base: string; platform: TargetPlatform | undefined } | { error: string } {
  // 同步取 agent cwd：read/write/edit 的 makeApi 测试替身与 SDK 契约均为
  // Promise<agent>；resolveToolTarget 改为 async 后由调用方 await。
  return (async () => {
    const agent = await api.agent(BACKGROUND_CONTEXT)
    const base = agent.cwd ?? deps.defaultCwd
    if (!isAbsoluteTargetPath(base)) {
      return { error: `会话 cwd 非绝对路径（${base}），拒绝文件操作` }
    }
    const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
    const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
    return {
      nodeId,
      base,
      platform: platformInfo.known ? platformInfo.platform : undefined,
    }
  })() as never
}

/**
 * 靶点路径解析：cwd（base）仅作相对路径基准，绝对路径与 ../ 跨目录均
 * 允许（与 bash 同权，不设 cwd 沙箱）；权限边界交给操作系统本身。
 * 词法解析按目标路径形状的纯 posix/win32 规则（绝不用 Hub 宿主 path 默认
 * 规则解析远端路径）；盘符相对路径（C:relative）在此显式拒绝。目标已存在时
 * 经 canonicalPath/realpath 解析到真实路径再写——软链别名写到真实文件，
 * 且与 env/file-mutation-queue 的 canonical key 对齐；不存在（含悬空软链，
 * writeFile 会跟随它在目标处创建文件，与 bash 重定向语义一致）按词法绝对
 * 路径写入；无权探测等真实错误由后续 mkdir/writeFile 如实上抛。
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
  platform: TargetPlatform | undefined,
  context: Context,
): Promise<{ ok: true; abs: string } | { ok: false; message: string }> {
  const resolvedR = resolveTargetPath(raw, base, platform)
  if (!resolvedR.ok) return { ok: false, message: `invalid_path: ${resolvedR.reason}` }
  const absolute = resolvedR.abs
  const targetRealR = await env.canonicalPath(absolute, context)
  if (targetRealR.ok) return { ok: true, abs: targetRealR.value }
  return { ok: true, abs: absolute }
}

const writeParameters = obj({
  path: str({ description: '目标文件路径（相对会话 cwd 或绝对路径，支持 ../ 跨目录；允许创建新文件或子目录）' }),
  content: str({ description: '要写入的 UTF-8 文本内容（整体覆盖）' }),
  artifact: opt(
    bool({
      description:
        '是否同时登记为当前会话产物（Web 界面可见/可预览/可下载，并在输出中返回 [Artifact] id=<id>；在回复正文中可用 [文件名](artifact:<id>) 或 ![图片](artifact:<id>) 直接渲染）',
    }),
  ),
})

/** write 工具：按会话 (nodeId, cwd) 靶点写入文本文件（路径与 bash 同权，不设 cwd 沙箱）。 */
export function createWriteTool(deps: HelmToolDeps): ToolRegistration<typeof writeParameters, never> {
  return defineTool({
    name: 'write',
    description:
      '写入 UTF-8 文本文件（整体覆盖）。路径相对会话 cwd 解析，支持绝对路径与 ../ 跨目录访问（与 bash 同权）；允许创建新文件或子目录；会话绑定远端节点时在目标节点写入。默认文件仅写入磁盘（Web 界面不可见）；若需交付用户在 Web 预览或下载，传 artifact: true 同步登记为会话产物并获取产物 ID，在回复中用 [文件名](artifact:<id>) 或 ![标题](artifact:<id>) 直接渲染到聊天界面。',
    parameters: writeParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '实际写入的绝对路径（已存在文件为 canonical 解析后；非原始入参）' },
        nodeId: { type: 'string', description: '实际写入节点' },
        bytesWritten: { type: 'number' },
        artifactId: { type: 'string' },
      },
      required: ['path', 'nodeId', 'bytesWritten'],
    } as never,
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api as never)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `write_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
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
            const fileName = nodePathForShape(targetPathShape(targetAbs)).basename(targetAbs)
            const meta = await deps.artifacts.writeUploaded(api.conversationId as number, {
              name: fileName,
              bytes: Buffer.from(args.content, 'utf8'),
            })
            return {
              output: [
                {
                  type: 'text' as const,
                  text: `write_ok: ${targetAbs}（节点 ${nodeId}，${bytes} 字节）\n[Artifact] id=${meta.id} name=${meta.name}`,
                },
              ],
              structuredOutput: {
                path: targetAbs,
                nodeId,
                bytesWritten: bytes,
                artifactId: meta.id,
              } as JsonValue,
            }
          }
          return {
            output: [
              { type: 'text' as const, text: `write_ok: ${targetAbs}（节点 ${nodeId}，${bytes} 字节）` },
            ],
            structuredOutput: { path: targetAbs, nodeId, bytesWritten: bytes } as JsonValue,
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
          const target = await resolveWritableTarget(env, args.path, base, platform, context)
          if (!target.ok) {
            return { output: [{ type: 'text', text: target.message }], isError: true }
          }
          const bytes = Buffer.byteLength(args.content, 'utf8')
          // 互斥队列：同文件读-改-写窗口与插件/其他工具排队（见 env/file-mutation-queue.ts）。
          // 新文件的父目录可能不存在：先确保目录（recursive）；dirname 按目标
          // 形状规则（win32 反斜杠分隔符）。
          return await envWithFileMutationQueue(env, target.abs, async () => {
            const parent = nodePathForShape(targetPathShape(target.abs)).dirname(target.abs)
            const mkdirResult = await env.createDir(parent, { recursive: true }, context)
            if (!mkdirResult.ok) throw new Error(mkdirResult.error.message)
            const writeResult = await env.writeFile(target.abs, args.content, context)
            if (!writeResult.ok) throw new Error(writeResult.error.message)
            return await onWriteSuccess(target.abs, bytes)
          }, context)
        }
        // local 节点：进程内 fs（canonicalPath 直接用 realpath；解析失败（不
        // 存在/悬空软链/无权等）一律按「不存在」处理，真实错误由随后的
        // mkdir/writeFile 如实上抛）。
        const target = await resolveWritableTarget(
          {
            canonicalPath: async (p, _ctx) => {
              try {
                return { ok: true, value: await realpath(p) }
              } catch (error) {
                return {
                  ok: false,
                  error: {
                    code: (error as { code?: string }).code ?? 'not_found',
                    message: String(error),
                  },
                }
              }
            },
          },
          args.path,
          base,
          platform,
          context,
        )
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        const bytes = Buffer.byteLength(args.content, 'utf8')
        // local 与远端共享同一进程级队列（localWithFileMutationQueue 的 key 前缀
        // 与 NodeExecutionEnv.id 一致，两种入口互斥）。
        return await localWithFileMutationQueue(target.abs, async () => {
          await mkdir(nodePathForShape(targetPathShape(target.abs)).dirname(target.abs), { recursive: true })
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
  path: str({ description: '目标文件路径（相对会话 cwd 或绝对路径，支持 ../ 跨目录）' }),
  oldText: str({ description: '要被替换的精确文本（必须在文件中恰好出现一次）' }),
  newText: str({ description: '替换后的文本' }),
})

/**
 * edit 工具：精确文本替换。oldText 必须在目标文件中唯一精确匹配（不存在
 * 或出现多次均显式报错，绝不模糊替换或静默跳过）；替换后写回原文件；
 * 路径解析与 write 同契约（与 bash 同权，不设 cwd 沙箱）。
 */
export function createEditTool(deps: HelmToolDeps): ToolRegistration<typeof editParameters, never> {
  return defineTool({
    name: 'edit',
    description:
      '精确替换文件文本片段。oldText 必须在文件中恰好出现一次（不存在或多次出现均报错）；路径相对会话 cwd 解析，支持绝对路径与 ../ 跨目录访问（与 bash 同权）；会话绑定远端节点时在目标节点读取与写回。',
    parameters: editParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '实际编辑的绝对路径（canonical 解析后；非原始入参）' },
        nodeId: { type: 'string', description: '实际编辑节点' },
        replaced: { type: 'boolean' },
      },
      required: ['path', 'nodeId', 'replaced'],
    } as never,
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api as never)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `edit_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
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
          const target = await resolveWritableTarget(env, args.path, base, platform, context)
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
                output: [
                  { type: 'text', text: `edit_failed: oldText 在 ${target.abs} 中不存在（拒绝无操作编辑）` },
                ],
                isError: true,
              }
            }
            if (count > 1) {
              return {
                output: [
                  {
                    type: 'text',
                    text: `edit_failed: oldText 在 ${target.abs} 中出现 ${count} 次（需唯一匹配；请扩大上下文使 oldText 唯一）`,
                  },
                ],
                isError: true,
              }
            }
            const updated = readResult.value.replace(args.oldText, args.newText)
            const writeResult = await env.writeFile(target.abs, updated, context)
            if (!writeResult.ok) throw new Error(writeResult.error.message)
            return {
              output: [
                { type: 'text', text: `edit_ok: ${target.abs}（节点 ${nodeId}，已替换 1 处）` },
              ],
              structuredOutput: { path: target.abs, nodeId, replaced: true } as JsonValue,
            }
          }, context)
        }
        // local 节点：进程内 fs（canonicalPath 直接用 realpath；解析失败按
        //「不存在」处理，真实错误由随后的 readFile/writeFile 如实上抛）。
        const target = await resolveWritableTarget(
          {
            canonicalPath: async (p, _ctx) => {
              try {
                return { ok: true, value: await realpath(p) }
              } catch (error) {
                return {
                  ok: false,
                  error: {
                    code: (error as { code?: string }).code ?? 'not_found',
                    message: String(error),
                  },
                }
              }
            },
          },
          args.path,
          base,
          platform,
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
              output: [
                { type: 'text', text: `edit_failed: oldText 在 ${target.abs} 中不存在（拒绝无操作编辑）` },
              ],
              isError: true,
            }
          }
          if (count > 1) {
            return {
              output: [
                {
                  type: 'text',
                  text: `edit_failed: oldText 在 ${target.abs} 中出现 ${count} 次（需唯一匹配；请扩大上下文使 oldText 唯一）`,
                },
              ],
              isError: true,
            }
          }
          const updated = content.replace(args.oldText, args.newText)
          await writeFile(target.abs, updated, 'utf8')
          return {
            output: [
              { type: 'text', text: `edit_ok: ${target.abs}（节点 ${nodeId}，已替换 1 处）` },
            ],
            structuredOutput: { path: target.abs, nodeId, replaced: true } as JsonValue,
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

const registerArtifactParameters = obj({
  path: str({ description: '要登记为会话产物的源文件路径（相对会话 cwd 或绝对路径，支持 ../ 跨目录，与 bash 同权）' }),
  name: opt(str({ description: '产物展示名（缺省用源文件名）' })),
  mimeType: opt(str({ description: 'MIME 类型（缺省按扩展名探测；文本类会脱敏后落盘，二进制字节原样保留）' })),
})

/** register_artifact local 读取结果：成功携带完整字节；失败为机器可读码。 */
export type ArtifactFileBytes =
  | { ok: true; bytes: Buffer; size: number }
  | { ok: false; code: 'artifact_too_large'; read: number }
  | { ok: false; code: 'file_changed'; detail: string }

/**
 * helper 读取所需的最小句柄面（结构化：真实 FileHandle 天然满足，测试可用
 * 包装真实句柄注入短读/读途中变更，不需模拟整个 FileHandle）。
 */
export interface ArtifactReadHandle {
  stat(): Promise<{ size: number; mtimeMs: number; ctimeMs: number }>
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number; buffer: Buffer }>
}

/** 单次读取块大小（有界循环读，避免一次性占 15 MiB 缓冲）。 */
const ARTIFACT_READ_CHUNK_BYTES = 256 * 1024

/** local 打开标志：O_RDONLY + 平台支持时 O_NONBLOCK。stat 预检与 open 之间存在
 *  竞态窗口（普通文件被换成 FIFO/设备文件会使纯 O_RDONLY 的 open 无限阻塞），
 *  O_NONBLOCK 让 open 立即返回、由同一 fd 上的 fstat 权威拒绝；Windows
 *  libuv 不支持 O_NONBLOCK，仅用 O_RDONLY（Windows 无 FIFO，风险面不同）。 */
function artifactOpenFlags(): number {
  return process.platform === 'win32'
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | (fsConstants as { O_NONBLOCK?: number }).O_NONBLOCK!
}

/**
 * 同一 FileHandle 上有界读到 EOF（register_artifact local 路径唯一实现）：
 * - 逐块循环读到 EOF：单次短读只推进游标继续循环，绝不把短读当完整文件
 *  （旧实现一次性 read(size) 在文件增长时最多读到旧 size，把静默截断的
 *  前缀当成功登记）；
 * - 总预算 MAX_ARTIFACT_BYTES + 1：读到超限即停并显式 artifact_too_large
 *  （读上限+1 字节即为超限实证，绝无 bytesRead > MAX 永假的死分支）；
 * - 读取前后同一 fd fstat 对比 size/mtime/ctime：中途被追加/截断/改写时
 *  显式 file_changed，绝不把旧前缀登记成功（无快照系统，只做前后对比）。
 */
export async function readArtifactBytesFromHandle(handle: ArtifactReadHandle): Promise<ArtifactFileBytes> {
  const before = await handle.stat()
  const budget = MAX_ARTIFACT_BYTES + 1
  const chunks: Buffer[] = []
  let total = 0
  let position = 0
  for (;;) {
    const want = Math.min(ARTIFACT_READ_CHUNK_BYTES, budget - total)
    if (want <= 0) return { ok: false, code: 'artifact_too_large', read: total }
    const chunk = Buffer.alloc(want)
    const { bytesRead } = await handle.read(chunk, 0, want, position)
    if (bytesRead === 0) break
    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
    position += bytesRead
    if (total > MAX_ARTIFACT_BYTES) return { ok: false, code: 'artifact_too_large', read: total }
  }
  const after = await handle.stat()
  if (
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    return {
      ok: false,
      code: 'file_changed',
      detail: `读取期间文件发生变化（size ${before.size} -> ${after.size}，mtime ${before.mtimeMs} -> ${after.mtimeMs}，ctime ${before.ctimeMs} -> ${after.ctimeMs}），拒绝登记可能不完整的快照`,
    }
  }
  return { ok: true, bytes: Buffer.concat(chunks, total), size: after.size }
}

/**
 * register_artifact 工具：把会话靶点节点上的真实普通文件复制登记为当前
 * 会话产物（经 artifacts.writeUploaded 落 Hub 数据目录，Web 可预览/下载）。
 *
 * 诚实性契约：
 * - 在目标节点读取真实文件字节（远端必经 EnvFabric 的 canonicalPath /
 *   fileInfo / readBinaryFile；节点离线或 EnvFabric 缺失显式失败，绝不回退
 *   local 误读 Hub 本机磁盘）；
 * - 只接受普通文件（目录/特殊文件拒绝）：stat 预检分类（无竞态场景）+
 *   O_NONBLOCK（平台支持时）open 封 stat→open 竞态窗口（换成 FIFO 不阻塞）
 *   + 同一 fd fstat 权威复核；上限 MAX_ARTIFACT_BYTES（15 MiB，与上传入口
 *   一致），读前预检 + 读后字节数复核；
 * - local 有界循环读到 EOF（短读继续循环，绝不把单次短读/旧 size 前缀当
 *   完整文件；读到上限+1 即实证超限），读取前后同一 fd stat 对比
 *   size/mtime/ctime，中途变更显式 file_changed（见 readArtifactBytesFromHandle）；
 * - 结构化结果回显 artifactId、源文件绝对路径（local 为词法绝对路径、远端
 *   为 canonical 解析后）、nodeId、name、size/mime；二进制保真与文本脱敏
 *   由 ArtifactService 统一处理；一切异常文本经 deps.redact 脱敏。
 */
export function createRegisterArtifactTool(
  deps: HelmToolDeps,
): ToolRegistration<typeof registerArtifactParameters, never> {
  return defineTool({
    name: 'register_artifact',
    description:
      '把会话靶点节点上的真实普通文件登记为当前会话产物（复制进 Hub 数据目录，Web 界面可见/可预览/可下载）。支持二进制（字节原样保真）与文本（脱敏后落盘）；单文件上限 15 MiB；会话绑定远端节点时在目标节点读取，绝不回退本机。生成新文本内容时优先用 write(..., artifact: true)；本工具用于把已有文件（如命令输出、构建产物、图片）交给用户。',
    parameters: registerArtifactParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: '产物 ID（可用 [文件名](artifact:<id>) 渲染）' },
        path: { type: 'string', description: '源文件绝对路径（远端为 canonical 解析后）' },
        nodeId: { type: 'string', description: '实际读取节点' },
        name: { type: 'string', description: '产物展示名' },
        size: { type: 'number', description: '登记字节数（文本类为脱敏后大小）' },
        mimeType: { type: 'string', description: '产物 MIME 类型' },
      },
      required: ['artifactId', 'path', 'nodeId', 'name', 'size', 'mimeType'],
    } as never,
    async execute(args, api, context) {
      if (deps.artifacts.writeUploaded === undefined) {
        return {
          output: [
            { type: 'text', text: 'register_failed: 产物服务未配置 writeUploaded，无法登记会话产物' },
          ],
          isError: true,
        }
      }
      const target0 = await resolveToolTarget(deps, api as never)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `register_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      try {
        const resolvedR = resolveTargetPath(args.path, base, platform)
        if (!resolvedR.ok) {
          return { output: [{ type: 'text', text: `invalid_path: ${resolvedR.reason}` }], isError: true }
        }
        const lexicalAbs = resolvedR.abs
        const displayName =
          args.name ?? nodePathForShape(targetPathShape(lexicalAbs)).basename(lexicalAbs)
        let bytes: Uint8Array
        let sourcePath: string
        if (nodeId !== 'local') {
          // 远端：必经 EnvFabric（缺失/离线显式失败，绝不回退 local）。
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
          if (!deps.envFabric.isOnline(nodeId)) {
            return {
              output: [
                { type: 'text', text: `node_offline: 节点 ${nodeId} 离线，无法读取远端文件（绝不回退本机）` },
              ],
              isError: true,
            }
          }
          const env = deps.envFabric.envFor(nodeId, base)
          // canonicalPath 先解析软链（与 read 一致）：fileInfo 是 lstat 语义。
          const targetRealR = await env.canonicalPath(lexicalAbs, context)
          if (!targetRealR.ok) throw new Error(targetRealR.error.message)
          sourcePath = targetRealR.value
          const infoR = await env.fileInfo(sourcePath, context)
          if (!infoR.ok) throw new Error(infoR.error.message)
          const info = infoR.value
          if (info.kind === 'directory') {
            return {
              output: [
                { type: 'text', text: `register_failed: ${args.path} 是目录，register_artifact 仅支持普通文件` },
              ],
              isError: true,
            }
          }
          if (info.kind !== 'file') {
            return {
              output: [
                { type: 'text', text: `register_failed: ${args.path} 不是普通文件（kind=${info.kind}）` },
              ],
              isError: true,
            }
          }
          if (info.size > MAX_ARTIFACT_BYTES) {
            return {
              output: [
                {
                  type: 'text',
                  text: `artifact_too_large: ${args.path} 为 ${info.size} 字节，超过单产物 ${MAX_ARTIFACT_BYTES} 字节（15 MiB）上限`,
                },
              ],
              isError: true,
            }
          }
          const bytesR = await env.readBinaryFile(sourcePath, context)
          if (!bytesR.ok) throw new Error(bytesR.error.message)
          bytes = bytesR.value
          // 读后复核：预检与读取之间文件可能增长，超限显式拒绝（不截断当成功）。
          if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
            return {
              output: [
                {
                  type: 'text',
                  text: `artifact_too_large: ${args.path} 读取到 ${bytes.byteLength} 字节，超过单产物 ${MAX_ARTIFACT_BYTES} 字节（15 MiB）上限`,
                },
              ],
              isError: true,
            }
          }
        } else {
          // local：与 read 工具同构——先 stat（跟随软链）预检分类（目录/特殊
          // 文件/超限；FIFO 等特殊文件在无竞态场景下预检即拒绝）；打开用
          // O_NONBLOCK（平台支持时）封住 stat→open 竞态窗口（普通文件被换成
          // FIFO 后纯 O_RDONLY 的 open 会无限阻塞）；同一 fd 上 fstat 权威复核
          // 后有界循环读到 EOF（短读继续、超限实证、中途变更显式 file_changed，
          // 见 readArtifactBytesFromHandle）。
          const preInfo = await stat(lexicalAbs)
          if (preInfo.isDirectory()) {
            return {
              output: [
                { type: 'text', text: `register_failed: ${args.path} 是目录，register_artifact 仅支持普通文件` },
              ],
              isError: true,
            }
          }
          if (!preInfo.isFile()) {
            return {
              output: [
                { type: 'text', text: `register_failed: ${args.path} 不是普通文件（特殊文件）` },
              ],
              isError: true,
            }
          }
          if (preInfo.size > MAX_ARTIFACT_BYTES) {
            return {
              output: [
                {
                  type: 'text',
                  text: `artifact_too_large: ${args.path} 为 ${preInfo.size} 字节，超过单产物 ${MAX_ARTIFACT_BYTES} 字节（15 MiB）上限`,
                },
              ],
              isError: true,
            }
          }
          const handle = await open(lexicalAbs, artifactOpenFlags())
          try {
            const statInfo = await handle.stat()
            if (statInfo.isDirectory()) {
              return {
                output: [
                  { type: 'text', text: `register_failed: ${args.path} 是目录，register_artifact 仅支持普通文件` },
                ],
                isError: true,
              }
            }
            if (!statInfo.isFile()) {
              return {
                output: [
                  { type: 'text', text: `register_failed: ${args.path} 在打开后不是普通文件（特殊文件），拒绝读取` },
                ],
                isError: true,
              }
            }
            if (statInfo.size > MAX_ARTIFACT_BYTES) {
              return {
                output: [
                  {
                    type: 'text',
                    text: `artifact_too_large: ${args.path} 为 ${statInfo.size} 字节，超过单产物 ${MAX_ARTIFACT_BYTES} 字节（15 MiB）上限`,
                  },
                ],
                isError: true,
              }
            }
            const read = await readArtifactBytesFromHandle(handle)
            if (!read.ok) {
              if (read.code === 'artifact_too_large') {
                return {
                  output: [
                    {
                      type: 'text',
                      text: `artifact_too_large: ${args.path} 读取到 ${read.read} 字节，超过单产物 ${MAX_ARTIFACT_BYTES} 字节（15 MiB）上限`,
                    },
                  ],
                  isError: true,
                }
              }
              return {
                output: [
                  { type: 'text', text: `file_changed: ${args.path} ${read.detail}` },
                ],
                isError: true,
              }
            }
            bytes = read.bytes
          } finally {
            await handle.close()
          }
          sourcePath = lexicalAbs
        }
        const meta = await deps.artifacts.writeUploaded(api.conversationId as number, {
          name: displayName,
          bytes,
          ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
        })
        return {
          output: [
            {
              type: 'text',
              text:
                `[Artifact] id=${meta.id} name=${meta.name}\n` +
                `register_artifact_ok: 源 ${sourcePath}（节点 ${nodeId}，${meta.size} 字节，${meta.mimeType}）`,
            },
          ],
          structuredOutput: {
            artifactId: meta.id,
            path: sourcePath,
            nodeId,
            name: meta.name,
            size: meta.size,
            mimeType: meta.mimeType,
          } as JsonValue,
        }
      } catch (error) {
        return {
          output: [{ type: 'text', text: `register_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
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
