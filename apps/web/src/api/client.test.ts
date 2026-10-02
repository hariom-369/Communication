import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { api, ApiError, errorMessage, fieldErrors, NetworkError } from './client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(body === undefined ? '' : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api client', () => {
  it('sends the CSRF header, same-origin credentials and JSON body', async () => {
    const fetchMock = respond(200, { ok: true });
    await api('POST', '/auth/logout', z.object({ ok: z.literal(true) }), {});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/auth/logout');
    expect(init.credentials).toBe('same-origin');
    expect(init.headers).toMatchObject({
      'x-tessera-csrf': '1',
      'content-type': 'application/json',
    });
    expect(init.body).toBe('{}');
  });

  it('validates successful responses against the schema', async () => {
    respond(200, { unexpected: true });
    await expect(api('GET', '/accounts/me', z.object({ id: z.string() }))).rejects.toThrow();
  });

  it('turns problem details into ApiError with user-facing messages', async () => {
    respond(429, {
      type: 't',
      code: 'RATE_LIMITED',
      title: 'Too many requests',
      status: 429,
      retryAfterSeconds: 30,
    });
    const error = await api('POST', '/auth/login', z.object({})).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(errorMessage(error)).toBe('Too many attempts. Try again in 30 seconds.');
  });

  it('retries a rate-limited read once after a short wait, but never a write', async () => {
    vi.useFakeTimers();
    const limited = () =>
      new Response(
        JSON.stringify({
          type: 't',
          code: 'RATE_LIMITED',
          title: 'Too many requests',
          status: 429,
          retryAfterSeconds: 2,
        }),
        { status: 429 },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(limited())
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'x' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const read = api('GET', '/accounts/me', z.object({ id: z.string() }));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(read).resolves.toEqual({ id: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const writes = vi.fn().mockImplementation(() => Promise.resolve(limited()));
    vi.stubGlobal('fetch', writes);
    await expect(api('POST', '/auth/logout', z.object({}), {})).rejects.toBeInstanceOf(ApiError);
    expect(writes).toHaveBeenCalledTimes(1);
    // A second limit on the retried read is reported, not retried again.
    const reads = vi.fn().mockImplementation(() => Promise.resolve(limited()));
    vi.stubGlobal('fetch', reads);
    const failing = api('GET', '/accounts/me', z.object({})).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await failing).toBeInstanceOf(ApiError);
    expect(reads).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('shows an error reference instead of internals for server errors', async () => {
    respond(500, {
      type: 't',
      code: 'INTERNAL',
      title: 'Internal error',
      status: 500,
      errorId: 'abc-123',
    });
    const error = await api('GET', '/accounts/me', z.object({})).catch((caught: unknown) => caught);
    expect(errorMessage(error)).toBe('Something went wrong on our side. Reference: abc-123');
  });

  it('copes with non-JSON error bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 })),
    );
    const error = await api('GET', '/accounts/me', z.object({})).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('INTERNAL');
  });

  it('reports network failures as offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const error = await api('GET', '/accounts/me', z.object({})).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkError);
    expect(errorMessage(error)).toMatch(/offline/);
  });

  it('maps field errors by their last path segment', async () => {
    respond(400, {
      type: 't',
      code: 'VALIDATION_FAILED',
      title: 'Request validation failed',
      status: 400,
      fieldErrors: [{ path: 'body/email', message: 'Invalid email' }],
    });
    const error = await api('POST', '/accounts', z.object({}), {}).catch(
      (caught: unknown) => caught,
    );
    expect(fieldErrors(error)).toEqual({ email: 'Invalid email' });
  });
});
