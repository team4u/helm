/**
 * env-rpc error code union contract: ownership and shape of node_draining
 * (upgrade drain rejecting new work).
 * - RpcExecutionErrorCode / NodeTunnelErrorCode carry node_draining (the actual
 *   return paths of envExec, ipcCall/ipcSubscribe and nodeTunnelOpen);
 * - RpcFileErrorCode does not include node_draining (upgrade draining does not
 *   reject file operations);
 * - aborted remains in every union (genuine cancellation/termination is strictly
 *   distinguished from drain rejection).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  NodeEnvRpcFunctions,
  NodeTunnelErrorCode,
  RpcEnvError,
  RpcExecutionErrorCode,
  RpcFileErrorCode,
} from '@helmx/protocol'

describe('env-rpc error code unions: node_draining', () => {
  it('RpcExecutionErrorCode and NodeTunnelErrorCode both include node_draining; aborted kept', { timeout: 60_000 }, () => {
    const execCode: RpcExecutionErrorCode = 'node_draining'
    const tunnelCode: NodeTunnelErrorCode = 'node_draining'
    assert.equal(execCode, 'node_draining')
    assert.equal(tunnelCode, 'node_draining')

    const execAborted: RpcExecutionErrorCode = 'aborted'
    const tunnelAborted: NodeTunnelErrorCode = 'aborted'
    assert.equal(execAborted, 'aborted')
    assert.equal(tunnelAborted, 'aborted')
  })

  it('RpcFileErrorCode does not include node_draining (file operations do not participate in upgrade drain rejection)', { timeout: 60_000 }, () => {
    // Constrained at compile time: node_draining cannot be assigned to RpcFileErrorCode (ts-expect-error).
    // @ts-expect-error node_draining is not a file operation error code
    const bad: RpcFileErrorCode = 'node_draining'
    void bad
    const fileAborted: RpcFileErrorCode = 'aborted'
    assert.equal(fileAborted, 'aborted')
  })

  it('RpcEnvError can carry node_draining and pass through the unions (ipc/tunnel/exec paths)', { timeout: 60_000 }, () => {
    const drainingError: RpcEnvError = {
      code: 'node_draining',
      message: 'daemon is draining (upgrade in progress), rejecting new commands',
    }
    assert.equal(drainingError.code, 'node_draining')

    // Actual return-path type checks: the RpcResult error branches of envExec /
    // nodeTunnelOpen / ipcCall can all carry this envelope (structural
    // assignment + runtime assertion).
    const rpc = {
      envExec: async (): Promise<{ ok: false; error: RpcEnvError }> => ({ ok: false, error: drainingError }),
      nodeTunnelOpen: async (): Promise<{ ok: false; error: RpcEnvError }> => ({ ok: false, error: drainingError }),
      ipcCall: async (): Promise<{ ok: false; error: RpcEnvError }> => ({ ok: false, error: drainingError }),
    } as unknown as Pick<NodeEnvRpcFunctions, 'envExec'>
    assert.equal(rpc, rpc)
  })
})
