/**
 * desktop shell error type: entry boundary strong validate + explicit error code (forbidden static default fall back).
 * semantics and kernel HelmError align but independent of @helm/protocol(desktop shell zero workspace runtime dependency).
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
