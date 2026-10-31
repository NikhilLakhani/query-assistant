import type { ErrorCode } from '@query-assistant/contracts';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export const errorStatus: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ACCOUNT_DISABLED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_ACTIVATION: 410,
  CSRF_INVALID: 403,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  CONCURRENCY_LIMIT: 409,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_REJECTED: 502,
  GENERATION_TIMEOUT: 504,
  STORAGE_UNAVAILABLE: 503,
  SERVICE_NOT_READY: 503,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INTERNAL_ERROR: 500,
};
