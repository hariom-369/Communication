import {
  problemDetailsSchema,
  problemType,
  type ProblemCode,
  type ProblemDetails,
} from '@tessera/validation';
import type { z } from 'zod';

const suspendedListeners = new Set<() => void>();

/** Called when the API refuses a request because the account is suspended or banned. */
export function onAccountSuspended(listener: () => void): () => void {
  suspendedListeners.add(listener);
  return () => suspendedListeners.delete(listener);
}

/** An error response from the API (RFC 9457 problem details). */
export class ApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.problem = problem;
  }

  get code(): ProblemCode {
    return this.problem.code;
  }
}

/** The request never reached the API (offline, DNS, connection reset). */
export class NetworkError extends Error {
  constructor() {
    super('You appear to be offline. Check your connection and try again.');
    this.name = 'NetworkError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function fallbackProblem(status: number): ProblemDetails {
  const code: ProblemCode = status >= 500 ? 'INTERNAL' : 'BAD_REQUEST';
  return {
    type: problemType(code),
    code,
    title: 'Something went wrong',
    status: status >= 400 ? status : 500,
  };
}

/**
 * Calls the same-origin API. The session travels in an HttpOnly cookie the script cannot read;
 * every request carries the CSRF header the API requires (docs/authentication.md §5). Responses
 * are validated against the shared schemas, so the UI never trusts an unexpected shape.
 */
export async function api<S extends z.ZodType>(
  method: Method,
  path: `/${string}`,
  schema: S,
  body?: unknown,
  retry = true,
): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'x-tessera-csrf': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new NetworkError();
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text === '' ? undefined : JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const problem = problemDetailsSchema.safeParse(data);
    const error = new ApiError(problem.success ? problem.data : fallbackProblem(response.status));
    if (error.code === 'ACCOUNT_SUSPENDED') for (const listener of suspendedListeners) listener();
    // A read that hit a rate limit with a short wait is retried once, so a page does not fail
    // (or stay empty) because of a burst; writes are never repeated automatically.
    const wait = error.problem.retryAfterSeconds ?? 1;
    if (method === 'GET' && response.status === 429 && retry && wait <= MAX_READ_RETRY_SECONDS) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return api(method, path, schema, body, false);
    }
    throw error;
  }
  return schema.parse(data);
}

const MAX_READ_RETRY_SECONDS = 5;

/** User-facing message for any error thrown by `api`. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'RATE_LIMITED') {
      const seconds = error.problem.retryAfterSeconds;
      return seconds === undefined
        ? 'Too many attempts. Please wait and try again.'
        : `Too many attempts. Try again in ${seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`}.`;
    }
    if (error.code === 'INTERNAL') {
      return `Something went wrong on our side. Reference: ${error.problem.errorId ?? error.problem.requestId ?? 'n/a'}`;
    }
    return error.problem.detail ?? error.problem.title;
  }
  if (error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}

/** Field-level validation messages keyed by the last path segment (e.g. "body/email" → "email"). */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.problem.fieldErrors === undefined) return {};
  const result: Record<string, string> = {};
  for (const field of error.problem.fieldErrors) {
    const key = field.path.split('/').at(-1) ?? field.path;
    result[key] ??= field.message;
  }
  return result;
}
