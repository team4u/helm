/**
 * spawn 靶点解析唯一权威链（kernel 内纯函数；原生执行行与
 * ctx.host.resolveSpawnTarget 共用，插件不得自行复制规则）。
 *
 * 按需求值是刻意形态而非入口预归一化：agent_spawn around 链可经
 * next(finalRequest) 改写请求，入口快照会过期；resume 语义依赖
 * request.cwd === undefined（显式继承链回退），预填即破坏
 * （完整论证见 protocol/plugin.ts 的 resolveSpawnTarget 端口注释）。
 *
 * 语义（与既有原生派生行为逐字一致）：
 * - 节点链：显式 profile.nodeId > 父会话绑定节点 > 'local'；
 * - cwd 链：request.cwd > profile.cwd > 父会话 cwd > 宿主缺省目录；
 * - cwd 按目标节点平台统一收口（normalizeSessionCwd：win32 目标上不可映射
 *   的 POSIX cwd 显式拒绝；远端平台无可信信息时透传），由调用方注入
 *   normalize 闭包（携带其 trustedPlatform 事实源）。
 */

export interface SpawnTargetChainInput {
  /** Profile 显式声明的目标节点（缺省继承父会话）。 */
  profileNodeId?: string
  /** 父会话绑定的节点镜像。 */
  parentNodeId?: string
  /** 请求显式 cwd（优先于 Profile cwd）。 */
  requestCwd?: string
  /** Profile 显式 cwd。 */
  profileCwd?: string
  /** 父会话 cwd 镜像。 */
  parentCwd?: string
  /** 宿主缺省 cwd（cwd 链尾）。 */
  defaultCwd: string
  /** 平台收口闭包：normalize(rawCwd, nodeId) -> 规范化 cwd（非法即抛）。 */
  normalize: (cwd: string, nodeId: string) => string
}

export interface SpawnTargetChain {
  nodeId: string
  sourceCwd: string
}

/** 节点链纯解析（herdr 等外部运行时与内核同源消费的尾段语义）。 */
export function resolveSpawnTargetNodeId(profileNodeId: string | undefined, parentNodeId: string | undefined): string {
  return profileNodeId ?? parentNodeId ?? 'local'
}

/** 完整链解析：节点 + 平台收口后的源 cwd。 */
export function resolveSpawnTargetChain(input: SpawnTargetChainInput): SpawnTargetChain {
  const nodeId = resolveSpawnTargetNodeId(input.profileNodeId, input.parentNodeId)
  const rawCwd = input.requestCwd ?? input.profileCwd ?? input.parentCwd ?? input.defaultCwd
  return { nodeId, sourceCwd: input.normalize(rawCwd, nodeId) }
}
