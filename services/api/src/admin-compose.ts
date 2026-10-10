import type { Logger } from '@tessera/platform';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';

import type { ApiConfig } from './config.js';
import type { Modules } from './compose.js';
import type { Database } from './db/schema.js';
import {
  AdminAuthService,
  AdminDirectory,
  AdminKeys,
  AdminOidc,
  AdminService,
  AdminSessions,
  Approvals,
  adminRoutes,
} from './modules/admin/index.js';
import { ChallengeStore } from './modules/auth/index.js';
import type { AdminRouteDefinition } from './platform/http/admin-routes.js';
import type { ObjectStore } from './platform/object-store.js';

/**
 * Composition of the admin console's services (docs/admin.md, ADR-050), on top of the same
 * modules as the user API. It runs in its own process (`admin-server`), so the user API never
 * serves an admin route and the admin process never serves a user route.
 */

export type AdminComposeConfig = Pick<
  ApiConfig,
  | 'VALKEY_KEY_PREFIX'
  | 'ADMIN_ORIGINS'
  | 'ADMIN_PUBLIC_URL'
  | 'ADMIN_OIDC_ISSUER'
  | 'ADMIN_OIDC_CLIENT_ID'
  | 'ADMIN_OIDC_CLIENT_SECRET'
  | 'ADMIN_EMAIL_DOMAINS'
  | 'ADMIN_OIDC_ALLOW_INSECURE'
  | 'ADMIN_WEBAUTHN_RP_ID'
  | 'ADMIN_AUTHENTICATOR_AAGUIDS'
  | 'ADMIN_SESSION_IDLE_MINUTES'
  | 'ADMIN_SESSION_ABSOLUTE_HOURS'
>;

export interface AdminInfrastructure {
  readonly db: Kysely<Database>;
  readonly valkey: Redis;
  readonly logger: Logger;
  readonly media: ObjectStore;
  /** Vendor attestation roots (PEM) for the security-key allow-list. */
  readonly attestationRoots?: readonly string[];
}

export interface AdminModules {
  readonly routes: AdminRouteDefinition[];
  readonly sessions: AdminSessions;
  readonly directory: AdminDirectory;
  readonly service: AdminService;
  readonly approvals: Approvals;
}

