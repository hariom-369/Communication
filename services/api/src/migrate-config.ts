import { env, loadConfig } from '@tessera/platform';
import { z } from 'zod';

/**
 * The migration job's own configuration: only the database (as the schema-owning migrator role,
 * docs/deployment.md §5), so the job holds none of the API's keys.
 */
const schema = z
  .object({
    NODE_ENV: env.nodeEnv(),
    LOG_LEVEL: env.logLevel(),
    LOG_ERROR_DETAILS: env.boolean(false),
    DATABASE_URL: env.url(['postgres:', 'postgresql:']),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return;
    if (new URL(config.DATABASE_URL).searchParams.get('sslmode') !== 'verify-full')
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'Must set sslmode=verify-full in production',
      });
    if (config.LOG_ERROR_DETAILS)
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_ERROR_DETAILS'],
        message: 'Must be false in production',
      });
  });

export function loadMigrateConfig(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<z.infer<typeof schema>> {
  return loadConfig(schema, source);
}
