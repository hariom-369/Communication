import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConfigError, env, loadConfig } from './config.js';

const schema = z.object({
  PORT: env.port(8080),
  DATABASE_URL: env.url(['postgres:', 'postgresql:']),
  FEATURE: env.boolean(false),
  ORIGINS: env.originList(),
});

describe('loadConfig', () => {
  it('parses, applies defaults and freezes', () => {
    const config = loadConfig(schema, {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      ORIGINS: 'https://app.example.com, http://localhost:5173',
    });
    expect(config).toEqual({
      PORT: 8080,
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      FEATURE: false,
      ORIGINS: ['https://app.example.com', 'http://localhost:5173'],
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('reports every invalid variable by name without echoing values', () => {
    const secret = 'postgres-password-canary-9f2a';
    let caught: unknown;
    try {
      loadConfig(schema, {
        PORT: '99999',
        DATABASE_URL: `mysql://root:${secret}@db/app`,
        FEATURE: 'yes',
        ORIGINS: 'https://app.example.com/path',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    expect(error.issues.map((issue) => issue.split(':')[0])).toEqual([
      'PORT',
      'DATABASE_URL',
      'FEATURE',
      'ORIGINS',
    ]);
    expect(error.message).not.toContain(secret);
  });
});