export function composeAdmin(
  config: AdminComposeConfig,
  infra: AdminInfrastructure,
  modules: Modules,
): AdminModules {
  const publicUrl = config.ADMIN_PUBLIC_URL;
  const origins = config.ADMIN_ORIGINS ?? [];
  const directory = new AdminDirectory(infra.db);
  const sessions = new AdminSessions(infra.db, directory, {
    idleMs: config.ADMIN_SESSION_IDLE_MINUTES * 60_000,
    absoluteMs: config.ADMIN_SESSION_ABSOLUTE_HOURS * 3_600_000,
  });
  const keys = new AdminKeys(
    infra.db,
    new ChallengeStore(infra.valkey, `${config.VALKEY_KEY_PREFIX}:admin`),
    {
      rpId:
        config.ADMIN_WEBAUTHN_RP_ID ??
        (publicUrl === undefined ? 'localhost' : new URL(publicUrl).hostname),
      rpName: 'Tessera admin',
      origins,
      aaguids: config.ADMIN_AUTHENTICATOR_AAGUIDS,
      attestationRoots: infra.attestationRoots ?? [],
    },
  );
  const oidc =
    config.ADMIN_OIDC_ISSUER !== undefined &&
    config.ADMIN_OIDC_CLIENT_ID !== undefined &&
    config.ADMIN_OIDC_CLIENT_SECRET !== undefined &&
    publicUrl !== undefined
      ? new AdminOidc(
          {
            issuer: config.ADMIN_OIDC_ISSUER,
            clientId: config.ADMIN_OIDC_CLIENT_ID,
            clientSecret: config.ADMIN_OIDC_CLIENT_SECRET,
            redirectUri: new URL('/auth/callback', publicUrl).href,
            emailDomains: config.ADMIN_EMAIL_DOMAINS ?? [],
            allowInsecure: config.ADMIN_OIDC_ALLOW_INSECURE,
          },
          infra.valkey,
          config.VALKEY_KEY_PREFIX,
        )
      : null;
  const auth = new AdminAuthService({ oidc, directory, keys, sessions, logger: infra.logger });

  const { accounts, sessionService, loginEvents, keys: deviceKeys, moderation, flags } = modules;
  const service = new AdminService({
    db: infra.db,
    valkey: infra.valkey,
    keyPrefix: config.VALKEY_KEY_PREFIX,
    directory,
    logger: infra.logger,
    ports: {
      accounts: {
        byId: (userId) => accounts.byId(userId),
        byIdentifier: (identifier) => accounts.byIdentifier(identifier),
        usernames: (ids) => accounts.usernames(ids),
        resendVerification: (email) => accounts.resendVerification(email),
        stats: () => accounts.stats(),
        signupsPerDay: (days) => accounts.signupsPerDay(days),
      },
      auth: {
        summary: (userId) => modules.auth.summary(userId),
        sessions: (userId) => sessionService.list(userId),
        revokeSession: (userId, sessionId) => sessionService.revoke(userId, sessionId, 'admin'),
        revokeAll: (userId) => sessionService.revokeAll(userId, 'admin'),
        loginEvents: (userId) => loginEvents.recent(userId),
        activeUsersSince: (since) => sessionService.activeUsersSince(since),
        failureHotspots: (since) => loginEvents.failureHotspots(since),
      },
      devices: {
        list: async (userId) =>
          (await deviceKeys.ownKeys(userId)).devices.map((device) => ({
            id: device.deviceId,
            label: device.label,
            createdAt: device.createdAt,
            revoked: false,
          })),
      },
      moderation: {
        standing: async (userId) => {
          const standing = await moderation.standing(userId);
          return { status: standing.status, suspendedUntil: standing.suspendedUntil };
        },
        caseConcerns: (caseId, userId) => moderation.caseConcerns(caseId, userId),
        metrics: () => moderation.metrics(),
        staffList: () => moderation.staffList(),
        revokeStaff: (userId, role) => moderation.revokeStaff(userId, role),
      },
      messaging: { countSince: (since) => modules.messaging.countSince(since) },
      billing: {
        summary: async (userId) => {
          const [entitlements, subscription] = await Promise.all([
            modules.entitlements.forUser(userId),
            modules.billing.subscription(userId),
          ]);
          return {
            tier: entitlements.tier,
            planName: subscription?.planName ?? null,
            status: subscription?.status ?? null,
            provider: subscription?.provider ?? null,
            cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
            currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
          };
        },
      },
      notifications: { queueDepth: () => modules.notifyQueue.depth() },
      flags: { list: () => flags.list() },
      audit: {
        page: (filter) => modules.audit.page(filter),
        verifyChain: () => modules.audit.verifyChain(),
      },
      health: [
        {
          name: 'database',
          check: async () => {
            await sql`SELECT 1`.execute(infra.db);
            return 'reachable';
          },
        },
        {
          name: 'cache',
          check: async () => {
            await infra.valkey.ping();
            return 'reachable';
          },
        },
        {
          name: 'object storage',
          check: async () => {
            await infra.media.ping();
            return 'reachable';
          },
        },
        {
          name: 'notification queue',
          check: async () => `${String(await modules.notifyQueue.depth())} pending`,
        },
      ],
    },
  });
  const approvals = new Approvals(
    infra.db,
    directory,
    {
      flag: async (key) => {
        const flag = await flags.get(key);
        return flag === null ? null : { kind: flag.kind };
      },
      applyFlag: async (key, change, adminId) => {
        await flags.apply(key, change, adminId);
      },
      userIdByUsername: async (username) => (await accounts.byIdentifier(username))?.id ?? null,
      grantStaff: async (userId, role, days, grantedBy) => {
        await moderation.grantStaff(userId, role, days, grantedBy);
      },
    },
    infra.logger,
  );
  return {
    routes: adminRoutes({ auth, admin: service, approvals, directory, sessions }),
    sessions,
    directory,
    service,
    approvals,
  };
}
