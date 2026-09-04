export class DesktopError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DesktopError';
  }
}

export function errorMessage(error: unknown, fallback = '操作失败，请重试'): string {
  if (error instanceof DesktopError) return error.message;
  if (error instanceof Error && error.name === 'ZodError') return '提交的数据格式无效';
  return fallback;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

