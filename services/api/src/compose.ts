import type { Logger } from '@tessera/platform';
import { PUSH_COALESCE_SECONDS, PUSH_MIN_INTERVAL_SECONDS } from '@tessera/validation';
import type { Redis } from 'ioredis';
import type { Kysely } from 'kysely';

import type { ApiConfig } from './config.js';
import type { Database } from './db/schema.js';
import { AccountService, accountsRoutes } from './modules/accounts/index.js';
import { AuditLog } from './modules/audit/index.js';
import { BackupsService, backupsRoutes } from './modules/backups/index.js';
import { CallsService, LiveKitRooms, callRoutes } from './modules/calls/index.js';
import { ChannelsService, LinkPreviewer, channelRoutes } from './modules/channels/index.js';
import { CommunitiesService, communityRoutes } from './modules/communities/index.js';
import {
  AuthService,
  authRoutes,
  ChallengeStore,
  LoginEvents,
  PasskeyService,
  PasswordHasher,
  parsePepper,
  RangeApiBreachedPasswords,
  SessionService,
} from './modules/auth/index.js';
import { KeysService, keysRoutes } from './modules/keys/index.js';
import { MediaService, mediaRoutes } from './modules/media/index.js';
import {
  GroupsService,
  MessagingService,
  groupRoutes,
  messagingRoutes,
} from './modules/messaging/index.js';
import {
  BillingService,
  RazorpayProvider,
  StripeProvider,
  billingRoutes,
  parsePriceMap,
  type PaymentProvider,
} from './modules/billing/index.js';
import { EntitlementsService, entitlementRoutes } from './modules/entitlements/index.js';
import { FlagsService, flagRoutes } from './modules/flags/index.js';
import { metaRoutes } from './modules/meta/index.js';
import {
  ModerationService,
  moderationRoutes,
  type ModerationKey,
} from './modules/moderation/index.js';
import {
  NotificationsService,
  NotifyQueue,
  PushSender,
  notificationRoutes,
} from './modules/notifications/index.js';
import { RealtimeService, realtimeRoutes } from './modules/realtime/index.js';
import type { Mailer } from './platform/email.js';
import { FrankingTagger } from './platform/franking.js';
import type { ObjectStore } from './platform/object-store.js';
import type { RouteDefinition, SessionAuthenticator } from './platform/http/routes.js';
import { ValkeyRealtimePublisher } from './platform/realtime-publisher.js';
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
  | 'MAILBOX_RETENTION_DAYS'
  | 'REALTIME_WS_PATH'
  | 'REALTIME_TICKETS_PER_SECOND'
  | 'TURN_URLS'
  | 'TURN_SHARED_SECRET'
  | 'TURN_TTL_SECONDS'
  | 'STUN_URLS'
  | 'LIVEKIT_URL'
  | 'LIVEKIT_API_URL'
  | 'LIVEKIT_API_KEY'
  | 'LIVEKIT_API_SECRET'
  | 'CALL_RECORD_RETENTION_DAYS'
  | 'VAPID_PUBLIC_KEY'
  | 'VAPID_PRIVATE_KEY'
  | 'VAPID_SUBJECT'
  | 'PUSH_SERVICE_HOSTS'
  | 'PUSH_TEST_ENDPOINT_ORIGIN'
  | 'SECURITY_ALERT_RETENTION_DAYS'
  | 'FRANKING_KEYS'
  | 'EVIDENCE_RETENTION_DAYS'
> &
  Partial<
    Pick<
      ApiConfig,
      | 'STRIPE_SECRET_KEY'
      | 'STRIPE_WEBHOOK_SECRET'
      | 'STRIPE_PRICES'
      | 'STRIPE_API_URL'
      | 'RAZORPAY_KEY_ID'
      | 'RAZORPAY_KEY_SECRET'
      | 'RAZORPAY_WEBHOOK_SECRET'
      | 'RAZORPAY_PLANS'
      | 'RAZORPAY_API_URL'
      | 'BILLING_SELLER_NAME'
      | 'BILLING_SELLER_ADDRESS'
      | 'BILLING_SELLER_GSTIN'
      | 'BILLING_SELLER_STATE'
      | 'BILLING_SAC_CODE'
      | 'PWNED_PASSWORDS_URL'
    >
  >;

