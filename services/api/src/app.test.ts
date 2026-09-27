import { problemDetailsSchema } from '@tessera/validation';
import { afterEach, describe, expect, it } from 'vitest';

import { buildTestApp, sameSiteHeaders, TEST_ORIGIN, type TestApp } from './test/helpers.js';

let current: TestApp | undefined;
async function setup(...args: Parameters<typeof buildTestApp>): Promise<TestApp> {
  current = await buildTestApp(...args);
  return current;
}
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

function expectProblem(body: string, code: string, status: number) {
  const parsed = problemDetailsSchema.parse(JSON.parse(body));
  expect(parsed.code).toBe(code);
  expect(parsed.status).toBe(status);
  return parsed;
}

describe('security headers', () => {
  it('are present on success and error responses', async () => {
    const { app } = await setup();
    for (const url of ['/api/v1/meta/version', '/api/v1/does-not-exist']) {
      const response = await app.inject({ url });
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['strict-transport-security']).toContain('max-age=63072000');
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['server']).toBeUndefined();
    }
  });

  it('omits HSTS when disabled (non-production)', async () => {
    const { app } = await setup({ hsts: false });
    const response = await app.inject({ url: '/api/v1/meta/version' });
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('request ids', () => {
  it('are server-generated UUIDv7 values and ignore client-supplied ids', async () => {
    const { app } = await setup();
    const response = await app.inject({
      url: '/api/v1/meta/version',
      headers: { 'x-request-id': 'attacker-chosen' },
    });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-request-id']).not.toBe('attacker-chosen');
  });
});

describe('error contract', () => {
  it('returns problem+json for unknown routes', async () => {
    const { app } = await setup();
    const response = await app.inject({ url: '/api/v1/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expectProblem(response.body, 'NOT_FOUND', 404);
  });

  it('hides internal details of unexpected errors and correlates them with logs', async () => {
    const { app, logs } = await setup();
    const response = await app.inject({ url: '/api/v1/test/boom' });
    expect(response.statusCode).toBe(500);
    const problem = expectProblem(response.body, 'INTERNAL', 500);
    expect(problem.errorId).toBeDefined();
    expect(response.body).not.toMatch(/10\.1\.2\.3|CANARY|stack|tessera_prod/);

    const logged = logs.records().find((record) => record['event'] === 'http.unhandled_error');
    expect(logged).toMatchObject({ errorId: problem.errorId, routeId: 'test.boom' });
    // errorDetails=false: third-party error text is not logged either.
    expect(logs.text()).not.toContain('CANARY');
  });

  it('reports validation failures with field paths but without echoing input', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test/echo',
      headers: sameSiteHeaders,
      payload: { text: 'x'.repeat(101), unexpected: 'SECRET-VALUE' },
    });
    expect(response.statusCode).toBe(400);
    const problem = expectProblem(response.body, 'VALIDATION_FAILED', 400);
    expect(problem.fieldErrors?.length).toBeGreaterThan(0);
    expect(response.body).not.toContain('SECRET-VALUE');
  });

  it('rejects malformed JSON, wrong media types and oversized bodies', async () => {
    const { app } = await setup();
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/test/echo',
      headers: sameSiteHeaders,
      payload: '{"text":',
    });
    expectProblem(malformed.body, 'BAD_REQUEST', 400);

    const wrongType = await app.inject({
      method: 'POST',
      url: '/api/v1/test/echo',
      headers: { ...sameSiteHeaders, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'text=hi',
    });
    expectProblem(wrongType.body, 'UNSUPPORTED_MEDIA_TYPE', 415);

    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v1/test/echo',
      headers: sameSiteHeaders,
      payload: JSON.stringify({ text: 'x'.repeat(2000) }),
    });
    expectProblem(tooLarge.body, 'PAYLOAD_TOO_LARGE', 413);
  });

  it('rejects prototype-pollution payloads', async () => {
    const { app } = await setup();
    for (const payload of [
      '{"text":"a","__proto__":{"admin":true}}',
      '{"text":"a","constructor":{"prototype":{"admin":true}}}',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/test/echo',
        headers: sameSiteHeaders,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });
});

describe('DTO enforcement', () => {
  it('strips properties that are not part of the response schema', async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test/echo',
      headers: sameSiteHeaders,
      payload: { text: 'hello' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ text: 'hello' });
  });
});

describe('CSRF protection', () => {
  const post = (app: TestApp['app'], headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/v1/test/echo', headers, payload: { text: 'hi' } });

  it('accepts same-site requests with the CSRF header', async () => {
    const { app } = await setup();
    expect((await post(app, sameSiteHeaders)).statusCode).toBe(201);
  });

  it('rejects requests without the CSRF header', async () => {
    const { app } = await setup();
    const { 'x-tessera-csrf': _omitted, ...headers } = sameSiteHeaders;
    const response = await post(app, headers);
    expectProblem(response.body, 'CSRF_REJECTED', 403);
  });

  it('rejects foreign origins even with the header', async () => {
    const { app } = await setup();
    const response = await post(app, { ...sameSiteHeaders, origin: 'https://evil.example' });
    expectProblem(response.body, 'CSRF_REJECTED', 403);
  });

  it('rejects requests the browser marks as cross-site', async () => {
    const { app } = await setup();
    const response = await post(app, { ...sameSiteHeaders, 'sec-fetch-site': 'cross-site' });
    expectProblem(response.body, 'CSRF_REJECTED', 403);
  });

  it('does not apply to safe methods', async () => {
    const { app } = await setup();
    const response = await app.inject({
      url: '/api/v1/meta/version',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('CORS', () => {
  it('allows preflight only from configured origins', async () => {
    const { app } = await setup();
    const preflight = (origin: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/api/v1/test/echo',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-tessera-csrf',
        },
      });
    const allowed = await preflight(TEST_ORIGIN);
    expect(allowed.headers['access-control-allow-origin']).toBe(TEST_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await preflight('https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('authorization and rate limiting', () => {
  it('denies when the policy denies', async () => {
    const { app } = await setup();
    const response = await app.inject({ url: '/api/v1/test/denied' });
    expectProblem(response.body, 'FORBIDDEN', 403);
  });

  it('returns 429 with Retry-After once the limit is exhausted', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/v1/test/strict' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/v1/test/strict' })).statusCode).toBe(200);
    const limited = await app.inject({ url: '/api/v1/test/strict' });
    expect(limited.statusCode).toBe(429);
    const problem = expectProblem(limited.body, 'RATE_LIMITED', 429);
    expect(Number(limited.headers['retry-after'])).toBe(problem.retryAfterSeconds);
    expect(problem.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts requests that fail validation against the limit', async () => {
    const { app } = await setup();
    const bad = () => app.inject({ url: '/api/v1/test/strict?unexpected=1' });
    expect((await bad()).statusCode).toBe(400);
    expect((await bad()).statusCode).toBe(400);
    expect((await bad()).statusCode).toBe(429);
  });
});

describe('request logging', () => {
  it('logs one allow-listed line per request without URLs, headers or bodies', async () => {
    const { app, logs } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/v1/test/echo?token=QUERY-CANARY',
      headers: { ...sameSiteHeaders, cookie: '__Host-tsid=COOKIE-CANARY' },
      payload: { text: 'BODY-CANARY' },
    });
    const line = logs.records().find((record) => record['event'] === 'http.request');
    expect(line).toMatchObject({ routeId: 'test.echo', method: 'POST', statusCode: 201 });
    expect(logs.text()).not.toMatch(/CANARY/);
  });
});
