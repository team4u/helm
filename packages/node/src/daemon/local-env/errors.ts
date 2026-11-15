/**
 * Result 信封与错误映射（local-env 子模块）：
 *
 * 所有文件系统与进程错误如实映射为 FileError / ExecutionError
 * （code 对齐 @helm/protocol 的 RpcFileErrorCode / RpcExecutionErrorCode），
 * 绝不静默降级或伪造结果。
 */

// ---------------------------------------------------------------------------
// Result / 错误类型（code 对齐 @helm/protocol 的 Rpc*ErrorCode）
// ---------------------------------------------------------------------------

export type Result<T> = { ok: true; value: T } | { ok: false; error: FileError | ExecutionError };

export type FileErrorCode =
  | 'aborted'
  | 'not_found'
  | 'permission_denied'
  | 'not_directory'
  | 'is_directory'
  | 'invalid'
  | 'unknown';

export type ExecutionErrorCode =
  | 'aborted'
  | 'timeout'
  | 'shell_unavailable'
  | 'spawn_error'
  | 'callback_error'
  | 'unknown';

export class FileError extends Error {
  readonly code: FileErrorCode;
  readonly path?: string;
  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'FileError';
    this.code = code;
    this.path = path;
  }
}

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  /** 超时/中止时超阈值的完整输出溢写文件路径。 */
  spillPath?: string;
  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExecutionError';
    this.code = code;
  }
}

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <T>(error: FileError | ExecutionError): { ok: false; error: FileError | ExecutionError } => ({
  ok: false,
  error,
});

export const toError = (error: unknown): Error => {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
};

interface NodeError extends Error {
  code?: string;
  path?: string;
}

export const isNodeError = (error: unknown): error is NodeError =>
  error instanceof Error && 'code' in error;

export function toFileError(error: unknown, fallbackPath?: string): FileError {
  if (error instanceof FileError) return error;
  const cause = toError(error);
  const nodeError = isNodeError(error) ? error : undefined;
  const path = typeof nodeError?.path === 'string' ? nodeError.path : fallbackPath;
  if (nodeError) {
    const message = nodeError.message;
    switch (nodeError.code) {
      case 'ABORT_ERR':
        return new FileError('aborted', message, path, cause);
      case 'ENOENT':
        return new FileError('not_found', message, path, cause);
      case 'EACCES':
      case 'EPERM':
        return new FileError('permission_denied', message, path, cause);
      case 'ENOTDIR':
        return new FileError('not_directory', message, path, cause);
      case 'EISDIR':
        return new FileError('is_directory', message, path, cause);
      case 'EINVAL':
        return new FileError('invalid', message, path, cause);
    }
  }
  return new FileError('unknown', cause.message, path, cause);
}

export const abortResult = (signal: AbortSignal | undefined, path?: string) =>
  signal?.aborted ? err(new FileError('aborted', 'aborted', path)) : undefined;