export interface ModuleInfrastructure {
  readonly db: Kysely<Database>;
  readonly valkey: Redis;
  readonly mailer: Mailer;
  readonly logger: Logger;
  /** Encrypted attachments (docs/media.md §5). */
  readonly media: ObjectStore;
  /** HPKE key report bundles are encrypted to (loaded asynchronously; null when unset). */
  readonly moderationKey?: ModerationKey | null;
}

export interface Modules {
  readonly routes: RouteDefinition[];
  readonly sessions: SessionAuthenticator;
  readonly audit: AuditLog;
  readonly messaging: MessagingService;
  readonly keys: KeysService;
  readonly media: MediaService;
  readonly channels: ChannelsService;
  readonly calls: CallsService;
  readonly notifications: NotificationsService;
  readonly moderation: ModerationService;
  readonly accounts: AccountService;
  readonly auth: AuthService;
  readonly sessionService: SessionService;
  readonly loginEvents: LoginEvents;
  readonly flags: FlagsService;
  readonly notifyQueue: NotifyQueue;
  readonly entitlements: EntitlementsService;
  readonly billing: BillingService;
}

const DAY_MS = 24 * 60 * 60_000;

export function composeModules(config: ModuleConfig, infra: ModuleInfrastructure): Modules {
  const audit = new AuditLog(infra.db);
  const secretBox = new SecretBox(parseKeyring(config.SECRET_BOX_KEYS));
  const accounts = new AccountService(infra.db, infra.mailer, audit);
  const publisher = new ValkeyRealtimePublisher(
    infra.valkey,
    config.VALKEY_KEY_PREFIX,
    infra.logger,
  );
  const sessions = new SessionService(
    infra.db,
    {
      idleMs: config.SESSION_IDLE_DAYS * DAY_MS,
      absoluteMs: config.SESSION_ABSOLUTE_DAYS * DAY_MS,
    },
    (userId) => {
      publisher.publish([userId], { type: 'sessions_changed' });
    },
  );
  const passkeys = new PasskeyService(
    infra.db,
    new ChallengeStore(infra.valkey, config.VALKEY_KEY_PREFIX),
    {
      rpId: config.WEBAUTHN_RP_ID,
      rpName: config.WEBAUTHN_RP_NAME,
      origins: config.ALLOWED_ORIGINS,
    },
  );
  const loginEvents = new LoginEvents(infra.db);
  const auth = new AuthService({
    db: infra.db,
    accounts,
    sessions,
    passwords: new PasswordHasher(parsePepper(config.PASSWORD_PEPPER)),
    passkeys,
    loginEvents,
    secretBox,
    audit,
    mailer: infra.mailer,
    logger: infra.logger,
    publicWebUrl: config.PUBLIC_WEB_URL,
    ...(config.PWNED_PASSWORDS_URL === undefined
      ? {}
      : {
          breached: new RangeApiBreachedPasswords({
            baseUrl: config.PWNED_PASSWORDS_URL,
            logger: infra.logger,
          }),
        }),
  });

  const messaging = new MessagingService(
    infra.db,
    accounts,
    publisher,
    { retentionDays: config.MAILBOX_RETENTION_DAYS },
    infra.logger,
  );
  const keys = new KeysService(
    infra.db,
    audit,
    publisher,
    {
      contactsOf: (userId) => messaging.contactsOf(userId),
      sharesConversation: (a, b) => messaging.sharesConversation(a, b),
    },
    infra.logger,
  );
  messaging.useDevices(keys);
  const groups = new GroupsService(infra.db, accounts, messaging, publisher, infra.logger);
  const communities = new CommunitiesService(
    infra.db,
    accounts,
    groups,
    publisher,
    audit,
    infra.logger,
  );
  groups.useSpaces(communities);
  const previews = new LinkPreviewer(infra.valkey, config.VALKEY_KEY_PREFIX);
  const channels = new ChannelsService({
    db: infra.db,
    valkey: infra.valkey,
    keyPrefix: config.VALKEY_KEY_PREFIX,
    directory: accounts,
    previews,
    audit,
    logger: infra.logger,
  });
  keys.useNotifier(auth);
  const backups = new BackupsService(infra.db, audit, auth);
  const media = new MediaService(infra.db, infra.media, infra.logger);
  media.useMembership(messaging);
  messaging.useAttachments(media);
  const franking =
    config.FRANKING_KEYS === undefined
      ? null
      : new FrankingTagger(parseKeyring(config.FRANKING_KEYS));
  const moderation = new ModerationService({
    db: infra.db,
    valkey: infra.valkey,
    keyPrefix: config.VALKEY_KEY_PREFIX,
    audit,
    secretBox,
    mailer: infra.mailer,
    logger: infra.logger,
    moderationKey: infra.moderationKey ?? null,
    franking,
    accounts,
    sessions,
    notices: auth,
    conversations: {
      isMember: (userId, conversationId) => messaging.isMember(userId, conversationId),
      directPeer: (userId, conversationId) => messaging.directPeer(userId, conversationId),
    },
    channels,
    communities,
    evidenceRetentionDays: config.EVIDENCE_RETENTION_DAYS,
  });
  if (franking !== null) messaging.useFranking(franking);
  messaging.useSafety(moderation, moderation);
  groups.useSafety(moderation, moderation);
  channels.useLinkGuard({
    blockedHosts: (text) => moderation.blockedHosts(text),
    assertMay: (userId, kind) => moderation.assertMay(userId, kind),
  });
  const realtime = new RealtimeService(infra.valkey, config.VALKEY_KEY_PREFIX, {
    privacySettings: (userId) => accounts.privacySettings(userId),
    areContacts: (a, b) => messaging.areContacts(a, b),
    blockedEitherWay: (a, b) => moderation.blockedEitherWay(a, b),
  });

  const livekit =
    config.LIVEKIT_URL !== undefined &&
    config.LIVEKIT_API_URL !== undefined &&
    config.LIVEKIT_API_KEY !== undefined &&
    config.LIVEKIT_API_SECRET !== undefined
      ? {
          url: config.LIVEKIT_URL,
          apiUrl: config.LIVEKIT_API_URL,
          apiKey: config.LIVEKIT_API_KEY,
          apiSecret: config.LIVEKIT_API_SECRET,
        }
      : null;
  const calls = new CallsService({
    db: infra.db,
    conversations: {
      callContext: (id) => messaging.callContext(id),
      areContacts: (a, b) => messaging.areContacts(a, b),
    },
    devices: keys,
    directory: accounts,
    publisher,
    sfu: livekit === null ? null : new LiveKitRooms(livekit),
    config: {
      turn:
        config.TURN_URLS !== undefined && config.TURN_SHARED_SECRET !== undefined
          ? {
              urls: config.TURN_URLS,
              secret: config.TURN_SHARED_SECRET,
              ttlSeconds: config.TURN_TTL_SECONDS,
            }
          : null,
      stunUrls: config.STUN_URLS ?? [],
      sfu: livekit === null ? null : { url: livekit.url },
      retentionDays: config.CALL_RECORD_RETENTION_DAYS,
    },
    logger: infra.logger,
  });

  const push =
    config.VAPID_PUBLIC_KEY !== undefined &&
    config.VAPID_PRIVATE_KEY !== undefined &&
    config.VAPID_SUBJECT !== undefined
      ? new PushSender({
          vapid: {
            publicKey: config.VAPID_PUBLIC_KEY,
            privateKey: config.VAPID_PRIVATE_KEY,
            subject: config.VAPID_SUBJECT,
          },
          allowedHosts: config.PUSH_SERVICE_HOSTS,
          ...(config.PUSH_TEST_ENDPOINT_ORIGIN === undefined
            ? {}
            : { testOrigin: config.PUSH_TEST_ENDPOINT_ORIGIN }),
        })
      : null;
  const notifyQueue = new NotifyQueue(infra.valkey, config.VALKEY_KEY_PREFIX, {
    coalesceMs: PUSH_COALESCE_SECONDS * 1000,
    minIntervalMs: PUSH_MIN_INTERVAL_SECONDS * 1000,
  });
  const notifications = new NotificationsService({
    db: infra.db,
    valkey: infra.valkey,
    queue: notifyQueue,
    push,
    publisher,
    conversations: {
      isMember: (conversationId, userId) => messaging.isMember(userId, conversationId),
    },
    sessions,
    devices: keys,
    config: {
      keyPrefix: config.VALKEY_KEY_PREFIX,
      alertRetentionDays: config.SECURITY_ALERT_RETENTION_DAYS,
    },
    logger: infra.logger,
  });
  notifications.useChannels(channels);
  messaging.useNotifier(notifications);
  calls.useNotifier(notifications);
  calls.useBlocks(moderation);
  // Feature flags (admin console): kill switches for features with an outside dependency.
  const flags = new FlagsService(infra.db);
  calls.useSwitch((userId) => flags.enabled('group_calls', userId));
  previews.useSwitch(() => flags.enabled('link_previews'));

  // Billing and entitlements (docs/billing.md): other modules ask entitlements, never billing.
  const entitlements = new EntitlementsService(
    infra.db,
    infra.valkey,
    config.VALKEY_KEY_PREFIX,
    infra.logger,
  );
  media.useEntitlements({
    limits: async (userId) => {
      const { limits } = await entitlements.forUser(userId);
      return {
        maxFileBytes: limits['media.max_file_bytes'],
        dailyBytes: limits['media.daily_bytes'],
        dailyUploads: limits['media.daily_uploads'],
      };
    },
  });
  channels.useEntitlements({
    limits: async (userId) => {
      const { limits } = await entitlements.forUser(userId);
      return {
        maxOwned: limits['channels.max_owned'],
        scheduleDays: limits['channels.schedule_days'],
      };
    },
  });
  const providers: PaymentProvider[] = [];
  if (
    config.STRIPE_SECRET_KEY !== undefined &&
    config.STRIPE_WEBHOOK_SECRET !== undefined &&
    config.STRIPE_PRICES !== undefined
  )
    providers.push(
      new StripeProvider({
        secretKey: config.STRIPE_SECRET_KEY,
        webhookSecret: config.STRIPE_WEBHOOK_SECRET,
        prices: parsePriceMap(config.STRIPE_PRICES),
        apiUrl: config.STRIPE_API_URL ?? 'https://api.stripe.com',
      }),
    );
  if (
    config.RAZORPAY_KEY_ID !== undefined &&
    config.RAZORPAY_KEY_SECRET !== undefined &&
    config.RAZORPAY_WEBHOOK_SECRET !== undefined &&
    config.RAZORPAY_PLANS !== undefined
  )
    providers.push(
      new RazorpayProvider({
        keyId: config.RAZORPAY_KEY_ID,
        keySecret: config.RAZORPAY_KEY_SECRET,
        webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
        plans: parsePriceMap(config.RAZORPAY_PLANS),
        apiUrl: config.RAZORPAY_API_URL ?? 'https://api.razorpay.com',
      }),
    );
  const billing = new BillingService({
    db: infra.db,
    providers,
    entitlements,
    audit,
    seller:
      config.BILLING_SELLER_NAME !== undefined &&
      config.BILLING_SELLER_ADDRESS !== undefined &&
      config.BILLING_SELLER_STATE !== undefined
        ? {
            name: config.BILLING_SELLER_NAME,
            address: config.BILLING_SELLER_ADDRESS,
            gstin: config.BILLING_SELLER_GSTIN ?? null,
            state: config.BILLING_SELLER_STATE,
            sacCode: config.BILLING_SAC_CODE ?? '998439',
          }
        : null,
    returnUrl: new URL('/settings/plan?checkout=return', config.PUBLIC_WEB_URL).href,
    checkoutEnabled: () => flags.enabled('billing'),
    logger: infra.logger,
  });
  channels.useNotifier(notifications);
  auth.useAlerts(notifications);
  sessions.onRotated((from, to) => {
    void notifications.sessionRotated(from, to);
  });

  return {
    routes: [
      ...metaRoutes({ build: { version: config.BUILD_VERSION, commit: config.BUILD_COMMIT } }),
      ...accountsRoutes({ accounts, sessions: auth, security: auth }),
      ...authRoutes({ auth, sessions, passkeys }),
      ...messagingRoutes({ messaging }),
      ...groupRoutes({ groups }),
      ...communityRoutes({ communities }),
      ...channelRoutes({ channels, previews }),
      ...callRoutes({ calls }),
      ...notificationRoutes({ notifications }),
      ...keysRoutes({ keys }),
      ...backupsRoutes({ backups }),
      ...mediaRoutes({ media }),
      ...realtimeRoutes({
        realtime,
        websocketPath: config.REALTIME_WS_PATH,
        ...(config.REALTIME_TICKETS_PER_SECOND === 0
          ? {}
          : { ticketsPerSecond: config.REALTIME_TICKETS_PER_SECOND }),
      }),
      ...moderationRoutes({ moderation }),
      ...flagRoutes({ flags }),
      ...entitlementRoutes({ entitlements }),
      ...billingRoutes({ billing }),
    ],
    sessions,
    audit,
    messaging,
    keys,
    media,
    channels,
    calls,
    notifications,
    moderation,
    accounts,
    auth,
    sessionService: sessions,
    loginEvents,
    flags,
    notifyQueue,
    entitlements,
    billing,
  };
}
