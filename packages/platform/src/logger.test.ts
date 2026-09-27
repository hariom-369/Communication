import { describe, expect, it } from 'vitest';

import { createLogger, sanitizeFields } from './logger.js';
import { MemoryDestination } from './testing/memory-destination.js';

function setup(errorDetails = false) {
  const destination = new MemoryDestination();
  const logger = createLogger({ service: 'test', level: 'debug', errorDetails, destination });
  return { destination, logger };
}

describe('logger allow-list', () => {
  it('drops fields that are not allow-listed and non-primitive values', () => {
    const fields = sanitizeFields({
      userId: 'u1',
      password: 'hunter2',
      authorization: 'Bearer abc',
      statusCode: 200,
      durationMs: { nested: true },
      ok: true,
    });
    expect(fields).toEqual({ userId: 'u1', statusCode: 200, ok: true });
  });

  it('never writes canary secrets passed in unknown fields', () => {
    const { destination, logger } = setup();
    const canaries = {
      password: 'CANARY-PASSWORD-1',
      token: 'CANARY-TOKEN-2',
      body: { message: 'CANARY-PLAINTEXT-3' },
      privateKey: 'CANARY-KEY-4',
    };
    logger.info('auth.login_attempt', canaries as unknown as Record<string, never>);
    logger.child(canaries as unknown as Record<string, never>).warn('x.y');
    expect(destination.text()).not.toMatch(/CANARY/);
  });

  it('writes the event as the message key and rejects free-text event names', () => {
    const { destination, logger } = setup();
    logger.info('http.request', { routeId: 'meta.version' });
    logger.info('user said: my password is hunter2');
    const [first, second] = destination.records();
    expect(first).toMatchObject({
      event: 'http.request',
      routeId: 'meta.version',
      service: 'test',
    });
    expect(second).toMatchObject({ event: 'invalid_event_name' });
    expect(destination.text()).not.toContain('hunter2');
  });

  it('truncates long strings', () => {
    const { destination, logger } = setup();
    logger.info('x.y', { routeId: 'a'.repeat(2000) });
    const record = destination.records()[0]!;
    expect((record['routeId'] as string).length).toBeLessThanOrEqual(513);
  });
});

describe('error serialisation', () => {
  it('omits messages of unexpected errors unless error details are enabled', () => {
    const error = Object.assign(new Error('duplicate key (email)=(someone@example.com)'), {
      code: '23505',
    });
    expect(setup(false).logger.errorFields(error)).toEqual({
      errorName: 'Error',
      errorCode: '23505',
    });
    const detailed = setup(true).logger.errorFields(error);
    expect(detailed['errorMessage']).toContain('duplicate key');
    expect(detailed['stack']).toBeTypeOf('string');
  });

  it('always includes messages of errors marked safe', () => {
    const error = Object.assign(new Error('Rate limit exceeded'), { safeToLog: true as const });
    expect(setup(false).logger.errorFields(error)['errorMessage']).toBe('Rate limit exceeded');
  });
});
