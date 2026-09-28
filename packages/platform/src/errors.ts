import type { ProblemCode } from '@tessera/validation';

export interface AppErrorOptions {
  /** Human-readable, user-safe explanation. Never include internal details or user content. */
  detail?: string;
  retryAfterSeconds?: number;
  fieldErrors?: readonly { path: string; message: string }[];
  cause?: unknown;
}

const STATUS: Record<ProblemCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  USERNAME_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  INVALID_CODE: 400,
  WEAK_PASSWORD: 400,
  STEP_UP_REQUIRED: 403,
  LAST_CREDENTIAL: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const TITLE: Record<ProblemCode, string> = {
  BAD_REQUEST: 'Bad request',
  VALIDATION_FAILED: 'Request validation failed',
  UNAUTHENTICATED: 'Authentication required',
  FORBIDDEN: 'Forbidden',
  CSRF_REJECTED: 'Cross-site request rejected',
  NOT_FOUND: 'Not found',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  CONFLICT: 'Conflict',
  USERNAME_TAKEN: 'Username is already taken',
  INVALID_CREDENTIALS: 'Incorrect sign-in details',
  INVALID_CODE: 'Invalid or expired code',
  WEAK_PASSWORD: 'Password is too easy to guess',
  STEP_UP_REQUIRED: 'Please confirm it is you',
  LAST_CREDENTIAL: 'You cannot remove your only way to sign in',
  PAYLOAD_TOO_LARGE: 'Payload too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported media type',
  RATE_LIMITED: 'Too many requests',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable',
  INTERNAL: 'Internal error',
};

/**
 * An expected, user-presentable failure. Everything else reaching the error boundary is treated
 * as an internal error and rendered without details.
 */
export class AppError extends Error {
  readonly safeToLog = true as const;
  readonly code: ProblemCode;
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly fieldErrors: readonly { path: string; message: string }[] | undefined;

  constructor(code: ProblemCode, options: AppErrorOptions = {}) {
    super(options.detail ?? TITLE[code], { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.title = TITLE[code];
    this.detail = options.detail;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.fieldErrors = options.fieldErrors;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
