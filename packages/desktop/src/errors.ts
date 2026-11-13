/**
 * 桌面壳错误类型：入口边界强校验 + 显式错误码（禁止静默降级）。
 * 语义与 kernel HelmError 对齐但不依赖 @helm/protocol（桌面壳零 workspace 运行时依赖）。
 */
export class DesktopError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'DesktopError';
    this.code = code;
    this.details = details;
  }
}
