/** CLI unify error:code for --json machine consume;exitCode non-zero i.e. failed. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: string = 'cli_error',
    readonly exitCode = 1,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface DescribedError {
  message: string;
  code: string;
  exitCode: number;
  details?: unknown;
}

export function describeError(error: unknown): DescribedError {
  if (error instanceof CliError) {
    return { message: error.message, code: error.code, exitCode: error.exitCode, details: error.details };
  }
  if (error instanceof Error) return { message: error.message, code: 'internal_error', exitCode: 1 };
  return { message: String(error), code: 'internal_error', exitCode: 1 };
}

/** and Hub HTTP error message seal same construct:{error:{code,message,details?}}. */
export function errorEnvelope(error: DescribedError): { error: { code: string; message: string; details?: unknown } } {
  const inner: { code: string; message: string; details?: unknown } = {
    code: error.code,
    message: error.message,
  };
  if (error.details !== undefined) inner.details = error.details;
  return { error: inner };
}
