/**
 * Shared RPC error envelope and validation helpers used by `env-rpc-server`, `env-rpc-ipc`,
 * and `env-rpc-tunnel` so error codes and formatting share one source of truth.
 */
import type { RpcEnvError, RpcResult } from '@helm/protocol';

export type RpcErrorCode = RpcEnvError['code'];

/** Standard `node_draining` error envelope returned when rejecting new work during upgrade drain. */
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
