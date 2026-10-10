import { createLogger } from '@tessera/platform';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { composeModules } from './compose.js';
import type { Database } from './db/schema.js';
import type { RouteDefinition } from './platform/http/routes.js';
import type { ObjectStore } from './platform/object-store.js';
import { createValkey } from './platform/valkey.js';

const unusedKey = Buffer.alloc(32).toString('base64');

/**
 * All production routes, built with infrastructure clients that never connect. Used to generate
 * the OpenAPI document and by the route-completeness test; never to serve requests.
 */
export function routeCatalog(): { routes: RouteDefinition[]; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: 'postgres://catalog.invalid/catalog' });
  const valkey = createValkey('redis://catalog.invalid:6379', 'catalog');
  const modules = composeModules(
    {
      PASSWORD_PEPPER: `catalog:${unusedKey}`,
      SECRET_BOX_KEYS: `catalog:${unusedKey}`,
      WEBAUTHN_RP_ID: 'catalog.invalid',
      WEBAUTHN_RP_NAME: 'Tessera',
      ALLOWED_ORIGINS: ['https://catalog.invalid'],
      PUBLIC_WEB_URL: 'https://catalog.invalid',
      SESSION_IDLE_DAYS: 30,
      SESSION_ABSOLUTE_DAYS: 90,
      BUILD_VERSION: 'catalog',
      BUILD_COMMIT: 'catalog',
      VALKEY_KEY_PREFIX: 'catalog',
      MAILBOX_RETENTION_DAYS: 30,
      REALTIME_WS_PATH: '/rt/v1/ws',
      TURN_TTL_SECONDS: 600,
      CALL_RECORD_RETENTION_DAYS: 90,
      PUSH_SERVICE_HOSTS: [],
      SECURITY_ALERT_RETENTION_DAYS: 180,
      FRANKING_KEYS: undefined,
      EVIDENCE_RETENTION_DAYS: 365,
    },
    {
      db: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
      valkey,
      mailer: { send: () => Promise.reject(new Error('Route catalog cannot send email')) },
      logger: createLogger({ service: 'catalog', level: 'fatal', errorDetails: false }),
      media: new Proxy({} as ObjectStore, {
        get: () => () => Promise.reject(new Error('Route catalog has no object store')),
      }),
    },
  );
  return {
    routes: modules.routes,
    close: async () => {
      valkey.disconnect();
      await pool.end();
    },
  };
}
