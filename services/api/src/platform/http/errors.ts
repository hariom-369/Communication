import type { Logger } from '@tessera/platform';
import { AppError, isAppError } from '@tessera/platform';
import { newId } from '@tessera/shared';
import { problemType, type ProblemCode, type ProblemDetails } from '@tessera/validation';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

import { RateLimitStoreUnavailableError } from '../rate-limit.js';

/**
 * Central error boundary (docs/security.md §8). Every error response is RFC 9457
 * `application/problem+json`. Expected errors (AppError, validation, framework client errors)
 * carry user-safe text; anything else becomes a generic 500 with an `errorId` that correlates
 * with the server log. Stack traces, SQL errors and internal hostnames never reach clients.
 */
export function installErrorHandling(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler((error: unknown, request, reply) => {
    const appError = toAppError(error);
    if (appError !== undefined) {
      if (appError.status >= 500) {
        logger.error('http.dependency_error', {
          reqId: request.id,
          routeId: request.routeOptions.config.routeId ?? null,
          ...logger.errorFields(error),
        });
      }
      return sendProblem(request, reply, appError);
    }

    const errorId = newId();
    logger.error('http.unhandled_error', {
      reqId: request.id,
      errorId,
      routeId: request.routeOptions.config.routeId ?? null,
      ...logger.errorFields(error),
    });
    return sendProblem(request, reply, new AppError('INTERNAL'), errorId);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, new AppError('NOT_FOUND')),
  );
}

function toAppError(error: unknown): AppError | undefined {
  if (isAppError(error)) return error;

  if (error instanceof RateLimitStoreUnavailableError) {
    return new AppError('SERVICE_UNAVAILABLE', { retryAfterSeconds: 5 });
  }

  if (hasZodFastifySchemaValidationErrors(error)) {
    return new AppError('VALIDATION_FAILED', {
      fieldErrors: error.validation.slice(0, 50).map((issue) => ({
        path: `${error.validationContext ?? 'request'}${issue.instancePath}`,
        message: issue.message ?? 'Invalid value',
      })),
    });
  }

  if (isFastifyError(error)) {
    const code = FASTIFY_CODES[error.code];
    if (code !== undefined) return new AppError(code);
    if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
      return new AppError('BAD_REQUEST');
    }
  }
  return undefined;
}

/** Framework client errors mapped to stable codes, with our own user-safe wording. */
const FASTIFY_CODES: Partial<Record<string, ProblemCode>> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: 'BAD_REQUEST',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'BAD_REQUEST',
  FST_ERR_CTP_INVALID_JSON_BODY: 'BAD_REQUEST',
};

function isFastifyError(error: unknown): error is FastifyError {
  return (
    error instanceof Error &&
    typeof (error as Partial<FastifyError>).code === 'string' &&
    (error as FastifyError).code.startsWith('FST_')
  );
}

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AppError,
  errorId?: string,
): FastifyReply {
  const body: ProblemDetails = {
    type: problemType(error.code),
    code: error.code,
    title: error.title,
    status: error.status,
    requestId: request.id,
  };
  if (error.detail !== undefined) body.detail = error.detail;
  if (errorId !== undefined) body.errorId = errorId;
  if (error.fieldErrors !== undefined) body.fieldErrors = [...error.fieldErrors];
  if (error.retryAfterSeconds !== undefined) {
    body.retryAfterSeconds = error.retryAfterSeconds;
    void reply.header('retry-after', String(error.retryAfterSeconds));
  }
  return reply
    .code(error.status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send(JSON.stringify(body));
}
