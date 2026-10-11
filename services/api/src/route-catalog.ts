import { createLogger } from '@tessera/platform';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { composeAdmin } from './admin-compose.js';
import { composeModules } from './compose.js';
import type { Database } from './db/schema.js';
import type { AdminRouteDefinition } from './platform/http/admin-routes.js';
import type { RouteDefinition } from './platform/http/routes.js';
import type { ObjectStore } from './platform/object-store.js';
import { createValkey } from './platform/valkey.js';

const unusedKey = Buffer.alloc(32).toString('base64');

/**
 * All production routes, built with infrastructure clients that never connect. Used to generate
 * the OpenAPI document and the route security matrix, and by the route-completeness test; never
 * to serve requests.
 */
export function routeCatalog(): {
  routes: RouteDefinition[];
  adminRoutes: AdminRouteDefinition[];
  close(): Promise<void>;
} {
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
      REALTIME_TICKETS_PER_SECOND: 0,
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
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const admin = composeAdmin(
    {
      VALKEY_KEY_PREFIX: 'catalog',
      ADMIN_ORIGINS: ['https://admin.catalog.invalid'],
      ADMIN_PUBLIC_URL: 'https://admin.catalog.invalid',
      ADMIN_OIDC_ISSUER: 'https://idp.catalog.invalid',
      ADMIN_OIDC_CLIENT_ID: 'catalog',
      ADMIN_OIDC_CLIENT_SECRET: 'catalog-client-secret',
      ADMIN_EMAIL_DOMAINS: ['catalog.invalid'],
      ADMIN_OIDC_ALLOW_INSECURE: false,
      ADMIN_WEBAUTHN_RP_ID: 'admin.catalog.invalid',
      ADMIN_AUTHENTICATOR_AAGUIDS: [],
      ADMIN_SESSION_IDLE_MINUTES: 30,
      ADMIN_SESSION_ABSOLUTE_HOURS: 8,
    },
    {
      db,
      valkey,
      logger: createLogger({ service: 'catalog', level: 'fatal', errorDetails: false }),
      media: new Proxy({} as ObjectStore, {
        get: () => () => Promise.reject(new Error('Route catalog has no object store')),
      }),
    },
    modules,
  );
  return {
    routes: modules.routes,
    adminRoutes: admin.routes,
    close: async () => {
      valkey.disconnect();
      await pool.end();
    },
  };
}
