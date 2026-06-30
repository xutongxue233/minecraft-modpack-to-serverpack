import type { AppError } from "./types";

export function appError(
  code: string,
  message: string,
  options: { detail?: unknown; suggestion?: string; recoverable?: boolean } = {}
): AppError {
  return {
    code,
    message,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.suggestion === undefined ? {} : { suggestion: options.suggestion }),
    recoverable: options.recoverable ?? false
  };
}

export function unknownToAppError(error: unknown, fallbackCode = "E_UNKNOWN"): AppError {
  if (isAppError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return appError(fallbackCode, error.message, {
      detail: error.stack,
      recoverable: false
    });
  }

  return appError(fallbackCode, "发生未知错误。", {
    detail: error,
    recoverable: false
  });
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    "recoverable" in value
  );
}
