import { z } from 'zod';

/** Raised when environment configuration is invalid. Lists variable names only, never values. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Parses and freezes configuration from an environment map. Services call this once at boot and
 * refuse to start on failure (docs/architecture.md §8).
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<z.infer<S>> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(issues);
  }
  return Object.freeze(result.data);
}

/** Reusable field schemas for environment variables (which are always strings). */
export const env = {
  port: (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback),

  positiveInt: (fallback: number) => z.coerce.number().int().positive().default(fallback),

  nonNegativeInt: (fallback: number) => z.coerce.number().int().nonnegative().default(fallback),

  boolean: (fallback: boolean) =>
    z
      .enum(['true', 'false'])
      .default(fallback ? 'true' : 'false')
      .transform((value) => value === 'true'),

  nodeEnv: () => z.enum(['development', 'test', 'production']).default('development'),

  logLevel: () => z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /** A URL with one of the allowed protocols. */
  url: (protocols: readonly string[]) =>
    z.string().refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol);
        } catch {
          return false;
        }
      },
      { message: `Must be a URL with protocol ${protocols.join(' or ')}` },
    ),

  /** Comma-separated list of origins (scheme://host[:port]) without paths. */
  originList: () =>
    z
      .string()
      .min(1)
      .transform((value) =>
        value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      )
      .refine((origins) => origins.length > 0 && origins.every(isOrigin), {
        message: 'Must be a comma-separated list of origins like https://app.example.com',
      }),
} as const;

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}
