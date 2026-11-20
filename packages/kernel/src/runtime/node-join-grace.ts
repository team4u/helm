/**
 * node-join-grace.ts — 启动期节点回连等待屏障（机制层，策略由调用方注入）。
 *
 * 职责（单一）：给定「恢复依赖的已注册远端节点集合」，有界等待它们上线：
 * - 全部上线立即返回（早连早走，不空等满上限）；
 * - 超时返回已上线/仍离线清单，由调用方如实诊断并继续启动（绝不阻断 Hub、绝不回退本地）；
 * - 尚未监听 /ws/node 时等待无意义：调用方必须先完成 startHub 监听再进入本屏障（见 hub/main.ts 两段式引导）。
 *
 * 诚实性纪律：等待时长、结果全部显式返回（onWaitStart / 日志由调用方决定），不吞错、不猜测节点状态。
 */

/** 屏障结果：等待了哪些节点、上线了哪些、仍离线哪些、实际耗时。 */
export interface NodeJoinGraceResult {
  waitedNodeIds: string[]
  onlineNodeIds: string[]
  stillOfflineNodeIds: string[]
  elapsedMs: number
}

export interface NodeJoinGraceOptions {
  /** 恢复依赖的已注册远端节点集合（空集合直接返回，零等待）。 */
  nodeIds: ReadonlySet<string>
  /** 等待上限毫秒（<=0 直接跳过等待）。 */
  timeoutMs: number
  /** 当前在线判定（EnvFabric.isOnline）。 */
  isOnline: (nodeId: string) => boolean
  /** 节点上线事件源（NodeRegistry.onNodeChanged）；离线事件忽略。 */
  onNodeChanged: (listener: (nodeId: string, online: boolean) => void) => () => void
  /** 进程内时钟（测试注入）；缺省 Date.now。 */
  now?: () => number
  /** 结构化诊断出口（缺省 process.stderr 单行）。 */
  log?: (line: string) => void
}

/**
 * 有界等待依赖节点回连。绝无失败路径：超时是合法结果（调用方继续启动，后续恢复按
 * 真实在线态显式 node_offline），等待中的断言错误如实上抛。
 */
export async function waitForNodesOnline(options: NodeJoinGraceOptions): Promise<NodeJoinGraceResult> {
  const { nodeIds, timeoutMs, isOnline, onNodeChanged } = options
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))

  const pending = new Set<string>()
  for (const nodeId of nodeIds) {
    if (nodeId !== 'local' && !isOnline(nodeId)) pending.add(nodeId)
  }
  const waitedNodeIds = [...pending]
  if (pending.size === 0 || timeoutMs <= 0) {
    return { waitedNodeIds: [], onlineNodeIds: [], stillOfflineNodeIds: [], elapsedMs: 0 }
  }

  const startedAt = now()
  const deadline = startedAt + timeoutMs
  log(
    `[node-join-grace] waiting up to ${timeoutMs}ms for ${pending.size} registered node(s) to reconnect before recovery: ${[...pending].join(', ')}`,
  )

  return await new Promise<NodeJoinGraceResult>((resolve) => {
    let release: (() => void) | undefined
    const finish = (): void => {
      release?.()
      const onlineNodeIds = waitedNodeIds.filter((id) => isOnline(id))
      const stillOfflineNodeIds = waitedNodeIds.filter((id) => !isOnline(id))
      const elapsedMs = now() - startedAt
      if (stillOfflineNodeIds.length === 0) {
        log(`[node-join-grace] all node(s) online after ${elapsedMs}ms; proceeding with recovery`)
      } else {
        log(
          `[node-join-grace] grace expired after ${elapsedMs}ms; still offline: ${stillOfflineNodeIds.join(', ')} (proceeding; remote-bound recovery will fail explicitly with node_offline)`,
        )
      }
      resolve({ waitedNodeIds, onlineNodeIds, stillOfflineNodeIds, elapsedMs })
    }
    const timer = setTimeout(finish, Math.max(0, deadline - now()))
    const unsubscribe = onNodeChanged((nodeId, online) => {
      if (!online || !pending.has(nodeId)) return
      pending.delete(nodeId)
      if (pending.size === 0) finish()
    })
    release = () => {
      clearTimeout(timer)
      unsubscribe()
    }
  })
}
