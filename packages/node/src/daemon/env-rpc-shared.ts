/**
 * env-rpc 系列模块共享的纯错误信封与校验助手：主服务端
 * （env-rpc-server）、Herdr IPC 桥（env-rpc-ipc）与 TCP 隧道处理器
 * （env-rpc-tunnel）单点共用，错误码/消息语义零复制。
 */
import type { RpcEnvError, RpcResult } from '@helm/protocol';

export type RpcErrorCode = RpcEnvError['code'];

/** 升级排空拒新错误信封：稳定码 node_draining + 人类可读诊断。 */
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
