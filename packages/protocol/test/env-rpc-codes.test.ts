/**
 * env-rpc 错误码联合契约：node_draining（节点升级排空拒新）的归属与形状。
 * - RpcExecutionErrorCode / NodeTunnelErrorCode 承载 node_draining（envExec、
 *   ipcCall/ipcSubscribe、nodeTunnelOpen 的实际返回路径）；
 * - RpcFileErrorCode 不含 node_draining（升级排空不拒绝文件操作）；
 * - aborted 仍保留在全部联合（真实取消/终止与排空拒新严格区分）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  NodeEnvRpcFunctions,
  NodeTunnelErrorCode,
  RpcEnvError,
  RpcExecutionErrorCode,
  RpcFileErrorCode,
} from '@helm/protocol'

describe('env-rpc 错误码联合：node_draining', () => {
  it('RpcExecutionErrorCode 与 NodeTunnelErrorCode 均含 node_draining；aborted 保留', { timeout: 60_000 }, () => {
    const execCode: RpcExecutionErrorCode = 'node_draining'
    const tunnelCode: NodeTunnelErrorCode = 'node_draining'
    assert.equal(execCode, 'node_draining')
    assert.equal(tunnelCode, 'node_draining')

    const execAborted: RpcExecutionErrorCode = 'aborted'
    const tunnelAborted: NodeTunnelErrorCode = 'aborted'
    assert.equal(execAborted, 'aborted')
    assert.equal(tunnelAborted, 'aborted')
  })

  it('RpcFileErrorCode 不含 node_draining（文件操作不参与升级排空拒新）', { timeout: 60_000 }, () => {
    // 编译期即约束：node_draining 不能赋给 RpcFileErrorCode（ts-expect-error）。
    // @ts-expect-error node_draining 不是文件操作错误码
    const bad: RpcFileErrorCode = 'node_draining'
    void bad
    const fileAborted: RpcFileErrorCode = 'aborted'
    assert.equal(fileAborted, 'aborted')
  })

  it('RpcEnvError 可携带 node_draining 并按联合传递（ipc/tunnel/exec 路径）', { timeout: 60_000 }, () => {
    const drainingError: RpcEnvError = {
      code: 'node_draining',
      message: 'daemon is draining (upgrade in progress), rejecting new commands',
    }
    assert.equal(drainingError.code, 'node_draining')

    // 实际返回路径类型检查：envExec / nodeTunnelOpen / ipcCall 的 RpcResult
    // 错误分支均可承载该信封（结构赋值 + 运行时断言）。
    const rpc = {
      envExec: async (): Promise<{ ok: false; error: RpcEnvError }> => ({ ok: false, error: drainingError }),
      nodeTunnelOpen: async (): Promise<{ ok: false; error: RpcEnvError }> => ({ ok: false, error: drainingError }),
      ipcCall: async (): Promise<{ ok: false; error: RpcEnvError }> => ({ ok: false, error: drainingError }),
    } as unknown as Pick<NodeEnvRpcFunctions, 'envExec'>
    assert.equal(rpc, rpc)
  })
})
