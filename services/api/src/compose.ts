import type { Logger } from '@tessera/platform';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';

import type { ApiConfig } from './config.js';
import type { Database } from './db/schema.js';
import { AccountService, accountsRoutes } from './modules/accounts/index.js';
import { AuditLog } from './modules/audit/index.js';
import {
  AuthService,
  authRoutes,
  ChallengeStore,
  LoginEvents,
  PasskeyService,
  PasswordHasher,
  parsePepper,
  SessionService,
} from './modules/auth/index.js';
import { metaRoutes } from './modules/meta/index.js';
import type { Mailer } from './platform/email.js';
import type { RouteDefinition, SessionAuthenticator } from './platform/http/routes.js';
import { parseKeyring, SecretBox } from './platform/secrets.js';

/**
 * Composition root: the only place that knows every module. Modules receive their collaborators
 * through interfaces, which keeps them extractable into services later (ADR-001).
 */

export type ModuleConfig = Pick<
  ApiConfig,
  | 'PASSWORD_PEPPER'
  | 'SECRET_BOX_KEYS'
  | 'WEBAUTHN_RP_ID'
  | 'WEBAUTHN_RP_NAME'
  | 'ALLOWED_ORIGINS'
  | 'PUBLIC_WEB_URL'
  | 'SESSION_IDLE_DAYS'
  | 'SESSION_ABSOLUTE_DAYS'
  | 'BUILD_VERSION'
  | 'BUILD_COMMIT'
  | 'VALKEY_KEY_PREFIX'
>;

export interface ModuleInfrastructure {
  readonly db: Kysely<Database>;
  readonly valkey: Redis;
  readonly mailer: Mailer;
  readonly logger: Logger;
}

export interface Modules {
  readonly routes: RouteDefinition[];
  readonly sessions: SessionAuthenticator;
  readonly audit: AuditLog;
}

const DAY_MS = 24 * 60 * 60_000;

export function composeModules(config: ModuleConfig, infra: ModuleInfrastructure): Modules {
  const audit = new AuditLog(infra.db);
  const accounts = new AccountService(infra.db, infra.mailer, audit);
  const sessions = new SessionService(infra.db, {
    idleMs: config.SESSION_IDLE_DAYS * DAY_MS,
    absoluteMs: config.SESSION_ABSOLUTE_DAYS * DAY_MS,
  });
  const passkeys = new PasskeyService(
    infra.db,
    new ChallengeStore(infra.valkey, config.VALKEY_KEY_PREFIX),
    {
      rpId: config.WEBAUTHN_RP_ID,
      rpName: config.WEBAUTHN_RP_NAME,
      origins: config.ALLOWED_ORIGINS,
    },
  );
  const auth = new AuthService({
    db: infra.db,
    accounts,
    sessions,
    passwords: new PasswordHasher(parsePepper(config.PASSWORD_PEPPER)),
    passkeys,
    loginEvents: new LoginEvents(infra.db),
    secretBox: new SecretBox(parseKeyring(config.SECRET_BOX_KEYS)),
    audit,
    mailer: infra.mailer,
    logger: infra.logger,
    publicWebUrl: config.PUBLIC_WEB_URL,
  });

  return {
    routes: [
      ...metaRoutes({ build: { version: config.BUILD_VERSION, commit: config.BUILD_COMMIT } }),
      ...accountsRoutes({ accounts, sessions: auth, security: auth }),
      ...authRoutes({ auth, sessions, passkeys }),
    ],
    sessions,
    audit,
  };
}
