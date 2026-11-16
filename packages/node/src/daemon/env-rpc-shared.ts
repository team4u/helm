/**
 * env-rpc system column module sharing pure error message seal and validate assist manually: main server side
 * (env-rpc-server),Herdr IPC bridge (env-rpc-ipc) and TCP tunnel handle
 * (env-rpc-tunnel) single point shared use, error code/message semantics zero duplicate.
 */
import type { RpcEnvError, RpcResult } from '@helm/protocol';

export type RpcErrorCode = RpcEnvError['code'];

/** upgrade arrange empty refuse new error message seal: stable code node_draining + person class can read diagnose. */
export const drainingRejection = (what: string): RpcEnvError => ({
  code: 'node_draining',
  message: `daemon is draining (upgrade in progress), rejecting new ${what}`,
});

export const toRpcError = (error: unknown): RpcEnvError => {
  const anyError = error as { code?: string; message?: string; spillPath?: string } | null;
  if (anyError && typeof anyError === 'object' && anyError.code && anyError.message !== undefined) {
    return {
      code: anyError.code as RpcErrorCode,
      message: anyError.message,
      ...(anyError.spillPath !== undefined ? { spillPath: anyError.spillPath } : {}),
    };
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) };
};

export const rpcFail = <T>(error: unknown): RpcResult<T> => ({ ok: false, error: toRpcError(error) });

export const invalidInput = <T>(message: string): RpcResult<T> => ({
  ok: false,
  error: { code: 'invalid', message },
});

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
