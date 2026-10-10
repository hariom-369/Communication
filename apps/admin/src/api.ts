import {
  problemDetailsSchema,
  problemType,
  type ProblemCode,
  type ProblemDetails,
} from '@tessera/validation';
import type { z } from 'zod';

const signedOutListeners = new Set<() => void>();

/** Called when the API says the session is gone (expired, idle, revoked, or the admin disabled). */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

/** An error response from the admin API (RFC 9457 problem details). */
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

export class NetworkError extends Error {
  constructor() {
    super('The admin API cannot be reached. Check your connection (and the access proxy).');
    this.name = 'NetworkError';
  }
}

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
 * Calls the same-origin admin API. The admin session is an HttpOnly, SameSite=Strict cookie the
 * script cannot read; every request carries the CSRF header. Responses are validated against the
 * shared schemas. Nothing is cached and nothing is retried automatically.
 */
export async function adminApi<S extends z.ZodType>(
  method: 'GET' | 'POST',
  path: `/${string}`,
  schema: S,
  body?: unknown,
): Promise<z.infer<S>> {
  let response: Response;
  try {
    response = await fetch(`/admin/v1${path}`, {
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
    if (error.code === 'UNAUTHENTICATED') for (const listener of signedOutListeners) listener();
    throw error;
  }
  return schema.parse(data);
}

/** User-facing message for any error thrown by `adminApi`. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'FORBIDDEN' && error.problem.detail === undefined)
      return 'Your current roles do not allow this.';
    if (error.code === 'NOT_FOUND')
      return error.problem.detail ?? 'Not found — or not reachable for the purpose you gave.';
    if (error.code === 'INTERNAL')
      return `Something went wrong on our side. Reference: ${error.problem.errorId ?? error.problem.requestId ?? 'n/a'}`;
    if (error.code === 'RATE_LIMITED')
      return `Too many requests. Try again in ${String(error.problem.retryAfterSeconds ?? 60)} seconds.`;
    if (error.problem.fieldErrors !== undefined && error.problem.fieldErrors.length > 0)
      return error.problem.fieldErrors.map((field) => field.message).join(' ');
    return error.problem.detail ?? error.problem.title;
  }
  if (error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
