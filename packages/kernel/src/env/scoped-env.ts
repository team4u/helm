/**
 * 会话作用域执行环境：同一 (nodeId, cwd) 下多个会话并发时，每条命令的
 * env 按 conversationId 现场合成（fresh），绝不缓存「上一个会话」的快照
 * （否则受管 token / SecretStash 机密会跨会话泄漏）。
 *
 * 绑定语义（fail-closed）：
 * - composer 返回的键是**绑定身份**（HELM_CONVERSATION_ID / HELM_HUB_URL /
 *   HELM_TOKEN / HELM_SECRET_* 等）：逐调用 options.env 同名键不可覆盖
 *   （防伪造作用域），其余键由逐调用 env 正常补充；
 * - 无 conversationId（两参 envFor）：不注入任何机密——没有可信
 *   作用域就不注入（fail-closed），而非借用别的会话；
 * - 远端传输共享（同 nodeId 一个连接池 + execId 路由的输出扇出），
 *   每条命令的 env 在 exec 时隔离合成。
 */

import type { ExecutionEnv, Result, ShellExecOptions, ShellExecResult } from '@earendil-works/pi-durable/env'
import type { ExecutionError } from '@earendil-works/pi-durable/env'
import type { Context } from '@earendil-works/chord/context'
import type { EnvOptionsComposer } from './fabric.js'

/** 执行靶点：会话 + 节点 + 工作目录（Profile×节点组合后的物理落点）。 */
export interface EnvTarget {
  conversationId?: number
  nodeId: string
  cwd: string
}

export interface ScopedExecutionEnv extends ExecutionEnv {
  /** 本靶点（cwd 可变视角；底座实例随靶点隔离）。 */
  readonly target: { conversationId?: number; nodeId: string; cwd: string }
}

export function createScopedExecutionEnv(
  base: ExecutionEnv,
  target: EnvTarget,
  composer: EnvOptionsComposer | undefined,
): ScopedExecutionEnv {
  const exec = async (
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> => {
    let merged: Record<string, string> | undefined = options?.env
    let composedToken = false
    if (composer !== undefined) {
      // 现场合成（fresh per exec）：不缓存，天然免疫跨会话快照泄漏。
      const composed = await composer({
        nodeId: target.nodeId,
        cwd: target.cwd,
        ...(target.conversationId === undefined ? {} : { conversationId: target.conversationId }),
      })
      composedToken = Object.hasOwn(composed, 'HELM_TOKEN')
      const perCall = options?.env ?? {}
      // 绑定键以 composer 为准（逐调用同名键不可覆盖——防伪造作用域），
      // 其余键由逐调用 env 正常补充。
      const supplemented: Record<string, string> = { ...perCall }
      for (const [key, value] of Object.entries(composed)) supplemented[key] = value
      merged = supplemented
    }
    if (target.nodeId === 'local') {
      const host: Record<string, string> = {}
      if (options?.inheritEnv !== false) {
        for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key.toUpperCase() !== 'HELM_TOKEN') host[key] = value
      }
      merged = { ...host, ...merged }
      if (composer !== undefined && !composedToken) {
        for (const key of Object.keys(merged)) if (key.toUpperCase() === 'HELM_TOKEN') delete merged[key]
      }
    }
    return base.exec(
      command,
      {
        ...(options === undefined ? {} : options),
        ...(target.nodeId === 'local' ? { inheritEnv: false } : {}),
        ...(merged === undefined || Object.keys(merged).length === 0 ? {} : { env: merged }),
      },
      context,
    )
  }

  // 委托其余全部操作；FS 操作无身份 env 需求。
  const scoped: ScopedExecutionEnv = {
    target,
    get id() {
      return base.id
    },
    get cwd(): string {
      // 靶点视角：相对路径/exec 默认 cwd 都以 target.cwd 为准。
      return target.cwd
    },
    set cwd(value: string) {
      // 仅改本靶点视角：底座实例已按靶点隔离（不影响其他会话）。
      target.cwd = value
      base.cwd = value
    },
    absolutePath: (p, ctx) => base.absolutePath(p, ctx),
    joinPath: (parts, ctx) => base.joinPath(parts, ctx),
    readTextFile: (p, ctx) => base.readTextFile(p, ctx),
    openTextLineReader: (p, ctx) => base.openTextLineReader(p, ctx),
    readTextLines: (p, o, ctx) => base.readTextLines(p, o, ctx),
    readBinaryFile: (p, ctx) => base.readBinaryFile(p, ctx),
    openBinaryReader: (p, o, ctx) => base.openBinaryReader(p, o, ctx),
    writeFile: (p, c, ctx) => base.writeFile(p, c, ctx),
    appendFile: (p, c, ctx) => base.appendFile(p, c, ctx),
    truncateFile: (p, s, ctx) => base.truncateFile(p, s, ctx),
    flushFile: (p, ctx) => base.flushFile(p, ctx),
    renameFile: (s, d, ctx) => base.renameFile(s, d, ctx),
    fileInfo: (p, ctx) => base.fileInfo(p, ctx),
    listDir: (p, ctx) => base.listDir(p, ctx),
    ...(base.listFiles === undefined ? {} : { listFiles: base.listFiles.bind(base) }),
    openDirReader: (p, ctx) => base.openDirReader(p, ctx),
    watch: (t, onChange, ctx) => base.watch(t, onChange, ctx),
    canonicalPath: (p, ctx) => base.canonicalPath(p, ctx),
    exists: (p, ctx) => base.exists(p, ctx),
    createDir: (p, o, ctx) => base.createDir(p, o, ctx),
    remove: (p, o, ctx) => base.remove(p, o, ctx),
    createTempDir: (p, ctx) => base.createTempDir(p, ctx),
    createTempFile: (o, ctx) => base.createTempFile(o, ctx),
    cleanup: (ctx) => base.cleanup(ctx),
    exec,
  } as ScopedExecutionEnv
  return scoped
}
